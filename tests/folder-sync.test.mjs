// The archive folder's sync rule (src/archive/folder-sync.ts) over a folder held in a Map: a sync MERGES a month file
// into the archive before rewriting it, so a new browser pointed at an old machine's folder keeps both machines'
// sessions; what the archive removed on purpose stays removed; a file it cannot read is never overwritten.
import test from "node:test";
import assert from "node:assert/strict";
import init from "@sqlite.org/sqlite-wasm";
import { dirtyMonths, exportMonth, migrate, prepareSession, readArchived, removeArchived, wasmDb, writeSession, archiveStats } from "../src/archive/db.ts";
import { adoptFolder, folderFormOf, importMonths, setFolderForm, surveyFolder, syncMonths } from "../src/archive/folder-sync.ts";
import { createKeyring, sniff, readHeader } from "../src/backup/backup-format.ts";
import { openBackupBytes } from "../src/backup/backup-file.ts";

const sqlite3 = await init();
const fresh = () => { const raw = new sqlite3.oo1.DB(":memory:"); const db = wasmDb(raw); migrate(db); return { db, raw, h: { sqlite3, raw } }; };

const OCT = Date.UTC(2026, 9, 10), SEPT = Date.UTC(2026, 8, 10);
const put = async (a, hash, lastTs) => writeSession(a.db, await prepareSession({
    summary: { id: { runtime: "local", hash }, kind: "agent", status: "done", task: `task ${hash}`, createdTs: lastTs - 10, lastTs, pendingApprovals: 0, saved: true },
    events: [{ kind: "agent", id: hash, ts: lastTs, session: { hash, turn: 0 }, task: `remember ${hash}` }], history: null, bytes: 100,
}), 5000);

const EXT = { plain: "sqlite", gzip: "sqlite.gz", encrypted: "wmlbak" };
const FORMS = Object.keys(EXT);
/** A folder of month files in memory, as a sync sees one: file name (`2026-10.sqlite`) to bytes. */
function mapFolder(files = new Map()) {
    const names = (month) => FORMS.filter((f) => files.has(`${month}.${EXT[f]}`));
    return {
        files,
        failWrites: false,
        months: async () => [...new Set([...files.keys()].map((n) => n.slice(0, 7)))].sort(),
        forms: async (m) => names(m),
        read: async (m, form) => files.get(`${m}.${EXT[form]}`) ?? null,
        write: async function (m, form, bytes) { if (this.failWrites) throw new Error("disk full"); files.set(`${m}.${EXT[form]}`, bytes); },
        remove: async (m, form) => { files.delete(`${m}.${EXT[form]}`); },
    };
}
/** The session hashes a month file holds. */
function hashesIn(bytes) {
    const a = fresh();
    a.db.exec("ATTACH DATABASE ':memory:' AS f");
    const p = sqlite3.wasm.allocFromTypedArray(bytes);
    sqlite3.capi.sqlite3_deserialize(a.raw.pointer, "f", p, bytes.byteLength, bytes.byteLength, sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_READONLY);
    return a.db.selectValues("SELECT hash FROM f.sessions ORDER BY hash").map(String);
}

// --- two machines, one folder ---

test("a new browser pointed at an old machine's folder keeps both machines' sessions in the month they share", async () => {
    const old = fresh();
    await put(old, "01d00001", OCT);
    await put(old, "01d00002", OCT + 1000);
    const folder = mapFolder();
    await syncMonths(old.h, folder);
    assert.deepEqual(hashesIn(folder.files.get("2026-10.sqlite")), ["01d00001", "01d00002"]);

    // The new machine archives something into October and syncs, never having clicked Import.
    const neu = fresh();
    await put(neu, "0e000003", OCT + 2000);
    const r = await syncMonths(neu.h, folder);
    assert.deepEqual(r.written, ["2026-10"]);
    assert.equal(r.merged, 2, "the old machine's two sessions were taken in first");
    assert.deepEqual(hashesIn(folder.files.get("2026-10.sqlite")), ["01d00001", "01d00002", "0e000003"], "nothing the folder held was dropped");
    assert.equal(readArchived(neu.db, "01d00001").events[0].task, "remember 01d00001", "and the new archive can open them");
});

test("picking a folder takes in every month it holds, including months this archive never touched", async () => {
    const old = fresh();
    await put(old, "01d0aa01", SEPT);
    await put(old, "01d0aa02", OCT);
    const folder = mapFolder();
    await syncMonths(old.h, folder);

    const neu = fresh();
    await put(neu, "0e0aa003", OCT + 5);
    assert.deepEqual(await surveyFolder(folder), { files: 2, first: "2026-09", last: "2026-10" });
    const r = await adoptFolder(neu.h, folder);
    assert.deepEqual(r.imported, { files: 2, sessions: 2 });
    assert.equal(archiveStats(neu.db).sessions, 3);
    assert.deepEqual(hashesIn(folder.files.get("2026-09.sqlite")), ["01d0aa01"]);
    assert.deepEqual(hashesIn(folder.files.get("2026-10.sqlite")), ["01d0aa02", "0e0aa003"]);
    assert.deepEqual(dirtyMonths(neu.db), []);
});

// --- what the archive removed on purpose ---

test("a delete reaches the folder and stays deleted: the merge does not read it back from the old file", async () => {
    const a = fresh();
    await put(a, "de1e0001", OCT);
    await put(a, "de1e0002", OCT + 1);
    const folder = mapFolder();
    await syncMonths(a.h, folder);
    removeArchived(a.db, "de1e0001");
    const r = await syncMonths(a.h, folder);
    assert.equal(r.merged, 0);
    assert.deepEqual(hashesIn(folder.files.get("2026-10.sqlite")), ["de1e0002"]);
    assert.equal(readArchived(a.db, "de1e0001"), null);
    // An explicit Import skips it too.
    assert.equal((await importMonths(a.h, mapFolder(new Map([["2026-10.sqlite", await otherMachinesOctober("de1e0001")]])))).sessions, 0);
});

test("a session un-archived and archived again is written again, not held back as removed", async () => {
    const a = fresh();
    await put(a, "ba5e0001", OCT);
    const folder = mapFolder();
    await syncMonths(a.h, folder);
    removeArchived(a.db, "ba5e0001");   // opened: back in the live store
    await syncMonths(a.h, folder);
    assert.equal(folder.files.has("2026-10.sqlite"), false, "the month emptied, so its file went");
    await put(a, "ba5e0001", OCT + 50);   // retention archives it again
    await syncMonths(a.h, folder);
    assert.deepEqual(hashesIn(folder.files.get("2026-10.sqlite")), ["ba5e0001"]);
});

test("a month's last session deleted removes the file even when the folder copy still had it", async () => {
    const a = fresh();
    await put(a, "1a510001", SEPT);
    const folder = mapFolder();
    await syncMonths(a.h, folder);
    removeArchived(a.db, "1a510001");
    const r = await syncMonths(a.h, folder);
    assert.deepEqual(r.removed, ["2026-09"]);
    assert.equal(folder.files.size, 0);
});

// --- a file it cannot read ---

test("a month file that is not a readable archive is left exactly as it was, and its month waits", async () => {
    const a = fresh();
    await put(a, "bad00001", OCT);
    const junk = new TextEncoder().encode("this is somebody's notes, not an archive file at all, and it is long enough to pass the size check ".repeat(2));
    const folder = mapFolder(new Map([["2026-10.sqlite", junk]]));
    const r = await syncMonths(a.h, folder);
    assert.deepEqual(r.written, []);
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].month, "2026-10");
    assert.equal(folder.files.get("2026-10.sqlite"), junk, "not overwritten");
    assert.deepEqual(dirtyMonths(a.db), ["2026-10"], "still waiting");
});

// --- an archive from before `removed` existed ---

test("an archive written before `removed` existed opens, deletes, and keeps the delete", async () => {
    const a = fresh();
    await put(a, "01de0001", OCT);
    a.db.exec("DROP TABLE main.removed");   // what an earlier build's migrate left on disk
    migrate(a.db);
    const folder = mapFolder();
    await syncMonths(a.h, folder);
    assert.equal(removeArchived(a.db, "01de0001"), true);
    await syncMonths(a.h, folder);
    assert.equal(folder.files.has("2026-10.sqlite"), false);
});

test("a month file never carries the archive's own list of removed sessions", async () => {
    const a = fresh();
    await put(a, "f11e0001", OCT);
    await put(a, "f11e0002", OCT + 1);
    removeArchived(a.db, "f11e0002");
    const { bytes } = exportMonth(sqlite3, a.raw, "2026-10");
    const b = fresh();
    b.db.exec("ATTACH DATABASE ':memory:' AS f");
    const p = sqlite3.wasm.allocFromTypedArray(bytes);
    sqlite3.capi.sqlite3_deserialize(b.raw.pointer, "f", p, bytes.byteLength, bytes.byteLength, sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_READONLY);
    assert.equal(b.db.selectValue("SELECT count(*) FROM f.sqlite_master WHERE name = 'removed'"), 0);
});

/** The October file of another machine's archive holding `hash`: what its folder would have. */
async function otherMachinesOctober(hash) {
    const a = fresh();
    await put(a, hash, OCT);
    return exportMonth(sqlite3, a.raw, "2026-10").bytes;
}

// --- a month file's unreferenced images ---

test("a folder merge takes in only the images the new sessions reference: an orphan image in a month file is not imported", async () => {
    const old = fresh();
    await put(old, "01d00001", OCT);
    old.db.exec({ sql: "INSERT INTO images(sha, mime, data) VALUES (?, ?, ?)", bind: ["orphan0000", "image/png", new Uint8Array(2000)] });
    // A hostile (or damaged) month file: the whole database, orphan included. exportMonth would never write one.
    const folder = mapFolder(new Map([["2026-10.sqlite", sqlite3.capi.sqlite3_js_db_export(old.raw.pointer)]]));
    const neu = fresh();
    const r = await importMonths(neu.h, folder);
    assert.equal(r.sessions, 1, "control: the session came in");
    assert.deepEqual(neu.db.selectValues("SELECT sha FROM images WHERE sha = 'orphan0000'"), [], "the orphan blob did not");
    // A month file whose sessions the archive already holds imports nothing, images included.
    const again = fresh();
    await put(again, "01d00001", OCT);
    const before = Number(again.db.selectValue("SELECT count(*) FROM images"));
    await importMonths(again.h, folder);
    assert.equal(Number(again.db.selectValue("SELECT count(*) FROM images")), before);
});

// --- the folder's form (part 3a) ---

const CHEAP = { argon: { m: 64, t: 1, p: 1 } };
const keyringA = (await createKeyring("pw-a", CHEAP)).keyring;
const keyringB = (await createKeyring("pw-b", CHEAP)).keyring;
const enc = { form: "encrypted", keyring: keyringA };
const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

test("THE UPGRADE: an archive with no folder_form and a folder of plain files still syncs plain, and nothing else changes", async () => {
    const a = fresh();
    await put(a, "0b1d0001", OCT);
    await put(a, "0b1d0002", SEPT);
    // What the old code left: a folder of plain files, written by a sync with no form at all.
    const folder = mapFolder();
    await syncMonths(a.h, folder);
    assert.equal(a.db.selectValue("SELECT count(*) FROM meta WHERE key = 'folder_form'"), 0, "fixture: the setting was never written");
    assert.equal(folderFormOf(a.db), "plain", "absent reads as plain");
    await put(a, "0b1d0003", OCT + 5);
    const r = await syncMonths(a.h, folder, { form: folderFormOf(a.db), keyring: null });
    assert.deepEqual(r.written, ["2026-10"]);
    assert.deepEqual([...folder.files.keys()].sort(), ["2026-09.sqlite", "2026-10.sqlite"]);
    assert.deepEqual(hashesIn(folder.files.get("2026-10.sqlite")), ["0b1d0001", "0b1d0003"]);
});

test("switching to encrypted rewrites every month as an encrypted file, removes the .sqlite, and a fresh archive with the key imports it back", async () => {
    const a = fresh();
    await put(a, "e0c00001", OCT);
    await put(a, "e0c00002", SEPT);
    const folder = mapFolder();
    await syncMonths(a.h, folder);
    setFolderForm(a.db, "encrypted", keyringA);
    assert.equal(folderFormOf(a.db), "encrypted");
    assert.deepEqual(dirtyMonths(a.db), ["2026-09", "2026-10"], "every month is dirty");
    const r = await syncMonths(a.h, folder, enc);
    assert.deepEqual(r.written, ["2026-09", "2026-10"]);
    assert.deepEqual([...folder.files.keys()].sort(), ["2026-09.wmlbak", "2026-10.wmlbak"]);
    for (const bytes of folder.files.values()) {
        assert.equal(sniff(bytes), "wmlbak");
        assert.equal(readHeader(bytes).kind, "archive-month");
    }
    const neu = fresh();
    const imp = await importMonths(neu.h, folder, keyringA);
    assert.deepEqual({ files: imp.files, sessions: imp.sessions, skipped: imp.skipped.length }, { files: 2, sessions: 2, skipped: 0 });
    assert.equal(readArchived(neu.db, "e0c00001").events[0].task, "remember e0c00001");
    assert.deepEqual(hashesIn(await openBackupBytes(folder.files.get("2026-10.wmlbak"), keyringA)), ["e0c00001"]);
});

test("compressed is a form too: .sqlite.gz written, the other forms' files removed", async () => {
    const a = fresh();
    await put(a, "9210c001", OCT);
    const folder = mapFolder();
    await syncMonths(a.h, folder, enc);
    setFolderForm(a.db, "gzip", null);
    await syncMonths(a.h, folder, { form: "gzip", keyring: keyringA });
    assert.deepEqual([...folder.files.keys()], ["2026-10.sqlite.gz"]);
    assert.equal(sniff(folder.files.get("2026-10.sqlite.gz")), "gzip");
});

test("a month holding both a .sqlite and an encrypted file with different sessions merges both and leaves one file", async () => {
    const x = fresh(), y = fresh();
    await put(x, "b07h0001", OCT);
    await put(y, "b07h0002", OCT + 1);
    const fx = mapFolder(), fy = mapFolder();
    await syncMonths(x.h, fx);
    await syncMonths(y.h, fy, enc);
    const folder = mapFolder(new Map([["2026-10.sqlite", fx.files.get("2026-10.sqlite")], ["2026-10.wmlbak", fy.files.get("2026-10.wmlbak")]]));
    const a = fresh();
    await put(a, "b07h0003", OCT + 2);
    const r = await syncMonths(a.h, folder, enc);
    assert.equal(r.merged, 2);
    assert.deepEqual([...folder.files.keys()], ["2026-10.wmlbak"]);
    assert.deepEqual(hashesIn(await openBackupBytes(folder.files.get("2026-10.wmlbak"), keyringA)), ["b07h0001", "b07h0002", "b07h0003"]);
});

test("an encrypted month with no keyring is skipped as needs-key: bytes unchanged, still dirty, the plain sibling kept", async () => {
    const x = fresh();
    await put(x, "4eed0001", OCT);
    const fx = mapFolder();
    await syncMonths(x.h, fx, enc);
    const locked = fx.files.get("2026-10.wmlbak");
    const a = fresh();
    await put(a, "4eed0002", OCT + 1);
    const plain = await exportBytes(a, "2026-10");
    const folder = mapFolder(new Map([["2026-10.wmlbak", locked], ["2026-10.sqlite", plain]]));
    const r = await syncMonths(a.h, folder, { form: "plain", keyring: null });
    assert.deepEqual(r.written, []);
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].reason, "needs-key");
    assert.equal(typeof r.skipped[0].error, "string");
    assert.equal(folder.files.get("2026-10.wmlbak"), locked);
    assert.equal(folder.files.get("2026-10.sqlite"), plain, "the plain sibling was not removed or rewritten");
    assert.deepEqual(dirtyMonths(a.db), ["2026-10"]);
});

test("an encrypted month under another keyring is skipped as other-key, bytes unchanged", async () => {
    const x = fresh();
    await put(x, "07e00001", OCT);
    const fx = mapFolder();
    await syncMonths(x.h, fx, { form: "encrypted", keyring: keyringB });
    const theirs = fx.files.get("2026-10.wmlbak");
    const a = fresh();
    await put(a, "07e00002", OCT + 1);
    const r = await syncMonths(a.h, fx, enc);
    assert.deepEqual(r.skipped.map((s) => [s.month, s.reason]), [["2026-10", "other-key"]]);
    assert.equal(fx.files.get("2026-10.wmlbak"), theirs);
    assert.deepEqual([...fx.files.keys()], ["2026-10.wmlbak"]);
    assert.deepEqual(dirtyMonths(a.db), ["2026-10"]);
});

test("a damaged encrypted file is unreadable, not needs-key", async () => {
    const x = fresh();
    await put(x, "da4a0001", OCT);
    const fx = mapFolder();
    await syncMonths(x.h, fx, enc);
    const cut = fx.files.get("2026-10.wmlbak").slice(0, 200);
    const a = fresh();
    await put(a, "da4a0002", OCT);
    const r = await syncMonths(a.h, mapFolder(new Map([["2026-10.wmlbak", cut]])), enc);
    assert.equal(r.skipped[0].reason, "unreadable");
});

test("a write that throws leaves the other-form files in place", async () => {
    const a = fresh();
    await put(a, "fa110001", OCT);
    const folder = mapFolder();
    await syncMonths(a.h, folder);
    setFolderForm(a.db, "encrypted", keyringA);
    folder.failWrites = true;
    await assert.rejects(syncMonths(a.h, folder, enc), /disk full/);
    assert.deepEqual([...folder.files.keys()], ["2026-10.sqlite"], "the plain file is still the only copy");
    assert.deepEqual(dirtyMonths(a.db), ["2026-10"]);
});

test("a month left with no sessions removes every form's file", async () => {
    const a = fresh();
    await put(a, "e3070001", OCT);
    const folder = mapFolder();
    await syncMonths(a.h, folder);
    const both = new Map(folder.files);
    both.set("2026-10.sqlite.gz", both.get("2026-10.sqlite"));
    removeArchived(a.db, "e3070001");
    const f2 = mapFolder(both);
    const r = await syncMonths(a.h, f2, enc);
    assert.deepEqual(r.removed, ["2026-10"]);
    assert.equal(f2.files.size, 0);
});

test("folderForm encrypted with no keyring is refused and the form is unchanged; absent stays plain", () => {
    const a = fresh();
    assert.throws(() => setFolderForm(a.db, "encrypted", null), (e) => e.reason === "needs-key");
    assert.equal(folderFormOf(a.db), "plain");
    assert.equal(a.db.selectValue("SELECT count(*) FROM meta WHERE key = 'folder_form'"), 0, "nothing was written");
    assert.throws(() => setFolderForm(a.db, "zip", keyringA), /not a form/);
    setFolderForm(a.db, "gzip", null);
    assert.equal(folderFormOf(a.db), "gzip");
});

/** A month of `a` as plain bytes. */
async function exportBytes(a, month) { return exportMonth(sqlite3, a.raw, month).bytes; }

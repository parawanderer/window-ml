// The archive folder's sync rule (src/archive/folder-sync.ts) over a folder held in a Map: a sync MERGES a month file
// into the archive before rewriting it, so a new browser pointed at an old machine's folder keeps both machines'
// sessions; what the archive removed on purpose stays removed; a file it cannot read is never overwritten.
import test from "node:test";
import assert from "node:assert/strict";
import init from "@sqlite.org/sqlite-wasm";
import { markAllDirty, dirtyMonths, exportMonth, expireRemoved, folderFilesMonths, migrate, prepareSession, readArchived, removeArchived, wasmDb, writeSession, archiveStats, metaSet } from "../src/archive/db.ts";
import { adoptFolder, folderFormOf, importMonths, setFolderForm, surveyFolder, syncMonths } from "../src/archive/folder-sync.ts";
import { adoptKeyring } from "../src/backup/backup-keyring.ts";
import { createKeyring, sniff, readHeader } from "../src/backup/backup-format.ts";
import { digestOf, inspectBackup, openBackupBytes, restoreNewSessions } from "../src/backup/backup-file.ts";

const sqlite3 = await init();
const fresh = () => { const raw = new sqlite3.oo1.DB(":memory:"); const db = wasmDb(raw); migrate(db); return { db, raw, h: { sqlite3, raw } }; };

const DAY = 86_400_000, T0 = Date.UTC(2026, 9, 27);
const OCT = Date.UTC(2026, 9, 10), SEPT = Date.UTC(2026, 8, 10);
const put = async (a, hash, lastTs, archivedTs = 5000) => writeSession(a.db, await prepareSession({
    summary: { id: { runtime: "local", hash }, kind: "agent", status: "done", task: `task ${hash}`, createdTs: lastTs - 10, lastTs, pendingApprovals: 0, saved: true },
    events: [{ kind: "agent", id: hash, ts: lastTs, session: { hash, turn: 0 }, task: `remember ${hash}` }], history: null, bytes: 100,
}), archivedTs);

const EXT = { plain: "sqlite", gzip: "sqlite.gz", encrypted: "wmlbak" };
const FORMS = Object.keys(EXT);
/** A folder of month files in memory, as a sync sees one: file name (`2026-10.sqlite`) to bytes. */
function mapFolder(files = new Map()) {
    const mtimes = new Map();
    let clock = 0;
    const names = (month) => FORMS.filter((f) => files.has(`${month}.${EXT[f]}`));
    return {
        files,
        failWrites: false,
        months: async () => [...new Set([...files.keys()].map((n) => n.slice(0, 7)))].sort(),
        forms: async (m) => names(m),
        read: async (m, form) => files.get(`${m}.${EXT[form]}`) ?? null,
        mtimes,
        /** what a sync of the real folder would see without reading the file: its size and when it was last written */
        stat: async (m, form) => { const b = files.get(`${m}.${EXT[form]}`); return b ? { size: b.length, lastModified: mtimes.get(`${m}.${EXT[form]}`) ?? 0 } : null; },
        write: async function (m, form, bytes) { if (this.failWrites) throw new Error("disk full"); files.set(`${m}.${EXT[form]}`, bytes); mtimes.set(`${m}.${EXT[form]}`, ++clock); this.writes.push(`${m}.${EXT[form]}`); },
        writes: [],
        remove: async (m, form) => { files.delete(`${m}.${EXT[form]}`); },
    };
}
/** A month file's bytes attached read-only to a scratch archive as `f`. */
function attached(bytes) {
    const a = fresh();
    a.db.exec("ATTACH DATABASE ':memory:' AS f");
    const p = sqlite3.wasm.allocFromTypedArray(bytes);
    sqlite3.capi.sqlite3_deserialize(a.raw.pointer, "f", p, bytes.byteLength, bytes.byteLength, sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_READONLY);
    return a.db;
}
/** The session hashes a month file holds. */
function hashesIn(bytes) { return attached(bytes).selectValues("SELECT hash FROM f.sessions ORDER BY hash").map(String); }
/** The `removed` entries a month file holds as `hash@ts`, or null when it has no such table (a file from before 3b). */
function entriesIn(bytes) {
    const db = attached(bytes);
    if (!db.selectValue("SELECT count(*) FROM f.sqlite_master WHERE name = 'removed'")) return null;
    return db.selectObjects("SELECT hash, ts FROM f.removed ORDER BY hash").map((r) => `${r.hash}@${r.ts}`);
}
const removedOf = (a) => a.db.selectObjects("SELECT hash, ts FROM removed ORDER BY hash").map((r) => `${r.hash}@${r.ts}`);

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
    assert.deepEqual(r.imported, { files: 2, sessions: 2, deleted: 0 });
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
    assert.deepEqual(hashesIn(folder.files.get("2026-10.sqlite")), [], "the month emptied; its file keeps only the entry (part 3b)");
    assert.equal(entriesIn(folder.files.get("2026-10.sqlite")).length, 1);
    await put(a, "ba5e0001", OCT + 50, Date.now() + 10);   // retention archives it again, later than the delete
    await syncMonths(a.h, folder);
    assert.deepEqual(hashesIn(folder.files.get("2026-10.sqlite")), ["ba5e0001"]);
    assert.deepEqual(entriesIn(folder.files.get("2026-10.sqlite")), [], "archived again: the entry is gone from the file too");
});

test("a month's last session deleted rewrites the file as entries only, even when the folder copy still had the session", async () => {
    const a = fresh();
    await put(a, "1a510001", SEPT);
    const folder = mapFolder();
    await syncMonths(a.h, folder);
    removeArchived(a.db, "1a510001");
    const r = await syncMonths(a.h, folder);
    assert.deepEqual([r.written, r.removed], [["2026-09"], []]);
    assert.deepEqual(hashesIn(folder.files.get("2026-09.sqlite")), []);
    assert.equal(entriesIn(folder.files.get("2026-09.sqlite")).length, 1);
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
    assert.deepEqual(hashesIn(folder.files.get("2026-10.sqlite")), [], "the delete stayed deleted");
    assert.equal(entriesIn(folder.files.get("2026-10.sqlite")).length, 1);
});

test("a month file carries the removed entries of ITS month and no other", async () => {
    const a = fresh();
    await put(a, "f11e0001", OCT);
    await put(a, "f11e0002", OCT + 1);
    await put(a, "f11e0003", SEPT);
    removeArchived(a.db, "f11e0002", 7_000_000_000_000);
    removeArchived(a.db, "f11e0003", 7_000_000_000_001);
    const now = 7_000_000_000_000;
    const oct = exportMonth(sqlite3, a.raw, "2026-10", now);
    assert.deepEqual([oct.sessions, oct.removed], [1, 1]);
    assert.deepEqual(entriesIn(oct.bytes), ["f11e0002@7000000000000"]);
    assert.deepEqual(entriesIn(exportMonth(sqlite3, a.raw, "2026-09", now).bytes), ["f11e0003@7000000000001"]);
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
    assert.equal(folderFormOf(a.db), null, "no folder_form and no last_sync: a folder never synced, so the form is unchosen");
    // What the old worker's sync also left: the time it last wrote. An archive that had a folder reads as plain.
    metaSet(a.db, "last_sync", String(Date.now()));
    assert.equal(folderFormOf(a.db), "plain", "absent reads as plain once it has synced");
    await put(a, "0b1d0003", OCT + 5);
    const r = await syncMonths(a.h, folder, { form: folderFormOf(a.db), keyring: null });
    assert.deepEqual(r.written, ["2026-10"]);
    assert.deepEqual([...folder.files.keys()].sort(), ["2026-09.sqlite", "2026-10.sqlite"]);
    assert.deepEqual(hashesIn(folder.files.get("2026-10.sqlite")), ["0b1d0001", "0b1d0003"]);
});

test("a NEW folder (no folder_form, never synced) writes nothing until its form is chosen: months stay pending, then setFolderForm lets the sync write", async () => {
    const a = fresh();
    await put(a, "0e000001", OCT);
    await put(a, "0e000002", SEPT);
    const folder = mapFolder();
    assert.equal(folderFormOf(a.db), null);
    const r = await syncMonths(a.h, folder, { form: folderFormOf(a.db), keyring: keyringA });
    assert.deepEqual([r.written, r.removed, r.skipped], [[], [], []]);
    assert.equal(folder.files.size, 0, "no plain file lands in the new folder");
    assert.deepEqual(dirtyMonths(a.db), ["2026-09", "2026-10"], "still pending");
    // A pick takes in what the folder holds, and still writes nothing.
    const adopted = await adoptFolder(a.h, folder, { form: null, keyring: keyringA });
    assert.equal(adopted.written.length, 0);
    assert.equal(folder.files.size, 0);
    setFolderForm(a.db, "encrypted", keyringA);
    const w = await syncMonths(a.h, folder, { form: folderFormOf(a.db), keyring: keyringA });
    assert.deepEqual(w.written, ["2026-09", "2026-10"]);
    assert.deepEqual([...folder.files.keys()].sort(), ["2026-09.wmlbak", "2026-10.wmlbak"]);
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

test("a month left with neither sessions nor live entries removes every form's file", async () => {
    const a = fresh();
    await put(a, "e3070001", OCT);
    const folder = mapFolder();
    await syncMonths(a.h, folder);
    const both = new Map(folder.files);
    both.set("2026-10.sqlite.gz", both.get("2026-10.sqlite"));
    removeArchived(a.db, "e3070001", T0);
    const f2 = mapFolder(both);
    // The delete's entry is still live, so the month keeps a file; once it has expired nothing is left to say.
    assert.deepEqual((await syncMonths(a.h, f2, { ...enc, now: T0 })).removed, []);
    const r = await syncMonths(a.h, f2, { ...enc, now: T0 + 181 * DAY });
    assert.deepEqual(r.removed, ["2026-10"]);
    assert.equal(f2.files.size, 0);
});

test("folderForm encrypted with no keyring is refused and the form is unchanged; absent stays unchosen", () => {
    const a = fresh();
    assert.throws(() => setFolderForm(a.db, "encrypted", null), (e) => e.reason === "needs-key");
    assert.equal(folderFormOf(a.db), null);
    assert.equal(a.db.selectValue("SELECT count(*) FROM meta WHERE key = 'folder_form'"), 0, "nothing was written");
    assert.throws(() => setFolderForm(a.db, "zip", keyringA), /not a form/);
    setFolderForm(a.db, "gzip", null);
    assert.equal(folderFormOf(a.db), "gzip");
});

/** A month of `a` as plain bytes. */
async function exportBytes(a, month) { return exportMonth(sqlite3, a.raw, month).bytes; }

// --- deletes travel between machines through the month files (part 3b) ---

const ARCH = T0 - 3 * DAY, DEL = T0 - 2 * DAY, AGAIN = T0 - 1 * DAY;
const P = { form: "plain", keyring: null, now: T0 };
const hasIt = (a, hash) => readArchived(a.db, hash) !== null;
/** Two machines, A and B, that both hold `hashes` (archived at ARCH) in OCT through one shared folder, in sync. */
async function twoMachines(...hashes) {
    const A = fresh(), B = fresh();
    for (const [i, h] of hashes.entries()) await put(A, h, OCT + i, ARCH);
    const folder = mapFolder();
    await syncMonths(A.h, folder, P);
    await syncMonths(B.h, folder, P);
    assert.ok(hashes.every((h) => hasIt(B, h)), "fixture: B holds what A archived");
    return { A, B, folder };
}

test("A deletes a session both hold: B's next sync removes it, keeping A's time, and B's sync does not bring it back to A", async () => {
    const { A, B, folder } = await twoMachines("de1e0a01", "de1e0a02");
    removeArchived(A.db, "de1e0a01", DEL);
    await syncMonths(A.h, folder, P);
    assert.deepEqual(hashesIn(folder.files.get("2026-10.sqlite")), ["de1e0a02"]);
    assert.deepEqual(entriesIn(folder.files.get("2026-10.sqlite")), [`de1e0a01@${DEL}`]);

    const r = await syncMonths(B.h, folder, P);
    assert.equal(r.deleted, 1);
    assert.equal(r.merged, 0, "merged still means sessions added");
    assert.equal(hasIt(B, "de1e0a01"), false);
    assert.equal(hasIt(B, "de1e0a02"), true);
    assert.deepEqual(removedOf(B), [`de1e0a01@${DEL}`], "the entry keeps the file's time, not now");
    assert.deepEqual(entriesIn(folder.files.get("2026-10.sqlite")), [`de1e0a01@${DEL}`], "and B writes it on");

    const back = await syncMonths(A.h, folder, P);
    assert.deepEqual([back.merged, back.deleted], [0, 0]);
    assert.equal(hasIt(A, "de1e0a01"), false, "B's file does not bring it back");
    assert.equal(hasIt(B, "de1e0a01"), false);
});

test("A deletes, B archives the same session again later: B's copy survives A's entry, and A takes it back and drops its entry", async () => {
    const { A, B, folder } = await twoMachines("a6a10b01");
    removeArchived(A.db, "a6a10b01", DEL);
    await syncMonths(A.h, folder, P);
    await put(B, "a6a10b01", OCT, AGAIN);   // archived again after the delete
    const b = await syncMonths(B.h, folder, P);
    assert.equal(b.deleted, 0, "the entry arrived and did not remove the newer copy");
    assert.equal(hasIt(B, "a6a10b01"), true);
    assert.deepEqual(removedOf(B), [], "and was not added");
    assert.deepEqual(entriesIn(folder.files.get("2026-10.sqlite")), []);

    const a = await syncMonths(A.h, folder, P);
    assert.equal(a.merged, 1);
    assert.equal(hasIt(A, "a6a10b01"), true);
    assert.deepEqual(removedOf(A), [], "A's entry is gone");
});

test("B archived it after A's delete but syncs first: A's entry arriving later does not remove B's newer copy", async () => {
    const { A, B, folder } = await twoMachines("5e1f0c01");
    removeArchived(A.db, "5e1f0c01", DEL);   // A has not synced yet
    await put(B, "5e1f0c01", OCT, AGAIN);
    await syncMonths(B.h, folder, P);
    assert.deepEqual(hashesIn(folder.files.get("2026-10.sqlite")), ["5e1f0c01"]);

    const a = await syncMonths(A.h, folder, P);
    assert.deepEqual([a.merged, a.deleted], [1, 0]);
    assert.equal(hasIt(A, "5e1f0c01"), true, "A's own older delete lost to B's newer archive");
    assert.deepEqual(removedOf(A), []);
    assert.deepEqual(hashesIn(folder.files.get("2026-10.sqlite")), ["5e1f0c01"], "the file never lost it");
    assert.equal((await syncMonths(B.h, folder, P)).deleted, 0);
    assert.equal(hasIt(B, "5e1f0c01"), true);
});

test("all of a month's sessions deleted on A: the file keeps only the entries, B removes them, and after expiry the file goes", async () => {
    const { A, B, folder } = await twoMachines("a11d0d01", "a11d0d02");
    removeArchived(A.db, "a11d0d01", DEL);
    removeArchived(A.db, "a11d0d02", DEL);
    const w = await syncMonths(A.h, folder, P);
    assert.deepEqual([w.written, w.removed], [["2026-10"], []]);
    assert.deepEqual(hashesIn(folder.files.get("2026-10.sqlite")), []);
    assert.deepEqual(entriesIn(folder.files.get("2026-10.sqlite")), [`a11d0d01@${DEL}`, `a11d0d02@${DEL}`]);

    assert.equal((await syncMonths(B.h, folder, P)).deleted, 2);
    assert.equal(archiveStats(B.db).sessions, 0);

    // 100 days on: the entries are live, the file stays.
    await syncMonths(A.h, folder, { ...P, now: T0 + 100 * DAY });
    assert.deepEqual([...folder.files.keys()], ["2026-10.sqlite"]);
    // 180 days after the delete: neither entries nor sessions, so the file goes, and the archive forgets the entries.
    const late = { ...P, now: DEL + 181 * DAY };
    const r = await syncMonths(A.h, folder, late);
    assert.deepEqual(r.removed, ["2026-10"]);
    assert.equal(folder.files.size, 0);
    assert.deepEqual(removedOf(A), []);
});

test("an entry older than the expiry is never written into a month file, and a file that carried one is rewritten without it", async () => {
    const A = fresh();
    await put(A, "e4b1ed01", OCT, ARCH);
    await put(A, "e4b1ed02", OCT + 1, ARCH);
    removeArchived(A.db, "e4b1ed01", DEL);
    const folder = mapFolder();
    await syncMonths(A.h, folder, P);
    assert.deepEqual(entriesIn(folder.files.get("2026-10.sqlite")), [`e4b1ed01@${DEL}`]);
    assert.equal(exportMonth(sqlite3, A.raw, "2026-10", DEL + 181 * DAY).removed, 0, "the export leaves it out");
    assert.equal(expireRemoved(A.db, DEL + 181 * DAY), 1);
    assert.deepEqual(dirtyMonths(A.db), ["2026-10"], "and its month is rewritten");
    await syncMonths(A.h, folder, { ...P, now: DEL + 181 * DAY });
    assert.deepEqual(entriesIn(folder.files.get("2026-10.sqlite")), []);
    assert.deepEqual(hashesIn(folder.files.get("2026-10.sqlite")), ["e4b1ed02"]);
});

test("encrypted: the entries survive sealing, and the other machine reading the encrypted file removes the session", async () => {
    const A = fresh(), B = fresh();
    await put(A, "e2c70e01", OCT, ARCH);
    const folder = mapFolder();
    const E = { form: "encrypted", keyring: keyringA, now: T0 };
    await syncMonths(A.h, folder, E);
    await syncMonths(B.h, folder, E);
    assert.equal(hasIt(B, "e2c70e01"), true);
    removeArchived(A.db, "e2c70e01", DEL);
    await syncMonths(A.h, folder, E);
    assert.deepEqual([...folder.files.keys()], ["2026-10.wmlbak"], "an entries-only month is written in the chosen form");
    const plain = await openBackupBytes(folder.files.get("2026-10.wmlbak"), keyringA);
    assert.deepEqual([hashesIn(plain), entriesIn(plain)], [[], [`e2c70e01@${DEL}`]]);
    assert.equal((await syncMonths(B.h, folder, E)).deleted, 1);
    assert.equal(hasIt(B, "e2c70e01"), false);
});

test("THE UPGRADE: a month file from before 3b (no removed table) merges as before, and a local entry still keeps a deleted session out", async () => {
    const X = fresh();
    await put(X, "01d3b001", OCT, ARCH);
    await put(X, "01d3b002", OCT + 1, ARCH);
    // What the previous build wrote: the same file without the `removed` table.
    const old = new sqlite3.oo1.DB(":memory:");
    const bytes = exportMonth(sqlite3, X.raw, "2026-10", T0).bytes;
    const p = sqlite3.wasm.allocFromTypedArray(bytes);
    sqlite3.capi.sqlite3_deserialize(old.pointer, "main", p, bytes.byteLength, bytes.byteLength, sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE);
    old.exec("DROP TABLE removed");
    const oldBytes = sqlite3.capi.sqlite3_js_db_export(old.pointer);
    assert.equal(entriesIn(oldBytes), null, "fixture: no removed table");

    const B = fresh();
    await put(B, "01d3b002", OCT + 1, ARCH);
    removeArchived(B.db, "01d3b002", DEL);   // B deleted one of the two itself
    const folder = mapFolder(new Map([["2026-10.sqlite", oldBytes]]));
    const r = await syncMonths(B.h, folder, P);
    assert.deepEqual([r.merged, r.deleted], [1, 0]);
    assert.deepEqual([hasIt(B, "01d3b001"), hasIt(B, "01d3b002")], [true, false]);
    assert.deepEqual(hashesIn(folder.files.get("2026-10.sqlite")), ["01d3b001"], "rewritten in the new shape");
    assert.deepEqual(entriesIn(folder.files.get("2026-10.sqlite")), [`01d3b002@${DEL}`]);
});

test("a restore from a backup file imports what it previewed: a local removed entry blocks a session whatever its archived_ts, and the file's own entries delete nothing", async () => {
    // The backup: holds Y, and X archived AFTER this archive deleted X, and carries an entry for Z.
    const src = fresh();
    await put(src, "7e570f01", OCT, ARCH);        // Y
    await put(src, "7e570f02", OCT + 1, AGAIN);   // X
    await put(src, "7e570f03", OCT + 2, ARCH);    // Z, deleted on the source
    removeArchived(src.db, "7e570f03", DEL);
    const file = exportMonth(sqlite3, src.raw, "2026-10", T0).bytes;
    assert.deepEqual(entriesIn(file), [`7e570f03@${DEL}`], "fixture: the file carries an entry");

    const here = fresh();
    await put(here, "7e570f03", OCT + 2, ARCH);   // Z is held here
    await put(here, "7e570f02", OCT + 1, ARCH);
    removeArchived(here.db, "7e570f02", DEL);     // X was deleted here
    const seen = inspectBackup(sqlite3, here.raw, file);
    assert.deepEqual(seen.hashes, ["7e570f01"], "the preview: Y only; X is blocked by this archive's entry although the backup copy is newer");
    const added = await restoreNewSessions(sqlite3, here.raw, file, file, { digest: await digestOf(file), hashes: seen.hashes });
    assert.equal(added, 1);
    assert.deepEqual([hasIt(here, "7e570f01"), hasIt(here, "7e570f02"), hasIt(here, "7e570f03")], [true, false, true], "Z stays: a restore deletes nothing");
    assert.deepEqual(removedOf(here), [`7e570f02@${DEL}`], "and this archive's entries are as they were");
});

// --- a sync merges month files another machine changed (part 3b) ---

test("A archives a new session and syncs: B's plain sync, with nothing dirty on B, takes it in", async () => {
    const { A, B, folder } = await twoMachines("5ee00e01");
    await put(A, "5ee00e02", OCT + 5, ARCH);
    await syncMonths(A.h, folder, P);
    assert.deepEqual(dirtyMonths(B.db), [], "fixture: nothing is pending on B");
    const r = await syncMonths(B.h, folder, P);
    assert.equal(r.merged, 1);
    assert.equal(hasIt(B, "5ee00e02"), true);
});

test("two archives syncing back and forth with no changes reach a state where neither writes", async () => {
    const { A, B, folder } = await twoMachines("9019e001");
    await put(A, "9019e002", OCT + 3, ARCH);
    await put(B, "9019e003", OCT + 4, ARCH);
    removeArchived(A.db, "9019e001", DEL);
    for (let i = 0; i < 3; i++) { await syncMonths(A.h, folder, P); await syncMonths(B.h, folder, P); }
    for (const M of [A, B]) assert.deepEqual([hasIt(M, "9019e002"), hasIt(M, "9019e003"), hasIt(M, "9019e001")], [true, true, false]);
    const settled = folder.writes.length;
    for (let i = 0; i < 3; i++) {
        const a = await syncMonths(A.h, folder, P), b = await syncMonths(B.h, folder, P);
        assert.deepEqual([a.written, b.written, a.merged, b.merged, a.deleted, b.deleted], [[], [], 0, 0, 0, 0]);
    }
    assert.equal(folder.writes.length, settled, "no file was rewritten once both had merged");
});

test("THE UPGRADE: an archive with no remembered file stats merges every file once at its first sync, then leaves them alone", async () => {
    const X = fresh();
    await put(X, "0b5e7001", OCT, ARCH);
    const folder = mapFolder();
    await syncMonths(X.h, folder, P);
    const A = fresh();   // an archive from before 3b: the table does not exist yet, and migrate makes it empty
    A.db.exec("DROP TABLE main.folder_files");
    migrate(A.db);
    assert.deepEqual(folderFilesMonths(A.db), []);
    const first = await syncMonths(A.h, folder, P);
    assert.equal(first.merged, 1, "the first sync after the upgrade merged the file");
    assert.deepEqual(folderFilesMonths(A.db), ["2026-10"]);
    const settled = folder.writes.length;
    const second = await syncMonths(A.h, folder, P);
    assert.deepEqual([second.merged, second.written], [0, []]);
    assert.equal(folder.writes.length, settled, "and the second wrote nothing");
});

test("another machine emptied the month and removed its file: a sync rewrites it while this archive still holds sessions, and forgets it when nothing is left", async () => {
    const { A, folder } = await twoMachines("e3b7e001");
    folder.files.delete("2026-10.sqlite");   // the other machine removed the month's file
    const r = await syncMonths(A.h, folder, P);
    assert.deepEqual(r.written, ["2026-10"]);
    assert.deepEqual(hashesIn(folder.files.get("2026-10.sqlite")), ["e3b7e001"]);
    // Nothing held for the month: the file goes and the memory of it goes with it.
    removeArchived(A.db, "e3b7e001", DEL);
    await syncMonths(A.h, folder, P);
    await syncMonths(A.h, folder, { ...P, now: DEL + 181 * DAY });
    assert.equal(folder.files.size, 0);
    assert.deepEqual(folderFilesMonths(A.db), []);
    const idle = await syncMonths(A.h, folder, { ...P, now: DEL + 181 * DAY });
    assert.deepEqual([idle.written, idle.removed, idle.skipped], [[], [], []]);
});

test("a changed file this install cannot read is skipped as a dirty one is: bytes unchanged, stats not recorded", async () => {
    const X = fresh();
    await put(X, "5c19e001", OCT, ARCH);
    const folder = mapFolder();
    await syncMonths(X.h, folder, { form: "encrypted", keyring: keyringB, now: T0 });
    const theirs = folder.files.get("2026-10.wmlbak");
    const A = fresh();
    const r = await syncMonths(A.h, folder, { form: "encrypted", keyring: keyringA, now: T0 });
    assert.deepEqual(r.skipped.map((x) => [x.month, x.reason]), [["2026-10", "other-key"]]);
    assert.equal(folder.files.get("2026-10.wmlbak"), theirs);
    assert.deepEqual(folderFilesMonths(A.db), [], "not recorded, so it is tried again next time");
    assert.equal((await syncMonths(A.h, folder, { form: "encrypted", keyring: keyringA, now: T0 })).skipped.length, 1);
});

// --- two machines on different forms (part 3b) ---

test("A plain and B encrypted sharing a keyring settle: neither rewrites the other's month for ever, and both see each other's sessions", async () => {
    const A = fresh(), B = fresh();
    const pa = { form: "plain", keyring: keyringA, now: T0 }, eb = { form: "encrypted", keyring: keyringA, now: T0 };
    const folder = mapFolder();
    await put(A, "d1ff0001", OCT, ARCH);
    await put(B, "d1ff0002", OCT + 1, ARCH);
    await syncMonths(A.h, folder, pa);
    for (let i = 0; i < 3; i++) { await syncMonths(B.h, folder, eb); await syncMonths(A.h, folder, pa); }
    for (const M of [A, B]) assert.deepEqual([hasIt(M, "d1ff0001"), hasIt(M, "d1ff0002")], [true, true]);
    const settled = folder.writes.length;
    for (let i = 0; i < 3; i++) {
        const b = await syncMonths(B.h, folder, eb), a = await syncMonths(A.h, folder, pa);
        assert.deepEqual([a.written, b.written], [[], []]);
    }
    assert.equal(folder.writes.length, settled, "no file was rewritten once both had merged");
});

// --- a second machine adopts the folder's key (part 3c) ---

/** A keyring store in memory, with the calls made on it. */
function memStore(ring = null) {
    const calls = [];
    return { calls, read: async () => ring, create: async (r) => { calls.push("create"); if (ring) throw new Error("already set up"); ring = r; }, replace: async (r) => { calls.push("replace"); ring = r; } };
}
/** An install: its keyring in a store, its archive, and the recovery key of its keyring. */
async function machine(pass, ...sessions) {
    const made = await createKeyring(pass, CHEAP);
    const m = { ...fresh(), store: memStore(made.keyring), recoveryKey: made.recoveryKey, pass, keyId: made.keyring.keyId };
    for (const [hash, ts] of sessions) await put(m, hash, ts, ARCH);
    return m;
}
/** One sync of `m` into `folder` as the encrypted form, with whatever key `m` holds now. */
const syncEnc = async (m, folder) => syncMonths(m.h, folder, { form: "encrypted", keyring: await m.store.read(), now: T0 });
/** Every machine syncs until a full round writes nothing; the folder's writes at the end. */
async function settle(folder, ...ms) {
    for (let i = 0; i < 4; i++) for (const m of ms) await syncEnc(m, folder);
    const done = folder.writes.length;
    for (const m of ms) assert.deepEqual((await syncEnc(m, folder)).written, [], "a settled folder is not written again");
    assert.equal(folder.writes.length, done);
}

for (const [how, secretOf] of [["passphrase", (m) => ({ passphrase: m.pass })], ["recovery key", (m) => ({ recoveryKey: m.recoveryKey })]]) {
    test(`B skips A's months as other-key, adopts A's key with its ${how}, and then both read every month and the folder settles`, async () => {
        const A = await machine("pw-of-a", ["ad0pt001", OCT], ["ad0pt002", SEPT]);
        const B = await machine("pw-of-b", ["ad0pt0b1", OCT + 1]);
        const folder = mapFolder();
        await syncEnc(A, folder);
        const first = await syncEnc(B, folder);
        assert.deepEqual(first.skipped.map((s) => [s.month, s.reason, s.keyId]), [["2026-09", "other-key", A.keyId], ["2026-10", "other-key", A.keyId]]);
        assert.equal(hasIt(B, "ad0pt001"), false);
        // The page reads the header of one skipped month and adopts from it.
        const header = folder.files.get("2026-10.wmlbak");
        assert.equal(await adoptKeyring(B.store, header, secretOf(A)), A.keyId);
        assert.deepEqual(B.store.calls, ["replace"]);
        // `rekey`: every month dirty, then a sync.
        markAllDirty(B.db);
        const r = await syncEnc(B, folder);
        assert.deepEqual([r.skipped, r.merged], [[], 2], "A's two sessions came in");
        assert.deepEqual(r.written.sort(), ["2026-09", "2026-10"], "B's own month and A's both rewritten under the new key");
        for (const f of ["2026-09.wmlbak", "2026-10.wmlbak"]) assert.equal(readHeader(folder.files.get(f)).keyId, A.keyId, f);
        // A's next sync reads every month and B's session arrives.
        const a = await syncEnc(A, folder);
        assert.deepEqual([a.skipped, a.merged], [[], 1]);
        assert.equal(hasIt(A, "ad0pt0b1"), true);
        await settle(folder, A, B);
        for (const M of [A, B]) assert.deepEqual(["ad0pt001", "ad0pt002", "ad0pt0b1"].map((h) => hasIt(M, h)), [true, true, true]);
    });
}

test("a new install with no keyring adopts by creating one, then reads the whole folder", async () => {
    const A = await machine("pw-of-a", ["0e00a001", OCT]);
    const folder = mapFolder();
    await syncEnc(A, folder);
    const N = { ...fresh(), store: memStore() };
    const before = await syncMonths(N.h, folder, { form: "encrypted", keyring: null, now: T0 }).catch((e) => e);
    assert.equal(before.reason, "needs-key", "an encrypted folder cannot be written without a key");
    const imp = await importMonths(N.h, folder, null);
    assert.deepEqual(imp.skipped.map((s) => [s.reason, s.keyId]), [["needs-key", A.keyId]], "the skip names the key even with none to compare");
    await adoptKeyring(N.store, folder.files.get("2026-10.wmlbak"), { passphrase: "pw-of-a" });
    assert.deepEqual(N.store.calls, ["create"]);
    const r = await syncEnc(N, folder);
    assert.deepEqual([r.skipped, r.merged], [[], 1]);
    assert.equal(hasIt(N, "0e00a001"), true);
});

test("the swap: A adopts B's key while B adopts A's, before either syncs again; each still reads the other's months and the folder settles", async () => {
    // A wrote October under KA, B wrote September under KB; each skipped the other's month.
    const A = await machine("pw-of-a", ["5a0a0001", OCT]);
    const B = await machine("pw-of-b", ["5a0b0001", SEPT]);
    const folder = mapFolder();
    await syncEnc(A, folder);
    await syncEnc(B, folder);
    const skippedA = (await syncEnc(A, folder)).skipped, skippedB = (await syncEnc(B, folder)).skipped;
    assert.deepEqual([skippedA.map((s) => [s.month, s.keyId]), skippedB.map((s) => [s.month, s.keyId])], [[["2026-09", B.keyId]], [["2026-10", A.keyId]]]);
    const [fromA, fromB] = [folder.files.get("2026-10.wmlbak"), folder.files.get("2026-09.wmlbak")];
    await adoptKeyring(A.store, fromB, { passphrase: "pw-of-b" });
    await adoptKeyring(B.store, fromA, { passphrase: "pw-of-a" });
    assert.deepEqual([(await A.store.read()).keyId, (await B.store.read()).keyId], [B.keyId, A.keyId], "swapped");
    for (const M of [A, B]) markAllDirty(M.db);
    await settle(folder, A, B);
    for (const M of [A, B]) assert.deepEqual([hasIt(M, "5a0a0001"), hasIt(M, "5a0b0001")], [true, true]);
    for (const M of [A, B]) assert.deepEqual((await syncEnc(M, folder)).skipped, [], "every month opens with the current or the retired key");
});

// The archive folder's sync rule (src/archive/folder-sync.ts) over a folder held in a Map: a sync MERGES a month file
// into the archive before rewriting it, so a new browser pointed at an old machine's folder keeps both machines'
// sessions; what the archive removed on purpose stays removed; a file it cannot read is never overwritten.
import test from "node:test";
import assert from "node:assert/strict";
import init from "@sqlite.org/sqlite-wasm";
import { dirtyMonths, exportMonth, migrate, prepareSession, readArchived, removeArchived, wasmDb, writeSession, archiveStats } from "../src/archive/db.ts";
import { adoptFolder, importMonths, surveyFolder, syncMonths } from "../src/archive/folder-sync.ts";

const sqlite3 = await init();
const fresh = () => { const raw = new sqlite3.oo1.DB(":memory:"); const db = wasmDb(raw); migrate(db); return { db, raw, h: { sqlite3, raw } }; };

const OCT = Date.UTC(2026, 9, 10), SEPT = Date.UTC(2026, 8, 10);
const put = async (a, hash, lastTs) => writeSession(a.db, await prepareSession({
    summary: { id: { runtime: "local", hash }, kind: "agent", status: "done", task: `task ${hash}`, createdTs: lastTs - 10, lastTs, pendingApprovals: 0, saved: true },
    events: [{ kind: "agent", id: hash, ts: lastTs, session: { hash, turn: 0 }, task: `remember ${hash}` }], history: null, bytes: 100,
}), 5000);

/** A folder of month files in memory, as a sync sees one. */
function mapFolder(files = new Map()) {
    return {
        files,
        months: async () => [...files.keys()].sort(),
        read: async (m) => files.get(m) ?? null,
        write: async (m, bytes) => { files.set(m, bytes); },
        remove: async (m) => { files.delete(m); },
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
    assert.deepEqual(hashesIn(folder.files.get("2026-10")), ["01d00001", "01d00002"]);

    // The new machine archives something into October and syncs, never having clicked Import.
    const neu = fresh();
    await put(neu, "0e000003", OCT + 2000);
    const r = await syncMonths(neu.h, folder);
    assert.deepEqual(r.written, ["2026-10"]);
    assert.equal(r.merged, 2, "the old machine's two sessions were taken in first");
    assert.deepEqual(hashesIn(folder.files.get("2026-10")), ["01d00001", "01d00002", "0e000003"], "nothing the folder held was dropped");
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
    assert.deepEqual(hashesIn(folder.files.get("2026-09")), ["01d0aa01"]);
    assert.deepEqual(hashesIn(folder.files.get("2026-10")), ["01d0aa02", "0e0aa003"]);
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
    assert.deepEqual(hashesIn(folder.files.get("2026-10")), ["de1e0002"]);
    assert.equal(readArchived(a.db, "de1e0001"), null);
    // An explicit Import skips it too.
    assert.equal((await importMonths(a.h, mapFolder(new Map([["2026-10", await otherMachinesOctober("de1e0001")]])))).sessions, 0);
});

test("a session un-archived and archived again is written again, not held back as removed", async () => {
    const a = fresh();
    await put(a, "ba5e0001", OCT);
    const folder = mapFolder();
    await syncMonths(a.h, folder);
    removeArchived(a.db, "ba5e0001");   // opened: back in the live store
    await syncMonths(a.h, folder);
    assert.equal(folder.files.has("2026-10"), false, "the month emptied, so its file went");
    await put(a, "ba5e0001", OCT + 50);   // retention archives it again
    await syncMonths(a.h, folder);
    assert.deepEqual(hashesIn(folder.files.get("2026-10")), ["ba5e0001"]);
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
    const folder = mapFolder(new Map([["2026-10", junk]]));
    const r = await syncMonths(a.h, folder);
    assert.deepEqual(r.written, []);
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].month, "2026-10");
    assert.equal(folder.files.get("2026-10"), junk, "not overwritten");
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
    assert.equal(folder.files.has("2026-10"), false);
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
    const folder = mapFolder(new Map([["2026-10", sqlite3.capi.sqlite3_js_db_export(old.raw.pointer)]]));
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

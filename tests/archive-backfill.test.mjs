// archive-backfill.test.mjs — re-encoding the session archive's PNG screenshots as lossless WebP (db.ts `pngBatch`/
// `replacePngs`, sw-image-compact.ts `archiveImageCompactor`): an image is replaced in place and every event pointing at
// it reads the WebP, a kept PNG is not tried again, the months that show it are rewritten, an older month file cannot
// bring the PNG back, and the pass is a background job that resumes where a stopped one left off.
import test from "node:test";
import assert from "node:assert/strict";
import init from "@sqlite.org/sqlite-wasm";
import { archiveStats, dirtyMonths, exportMonth, importBytes, markClean, migrate, pngBatch, pngPending, prepareSession, readArchived, replacePngs, wasmDb, writeSession } from "../src/archive/db.ts";
import { archiveImageCompactor, archiveCompactionJob } from "../src/sw/sw-image-compact.ts";
import { jobStatus } from "../src/job-registry.ts";

const sqlite3 = await init();
const fresh = () => { const raw = new sqlite3.oo1.DB(":memory:"); const db = wasmDb(raw); migrate(db); db.raw = raw; return db; };

const url = (mime, text) => `data:${mime};base64,${Buffer.from(text).toString("base64")}`;
// Two PNGs and their WebPs: what the encoder answers is only ever smaller, or null to keep the PNG.
const PNG_A = url("image/png", "png A, a screenshot of a page, long enough to be worth shrinking");
const PNG_B = url("image/png", "png B, another screenshot of a different page, also long enough");
const WEBP = (png) => url("image/webp", `webp of ${png.slice(-6)}`);
const SEPT = Date.UTC(2026, 8, 10), OCT = Date.UTC(2026, 9, 10);

const summary = (hash, lastTs) => ({ id: { runtime: "local", hash }, kind: "agent", status: "done", task: `task ${hash}`, createdTs: lastTs - 10, lastTs, pendingApprovals: 0, saved: true });
const events = (hash, img) => [
    { kind: "agent-step", id: hash, ts: 1, session: { hash, turn: 0 }, step: 1, seq: 1, tool: "look", result: { kind: "image", dataUrl: img } },
    { kind: "agent-step", id: hash, ts: 2, session: { hash, turn: 0 }, step: 2, seq: 2, tool: "look", renderOut: [{ type: "look", image: img }] },
];
const put = async (db, hash, lastTs, img) => writeSession(db, await prepareSession({ summary: summary(hash, lastTs), events: events(hash, img), history: { kind: "agent", messages: [{ role: "user", content: "hi" }] }, bytes: 1 }), 5000);
const cleanAll = (db) => { for (const m of dirtyMonths(db)) markClean(db, m); };

// --- the archive: replacing images in place ---

test("a replaced image reads back as the WebP in every event that showed it, and the archive shrinks", async () => {
    const db = fresh();
    await put(db, "aaaa0001", SEPT, PNG_A);
    await put(db, "aaaa0002", OCT, PNG_A);
    const before = archiveStats(db).imageBytes;
    assert.equal(pngPending(db), 1, "one image, stored once for both sessions");
    const [only] = pngBatch(db, 8);
    assert.equal(only.url, PNG_A, "handed out as the data URL it was stored from");

    const r = replacePngs(db, [{ sha: only.sha, url: WEBP(PNG_A) }]);
    assert.deepEqual([r.replaced, r.kept, r.pending], [1, 0, 0]);
    assert.ok(r.bytesAfter < r.bytesBefore);
    assert.ok(archiveStats(db).imageBytes < before);
    for (const h of ["aaaa0001", "aaaa0002"]) assert.deepEqual(readArchived(db, h).events, events(h, WEBP(PNG_A)), h);
});

test("a PNG the encoder keeps is not tried again, and one replaced already is left alone", async () => {
    const db = fresh();
    await put(db, "bbbb0001", SEPT, PNG_A);
    await put(db, "bbbb0002", SEPT, PNG_B);
    const batch = pngBatch(db, 8);
    const a = batch.find((b) => b.url === PNG_A), b = batch.find((x) => x.url === PNG_B);
    // A: not opaque, kept. B: an answer that is not smaller is kept too, whatever the encoder said.
    const r = replacePngs(db, [{ sha: a.sha, url: null }, { sha: b.sha, url: url("image/webp", "x".repeat(500)) }]);
    assert.deepEqual([r.replaced, r.kept, r.pending], [0, 2, 0]);
    assert.deepEqual(pngBatch(db, 8), [], "nothing waits: both are recorded as kept");
    assert.deepEqual(readArchived(db, "bbbb0001").events, events("bbbb0001", PNG_A), "a kept PNG reads back unchanged");
    // A commit naming an image that is no longer a PNG changes nothing (a stale batch, a second worker).
    const PNG_C = url("image/png", "png C, a third screenshot, the one that does get replaced");
    await put(db, "bbbb0003", SEPT, PNG_C);
    const [c] = pngBatch(db, 8);
    assert.equal(replacePngs(db, [{ sha: c.sha, url: WEBP(PNG_C) }]).replaced, 1);
    assert.equal(replacePngs(db, [{ sha: c.sha, url: url("image/webp", "w") }]).replaced, 0);
    assert.deepEqual(readArchived(db, "bbbb0003").events, events("bbbb0003", WEBP(PNG_C)));
});

test("replacing an image marks every month that shows it, and only those", async () => {
    const db = fresh();
    await put(db, "cccc0001", SEPT, PNG_A);
    await put(db, "cccc0002", OCT, PNG_B);
    cleanAll(db);
    const a = pngBatch(db, 8).find((x) => x.url === PNG_A);
    replacePngs(db, [{ sha: a.sha, url: WEBP(PNG_A) }]);
    assert.deepEqual(dirtyMonths(db), ["2026-09"], "the folder's September file is rewritten; October has no such image");
});

test("UPGRADE: a month file written before the backfill cannot bring the PNG back on import", async () => {
    const db = fresh();
    await put(db, "dddd0001", SEPT, PNG_A);
    const oldFile = exportMonth(sqlite3, db.raw, "2026-09").bytes; // what the folder held before
    const [a] = pngBatch(db, 8);
    replacePngs(db, [{ sha: a.sha, url: WEBP(PNG_A) }]);
    importBytes(sqlite3, db.raw, oldFile);
    assert.deepEqual(readArchived(db, "dddd0001").events, events("dddd0001", WEBP(PNG_A)));
    assert.equal(pngPending(db), 0);
    // And the old file into a FRESH profile restores the PNG, which the next backfill then finds.
    const restored = fresh();
    importBytes(sqlite3, restored.raw, oldFile);
    assert.equal(pngPending(restored), 1);
});

test("UPGRADE: an archive from before the backfill (no kept-table yet) is read as all PNGs waiting", async () => {
    const db = fresh();
    await put(db, "eeee0001", SEPT, PNG_A);
    assert.equal(db.selectValue("SELECT count(*) FROM sqlite_master WHERE name = 'image_kept'"), 0, "migrate does not add it");
    assert.equal(pngPending(db), 1);
});

test("the batch is the smallest images first, and capped", async () => {
    const db = fresh();
    for (let i = 0; i < 5; i++) await put(db, `ffff000${i}`, SEPT, url("image/png", "p".repeat(100 - i * 10) + i));
    const batch = pngBatch(db, 3);
    assert.equal(batch.length, 3);
    const sizes = batch.map((b) => b.url.length);
    assert.deepEqual(sizes, [...sizes].sort((x, y) => x - y));
});

// --- the pass: batch by batch, logged, resumable ---

/** The archive operations a pass calls, answered by a real database; `failAfter` throws on that many replaces. */
function archiveCalls(db, { failAfter = Infinity } = {}) {
    let replaces = 0;
    return async (op, args) => {
        if (op === "pngs") return { batch: pngBatch(db, args.limit), pending: pngPending(db) };
        if (op === "replacePngs") { if (++replaces > failAfter) throw new Error("the offscreen document went away"); return replacePngs(db, args.items); }
        throw new Error(op);
    };
}
const webpEncode = async (u) => WEBP(u);

test("a pass re-encodes every waiting PNG in batches, logs it as one pass, and asks for a folder sync", async () => {
    const db = fresh();
    for (let i = 0; i < 20; i++) await put(db, `gggg${String(i).padStart(4, "0")}`, SEPT, url("image/png", `screenshot ${i} `.repeat(8)));
    const records = [];
    let syncs = 0;
    const c = archiveImageCompactor({ call: archiveCalls(db), encode: webpEncode, record: (r) => records.push(r), onReplaced: () => syncs++ });
    await c.pass();
    assert.equal(pngPending(db), 0);
    assert.deepEqual(records.map((r) => r.kind), ["image-compact", "image-compact-done"]);
    assert.deepEqual(records[0].detail, { pending: 20 });
    assert.deepEqual(records[1].detail, { replaced: 20, kept: 0 });
    assert.ok(records[1].bytes > 0);
    assert.equal(syncs, 1);
    assert.deepEqual([c.status().running, c.status().pending], [false, 0]);
    // Nothing left: the next pass logs nothing and asks for nothing.
    await c.pass();
    assert.equal(records.length, 2);
    assert.equal(syncs, 1);
});

test("a pass stopped half way keeps every committed batch, is interrupted or failed in its job, and the next resumes", async () => {
    const db = fresh();
    for (let i = 0; i < 20; i++) await put(db, `hhhh${String(i).padStart(4, "0")}`, SEPT, url("image/png", `screenshot ${i} `.repeat(8)));
    const log = [];
    const rec = (r) => log.push({ t: log.length + 1, origin: "worker", ...r });
    const broken = archiveImageCompactor({ call: archiveCalls(db, { failAfter: 1 }), encode: webpEncode, record: rec });
    await broken.pass();
    assert.equal(pngPending(db), 12, "the first batch of 8 was committed before the failure");
    assert.equal(log.at(-1).kind, "image-compact-failed");
    assert.equal(log.at(-1).detail.replaced, 8);
    assert.equal(jobStatus(archiveCompactionJob(broken), broken.status(), log).state, "failed");

    // A worker stopped mid-pass: a start record and no end. The new worker's compactor is idle, with work waiting.
    const cut = [{ t: 1, subsystem: "archive", kind: "image-compact", origin: "worker", detail: { pending: 12 } }];
    const next = archiveImageCompactor({ call: archiveCalls(db), encode: webpEncode, record: (r) => cut.push({ t: cut.length + 1, origin: "worker", ...r }) });
    assert.equal(jobStatus(archiveCompactionJob(next), next.status(), cut).state, "interrupted");
    await next.pass();
    assert.equal(pngPending(db), 0);
    const s = jobStatus(archiveCompactionJob(next), next.status(), cut);
    assert.deepEqual([s.state, s.pending, s.lastRun.detail.replaced], ["idle", 0, 12]);
});

test("the job says what waits once a pass has looked, and nothing before", async () => {
    const db = fresh();
    await put(db, "iiii0001", SEPT, PNG_A);
    const c = archiveImageCompactor({ call: archiveCalls(db), encode: async () => null });
    assert.equal(c.status().pending, undefined, "unknown until the archive is asked: never a guessed zero");
    await c.pass();
    assert.deepEqual([c.status().pending, c.status().pendingLabel], [0, "archived screenshots in PNG"], "kept, so nothing waits");
});

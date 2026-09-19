// The session archive's database (src/archive-db.ts) against an in-memory SQLite: a session goes in and comes back
// the same, an image is stored once however often it appears, search finds words from any event, and paging is by
// last activity.
import test from "node:test";
import assert from "node:assert/strict";
import init from "@sqlite.org/sqlite-wasm";
import { ARCHIVE_SCHEMA, archiveStats, listArchived, migrate, prepareSession, readArchived, removeArchived, writeSession } from "../src/archive-db.ts";

const sqlite3 = await init();
const fresh = () => { const db = new sqlite3.oo1.DB(":memory:"); migrate(db); return db; };

const PNG = "data:image/png;base64," + Buffer.from("fake png bytes, twice as fake").toString("base64");
const OTHER = "data:image/jpeg;base64," + Buffer.from("another image").toString("base64");
const summary = (hash, lastTs, over = {}) => ({ id: { runtime: "local", hash }, kind: "agent", status: "done", task: `task ${hash}`, createdTs: lastTs - 10, lastTs, pendingApprovals: 0, saved: true, ...over });
const events = (hash) => [
    { kind: "agent", id: hash, ts: 1, session: { hash, turn: 0 }, task: "find the brass lamp", images: [PNG] },
    { kind: "agent-step", id: hash, ts: 2, session: { hash, turn: 0 }, step: 1, seq: 1, tool: "look", result: { kind: "image", dataUrl: PNG } },
    { kind: "agent-step", id: hash, ts: 3, session: { hash, turn: 0 }, step: 2, seq: 2, tool: "exec", result: "price: 40 euros", shot: OTHER },
    { kind: "agent-result", id: hash, ts: 4, session: { hash, turn: 0 }, summary: "Found it for 40 euros", steps: 2, hitCap: false },
];
const put = async (db, hash, lastTs, over) => writeSession(db, await prepareSession({ summary: summary(hash, lastTs, over), events: events(hash), history: { kind: "agent", messages: [{ role: "user", content: "hi" }] }, bytes: 999 }), 5000);

test("a session reads back exactly as it went in, images restored", async () => {
    const db = fresh();
    await put(db, "aaaa0001", 100);
    const back = readArchived(db, "aaaa0001");
    assert.deepEqual(back.events, events("aaaa0001"));
    assert.equal(back.summary.task, "task aaaa0001");
    assert.deepEqual(back.history, { kind: "agent", messages: [{ role: "user", content: "hi" }] });
    assert.equal(readArchived(db, "ffff0000"), null);
});

test("an image is stored once, however many events and sessions carry it", async () => {
    const db = fresh();
    await put(db, "aaaa0001", 100);
    await put(db, "aaaa0002", 200);
    const s = archiveStats(db);
    assert.equal(s.images, 2, "two distinct images across six appearances");
    assert.equal(s.sessions, 2);
    const body = db.selectValue("SELECT body FROM events WHERE hash = 'aaaa0001' AND pos = 1");
    assert.equal(body.includes("data:image"), false, "the event holds a marker, not the image");
    // Removing one session keeps the images the other still uses; removing both frees them.
    removeArchived(db, "aaaa0001");
    assert.equal(archiveStats(db).images, 2);
    assert.deepEqual(readArchived(db, "aaaa0002").events, events("aaaa0002"));
    removeArchived(db, "aaaa0002");
    assert.equal(archiveStats(db).images, 0);
});

test("listing pages by last activity, and search finds words from any event", async () => {
    const db = fresh();
    for (let i = 1; i <= 5; i++) await put(db, `bbbb000${i}`, i * 100);
    const first = listArchived(db, { limit: 2 });
    assert.deepEqual(first.map((r) => r.summary.id.hash), ["bbbb0005", "bbbb0004"]);
    const next = listArchived(db, { limit: 2, before: first.at(-1).summary.lastTs });
    assert.deepEqual(next.map((r) => r.summary.id.hash), ["bbbb0003", "bbbb0002"]);
    assert.equal(listArchived(db, { query: "brass lamp" }).length, 5);
    assert.equal(listArchived(db, { query: "40 euros" }).length, 5);
    assert.equal(listArchived(db, { query: "nothing like this" }).length, 0);
    // A person's text is a phrase, never FTS syntax: quotes and operators do not throw.
    assert.doesNotThrow(() => listArchived(db, { query: 'lamp" OR NEAR(' }));
});

test("writing a session again replaces it rather than doubling it", async () => {
    const db = fresh();
    await put(db, "cccc0001", 100);
    await put(db, "cccc0001", 300, { title: "Renamed" });
    assert.equal(archiveStats(db).events, 4);
    assert.equal(listArchived(db)[0].summary.title, "Renamed");
    assert.equal(db.selectValue("SELECT count(*) FROM event_text WHERE hash = 'cccc0001'"), 4);
});

test("a file written by a newer schema is refused, not half-read", () => {
    const db = fresh();
    db.exec({ sql: "UPDATE meta SET value = ? WHERE key = 'schema'", bind: [String(ARCHIVE_SCHEMA + 1)] });
    assert.throws(() => migrate(db), /newer version/);
});

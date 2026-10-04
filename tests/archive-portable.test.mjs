// The archive's SQL over TWO INDEPENDENT SQLITE BUILDS, because the phone is to keep the same database the
// extension writes and "the same" has to mean something a test can fail on.
//
// Sharing the module (src/archive/db.ts) guarantees one set of statements; it does not guarantee that those
// statements mean the same thing under another driver. A schema can lean on one build's defaults, an FTS5 table can
// be unavailable, a blob can come back as something else. So the same session goes in and comes out under
// sqlite-wasm — what the extension runs — and under node:sqlite, an unrelated build with its own compile flags, and
// the two are compared to each other rather than to a fixture.
//
// It cannot run expo-sqlite, which needs a device. That is the limit of what this proves, and it is still the part
// worth proving: what would break the phone is the shared layer leaking a driver's assumptions, not expo-sqlite
// being exotic. FTS5 is enabled by default on both its platforms (expo/expo#27738), which is the one capability
// this schema actually requires.

import test from "node:test";
import assert from "node:assert/strict";
import init from "@sqlite.org/sqlite-wasm";
import { archiveStats, listArchived, migrate, prepareSession, readArchived, wasmDb, writeSession } from "../src/archive/db.ts";

const sqlite3 = await init();

/** `node:sqlite` as the shared surface. A second adapter, written here rather than shipped, because its only job is
 *  to be a driver this code was NOT written against. */
function nodeDb(raw) {
    const rows = (sql, bind = []) => raw.prepare(sql).all(...bind);
    const db = {
        exec: (sql) => (typeof sql === "string" ? raw.exec(sql) : raw.prepare(sql.sql).run(...(sql.bind ?? []))),
        selectValue: (sql, bind = []) => { const r = rows(sql, bind)[0]; return r === undefined ? undefined : Object.values(r)[0]; },
        selectValues: (sql, bind = []) => rows(sql, bind).map((r) => Object.values(r)[0]),
        selectObjects: (sql, bind = []) => rows(sql, bind),
        transaction: (fn) => { raw.exec("BEGIN"); try { const v = fn(db); raw.exec("COMMIT"); return v; } catch (e) { raw.exec("ROLLBACK"); throw e; } },
        prepare: (sql) => {
            const st = raw.prepare(sql);
            let bound = [];
            const s = { bind(v) { bound = v; return s; }, stepReset() { st.run(...bound); return s; }, finalize() {} };
            return s;
        },
    };
    return db;
}

const PNG = "data:image/png;base64," + Buffer.from("fake png bytes, twice as fake").toString("base64");
const summary = (hash, lastTs) => ({ id: { runtime: "local", hash }, kind: "agent", status: "done", task: `task ${hash}`, createdTs: lastTs - 10, lastTs, pendingApprovals: 0, saved: true });
// The two sessions say DIFFERENT things, or a search matching both proves nothing about the index.
const events = (hash, subject = "brass lamp") => [
    { kind: "agent", id: hash, ts: 1, session: { hash, turn: 0 }, task: `find the ${subject}`, images: [PNG] },
    { kind: "agent-step", id: hash, ts: 2, session: { hash, turn: 0 }, step: 1, seq: 1, tool: "look", result: { kind: "image", dataUrl: PNG } },
    { kind: "agent-result", id: hash, ts: 3, session: { hash, turn: 0 }, summary: "Found it for 40 euros", steps: 1, hitCap: false },
];

/** Everything the phone's copy has to agree about, read back out of a database. */
async function roundTrip(db) {
    await (async () => {
        for (const [hash, ts, subject] of [["aaaa0001", 100, "brass lamp"], ["bbbb0002", 200, "copper kettle"]]) {
            writeSession(db, await prepareSession({ summary: summary(hash, ts), events: events(hash, subject), history: { kind: "agent", messages: [{ role: "user", content: "hi" }] }, bytes: 999 }), 5000);
        }
    })();
    return {
        read: readArchived(db, "aaaa0001"),
        listed: listArchived(db, {}).map((r) => r.summary.id.hash),
        // The FTS5 index, which is the one capability this schema requires of a build.
        found: listArchived(db, { query: "brass" }).map((r) => r.summary.id.hash),
        missed: listArchived(db, { query: "zeppelin" }).length,
        stats: archiveStats(db),
    };
}

// --- the same session under two SQLite builds ---

test("the archive's SQL means the same thing under sqlite-wasm and under node:sqlite", async () => {
    let DatabaseSync;
    try { ({ DatabaseSync } = await import("node:sqlite")); } catch { return; }   // older Node: nothing to compare against

    const wasm = wasmDb(new sqlite3.oo1.DB(":memory:"));
    migrate(wasm);
    const node = nodeDb(new DatabaseSync(":memory:"));
    migrate(node);

    const a = await roundTrip(wasm);
    const b = await roundTrip(node);

    // The events are the point: an image is stored once and put back, so a difference here is the blob path.
    assert.deepEqual(b.read.events, events("aaaa0001"));
    assert.deepEqual(b.read.events, a.read.events, "the same events come back from either build");
    assert.deepEqual(b.read.summary, a.read.summary);
    assert.deepEqual(b.read.history, a.read.history);
    assert.deepEqual(b.listed, a.listed, "and in the same order");
    assert.deepEqual(b.found, ["aaaa0001"], "FTS5 finds a word from an event's body");
    assert.deepEqual(b.found, a.found, "and finds the same rows as the build this was written against");
    assert.equal(b.missed, 0);
    // One image, twice over, stored once — under both.
    assert.deepEqual(b.stats, a.stats, "sessions, events, images and their bytes all agree");
    assert.equal(b.stats.images, a.stats.images);
});

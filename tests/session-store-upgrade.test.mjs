// session-store-upgrade.test.mjs — a database written by the VERSION-1 code, opened by the version-2 code: the list,
// the histories and the events survive, the migration moves each session in one transaction, and an interrupted
// one carries on. The fixture is written by hand, as the old code wrote it (SESSION_HISTORY_STORE.md §3, "The upgrade").
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { SessionStore, indexedDbBackend } from "../src/session/session-store.ts";

// The CommonJS build's factory and key range, together: the ESM build's database refuses the other build's range
// (tests/helpers.js), which the delete in a history write would hit.
const { IDBFactory, IDBKeyRange } = createRequire(import.meta.url)("fake-indexeddb");
globalThis.IDBKeyRange = IDBKeyRange;

const T = { timeout: 10_000 };
const done = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
const committed = (tx) => new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error); });

const summary = (hash, over = {}) => ({ id: { runtime: "local", hash }, kind: "agent", status: "done", createdTs: 1000, lastTs: 2000, pendingApprovals: 0, saved: true, task: `task ${hash}`, ...over });
const ev = (hash, n) => ({ kind: "agent-step", id: hash, ts: 1000 + n, save: true, session: { hash, turn: 0 }, step: n, seq: n, tool: "look" });

const AGENT = "aaaa0001", CHAT = "bbbb0002";
const agentHistory = {
    kind: "agent",
    messages: [{ role: "user", content: "find it" }, { role: "assistant", content: "looking", toolCalls: [{ id: "c1", name: "look", arguments: "{}" }] }, { role: "tool", content: "found", toolCallId: "c1" }],
    payload: { task: "find it", systemPrompt: "S", runId: AGENT },
    sub: { calls: 1, promptTokens: 10, completionTokens: 5 },
};
const chatHistory = { kind: "chat", session: { hash: CHAT, messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }], model: "m1", save: true } };

/** A version-1 database, byte for byte what the old code wrote: `sessions` keyed by `hash`, `events` keyed `[hash, seq]`, the history a field of the row. */
async function writeVersion1(idb) {
    const open = idb.open("ml-saved-sessions", 1);
    open.onupgradeneeded = () => { open.result.createObjectStore("sessions", { keyPath: "hash" }); open.result.createObjectStore("events"); };
    const db = await done(open);
    const tx = db.transaction(["sessions", "events"], "readwrite");
    const rows = [
        { hash: AGENT, summary: summary(AGENT), lastTs: 2000, createdTs: 1000, bytes: 300, count: 3, history: agentHistory },
        { hash: CHAT, summary: summary(CHAT, { kind: "chat", lastTs: 3000 }), lastTs: 3000, createdTs: 1500, bytes: 200, count: 2, history: chatHistory },
    ];
    for (const r of rows) tx.objectStore("sessions").put(r);
    for (let n = 0; n < 3; n++) tx.objectStore("events").put(ev(AGENT, n), [AGENT, n]);
    for (let n = 0; n < 2; n++) tx.objectStore("events").put(ev(CHAT, n), [CHAT, n]);
    await committed(tx);
    db.close();
}

/** What is on the disk now, whichever version it is: rows, history positions with their keys, runmeta. */
async function onDisk(idb) {
    const db = await done(idb.open("ml-saved-sessions"));
    try {
        const tx = db.transaction(["sessions", "history", "runmeta"], "readonly");
        const sessions = tx.objectStore("sessions"), history = tx.objectStore("history"), runmeta = tx.objectStore("runmeta");
        const out = { rows: await done(sessions.getAll()), keys: await done(history.getAllKeys()), messages: await done(history.getAll()), metaKeys: await done(runmeta.getAllKeys()), version: db.version };
        return out;
    } finally { db.close(); }
}
const row = (disk, hash) => disk.rows.find((r) => r.hash === hash);
const summaries = (rows) => rows.map((r) => [r.hash, r.summary, r.count, r.bytes]);

// --- the upgrade: a version-1 database opened by the version-2 code ---

test("a version-1 database: the list and every history read the same before and after migrate(), events untouched", T, async () => {
    const idb = new IDBFactory();
    await writeVersion1(idb);
    const migrated = [];
    const store = new SessionStore(indexedDbBackend(idb), { flushMs: 60_000, onMigrated: (m) => migrated.push(m) });

    const before = await store.open();
    assert.deepEqual(before.map((r) => r.hash).sort(), [AGENT, CHAT]);
    assert.equal((await onDisk(idb)).version, 2, "opening upgrades the schema and nothing else");
    assert.ok(row(await onDisk(idb), AGENT).history, "no record is rewritten by opening");
    // A resume reads what the old code wrote, from the row, until the row is moved.
    assert.deepEqual(await store.history(AGENT), agentHistory);
    assert.deepEqual(await store.history(CHAT), chatHistory);
    const eventsBefore = { [AGENT]: await store.read(AGENT), [CHAT]: await store.read(CHAT) };
    assert.equal(eventsBefore[AGENT].length, 3);

    assert.equal(await store.migrate(), 2);
    assert.equal(migrated.length, 2, "one record per session");
    assert.deepEqual(migrated.map((m) => m.hash).sort(), [AGENT, CHAT]);
    assert.deepEqual(migrated.find((m) => m.hash === AGENT).positions, 3);
    assert.ok(migrated.every((m) => m.error === undefined && m.bytes > 0));

    // The list: same hashes, summaries, counts, byte counts.
    const after = await store.open();
    assert.deepEqual(summaries(after).sort(), summaries(before).sort());
    // The histories: the same, whether read through the open store or through a fresh one over the same disk.
    assert.deepEqual(await store.history(AGENT), agentHistory);
    assert.deepEqual(await store.history(CHAT), chatHistory);
    const fresh = new SessionStore(indexedDbBackend(idb), { flushMs: 60_000 });
    await fresh.open();
    assert.deepEqual(await fresh.history(AGENT), agentHistory);
    assert.deepEqual(await fresh.history(CHAT), chatHistory);
    // The events.
    assert.deepEqual(await store.read(AGENT), eventsBefore[AGENT]);
    assert.deepEqual(await fresh.read(CHAT), eventsBefore[CHAT]);

    // On the disk: no history field, form 2, the count, the messages at [hash, 0..n-1].
    const disk = await onDisk(idb);
    for (const [hash, h] of [[AGENT, agentHistory.messages], [CHAT, chatHistory.session.messages]]) {
        const r = row(disk, hash);
        assert.equal(r.history, undefined, `${hash}: the row no longer carries its history`);
        assert.equal(r.form, 2);
        assert.equal(r.historyCount, h.length);
        assert.ok(r.historyBytes > 0);
        assert.deepEqual(disk.keys.filter((k) => k[0] === hash), h.map((_, i) => [hash, i]));
        assert.deepEqual(disk.messages.filter((_, i) => disk.keys[i][0] === hash), h);
    }
    assert.deepEqual([...disk.metaKeys].sort(), [AGENT, CHAT]);
    assert.equal(await store.migrate(), 0, "a second pass has nothing to move");
    assert.equal(migrated.length, 2);
});

test("a migration interrupted after the first session leaves each session in one form, and the next start finishes it", T, async () => {
    const idb = new IDBFactory();
    await writeVersion1(idb);
    const real = indexedDbBackend(idb);
    let failing = true;
    const flaky = { ...real, append: async (r, from, events, hw) => { if (failing && r.hash === CHAT) throw new Error("quota exceeded"); return real.append(r, from, events, hw); } };
    const told = [];
    const store = new SessionStore(flaky, { flushMs: 60_000, onMigrated: (m) => told.push(m) });
    await store.open();

    assert.equal(await store.migrate(), 1, "one moved, one did not");
    assert.deepEqual(told.map((m) => [m.hash, m.error === undefined]).sort(), [[AGENT, true], [CHAT, false]]);
    assert.match(told.find((m) => m.hash === CHAT).error, /quota exceeded/);

    const disk = await onDisk(idb);
    assert.equal(row(disk, AGENT).form, 2);
    assert.equal(row(disk, AGENT).history, undefined);
    assert.equal(row(disk, CHAT).form, undefined, "the second is still in the old form");
    assert.deepEqual(row(disk, CHAT).history, chatHistory, "with its history intact on the row");
    assert.equal(disk.keys.filter((k) => k[0] === CHAT).length, 0, "and no half of it in the new stores");
    assert.deepEqual(await store.history(CHAT), chatHistory, "a resume still reads it");
    assert.deepEqual(await store.history(AGENT), agentHistory);

    // The worker restarts: a fresh store over the same disk carries on from where it stopped.
    failing = false;
    const next = new SessionStore(indexedDbBackend(idb), { flushMs: 60_000 });
    await next.open();
    assert.deepEqual(await next.history(CHAT), chatHistory);
    assert.equal(await next.migrate(), 1, "only the one left");
    const after = await onDisk(idb);
    assert.equal(row(after, CHAT).form, 2);
    assert.equal(row(after, CHAT).history, undefined);
    assert.equal(row(after, CHAT).historyCount, 2);
    assert.deepEqual(await next.history(CHAT), chatHistory);
    assert.deepEqual(await next.history(AGENT), agentHistory);
});

test("an ordinary write to an unmigrated row moves its history in the same transaction", T, async () => {
    const idb = new IDBFactory();
    await writeVersion1(idb);
    const store = new SessionStore(indexedDbBackend(idb), { flushMs: 60_000 });
    await store.open();

    store.putSummary(summary(AGENT, { pinned: true }));
    await store.flush();
    const disk = await onDisk(idb);
    const r = row(disk, AGENT);
    assert.equal(r.summary.pinned, true);
    assert.equal(r.history, undefined, "the pin moved the history with it");
    assert.equal(r.form, 2);
    assert.equal(r.historyCount, 3);
    assert.equal(disk.keys.filter((k) => k[0] === AGENT).length, 3, "the records are there, in the same write");
    assert.deepEqual(await store.history(AGENT), agentHistory);
    assert.ok(row(disk, CHAT).history, "the other session is untouched");

    // A new event on the other unmigrated session does the same.
    store.put(summary(CHAT, { kind: "chat", lastTs: 4000 }), ev(CHAT, 2));
    await store.flush();
    const disk2 = await onDisk(idb);
    assert.equal(row(disk2, CHAT).history, undefined);
    assert.equal(row(disk2, CHAT).count, 3);
    assert.deepEqual(await store.history(CHAT), chatHistory);
    assert.equal(await store.migrate(), 0, "nothing left to migrate");
    const fresh = new SessionStore(indexedDbBackend(idb), { flushMs: 60_000 });
    await fresh.open();
    assert.deepEqual(await fresh.history(CHAT), chatHistory);
    assert.deepEqual(await fresh.history(AGENT), agentHistory);
});

// --- a failed write in the real database ---

test("a message the database cannot store fails the whole write: no row claims positions that are not there", T, async () => {
    const idb = new IDBFactory();
    const failures = [];
    const store = new SessionStore(indexedDbBackend(idb), { flushMs: 60_000, onWriteFailed: (f) => failures.push(f) });
    store.put(summary(AGENT, { status: "running" }), ev(AGENT, 0));
    store.putHistory(AGENT, { kind: "agent", messages: [{ role: "user", content: "ok" }, { role: "assistant", content: "bad", fn: () => 1 }] });
    await store.flush();
    assert.equal(failures.length, 1);
    const disk = await onDisk(idb);
    // Either nothing was written, or the row and its records agree.
    const r = row(disk, AGENT);
    assert.equal(r === undefined || (r.historyCount ?? 0) === disk.keys.filter((k) => k[0] === AGENT).length, true, "row and records agree");
});

// --- the namespace-drop record in `runmeta` (ASYNC_CALLS.md, rulings of 2026-11-22, ruling 2) ---

const runmetaOf = async (idb, hash) => {
    const db = await done(idb.open("ml-saved-sessions"));
    try { return await done(db.transaction("runmeta", "readonly").objectStore("runmeta").get(hash)); } finally { db.close(); }
};
const DROP = { at: 5000, reason: "timeout", names: ["df", "x"], total: 2 };

test("nsDropped: a form-2 runmeta written before the record existed reads back with none", T, async () => {
    const idb = new IDBFactory();
    await writeVersion1(idb);
    const old = new SessionStore(indexedDbBackend(idb), { flushMs: 60_000 });
    await old.open();
    assert.equal(await old.migrate(), 2);
    const meta = await runmetaOf(idb, AGENT);
    assert.deepEqual(Object.keys(meta).sort(), ["kind", "payload", "sub"], "what the old code wrote: no nsDropped key");
    const fresh = new SessionStore(indexedDbBackend(idb), { flushMs: 60_000 });
    await fresh.open();
    assert.equal((await fresh.history(AGENT)).nsDropped, undefined);
    assert.deepEqual(await fresh.history(AGENT), agentHistory);
});

test("nsDropped: a row still in the old form is migrated by noteNsDropped, and keeps the record through migrate()", T, async () => {
    const idb = new IDBFactory();
    await writeVersion1(idb);
    const store = new SessionStore(indexedDbBackend(idb), { flushMs: 60_000 });
    await store.open();
    await store.noteNsDropped(AGENT, DROP);
    const disk = await onDisk(idb);
    assert.equal(row(disk, AGENT).form, 2);
    assert.equal(row(disk, AGENT).history, undefined, "its history moved first");
    assert.ok(row(disk, CHAT).history, "the other row is untouched");
    assert.deepEqual(await store.history(AGENT), { ...agentHistory, nsDropped: DROP });
    assert.equal(await store.migrate(), 1, "only the chat is left");
    const fresh = new SessionStore(indexedDbBackend(idb), { flushMs: 60_000 });
    await fresh.open();
    assert.deepEqual(await fresh.history(AGENT), { ...agentHistory, nsDropped: DROP }, "still there after the migration and a restart");
    assert.deepEqual(await fresh.history(CHAT), chatHistory);
});

test("nsDropped: a later history save keeps the record, and a second record replaces the first", T, async () => {
    const idb = new IDBFactory();
    const store = new SessionStore(indexedDbBackend(idb), { flushMs: 60_000 });
    store.put(summary(AGENT, { status: "running" }), ev(AGENT, 0));
    store.putHistory(AGENT, { kind: "agent", messages: agentHistory.messages.slice(0, 2), payload: agentHistory.payload });
    await store.flush();
    await store.noteNsDropped(AGENT, DROP);
    store.putHistory(AGENT, { kind: "agent", messages: agentHistory.messages, payload: agentHistory.payload, sub: agentHistory.sub });
    await store.flush();
    const meta = await runmetaOf(idb, AGENT);
    assert.deepEqual(meta.nsDropped, DROP, "the fresh save rewrote runmeta and carried the record");
    assert.deepEqual(meta.sub, agentHistory.sub, "and the new sub");
    const second = { at: 9000, reason: "person" };
    await store.noteNsDropped(AGENT, second);
    assert.deepEqual((await runmetaOf(idb, AGENT)).nsDropped, second, "replaced, not merged");
    assert.deepEqual((await store.history(AGENT)).nsDropped, second);
    await store.noteNsDropped(AGENT, { at: 1, reason: "x", names: Array.from({ length: 80 }, (_, i) => `n${i}`), total: 80 });
    assert.equal((await runmetaOf(idb, AGENT)).nsDropped.names.length, 50, "names capped at 50, total kept");
});

test("nsDropped: a hash the store does not hold creates nothing and does not throw", T, async () => {
    const idb = new IDBFactory();
    await writeVersion1(idb);
    const errors = [];
    const store = new SessionStore(indexedDbBackend(idb), { flushMs: 60_000, onError: (e) => errors.push(e) });
    await store.open();
    await store.noteNsDropped("ffff9999", DROP);
    const disk = await onDisk(idb);
    assert.deepEqual(disk.metaKeys, [], "no runmeta");
    assert.equal(disk.rows.length, 2, "no row");
    assert.deepEqual(errors, []);
    assert.equal(await store.history("ffff9999"), null);
});

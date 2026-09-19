// SAVED SESSIONS (src/session-store.ts): what gets written, when, and which sessions are dropped when the budget is
// full. The IndexedDB backend is replaced by a map, so the policy is tested without a database.
import test from "node:test";
import assert from "node:assert/strict";
import { SessionStore, planEviction, planExpiry, sizeOf, STORE_BUDGET_BYTES } from "../src/session-store.ts";

const T = { timeout: 5000 };

const summary = (hash, over = {}) => ({ id: { runtime: "local", hash }, kind: "chat", status: "done", createdTs: 1000, lastTs: 1000, pendingApprovals: 0, saved: true, ...over });
const ev = (hash, n, over = {}) => ({ kind: "chat-result", id: `${hash}-${n}`, ts: 1000 + n, save: true, session: { hash, turn: n }, content: `answer ${n}`, sources: null, structured: false, model: "m", extend: null, reasoning: null, usage: null, ...over });

/** A backend in memory, counting its calls so batching is visible. */
function backend() {
    const rows = new Map(), events = new Map();
    const calls = { append: 0, remove: 0, rows: 0 };
    return {
        rows: async () => { calls.rows++; return [...rows.values()]; },
        append: async (row, from, list) => {
            calls.append++;
            rows.set(row.hash, row);
            const have = events.get(row.hash) ?? [];
            list.forEach((e, i) => { have[from + i] = e; });
            events.set(row.hash, have);
        },
        events: async (hash) => [...(events.get(hash) ?? [])],
        remove: async (hashes) => { calls.remove++; for (const h of hashes) { rows.delete(h); events.delete(h); } },
        _rows: rows, _events: events, calls,
    };
}

test("events are written in batches, and read back in the order they arrived", T, async () => {
    const be = backend();
    const store = new SessionStore(be, { flushMs: 5 });
    for (let n = 0; n < 6; n++) store.put(summary("aaaa0001"), ev("aaaa0001", n));
    await store.flush();

    // One append for six events: a transaction each would spend more time in the database than in the model.
    assert.equal(be.calls.append, 1);
    const read = await store.read("aaaa0001");
    assert.deepEqual(read.map((e) => e.content), ["answer 0", "answer 1", "answer 2", "answer 3", "answer 4", "answer 5"]);
    assert.equal(be._rows.get("aaaa0001").count, 6);
});

test("a second batch continues where the first stopped", T, async () => {
    const be = backend();
    const store = new SessionStore(be, { flushMs: 5 });
    store.put(summary("aaaa0001"), ev("aaaa0001", 0));
    await store.flush();
    store.put(summary("aaaa0001"), ev("aaaa0001", 1));
    await store.flush();
    assert.deepEqual((await store.read("aaaa0001")).map((e) => e.content), ["answer 0", "answer 1"]);
});

test("a read sees what is still queued, so a transcript is never missing its newest turn", T, async () => {
    const be = backend();
    const store = new SessionStore(be, { flushMs: 60_000 });   // nothing will flush on its own
    store.put(summary("aaaa0001"), ev("aaaa0001", 0));
    await store.flush();
    store.put(summary("aaaa0001"), ev("aaaa0001", 1));
    assert.deepEqual((await store.read("aaaa0001")).map((e) => e.content), ["answer 0", "answer 1"]);
});

test("a restarted worker lists what it saved, newest first", T, async () => {
    const be = backend();
    const first = new SessionStore(be, { flushMs: 5 });
    first.put(summary("aaaa0001", { lastTs: 1000 }), ev("aaaa0001", 1));
    first.put(summary("bbbb0002", { lastTs: 5000 }), ev("bbbb0002", 5));
    await first.flush();

    const second = new SessionStore(be, { flushMs: 5 });   // a new worker, with nothing in memory
    const rows = await second.open();
    assert.deepEqual(rows.map((r) => r.hash), ["bbbb0002", "aaaa0001"]);
    assert.equal(second.has("aaaa0001"), true);
    assert.deepEqual((await second.read("bbbb0002")).map((e) => e.content), ["answer 5"]);
});

test("the oldest sessions are dropped when the budget is full, and a running one is never dropped", T, async () => {
    const be = backend();
    const store = new SessionStore(be, { flushMs: 5, budgetBytes: 900 });
    const big = "x".repeat(400);
    store.put(summary("old00001", { lastTs: 1000 }), ev("old00001", 1, { content: big }));
    store.put(summary("mid00002", { lastTs: 2000 }), ev("mid00002", 2, { content: big }));
    // Still running, and older than the one above: it survives anyway, because its events are still arriving.
    store.put(summary("run00003", { lastTs: 1500, status: "running" }), ev("run00003", 3, { content: big }));
    await store.flush();

    // Three rows of ~604 bytes against a 900-byte budget: the oldest goes, the running one is skipped rather than
    // dropped, so the next oldest goes too, and one row is left.
    assert.equal(store.has("old00001"), false, "the oldest went");
    assert.equal(store.has("mid00002"), false, "and the next oldest, since the budget still did not fit");
    assert.equal(store.has("run00003"), true, "the running one stayed, though it was older than the one dropped after it");
    assert.deepEqual(await store.read("old00001"), [], "and an evicted session's events went with it");
});

test("a session a page has open is protected too", T, async () => {
    const be = backend();
    const open = ["old00001"];
    const store = new SessionStore(be, { flushMs: 5, budgetBytes: 900, protect: () => open });
    const big = "x".repeat(400);
    store.put(summary("old00001", { lastTs: 1000 }), ev("old00001", 1, { content: big }));
    store.put(summary("mid00002", { lastTs: 2000 }), ev("mid00002", 2, { content: big }));
    store.put(summary("new00003", { lastTs: 3000 }), ev("new00003", 3, { content: big }));
    await store.flush();
    assert.equal(store.has("old00001"), true, "open, so kept even though it is the oldest");
    assert.equal(store.has("mid00002"), false, "the oldest one that is not protected went instead");
});

test("forgetting a session removes its events, and a write queued before it does not bring it back", T, async () => {
    const be = backend();
    const store = new SessionStore(be, { flushMs: 60_000 });
    store.put(summary("aaaa0001"), ev("aaaa0001", 0));
    await store.flush();
    store.put(summary("aaaa0001"), ev("aaaa0001", 1));   // queued, not written
    await store.forget(["aaaa0001"]);
    await store.flush();
    assert.equal(store.has("aaaa0001"), false);
    assert.deepEqual(await store.read("aaaa0001"), []);
    // And the BACKEND is clean, not just the store's view of it. Asserting only `has`/`read` let a mutation that
    // wrote the queued batch back under a fresh row pass: the store had forgotten the session while the database
    // kept its events for good, which is a leak nothing would ever have surfaced.
    assert.equal(be._rows.has("aaaa0001"), false, "no row left behind");
    assert.equal(be._events.has("aaaa0001"), false, "and no orphaned events");
});

test("planEviction: count and bytes both bound it, and it drops no more than it must", () => {
    const row = (hash, lastTs, bytes) => ({ hash, summary: summary(hash), lastTs, createdTs: lastTs, bytes, count: 1 });
    const rows = [row("a", 1, 100), row("b", 2, 100), row("c", 3, 100)];

    assert.deepEqual(planEviction(rows, { budgetBytes: 1000, maxSessions: 500 }), [], "nothing to do");
    assert.deepEqual(planEviction(rows, { budgetBytes: 250 }), ["a"], "one is enough");
    assert.deepEqual(planEviction(rows, { budgetBytes: 150 }), ["a", "b"]);
    assert.deepEqual(planEviction(rows, { maxSessions: 2 }), ["a"], "the count alone can force one out");
    assert.deepEqual(planEviction(rows, { budgetBytes: 250, protect: ["a"] }), ["b"], "protected is skipped, not counted");
    // An incoming write is charged before it lands, so a big one makes room for itself.
    assert.deepEqual(planEviction(rows, { budgetBytes: 300, incoming: 200 }), ["a", "b"]);
});

test("planEviction: a pinned session counts toward the budget and is never what pays for it", () => {
    const row = (hash, lastTs, bytes, over = {}) => ({ hash, summary: summary(hash, over), lastTs, createdTs: lastTs, bytes, count: 1 });
    const rows = [row("a", 1, 100, { pinned: true }), row("b", 2, 100), row("c", 3, 100)];
    assert.deepEqual(planEviction(rows, { budgetBytes: 250 }), ["b"], "the oldest UNPINNED goes");
    assert.deepEqual(planEviction(rows, { maxSessions: 1 }), ["b", "c"]);
    // When only pins are left, the budget is exceeded rather than a pin dropped. The runtime bounds the pins.
    assert.deepEqual(planEviction([row("a", 1, 500, { pinned: true })], { budgetBytes: 100 }), []);
});

test("putSummary writes a pin with no event behind it, and a restarted store reads it back", T, async () => {
    const be = backend();
    const store = new SessionStore(be, { flushMs: 5 });
    store.put(summary("aaaa0001"), ev("aaaa0001", 0));
    await store.flush();
    store.putSummary(summary("aaaa0001", { pinned: true }));
    await store.flush();
    const again = new SessionStore(be, { flushMs: 5 });
    const [r] = await again.open();
    assert.equal(r.summary.pinned, true);
    assert.equal(r.count, 1, "the pin wrote a row, not an event");

    // A session pinned before anything of it was written still comes back; an unsaved summary is not a row.
    store.putSummary(summary("aaaa0002", { pinned: true }));
    store.putSummary(summary("aaaa0003", { saved: false, pinned: true }));
    await store.flush();
    assert.deepEqual([...be._rows.keys()].sort(), ["aaaa0001", "aaaa0002"]);
});

test("sizeOf survives an event that cannot be serialized", () => {
    const circular = { kind: "chat" };
    circular.self = circular;
    assert.equal(sizeOf(circular), 1024);
    assert.ok(sizeOf({ kind: "chat", content: "hello" }) > 10);
    assert.ok(STORE_BUDGET_BYTES > 0);
});

test("a history is what a session would be CONTINUED from, and the newest one is the only one kept", T, async () => {
    const be = backend();
    const store = new SessionStore(be, { flushMs: 5 });
    store.put(summary("aaaa0001"), ev("aaaa0001", 0));
    store.putHistory("aaaa0001", { kind: "agent", messages: [{ role: "user", content: "first" }] });
    store.putHistory("aaaa0001", { kind: "agent", messages: [{ role: "user", content: "first" }, { role: "assistant", content: "second" }] });
    await store.flush();

    // A history is the whole of it, not an append: the newest replaces the last.
    const h = await store.history("aaaa0001");
    assert.deepEqual(h.messages.map((m) => m.content), ["first", "second"]);
    assert.equal(be._rows.get("aaaa0001").history.messages.length, 2, "and it reached the disk");

    // A worker that restarted can continue what it saved.
    const next = new SessionStore(be, { flushMs: 5 });
    await next.open();
    assert.deepEqual((await next.history("aaaa0001")).messages.length, 2);
    assert.equal(await next.history("nosuch01"), null);
});

test("a history written between turns reaches the disk without an event to carry it", T, async () => {
    const be = backend();
    const store = new SessionStore(be, { flushMs: 5 });
    store.put(summary("aaaa0001"), ev("aaaa0001", 0));
    await store.flush();
    const appends = be.calls.append;

    // No new events, only a history. A session's newest turn would otherwise be readable and not continuable
    // until something else happened to it.
    store.putHistory("aaaa0001", { kind: "chat", session: { hash: "aaaa0001", messages: [{ role: "user", content: "hi" }], save: true } });
    await store.flush();
    assert.equal(be.calls.append, appends + 1);
    assert.equal(be._rows.get("aaaa0001").history.kind, "chat");
    assert.equal(be._rows.get("aaaa0001").count, 1, "and it did not invent an event");
});

test("a history for a session this store does not keep is dropped", T, async () => {
    const be = backend();
    const store = new SessionStore(be, { flushMs: 5 });
    store.putHistory("ffff0001", { kind: "agent", messages: [] });
    await store.flush();
    assert.equal(await store.history("ffff0001"), null);
    assert.equal(be._rows.size, 0, "an ephemeral session does not become saved by having a history");
});

test("an eviction is reported, so whatever lists sessions stops listing one whose history has gone", T, async () => {
    // The store is the one authority on whether a saved session exists. It used to evict without telling anyone, so a
    // session stayed in the list after its history had left the disk.
    const be = backend();
    const told = [];
    const store = new SessionStore(be, { flushMs: 5, maxSessions: 2, onEvict: (h) => told.push(...h) });
    for (const [i, h] of ["aaaa0001", "aaaa0002", "aaaa0003"].entries()) {
        store.put(summary(h, { lastTs: 100 + i }), ev(h, 0));
        await store.flush();
    }
    assert.deepEqual(told, ["aaaa0001"], "the oldest, and only it");
    assert.equal(await store.history("aaaa0001"), null, "and it really is gone");

    // A write that evicts nothing reports nothing: a listener is not told about a non-event.
    const before = told.length;
    store.put(summary("aaaa0003", { lastTs: 200 }), ev("aaaa0003", 1));
    await store.flush();
    assert.equal(told.length, before);
});

const DAY = 24 * 60 * 60 * 1000;

test("planExpiry: idle past the limit goes, whatever the budget; pins, protected sessions and 0 keep it", () => {
    const row = (hash, lastTs, over = {}) => ({ hash, summary: summary(hash, over), lastTs, createdTs: 0, bytes: 1, count: 1 });
    const now = 100 * DAY;
    const rows = [row("old", now - 31 * DAY), row("pinned", now - 90 * DAY, { pinned: true }), row("open", now - 60 * DAY), row("fresh", now - 29 * DAY)];
    assert.deepEqual(planExpiry(rows, { now, retainMs: 30 * DAY, protect: ["open"] }), ["old"]);
    assert.deepEqual(planExpiry(rows, { now, retainMs: 0 }), [], "0 keeps every session");
    // Measured from the LAST activity: a session started long ago and used yesterday is not old.
    assert.deepEqual(planExpiry([{ ...row("used", now - DAY), createdTs: 0 }], { now, retainMs: 30 * DAY }), []);
});

test("the store expires on a sweep and on a write, and records each drop with its reason", T, async () => {
    const be = backend();
    let now = 10 * DAY;
    let retain = 0;
    const records = [];
    const removed = [];
    const store = new SessionStore(be, { flushMs: 5, now: () => now, retainMs: () => retain, onEvicted: (e) => records.push(e), onEvict: (h) => removed.push(...h), maxSessions: 2 });
    store.put(summary("aaaa0001", { lastTs: 1 * DAY }), ev("aaaa0001", 0, { ts: 1 * DAY }));
    store.put(summary("aaaa0002", { lastTs: 9 * DAY }), ev("aaaa0002", 0, { ts: 9 * DAY }));
    await store.flush();
    assert.deepEqual(await store.sweep(), [], "retention off");

    retain = 5 * DAY;
    assert.deepEqual(await store.sweep(), ["aaaa0001"]);
    assert.deepEqual(records, [{ hash: "aaaa0001", reason: "retention", outcome: "deleted", bytes: records[0].bytes, idleMs: 9 * DAY }]);
    assert.deepEqual(removed, ["aaaa0001"], "whatever lists sessions hears of it");

    // The count cap is the other reason, and says so.
    now = 9.5 * DAY;
    store.put(summary("aaaa0003", { lastTs: now }), ev("aaaa0003", 0, { ts: now }));
    store.put(summary("aaaa0004", { lastTs: now }), ev("aaaa0004", 0, { ts: now }));
    await store.flush();
    assert.deepEqual(records.slice(1).map((r) => [r.hash, r.reason]), [["aaaa0002", "budget"]]);

    // An idle worker's next write expires too, not only a sweep.
    now = 20 * DAY;
    store.put(summary("aaaa0005", { lastTs: now }), ev("aaaa0005", 0, { ts: now }));
    await store.flush();
    assert.deepEqual(records.slice(2).map((r) => [r.hash, r.reason]).sort(), [["aaaa0003", "retention"], ["aaaa0004", "retention"]]);
});

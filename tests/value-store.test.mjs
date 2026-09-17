// The value store (src/value-store.ts): the eviction POLICY as a pure function, then the store itself over an in-memory
// IndexedDB. What is pinned is the spec's "Eviction" section: one global budget, least recently READ first, idle orphans
// swept, a session released explicitly, a read that never degrades to a preview, and a tombstone that says why.
import { test } from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { planEviction, ValueStore, ValueMissing, ValueTooLarge, IDLE_MS, TOMBSTONE_MS } from "../src/value-store.ts";

const MIN = 60_000, HOUR = 60 * MIN;
const row = (key, bytes, lastReadAt, extra = {}) => ({ key, bytes, lastReadAt, createdAt: lastReadAt, sessions: [], format: "csv", ...extra });

/* ---------------- the policy ---------------- */

test("planEviction: nothing to do inside the budget, with nothing idle", () => {
    const now = 10 * HOUR;
    assert.deepEqual(planEviction([row("a", 100, now), row("b", 100, now)], { budgetBytes: 1000, now, incoming: 500 }), []);
});

test("planEviction: over budget, the least recently READ goes first, and only as many as the write needs", () => {
    const now = 10 * HOUR;
    const rows = [
        row("old-but-read", 400, now - MIN, { createdAt: 0 }),   // created first, READ recently: survives
        row("untouched", 400, now - 5 * HOUR),
        row("middling", 400, now - 2 * HOUR),
    ];
    const plan = planEviction(rows, { budgetBytes: 1000, now, incoming: 300 });
    assert.deepEqual(plan.map((e) => [e.key, e.reason]), [["untouched", "budget"], ["middling", "budget"]],
        "1200 held + 300 incoming needs 500 freed: the two read longest ago, in that order");
    assert.ok(!plan.some((e) => e.key === "old-but-read"), "recency is lastReadAt, not createdAt");
});

test("planEviction: ONE budget across sessions, not one per session", () => {
    const now = 10 * HOUR;
    const rows = [row("s1", 600, now - 2 * MIN, { sessions: ["a"] }), row("s2", 600, now - MIN, { sessions: ["b"] })];
    assert.deepEqual(planEviction(rows, { budgetBytes: 1000, now }).map((e) => e.key), ["s1"], "two sessions under 1000 each still share the pool");
});

test("planEviction: an idle value is swept whatever the budget, and a protected one never is", () => {
    const now = 10 * IDLE_MS;
    const rows = [row("orphan", 10, now - IDLE_MS), row("being-read", 5000, now - 3 * IDLE_MS), row("fresh", 10, now)];
    const idle = planEviction(rows, { budgetBytes: 100_000, now, protect: ["being-read"] });
    assert.deepEqual(idle.map((e) => [e.key, e.reason]), [["orphan", "idle"]], "inside the budget, only the idle orphan goes: the protected value is not idle-swept");
    const tight = planEviction(rows, { budgetBytes: 100, now, protect: ["being-read"] });
    assert.ok(!tight.some((e) => e.key === "being-read"), "over the budget, the protected value is still not evicted");
    assert.deepEqual(tight.map((e) => e.key), ["orphan", "fresh"], "…the unprotected ones go instead");
});

test("planEviction: a budget that cannot be met evicts what it may and stops", () => {
    const now = HOUR;
    const plan = planEviction([row("a", 50, now), row("b", 50, now)], { budgetBytes: 100, now, incoming: 200 });
    assert.deepEqual(plan.map((e) => e.key).sort(), ["a", "b"], "everything unprotected goes; the caller refuses the write");
});

/* ---------------- the store ---------------- */

const blob = (n) => new Blob([new Uint8Array(n)]);
const makeStore = (o = {}) => {
    let now = o.start ?? HOUR;
    const evicted = [];
    const store = new ValueStore({ idb: new IDBFactory(), budgetBytes: () => o.budget ?? 1000, now: () => now, onEvict: (e) => evicted.push(e), ...(o.idleMs ? { idleMs: o.idleMs } : {}) });
    return { store, evicted, tick: (ms) => { now += ms; } };
};

test("store: put then get returns the same bytes and marks the value read", async () => {
    const { store, tick } = makeStore();
    const put = await store.put(new Blob([new Uint8Array([1, 2, 3])]), { format: "arrow-file", source: "https://x.test/a.arrow" });
    assert.match(put.key, /^v[0-9a-f]{16}$/);
    assert.equal(put.bytes, 3);
    tick(5 * MIN);
    const { row: r, blob: b } = await store.get(put.key);
    assert.deepEqual([...new Uint8Array(await b.arrayBuffer())], [1, 2, 3]);
    assert.equal(r.lastReadAt, put.createdAt + 5 * MIN, "a read moves lastReadAt, which is what budget eviction orders by");
});

test("store: a write that needs room evicts the least recently read, reports it, and leaves a tombstone", async () => {
    const { store, evicted, tick } = makeStore({ budget: 1000 });
    const a = await store.put(blob(400), { format: "csv", source: "a.csv" });
    tick(MIN);
    const b = await store.put(blob(400), { format: "csv", source: "b.csv" });
    tick(MIN);
    await store.get(a.key);                                    // a is now the more recently read
    tick(MIN);
    await store.put(blob(400), { format: "csv", source: "c.csv" });
    assert.deepEqual(evicted.map((e) => [e.key, e.reason, e.bytes]), [[b.key, "budget", 400]], "b was read longest ago");
    await assert.rejects(store.get(b.key), (e) => e instanceof ValueMissing && /b\.csv\) was evicted to keep the value store within its storage budget/.test(e.message)
        && /Re-run the step that produced it/.test(e.message));
    await store.get(a.key);                                    // …and a is still there
});

test("store: a value larger than the whole budget is refused, and nothing is evicted for it", async () => {
    const { store, evicted } = makeStore({ budget: 1000 });
    const kept = await store.put(blob(600), { format: "csv" });
    await assert.rejects(store.put(blob(1001), { format: "parquet" }), ValueTooLarge);
    assert.deepEqual(evicted, []);
    await store.get(kept.key);
});

test("store: ending a session releases exactly the values nobody else holds", async () => {
    const { store, evicted } = makeStore({ budget: 10_000 });
    const mine = await store.put(blob(10), { format: "csv" });
    const other = await store.put(blob(10), { format: "csv", session: "other" });
    const shared = await store.put(blob(10), { format: "csv", session: "other" });
    const loose = await store.put(blob(10), { format: "csv" });
    assert.equal(await store.claim(mine.key, "run1"), true);
    assert.equal(await store.claim(mine.key, "run1"), true, "claiming twice is harmless");
    assert.equal(await store.claim(shared.key, "run1"), true, "a second session can hold a value another already claimed");
    assert.equal(await store.claim("v0000000000000000", "run1"), false, "a key that is not stored cannot be claimed");
    const released = await store.releaseSession("run1");
    assert.deepEqual(released.map((e) => [e.key, e.reason]), [[mine.key, "session-end"]], "the shared value is still held by `other`");
    assert.deepEqual(evicted.map((e) => e.key), [mine.key]);
    await assert.rejects(store.get(mine.key), /when its session ended/);
    await store.get(other.key);
    await store.get(loose.key);
    assert.deepEqual((await store.get(shared.key)).row.sessions, ["other"]);
    assert.deepEqual((await store.releaseSession("other")).map((e) => e.key).sort(), [other.key, shared.key].sort(), "…until its last holder ends");
});

test("store: the sweep takes idle orphans and forgets tombstones after a week", async () => {
    const { store, evicted, tick } = makeStore({ budget: 10_000 });
    const orphan = await store.put(blob(10), { format: "text" });
    tick(IDLE_MS);
    const fresh = await store.put(blob(10), { format: "text" });   // this write already sweeps the idle orphan
    assert.deepEqual(evicted.map((e) => [e.key, e.reason]), [[orphan.key, "idle"]]);
    await assert.rejects(store.get(orphan.key), /after going unread for a day/);
    tick(TOMBSTONE_MS + MIN);
    await store.get(fresh.key);                                     // reading it keeps it: only the tombstone is past its week
    await store.sweep();
    await assert.rejects(store.get(orphan.key), (e) => e instanceof ValueMissing && e.tombstone === null && /not in the store/.test(e.message),
        "past a week the tombstone is gone, and the error says so rather than inventing a reason");
});

test("store: a key that never existed is a ValueMissing with no reason, never a preview or undefined", async () => {
    const { store } = makeStore();
    await assert.rejects(store.get("v0000000000000000"), (e) => e instanceof ValueMissing && e.tombstone === null);
});

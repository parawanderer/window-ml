// The value store (src/value-store.ts): the eviction POLICY as a pure function, then the store itself over an in-memory
// IndexedDB. What is pinned is the spec's "Eviction" section: one global budget, least recently READ first, idle orphans
// swept, a session released explicitly, a read that never degrades to a preview, and a tombstone that says why.
import { test } from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { planEviction, ValueStore, ValueMissing, ValueTooLarge, IDLE_MS, TOMBSTONE_MS } from "../src/pointers/value-store.ts";

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

let fill = 0;
/** `n` bytes, DIFFERENT on every call: the same bytes are one blob (below), and these tests are about distinct values. */
const blob = (n) => new Blob([new Uint8Array(n).fill(++fill % 251)]);
const makeStore = (o = {}) => {
    let now = o.start ?? HOUR;
    const evicted = [];
    const idb = o.idb ?? new IDBFactory();
    const store = new ValueStore({ idb, budgetBytes: () => o.budget ?? 1000, now: () => now, onEvict: (e) => evicted.push(e), ...(o.idleMs ? { idleMs: o.idleMs } : {}) });
    return { store, idb, evicted, tick: (ms) => { now += ms; } };
};

// --- the store: basics ---

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

test("store: a claim with a `may` is taken only when it allows the holders as they are, or the session holds it already", async () => {
    const { store } = makeStore({ budget: 10_000 });
    const loose = await store.put(blob(10), { format: "csv" });
    const theirs = await store.put(blob(10), { format: "csv", session: "other" });
    const mine = await store.put(blob(10), { format: "csv", session: "run1" });
    const seen = [];
    const may = (holders) => { seen.push([...holders]); return !holders.length; };
    assert.equal(await store.claim(theirs.key, "run1", may), false, "refused: another session holds it");
    assert.deepEqual((await store.get(theirs.key)).row.sessions, ["other"], "and nothing was written");
    assert.equal(await store.claim(loose.key, "run1", may), true, "allowed: nobody holds it");
    assert.deepEqual((await store.get(loose.key)).row.sessions, ["run1"]);
    assert.equal(await store.claim(mine.key, "run1", () => false), true, "a session's own value is never refused to it");
    assert.equal(await store.claim("v0000000000000000", "run1", () => true), false, "a key that is not stored cannot be claimed");
    assert.deepEqual(seen, [["other"], []]);
});

test("store: two sessions racing to claim one unheld value under `may` = 'nobody holds it': exactly one gets it", async () => {
    const { store } = makeStore({ budget: 10_000 });
    for (let i = 0; i < 20; i++) {
        const { key } = await store.put(blob(10), { format: "csv" });
        const may = (holders) => !holders.length;
        const won = await Promise.all(["a", "b", "c"].map((s) => store.claim(key, s, may)));
        assert.equal(won.filter(Boolean).length, 1, `round ${i}: ${won}`);
        assert.equal((await store.get(key)).row.sessions.length, 1, "the predicate saw the holders the write was made over");
    }
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

// --- rows over blobs: helpers ---

/** Bytes that differ per `n` and `size`, so two calls with the same arguments are the same bytes. */
const bytesOf = (n, size) => new Blob([new Uint8Array(size).fill(n)]);
const rawOpen = (idb, name = "ml-values") => new Promise((res, rej) => { const r = idb.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const rawAll = (db, store) => new Promise((res, rej) => { const r = db.transaction(store).objectStore(store).getAllKeys(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

// --- rows over blobs: one copy of the same bytes ---

test("blobs: the same bytes put twice are two rows with their own keys over ONE blob, charged once", async () => {
    const { store, idb } = makeStore({ budget: 1000 });
    const a = await store.put(bytesOf(1, 600), { format: "csv", source: "a" });
    const b = await store.put(bytesOf(1, 600), { format: "csv", source: "b" });
    assert.notEqual(a.key, b.key);
    assert.equal(a.blob, b.blob);
    assert.match(a.blob, /^[0-9a-f]{64}$/);
    assert.equal(a.bytes, 600, "a row's bytes is the value's size");
    assert.equal((await rawAll(await rawOpen(idb), "blobs")).length, 1);
    assert.equal((await store.get(b.key)).blob.size, 600);
    // 600 charged once: a second, different 600-byte value does not fit alongside it (1200 > 1000), but a third copy does.
    await store.put(bytesOf(1, 600), { format: "csv" });
});

test("blobs: a put of stored bytes is accepted over the budget, and evicts nothing", async () => {
    let budget = 1000;
    const evicted = [];
    const store = new ValueStore({ idb: new IDBFactory(), budgetBytes: () => budget, now: () => HOUR, onEvict: (e) => evicted.push(e) });
    const other = await store.put(bytesOf(2, 300), { format: "csv" });
    const first = await store.put(bytesOf(1, 600), { format: "csv" });
    budget = 100;                                              // the setting was lowered: the blob alone is now over it
    const again = await store.put(bytesOf(1, 600), { format: "csv" });
    assert.equal(again.blob, first.blob);
    assert.deepEqual(evicted, [], "no eviction for a put that takes no room");
    await store.get(other.key);
    await assert.rejects(store.put(bytesOf(3, 600), { format: "csv" }), ValueTooLarge, "new bytes over the budget are still refused");
});

// --- rows over blobs: eviction per blob ---

const grow = (n, blob, lastReadAt, extra = {}) => row(n, 400, lastReadAt, { blob, ...extra });

test("planEviction: the budget charges a blob once, and evicts least recently read BLOBS, a group by its latest read", () => {
    const now = 10 * HOUR;
    const rows = [
        grow("x1", "X", now - 5 * HOUR), grow("x2", "X", now - MIN),            // X: two rows, last read a minute ago
        grow("y", "Y", now - 3 * HOUR),
        grow("z", "Z", now - 2 * HOUR),
    ];
    assert.deepEqual(planEviction(rows, { budgetBytes: 1200, now }), [], "three blobs of 400 hold in 1200 (four rows would not)");
    const plan = planEviction(rows, { budgetBytes: 1200, now, incoming: 400 });
    assert.deepEqual(plan.map((e) => [e.key, e.reason]), [["y", "budget"]], "Y was read longest ago; X's old row does not make X old");
    const two = planEviction(rows, { budgetBytes: 800, now, incoming: 400 });
    assert.deepEqual(two.map((e) => e.key), ["y", "z"], "then Z; X is read most recently");
});

test("planEviction: a group with ANY protected row is skipped whole", () => {
    const now = 10 * HOUR;
    const rows = [grow("x1", "X", now - 5 * HOUR), grow("x2", "X", now - 4 * HOUR), grow("y", "Y", now - HOUR)];
    const plan = planEviction(rows, { budgetBytes: 400, now, protect: ["x2"] });
    assert.deepEqual(plan.map((e) => e.key), ["y"], "the older group is protected through x2, so neither x row goes");
});

test("planEviction: evicting a whole group marks every row but the last `shared`; an idle row beside a kept one is `shared`", () => {
    const now = 10 * HOUR;
    const whole = planEviction([grow("x1", "X", now - 5 * HOUR), grow("x2", "X", now - 4 * HOUR)], { budgetBytes: 100, now });
    assert.deepEqual(whole.map((e) => [e.key, !!e.shared]), [["x1", true], ["x2", false]], "the blob goes with the last row, which is the one that frees bytes");
    const idleRows = [grow("old", "X", now - 2 * IDLE_MS), grow("live", "X", now)];
    const idle = planEviction(idleRows, { budgetBytes: 10_000, now });
    assert.deepEqual(idle.map((e) => [e.key, e.reason, e.shared]), [["old", "idle", true]], "its blob stays for the live row: no bytes freed");
    const legacy = planEviction([row("l", 400, 0)], { budgetBytes: 10_000, now: 10 * IDLE_MS });
    assert.equal(legacy[0].shared, undefined, "a row without a blob owns its bytes");
});

// --- rows over blobs: a blob goes with its last row ---

test("blobs: session end, idle and budget each delete the blob with its LAST row only", async () => {
    const { store, idb, evicted, tick } = makeStore({ budget: 1000 });
    const blobs = async () => (await rawAll(await rawOpen(idb), "blobs")).length;
    const a = await store.put(bytesOf(1, 100), { format: "csv", session: "s1" });
    const b = await store.put(bytesOf(1, 100), { format: "csv", session: "s2" });
    assert.equal(await blobs(), 1);
    const r1 = await store.releaseSession("s1");
    assert.deepEqual(r1.map((e) => [e.key, e.shared]), [[a.key, true]], "s1's row goes, the blob stays for b");
    assert.equal(await blobs(), 1);
    await store.get(b.key);
    const r2 = await store.releaseSession("s2");
    assert.deepEqual(r2.map((e) => [e.key, e.shared]), [[b.key, undefined]]);
    assert.equal(await blobs(), 0, "session-end of the last row deletes the blob");
    // idle
    const c = await store.put(bytesOf(2, 100), { format: "csv" });
    tick(IDLE_MS / 2);
    const d = await store.put(bytesOf(2, 100), { format: "csv" });
    tick(IDLE_MS / 2 + 1);
    await store.sweep();                                       // c idle, d not
    await assert.rejects(store.get(c.key), /after going unread for a day/);
    assert.equal(await blobs(), 1, "d still holds the blob");
    assert.ok(evicted.some((e) => e.key === c.key && e.shared === true));
    tick(IDLE_MS);
    await store.sweep();
    assert.equal(await blobs(), 0, "idle eviction of the last row deletes it");
    // budget
    const e1 = await store.put(bytesOf(3, 600), { format: "csv" });
    const e2 = await store.put(bytesOf(3, 600), { format: "csv" });
    tick(MIN);
    await store.put(bytesOf(4, 600), { format: "csv" });
    await assert.rejects(store.get(e1.key), /storage budget/);
    await assert.rejects(store.get(e2.key), /storage budget/);
    assert.equal(await blobs(), 1, "both rows of the older blob went, and only the new blob is left");
});

// --- rows over blobs: the upgrade from version 1 ---

/** Open `name` the way the version 1 code did and write what its `put` wrote: a row without `blob`, a blob under the row key. */
async function writeV1(idb, name, rows) {
    const db = await new Promise((res, rej) => {
        const req = idb.open(name, 1);
        req.onupgradeneeded = () => {
            const d = req.result;
            d.createObjectStore("rows", { keyPath: "key" }).createIndex("session", "sessions", { multiEntry: true });
            d.createObjectStore("blobs");
            d.createObjectStore("tombstones", { keyPath: "key" });
        };
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
    });
    const tx = db.transaction(["rows", "blobs"], "readwrite");
    for (const [r, b] of rows) { tx.objectStore("blobs").put(b, r.key); tx.objectStore("rows").put(r); }
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close();
}

test("upgrade: a version 1 database reads, claims, releases and evicts through its own-key blobs, and a new put stores a hashed blob beside", async () => {
    const idb = new IDBFactory();
    const v1 = (key, n, extra = {}) => ({ key, sessions: [], bytes: 50, format: "csv", createdAt: HOUR, lastReadAt: HOUR, ...extra });
    await writeV1(idb, "ml-values", [
        [v1("v0000000000000001", 1), bytesOf(1, 50)],
        [v1("v0000000000000002", 2, { source: "old.csv" }), bytesOf(2, 50)],
        [v1("v0000000000000003", 3), bytesOf(3, 50)],
    ]);
    let budget = 1000;
    let now = HOUR;
    const evicted = [];
    const store = new ValueStore({ idb, budgetBytes: () => budget, now: () => now, onEvict: (e) => evicted.push(e) });
    const tick = (ms) => { now += ms; };
    const one = await store.get("v0000000000000001");
    assert.equal(one.blob.size, 50);
    assert.equal(one.row.blob, undefined, "reading does not rewrite the row to a hash");
    assert.equal(await store.claim("v0000000000000002", "run1"), true);
    assert.deepEqual((await store.releaseSession("run1")).map((e) => [e.key, e.shared]), [["v0000000000000002", undefined]]);
    await assert.rejects(store.get("v0000000000000002"), /when its session ended/);
    assert.equal(await rawAll(await rawOpen(idb), "blobs").then((k) => k.includes("v0000000000000002")), false, "its blob went with it");
    // a new put of the SAME bytes as legacy 1 stores a new hashed blob and leaves the old one alone
    const fresh = await store.put(bytesOf(1, 50), { format: "csv" });
    assert.match(fresh.blob, /^[0-9a-f]{64}$/);
    const keys = await rawAll(await rawOpen(idb), "blobs");
    assert.ok(keys.includes("v0000000000000001") && keys.includes(fresh.blob));
    // budget eviction reaches legacy rows (150 held + 50 incoming > 120): the least recently read legacy row (3) goes first
    budget = 120;
    tick(MIN);
    await store.get("v0000000000000001");
    tick(MIN);
    await store.put(bytesOf(9, 50), { format: "csv" });
    assert.ok(evicted.some((e) => e.key === "v0000000000000003" && e.reason === "budget"));
    assert.equal(await rawAll(await rawOpen(idb), "blobs").then((k) => k.includes("v0000000000000003")), false);
    // the sweep takes the idle remainder, legacy blob included
    tick(IDLE_MS * 2);
    await store.sweep();
    assert.deepEqual(await store.rows(), []);
    assert.deepEqual(await rawAll(await rawOpen(idb), "blobs"), [], "no blob is left without a row");
});

// --- rows over blobs: races ---

test("races: two puts of the same bytes at once both succeed, with two rows and one blob", async () => {
    for (let i = 0; i < 10; i++) {
        const { store, idb } = makeStore({ budget: 1000 });
        const [a, b] = await Promise.all([store.put(bytesOf(7, 400), { format: "csv" }), store.put(bytesOf(7, 400), { format: "csv" })]);
        assert.notEqual(a.key, b.key);
        assert.equal((await store.rows()).length, 2);
        assert.equal((await rawAll(await rawOpen(idb), "blobs")).length, 1);
        await store.get(a.key); await store.get(b.key);
    }
});

test("races: an eviction racing a put of the same bytes leaves the new row readable", async () => {
    for (let delay = 0; delay < 40; delay++) {
        const { store, idb } = makeStore({ budget: 1000 });
        const old = await store.put(bytesOf(5, 400), { format: "csv", session: "gone" });
        const racing = (async () => { for (let k = 0; k < delay; k++) await Promise.resolve(); return store.releaseSession("gone"); })();
        const [fresh] = await Promise.all([store.put(bytesOf(5, 400), { format: "csv" }), racing]);
        const read = await store.get(fresh.key);
        assert.equal(read.blob.size, 400, `delay ${delay}`);
        await assert.rejects(store.get(old.key), ValueMissing);
        assert.equal((await rawAll(await rawOpen(idb), "blobs")).length, 1, `delay ${delay}: one blob, not orphaned`);
    }
});

// --- the new formats: paged and bytes are not tables ---

test("formats: a paged or bytes value is refused as a table with a sentence, not misread", async () => {
    const { storedColumns } = await import("../src/table/table-data.ts");
    for (const f of ["paged", "bytes"]) {
        await assert.rejects(storedColumns(new ArrayBuffer(4), f, ["a"]), new RegExp(`this stored value is ${f}, which is not a table`));
    }
});

// --- held rows: a file the person attached is kept for its session's life ---

test("planEviction: a held row a session holds is neither idle-swept nor budget-evicted, and its blob's group is skipped whole", () => {
    const now = 10 * IDLE_MS;
    const rows = [
        row("attached", 600, now - 3 * IDLE_MS, { held: true, sessions: ["s"], blob: "h1" }),
        row("fetched-copy", 600, now - 3 * IDLE_MS, { blob: "h1", sessions: ["t"] }),
        row("fetched", 300, now - MIN, { sessions: ["t"] }),
    ];
    const plan = planEviction(rows, { budgetBytes: 500, now, incoming: 100 });
    assert.ok(!plan.some((e) => e.key === "attached"), "the attachment stays, however long unread and however full the budget");
    assert.ok(!plan.some((e) => e.key === "fetched-copy" && e.reason === "budget"), "a fetched copy of the same bytes cannot take it out with it");
    assert.ok(plan.some((e) => e.key === "fetched" && e.reason === "budget"), "an ordinary value goes for the room");
});

test("planEviction: a held row nobody holds is evicted like any other, so a claim that never landed does not pin it forever", () => {
    const now = 10 * IDLE_MS;
    const plan = planEviction([row("stray", 10, now - IDLE_MS, { held: true })], { budgetBytes: 1000, now });
    assert.deepEqual(plan.map((e) => [e.key, e.reason]), [["stray", "idle"]]);
});

test("store: a held put that the budget cannot hold beside the held values is refused, and evicts nothing for it", async () => {
    const { store, evicted } = makeStore({ budget: 1000 });
    const first = await store.put(blob(700), { format: "bytes", session: "s", held: true });
    const fetched = await store.put(blob(100), { format: "csv", session: "t" });
    await assert.rejects(store.put(blob(400), { format: "bytes", session: "s", held: true }), ValueTooLarge,
        "700 held + 400 is past 1000 even with every evictable value gone");
    assert.deepEqual(evicted, [], "the fetched value was not evicted for a write that still would not fit");
    await store.get(first.key);
    await store.get(fetched.key);
});

test("store: a held value goes when its session ends, and an idle sweep before that leaves it", async () => {
    const { store, evicted, tick } = makeStore({ budget: 10_000, idleMs: HOUR });
    const held = await store.put(blob(10), { format: "bytes", session: "s", held: true });
    tick(5 * HOUR);
    await store.sweep();
    await store.get(held.key);
    await store.releaseSession("s");
    assert.deepEqual(evicted.map((e) => [e.key, e.reason]), [[held.key, "session-end"]]);
    await assert.rejects(store.get(held.key), ValueMissing);
});

test("upgrade: a row written before `held` existed has no field and is evicted as before", () => {
    const now = 10 * IDLE_MS;
    const old = { key: "v-old", bytes: 10, lastReadAt: now - IDLE_MS, createdAt: 0, sessions: ["s"], format: "text" };
    assert.deepEqual(planEviction([old], { budgetBytes: 1000, now }).map((e) => e.key), ["v-old"]);
});

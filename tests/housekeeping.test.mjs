// The housekeeping log (src/housekeeping.ts): what the system decided on its own, kept in storage.session so it
// outlives the worker, with eviction inferred from a heartbeat and page reports kept from crowding it out.
import { test } from "node:test";
import assert from "node:assert";
import { HousekeepingLog, sanitizeReport, trimRing, eventsForReader, LOG_KEY, SEEN_KEY, LOG_CAP, PAGE_CAP, IDLE_EVICT_MS } from "../src/housekeeping.ts";

function area(seed = {}) {
    const store = { ...seed };
    let writes = 0;
    return {
        store,
        writes: () => writes,
        get: async (keys) => Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, structuredClone(store[k])])),
        set: async (items) => { writes++; Object.assign(store, structuredClone(items)); },
    };
}

test("a first start logs `start` and no inferred eviction", async () => {
    const a = area();
    const log = new HousekeepingLog(a, () => 1_000);
    await log.start();
    const events = await log.all();
    assert.deepEqual(events.map((e) => `${e.subsystem}/${e.kind}`), ["sw/start"]);
    assert.equal(events[0].detail.previousWorker, false);
    assert.equal(a.store[SEEN_KEY], 1_000);
});

test("a heartbeat left by an earlier worker is logged as an inferred eviction, idle past the window", async () => {
    const a = area({ [SEEN_KEY]: 100_000 });
    const log = new HousekeepingLog(a, () => 100_000 + IDLE_EVICT_MS + 5);
    await log.start();
    const [evicted, start] = await log.all();
    assert.equal(evicted.kind, "evicted-inferred");
    assert.equal(evicted.reason, "idle");
    assert.equal(evicted.ms, IDLE_EVICT_MS + 5);
    assert.equal(evicted.origin, "worker");
    assert.equal(start.detail.previousWorker, true);
});

test("a short gap is not called idle: the worker was stopped for some other reason", async () => {
    const log = new HousekeepingLog(area({ [SEEN_KEY]: 50_000 }), () => 52_000);
    await log.start();
    assert.equal((await log.all())[0].reason, "unknown");
});

test("events are batched: many records cost one write", async () => {
    const a = area();
    let t = 0;
    const log = new HousekeepingLog(a, () => t);
    for (let i = 0; i < 50; i++) { t = i; log.record({ subsystem: "fetch-cache", kind: "evict", bytes: i }); }
    assert.equal(a.writes(), 0, "nothing written before the flush");
    await log.flush();
    assert.equal(a.writes(), 1);
    assert.equal((await log.all()).length, 50);
});

test("concurrent flushes never drop each other's batch", async () => {
    const a = area();
    const log = new HousekeepingLog(a, () => 1);
    log.record({ subsystem: "sw", kind: "one" });
    const f1 = log.flush();
    log.record({ subsystem: "sw", kind: "two" });
    const f2 = log.flush();
    await Promise.all([f1, f2]);
    assert.deepEqual((await log.all()).map((e) => e.kind), ["one", "two"]);
});

test("the ring keeps the newest LOG_CAP events", () => {
    const events = Array.from({ length: LOG_CAP + 10 }, (_, i) => ({ t: i, subsystem: "sw", kind: "x", origin: "worker" }));
    const kept = trimRing(events);
    assert.equal(kept.length, LOG_CAP);
    assert.equal(kept[0].t, 10);
});

test("a page flooding reports cannot push the worker's own events out", async () => {
    const a = area();
    const log = new HousekeepingLog(a, () => 1);
    log.record({ subsystem: "pyodide", kind: "cold-start", ms: 4000 });
    for (let i = 0; i < 5_000; i++) log.report({ subsystem: "fetch-cache", kind: "evict", bytes: i }, "page", 7);
    const events = await log.all();
    assert.ok(events.some((e) => e.kind === "cold-start"), "the worker's event survives");
    assert.equal(events.filter((e) => e.origin === "page").length, PAGE_CAP);
    assert.equal(events.at(-1).bytes, 4_999, "the newest page events are the ones kept");
});

test("a report's origin and tab are the caller's to set, never the reporter's", () => {
    const log = new HousekeepingLog(area(), () => 5);
    log.report({ subsystem: "sw", kind: "start", origin: "worker", tab: 1, t: 0 }, "page", 9);
    const [e] = log.pending;
    assert.equal(e.origin, "page");
    assert.equal(e.tab, 9);
    assert.equal(e.t, 5);
});

test("sanitizeReport keeps nothing a hostile page sends verbatim", () => {
    assert.equal(sanitizeReport(null), null);
    assert.equal(sanitizeReport({ subsystem: "SW", kind: "start" }), null, "names are lowercase slugs");
    assert.equal(sanitizeReport({ subsystem: "sw", kind: "<img src=x>" }), null);
    assert.equal(sanitizeReport({ subsystem: "x".repeat(40), kind: "start" }), null, "names are short");
    const r = sanitizeReport({
        subsystem: "fetch-cache", kind: "evict", reason: "Budget!", key: "k".repeat(2_000), bytes: -1, ms: Infinity,
        detail: { ok: "v".repeat(1_000), n: 3, nested: { a: 1 }, "bad key": 1, arr: [1], nan: NaN },
        extra: "dropped",
    });
    assert.deepEqual(Object.keys(r).sort(), ["detail", "key", "kind", "subsystem"]);
    assert.equal(r.key.length, 512);
    assert.deepEqual(Object.keys(r.detail).sort(), ["n", "ok"]);
    assert.equal(r.detail.ok.length, 200);
    const many = sanitizeReport({ subsystem: "sw", kind: "x", detail: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i])) });
    assert.equal(Object.keys(many.detail).length, 16);
});

test("a page reads key and string details only on the events its own tab reported", () => {
    const events = [
        { t: 1, subsystem: "fetch-cache", kind: "evict", key: "https://mine", detail: { a: 1, s: "mine" }, origin: "page", tab: 1 },
        { t: 2, subsystem: "fetch-cache", kind: "evict", key: "https://theirs", detail: { a: 2, url: "https://theirs" }, origin: "page", tab: 2 },
        { t: 3, subsystem: "value-store", kind: "evict", key: "session-hash", bytes: 10, origin: "worker" },
        { t: 4, subsystem: "pyodide", kind: "kill", detail: { message: "hash abc" }, origin: "offscreen" },
    ];
    const seen = eventsForReader(events, 1);
    assert.equal(seen[0].key, "https://mine");
    assert.equal(seen[0].detail.s, "mine");
    assert.equal(seen[1].key, undefined);
    assert.deepEqual(seen[1].detail, { a: 2 }, "a number identifies nothing and stays; the string goes");
    assert.equal(seen[3].detail, undefined, "a detail left empty is dropped");
    assert.equal(seen[2].key, undefined);
    assert.equal(seen[2].bytes, 10, "the decision itself stays visible");
    assert.deepEqual(eventsForReader(events, null), events, "an extension surface sees everything");
});

test("clear leaves a marker, so a cleared log reads differently from an empty one", async () => {
    const a = area();
    const log = new HousekeepingLog(a, () => 3);
    log.record({ subsystem: "sw", kind: "x" });
    await log.flush();
    await log.clear();
    assert.deepEqual((await log.all()).map((e) => `${e.subsystem}/${e.kind}`), ["log/clear"]);
    assert.ok(Array.isArray(a.store[LOG_KEY]));
});

test("a failing storage write loses the batch without breaking later ones", async () => {
    const a = area();
    let fail = true;
    const set = a.set;
    a.set = async (items) => { if (fail) throw new Error("quota"); return set(items); };
    const log = new HousekeepingLog(a, () => 1);
    log.record({ subsystem: "sw", kind: "lost" });
    await log.flush();
    fail = false;
    log.record({ subsystem: "sw", kind: "kept" });
    assert.deepEqual((await log.all()).map((e) => e.kind), ["kept"]);
});

test("a read racing the worker's start still sees the start's events", async () => {
    const a = area({ [SEEN_KEY]: 0 });
    const get = a.get;
    a.get = async (keys) => { await new Promise((r) => setTimeout(r, 20)); return get(keys); };
    const log = new HousekeepingLog(a, () => 60_000);
    void log.start();
    assert.deepEqual((await log.all()).map((e) => e.kind), ["evicted-inferred", "start"]);
});

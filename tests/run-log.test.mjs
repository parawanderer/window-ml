// The per-run execution log (src/run-log.ts): what the machinery did while a run ran, kept per run so one run
// watching a sleeping tab cannot push every other run's mechanics out of the ring.
import { test } from "node:test";
import assert from "node:assert";
import { RunLog, sanitizeRunReport, trimRunRing, eventsForRun, runsInLog, runLogDocument, RUN_LOG_KEY, RUN_LOG_CAP, PER_RUN_CAP, RUN_LOG_SCHEMA_VERSION } from "../src/run-log.ts";

function area(seed = {}) {
    const store = { ...seed };
    return {
        store,
        get: async (keys) => Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, structuredClone(store[k])])),
        set: async (items) => { Object.assign(store, structuredClone(items)); },
    };
}
const rec = (run, over = {}) => ({ run, subsystem: "page", kind: "discarded", t: 1, origin: "worker", ...over });

// --- what a record must be: the housekeeping rules, plus a run that is a session hash ---

test("a well-formed record keeps its run", () => {
    assert.deepEqual(sanitizeRunReport({ run: "abc123", subsystem: "cdp", kind: "refused", reason: "permission" }),
        { run: "abc123", subsystem: "cdp", kind: "refused", reason: "permission" });
});

test("a record with no run is not a run-log record", () => {
    assert.equal(sanitizeRunReport({ subsystem: "cdp", kind: "attach" }), null);
});

test("a run id that is not a session hash is refused — a `:` would make it a SessionKey, not a hash", () => {
    for (const run of ["", "rt:abc123", "a".repeat(65), "has space", 7, null])
        assert.equal(sanitizeRunReport({ run, subsystem: "cdp", kind: "attach" }), null, JSON.stringify(run));
});

test("the housekeeping log's own rules still apply: a bad name is refused, detail is flattened and capped", () => {
    assert.equal(sanitizeRunReport({ run: "abc123", subsystem: "CDP", kind: "attach" }), null);
    assert.equal(sanitizeRunReport({ run: "abc123", subsystem: "cdp", kind: "" }), null);
    const clean = sanitizeRunReport({ run: "abc123", subsystem: "cdp", kind: "attach", ms: -1, bytes: 10, detail: { ok: true, nested: { a: 1 }, n: 2 } });
    assert.equal(clean.ms, undefined);
    assert.equal(clean.bytes, 10);
    assert.deepEqual(clean.detail, { ok: true, n: 2 });
});

// --- the ring: one run's flood must not cost another run its history ---

test("under both caps nothing is dropped", () => {
    const rs = [rec("aaa1"), rec("bbb2"), rec("aaa1")];
    assert.deepEqual(trimRunRing(rs), rs);
});

test("a run past its own cap loses its OLDEST records, and no other run loses any", () => {
    const flood = Array.from({ length: PER_RUN_CAP + 5 }, (_, i) => rec("aaa1", { t: i }));
    const other = [rec("bbb2", { t: 999 })];
    const kept = trimRunRing([...flood, ...other]);
    const mine = eventsForRun(kept, "aaa1");
    assert.equal(mine.length, PER_RUN_CAP);
    assert.equal(mine[0].t, 5, "the five oldest of that run went");
    assert.deepEqual(eventsForRun(kept, "bbb2"), other);
});

test("past the total cap the oldest records go, whichever run they belong to", () => {
    // Enough runs that no single one is over its own cap, so only the total cap can be doing the work.
    const rs = [];
    for (let i = 0; i < RUN_LOG_CAP / 100 + 2; i++) for (let j = 0; j < 100; j++) rs.push(rec(`run${i}`, { t: i * 100 + j }));
    const kept = trimRunRing(rs);
    assert.equal(kept.length, RUN_LOG_CAP);
    assert.equal(kept[kept.length - 1].t, rs[rs.length - 1].t);
    assert.ok(kept[0].t > rs[0].t);
});

test("the runs in a log are listed newest first, with how much each has", () => {
    assert.deepEqual(runsInLog([rec("aaa1", { t: 10 }), rec("bbb2", { t: 50 }), rec("aaa1", { t: 20 })]),
        [{ run: "bbb2", count: 1, last: 50 }, { run: "aaa1", count: 2, last: 20 }]);
});

// --- the log the worker keeps ---

test("a recorded line is stamped with the time and who recorded it", async () => {
    const log = new RunLog(area(), () => 4_000);
    log.record("abc123", { subsystem: "page", kind: "reloaded", reason: "discarded" });
    const [e] = await log.all();
    assert.deepEqual(e, { run: "abc123", subsystem: "page", kind: "reloaded", reason: "discarded", t: 4_000, origin: "worker" });
});

test("a malformed line is dropped rather than thrown: logging must never fail the run being logged", async () => {
    const log = new RunLog(area(), () => 1);
    log.record("abc123", { subsystem: "NOPE", kind: "x" });
    log.record("rt:abc123", { subsystem: "page", kind: "discarded" });
    assert.deepEqual(await log.all(), []);
});

test("forRun reads one run out of a ring holding several", async () => {
    const log = new RunLog(area(), () => 1);
    log.record("aaa1", { subsystem: "cdp", kind: "attach" });
    log.record("bbb2", { subsystem: "cdp", kind: "attach" });
    log.record("aaa1", { subsystem: "cdp", kind: "detach", reason: "run-end" });
    assert.deepEqual((await log.forRun("aaa1")).map((e) => e.kind), ["attach", "detach"]);
});

test("clearing one run leaves every other run's mechanics alone", async () => {
    const log = new RunLog(area(), () => 1);
    log.record("aaa1", { subsystem: "cdp", kind: "attach" });
    log.record("bbb2", { subsystem: "cdp", kind: "attach" });
    await log.clear("aaa1");
    assert.deepEqual((await log.all()).map((e) => e.run), ["bbb2"]);
});

test("clearing the lot empties it, with no marker left behind", async () => {
    const log = new RunLog(area(), () => 1);
    log.record("aaa1", { subsystem: "cdp", kind: "attach" });
    await log.clear();
    assert.deepEqual(await log.all(), []);
});

test("the ring outlives the log object, which is what surviving an evicted worker means", async () => {
    const a = area();
    const first = new RunLog(a, () => 1);
    first.record("aaa1", { subsystem: "page", kind: "silent", ms: 8_000 });
    await first.flush();
    assert.equal(a.store[RUN_LOG_KEY].length, 1);
    const next = new RunLog(a, () => 2);
    next.record("aaa1", { subsystem: "page", kind: "unreachable", reason: "asleep" });
    assert.deepEqual((await next.all()).map((e) => e.kind), ["silent", "unreachable"]);
});

test("the export is a document, not a bare array: it says which run, when, and by which schema", () => {
    const rs = [rec("aaa1"), rec("bbb2")];
    assert.deepEqual(runLogDocument(rs, "aaa1", 1_700_000_000_000),
        { schemaVersion: RUN_LOG_SCHEMA_VERSION, exportedAt: "2023-11-14T22:13:20.000Z", run: "aaa1", records: rs });
    // The whole ring has no one run to name, and a `run` of null or "" would read as a run called that.
    assert.equal("run" in runLogDocument(rs, null, 1), false);
});

// --- the names the emitters use: a generator judged by a rule, enumerated rather than sampled ---

/** Every `subsystem` / `kind` / `reason` literal the worker's emitters pass, in either of the two shapes they
 *  are written in: a record literal (`subsystem: "cdp"`) and the log helper's positional kind (`note("held")`). */
async function emittedNames() {
    const { readFile } = await import("node:fs/promises");
    const out = { subsystem: new Set(), kind: new Set(), reason: new Set() };
    for (const f of ["sw-run-host.ts", "sw-cdp.ts", "sw-runs.ts"]) {
        const src = await readFile(new URL(`../src/${f}`, import.meta.url), "utf8");
        for (const key of ["subsystem", "kind", "reason"])
            for (const m of src.matchAll(new RegExp(`\\b${key}:\\s*([^,}\\n]+)`, "g")))
                for (const lit of m[1].matchAll(/"([^"]*)"/g)) out[key].add(lit[1]);
        for (const m of src.matchAll(/\bnote\(\s*"([^"]*)"/g)) out.kind.add(m[1]);
    }
    // One reason is not a literal at its emit site: an unreachable page records `reason: e.state`, whose values
    // are the `TabState` union plus the cap's own "silent". Read them where they ARE declared, so a new state
    // named in a shape the sanitizer refuses still fails this.
    const reach = await readFile(new URL("../src/page-reachable.ts", import.meta.url), "utf8");
    const states = reach.match(/^export type TabState = (.*)$/m)[1] + (reach.match(/state: TabState \| "[^"]+"/)?.[0] ?? "");
    for (const lit of states.matchAll(/"([^"]*)"/g)) out.reason.add(lit[1]);
    return out;
}

test("every name the emitters pass survives the sanitizer — a bad slug would drop the record silently", async () => {
    const names = await emittedNames();
    // The scan must not pass by finding nothing: these three files hold the page, cdp and tab mechanics.
    assert.ok(names.subsystem.size >= 3, [...names.subsystem].join(","));
    assert.ok(names.kind.size >= 8, [...names.kind].join(","));
    assert.ok(names.reason.size >= 5, [...names.reason].join(","));
    for (const subsystem of names.subsystem)
        assert.ok(sanitizeRunReport({ run: "abc123", subsystem, kind: "x" }), `subsystem "${subsystem}"`);
    for (const kind of names.kind)
        assert.ok(sanitizeRunReport({ run: "abc123", subsystem: "page", kind }), `kind "${kind}"`);
    for (const reason of names.reason)
        assert.ok(sanitizeRunReport({ run: "abc123", subsystem: "page", kind: "x", reason })?.reason, `reason "${reason}"`);
});

test("the kinds and reasons the module's own map documents are the ones the emitters emit", async () => {
    const { readFile } = await import("node:fs/promises");
    const doc = await readFile(new URL("../src/run-log.ts", import.meta.url), "utf8");
    // The map is the three `//   <subsystem>  <kind> (reason: a|b) · <kind> …` lines in the header's convention
    // note. Parsed rather than grepped, so the prose around it cannot be mistaken for an entry.
    const lines = doc.split("\n").filter((l) => /^\/\/ {3}(page|cdp|tab) /.test(l));
    assert.equal(lines.length, 3, "the map's three subsystem lines");
    const mapped = { subsystem: new Set(), kind: new Set(), reason: new Set() };
    for (const line of lines) {
        const [, subsystem, rest] = line.match(/^\/\/ {3}(\w+) +(.*)$/);
        mapped.subsystem.add(subsystem);
        for (const seg of rest.split("·")) {
            mapped.kind.add(seg.trim().split(/\s/)[0]);
            const reasons = seg.match(/\(reason: ([^)]+)\)/);
            if (reasons) for (const r of reasons[1].split("|")) mapped.reason.add(r.trim());
        }
    }
    const names = await emittedNames();
    // One direction only: the map is a map, so an emitter may add a kind before anyone writes it down — but a
    // kind written down that nothing emits is a map describing a log that does not exist.
    for (const key of ["subsystem", "kind", "reason"])
        for (const w of mapped[key]) assert.ok(names[key].has(w), `the map lists ${key} "${w}", which nothing emits`);
});

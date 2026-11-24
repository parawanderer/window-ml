// The per-run execution log (src/run-log.ts): what the machinery did while a run ran, kept per run so one run
// watching a sleeping tab cannot push every other run's mechanics out of the ring.
import { test } from "node:test";
import assert from "node:assert";
import { RunLog, sanitizeRunReport, trimRunRing, eventsForRun, runsInLog, runLogDocument, filterRunLog, levelCounts, RUN_LOG_KEY, RUN_LOG_CAP, PER_RUN_CAP, PER_RUN_CELL_CAP, CELL_LOG_CAP, RUN_LOG_SCHEMA_VERSION } from "../src/log/run-log.ts";

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

// --- the ring: a run's cell facts and its mechanics are capped apart, so neither evicts the other ---

const cellRec = (run, over = {}) => ({ run, subsystem: "cell", kind: "facts", t: 1, origin: "worker", detail: { seq: 1, cell: { lang: "js", ran: "inside" } }, ...over });
const isCell = (r) => r.subsystem === "cell";

test("201 cell records of a run leave every one of its mechanics records; the run keeps its newest 200 cells", () => {
    const mech = Array.from({ length: 50 }, (_, i) => rec("aaa1", { t: i }));
    const cells = Array.from({ length: PER_RUN_CELL_CAP + 1 }, (_, i) => cellRec("aaa1", { t: 100 + i }));
    const kept = trimRunRing([...mech, ...cells]);
    assert.deepEqual(kept.filter((r) => !isCell(r)), mech);
    assert.equal(kept.filter(isCell).length, PER_RUN_CELL_CAP);
    assert.equal(kept.filter(isCell)[0].t, 101, "the oldest cell went");
});

test("201 mechanics records of a run leave every one of its cell records", () => {
    const cells = Array.from({ length: 30 }, (_, i) => cellRec("aaa1", { t: i }));
    const mech = Array.from({ length: PER_RUN_CAP + 1 }, (_, i) => rec("aaa1", { t: 100 + i }));
    const kept = trimRunRing([...cells, ...mech]);
    assert.deepEqual(kept.filter(isCell), cells);
    assert.equal(kept.filter((r) => !isCell(r)).length, PER_RUN_CAP);
});

test("past the total cap, cells evict only older cells: no run's cells cost another run its mechanics", () => {
    const mech = Array.from({ length: 100 }, (_, i) => rec("bbb2", { t: i }));
    const cells = [];
    for (let i = 0; i < CELL_LOG_CAP / 100 + 3; i++) for (let j = 0; j < 100; j++) cells.push(cellRec(`run${i}`, { t: 1000 + i * 100 + j }));
    const kept = trimRunRing([...mech, ...cells]);
    assert.deepEqual(kept.filter((r) => !isCell(r)), mech, "every other run's mechanics stay");
    assert.equal(kept.filter(isCell).length, CELL_LOG_CAP);
    assert.equal(kept.at(-1).t, cells.at(-1).t, "the newest cells stay");
});

test("UPGRADE: a ring the old code wrote, with no cell records, trims exactly as it did", () => {
    const old = [];
    for (let i = 0; i < 25; i++) for (let j = 0; j < 100; j++) old.push(rec(`run${i}`, { t: i * 100 + j }));
    old.push(...Array.from({ length: PER_RUN_CAP + 7 }, (_, i) => rec("flood", { t: 9000 + i })));
    // The old trim, as it was: each run to PER_RUN_CAP oldest-first, then the last RUN_LOG_CAP.
    const counts = new Map();
    for (const r of old) counts.set(r.run, (counts.get(r.run) || 0) + 1);
    const excess = new Map([...counts].filter(([, n]) => n > PER_RUN_CAP).map(([run, n]) => [run, n - PER_RUN_CAP]));
    const perRun = old.filter((r) => { const left = excess.get(r.run) || 0; if (left > 0) { excess.set(r.run, left - 1); return false; } return true; });
    assert.deepEqual(trimRunRing(old), perRun.slice(-RUN_LOG_CAP));
    const small = [rec("aaa1"), rec("bbb2")];
    assert.deepEqual(trimRunRing(small), small, "under the caps, read unchanged");
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
    for (const f of ["sw-run-host.ts", "delegate-send.ts", "sw-cdp.ts", "sw-runs.ts"]) {
        const src = await readFile(new URL(`../src/sw/${f}`, import.meta.url), "utf8");
        for (const key of ["subsystem", "kind", "reason"])
            for (const m of src.matchAll(new RegExp(`\\b${key}:\\s*([^,}\\n]+)`, "g")))
                for (const lit of m[1].matchAll(/"([^"]*)"/g)) out[key].add(lit[1]);
        for (const m of src.matchAll(/\bnote\(\s*"([^"]*)"/g)) out.kind.add(m[1]);
    }
    // One reason is not a literal at its emit site: an unreachable page records `reason: e.state`, whose values
    // are the `PageUnreachableState` union: `TabState`'s verdicts plus "busy", the cap's own "silent" and "unadopted".
    // Read them where they ARE declared, so a new state named in a shape the sanitizer refuses still fails this.
    const reach = await readFile(new URL("../src/sw/page-reachable.ts", import.meta.url), "utf8");
    const states = reach.match(/^export type TabState = (.*)$/m)[1] + reach.match(/^export type PageUnreachableState = (.*)$/m)[1];
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
    const doc = await readFile(new URL("../src/log/run-log.ts", import.meta.url), "utf8");
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

// --- levels, and the panel's filter over them ---

test("a record keeps a warn or error level; info is the default and is not stored, anything else is dropped", () => {
    assert.equal(sanitizeRunReport({ run: "abc123", subsystem: "page", kind: "x", level: "warn" }).level, "warn");
    assert.equal(sanitizeRunReport({ run: "abc123", subsystem: "page", kind: "x", level: "error" }).level, "error");
    for (const level of ["info", "WARN", "fatal", 2, null, {}])
        assert.ok(!("level" in sanitizeRunReport({ run: "abc123", subsystem: "page", kind: "x", level })), String(level));
});

test("every level an emitter passes is one the sanitizer keeps", async () => {
    const { readFile } = await import("node:fs/promises");
    const levels = new Set();
    for (const f of ["sw-run-host.ts", "delegate-send.ts", "sw-cdp.ts", "sw-runs.ts"]) {
        const src = await readFile(new URL(`../src/sw/${f}`, import.meta.url), "utf8");
        for (const m of src.matchAll(/\blevel:\s*"([^"]*)"/g)) levels.add(m[1]);
    }
    assert.deepEqual([...levels].sort(), ["error", "warn"], "the scan found the emitters' levels");
    for (const level of levels) assert.equal(sanitizeRunReport({ run: "abc123", subsystem: "page", kind: "x", level }).level, level);
});

const MIXED = [
    rec("r1", { t: 1, subsystem: "page", kind: "held", reason: "navigating", detail: { tab: 12, tool: "pageInfo" } }),
    rec("r1", { t: 2, level: "warn", subsystem: "page", kind: "discarded", detail: { tab: 12 } }),
    rec("r1", { t: 3, level: "error", subsystem: "cdp", kind: "refused", reason: "busy", key: "Another debugger is attached", detail: { tab: 9 } }),
];

test("the least level keeps that level and everything above it, and none means everything", () => {
    const kinds = (f) => filterRunLog(MIXED, f).map((r) => r.kind);
    assert.deepEqual(kinds({}), ["held", "discarded", "refused"]);
    assert.deepEqual(kinds({ minLevel: "info" }), ["held", "discarded", "refused"]);
    assert.deepEqual(kinds({ minLevel: "warn" }), ["discarded", "refused"]);
    assert.deepEqual(kinds({ minLevel: "error" }), ["refused"]);
});

test("the text matches any field the line prints, ignoring case, and combines with the level", () => {
    const kinds = (f) => filterRunLog(MIXED, f).map((r) => r.kind);
    assert.deepEqual(kinds({ text: "tab=12" }), ["held", "discarded"], "a detail as k=v");
    assert.deepEqual(kinds({ text: "PAGEINFO" }), ["held"], "a detail value, case-insensitively");
    assert.deepEqual(kinds({ text: "debugger" }), ["refused"], "the key");
    assert.deepEqual(kinds({ text: "navigating" }), ["held"], "the reason");
    assert.deepEqual(kinds({ text: "error" }), ["refused"], "the level itself");
    assert.deepEqual(kinds({ text: "  " }), ["held", "discarded", "refused"], "blank is no filter");
    assert.deepEqual(kinds({ text: "tab=12", minLevel: "warn" }), ["discarded"]);
    assert.deepEqual(kinds({ text: "nothing like it" }), []);
});

test("the level counts are of records AT OR ABOVE each level, which is what each choice would show", () => {
    assert.deepEqual(levelCounts(MIXED), { info: 3, warn: 2, error: 1 });
    assert.deepEqual(levelCounts([]), { info: 0, warn: 0, error: 0 });
});

// --- cell/facts: the one record whose detail is nested (docs/spec/CELL_FACTS.md, Half 1) ---

const { sanitizeCellFacts } = await import("../src/agent/cell-facts.ts");
const { currentLogRecords, snapshotCurrent } = await import("../src/agent/current-context.ts");
const { eventsForReader } = await import("../src/log/housekeeping.ts");
const factsRec = (detail, over = {}) => ({ run: "abc123", subsystem: "cell", kind: "facts", detail, ...over });
const goodCell = () => ({ lang: "js", ran: "inside", realm: "worker", steps: { used: 5, budget: 100 }, lifted: [{ name: "array.map", calls: 2, charged: 40 }] });

test("a valid cell/facts record is stored with its nested detail, equal to sanitizeCellFacts' output", () => {
    const cell = goodCell();
    const out = sanitizeRunReport(factsRec({ seq: 3, cell }));
    assert.deepEqual(out.detail, { seq: 3, cell: sanitizeCellFacts(cell) });
    assert.notEqual(out.detail.cell, cell, "rebuilt, never the raw object");
});

test("cell/facts: an unknown key, a wrong type or an over-cap list drops the whole record", () => {
    const bad = [
        factsRec({ seq: 1, cell: goodCell(), extra: 1 }),
        factsRec({ seq: 1 }),
        factsRec({ cell: goodCell() }),
        factsRec({ seq: -1, cell: goodCell() }),
        factsRec({ seq: 1.5, cell: goodCell() }),
        factsRec({ seq: "1", cell: goodCell() }),
        factsRec({ seq: 1, cell: { ...goodCell(), surprise: true } }),
        factsRec({ seq: 1, cell: { ...goodCell(), lifted: [{ name: "a.b", calls: 1, charged: 1, more: 1 }] } }),
        factsRec({ seq: 1, cell: { ...goodCell(), steps: { used: "5", budget: 100 } } }),
        factsRec({ seq: 1, cell: { ...goodCell(), lifted: Array.from({ length: 33 }, (_, i) => ({ name: `a.f${i}`, calls: 1, charged: 1 })) } }),
        factsRec([1, 2]), factsRec(null), factsRec("x"), factsRec(undefined),
    ];
    bad.forEach((b, i) => assert.equal(sanitizeRunReport(b), null, `case ${i}`));
});

test("another kind with a nested object in detail is still flattened: the lift is for cell/facts only", () => {
    const out = sanitizeRunReport({ run: "abc123", subsystem: "cell", kind: "other", detail: { seq: 1, cell: goodCell() } });
    assert.deepEqual(out.detail, { seq: 1 });
    const out2 = sanitizeRunReport({ run: "abc123", subsystem: "page", kind: "facts", detail: { seq: 1, cell: goodCell() } });
    assert.deepEqual(out2.detail, { seq: 1 });
});

test("the model's view of the log carries no cell/facts record while the person's has it", async () => {
    const log = new RunLog(area(), () => 10);
    log.record("abc123", { subsystem: "cell", kind: "facts", detail: { seq: 1, cell: goodCell() } });
    log.record("abc123", { subsystem: "page", kind: "discarded" });
    const mine = await log.forRun("abc123");
    assert.equal(mine.length, 2, "the person's view");
    assert.deepEqual(currentLogRecords(mine).map((r) => r.kind), ["discarded"]);
    const snap = snapshotCurrent({ run: { id: "abc123" }, messages: [], recorded: [], log: mine, now: 20 });
    assert.deepEqual(snap.log.map((r) => r.subsystem), ["page"]);
    assert.ok(!snap.log.text.includes("cell"), "nor on the greppable text");
});

test("a page reading events it did not report does not get a nested cell", () => {
    const ev = { t: 1, origin: "worker", subsystem: "cell", kind: "facts", detail: { seq: 1, cell: goodCell() } };
    const seen = eventsForReader([ev], 7)[0];
    assert.deepEqual(seen.detail, { seq: 1 }, "the number stays, the nested cell does not");
    assert.deepEqual(eventsForReader([ev], null)[0], ev, "an extension surface sees everything");
});

test("the search line makes a nested cell searchable as JSON, not [object Object]", () => {
    const rec1 = sanitizeRunReport(factsRec({ seq: 2, cell: goodCell() }));
    assert.equal(filterRunLog([rec1], { text: "array.map" }).length, 1);
    assert.equal(filterRunLog([rec1], { text: "[object" }).length, 0);
});

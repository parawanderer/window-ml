// isolated-pointer.test.mjs — a pointer's `.table`, `.pipe()` and `.schema()` in an isolated exec (site access slice 2
// part 4b; iso-channel.ts, isolated-kit.ts), matched against the same reads on the read-only path and on the approved
// main-world path, errors and caps included.
//
// Every path runs in the real background bundle, on one worker-built run per path (isolated-harness.mjs): a `fetch_url`
// of a CSV past the parse cap (so its pointer is a STORED table, read by column through the worker), then one exec per
// probe. The read-only path is the worker's own survey; the isolated paths are a user-script world and a CDP world; the
// main world is the page's own pieces put together as the page puts them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runOn, ROWS } from "./isolated-harness.mjs";

const { ValueStore } = await import("../src/pointers/value-store.ts");
const { PIPE_CMDS } = await import("../src/pointers/text-pipe.ts");

const T = { timeout: 120000 };

/** The probe's report out of a tool result, whatever the path wrapped it in. */
const report = (result) => { const m = /<<<(.*)>>>/.exec(result); return m ? JSON.parse(m[1]) : { unparsed: result.slice(0, 600) }; };

/** A probe script: each named expression evaluated over the pointer `v`, a throw reported as its message, a string as
 *  its length, ends and a checksum (a short error stays whole, a MemoryFault without the run's other pointers, which
 *  differ by path as each path's own exec steps do; an exec's result is clipped at 500 characters, and the read-only path's with it). */
const probe = (entries, { pre = "", v = '@tool:"orders"' } = {}) => (id) => [
    pre,
    `const v = ${v};`,
    "const D = (x) => typeof x === \"string\" && (!x.startsWith(\"ERR \") || x.length > 300) ? [x.length, x.slice(0, 60), x.slice(-60), x.split(\"\").reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 1000000007, 7)] : x;",
    "const P = async (f) => { try { return D(await f()); } catch (e) { return D(\"ERR \" + e.message.split(\"\\nNearest valid pointers\")[0]); } };",
    `return "<<<" + JSON.stringify({ ${entries(id).map(([k, e]) => `${JSON.stringify(k)}: await P(async () => ${e})`).join(", ")} }) + ">>>";`,
].join("\n");

/** One stage per pipe verb, the dialect's own list enumerated: a verb added to PIPE_CMDS without a stage here fails. */
const STAGE = {
    grep: "grep -c 7", sed: "sed s/1/X/g | head -n 2", head: "head -n 3", tail: "tail -n 2", wc: "wc -l", count: "count",
    sort: "sort -n -r | head -n 2", uniq: "sort | uniq -c | head -n 2", keys: "keys", values: "values | head -n 2", schema: "schema", type: "type",
};
/** Every stage, the array form, and a stage the dialect refuses. */
const PIPES = [...Object.values(STAGE), ["grep -E 99|98", "head -n 2"], "nosuchverb x"];

/** What every path reads the same way, the read-only dialect included. */
const VALUE_PROBES = [
    // First, so the pointers its error lists as nearest are the fetch's alone: later ones are each path's own exec steps.
    ["unknownPointer", '(@tool:"no such label").text'],
    ["text", "v.text.length"], ["type", "v.type"],
    ["shape", "v.table.shape"], ["columns", "v.table.columns"], ["previewRows", "v.table.rows.length"],
    ["colLen", '(await v.table.col("n")).length'], ["colLast", `(await v.table.col("s"))[${ROWS - 1}]`],
    ["head7", "(await v.table.head(7)).rows"], ["headAll", `(await v.table.head(${ROWS})).shape`],
    ["select", '(await v.table.select(["id", "s"])).shape'], ["records", `(await v.table.records())[${ROWS - 1}]`],
    ["noColumn", '(await v.table.col("nope")).length'],
];
/** A pipe as the approved paths spell it, on the value, and as the read-only dialect does, which has no `.pipe()` on a
 *  value (it reads one as a string) and re-reads through `ml.dereference` instead. */
const pipeProbes = (id, onValue) => PIPES.map((p) => [`pipe ${JSON.stringify(p)}`, onValue ? `(await v.pipe(${JSON.stringify(p)})).text` : `(await ml.dereference("@tool:${id}", { pipe: ${JSON.stringify(p)} })).text`]);
/** What only the approved paths have: `.schema()` on a value, a table member it does not have, a re-pipe of a re-pipe. */
const APPROVED_PROBES = [
    ["schema", "v.schema()"], ["tableMember", "v.table.iloc"],
    ["repipe", '(await (await v.pipe("head -n 5")).pipe("tail -n 1")).text'],
];
/** The main world answers only the pipes its script names (named-reads.ts), and re-pipes `@tool:<id>`: name them. */
const namedForMain = (id) => `\n// ${[...PIPES, "head -n 5", "tail -n 1"].map((p) => `ml.dereference("@tool:${id}", { pipe: ${JSON.stringify(p)} })`).join(" ")}`;

/** The probes a path runs, one exec each, so no result is clipped. */
const probesFor = (path) => path === "readonly"
    ? [...VALUE_PROBES, ...pipeProbes("<id>", false)]
    : [...VALUE_PROBES, ...pipeProbes("<id>", true), ...APPROVED_PROBES];
/** One exec per probe, the pointer id filled in when the script is sent. */
const scriptsFor = (path) => probesFor(path).map(([k, e]) => (id) => {
    const body = probe(() => [[k, e.replaceAll("<id>", id)]])(id);
    return path === "main" ? body + namedForMain(id) : body;
});

/** A report with the run's own ids made the same: a pointer id and a value key differ per run, not per path. */
const norm = (o) => JSON.parse(JSON.stringify(o).replace(/@tool:[0-9a-f]{7}/g, "@tool:<id>").replace(/\bv[0-9a-f]{16}\b/g, "v<key>"));

/** Each path's report, one run each (a run is a fetch of a 200,001-row CSV, so they are shared by the tests below). */
const runs = {};
const reportOf = async (path) => (runs[path] ??= (async () => {
    const r = await runOn(path === "main" ? "none" : path, scriptsFor(path));
    return { report: Object.assign({}, ...r.results.map((x) => norm(report(x)))), log: [...new Set(r.log.map((x) => `${x.kind}:${x.reason}`))], raw: r.results };
})());

// --- parity: the same read on every path ---

test("every pipe verb has a stage in the probe (PIPE_CMDS is the single source)", () => {
    assert.deepEqual(Object.keys(STAGE).sort(), [...PIPE_CMDS].sort());
});

test("each path runs where it claims: the worker's survey, a user-script world, a CDP world, the page's main world", T, async () => {
    assert.deepEqual((await reportOf("readonly")).log, ["readonly-worker:no-page-reads"], JSON.stringify((await reportOf("readonly")).raw).slice(0, 400));
    assert.deepEqual((await reportOf("userScripts")).log, ["exec-isolated:pointer"]);
    assert.deepEqual((await reportOf("cdp")).log, ["exec-isolated:pointer"]);
    assert.deepEqual((await reportOf("main")).log, ["exec-main:pointer"]);
});

test("a stored table's facade, its column reads past the preview and its errors are the same in an isolated world as on the read-only and main-world paths", T, async () => {
    const want = (await reportOf("readonly")).report;
    assert.equal(want.colLen, ROWS, `positive control: the read-only path read every row: ${JSON.stringify(want).slice(0, 400)}`);
    assert.equal(want.previewRows < ROWS, true, "the pointer's own rows are a preview, so the column read went to the store");
    assert.match(want.noColumn, /^ERR No column "nope"/);
    assert.match(want.unknownPointer, /^ERR MemoryFault: pointer '@tool:"no such label"' does not exist\.$/);
    for (const path of ["userScripts", "cdp", "main"]) {
        const got = (await reportOf(path)).report;
        for (const [k] of VALUE_PROBES) assert.deepEqual(got[k], want[k], `${path}: ${k}`);
    }
});

test("each pipe verb, the array form and a refused stage give the same text or error through .pipe() in an isolated world as through the read-only path and the main world", T, async () => {
    const ro = (await reportOf("readonly")).report;
    const keys = pipeProbes("<id>", true).map(([k]) => k);
    assert.ok(keys.every((k) => k in ro), "the read-only probe used the same keys");
    assert.ok(keys.filter((k) => !String(ro[k]).startsWith("ERR")).length >= 10, `positive control: most stages answered: ${JSON.stringify(ro).slice(0, 600)}`);
    assert.match(ro['pipe "nosuchverb x"'], /^ERR /, "the refused stage is an error on the read-only path");
    for (const path of ["userScripts", "cdp", "main"]) {
        const got = (await reportOf(path)).report;
        for (const k of keys) assert.deepEqual(got[k], ro[k], `${path}: ${k}`);
    }
});

test(".schema(), a table member it lacks, and a re-pipe of a re-pipe are the same in an isolated world as in the main world", T, async () => {
    const main = (await reportOf("main")).report;
    assert.match(main.schema[1], /^table shape: \(200001, 3\)/, "positive control");
    assert.match(main.tableMember, /^ERR /);
    for (const path of ["userScripts", "cdp"]) {
        const got = (await reportOf(path)).report;
        for (const [k] of APPROVED_PROBES) assert.deepEqual(got[k], main[k], `${path}: ${k}`);
    }
});

test("a stored table evicted between calls fails with the store's reason on every path, never with the preview", T, async () => {
    const evict = async (i, { idb }) => { if (i === 1) await new ValueStore({ idb, budgetBytes: () => 1 }).sweep(); };
    const after = (path) => (id) => probe(() => [["colLen", '(await v.table.col("n")).length'], ["previewRows", "v.table.rows.length"]])(id) + (path === "main" ? namedForMain(id) : "");
    const out = {};
    for (const path of ["readonly", "userScripts", "cdp", "main"]) {
        const r = await runOn(path === "main" ? "none" : path, [after(path), after(path)], { between: evict });
        out[path] = r.results.map((x) => norm(report(x)));
    }
    assert.equal(out.readonly[0].colLen, ROWS, `positive control: before the eviction the column reads whole: ${JSON.stringify(out.readonly)}`);
    assert.match(out.readonly[1].colLen, /^ERR .*evicted to keep the value store within its storage budget/);
    for (const path of ["userScripts", "cdp", "main"]) assert.deepEqual(out[path], out.readonly, path);
});

// --- upgrade: what an isolated exec did before part 4b ---

test("UPGRADE: an isolated exec that read a pointer before part 4b reads it the same: its text, facts, JSON and a pipe named as a literal", T, async () => {
    // What part 4 already answered with the call: the value as a String with its facts, and a pipe the script names.
    const old = (id) => `const v = @tool:"orders"; const h = ml.dereference("@tool:${id}", { pipe: "head -n 2" }); return "<<<" + JSON.stringify([v.length, v.type, v.id === "${id}", v.tool, typeof v.json, String(h), h.text === String(h), v + "" === v.text]) + ">>>"`;
    for (const path of ["userScripts", "cdp"]) {
        const r = await runOn(path, [old]);
        const got = report(r.results[0]);
        assert.deepEqual(got, [413, "table", true, "fetch_url", "undefined", "{\n  \"columns\": [", true, true], `${path}: ${r.results[0].slice(0, 300)}`);
        assert.deepEqual(r.log.map((x) => x.kind), ["exec-isolated"]);
    }
});

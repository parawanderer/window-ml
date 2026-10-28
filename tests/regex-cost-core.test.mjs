// regex-cost-core.test.mjs — the regex COST corpus (tests/fixtures/dialect-vectors/regex-cost.json) read against the
// Python core window-ml SHIPS (dist/pyodide), since that core's `regex_work`/`regex_steps` is what prices a person's
// cell, not the JS model and not the fork's checkout (the coordinator's PR-3 ruling: "pinned against #1202's core"
// means run on dist/pyodide). Each entry states the ORDER of the bound on its input recipe (1 linear, 2 quadratic,
// 3 cubic, null unbounded); this file holds the shipped core to that order, and to the refusal that follows when the
// bound at the entry's own input is over `DEFAULT_BUDGET` ("priced": the cell is NotInDialect before the search runs).
// The under-budget entries run, as the positive control the refusals need — without it a core that refused every
// search would pass the priced half. Self-skips without the restricted core (`npm run fetch-pyodide`). The JS side of
// the same corpus is tests/regex-cost.test.mjs ("the cost corpus"); one DEFINITION and one CORPUS, both held to it.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { regexCostVectors, regexInput } from "./dialect-vectors.mjs";

const PYODIDE_DIR = path.resolve(import.meta.dirname, "../dist/pyodide");
const DATA_DIR = path.resolve(import.meta.dirname, "../notebooks/python-dialect/data");
const PIN = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../tools/pyodide-dist.json"), "utf8")).cpython.commit;
const WML_FLAGS = { i: 2, m: 8, s: 16, x: 64 };   // Python's re.I/M/S/X values, as regex-corpus-core.test.mjs maps them
let py = null, skip = fs.existsSync(path.join(PYODIDE_DIR, "pyodide.mjs")) ? false : "no dist/pyodide: run `npm run fetch-pyodide`";

before(async () => {
    if (skip) return;
    const { loadPyodide } = await import(path.join(PYODIDE_DIR, "pyodide.mjs"));
    py = await loadPyodide({ indexURL: PYODIDE_DIR });
    if (py.runPython(`import importlib.util; "stock" if importlib.util.find_spec("_restricted") is None else "fork"`) === "stock") {
        skip = "dist/pyodide is the stock Pyodide, not the restricted-mode build";
        return;
    }
    py.FS.mkdirTree("/dialect-data");
    py.mountNodeFS("/dialect-data", DATA_DIR);
    // The cost read and one end-to-end cell per entry: the gate is only live once load_manifests has run (it lifts
    // `re.*` behind `regex_check`), which is also what a real cell sees.
    py.runPython(`
import json, math, _restricted, restricted

def wml_regex_cost(pattern, flags, s1, s2):
    w1 = restricted.regex_work(pattern, flags, s1)
    w2 = restricted.regex_work(pattern, flags, s2)
    steps = restricted.regex_steps(pattern, flags, s1)
    def fin(x):
        return "inf" if isinstance(x, float) and not math.isfinite(x) else x
    return json.dumps({"w1": fin(w1), "w2": fin(w2), "steps": fin(steps), "budget": restricted.DEFAULT_BUDGET})

def wml_regex_run(pattern, flags, inp):
    src = "import re\\nre.search(" + repr(pattern) + ", " + repr(inp) + (", " + repr(flags) if flags else "") + ")"
    try:
        v = restricted.run_cell(src, {})
        return json.dumps({"ran": True, "value": repr(v)[:60]})
    except BaseException as e:
        return json.dumps({"ran": False, "exc": type(e).__name__,
                           "not_in_dialect": isinstance(e, _restricted.NotInDialect), "msg": str(e)[:160]})
`);
    py.runPython(`_restricted.reset(); restricted.load_manifests("/dialect-data")`);
}, { timeout: 240_000 });

/** One entry's bound on the shipped core: `{ w1, w2, steps, budget }`, non-finite values as `"inf"`. */
function cost(v, flags, s1, s2) {
    return JSON.parse(py.globals.get("wml_regex_cost")(v.pattern, flags, s1, s2));
}
/** `restricted.run_cell` on `re.search(pattern, inp)`: `{ ran, value }` or `{ ran: false, exc, not_in_dialect, msg }`. */
function run(v, flags, inp) {
    return JSON.parse(py.globals.get("wml_regex_run")(v.pattern, flags, inp));
}
/** The defended outcome for a priced entry: the gate refuses the search before it runs. */
function refused(out) {
    return out.ran === false && out.not_in_dialect === true;
}

// --- the shipped core against the cost corpus: the bound's order on each input, and the refusal its size earns ------
//
// A todo in LAG IS a pin lag: the fork has the fix, the core in dist/pyodide does not, so it is closed by REBUILDING
// the core and moving tools/pyodide-dist.json's pin, never by a code change here. Each entry names the fork commit
// that fixes it (`"<corpus name>": "<sha8>"`). An entry listed here that the core now judges right FAILS (a rebuild
// shipped its fix: delete the line); a mismatch on an entry NOT listed here FAILS too (the shipped core drifted from
// the corpus for some other reason).
const LAG = {};

for (const v of regexCostVectors("py")) {
    const title = v.order === null ? "unbounded" : `order ${v.order}`;
    test(`the shipped core's bound on ${v.name.replace(/^regex: /, "")} is ${title}, and the cell on its input is priced or run to match`, (t) => {
        if (skip) return t.skip(skip);
        const flags = [...v.flags].reduce((a, c) => a + (WML_FLAGS[c] ?? 0), 0);
        const s1 = regexInput({ input: v.input });
        const s2 = regexInput({ input: { ...v.input, n: v.input.n * 2 } });
        const c = cost(v, flags, s1, s2);
        const t0 = Date.now();
        const out = run(v, flags, s1);
        const ms = Date.now() - t0;
        const priced = c.steps === "inf" || c.steps > c.budget;
        const orderRight = v.order === null
            ? c.w1 === "inf"
            : typeof c.w1 === "number" && typeof c.w2 === "number" && Math.abs(Math.log2(c.w2 / c.w1) - v.order) < 0.1;
        const refusalRight = priced ? refused(out) : out.ran === true;
        const lag = LAG[v.name];
        if (lag && orderRight && refusalRight) assert.fail(`${v.name}: the shipped core now judges it right, so ${lag} shipped: delete its LAG line`);
        if (lag) { t.todo(`${lag} not in the shipped core (pin ${PIN.slice(0, 8)}): rebuild the core`); return; }
        if (v.order === null) {
            assert.equal(c.w1, "inf", `${v.name}: ${v.reason} — priced unbounded on its input, got ${JSON.stringify(c)}`);
        } else {
            assert.equal(typeof c.w1, "number", `${v.name}: a finite bound at n, got ${JSON.stringify(c)}`);
            assert.equal(typeof c.w2, "number", `${v.name}: a finite bound at 2n, got ${JSON.stringify(c)}`);
            const ratio = c.w2 / c.w1;
            assert.ok(Math.abs(Math.log2(ratio) - v.order) < 0.1,
                `${v.name}: /${v.pattern}/${v.flags} doubles to ${ratio.toFixed(3)}x, the corpus says order ${v.order} (${v.reason})`);
        }
        if (priced) {
            assert.ok(refused(out), `${v.name}: priced on its input (${c.steps} > ${c.budget}) and the cell ran: ${JSON.stringify(out)}`);
            assert.ok(ms < 1000, `${v.name}: refused before the search ran, in ${ms} ms — unpriced, its search is 0.7 s to 11 s on this core`);
        } else {
            assert.equal(out.ran, true, `${v.name}: under the budget on its input (${c.steps} ≤ ${c.budget}) and the cell was refused: ${JSON.stringify(out)}`);
        }
    });
}

test("every LAG line names a cost-corpus entry the Python side reads", (t) => {
    if (skip) return t.skip(skip);
    const names = new Set(regexCostVectors("py").map((v) => v.name));
    for (const n of Object.keys(LAG)) assert.ok(names.has(n), `LAG names "${n}", which is not a py or both cost entry`);
});

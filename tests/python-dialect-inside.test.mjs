// python-dialect-inside.test.mjs — a python_exec cell run INSIDE the read-only dialect, through the worker's own wrapper, on the real fork core.
//
// docs/spec/PYTHON_DIALECT.md, "Membership replaces `mode`": a cell runs unasked only under the fork's gate
// (`restricted.run_cell`), never on a verdict from its source alone. This drives `wrapUserSetup` + `wrapUserScript(…,
// inside)` exactly as python-worker.ts does, against dist/pyodide/. Self-SKIPS without it, and on the stock core (no
// `_restricted`): `npm run fetch-pyodide` with tools/pyodide-dist.json's artefact. Written by the lane 3 generalist.
import { test, before } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { wrapUserSetup, wrapUserScript } from "../src/python/python-runtime.ts";
import { dialectSetup } from "../src/python/python-dialect-run.js";
import { pythonCellInDialect, pythonOutsideWhy } from "../src/agent/python-dialect.ts";
import { GENRES, loadVectors } from "./dialect-vectors.mjs";

const PYODIDE_DIR = path.resolve(import.meta.dirname, "../dist/pyodide");
const DATA_DIR = path.resolve(import.meta.dirname, "../notebooks/python-dialect/data");
const FILES = Object.fromEntries(["whitelist.json", "manifest-stdlib.json", "manifest-numpy.json", "manifest-pandas.json", "manifest-pil.json"]
    .map((f) => [f, fs.readFileSync(path.join(DATA_DIR, f), "utf8")]));
const NODES = JSON.parse(FILES["whitelist.json"]).nodes;
const hasPyodide = fs.existsSync(path.join(PYODIDE_DIR, "pyodide.mjs"));

let py = null;
let stockCore = false;
let skip = hasPyodide ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";

// The vectors' worlds (run_vectors.py's `_world`), bound into a fresh namespace dict.
const WORLDS = `
def _ml_test_world(env):
    import io, sys, base64, contextlib
    if env == "none": return {}
    if env == "table":
        import numpy as np, pandas as pd
        return {"df": pd.DataFrame({"a": [1, 2, 3, 4], "b": [5, 6, 7, 8], "c": [9, 10, 11, 12]}),
                "pd": pd, "np": np, "io": io, "base64": base64, "sys": sys, "contextlib": contextlib}
    if env == "warm":
        class Box: pass
        box = Box(); box.secret = 1
        def peek(o): return o.secret
        def peek_ok(xs): return len(xs)
        def peek_cold(o): return o.secret
        def via_python(f): return lambda x: f(x)
        for _ in range(10_000):
            peek(box); peek_ok([1, 2, 3])
        return {"Box": Box, "box": box, "peek": peek, "peek_ok": peek_ok, "peek_cold": peek_cold, "via_python": via_python}
    return None

def _ml_test_snapshot(ns):
    import copy
    out = {}
    for k, v in ns.items():
        if k.startswith("_") or k == "result": continue
        try: out[k] = ("plain", copy.deepcopy(v)) if isinstance(v, (type(None), bool, int, float, str, list, dict, tuple, set)) else ("id", id(v))
        except Exception: out[k] = ("id", id(v))
    return out
`;

before(async () => {
    if (!hasPyodide) return;
    const { loadPyodide } = await import(path.join(PYODIDE_DIR, "pyodide.mjs"));
    py = await loadPyodide({ indexURL: PYODIDE_DIR });
    if (py.runPython(`import importlib.util; importlib.util.find_spec("_restricted") is None`)) { stockCore = true; skip = "dist/pyodide is the stock core, not the restricted-mode fork"; return; }
    await py.loadPackage(["numpy", "pandas", "pillow"]);
    py.runPython(WORLDS);
}, { timeout: 240000 });

/** A fresh namespace dict holding a vector's world. */
function world(env) {
    const ns = py.globals.get("_ml_test_world")(env);
    return ns ? py.globals.get("dict")(ns) : null;
}

/** One cell in `ns`, as the worker runs it: the setup, then the cell inside the dialect (or on the full path).
 *  `before` is the namespace between the two, which is what the cell itself could change. */
async function cell(ns, code, inside = true) {
    await py.runPythonAsync(wrapUserSetup(false, "run"), { globals: ns });
    const before = snapshot(ns);
    await py.runPythonAsync(wrapUserScript(code, "run", inside ? { nodes: NODES } : null), { globals: ns });
    const refused = inside ? ns.get("_ml_not_in_dialect") : undefined;
    if (refused) return { refused: String(refused), before };
    const err = ns.get("_err");
    if (err) return { error: String(err) };
    const jr = ns.get("_json_result");
    let value; try { value = JSON.parse(jr); } catch { value = jr; }
    return { value, stdout: String(ns.get("_stdout") ?? ""), before };
}

/** The names a namespace holds that a cell could have bound, each by value or identity. */
const snapshot = (ns) => JSON.stringify(py.globals.get("_ml_test_snapshot")(ns).toJs({ dict_converter: Object.fromEntries }), (_, v) => typeof v === "bigint" ? String(v) : v);

// --- under CI a fetched fork core must be the one shipped: a skip must not pass for a run ---

test("under CI, a job that fetched the fork core ships it in dist/pyodide", (t) => {
    const fetched = fs.existsSync(path.resolve(import.meta.dirname, "../pyodide-core/.pin"));
    if (!process.env.CI || !fetched) return t.skip("only under CI, in a job that ran `npm run fetch-pyodide` with an artefact pinned");
    assert.ok(hasPyodide && !stockCore, `the inside tests would be skipped: ${skip}`);
});

// --- the allow tables load once, and only on the fork's build ---

test("the fork core is ready for inside runs: dialectSetup answers \"\"", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    assert.strictEqual(await py.runPythonAsync(dialectSetup(FILES)), "");
});

/** dialectSetup's answer with `patch` applied to the interpreter first and `unpatch` after, whatever happens. */
async function setupUnder(patch, unpatch) {
    py.runPython(patch);
    try { return String(await py.runPythonAsync(dialectSetup(FILES))); } finally { py.runPython(unpatch); }
}

test("FAIL CLOSED: a core without the fork's modules gives a reason, so the cell asks", async (t) => {
    if (skip) return t.skip(skip);
    const r = await setupUnder(`
import importlib.util as _u
_ml_real_find = _u.find_spec
_u.find_spec = lambda name, *a: None if name in ("_restricted", "restricted") else _ml_real_find(name, *a)`,
    "import importlib.util as _u\n_u.find_spec = _ml_real_find");
    assert.match(r, /no membership predicate/);
});

test("FAIL CLOSED: a core that specializes gives a reason, so the cell asks", async (t) => {
    if (skip) return t.skip(skip);
    const r = await setupUnder(`
import _restricted
_ml_real_build = _restricted.build
_restricted.build = lambda: {"specialization": True, "specialization_ft": False, "tier2": False, "jit": False}`,
    "import _restricted\n_restricted.build = _ml_real_build");
    assert.match(r, /cannot be trusted/);
});

test("the sync seam never answers inside: a cell not run under the gate is outside", (t) => {
    for (const genre of GENRES) for (const v of loadVectors(genre)) if (v.py !== undefined) assert.strictEqual(pythonCellInDialect(v.py), false, v.name);
});

// --- every shared vector through the inside wrapper: refused ones ask and leave nothing, the rest give their value ---

const EXPECTED = { abuse: 43, halting: 20, failure: 5, ownership: 19, print: 0 };

for (const genre of GENRES) {
    const vecs = loadVectors(genre).filter((v) => v.py !== undefined);
    test(`${genre}: ${EXPECTED[genre]} vectors carry a py program`, () => assert.strictEqual(vecs.length, EXPECTED[genre]));
    for (const vec of vecs) {
        test(`inside: ${genre}: ${vec.name}`, { timeout: 60000 }, async (t) => {
            if (skip) return t.skip(skip);
            const ns = world(vec.env);
            if (!ns) return t.skip(`env ${vec.env} has no Python world`);
            if (vec.pre?.py) assert.ok(!(await cell(ns, vec.pre.py)).refused, "the vector's pre ran inside");
            const out = await cell(ns, vec.py);
            const before = out.before;
            if (vec.expect === "refused") {
                assert.ok(out.refused, `expected a refusal (the cell asks), got ${JSON.stringify(out)}`);
                assert.strictEqual(snapshot(ns), before, "a refused cell leaves the namespace as it was");
            } else if (vec.expect !== "halts") {
                assert.deepStrictEqual(out.value, vec.expect.value, JSON.stringify(out));
            }
            if (vec.leaves_nothing) assert.strictEqual(snapshot(ns), before, "leaves nothing");
        });
    }
}

// --- what the wrapper adds around run_cell ---

test("a bare trailing expression is the cell's value inside, as on the full path", async (t) => {
    if (skip) return t.skip(skip);
    const ns = world("none");
    assert.strictEqual((await cell(ns, "x = 2\nx * 21")).value, (await cell(world("none"), "x = 2\nx * 21", false)).value);
    assert.strictEqual((await cell(world("none"), "x = 2; x * 21")).value, 42);
    assert.strictEqual((await cell(world("none"), "s = 'é'; len(s) * 2")).value, 2, "a non-ASCII line splices at the right column");
});

test("a refusal AT RUN TIME names what and where: the module and the cell's line", async (t) => {
    if (skip) return t.skip(skip);
    const out = await cell(world("none"), "x = 1\nimport os\nreturn os.listdir('/')");
    assert.match(out.refused, /import 'os'/);
    assert.match(out.refused, /\(line 2\)/);
    assert.match(pythonOutsideWhy(out.refused).line, /^Outside the read-only Python dialect: import 'os' \(line 2\)$/);
});

test("a refusal AT CHECK time keeps the fork's own line", async (t) => {
    if (skip) return t.skip(skip);
    const out = await cell(world("none"), "x = 1\nwhile True:\n    pass");
    assert.match(out.refused, /While \(line 2\)/);
});

test("a refused cell's bindings and output are discarded: the namespace holds what it held", async (t) => {
    if (skip) return t.skip(skip);
    const ns = world("none");
    await cell(ns, "a = 1");
    const out = await cell(ns, "a = 2\nb = 3\nprint('partial')\nimport os");
    assert.ok(out.refused);
    assert.strictEqual((await cell(ns, "a")).value, 1);
    assert.match((await cell(ns, "b")).refused ?? (await cell(ns, "b")).error ?? "", /b/, "b was never bound");
});

test("a finished cell's bindings persist, but never a name the wrapper reads (a builtin, or one starting with _)", async (t) => {
    if (skip) return t.skip(skip);
    const ns = world("none");
    const out = await cell(ns, "y = 3\n_z = 4\nlen = 5\nreturn y");
    assert.strictEqual(out.value, 3);
    assert.strictEqual(ns.has("y"), true);
    assert.strictEqual(ns.has("_z"), false, "_z is not copied back");
    assert.strictEqual(ns.has("len"), false, "a builtin's name is not shadowed in the run's namespace");
    assert.strictEqual((await cell(ns, "return y + 1")).value, 4);
});

test("a cell's own function is never what the wrapper calls: one shadowing str stays in the cell", async (t) => {
    if (skip) return t.skip(skip);
    const ns = world("none");
    const out = await cell(ns, "def str(x):\n    return 'cell'\nreturn [1]");
    assert.deepStrictEqual(out.value, [1]);
    assert.strictEqual(ns.has("str"), false);
});

// --- what an inside run leaves behind is data, never code (PYTHON_DIALECT.md, #892) ---

test("DATA ONLY: a binding that reaches code, at any depth, puts the cell outside and leaves nothing", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    const cases = [
        ["def f():\n    return 1", /'f' holding a function or class it defined/],
        ["f = lambda: 1", /'f' holding a function or class it defined/],
        ["g = map(abs, [-1, 2])", /'g' holding a map/],
        ["f = open", /'f' holding a builtin it captured \(open\)/],
        ["xs = [1, [2, (3, open)]]", /'xs' holding a builtin it captured \(open\)/],
        ["d = {'k': {'f': lambda: 1}}", /'d' holding a function or class it defined/],
        ["d = {getattr: 1}", /'d' holding a builtin it captured \(getattr\)/],
        ["import pandas as pd\ndf = pd.DataFrame({'a': [1, open]})", /'df' holding a builtin it captured \(open\)/],
        ["import numpy as np\na = np.array([1, open], dtype=object)", /'a' holding a builtin it captured \(open\)/],
        ["return open", /the value it returns holding a builtin it captured \(open\)/],
        ["return [lambda: 1]", /the value it returns holding a function/],
    ];
    const gateFirst = [];
    for (const [code, re] of cases) {
        const ns = world("none");
        await cell(ns, "keep = 1");
        const out = await cell(ns, code);
        // A construct the dialect refuses on its own never reaches the copy-back; that is outside all the same.
        if (out.refused && !/^it leaves /.test(out.refused)) { gateFirst.push(`${code} -> ${out.refused}`); continue; }
        assert.match(String(out.refused), re, code);
        assert.match(pythonOutsideWhy(out.refused).line, /^Outside the read-only Python dialect: it leaves /, code);
        assert.strictEqual(snapshot(ns), out.before, `${code}: the namespace holds what it held`);
    }
    assert.deepStrictEqual(gateFirst, [], "every case reaches the copy-back");
    // Shapes the gate refuses before any copy-back (a class, `yield` or a bare generator expression, defaultdict, DataFrame.attrs):
    // outside all the same. If the dialect admits one later, it belongs in the list above.
    for (const code of ["class C:\n    pass", "g = (i for i in range(3))", "def _gen():\n    yield 1\ng = _gen()", "import collections\nd = collections.defaultdict(lambda: 0)",
                        "import pandas as pd\ndf = pd.DataFrame({'a': [1]})\ndf.attrs['f'] = open"]) {
        const out = await cell(world("none"), code);
        assert.ok(out.refused && !/^it leaves /.test(out.refused), `${code}: refused by the gate (${JSON.stringify(out)})`);
    }
});

test("DATA ONLY: plain data of every kind crosses back, and a value approved code bound passes by identity", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    const ns = world("none");
    await cell(ns, "def helper(x):\n    return x + 1\nimport math", false);
    const out = await cell(ns, [
        "import pandas as pd, numpy as np",
        "df = pd.DataFrame({'name': ['a', 'b'], 'n': [1, 2], 't': [None, 1.5]})",
        "s = df['name']",
        "a = np.array([1.0, 2.0]) * 1.5",
        "x = (np.sum(a), None, b'z', {1, 2}, 2.5, 'k')",
        "h = helper",
        "m = math",
        "return [len(df), s.tolist()]",
    ].join("\n"));
    assert.deepStrictEqual(out.value, [2, ["a", "b"]], JSON.stringify(out));
    for (const k of ["df", "s", "a", "x", "h", "m"]) assert.strictEqual(ns.has(k), true, `${k} crossed back`);
});

test("a try inside the dialect writes nothing to the real stdout; its print reaches the call only when it finished", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    const seen = [];
    py.setStdout({ batched: (s) => seen.push(s) });
    try {
        const ns = world("none");
        assert.ok((await cell(ns, "print('TRY')\nimport os")).refused);
        assert.strictEqual(String(ns.get("_stdout")), "", "a refused try's captured output is dropped");
        assert.strictEqual((await cell(world("none"), "print('DONE')\nreturn 1")).stdout, "DONE\n");
        assert.strictEqual((await cell(world("none"), "print('FULL')", false)).stdout, "FULL\n");
        assert.deepStrictEqual(seen, ["FULL"], "only the full path streams live");
    } finally { py.setStdout(); }
});

// --- the cost: one inside run against the same cell on the full path ---

test("COST: an inside cell against the full path, measured (reported, not asserted)", { timeout: 120000 }, async (t) => {
    if (skip) return t.skip(skip);
    const N = 50, code = "xs = [i * i for i in range(1000)]\nreturn sum(xs)";
    // Interleaved, one full and one inside per round, and the MEDIAN of each: a shared machine's load drifts over a
    // run, and a block of one then a block of the other charges that drift to whichever ran second.
    const nsFull = world("none"), nsIn = world("none");
    await cell(nsFull, code, false); await cell(nsIn, code, true);   // warm
    const full = [], inside = [];
    for (let i = 0; i < N; i++) {
        let t0 = performance.now(); await cell(nsFull, code, false); full.push(performance.now() - t0);
        t0 = performance.now(); await cell(nsIn, code, true); inside.push(performance.now() - t0);
    }
    const median = (xs) => xs.sort((a, b) => a - b)[xs.length >> 1];
    const f = median(full), n = median(inside);
    t.diagnostic(`per cell (median of ${N}, interleaved): full ${f.toFixed(2)} ms, inside ${n.toFixed(2)} ms, overhead ${(n - f).toFixed(2)} ms (${(n / f).toFixed(2)}x)`);
});

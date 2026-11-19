// redteam-python-dialect-buffer-args.test.mjs — an inside cell writes no file through a lifted leaf's buffer or path argument,
// by ANY route that reaches it (#1991): the method read off the class, a helper handed the method, the cell's own function body,
// a dunder, and every other lifted method whose signature has a sink parameter (the ratchet).
//
// Probes what the buffer check in src/python/python-dialect-run.ts (_ml_buffer_args, DIALECT_BUFFER_ARGS) is for, from the
// shapes its own rows do not take: a refusal the cell can see AND no file on disk is the pass. Self-SKIPS without the fork core
// in dist/pyodide, as python-dialect-buffer-args.test.mjs does.
import { test, before } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { wrapUserSetup, wrapUserScript } from "../src/python/python-runtime.ts";
import { dialectSetup, DIALECT_BUFFER_ARGS } from "../src/python/python-dialect-run.js";

const PYODIDE_DIR = path.resolve(import.meta.dirname, "../dist/pyodide");
const DATA_DIR = path.resolve(import.meta.dirname, "../notebooks/python-dialect/data");
const FILES = Object.fromEntries(["whitelist.json", "manifest-stdlib.json", "manifest-numpy.json", "manifest-pandas.json", "manifest-pil.json"]
    .map((f) => [f, fs.readFileSync(path.join(DATA_DIR, f), "utf8")]));
const NODES = JSON.parse(FILES["whitelist.json"]).nodes;
const hasPyodide = fs.existsSync(path.join(PYODIDE_DIR, "pyodide.mjs"));

const T = { timeout: 90000 };
let py = null;
let skip = hasPyodide ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";

before(async () => {
    if (!hasPyodide) return;
    const { loadPyodide } = await import(path.join(PYODIDE_DIR, "pyodide.mjs"));
    py = await loadPyodide({ indexURL: PYODIDE_DIR });
    if (py.runPython(`import importlib.util; importlib.util.find_spec("_restricted") is None`)) { skip = "dist/pyodide is the stock core, not the restricted-mode fork"; return; }
    await py.loadPackage(["numpy", "pandas", "pillow"]);
    assert.strictEqual(String(await py.runPythonAsync(dialectSetup(FILES))), "");
}, { timeout: 240000 });

/** One cell inside the dialect in a fresh namespace, as the worker runs it: refused (the host asks), an error, or its value. */
async function inside(code) {
    const ns = py.globals.get("dict")();
    await py.runPythonAsync(wrapUserSetup(false, "run"), { globals: ns });
    await py.runPythonAsync(wrapUserScript(code, "run", { nodes: NODES }), { globals: ns });
    const refused = ns.get("_ml_not_in_dialect");
    if (refused) return { refused: String(refused) };
    const err = ns.get("_err");
    if (err) return { error: String(err) };
    return { value: String(ns.get("_json_result")) };
}

/** Whether `p` exists in Pyodide's file system; removes it so the next row starts clean. */
function wrote(p) {
    const there = py.runPython(`import os; os.path.exists(${JSON.stringify(p)})`);
    if (there) py.runPython(`import os; os.remove(${JSON.stringify(p)})`);
    return there;
}

/** Runs `row`, then removes `paths` whatever happened, so one failing row leaves no file to red the rows after it. */
async function cleaning(paths, row) {
    try { return await row(); }
    finally { for (const p of paths) py.runPython(`import os\nif os.path.exists(${JSON.stringify(p)}): os.remove(${JSON.stringify(p)})`); }
}

const DF = `import pandas as pd\ndf = pd.DataFrame({"c": ["y"]})\n`;
const A_FILE = "/tmp/ml-rt-e4-buf.txt";

// --- RED TEAM (#1991): every route to the leaf asks, and the file the cell named stays absent ---

const ROUTES = [
    ["the class, positional", `${DF}pd.DataFrame.to_string(df, "${A_FILE}", header=False, index=False)`],
    ["the class, keyword", `${DF}pd.DataFrame.to_string(df, buf="${A_FILE}", header=False, index=False)`],
    ["the class, through * spreading", `${DF}pd.DataFrame.to_string(df, *["${A_FILE}"])`],
    ["the type object", `${DF}type(df).to_string(df, "${A_FILE}")`],
    ["the class __dict__", `${DF}pd.DataFrame.__dict__["to_string"](df, "${A_FILE}")`],
    ["getattr by name", `${DF}getattr(df, "to_string")("${A_FILE}")`],
    ["the unbound function off a bound method", `${DF}df.to_string.__func__(df, "${A_FILE}")`],
    ["the module's Series", `${DF}pd.Series.to_string(df["c"], "${A_FILE}")`],
    ["pipe handed the class method", `${DF}df.pipe(pd.DataFrame.to_string, buf="${A_FILE}")`],
    ["pipe handed the bound method", `${DF}df.pipe(df.to_string, buf="${A_FILE}")`],
    ["apply handed the class method", `${DF}df.apply(pd.DataFrame.to_string)`],
    ["agg handed a dict of class methods", `${DF}df.agg({"c": pd.Series.to_string})`],
    ["a cell lambda in apply", `${DF}df.apply(lambda s: s.to_string(buf="${A_FILE}", index=False))`],
    ["a cell lambda in map", `${DF}df["c"].map(lambda v: pd.DataFrame({"c": [v]}).to_string(buf="${A_FILE}"))`],
    ["a def'd function's own body", `${DF}def w():\n    pd.DataFrame({"c": ["z"]}).to_string(buf="${A_FILE}")\nw()`],
    ["an own **kw forwarder", `${DF}(lambda **kw: pd.DataFrame({"c": ["z"]}).to_string(**kw))(buf="${A_FILE}")`],
    ["a bound method kept, then called", `${DF}f = df.to_string\nf(buf="${A_FILE}")`],
    ["a copy's method", `${DF}df.copy().to_string(buf="${A_FILE}", index=False)`],
];

for (const [label, code] of ROUTES) {
    test(`RED TEAM (#1991): to_string reached ${label} asks, and writes nothing`, T, async (t) => {
        if (skip) return t.skip(skip);
        await cleaning([A_FILE], async () => {
            assert.strictEqual(wrote(A_FILE), false, "the target existed before the row: not a clean probe");
            const r = await inside(code);
            assert.ok(r.refused, `${label} was not refused: ${JSON.stringify(r)}`);
            assert.strictEqual(wrote(A_FILE), false, `${label} wrote ${A_FILE}`);
        });
    });
}

test("RED TEAM (#1991): positive control: the same call with no buf runs inside and returns the text", T, async (t) => {
    if (skip) return t.skip(skip);
    const r = await inside(`${DF}df.to_string(index=False)`);
    assert.ok(r.value && /y/.test(r.value), JSON.stringify(r));
});

test("RED TEAM (#1991): the original defect's target, site-packages, is refused from a cell's own function", T, async (t) => {
    if (skip) return t.skip(skip);
    const site = String(py.runPython(`import site; site.getsitepackages()[0]`)) + "/zz_ml_rt_e4_1991.py";
    await cleaning([site], async () => {
        const r = await inside(`${DF}def w():\n    df.to_string(buf=${JSON.stringify(site)}, header=False, index=False)\nw()`);
        assert.ok(r.refused, JSON.stringify(r));
        assert.strictEqual(wrote(site), false, `${site} was written`);
        // positive control: the same path IS writable from outside the dialect, so the refusal above is the gate's, not the filesystem's.
        py.runPython(`open(${JSON.stringify(site)}, "w").write("x")`);
        assert.strictEqual(wrote(site), true, "the test cannot write its own target: the probe proves nothing");
    });
});

// --- RED TEAM (#1991): the buffer check's precondition, the cell's own function, is checked too ---

test("RED TEAM (#1991): a cell's own function is entered through the gate, so a write inside its body asks", T, async (t) => {
    if (skip) return t.skip(skip);
    await cleaning([A_FILE], async () => {
        const r = await inside(`import pandas as pd\ndef w(s, p):\n    s.to_string(buf=p)\nw(pd.DataFrame({"c": ["y"]})["c"], "${A_FILE}")`);
        assert.match(r.refused ?? "", /to_string\(buf=…\) writes to the file or buffer it is given/, JSON.stringify(r));
        assert.strictEqual(wrote(A_FILE), false);
    });
});

// --- RED TEAM (#1991): the ratchet: every lifted method with a sink parameter is checked or has a reason ---

/** Parameter names that may take a path, a file or a buffer (the builder's set, plus numpy's `out`). */
const SINK_PARAMS = ["buf", "path", "file", "fname", "fp", "path_or_buf", "path_or_buffer", "excel_writer", "filename", "stream",
    "filepath_or_buffer", "filepath", "f", "io", "target", "dest", "fd", "out"];

/** Each lifted method with a sink parameter, and why it is not a file write (to_string's own rows are the other half). */
const REASONS = {
    "DataFrame.to_string": "in DIALECT_BUFFER_ARGS; the route rows above",
    "Series.to_string": "in DIALECT_BUFFER_ARGS; the route rows above",
    // A C method's out= is not in DIALECT_OUT_ARGS (that lists module functions, whose checker survives * and **); it
    // takes an ndarray, so a path raises TypeError, probed below. ndarray.round is no longer lifted (#1993, UNLISTED).
    "ndarray.any": "out= takes an ndarray, so a path raises TypeError (probed below)",
    "ndarray.max": "out= takes an ndarray, so a path raises TypeError (probed below)",
    "ndarray.mean": "out= takes an ndarray, so a path raises TypeError (probed below)",
    "ndarray.sum": "out= takes an ndarray, so a path raises TypeError (probed below)",
};

/** Every lifted method of a pandas or numpy kind whose signature has a sink parameter, by name, from the gate's own tables.
 *  The builder's enumeration reads kinds through a `C` map that has no `DataFrame` in it, so it never walks a kind's
 *  methods; this reads them through the gate's own `_kind_class`. Restores the setup afterwards. */
async function kindSinks() {
    const out = py.runPython(`
import inspect, json, restricted
done = restricted.load_manifests("/tmp/ml-dialect")
SINK = set(${JSON.stringify(SINK_PARAMS)})
res = {}
for mod in ("pandas", "numpy"):
    man = json.load(open("/tmp/ml-dialect/manifest-%s.json" % mod))
    for kind in man["kinds"]:
        cls = restricted._kind_class(mod, kind)
        if cls is None: continue
        for c in (cls if isinstance(cls, tuple) else (cls,)):
            for n in done["kinds"].get(mod + "." + kind, []):
                if n.startswith(("[", "__")): continue
                f = getattr(c, n, None)
                if not callable(f): continue
                try: ps = sorted({p.lstrip("_") for p in inspect.signature(f).parameters} & SINK)
                except (TypeError, ValueError): ps = None
                if ps: res[c.__name__ + "." + n] = ps
json.dumps(res)
`);
    assert.strictEqual(String(await py.runPythonAsync(dialectSetup(FILES))), "");
    return JSON.parse(String(out));
}

test("RED TEAM (#1991): no lifted method gained a buffer or path parameter without a probe or a reason", T, async (t) => {
    if (skip) return t.skip(skip);
    const sinks = await kindSinks();
    assert.ok(Object.keys(sinks).length > 0, "no kind method with a sink parameter was found: the enumeration is broken");
    assert.deepStrictEqual(Object.keys(sinks).sort(), Object.keys(REASONS).sort(),
        "a lifted method gained or lost a sink parameter: probe it, or give its reason");
    const listed = DIALECT_BUFFER_ARGS.map(([, kind, name]) => `${kind}.${name}`);
    assert.deepStrictEqual(listed.sort(), Object.keys(REASONS).filter((n) => REASONS[n].includes("DIALECT_BUFFER_ARGS")).sort());
    for (const name of Object.keys(sinks).filter((n) => n.startsWith("ndarray."))) {
        await cleaning([A_FILE], async () => {
            const r = await inside(`import numpy as np\na = np.array([1.4, 2.6])\na.${name.split(".")[1]}(out="${A_FILE}")`);
            assert.ok(r.refused || r.error, `${name} accepted a path as out=: ${JSON.stringify(r)}`);
            assert.strictEqual(wrote(A_FILE), false, `${name}(out=path) wrote ${A_FILE}`);
        });
    }
});

// python-dialect-library.test.mjs — a Tier 3 library (READONLY_LIBRARY_MANIFEST.md, "Generating and importing a manifest into the runtime") loaded into the dialect on the real fork core.
//
// Root K (c2): a pure-Python module the person approved is LOADED by running its body inside the dialect (`check`, then
// `mark(compile())`, then `_restricted.run`), admitted only when what it leaves can carry no state from one run to the
// next, and then importable by a cell under its listed names. Measured 2026-10-24 on the pinned core: an object made in
// the load run stays OWNED for the worker's life, so a module-level list or a mutable default would be written by later
// cells and remember across runs; the admission check refuses both. Self-SKIPS without dist/pyodide/ or on the stock core.
import { test, before } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { dialectSetup, libraryLoad, libraryShape } from "../src/python/python-dialect-run.js";

const PYODIDE_DIR = path.resolve(import.meta.dirname, "../dist/pyodide");
const DATA_DIR = path.resolve(import.meta.dirname, "../notebooks/python-dialect/data");
const FILES = Object.fromEntries(["whitelist.json", "manifest-stdlib.json", "manifest-numpy.json", "manifest-pandas.json", "manifest-pil.json"]
    .map((f) => [f, fs.readFileSync(path.join(DATA_DIR, f), "utf8")]));
const NODES = JSON.parse(FILES["whitelist.json"]).nodes;
/** What the worker reserves: the dialect's modules and every import name in the Pyodide lock. */
const reservedNames = () => [...JSON.parse(FILES["whitelist.json"]).modules,
    ...Object.values(JSON.parse(fs.readFileSync(path.join(PYODIDE_DIR, "pyodide-lock.json"), "utf8")).packages).flatMap((p) => p.imports ?? [])];
const hasPyodide = fs.existsSync(path.join(PYODIDE_DIR, "pyodide.mjs"));

let py = null;
let skip = hasPyodide ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";

before(async () => {
    if (!hasPyodide) return;
    const { loadPyodide } = await import(path.join(PYODIDE_DIR, "pyodide.mjs"));
    py = await loadPyodide({ indexURL: PYODIDE_DIR });
    if (py.runPython(`import importlib.util; importlib.util.find_spec("_restricted") is None`)) { skip = "dist/pyodide is the stock core, not the restricted-mode fork"; return; }
    assert.strictEqual(await py.runPythonAsync(dialectSetup(FILES)), "");
}, { timeout: 240000 });

const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
/** A library as the worker is handed it: pinned to its source's sha256. */
const lib = (name, source, names, pin = sha(source)) => ({ name, source, sha256: pin, names });
/** Load libraries; the reason each was refused, "" when loaded. */
async function load(...libs) {
    return Object.fromEntries(JSON.parse(await py.runPythonAsync(libraryLoad(libs, NODES, reservedNames()))).map((r) => [r.name, r.why]));
}
/** A cell inside the dialect, as `run_cell` runs it: its value, or the refusal. */
function cell(src) {
    return JSON.parse(py.runPython(`
import json, restricted
try:
    _v = restricted.run_cell(${JSON.stringify(src)}, {}, budget=200000)
    _out = {"value": _v}
except BaseException as _e:
    _out = {"refused": type(_e).__name__ + ": " + str(_e)}
json.dumps(_out, default=repr)
`));
}

const STATS = `
import math
SCALE = 2
NAMES = ("a", "b")
def total(xs):
    s = 0
    for x in xs:
        s += x
    return s
def mean(xs, ndigits=None):
    return round(total(xs) / len(xs), ndigits) if ndigits is not None else total(xs) / len(xs)
def root(x):
    return math.sqrt(x)
def spin(n):
    s = 0
    for i in range(n):
        for j in range(n):
            s += 1
    return s
`;

// --- loading a library: what it may leave behind ---

test("an admitted library is importable by a cell under its listed names, and its functions run gated", async (t) => {
    if (skip) return t.skip(skip);
    assert.deepStrictEqual(await load(lib("stats_a", STATS, ["total", "mean", "root", "spin", "SCALE"])), { stats_a: "" });
    assert.deepStrictEqual(cell("import stats_a\nreturn stats_a.total([1, 2, 3])"), { value: 6 });
    assert.deepStrictEqual(cell("from stats_a import mean\nreturn mean([1, 2])"), { value: 1.5 });
    assert.deepStrictEqual(cell("import stats_a\nreturn stats_a.SCALE"), { value: 2 });
    // Gated inside its body exactly as a cell is: tier 3 trusts no annotation. The stdlib manifest admits math.fsum only,
    // and the cell's step budget covers the library's loops.
    assert.match(cell("import stats_a\nreturn stats_a.root(9)").refused, /NotInDialect.*sqrt/);
    assert.match(cell("import stats_a\nreturn stats_a.spin(1000)").refused, /NotInDialect.*step budget/);
    assert.deepStrictEqual(cell("import stats_a\nreturn stats_a.spin(10)"), { value: 100 });
    // An unlisted name is not readable, though the module has it.
    assert.match(cell("import stats_a\nreturn stats_a.NAMES").refused, /NotInDialect.*NAMES/);
});

test("a library whose source does not match its pin is not loaded", async (t) => {
    if (skip) return t.skip(skip);
    const r = await load(lib("stats_b", STATS, ["total"], sha(STATS + "\n")));
    assert.match(r.stats_b, /sha256/);
    assert.match(cell("import stats_b\nreturn 1").refused, /NotInDialect.*import 'stats_b'/);
});

test("a library body outside the dialect is not loaded: an import, a loop, a class, a dunder, a file", async (t) => {
    if (skip) return t.skip(skip);
    const bodies = {
        bad_os: "import os\nX = os.getcwd()",
        bad_while: "def f():\n    while True:\n        pass",
        bad_class: "class A:\n    pass",
        bad_dunder: "def f(o):\n    return o.__class__",
        bad_open: "X = open('/dev/null')",
        bad_global: "N = 0\ndef bump():\n    global N\n    N += 1\n    return N",
    };
    const r = await load(...Object.entries(bodies).map(([n, s]) => lib(n, s, [])));
    for (const n of Object.keys(bodies)) {
        assert.match(r[n], /not in dialect/, `${n}: ${r[n]}`);
        assert.match(cell(`import ${n}\nreturn 1`).refused, new RegExp(`import '${n}'`));
    }
});

test("a library that would keep state across runs is not loaded: a mutable global, a mutable default", async (t) => {
    if (skip) return t.skip(skip);
    const r = await load(
        lib("keep_list", "CACHE = []\ndef remember(x):\n    CACHE.append(x)\n    return len(CACHE)", ["remember"]),
        lib("keep_default", "def keep(x, acc=[]):\n    acc.append(x)\n    return acc", ["keep"]),
        lib("keep_kwdefault", "def keep(x, *, acc={}):\n    acc[x] = 1\n    return acc", ["keep"]),
        lib("keep_nested", "T = (1, [2])", []),
    );
    assert.match(r.keep_list, /CACHE/);
    assert.match(r.keep_default, /keep/);
    assert.match(r.keep_kwdefault, /keep/);
    assert.match(r.keep_nested, /'T'/);
});

test("a library cannot take a name that already imports: a stdlib module, a dialect module, a dotted name", async (t) => {
    if (skip) return t.skip(skip);
    const r = await load(lib("json", "X = 1", []), lib("os", "X = 1", []), lib("numpy", "X = 1", []), lib("a.b", "X = 1", []), lib("__init__", "X = 1", []));
    for (const n of ["json", "os", "numpy", "a.b", "__init__"]) assert.notStrictEqual(r[n], "", n);
    assert.deepStrictEqual(py.runPython(`import sys, json; sys.modules["json"] is json and hasattr(json, "dumps")`), true);
});

test("a listed name that is not a function or a constant is refused, and a dunder name never listed", async (t) => {
    if (skip) return t.skip(skip);
    const r = await load(lib("names_a", "import math\ndef f():\n    return 1", ["math"]), lib("names_b", "def f():\n    return 1", ["__dict__"]), lib("names_c", "def f():\n    return 1", ["g"]));
    assert.match(r.names_a, /math/);
    assert.match(r.names_b, /__dict__/);
    assert.match(r.names_c, /'g'/);
});

test("loading the same pin again is a no-op; the library's functions run only inside a run", async (t) => {
    if (skip) return t.skip(skip);
    assert.deepStrictEqual(await load(lib("stats_a", STATS, ["total", "mean", "root", "spin", "SCALE"])), { stats_a: "" });
    const outside = py.runPython(`
import sys
try:
    sys.modules["stats_a"].total([1])
    _r = "ran"
except BaseException as _e:
    _r = type(_e).__name__
_r
`);
    assert.strictEqual(outside, "NotInDialect");
});

// --- the card's shape rule: derived from the source alone, nothing runs (the coordinator's ruling B, 2026-10-24) ---

/** The shape rule's verdict on `source` as `name`. */
async function shape(name, source) {
    return JSON.parse(await py.runPythonAsync(libraryShape(name, source, NODES, reservedNames())));
}

test("the shape rule admits a docstring, admitted imports, defs with literal defaults and literal constants, and lists signatures", async (t) => {
    if (skip) return t.skip(skip);
    const s = await shape("shape_ok", `"""Stats."""\nimport math\nfrom math import fsum\nSCALE = 2\nNEG = -1.5\nPAIR = ("a", (1, b"x"))\ndef total(xs, start=0, *, label=None):\n    return sum(xs) + start\ndef scaled(xs):\n    return [x * SCALE for x in xs]\n`);
    assert.deepStrictEqual(s, { why: "", defs: [{ name: "total", signature: "xs, start=0, *, label=None" }, { name: "scaled", signature: "xs" }], constants: ["SCALE", "NEG", "PAIR"] });
});

test("the shape rule refuses, with the line, every top-level statement that would make state or run code at load", async (t) => {
    if (skip) return t.skip(skip);
    const cases = {
        "X = []": 1, "X = {}": 1, "X = {1}": 1, "X = (1, [2])": 1, "X = len('a')": 1, "X = Y = ()": 0,
        "def f(acc=[]):\n    return acc": 1, "def f(*, acc={}):\n    return acc": 1, "def f(n=len):\n    return n": 1,
        "for i in range(3):\n    pass": 1, "x = [i for i in range(3)]": 1, "print(1)": 1, "if True:\n    X = 1": 1,
        "import os": 1, "import os.path": 1, "from os import path": 1, "from . import x": 1, "from statistics import median": 1, "from math import sqrt": 1,
        "\"\"\"doc\"\"\"\nX = 1\nY = X": 3, "X: int": 1, "X: int = 3": 1, "f = lambda x: x": 1, "assert True": 1, "X = 1\nX += 1": 2,
    };
    for (const [src, line] of Object.entries(cases)) {
        const s = await shape("shape_bad", src);
        assert.notStrictEqual(s.why, "", src);
        if (line) assert.match(s.why, new RegExp(`line ${line}\\b`), `${src}: ${s.why}`);
    }
});

test("the shape rule refuses a source outside the whitelist, a decorator, and a name that imports or is not plain", async (t) => {
    if (skip) return t.skip(skip);
    assert.match((await shape("shape_w", "def f():\n    while True:\n        pass")).why, /While/);
    assert.match((await shape("shape_d", "def f(o):\n    return o.__class__")).why, /__class__/);
    assert.match((await shape("shape_dec", "def deco(f):\n    return f\n@deco\ndef g():\n    return 1")).why, /line 3.*decorat/);
    for (const n of ["json", "numpy", "scipy", "a.b", "_private", "class", ""]) assert.notStrictEqual((await shape(n, "X = 1")).why, "", n);
});

// Every top-level form the shape rule admits, one module each: the load must admit each too, or the card promised a
// library the approval cannot deliver (the ruling names that disagreement a same-day finding).
const ADMITTED_SHAPES = [
    `"""Only a docstring."""`,
    "import math", "import math, statistics", "from math import fsum", "from re import compile as rc",
    "X = 1", "X = -1", "X = +2.5", "X = 1j", "X = None", "X = True", "X = 'a'", "X = b'a'", "X = ()", "X = (1, ('a', b'b', None))",
    "def f():\n    return 1", "def f(a, b=1, *c, d=(), e=-1, **g):\n    return a", "def f(*, k=None):\n    return k",
    "def f(xs):\n    def g(x):\n        return x + 1\n    return [g(x) for x in xs]",
    `"""Doc."""\nimport math\nSCALE = 2\nPAIR = ("a", (1, b"x"))\ndef total(xs, start=0, *, label=None):\n    return sum(xs) + start\n`,
];

test("whatever the shape rule admits, the load admits too: the enforce layer agrees on every admitted form", async (t) => {
    if (skip) return t.skip(skip);
    for (const [i, src] of ADMITTED_SHAPES.entries()) {
        const name = `agree_${i}`;
        const s = await shape(name, src);
        assert.strictEqual(s.why, "", src);
        const names = [...s.defs.map((d) => d.name), ...s.constants];
        assert.deepStrictEqual(await load(lib(name, src, names)), { [name]: "" }, src);
    }
});

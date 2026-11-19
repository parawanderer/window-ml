// python-dialect-out-args.test.mjs — an inside cell never writes an array it does not own through an `out=` argument.
//
// The ownership check refuses `b[0] = 1` and `b += 1` on a value the cell did not make, but a leaf that takes `out`
// writes into it from C, where the gate sees nothing: `a.round(out=b)` (ndarray.round runs unlifted) and
// `np.sum(m, axis=0, out=b)` (lifted, no checker on out) both wrote an injected array unasked. Each admitted leaf that
// takes `out` is in DIALECT_OUT_ARGS, and the call asks with `out` bound to anything but None. This file enumerates
// every admitted callable taking `out` (by signature or docstring) and every admitted ufunc, and keeps every other write
// path that was probed as a row. Self-SKIPS without the fork core in dist/pyodide, as python-dialect-inside.test.mjs does.
import { test, before } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { wrapUserSetup, wrapUserScript } from "../src/python/python-runtime.ts";
import { dialectSetup, DIALECT_OUT_ARGS } from "../src/python/python-dialect-run.js";

const PYODIDE_DIR = path.resolve(import.meta.dirname, "../dist/pyodide");
const DATA_DIR = path.resolve(import.meta.dirname, "../notebooks/python-dialect/data");
const FILES = Object.fromEntries(["whitelist.json", "manifest-stdlib.json", "manifest-numpy.json", "manifest-pandas.json", "manifest-pil.json"]
    .map((f) => [f, fs.readFileSync(path.join(DATA_DIR, f), "utf8")]));
const NODES = JSON.parse(FILES["whitelist.json"]).nodes;
const hasPyodide = fs.existsSync(path.join(PYODIDE_DIR, "pyodide.mjs"));

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

/** One cell inside the dialect, in a namespace holding `b` (an ndarray), `df` and `img` the cell did NOT make: refused,
 *  an error, or its value, and what `b`, `df` and `img` hold afterwards. */
async function inside(code) {
    const ns = py.globals.get("dict")();
    py.runPython(`import numpy as np, pandas as pd\nfrom PIL import Image\nb = np.array([9., 9.])\ndf = pd.DataFrame({"c": [9., 9.]})\nimg = Image.new("RGB", (2, 2))`, { globals: ns });
    await py.runPythonAsync(wrapUserSetup(false, "run"), { globals: ns });
    await py.runPythonAsync(wrapUserScript(code, "run", { nodes: NODES }), { globals: ns });
    const after = String(py.runPython(`repr((b.tolist(), df["c"].tolist(), img.getpixel((0, 0))))`, { globals: ns }));
    const refused = ns.get("_ml_not_in_dialect");
    if (refused) return { refused: String(refused), after };
    const err = ns.get("_err");
    if (err) return { error: String(err), after };
    return { value: String(ns.get("_json_result")), after };
}

const UNTOUCHED = "([9.0, 9.0], [9.0, 9.0], (0, 0, 0))";

// --- out= writes into what it is given: it asks, by every way of binding out ---

const M = `np.array([[1., 2.], [3., 4.]])`;
const OUT_ROWS = [
    ["numpy.sum, out=", `import numpy as np\nnp.sum(${M}, axis=0, out=b)`],
    ["numpy.sum, out positional", `import numpy as np\nnp.sum(${M}, 0, None, b)`],
    ["numpy.sum, out through **", `import numpy as np\nk = {"axis": 0, "out": b}\nnp.sum(${M}, **k)`],
    ["numpy.mean, out=", `import numpy as np\nnp.mean(${M}, axis=0, out=b)`],
    ["numpy.mean, out positional", `import numpy as np\nnp.mean(${M}, 0, None, b)`],
    ["numpy.mean, out through *", `import numpy as np\na = [${M}, 0, None, b]\nnp.mean(*a)`],
    ["numpy.any, out=", `import numpy as np\nnp.any(${M} > 2, axis=0, out=b)`],
    ["numpy.any, out through **", `import numpy as np\nk = {"axis": 0, "out": b}\nnp.any(${M} > 2, **k)`],
    ["numpy.abs, out=", `import numpy as np\nnp.abs(np.array([-1., -2.]), out=b)`],
    ["numpy.abs, out positional", `import numpy as np\nnp.abs(np.array([-1., -2.]), b)`],
    ["numpy.abs, out as a tuple", `import numpy as np\nnp.abs(np.array([-1., -2.]), out=(b,))`],
    ["numpy.abs, out through *", `import numpy as np\na = [np.array([-1., -2.]), b]\nnp.abs(*a)`],
];

for (const [label, code] of OUT_ROWS) {
    test(`out= ASKS and writes nothing: ${label}`, { timeout: 60000 }, async (t) => {
        if (skip) return t.skip(skip);
        const r = await inside(code);
        assert.match(r.refused ?? "", /\(out=…\) writes into the array it is given/, JSON.stringify(r));
        assert.strictEqual(r.after, UNTOUCHED);
    });
}

test("with no out, or out=None, each still runs inside and gives its value", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    for (const [code, want] of [[`import numpy as np\nnp.sum(${M}, axis=0).tolist()`, "[4.0, 6.0]"], [`import numpy as np\nfloat(np.sum(${M}, out=None))`, "10.0"],
        [`import numpy as np\nnp.mean(${M}, axis=0).tolist()`, "[2.0, 3.0]"], [`import numpy as np\nbool(np.any(${M} > 3))`, "true"],
        [`import numpy as np\nnp.abs(np.array([-1., -2.])).tolist()`, "[1.0, 2.0]"]]) {
        const r = await inside(code);
        assert.strictEqual(r.value, want, `${code}: ${JSON.stringify(r)}`);
    }
});

// --- ndarray.round is not listed: a checker on a C method does not survive * or ** (make-corpus-count.py, UNLISTED) ---

const ROUND_ROWS = [
    ["a.round(out=b)", `import numpy as np\nnp.array([1.4, 2.6]).round(out=b)`],
    ["a.round(0, b)", `import numpy as np\nnp.array([1.4, 2.6]).round(0, b)`],
    ["a.round(**{\"out\": b})", `import numpy as np\nk = {"out": b}\nnp.array([1.4, 2.6]).round(**k)`],
    ["a.round(*[0, b])", `import numpy as np\na = [0, b]\nnp.array([1.4, 2.6]).round(*a)`],
    ["a.round(), no out", `import numpy as np\nnp.array([1.4, 2.6]).round().tolist()`],
    ["np.round, not an admitted module name", `import numpy as np\nk = {"out": b}\nnp.round(np.array([1.4, 2.6]), **k)`],
    ["np.around, not an admitted module name", `import numpy as np\na = [np.array([1.4, 2.6]), 0, b]\nnp.around(*a)`],
];

for (const [label, code] of ROUND_ROWS) {
    test(`round ASKS in every form, so its spread call cannot write: ${label}`, { timeout: 60000 }, async (t) => {
        if (skip) return t.skip(skip);
        const r = await inside(code);
        assert.match(r.refused ?? "", /attribute '(round|around)' of (numpy\.ndarray|module)/, JSON.stringify(r));
        assert.strictEqual(r.after, UNTOUCHED);
    });
}

// --- every other write path into an unowned value that was probed: each refused, or harmless ---

const WRITE_PATHS = [
    ...["+=", "-=", "*=", "/=", "**=", "//=", "%="].map((op) => [`b ${op} 2`, `b ${op} 2`]),
    ["np.add.at(b, …)", `import numpy as np\nnp.add.at(b, [0], 1)`], ["np.add.reduce(m, out=b)", `import numpy as np\nnp.add.reduce(${M}, axis=0, out=b)`],
    ["np.add.accumulate(x, out=b)", `import numpy as np\nnp.add.accumulate(np.array([1., 2.]), out=b)`], ["np.add.outer", `import numpy as np\nnp.add.outer(b, b)`],
    ["np.abs.at(b, …)", `import numpy as np\nnp.abs.at(b, [0])`], ["np.abs.reduce", `import numpy as np\nnp.abs.reduce(b)`],
    ["np.abs.accumulate(x, out=b)", `import numpy as np\nnp.abs.accumulate(b, out=b)`],
    ["np.copyto", `import numpy as np\nnp.copyto(b, np.array([1., 2.]))`], ["np.put", `import numpy as np\nnp.put(b, [0], 1.)`],
    ["np.place", `import numpy as np\nnp.place(b, b > 0, [1.])`], ["np.fill_diagonal", `import numpy as np\nnp.fill_diagonal(b, 1.)`],
    ["b.sort()", `b.sort()`], ["b.fill()", `b.fill(1.)`], ["b.resize()", `b.resize(3)`], ["b.partition()", `b.partition(0)`],
    ["b.itemset()", `b.itemset(0, 1.)`], ["b.setflags()", `b.setflags(write=True)`],
    ["np.asarray(b)[0] = …", `import numpy as np\nv = np.asarray(b)\nv[0] = 1.`], ["b.reshape(-1)[0] = …", `v = b.reshape(-1)\nv[0] = 1.`],
    ["b.ravel()[0] = …", `v = b.ravel()\nv[0] = 1.`], ["b.T[0] = …", `v = b.T\nv[0] = 1.`], ["b.view()[0] = …", `v = b.view()\nv[0] = 1.`],
    ["b[:][0] = …", `v = b[:]\nv[0] = 1.`], ["np.squeeze(b)[0] = …", `import numpy as np\nv = np.squeeze(b)\nv[0] = 1.`],
    ["np.where(…, b) then write", `import numpy as np\nv = np.where(b > 0, b, b)\nv[0] = 1.`],
    ["pandas: df.astype(copy=False), then a write", `v = df.astype(float, copy=False)\nv["c"] = 1.`],
    ["pandas: df.to_numpy(), then a write", `v = df.to_numpy()\nv[0, 0] = 1.`], ["pandas: df.values, then a write", `v = df.values\nv[0, 0] = 1.`],
    ["pandas: df['c'].to_numpy(), then a write", `v = df["c"].to_numpy()\nv[0] = 1.`], ["pandas: df['c'][0] = …", `s = df["c"]\ns[0] = 1.`],
    ["Pillow: img.paste", `img.paste((1, 2, 3), (0, 0, 1, 1))`], ["Pillow: img.putpixel", `img.putpixel((0, 0), (1, 2, 3))`],
    ["Pillow: img.load()[…] = …", `px = img.load()\npx[0, 0] = (1, 2, 3)`],
];

for (const [label, code] of WRITE_PATHS) {
    test(`a write into an unowned value is refused: ${label}`, { timeout: 60000 }, async (t) => {
        if (skip) return t.skip(skip);
        const r = await inside(code);
        assert.ok(r.refused, JSON.stringify(r));
        assert.strictEqual(r.after, UNTOUCHED);
    });
}

test("pandas: a shallow copy is the cell's own under copy-on-write; writing it leaves the frame it copied untouched", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    const r = await inside(`v = df.copy(deep=False)\nv["c"] = 1.`);
    assert.strictEqual(r.after, UNTOUCHED, JSON.stringify(r));
});

// --- ENUMERATED: every admitted callable taking out, and every admitted ufunc, is in DIALECT_OUT_ARGS or has a reason ---

/** Admitted leaves taking `out` that are NOT callable inside today: each with the reason and a row showing `b` is untouched. */
const OUT_ELSEWHERE = {
    "ndarray.any": "a C method never lifted, so it errors inside today (KeyError '__builtins__'); the descriptor PR lifts it with this check",
    "ndarray.max": "the same", "ndarray.mean": "the same", "ndarray.sum": "the same",
};

/** Every admitted callable (all four manifests' tables and the builtins) whose signature, or failing that its docstring's
 *  first paragraph, takes `out`, and every admitted ufunc, by name. Restores the setup afterwards. */
async function takesOut() {
    const out = py.runPython(`
import inspect, importlib, json, builtins, re, numpy, restricted
done = restricted.load_manifests("/tmp/ml-dialect")
C = {"str": str, "list": list, "dict": dict, "set": set, "tuple": tuple, "int": int, "float": float}
def resolve(mod, dotted):
    o = mod
    for part in dotted.split("."):
        if hasattr(o, part): o = getattr(o, part)
        elif inspect.ismodule(o): o = importlib.import_module(o.__name__ + "." + part)
        else: return None
    return o
items = [("builtins." + n, getattr(builtins, n)) for n in done["calls"]]
for m, names in done["modules"].items():
    mod = importlib.import_module(m)
    items += [(m + "." + n, resolve(mod, n)) for n in names]
for k, names in done["kinds"].items():
    cls = C.get(k) or (restricted._kind_class(*k.split(".")) if "." in k else None)
    for c in (cls if isinstance(cls, tuple) else (cls,)):
        items += [(k.split(".")[-1] + "." + n, inspect.getattr_static(c, n, None)) for n in names if not n.startswith(("[", "__"))]
hits = set()
for name, o in items:
    if o is None or inspect.ismodule(o) or isinstance(o, property): continue
    if isinstance(o, numpy.ufunc): hits.add(name); continue
    try: ps = list(inspect.signature(o).parameters)
    except (TypeError, ValueError): ps = None
    doc = (getattr(o, "__doc__", "") or "").split("\\n\\n")[0]
    if (ps is not None and "out" in ps) or (ps is None and re.search(r"\\bout\\b", doc)): hits.add(name)
json.dumps(sorted(hits))
`);
    assert.strictEqual(String(await py.runPythonAsync(dialectSetup(FILES))), "");
    return JSON.parse(String(out));
}

const listed = () => DIALECT_OUT_ARGS.map(([mod, name]) => `${mod}.${name}`);

test("ENUMERATED: every admitted callable taking out, and every admitted ufunc, is checked or has a reason; none is new", { timeout: 120000 }, async (t) => {
    if (skip) return t.skip(skip);
    const found = await takesOut();
    assert.deepStrictEqual(found, [...listed(), ...Object.keys(OUT_ELSEWHERE)].sort(), "an admitted callable takes out: add it to DIALECT_OUT_ARGS, or give its reason");
    for (const name of Object.keys(OUT_ELSEWHERE)) {
        const m = name.split(".")[1];
        for (const code of [`np.array([[1., 2.], [3., 4.]]).${m}(axis=0, out=b)`, `k = {"axis": 0, "out": b}\nnp.array([[1., 2.], [3., 4.]]).${m}(**k)`,
            `a = [0, b] if "${m}" in ("any", "max") else [0, None, b]\nnp.array([[1., 2.], [3., 4.]]).${m}(*a)`]) {
            const r = await inside(`import numpy as np\n${code}`);
            assert.ok(r.error && !r.value, `${name}: an error, before any write: ${JSON.stringify(r)}`);
            assert.strictEqual(r.after, UNTOUCHED, `${name}: ${code}: ${JSON.stringify(r)}`);
        }
    }
});

// --- the interim rule: a listed C method takes no argument that can write, since no checker on it survives * or ** ---

/** Argument names that can write: into an array (out) or a file or buffer (the to_string family). */
const WRITE_CAPABLE = ["out", "buf", "path", "file", "fname", "fp", "path_or_buf", "path_or_buffer", "filename", "stream", "filepath_or_buffer"];

test("ENUMERATED: no admitted C method takes an argument that can write, but those shown to error before writing", { timeout: 120000 }, async (t) => {
    if (skip) return t.skip(skip);
    const out = py.runPython(`
import inspect, json, restricted
done = restricted.load_manifests("/tmp/ml-dialect")
W = set(${JSON.stringify(WRITE_CAPABLE)})
res = {}
for k, names in done["kinds"].items():
    if "." not in k: continue
    cls = restricted._kind_class(*k.split("."))
    for c in (cls if isinstance(cls, tuple) else (cls,)):
        for n in names:
            o = inspect.getattr_static(c, n, None)
            if type(o).__name__ not in ("method_descriptor", "builtin_function_or_method", "wrapper_descriptor"): continue
            try: ps = {p.lstrip("_") for p in inspect.signature(o).parameters}
            except (TypeError, ValueError): ps = None
            res[k.split(".")[-1] + "." + n] = None if ps is None else sorted(ps & W)
json.dumps(res)
`);
    assert.strictEqual(String(await py.runPythonAsync(dialectSetup(FILES))), "");
    const methods = JSON.parse(String(out));
    assert.ok(Object.keys(methods).length >= 7, `only ${Object.keys(methods).length} C methods: the enumeration is broken`);
    for (const [name, ps] of Object.entries(methods)) {
        assert.notStrictEqual(ps, null, `${name}: a C method whose signature cannot be read; read it by hand`);
        if (ps.length) assert.ok(name in OUT_ELSEWHERE, `${name} takes ${ps}: a C method with an argument that can write is not listed`);
    }
});

// --- the hard-coded list and the manifest say the same thing, until the data form replaces both ---

test("AGREE: every numpy leaf the manifest marks as writing its out argument is in DIALECT_OUT_ARGS, and the reverse", () => {
    // Only the names the manifest LISTS: ndarray.round keeps its leaf row (what it does) while UNLISTED keeps it out.
    const man = JSON.parse(FILES["manifest-numpy.json"]);
    const names = new Set([...man.functions.map((f) => `numpy.${f}`), ...Object.entries(man.kinds).flatMap(([k, ms]) => ms.map((m) => `${k}.${m}`))]);
    const marked = Object.entries(man.leaves ?? {}).filter(([key, row]) => names.has(key)
        && /mutates\(the out argument\) when out= is given/.test(row.effects ?? "")).map(([key]) => key);
    assert.deepStrictEqual(marked.sort(), listed().sort());
    assert.ok(!names.has("ndarray.round"), "ndarray.round is listed again: its out check does not survive * or **");
    for (const [, , p] of DIALECT_OUT_ARGS) assert.strictEqual(p, "out");
});

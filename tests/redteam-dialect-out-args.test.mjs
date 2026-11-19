// redteam-dialect-out-args.test.mjs — `out=` on an admitted numpy leaf, attacked through every way of reaching the same
// function and of binding the same parameter. The ownership check sees the interpreter's store sites; `np.sum(m,
// axis=0, out=b)` writes into `b` from C where it sees nothing, so the four listed module functions refuse `out` bound
// to anything but None. The lane's own rows (tests/python-dialect-out-args.test.mjs) hold every listed function and
// the *, ** and positional forms through the bare name; these hold the shapes that reach the SAME function object by
// another name (an alias, the ufunc's other name, a cell function body) and the ones that alias the ARRAY instead.
// Self-SKIPS without the fork core in dist/pyodide, as python-dialect-inside.test.mjs does.
//
// The property, in one line: no admitted leaf writes into a value the cell does not own through its `out` parameter,
// however the function or the array is spelled. Each row asserts the refusal AND that the injected array is untouched.
import { test, before } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { wrapUserSetup, wrapUserScript } from "../src/python/python-runtime.ts";
import { dialectSetup } from "../src/python/python-dialect-run.js";

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

/** One cell inside the dialect, in a namespace holding `b`, `df` and `img` the cell did NOT make. */
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
const M = `np.array([[1., 2.], [3., 4.]])`;

// --- the same function object, reached another way, and the same array under another name ---

const ALIAS_ROWS = [
    ["the function bound to a name, out through **", `import numpy as np\nf = np.sum\nk = {"axis": 0, "out": b}\nf(${M}, **k)`],
    ["the function bound to a name, the whole call spread with *", `import numpy as np\nf = np.mean\na = [${M}, 0, None, b]\nf(*a)`],
    ["the ufunc bound to a name, out positional", `import numpy as np\nf = np.abs\nf(np.array([-1., -2.]), b)`],
    ["out through a dict whose key is a variable", `import numpy as np\np = "out"\nnp.sum(${M}, axis=0, **{p: b})`],
    ["out is a slice of the array the cell was handed", `import numpy as np\nnp.abs(np.array([-1., -2.]), out=b[:])`],
    ["the array under a second name", `import numpy as np\nd = b\nnp.any(${M} > 2, axis=0, out=d)`],
    ["from the cell's own function", `import numpy as np\ndef run():\n    return np.sum(${M}, axis=0, out=b)\nrun()`],
    ["from a lambda", `import numpy as np\nrun = lambda: np.mean(${M}, axis=0, out=b)\nrun()`],
];

for (const [label, code] of ALIAS_ROWS) {
    test(`out= ASKS through an alias and writes nothing: ${label}`, { timeout: 60000 }, async (t) => {
        if (skip) return t.skip(skip);
        const r = await inside(code);
        assert.match(r.refused ?? "", /\(out=…\) writes into the array it is given/, JSON.stringify(r));
        assert.strictEqual(r.after, UNTOUCHED);
    });
}

test("the ufunc's other name is not an admitted alias, so out= through np.absolute never reaches the write", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    // `numpy.absolute` is unlisted (only numpy.abs has a row), so the call is refused at the NAME, before any out=
    // check: the row asserts the name refusal names `absolute`, so a later admitted alias cannot slip in silently.
    const code = `import numpy as np\nf = np.absolute\nf(np.array([-1., -2.]), out=b)`;
    const r = await inside(code);
    assert.match(r.refused ?? "", /attribute 'absolute' of module/, JSON.stringify(r));
    assert.strictEqual(r.after, UNTOUCHED);
});

// --- the removed row: ndarray.round is admitted nowhere, so no alias of it can write through out= ---

test("ndarray.round cannot write through out= by any alias: the row is gone and every way in asks", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    // The lane's rows hold the method's own forms (`x.round(...)`, `np.round`, `np.around`). These reach the same C
    // function through the class and through attribute machinery, where a surviving leaf row would be the way in.
    for (const code of [
        `import numpy as np\nx = np.array([1.4, 2.6])\nnp.ndarray.round(x, out=b)`,
        `import numpy as np\nx = np.array([1.4, 2.6])\nC = np.ndarray\nC.round(x, **{"out": b})`,
        `import numpy as np\nx = np.array([1.4, 2.6])\nf = getattr(np.ndarray, "round")\nf(x, out=b)`,
        `import numpy as np\nx = np.array([1.4, 2.6])\nf = getattr(x, "round")\nf(out=b)`,
    ]) {
        const r = await inside(code);
        assert.ok(r.refused, `ndarray.round ran instead of asking: ${JSON.stringify(r)}`);
        assert.equal(r.after, UNTOUCHED);
    }
});

test("the rule's width: out bound to the cell's OWN array asks too, which is safe and only costs a call", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    const r = await inside(`import numpy as np\nv = np.array([0., 0.])\nnp.abs(np.array([-1., -2.]), out=v)`);
    assert.match(r.refused ?? "", /\(out=…\) writes into the array it is given/, JSON.stringify(r));
});

test("the free control: the form the alias rows spread still runs inside when out is absent or None", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    // The alias rows' calls are refused for their out= argument; with out absent or None the same shapes run, so the
    // check costs a call and nothing else. (A name left holding a dispatcher is refused by the dialect at the cell's
    // end, measured: "it leaves 'f' holding a _ArrayFunctionDispatcher" — which is why the alias rows assert the out=
    // refusal at the call, before any write, and not the alias's own fate.)
    for (const [code, want] of [
        [`import numpy as np\nnp.sum(${M}, axis=0).tolist()`, "[4.0, 6.0]"],
        [`import numpy as np\nnp.mean(*[${M}, 0, None]).tolist()`, "[2.0, 3.0]"],
    ]) {
        const r = await inside(code);
        assert.strictEqual(r.value, want, `${code}: ${JSON.stringify(r)}`);
    }
});

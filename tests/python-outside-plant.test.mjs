// python-outside-plant.test.mjs — why the outside mark exists: on one interpreter, a cell run OUTSIDE the dialect can plant
// code that a later cell INSIDE it runs ungated, and the gate cannot tell.
//
// The rule these rows are the reason for: docs/spec/PYTHON_DIALECT.md, "What an inside run may leave behind is data,
// never code" (the third layer), built in py-mark.ts and held in python-outside-mark.test.mjs. The gate admits a lifted
// function by its identity, so assigning its `__code__` keeps it admitted; and a lifted call runs its Python callees
// ungated, so replacing a callee (`_iLocIndexer.__getitem__` under `DataFrame.head`) needs no admitted function touched at
// all, which is why a snapshot of the registered functions would not be enough. Each row asserts the plant RUNS inside:
// the interpreter does not hold, and the defence is that a marked worker is never posted an inside cell. A row that
// starts failing means the gate learned to refuse the plant: re-read the mark's reason before changing either.
//
// Real fork core: `npm run fetch-pyodide` then `node build.mjs`; `dist/pyodide/python_stdlib.zip` must hold `restricted.py`.
// Self-SKIPS without dist/pyodide or on the stock core. Drives `wrapUserSetup` + `wrapUserScript(…, inside)` exactly as
// python-worker.ts does. Genre: python.
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
    await py.runPythonAsync(dialectSetup(FILES));
}, { timeout: 240000 });

/** One cell in `ns`, as the worker runs it: the setup, then the cell inside the dialect or on the full path. */
async function cell(ns, code, inside) {
    ns.set("_ml_not_in_dialect", null);
    await py.runPythonAsync(wrapUserSetup(false, "run"), { globals: ns });
    await py.runPythonAsync(wrapUserScript(code, "run", inside ? { nodes: NODES } : null), { globals: ns });
    return { refused: ns.get("_ml_not_in_dialect") ?? null, error: ns.get("_err") ?? null, value: String(ns.get("_json_result")), stdout: String(ns.get("_stdout") ?? "") };
}

// --- an approved cell plants; a later inside cell runs the plant ungated ---

test("a lifted function's __code__ rewritten by an outside cell runs, ungated, in a later inside cell", { timeout: 120000 }, async (t) => {
    if (skip) return t.skip(skip);
    const ns = py.globals.get("dict")();
    const before = await cell(ns, "import pandas as pd\ndf = pd.DataFrame({'a': [1, 2]})\nreturn df.head(1).shape[0]", true);
    assert.deepStrictEqual([before.refused, before.value], [null, "1"], "positive control: the inside cell runs");
    const plant = await cell(ns, "import pandas as pd\nimport builtins\nbuiltins._ml_test_head = pd.DataFrame.head.__code__\ndef _p(self, n=5):\n    import os\n    return 'PLANTED ' + str(len(os.listdir('/')) > 0)\npd.DataFrame.head.__code__ = _p.__code__\nreturn 1", false);
    assert.strictEqual(plant.error, null, JSON.stringify(plant));
    // The interpreter is shared by the rows: the plant is undone when this one ends.
    t.after(() => cell(py.globals.get("dict")(), "import pandas as pd, builtins\npd.DataFrame.head.__code__ = builtins._ml_test_head\nreturn 1", false));
    const after = await cell(ns, "return df.head(1)", true);
    assert.strictEqual(after.refused, null, "the gate admits the planted body");
    assert.strictEqual(after.value, '"PLANTED True"', "the plant ran `import os` inside, ungated");
});

test("a CALLEE replaced by an outside cell runs, ungated, under an admitted function nobody touched", { timeout: 120000 }, async (t) => {
    if (skip) return t.skip(skip);
    const ns = py.globals.get("dict")();
    const before = await cell(ns, "import pandas as pd\ndf = pd.DataFrame({'a': [1, 2, 3]})\nreturn df.head(2).shape[0]", true);
    assert.deepStrictEqual([before.refused, before.value, before.stdout], [null, "2", ""], "positive control");
    const plant = await cell(ns, "from pandas.core.indexing import _iLocIndexer\n_orig = _iLocIndexer.__getitem__\ndef _g(self, key):\n    import os\n    print('PLANTED', len(os.listdir('/')) > 0)\n    return _orig(self, key)\n_iLocIndexer.__getitem__ = _g\nreturn 1", false);
    assert.strictEqual(plant.error, null, JSON.stringify(plant));
    const after = await cell(ns, "return df.head(2).shape[0]", true);
    assert.deepStrictEqual([after.refused, after.value], [null, "2"], "the admitted function still answers");
    assert.strictEqual(after.stdout, "PLANTED True\n", "the replaced callee ran `import os` inside, ungated");
});

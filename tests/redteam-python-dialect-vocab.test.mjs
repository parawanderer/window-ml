// redteam-python-dialect-vocab.test.mjs — the V1 vocabulary gives an inside cell no shared state, no write through a lifted
// read, and no out= it can name: decimal's context is never writable and its sticky flags are put back after every run, a
// lifted property's result or indexer cannot be written, and np.rint's out= is refused by every binding. Source:
// src/python/python-dialect-run.ts (_ml_inside_run's decimal restore, _ml_lifted_reads, DIALECT_OUT_ARGS).
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

async function inside(code) {
    const ns = py.globals.get("dict")();
    await py.runPythonAsync(wrapUserSetup(false, "run"), { globals: ns });
    await py.runPythonAsync(wrapUserScript(code, "run", { nodes: NODES }), { globals: ns });
    if (ns.get("_ml_not_in_dialect")) return { refused: String(ns.get("_ml_not_in_dialect")) };
    if (ns.get("_err")) return { error: String(ns.get("_err")) };
    return { value: String(ns.get("_json_result")) };
}

/** The thread decimal context's sticky flags, read from OUTSIDE any inside run — what a later full-path cell would see. */
const flags = () => JSON.parse(String(py.runPython(`import decimal, json; json.dumps({k.__name__: bool(v) for k, v in decimal.getcontext().flags.items()})`)));
/** A clean context for a row to start from, so one row's failure cannot hide the next row's. */
const clearFlags = () => { py.runPython(`import decimal; decimal.getcontext().clear_flags()`); };

// --- the decimal context: read, never written, and its sticky flags put back ---

test("RED TEAM (V1): getcontext()'s precision cannot be set inside", { ...T, skip }, async () => {
    const r = await inside(`import decimal\ndecimal.getcontext().prec = 9999\n1`);
    assert.match(r.refused ?? "", /setting attribute 'prec'/, JSON.stringify(r));
    // positive control: a Decimal runs, and the context it uses is the stock one.
    const ok = await inside(`from decimal import Decimal\nDecimal(1) / Decimal(3)`);
    assert.match(ok.value ?? "", /0\.3333/, JSON.stringify(ok));
});

test("RED TEAM (V1): a decimal operation's sticky flags are put back, so a later cell reads its own context", { ...T, skip }, async () => {
    clearFlags();
    const before = flags();
    const r = await inside(`from decimal import Decimal\nDecimal(1) / Decimal(3)`);
    assert.ok(r.value !== undefined, JSON.stringify(r));
    assert.deepEqual(flags(), before, "an inside cell left Inexact/Rounded set for the next reader");
});

test("RED TEAM (V1): the flags are put back after a cell that RAISES, and after one that is REFUSED mid-way", { ...T, skip }, async () => {
    clearFlags();
    const before = flags();
    await inside(`from decimal import Decimal\nDecimal(1) / Decimal(3)\nraise ValueError("boom")`);
    assert.deepEqual(flags(), before, "a raising cell left the flags set");
    const refused = await inside(`from decimal import Decimal\nDecimal(1) / Decimal(3)\nimport decimal\ndecimal.getcontext().prec = 5`);
    assert.ok(refused.refused, JSON.stringify(refused));
    assert.deepEqual(flags(), before, "a refused cell left the flags set");
});

test("RED TEAM (V1): random.choice refuses, naming the shared generator", { ...T, skip }, async () => {
    const r = await inside(`import random\nrandom.choice([1, 2])`);
    assert.match(r.refused ?? "", /shared generator/, JSON.stringify(r));
});

// --- a lifted read hands out no way to write ---

test("RED TEAM (V1): Series.iloc reads, and an item write through it is refused", { ...T, skip }, async () => {
    const read = await inside(`import pandas as pd\ns = pd.DataFrame({"c": [1, 2]})["c"]\ns.iloc[0]`);
    assert.ok(read.value !== undefined, `positive control: iloc did not read: ${JSON.stringify(read)}`);
    const w = await inside(`import pandas as pd\ns = pd.DataFrame({"c": [1, 2]})["c"]\ns.iloc[0] = 9\ns.tolist()`);
    assert.ok(w.refused, `iloc wrote: ${JSON.stringify(w)}`);
});

test("RED TEAM (V1): df.values is a view onto unowned data, so a write through it is refused", { ...T, skip }, async () => {
    const read = await inside(`import pandas as pd\ndf = pd.DataFrame({"c": [1, 2]})\ndf.values.tolist()`);
    assert.match(read.value ?? "", /\[\[1\], \[2\]\]/, JSON.stringify(read));
    const w = await inside(`import pandas as pd\ndf = pd.DataFrame({"c": [1, 2]})\nv = df.values\nv[0, 0] = 9\ndf["c"].tolist()`);
    assert.ok(w.refused, `a write through .values ran: ${JSON.stringify(w)}`);
});

test("RED TEAM (V1): .columns cannot be assigned, and its Index cannot be written", { ...T, skip }, async () => {
    const read = await inside(`import pandas as pd\ndf = pd.DataFrame({"c": [1, 2]})\nlist(df.columns)`);
    assert.match(read.value ?? "", /"c"/, JSON.stringify(read));
    for (const code of [`import pandas as pd\ndf = pd.DataFrame({"c": [1]})\ndf.columns = ["x"]\n1`,
        `import pandas as pd\ndf = pd.DataFrame({"c": [1]})\ndf.columns[0] = "x"\n1`]) {
        const r = await inside(code);
        assert.ok(r.refused, `${code}: ${JSON.stringify(r)}`);
    }
});

// --- np.rint's out= by every binding ---

test("RED TEAM (V1): np.rint refuses out= by keyword, by position and through ** spreading", { ...T, skip }, async () => {
    const P = "/tmp/ml-rt-e4-rint.bin";
    const ok = await inside(`import numpy as np\nnp.rint(np.array([1.4, 1.6])).tolist()`);
    assert.match(ok.value ?? "", /1\.0, 2\.0/, `positive control: ${JSON.stringify(ok)}`);
    for (const code of [
        `import numpy as np\na = np.array([1.4, 1.6])\nnp.rint(a, out=${JSON.stringify(P)})`,
        `import numpy as np\na = np.array([1.4, 1.6])\nnp.rint(a, ${JSON.stringify(P)})`,
        `import numpy as np\na = np.array([1.4, 1.6])\nk = {"out": ${JSON.stringify(P)}}\nnp.rint(a, **k)`,
    ]) {
        const r = await inside(code);
        assert.match(r.refused ?? "", /rint\(out=…\)|writes into the array it is given/, `${code}: ${JSON.stringify(r)}`);
    }
    assert.equal(fs.existsSync(P), false, "an rint out= wrote a file");
});

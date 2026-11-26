// redteam-python-read-csv.test.mjs — RED TEAM: what a hostile INSIDE cell must NOT get from `pd.read_csv` being served
// in the dialect (ruling 71, #2131). The builder's rows (python-read-csv-inside.test.mjs) hold the path rules, the
// keyword list and the charge; these hold the ROUTES AROUND them: the wrapper's closure (which holds the raw reader),
// the raw parser's module, the other readers pandas names, a subclassed source, the tables guard, and off-stack work.
//
// The checker is `_ml_read_csv_inside` (python-dialect-run.ts); the cell is the real interpreter's, with the loader
// redirect installed first as the worker does it. Self-SKIPS without the fork core in dist/pyodide. Genre: python.
import { test, before } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { wrapUserSetup, wrapUserScript, LOADERS_INSTALL } from "../src/python/python-runtime.ts";
import { dialectSetup } from "../src/python/python-dialect-run.ts";

const PYODIDE_DIR = path.resolve(import.meta.dirname, "../dist/pyodide");
const DATA_DIR = path.resolve(import.meta.dirname, "../notebooks/python-dialect/data");
const FILES = Object.fromEntries(["whitelist.json", "manifest-stdlib.json", "manifest-numpy.json", "manifest-pandas.json", "manifest-pil.json"]
    .map((f) => [f, fs.readFileSync(path.join(DATA_DIR, f), "utf8")]));
const NODES = JSON.parse(FILES["whitelist.json"]).nodes;
const CSV = "region,amount\nnorth,1.5\nsouth,2.5\neast,4\n";
const FILES_CSV = "/files/attached/h1/sales.csv";
const OUTSIDE_CSV = "/tmp/elsewhere/sales.csv";

let py = null;
let skip = fs.existsSync(path.join(PYODIDE_DIR, "pyodide.mjs")) ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";

before(async () => {
    if (skip) return;
    const { loadPyodide } = await import(path.join(PYODIDE_DIR, "pyodide.mjs"));
    py = await loadPyodide({ indexURL: PYODIDE_DIR });
    if (py.runPython(`import importlib.util; importlib.util.find_spec("_restricted") is None`)) { skip = "dist/pyodide is the stock core, not the restricted-mode fork"; return; }
    await py.loadPackage(["numpy", "pandas", "pillow"]);
    // As the worker does (dialectReason): the loader redirect first, so the setup registers the `pd.read_csv` a cell reaches.
    await py.runPythonAsync("import pandas as pd\nfrom PIL import Image\n" + LOADERS_INSTALL, { globals: py.globals.get("dict")() });
    assert.strictEqual(String(await py.runPythonAsync(dialectSetup(FILES))), "", "the dialect's manifests load");
    py.runPython(`
import os
for d in ("/files/attached/h1", "/files/agent", "/tmp/elsewhere"):
    os.makedirs(d, exist_ok=True)
for p in ("/files/attached/h1/sales.csv", "/tmp/elsewhere/sales.csv"):
    with open(p, "w") as f:
        f.write(${JSON.stringify(CSV)})
os.chdir("/files/agent")
`);
}, { timeout: 240000 });

/** One inside cell on a fresh namespace, as the runner gives it: refused, an error, or its value as JSON. */
async function cell(code) {
    const ns = py.globals.get("dict")();
    await py.runPythonAsync(wrapUserSetup(false, "run"), { globals: ns });
    await py.runPythonAsync(wrapUserScript(code, "run", { nodes: NODES }), { globals: ns });
    const refused = ns.get("_ml_not_in_dialect");
    if (refused) return { refused: String(refused) };
    const err = ns.get("_err");
    if (err) return { error: String(err) };
    return { value: JSON.parse(String(ns.get("_json_result"))) };
}

/** The positive control every row here rides on: the same cell reads the /files path, inside, and gets its rows. */
async function control(t) {
    const c = await cell(`import pandas as pd\nlen(pd.read_csv(${JSON.stringify(FILES_CSV)}))`);
    assert.deepStrictEqual(c, { value: 3 }, `control: the inside read works: ${JSON.stringify(c)}`);
    t ??= null;
}

// --- the registered wrapper is the only reader a cell can call -----------------------------------------

// `_ml_read_csv` (LOADERS_INSTALL) keeps the raw `pandas.read_csv` in its CLOSURE, which is what a cell would want:
// the raw function is the one the manifest lifted, without this change's path check. The dialect refuses dunder
// attribute access on a function, so the closure is out of reach; the control proves the same cell can call the
// wrapper, so a refusal is the attribute rule, not a cell that never ran.
for (const attr of ["__closure__", "__globals__", "__code__", "__dict__", "__doc__", "__module__", "__wrapped__"]) {
    test(`RED TEAM (read_csv): a cell cannot read \`pd.read_csv.${attr}\``, { timeout: 60000 }, async (t) => {
        if (skip) return t.skip(skip);
        const r = await cell(`import pandas as pd\npd.read_csv.${attr}`);
        assert.match(r.refused ?? "", /not in dialect/, JSON.stringify(r));
        assert.strictEqual(r.value, undefined);
        await control(t);
    });
}

test("RED TEAM (read_csv): a computed dunder name is refused the same way (`getattr`, `vars`)", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    for (const call of [`getattr(pd.read_csv, "__" + "clos" + "ure" + "__")`, `vars(pd.read_csv)`]) {
        const r = await cell(`import pandas as pd\n${call}`);
        assert.match(r.refused ?? "", /not in dialect/, `${call}: ${JSON.stringify(r)}`);
    }
    await control(t);
});

test("RED TEAM (read_csv): the function cannot be left in a name or a container's value, so no later cell finds it unnamed", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    // MEASURED: the refusal is the cell's closing rule (a name or a container left holding a function), so it fires
    // on the assignment itself; the call's own check is the row below.
    for (const stmt of ["g = pd.read_csv", "L = [pd.read_csv]"]) {
        const r = await cell(`import pandas as pd\n${stmt}\n1`);
        assert.match(r.refused ?? "", /leaves '.*holding a function/, `${stmt}: ${JSON.stringify(r)}`);
    }
    await control(t);
});

test("RED TEAM (read_csv): the check is on the FUNCTION, not the name: a call through a literal container is judged", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    const inside = await cell(`import pandas as pd\nlen([pd.read_csv][0](${JSON.stringify(FILES_CSV)}))`);
    assert.deepStrictEqual(inside, { value: 3 }, `a /files path through a container runs: ${JSON.stringify(inside)}`);
    const outside = await cell(`import pandas as pd\n[pd.read_csv][0](${JSON.stringify(OUTSIDE_CSV)})`);
    assert.match(outside.refused ?? "", /outside \/files\//, JSON.stringify(outside));
    const starred = await cell(`import pandas as pd\npd.read_csv(*(${JSON.stringify(OUTSIDE_CSV)},))`);
    assert.match(starred.refused ?? "", /outside \/files\//, JSON.stringify(starred));
    const kwargs = await cell(`import pandas as pd\npd.read_csv(**{"filepath_or_buffer": ${JSON.stringify(OUTSIDE_CSV)}})`);
    assert.match(kwargs.refused ?? "", /outside \/files\//, JSON.stringify(kwargs));
});

// --- the raw parser and the other readers are not in the re-admitted module -----------------------------

test("RED TEAM (read_csv): pandas' own submodules do not hand back the raw parser", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    for (const code of ["import pandas.io.parsers as P\nP.read_csv", `import pandas as pd\npd.io`]) {
        const r = await cell(code);
        // The submodule attribute is refused for what it returns (a module); the import for the name it asks for.
        assert.match(r.refused ?? "", /not in dialect|it leaves/, `${code.split("\n").at(-1)}: ${JSON.stringify(r)}`);
    }
    await control(t);
});

// The setup REPLACES pandas' names with the manifest's plus `read_csv` (allow_module). The other readers pandas
// defines — read_html takes a path or a URL, read_parquet a path in C — are outside that list, so a cell cannot
// reach a second parser that skips the path rule and the charge.
for (const name of ["read_html", "read_parquet"]) {
    test(`RED TEAM (read_csv): \`pandas.${name}\` is not a name the served module re-admits`, { timeout: 60000 }, async (t) => {
        if (skip) return t.skip(skip);
        const r = await cell(`import pandas as pd\npd.${name}`);
        assert.match(r.refused ?? "", /not in dialect: attribute '/, JSON.stringify(r));
        await control(t);
    });
}

// --- the source's type cannot be spoofed --------------------------------------------------------------

// The check is an exact type test (`type(_src) is io.StringIO`), so a subclass could dodge it — but a class cannot be
// defined inside the dialect at all, and the only other way to a subclass is a library one, whose attribute is not
// admitted either. A memoryview is refused with the rest.
test("RED TEAM (read_csv): a subclassed str or buffer cannot be built inside, so the exact-type check stands", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    for (const [code, why] of [
        [`import pandas as pd\nclass S(str):\n    pass\npd.read_csv(S(${JSON.stringify(FILES_CSV)}))`, /ClassDef|not in dialect/],
        [`import io, pandas as pd\nclass B(io.StringIO):\n    pass\npd.read_csv(B(${JSON.stringify(CSV)}))`, /ClassDef|not in dialect/],
        [`import numpy as np, pandas as pd\npd.read_csv(np.str_(${JSON.stringify(FILES_CSV)}))`, /not in dialect/],
        [`import pandas as pd\npd.read_csv(memoryview(b"a\\n1\\n"))`, /not in dialect/],
    ]) {
        const r = await cell(code);
        assert.match(r.refused ?? "", why, `${code.split("\n")[0]}: ${JSON.stringify(r)}`);
    }
    // The control is a source of the exact type the check wants, made by the cell: it is read inside.
    assert.deepStrictEqual(await cell(`import io, pandas as pd\nlen(pd.read_csv(io.StringIO(${JSON.stringify(CSV)})))`), { value: 3 });
});

// --- the tables guard cannot be cleared from a cell ---------------------------------------------------

// The check asks while the cell has tables loaded, because the prelude's redirect may answer a path with an injected
// table rather than the file. That guard keys on `__main__._ml_load_ns`; clearing it would silence the guard, so the
// module that holds it must not be reachable by any name.
test("RED TEAM (read_csv): the tables guard cannot be cleared: `__main__`, `sys` and `builtins` are not importable inside", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    for (const code of ["import __main__\n__main__._ml_load_ns", "import sys\nsys.modules[\"__main__\"]", "import builtins\nbuiltins.open"]) {
        const r = await cell(code);
        assert.match(r.refused ?? "", /not in dialect: (the name|import) /, `${code.split("\n")[0]}: ${JSON.stringify(r)}`);
    }
    await control(t);
});

// --- no parse runs off the cell's stack ---------------------------------------------------------------

// The charge is paid on the cell's own stack, before the call, so the budget sees every byte. A parse run by another
// thread would be work the budget never counts; the dialect admits neither module that starts one.
test("RED TEAM (read_csv): no thread can run a parse off the cell's stack: threading and concurrent.futures are refused", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    for (const code of ["import threading\nthreading.Thread", "import concurrent.futures\nconcurrent.futures"]) {
        const r = await cell(code);
        assert.match(r.refused ?? "", /not in dialect: import '/, `${code.split("\n")[0]}: ${JSON.stringify(r)}`);
    }
    await control(t);
});

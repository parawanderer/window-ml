// redteam-python-dialect-coverage.test.mjs — what a hostile cell must NOT get from coverage PR (1): bare dir(),
// numpy's sized scalar types, Decimal.quantize and the decimal ROUND_* modes, and the manifest's new kind_types key
// (src/python/python-dialect-run.ts `_ml_stdlib`; notebooks/python-dialect/data/manifest-*.json). The inside run is the
// auto-approved path, so each admission keeps its claim or the cell gets more than the manifest says: dir() yields
// NAMES of nothing it could not already name (no value, no harness name) and asks in any frame that has locals; a scalar
// type is a value, not a namespace (item, subclass, dunder, type() all ask), and its constructor converts a handed frame
// in C without routing through the frame's Python protocol or writing to it; quantize rounds only in the thread context, which the cell never owns
// and cannot read or write; and the kind_types resolution is the harness's, reachable by no name a cell can write.
//
// Every refusal row carries a positive control: the SAME shape on the full path answers, so a row that starts passing
// because the shape stopped parsing is seen. The admitted siblings (dir() at the top level, np.int64("3"),
// quantize(getcontext())) fail with the change reverted, which is what anchors the rows to this PR. Real fork core;
// self-SKIPS as python-dialect-vocab does.
import { test, before } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { wrapUserSetup, wrapUserScript } from "../src/python/python-runtime.ts";
import { dialectSetup } from "../src/python/python-dialect-run.ts";

const PYODIDE_DIR = path.resolve(import.meta.dirname, "../dist/pyodide");
const DATA_DIR = path.resolve(import.meta.dirname, "../notebooks/python-dialect/data");
const FILES = Object.fromEntries(["whitelist.json", "manifest-stdlib.json", "manifest-numpy.json", "manifest-pandas.json", "manifest-pil.json"]
    .map((f) => [f, fs.readFileSync(path.join(DATA_DIR, f), "utf8")]));
const NODES = JSON.parse(FILES["whitelist.json"]).nodes;
const hasPyodide = fs.existsSync(path.join(PYODIDE_DIR, "pyodide.mjs"));

let py = null, ns = null;
let skip = hasPyodide ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";

before(async () => {
    if (!hasPyodide) return;
    const { loadPyodide } = await import(path.join(PYODIDE_DIR, "pyodide.mjs"));
    py = await loadPyodide({ indexURL: PYODIDE_DIR });
    if (py.runPython(`import importlib.util; importlib.util.find_spec("_restricted") is None`)) { skip = "dist/pyodide is the stock core, not the restricted-mode fork"; return; }
    await py.loadPackage(["numpy", "pandas", "pillow"]);
    assert.strictEqual(String(await py.runPythonAsync(dialectSetup(FILES))), "");
    ns = py.globals.get("dict")();
    py.runPython(`import decimal\ndecimal.getcontext()`, { globals: ns });
    await py.runPythonAsync(wrapUserSetup(false, "run"), { globals: ns });
}, { timeout: 240000 });

/** The injected frame values, as the full path sees them: nothing a cell does may change these. */
const reset = () => py.runPython(`import numpy as np, pandas as pd\nb = np.array([1.2, 2.7])\ndf = pd.DataFrame({"a": [1.5, 2.5], "s": ["x", "y"]})\nser = df["a"]`, { globals: ns });
const injected = () => String(py.runPython(`repr((b.tolist(), df["a"].tolist(), ser.tolist()))`, { globals: ns }));
const UNTOUCHED = "([1.2, 2.7], [1.5, 2.5], [1.5, 2.5])";
const json = (v) => JSON.stringify(v);
/** The cell's answer, decoded: `_json_result` holds the value already JSON-encoded. */
const valOf = (r) => JSON.parse(String(r.value));

/** One cell, inside or on the full path: refused, an error, or its value as JSON. */
async function cell(code, full = false) {
    for (const k of ["_ml_not_in_dialect", "_err", "_json_result"]) ns.set(k, undefined);
    await py.runPythonAsync(wrapUserScript(code, "run", full ? null : { nodes: NODES }), { globals: ns });
    const refused = ns.get("_ml_not_in_dialect");
    if (refused) return { refused: String(refused) };
    const err = ns.get("_err");
    if (err) return { error: String(err) };
    return { value: ns.get("_json_result") };
}

// --- bare dir(): names of nothing, and only where no frame has locals ---

test("RED TEAM: bare dir() answers inside exactly what the full path answers, and names nothing of the harness's", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    for (const code of [`dir()`, `x = 1\ndir()`, `y = 2\n"y" in dir()`, `(lambda: dir())()`, `len(dir())`]) {
        const inside = await cell(code), full = await cell(code, true);
        assert.ok("value" in inside, `${code}: ${JSON.stringify(inside)}`);
        assert.strictEqual(json(inside.value), json(full.value), `${code}: the dialect answered something the full path does not`);
        // The claim is folded into the answer itself: nothing the harness keeps in the module or the namespace shows.
        assert.ok(!/_ml|_err\b|_json_result/.test(String(inside.value)), `${code}: dir() named a harness name: ${inside.value}`);
    }
});

test("RED TEAM: dir() in any frame that HAS locals asks, never answers with them — while the full path does answer", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    // A function's and a comprehension's frame hold locals; bare dir() over them reads the proxy by item, which the
    // manifest does not admit. The full path shows the same shapes are live and would answer if the admission loosened.
    for (const code of [`def f(a):\n    return dir()\nf(1)`, `[dir() for _ in "ab"]`]) {
        const inside = await cell(code);
        assert.ok(inside.refused, `${code}: answered instead of asking: ${JSON.stringify(inside)}`);
        assert.match(inside.refused, /FrameLocalsProxy|not in dialect/, code);
        const full = await cell(code, true);
        assert.ok("value" in full, `${code}: the full path no longer answers; the row measures nothing`);
    }
});

test("RED TEAM: dir(obj) is not in the dialect", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    for (const code of [`dir(1)`, `dir("a")`, `sorted(dir(1))`]) {
        const inside = await cell(code);
        assert.ok(inside.refused, `${code}: ${JSON.stringify(inside)}`);
        const full = await cell(code, true);
        assert.ok("value" in full, `${code}: the full path no longer answers; the row measures nothing`);
    }
});

// --- a scalar type is a value, not a namespace ---

test("RED TEAM: a numpy scalar type admits no namespace of its own: item, subclass, dunder, type() and a C slot all ask", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    for (const code of [
        `import numpy as np\nnp.int64[int]`,
        `import numpy as np\nclass X(np.int64):\n    pass\n1`,
        `import numpy as np\nnp.int64(1).__class__`,
        `import numpy as np\nnp.int64.__call__`,
        `import numpy as np\ntype(np.int64)`,
        `import numpy as np\ntype(np.int64(1))`,
    ]) assert.ok((await cell(code)).refused, code);
    // The positive controls: the value and the constructor are the only things admitted, and they run.
    assert.strictEqual(valOf(await cell(`import numpy as np\nstr(np.int64("3"))`)), "3");
    assert.strictEqual(valOf(await cell(`import numpy as np\nbool(np.float32(0.5) == 0.5)`)), true);
});

test("RED TEAM: a scalar constructor over a handed frame converts in C — no gate refusal is raised, nothing runs a gated operation ungated, and the frame is untouched", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    // Measured on the fork core: np.int64(ser), np.float64(ser) and np.int64(b) convert ELEMENTWISE and hand back an
    // ndarray; they raise numpy's own TypeError only where numpy itself would. The manifest admits the constructor as a
    // conversion, so the row holds it to that: conversion is C-level, it never routes through the frame's Python
    // protocol (where a refusal would be raised, and could be caught by library code), and it does not write.
    for (const code of [`import numpy as np\nnp.int64(ser)`, `import numpy as np\nnp.float64(ser)`, `import numpy as np\nnp.int64(b)`]) {
        reset();
        const inside = await cell(code), full = await cell(code, true);
        assert.ok(!inside.refused, `${code}: the conversion asked instead of converting: ${JSON.stringify(inside)}`);
        assert.ok(!full.refused, `${code}: the full path refuses; the shape no longer measures the conversion`);
        assert.strictEqual(injected(), UNTOUCHED, `${code}: the cell changed the handed frame`);
    }
    reset();
    assert.ok((await cell(`import numpy as np\nint(np.int64(ser))`)).error, "int() of the converted array no longer raises numpy's own error");
    assert.strictEqual(injected(), UNTOUCHED, "the cell changed the handed frame");
});

// --- quantize rounds in the thread context, which the cell never owns ---

test("RED TEAM: quantize takes no context the cell owns: decimal.Context is not admitted, nor any context attribute", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    for (const code of [
        `import decimal\ndecimal.Context()`,
        `from decimal import Context\nContext()`,
        `import decimal\ndecimal.getcontext().flags`,
        `import decimal\ndecimal.getcontext().rounding`,
        `import decimal\ndecimal.getcontext().prec = 5\n1`,
    ]) assert.ok((await cell(code)).refused, code);
    // The only context reachable is the thread's own, and through it quantize runs.
    const r = await cell(`from decimal import Decimal, getcontext, ROUND_HALF_UP\nstr(Decimal("1.235").quantize(Decimal("0.01"), rounding=ROUND_HALF_UP, context=getcontext()))`);
    assert.strictEqual(valOf(r), "1.24", JSON.stringify(r));
});

test("RED TEAM: a rounding mode from the cell is validated by decimal, and the cell cannot write the module's", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    // Not a dialect question: both paths raise the same thing for a name that is not a mode.
    const bad = `from decimal import Decimal\nDecimal("1").quantize(Decimal("1"), rounding="ROUND_NOPE")`;
    const inside = await cell(bad), full = await cell(bad, true);
    assert.ok(inside.error && full.error, `${JSON.stringify([inside, full])}`);
    assert.match(String(inside.error), /valid values for rounding/);
    assert.match(String(full.error), /valid values for rounding/);
    for (const code of [`import decimal\ndecimal.ROUND_HALF_UP = "ROUND_DOWN"\n1`, `import decimal\nsetattr(decimal, "ROUND_HALF_UP", "ROUND_DOWN")\n1`])
        assert.ok((await cell(code)).refused, code);
    assert.strictEqual(valOf(await cell(`import decimal\ndecimal.ROUND_HALF_UP`, true)), "ROUND_HALF_UP");
});

// --- the kind_types key resolves in the harness, by no name a cell can write ---

test("RED TEAM: the kind_types kind is the harness's: its module stays unadmitted and the name binds to whatever the cell makes", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    for (const code of [`import builtins`, `import builtins\nbuiltins.FrameLocalsProxy`, `import importlib`, `import sys\nsys._getframe().f_locals`])
        assert.ok((await cell(code)).refused, code);
    // A cell writing the KIND's name makes its own value, which the registry (keyed by the type object) does not know.
    assert.strictEqual(valOf(await cell(`FrameLocalsProxy = 7\nFrameLocalsProxy`)), 7);
    assert.ok((await cell(`FrameLocalsProxy = [1]\nFrameLocalsProxy.keys()`)).refused, "a list made under the kind's name was admitted as a FrameLocalsProxy");
});

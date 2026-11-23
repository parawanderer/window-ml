// python-dialect-vocab.test.mjs — the dialect's vocabulary as the manifests list it is the vocabulary a cell gets inside.
//
// Finding A: load_manifests admits READING each name manifest-stdlib.json lists but registers no call, so
// decimal.Decimal, io.StringIO, csv.reader and the rest were refused inside although listed. `_ml_stdlib`
// (python-dialect-run.ts) registers them from the manifest; this file holds every listed stdlib name to a call that runs
// inside, or a reason. Decimal arithmetic sets the thread context's sticky flags from C, which no ownership check sees,
// so `_ml_inside_run` puts them back. The pandas attributes the cell replay found missing (DataFrame.columns/shape,
// Series.iloc) and np.rint are listed; a listed pandas property is read lifted (`_ml_lifted_reads`), which also revives
// DataFrame.values and Series.values. Self-SKIPS without the fork core in dist/pyodide, as python-dialect-inside does.
import { test, before } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { wrapUserSetup, wrapUserScript } from "../src/python/python-runtime.ts";
import { dialectSetup, DIALECT_STDLIB_REFUSED } from "../src/python/python-dialect-run.ts";

const PYODIDE_DIR = path.resolve(import.meta.dirname, "../dist/pyodide");
const DATA_DIR = path.resolve(import.meta.dirname, "../notebooks/python-dialect/data");
const FILES = Object.fromEntries(["whitelist.json", "manifest-stdlib.json", "manifest-numpy.json", "manifest-pandas.json", "manifest-pil.json"]
    .map((f) => [f, fs.readFileSync(path.join(DATA_DIR, f), "utf8")]));
const NODES = JSON.parse(FILES["whitelist.json"]).nodes;
const STDLIB = JSON.parse(FILES["manifest-stdlib.json"]);
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
    // The decimal context made at the top level, as a worker's first full cell would: the one later cells read.
    py.runPython(`import decimal\ndecimal.getcontext()`, { globals: ns });
    await py.runPythonAsync(wrapUserSetup(false, "run"), { globals: ns });
}, { timeout: 240000 });

/** Fresh injected values the cell did NOT make: `b` (an ndarray), `df` and `ser` (a column of it). */
function reset() {
    py.runPython(`import numpy as np, pandas as pd\nb = np.array([1.2, 2.7])\ndf = pd.DataFrame({"a": [1.5, 2.5], "s": ["x", "y"]})\nser = df["a"]`, { globals: ns });
}

/** One cell, inside the dialect or (full) on the full path: refused, an error, or its value as JSON. */
async function cell(code, full = false) {
    for (const k of ["_ml_not_in_dialect", "_err", "_json_result"]) ns.set(k, undefined);
    await py.runPythonAsync(wrapUserScript(code, "run", full ? null : { nodes: NODES }), { globals: ns });
    const refused = ns.get("_ml_not_in_dialect");
    if (refused) return { refused: String(refused) };
    const err = ns.get("_err");
    if (err) return { error: String(err) };
    return { value: ns.get("_json_result") };
}
const injected = () => String(py.runPython(`repr((b.tolist(), df["a"].tolist(), ser.tolist()))`, { globals: ns }));
const UNTOUCHED = "([1.2, 2.7], [1.5, 2.5], [1.5, 2.5])";

// --- every name manifest-stdlib.json lists: a call that runs inside, or a reason ---

/** A cell per listed name that runs inside and gives this value. */
const CALLS = {
    "decimal.Decimal": [`from decimal import Decimal\nstr(Decimal("1.10") + Decimal(2) + Decimal(1.5))`, `"4.60"`],
    "decimal.getcontext": [`import decimal\ndecimal.getcontext() is not None`, "true"],
    "io.StringIO": [`import io, csv\nlist(csv.reader(io.StringIO("a,b\\n1,2\\n")))`, `[["a","b"],["1","2"]]`],
    "io.BytesIO": [`import io\nio.BytesIO(b"ab") is not None`, "true"],
    "csv.reader": [`import csv\nlist(csv.reader(["a,b", "1,2"]))`, `[["a","b"],["1","2"]]`],
    "csv.DictReader": [`import csv, io\n[dict(r) for r in csv.DictReader(io.StringIO("a,b\\n1,2\\n"))]`, `[{"a":"1","b":"2"}]`],
    "math.fsum": [`import math\nmath.fsum([0.1] * 10)`, "1"],
    "re.compile": [`import re\nre.compile("a+") is not None`, "true"],
    "re.findall": [`import re\nre.findall("a", "banana")`, `["a","a","a"]`],
    "re.search": [`import re\nbool(re.search("a+", "caat"))`, "true"],
    "Decimal.max": [`from decimal import Decimal\nstr(Decimal(1).max(Decimal(2)))`, `"2"`],
    "Decimal.quantize": [`from decimal import Decimal\nstr(Decimal("1.234").quantize(Decimal("0.01")))`, `"1.23"`],
    // A top-level cell's names are globals, so its frame has no locals: bare dir() is [] here and on the full path alike.
    "FrameLocalsProxy.keys": [`x = 1\ndir()`, "[]"],
    // The rounding modes are values, read and passed: 2.5 to the unit under each.
    "decimal.ROUND_CEILING": [`from decimal import Decimal, ROUND_CEILING\nstr(Decimal("2.5").quantize(Decimal("1"), rounding=ROUND_CEILING))`, `"3"`],
    "decimal.ROUND_DOWN": [`from decimal import Decimal, ROUND_DOWN\nstr(Decimal("2.5").quantize(Decimal("1"), rounding=ROUND_DOWN))`, `"2"`],
    "decimal.ROUND_FLOOR": [`from decimal import Decimal, ROUND_FLOOR\nstr(Decimal("2.5").quantize(Decimal("1"), rounding=ROUND_FLOOR))`, `"2"`],
    "decimal.ROUND_HALF_DOWN": [`from decimal import Decimal, ROUND_HALF_DOWN\nstr(Decimal("2.5").quantize(Decimal("1"), rounding=ROUND_HALF_DOWN))`, `"2"`],
    "decimal.ROUND_HALF_EVEN": [`from decimal import Decimal, ROUND_HALF_EVEN\nstr(Decimal("2.5").quantize(Decimal("1"), rounding=ROUND_HALF_EVEN))`, `"2"`],
    "decimal.ROUND_HALF_UP": [`from decimal import Decimal, ROUND_HALF_UP\nstr(Decimal("2.5").quantize(Decimal("1"), rounding=ROUND_HALF_UP))`, `"3"`],
    "decimal.ROUND_UP": [`from decimal import Decimal, ROUND_UP\nstr(Decimal("2.5").quantize(Decimal("1"), rounding=ROUND_UP))`, `"3"`],
    "decimal.ROUND_05UP": [`from decimal import Decimal, ROUND_05UP\nstr(Decimal("2.5").quantize(Decimal("1"), rounding=ROUND_05UP))`, `"2"`],
};
/** Listed names this file does not call, with why. */
const ELSEWHERE = {
    "PIL.Image.open": "a PIL name: its row and rule are manifest-pil.json's (manifest-schemas.test.mjs)",
};
/** The listed names: each module's names, and each kind's methods. */
const LISTED = [...Object.entries(STDLIB.modules).flatMap(([m, ns]) => ns.map((n) => `${m}.${n}`)),
    ...Object.entries(STDLIB.kinds).flatMap(([k, ns]) => ns.map((n) => `${k}.${n}`))].sort();
const json = (v) => JSON.stringify(JSON.parse(v));

test("ENUMERATED: every name manifest-stdlib.json lists is called here, refused with a reason, or held elsewhere", () => {
    assert.deepEqual([...Object.keys(CALLS), ...Object.keys(DIALECT_STDLIB_REFUSED), ...Object.keys(ELSEWHERE)].sort(), LISTED);
});

for (const [name, [code, want]] of Object.entries(CALLS)) {
    test(`a listed stdlib name runs inside: ${name}`, { timeout: 60000 }, async (t) => {
        if (skip) return t.skip(skip);
        const r = await cell(code);
        assert.ok("value" in r, JSON.stringify(r));
        assert.strictEqual(json(r.value), json(want));
    });
}

for (const [name, why] of Object.entries(DIALECT_STDLIB_REFUSED)) {
    test(`a listed stdlib name refused with its reason: ${name}`, { timeout: 60000 }, async (t) => {
        if (skip) return t.skip(skip);
        const [mod, fn] = name.split(".");
        const r = await cell(`import ${mod}\n${mod}.${fn}([1, 2, 3])`);
        assert.ok((r.refused ?? "").includes(why), JSON.stringify(r));
    });
}

test("AGREE: what _ml_stdlib registered is the manifest's names, less the fork's own re leaves, the refused and the held", { timeout: 60000 }, (t) => {
    if (skip) return t.skip(skip);
    const registered = JSON.parse(py.runPython(`import json, sys\njson.dumps(sys.modules["_ml_libraries"].stdlib)`));
    const forks = new Set(JSON.parse(py.runPython(`import json, restricted\njson.dumps(list(restricted._REGEX))`)).map((n) => `re.${n}`));
    // A listed value that is not callable (decimal's rounding modes) is admitted for reading and registers no call.
    const values = new Set(JSON.parse(py.runPython(`import importlib, json\njson.dumps([m + "." + n for m, ns in ${JSON.stringify(STDLIB.modules)}.items() for n in ns if "." not in n and not callable(getattr(importlib.import_module(m), n))])`)));
    const want = LISTED.filter((n) => !forks.has(n) && !values.has(n) && !(n in DIALECT_STDLIB_REFUSED) && !(n in ELSEWHERE));
    assert.deepEqual(registered, want);
});

test("re.compile runs, but a Pattern is only a value: its attributes and methods ask, and re.search takes a string", { timeout: 60000 }, async (t) => {
    // re's module functions carry the regex step charge for the string they are given; a Pattern's own methods would not.
    if (skip) return t.skip(skip);
    for (const code of [`import re\nre.compile("a+").pattern`, `import re\nre.compile("a+").search("caat") is not None`, `import re\nre.search(re.compile("a+"), "caat") is not None`])
        assert.ok((await cell(code)).refused, code);
});

// --- Decimal: an inside cell leaves nothing on the shared context ---

const FLAGS = `import decimal\nsorted(k.__name__ for k, v in decimal.getcontext().flags.items() if v)`;

test("an inside cell's Decimal arithmetic leaves no flag a later cell reads", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    await cell(`import decimal\ndecimal.getcontext().clear_flags()\n1`, true);
    assert.strictEqual(json((await cell(`from decimal import Decimal\nstr(Decimal(1) / Decimal(3))`)).value), json(`"0.3333333333333333333333333333"`));
    assert.strictEqual(json((await cell(FLAGS, true)).value), "[]");
});

test("nor does a REFUSED inside cell that did Decimal arithmetic first", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    await cell(`import decimal\ndecimal.getcontext().clear_flags()\n1`, true);
    assert.ok((await cell(`from decimal import Decimal\nx = Decimal(1) / Decimal(3)\nimport os`)).refused);
    assert.strictEqual(json((await cell(FLAGS, true)).value), "[]");
});

test("a flag a full cell set is still set after an inside cell", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    await cell(`import decimal\ndecimal.getcontext().clear_flags()\nstr(decimal.Decimal(1) / decimal.Decimal(3))`, true);
    await cell(`from decimal import Decimal\nstr(Decimal(2) + Decimal(2))`);
    assert.strictEqual(json((await cell(FLAGS, true)).value), json(`["Inexact","Rounded"]`));
});

test("ADVERSARIAL: the context itself is never the cell's: prec, traps and flags are refused, and it is not kept", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    for (const code of [`import decimal\ndecimal.getcontext().prec = 50\n1`, `import decimal\ndecimal.getcontext().prec`,
        `import decimal\ndecimal.getcontext().traps[decimal.Inexact] = True\n1`, `import decimal\ndecimal.getcontext().clear_flags()\n1`,
        `import decimal\nc = decimal.getcontext()\n1`, `import decimal\ndecimal.getcontext()`])
        assert.ok((await cell(code)).refused, code);
    assert.strictEqual(json((await cell(`import decimal\n[decimal.getcontext().prec, decimal.getcontext().traps[decimal.Inexact]]`, true)).value), "[28,false]");
});

test("ADVERSARIAL: a stdlib value's unlisted methods ask (Decimal.as_tuple, StringIO.write, a DictReader's reader)", { timeout: 60000 }, async (t) => {
    // Decimal.as_tuple is not listed: C builds its DecimalTuple through type.__new__, which the gate refuses whatever is
    // registered, so listing it would change nothing.
    if (skip) return t.skip(skip);
    for (const code of [`from decimal import Decimal\nDecimal("1.25").as_tuple()`, `import io\nio.StringIO("x").write("y")`,
        `import io\nio.StringIO("x").read()`, `import csv\ncsv.DictReader(["a"]).reader is not None`, `import csv\ncsv.DictReader(["a"]).fieldnames`])
        assert.ok((await cell(code)).refused, code);
});

// --- the attributes the cell replay found missing, and the listed properties that were dead ---

const ATTRS = [
    ["DataFrame.columns", `list(df.columns)`, `["a","s"]`],
    ["DataFrame.shape", `df.shape`, "[2,2]"],
    ["DataFrame.values (listed, was dead inside)", `df.values.tolist()`, `[[1.5,"x"],[2.5,"y"]]`],
    ["Series.values (listed, was dead inside)", `ser.values.tolist()`, "[1.5,2.5]"],
    ["Series.iloc, an item", `float(ser.iloc[1])`, "2.5"],
    ["Series.iloc, a slice", `ser.iloc[0:1].tolist()`, "[1.5]"],
    ["a column by attribute (the dynamic rule kept)", `df.s.tolist()`, `["x","y"]`],
    ["np.rint", `import numpy as np\nnp.rint(b).tolist()`, "[1,3]"],
];

for (const [label, code, want] of ATTRS) {
    test(`runs inside: ${label}`, { timeout: 60000 }, async (t) => {
        if (skip) return t.skip(skip);
        reset();
        const r = await cell(code);
        assert.ok("value" in r, JSON.stringify(r));
        assert.strictEqual(json(r.value), json(want));
        assert.strictEqual(injected(), UNTOUCHED);
    });
}

const STILL_ASKS = [
    // An item write through iloc is judged on the indexer (a new object each read), never on the Series, so it is not
    // listed at all, on a handed Series or the cell's own copy.
    ["ser.iloc[0] = 9 on a handed Series", `ser.iloc[0] = 9\n1`],
    ["an iloc write on the cell's own copy", `s = df["a"].copy()\ns.iloc[0] = 9\n1`],
    ["an iloc write through a kept indexer", `i = ser.iloc\ni[0] = 9\n1`],
    ["an indexer kept past the cell", `i = ser.iloc\n1`],
    ["np.rint into a handed array", `import numpy as np\nnp.rint(np.array([1.5, 2.5]), out=b)\n1`],
    // str() of a numpy dtype imports from C under the cell's frame, which has no __builtins__ (KeyError, a fork
    // follow-up): admitted, the model would get an error a full run never gives, so neither name is listed.
    ["Series.dtype (not listed)", `ser.dtype == "float64"`],
    ["DataFrame.dtypes (not listed)", `len(df.dtypes)`],
    // The lifted read is for the listed properties alone: an internal name, a dunder, a name the class has unlisted.
    ["df._mgr", `df._mgr is not None`],
    ["ser._values", `ser._values is not None`],
    ["df.__dict__", `len(df.__dict__)`],
    ["df.T (a property, not listed)", `df.T.shape`],
    ["df.iloc (not listed on DataFrame)", `df.iloc[0, 0]`],
    ["df.values, then a write", `v = df.values\nv[0, 0] = 1.\n1`],
    ["ser.values, then a write", `v = ser.values\nv[0] = 1.\n1`],
];

for (const [label, code] of STILL_ASKS) {
    test(`ADVERSARIAL: asks, and the handed values are untouched: ${label}`, { timeout: 60000 }, async (t) => {
        if (skip) return t.skip(skip);
        reset();
        const r = await cell(code);
        assert.ok(r.refused, JSON.stringify(r));
        assert.strictEqual(injected(), UNTOUCHED);
    });
}

// --- bare dir(), numpy's scalar types and Decimal.quantize: the coverage rulings of 2026-11-23 ---

const NUMPY = JSON.parse(FILES["manifest-numpy.json"]);
/** numpy's sized scalar types, ruled in as values and constructors (make-corpus-count.py NP_SCALARS). */
const NP_SCALARS = ["bool_", "int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "uint64", "float16", "float32", "float64", "complex64", "complex128"];

test("AGREE: the numpy names that are types are exactly the sized scalar types", { timeout: 60000 }, (t) => {
    if (skip) return t.skip(skip);
    const types = JSON.parse(py.runPython(`import json, numpy\njson.dumps(sorted(n for n in ${JSON.stringify(NUMPY.functions)} if isinstance(getattr(numpy, n, None), type)))`));
    assert.deepEqual(types, [...NP_SCALARS].sort());
});

for (const name of NP_SCALARS) {
    test(`runs inside: numpy.${name} built from a number`, { timeout: 60000 }, async (t) => {
        if (skip) return t.skip(skip);
        const r = await cell(`import numpy as np\nbool(np.${name}(1) == 1)`);
        assert.strictEqual(json(r.value ?? "null"), "true", JSON.stringify(r));
    });
}

test("runs inside: a scalar type named as a value (astype(np.int64)), the handed frame untouched", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    reset();
    const r = await cell(`import numpy as np\ndf["a"].astype(np.int64).tolist()`);
    assert.strictEqual(json(r.value ?? "null"), "[1,2]", JSON.stringify(r));
    assert.strictEqual(injected(), UNTOUCHED);
});

test("ADVERSARIAL: a scalar type is a value, not a namespace: its attributes ask (fromhex, max, a dunder), and np.iinfo is not listed", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    for (const code of [`import numpy as np\nnp.float64.fromhex("0x1p0")`, `import numpy as np\nnp.int64.max`, `import numpy as np\nnp.int64.__mro__`,
        `import numpy as np\nnp.iinfo(np.int64).max`])
        assert.ok((await cell(code)).refused, code);
});

test("bare dir() answers inside what it answers on the full path, and only names", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    for (const code of [`dir()`, `y = 2\n"y" in dir()`, `[n for n in dir() if not n.startswith("__")]`]) {
        const inside = await cell(code), full = await cell(code, true);
        assert.ok("value" in inside, `${code}: ${JSON.stringify(inside)}`);
        assert.strictEqual(json(inside.value), json(full.value), code);
    }
});

test("ADVERSARIAL: only BARE dir() is in: dir(obj), vars(), locals() and globals() ask, and so does dir() in a cell's own function", { timeout: 60000 }, async (t) => {
    // In a function the proxy has locals, and dir() reads them by item, which is not listed: it asks, where the full path
    // answers ["a"]. An ask, never a different answer.
    if (skip) return t.skip(skip);
    for (const code of [`import pandas as pd\ndir(pd.DataFrame())`, `vars()`, `locals()`, `globals()`, `len(globals())`, `def f(a):\n    return dir()\nf(1)`])
        assert.ok((await cell(code)).refused, code);
});

test("Decimal.quantize raises inside what it raises on the full path (InvalidOperation past the precision)", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    const code = `from decimal import Decimal\nstr(Decimal("1e30").quantize(Decimal("1")))`;
    const inside = await cell(code), full = await cell(code, true);
    assert.match(inside.error ?? "", /InvalidOperation/, JSON.stringify(inside));
    assert.match(full.error ?? "", /InvalidOperation/);
});

test("ADVERSARIAL: quantize through the thread context leaves its flags and traps as they were, and no trap can be enabled", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    await cell(`import decimal\ndecimal.getcontext().clear_flags()\n1`, true);
    const r = await cell(`from decimal import Decimal, getcontext, ROUND_HALF_UP\nstr(Decimal("1.235").quantize(Decimal("0.01"), rounding=ROUND_HALF_UP, context=getcontext()))`);
    assert.strictEqual(json(r.value ?? "null"), json(`"1.24"`), JSON.stringify(r));
    assert.strictEqual(json((await cell(FLAGS, true)).value), "[]");
    for (const code of [`from decimal import Inexact\n1`, `import decimal\ndecimal.getcontext().traps[decimal.Inexact] = True\n1`,
        `import decimal\ndecimal.getcontext().traps`, `import decimal\ndecimal.setcontext(decimal.Context(traps=[decimal.Inexact]))\n1`,
        `import decimal\ndecimal.localcontext()`])
        assert.ok((await cell(code)).refused, code);
    assert.strictEqual(json((await cell(`import decimal\nsorted(k.__name__ for k, v in decimal.getcontext().traps.items() if v)`, true)).value),
        json(`["DivisionByZero","FloatOperation","InvalidOperation","Overflow"]`).replace(',"FloatOperation"', ""));
});

test("ADVERSARIAL: a rounding mode is read, never written: assigning decimal.ROUND_HALF_UP asks, and the module keeps its value", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    for (const code of [`import decimal\ndecimal.ROUND_HALF_UP = "ROUND_DOWN"\n1`, `import decimal\nsetattr(decimal, "ROUND_HALF_UP", "ROUND_DOWN")\n1`])
        assert.ok((await cell(code)).refused, code);
    assert.strictEqual(json((await cell(`import decimal\ndecimal.ROUND_HALF_UP`, true)).value), json(`"ROUND_HALF_UP"`));
});

// python-dialect-buffer-args.test.mjs — an inside cell never writes or reads a file through an admitted call's path or buffer argument.
//
// The fork has no file gate: `open` is a refused builtin, and a lifted leaf that opens a path itself is kept out only by
// the fork's deny-list (restricted._EFFECTFUL) or by window-ml's entry check. DataFrame.to_string(buf=path) was on
// neither and wrote what the cell chose, anywhere (site-packages included), unasked. So this file enumerates every
// callable the gate admits, from load_manifests' own tables, and each parameter that may name a path, a file or a
// buffer is either PROBED live (the call asks, or reads and writes nothing) or listed with a reason. Self-SKIPS without
// the fork core in dist/pyodide, as python-dialect-inside.test.mjs does.
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

/** One cell inside the dialect in a fresh namespace, as the worker runs it: refused, an error, or its value. */
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

const sitePackages = () => String(py.runPython(`import site; site.getsitepackages()[0]`));

// --- to_string(buf=…) writes where the cell says: it asks, by every way of binding buf ---

const TO_STRING = [
    ["DataFrame, buf= a path", (p) => `import pandas as pd\npd.DataFrame({"c": ["X = 41 + 1"]}).to_string(buf=${JSON.stringify(p)}, header=False, index=False)`],
    ["DataFrame, buf positional", (p) => `import pandas as pd\npd.DataFrame({"c": ["X = 41 + 1"]}).to_string(${JSON.stringify(p)})`],
    ["DataFrame, buf through ** spreading", (p) => `import pandas as pd\nk = {"buf": ${JSON.stringify(p)}}\npd.DataFrame({"c": ["y"]}).to_string(**k)`],
    ["DataFrame, buf through * spreading", (p) => `import pandas as pd\na = [${JSON.stringify(p)}]\npd.DataFrame({"c": ["y"]}).to_string(*a)`],
    ["Series (a column), buf= a path", (p) => `import pandas as pd\npd.DataFrame({"c": ["y"]})["c"].to_string(buf=${JSON.stringify(p)}, index=False)`],
    ["Series (a column), buf positional", (p) => `import pandas as pd\npd.DataFrame({"c": ["y"]})["c"].to_string(${JSON.stringify(p)})`],
];

for (const [label, code] of TO_STRING) {
    test(`to_string ASKS and writes nothing: ${label}`, { timeout: 60000 }, async (t) => {
        if (skip) return t.skip(skip);
        for (const target of ["/tmp/ml-buf-probe.txt", `${sitePackages()}/zz_ml_buf_probe.py`]) await cleaning([target], async () => {
            const r = await inside(code(target));
            assert.match(r.refused ?? "", /to_string\(buf=…\) writes to the file or buffer it is given/, `${target}: ${JSON.stringify(r)}`);
            assert.strictEqual(wrote(target), false, `${target} was written`);
        });
    });
}

test("a buffer of the cell's own is not a way round it: io.StringIO is not callable inside, and the rule is buf bound at all", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    const r = await inside(`import io, pandas as pd\nb = io.StringIO()\npd.DataFrame({"c": [1]}).to_string(buf=b)\nb.getvalue()`);
    assert.ok(r.refused, JSON.stringify(r));
});

test("to_string with no buf, or buf=None, still runs inside and gives the string", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    for (const code of [`import pandas as pd\npd.DataFrame({"c": [7]}).to_string(index=False)`,
        `import pandas as pd\npd.DataFrame({"c": [7]}).to_string(None, index=False)`,
        `import pandas as pd\npd.DataFrame({"c": [7]})["c"].to_string(buf=None, index=False)`]) {
        const r = await inside(code);
        assert.ok(r.value && /7/.test(r.value), `${code}: ${JSON.stringify(r)}`);
    }
});

// --- the hard-coded list and the manifest say the same thing, until the data form replaces both ---

test("AGREE: every numpy/pandas leaf the manifest marks as a buffer write is in DIALECT_BUFFER_ARGS, and the reverse", () => {
    // numpy and pandas only: theirs are the kinds load_manifests lifts. manifest-pil.json's Image.save is not a lifted kind.
    const marked = [];
    for (const mod of ["numpy", "pandas"]) {
        for (const [key, row] of Object.entries(JSON.parse(FILES[`manifest-${mod}.json`]).leaves ?? {})) {
            if (!/write\(buffer arg\)/.test(row.effects ?? "")) continue;
            const m = /write\(buffer arg\) when (\w+)= is given/.exec(row.effects);
            assert.ok(m, `${mod} ${key}: a buffer write must name its parameter ("write(buffer arg) when <p>= is given"): ${row.effects}`);
            marked.push([mod, ...key.split("."), m[1]].join(" "));
        }
    }
    assert.deepStrictEqual(marked.sort(), DIALECT_BUFFER_ARGS.map((r) => r.join(" ")).sort());
});

// --- ENUMERATED: every admitted callable's path, file or buffer parameter is probed or has a reason ---

/** Parameter names that may take a path, a file or a buffer. */
const SINK_PARAMS = ["buf", "path", "file", "fname", "fp", "path_or_buf", "path_or_buffer", "excel_writer", "filename", "stream",
    "filepath_or_buffer", "filepath", "f", "io", "target", "dest", "fd"];

/** Each admitted callable with such a parameter: a live probe asserting nothing is read or written, or a reason. */
const SINKS = {
    "DataFrame.to_string": { probe: "to_string's rows above" },
    "Series.to_string": { probe: "to_string's rows above" },
    "builtins.print": {
        probe: () => cleaning(["/tmp/ml-print-probe.txt"], async () => {
            const r = await inside(`print("X = 1", file="/tmp/ml-print-probe.txt")`);
            assert.ok(!r.value || r.refused || r.error, JSON.stringify(r));
            assert.strictEqual(wrote("/tmp/ml-print-probe.txt"), false);
        }),
        why: "file= must have a write method; a cell cannot get a real file (open is refused), only its own StringIO",
    },
    "csv.DictReader": {
        probe: () => cleaning(["/tmp/ml-csv-probe.txt"], async () => {
            py.runPython(`open("/tmp/ml-csv-probe.txt", "w").write("A\\nsecret-content\\n")`);
            const r = await inside(`import csv\n[dict(r) for r in csv.DictReader("/tmp/ml-csv-probe.txt")]`);
            assert.doesNotMatch(JSON.stringify(r), /secret-content/);
        }),
        why: "f is iterated, never opened: a path string is read as its own characters",
    },
    "PIL.Image.open": {
        probe: () => cleaning(["/tmp/ml-pil-probe.png"], async () => {
            py.runPython(`from PIL import Image; Image.new("RGB", (2, 2)).save("/tmp/ml-pil-probe.png")`);
            const r = await inside(`from PIL import Image\nImage.open("/tmp/ml-pil-probe.png").size`);
            assert.ok(r.refused, JSON.stringify(r));
        }),
    },
};

/** Admitted callables whose signature Python cannot read (C builtins with no text signature): each read by hand. */
const NO_SIGNATURE = {
    "builtins.dict": "takes a mapping or pairs", "builtins.dir": "takes an object", "builtins.int": "takes a number or a string",
    "builtins.max": "takes values", "builtins.min": "takes values", "builtins.next": "takes an iterator",
    "builtins.range": "takes integers", "builtins.str": "takes an object", "builtins.type": "takes an object",
    "dict.update": "takes a mapping or pairs", "str.find": "takes a string", "str.index": "takes a string",
    "str.startswith": "takes a string or a tuple of them",
};

/** Every callable the gate admits (load_manifests' tables: builtins, modules' names, kinds' methods), by name, with
 *  its path-like parameters, or `null` when it has no readable signature. A name's leading underscores are dropped:
 *  the worker's prelude rebinds Image.open to a loader shim whose parameter is `_fp`. Restores the setup afterwards. */
async function admitted() {
    const out = py.runPython(`
import inspect, importlib, json, builtins, restricted
done = restricted.load_manifests("/tmp/ml-dialect")
SINK = set(${JSON.stringify(SINK_PARAMS)})
C = {"str": str, "list": list, "dict": dict, "set": set, "tuple": tuple, "int": int, "float": float}
def resolve(mod, dotted):
    o = mod
    for part in dotted.split("."):
        if not hasattr(o, part):
            o = importlib.import_module(o.__name__ + "." + part) if inspect.ismodule(o) else None
            if o is None: return None
        else: o = getattr(o, part)
    return o
items = [("builtins." + n, getattr(builtins, n)) for n in done["calls"]]
for m, names in done["modules"].items():
    mod = importlib.import_module(m)
    items += [(m + "." + n, resolve(mod, n)) for n in names]
for k, names in done["kinds"].items():
    cls = C.get(k) or (restricted._kind_class(*k.split(".")) if "." in k else None)
    for c in (cls if isinstance(cls, tuple) else (cls,)):
        items += [(k.split(".")[-1] + "." + n, getattr(c, n, None)) for n in names if not n.startswith(("[", "__"))]
res = {}
for name, o in items:
    if o is None or not callable(o): continue
    try: res[name] = sorted({p.lstrip("_") for p in inspect.signature(o).parameters} & SINK)
    except (TypeError, ValueError): res[name] = None
json.dumps(res)
`);
    assert.strictEqual(String(await py.runPythonAsync(dialectSetup(FILES))), "");
    return JSON.parse(String(out));
}

test("ENUMERATED: every admitted callable with a path, file or buffer parameter is probed or has a reason; none is new", { timeout: 120000 }, async (t) => {
    if (skip) return t.skip(skip);
    const all = await admitted();
    assert.ok(Object.keys(all).length > 150, `only ${Object.keys(all).length} admitted callables: the enumeration is broken`);
    const sinks = Object.entries(all).filter(([, ps]) => ps?.length).map(([n]) => n).sort();
    assert.deepStrictEqual(sinks, Object.keys(SINKS).sort(), "a callable gained or lost a path-like parameter: probe it, or give its reason");
    const unreadable = Object.entries(all).filter(([, ps]) => ps === null).map(([n]) => n).sort();
    assert.deepStrictEqual(unreadable, Object.keys(NO_SIGNATURE).sort(), "an admitted callable has no signature: read it by hand and list it");
    for (const [name, row] of Object.entries(SINKS)) if (typeof row.probe === "function") await t.test(name, row.probe);
});

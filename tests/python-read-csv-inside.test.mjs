// python-read-csv-inside.test.mjs — `pd.read_csv` INSIDE the read-only dialect (ruling 71, served): a file under /files/
// or a buffer the cell made, parsed into a frame the cell owns, its bytes charged to the budget before it runs.
//
// The checker is `_ml_read_csv_inside` (python-dialect-run.ts). These rows drive it on the real fork core with a /files
// tree made in the interpreter's own file system, so every path rule is judged against real files: what is read, what
// asks, and what raises the error a full run gives. The mount itself, its hidden files and the worker's loader order
// are python-read-csv-worker.test.mjs's. Self-SKIPS without the fork core in dist/pyodide. Genre: python.
import { test, before } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { wrapUserSetup, wrapUserScript, LOADERS_INSTALL } from "../src/python/python-runtime.ts";
import { dialectSetup, DIALECT_READ_CSV_KEYWORDS, DIALECT_READ_CSV_MAX_BYTES, DIALECT_READ_CSV_BYTES_PER_STEP } from "../src/python/python-dialect-run.ts";

const PYODIDE_DIR = path.resolve(import.meta.dirname, "../dist/pyodide");
const DATA_DIR = path.resolve(import.meta.dirname, "../notebooks/python-dialect/data");
const FILES = Object.fromEntries(["whitelist.json", "manifest-stdlib.json", "manifest-numpy.json", "manifest-pandas.json", "manifest-pil.json"]
    .map((f) => [f, fs.readFileSync(path.join(DATA_DIR, f), "utf8")]));
const NODES = JSON.parse(FILES["whitelist.json"]).nodes;
const hasPyodide = fs.existsSync(path.join(PYODIDE_DIR, "pyodide.mjs"));
const CSV = "region,amount\nnorth,1.5\nsouth,2.5\neast,4\n";

let py = null, ns = null;
let skip = hasPyodide ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";

before(async () => {
    if (!hasPyodide) return;
    const { loadPyodide } = await import(path.join(PYODIDE_DIR, "pyodide.mjs"));
    py = await loadPyodide({ indexURL: PYODIDE_DIR });
    if (py.runPython(`import importlib.util; importlib.util.find_spec("_restricted") is None`)) { skip = "dist/pyodide is the stock core, not the restricted-mode fork"; return; }
    await py.loadPackage(["numpy", "pandas", "pillow"]);
    // As the worker does (dialectReason): the loader redirect first, so the setup registers the `pd.read_csv` a cell reaches.
    await py.runPythonAsync("import pandas as pd\nfrom PIL import Image\n" + LOADERS_INSTALL, { globals: py.globals.get("dict")() });
    assert.strictEqual(String(await py.runPythonAsync(dialectSetup(FILES))), "");
    py.globals.set("CSV", CSV);
    py.runPython(`
import os, gzip
for d in ("/files/attached/h1", "/files/agent", "/tmp/elsewhere"):
    os.makedirs(d, exist_ok=True)
for p in ("/files/attached/h1/sales.csv", "/tmp/elsewhere/sales.csv"):
    with open(p, "w") as f:
        f.write(CSV)
with gzip.open("/files/attached/h1/sales.csv.gz", "wt") as f:
    f.write(CSV)
os.symlink("/tmp/elsewhere/sales.csv", "/files/attached/h1/link.csv")
os.chdir("/files/agent")
`);
    ns = py.globals.get("dict")();
    await py.runPythonAsync(wrapUserSetup(false, "run"), { globals: ns });
}, { timeout: 240000 });

/** One cell, inside the dialect or (full) on the full path: refused, an error, or its value as JSON. */
async function cell(code, full = false) {
    for (const k of ["_ml_not_in_dialect", "_err", "_json_result"]) ns.set(k, undefined);
    await py.runPythonAsync(wrapUserScript(code, "run", full ? null : { nodes: NODES }), { globals: ns });
    const refused = ns.get("_ml_not_in_dialect");
    if (refused) return { refused: String(refused) };
    const err = ns.get("_err");
    if (err) return { error: String(err) };
    return { value: JSON.parse(String(ns.get("_json_result"))) };
}

// --- a /files file or the cell's own buffer is read inside, into a frame the cell owns ---

test("a file under /files/ is read inside, by absolute and by relative path", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    for (const src of ["/files/attached/h1/sales.csv", "../attached/h1/sales.csv", "/files/attached/h1/../h1/sales.csv"]) {
        const r = await cell(`import pandas as pd\nt = pd.read_csv(${JSON.stringify(src)})\n[len(t), float(t["amount"].sum())]`);
        assert.deepStrictEqual(r, { value: [3, 8] }, src);
    }
});

test("the frame is the cell's own: a later inside cell edits it and works on it, unasked", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    assert.deepStrictEqual(await cell(`import pandas as pd\nsales = pd.read_csv("/files/attached/h1/sales.csv")\nlen(sales)`), { value: 3 });
    const r = await cell(`sales["double"] = sales["amount"] * 2\nfloat(sales["double"].max())`);
    assert.ok(!r.refused, JSON.stringify(r));
    assert.deepStrictEqual(r, { value: 8 });
});

test("a StringIO or BytesIO the cell made is read inside", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    assert.deepStrictEqual(await cell(`import io, pandas as pd\nlen(pd.read_csv(io.StringIO(${JSON.stringify(CSV)})))`), { value: 3 });
    assert.deepStrictEqual(await cell(`import io, pandas as pd\nlen(pd.read_csv(io.BytesIO(b${JSON.stringify(CSV)})))`), { value: 3 });
});

test("ruling 71's keywords run inside, as the corpus passes them (dtype a builtin type, header, names, index_col, usecols)", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    const src = `"/files/attached/h1/sales.csv"`;
    // The first amount added to itself: text concatenates, a number doubles.
    for (const [kw, want] of [[`dtype=str`, "1.51.5"], [`header=0`, 3], [`usecols=["amount"]`, 3], [`index_col=0`, 3],
        [`names=["r", "amount"], skiprows=1`, 3], [`sep=","`, 3], [`nrows=2`, 3]]) {
        const sum = typeof want === "string" ? "v + v" : "float(v + v)";
        const r = await cell(`import pandas as pd\nt = pd.read_csv(${src}, ${kw})\nv = t["amount"].iloc[0]\n${sum}`);
        assert.deepStrictEqual(r, { value: want }, kw);
    }
});

test("a missing file and a directory raise the error a full run gives, inside, with no card", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    for (const [src, err] of [["/files/attached/h1/nope.csv", /FileNotFoundError/], ["/files/attached/h1", /IsADirectoryError/]]) {
        const inside = await cell(`import pandas as pd\npd.read_csv(${JSON.stringify(src)})`);
        assert.match(inside.error ?? "", err, `${src}: ${JSON.stringify(inside)}`);
        assert.match((await cell(`import pandas as pd\npd.read_csv(${JSON.stringify(src)})`, true)).error ?? "", err);
    }
});

// --- the charge: a parse is paid for before it runs ---

test("the input's bytes are charged to the budget before the parse, and a parse that cannot fit asks with nothing read", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    const steps = (code) => py.runPython(`import restricted, _restricted\nrestricted.run_cell(${JSON.stringify(code)}, {}, frozenset(${JSON.stringify(NODES)}), budget=${10 ** 7})\n_restricted.steps()`);
    const bare = steps(`import pandas as pd\nx = pd.read_csv`);
    const read = steps(`import pandas as pd\nx = pd.read_csv("/files/attached/h1/sales.csv")`);
    assert.ok(read - bare >= Math.ceil(CSV.length / DIALECT_READ_CSV_BYTES_PER_STEP), `charged ${read - bare}`);
    // A budget below the file's charge: refused at the charge, before pandas opens the file.
    const big = "/files/attached/h1/big.csv";
    py.runPython(`with open(${JSON.stringify(big)}, "w") as f:\n    f.write("a\\n" + "1\\n" * 200000)`);
    const tiny = Math.ceil(400002 / DIALECT_READ_CSV_BYTES_PER_STEP) - 1;
    const r = py.runPython(`
import restricted
try:
    restricted.run_cell('import pandas as pd\\nx = pd.read_csv("${big}")', {}, frozenset(${JSON.stringify(NODES)}), budget=${tiny})
    out = "ran"
except restricted.NotInDialect as e:
    out = str(e)
out`);
    assert.match(String(r), /step budget/);
});

// --- what asks: anything outside /files/, anything a path rule could not see through, and every unlisted keyword ---

const SRC = `"/files/attached/h1/sales.csv"`;
const ASKS = [
    ["a path outside /files/", `pd.read_csv("/tmp/elsewhere/sales.csv")`, /outside \/files\//],
    ["/lib", `pd.read_csv("/lib/python3.14/os.py")`, /outside \/files\//],
    ["a path that climbs out of /files/", `pd.read_csv("/files/../tmp/elsewhere/sales.csv")`, /outside \/files\//],
    ["a relative path that climbs out", `pd.read_csv("../../tmp/elsewhere/sales.csv")`, /outside \/files\//],
    ["a link out of /files/", `pd.read_csv("/files/attached/h1/link.csv")`, /through a link/],
    ["an http URL", `pd.read_csv("http://127.0.0.1/sales.csv")`, /URL/],
    ["a file:// URL that names a /files path", `pd.read_csv("file:///files/attached/h1/sales.csv")`, /URL/],
    ["a file:// URL that the cwd would have put under /files/", `pd.read_csv("file:/etc/passwd")`, /URL|outside/],
    ["a ~ path", `pd.read_csv("~/sales.csv")`, /~ path/],
    ["a compressed file", `pd.read_csv("/files/attached/h1/sales.csv.gz")`, /compressed/],
    ["the source given twice", `pd.read_csv(${SRC}, filepath_or_buffer=${SRC})`, /twice/],
    ["a second positional argument", `pd.read_csv(${SRC}, ",")`, /positional/],
    ["no source", `pd.read_csv()`, /no source/],
    ["a callable usecols", `pd.read_csv(${SRC}, usecols=lambda c: True)`, /callable usecols/],
    ["a callable skiprows", `pd.read_csv(${SRC}, skiprows=lambda i: False)`, /callable skiprows/],
    ["a regular-expression separator", `pd.read_csv(${SRC}, sep="\\\\s+")`, /more than one character/],
    ["a regular-expression delimiter", `pd.read_csv(${SRC}, delimiter=",|;")`, /more than one character/],
    ["an unlisted keyword through ** spreading", `pd.read_csv(**{"filepath_or_buffer": ${SRC}, "engine": "python"})`, /engine=/],
    ["a path outside /files/ through ** spreading", `pd.read_csv(**{"filepath_or_buffer": "/tmp/elsewhere/sales.csv"})`, /outside/],
    ["a list as the source", `pd.read_csv(["a", "b"])`, /of a list/],
];
for (const kw of ["chunksize=1", "iterator=True", "converters={}", "engine='python'", "storage_options={}", "memory_map=True",
    "compression='gzip'", "encoding_errors='strict'", "on_bad_lines='skip'", "date_parser=None", "encoding='utf-8'", "low_memory=False"]) {
    ASKS.push([`the unlisted keyword ${kw.split("=")[0]}`, `pd.read_csv(${SRC}, ${kw})`, new RegExp(`with ${kw.split("=")[0]}=`)]);
}

for (const [label, call, why] of ASKS) {
    test(`ADVERSARIAL: asks: ${label}`, { timeout: 60000 }, async (t) => {
        if (skip) return t.skip(skip);
        const r = await cell(`import pandas as pd\n${call}`);
        assert.ok(r.refused, JSON.stringify(r));
        assert.match(r.refused, why);
    });
}

test("ADVERSARIAL: a buffer an approved (full) cell made is not the inside cell's, so reading it asks", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    await cell(`import io\nbuf = io.StringIO(${JSON.stringify(CSV)})\n1`, true);
    const r = await cell(`import pandas as pd\npd.read_csv(buf)`);
    assert.match(r.refused ?? "", /did not make/, JSON.stringify(r));
});

test("ADVERSARIAL: a str that names a /files/ path does not turn a refused source into an admitted one: an open file object asks", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    await cell(`fh = open("/files/attached/h1/sales.csv")\n1`, true);
    const r = await cell(`import pandas as pd\npd.read_csv(fh)`);
    assert.match(r.refused ?? "", /of a TextIOWrapper/, JSON.stringify(r));
});

test("ADVERSARIAL: a file over the cap asks before it is read", { timeout: 120000 }, async (t) => {
    if (skip) return t.skip(skip);
    py.runPython(`with open("/files/attached/h1/huge.csv", "wb") as f:\n    f.truncate(${DIALECT_READ_CSV_MAX_BYTES + 1})`);
    const r = await cell(`import pandas as pd\npd.read_csv("/files/attached/h1/huge.csv")`);
    assert.match(r.refused ?? "", /over 64 MB/, JSON.stringify(r));
    py.runPython(`import os\nos.remove("/files/attached/h1/huge.csv")`);
});

test("ADVERSARIAL: with tables loaded the call asks, since the run's loader may answer with an injected table, not the file", { timeout: 60000 }, async (t) => {
    // The prelude's redirect (python-runtime.ts LOADERS_INSTALL) returns the one loaded table for any name, a /files path
    // included, on the full path too: an injected frame the cell must not be handed as its own.
    if (skip) return t.skip(skip);
    py.runPython(`import __main__, pandas as pd\n__main__._ml_load_ns = {"tables": {"df": pd.DataFrame({"a": [1]})}}`);
    try {
        const r = await cell(`import pandas as pd\npd.read_csv("/files/attached/h1/sales.csv")`);
        assert.match(r.refused ?? "", /tables loaded/, JSON.stringify(r));
    } finally { py.runPython(`import __main__\n__main__._ml_load_ns = None`); }
});

test("ENUMERATED: the admitted keywords are ruling 71's list, exactly", () => {
    assert.deepStrictEqual([...DIALECT_READ_CSV_KEYWORDS].sort(), ["decimal", "delimiter", "dtype", "header", "index_col", "keep_default_na",
        "na_values", "names", "nrows", "parse_dates", "sep", "skiprows", "thousands", "usecols"]);
});

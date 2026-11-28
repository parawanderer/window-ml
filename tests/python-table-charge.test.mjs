// python-table-charge.test.mjs — the step charge of Python `ml.table` INSIDE the read-only dialect, on the real fork core.
//
// docs/spec/ML_TABLE.md, "The charge": the lifted leaf's decode counts no interpreter steps, so `ml.table` bills the
// cell's budget itself, ceil(bytes / ML_TABLE_BYTES_PER_STEP) steps for the source string, the answer's JSON (the
// facade's `_call` meter) and a stored value's bytes. These rows read `_restricted.steps()` after a cell run through
// `wrapUserSetup` + `wrapUserScript(…, inside)` with the fake wire answering. Self-SKIPS without the fork core, as
// python-dialect-inside.test.mjs does.
import { test, before } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { wrapUserSetup, wrapUserScript, injectInputs, ML_TABLE_BYTES_PER_STEP } from "../src/python/python-runtime.ts";
import { dialectSetup } from "../src/python/python-dialect-run.js";
import { PAGE_TABLE_CAPS } from "../src/sw/worker-page-read.ts";

const PYODIDE_DIR = path.resolve(import.meta.dirname, "../dist/pyodide");
const DATA_DIR = path.resolve(import.meta.dirname, "../notebooks/python-dialect/data");
const FILES = Object.fromEntries(["whitelist.json", "manifest-stdlib.json", "manifest-numpy.json", "manifest-pandas.json", "manifest-pil.json"]
    .map((f) => [f, fs.readFileSync(path.join(DATA_DIR, f), "utf8")]));
const NODES = JSON.parse(FILES["whitelist.json"]).nodes;
const hasPyodide = fs.existsSync(path.join(PYODIDE_DIR, "pyodide.mjs"));

let py = null;
let skip = hasPyodide ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";
let budget = 0;
let dialectWhy = "";

// The wire python.test.mjs uses, with one addition: it records the length of each answer it sends, which is the `len(raw)`
// the facade's meter is given, so a row names S exactly instead of re-deriving the JSON.
const WIRE = `
import json as _j, base64 as _b
def _fake(answers_json, g, record):
    answers = _j.loads(answers_json)
    async def send(raw):
        req = _j.loads(raw)
        a = answers.get(req["args"][0]) if req.get("call") == "table" else None
        if a is None:
            out = _j.dumps({"seq": req["seq"], "error": {"code": "Absent", "message": "the test gave no answer for this source"}})
        elif "error" in a:
            out = _j.dumps({"seq": req["seq"], "error": a["error"]})
        else:
            v = _j.loads(_j.dumps(a))
            b = v.pop("b64", None)
            if b is not None:
                name = "_ml_wbuf_%d" % req["seq"]
                g[name] = bytearray(_b.b64decode(b))
                v["data"]["buf"] = name
            out = _j.dumps({"seq": req["seq"], "value": v})
        record(len(out))
        return out
    return send
_fake
`;
let wireMaker = null;

before(async () => {
    if (!hasPyodide) return;
    const { loadPyodide } = await import(path.join(PYODIDE_DIR, "pyodide.mjs"));
    py = await loadPyodide({ indexURL: PYODIDE_DIR });
    if (py.runPython(`import importlib.util; importlib.util.find_spec("_restricted") is None`)) { skip = "dist/pyodide is the stock core, not the restricted-mode fork"; return; }
    await py.loadPackage(["numpy", "pandas", "pillow", "beautifulsoup4", "html5lib"]);
    dialectWhy = String(await py.runPythonAsync(dialectSetup(FILES)));
    budget = Number(py.runPython("import restricted; restricted.DEFAULT_BUDGET"));
    wireMaker = py.runPython(WIRE, { globals: py.toPy({}) });
}, { timeout: 240000 });

/** One cell in a fresh namespace with the fake wire answering `tables`; inside the dialect, or on the full path.
 *  `steps` is what `_restricted.steps()` reads after the cell (the finished run's count inside; the last inside run's, untouched, outside), `sent` the byte length of each answer the wire sent. */
async function run(code, tables, inside = true) {
    const ns = py.globals.get("dict")();
    const sent = [];
    injectInputs(ns, null, undefined);
    const send = wireMaker(JSON.stringify(tables), ns, (n) => sent.push(Number(n)));
    ns.set("_ml_send", send);
    send.destroy();
    await py.runPythonAsync(wrapUserSetup(false, "run"), { globals: ns });
    const before = Number(py.runPython("import _restricted; _restricted.steps()"));
    await py.runPythonAsync(wrapUserScript(code, "run", inside ? { nodes: NODES } : null), { globals: ns });
    const steps = Number(py.runPython("import _restricted; _restricted.steps()"));
    const refused = inside ? ns.get("_ml_not_in_dialect") : undefined;
    const err = ns.get("_err");
    const jr = ns.get("_json_result");
    let value; try { value = JSON.parse(jr); } catch { value = jr; }
    const out = { steps, before, sent, value, refused: refused ? String(refused) : undefined, error: err ? String(err) : undefined };
    ns.destroy();
    return out;
}

/** A `rows` answer, as the page's or the worker's read of a page table gives it. */
const rowsAns = (columns, r) => ({ source: { kind: "dom", label: "table#t" }, data: { kind: "rows", columns, rows: r } });
/** An `html` answer. */
const htmlAns = (html) => ({ source: { kind: "dom", label: "table#t" }, data: { kind: "html", html } });
/** A stored table's answer, its bytes carried for the wire to bind. */
const storedAns = (bytes, data = {}) => ({ source: { kind: "fetch", label: "https://site.test/s.csv" }, data: { kind: "value", label: "s", columns: [], format: "csv", ...data }, b64: Buffer.from(bytes).toString("base64") });
// The spec's rate, written out: a test that read the constant would move with it and pin nothing.
const half = (n) => Math.ceil(n / 2);
const CELL = "df = ml.table('t')\nreturn int(len(df))";

// --- the harness is the real one: a skip must not pass for a run ---

test("the dialect loads, and a tiny rows answer reads inside it with a baseline of a few steps", { timeout: 120000 }, async (t) => {
    if (skip) return t.skip(skip);
    assert.strictEqual(dialectWhy, "");
    assert.strictEqual(budget, 15_000_000, "the budget the spec's arithmetic rests on");
    assert.strictEqual(ML_TABLE_BYTES_PER_STEP, 2, "the rate ML_TABLE.md, \"The charge\", states");
    const r = await run(CELL, { t: rowsAns(["a"], [[1]]) });
    assert.deepStrictEqual([r.refused, r.error, r.value], [undefined, undefined, 1]);
    assert.ok(r.steps > half(r.sent[0]), `the answer's charge ${half(r.sent[0])} is inside the ${r.steps} counted`);
});

// --- a rows answer is paid at ceil(S / 2) steps, on its JSON ---

test("a rows answer of S JSON characters charges ceil(S/2) steps more than a tiny one", { timeout: 120000 }, async (t) => {
    if (skip) return t.skip(skip);
    const small = await run(CELL, { t: rowsAns(["a"], [[1]]) });
    const cells = ["x".repeat(45_000), "y".repeat(45_000)];     // under PAGE_TABLE_CAPS.cell; 20 rows keep the cell's own per-row steps small
    const big = await run(CELL, { t: rowsAns(["a", "b"], Array.from({ length: 20 }, () => cells)) });
    assert.strictEqual(big.value, 20);
    const dS = big.sent[0] - small.sent[0];
    assert.ok(dS > 1_800_000, `S is about 1.8 MB (was ${big.sent[0]})`);
    const dSteps = big.steps - small.steps;
    // The charge is ceil(ΔS/2) exactly; above it, the decode of the answer runs on the cell's own stack and the interpreter
    // counts that work too, a few steps a cell (CELL_STEPS bounds it).
    const dCells = 40 - 1;
    assert.ok(dSteps >= half(dS) && dSteps <= half(dS) + 400 + CELL_STEPS * dCells, `charged ${dSteps} for ΔS=${dS}, expected ${half(dS)} to ${half(dS) + 400 + CELL_STEPS * dCells} (S=${big.sent[0]}, baseline ${small.steps} steps)`);
});

// --- an answer at the page-table HTML cap exhausts the budget on a second call ---
// The frame builder is cheap on purpose: pd.read_html over 16 million characters of HTML takes minutes and gigabytes in a
// test, and the charge is on the answer's JSON, not on what the frame is built from. So the rows are the bytes: 16 columns
// of strings of PAGE_TABLE_CAPS.cell / 10 characters, 100 rows, sized so the JSON is as long as the HTML cap.
const BIG_CELL = PAGE_TABLE_CAPS.cell / 10;
/** The most steps decoding one cell of an answer may count on the cell's stack (measured about 6). */
const CELL_STEPS = 10;
const bigRows = () => {
    const unit = JSON.stringify("z".repeat(BIG_CELL)).length + 2;     // a cell, with its separator
    const cols = 16, nrows = Math.ceil(PAGE_TABLE_CAPS.html / (unit * cols));
    return rowsAns(Array.from({ length: cols }, (_, i) => "c" + i), Array.from({ length: nrows }, () => Array.from({ length: cols }, () => "z".repeat(BIG_CELL))));
};

test("an answer of PAGE_TABLE_CAPS.html characters costs about half of that in steps; a second call in one cell is stopped by the budget", { timeout: 600000 }, async (t) => {
    if (skip) return t.skip(skip);
    const ans = bigRows();
    const one = await run("df = ml.table('t')\nreturn int(len(df))", { t: ans });
    assert.deepStrictEqual([one.refused, one.error], [undefined, undefined]);
    const S = one.sent[0];
    assert.ok(S >= PAGE_TABLE_CAPS.html, `the answer is at the cap: ${S}`);
    const nCells = ans.data.rows.length * ans.data.columns.length;
    assert.ok(one.steps >= half(S) && one.steps <= half(S) + 5000 + CELL_STEPS * nCells, `one call counted ${one.steps} steps for S=${S} (${nCells} cells), expected ${half(S)} to ${half(S) + 5000 + CELL_STEPS * nCells}`);
    assert.ok(one.steps < budget, "one call fits");
    const two = await run("a = ml.table('t')\nb = ml.table('t')\nreturn 1", { t: ans });
    assert.strictEqual(two.value, null, "the second call returned nothing");
    assert.match(String(two.refused), /^not in dialect: the step budget \(15000000\) ran out/, `the cell was stopped by the budget (steps ${two.steps}, error ${two.error})`);
});

// --- the same answer outside the dialect is not charged ---

test("read outside the dialect, the same big answer is not stopped and nothing is charged", { timeout: 600000 }, async (t) => {
    if (skip) return t.skip(skip);
    const ans = bigRows();
    const r = await run("a = ml.table('t')\nb = ml.table('t')\nreturn [int(len(a)), int(len(b))]", { t: ans }, false);
    assert.strictEqual(r.error, undefined);
    assert.strictEqual(r.value[0], r.value[1]);
    assert.ok(r.value[0] > 0);
    assert.strictEqual(r.steps, r.before, "no inside run happened, so no step was counted or charged");
});

// --- a stored value's bytes are paid on top of the JSON ---

test("a stored value's bytes are charged ceil(len/2) beside its JSON", { timeout: 120000 }, async (t) => {
    if (skip) return t.skip(skip);
    const body = (n) => "a,b\n" + "1,2\n".repeat(n);
    const small = await run(CELL, { t: storedAns(body(1), { columns: ["a", "b"] }) });
    const bigBytes = body(200_000);
    const big = await run(CELL, { t: storedAns(bigBytes, { columns: ["a", "b"] }) });
    assert.strictEqual(big.value, 200_000);
    // The JSON carries the bytes' base64 only through the wire's `b64`, which it pops: the answer's JSON is the same size.
    const dJson = big.sent[0] - small.sent[0];
    const dBytes = bigBytes.length - body(1).length;
    const dSteps = big.steps - small.steps;
    assert.ok(Math.abs(dSteps - (half(dJson) + half(dBytes))) <= 500, `charged ${dSteps}; expected ${half(dBytes)} ± 500 for ${dBytes} bytes + ${half(dJson)} for ΔJSON ${dJson}`);
    assert.ok(dSteps > half(dBytes) - 500, "the bytes alone account for their charge");
});

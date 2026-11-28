// redteam-python-table.test.mjs — RED TEAM: what a hostile CELL must not get from `ml.table` (ML_TABLE.md, "Red
// team", rule 10). The builder's rows (python-table-charge, python-table-sources, python-table-inside) measure what
// the member does; these probe the cell's side of the gate: whether the charge follows the FUNCTION rather than the
// name it is called by, whether a source that is not a string reaches the wire at all, whether a cell can plant the
// bytes a stored table's frame will read, what an earlier cell's facade can still do, and whether a read can be made
// to resolve with no cell stack to charge.
//
// Drives the worker's own wrapper as python-table-charge.test.mjs does, with the fake wire answering; self-SKIPS
// without the fork core in dist/pyodide.
import { test, before } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { wrapUserSetup, wrapUserScript, injectInputs } from "../src/python/python-runtime.ts";
import { dialectSetup } from "../src/python/python-dialect-run.ts";

const PYODIDE_DIR = path.resolve(import.meta.dirname, "../dist/pyodide");
const DATA_DIR = path.resolve(import.meta.dirname, "../notebooks/python-dialect/data");
const FILES = Object.fromEntries(["whitelist.json", "manifest-stdlib.json", "manifest-numpy.json", "manifest-pandas.json", "manifest-pil.json"]
    .map((f) => [f, fs.readFileSync(path.join(DATA_DIR, f), "utf8")]));
const NODES = JSON.parse(FILES["whitelist.json"]).nodes;
const hasPyodide = fs.existsSync(path.join(PYODIDE_DIR, "pyodide.mjs"));

let py = null;
let skip = hasPyodide ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";

// The fake wire: it answers the source it is asked for, binds a stored answer's bytes under the name the real worker
// binds (`_ml_wbuf_<seq>`), and records each answer's length — the `len(raw)` the facade meters.
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
                g["_ml_wbuf_%d" % req["seq"]] = bytearray(_b.b64decode(b))
                v["data"]["buf"] = "_ml_wbuf_%d" % req["seq"]
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
    assert.strictEqual(await py.runPythonAsync(dialectSetup(FILES)), "");
    wireMaker = py.runPython(WIRE, { globals: py.toPy({}) });
}, { timeout: 240000 });

/**
 * One kept-namespace run of one or more cells, each inside the dialect. `pre` names Python expressions whose values
 * are bound in the namespace before the first cell (a cell's guess at a buffer name). Reports per cell: its refusal,
 * error or value, and the steps the run counted (the charge paid on the cell's own stack).
 */
async function cells(list, tables, pre = {}) {
    const ns = py.globals.get("dict")();
    const sent = [];
    injectInputs(ns, null, undefined);
    const send = wireMaker(JSON.stringify(tables), ns, (n) => sent.push(Number(n)));
    ns.set("_ml_send", send);
    send.destroy();
    await py.runPythonAsync(wrapUserSetup(false, "run"), { globals: ns });
    for (const [name, expr] of Object.entries(pre)) {
        const v = py.runPython(expr);
        ns.set(name, v);
        v.destroy();
    }
    const out = [];
    for (const code of list) {
        py.runPython('globals().pop("_ml_not_in_dialect", None)', { globals: ns });
        await py.runPythonAsync(wrapUserScript(code, "run", { nodes: NODES }), { globals: ns });
        const refused = ns.get("_ml_not_in_dialect");
        const err = ns.get("_err");
        const jr = ns.get("_json_result");
        let value; try { value = JSON.parse(jr); } catch { value = jr; }
        out.push({ refused: refused ? String(refused) : undefined, error: err ? String(err) : undefined, value,
            steps: Number(py.runPython("import _restricted; _restricted.steps()")), sent: [...sent] });
    }
    ns.destroy();
    return out;
}

/** A `rows` answer. */
const rowsAns = (columns, r) => ({ source: { kind: "dom", label: "table#t" }, data: { kind: "rows", columns, rows: r } });
/** A stored table's answer, its bytes carried for the wire to bind. */
const storedAns = (bytes, data = {}) => ({ source: { kind: "fetch", label: "https://site.test/s.csv" }, data: { kind: "value", label: "s", columns: [], format: "csv", ...data }, b64: Buffer.from(bytes).toString("base64") });
const half = (n) => Math.ceil(n / 2);

// --- the charge follows the registered function, not the name it is called through --------------------------------

// `_ml_table_inside` registers `type(ml).__dict__["table"].__func__` with `allow_call(…, _check)`, and `_check`
// charges ceil(len(src) / ML_TABLE_BYTES_PER_STEP) for the source. So a source long enough makes the leaf's own charge
// dominate the answer's: a call that ran the leaf without its check shows a few dozen steps. The cell's cheapest way
// to call the leaf the gate did not see made is to detach it first, and the dialect refuses that outright — a name
// holding a function or class is not something it can vouch for — so the charge is pinned on the direct call.
const LONG = "t" + "." + "x".repeat(4000);
test("RED TEAM (ml.table): the leaf cannot be detached to dodge its charge, and the direct call pays it", { timeout: 120000 }, async (t) => {
    if (skip) return t.skip(skip);
    const direct = "df = ml.table(SRC)\nreturn int(len(df))";
    const [d, f] = await cells([direct.replace("SRC", JSON.stringify(LONG)), "f = ml.table\ndf = f(" + JSON.stringify(LONG) + ")\nreturn int(len(df))"], { [LONG]: rowsAns(["a"], [[1]]) });
    assert.strictEqual(d.refused, undefined, `the direct call must run inside: ${d.refused}`);
    assert.strictEqual(d.value, 1, `the answer must arrive: ${d.error ?? ""}`);
    assert.ok(d.steps > half(LONG.length), `the source's own charge (${half(LONG.length)} steps) is not in the direct call's ${d.steps}`);
    assert.match(String(f.refused), /leaves 'f' holding a function or class/, `a cell detached the leaf: ${JSON.stringify({ refused: f.refused, value: f.value })}`);
});

// The leaf reached through its own dunders, and the facade reached from the bound method: each must be refused or
// charged, never a way to the transport that skips both. `ml.table.__self__` is the facade, and a cell that holds it
// holds nothing the gate does not admit: the wire function it wraps is not `ml`.
test("RED TEAM (ml.table): the leaf's dunders and the facade behind it give no uncharged way to call", { timeout: 120000 }, async (t) => {
    if (skip) return t.skip(skip);
    for (const code of [
        "f = ml.table\nreturn repr(f.__func__)",
        "f = ml.table\nreturn repr(f.__self__)",
        "f = ml.table\nreturn repr(ml.__class__)",
        "f = ml.table\nreturn repr(f.__self__.__dict__)",
        "return repr(type(ml).__dict__['table'])",
    ]) {
        const [r] = await cells([code], { t: rowsAns(["a"], [[1]]) });
        assert.ok(r.refused, `${JSON.stringify(code)}\nran inside: ${JSON.stringify({ value: r.value, error: r.error })}`);
    }
    // The unbound call is the one shape that could bypass a bound-method rule: it must still be the registered leaf.
    const [u] = await cells(["f = type(ml).__dict__['table'].__func__\ndf = f(ml, 't')\nreturn int(len(df))"], { t: rowsAns(["a"], [[1]]) });
    assert.ok(u.refused || u.steps > 100, `the unbound call ran uncharged: ${JSON.stringify({ refused: u.refused, steps: u.steps, value: u.value })}`);
});

// --- a source that is not a string never reaches the wire ------------------------------------------

// The check charges a non-str source 1 step (`_charge(1)`), so a cell that hands over an object with a huge `__len__`
// pays nothing for it. The property is that such a source is refused BEFORE any call — a TypeError from the member, or
// a refusal by the dialect for an argument it cannot vouch for — so the object is never serialised and the wire never
// sees it, whatever the refusal's shape.
test("RED TEAM (ml.table): a non-string source never reaches the wire, whatever it looks like", { timeout: 120000 }, async (t) => {
    if (skip) return t.skip(skip);
    for (const expr of ["['t']", "('t',)", "123", "None", "b't'", "object()", "{'t': 1}"]) {
        const [r] = await cells([`return ml.table(${expr})`], { t: rowsAns(["a"], [[1]]) });
        assert.ok(r.refused || (r.error && /TypeError/.test(r.error)), `ml.table(${expr}) was neither refused nor a TypeError: ${JSON.stringify({ refused: r.refused, error: r.error, value: r.value })}`);
        assert.deepStrictEqual(r.sent, [], `ml.table(${expr}) reached the wire`);
    }
});

// --- a cell cannot plant the bytes a stored table's frame will read --------------------------------

// The worker binds a stored answer's bytes under `_ml_wbuf_<seq>` and `_ml_table_frame` pops that name and charges it.
// A cell that guesses the name first must not have its own bytes read — and, more to the point, must not get an
// uncharged decode: the charge is on what the frame actually read, so the answer's size is paid either way.
test("RED TEAM (ml.table): a cell's guess at the buffer name does not replace the bytes the worker bound", { timeout: 120000 }, async (t) => {
    if (skip) return t.skip(skip);
    const csv = "a,b\n1,2\n3,4\n";
    const pre = Object.fromEntries([1, 2, 3].map((n) => [`_ml_wbuf_${n}`, `bytearray(b"a,b\\n9,9\\n9,9\\n9,9\\n")`]));
    // The answer's CSV has a header and two rows; the planted one a header and three, so the length tells them apart.
    const [r] = await cells(["df = ml.table('s')\nreturn int(len(df))"], { s: storedAns(csv) }, pre);
    assert.strictEqual(r.refused, undefined, `the read must run inside: ${r.refused}`);
    assert.strictEqual(r.error, undefined, `the read raised: ${r.error}`);
    assert.strictEqual(r.value, 2, `the frame read bytes the cell planted: ${JSON.stringify(r.value)}`);
    assert.ok(r.steps > half(csv.length), `the bound bytes' charge is not in the ${r.steps} counted`);
});

// --- an earlier cell's facade is not a budget the next cell inherits -------------------------------

// A worker-hosted run keeps one namespace across cells, so cell 1's `_facade = ml` is still in cell 2's reach. Its
// class was admitted only in cell 1's registry, so the call is not lifted in cell 2 and never reaches the wire (measured
// on the pinned core: refused, "a refusal during the run was caught by library code", no request sent). The control is
// cell 2's own facade, which must read and be charged.
test("RED TEAM (ml.table): a facade kept from an earlier cell never reaches the wire in the next", { timeout: 120000 }, async (t) => {
    if (skip) return t.skip(skip);
    const src = "t" + "." + "y".repeat(2000);
    const [c1, c2, c3] = await cells([
        "_facade = ml\nreturn 1",
        "_df = _facade.table(" + JSON.stringify(src) + ")\nreturn int(len(_df))",
        "df = ml.table(" + JSON.stringify(src) + ")\nreturn int(len(df))",
    ], { [src]: rowsAns(["a"], [[1]]) });
    assert.strictEqual(c1.value, 1, `cell 1 must run: ${c1.refused ?? c1.error ?? ""}`);
    assert.ok(c2.refused, `the kept facade was not refused: ${JSON.stringify({ value: c2.value, error: c2.error, sent: c2.sent })}`);
    assert.deepStrictEqual(c2.sent, [], "the kept facade's call reached the wire");
    assert.strictEqual(c3.value, 1, `cell 2's own facade must read: ${c3.refused ?? c3.error ?? ""}`);
    assert.ok(c3.steps > half(src.length), `cell 2's own read was not charged: ${c3.steps}`);
});

// --- the charge always lands on the cell's own stack ----------------------------------------------

// The answer's charge is made after the awaited chain returns, on the cell's stack (ML_TABLE.md, "The charge"): inside
// `run_sync` the event loop counts nothing. So a read that resolved with no cell stack above it would be free. The way
// to get one is to schedule the call and leave: a task, a thread, a finalizer. Every primitive that could do that is
// outside the dialect, so the cell can only call the leaf on its own stack, where it pays. The control is a direct
// call, which does pay.
test("RED TEAM (ml.table): a cell cannot schedule the read off its own stack, so it always pays there", { timeout: 120000 }, async (t) => {
    if (skip) return t.skip(skip);
    for (const mod of ["asyncio", "threading", "_thread", "concurrent", "gc", "weakref", "atexit", "js"]) {
        const [r] = await cells([`import ${mod}\nreturn 1`], {});
        assert.match(String(r.refused), new RegExp(`import '${mod}'`), `a cell imported ${mod}: ${JSON.stringify({ refused: r.refused, value: r.value })}`);
    }
    const src = "t" + "." + "z".repeat(2000);
    const [c] = await cells(["df = ml.table(" + JSON.stringify(src) + ")\nreturn int(len(df))"], { [src]: rowsAns(["a"], [[1]]) });
    assert.strictEqual(c.value, 1, `the direct call must run inside: ${c.refused ?? c.error ?? ""}`);
    assert.ok(c.steps > half(src.length), `the direct call paid ${c.steps} for a ${half(src.length)}-step source`);
});

// REAL-CPython tests for the python_exec sandbox runtime — Pyodide-in-Node exercising the exact
// PRELUDE + wrapper the offscreen document runs (python-runtime.ts → dist/python-runtime.js), so
// the drift-prone Python (tables→DataFrame building, numeric auto-cast, the `tables` dict, read_html
// fallback, return/stdout/traceback capture, per-run isolation) is verified against actual pandas —
// not a re-implementation. Opt-in: needs the bundled wheels (dist/pyodide/, from `npm run
// fetch-pyodide`); self-SKIPS when absent (so a bundle-less `npm test` stays green). CI fetches them.
const { test, before } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");

const PYODIDE_DIR = path.resolve(__dirname, "../dist/pyodide");
const hasPyodide = fs.existsSync(path.join(PYODIDE_DIR, "pyodide.mjs"));
const skip = hasPyodide ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";
const { wrapUserCode, harden, unharden } = hasPyodide ? require("../dist/python-runtime.js") : {};

let py = null;
before(async () => {
    if (!hasPyodide) return;
    const { loadPyodide } = await import(path.join(PYODIDE_DIR, "pyodide.mjs"));
    py = await loadPyodide({ indexURL: PYODIDE_DIR });
    // The PRELUDE imports numpy/PIL/pandas; read_html needs bs4 + html5lib. (scipy is load-only in
    // the real sandbox and unused by the prelude, so it's skipped here.)
    await py.loadPackage(["numpy", "pillow", "pandas", "beautifulsoup4", "html5lib"]);
}, { timeout: 180000 });

// Mirror offscreen.run(): set the injected globals, (optionally harden), run the wrapped script,
// read back the result. `hardened` applies the REAL readonly-mode hardening (harden/unharden) so
// the escape tests hit the shipped code — restored in `finally` so a null'd global can't leak to
// the next test (which runs serially).
async function pyRun(code, { tables = null, image = null, hardened = false } = {}) {
    py.globals.set("INJECTED_IMAGE_B64", image);
    py.globals.set("INJECTED_TABLES_JSON", Array.isArray(tables) && tables.length ? JSON.stringify(tables) : null);
    const saved = hardened ? harden(py) : null;
    try { await py.runPythonAsync(wrapUserCode(code)); }
    finally { if (saved) unharden(py, saved); }
    const stdout = String(py.globals.get("_stdout") ?? "");
    if (py.globals.get("_err")) return { ok: false, stdout, error: String(py.globals.get("_err")) };
    const jr = py.globals.get("_json_result");
    let value; try { value = JSON.parse(jr); } catch { value = jr; }
    return { ok: true, value, stdout };
}
const rows = (name, columns, r) => ({ name, data: { kind: "rows", columns, rows: r } });

test("tables map: each df binds under its name AND in tables[name]; numeric columns auto-typed", { skip }, async () => {
    const r = await pyRun(
        "return [int(sales['Q1'].sum()), int(tables['sales']['Q1'].sum()), str(sales['Q1'].dtype)]",
        { tables: [rows("sales", ["Rep", "Q1"], [["Ada", 120], ["Ben", 90]])] });
    // Both the bare var and the tables dict resolve; Q1 arrives as int64 so .sum() adds (not concat).
    assert.deepEqual(r.value, [210, 210, "int64"]);
});

test("tables map: two sources join with pd.merge under their own names", { skip }, async () => {
    const r = await pyRun("return pd.merge(sales, targets, on='Rep')['Q1'].tolist()", {
        tables: [rows("sales", ["Rep", "Q1"], [["Ada", 120], ["Ben", 90]]),
                 rows("targets", ["Rep", "Goal"], [["Ada", 100], ["Ben", 200]])],
    });
    assert.deepEqual(r.value, [120, 90]);
});

test("html-kind source falls back to pd.read_html", { skip }, async () => {
    const html = "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>";
    const r = await pyRun("return int(df['A'].iloc[0]) + int(df['B'].iloc[0])",
        { tables: [{ name: "df", data: { kind: "html", html } }] });
    assert.equal(r.value, 3);
});

test("ragged rows pad to the header width (DataFrame can't choke)", { skip }, async () => {
    const r = await pyRun("return bool(pd.isna(df.iloc[0, 2]))",
        { tables: [rows("df", ["A", "B", "C"], [[1, 2]])] });   // only 2 cells for a 3-col header
    assert.equal(r.value, true);
});

test("captures a `return` value AND a bare top-level `result =`", { skip }, async () => {
    assert.equal((await pyRun("return 6 * 7")).value, 42);
    assert.equal((await pyRun("result = 6 * 7")).value, 42);   // no return → the assigned global survives
});

test("stdout is captured byte-exact; the value comes back alongside", { skip }, async () => {
    const r = await pyRun("print('line1')\nprint('line2')\nreturn 9");
    assert.equal(r.stdout, "line1\nline2\n");
    assert.equal(r.value, 9);
});

test("a runtime error returns ok:false with the traceback (partial stdout preserved)", { skip }, async () => {
    const r = await pyRun("print('before')\nreturn 1 / 0");
    assert.equal(r.ok, false);
    assert.match(r.error, /ZeroDivisionError/);
    assert.equal(r.stdout, "before\n");
});

test("per-run RESET isolates the namespace — a prior run's table global doesn't leak", { skip }, async () => {
    await pyRun("return 1", { tables: [rows("leaked", ["A"], [[1]])] });
    const r = await pyRun("return 'leaked' in globals()");   // next call, no tables
    assert.equal(r.value, false);
});

test("no injected image → img/img_np are None", { skip }, async () => {
    assert.deepEqual((await pyRun("return [img is None, img_np is None]")).value, [true, true]);
});

// ---- readonly-mode sandbox hardening: a script CANNOT escape to the outside world ----
// These are the security invariant that makes `python_exec` auto-approvable. Run against real
// Pyodide via the shipped harden()/unharden() (python-runtime.ts).

test("FULL mode leaves the js bridge intact (this is exactly why full-mode always asks for approval)", { skip }, async () => {
    const r = await pyRun("import js\nreturn hasattr(js, 'fetch')");   // not hardened
    assert.equal(r.ok, true);
    assert.equal(r.value, true, "js.fetch is reachable → network is open in full mode");
});

test("hardened: `import js` / `import pyodide_js` fail — the JS/network bridge is severed", { skip }, async () => {
    const r = await pyRun("import js\nreturn js.fetch", { hardened: true });
    assert.equal(r.ok, false);
    assert.match(r.error, /No module named 'js'/);
    assert.match((await pyRun("import pyodide_js\nreturn 1", { hardened: true })).error, /No module named 'pyodide_js'/);
});

test("hardened: the pyodide.code.run_js escape hatch is unreachable too", { skip }, async () => {
    // run_js would execute JS in the page's global scope — hardening blocks reaching it at all.
    const r = await pyRun("from pyodide.code import run_js\nreturn run_js('1 + 1')", { hardened: true });
    assert.equal(r.ok, false, "run_js can't be reached to execute JS / touch a nulled global");
});

test("hardened: a cached `import js` from a prior FULL run is PURGED (not just unregistered)", { skip }, async () => {
    await pyRun("import js\nreturn 1");                                   // full run caches js in sys.modules
    const r = await pyRun("import js\nreturn 1", { hardened: true });     // the cache-leak fix
    assert.match(r.error, /No module named 'js'/, "sys.modules purge closes the leak an unregister alone leaves open");
});

test("unharden restores the bridge — a later FULL run can import js again", { skip }, async () => {
    await pyRun("import js\nreturn 1", { hardened: true });   // harden + unharden (finally)
    assert.equal((await pyRun("import js\nreturn 1")).ok, true, "the swap is fully reversible");
});

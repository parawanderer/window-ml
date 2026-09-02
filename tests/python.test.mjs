// REAL-CPython tests for the python_exec sandbox runtime — Pyodide-in-Node exercising the exact
// PRELUDE + wrapper the offscreen document runs (python-runtime.ts), so
// the drift-prone Python (tables→DataFrame building, numeric auto-cast, the `tables` dict, read_html
// fallback, return/stdout/traceback capture, per-run isolation) is verified against actual pandas —
// not a re-implementation. Opt-in: needs the bundled wheels (dist/pyodide/, from `npm run
// fetch-pyodide`); self-SKIPS when absent (so a bundle-less `npm test` stays green). CI fetches them.
import { test, before, after } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
// Static (not conditional-require) — python-runtime.ts is chrome-free and side-effect-free,
// so importing it costs nothing when the wheels are absent; `skip` still gates every test.
import { wrapUserCode, harden, unharden } from "../python-runtime.ts";
// For the sympy→UI INTEGRATION test: the sidebar app (jsdom) to render the real WASM output. CommonJS helper.
const { loadSidebarWorld, closeSidebarWorlds } = createRequire(import.meta.url)("./helpers");
after(closeSidebarWorlds);   // close jsdom windows so their timers don't keep the runner alive (the leak gotcha)

const PYODIDE_DIR = path.resolve(import.meta.dirname, "../dist/pyodide");
const hasPyodide = fs.existsSync(path.join(PYODIDE_DIR, "pyodide.mjs"));
const skip = hasPyodide ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";

let py = null;
before(async () => {
    if (!hasPyodide) return;
    const { loadPyodide } = await import(path.join(PYODIDE_DIR, "pyodide.mjs"));
    py = await loadPyodide({ indexURL: PYODIDE_DIR });
    // The PRELUDE imports numpy/PIL/pandas; read_html needs bs4 + html5lib. (scipy is load-only in
    // the real sandbox and unused by the prelude, so it's skipped here.)
    await py.loadPackage(["numpy", "pillow", "pandas", "beautifulsoup4", "html5lib", "sympy"]);
}, { timeout: 180000 });

// Mirror offscreen.run(): set the injected globals, (optionally harden), run the wrapped script,
// read back the result. `hardened` applies the REAL readonly-mode hardening (harden/unharden) so
// the escape tests hit the shipped code — restored in `finally` so a null'd global can't leak to
// the next test (which runs serially).
async function pyRun(code, { tables = null, image = null, hardened = false } = {}) {
    py.globals.set("INJECTED_IMAGE_B64", image);
    py.globals.set("INJECTED_TABLES_JSON", Array.isArray(tables) && tables.length ? JSON.stringify(tables) : null);
    const saved = hardened ? harden(py) : null;
    try { await py.runPythonAsync(wrapUserCode(code, hardened)); }
    finally { if (saved) unharden(py, saved); }
    const stdout = String(py.globals.get("_stdout") ?? "");
    if (py.globals.get("_err")) return { ok: false, stdout, error: String(py.globals.get("_err")) };
    const jr = py.globals.get("_json_result");
    let value; try { value = JSON.parse(jr); } catch { value = jr; }
    const tj = py.globals.get("_json_table");
    let table; if (typeof tj === "string") { try { table = JSON.parse(tj); } catch { /* */ } }
    const rh = py.globals.get("_json_render");
    const render = rh === "latex" || rh === "img" ? rh : undefined;
    return { ok: true, value, stdout, table, render };
}
const rows = (name, columns, r) => ({ name, data: { kind: "rows", columns, rows: r } });

test("tables map: each df binds under its name AND in tables[name]; numeric columns auto-typed", { skip }, async () => {
    const r = await pyRun(
        "return [int(sales['Q1'].sum()), int(tables['sales']['Q1'].sum()), str(sales['Q1'].dtype)]",
        { tables: [rows("sales", ["Rep", "Q1"], [["Ada", 120], ["Ben", 90]])] });
    // Both the bare var and the tables dict resolve; Q1 arrives as int64 so .sum() adds (not concat).
    assert.deepEqual(r.value, [210, 210, "int64"]);
});

test("single source aliases into tables[<source>] too (a model that passed 'current' → tables['current'])", { skip }, async () => {
    // A single source is loaded as `df`; the `alias` (the raw source string) also keys the tables dict,
    // so tables['current'] resolves to the same df — accommodating the natural mirror of the passed arg.
    const r = await pyRun(
        "return [int(df['Q1'].sum()), int(tables['current']['Q1'].sum()), tables['current'] is df]",
        { tables: [{ ...rows("df", ["Rep", "Q1"], [["Ada", 120], ["Ben", 90]]), alias: "current" }] });
    assert.deepEqual(r.value, [210, 210, true]);
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

test("a bare TRAILING EXPRESSION is the return value (Jupyter/REPL-style: `df` == `return df`)", { skip }, async () => {
    assert.equal((await pyRun("6 * 7")).value, 42, "a lone expression is the result");
    // Statements then a trailing expression — the expression wins, like a notebook cell.
    assert.equal((await pyRun("x = 6\ny = 7\nx * y")).value, 42);
    // Equivalent to the explicit return.
    const bare = await pyRun("import pandas as pd\ndf = pd.DataFrame({'a': [1, 2]})\ndf['a'].sum()");
    const ret = await pyRun("import pandas as pd\ndf = pd.DataFrame({'a': [1, 2]})\nreturn df['a'].sum()");
    assert.equal(bare.value, 3);
    assert.deepEqual(bare.value, ret.value, "bare trailing expr === explicit return");
});

test("a returned DataFrame is ALSO serialized structurally ({columns, rows}) for a real-table render", { skip }, async () => {
    const r = await pyRun("import pandas as pd\ndf = pd.DataFrame({'foo': [1, 2, 3], 'bar': [4, 5, 6]})\ndf");
    assert.ok(r.table, "a df return yields a structural table");
    assert.deepEqual(r.table.columns, ["foo", "bar"]);
    assert.deepEqual(r.table.rows, [[1, 4], [2, 5], [3, 6]]);
    // A non-df return has no table.
    assert.equal((await pyRun("return 42")).table, undefined);
    // A Series becomes a 1-column frame.
    const s = await pyRun("import pandas as pd\npd.Series([10, 20], name='v')");
    assert.deepEqual(s.table.columns, ["v"]);
    assert.deepEqual(s.table.rows, [[10], [20]]);
});

test("a trailing statement that ISN'T an expression is untouched (no bogus return)", { skip }, async () => {
    // print(...) returns None, so a trailing print stays value-less (stdout only), not `return None` noise.
    const r = await pyRun("print('hi')");
    assert.equal(r.value, null);
    assert.equal(r.stdout, "hi\n");
    // A trailing assignment isn't an expression → no capture (unless it's the `result =` convention).
    assert.equal((await pyRun("z = 5")).value, null);
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

// ---- readonly network policy (DX): a fetch gives ONE clear error, not a socket traceback ----

test("readonly: urllib.request.urlopen raises the clean extension error, not a raw socket traceback", { skip }, async () => {
    const r = await pyRun("import urllib.request\nurllib.request.urlopen('http://example.com/data.csv')", { hardened: true });
    assert.equal(r.ok, false);
    assert.match(r.error, /network is disabled in readonly python_exec/);
    assert.doesNotMatch(r.error, /create_connection|Host is unreachable/, "no 40-line socket traceback");
});

test("readonly: pandas read_csv(url) hits the SAME clean error (the funnel is OpenerDirector.open)", { skip }, async () => {
    const r = await pyRun("import pandas as pd\nreturn pd.read_csv('http://example.com/data.csv')", { hardened: true });
    assert.equal(r.ok, false);
    assert.match(r.error, /network is disabled in readonly python_exec/, "the patch catches pandas' urlopen regardless of how it imported it");
});

test("full mode installs the working fetch (NOT the readonly block) — no leak between modes", { skip }, async () => {
    await pyRun("x = 1", { hardened: true });   // a readonly run installs the block
    const r = await pyRun("import urllib.request\nreturn urllib.request.OpenerDirector.open.__name__", { hardened: false });
    assert.equal(r.ok, true);
    assert.equal(r.value, "_ml_working_open", "full mode routes urllib through the working (open_url) fetch, not _ml_blocked_open");
});

test("full mode: pd.read_csv(url) actually works — urllib routed through pyodide.http.open_url", { skip }, async () => {
    // node-pyodide has no XMLHttpRequest, so mock open_url to a StringIO; this exercises the response
    // shim + the whole pandas → urllib → OpenerDirector.open → open_url pipeline.
    const r = await pyRun(
        "import io, pyodide.http\n" +
        "pyodide.http.open_url = lambda u: io.StringIO('a,b\\n1,2\\n3,4\\n')\n" +
        "import pandas as pd\n" +
        "return pd.read_csv('http://example.com/data.csv').to_dict('records')",
        { hardened: false });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.value, [{ a: 1, b: 2 }, { a: 3, b: 4 }]);
});

test("full mode: a failed fetch raises a clear host-permissions error (not a raw JS/CORS dump)", { skip }, async () => {
    const r = await pyRun(
        "import pyodide.http\n" +
        "def _boom(u):\n    raise Exception('NetworkError: CORS')\n" +
        "pyodide.http.open_url = _boom\n" +
        "import pandas as pd\n" +
        "return pd.read_csv('http://example.com/data.csv')",
        { hardened: false });
    assert.equal(r.ok, false);
    assert.match(r.error, /full-mode fetch of .* failed/);
    assert.match(r.error, /site access \/ host permissions/);
});

// --- Loader interception: the model's Image.open(selector)/read_csv(name) habits resolve to the
// pre-loaded img/df instead of throwing FileNotFoundError and burning a turn. ------------------
const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("loader: Image.open(selector) returns the pre-loaded img (no filesystem to hit)", { skip }, async () => {
    // The exact observed failure: Image.open('canvas#stage'). Any str → the loaded img (identity).
    const r = await pyRun("return [Image.open('canvas#stage') is img, Image.open('#foo') is img]", { image: TINY_PNG });
    assert.deepEqual(r.value, [true, true]);
});

test("loader: with NO image loaded, Image.open falls through (nothing to redirect to)", { skip }, async () => {
    const r = await pyRun("return Image.open('#x')");   // no image injected → original runs → errors
    assert.equal(r.ok, false);
});

test("loader: Image.open(BytesIO(...)) is NOT hijacked — a real file-like still opens", { skip }, async () => {
    // A non-str arg passes straight to the original, even with an image loaded.
    const r = await pyRun("import io\nreturn Image.open(io.BytesIO(base64.b64decode(INJECTED_IMAGE_B64.split(',')[-1]))).size == img.size", { image: TINY_PNG });
    assert.equal(r.value, true);
});

test("loader: pd.read_csv('current') returns the one loaded df", { skip }, async () => {
    const r = await pyRun("return int(pd.read_csv('current')['Q1'].sum())", { tables: [rows("df", ["Rep", "Q1"], [["Ada", 120], ["Ben", 90]])] });
    assert.equal(r.value, 210);
});

test("loader: pd.read_html(selector) returns [df] so read_html(...)[0] works", { skip }, async () => {
    const r = await pyRun("return int(pd.read_html('#sales')[0]['Q1'].sum())", { tables: [rows("df", ["Rep", "Q1"], [["Ada", 120], ["Ben", 90]])] });
    assert.equal(r.value, 210);
});

test("loader: read_csv(name) picks the MATCHING table when several are loaded", { skip }, async () => {
    const r = await pyRun("return int(pd.read_csv('targets')['Goal'].sum())", {
        tables: [rows("sales", ["Rep", "Q1"], [["Ada", 120]]), rows("targets", ["Rep", "Goal"], [["Ada", 100], ["Ben", 200]])] });
    assert.equal(r.value, 300);
});

test("loader: a real URL is NOT hijacked even with a table loaded (readonly → the clean net error)", { skip }, async () => {
    const r = await pyRun("return pd.read_csv('https://example.com/x.csv')", { tables: [rows("df", ["A"], [[1]])], hardened: true });
    assert.equal(r.ok, false, "'://' → not tableish → falls through to the real (blocked) loader");
});

test("loader: patched loaders see the CURRENT run's data across runs (no stale closure)", { skip }, async () => {
    // Patched ONCE, but resolve img/tables from globals() each call — so run 2's data wins.
    const a = await pyRun("return int(pd.read_csv('current')['V'].sum())", { tables: [rows("df", ["V"], [[5]])] });
    const b = await pyRun("return int(pd.read_csv('current')['V'].sum())", { tables: [rows("df", ["V"], [[9]])] });
    assert.equal(a.value, 5);
    assert.equal(b.value, 9);
});

test("sympy: loadable + sympy.latex(expr) yields a LaTeX string (the `| latex` companion)", { skip }, async () => {
    await py.loadPackage("sympy");
    const r = await pyRun(`
import sympy
x = sympy.symbols('x')
roots = sympy.solve(x**2 + 2*x + 5, x)   # complex-conjugate pair -1 ± 2i
return sympy.latex(roots[0])
`);
    assert.ok(r.ok, r.error);
    assert.match(String(r.value), /i/, "a symbolic complex root serializes to a LaTeX string with the imaginary unit");
    assert.match(String(r.value), /2/, "and the coefficient");
});

// INTEGRATION: run sympy in the REAL WASM sandbox (the shipped wrapUserCode path), then render its ACTUAL
// LaTeX output through the UI's `| latex` citation → KaTeX. This ties the two halves so a change to sympy's
// output format OR to the render can't silently break the pipeline (which unit tests, mocking each half,
// would miss). Self-skips with the rest when the wheels are absent.
const agentStart = (h, t) => ({ kind: "agent", id: h, ts: Date.now(), save: false, session: { hash: h, turn: 0 }, task: t, model: "m", maxSteps: 10, config: null });
const agentStep = (h, step, f) => ({ kind: "agent-step", id: h, ts: Date.now() + step, save: false, session: { hash: h, turn: step }, step, ...f });
const agentResult = (h, s, steps) => ({ kind: "agent-result", id: h, ts: Date.now() + 100, save: false, session: { hash: h, turn: steps }, summary: s, steps, hitCap: false });

test("INTEGRATION: sympy runs in WASM → its actual LaTeX renders via the UI `| latex` citation (KaTeX)", { skip }, async () => {
    // 1) REAL sympy in the sandbox → the actual LaTeX string (not a hand-written one).
    await py.loadPackage("sympy");
    py.globals.set("INJECTED_IMAGE_B64", null);
    py.globals.set("INJECTED_TABLES_JSON", null);
    await py.runPythonAsync(wrapUserCode(`
import sympy
x = sympy.Symbol('x')
# an equation with irrational + complex parts, so the LaTeX carries real commands (\\frac, \\sqrt, i)
expr = sympy.integrate(sympy.sqrt(x), x) + sympy.Rational(1, 2) + 2 * sympy.I
return sympy.latex(expr)
`, false));
    assert.ok(!py.globals.get("_err"), `sympy run errored: ${py.globals.get("_err")}`);
    const latex = JSON.parse(String(py.globals.get("_json_result")));
    assert.match(latex, /\\frac|\\sqrt/, `sympy emitted LaTeX with commands: ${latex}`);

    // 2) Feed THAT exact output into the sidebar as a python-out.value, cite it `| latex`, assert KaTeX renders it.
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("symint", "compute symbolically"));
    await w.dispatch(agentStep("symint", 1, { seq: 1, tool: "python_exec", token: "abcdef5", result: `[loaded, reference directly] a df.\n\n${latex}`, renderOut: { type: "python-out", value: latex } }));
    await w.dispatch({ ...agentResult("symint", `The result is ![result](@tool:abcdef5:out | latex).`, 1), answer: "" });
    w.shadow.querySelector(".row").click(); await w.tick();
    const tok = w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref");
    assert.ok(tok, "the citation renders in the UI");
    assert.ok(tok.querySelector(".katex"), `the ACTUAL sympy WASM output typesets via KaTeX: ${latex}`);
    assert.doesNotMatch(tok.textContent, /loaded, reference directly/, "the model-facing prelude is NOT fed to KaTeX");
});

test("auto-render: a returned sympy expression comes back as its LaTeX + a 'latex' hint (no cast)", { skip }, async () => {
    // The model returns the sympy EXPRESSION (not sympy.latex(...)) — python-runtime detects the type and
    // serializes sympy.latex(result) with render:'latex', so a plain `:out` citation typesets with no cast.
    const r = await pyRun("import sympy as sp\nx = sp.Symbol('x')\nreturn sp.diff(sp.sin(x**2) * sp.exp(3*x), x)");
    assert.equal(r.render, "latex", "the return type was detected as latex-renderable");
    assert.equal(typeof r.value, "string", "the value is a LaTeX string");
    assert.match(r.value, /\\cos|\\left|\^\{/, "it's real LaTeX (commands / superscripts), not the plain str()");
    assert.doesNotMatch(r.value, /Derivative|sin\(x\*\*2\)/, "not the Python repr");
});

test("auto-render: a returned PIL Image comes back as a data:image URL + an 'img' hint (no to_base64)", { skip }, async () => {
    // The model returns a PIL Image directly — python-runtime encodes it as a PNG data: URL with render:'img',
    // which the tool already auto-shows as an image (the value string starts with data:image/).
    const r = await pyRun("from PIL import Image\nreturn Image.new('RGB', (4, 4), (255, 0, 0))");
    assert.equal(r.render, "img", "the return type was detected as an image");
    assert.match(r.value, /^data:image\/png;base64,/, "the value is a PNG data: URL");
    assert.ok(r.value.length > 80, "…with real base64 bytes");
});

test("auto-render: a plain scalar/list return is untouched (no render hint)", { skip }, async () => {
    const r = await pyRun("return [1, 2, 3]");
    assert.equal(r.render, undefined, "no auto-render hint for ordinary data");
    assert.deepEqual(r.value, [1, 2, 3]);
});

test("auto-render: a sympy.latex(...) return is flagged latex by the CODE (AST), even a bare scalar", { skip }, async () => {
    // The model returns the STRING from sympy.latex() (not the expression). The wrapper's AST sees the latex()
    // call in the return and flags render:'latex' — so it typesets even a "5" that a string-shape heuristic misses.
    const r = await pyRun("import sympy as sp\nx = sp.Symbol('x')\nreturn sp.latex(sp.diff(sp.sin(x**2), x))");
    assert.equal(r.render, "latex", "a sympy.latex(...) return is flagged latex");
    assert.equal(typeof r.value, "string");
    const scalar = await pyRun("import sympy as sp\nreturn sp.latex(sp.Integer(5))");
    assert.equal(scalar.render, "latex", "sympy.latex(scalar) → '5' is still flagged latex (AST, not string shape)");
    assert.equal(scalar.value, "5");
    // A non-latex string call is NOT flagged.
    const plain = await pyRun("return str(5)");
    assert.equal(plain.render, undefined, "str(5) is not a latex() call → not flagged");
});

test("live stdout tee: _ml_stdout_cb streams each print() chunk while _stdout keeps the full capture", { skip }, async () => {
    const chunks = [];
    py.globals.set("_ml_stdout_cb", (s) => chunks.push(s));   // the worker sets this only when streaming is on
    try {
        const r = await pyRun("print('alpha'); print('beta'); 42");
        assert.equal(r.value, 42, "the trailing expression still returns");
        assert.equal(r.stdout, "alpha\nbeta\n", "the final _stdout keeps the byte-exact full output");
        const streamed = chunks.join("");
        assert.match(streamed, /alpha/, "alpha streamed live via the tee");
        assert.match(streamed, /beta/, "beta streamed live via the tee");
    } finally { py.globals.delete("_ml_stdout_cb"); }
});

test("live stdout tee: NO callback set → pure capture, the tee is a silent no-op", { skip }, async () => {
    const r = await pyRun("print('quiet'); 1");   // (prior test deleted _ml_stdout_cb)
    assert.equal(r.stdout, "quiet\n", "stdout captured normally");
    assert.equal(r.value, 1);
});

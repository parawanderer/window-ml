// REAL-CPython tests for the python_exec sandbox runtime — Pyodide-in-Node exercising the exact
// PRELUDE + wrapper the offscreen document runs (python-runtime.ts), so
// the drift-prone Python (`ml.table`'s answer→DataFrame building, numeric auto-cast, read_html
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
import { wrapUserCode, harden, unharden, takeIpc, stdoutWriter } from "../src/python/python-runtime.ts";
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
    // pyarrow too, when its wheel was fetched, and PREPARED before any test runs pandas — the worker's own order.
    const withArrow = fs.readdirSync(PYODIDE_DIR).some((f) => f.startsWith("pyarrow-"));
    await py.loadPackage(["numpy", "pillow", "pandas", "beautifulsoup4", "html5lib", "sympy", ...(withArrow ? ["pyarrow"] : [])]);
    if (withArrow) py.runPython((await import("../src/python/python-env.ts")).PY_STARTUP_PREPARE);
}, { timeout: 180000 });

// `ml.table` without the worker: a transport that answers each `table` call from `tables` (source → the answer's value,
// or `{ error }`), as the worker's wire would. A value whose data is a stored table carries its bytes as `b64`, and they are
// bound under the name the answer gives, which is what the worker does with an answer's transferred bytes (bindTableBytes).
const FAKE_WIRE = `
import json as _j, base64 as _b
def _fake(answers_json, g, record):
    answers = _j.loads(answers_json)
    async def send(raw):
        record(raw)
        req = _j.loads(raw)
        a = answers.get(req["args"][0]) if req.get("call") == "table" else None
        if a is None:
            return _j.dumps({"seq": req["seq"], "error": {"code": "Absent", "message": "the test gave no answer for this source"}})
        if "error" in a:
            return _j.dumps({"seq": req["seq"], "error": a["error"]})
        v = _j.loads(_j.dumps(a))
        b = v.pop("b64", None)
        if b is not None:
            name = "_ml_wbuf_%d" % req["seq"]
            g[name] = bytearray(_b.b64decode(b))
            v["data"]["buf"] = name
        return _j.dumps({"seq": req["seq"], "value": v})
    return send
_fake
`;
let fakeWire = null;
/** Install the fake transport in `ns` for one cell; returns the requests it receives, decoded. */
function tableWire(ns, tables) {
    const sent = [];
    if (!tables) return sent;
    fakeWire ??= py.runPython(FAKE_WIRE, { globals: py.toPy({}) });
    const send = fakeWire(JSON.stringify(tables), ns, (raw) => sent.push(JSON.parse(raw)));
    ns.set("_ml_send", send);
    send.destroy();
    return sent;
}

// Mirror offscreen.run(): set the injected globals, (optionally harden), run the wrapped script,
// read back the result. `hardened` applies the REAL readonly-mode hardening (harden/unharden) so
// the escape tests hit the shipped code — restored in `finally` so a null'd global can't leak to
// the next test (which runs serially). `tables` answers the cell's `ml.table` calls (tableWire).
async function pyRun(code, { tables = null, image = null, hardened = false } = {}) {
    py.globals.set("INJECTED_IMAGE_B64", image);
    const sent = tableWire(py.globals, tables);
    const saved = hardened ? harden(py) : null;
    try { await py.runPythonAsync(wrapUserCode(code, hardened)); }
    finally { if (saved) unharden(py, saved); }
    const stdout = String(py.globals.get("_stdout") ?? "");
    if (py.globals.get("_err")) return { ok: false, stdout, error: String(py.globals.get("_err")), sent };
    const jr = py.globals.get("_json_result");
    let value; try { value = JSON.parse(jr); } catch { value = jr; }
    const tj = py.globals.get("_json_table");
    let table; if (typeof tj === "string") { try { table = JSON.parse(tj); } catch { /* */ } }
    const rh = py.globals.get("_json_render");
    const render = rh === "latex" || rh === "img" ? rh : undefined;
    const ipc = takeIpc(py.globals);
    try { py.globals.delete("_ipc_result"); } catch { /* not set */ }
    return { ok: true, value, stdout, table, render, ipc, sent };
}
/** A `rows` answer, as the page's or the worker's read of a page table gives it. */
const rows = (columns, r, label = "table#t") => ({ source: { kind: "dom", label }, data: { kind: "rows", columns, rows: r } });
/** A stored table's answer, its bytes carried for tableWire to bind. */
const storedAns = (bytes, data = {}) => ({ source: { kind: "fetch", label: "https://site.test/s.csv" }, data: { kind: "value", label: "s", columns: [], format: "csv", ...data }, b64: Buffer.from(bytes).toString("base64") });

// ── Traceback line numbers ────────────────────────────────────────────────────────────────────────────
//
// A traceback's LINE NUMBERS are what a person uses to find the failure, and the sandbox indents the user's
// code into `def _user():` after a three-line prefix — so an uncorrected traceback pointed three lines past
// the statement that actually failed (on a four-line script, at line 7). Corrected in the AST rather than by
// rewriting the traceback text, so CPython emits true numbers natively and the MODEL gets them too: handing
// it a traceback that names the wrong line costs it a turn.
//
// The user's frame is the one in `<python_exec>`; the `<exec>` frame above it is the prelude's own call site
// and is not about the user's code at all.
const userLine = (err) => {
    const m = /File "<python_exec>", line (\d+)/.exec(err);
    return m ? Number(m[1]) : null;
};

test("traceback: the line number is the line the USER wrote", { skip }, async () => {
    const r = await pyRun(["a = 1", "b = 2", "c = 3", "raise ValueError('boom')"].join("\n"));
    assert.equal(r.ok, false);
    assert.equal(userLine(r.error), 4, "the raise is the user's line 4");
});

test("traceback: line 1 is line 1 — the off-by-three is not a constant that happens to work", { skip }, async () => {
    const r = await pyRun("raise ValueError('immediate')");
    assert.equal(r.ok, false);
    assert.equal(userLine(r.error), 1);
});

test("traceback: a failure INSIDE a user-defined function names that function's line", { skip }, async () => {
    // The deepest frame is the one that matters, and it is inside code the user indented themselves — the
    // shift must apply to nested statements, not only to the top level of the body.
    const r = await pyRun([
        "def outer():",
        "    return inner()",
        "def inner():",
        "    return 1 / 0",
        "outer()",
    ].join("\n"));
    assert.equal(r.ok, false);
    const lines = [...r.error.matchAll(/File "<python_exec>", line (\d+)/g)].map((m) => Number(m[1]));
    assert.deepEqual(lines, [5, 2, 4], "call site, then outer, then the division — all user-relative");
});

test("traceback: a blank first line and comments do not shift it", { skip }, async () => {
    const r = await pyRun(["", "# a comment", "", "raise RuntimeError('x')"].join("\n"));
    assert.equal(r.ok, false);
    assert.equal(userLine(r.error), 4);
});

test("traceback: a SYNTAX error also reports the user's line", { skip }, async () => {
    // A syntax error is raised by `ast.parse` before any of the above runs, so it takes a different path
    // entirely — and that path had the same three-line prefix in it.
    const r = await pyRun(["ok = 1", "def (:", "more = 2"].join("\n"));
    assert.equal(r.ok, false);
    assert.match(r.error, /SyntaxError/);
    // A SyntaxError carries the line in its OWN fields (it is raised by the parse, before anything runs), so
    // it takes a different path from a runtime traceback and needed its own correction.
    assert.equal(userLine(r.error), 2, "the bad def is the user's line 2");
});

// --- ml.table: the answer becomes the cell's DataFrame (ruling 78) ---

test("ml.table: a rows answer is a DataFrame; numeric columns arrive typed", { skip }, async () => {
    const r = await pyRun("sales = ml.table('#sales')\nreturn [int(sales['Q1'].sum()), str(sales['Q1'].dtype)]",
        { tables: { "#sales": rows(["Rep", "Q1"], [["Ada", 120], ["Ben", 90]]) } });
    // Q1 arrives as int64 so .sum() adds (not concat).
    assert.deepEqual(r.value, [210, "int64"]);
    assert.deepEqual(r.sent, [{ seq: 1, call: "table", args: ["#sales"] }], "one call, no options when none were given");
});

test("ml.table: the source facts are on df.attrs", { skip }, async () => {
    const r = await pyRun("df = ml.table('#sales')\nreturn dict(df.attrs)", { tables: { "#sales": rows(["A"], [[1]], "table#sales") } });
    assert.deepEqual(r.value, { source: "table#sales", kind: "dom" });
});

test("ml.table: two sources join with pd.merge under the names the cell gave them", { skip }, async () => {
    const r = await pyRun("sales = ml.table('#s')\ntargets = ml.table('#t')\nreturn pd.merge(sales, targets, on='Rep')['Q1'].tolist()", {
        tables: { "#s": rows(["Rep", "Q1"], [["Ada", 120], ["Ben", 90]]), "#t": rows(["Rep", "Goal"], [["Ada", 100], ["Ben", 200]]) },
    });
    assert.deepEqual(r.value, [120, 90]);
});

test("ml.table: an html answer is read with pd.read_html", { skip }, async () => {
    const html = "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>";
    const r = await pyRun("df = ml.table('table')\nreturn int(df['A'].iloc[0]) + int(df['B'].iloc[0])",
        { tables: { table: { source: { kind: "dom", label: "table" }, data: { kind: "html", html } } } });
    assert.equal(r.value, 3);
});

test("ml.table: ragged rows pad to the header width (DataFrame can't choke)", { skip }, async () => {
    const r = await pyRun("df = ml.table('t')\nreturn bool(pd.isna(df.iloc[0, 2]))", { tables: { t: rows(["A", "B", "C"], [[1, 2]]) } });
    assert.equal(r.value, true);
});

test("ml.table: a stored CSV is read with the delimiter and header the JS reader decided, and its bytes are dropped", { skip }, async () => {
    const r = await pyRun("df = ml.table('@tool:abc1234')\nreturn [df.shape[0], int(df['qty'].sum()), dict(df.attrs), [k for k in globals() if k.startswith('_ml_wbuf')]]",
        { tables: { "@tool:abc1234": storedAns("name;qty\nx;1\ny;2\n", { delimiter: ";" }) } });
    assert.deepEqual(r.value, [2, 3, { source: "https://site.test/s.csv", kind: "fetch", delimiter: ";" }, []]);
});

test("ml.table: a headerless stored CSV gets positional columns; raw keeps every cell a string", { skip }, async () => {
    const h = await pyRun("df = ml.table('s')\nreturn [list(df.columns), df.attrs.get('headerless')]", { tables: { s: storedAns("1,2\n3,4\n", { headerless: true }) } });
    assert.deepEqual(h.value, [[0, 1], true]);
    const raw = await pyRun("df = ml.table('s', raw=True)\nreturn [str(df['a'].dtype), df['a'].tolist()]", { tables: { s: storedAns("a\n007\n", { raw: true }) } });
    assert.ok(["object", "str"].includes(raw.value[0]), `a string column (pandas 3 says str): ${raw.value[0]}`);
    assert.deepEqual(raw.value[1], ["007"], "a leading zero survives");
    assert.deepEqual(raw.sent[0].args, ["s", { raw: true }], "the option travels as one trailing object");
});

test("ml.table: a stored value that is not a table, or whose bytes never arrived, raises at the call", { skip }, async () => {
    const paged = await pyRun("ml.table('p')", { tables: { p: storedAns("x", { format: "paged" }) } });
    assert.match(paged.error, /not a table\. Read it with ml\.dereference/);
    const lost = await pyRun("ml.table('p')", { tables: { p: { source: { kind: "fetch", label: "u" }, data: { kind: "value", format: "csv", buf: "_ml_wbuf_9" } } } });
    assert.match(lost.error, /was not handed to the sandbox/);
});

test("ml.table: an error answer is an MlError at the line that called, and the cell can catch it", { skip }, async () => {
    const r = await pyRun("try:\n    ml.table('#gone')\nexcept MlError as e:\n    return [e.code, str(e)]",
        { tables: { "#gone": { error: { code: "Failed", message: "no table matches #gone" } } } });
    assert.equal(r.value[0], "Failed");
    assert.match(r.value[1], /no table matches #gone/);
});

test("ml.table: a source that is not a string, or an option of the wrong type, is a TypeError before any call", { skip }, async () => {
    for (const call of ["ml.table(1)", "ml.table(['#t'])", "ml.table('#t', raw='yes')", "ml.table('#t', delimiter=1)", "ml.table('#t', header=1)"]) {
        const r = await pyRun(call, { tables: {} });
        assert.match(r.error, /TypeError: ml\.table/, call);
        assert.deepEqual(r.sent, [], `${call}: nothing crossed`);
    }
});

test("ml.table is absent where the worker installed no wire (real CPython, a completion)", { skip }, async () => {
    const r = await pyRun("ml.table('#t')");
    assert.match(r.error, /NameError/);
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
    await pyRun("leaked = ml.table('t')\nreturn 1", { tables: { t: rows(["A"], [[1]]) } });
    const r = await pyRun("return 'leaked' in globals()");   // next call, no tables
    assert.equal(r.value, false);
});

test("no injected image → img/img_np are None", { skip }, async () => {
    assert.deepEqual((await pyRun("return [img is None, img_np is None]")).value, [true, true]);
});

// ---- the output ceiling: past it stdout is counted, not kept (output-clip.ts OUTPUT_CEILING) ----

test("stdout past the output ceiling: kept up to it, the rest counted, nothing teed past it", { skip, timeout: 120000 }, async () => {
    const teed = [];
    // The live half is Pyodide's JS-side setStdout, which wraps the real stdout the tee writes through to.
    py.setStdout({ batched: (s) => teed.push(s.length) });
    try {
        // Five 9 MB prints: three fit under 32 million, the fourth would pass it.
        const r = await pyRun(`s = "x" * 9000000\nfor _ in range(5):\n    print(s)\nreturn 1`);
        assert.equal(r.ok, true, r.error);
        assert.equal(r.stdout.length, 3 * 9_000_001, "three whole writes of a line and its newline");
        assert.equal(Number(py.globals.get("_ml_stdout_dropped")), 2 * 9_000_001);
        assert.ok(teed.reduce((a, b) => a + b, 0) <= 3 * 9_000_001, "a write past the ceiling is not streamed");
    } finally { py.setStdout({}); }
});

test("stdout under the ceiling reports nothing dropped", { skip, timeout: 120000 }, async () => {
    const r = await pyRun(`print("hi")`);
    assert.equal(r.stdout, "hi\n");
    assert.equal(Number(py.globals.get("_ml_stdout_dropped")), 0);
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
    assert.match(r.error, /network is disabled in python_exec/);
    assert.doesNotMatch(r.error, /create_connection|Host is unreachable/, "no 40-line socket traceback");
});

test("the blocked-network message points at fetch_url and names no removed mode", { skip }, async () => {
    const r = await pyRun("import urllib.request\nurllib.request.urlopen('http://example.com/data.csv')", { hardened: true });
    assert.equal(r.ok, false);
    assert.match(r.error, /fetch_url/);
    assert.doesNotMatch(r.error, /mode:|readonly python_exec|full/, "python_exec has no mode since #820");
});

test("readonly: pandas read_csv(url) hits the SAME clean error (the funnel is OpenerDirector.open)", { skip }, async () => {
    const r = await pyRun("import pandas as pd\nreturn pd.read_csv('http://example.com/data.csv')", { hardened: true });
    assert.equal(r.ok, false);
    assert.match(r.error, /network is disabled in python_exec/, "the patch catches pandas' urlopen regardless of how it imported it");
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

test("loader: pd.read_csv and pd.read_html are pandas' own: a selector or 'current' is never redirected to a table", { skip }, async () => {
    const t = { t: rows(["Q1"], [[120]]) };
    const csv = await pyRun("df = ml.table('t')\nreturn pd.read_csv('current')", { tables: t });
    assert.match(csv.error, /FileNotFoundError|No such file/, "read_csv opens a file named 'current', which is not there");
    const html = await pyRun("df = ml.table('t')\nreturn pd.read_html('#sales')", { tables: t });
    assert.equal(html.ok, false, "read_html of a selector is pandas reading the string, not a loaded table");
});

test("loader: a URL read with ml.table does not make pd.read_csv of that URL a table (readonly → the clean net error)", { skip }, async () => {
    const url = "http://site.test/sales.csv";
    const r = await pyRun(`df = ml.table('${url}')\nreturn pd.read_csv('${url}')`, { tables: { [url]: rows(["A"], [[1]], url) }, hardened: true });
    assert.equal(r.ok, false);
});

test("ml.table: each run reads its own answer (no stale closure across runs)", { skip }, async () => {
    const a = await pyRun("return int(ml.table('t')['V'].sum())", { tables: { t: rows(["V"], [[5]]) } });
    const b = await pyRun("return int(ml.table('t')['V'].sum())", { tables: { t: rows(["V"], [[9]]) } });
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

test("live stdout tee: setStdout streams each print() chunk while _stdout keeps the full capture", { skip }, async () => {
    const chunks = [];
    // The worker hooks Pyodide's JS-side setStdout when streaming is on: the tee writes through to the
    // real stdout, so the live chunks arrive there and the namespace holds no JsProxy (P3).
    py.setStdout({ batched: (s) => chunks.push(s) });
    try {
        const r = await pyRun("print('alpha'); print('beta'); 42");
        assert.equal(r.value, 42, "the trailing expression still returns");
        assert.equal(r.stdout, "alpha\nbeta\n", "the final _stdout keeps the byte-exact full output");
        const streamed = chunks.join("");
        assert.match(streamed, /alpha/, "alpha streamed live via the tee");
        assert.match(streamed, /beta/, "beta streamed live via the tee");
    } finally { py.setStdout({}); }
});

test("live stdout tee: the worker's writer streams the exact text, newlines included, so lines stay lines", { skip }, async () => {
    const chunks = [];
    // What python-worker.ts installs. The `batched` handler it replaced stripped each line's newline, so a live cell
    // showed "rolled 2000rolled 4000" until the run ended.
    py.setStdout(stdoutWriter((s) => chunks.push(s)));
    try {
        const r = await pyRun("print('alpha'); print('beta', end=''); print(' and é'); 42");
        assert.equal(r.value, 42);
        assert.equal(chunks.join(""), "alpha\nbeta and é\n", "streamed text equals what was printed");
        assert.equal(chunks.join(""), r.stdout, "and equals the final capture");
    } finally { py.setStdout({}); }
});

test("live stdout tee: no setStdout hook → pure capture, the tee still keeps _stdout", { skip }, async () => {
    const r = await pyRun("print('quiet'); 1");
    assert.equal(r.stdout, "quiet\n", "stdout captured normally");
    assert.equal(r.value, 1);
});

test("a df cell with no JSON form is NAMED by the sandbox, not flattened to an empty object", { skip }, async () => {
    // pandas serialises an arbitrary object to `{}` — a plausible value, so the panel would print an empty
    // dict exactly where the reader is looking for the real one (the `[object Object]` bug in another
    // costume). The type is only still known HERE, so it is recorded here.
    const r = await pyRun([
        "import pandas as pd",
        "class Widget:",
        "    def __repr__(self): return '<Widget id=7>'",
        "return pd.DataFrame({'name': ['a', 'b', 'c', 'd'], 'meta': [{'q1': 1}, {1, 2, 3}, Widget(), None]})",
    ].join("\n"));
    assert.ok(r.table, "a df return yields a structural table");
    const meta = r.table.rows.map((row) => row[1]);
    // Everything json/pandas represents natively is LEFT ALONE — the marker is only for what would be lost.
    assert.deepEqual(meta[0], { q1: 1 }, "a dict cell is still a dict");
    assert.deepEqual(meta[1], [1, 2, 3], "a set still converts to a list");
    assert.deepEqual(meta[2], { __ml_unrenderable__: "Widget" }, "the class instance is named");
    assert.equal(meta[3], null, "None is still None, not 'NoneType'");
});

test("a frame of ordinary values gains no markers at all", { skip }, async () => {
    // The walk must not perturb the common case: an object-dtype column of strings is the norm.
    const r = await pyRun("import pandas as pd\nreturn pd.DataFrame({'s': ['x', 'y'], 'n': [1, 2]})");
    assert.deepEqual(r.table.rows, [["x", 1], ["y", 2]]);
});

// ── THE BENCH EDITOR'S COMPLETION (Jedi) ──────────────────────────────────────────────────────────────────
// Against the SHIPPED helper in real CPython. Lazy tooling, so its wheel may be absent from an older fetch:
// these skip with the reason rather than failing.
const hasJedi = hasPyodide && fs.readdirSync(PYODIDE_DIR).some((f) => f.startsWith("jedi-"));
const skipJedi = skip || (hasJedi ? false : "no jedi wheel in dist/pyodide — re-run `npm run fetch-pyodide`");
let completerLoaded = false;
async function complete(code, namespace) {
    const { COMPLETE_HELPER, completeIn } = await import("../src/python/python-runtime.ts");
    if (!completerLoaded) { await py.loadPackage(["jedi"]); py.runPython(COMPLETE_HELPER); completerLoaded = true; }
    const lines = code.split("\n");
    if (namespace) return JSON.parse(py.runPython(`_ml_complete(${JSON.stringify(code)}, ${lines.length}, ${lines.at(-1).length}, ${namespace})`));
    return completeIn(py, code, lines.length, lines.at(-1).length);
}
const names = (cs) => cs.map((c) => c.name);

test("completion: a module attribute completes by following the import, without running it", { skip: skipJedi }, async () => {
    assert.ok(names(await complete("import numpy as np\nnp.ara")).includes("arange"));
    assert.ok(names(await complete("from numpy import lin")).includes("linspace"));
});

test("completion: a pandas frame completes from pandas' own stubs — even read_csv of a file that is not there", { skip: skipJedi }, async () => {
    // `x.csv` does not exist: if this were evaluated it would raise, so an answer means it was inferred.
    assert.ok(names(await complete("import pandas as pd\ndf = pd.read_csv('x.csv')\ndf.he")).includes("head"));
});

test("completion: the script's own functions and classes complete", { skip: skipJedi }, async () => {
    assert.ok(names(await complete("def row_sums(m):\n    return m.sum(axis=1)\nrow_")).includes("row_sums"));
    assert.ok(names(await complete("class P:\n    def area(self): return 1\np = P()\np.ar")).includes("area"));
});

test("completion: it NEVER runs the script being typed", { skip: skipJedi }, async () => {
    py.runPython("import builtins\nbuiltins._ml_ran = False");
    await complete("import builtins\nbuiltins._ml_ran = True\nx = 1\nx.");
    assert.equal(py.runPython("import builtins\nbuiltins._ml_ran"), false);
});

test("completion: the sandbox is hardened only for the call, and restored after", { skip: skipJedi }, async () => {
    const fetchBefore = globalThis.fetch;
    await complete("import numpy as np\nnp.");
    assert.equal(globalThis.fetch, fetchBefore, "a completion must not leave the next run without its network globals");
});

test("completion: a script full of quotes cannot break out of the call", { skip: skipJedi }, async () => {
    const { completeIn } = await import("../src/python/python-runtime.ts");
    await complete("x = 1");   // loads Jedi and the helper if this runs alone
    // A payload that DOES run when the script is spliced into the call's source — its triple quote closes the
    // literal, the call completes, the payload executes, and a fresh literal soaks up the template's closing
    // quote (verified: a naive `_ml_complete('''<script>''', 2, 4)` sets the flag). Handed over as a global,
    // as the shipped helper does, it is an ordinary comment and the line above it still completes.
    py.runPython("import builtins\nbuiltins._ml_pwned = False");
    const hostile = "s = 'abc'\ns.up\n# ''', 1, 0); import builtins; builtins._ml_pwned = True; _ml_complete('''";
    assert.ok(completeIn(py, hostile, 2, 4).map((c) => c.name).includes("upper"));
    assert.equal(py.runPython("import builtins\nbuiltins._ml_pwned"), false, "nothing in the script was executed");
});

test("completion: a numpy ARRAY needs the live namespace — static analysis cannot infer it (the persisted-bench seam)", { skip: skipJedi }, async () => {
    const code = "import numpy as np\ngrid = np.arange(24).reshape(4, 6)\ngrid.su";
    // Known and documented (python-runtime.ts): Jedi 0.19 cannot resolve numpy 2's stubs. If this starts
    // returning something, a newer Jedi fixed it — update that comment and the note in docs/dev/python-sandbox.md, don't just delete this.
    assert.deepEqual(names(await complete(code)), [], "static analysis still cannot type a numpy call's result");
    // With the object alive — what a persisted session will pass — the same call completes it.
    py.runPython("import numpy as np\n_ml_test_ns = {'np': np, 'grid': np.arange(24).reshape(4, 6)}");
    assert.ok(names(await complete("grid.su", "_ml_test_ns")).includes("sum"));
});

test("completion: a kind Jedi could not resolve is reported as UNKNOWN, never as a wrong 'module'", { skip: skipJedi }, async () => {
    const byName = (cs) => Object.fromEntries(cs.map((c) => [c.name, c.type]));
    // `arange` is a function that numpy 2's stubs re-export from a module Jedi cannot import, so Jedi says
    // "module". That is believed only for a real, loaded module; otherwise the kind is "" (no label).
    assert.equal(byName(await complete("import numpy as np\nnp.ara")).arange, "");
    assert.equal(byName(await complete("import numpy as np\nnp.lina")).linalg, "module", "a real submodule keeps its kind");
});

// ── SETUP / SCRIPT SPLIT (the 15s is the cell's) ────────────────────────────────────────────────────────
//
// The worker runs `wrapUserSetup` then `wrapUserScript`, and fires `started` — which arms the script's 15s —
// only between them. So the prelude's imports, the injected inputs and the wire facade are NOT charged to the
// cell. These pins hold the split's shape; the e2e ("a run queued behind another…") is the timing proof.
test("the setup/script split composes to the one-string wrapper, and setup never runs the cell", { skip }, async () => {
    const { wrapUserCode, wrapUserSetup, wrapUserScript } = await import("../src/python/python-runtime.ts");
    const code = "split_marker = 1\nreturn split_marker";
    assert.equal(wrapUserCode(code), wrapUserSetup() + wrapUserScript(code), "wrapUserCode is the two halves joined");
    assert.ok(!wrapUserSetup().includes("split_marker"), "setup does not contain the cell's source");
    assert.ok(wrapUserScript(code).includes("split_marker"), "the script half does");
    // SETUP alone: prelude names land, the cell does not run (no result, no capture).
    const ns = freshNs();
    await py.runPythonAsync(wrapUserSetup(false, "run"), { globals: ns });
    assert.equal(ns.get("_json_result"), undefined, "setup alone serialises no result");
    assert.equal(ns.get("split_marker"), undefined, "setup alone does not run the cell");
    assert.ok(ns.get("pd") != null, "the prelude's pandas is already bound");
    // SCRIPT after SETUP: the cell runs against that prelude, the same way the joined wrapper would.
    await py.runPythonAsync(wrapUserScript(code, "run"), { globals: ns });
    assert.equal(ns.get("split_marker"), 1, "the cell ran");
    assert.equal(ns.get("_err"), undefined, "and did not fail");
    assert.equal(JSON.parse(String(ns.get("_json_result"))), 1, "and its return was captured");
});

// ── THE BENCH'S KEPT STATE (`wrapUserCode(..., persist = true)`) ─────────────────────────────────────────
// Driven the way the worker drives it: the shipped wrapper, run with a SEPARATE dict as its globals.
async function benchRun(code, ns, { hardened = true } = {}) {
    const { wrapUserCode } = await import("../src/python/python-runtime.ts");
    await py.runPythonAsync(wrapUserCode(code, hardened, true), { globals: ns });
    const err = ns.get("_err");
    if (err) return { error: String(err) };
    const r = ns.get("_json_result");
    return { value: typeof r === "string" ? JSON.parse(r) : r };
}
const freshNs = () => py.globals.get("dict")();

test("bench: what one run defines, the next can use — values, functions, imports", { skip }, async () => {
    const ns = freshNs();
    await benchRun("x = 41\ngrid = np.arange(24).reshape(4, 6)\ndef f():\n    return x + 1\nimport math as m", ns);
    // f closes over x as a GLOBAL of the namespace, so it still resolves a run later.
    assert.deepEqual(await benchRun("return f() + int(grid.sum()) + int(m.floor(0.5))", ns), { value: 318 });
});

test("bench: a traceback names the line the user wrote, as a per-run script's does", { skip }, async () => {
    // The bench's editor marks and jumps to these numbers, and the kept-state wrapper edits the script's AST
    // (its `global` statement) — so the correction has to survive that path too.
    const ns = freshNs();
    const { error } = await benchRun("def inner():\n    return 1 / 0\n\nx = 5\ninner()", ns);
    assert.deepEqual([...error.matchAll(/File "<python_exec>", line (\d+)/g)].map((m) => Number(m[1])), [5, 2]);
    const syntax = await benchRun("ok = 1\ndef (:\nmore = 2", freshNs());
    assert.match(syntax.error, /File "<python_exec>", line 2/);
});

test("bench: `df` survives a run — the injected-data prelude that resets it is not run here", { skip }, async () => {
    const ns = freshNs();
    await benchRun("df = pd.DataFrame({'a': [1, 2]})", ns);
    assert.deepEqual(await benchRun("int(df['a'].sum())", ns), { value: 3 });
});

test("bench: `return`, a trailing expression and a loop variable all behave as they do elsewhere", { skip }, async () => {
    const ns = freshNs();
    assert.deepEqual(await benchRun("for i in range(3): pass\nreturn 'r'", ns), { value: "r" });
    assert.deepEqual(await benchRun("i", ns), { value: 2 }, "a top-level loop variable is kept, as at a notebook's top level");
});

test("bench: a name a nested function declares nonlocal stays local, so the script still compiles", { skip }, async () => {
    // Made global, `nonlocal n` would have no binding to refer to and the whole script would be a SyntaxError.
    assert.deepEqual(await benchRun("n = 0\ndef inc():\n    nonlocal n\n    n += 1\ninc()\nreturn n", freshNs()), { value: 1 });
});

test("bench: one namespace cannot see another's, and the model's namespace sees neither", { skip }, async () => {
    const a = freshNs();
    await benchRun("secret = 7", a);
    assert.match((await benchRun("secret", freshNs())).error, /NameError/, "a different bench namespace");
    // The model's path: the ordinary wrapper, in the interpreter's main namespace, with its per-run reset.
    const { error } = await pyRun("return secret");
    assert.match(String(error), /NameError/, "a python_exec never sees a person's bench variables");
});

// ── A RUN'S KEPT DICT (`wrapUserCode(..., "run")`, ROOT C) ─────────────────────────────────────────────────
// What the worker does for a cell of a worker-hosted run: its injected inputs set into the run's own dict, then the
// wrapper in "run" mode. Unlike the bench, a cell that passes an image gets it decoded; `tables` answers its `ml.table`.
async function runCell(code, ns, { image = null, tables = null } = {}) {
    const { wrapUserCode, injectInputs } = await import("../src/python/python-runtime.ts");
    injectInputs(ns, image);
    tableWire(ns, tables);
    await py.runPythonAsync(wrapUserCode(code, false, "run"), { globals: ns });
    const err = ns.get("_err");
    if (err) return { error: String(err) };
    const r = ns.get("_json_result");
    return { value: typeof r === "string" ? JSON.parse(r) : r };
}

test("run dict: a cell that passes an image gets img/img_np/H/W, and a later cell without one keeps them", { skip }, async () => {
    const ns = freshNs();
    assert.deepEqual(await runCell("x = 5\nreturn [list(img_np.shape), H, W]", ns, { image: TINY_PNG }), { value: [[1, 1, 3], 1, 1] });
    assert.deepEqual(await runCell("return [x, img.size[0], int(img_np.shape[0])]", ns), { value: [5, 1, 1] });
});

test("run dict: a frame a cell read with ml.table stays for a later cell, which needs no wire", { skip }, async () => {
    const ns = freshNs();
    assert.deepEqual(await runCell("t = ml.table('#t')\nreturn int(t['a'].sum())", ns, { tables: { "#t": rows(["a"], [[1], [2]]) } }), { value: 3 });
    assert.deepEqual(await runCell("return int(t['a'].sum())", ns), { value: 3 });
});

test("run dict: the injected inputs are coerced to str/None, and the loaders' originals are not left in it", { skip }, async () => {
    const ns = freshNs();
    assert.deepEqual(await runCell("return [INJECTED_IMAGE_B64, 'INJECTED_TABLES_JSON' in globals()]", ns), { value: [null, false] });
    // The shared patch keeps its originals in its own closure, so a run's dict holds none to chain onto.
    assert.equal(ns.has("_ml_orig_image_open"), false);
});

// --- the loader redirect in a run's dict: ONE patch per interpreter, reading the namespace of the cell that runs ---

test("run dict loaders: a cell that passed an image is redirected; a run with none is not handed another run's", { skip }, async () => {
    const a = freshNs();
    const b = freshNs();
    assert.deepEqual(await runCell("return Image.open('canvas#stage') is img", a, { image: TINY_PNG }), { value: true }, "run A: the redirect works");
    const bOpen = await runCell("return Image.open('canvas#stage') is not None", b);
    assert.match(String(bOpen.error), /FileNotFoundError|No such file/, "run B has no image: the real open runs and fails, nothing is served");
    assert.deepEqual(await runCell("return Image.open('canvas#stage') is img", a), { value: true }, "run A still has its own after B ran");
});

test("run dict loaders: a re-import of Image neither loses the redirect nor leaks another run's image", { skip }, async () => {
    const a = freshNs();
    const b = freshNs();
    assert.deepEqual(await runCell("from PIL import Image\nreturn Image.open('x') is img", a, { image: TINY_PNG }), { value: true }, "neither lose");
    const bOpen = await runCell("from PIL import Image\nreturn Image.open('x') is not None", b);
    assert.match(String(bOpen.error), /FileNotFoundError|No such file/, "neither leak");
});

test("run dict loaders: a later run's prelude installs nothing over the first", { skip }, async () => {
    const a = freshNs();
    const b = freshNs();
    // No chain: a later prelude run installs nothing, so the patched slot is the very same object afterwards, and
    // pandas' readers are its own (nothing redirects them since `tables` went).
    const ids = "import PIL.Image as m\nreturn [id(m.open), pd.read_csv.__module__, pd.read_html.__module__]";
    const before = await runCell(ids, a);
    await runCell("return 1", freshNs());
    await runCell("return 1", b);
    assert.deepEqual(await runCell(ids, a), before, "the slot holds the same wrapper after other runs' preludes");
    assert.match(String(before.value[1]), /^pandas(\.|$)/);
});

// --- the _ml_in coercion runs on every run-dict cell, not only the first ---

test("run dict: a second cell with a null injection gets None, never a JsProxy", { skip }, async () => {
    const ns = freshNs();
    assert.equal((await runCell("return type(INJECTED_IMAGE_B64).__name__", ns, { image: TINY_PNG })).value, "str");
    assert.deepEqual(await runCell("return [INJECTED_IMAGE_B64 is None, type(INJECTED_IMAGE_B64).__name__]", ns),
        { value: [true, "NoneType"] }, "cell 2: it coerces to Python None");
    assert.deepEqual(await runCell("return type(INJECTED_IMAGE_B64).__name__ not in ('JsProxy','JsNull','JsUndefined')", ns),
        { value: true }, "never a JsProxy of the host's null/undefined");
    assert.equal((await runCell("return type(INJECTED_IMAGE_B64).__name__", ns, { image: TINY_PNG })).value, "str", "cell 3: re-coerces when one is passed again");
});

test("run dict: no other host-injected name reaches the dict uncoerced", { skip }, async () => {
    const ns = freshNs();
    await runCell("t = ml.table('s')\nreturn 1", ns, { image: TINY_PNG, tables: { s: storedAns("a\n1\n") } });
    assert.deepEqual(await runCell("return ['_ml_harness' not in globals(), '_ml_send' not in globals(), [k for k in globals() if k.startswith('_ml_wbuf') or k.startswith('_ml_table') or k == '_ml_run_sync']]", ns),
        { value: [true, true, []] }, "the harness, the wire transport, the table bytes and the table helpers are all dropped");
    assert.deepEqual(await runCell("return type(INJECTED_IMAGE_B64).__name__", ns),
        { value: "NoneType" }, "a cell that passes none sees Python None, never a JsProxy");
    assert.deepEqual(await runCell("return type(INJECTED_IMAGE_B64).__name__", ns, { image: TINY_PNG }),
        { value: "str" }, "the only injected name is the coerced one, and a passing cell gets str");
});

test("run dict loaders: the bench is never served a run's image or tables", { skip }, async () => {
    const run = freshNs();
    await runCell("t = ml.table('s')\nreturn 1", run, { image: TINY_PNG, tables: { s: rows(["a"], [[1]]) } });
    const open = await benchRun("Image.open('x')", freshNs());
    assert.match(String(open.error), /FileNotFoundError|No such file/);
    const csv = await benchRun("pd.read_csv('t')", freshNs());
    assert.match(String(csv.error), /FileNotFoundError|No such file|Errno/);
    assert.match(String((await benchRun("t", freshNs())).error), /NameError/, "nor a run's frame");
});

test("run dict: persist true (bench), \"run\" and false cannot be confused", { skip }, async () => {
    const { wrapUserCode } = await import("../src/python/python-runtime.ts");
    const bench = wrapUserCode("return 1", true, true);
    const run = wrapUserCode("return 1", false, "run");
    const old = wrapUserCode("return 1", true, false);
    assert.ok(!bench.includes("def _ml_in") && !bench.includes("_ml_image_open"), "the bench gets neither the coercion nor the loaders (it injects no names)");
    assert.ok(run.includes("def _ml_in") && run.includes("_ml_image_open"), "\"run\" coerces and installs the shared loaders (a no-op after the first)");
    assert.ok(old.includes("def _ml_in") && old.includes("_ml_image_open") && old.includes("for _k in list(globals().keys())"), "the old path coerces, runs the loaders, and RESETs");
    const reset = "img = None\nimg_np = None\nH = W = 0";
    assert.ok(!run.includes(reset), "\"run\" keeps a later cell's img when it passes none");
    assert.ok(old.includes(reset), "the old path resets img on every call (which is why it does not stale-chain)");
});

test("completion: the prelude's names complete with NOTHING kept — no import, no namespace", { skip: skipJedi }, async () => {
    // Before a bench's first run, after a reset, after a restart: no namespace exists, but the prelude still
    // binds these for the run. Static analysis of the script alone offered none of them.
    const { completeIn } = await import("../src/python/python-runtime.ts");
    await complete("x = 1");   // loads Jedi and the helper if this runs alone
    const at = (code) => completeIn(py, code, 1, code.length).map((c) => c.name);
    assert.ok(at("np.ara").includes("arange"));
    assert.ok(at("pd.read_").includes("read_csv"));
    assert.ok(at("Image.ope").includes("open"));
    assert.ok(at("to_ba").includes("to_base64"));
    // The line and column are the SCRIPT's, whatever is read in front of it.
    const two = "import math\nmath.flo";
    assert.ok(completeIn(py, two, 2, 8).map((c) => c.name).includes("floor"));
});

test("completion: kept state does not cost the prelude's stubs — a call through `pd` is still typed", { skip: skipJedi }, async () => {
    // A live `pd` from the namespace has no stubs for a call's result; the prelude read in front of the script
    // does, so both halves answer: the stubs for `pd.read_csv(...)`, the live object for `grid`.
    const { completeIn } = await import("../src/python/python-runtime.ts");
    await complete("x = 1");
    const ns = freshNs();
    await benchRun("grid = np.arange(24).reshape(4, 6)", ns);
    const read = "df = pd.read_csv('x.csv')\ndf.he";
    assert.ok(completeIn(py, read, 2, 5, ns).map((c) => c.name).includes("head"), "stubs, through the prelude's pd");
    assert.ok(completeIn(py, "grid.su", 1, 7, ns).map((c) => c.name).includes("sum"), "the live object, from the namespace");
});

test("bench: completion from a LIVE namespace types what static analysis cannot (grid.)", { skip: skipJedi }, async () => {
    const { completeIn } = await import("../src/python/python-runtime.ts");
    await complete("x = 1");   // loads Jedi and the helper if this runs alone
    const ns = freshNs();
    await benchRun("grid = np.arange(24).reshape(4, 6)", ns);
    const code = "grid.su";
    assert.deepEqual(completeIn(py, code, 1, code.length).map((c) => c.name), [], "without the namespace: nothing");
    assert.ok(completeIn(py, code, 1, code.length, ns).map((c) => c.name).includes("sum"), "with it: the live ndarray's methods");
});

// ── pyarrow ───────────────────────────────────────────────────────────────────────────────────────────────────
// Loaded at start and prepared in `before`, as the worker does. Used from INSIDE the readonly sandbox — proving a
// hardened script reads and writes Parquet and Arrow IPC with no JS bridge and no network, which pointer values need.
const hasPyarrow = hasPyodide && fs.readdirSync(PYODIDE_DIR).some((f) => f.startsWith("pyarrow-"));
const skipArrow = skip || (hasPyarrow ? false : "no pyarrow wheel in dist/pyodide — re-run `npm run fetch-pyodide`");

test("pyarrow: a hardened script round-trips a DataFrame through Parquet and Arrow IPC, after pandas ran before it", { skip: skipArrow, timeout: 120000 }, async () => {
    // pandas FIRST, as a sandbox that has already run something has.
    assert.equal((await pyRun("return pd.__version__", { hardened: true })).ok, true);
    const code = [
        "import pyarrow as pa",
        "buf = io.BytesIO()",
        "src = pd.DataFrame({'a': [1, 2, 3], 'b': ['x', 'y', None], 'c': [True, False, True]})",
        "src.to_parquet(buf)",
        "buf.seek(0)",
        "back = pd.read_parquet(buf)",
        "sink = pa.BufferOutputStream()",
        "table = pa.Table.from_pandas(src)",
        "with pa.ipc.new_file(sink, table.schema) as w: w.write_table(table)",
        "ipc = pa.ipc.open_file(sink.getvalue()).read_all().to_pandas()",
        "return {'parquet': [len(back), str(back.dtypes['a']), str(back.dtypes['c'])], 'ipc_equal': bool(ipc.equals(src)), 'version': pa.__version__}",
    ].join("\n");
    const r = await pyRun(code, { hardened: true });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.value.parquet, [3, "int64", "bool"]);
    assert.equal(r.value.ipc_equal, true);
    assert.match(r.value.version, /^22\./);
});

test("ADVERSARIAL pyarrow: its preparation leaves no route to `js` for a hardened script", { skip: skipArrow, timeout: 120000 }, async () => {
    // The dependency that needed `js` kept it as a module attribute; that is the one to try first.
    const r = await pyRun([
        "import sys, unix_timezones, pyarrow",
        "leaks = [name for name, mod in list(sys.modules.items()) if mod is not None and getattr(mod, 'js', None) is not None and name.split('.')[0] in ('pyarrow', 'unix_timezones', 'pandas')]",
        "return {'attr': hasattr(unix_timezones, 'js'), 'cached': 'js' in sys.modules, 'leaks': leaks}",
    ].join("\n"), { hardened: true });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.value, { attr: false, cached: false, leaks: [] });
    const imp = await pyRun("import js\nreturn 'reached'", { hardened: true });
    assert.equal(imp.ok, false, "`import js` still fails in a hardened run with pyarrow loaded");
});

// ── Stored tables (POINTER_VALUES slice 5) ────────────────────────────────────────────────────────────────────────────
// A table the value store holds reaches Python through `ml.table` as ONE copy of its bytes in a bytearray, decoded by
// the format it arrived in, in the HARDENED sandbox (the buffer is not a JsProxy, so nothing the hardening removed comes back).

test("stored table: Arrow IPC file and stream load as DataFrames with their own dtypes, in a hardened run", { skip: skipArrow, timeout: 120000 }, async () => {
    const { tableFromArrays, tableToIPC, vectorFromArray, Utf8, Int64 } = await import("apache-arrow");
    const t = tableFromArrays({ sku: vectorFromArray(["A", "B", "C"], new Utf8()), n: vectorFromArray([1n, 2n, 3n], new Int64()) });
    const code = "df = ml.table('f')\ns = ml.table('s')\nreturn [list(df.shape), str(df.dtypes['n']), int(df['n'].sum()), list(s.columns)]";
    const r = await pyRun(code, { hardened: true, tables: { f: storedAns(tableToIPC(t, "file"), { format: "arrow-file" }), s: storedAns(tableToIPC(t, "stream"), { format: "arrow-stream" }) } });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.value, [[3, 2], "int64", 6, ["sku", "n"]]);
});

test("stored table: Parquet loads through pyarrow", { skip: skipArrow, timeout: 120000 }, async () => {
    const made = py.runPython("import io as _i, pandas as _p\n_b = _i.BytesIO()\n_p.DataFrame({'x': [1.5, 2.5], 'y': ['a', 'b']}).to_parquet(_b)\n_b.getvalue()");
    const bytes = made?.toJs ? made.toJs() : made;
    made?.destroy?.();
    const r = await pyRun("df = ml.table('p')\nreturn [list(df.shape), float(df['x'].sum()), str(df.dtypes['x'])]", { hardened: true, tables: { p: storedAns(bytes, { format: "parquet" }) } });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.value, [[2, 2], 4, "float64"]);
});

test("stored table: delimited text is re-read with the PREVIEW's delimiter, columns and header decision", { skip, timeout: 120000 }, async () => {
    // A header row whose names the preview had already decided on, split on ';'.
    const withHeader = await pyRun("df = ml.table('s')\nreturn [list(df.columns), list(df.shape), int(df['qty'].sum())]",
        { tables: { s: storedAns("region;qty\nnorth;3\nsouth;4\n", { delimiter: ";", columns: ["region", "qty"] }) } });
    assert.equal(withHeader.ok, true, withHeader.error);
    assert.deepEqual(withHeader.value, [["region", "qty"], [2, 2], 7]);
    // No header row: the first line is data, and the columns are the preview's positional names.
    const headerless = await pyRun("df = ml.table('s')\nreturn [list(df.columns), list(df.shape)]",
        { tables: { s: storedAns("1\t2\n3\t4\n", { format: "tsv", headerless: true, columns: ["0", "1"] }) } });
    assert.equal(headerless.ok, true, headerless.error);
    assert.deepEqual(headerless.value, [["0", "1"], [2, 2]], "no record was eaten as a header");
});

test("ADVERSARIAL stored table: the buffer is gone after loading, and what Python holds is plain data with no route to `js`", { skip, timeout: 120000 }, async () => {
    const r = await pyRun([
        "import sys",
        "df = ml.table('s')",
        "left = [k for k in globals() if k.startswith('_ml_wbuf')]",
        "return {'left': left, 'js': 'js' in sys.modules, 'type': type(df).__name__}",
    ].join("\n"), { hardened: true, tables: { s: storedAns("a,b\n1,2\n", { columns: ["a", "b"] }) } });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.value, { left: [], js: false, type: "DataFrame" });
    const escape = await pyRun("df = ml.table('s')\nimport js\nreturn 'reached'", { hardened: true, tables: { s: storedAns("a\n1\n", { columns: ["a"] }) } });
    assert.equal(escape.ok, false, "reading a stored table does not bring `js` back");
});

test("stored table: an unknown format fails loudly at the call rather than loading nothing", { skip, timeout: 120000 }, async () => {
    const r = await pyRun("ml.table('x')", { tables: { x: storedAns("nope", { format: "xlsx" }) } });
    assert.match(r.error, /a stored table in a format the sandbox does not read: xlsx/);
});

// ── Returned frames become stored tables (POINTER_VALUES slice 6) ─────────────────────────────────────────────────────
test("a returned DataFrame past its preview carries its whole row count and comes back as Arrow IPC holding every row", { skip: skipArrow, timeout: 120000 }, async () => {
    const r = await pyRun("return pd.DataFrame({'x': range(1000), 'y': [i * 0.5 for i in range(1000)]})", { hardened: true });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.table.rows.length, 200, "the preview stays capped");
    assert.equal(r.table.rowCount, 1000, "…and says how big the frame is");
    assert.ok(r.ipc instanceof ArrayBuffer);
    const { tableFromIPC } = await import("apache-arrow");
    const t = tableFromIPC(new Uint8Array(r.ipc));
    assert.equal(t.numRows, 1000);
    assert.deepEqual(t.schema.fields.map((f) => f.name), ["x", "y"]);
    assert.equal(Number(t.getChild("x").get(999)), 999);
});

test("a frame inside its preview stores nothing, and one Arrow cannot hold still reports its size", { skip: skipArrow, timeout: 120000 }, async () => {
    const small = await pyRun("return pd.DataFrame({'x': range(10)})", { hardened: true });
    assert.equal(small.table.rowCount, undefined);
    assert.equal(small.ipc, undefined, "a preview that is the whole frame needs no stored value");
    const mixed = await pyRun("return pd.DataFrame({'x': [1, 'a', 2.5, object()] * 100})", { hardened: true });
    assert.equal(mixed.ok, true, mixed.error);
    assert.equal(mixed.table.rowCount, 400);
    assert.equal(mixed.ipc, undefined, "mixed object cells do not convert to Arrow, so nothing is stored");
});

// --- second-adversary pass: the _ml_in coercion on the "run" path, every cell and every injected name ---

test("run dict: a cell that poisons INJECTED_* to a JsProxy is re-coerced by the NEXT cell", { skip }, async () => {
    // A hostile cell can set INJECTED_IMAGE_B64 to anything, including a JsProxy.
    // The coercion runs at the top of every wrapUserCode (persist "run" and false), so the next cell's
    // prelude reads str/None — never a JsProxy the cell left behind.
    const ns = freshNs();
    await runCell("return 1", ns);
    await runCell("INJECTED_IMAGE_B64 = (lambda: None).__class__.__mro__\nreturn 1", ns);
    const r = await runCell("return [type(INJECTED_IMAGE_B64).__name__]", ns);
    assert.deepEqual(r.value, ["NoneType"], "the next cell's coercion drops whatever the previous cell left");
    assert.ok(!r.value.some((t) => /JsProxy|JsNull|JsUndefined/.test(t)), "never a JsProxy");
});

test("run dict: the coercion covers every injected name injectInputs sets, and nothing else leaks as a JsProxy", { skip }, async () => {
    // injectInputs sets INJECTED_IMAGE_B64 (and _ml_harness, which the wrapper pops); the worker sets _ml_send, and binds
    // a stored table's bytes as _ml_wbuf_<seq>. After a cell that passes an image and reads a stored table, the
    // namespace must hold no JsProxy of a host-injected name and none of the wire's pieces.
    const ns = freshNs();
    await runCell("t = ml.table('s')\nreturn 1", ns, { image: TINY_PNG, tables: { s: storedAns("a\n1\n") } });
    const r = await runCell("return [n for n in globals() if n.startswith('INJECTED_') or n.startswith('_ml_')]", ns);
    const names = r.value;
    assert.ok(names.includes("INJECTED_IMAGE_B64") && !names.includes("INJECTED_TABLES_JSON"), "the one coerced name remains; the tables one is gone");
    assert.ok(!names.includes("_ml_harness") && !names.includes("_ml_send") && !names.some((n) => n.startsWith("_ml_wbuf")), "the harness, transport and buffers are dropped");
    const types = await runCell(`return [type(globals()[n]).__name__ for n in ${JSON.stringify(["INJECTED_IMAGE_B64"])}]`, ns);
    assert.ok(types.value.every((t) => !/JsProxy|JsNull|JsUndefined/.test(t)), `both are str/None, not JsProxy: ${types.value}`);
});

test("run dict: bench (persist true) injects no INJECTED_* names and compiles no coercion", { skip }, async () => {
    // The bench's wipe keeps INJECTED_IMAGE_B64 if present (PY_BENCH_BASE_NAMES),
    // but injectInputs is never called for bench, so they are never set. Pin: a bench namespace has no
    // INJECTED_* names, and the bench wrapper has no _ml_in.
    const { wrapUserCode } = await import("../src/python/python-runtime.ts");
    const bench = wrapUserCode("return 1", true, true);
    assert.ok(!bench.includes("def _ml_in"), "the bench compiles no coercion (it injects no names)");
    const ns = freshNs();
    const inj = await benchRun("return [n for n in globals() if n.startswith('INJECTED_')]", ns);
    assert.deepEqual(inj, { value: [] }, "a bench namespace holds no INJECTED_* names");
    assert.deepEqual(await benchRun("return 1", ns), { value: 1 }, "positive control: the bench still runs");
});

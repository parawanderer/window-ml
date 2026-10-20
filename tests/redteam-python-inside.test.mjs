// redteam-python-inside.test.mjs — a red-team pass on PR #880's inside-the-dialect try (python_exec cells run unasked only inside the fork's gate).
//
// Threat: a cell the host runs INSIDE the dialect (unasked) plants a binding or a function whose body never ran under the
// gate; a later cell — a full-path rerun after approval, or the wrapper's own code — then reaches what the gate refused.
// Each test names the property the boundary must keep and carries a positive control. Written failing-first (`{ todo: … }`, since removed)
// against `pr-880` / `3a7b09b5`; the fixer removes the `todo` when the property holds.
//
// Real fork core: `npm run fetch-pyodide` then `node build.mjs`; `dist/pyodide/python_stdlib.zip` must hold `restricted.py`.
// Self-SKIPS without dist/pyodide or on the stock core. Drives `wrapUserSetup` + `wrapUserScript(…, inside)` exactly as
// python-worker.ts does. Genre: python.
import { test, before } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { wrapUserSetup, wrapUserScript } from "../src/python/python-runtime.ts";
import { dialectSetup } from "../src/python/python-dialect-run.js";
import { pythonCellInDialect, pythonOutsideWhy } from "../src/agent/python-dialect.ts";

const PYODIDE_DIR = path.resolve(import.meta.dirname, "../dist/pyodide");
const DATA_DIR = path.resolve(import.meta.dirname, "../notebooks/python-dialect/data");
const FILES = Object.fromEntries(["whitelist.json", "manifest-stdlib.json", "manifest-numpy.json", "manifest-pandas.json", "manifest-pil.json"]
    .map((f) => [f, fs.readFileSync(path.join(DATA_DIR, f), "utf8")]));
const NODES = JSON.parse(FILES["whitelist.json"]).nodes;
const hasPyodide = fs.existsSync(path.join(PYODIDE_DIR, "pyodide.mjs"));

let py = null;
let skip = hasPyodide ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";

/** Wire calls that reached `_ml_send`, drained per test. */
let wireLog = [];

before(async () => {
    if (!hasPyodide) return;
    const { loadPyodide } = await import(path.join(PYODIDE_DIR, "pyodide.mjs"));
    py = await loadPyodide({ indexURL: PYODIDE_DIR });
    if (py.runPython(`import importlib.util; importlib.util.find_spec("_restricted") is None`)) { skip = "dist/pyodide is the stock core, not the restricted-mode fork"; return; }
    await py.loadPackage(["numpy", "pandas", "pillow"]);
    await py.runPythonAsync(dialectSetup(FILES));
}, { timeout: 240000 });

/** A fresh namespace with the wire transport installed, as python-worker.ts does before every cell. */
function world() {
    const ns = py.globals.get("dict")();
    ns.set("_ml_send", (s) => { wireLog.push(String(s)); return Promise.resolve(JSON.stringify({ seq: 1, value: "WIRE_OK" })); });
    return ns;
}

/** One cell in `ns`, as the worker runs it: the setup, then the cell inside (or on the full path). */
async function cell(ns, code, inside = true) {
    wireLog = [];
    try {
        await py.runPythonAsync(wrapUserSetup(false, "run"), { globals: ns });
        await py.runPythonAsync(wrapUserScript(code, "run", inside ? { nodes: NODES } : null), { globals: ns });
    } catch (e) {
        return { threw: String(e).split("\n").slice(0, 4).join(" | ") };
    }
    return {
        refused: inside ? ns.get("_ml_not_in_dialect") : undefined,
        error: ns.get("_err"),
        value: ns.has("_json_result") ? String(ns.get("_json_result")) : undefined,
        stdout: ns.has("_stdout") ? String(ns.get("_stdout")) : undefined,
        wire: wireLog.slice(),
    };
}

// --- property 1: a refused inside run leaves only reads ---

test("P1-namespace: a refused inside run leaves shared values as it found them (in-place writes are refused before they land)", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    const attempts = [
        ["lst += [4]", "lst += [4]\nimport os", "lst", "[1, 2, 3]"],
        ["lst[0] = 99", "lst[0] = 99\nimport os", "lst", "[1, 2, 3]"],
        ["lst.append(4)", "lst.append(4)\nimport os", "lst", "[1, 2, 3]"],
        ["d |= {'b': 2}", "d |= {'b': 2}\nimport os", "d", "{'a': 1}"],
        ["d['x'] = 9", "d['x'] = 9\nimport os", "d", "{'a': 1}"],
    ];
    for (const [label, code, name, want] of attempts) {
        const ns = world();
        py.runPython(`import ast`);
        // bind the shared value in ns via a tiny setup cell on the full path
        await cell(ns, name === "lst" ? "lst = [1, 2, 3]" : "d = {'a': 1}", false);
        const out = await cell(ns, code);
        assert.ok(out.refused, `${label} refused: ${JSON.stringify(out)}`);
        const after = String(await py.runPythonAsync(`repr(lst if 'lst' in dir() else d)`, { globals: ns }));
        assert.strictEqual(after, want, `${label} left ${name} as it found it`);
    }
    // positive control: a finished cell's binding persists
    const ns = world();
    await cell(ns, "x = 42");
    assert.strictEqual(String(await py.runPythonAsync("repr(x)", { globals: ns })), "42");
});

test("P1-output: a refused inside run's output is discarded (the try's stdout never reaches the call's result)", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    const ns = world();
    const out = await cell(ns, "print('LEAKED')\nimport os");
    assert.ok(out.refused, `expected a refusal, got ${JSON.stringify(out)}`);
    // DEFENDED: the try's output is dropped with its bindings. Positive control below: a finished cell keeps its print.
    assert.strictEqual(out.stdout, "", "a refused try's stdout is discarded, not left in the call's output");
    const ok = await cell(ns, "print('KEPT')\nreturn 1");
    assert.strictEqual(ok.stdout, "KEPT\n", "positive control: a finished inside cell keeps its print");
});

test("P1-ml: a function a cell defines inside cannot reach `ml` when later code calls it (no write reaches the wire from an inside run)", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    const ns = world();
    const def = await cell(ns, "def f():\n    return ml.config()");
    // A function made inside carries a body the gate never ran: the try is outside and leaves nothing (#892).
    // The fork enters a cell's own code only inside a run (#895), so the function crosses back; calling it later is refused.
    assert.ok(!def.refused, JSON.stringify(def));
    // DEFENDED: calling f later — the full path of a rerun after approval — must not send a wire call the inside run never made.
    const call = await cell(ns, "return await f()", false);
    assert.deepStrictEqual(call.wire, [], "an inside-defined function does not reach ml when ordinary code calls it");
    // positive control: the facade works when the full path calls it directly
    const direct = await cell(ns, "return await ml.config()", false);
    assert.deepStrictEqual(direct.wire, ['{"seq": 1, "call": "config", "args": []}'], "positive control: the full path's own ml call sends");
});

// --- property 2: an inside run's bindings never shadow what the wrapper calls; a cell-defined function runs ungated later ---

test("P2-shadow: `_` names and builtin names are not copied back (positive control of the copy rule)", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    const ns = world();
    const out = await cell(ns, "y = 3\n_z = 4\nlen = 5\nreturn y");
    assert.strictEqual(out.value, "3");
    assert.strictEqual(await py.runPythonAsync("'_z' in globals()", { globals: ns }), false);
    assert.strictEqual(await py.runPythonAsync("'len' in globals()", { globals: ns }), false);
    assert.strictEqual(await py.runPythonAsync("repr(y)", { globals: ns }), "3");
});

test("P2-ungated: a function a cell defines inside does not run UNGATED when a later full-path cell calls it", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    const ns = world();
    const def = await cell(ns, "def f():\n    import os\n    return os.listdir('/')");
    // The fork enters a cell's own code only inside a run (#895), so the function crosses back; calling it later is refused.
    assert.ok(!def.refused, JSON.stringify(def));
    // DEFENDED: f's body carries the inside gate with it; a later call cannot `import os`.
    const call = await cell(ns, "return f()", false);
    assert.ok(call.error || call.threw, `f() must not run its body ungated: ${JSON.stringify(call)}`);
    // positive control: the same import on the full path, written there, is full Python (the person approved it)
    const direct = await cell(ns, "import os\nreturn os.listdir('/')", false);
    assert.ok(!direct.error && !direct.threw, `positive control: the full path is full Python: ${JSON.stringify(direct)}`);
});

test("P2-capture: a builtin the gate refuses to CALL is not left behind as a callable binding", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    for (const [label, code, name] of [
        ["f = open", "f = open", "f"],
        ["f = getattr", "f = getattr", "f"],
        ["f = setattr", "f = setattr", "f"],
        ["def f(): return open", "def f():\n    return open", "f"],
        ["f = lambda: open", "f = lambda: open", "f"],
    ]) {
        const ns = world();
        const out = await cell(ns, code);
        // DEFENDED: the callable is not copied back — the name may be bound to nothing the full path can call.
        const leaked = await py.runPythonAsync(`import restricted\n_f = globals().get('${name}')\n'CLEAR' if not callable(_f) or (type(_f).__name__ == 'function' and _f.__code__.co_flags & restricted.CO_RESTRICTED) else repr(_f)`, { globals: ns });
        assert.strictEqual(String(leaked), "CLEAR", `${label} must not leave a callable ${name} that runs outside a run`);
    }
    // positive control: a harmless binding does persist
    const ns = world();
    await cell(ns, "f = 1");
    assert.strictEqual(String(await py.runPythonAsync("repr(f)", { globals: ns })), "1");
});

test("P2-container: a DATA binding does not smuggle code past the copy-back (a list of lambdas, an instance of an inside-defined class)", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    // 1. a list whose element is a lambda — the list is data, the element is code
    {
        const ns = world();
        const out = await cell(ns, "f = [lambda: open]");
        const call = await cell(ns, "return f[0]()", false);
        assert.ok(!/built-in function open/.test(String(call.value)), `f[0]() must not return open: ${JSON.stringify(call)}`);
    }
    // 2. an instance of a class the cell defined — the instance is data, its method carries code
    {
        const ns = world();
        const out = await cell(ns, "class C:\n    def run(self):\n        return open\nc = C()");
        const call = await cell(ns, "return c.run()", false);
        assert.ok(!/built-in function open/.test(String(call.value)), `c.run() must not return open: ${JSON.stringify(call)}`);
    }
    // 3. a dict whose value is a lambda
    {
        const ns = world();
        const out = await cell(ns, "f = {'g': lambda: open}");
        const call = await cell(ns, "return f['g']()", false);
        assert.ok(!/built-in function open/.test(String(call.value)), `f['g']() must not return open: ${JSON.stringify(call)}`);
    }
    // 4. nested containers
    {
        const ns = world();
        const out = await cell(ns, "f = [[lambda: open]]");
        const call = await cell(ns, "return f[0][0]()", false);
        assert.ok(!/built-in function open/.test(String(call.value)), `f[0][0]() must not return open: ${JSON.stringify(call)}`);
    }
    // positive control: a data binding with no code inside persists and reads back
    const ns = world();
    await cell(ns, "f = [1, 2, 3]");
    assert.strictEqual(String(await py.runPythonAsync("repr(f)", { globals: ns })), "[1, 2, 3]");
});

test("P2-alias: a non-data value crosses back only under a name it already had (a = ml and f = [ml] put the cell outside)", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    // 1. a new name for a pre-existing instance — the ruling's first example
    {
        const ns = world();
        const out = await cell(ns, "a = ml");
        assert.ok(out.refused, `a = ml puts the cell outside (a non-data value under a new name, #896): ${JSON.stringify(out)}`);
    }
    // 2. a new container holding a pre-existing instance — the ruling's second example
    {
        const ns = world();
        const out = await cell(ns, "f = [ml]");
        assert.ok(out.refused, `f = [ml] puts the cell outside (a non-data value in a new container, #896): ${JSON.stringify(out)}`);
    }
    // 3. a new container holding a pre-existing function
    {
        const ns = world();
        await cell(ns, "def helper(x):\n    return x", false);
        const out = await cell(ns, "f = [helper]");
        assert.ok(out.refused, `f = [helper] puts the cell outside: ${JSON.stringify(out)}`);
    }
    // 4. a new name for a pre-existing function
    {
        const ns = world();
        await cell(ns, "def helper(x):\n    return x", false);
        const out = await cell(ns, "a = helper");
        assert.ok(out.refused, `a = helper puts the cell outside: ${JSON.stringify(out)}`);
    }
    // 5. a new name for the error class
    {
        const ns = world();
        const out = await cell(ns, "a = MlError");
        assert.ok(out.refused, `a = MlError puts the cell outside: ${JSON.stringify(out)}`);
    }
    // 6. a tuple / set holding a pre-existing instance
    {
        const ns = world();
        const out = await cell(ns, "f = (ml, 1)");
        assert.ok(out.refused, `f = (ml, 1) puts the cell outside: ${JSON.stringify(out)}`);
    }
    // 7. the returned value is a new container holding a non-data value
    {
        const ns = world();
        const out = await cell(ns, "return [ml]");
        assert.ok(out.refused, `return [ml] puts the cell outside (the result carries a non-data value): ${JSON.stringify(out)}`);
    }
    // 8. the returned value is itself a non-data value
    {
        const ns = world();
        const out = await cell(ns, "return ml");
        assert.ok(out.refused, `return ml puts the cell outside: ${JSON.stringify(out)}`);
    }
    // positive controls: a data alias and an admitted import's own binding cross (z = math would be a NEW name for a
    // module, outside under #896 like m = math, so the control binds the import itself)
    {
        const ns = world();
        const ok = await cell(ns, "x = 42\ny = x\nimport math as z");
        assert.ok(!ok.refused, JSON.stringify(ok));
        assert.strictEqual(String(await py.runPythonAsync("repr(y)", { globals: ns })), "42");
        assert.strictEqual(String(await py.runPythonAsync("'z' in globals()", { globals: ns })), "true");
    }
});

// --- property 3: fail closed ---

test("P3-fail-closed: the seam answers outside for every cell (no source-only positive verdict)", () => {
    for (const code of ["1 + 1", "import os", "x = open", "def f(): return open"]) {
        assert.strictEqual(pythonCellInDialect(code), false, code);
    }
});

test("P3-why: pythonOutsideWhy names the fork's refusal", () => {
    const why = pythonOutsideWhy("not in dialect: import 'os' (line 1)");
    assert.match(why.line, /import 'os' \(line 1\)/);
    assert.strictEqual(why.cause, "outside-dialect");
});

// --- property 5: anything check() admits that only run time refuses ---

test("P5-calls: run-time refusals for modules, open, js and dunder paths (each refuses and would ask)", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    const cases = [
        ["import os", /import 'os'/],
        ["import js", /import 'js'/],
        ["import pyodide.http", /import 'pyodide\.http'/],
        ["open('/etc/passwd')", /call on builtin_function_or_method/],
        ["getattr(int, 'to_bytes')", /call on builtin_function_or_method/],
        ["type(1).mro()", /attribute 'mro'/],
        ["(1).__class__", /the attribute __class__/],
        ["type(1).__dict__", /the attribute __dict__/],
        ["().__class__.__bases__[0].__subclasses__()", /the attribute __subclasses__/],
    ];
    for (const [code, re] of cases) {
        const out = await cell(world(), code);
        assert.ok(out.refused, `${code} refused: ${JSON.stringify(out)}`);
        assert.match(String(out.refused), re, code);
        assert.ok(pythonOutsideWhy(out.refused).line.startsWith("Outside the read-only Python dialect"), code);
    }
});

test("P5-nameload: a name load of a refused builtin does not hand back the callable", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    for (const code of ["return open", "return getattr", "return setattr", "return __import__"]) {
        const out = await cell(world(), code);
        // DEFENDED: either refused, or the value is not the live builtin.
        if (out.refused) continue;
        assert.ok(!/built-in function/.test(String(out.value)), `${code} must not return the live builtin: ${JSON.stringify(out)}`);
    }
    // positive control: a name the dialect does allow returns its value
    const ok = await cell(world(), "return [abs][0](-2)");
    assert.strictEqual(ok.value, "2", "positive control: an allowed builtin's name load works inside the cell");
});

// --- the probe table (PR #901, core 77376876): every route into a cell-defined function is refused on the full path ---
// Pins the shapes the `probe-*.mjs` drivers drove, so a later change cannot flip one quietly. The fork's `OutsideRunTest`
// holds the RESUME check at the C level; these hold the seam around it: what copy-back admits, and what the full path
// of `wrapUserScript` does with what crossed back. `CELL FUNCTIONS` in `python-dialect-inside.test.mjs` already pins
// the direct call and the later inside call; these are the other routes and the walk's own catches.

/** The fork's outside-a-run refusal, whichever field the wrapper put it in. */
function forkRefusal(out) {
    const text = String(out.error ?? out.threw ?? "");
    return /NotInDialect: not in dialect: .*was defined in a cell that ran inside the read-only dialect/.test(text) ? text : null;
}

test("P4-routes: a cell function is refused on the full path for every way in (call, exec, map, sorted, nested, container)", { timeout: 90000 }, async (t) => {
    if (skip) return t.skip(skip);
    const shapes = [
        ["lambda in a list", "f = [lambda: 42]\nreturn 1", "return f[0]()"],
        ["lambda in a dict", "f = {'g': lambda: 42}\nreturn 1", "return f['g']()"],
        ["default-only def", "def f(x=1):\n    return x\nreturn 1", "return f()"],
        ["nested def", "def outer():\n    def inner():\n        return 7\n    return inner\ng = outer\nreturn 1", "return outer()()"],
        ["exec of its code", "def f():\n    return 42\nreturn 1", "exec(f.__code__, {})\nreturn 1"],
        ["map's C callback", "def f(x):\n    return x\nreturn 1", "return list(map(f, [1]))"],
        ["sorted's key callback", "def f(x):\n    return x\nreturn 1", "return sorted([2, 1], key=f)"],
    ];
    for (const [label, defCode, callCode] of shapes) {
        const ns = world();
        const def = await cell(ns, defCode);
        assert.ok(!def.refused, `${label}: the def is admitted (a CO_RESTRICTED function crosses back, #901): ${JSON.stringify(def)}`);
        const call = await cell(ns, callCode, false);
        assert.match(forkRefusal(call) ?? String(call.error ?? call.threw ?? call), /NotInDialect: not in dialect: .*was defined in a cell that ran inside the read-only dialect/,
            `${label}: the fork's outside-run refusal, not some other error: ${JSON.stringify(call)}`);
    }
    // positive control: the same call written on the full path is full Python (the person approved it)
    const direct = await cell(world(), "return sorted([2, 1])", false);
    assert.strictEqual(direct.value, "[1, 2]", "positive control: the full path runs ordinary code");
});

test("P4-generator: a cell-defined generator stays closed — gate-first today, and the full-path call refused if Yield ever enters the whitelist", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    const ns = world();
    const def = await cell(ns, "def gen():\n    yield 1\n    yield 2\nreturn 1");
    if (def.refused) {
        // Gate-first today: Yield is not in the node whitelist. Still closed if that ever changes.
        t.diagnostic(`gate-first: ${def.refused}`);
    } else {
        const call = await cell(ns, "return list(gen())", false);
        assert.match(forkRefusal(call) ?? String(call.error ?? call.threw ?? call), /NotInDialect: not in dialect: .*was defined in a cell that ran inside the read-only dialect/,
            `a cell-defined generator must not run on the full path: ${JSON.stringify(call)}`);
    }
    // positive control: a generator written on the full path is full Python
    const direct = await cell(world(), "def gen():\n    yield 1\nreturn list(gen())", false);
    assert.strictEqual(direct.value, "[1]", "positive control: the full path is full Python");
});

test("P4-ml-closure: ml carried in a default or a closure puts the cell outside (it leaves 'name' holding a _Ml)", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    for (const [label, code] of [
        ["ml as a default", "def outer(ml=ml):\n    def inner():\n        return ml.config()\n    return inner\ng = outer()\nreturn 1"],
        ["ml in a closure cell", "def outer():\n    x = ml\n    return lambda: x.config()\ng = outer()\nreturn 1"],
    ]) {
        const out = await cell(world(), code);
        assert.ok(out.refused, `${label} must not cross back: ${JSON.stringify(out)}`);
        assert.match(String(out.refused), /^it leaves '\w+' holding a _Ml/, label);
    }
    // positive control: a data default crosses
    const ok = await cell(world(), "def f(x=1):\n    return x\nreturn 1");
    assert.ok(!ok.refused, JSON.stringify(ok));
});

test("P4-strip: the stated residual (#903) — a full-path cell CAN strip CO_RESTRICTED and run the body ungated", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    // STATED RESIDUAL, not a hole to fix (#903): a fresh types.CodeType from the same bytes would do the same, and the
    // flag cannot be made unstrippable without taking code-object access from the full path, which it has by design.
    // This pin asserts the residual HOLDS AS RECORDED. If this test flips, the spec's layer-1 residual sentence
    // (docs/spec/PYTHON_DIALECT.md, from #903) gets rewritten — the guarantee's edge moved.
    const ns = world();
    await cell(ns, "def f():\n    return 7");
    const strip = await cell(ns, "import types, restricted\nc = f.__code__.replace(co_flags=f.__code__.co_flags & ~restricted.CO_RESTRICTED)\nf2 = types.FunctionType(c, f.__globals__)\nreturn f2()", false);
    assert.strictEqual(strip.value, "7", `the residual: the stripped body runs ungated (spec layer-1, #903): ${JSON.stringify(strip)}`);
    // and the unstripped call is still refused — the residual is the strip, not a general bypass
    const raw = await cell(ns, "return f()", false);
    assert.match(forkRefusal(raw) ?? String(raw.error ?? raw.threw ?? raw), /NotInDialect/, `the unstripped call is still refused: ${JSON.stringify(raw)}`);
});

// --- higher-order sinks (probe-hof): a library call invokes a cell-defined callable while the run is active ---

test("P5-hof: a library call that invokes a cell-defined callable cannot smuggle an effect past the gate", { timeout: 120000 }, async (t) => {
    if (skip) return t.skip(skip);
    const HOST = /\/private\/|\/etc\/|root:|tmp|home|dev|proc|lib/;
    const sinks = [
        ["df.pipe(lambda)", "import pandas as pd\ndf = pd.DataFrame({'a': [1]})\nout = df.pipe(lambda d: open('/etc/hostname').read())\nreturn out"],
        ["df.apply(lambda)", "import pandas as pd\ndf = pd.DataFrame({'a': [1]})\nout = df.apply(lambda s: open('/etc/hostname').read())\nreturn 1"],
        ["sorted(key=)", "out = sorted([2, 1], key=lambda x: open('/etc/hostname').read())\nreturn out"],
        ["max(key=)", "out = max([1, 2], key=lambda x: open('/etc/hostname').read())\nreturn out"],
        ["list.sort(key=)", "xs = [2, 1]\nxs.sort(key=lambda x: open('/etc/hostname').read())\nreturn xs"],
        ["re.sub(repl=)", "import re\nout = re.sub('x', lambda m: open('/etc/hostname').read(), 'x')\nreturn out"],
        ["json.dumps(default=)", "import json\nout = json.dumps([object()], default=lambda o: open('/etc/hostname').read())\nreturn out"],
        ["list comp with open", "out = [open('/etc/hostname').read() for _ in [1]]\nreturn out"],
        ["dict comp with open", "out = {i: open('/etc/hostname').read() for i in [1]}\nreturn out"],
        ["genexp passed to join", "out = ''.join(open('/etc/hostname').read() for _ in [1])\nreturn out"],
        ["map forced by list()", "out = list(map(lambda x: open('/etc/hostname').read(), [1]))\nreturn out"],
        ["pre-existing apply(fn)", "out = apply(lambda: open('/etc/hostname').read(), 1)\nreturn out"],
    ];
    for (const [label, code] of sinks) {
        const ns = world();
        await cell(ns, "def apply(f, x):\n    return f(x)", false);
        const out = await cell(ns, code);
        // Either the gate refuses the cell, or it finishes and the result is not a filesystem read.
        if (out.refused || out.error || out.threw) continue;
        assert.ok(!HOST.test(String(out.value)), `${label}: the callable's effect must not reach the result: ${JSON.stringify(out)}`);
    }
    // positive control: the same sinks with a pure callable return ordinary data
    const ns = world();
    await cell(ns, "def apply(f, x):\n    return f(x)", false);
    const ok = await cell(ns, "import pandas as pd\ndf = pd.DataFrame({'a': [1]})\nout = df.pipe(lambda d: 42)\nreturn out");
    assert.strictEqual(ok.value, "42", `positive control: df.pipe with a pure lambda works: ${JSON.stringify(ok)}`);
});

// --- identity / return-value corners (probe-id, probe-import): what the walk admits under a new name or as the result ---

test("P5-return: a returned value that holds a pre-existing non-data object does not cross back", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    for (const [label, code, re] of [
        ["return (ml, 1)", "return (ml, 1)", /^it leaves the value it returns holding a _Ml/],
        ["df.pipe(lambda d: ml)", "import pandas as pd\ndf = pd.DataFrame({'a': [1]})\nout = df.pipe(lambda d: ml)\nreturn 1", /^it leaves '\w+' holding a _Ml/],
    ]) {
        const out = await cell(world(), code);
        assert.ok(out.refused, `${label} must not cross back: ${JSON.stringify(out)}`);
        assert.match(String(out.refused), re, `${label}: ${JSON.stringify(out)}`);
    }
    // A key that returns ml dies before the walk: sorted compares the keys and `'<` is not supported on `_Ml`.
    // Fail-closed either way — the cell does not finish and leave a binding holding ml.
    const die = await cell(world(), "out = sorted([1, 2], key=lambda x: ml)\nreturn 1");
    assert.ok(die.refused || die.error || die.threw, `sorted(key=… ml) must not finish with a binding holding ml: ${JSON.stringify(die)}`);
    // positive control: a pipe that returns data crosses
    const ok = await cell(world(), "import pandas as pd\ndf = pd.DataFrame({'a': [1]})\nout = df.pipe(lambda d: 42)\nreturn out");
    assert.strictEqual(ok.value, "42", JSON.stringify(ok));
});

test("P5-rebind: the import exemption's name can be rebound to data, but not to a container holding the module", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    // data under the import's own name: admitted (the walk sees data)
    const ok = await cell(world(), "import math\nmath = 5\nreturn math");
    assert.ok(!ok.refused, JSON.stringify(ok));
    assert.strictEqual(ok.value, "5");
    // a new container holding the module, even under the import's name: outside (#896)
    const bad = await cell(world(), "import math\nmath = [math]\nreturn 1");
    assert.ok(bad.refused, JSON.stringify(bad));
    assert.match(String(bad.refused), /^it leaves 'math' holding a module/, JSON.stringify(bad));
});

test("P5-import-gate: a dangerous import is gate-first, even in the from-shape the exemption would otherwise admit", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    for (const code of ["from os import system\nreturn 1", "from numpy import __import__\nreturn 1", "import js\nreturn 1"]) {
        const out = await cell(world(), code);
        assert.ok(out.refused, `${code}: gate-first: ${JSON.stringify(out)}`);
        assert.ok(!/^it leaves /.test(String(out.refused)), `${code}: the gate refuses the import itself, not the walk: ${JSON.stringify(out)}`);
    }
    // positive control: an admitted import's own binding crosses (attribute access on it is a separate gate)
    const ns = world();
    const ok = await cell(ns, "import math as z\nreturn 1");
    assert.ok(!ok.refused, JSON.stringify(ok));
    assert.strictEqual(await py.runPythonAsync("'z' in globals()", { globals: ns }), true, "positive control: z crossed back");
});

// --- shared-object writes (probe-inside P1d/g/h, probe-inside3 P3a/b): a refused or failed cell leaves them as it found them ---

test("P1-shared-write: an in-place write on a shared object is gate-refused before it lands (probe-inside P1a–h)", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    for (const [label, plant, code, want] of [
        ["df.iloc", "import pandas as pd\ndf = pd.DataFrame({'a': [1, 2]})", "df.iloc[0, 0] = 99\nimport os", "df"],
        ["df.loc", "import pandas as pd\ndf = pd.DataFrame({'a': [1, 2]})", "df.loc[0, 'a'] = 99\nimport os", "df"],
        ["df column", "import pandas as pd\ndf = pd.DataFrame({'a': [1, 2]})", "df['a'][0] = 99\nimport os", "df"],
        ["list append", "lst = [1, 2, 3]", "lst.append(4)\nimport os", "lst"],
        ["list item", "lst = [1, 2, 3]", "lst[0] = 99\nimport os", "lst"],
        ["dict key", "d = {'a': 1}", "d['x'] = 9\nimport os", "d"],
    ]) {
        const ns = world();
        await cell(ns, plant, false);
        const before = String(await py.runPythonAsync(`repr(${want})`, { globals: ns }));
        const out = await cell(ns, code);
        assert.ok(out.refused, `${label}: refused: ${JSON.stringify(out)}`);
        assert.match(String(out.refused), /writes a value the cell does not own|not in dialect/, `${label}: the write is what is refused, not a later step: ${JSON.stringify(out)}`);
        const after = String(await py.runPythonAsync(`repr(${want})`, { globals: ns }));
        assert.strictEqual(after, before, `${label} left ${want} as it found it`);
    }
    // Positive controls: a write on an object the cell itself made is fine; a read of a shared one is fine.
    // An inside cell cannot mutate a shared object at all — the write is refused even with no later refusal.
    const own = world();
    const ok = await cell(own, "lst = [1, 2, 3]\nlst.append(4)\nreturn lst");
    assert.strictEqual(ok.value, "[1, 2, 3, 4]", `a cell owns what it made: ${JSON.stringify(ok)}`);
    const ns = world();
    await cell(ns, "lst = [1, 2, 3]", false);
    const read = await cell(ns, "return len(lst)");
    assert.strictEqual(read.value, "3", `a read of a shared value works: ${JSON.stringify(read)}`);
});

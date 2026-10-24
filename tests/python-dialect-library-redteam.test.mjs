// python-dialect-library-redteam.test.mjs — the rule-10 red-team pass on the tier 3 library load and shape rule
// (READONLY_LIBRARY_MANIFEST.md, "The runtime import loop", ruled 2026-10-24), on the real fork core: what a module that
// is proposed and approved must NOT let a cell do. Each property is a test; where the gate already held it is a pin, and
// what was probed and not gotten is listed at the end of its section. Self-SKIPS without dist/pyodide/ or on the stock
// core.
//
// The worker's path (the proposal, the card, the store, the snapshot) is tests/propose-library-redteam.test.mjs.

import { test, before } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { dialectSetup, libraryLoad, libraryShape } from "../src/python/python-dialect-run.js";

const PYODIDE_DIR = path.resolve(import.meta.dirname, "../dist/pyodide");
const DATA_DIR = path.resolve(import.meta.dirname, "../notebooks/python-dialect/data");
const FILES = Object.fromEntries(["whitelist.json", "manifest-stdlib.json", "manifest-numpy.json", "manifest-pandas.json", "manifest-pil.json"]
    .map((f) => [f, fs.readFileSync(path.join(DATA_DIR, f), "utf8")]));
const NODES = JSON.parse(FILES["whitelist.json"]).nodes;
/** What the worker reserves: the dialect's modules and every import name in the Pyodide lock. */
const reservedNames = () => [...JSON.parse(FILES["whitelist.json"]).modules,
    ...Object.values(JSON.parse(fs.readFileSync(path.join(PYODIDE_DIR, "pyodide-lock.json"), "utf8")).packages).flatMap((p) => p.imports ?? [])];
const hasPyodide = fs.existsSync(path.join(PYODIDE_DIR, "pyodide.mjs"));

let py = null;
let skip = hasPyodide ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";

before(async () => {
    if (!hasPyodide) return;
    const { loadPyodide } = await import(path.join(PYODIDE_DIR, "pyodide.mjs"));
    py = await loadPyodide({ indexURL: PYODIDE_DIR });
    if (py.runPython(`import importlib.util; importlib.util.find_spec("_restricted") is None`)) { skip = "dist/pyodide is the stock core, not the restricted-mode fork"; return; }
    assert.strictEqual(await py.runPythonAsync(dialectSetup(FILES)), "");
}, { timeout: 240000 });

const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
/** A library as the worker is handed it: pinned to its source's sha256. */
const lib = (name, source, names, pin = sha(source)) => ({ name, source, sha256: pin, names });
/** Load libraries; the reason each was refused, "" when loaded. */
async function load(...libs) {
    return Object.fromEntries(JSON.parse(await py.runPythonAsync(libraryLoad(libs, NODES, reservedNames()))).map((r) => [r.name, r.why]));
}
/** A cell inside the dialect, as `run_cell` runs it: its value, or the refusal. */
function cell(src) {
    return JSON.parse(py.runPython(`
import json, restricted
try:
    _v = restricted.run_cell(${JSON.stringify(src)}, {}, budget=200000)
    _out = {"value": _v}
except BaseException as _e:
    _out = {"refused": type(_e).__name__ + ": " + str(_e)}
json.dumps(_out, default=repr)
`));
}
/** The shape rule's verdict: `{ why, defs, constants }`; `why === ""` when admitted. */
async function shape(name, source) {
    return JSON.parse(await py.runPythonAsync(libraryShape(name, source, NODES, reservedNames())));
}

// --- nothing in the proposed source executes before the person's word ---

test("the shape rule refuses every form that would run at load, without running it", async (t) => {
    if (skip) return t.skip(skip);
    // Each would execute at import time in plain Python. Shape must refuse by AST alone.
    const EXE = {
        decorator: "def deco(f):\n    return f\n@deco\ndef g():\n    return 1",
        decorator_call: "def deco(f):\n    return f\n@deco()\ndef g():\n    return 1",
        fstring_open: "X = f\"{open('/dev/null').read()}\"",
        fstring_plain: "X = f\"hello\"",
        comprehension: "X = [open('/dev/null').read() for _ in range(1)]",
        call_default: "def f(n=open('/dev/null').read()):\n    return n",
        call_default_builtin: "def f(n=len('a')):\n    return n",
        annotation_call: "X: int = open('/dev/null').read()",
        lambda_default: "def f(n=(lambda: 1)):\n    return n",
        walrus: "if (n := 1):\n    X = n",
        aug_assign: "X = 1\nX += 1",
        delete: "X = 1\ndel X",
        global_stmt: "X = 1\ndef f():\n    global X\n    return X",
        yield_in_def: "def f():\n    yield 1",
        async_def: "async def f():\n    return 1",
        module_return: "return 1",
        star_assign: "(a, *b) = [1, 2, 3]",
        binop_const: "X = 10 ** 100",
        nested_mutable_tuple: "X = (1, [2])",
        dunder_const: "X = __debug__",
        class_def: "class C:\n    pass",
        import_not_admitted: "import sys\ndef f():\n    return 1",
    };
    for (const [k, src] of Object.entries(EXE)) {
        const s = await shape(`ex_${k}`, src);
        assert.notEqual(s.why, "", `shape admitted ${k}, which would run at load`);
        assert.equal(s.defs?.length ?? 0, 0, `shape listed defs for ${k}`);
    }
    // Positive control: the admitted shape is still admitted.
    const ok = await shape("ok", "def g():\n    return 1\nSCALE = 2\n");
    assert.equal(ok.why, "");
    assert.deepEqual(ok.defs.map((d) => d.name), ["g"]);
    assert.deepEqual(ok.constants, ["SCALE"]);
});

test("nothing executes at the shape op: a module that would write a marker does not", async (t) => {
    if (skip) return t.skip(skip);
    py.FS.mkdirTree("/pre");
    py.FS.writeFile("/pre/evilmod.py", "import pathlib\npathlib.Path('/pre/MARKER').write_text('RAN')\nX = 1\n");
    py.runPython(`import sys; sys.path.insert(0, "/pre")`);
    const before = py.runPython(`import os; os.path.exists('/pre/MARKER')`);
    assert.equal(before, false, "the marker is not there to begin with");
    const s = await shape("evilmod", "import evilmod\ndef f():\n    return 1");
    assert.notEqual(s.why, "", "a not-admitted import is refused");
    assert.equal(py.runPython(`import os; os.path.exists('/pre/MARKER')`), false, "the shape op did not run the import");
});

// --- the name precheck cannot execute or shadow an admitted module ---

test("the name precheck's find_spec does not run a candidate module's body, and a name that already imports is refused", async (t) => {
    if (skip) return t.skip(skip);
    py.FS.mkdirTree("/pre");
    py.FS.writeFile("/pre/evilmod.py", "import pathlib\npathlib.Path('/pre/MARKER').write_text('RAN')\nX = 1\n");
    py.FS.mkdirTree("/pre/evilpkg");
    py.FS.writeFile("/pre/evilpkg/__init__.py", "import pathlib\npathlib.Path('/pre/MARKER2').write_text('RAN')\n");
    py.runPython(`import sys; sys.path.insert(0, "/pre")`);
    assert.equal(py.runPython(`import os; os.path.exists('/pre/MARKER')`), false);
    assert.equal(py.runPython(`import os; os.path.exists('/pre/MARKER2')`), false);

    const named = await shape("evilmod", ""); // the precheck: the NAME alone, over an empty source
    assert.match(named.why, /already imports something else/);
    assert.equal(py.runPython(`import os; os.path.exists('/pre/MARKER')`), false, "find_spec did not run the candidate's body");

    const pkg = await shape("evilpkg", "");
    assert.match(pkg.why, /already imports something else/);
    assert.equal(py.runPython(`import os; os.path.exists('/pre/MARKER2')`), false, "find_spec did not run the package's __init__");

    const free = await shape("no_such_xyz_lib", "");
    assert.equal(free.why, "", "a free name is admitted");
});

// --- a module that passes the shape rule but whose post-load globals disagree is not stored ---

test("a shape-admitted def whose listed name is a dunder is refused at load: the post-load globals disagree", async (t) => {
    if (skip) return t.skip(skip);
    // Shape walks top-level statements and admits a plain def. The load (the enforce layer) refuses a name a cell
    // may not read. The worker stores only what the load agrees to (approveLibrary), so this disagreement stores nothing.
    const src = "def __f():\n    return 1\n";
    const s = await shape("dunder_def", src);
    assert.equal(s.why, "", "shape admits the def (this is the disagreement)");
    const r = await load(lib("dunder_def", src, ["__f"]));
    assert.match(r.dunder_def, /not a name a cell may read/);
});

test("the load refuses a mutable global and a mutable default even when a hand-built shape claimed them", async (t) => {
    if (skip) return t.skip(skip);
    // The card's verdict is the shape rule; the load is what actually admits. If they ever disagree the load rules.
    assert.match((await load(lib("mut_list", "X = [1, 2]\ndef f():\n    return 1", ["X", "f"]))).mut_list, /holds a list|would keep state/);
    assert.match((await load(lib("mut_default", "def f(n=[]):\n    return n", ["f"]))).mut_default, /frozen|mutable|default|list/);
    assert.match((await load(lib("mut_tuple", "X = (1, [2])\ndef f():\n    return 1", ["X", "f"]))).mut_tuple, /holds a tuple|would keep state|list/);
});

// --- the #1102 leak is unreachable from an admitted module ---

test("a cell cannot write an attribute on a library function or module, or reach its dunders", async (t) => {
    if (skip) return t.skip(skip);
    const src = "HIDDEN = 42\ndef f():\n    return HIDDEN\ndef g():\n    return 1\n";
    assert.equal((await load(lib("leak_f", src, ["f", "g"]))).leak_f, "");
    const attempts = [
        "import leak_f\nleak_f.f.flag = 99",
        "import leak_f\nleak_f.__dict__",
        "import leak_f\nleak_f.f.__dict__",
        "import leak_f\nleak_f.f.__defaults__",
        "import leak_f\nleak_f.f.__code__",
        "import leak_f\nsetattr(leak_f.f, 'g', 7)",
        "import leak_f\nleak_f.HIDDEN = 0",
        "import leak_f\nleak_f.x = 1",
        "import leak_f\ndir(leak_f)",
        "import leak_f\nleak_f.HIDDEN",
    ];
    for (const src2 of attempts) {
        const out = cell(src2);
        assert.ok(out.refused, `a cell got through: ${src2} -> ${JSON.stringify(out)}`);
    }
    // Positive control: the listed names still work, and an unlisted one is refused.
    assert.equal(cell("import leak_f\nreturn leak_f.f()").value, 42);
    assert.equal(cell("import leak_f\nreturn leak_f.g()").value, 1);
});

test("a listed function that returns an unadmitted builtin is inert: the cell gets the value and cannot call it", async (t) => {
    if (skip) return t.skip(skip);
    // `open`, `eval`, `exec`, `compile`, `setattr`, `getattr`, `globals` are effectful: a cell cannot call them
    // directly, and a library handing one out must not widen that. `type` and `object` are already callable in the
    // dialect, so they are a positive control below, not an escape.
    const r = await load(lib("ret_builtin", "def f():\n    return open\ndef g():\n    return eval\ndef h():\n    return exec\ndef k():\n    return setattr\ndef m():\n    return getattr", ["f", "g", "h", "k", "m"]));
    assert.equal(r.ret_builtin, "");
    for (const call of ["f()('/etc/passwd')", "g()('1')", "h()('1')", "k()(1, 'x', 2)", "m()(1, '__class__')"]) {
        const out = cell(`import ret_builtin\nreturn ret_builtin.${call}`);
        assert.ok(out.refused, `a cell called ${call}: ${JSON.stringify(out)}`);
    }
    // The value itself is handed out — that is allowed — but every call path is refused.
    assert.match(JSON.stringify(cell("import ret_builtin\nreturn ret_builtin.f()")), /built-in function open/);
    // Positive control: a builtin the dialect admits is callable however the cell reached it.
    assert.equal(cell("return type(1)").value, "<class 'int'>");
    assert.equal(cell("import ret_builtin\nreturn ret_builtin.h()").value !== undefined, true, "exec is handed out as a value");
});

test("a non-admitted module attribute is refused at the body's run, even when the shape rule admitted the def", async (t) => {
    if (skip) return t.skip(skip);
    // Shape does not walk the body: `return math.sqrt` is an admitted def. The load admits the function; a cell
    // calling it runs the body under the gate, which refuses the attribute. `math.fsum` is admitted and works.
    const both = await load(lib("retm", "import math\ndef f():\n    return math.sqrt\ndef g():\n    return math.fsum", ["f", "g"]));
    assert.equal(both.retm, "");
    assert.ok(cell("import retm\nreturn retm.f(2)").refused, "math.sqrt is not an admitted name of math");
    assert.equal(cell("import retm\nreturn retm.g()([1.0, 2.0])").value, 3, "positive control: math.fsum is admitted");
});

// --- callback laundering: an inert builtin passed to an admitted HOF is refused at every consumption ---

test("a map or filter holding an inert builtin constructs, and every consumption of it is refused", async (t) => {
    if (skip) return t.skip(skip);
    assert.equal((await load(lib("op", "def f():\n    return open", ["f"]))).op, "");
    const launder = [
        "import op\nreturn next(map(op.f(), ['a']))",
        "import op\nm = map(op.f(), ['a'])\nreturn next(m)",
        "import op\nreturn [x for x in map(op.f(), ['a'])]",
        "import op\nfor x in map(op.f(), ['a']):\n    return x",
        "import op\n(a,) = map(op.f(), ['a'])\nreturn a",
        "import op\nreturn list(filter(op.f(), ['a']))",
        "import op\nm = map(op.f(), ['a'])\nreturn list(m)",
        "import op\nreturn sorted(map(op.f(), ['a']))",
        "import op\nreturn sorted(['a'], key=op.f())",
        "import op\nreturn max(['a'], key=op.f())",
        "import op\nreturn min(['a'], key=op.f())",
        "import op\nreturn all(map(op.f(), ['a']))",
        "import op\nreturn any(map(op.f(), ['a']))",
        "import op\nreturn list(enumerate(map(op.f(), ['a'])))",
        "import op\nreturn list(zip(map(op.f(), ['a']), [1]))",
        "import op\nm = map(op.f(), ['a'])\nreturn next(m, None)",
    ];
    for (const src of launder) {
        const out = cell(src);
        assert.ok(out.refused, `laundering got through: ${src.replace(/\n/g, " | ")} -> ${JSON.stringify(out)}`);
    }
    // Positive control: the same HOFs with a callable the dialect admits.
    assert.deepEqual(cell("return list(map(len, ['ab']))").value, [2]);
    assert.deepEqual(cell("return list(map(sum, [[1], [2]]))").value, [1, 2]);
});

test("a library function that iterates a map it is given still cannot call the inert builtin inside", async (t) => {
    if (skip) return t.skip(skip);
    assert.equal((await load(lib("it", "def g(m):\n    return list(m)", ["g"]))).it, "");
    assert.equal((await load(lib("op2", "def f():\n    return open", ["f"]))).op2, "");
    const out = cell("import it, op2\nreturn it.g(map(op2.f(), ['a']))");
    assert.ok(out.refused, `the library's own iteration called open: ${JSON.stringify(out)}`);
    assert.deepEqual(cell("import it\nreturn it.g(map(len, ['ab']))").value, [2], "positive control");
});

// --- probed and not gotten ---

test("PROBED AND NOT GOTTEN: the channels this pass tried against the load and the shape rule", () => {
    const closed = [
        "decorators, f-strings, comprehensions, call defaults, walrus, aug-assign, del, global, yield, async def, star assign, BinOp consts, nested mutable tuples and class defs are refused by shape, with nothing run",
        "find_spec in the name precheck does not run a candidate module's body or a package's __init__",
        "a shape-admitted def listed under a dunder name is refused at load (shape and load disagree; the load rules)",
        "a mutable global, a mutable default and a mutable nested tuple are refused at load",
        "a cell cannot write an attribute on a library function or module, or reach __dict__/__defaults__/__code__, or call setattr",
        "a listed function that returns open/eval/exec/setattr/getattr hands out an inert value; every call path is refused",
        "a non-admitted module attribute (math.sqrt) is refused at the body's run; math.fsum works",
        "map/filter holding an inert builtin constructs, and every consumption (next, list, for, unpack, sorted(key=), max/min(key=), all/any, enumerate, zip, next(m, None)) is refused",
        "a library function that iterates the map it is given still cannot call the inert builtin inside",
    ];
    assert.equal(closed.length, 9);
    assert.ok(closed.every((s) => s.length > 20));
});

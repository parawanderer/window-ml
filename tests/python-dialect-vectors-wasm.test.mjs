// python-dialect-vectors-wasm.test.mjs — the 87 dialect vectors with a `py` program, run under the extension's real dist/pyodide/.
//
// The fork's Tools/restricted/run_vectors.py runs them on a desktop CPython; this is the same contract under wasm, so
// "the dialect holds in python_exec" is measured on the interpreter the extension ships. Self-SKIPS without
// dist/pyodide/, and without the fork (`_restricted` absent = the stock npm core): `npm run fetch-pyodide` fetches it.
// One Pyodide instance for every vector (no subprocess under Node): each vector gets `_restricted.reset()` and a fresh
// namespace, and the vector's own budget is the hang guard.
import { test, before } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { GENRES, loadVectors } from "./dialect-vectors.mjs";

const PYODIDE_DIR = path.resolve(import.meta.dirname, "../dist/pyodide");
const DATA_DIR = path.resolve(import.meta.dirname, "../notebooks/python-dialect/data");
const hasPyodide = fs.existsSync(path.join(PYODIDE_DIR, "pyodide.mjs"));
const BUILD_OFF = { specialization: false, specialization_ft: false, tier2: false, jit: false };

let py = null;
let stockCore = false; // a core is present but is the stock Pyodide, not the fork build
let skip = hasPyodide ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";

// --- the harness: run_vectors.py's child, as one function inside the interpreter ---

const HARNESS = `
import json, sys, copy, io, base64, contextlib
import _restricted, restricted
PLAIN = (type(None), bool, int, float, str)

def _plain(v):
    if isinstance(v, PLAIN): return v
    if isinstance(v, (list, tuple)): return [_plain(x) for x in v]
    if isinstance(v, dict): return {str(k): _plain(x) for k, x in v.items()}
    for m in ("item", "tolist", "to_dict"):
        if hasattr(v, m) and (m != "item" or getattr(v, "ndim", 0) == 0):
            try: return _plain(getattr(v, m)())
            except Exception: pass
    return {"$unconvertible": type(v).__name__, "repr": repr(v)[:80]}

def _snapshot(ns):
    snap = {}
    for k, v in ns.items():
        if k in ("__builtins__", "_user", "__cell_result__"): continue
        if isinstance(v, PLAIN + (list, dict, tuple, set)):
            try:
                snap[k] = ("plain", copy.deepcopy(v)); continue
            except Exception: pass
        snap[k] = ("id", id(v), v)
    return snap

def _diff(b, a):
    out = []
    for k in sorted(set(b) | set(a)):
        if k not in a: out.append(k + " removed")
        elif k not in b: out.append(k + " added")
        else:
            x, y = b[k], a[k]
            if x[0] != y[0] or (x[0] == "plain" and x[1] != y[1]) or (x[0] == "id" and x[1] != y[1]): out.append(k + " changed")
    return out

def _world(env):
    if env == "none": return {}
    if env == "table":
        import numpy as np, pandas as pd
        return {"df": pd.DataFrame({"a": [1, 2, 3, 4], "b": [5, 6, 7, 8], "c": [9, 10, 11, 12]}),
                "pd": pd, "np": np, "io": io, "base64": base64, "sys": sys, "contextlib": contextlib}
    if env == "warm":
        class Box: pass
        box = Box(); box.secret = 1
        def peek(o): return o.secret
        def peek_ok(xs): return len(xs)
        def peek_cold(o): return o.secret
        def via_python(f): return lambda x: f(x)
        for _ in range(10_000):
            peek(box); peek_ok([1, 2, 3])
        return {"Box": Box, "box": box, "peek": peek, "peek_ok": peek_ok, "peek_cold": peek_cold, "via_python": via_python}
    return None

def wml_vector(msg_json):
    msg = json.loads(msg_json)
    _restricted.reset()
    restricted.load_manifests(msg["data"])
    ns = _world(msg["env"])
    if ns is None: return json.dumps({"kind": "skip", "reason": "unknown env " + msg["env"]})
    if msg.get("pre"):
        try: restricted.run_cell(msg["pre"], ns)
        except BaseException as e: return json.dumps({"kind": "error", "reason": "pre raised " + type(e).__name__ + ": " + str(e)})
    before = _snapshot(ns) if msg.get("leaves_nothing") else None
    out = {"kind": "ran"}
    try:
        v = restricted.run_cell(msg["py"], ns, budget=msg.get("budget"))
        out["returned"] = True; out["value"] = _plain(v)
    except BaseException as e:
        out.update(returned=False, exc=type(e).__name__, not_in_dialect=isinstance(e, _restricted.NotInDialect), msg=str(e))
    if before is not None: out["leaked"] = _diff(before, _snapshot(ns))
    return json.dumps(out)
`;

before(async () => {
    if (!hasPyodide) return;
    const { loadPyodide } = await import(path.join(PYODIDE_DIR, "pyodide.mjs"));
    py = await loadPyodide({ indexURL: PYODIDE_DIR });
    const probe = py.runPython(`
import importlib.util
"restricted" if importlib.util.find_spec("_restricted") else "stock"
`);
    if (probe === "stock") { stockCore = true; skip = "dist/pyodide is the stock Pyodide, not the restricted-mode build — `npm run fetch-pyodide` once tools/pyodide-dist.json has an artefact"; return; }
    await py.loadPackage(["numpy", "pandas"]);
    py.FS.mkdirTree("/dialect-data");
    py.mountNodeFS("/dialect-data", DATA_DIR); // the manifests the dialect loads, read-only in effect
    py.runPython(HARNESS);
}, { timeout: 240000 });

/** run_vectors.py's `_judge`: [status, reason] from the interpreter's reply. */
function judge(vec, out) {
    if (out.kind === "skip") return ["SKIP", out.reason];
    if (out.kind === "error") return ["ERROR", out.reason];
    const ended = out.returned ? `returned ${JSON.stringify(out.value)}` : `${out.exc}: ${out.msg}`;
    const e = vec.expect;
    let status, reason;
    if (e === "refused") [status, reason] = out.returned === false && out.not_in_dialect ? ["PASS", ended] : ["FAIL", `expected NotInDialect, got ${ended}`];
    else if (e === "halts") [status, reason] = ["PASS", ended];
    else [status, reason] = out.returned && JSON.stringify(out.value) === JSON.stringify(e.value) ? ["PASS", ended] : ["FAIL", `expected ${JSON.stringify(e.value)}, got ${ended}`];
    if (vec.leaves_nothing && out.leaked?.length) [status, reason] = ["FAIL", `state leaked (${out.leaked.join(", ")}); ${reason}`];
    return [status, reason];
}

// --- under CI a fetched fork core must be the one shipped: a skip must not pass for a run ---

test("under CI, a job that fetched the fork core ships it in dist/pyodide", (t) => {
    const fetched = fs.existsSync(path.resolve(import.meta.dirname, "../pyodide-core/.pin"));
    if (!process.env.CI || !fetched) return t.skip("only under CI, in a job that ran `npm run fetch-pyodide` with an artefact pinned");
    // A job that never fetched (the hub job) builds the stock core on purpose and has nothing to check; one that fetched
    // and still ships the stock core means the vectors below would SKIP and pass for a run.
    assert.strictEqual(stockCore, false, `the vectors would be skipped: ${skip}`);
});


// --- the build gate: specialization, tier 2 and the JIT off, or the warm vectors pass by chance ---

test("the interpreter is the patched build with specialization, tier 2 and the JIT off", (t) => {
    if (skip) return t.skip(skip);
    assert.deepStrictEqual(JSON.parse(py.runPython("import json, _restricted; json.dumps(_restricted.build())")), BUILD_OFF);
});

// --- the core carries the pinned commit's restricted.py, not a stale build's ---

// A core built on a stale tree once shipped the previous commit's restricted.py under the pin's name (2026-10-21): the C
// was right, and a cell's multi-line string came back indented by the wrapper's def. Both reads below are the fork's
// 77376876 and later.
test("a cell is parsed as itself: a multi-line string keeps its value, and a SyntaxError names the cell's own column", (t) => {
    if (skip) return t.skip(skip);
    const got = JSON.parse(py.runPython(`
import json, restricted
v = restricted.run_cell('s = """a\\nb"""\\nreturn s', {})
try:
    restricted.run_cell("x = 1\\ny = (\\n", {})
    err = None
except SyntaxError as e:
    err = [e.lineno, e.offset, e.text]
json.dumps([v, err])`));
    assert.deepStrictEqual(got, ["a\nb", [2, 5, "y = (\n"]]);
});

test("the core's restricted.py is the one the pin names (cpython.restrictedPySha256)", (t) => {
    if (skip) return t.skip(skip);
    const pin = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../tools/pyodide-dist.json"), "utf8"));
    const have = py.runPython("import hashlib, restricted; hashlib.sha256(restricted.__loader__.get_data(restricted.__file__)).hexdigest()");
    assert.strictEqual(have, pin.cpython.restrictedPySha256, "dist/pyodide's restricted.py is not the pinned commit's: a stale build");
});

// --- parse-as-itself: every shape whose meaning depends on the cell's own indentation or columns ---
//
// The one row above proves a bare multi-line string and one SyntaxError column. These enumerate the rest of the surface
// the wrapper relies on: a cell that is re-indented by a surrounding def, or re-parsed with the wrapper's columns, changes
// meaning here. Each input is a cell source; each want is what `restricted.run_cell` must answer on the fork's
// 77376876 restricted.py (and later). On the stale build that shipped a9f034a2's restricted.py under 77376876's name
// (2026-10-21) the string contents come back carrying the wrapper's indent and the SyntaxError tuples name the wrapper's
// lines — that is the failure these rows are for.

/** `restricted.run_cell(src, {})`: its return value, or `["SyntaxError", lineno, offset, text, msg]`. */
function cellParse(src) {
    return JSON.parse(py.runPython(`
import json, restricted
src = json.loads(${JSON.stringify(JSON.stringify(src))})
try:
    out = restricted.run_cell(src, {})
except SyntaxError as e:
    out = ["SyntaxError", e.lineno, e.offset, e.text, e.msg]
except Exception as e:
    out = ["other", type(e).__name__, str(e)[:120]]
json.dumps(out)`));
}

const PARSE_VALUE_ROWS = [
    // [name, cell source, what run_cell returns]
    ["multi-line string keeps its internal indent and tabs", 's = """a\n    b\n\tc"""\nreturn s', "a\n    b\n\tc"],
    ["an f-string expression on its own line is the cell's own expression", 'x = 2\ns = f"""{\n  x * 21\n}"""\nreturn s', "42"],
    ["implicit concatenation across a line break", 's = "a" \\\n    "b"\nreturn s', "ab"],
    ["backslash continuation at a deep indent", 'x = 1 + \\\n    2 + \\\n    3\nreturn x', 6],
    ["a string that holds what looks like the wrapper's indent is content", 's = """    def _user():\n        pass"""\nreturn s', "    def _user():\n        pass"],
    ["an if-block's multi-line string keeps its content indent", 'if 1:\n    s = """\n    keep\n    """\nreturn s', "\n    keep\n    "],
    ["tab and space inside a string are both kept", 's = "\tX \tY"\nreturn s', "\tX \tY"],
    ["a string line at column 0 is column 0", 's = """\nhead\n"""\nreturn s', "\nhead\n"],
    ["a multi-line dict display with trailing commas", 'd = {\n  "a": 1,\n  "b": 2,\n}\nreturn d', { a: 1, b: 2 }],
    ["a call spanning lines with a comment on the continuation", 'x = (\n  1  # one\n  + 2\n)\nreturn x', 3],
    ["a lambda spanning lines with the body indented", 'f = lambda a: (\n  a + 1\n)\nreturn f(1)', 2],
];

test("parse-as-itself: values that depend on the cell's own indentation or columns", (t) => {
    if (skip) return t.skip(skip);
    for (const [name, src, want] of PARSE_VALUE_ROWS) {
        assert.deepStrictEqual(cellParse(src), want, name);
    }
});

const PARSE_SYNTAX_ROWS = [
    // [name, cell source, [lineno, offset, text]] — msg is asserted only as a non-empty string
    ["an unclosed paren on line 2", "x = 1\ny = (\n", [2, 5, "y = (\n"]],
    ["an unclosed paren on line 4", "a = 1\nb = 2\nc = 3\nd = (\n", [4, 5, "d = (\n"]],
    ["a close paren alone at column 1 of line 2", "x = 1\n)\n", [2, 1, ")"]],
    ["an unclosed triple-quoted string", 's = """open\n', [1, 5, 's = """open']],
    ["a tab/space indent mix", "if 1:\n\tx = 1\n  y = 2\n", [3, 8, "  y = 2\n"]],
];

test("parse-as-itself: a SyntaxError names the cell's own lineno and offset", (t) => {
    if (skip) return t.skip(skip);
    for (const [name, src, want] of PARSE_SYNTAX_ROWS) {
        const got = cellParse(src);
        assert.strictEqual(got[0], "SyntaxError", name);
        assert.deepStrictEqual(got.slice(1, 4), want, name);
        assert.strictEqual(typeof got[4], "string", name);
        assert.ok(got[4].length > 0, name);
    }
});

test("parse-as-itself: a format spec that carries the cell's own newlines is the cell's own text", (t) => {
    if (skip) return t.skip(skip);
    // The multi-line spec is what the cell wrote, so `format` sees the newlines and refuses; the one-line form of the
    // same value is the same expression with the cell's own spec on one line, and it formats.
    const multi = cellParse('w = 5\ns = f"""{\n  w:03d\n}"""\nreturn s');
    assert.strictEqual(multi[0], "other", "the multi-line spec reaches format()");
    assert.strictEqual(multi[1], "ValueError", "format() refuses the spec the cell wrote");
    assert.strictEqual(cellParse('w = 5\ns = f"{w:03d}"\nreturn s'), "005", "the same value one line up");
});

// --- the vectors, one test each, by genre ---


const EXPECTED = { abuse: 43, halting: 20, failure: 5, ownership: 19, print: 0 };

for (const genre of GENRES) {
    const vecs = loadVectors(genre).filter((v) => v.py !== undefined);
    test(`${genre}: ${EXPECTED[genre]} vectors carry a py program`, () => assert.strictEqual(vecs.length, EXPECTED[genre]));
    for (const vec of vecs) {
        test(`${genre}: ${vec.name}`, { timeout: 60000 }, (t) => {
            if (skip) return t.skip(skip);
            const msg = { data: "/dialect-data", env: vec.env, py: vec.py, pre: vec.pre?.py ?? null, leaves_nothing: !!vec.leaves_nothing, budget: vec.budget ?? null };
            const out = JSON.parse(py.globals.get("wml_vector")(JSON.stringify(msg)));
            const [status, reason] = judge(vec, out);
            assert.strictEqual(status, "PASS", reason);
        });
    }
}

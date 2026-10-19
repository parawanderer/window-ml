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
    if (probe === "stock") { skip = "dist/pyodide is the stock Pyodide, not the restricted-mode build — `npm run fetch-pyodide` once tools/pyodide-dist.json has an artefact"; return; }
    await py.loadPackage(["numpy", "pandas"]);
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

// --- the build gate: specialization, tier 2 and the JIT off, or the warm vectors pass by chance ---

test("the interpreter is the patched build with specialization, tier 2 and the JIT off", (t) => {
    if (skip) return t.skip(skip);
    assert.deepStrictEqual(JSON.parse(py.runPython("import json, _restricted; json.dumps(_restricted.build())")), BUILD_OFF);
});

// --- the vectors, one test each, by genre ---

const EXPECTED = { abuse: 43, halting: 20, failure: 5, ownership: 19, print: 0 };

for (const genre of GENRES) {
    const vecs = loadVectors(genre).filter((v) => v.py !== undefined);
    test(`${genre}: ${EXPECTED[genre]} vectors carry a py program`, () => assert.strictEqual(vecs.length, EXPECTED[genre]));
    for (const vec of vecs) {
        test(`${genre}: ${vec.name}`, { timeout: 60000 }, (t) => {
            if (skip) return t.skip(skip);
            const msg = { data: DATA_DIR, env: vec.env, py: vec.py, pre: vec.pre?.py ?? null, leaves_nothing: !!vec.leaves_nothing, budget: vec.budget ?? null };
            const out = JSON.parse(py.globals.get("wml_vector")(JSON.stringify(msg)));
            const [status, reason] = judge(vec, out);
            assert.strictEqual(status, "PASS", reason);
        });
    }
}

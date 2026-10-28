// redteam-hard-python-lockdown.test.mjs — independent cross-run ownership probes through the worker's inside-cell wrapper on the real fork core.

import { test, before } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { wrapUserSetup, wrapUserScript } from "../src/python/python-runtime.ts";
import { dialectSetup, libraryLoad, libraryShape } from "../src/python/python-dialect-run.js";

const PYODIDE_DIR = path.resolve(import.meta.dirname, "../dist/pyodide");
const DATA_DIR = path.resolve(import.meta.dirname, "../notebooks/python-dialect/data");
const FILES = Object.fromEntries(["whitelist.json", "manifest-stdlib.json", "manifest-numpy.json", "manifest-pandas.json", "manifest-pil.json"]
    .map((f) => [f, fs.readFileSync(path.join(DATA_DIR, f), "utf8")]));
const NODES = JSON.parse(FILES["whitelist.json"]).nodes;
/** The import names a library may never take, exactly as the worker reserves them. */
const reservedNames = () => [...JSON.parse(FILES["whitelist.json"]).modules,
    ...Object.values(JSON.parse(fs.readFileSync(path.join(PYODIDE_DIR, "pyodide-lock.json"), "utf8")).packages).flatMap((p) => p.imports ?? [])];
const hasPyodide = fs.existsSync(path.join(PYODIDE_DIR, "pyodide.mjs"));

let py = null;
let fork = false;
const skip = hasPyodide ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";

before(async () => {
    if (!hasPyodide) return;
    const { loadPyodide } = await import(path.join(PYODIDE_DIR, "pyodide.mjs"));
    py = await loadPyodide({ indexURL: PYODIDE_DIR });
    fork = py.runPython(`import importlib.util; importlib.util.find_spec("_restricted") is not None`);
    if (fork) {
        await py.loadPackage(["numpy", "pandas", "pillow"]);
        assert.strictEqual(await py.runPythonAsync(dialectSetup(FILES)), "");
    }
}, { timeout: 240000 });

/** Run one cell through the same setup, dialect wrapper, and namespace copy-back as the worker. */
async function cell(ns, source) {
    await py.runPythonAsync(wrapUserSetup(false, "run"), { globals: ns });
    await py.runPythonAsync(wrapUserScript(source, "run", { nodes: NODES }), { globals: ns });
    const refused = ns.get("_ml_not_in_dialect");
    if (refused) return { refused: String(refused) };
    const err = ns.get("_err");
    if (err) return { error: String(err) };
    const jr = ns.get("_json_result");
    try { return { value: JSON.parse(jr) }; } catch { return { value: jr }; }
}

// --- reset ends the ownership history of values retained by the namespace ---------------------------------

// Measured passing on core 35bd1d69 (#1263 at 56ab77fd): the closure's creating-run and persistence controls pass,
// the outside-created closure control is refused, and post-reset keep(3) is refused.
test("a list held by a cell-defined closure is not writable after reset", {
    skip,
    timeout: 60000,
}, async (t) => {
    if (!fork) return t.skip("needs the restricted-mode fork core (npm run fetch-pyodide)");
    const ns = py.globals.get("dict")();
    const make = `
def make():
    acc = []
    def keep(x):
        acc.append(x)
        return acc
    return keep
keep = make()
return keep(1)
`;
    assert.deepStrictEqual(await cell(ns, make), { value: [1] }, "positive control: the closure works in its creating run");
    assert.deepStrictEqual(await cell(ns, "return keep(2)"), { value: [1, 2] }, "the closure persists into the next cell");
    assert.strictEqual(await py.runPythonAsync(dialectSetup(FILES)), "", "reset and reload the allow tables");

    const control = py.runPython(`
def _outside_make():
    _acc = []
    def _keep(x):
        _acc.append(x)
        return _acc
    return _keep
_outside_make()
`);
    const controlNs = py.globals.get("dict")();
    controlNs.set("keep", control);
    assert.ok((await cell(controlNs, "return keep(3)")).refused, "positive control: an outside-created closure's list is not owned");

    const afterReset = await cell(ns, "return keep(3)");
    assert.ok(afterReset.refused, `reset must end the retained list's ownership, got ${JSON.stringify(afterReset)}`);
});

// --- the tier-3 shape and post-load checks account for closures a library function can return ---------------------

// Measured passing on core 35bd1d69 (#1263 at 56ab77fd): libraryShape/libraryLoad and the creating-run control pass,
// and the library-produced closure's post-reset keep(2) is refused.
test("a tier-3 library cannot return a closure whose list stays writable after reset", {
    skip,
    timeout: 60000,
}, async (t) => {
    if (!fork) return t.skip("needs the restricted-mode fork core (npm run fetch-pyodide)");
    const source = `
def make():
    acc = []
    def keep(x):
        acc.append(x)
        return acc
    return keep
`;
    const sha256 = crypto.createHash("sha256").update(source, "utf8").digest("hex");
    const shape = JSON.parse(await py.runPythonAsync(libraryShape("closure_lib", source, NODES, reservedNames())));
    assert.strictEqual(shape.why, "", "the static shape rule must answer the proposed library before its measurement");
    const loaded = JSON.parse(await py.runPythonAsync(libraryLoad([{ name: "closure_lib", source, sha256, names: ["make"] }], NODES, reservedNames())));
    assert.strictEqual(loaded[0].why, "", "the post-load global check must answer the proposed library before its measurement");

    const ns = py.globals.get("dict")();
    assert.deepStrictEqual(await cell(ns, "import closure_lib\nkeep = closure_lib.make()\nreturn keep(1)"), { value: [1] },
        "positive control: the admitted library's factory returns a working closure");
    assert.strictEqual(await py.runPythonAsync(dialectSetup(FILES)), "", "reset and reload the allow tables");
    const afterReset = await cell(ns, "return keep(2)");
    assert.ok(afterReset.refused, `a library-produced closure must not retain list ownership across reset, got ${JSON.stringify(afterReset)}`);
});

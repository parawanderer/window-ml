// pkg-install-py.test.mjs — python_install's candidate cell in real Pyodide (src/python/pkg-install-test.ts): wheels unpacked after the readonly lockdown, as the worker does it, then the import test in a hardened cell. Its own file because `lockdown()` is once per realm. Run: node --import tsx --test tests/pkg-install-py.test.mjs

import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { wrapUserCode, injectInputs } from "../src/python/python-runtime.ts";
import { lockdownReadonly } from "../src/python/lockdown.ts";
import { PY_PACKAGE_LOADS, PY_STARTUP_PREPARE } from "../src/python/python-env.ts";
import { importTestCode } from "../src/python/pkg-install-test.ts";
import { wheel } from "./fixtures/wheel-zip.mjs";

const PYODIDE_DIR = path.resolve(import.meta.dirname, "../dist/pyodide");
const skip = fs.existsSync(path.join(PYODIDE_DIR, "pyodide.mjs")) ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";
const T = { timeout: 120000, skip };

let py = null;
let harness = null;
let site = "";

before(async () => {
    if (skip) return;
    const { loadPyodide } = await import(path.join(PYODIDE_DIR, "pyodide.mjs"));
    py = await loadPyodide({ indexURL: PYODIDE_DIR });
    py.setStdout({ batched: () => {} });
    py.setStderr({ batched: () => {} });
    await py.loadPackage(PY_PACKAGE_LOADS);
    if (PY_STARTUP_PREPARE) py.runPython(PY_STARTUP_PREPARE);
    site = String(py.runPython("import site\nsite.getsitepackages()[0]"));
    ({ harness } = await lockdownReadonly(py, {}));
    // After the lockdown, from JS, as python-worker.ts `installWheels` unpacks a run's installs.
    for (const [dist, files] of [
        ["goodpkg-1.0", [["goodpkg/__init__.py", "VALUE = 3\n"]]],
        ["needy-1.0", [["needy.py", "import wcwidth_not_installed_zz\n"]]],
        ["exiter-1.0", [["exiter.py", "raise SystemExit(2)\n"]]],
    ]) py.unpackArchive(wheel(files, { dist: `${dist}.dist-info` }), "wheel", { extractDir: site });
}, { timeout: 180000 });

/** The candidate's answer for `modules`: null when every import passed, else what failed. */
async function importTest(modules) {
    injectInputs(py.globals, null, null, harness);
    await py.runPythonAsync(wrapUserCode(importTestCode(modules), true));
    const err = py.globals.get("_err");
    assert.equal(err ? String(err) : null, null, "the cell itself ran");
    return JSON.parse(JSON.parse(py.globals.get("_json_result")));
}

// --- the import test, locked down ---

test("a package unpacked after the lockdown imports in a hardened cell: the test passes", T, async () => {
    assert.equal(await importTest(["goodpkg"]), null);
});

test("an import of a module nobody provides names that module as missing", T, async () => {
    assert.deepEqual(await importTest(["needy"]), { module: "needy", missing: "wcwidth_not_installed_zz", error: "ModuleNotFoundError: No module named 'wcwidth_not_installed_zz'" });
});

test("a module that exits at import is a failure, not the end of the cell", T, async () => {
    assert.deepEqual(await importTest(["exiter"]), { module: "exiter", error: "SystemExit: 2" });
});

test("a module the standard library names is a collision, refused before any import", T, async () => {
    const r = await importTest(["json"]);
    assert.equal(r.module, "json");
    assert.equal(r.collision, true);
});

test("the test stops at the first failure and says which module it was", T, async () => {
    const r = await importTest(["goodpkg", "exiter", "needy"]);
    assert.equal(r.module, "exiter");
});

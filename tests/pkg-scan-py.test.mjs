// pkg-scan-py.test.mjs — python_install's platform scan in real Pyodide (src/python/pkg-scan.ts): packages unpacked after the readonly lockdown, as the candidate holds them, then the scan cell in a hardened cell, which reads their sources and never imports them. Its own file because `lockdown()` is once per realm. Run: node --import tsx --test tests/pkg-scan-py.test.mjs

import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { wrapUserCode, injectInputs } from "../src/python/python-runtime.ts";
import { lockdownReadonly } from "../src/python/lockdown.ts";
import { PY_PACKAGE_LOADS, PY_STARTUP_PREPARE } from "../src/python/python-env.ts";
import { scanCode } from "../src/python/pkg-scan.ts";
import { readScan, SCAN_BOUNDS } from "../src/python/pkg-scan-note.ts";
import { wheel } from "./fixtures/wheel-zip.mjs";

const PYODIDE_DIR = path.resolve(import.meta.dirname, "../dist/pyodide");
const skip = fs.existsSync(path.join(PYODIDE_DIR, "pyodide.mjs")) ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";
const T = { timeout: 120000, skip };

let py = null;
let harness = null;

/** Each fixture package: its files, unpacked into site-packages after the lockdown. */
const PACKAGES = {
    procpkg: [["procpkg/__init__.py", "import subprocess\nsubprocess.run(['true'])\n"]],
    guarded: [["guarded.py", "try:\n    import resource\nexcept ImportError:\n    resource = None\n"]],
    plainmissing: [["plainmissing.py", "import resource\n"]],
    platpkg: [["platpkg.py", "import sys\nif sys.platform == 'win32':\n    import winreg\nelse:\n    import os\n"]],
    typed: [["typed.py", "from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    import pwd\n"]],
    lazy: [["lazy.py", "import subprocess\ndef later():\n    subprocess.run(['true'])\n"]],
    callsown: [["callsown.py", "import subprocess\ndef setup():\n    subprocess.run(['true'])\nsetup()\n"]],
    outer: [["outer/__init__.py", "from . import sub\nimport innerdep\n"], ["outer/sub.py", "X = 1\n"]],
    innerdep: [["innerdep.py", "import grp\n"]],
    outer2: [["outer2.py", "import notscoped\n"]],
    notscoped: [["notscoped.py", "import resource\n"]],
    raiser: [["raiser.py", "import sys\nif sys.platform == 'emscripten':\n    raise ImportError('not here')\n"]],
    sidefx: [["sidefx.py", "import builtins\nbuiltins.SCAN_RAN_SIDEFX = True\n"]],
    deep: [["deep.py", `x = ${"(".repeat(400)}1${")".repeat(400)}\nimport resource\n`]],
    nosyntax: [["nosyntax.py", "def (:\n"]],
    chain: [["chain.py", `obj${".a".repeat(1200)}()\nimport resource\n`]],
    huge: [["huge/__init__.py", "import huge.big\n"], ["huge/big.py", `# ${"x".repeat(SCAN_BOUNDS.fileBytes + 10)}\nimport resource\n`]],
};

before(async () => {
    if (skip) return;
    const { loadPyodide } = await import(path.join(PYODIDE_DIR, "pyodide.mjs"));
    py = await loadPyodide({ indexURL: PYODIDE_DIR });
    py.setStdout({ batched: () => {} });
    py.setStderr({ batched: () => {} });
    await py.loadPackage(PY_PACKAGE_LOADS);
    if (PY_STARTUP_PREPARE) py.runPython(PY_STARTUP_PREPARE);
    const site = String(py.runPython("import site\nsite.getsitepackages()[0]"));
    ({ harness } = await lockdownReadonly(py, {}));
    // After the lockdown, from JS, as python-worker.ts `installWheels` unpacks a candidate's wheels.
    for (const [dist, files] of Object.entries(PACKAGES)) py.unpackArchive(wheel(files, { dist: `${dist}-1.0.dist-info` }), "wheel", { extractDir: site });
}, { timeout: 180000 });

/** The scan of `roots` within `scope` (default: the roots), run as the candidate runs it, read as the offscreen document reads it. */
async function scan(roots, scope = roots) {
    injectInputs(py.globals, null, null, harness);
    await py.runPythonAsync(wrapUserCode(scanCode(roots, scope), true));
    const err = py.globals.get("_err");
    assert.equal(err ? String(err) : null, null, "the scan cell itself ran");
    const r = readScan(py.globals.get("_json_result"));
    assert.ok(r, "the scan answered");
    return r;
}

const brief = (r) => r.findings.map((f) => [f.kind, f.what, f.in, f.chain]);

// --- what the scan flags: import-time code that reaches what the core lacks ---

test("a module-level call that fails in the core is a call finding in that module", T, async () => {
    assert.deepEqual(brief(await scan(["procpkg"])), [["call", "subprocess.run", "procpkg", ["procpkg"]]]);
});

test("an unguarded import of a stdlib module the core lacks is a missing finding", T, async () => {
    assert.deepEqual(brief(await scan(["plainmissing"])), [["missing", "resource", "plainmissing", ["plainmissing"]]]);
});

test("a call inside a function the module calls at import is followed one level, and named as the function", T, async () => {
    assert.deepEqual(brief(await scan(["callsown"])), [["call", "subprocess.run", "callsown.setup()", ["callsown", "callsown.setup()"]]]);
});

test("a raise on the branch the core takes is a raise finding, with none of the package's text", T, async () => {
    assert.deepEqual(brief(await scan(["raiser"])), [["raise", "", "raiser", ["raiser"]]]);
});

test("a finding in a dependency the package imports counts for it, with the chain from the root", T, async () => {
    assert.deepEqual(brief(await scan(["outer"], ["outer", "innerdep"])), [["missing", "grp", "innerdep", ["outer", "innerdep"]]]);
});

// --- what it does not flag ---

test("a guarded import, a branch the core does not take, TYPE_CHECKING and a function body are not findings", T, async () => {
    for (const m of ["guarded", "platpkg", "typed", "lazy"]) assert.deepEqual(brief(await scan([m])), [], m);
});

test("a package outside the scope is not read: a lock package or the core's is not this scan's", T, async () => {
    const r = await scan(["outer2"], ["outer2"]);
    assert.deepEqual(brief(r), []);
    assert.equal(r.reached, 1);
});

// --- RED TEAM: the scan reads, never runs, and a hostile source cannot stop the install's test ---

test("RED TEAM: scanning a module never imports it: its import-time code has not run after the scan", T, async () => {
    await scan(["sidefx"]);
    assert.equal(py.runPython("import sys, builtins\n('sidefx' in sys.modules, hasattr(builtins, 'SCAN_RAN_SIDEFX'))").toJs().join(), "false,false");
});

test("RED TEAM: a source the parser refuses (nesting past its limit, bad syntax) is skipped and the scan still answers", T, async () => {
    for (const m of ["deep", "nosyntax"]) {
        const r = await scan([m]);
        assert.deepEqual(brief(r), [], m);
        assert.equal(r.reached, 1, m);
    }
});

test("RED TEAM: a source that parses but is too deep to walk (a 1200-attribute call chain) is skipped and the scan still answers", T, async () => {
    // 1000 to 1500 attributes parse in this core and then pass the recursion limit in the walk; from about 2000 the
    // parser overflows the JS stack and kills the interpreter (tests/pkg-install-fatal-worker.test.mjs).
    const r = await scan(["chain"]);
    assert.deepEqual(brief(r), []);
    assert.equal(r.reached, 1);
});

test("RED TEAM: a file past the size bound is not read, and the scan says it stopped short", T, async () => {
    const r = await scan(["huge"]);
    assert.deepEqual(brief(r), []);
    assert.equal(r.truncated, true);
});

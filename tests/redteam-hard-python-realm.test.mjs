// tests/redteam-hard-python-realm.test.mjs — independent Node-half probe of prototype-inherited worker state after the real readonly lockdown.

import { test, before, after } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { lockdownReadonly } from "../src/python/lockdown.ts";

const PYODIDE_DIR = path.resolve(import.meta.dirname, "../dist/pyodide");
const hasPyodide = fs.existsSync(path.join(PYODIDE_DIR, "pyodide.mjs"));
const skip = hasPyodide ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";
const WORKER_URL = "chrome-extension://realm-probe/python-worker.js";

let py = null;
let fork = false;
let scope = null;
let beforeHref = null;

before(async () => {
    if (!hasPyodide) return;
    const { loadPyodide } = await import(path.join(PYODIDE_DIR, "pyodide.mjs"));
    py = await loadPyodide({ indexURL: PYODIDE_DIR });
    const withArrow = fs.readdirSync(PYODIDE_DIR).some((f) => f.startsWith("pyarrow-"));
    await py.loadPackage(["numpy", "pillow", "pandas", "beautifulsoup4", "html5lib", "sympy", ...(withArrow ? ["pyarrow"] : [])]);
    fork = py.runPython(`import importlib.util; importlib.util.find_spec("_restricted") is not None`);

    // The browser measured WorkerLocation on WorkerGlobalScope.prototype. Model only that accessor here;
    // URL is an allow-listed own-property control, not another prototype surface.
    const workerPrototype = {};
    Object.defineProperty(workerPrototype, "location", {
        configurable: true,
        get() { return { href: WORKER_URL }; },
    });
    scope = Object.create(workerPrototype);
    scope.URL = URL;
    beforeHref = scope.location.href;
    await lockdownReadonly(py, scope);
}, { timeout: 180000 });

after(async () => {
    try { await py?.destroy?.(); } catch { /* */ }
});

// --- step 3: the allow-list strip also covers the worker prototype -----------------------------------

test("a location accessor on the worker prototype is unreadable after the strip", {
    skip,
}, async (t) => {
    if (!fork) return t.skip("needs the restricted-mode fork core (npm run fetch-pyodide)");
    assert.equal(beforeHref, WORKER_URL, "positive control: the prototype accessor must be readable before the strip");
    assert.equal(typeof scope.URL, "function", "positive control: the allow-listed URL constructor must survive the strip");
    assert.equal(scope.location, undefined, `the worker's location must be unreadable after lockdown, got ${scope.location?.href}`);
});

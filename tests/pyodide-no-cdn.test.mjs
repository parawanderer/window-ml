// pyodide-no-cdn.test.mjs — a wheel missing from dist/pyodide fails at once and is never fetched from the Pyodide CDN:
// the sandbox's own loadPyodide options (pyodideLoadOptions, python-env.ts) and the tests' preload (no-cdn-fetch.mjs).
// Real Pyodide in Node, against a copy of dist/pyodide with one wheel taken out. Self-skips without dist/pyodide.

import "./no-cdn-fetch.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const { pyodideLoadOptions } = await import("../src/python/python-env.ts");

const PYODIDE_DIR = path.resolve(import.meta.dirname, "../dist/pyodide");
const skip = fs.existsSync(path.join(PYODIDE_DIR, "pyodide.mjs")) ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";
/** A package with no dependencies, so its own wheel is the only file the load reads. */
const PKG = "pyparsing";
let dir = null;
let wheel = null;
let loadPyodide = null;

before(async () => {
    if (skip) return;
    const lock = JSON.parse(fs.readFileSync(path.join(PYODIDE_DIR, "pyodide-lock.json"), "utf8"));
    wheel = lock.packages[PKG].file_name;
    // Every file of dist/pyodide but the one wheel, linked rather than copied.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wml-no-cdn-"));
    for (const f of fs.readdirSync(PYODIDE_DIR)) if (f !== wheel) fs.symlinkSync(path.join(PYODIDE_DIR, f), path.join(dir, f));
    ({ loadPyodide } = await import(path.join(PYODIDE_DIR, "pyodide.mjs")));
});

after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

/**
 * Boot Pyodide on the copy with `options`, then time loading the missing package, recording every fetch it makes.
 *
 * @param options What to pass to `loadPyodide`, `indexURL` included.
 */
async function loadMissing(options) {
    const py = await loadPyodide(options);
    const fetched = [];
    const inner = globalThis.fetch;
    globalThis.fetch = (input, init) => { fetched.push(String(input?.url ?? input)); return inner(input, init); };
    const said = [];
    const t0 = Date.now();
    try {
        await py.loadPackage(PKG, { messageCallback: (m) => said.push(m), errorCallback: (m) => said.push(m) });
    } finally {
        globalThis.fetch = inner;
    }
    return { ms: Date.now() - t0, fetched, said: said.join("\n"), loaded: PKG in py.loadedPackages };
}

// --- a missing wheel ---

test("no-cdn: the sandbox's options make no fetch at all for a missing wheel, and it fails in under 1 s", { skip, timeout: 60000 }, async () => {
    const r = await loadMissing(pyodideLoadOptions(dir + "/"));
    assert.deepEqual(r.fetched, []);
    assert.equal(r.loaded, false);
    assert.ok(r.ms < 1000, `${r.ms} ms`);
    assert.doesNotMatch(r.said, /jsdelivr/);
});

test("no-cdn: Pyodide's default options try the CDN, and the preload refuses it in under 1 s, naming the wheel and the fix", { skip, timeout: 60000 }, async () => {
    const r = await loadMissing({ indexURL: dir + "/" });
    assert.equal(r.fetched.length, 1);
    assert.match(r.fetched[0], /^https:\/\/cdn\.jsdelivr\.net\/pyodide\//);
    assert.equal(r.loaded, false);
    assert.ok(r.ms < 1000, `${r.ms} ms`);
    assert.ok(r.said.includes(`${wheel} is not in dist/pyodide: run \`npm run fetch-pyodide\``), r.said);
});

// --- the preload reaches every test ---

test("no-cdn: scripts/test.mjs preloads the guard into every test file", () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, "../scripts/test.mjs"), "utf8");
    assert.match(src, /const NO_CDN = pathToFileURL\(path\.join\(ROOT, "tests", "no-cdn-fetch\.mjs"\)\)\.href;/);
    assert.match(src, /const NODE_ARGS = \["--import", "tsx", "--import", NO_CDN, "--test",/);
});

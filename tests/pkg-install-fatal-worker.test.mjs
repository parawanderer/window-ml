// pkg-install-fatal-worker.test.mjs — what a package that kills Pyodide at import leaves of the worker, in the real worker.
// Measured: the cell NEVER ANSWERS. The fatal RangeError (a call chain too deep for the compiler) escapes as an unhandled
// rejection, which a browser Worker does not report as `onerror`, so the offscreen document hears nothing; an install's
// candidate is ended by its deadline (offscreen.ts installTest, rows in tests/pkg-install-offscreen.test.mjs), a run's
// own cell by its timeout. The answer the offscreen rows and python-lease-offscreen's kernel-death todo rows expect,
// the fatal error AS the cell's answer, is the todo row here. The real python-worker.ts under a fake `self` and the real
// Pyodide in Node, as python-worker-bridges.test.mjs runs it (self-SKIPS without dist/pyodide). Its own file because
// `lockdown()` is once per realm, and because the interpreter in it does not survive its test.
import { test, before, after } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { armFileGuard } from "./helpers-fileguard.mjs";

// The same gap python-bench-stop's header names: `before()` boots real Pyodide and can block this thread, where
// no test timeout can fire. Armed at module load so the boot is covered (helpers-fileguard.mjs).
const disarmFileGuard = armFileGuard({ label: "pkg-install-fatal-worker" });

const DIST = path.resolve(import.meta.dirname, "../dist");
const hasPyodide = fs.existsSync(path.join(DIST, "pyodide", "pyodide.mjs"));
const skip = hasPyodide ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";

let shim = null;
const posted = [];
let handler = null;
let nextId = 1;

before(async () => {
    if (!hasPyodide) return;
    // Pyodide in Node wants a filesystem path where the worker hands it a URL, so the worker is pointed at a stand-in
    // `pyodide/pyodide.mjs` that forwards to the real one with the path (nothing else about the runtime is faked).
    shim = fs.mkdtempSync(path.join(os.tmpdir(), "wml-worker-"));
    fs.mkdirSync(path.join(shim, "pyodide"));
    fs.writeFileSync(path.join(shim, "pyodide", "pyodide.mjs"),
        `import { loadPyodide as real } from ${JSON.stringify(pathToFileURL(path.join(DIST, "pyodide", "pyodide.mjs")).href)};\n` +
        `export const loadPyodide = (o) => real({ ...o, indexURL: ${JSON.stringify(path.join(DIST, "pyodide") + "/")}, packageBaseUrl: ${JSON.stringify(path.join(DIST, "pyodide") + "/")} });\n`);
    // Inherits the realm's intrinsics: the TypeScript loader reads them off `self` when it compiles the worker's imports.
    globalThis.self = Object.assign(Object.create(globalThis), {
        name: "readonly",
        location: { href: pathToFileURL(shim + "/").href },
        postMessage: (m) => { posted.push(m); },
        addEventListener: (type, fn) => { if (type === "message") handler = fn; },
    });
    await import("../src/python/python-worker.ts");
}, { timeout: 180000 });

after(() => {
    disarmFileGuard();
    if (shim) fs.rmSync(shim, { recursive: true, force: true });
});

/** Post one cell the way the offscreen document does; its answer, or "no answer" after `ms`. */
async function cell(code, extra = {}, ms = 60_000) {
    const id = nextId++;
    handler({ data: { id, code, image: null, hardened: true, tables: null, ...extra } });
    for (let i = 0; i < ms / 10; i++) {
        const done = posted.find((m) => m.id === id && !m.partial && !m.started && !m.booted);
        if (done) return done;
        await new Promise((r) => setTimeout(r, 10));
    }
    return "no answer";
}

// Where the fatal error goes instead of the answer; kept, so it is asserted rather than failing the file.
const rejections = [];
process.on("unhandledRejection", (e) => { rejections.push(e); });

import crypto from "node:crypto";
import { wheel } from "./fixtures/wheel-zip.mjs";

/** A wheel whose one module, at import, compiles a call chain deep enough to overflow the JS stack in the compiler. */
function killerWheel() {
    const bytes = wheel([["killer.py", `obj${".a".repeat(3000)}()\n`]], { dist: "killer-1.0.dist-info" });
    return { filename: "killer-1.0-py3-none-any.whl", sha256: crypto.createHash("sha256").update(bytes).digest("hex"), bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}

// --- a package that kills the interpreter at import ---

// The first cell kills the interpreter, so the measured row runs first and the todo row reads what it left.
let killed = null;

test("an import that kills Pyodide never answers: the fatal error escapes as an unhandled rejection", { skip, timeout: 180000 }, async () => {
    assert.equal((await cell("print('ALIVE')")).ok, true, "the control: the worker runs a cell");
    killed = await cell("import killer", { wheels: [killerWheel()] }, 8_000);
    assert.equal(killed, "no answer", `the cell answered: ${JSON.stringify(killed).slice(0, 300)}`);
    assert.ok(rejections.some((e) => /Maximum call stack size exceeded/.test(String(e?.message ?? e))), "the fatal error went to an unhandled rejection");
});

test("an import that kills Pyodide answers with the fatal error", { skip, todo: "Pyodide loses a fatal error raised in a cell; the worker should answer it (async/kernel-death)" }, async () => {
    assert.notEqual(killed, "no answer");
    assert.equal(killed.ok, false);
    assert.match(String(killed.error), /Maximum call stack size exceeded|fatal/i);
});

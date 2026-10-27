// python-worker-bridges.test.mjs — the readonly worker lifts the bridge refusal for ONE cell, and only when told to.
//
// The real python-worker.ts under a fake `self` (name "readonly", a message listener, a recorded postMessage) and the real
// Pyodide in Node (`dist/pyodide/`, self-SKIPS without it): the shipped message handler boots it locked down, then cells
// are posted to it as the offscreen document posts them. The refusal itself is python-bridge-gate.test.mjs; who may ASK
// for the lift is python-run-namespace.test.mjs (offscreen) and dialect-inside-host.test.mjs (the service worker).
// Its own file because `lockdown()` is once per realm. Not reached: a `full` worker (`self.name` is read at import, and a
// second import in this realm could not lock down), and an `inside` cell (the dialect refuses what names a bridge anyway,
// so the lift cannot be seen there).
import { test, before, after } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";

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
        `export const loadPyodide = (o) => real({ ...o, indexURL: ${JSON.stringify(path.join(DIST, "pyodide") + "/")} });\n`);
    // Inherits the realm's intrinsics: the TypeScript loader reads them off `self` when it compiles the worker's imports.
    globalThis.self = Object.assign(Object.create(globalThis), {
        name: "readonly",
        location: { href: pathToFileURL(shim + "/").href },
        postMessage: (m) => { posted.push(m); },
        addEventListener: (type, fn) => { if (type === "message") handler = fn; },
    });
    await import("../src/python/python-worker.ts");
}, { timeout: 180000 });

after(() => { if (shim) fs.rmSync(shim, { recursive: true, force: true }); });

/** Post one cell the way the offscreen document does and wait for the worker's answer to it. */
async function cell(code, extra = {}) {
    const id = nextId++;
    handler({ data: { id, code, image: null, hardened: true, tables: null, ...extra } });
    for (let i = 0; i < 6000; i++) {
        const done = posted.find((m) => m.id === id && !m.partial && !m.started && !m.booted);
        if (done) return done;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("no answer for cell " + id);
}

const REFUSED = /is refused in python_exec: a cell may not reach the browser's JavaScript/;
const text = (r) => `${r.error ?? ""}${r.stdout ?? ""}`;
const USES_JS = "import js\n_t = js.setTimeout\nprint('JS-REACHED')";

// The refusal is in the module an import hands back, so each cell ends in a lookup on it (`js.setTimeout`).

// --- the lift is one cell's ---

test("a cell posted with bridges: true reaches js, and the next cell without it is refused again", { skip, timeout: 180000 }, async () => {
    const lifted = await cell(USES_JS, { bridges: true });
    assert.match(text(lifted), /JS-REACHED/, JSON.stringify(lifted));
    assert.doesNotMatch(text(lifted), REFUSED);
    assert.match(text(await cell(USES_JS)), REFUSED, "the lift was that cell's alone");
});

test("a cell posted without bridges (or with anything but true) is refused", { skip, timeout: 180000 }, async () => {
    for (const extra of [{}, { bridges: false }, { bridges: "true" }, { bridges: 1 }]) {
        const r = await cell(USES_JS, extra);
        assert.match(text(r), REFUSED, JSON.stringify(extra));
        assert.doesNotMatch(text(r), /JS-REACHED/);
    }
});

test("the lift is dropped even when the lifted cell throws, so the cell after it is refused", { skip, timeout: 180000 }, async () => {
    const threw = await cell("import js\n_t = js.setTimeout\nraise ValueError('boom')", { bridges: true });
    assert.match(text(threw), /boom/, "positive control: the lifted cell got past the import and threw");
    assert.match(text(await cell(USES_JS)), REFUSED);
});

test("a lifted cell leaves the guard back in sys.modules for the next one", { skip, timeout: 180000 }, async () => {
    await cell("import js\n_t = js.setTimeout", { bridges: true });
    assert.match(text(await cell("import sys\nprint(sys.modules['js'].setTimeout)")), REFUSED);
});

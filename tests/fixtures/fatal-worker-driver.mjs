// fatal-worker-driver.mjs — the real python-worker.ts under a fake `self` and the real Pyodide in Node (as
// python-worker-bridges.test.mjs boots it), in a process of its own: it posts a control cell, then an import that kills
// Pyodide, and prints one JSON line of what came back and where the fatal error went, then exits. A child process,
// because the dead interpreter's leftover work outlives anything a test runner can contain
// (tests/pkg-install-fatal-worker.test.mjs). Run: node --import tsx tests/fixtures/fatal-worker-driver.mjs

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { wheel } from "./wheel-zip.mjs";

const DIST = path.resolve(import.meta.dirname, "../../dist");
const rejections = [];
process.on("unhandledRejection", (e) => { rejections.push(String(e?.message ?? e)); });
const errors = [];
process.on("uncaughtException", (e) => { errors.push(String(e?.message ?? e)); });

const shim = fs.mkdtempSync(path.join(os.tmpdir(), "wml-worker-"));
fs.mkdirSync(path.join(shim, "pyodide"));
fs.writeFileSync(path.join(shim, "pyodide", "pyodide.mjs"),
    `import { loadPyodide as real } from ${JSON.stringify(pathToFileURL(path.join(DIST, "pyodide", "pyodide.mjs")).href)};\n` +
    `export const loadPyodide = (o) => real({ ...o, indexURL: ${JSON.stringify(path.join(DIST, "pyodide") + "/")}, packageBaseUrl: ${JSON.stringify(path.join(DIST, "pyodide") + "/")} });\n`);
const posted = [];
let handler = null;
globalThis.self = Object.assign(Object.create(globalThis), {
    name: "readonly",
    location: { href: pathToFileURL(shim + "/").href },
    postMessage: (m) => { posted.push(m); },
    addEventListener: (type, fn) => { if (type === "message") handler = fn; },
});
await import("../../src/python/python-worker.ts");

let nextId = 1;
/** Post one cell as the offscreen document does; its answer, or "no answer" after `ms`. */
async function cell(code, extra = {}, ms = 120_000) {
    const id = nextId++;
    handler({ data: { id, code, image: null, hardened: true, tables: null, ...extra } });
    for (let i = 0; i < ms / 10; i++) {
        const done = posted.find((m) => m.id === id && !m.partial && !m.started && !m.booted);
        if (done) return { ok: done.ok, error: done.error ?? null, stdout: done.stdout ?? "" };
        await new Promise((r) => setTimeout(r, 10));
    }
    return "no answer";
}

/** A wheel whose one module, at import, compiles a call chain deep enough to overflow the JS stack in the compiler. */
const bytes = wheel([["killer.py", `obj${".a".repeat(3000)}()\n`]], { dist: "killer-1.0.dist-info" });
const killer = { filename: "killer-1.0-py3-none-any.whl", sha256: crypto.createHash("sha256").update(bytes).digest("hex"), bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };

const control = await cell("print('ALIVE')");
const killed = await cell("import killer", { wheels: [killer] }, Number(process.env.FATAL_WAIT_MS ?? 8000));
process.stdout.write(`\nFATAL-WORKER-DRIVER ${JSON.stringify({ control, killed, rejections, errors })}\n`);
fs.rmSync(shim, { recursive: true, force: true });
process.exit(0);

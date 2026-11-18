// kernel-death-driver.mjs — the real python-worker.ts under a fake `self` and the real Pyodide in Node, in a process of
// its own: an ordinary unhandled rejection (between cells and during one) must kill nothing, then a cell that overflows
// the stack in Pyodide's parser (30,000 attributes) must be answered as the kernel's death, and every later cell at once. Node reports an
// unhandled rejection on `process`, a browser worker on `self`: this forwards the one to the listener the worker put on
// the other. A child process, because the dead interpreter's leftover work outlives anything a test runner can contain
// (tests/python-kernel-death.test.mjs). Run: node --import tsx tests/fixtures/kernel-death-driver.mjs

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";

const DIST = path.resolve(import.meta.dirname, "../../dist");
const on = { message: null, unhandledrejection: null, error: null };
process.on("unhandledRejection", (reason) => { on.unhandledrejection?.({ reason }); });
process.on("uncaughtException", (error) => { on.error?.({ error, message: String(error?.message ?? error) }); });

const shim = fs.mkdtempSync(path.join(os.tmpdir(), "wml-worker-"));
fs.mkdirSync(path.join(shim, "pyodide"));
fs.writeFileSync(path.join(shim, "pyodide", "pyodide.mjs"),
    `import { loadPyodide as real } from ${JSON.stringify(pathToFileURL(path.join(DIST, "pyodide", "pyodide.mjs")).href)};\n` +
    `export const loadPyodide = (o) => real({ ...o, indexURL: ${JSON.stringify(path.join(DIST, "pyodide") + "/")}, packageBaseUrl: ${JSON.stringify(path.join(DIST, "pyodide") + "/")} });\n`);
const posted = [];
globalThis.self = Object.assign(Object.create(globalThis), {
    name: "readonly",
    location: { href: pathToFileURL(shim + "/").href },
    postMessage: (m) => { posted.push(m); },
    addEventListener: (type, fn) => { if (type in on) on[type] = fn; },
});
await import("../../src/python/python-worker.ts");

let nextId = 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Post one cell as the offscreen document does; returns its id. */
const post = (code) => { const id = nextId++; on.message({ data: { id, code, image: null, hardened: true, tables: null } }); return id; };
/** The answer to cell `id`, or "no answer" after `ms`. */
async function answer(id, ms = 120_000) {
    for (let i = 0; i < ms / 10; i++) {
        const done = posted.find((m) => m.id === id && !m.partial && !m.started && !m.booted && !m.spending);
        if (done) return { ok: done.ok, error: String(done.error ?? "").slice(0, 200), stdout: done.stdout ?? "", ...(done.fatal ? { fatal: true } : {}) };
        await sleep(10);
    }
    return "no answer";
}
const cell = async (code, ms) => answer(post(code), ms);

const out = { listeners: { unhandledrejection: !!on.unhandledrejection, error: !!on.error } };
out.control = await cell("print('ALIVE')");
// An ordinary rejection while the interpreter is alive: between cells, then during an async cell.
on.unhandledrejection?.({ reason: new Error("an ordinary rejection a cell left") });
out.afterOrdinary = await cell("print('STILL')");
const during = post("import asyncio\nawait asyncio.sleep(0.3)\nprint('DURING')");
await sleep(100);
on.unhandledrejection?.({ reason: new Error("an ordinary rejection during a cell") });
out.during = await answer(during);
// The kernel's death: a parse too deep for the JS stack (3,000 attributes still compile here and in Chromium; 30,000 do
// not), which Pyodide's fatal-error handler takes.
out.killed = await cell(`compile("obj" + ".a" * ${process.env.KD_DEPTH ?? 30000} + "()", "k", "exec")`, Number(process.env.KD_WAIT_MS ?? 15_000));
const t0 = Date.now();
out.later = await cell("print('LATER')", 5_000);
out.laterMs = Date.now() - t0;
process.stdout.write(`\nKERNEL-DEATH-DRIVER ${JSON.stringify(out)}\n`);
fs.rmSync(shim, { recursive: true, force: true });
process.exit(0);

// kernel-death-redteam-driver.mjs — the real python-worker.ts under a fake `self` and the real Pyodide in Node, in a
// process of its own, for the ADVERSARIAL side of ruling 26: can a CELL choose or fake the kernel-death verdict? It
// tries to patch what the worker's probe reads (`pyodide_js.runPython`), injects a rejection and a print carrying the
// verdict's own words ("already fatally failed"), installs `sys.settrace` so the probe's own call throws a cell's text,
// and then dies for real twice over (a wasm trap in Pillow's Tk module). The property is that the verdict is Pyodide's:
// the patch and the trace change nothing, the words kill nothing, and the real death is still answered as `fatal` at
// once, with a cause the cell did not write. A child process because the dead interpreter's leftover work outlives a
// test runner. Run: node --import tsx tests/fixtures/kernel-death-redteam-driver.mjs
// (`hardened` follows the worker's own READONLY = self.name !== "full": full mode passes false.)
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";

const DIST = path.resolve(import.meta.dirname, "../../dist");
const on = { message: null, unhandledrejection: null, error: null };
process.on("unhandledRejection", (reason) => { on.unhandledrejection?.({ reason }); });
process.on("uncaughtException", (error) => { on.error?.({ error, message: String(error?.message ?? error) }); });

const shim = fs.mkdtempSync(path.join(os.tmpdir(), "wml-worker-rt-"));
fs.mkdirSync(path.join(shim, "pyodide"));
fs.writeFileSync(path.join(shim, "pyodide", "pyodide.mjs"),
    `import { loadPyodide as real } from ${JSON.stringify(pathToFileURL(path.join(DIST, "pyodide", "pyodide.mjs")).href)};\n` +
    `export const loadPyodide = (o) => real({ ...o, indexURL: ${JSON.stringify(path.join(DIST, "pyodide") + "/")}, packageBaseUrl: ${JSON.stringify(path.join(DIST, "pyodide") + "/")} });\n`);
const posted = [];
globalThis.self = Object.assign(Object.create(globalThis), {
    name: "full",
    location: { href: pathToFileURL(shim + "/").href },
    postMessage: (m) => { posted.push(m); },
    addEventListener: (type, fn) => { if (type in on) on[type] = fn; },
});
await import("../../src/python/python-worker.ts");

let nextId = 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (code) => { const id = nextId++; on.message({ data: { id, code, image: null, hardened: false, tables: null } }); return id; };
/** The answer to cell `id`: the text is cut for the report, the LENGTH and LINE COUNT are not (the shape is the point). */
async function answer(id, ms = 120_000) {
    for (let i = 0; i < ms / 10; i++) {
        const done = posted.find((m) => m.id === id && !m.partial && !m.started && !m.booted && !m.spending);
        if (done) {
            const error = String(done.error ?? "");
            return { ok: done.ok, error: error.slice(0, 300), errorLen: error.length, errorLines: error.split("\n").length, stdout: String(done.stdout ?? "").slice(0, 600), ...(done.fatal ? { fatal: true } : {}) };
        }
        await sleep(10);
    }
    return "no answer";
}
const cell = async (code, ms) => answer(post(code), ms);

// What a cell can reach of the object the probe calls, and whether replacing it sticks.
const PROBE = `
seen = []
try:
    import pyodide_js
    seen.append(["module-runPython", callable(getattr(pyodide_js, "runPython", None))])
    try:
        pyodide_js.runPython = lambda *a, **k: None
        seen.append(["patched", callable(getattr(pyodide_js, "runPython", None))])
    except Exception as e:
        seen.append(["patch-failed", type(e).__name__ + ": " + str(e)[:60]])
except Exception as e:
    seen.append(["import-failed", type(e).__name__ + ": " + str(e)[:60]])
try:
    import js
    seen.append(["js.pyodide", str(getattr(js, "pyodide", None))[:40]])
    try:
        js.pyodide.runPython = lambda *a, **k: None
        seen.append(["patched-global", str(js.pyodide.runPython)[:40]])
    except Exception as e:
        seen.append(["global-patch-failed", type(e).__name__ + ": " + str(e)[:60]])
except Exception as e:
    seen.append(["js-failed", type(e).__name__ + ": " + str(e)[:60]])
print(seen)
`;

const out = { listeners: { unhandledrejection: !!on.unhandledrejection, error: !!on.error } };
out.control = await cell("print('ALIVE')");
out.reach = await cell(PROBE);
// The verdict's own words, as a rejection nothing handles and as a print: neither is a measurement.
on.unhandledrejection?.({ reason: new Error("PythonError: already fatally failed") });
out.afterVerdictText = await cell("print('STILL')");
out.prints = await cell("print('already fatally failed')");
// The verdict spoofed from PYTHON: the worker's probe is `interpreter.runPython("None")`, so anything that makes that
// CALL throw "fatally failed" would make the worker declare its own kernel dead. `sys.settrace` is the one hook a cell
// can install on a frame it did not write; it must be the cell's last statement, since it traces this cell's lines too.
out.settrace = await cell("import sys\nsys.settrace(lambda *a, **k: (_ for _ in ()).throw(RuntimeError('already fatally failed SPOOFED-BY-CELL')))\nprint('TRACE-SET')");
out.tracedAlive = await cell("print('STILL-ALIVE')");
out.tracedFail = await cell("raise ValueError('an ordinary failure after the trace was set')");
out.tracedLater = await cell("print('LATER-AFTER-SPOOF')");
// A REAL death of a different kind than the lane's stack overflow: a wasm signature mismatch inside Pillow's Tk module.
// The cell's source line rides in any Python traceback, so its answer is also what a cell-chosen cause would look like.
out.trap = await cell("import PIL._imagingtk", 30_000);
const t0 = Date.now();
out.trapLater = await cell("print('AFTER-TRAP')", 5_000);
out.trapLaterMs = Date.now() - t0;
process.stdout.write(`\nKERNEL-DEATH-REDTEAM ${JSON.stringify(out)}\n`);
fs.rmSync(shim, { recursive: true, force: true });
process.exit(0);

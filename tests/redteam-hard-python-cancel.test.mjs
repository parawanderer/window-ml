// tests/redteam-hard-python-cancel.test.mjs — independent probes of the readonly worker's bounded task spend, against real Pyodide on the pinned core.

import { test, before, after } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { wrapUserCode, injectInputs, hostRunScript } from "../src/python/python-runtime.ts";
import { lockdownReadonly } from "../src/python/lockdown.ts";
import { onSpending } from "../src/python/cell-gate.ts";

const PYODIDE_DIR = path.resolve(import.meta.dirname, "../dist/pyodide");
const hasPyodide = fs.existsSync(path.join(PYODIDE_DIR, "pyodide.mjs"));
const skip = hasPyodide ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";

let py = null;
let harness = null;
let fork = false;
let spendStarted = 0;

before(async () => {
    if (!hasPyodide) return;
    const { loadPyodide } = await import(path.join(PYODIDE_DIR, "pyodide.mjs"));
    py = await loadPyodide({ indexURL: PYODIDE_DIR });
    const withArrow = fs.readdirSync(PYODIDE_DIR).some((f) => f.startsWith("pyarrow-"));
    await py.loadPackage(["numpy", "pillow", "pandas", "beautifulsoup4", "html5lib", "sympy", ...(withArrow ? ["pyarrow"] : [])]);
    fork = py.runPython(`import importlib.util; importlib.util.find_spec("_restricted") is not None`);
    ({ harness } = await lockdownReadonly(py, {}));
    onSpending(() => { spendStarted = Date.now(); });
}, { timeout: 180000 });

after(async () => {
    onSpending(null);
    try { await py?.destroy?.(); } catch { /* */ }
});

/** Run an approved cell through the real boot harness and measure from the spend's own mark to its return. */
async function cell(code) {
    py.runPython("globals().pop('_queue_ms', None)");
    injectInputs(py.globals, null, null, harness);
    spendStarted = 0;
    const script = wrapUserCode(code, true, false, "host");
    const cancelled = await hostRunScript(harness, script, py.globals);
    const queueMs = py.globals.get("_queue_ms");
    const finished = Date.now();
    const errText = (py.globals.get("_err") ? String(py.globals.get("_err")) : "") + (cancelled.refusal ?? "");
    const jr = py.globals.get("_json_result");
    let value = null;
    try { value = JSON.parse(jr); } catch { value = jr === undefined ? null : String(jr); }
    if (cancelled.refusal) value = null;
    return {
        stdout: String(py.globals.get("_stdout") ?? "") + (cancelled.out ?? ""),
        error: errText || cancelled.error || null,
        value,
        queueMs: typeof queueMs === "number" ? queueMs : null,
        spendMs: spendStarted ? finished - spendStarted : null,
    };
}

// --- the spend's clock covers every kind of work it drives -----------------------------------------

test("the 1 s spend bound also covers callbacks already queued on the event loop", {
    skip,
    timeout: 60000,
}, async (t) => {
    if (!fork) return t.skip("needs the restricted-mode fork core (npm run fetch-pyodide)");
    // Positive control: an ordinary leftover task takes the spend path and is spent promptly.
    const control = await cell(`
import asyncio
async def _left():
    try:
        await asyncio.sleep(10)
    except BaseException:
        pass
asyncio.ensure_future(_left()).set_name("ordinary-leftover")
await asyncio.sleep(0)
"control"
`);
    assert.equal(control.error, null, `control cell failed: ${control.error}`);
    assert.equal(control.value, "control");
    assert.ok(control.spendMs !== null, "control must reach the spend's mark");
    assert.ok(control.spendMs < 1000, `control: an ordinary task should spend within the 1 s bound, took ${control.spendMs} ms`);

    // The queued callbacks are built-ins and the loop/Handle frames are in the tracer's skip paths.
    // Pin 15 at 933e5e48 cuts the queue in JS at the deadline, with a residual for the queueing and drop costs.
    const queued = await cell(`
global _queue_ms
import asyncio, time
_sink = {}
_loop = asyncio.get_event_loop()
async def _left():
    try:
        await asyncio.sleep(10)
    except BaseException:
        pass
asyncio.ensure_future(_left()).set_name("queued-callback-leftover")
await asyncio.sleep(0)
_queue_started = time.monotonic()
for _ in range(250000):
    _loop.call_soon(_sink.clear)
_queue_ms = (time.monotonic() - _queue_started) * 1000
"queued"
`);
    assert.ok((queued.error === null && queued.value === "queued")
        || (queued.value === null && /RuntimeError: \d+ callbacks? this cell queued were dropped/.test(String(queued.error))),
    `queued cell must return its value or refuse by naming dropped callbacks, got ${JSON.stringify(queued)}`);
    assert.ok(queued.spendMs !== null, "queued cell must reach the spend's mark");
    // Pin 15's primary bound uses the cell's measured queueing time, with the quiet-run 250 ms allowance as its floor.
    // The ordinary control separately measures this run's harness overhead around the 1 s deadline.
    assert.ok(Number.isFinite(queued.queueMs) && queued.queueMs >= 0, `the cell must report its queueing time, got ${queued.queueMs}`);
    const residualMs = Math.max(250, queued.queueMs / 2);
    const allowedSpendMs = 1000 + control.spendMs + residualMs;
    console.log(`  spend with 250000 already-queued built-in callbacks: ${queued.spendMs} ms (control ${control.spendMs} ms, queueing ${queued.queueMs} ms)`);
    assert.ok(queued.spendMs < allowedSpendMs,
        `the cancel spent ${queued.spendMs} ms cutting queued callbacks; the 1 s deadline, this run's ${control.spendMs} ms control slack, and pin 15's ${residualMs} ms residual allow ${allowedSpendMs} ms`);
    assert.ok(queued.spendMs < 5000, `the queue cut took ${queued.spendMs} ms, approaching the 15 s kill instead of cutting promptly`);
});

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
    injectInputs(py.globals, null, null, harness);
    spendStarted = 0;
    const script = wrapUserCode(code, true, false, "host");
    const cancelled = await hostRunScript(harness, script, py.globals);
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
        spendMs: spendStarted ? finished - spendStarted : null,
    };
}

// --- the spend's clock covers every kind of work it drives -----------------------------------------

test("the 1 s spend bound also covers callbacks already queued on the event loop", {
    skip,
    timeout: 60000,
    todo: "measured on the pinned fork after afcbe2b9: 250000 built-in callbacks queued after the leftover task started kept the cancel in skipped event-loop/Handle frames for 3802 ms; the 1 s trace deadline did not fire",
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
    // The cell itself is finished; this time is entirely the cancel draining work it did not bound.
    const queued = await cell(`
import asyncio
_sink = {}
_loop = asyncio.get_event_loop()
async def _left():
    try:
        await asyncio.sleep(10)
    except BaseException:
        pass
asyncio.ensure_future(_left()).set_name("queued-callback-leftover")
await asyncio.sleep(0)
for _ in range(250000):
    _loop.call_soon(_sink.clear)
"queued"
`);
    assert.ok((queued.error === null && queued.value === "queued")
        || (queued.value === null && /RuntimeError:[\s\S]*dropped \d+ callbacks?/.test(String(queued.error))),
    `queued cell must return its value or refuse by naming dropped callbacks, got ${JSON.stringify(queued)}`);
    assert.ok(queued.spendMs !== null, "queued cell must reach the spend's mark");
    // The ordinary control measures this harness's overhead around the 1 s deadline on this run.
    const allowedSpendMs = 1000 + control.spendMs;
    console.log(`  spend with 250000 already-queued built-in callbacks: ${queued.spendMs} ms (control ${control.spendMs} ms)`);
    assert.ok(queued.spendMs < allowedSpendMs,
        `the cancel spent ${queued.spendMs} ms draining queued callbacks; the 1 s bound plus this run's measured ${control.spendMs} ms control overhead is ${allowedSpendMs} ms`);
});

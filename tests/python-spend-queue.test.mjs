// tests/python-spend-queue.test.mjs — the loop's queue under the lockdown (spend-queue.ts): what a cell queued is cut at
// the spend's deadline, and what was cut is destroyed before a later cell can reach it.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { makeSpendQueue, SWEEP_BATCH } from "../src/python/spend-queue.ts";
import { wrapUserCode, injectInputs, hostRunScript } from "../src/python/python-runtime.ts";
import { lockdownReadonly } from "../src/python/lockdown.ts";
import { onSpending } from "../src/python/cell-gate.ts";

const PYODIDE_DIR = path.resolve(import.meta.dirname, "../dist/pyodide");
const hasPyodide = fs.existsSync(path.join(PYODIDE_DIR, "pyodide.mjs"));
const skip = hasPyodide ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";

let py = null;
let harness = null;
let spendStarted = 0;

before(async () => {
    if (!hasPyodide) return;
    const { loadPyodide } = await import(path.join(PYODIDE_DIR, "pyodide.mjs"));
    py = await loadPyodide({ indexURL: PYODIDE_DIR });
    const withArrow = fs.readdirSync(PYODIDE_DIR).some((f) => f.startsWith("pyarrow-"));
    await py.loadPackage(["numpy", "pillow", "pandas", "beautifulsoup4", "html5lib", "sympy", ...(withArrow ? ["pyarrow"] : [])]);
    ({ harness } = await lockdownReadonly(py, {}));
    onSpending(() => { spendStarted = Date.now(); });
}, { timeout: 180000 });

after(async () => {
    onSpending(null);
    try { await py?.destroy?.(); } catch { /* */ }
});

/** Run a cell through the real boot harness; the spend is timed from its own mark to the cancel's return. */
async function cell(code) {
    injectInputs(py.globals, null, null, harness);
    spendStarted = 0;
    const cancelled = await hostRunScript(harness, wrapUserCode(code, true, false, "host"), py.globals);
    const finished = Date.now();
    const jr = py.globals.get("_json_result");
    let value = null;
    try { value = JSON.parse(jr); } catch { value = jr === undefined ? null : String(jr); }
    return {
        error: (py.globals.get("_err") ? String(py.globals.get("_err")) : "") + (cancelled.refusal ?? "") + (cancelled.error ?? "") || null,
        value: cancelled.refusal ? null : value,
        spendMs: spendStarted ? finished - spendStarted : null,
    };
}

// --- the queue on its own: a fake scheduler and a fake clock ---

/** A queue over a FIFO that runs only when pumped, a clock the test moves, and a log of what was released. */
function fakeQueue() {
    const fifo = [];
    const released = [];
    let t = 0;
    const q = makeSpendQueue((cb) => fifo.push(cb), (ptr) => released.push(`ref ${ptr}`), () => t);
    const pump = () => { while (fifo.length) fifo.shift()(); };
    const cb = (name, ran) => Object.assign(() => ran.push(name), { destroy: () => released.push(`destroy ${name}`) });
    return { q, pump, cb, released, at: (ms) => { t = ms; }, fifo };
}

test("an entry queued before the deadline is cut once it has passed and never runs; one queued after it runs", () => {
    const { q, pump, cb, at } = fakeQueue();
    const ran = [];
    q.schedule(cb("before", ran));
    q.mark(1);
    q.schedule(cb("also before", ran));
    at(1001);
    q.schedule(cb("after", ran));
    pump();
    assert.deepEqual(ran, ["after"]);
    assert.equal(q.done(), 2, "the deadline's count");
});

test("control: before the deadline every entry runs, in order, and nothing is counted", () => {
    const { q, pump, cb, at } = fakeQueue();
    const ran = [];
    q.mark(1);
    q.schedule(cb("a", ran));
    q.schedule(cb("b", ran));
    at(999);
    pump();
    assert.deepEqual(ran, ["a", "b"]);
    assert.equal(q.done(), 0);
});

test("the cancel's chain survives the cut: its one-shot, the wakeup that queues, and the wakeup's second turn", () => {
    const { q, pump, cb, at } = fakeQueue();
    const ran = [];
    q.schedule(cb("cell's", ran));
    q.mark(1);
    // The one-shot queues the wakeup; the wakeup queues its second turn (as Pyodide's JSPI call does), which runs Python.
    q.turn(Object.assign(() => q.schedule(Object.assign(() => q.hop(() => ran.push("wakeup's python")), { destroy() {} })), { destroy() {} }));
    at(1001);
    pump();
    assert.deepEqual(ran, ["wakeup's python"]);
    assert.equal(q.done(), 1);
});

test("a link of the chain is recognised only by the one before it: a hop from the one-shot, or a callback from the wakeup, is cut", () => {
    const { q, pump, cb, at, fifo } = fakeQueue();
    const ran = [];
    q.mark(1);
    // Step the chain one turn at a time before the deadline, so what each link queues is queued before it and waits.
    q.turn(Object.assign(() => q.hop(() => ran.push("hop queued by the one-shot")), { destroy() {} }));
    fifo.shift()();   // the one-shot: its hop is queued, not run
    q.turn(Object.assign(() => q.schedule(Object.assign(() => q.schedule(cb("callback queued by the wakeup", ran)), { destroy() {} })), { destroy() {} }));
    fifo.pop()();     // the second one-shot: queues the wakeup
    fifo.pop()();     // the wakeup: queues a callback
    at(1001);
    pump();
    assert.deepEqual(ran, [], "neither ran: only the wakeup itself and its own second turn are the chain's");
    assert.equal(q.done(), 2, "both were cut by the deadline");
});

test("a link of the chain is only the FIRST entry the one before it queues: what it queues after the wakeup is cut", () => {
    const { q, pump, cb, at, fifo } = fakeQueue();
    const ran = [];
    q.mark(1);
    // A cell that gets code run inside the one-shot (a done callback on the cancel's Future) queues behind the wakeup;
    // the wakeup's own second turn is likewise the first hop it queues, never a second.
    const wakeup = Object.assign(() => { q.hop(() => ran.push("wakeup's python")); q.hop(() => ran.push("second hop")); }, { destroy() {} });
    q.turn(Object.assign(() => { q.schedule(wakeup); q.schedule(cb("queued after the wakeup", ran)); }, { destroy() {} }));
    fifo.shift()();   // the one-shot: queues the wakeup, then the callback
    fifo.shift()();   // the wakeup: queues its second turn, then another hop; all before the deadline
    at(1001);
    pump();
    assert.deepEqual(ran, ["wakeup's python"]);
    assert.equal(q.done(), 2, "the callback and the second hop were cut by the deadline");
});

test("done cuts everything still queued, counting only what the deadline cut", () => {
    const { q, pump, cb, at } = fakeQueue();
    const ran = [];
    q.mark(1);
    q.schedule(cb("x", ran));
    at(10);
    assert.equal(q.done(), 0, "the deadline had not passed");
    pump();
    assert.deepEqual(ran, [], "cut by done all the same");
    assert.equal(q.doomed(), 1);
});

test("the sweep destroys cut callbacks and releases the reference each cut second turn held, in batches", async () => {
    const fifo = [];
    const released = [];
    const q = makeSpendQueue((cb) => fifo.push(cb), (ptr) => released.push(ptr), () => 0);
    for (let i = 0; i < SWEEP_BATCH + 3; i++) q.schedule(Object.assign(() => {}, { destroy: () => released.push("cb") }));
    q.calling(77, () => q.hop(() => {}));
    q.hop(() => {});   // a turn queued outside a call holds nothing
    q.done();
    fifo.length = 0;   // the cut entries' own callbacks: no-ops now
    const swept = q.sweep();
    fifo.shift()();
    assert.equal(released.length, SWEEP_BATCH, "one batch per turn");
    while (fifo.length) fifo.shift()();
    await swept;
    assert.deepEqual([released.filter((r) => r === "cb").length, released.filter((r) => r === 77).length], [SWEEP_BATCH + 3, 1]);
    assert.equal(q.doomed(), 0);
});

// --- the flood, on the real boot harness ---
// 250000 builtin callbacks queued behind a task the cell left (the hard red team's hunt 2, #1171): before the queue
// they kept the spend busy 3.3 to 3.8 s past its 1 s deadline.

const FLOOD = (name, n = 250000) => `
import asyncio
_loop = asyncio.get_event_loop()
_sink = {}
async def _left():
    try:
        await asyncio.sleep(10)
    except BaseException:
        pass
asyncio.ensure_future(_left()).set_name("${name}")
await asyncio.sleep(0)
for _ in range(${n}):
    _loop.call_soon(_sink.clear)
"queued"`;

test("a flood of queued callbacks is cut at the deadline: the spend returns within its bound and the cell is refused, naming both", { skip, timeout: 60000 }, async () => {
    const control = await cell(FLOOD("ordinary-leftover", 0));
    assert.deepEqual([control.error, control.value], [null, "queued"], "control: an ordinary leftover is spent and the value returned");
    const r = await cell(FLOOD("flooded-leftover"));
    console.log(`  spend with 250000 queued callbacks: ${r.spendMs} ms (control ${control.spendMs} ms)`);
    assert.ok(r.spendMs < 1500, `the spend took ${r.spendMs} ms`);
    assert.match(r.error, /^RuntimeError: \d+ callbacks this cell queued were dropped at the spend's deadline, so flooded-leftover \(.*_left\) never took its cancel; the result is refused rather than returned beside it\.\n$/);
    assert.equal(r.value, null);
    const next = await cell(`1`);
    assert.deepEqual([next.error, next.value], [null, 1], "the worker and namespace survive; the dropped task is not spent again");
});

test("the largest flood under the kill, with a heavier callback per entry: cut and named, or a MemoryError, never a hang", { skip, timeout: 180000 }, async () => {
    // Pin 15's stress case: 8 s of queueing is the largest flood that fits inside the 15 s kill. Each entry holds its own
    // 256-byte buffer, so the heap is reached sooner than with a shared one. A worker that dies of memory instead is named
    // by the offscreen (python-reap.test.mjs, "a worker that dies of memory"); here the interpreter must either cut and
    // name the flood or raise Python's own MemoryError.
    const heap0 = process.memoryUsage();
    const r = await cell(`
import asyncio, time
_loop = asyncio.get_event_loop()
async def _left():
    try:
        await asyncio.sleep(30)
    except BaseException:
        pass
asyncio.ensure_future(_left()).set_name("heavy-leftover")
await asyncio.sleep(0)
_end = time.monotonic() + 8
_n = 0
while time.monotonic() < _end:
    for _ in range(1000):
        _loop.call_soon(bytearray(256).clear)
    _n += 1000
"queued"`);
    const heap1 = process.memoryUsage();
    console.log(`  heavy flood: spend ${r.spendMs} ms; rss +${heap1.rss - heap0.rss} bytes, JS heap +${heap1.heapUsed - heap0.heapUsed} bytes; ${String(r.error).slice(0, 80)}`);
    assert.match(String(r.error), /callbacks this cell queued were dropped at the spend's deadline, so heavy-leftover|MemoryError/, `got ${JSON.stringify(r).slice(0, 400)}`);
    const next = await cell(`1`);
    assert.deepEqual([next.error, next.value], [null, 1], "the worker and namespace survive");
});

test("a flood with no task left is cut silently when the cancel returns: the value is returned", { skip, timeout: 60000 }, async () => {
    const r = await cell(`
import asyncio
_loop = asyncio.get_event_loop()
for _ in range(250000):
    _loop.call_soon(dict.clear, {})
"done"`);
    assert.deepEqual([r.error, r.value], [null, "done"]);
});

/** A cell that counts what of an earlier cell's it can reach by walking the heap. */
const PROBE = `
import gc, asyncio, contextvars
_found = {"dict": 0, "callback": 0, "context": 0}
for _o in gc.get_objects():
    if type(_o) is dict and _o.get("marker") == "A-SECRET":
        _found["dict"] += 1
    elif isinstance(_o, asyncio.Handle) and getattr(_o, "_callback", None).__class__.__name__ == "builtin_function_or_method" and getattr(_o._callback, "__self__", None).__class__ is dict and _o._callback.__self__.get("marker") == "A-SECRET":
        _found["callback"] += 1
    elif type(_o) is contextvars.Context and any(v == "A-CONTEXT" for v in _o.values()):
        _found["context"] += 1
_found`;

test("the next cell reaches none of what the cut dropped: no callable, no context, nothing they held", { skip, timeout: 60000 }, async () => {
    const a = await cell(`
import asyncio, contextvars
_loop = asyncio.get_event_loop()
_cv = contextvars.ContextVar("ml_probe")
def _queue():
    secret = {"marker": "A-SECRET"}
    _cv.set("A-CONTEXT")
    # Under the monitoring tool a C callback raises no event, so 100000 of them ran inside the budget (measured); a
    # million are cut, as are 400000.
    for _ in range(1000000):
        _loop.call_soon(secret.clear)
async def _left():
    try:
        await asyncio.sleep(10)
    except BaseException:
        pass
asyncio.ensure_future(_left()).set_name("reach-leftover")
await asyncio.sleep(0)
_queue()
del _queue, _cv
"queued"`);
    assert.match(String(a.error), /callbacks this cell queued were dropped at the spend's deadline/, "the flood was cut (else this proves nothing)");
    const b = await cell(PROBE);
    assert.deepEqual(b.value, { dict: 0, callback: 0, context: 0 });
    // Positive control: the same walk finds a context and a dict that are still alive.
    const held = await cell(`
import contextvars
_keep_cv = contextvars.ContextVar("ml_probe_held")
_keep_ctx = contextvars.copy_context()
_keep_ctx.run(_keep_cv.set, "A-CONTEXT")
_keep_dict = {"marker": "A-SECRET"}
${PROBE}`);
    assert.deepEqual([held.value.dict, held.value.context], [1, 1], `control: the walk finds what is alive, got ${JSON.stringify(held.value)}`);
    await cell(`del _keep_cv, _keep_ctx, _keep_dict\n1`);
});

test("the dropped task's handler never runs: not in the spend, not when a later cell collects it", { skip, timeout: 60000 }, async () => {
    const r = await cell(`
import asyncio, sys, types
_m = types.ModuleType("_sq_ran")
_m.ran = []
sys.modules["_sq_ran"] = _m
async def _left():
    try:
        await asyncio.sleep(10)
    except BaseException:
        _m.ran.append("handler")
    finally:
        _m.ran.append("finally")
asyncio.ensure_future(_left()).set_name("handler-leftover")
await asyncio.sleep(0)
_loop = asyncio.get_event_loop()
for _ in range(250000):
    _loop.call_soon(dict.clear, {})
"queued"`);
    assert.match(String(r.error), /handler-leftover .* never took its cancel/);
    const later = await cell(`import gc, sys\ngc.collect()\nsys.modules["_sq_ran"].ran`);
    assert.deepEqual(later.value, []);
});

test("the dropped task's coroutine is closed in the spend, before anything collects it, with none of its handlers run", { skip, timeout: 60000 }, async () => {
    const r = await cell(`
import asyncio, sys, types
_m = types.ModuleType("_sq_closed")
_m.ran = []
sys.modules["_sq_closed"] = _m
async def _left():
    try:
        await asyncio.sleep(10)
    except BaseException:
        _m.ran.append("handler")
    finally:
        _m.ran.append("finally")
_m.coro = _left()
asyncio.ensure_future(_m.coro).set_name("closed-leftover")
await asyncio.sleep(0)
_loop = asyncio.get_event_loop()
for _ in range(1000000):
    _loop.call_soon(dict.clear, {})
"queued"`);
    assert.match(String(r.error), /closed-leftover .* never took its cancel/, "the cut dropped the task's cancel (else this proves nothing)");
    // No gc.collect(): the cell still holds the coroutine, so only the spend's close() can have ended it.
    const later = await cell(`import sys, inspect\n_m = sys.modules["_sq_closed"]\n[inspect.getcoroutinestate(_m.coro), _m.coro.cr_frame is None, _m.ran]`);
    assert.deepEqual(later.value, ["CORO_CLOSED", true, []]);
});

test("a cell that rebinds webloop's scheduler does not hold the cancel: the cancel puts the queue back first", { skip, timeout: 60000 }, async () => {
    const r = await cell(`
import asyncio, pyodide.webloop as _w
async def _left():
    try:
        await asyncio.sleep(10)
    except BaseException:
        pass
asyncio.ensure_future(_left()).set_name("rebind-leftover")
await asyncio.sleep(0)
_w.scheduleCallback = lambda *a: None
"rebound"`);
    assert.deepEqual([r.error, r.value], [null, "rebound"], "the leftover was spent through the queue");
    assert.ok(r.spendMs < 1500, `the spend took ${r.spendMs} ms`);
    const next = await cell(`import asyncio\nawait asyncio.sleep(0)\n2`);
    assert.deepEqual([next.error, next.value], [null, 2], "the loop works for the next cell");
});

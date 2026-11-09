// python-bench-stop.test.mjs — a bench Stop in the real core: the interrupt buffer ends a script, and a stop that did not land never reaches the next one.
//
// The real python-worker.ts under a fake `self` (name "readonly") and the real Pyodide in Node (`dist/pyodide/`,
// self-SKIPS without it), as python-worker-bridges.test.mjs runs it. The buffer is posted first, as the offscreen
// document posts it (offscreen.ts `ensureWorker`), and the stop is written from a SECOND THREAD, since a running script
// holds this one: that is where the offscreen document stands to the worker. That thread re-arms the stop and
// watchdogs it — a WASM `while True` blocks THIS thread, so no timeout here can fire (see `stopAfter`). Which run a
// stop may reach, and the kill when it is not answered, are the offscreen document's (python-bench-stop-offscreen.test.mjs).
// Its own file because `lockdown()` is once per realm.
import { test, before, after } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

const DIST = path.resolve(import.meta.dirname, "../dist");
const hasPyodide = fs.existsSync(path.join(DIST, "pyodide", "pyodide.mjs"));
const skip = hasPyodide ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";

let shim = null;
const posted = [];
let handler = null;
let nextId = 1;
const flag = new Int32Array(new SharedArrayBuffer(4));
// Set when `cell` sees the worker's `started` (the user's script is live). `stopAfter`'s writer stops re-arming
// then: the start wipe (`run()`'s clearInterrupt before the script) is behind us, and a write after the END wipe
// would land in the run's own cleanup (`cancel`) and fail the file on an unhandled rejection (2026-11-09).
const scriptStarted = new Int32Array(new SharedArrayBuffer(4));

before(async () => {
    if (!hasPyodide) return;
    // Pyodide in Node wants a filesystem path where the worker hands it a URL (python-worker-bridges.test.mjs).
    shim = fs.mkdtempSync(path.join(os.tmpdir(), "wml-stop-"));
    fs.mkdirSync(path.join(shim, "pyodide"));
    fs.writeFileSync(path.join(shim, "pyodide", "pyodide.mjs"),
        `import { loadPyodide as real } from ${JSON.stringify(pathToFileURL(path.join(DIST, "pyodide", "pyodide.mjs")).href)};\n` +
        `export const loadPyodide = (o) => real({ ...o, indexURL: ${JSON.stringify(path.join(DIST, "pyodide") + "/")} });\n`);
    globalThis.self = Object.assign(Object.create(globalThis), {
        name: "readonly",
        location: { href: pathToFileURL(shim + "/").href },
        postMessage: (m) => { posted.push(m); },
        addEventListener: (type, fn) => { if (type === "message") handler = fn; },
    });
    await import("../src/python/python-worker.ts");
    handler({ data: { interruptBuffer: flag } });
}, { timeout: 180000 });

after(() => { if (shim) fs.rmSync(shim, { recursive: true, force: true }); });

/** Post one bench script the way the offscreen document does and wait for the worker's answer to it. */
async function cell(code) {
    const id = nextId++;
    handler({ data: { id, code, image: null, hardened: true, tables: null, persist: true } });
    for (let i = 0; i < 6000; i++) {
        if (posted.some((m) => m.id === id && m.started)) Atomics.store(scriptStarted, 0, 1);
        const done = posted.find((m) => m.id === id && !m.partial && !m.started && !m.booted && !m.spending);
        if (done) return done;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("no answer for cell " + id);
}

/**
 * Write a stop into the buffer from another thread after `ms`, as a Stop does while this thread runs Python — and
 * KEEP writing it until `done()`. A single write is not enough: `run()`'s `clearInterrupt()` wipes a stop that
 * landed before the script started, which is the product's rule (a stop meant for the previous run must not
 * interrupt this one). On a loaded runner 300 ms is not a safe gap — that wipe took the only write on 2026-11-09
 * and `while True` then held the file for 37 minutes with nothing able to time out (the WASM loop blocks this
 * thread, so neither `cell`'s poll nor `timeout: 180000` can fire). Re-arming survives the wipe.
 *
 * The same thread WATCHES: if the stop is still armed `failAfterMs` later the script never ended, and
 * `process.exit(1)` fails the file loud. (The product's own bound is `BENCH_STOP_KILL_MS` in offscreen.ts —
 * this test drives the worker's handler directly and so does not get that kill.)
 *
 * Re-arming stops once `cell` has seen the worker's `started`: the start wipe is behind us, and one more write
 * puts the stop in place. A write after the END wipe (run()'s finally) lands in the run's own cleanup and fails
 * the file on an unhandled rejection. Call `done()` when the cell returns, before any next one — a still-arming
 * writer would put a stop into the next script too (clearInterrupt only wipes one write).
 */
function stopAfter(ms, { failAfterMs = 15_000 } = {}) {
    const armed = new Int32Array(new SharedArrayBuffer(4));
    Atomics.store(armed, 0, 1);
    Atomics.store(scriptStarted, 0, 0);
    const w = new Worker(`
        const { workerData } = require('node:worker_threads');
        const a = new Int32Array(workerData.sab);
        const armed = new Int32Array(workerData.armed);
        const started = new Int32Array(workerData.started);
        let iv = 0;
        setTimeout(() => {
            iv = setInterval(() => {
                if (!Atomics.load(armed, 0)) return;
                Atomics.store(a, 0, 2);
                if (Atomics.load(started, 0)) clearInterval(iv); // script is live: the stop is in place, stop writing
            }, 5);
        }, workerData.ms);
        setTimeout(() => {
            if (!Atomics.load(armed, 0)) return;
            console.error("python-bench-stop: the stop never ended the script within " + workerData.failAfterMs + "ms");
            process.exit(1);
        }, workerData.failAfterMs);
    `, { eval: true, workerData: { sab: flag.buffer, armed: armed.buffer, started: scriptStarted.buffer, ms, failAfterMs } });
    return () => { Atomics.store(armed, 0, 0); w.terminate(); };
}

const text = (r) => `${r.error ?? ""}${r.stdout ?? ""}`;
const vars = (r) => (r.bench?.vars ?? []).map((v) => v.name);

// --- the stop's writer: it re-arms through a wipe, stops once the script is live, and disarms on done() ---

test("stopAfter re-arms through a wipe, stops at `started`, and stops writing once done()", async () => {
    Atomics.store(flag, 0, 0);
    const done = stopAfter(5, { failAfterMs: 10_000 });
    try {
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(Atomics.load(flag, 0), 2, "the stop landed");
        Atomics.store(flag, 0, 0); // stand in for `run()`'s clearInterrupt wiping a stop that arrived too early
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(Atomics.load(flag, 0), 2, "the re-arm wrote it again after the wipe");
        Atomics.store(scriptStarted, 0, 1); // `cell` saw the worker's `started`: the user's script is live
        await new Promise((r) => setTimeout(r, 30)); // past a tick: the writer writes once more and stops
        Atomics.store(flag, 0, 0); // stand in for run()'s END wipe (its finally), after which nothing may write
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(Atomics.load(flag, 0), 0, "no write after the end wipe: the writer stopped at `started`");
    } finally {
        done();
    }
    Atomics.store(flag, 0, 0);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(Atomics.load(flag, 0), 0, "done() disarmed the writer");
});

// --- a stop ends the script, and the kept variables survive ---

test("a stop written while a Python loop runs ends it with KeyboardInterrupt, and the bench's variables are kept", { skip, timeout: 180000 }, async () => {
    assert.match(text(await cell("kept_before = 41\nprint('SET')")), /SET/, "positive control: the bench runs");
    const done = stopAfter(300, { failAfterMs: 15_000 });
    let r, t0;
    try {
        t0 = Date.now();
        r = await cell("while True:\n    pass");
    } finally {
        done(); // the next cell must not inherit a re-armed stop
    }
    assert.match(text(r), /KeyboardInterrupt/, JSON.stringify(r).slice(0, 400));
    assert.ok(Date.now() - t0 < 10000, "the loop ended on the stop, not on anything slower");
    assert.ok(vars(r).includes("kept_before"), `the kept namespace is listed: ${vars(r)}`);
    assert.match(text(await cell("print(kept_before + 1)")), /42/, "and the next script reads it");
    assert.equal(Atomics.load(flag, 0), 0, "the buffer is clear once the run ends");
});

// --- clear before run: a stop that did not land does not interrupt the next script ---

test("a stop left pending between scripts does not interrupt the next one, which runs to its end", { skip, timeout: 180000 }, async () => {
    // Where a stop lands after the script's last bytecode (a C call that returned as the run ended): nothing read it.
    Atomics.store(flag, 0, 2);
    const r = await cell("total = sum(range(1000))\nprint('RAN-TO-END', total)");
    assert.match(text(r), /RAN-TO-END 499500/, JSON.stringify(r).slice(0, 400));
    assert.doesNotMatch(text(r), /KeyboardInterrupt/);
});

test("a stop written while a C call runs ends that script, never the next one", { skip, timeout: 180000 }, async () => {
    // `sum(range(…))` is one C call: the stop waits for it to return, and fires at the next bytecode, in this script.
    // The watchdog is longer than the loop's: a loaded WASM `sum` of 60M is allowed to take its time.
    const done = stopAfter(100, { failAfterMs: 60_000 });
    let r;
    try {
        r = await cell("big = sum(range(60_000_000))\nprint('AFTER-C')");
    } finally {
        done(); // the next cell must not inherit a re-armed stop
    }
    assert.doesNotMatch(text(r), /AFTER-C/, `positive control: the stop fired in this script: ${text(r).slice(0, 300)}`);
    assert.match(text(r), /KeyboardInterrupt/);
    const next = await cell("print('NEXT-RAN')");
    assert.match(text(next), /NEXT-RAN/, JSON.stringify(next).slice(0, 400));
    assert.doesNotMatch(text(next), /KeyboardInterrupt/);
});

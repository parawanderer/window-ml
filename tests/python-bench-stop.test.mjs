// python-bench-stop.test.mjs — a bench Stop in the real core: the interrupt buffer ends a script, and a stop that did not land never reaches the next one.
//
// The real python-worker.ts under a fake `self` (name "readonly") and the real Pyodide in Node (`dist/pyodide/`,
// self-SKIPS without it), as python-worker-bridges.test.mjs runs it. The buffer is posted first, as the offscreen
// document posts it (offscreen.ts `ensureWorker`), and the stop is written from a SECOND THREAD, since a running script
// holds this one: that is where the offscreen document stands to the worker. Which run a stop may reach, and the kill
// when it is not answered, are the offscreen document's (python-bench-stop-offscreen.test.mjs). Its own file because
// `lockdown()` is once per realm.
//
// WHEN the stop may be written is the whole game (see `stopOnBeacon`). `run()`'s start wipe (`clearInterrupt`, after
// boot, before the script) erases a stop that arrived too early — that took a one-shot writer's only write on
// 2026-11-09 and `while True` held the machine-wide slot for 37 minutes (test-slot 20261109T094442-4a6b50), a WASM
// loop blocking this thread so nothing here could time out. Its END wipe (the `finally`) makes a LATE write poison:
// it lands in the run's own `cancel` cleanup and fails the file on an unhandled KeyboardInterrupt — janitor-3 measured
// a re-arming writer still doing that 1 run in 14 (2026-11-09). One write BETWEEN the two wipes is the only safe
// shape: the script prints a beacon as its blocking section begins, the hook below sees the streamed chunk at print
// time, and the writer thread writes once and stops.
import { test, before, after } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

const DIST = path.resolve(import.meta.dirname, "../dist");
const hasPyodide = fs.existsSync(path.join(DIST, "pyodide", "pyodide.mjs"));
const skip = hasPyodide ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";

/** The mark a script prints as its blocking section begins: the moment a stop may safely be written. */
const BEACON = "WML-STOP-BEACON";

let shim = null;
const posted = [];
let handler = null;
let nextId = 1;
const flag = new Int32Array(new SharedArrayBuffer(4));
// Set by the `postMessage` hook when a streamed chunk carries `BEACON` — synchronously, at print time, on this
// thread. The writer thread polls it; `cell`'s own poll cannot, a WASM loop freezes it for the whole script.
const beaconFlag = new Int32Array(new SharedArrayBuffer(4));

/**
 * The writer thread's source — `stopOnBeacon` runs it, and the backstop row runs the SAME string under a
 * `spawnSync` child, so the kill it asserts is the kill the rows rely on.
 */
const WRITER_SRC = `
    const { workerData } = require('node:worker_threads');
    const a = new Int32Array(workerData.sab);
    const beacon = new Int32Array(workerData.beacon);
    const poll = setInterval(() => {
        if (Atomics.load(beacon, 0)) {              // the script's beacon printed: its blocking section is running
            Atomics.store(a, 0, 2);                 // the ONE write — after the start wipe, before the end wipe
            clearInterval(poll);
        }
    }, 5);
    setTimeout(() => {
        clearInterval(poll);
        if (!Atomics.load(beacon, 0)) {
            console.error('python-bench-stop: the script never reached its beacon within ' + workerData.failAfterMs + 'ms');
        } else if (Atomics.load(a, 0) === 2) {
            console.error('python-bench-stop: the stop never ended the script within ' + workerData.failAfterMs + 'ms');
        } else return;                              // the stop landed and the run ended (the end wipe read 0)
        process.kill(process.pid, 'SIGKILL');       // process.exit() on a worker thread ends only the THREAD —
    }, workerData.failAfterMs);                     // measured 2026-11-09: a blocked main thread outlives it and
                                                    // the process exits 0. SIGKILL takes the process down loud.
`;

before(async () => {
    if (!hasPyodide) return;
    // Pyodide in Node wants a filesystem path where the worker hands it a URL (python-worker-bridges.test.mjs).
    shim = fs.mkdtempSync(path.join(os.tmpdir(), "wml-stop-"));
    fs.mkdirSync(path.join(shim, "pyodide"));
    fs.writeFileSync(path.join(shim, "pyodide", "pyodide.mjs"),
        `import { loadPyodide as real } from ${JSON.stringify(pathToFileURL(path.join(DIST, "pyodide", "pyodide.mjs")).href)};\n` +
        `export const loadPyodide = (o) => real({ ...o, indexURL: ${JSON.stringify(path.join(DIST, "pyodide") + "/")}, packageBaseUrl: ${JSON.stringify(path.join(DIST, "pyodide") + "/")} });\n`);
    globalThis.self = Object.assign(Object.create(globalThis), {
        name: "readonly",
        location: { href: pathToFileURL(shim + "/").href },
        postMessage: (m) => {
            posted.push(m);
            if (m.partial && typeof m.chunk === "string" && m.chunk.includes(BEACON)) Atomics.store(beaconFlag, 0, 1);
        },
        addEventListener: (type, fn) => { if (type === "message") handler = fn; },
    });
    await import("../src/python/python-worker.ts");
    handler({ data: { interruptBuffer: flag } });
}, { timeout: 180000 });

after(() => { if (shim) fs.rmSync(shim, { recursive: true, force: true }); });

/** Post one bench script the way the offscreen document does and wait for the worker's answer to it. */
async function cell(code) {
    const id = nextId++;
    handler({ data: { id, code, image: null, hardened: true, tables: null, persist: true, stream: true } });
    for (let i = 0; i < 6000; i++) {
        const done = posted.find((m) => m.id === id && !m.partial && !m.started && !m.booted && !m.spending);
        if (done) return done;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("no answer for cell " + id);
}

/**
 * Arm a stop that is written ONCE, from another thread, when the script prints `BEACON` — while this thread runs
 * Python, where the offscreen document stands to the worker. Exactly one write is the whole point: `run()`'s start
 * wipe erases anything earlier (a re-armed stream only survives it by writing into the END wipe's window too), and
 * anything after the end wipe lands in the run's own `cancel` and fails the file. The beacon is printed inside the
 * script, after the start wipe; the write lands within a 5 ms tick, while the script's blocking section holds
 * (an infinite loop, or a C call far longer than the tick), so it cannot be after the end wipe either.
 *
 * The same thread WATCHES: if the script never reached its beacon, or the stop never ended it, `failAfterMs` later
 * it `SIGKILL`s the PROCESS. The product's own bound is `BENCH_STOP_KILL_MS` in offscreen.ts — this test drives the
 * worker's handler directly and so does not get that kill — and `process.exit(1)` on a worker thread is inert
 * (janitor-3's measurement, 2026-11-09).
 */
function stopOnBeacon({ failAfterMs = 15_000 } = {}) {
    Atomics.store(beaconFlag, 0, 0);
    const w = new Worker(WRITER_SRC,
        { eval: true, workerData: { sab: flag.buffer, beacon: beaconFlag.buffer, failAfterMs } });
    return () => w.terminate();
}

const text = (r) => `${r.error ?? ""}${r.stdout ?? ""}`;
const vars = (r) => (r.bench?.vars ?? []).map((v) => v.name);

// --- the stop's writer: one write at the beacon, none after the end wipe ---

test("the writer writes nothing before the beacon, the stop once at it, and nothing after the end wipe", async () => {
    Atomics.store(flag, 0, 0);
    const done = stopOnBeacon({ failAfterMs: 10_000 });
    try {
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(Atomics.load(flag, 0), 0, "no write before the beacon: a stop may not land while boot or setup runs");
        Atomics.store(beaconFlag, 0, 1); // the hook saw the script's beacon print: its blocking section is running
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(Atomics.load(flag, 0), 2, "the stop landed after the beacon");
        Atomics.store(flag, 0, 0); // stand in for run()'s END wipe (its finally), after which nothing may write
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(Atomics.load(flag, 0), 0, "no write after the end wipe: the writer wrote exactly once");
    } finally {
        done();
    }
    Atomics.store(flag, 0, 0);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(Atomics.load(flag, 0), 0, "done() stopped the writer");
});

// --- the backstop: a script the stop never ends fails loud, killing the process ---

test("the writer's backstop SIGKILLs the whole process, so a blocked main thread cannot outlive it", () => {
    // The child's main thread blocks forever, like `while True` in WASM; only the writer thread can fail it. A
    // backstop that `process.exit(1)`d (worker thread only) left the process to exit 0 whenever the block lifted
    // (janitor-3, 2026-11-09) — the child then dies on the spawn's own timeout with SIGTERM, and this row reds.
    const t0 = Date.now();
    const r = spawnSync(process.execPath, ["-e", `
        const { Worker } = require('node:worker_threads');
        new Worker(${JSON.stringify(WRITER_SRC)}, {
            eval: true,
            workerData: { sab: new SharedArrayBuffer(4), beacon: new SharedArrayBuffer(4), failAfterMs: 200 },
        });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    `], { timeout: 10_000 });
    assert.equal(r.signal, "SIGKILL", `the backstop killed the process itself: signal ${r.signal}, status ${r.status}`);
    assert.ok(Date.now() - t0 < 5000, "killed at the backstop's deadline, not by the spawn's own timeout");
});

// --- a stop ends the script, and the kept variables survive ---

test("a stop written while a Python loop runs ends it with KeyboardInterrupt, and the bench's variables are kept", { skip, timeout: 180000 }, async () => {
    assert.match(text(await cell("kept_before = 41\nprint('SET')")), /SET/, "positive control: the bench runs");
    const done = stopOnBeacon({ failAfterMs: 15_000 });
    let r, t0;
    try {
        t0 = Date.now();
        r = await cell(`print('${BEACON}')\nwhile True:\n    pass`);
    } finally {
        done(); // the writer is spent (one write), and its backstop must not outlive the row
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
    // `sum(range(…))` is one C call, far longer than the writer's 5 ms tick: the stop lands inside it, waits for it
    // to return, and fires at the next bytecode, in this script. The watchdog is longer than the loop's: a loaded
    // WASM `sum` of 60M is allowed to take its time.
    const done = stopOnBeacon({ failAfterMs: 60_000 });
    let r;
    try {
        r = await cell(`print('${BEACON}')\nbig = sum(range(60_000_000))\nprint('AFTER-C')`);
    } finally {
        done(); // the writer is spent (one write), and its backstop must not outlive the row
    }
    assert.doesNotMatch(text(r), /AFTER-C/, `positive control: the stop fired in this script: ${text(r).slice(0, 300)}`);
    assert.match(text(r), /KeyboardInterrupt/);
    const next = await cell("print('NEXT-RAN')");
    assert.match(text(next), /NEXT-RAN/, JSON.stringify(next).slice(0, 400));
    assert.doesNotMatch(text(next), /KeyboardInterrupt/);
});

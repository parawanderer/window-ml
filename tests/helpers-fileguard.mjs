// helpers-fileguard.mjs — a SIGKILL backstop for one test file's own process, armed before anything that can block its thread.
//
// A test's `timeout` and every `setTimeout` are timers on THIS thread: a `before()` that boots real Pyodide can
// block it inside WASM, and then none of them fire. That is how `tests/python-bench-stop.test.mjs` held the
// machine-wide slot for 37 minutes (2026-11-09) and again for 41 on 2026-11-14 — the per-test writer covers a
// running cell, and nothing covered the boot or the first `cell()` before the writer is armed. The runner's own
// 45-minute watchdog (watch-runner.mjs) eventually kills the whole suite run, which is a failure but not a
// diagnosis: every file queued behind the hung one is reported "interrupted" and nothing says which row hung.
//
// A Worker thread is the one thing in the process that survives a blocked main thread and can still act: its
// `Atomics.wait` + `Date.now()` deadline is not starved (python-bench-stop's header, 2026-11-12), and
// `process.kill(process.pid, "SIGKILL")` takes THIS FILE's process down loud — `node --test` runs each file in
// its own child, so the rest of the suite is untouched. `process.exit()` on a worker thread ends only the
// thread (measured 2026-11-09); SIGKILL is what a blocked main thread cannot outlive.
import { Worker } from "node:worker_threads";

/** The watcher's source — a Worker thread, so a WASM spin on the main thread cannot starve its clock.
 *  `import()` not `require()`: the Worker eval inherits the creator's module type, and a `--input-type=module`
 *  eval parent makes the eval ESM where `require` is a ReferenceError (measured 2026-11-14). `import()` works
 *  in both. */
const WATCH_SRC = `
    import('node:worker_threads').then(({ workerData }) => {
        const done = new Int32Array(workerData.done);
        const deadline = Date.now() + workerData.budgetMs;
        while (Date.now() < deadline && Atomics.load(done, 0) === 0) {
            Atomics.wait(done, 0, 0, 50);
        }
        if (Atomics.load(done, 0) === 0) {
            console.error(workerData.label + ': the file did not finish within ' + Math.round(workerData.budgetMs / 1000) + 's: SIGKILL');
            process.kill(process.pid, 'SIGKILL');
        }
    });
`;

/**
 * The default budget: 15 minutes. A file whose rows each carry a `timeout` cannot legitimately take longer
 * than `before()`'s 180 s plus one 180 s per row (python-bench-stop's arithmetic: 180 + 10 + 10 + 180 + 180
 * + 180 = 740 s ≈ 12 min; it measures 7 s healthy). Anything past that is a hang, not a slow pass — the rows
 * themselves would have failed on their own timeouts first.
 */
export const FILE_GUARD_MS = 15 * 60_000;

/**
 * Arm a SIGKILL backstop for this file's process and return the `disarm` to call from `after()`.
 *
 * Arm it at MODULE LOAD, before `before()`: the point is to cover the boot. `after()` runs even when the file
 * self-skips, so a skipped file disarms as a healthy one does. A budget the file cannot reach while healthy is
 * the rule — this is a hang detector, not a slow-test runner.
 *
 * @param {{ budgetMs?: number, label?: string }} [o] how long the file gets, and what the SIGKILL line names
 * @returns {() => void} disarm: call from `after()`, once, when the file is finished
 */
export function armFileGuard({ budgetMs = FILE_GUARD_MS, label = "file-guard" } = {}) {
    const done = new Int32Array(new SharedArrayBuffer(4));
    const worker = new Worker(WATCH_SRC,
        { eval: true, workerData: { done: done.buffer, budgetMs, label } });
    return () => {
        Atomics.store(done, 0, 1);
        worker.terminate();
    };
}

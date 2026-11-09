// watch-runner.mjs — the second opinion on a spawned runner's `exit`: turn a lost child-exit or a live-but-stuck
// runner into a loud failure, instead of waiting forever on the machine-wide test slot.
//
// Why: on 2026-11-09 `scripts/test.mjs` (test-slot 20261109T094442-4a6b50, pid 29182) sat 38 minutes at 0% CPU
// holding 8 workers. Its `node --import tsx --test` child was gone and the bare `.on("exit")` never fired, so the
// only child left was tsx's idle esbuild service. Nothing failed; the slot was held until someone cancelled it.

import { alive } from "../tests/e2e/bench/memory-budget.mjs";

/** How often the runner's liveness is sampled while its `exit` has not fired. */
export const POLL_MS = 15_000;
/** Wall clock after which a still-alive runner is killed and the wait fails: a backstop, not a budget. */
export const CAP_MS = 45 * 60_000;

/**
 * Watch a spawned runner until its `exit` event, with two failure paths a bare handler does not have: the process
 * is GONE and `exit` never fired (the lost-child-exit hang), or the wall clock passes `capMs` with it still alive
 * (a stuck test, a deadlocked worker). Both reject with a diagnostic — neither passes, retries, or extends.
 *
 * @param {import("node:child_process").ChildProcess} child the runner `spawn` just returned
 * @param {{ pollMs?: number, capMs?: number, log?: (s: string) => void, alive?: (pid: number) => boolean, kill?: (pid: number, sig: NodeJS.Signals) => void }} [o]
 * @returns {Promise<number>} the exit code (`exit` fired; a signal death resolves to 1, as `test.mjs` has always done)
 */
export function watchRunner(child, {
    pollMs = POLL_MS,
    capMs = CAP_MS,
    log = (s) => console.error(s),
    alive: isAlive = alive,
    kill = (pid, sig) => { try { process.kill(pid, sig); } catch { /* gone */ } },
} = {}) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let waitedMs = 0;
        let tick, cap; // assigned below; a same-tick `error` may settle before either exists
        const stop = () => { clearInterval(tick); clearTimeout(cap); };
        /** One settlement for all four paths: a late `exit` after the watchdog fired must not also resolve. */
        const settle = (fn, v) => { if (settled) return; settled = true; stop(); fn(v); };

        child.on("error", (e) => settle(reject, e));
        child.on("exit", (c) => settle(resolve, c ?? 1));

        tick = setInterval(() => {
            waitedMs += pollMs;
            if (child.pid == null) return; // spawn failed; its `error` settles
            if (isAlive(child.pid)) return;
            settle(reject, new Error(
                `watchdog: the runner (pid ${child.pid}) is gone and its exit never fired after ${Math.round(waitedMs / 1000)}s: `
                + "the lost-child-exit hang. Failing here rather than waiting forever on the slot.",
            ));
        }, pollMs);
        cap = setTimeout(() => {
            if (child.pid != null) {
                log(`watchdog: the runner (pid ${child.pid}) is still alive after ${Math.round(capMs / 60000)} min: sending SIGTERM`);
                kill(child.pid, "SIGTERM");
            }
            settle(reject, new Error(
                `watchdog: the runner (pid ${child.pid ?? "?"}) exceeded ${Math.round(capMs / 60000)} min (cap): `
                + "a stuck run, not a slow one. Failing here rather than holding the slot.",
            ));
        }, capMs);
        if (settled) stop(); // a same-tick `error`/`exit` settled before the timers were assigned
        // The timers are REFERENCED on purpose: a lost `exit` also drops the child's handle, and an unref'd
        // watchdog would let the waiter exit 0 in the one case it exists for. They are cleared when anything settles.
    });
}

// hang-watchdog.mjs — how long a survey in a worker may run before a test calls it hung, derived from its step budget rather than a fixed wall-clock.

/**
 * The halting watchdog, in milliseconds, for a survey of `stepBudget` steps.
 *
 * The step budget is what bounds the work (`src/readonly-exec/limits.ts`): measured at about 3.2 million steps a
 * second on an M-series laptop, so a 3M-step survey is about a second by design and a 200k-step one about 60 ms.
 * A fixed 5 s wall-clock was a stand-in for "the survey ended under its budget", and it was load-dependent: the
 * ADVERSARIAL case that passes `stepBudget = 3_000_000` has only 5x headroom over its designed second, and under
 * the load of a full `npm test` with other sessions on the machine the worker is slower than the measured rate and
 * the watchdog fired while the survey was still upholding the invariant (readonly-pipe:146, 2026-10-19). What the
 * guard MEANS is "the evaluator halted; a host call did not run away". So it is sized from the budget's designed
 * cost times a hang-detector headroom — it fires when the survey has cost far more than its steps say it should,
 * not when the machine is merely busy. The 5s floor keeps the usual 200k-step case on the bound it already had.
 */
export function watchdogMs(stepBudget) {
    return Math.max(5_000, (stepBudget / 3_200_000) * 1000 * 25);
}

/** Assert the survey did not hit the watchdog. The message names the budget, not a wall-clock. */
export function assertNotHung(r, why, stepBudget) {
    if (r.hung) {
        const designed = stepBudget == null ? "?" : (stepBudget / 3_200_000).toFixed(2);
        throw new Error(`${why}: the halting watchdog fired; the survey did not return under its ${stepBudget} step budget (designed ~${designed}s at the measured rate). That is a hang, not a slow machine.`);
    }
}

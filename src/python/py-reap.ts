// py-reap.ts — when the offscreen document shuts an idle Python worker (the idle reap), and the keep that exempts one.

// Every principal's worker used to live as long as the offscreen document, which is never closed: each worker-hosted
// run that ran Python kept a whole Pyodide realm for the browser's life. A worker is IDLE while no cell, prewarm or
// other message of its principal is running or queued; the clock starts when the last one answers and restarts with
// the next post. What the shut costs decides how long it waits:
//
// - a worker holding no namespace of a live turn (the turn settled and `PY_DELETE_RUN` emptied it, or a page's
//   stateless principal) loses only its warmth: shut after `REAP_SETTLED_MS`;
// - a worker holding a live turn's namespace loses the model's names: shut after `REAP_LIVE_MS`, the loss told on the
//   run's next cell like a kill's;
// - a KEEP exempts that second kind: the model asked (`python_exec` `keep: true`) to hold its namespace through long
//   gaps, a run that works overnight. It lasts until the turn ends (`PY_DELETE_RUN`), after which the worker is the
//   first kind again, or until the sandbox is killed (a timeout, a crash, a cancel), which the next cell is told as
//   loss. A keep never outlives its turn, so it never holds a realm for a run nobody is running.
//
// The bench's own surface (`own`) and the shared `full` worker are never reaped: the bench keeps a person's variables.

/** How long a worker that holds no live turn's namespace may sit idle before it is shut. */
export const REAP_SETTLED_MS = 5 * 60_000;
/** How long a worker that holds a live turn's namespace may sit idle before it is shut, its names lost. */
export const REAP_LIVE_MS = 30 * 60_000;

/**
 * How long a principal's idle worker waits before it is shut, or null when it is never shut for idleness.
 * @param principal whose worker: `run:<id>`, `page:<tabId>`, `own` or `full`
 * @param holdsRun whether the worker holds a namespace of a turn that has not ended
 * @param kept whether that turn asked to keep its worker
 * @returns the delay in ms, or null
 */
export function reapDelay(principal: string, holdsRun: boolean, kept: boolean): number | null {
    if (principal.startsWith("page:")) return REAP_SETTLED_MS;   // a page never holds a live turn's namespace: no flag moves it
    if (!principal.startsWith("run:")) return null;
    if (!holdsRun) return REAP_SETTLED_MS;
    return kept ? null : REAP_LIVE_MS;
}

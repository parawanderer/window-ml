// py-reap.ts — when the offscreen document shuts an idle Python worker (the idle reap), and the keep that exempts one.

// Every principal's worker used to live as long as the offscreen document, which is never closed: each worker-hosted
// run that ran Python kept a whole Pyodide realm for the browser's life. A worker is IDLE while no cell, prewarm or
// other message of its principal is running or queued; the clock starts when the last one answers and restarts with
// the next post. What the shut costs decides how long it waits:
//
// The namespace belongs to the RUN, which outlives its turns: it is dropped at session release and archive
// (`PY_DELETE_RUN`), and by this reap. At a turn's end (`PY_END_TURN`) the run's own worker keeps it.
//
// - a worker holding no namespace (a page's stateless principal, a run that defined nothing, or one whose namespace was
//   dropped) loses only its warmth: shut after `REAP_SETTLED_MS`;
// - a worker holding the namespace of a run whose turn is RUNNING loses the model's names: shut after `REAP_LIVE_MS`,
//   the loss told on the run's next cell like a kill's, and in the run's transcript;
// - a worker holding the namespace of a run BETWEEN turns (the person is reading, or away) is shut after the person's
//   `pythonIdleMinutes` (`DEFAULT_REAP_BETWEEN_MS`), told the same way;
// - a KEEP exempts the live-turn kind: the model asked (`python_exec` `keep: true`) to hold its namespace through long
//   gaps, a run that works overnight. A keep is bound to its TURN: it ends with it (`PY_END_TURN`), after which the
//   worker is the between-turns kind, or until the sandbox is killed (a timeout, a crash, a cancel), which the next cell
//   is told as loss. So a keep never holds a realm for a run nobody is running.
//
// The clock starts only when nothing of the principal is pending, so a running or detached cell is never reaped.
//
// The bench's own surface (`own`) and the shared `full` worker are never reaped: the bench keeps a person's variables.

/** How long a worker that holds no live turn's namespace may sit idle before it is shut. */
export const REAP_SETTLED_MS = 5 * 60_000;
/** How long a worker that holds a live turn's namespace may sit idle before it is shut, its names lost. */
export const REAP_LIVE_MS = 30 * 60_000;

/** How long a worker holding a namespace between turns may sit idle by default (the `pythonIdleMinutes` setting, 10). */
export const DEFAULT_REAP_BETWEEN_MS = 10 * 60_000;

/**
 * How long a principal's idle worker waits before it is shut, or null when it is never shut for idleness.
 * @param principal whose worker: `run:<id>`, `page:<tabId>`, `own` or `full`
 * @param holdsRun whether the worker holds a run's namespace
 * @param kept whether the run's live turn asked to keep its worker (meaningless once the turn ended)
 * @param betweenTurns whether the run's turn has ended
 * @param betweenMs the between-turns delay (the person's setting); 0 or less never reaps
 * @returns the delay in ms, or null
 */
export function reapDelay(principal: string, holdsRun: boolean, kept: boolean, betweenTurns = false, betweenMs = DEFAULT_REAP_BETWEEN_MS): number | null {
    if (principal.startsWith("page:")) return REAP_SETTLED_MS;   // a page never holds a live turn's namespace: no flag moves it
    if (!principal.startsWith("run:")) return null;
    if (!holdsRun) return REAP_SETTLED_MS;
    if (betweenTurns) return betweenMs > 0 ? betweenMs : null;   // a keep ended with its turn
    return kept ? null : REAP_LIVE_MS;
}

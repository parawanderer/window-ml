// py-lease.ts — how long a worker-hosted run's python_exec cell runs attached before it detaches into a task, how long a
// detached cell may run, and how long an interrupt is given before the sandbox is killed (docs/spec/ASYNC_CALLS.md, mode 1).

// Every number here is a PLACEHOLDER under the spec's rule 1: the lease's value is a bench question, so a bench cell sets
// it with the build define `__PY_LEASE_MS__`, as `__SH_LEASE_MS__` does the shell's. The 15 s default is the point where a
// cell used to be killed, so nothing changes for a cell that ends inside it. Pure: the offscreen document and the service
// worker both import it.

/** The lease a bench cell builds in (build.mjs `--define __PY_LEASE_MS__=…`); undefined when nothing defined it. */
declare const __PY_LEASE_MS__: number | undefined;

/** How long a worker-hosted run's cell runs attached, from the moment it starts, before it detaches into a task. A
 *  placeholder (rule 1); the bench varies it per cell through `__PY_LEASE_MS__`. */
export const PY_LEASE_MS = typeof __PY_LEASE_MS__ === "number" ? __PY_LEASE_MS__ : 15_000;   // state: fixed

/** The ceiling a bench cell builds in (build.mjs `--define __PY_DETACHED_MAX_MS__=…`); undefined when nothing defined it. */
declare const __PY_DETACHED_MAX_MS__: number | undefined;

/**
 * The longest a detached cell may run before the sandbox kills it. A placeholder under rule 1, but bounded by a
 * measurement: the service worker that waits on the cell's reply is killed with the reply still pending somewhere between
 * 345 s and 390 s after the cell was sent (Chrome 151, a SILENT cell; docs/spec/ASYNC_CALLS.md has the table), and a
 * reply after that reaches nobody. The ceiling is the last bound both runs survived, less 30 s, to the minute below. A
 * cell that PRINTS sends a message with every chunk and keeps the worker alive longer, so evidence from a printing cell
 * is no reason to raise it.
 */
export const PY_DETACHED_MAX_MS = typeof __PY_DETACHED_MAX_MS__ === "number" ? __PY_DETACHED_MAX_MS__ : 5 * 60_000;   // state: fixed

/** The longest a cell runs attached, whatever its `expect_ms`: half the detached ceiling, so a cell that detaches still has
 *  as long again to run as a task. A lease at the ceiling would never detach: the sandbox kills the cell when the lease ends. */
export const PY_LEASE_MAX_MS = Math.floor(PY_DETACHED_MAX_MS / 2);   // state: fixed

/** How long a cancelled or stopped cell is given to answer its interrupt (`KeyboardInterrupt`) before its sandbox is
 *  killed: a Python loop answers in about 3 ms, a call inside C not until it returns. A placeholder, as the bench's
 *  Stop bound is (offscreen.ts `BENCH_STOP_KILL_MS`). */
export const PY_INTERRUPT_KILL_MS = 1000;

/** The most output a detached cell keeps for `task tail`, in characters: the last of it, never all of it. A placeholder. */
export const PY_TAIL_RING_CHARS = 64 * 1024;

/**
 * Append a chunk to a bounded tail, keeping only its last `max` characters (cut at a line start when one is near).
 * @param ring the tail so far
 * @param chunk what was printed
 * @param max the bound
 */
export function ringAppend(ring: string, chunk: string, max = PY_TAIL_RING_CHARS): string {
    const s = ring + chunk;
    if (s.length <= max) return s;
    const cut = s.slice(s.length - max);
    const nl = cut.indexOf("\n");
    return nl >= 0 && nl < 200 ? cut.slice(nl + 1) : cut;
}

/** What the cell's sandbox says a cancel did: the interrupt landed and the names are kept, or the sandbox was killed
 *  and they are lost, or the cell had already ended. */
export type CellCancel = "interrupted" | "killed" | "ended";

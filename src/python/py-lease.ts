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
 * The CEILING on how long a detached cell may run before the sandbox kills it: 60 minutes. The person's cap
 * (`detachedTaskMaxMin`, DevTools Settings, 1..60) is what the worker sends with a leased cell, and the offscreen document
 * clamps it to this. The old 5 minute bound came from the service worker that waits on the cell's pending reply being
 * killed somewhere between 345 s and 390 s after the cell was sent (docs/spec/ASYNC_CALLS.md has the table); the result no
 * longer depends on that reply, since the offscreen document tells the cell's end by its own message (`PY_DONE`) and keeps
 * the result for a worker that was evicted meanwhile to fetch (`PY_RESULT`). A placeholder under rule 1.
 */
export const PY_DETACHED_MAX_MS = typeof __PY_DETACHED_MAX_MS__ === "number" ? __PY_DETACHED_MAX_MS__ : 60 * 60_000;   // state: fixed

/**
 * The cap a detached task runs under, in ms, from the worker's word: a finite number in (0, PY_DETACHED_MAX_MS], else the
 * ceiling. The offscreen document applies it to what a message carried.
 * @param v what the message (or the setting, in minutes times 60 000) said
 */
export function clampDetachedMs(v: unknown): number {
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), PY_DETACHED_MAX_MS) : PY_DETACHED_MAX_MS;
}

/** The longest a cell runs attached, whatever its `expect_ms`: 150 s. It was half the detached ceiling when that was 5
 *  minutes; the ceiling is now 60, and a lease that long would hold the call (and the service worker's pending reply) open
 *  for as long, so it stays where it was. Never past half the ceiling a bench build defines: a lease at the ceiling would
 *  never detach, the sandbox kills the cell when the ceiling ends. */
export const PY_LEASE_MAX_MS = Math.min(150_000, Math.floor(PY_DETACHED_MAX_MS / 2));   // state: fixed

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

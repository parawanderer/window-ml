// spend-queue.ts — the asyncio loop's JS queue, cut at the cancel's deadline so callbacks a cell queued cannot outlast its spend.

// Pyodide's loop (`pyodide.webloop`) gives every `call_soon`/`call_later` its own JS callback through
// `scheduleCallback`, in one FIFO, and with stack switching (JSPI) the Python behind each one is queued a second time
// (`callPyObjectMaybePromising` waits one `API.scheduleCallback` turn before it runs Python). The cancel's wakeup waits
// behind everything the cell queued, and a callback that is a builtin raises no line event, so the spend's trace
// deadline never sees it (PYTHON_CANCEL_GAPS.md pins 15 to 17). The lockdown puts this queue in both places: once the
// spend's deadline has passed, every entry queued before it is dropped in JS without entering Python. Entries queued
// after it run, and so does the cancel's own chain: its one-shot (`turn`), the wakeup that one-shot queues, and that
// wakeup's second turn. When the cancel returns (`done`) everything still queued is cut the same way: the cancel has
// cancelled every Handle by then, so a cut entry would only cost a trip into Python. What was cut still holds the cell's
// Python objects alive, so it is released in batches after the cancel (`sweep`), never on the spend's path.

/** A webloop callback: a once-callable PyProxy wrapper, destroyed after it runs or when it is swept. */
type Callback = ((...a: unknown[]) => unknown) & { destroy?: () => void };

/** A queued entry: a webloop callback, or the second turn of a Python call holding a reference to `ptr`. */
type Entry = { run: () => void; destroy?: () => void; ptr?: number; cb?: Callback };

/** The loop's queue under the lockdown, and the cancel's three calls into it. */
export type SpendQueue = {
    /** `webloop.scheduleCallback`'s replacement: queue `cb` after `ms` (0 = as soon as possible). */
    schedule(cb: Callback, ms?: number): void;
    /** `API.scheduleCallback`'s replacement: Pyodide's own turn before a Python call (`ptr` while one is starting). */
    hop(cb: () => void, ms?: number): void;
    /** Run `call` while the Python object `ptr` is being called: a turn it queues holds a reference to `ptr`. */
    calling<T>(ptr: number, call: () => T): T;
    /** The spend started: entries queued before `budgetS` seconds from now are cut once that time has passed. */
    mark(budgetS: number): void;
    /** Call `fn` (the cancel's one-shot, a PyProxy) after what is queued; what its call queues is never cut. */
    turn(fn: Callback): void;
    /** The cancel returned: cut everything still queued, and say how many entries the deadline cut (0 with no mark). */
    done(): number;
    /** Release what was cut, in batches off the spend's path; resolves when nothing is left. */
    sweep(): Promise<void>;
    /** How many cut entries are not released yet. */
    doomed(): number;
    /** Whether `fn` is a webloop callback the queue cut: it never runs, and the sweep destroys it. */
    isDoomed(fn: object): boolean;
};

/** How many cut entries one batch of the sweep releases before it yields. */
export const SWEEP_BATCH = 5000;

/**
 * Build the queue over Pyodide's own scheduler, captured at boot so no cell can reach it.
 * @param raw Pyodide's `scheduleCallback` (`py._api.scheduleCallback`)
 * @param decRef Pyodide's `_Py_DecRef`: releases the reference a cut second turn held
 * @param now the clock the deadline is read on, in ms
 * @returns the queue
 */
export function makeSpendQueue(raw: (cb: () => void, ms?: number) => void, decRef: (ptr: number) => void, now: () => number = () => performance.now()): SpendQueue {
    let seq = 0;
    let pending = new Map<number, Entry>();   // state: plumbing — queued and not yet run, by sequence (ascending)
    const doomed: Map<number, Entry>[] = [];   // state: plumbing — what each cut took, waiting for the sweep
    let doomedN = 0;                           // how many entries `doomed` holds
    // Each webloop callback's sequence while it is queued, written when it is queued (on the cell's time, not the
    // spend's), so the cut stays one swap and the gate's revoke can still tell a cut callback by `cutSeq`.
    const queuedAt = new WeakMap<object, number>();   // state: plumbing — keyed by the callback, gone when it runs
    let cutSeq = 0;               // every entry at or below this sequence was cut
    let deadline = 0;             // the running spend's deadline (ms on `now`); 0 when none is running
    let lateCut = -1;             // how many entries the running spend's deadline cut; -1 until it has
    let turning = 0;              // > 0 while the cancel's one-shot runs: the webloop callback it queues is the cancel's wakeup
    let waking = 0;               // > 0 while that wakeup runs: the second turn it queues is the wakeup's own
    let callingPtr = 0;           // the Python object a call is starting for, while it queues its second turn
    let sweeping: Promise<void> | null = null;

    // Move every queued entry to the sweep in one swap, whatever the flood; they never run.
    const cut = (): number => {
        const n = pending.size;
        if (n) { doomed.push(pending); doomedN += n; pending = new Map(); }
        cutSeq = seq;
        return n;
    };
    const cutIfLate = () => {
        if (deadline && lateCut < 0 && now() > deadline) lateCut = cut();
    };
    // An entry of the cancel's own chain goes straight to Pyodide's queue, where no cut reaches it. Each link is
    // recognised only by the one before it, never by anything the entry says about itself: a cell cannot queue one.
    const enqueue = (e: Entry, ms: number, kind: "schedule" | "hop") => {
        if (kind === "schedule" && turning) {
            raw(() => { waking++; try { e.run(); } finally { waking--; } }, ms);
            return;
        }
        if (kind === "hop" && waking) { raw(e.run, ms); return; }
        cutIfLate();   // the cut takes what was queued before the deadline, never this entry
        const s = ++seq;
        pending.set(s, e);
        if (e.cb) queuedAt.set(e.cb, s);
        raw(() => {
            cutIfLate();
            const it = pending.get(s);
            if (it === undefined) return;
            pending.delete(s);
            if (it.cb) queuedAt.delete(it.cb);
            it.run();
        }, ms);
    };

    return {
        schedule(cb, ms = 0) {
            enqueue({ run: cb, destroy: () => cb.destroy?.(), cb }, ms, "schedule");
        },
        hop(cb, ms = 0) {
            enqueue(callingPtr ? { run: cb, ptr: callingPtr } : { run: cb }, ms, "hop");
        },
        calling(ptr, call) {
            const outer = callingPtr;
            callingPtr = ptr;
            try { return call(); } finally { callingPtr = outer; }
        },
        mark(budgetS) {
            deadline = now() + budgetS * 1000;
            lateCut = -1;
        },
        turn(fn) {
            raw(() => {
                turning++;
                try { fn(); } finally { turning--; fn.destroy?.(); }
            }, 0);
        },
        done() {
            cutIfLate();
            const n = Math.max(lateCut, 0);
            deadline = 0;
            lateCut = -1;
            cut();
            return n;
        },
        sweep() {
            sweeping ??= new Promise<void>((resolve) => {
                const batch = () => {
                    let left = SWEEP_BATCH;
                    while (left > 0 && doomed.length) {
                        const m = doomed[0];
                        for (const [s, e] of m) {
                            if (left-- <= 0) break;
                            m.delete(s);
                            doomedN--;
                            try { if (e.ptr) decRef(e.ptr); else e.destroy?.(); } catch { /* released already */ }
                        }
                        if (!m.size) doomed.shift();
                    }
                    if (doomed.length) { raw(batch, 0); return; }
                    sweeping = null;
                    resolve();
                };
                raw(batch, 0);
            });
            return sweeping;
        },
        doomed: () => doomedN,
        isDoomed: (fn) => { const s = queuedAt.get(fn); return s !== undefined && s <= cutSeq; },
    };
}

let current: SpendQueue | null = null;   // state: plumbing — the realm's queue; one interpreter per realm (per-principal workers)

/**
 * Put the spend queue in both of Pyodide's scheduling places, once per realm. Called by the lockdown at boot, before
 * the cell gate (which wraps the same call entry points, outside this) and before any cell: the scheduler it wraps is
 * captured here, and nothing a cell can reach holds it after (`webloop` bound it at import, and the lockdown seals
 * `pyodide_js`).
 * @param py the booted Pyodide interpreter
 * @returns the queue
 */
export function installSpendQueue(py: any): SpendQueue {
    if (current) return current;
    const api = py._api;
    const M = py._module;
    const raw = api?.scheduleCallback;
    if (typeof raw !== "function" || typeof M?.callPyObjectMaybePromising !== "function" || typeof M?._Py_DecRef !== "function") {
        throw new Error("spend queue: this Pyodide lacks _api.scheduleCallback, callPyObjectMaybePromising or _Py_DecRef");
    }
    const q = makeSpendQueue(raw, (ptr) => M._Py_DecRef(ptr));
    py.globals.set("_ml_spend_schedule", q.schedule);
    py.runPython("import pyodide.webloop as _ml_w\n_ml_w.scheduleCallback = globals().pop('_ml_spend_schedule')\ndel _ml_w");
    api.scheduleCallback = q.hop;
    const call = M.callPyObjectMaybePromising;
    M.callPyObjectMaybePromising = function (this: unknown, ptr: number, args: unknown[]) { return q.calling(ptr, () => call.call(this, ptr, args)); };
    current = q;
    return q;
}

/**
 * Release what the last spend cut; a no-op without the queue. The worker awaits it before the next cell runs: until it
 * is done, what was cut keeps the cell's contexts where `gc.get_objects()` finds them.
 * @returns whether there was anything to release, once it is released
 */
export async function spendSweep(): Promise<boolean> {
    if (!current?.doomed()) return false;
    await current.sweep();
    return true;
}

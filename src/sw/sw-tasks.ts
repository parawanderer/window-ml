// sw-tasks.ts — a run's detached calls (docs/spec/ASYNC_CALLS.md, mode 1): the one table every executor adds to, the
// return of a finished call through the run inbox, the `task` tool's actions, and `ml.current.tasks`.

// A call that outruns its lease is registered here by its executor (`ml.sh` today: sw-shell-call.ts) with what only the
// executor can do (cancel it, read its tail) and a promise of how it ends. The table is the run's alone: every read and
// every action is keyed by the run id the worker knows, never by anything a script or the model said, so another run's
// id and an id that never existed read the same. A turn's end leaves its tasks running (`closeTurnTasks`, rule 4b): `endTasks` cancels what still runs at session release and archive.
//
// The table is also kept in `chrome.storage.session`, one key per run (`ml_tasks:<runId>`), so a worker evicted between
// turns (about 65 s idle) loses neither a parked result nor the knowledge that a cell still runs: `hydrateTasks` rebuilds
// the table from it, and the executor's end, told by its own message (`PY_DONE`), settles the rebuilt row.

import { defineState } from "../state-registry";
import { DEFAULT_CONFIG } from "../contract/contract-config";
import { tableOf } from "../table/table-data";
import type { TableLike } from "../table/table-data";
import type { CurrentSnapshot } from "../agent/current-context";
import { onSessionRelease, runControllers, runInboxes } from "./sw-runs";
import { recordRunLog } from "./sw-run-log";
import { forModel } from "./sw-scrub";
import { storeText } from "./sw-values";
import { PY_DETACHED_MAX_MS } from "../python/py-lease";

/** Where a task is. A detached call is `running`; `detached` is how it got here, not a status. */
export type TaskStatus = "running" | "done" | "failed" | "cancelled" | "orphaned";

/** What a waiting await is answered with: an executor's outcome, or a page change's cancel the executor did not confirm. */
type AwaitAnswer = Omit<TaskOutcome, "status"> & { status: TaskOutcome["status"] | "orphaned" };

/** How a task ended, as its executor reports it: the text the model reads (scrubbed here) and the result's pointer. */
export interface TaskOutcome {
    status: "done" | "failed" | "cancelled";
    /** The result as the call would have returned it, already capped by the executor. */
    text: string;
    /** An `@tool:` pointer to the full result, when there is one. */
    result: string | null;
    /** The program's exit code, when the executor has one; null when it is not known (killed, failed to run). */
    code?: number | null;
    /** The fuller output `text` was cut from, unscrubbed: scrubbed and stored here, so the step that reads the result
     *  can mint the pointer to it (rule 6: the full capped output is a value the model can point at). */
    whole?: string;
    /** A figure the result drew (a data URL): it reaches the model with the result, as the call's own return would. */
    image?: string;
}

/** How a finished task is announced to the run's surfaces beside its text, so a short line never parses the text. */
export interface TaskEnd { status: TaskStatus; ms: number; code: number | null }

/** What only the executor can do for a task it registered. */
export interface TaskExecutor {
    /**
     * Where the call RUNS (ASYNC_CALLS.md rule 4a): true when it runs in the page the run is on (a detached `exec`, a DOM or
     * selector subscription), so a page change ends it; false when it runs on the runtime (`ml.sh`, `python_exec`, a fetch),
     * which a page change leaves running. Each executor kind declares it; absent reads as false.
     */
    pageBound?: boolean;
    /** Cancel the call; resolves to what happened, in words (a cancel's effect is a fact, never a promise). */
    cancel(): Promise<{ confirmed: boolean; text: string }>;
    /**
     * The output so far, or null when the executor cannot read it while the call runs (said so, never a fake ""). `asked`
     * is true for `task tail`, where the model chose the length; false for the tail nobody asked for (`ml.current.tasks`),
     * which stays small.
     */
    tail(lines: number, asked?: boolean): string | TailAnswer | null | Promise<string | TailAnswer | null>;
    /** The sentence the model reads where `tail` is null. */
    tailAbsent: string;
    /** Settles once the call ends, however it ends. */
    settled: Promise<TaskOutcome>;
}

/** A tail with the key of the stored whole it was cut from (the pointer the step mints reads all of it) and that whole's length in characters. */
export interface TailAnswer { text: string; value: string; chars: number }

/** What an executor says about a call it detaches. */
export interface TaskSpec {
    tool: string;
    startedMs: number;
    leaseMs: number;
    /** The model's own expectation, null when it gave none. */
    expectMs: number | null;
    /** What a rebuilt worker needs to find the call again: the cell's id for Python, nothing for the host's call. Absent
     *  for an executor that cannot be found again (its running row is orphaned when a worker restarts). */
    ref?: TaskRef;
    exec: TaskExecutor;
}

/** How a stored running row reaches its executor again. */
export type TaskRef = { kind: "py"; cell: string } | { kind: "sh" };

/** A task row as `chrome.storage.session` holds it, filed under `ml_tasks:<runId>`. `v` is the shape's version: a row of a
 *  version this code does not know is dropped (and logged), never read as the current shape. */
export interface StoredTask {
    v: 1; id: string; tool: string; startedMs: number; leaseMs: number; expectMs: number | null; status: TaskStatus;
    result: string | null; text: string | null; delivered: boolean; endedMs?: number; code: number | null;
    value?: string; chars?: number; image?: string; ref?: TaskRef;
}

interface Task extends Omit<TaskSpec, "exec"> {
    id: string;
    status: TaskStatus;
    result: string | null;
    text: string | null;
    /** The result reached the model (an await answered with it, or the inbox carried it). */
    delivered: boolean;
    /** When it ended and its exit code, for the surfaces' short line. */
    endedMs?: number;
    code: number | null;
    /** The stored whole of a cut result and its length, and the figure it drew: carried with its text to the model. */
    value?: string;
    chars?: number;
    image?: string;
    /** An await waiting on it now: answered instead of the inbox, by its end or by a page change's cancel (which can
     *  leave it orphaned). */
    waiter?: (o: AwaitAnswer) => void;
    /** Its end is being recorded (the scrub is async): a second end is ignored, and it still reads as running. */
    ending?: boolean;
    /** Set on a row rebuilt from storage whose executor ran in another document (a cell): the executor's end, told after the
     *  worker that started it was gone, settles it. */
    settle?: (o: TaskOutcome) => void;
    exec: TaskExecutor;
}

/** The longest `task await` may wait in one call: past it the await detaches again, as any leased call does. */
export const TASK_AWAIT_MAX_MS = 10 * 60_000;
/** The most tail lines one `task tail` returns. */
export const TASK_TAIL_MAX_LINES = 200;

const tasks = new Map<string, Map<string, Task>>();
/** A run's table being read back from storage, so two callers wait on one read. */
const hydrating = new Map<string, Promise<void>>();   // state: plumbing — one read per run, until it is done
/** Where a run's finished task is announced to its surfaces (the run host's fan), set while the run's turn is live. */
const sinks = new Map<string, (text: string, id: string, end: TaskEnd) => void>();   // state: plumbing — the run host's fan, for the live turn
defineState({
    id: "run.tasks", scope: "run", realm: "worker", audience: "model", lostOn: ["browser-restart"],
    exposedAs: "ml.current.tasks",
    describe: "The run's calls that outran their lease and were detached: each one's tool, status, how long it has run, and its result once it finished. Kept in session storage (`ml_tasks:<runId>`), so a worker eviction does not lose it; a browser restart does.",
    read: ({ runId }) => (runId && tasks.get(runId)?.size ? rowsOf(runId, Date.now()) : undefined),
});

/** Forget every run's table, sink and read in memory: what a worker eviction does (the eviction test hook). The stored copy stays. */
export function dropAllTaskMemory(): void { tasks.clear(); sinks.clear(); hydrating.clear(); }

/**
 * Open a run's task table for its turn: a finished task is announced through `fan` as well as the inbox. A task that ended
 * while no turn ran (parked) is queued into the turn's inbox now, in the order it ended, so the first step reads it.
 * Call after the turn's inbox exists.
 * @param runId the run
 * @param fan the run host's announcement to its surfaces
 */
export function openTasks(runId: string, fan: (text: string, id: string, end: TaskEnd) => void): void {
    sinks.set(runId, fan);
    const inbox = runInboxes.get(runId);
    if (!inbox) return;
    const parked = [...(tasks.get(runId)?.values() ?? [])].filter((t) => t.status !== "running" && !t.delivered && t.endedMs !== undefined && t.text !== null);
    parked.sort((a, b) => a.endedMs! - b.endedMs!);
    for (const t of parked) inbox.queue.push(inboxItem(t));
}

/**
 * The inbox item for an ended task: its text with the true time it ran, and what the result carries.
 * @param t the ended task
 */
function inboxItem(t: Task): { text: string; task: string; value?: string; chars?: number; images?: string[] } {
    return { text: `[task ${t.id} ${t.status} after ${secs(t.endedMs! - t.startedMs)}: ${t.text}]`, task: t.id, ...carried(t) };
}

/**
 * The turn is over: its sink and any await are dropped, and its tasks run on (rule 4b). A result that arrives now is
 * parked in the table, and the next turn's {@link openTasks} queues it.
 * @param runId the run
 */
export function closeTurnTasks(runId: string): void {
    sinks.delete(runId);
    for (const t of tasks.get(runId)?.values() ?? []) t.waiter = undefined;
}

/**
 * Register a detached call. Its outcome is collected here when it settles: an await waiting on it gets it, otherwise
 * the run inbox carries it to the next step boundary.
 * @param runId the run the call belongs to, as the worker knows it
 * @param spec what the executor says about the call
 * @returns the task's id
 */
export function detachTask(runId: string, spec: TaskSpec): string {
    const id = `t${crypto.randomUUID().replace(/-/g, "").slice(0, 6)}`;
    const t: Task = { ...spec, id, status: "running", result: null, text: null, delivered: false, code: null };
    let mine = tasks.get(runId);
    if (!mine) tasks.set(runId, (mine = new Map()));
    mine.set(id, t);
    watch(runId, t);
    persist(runId);
    return id;
}

/** Collect a running task's outcome when its executor settles. */
function watch(runId: string, t: Task): void {
    void t.exec.settled.then((o) => finish(runId, t, o), (e) => finish(runId, t, { status: "failed", text: `${t.tool} failed: ${(e as Error)?.message || String(e)}`, result: null }));
}

// --- the stored copy ---

const KEY = (runId: string): string => `ml_tasks:${runId}`;

/** A task as it is stored: plain data, never its executor, its waiter or its ending flag. */
function rowOf(t: Task): StoredTask {
    return {
        v: 1, id: t.id, tool: t.tool, startedMs: t.startedMs, leaseMs: t.leaseMs, expectMs: t.expectMs, status: t.status,
        result: t.result, text: t.text, delivered: t.delivered, ...(t.endedMs !== undefined ? { endedMs: t.endedMs } : {}), code: t.code,
        ...(t.value ? { value: t.value } : {}), ...(t.chars !== undefined ? { chars: t.chars } : {}), ...(t.image ? { image: t.image } : {}),
        ...(t.ref ? { ref: t.ref } : {}),
    };
}

/**
 * Write the run's table through to session storage, best effort: memory still holds it when the write fails (the quota,
 * an image too large), and the failure is a run-log record. A run with no tasks has no key. The rows are read now and the
 * writes land in the order they were made.
 * @param runId the run
 */
function persist(runId: string): void {
    const mine = tasks.get(runId);
    if (!mine) return;
    const rows = [...mine.values()].map(rowOf);
    const failed = (e: unknown) => recordRunLog(runId, { level: "warn", subsystem: "task", kind: "persist-failed", reason: "write", detail: { rows: rows.length, error: String((e as Error)?.message || e).slice(0, 120) } });
    try {
        if (rows.length) void Promise.resolve(chrome.storage.session.set({ [KEY(runId)]: rows })).catch(failed);
        else void Promise.resolve(chrome.storage.session.remove(KEY(runId))).catch(() => { /* nothing stored */ });
    } catch (e) { failed(e); }
}

/** What reads a stored running row of one kind back into an executor: its `exec`, and `settle`, the way the executor's end,
 *  told later, resolves `exec.settled`. Null when the row cannot be attached. Lives in the executor's own module, which
 *  imports this one (and is loaded through a cycle), so it is imported when a row needs it. */
export type TaskRehydrator = (runId: string, row: StoredTask) => { exec: TaskExecutor; settle: (o: TaskOutcome) => void } | null;

/** How long past a cell's ceiling a stored running row is still believed: its `PY_DONE` is in flight or its worker is
 *  starting. Past it the cell is gone and nobody is coming. */
const ORPHAN_GRACE_MS = 60_000;

/**
 * Make the run's table whole in this worker: when memory holds none (a worker started since the run's tasks were
 * detached), read it back from session storage. Rows of a version this code does not know are dropped and logged. A
 * running row is attached to its executor again where the executor can be found (a cell in the offscreen document, by its
 * id) and is `orphaned` where it cannot (a call whose connection to the host died with the worker, a cell past its
 * ceiling), told to the model at the next turn. An ended row comes back as it was: a parked result stays parked, a
 * delivered one stays delivered. Safe to call on every entry; a run with nothing stored gets an empty table.
 * @param runId the run
 */
export function hydrateTasks(runId: string): Promise<void> {
    if (tasks.has(runId)) return Promise.resolve();
    let p = hydrating.get(runId);
    if (!p) { p = readBack(runId).finally(() => { hydrating.delete(runId); }); hydrating.set(runId, p); }
    return p;
}

async function readBack(runId: string): Promise<void> {
    let stored: unknown;
    try { stored = (await chrome.storage.session.get(KEY(runId)))?.[KEY(runId)]; } catch { stored = undefined; }
    // A task detached while the read was in flight made the table: the stored rows join it.
    let mine = tasks.get(runId);
    if (!mine) tasks.set(runId, (mine = new Map()));
    if (!Array.isArray(stored)) return;
    let changed = false;
    const now = Date.now();
    // Imported only when a running cell is to be attached again: sw-python-task imports this module, and both are in the
    // worker's import cycle, so neither may call the other as it loads.
    const attachPy: TaskRehydrator | undefined = (stored as { status?: unknown; ref?: { kind?: unknown } }[]).some((r) => r?.status === "running" && r.ref?.kind === "py")
        ? await import("./sw-python-task").then((m) => m.rehydratePyTask, () => undefined) : undefined;
    for (const raw of stored as unknown[]) {
        const row = raw as Partial<StoredTask> | null;
        if (!row || typeof row !== "object" || row.v !== 1 || typeof row.id !== "string" || typeof row.tool !== "string") {
            recordRunLog(runId, { level: "warn", subsystem: "task", kind: "dropped", reason: "unknown-version", detail: { v: String((row as { v?: unknown } | null)?.v ?? "none").slice(0, 20) } });
            changed = true;
            continue;
        }
        if (mine.has(row.id)) continue;
        const r = row as StoredTask;
        const base = { id: r.id, tool: r.tool, startedMs: Number(r.startedMs) || now, leaseMs: Number(r.leaseMs) || 0, expectMs: r.expectMs ?? null, status: r.status, result: r.result ?? null, text: r.text ?? null,
            delivered: r.delivered === true, ...(r.endedMs !== undefined ? { endedMs: r.endedMs } : {}), code: r.code ?? null,
            ...(r.value ? { value: r.value } : {}), ...(r.chars !== undefined ? { chars: r.chars } : {}), ...(r.image ? { image: r.image } : {}), ...(r.ref ? { ref: r.ref } : {}) };
        if (r.status !== "running") {
            // Ended: as it was. Its executor has nothing left to do.
            mine.set(r.id, { ...base, exec: { cancel: async () => ({ confirmed: true, text: "it had already ended." }), tail: () => null, tailAbsent: "", settled: new Promise<TaskOutcome>(() => { /* ended: never settles */ }) } });
            continue;
        }
        changed = true;
        const orphan = (why: string, text: string) => {
            mine!.set(r.id, { ...base, status: "orphaned", endedMs: now, text, exec: { cancel: async () => ({ confirmed: true, text: "it had already ended." }), tail: () => null, tailAbsent: "", settled: new Promise<TaskOutcome>(() => { /* ended */ }) } });
            recordRunLog(runId, { level: "warn", subsystem: "task", kind: "orphaned", reason: why, ms: now - base.startedMs, detail: { id: r.id, tool: r.tool } });
        };
        if (r.ref?.kind === "sh") {
            orphan("worker-restart", "the service worker restarted and this call's connection to the host was lost, so its outcome is not known.");
            continue;
        }
        if (r.ref?.kind === "py" && now > base.startedMs + PY_DETACHED_MAX_MS + ORPHAN_GRACE_MS) {
            orphan("past-ceiling", "the service worker restarted, and this cell ran past the longest a detached cell may, so it is gone and its result was not kept.");
            continue;
        }
        const live = r.ref?.kind === "py" ? attachPy?.(runId, r) : null;
        if (!live) { orphan("worker-restart", "the service worker restarted and this task could not be attached again, so its outcome is not known."); continue; }
        const t: Task = { ...base, exec: live.exec, settle: live.settle };
        mine.set(r.id, t);
        watch(runId, t);
    }
    if (changed) persist(runId);
}

/**
 * The running task of the run that a stored cell reference names, for the executor's end to settle: present only for a row
 * rebuilt from storage whose cell has not reported yet.
 * @param runId the run
 * @param cell the cell's id
 * @returns a function that settles the task with the cell's outcome, or null when there is no such task
 */
export function rehydratedCellTask(runId: string, cell: string): ((o: TaskOutcome) => void) | null {
    for (const t of tasks.get(runId)?.values() ?? []) if (t.status === "running" && t.settle && t.ref?.kind === "py" && t.ref.cell === cell) return t.settle;
    return null;
}

/**
 * The cap, in ms, that a detached task runs under: the person's `detachedTaskMaxMin` (1..60 minutes; a value outside
 * reads as 60), read now. One knob for `ml.sh` and `python_exec`.
 */
export async function detachedCapMs(): Promise<number> {
    let v: unknown = DEFAULT_CONFIG.detachedTaskMaxMin;
    try { v = (await chrome.storage.sync.get({ detachedTaskMaxMin: DEFAULT_CONFIG.detachedTaskMaxMin }))?.detachedTaskMaxMin; } catch { /* the default */ }
    return capMinutes(v) * 60_000;
}

/**
 * The knob's value as minutes: a finite number from 1 to 60, rounded down, else the ceiling.
 * @param v what the setting holds
 */
export function capMinutes(v: unknown): number {
    const n = typeof v === "number" ? Math.floor(v) : NaN;
    return Number.isFinite(n) && n >= 1 && n <= 60 ? n : 60;
}

/**
 * A task ended: record it, then hand its result to whoever is waiting, or to the inbox. With no turn live it is
 * parked in the table and read at the next turn; one ended by `endTasks` (session release, archive) is dropped.
 */
async function finish(runId: string, t: Task, o: TaskOutcome): Promise<void> {
    if (t.status !== "running" || t.ending) return;
    t.ending = true;
    const endedMs = Date.now();
    const text = (await forModel(o.text)).text;
    // Only a whole longer than the text is kept: one the cap did not cut is already all there in the text.
    const whole = o.whole && o.whole.length > o.text.length ? (await forModel(o.whole)).text : undefined;
    const value = whole ? await storeText(whole, `task ${t.id}`).catch(() => undefined) : undefined;
    // Ended in the meantime (a cancel or the session's end): its status is that end's.
    if (t.status !== "running") return;
    // All at once, after the scrub: a read in between sees a running task, never an ended one with no text.
    t.status = o.status;
    t.result = o.result;
    t.endedMs = endedMs;
    t.code = o.code ?? null;
    t.text = text;
    if (value) { t.value = value; t.chars = whole!.length; }
    if (o.image) t.image = o.image;
    recordRunLog(runId, { ...(o.status === "done" ? {} : { level: "warn" as const }), subsystem: "task", kind: "ended", reason: o.status, ms: Date.now() - t.startedMs, detail: { id: t.id, tool: t.tool } });
    if (tasks.get(runId)?.get(t.id) !== t) return;
    if (t.waiter) { const w = t.waiter; t.waiter = undefined; t.delivered = true; persist(runId); w({ ...o, text: t.text }); return; }
    persist(runId);
    const inbox = runInboxes.get(runId);
    if (t.delivered) return;
    // No turn is live: the result stays in the table, undelivered, and the next turn's `openTasks` queues it.
    if (!inbox) { recordRunLog(runId, { subsystem: "task", kind: "parked", reason: o.status, ms: endedMs - t.startedMs, detail: { id: t.id, tool: t.tool } }); return; }
    // Queued only: it is delivered, and drawn, when the loop drains it (`taskDrained`). A turn that ends first leaves it
    // undelivered, and the next turn queues it again.
    inbox.queue.push(inboxItem(t));
}

/**
 * What a finished task's result carries beside its text: the key and length of its stored whole, and its figure.
 * @param t the task
 */
function carried(t: Task): { value?: string; chars?: number; images?: string[] } {
    return { ...(t.value ? { value: t.value, chars: t.chars } : {}), ...(t.image ? { images: [t.image] } : {}) };
}

/** An await's answer: the result's text, with its stored whole (the step mints the pointer) and its figure. */
export interface TaskAnswer { content: string; textValue?: string; textChars?: number; image?: string }

/**
 * An await's answer for a task that ended: its text alone, or with what the result carries beside it.
 * @param t the task
 * @param content the text the model reads
 */
function answered(t: Task, content: string): string | TaskAnswer {
    if (!t.value && !t.image) return content;
    return { content, ...(t.value ? { textValue: t.value, textChars: t.chars } : {}), ...(t.image ? { image: t.image } : {}) };
}

/**
 * The loop has drained a task's result from the inbox: the model reads it now. Only here is it delivered, recorded and
 * drawn on the run's surfaces, so the transcript and the exports carry exactly what reached the model.
 * @param runId the run
 * @param id the task
 * @param text the text the inbox carried
 * @returns false when the model already read it (an await answered between the queue and the drain): drop the item
 */
export function taskDrained(runId: string, id: string, text: string): boolean {
    const t = tasks.get(runId)?.get(id);
    if (!t || t.delivered) return false;
    t.delivered = true;
    persist(runId);
    sinks.get(runId)?.(text, id, { status: t.status, ms: (t.endedMs ?? Date.now()) - t.startedMs, code: t.code });
    recordRunLog(runId, { subsystem: "task", kind: "collected", reason: "inbox", detail: { id } });
    return true;
}

/**
 * End a run's tasks for good: each still running is cancelled by its executor, and one whose cancel is not confirmed is
 * reported as an orphan. The table is dropped, so a result that arrives later is dropped. Called at session release and
 * archive (a turn's end is {@link closeTurnTasks}).
 * @param runId the run
 * @param reason what ended them, for the run log: "session-release" (the default), "archived" or "deleted"
 */
export async function endTasks(runId: string, reason = "session-release"): Promise<void> {
    sinks.delete(runId);
    // A worker started since the tasks were detached holds none in memory: they are read back first, so a cell still running
    // is cancelled and not left to run to its ceiling with no run to take its result.
    if (!tasks.has(runId)) await hydrateTasks(runId);
    const mine = tasks.get(runId);
    tasks.delete(runId);
    try { void Promise.resolve(chrome.storage.session.remove(KEY(runId))).catch(() => { /* nothing stored */ }); } catch { /* no storage */ }
    if (!mine) return;
    await Promise.all([...mine.values()].filter((t) => t.status === "running").map(async (t) => {
        t.waiter = undefined;
        const c = await t.exec.cancel().catch((e) => ({ confirmed: false, text: (e as Error)?.message || String(e) }));
        t.status = c.confirmed ? "cancelled" : "orphaned";
        recordRunLog(runId, { level: "warn", subsystem: "task", kind: c.confirmed ? "cancelled" : "orphaned", reason, detail: { id: t.id, tool: t.tool } });
    }));
}
onSessionRelease((runId) => { void endTasks(runId); });

/**
 * The run's page changed (a same-tab navigation of a worker-hosted run): each page-bound task still running is cancelled
 * through its executor's cancel, and the model is told as a fact, through the inbox as a cancel's result is (or to an await
 * waiting on it). A runtime-bound task is not touched. The cancelled task's late result is dropped (`finish` ignores a task
 * that is not running), so nothing it started in the old page resolves against the new one.
 * @param runId the run whose page changed
 */
export async function cancelPageTasks(runId: string): Promise<void> {
    const mine = tasks.get(runId);
    if (!mine) return;
    await Promise.all([...mine.values()].filter((t) => t.status === "running" && t.exec.pageBound === true).map(async (t) => {
        const c = await t.exec.cancel().catch((e) => ({ confirmed: false, text: (e as Error)?.message || String(e) }));
        // Ended or cancelled while the cancel was in flight: that end's status stands.
        if (t.status !== "running") return;
        const text = c.confirmed ? "it ran in the page this run left" : "it ran in the page this run left, and its cancel was not confirmed";
        t.status = c.confirmed ? "cancelled" : "orphaned";
        t.endedMs = Date.now();
        t.text = text;
        recordRunLog(runId, { level: "warn", subsystem: "task", kind: c.confirmed ? "cancelled" : "orphaned", reason: "page-change", ms: t.endedMs - t.startedMs, detail: { id: t.id, tool: t.tool } });
        if (tasks.get(runId)?.get(t.id) !== t) return;
        if (t.waiter) { const w = t.waiter; t.waiter = undefined; t.delivered = true; persist(runId); w({ status: t.status, text, result: null }); return; }
        persist(runId);
        runInboxes.get(runId)?.queue.push({ text: `[task ${t.id} ${t.status}: ${text}]`, task: t.id });
    }));
}

/** Whole seconds, for the model's text. */
const secs = (ms: number): string => `${Math.round(ms / 1000)} s`;

/** The `task` tool's answer for an id this run does not hold: another run's and a made-up one read the same. */
const UNKNOWN = (id: string): string => `UnknownTask: this run has no task ${JSON.stringify(id)}.`;

/**
 * The `task` tool: await, cancel or tail one of this run's detached calls.
 * @param runId the run, from the loop (never from the arguments)
 * @param args the tool's arguments: `op`, `id`, and `timeout_ms` or `lines`
 * @returns what the model reads
 */
export async function taskAction(runId: string, args: Record<string, unknown>): Promise<string | TaskAnswer> {
    const id = typeof args.id === "string" ? args.id : "";
    await hydrateTasks(runId);
    const t = tasks.get(runId)?.get(id);
    if (!t) return UNKNOWN(id);
    const op = args.op;
    if (op === "tail") {
        const n = Math.max(1, Math.min(TASK_TAIL_MAX_LINES, Math.floor(Number(args.lines) || 20)));
        if (t.status !== "running") return `task ${t.id} ${t.status}: ${t.text ?? ""}`;
        const tail = await t.exec.tail(n, true);
        if (tail === null) return `task ${t.id} running for ${secs(Date.now() - t.startedMs)}. ${t.exec.tailAbsent}`;
        if (typeof tail === "string") return (await forModel(tail)).text;
        return { content: (await forModel(tail.text)).text, textValue: tail.value, textChars: tail.chars };
    }
    if (op === "cancel") {
        if (t.status !== "running") return `task ${t.id} already ${t.status}: ${t.text ?? ""}`;
        const c = await t.exec.cancel();
        return `task ${t.id}: ${c.text}`;
    }
    if (op === "await") {
        if (t.status !== "running") { t.delivered = true; persist(runId); return answered(t, `task ${t.id} ${t.status}: ${t.text ?? ""}`); }
        if (t.waiter) return `task ${t.id}: another await is already waiting on it.`;
        const given = Number(args.timeout_ms);
        const expect = Number.isFinite(given) && given > 0 ? Math.min(Math.floor(given), TASK_AWAIT_MAX_MS) : null;
        const wait = expect ?? t.leaseMs;
        const signal = runControllers.get(runId)?.signal;
        const o = await new Promise<AwaitAnswer | null>((resolve) => {
            const timer = setTimeout(() => { t.waiter = undefined; resolve(null); }, wait);
            const onAbort = () => { clearTimeout(timer); t.waiter = undefined; resolve(null); };
            signal?.addEventListener("abort", onAbort, { once: true });
            t.waiter = (x) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); resolve(x); };
        });
        if (o) return answered(t, `task ${t.id} ${o.status} after ${secs(Date.now() - t.startedMs)}: ${o.text}`);
        return `task ${t.id} is still running after ${secs(Date.now() - t.startedMs)}; ` + (expect !== null
            ? `you expected it within ${secs(expect)} more. Investigate the stall, or await, tail or cancel it.`
            : `no timeout_ms was given, so the ${secs(wait)} default applied. Estimate (timeout_ms) or investigate.`);
    }
    return `BadRequest: op is "await", "cancel" or "tail".`;
}

/** The columns of `ml.current.tasks`, in order. */
const COLUMNS = ["id", "kind", "tool", "status", "started", "elapsed_ms", "lease_ms", "expect_ms", "tail", "result"];

/**
 * This run's tasks as rows, at one instant.
 * @param runId the run
 * @param now the snapshot's instant
 * @param tails each running task's tail, already read (`withTasks`, one ask per task); absent, a running row's tail is
 *  null: the state inspector reads synchronously and never asks the host
 */
function rowsOf(runId: string, now: number, tails?: ReadonlyMap<string, string | null>): (string | number | null)[][] {
    return [...(tasks.get(runId)?.values() ?? [])].map((t) => [
        t.id, "call", t.tool, t.status, t.startedMs, now - t.startedMs, t.leaseMs, t.expectMs,
        t.status === "running" ? tails?.get(t.id) ?? null : null, t.result,
    ]);
}

/**
 * The snapshot with `tasks` added, on a copy: one row per detached call of THIS run, read at the snapshot's instant.
 * Absent when the run has none. A running task's tail is the small one (the tail nobody asked for: `tail(20)`, one ask of
 * the executor per running task per snapshot), scrubbed like any text the model reads.
 * @param current the snapshot as the host made it
 * @param runId the run
 */
export async function withTasks(current: CurrentSnapshot, runId: string): Promise<CurrentSnapshot> {
    await hydrateTasks(runId);
    if (!tasks.get(runId)?.size) return current;
    const now = Date.now();
    const tails = new Map<string, string | null>();
    // A tail that needs the host is asked for here; a failed ask leaves the cell null.
    await Promise.all([...(tasks.get(runId)?.values() ?? [])].filter((t) => t.status === "running").map(async (t) => {
        const x = await Promise.resolve().then(() => t.exec.tail(20)).catch(() => null);
        const text = typeof x === "string" ? x : x?.text ?? null;
        tails.set(t.id, text === null ? null : (await forModel(text)).text);
    }));
    return { ...current, tasks: tableOf(COLUMNS, rowsOf(runId, now, tails)) as TableLike };
}

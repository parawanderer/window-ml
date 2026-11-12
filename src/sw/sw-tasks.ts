// sw-tasks.ts — a run's detached calls (docs/spec/ASYNC_CALLS.md, mode 1): the one table every executor adds to, the
// return of a finished call through the run inbox, the `task` tool's actions, and `ml.current.tasks`.

// A call that outruns its lease is registered here by its executor (`ml.sh` today: sw-shell-call.ts) with what only the
// executor can do (cancel it, read its tail) and a promise of how it ends. The table is the run's alone: every read and
// every action is keyed by the run id the worker knows, never by anything a script or the model said, so another run's
// id and an id that never existed read the same. It holds nothing past the turn: `endTasks` cancels what still runs.

import { defineState } from "../state-registry";
import { tableOf } from "../table/table-data";
import type { TableLike } from "../table/table-data";
import type { CurrentSnapshot } from "../agent/current-context";
import { runControllers, runInboxes } from "./sw-runs";
import { recordRunLog } from "./sw-run-log";
import { forModel } from "./sw-scrub";

/** Where a task is. A detached call is `running`; `detached` is how it got here, not a status. */
export type TaskStatus = "running" | "done" | "failed" | "cancelled" | "orphaned";

/** How a task ended, as its executor reports it: the text the model reads (scrubbed here) and the result's pointer. */
export interface TaskOutcome {
    status: "done" | "failed" | "cancelled";
    /** The result as the call would have returned it, already capped by the executor. */
    text: string;
    /** An `@tool:` pointer to the full result, when there is one. */
    result: string | null;
    /** The program's exit code, when the executor has one; null when it is not known (killed, failed to run). */
    code?: number | null;
}

/** How a finished task is announced to the run's surfaces beside its text, so a short line never parses the text. */
export interface TaskEnd { status: TaskStatus; ms: number; code: number | null }

/** What only the executor can do for a task it registered. */
export interface TaskExecutor {
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
    exec: TaskExecutor;
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
    /** An await waiting on it now: answered instead of the inbox. */
    waiter?: (o: TaskOutcome) => void;
    /** Its end is being recorded (the scrub is async): a second end is ignored, and it still reads as running. */
    ending?: boolean;
    exec: TaskExecutor;
}

/** The longest `task await` may wait in one call: past it the await detaches again, as any leased call does. */
export const TASK_AWAIT_MAX_MS = 10 * 60_000;
/** The most tail lines one `task tail` returns. */
export const TASK_TAIL_MAX_LINES = 200;

const tasks = new Map<string, Map<string, Task>>();
/** Where a run's finished task is announced to its surfaces (the run host's fan), set while the run's turn is live. */
const sinks = new Map<string, (text: string, id: string, end: TaskEnd) => void>();   // state: plumbing — the run host's fan, for the turn
defineState({
    id: "run.tasks", scope: "run", realm: "worker", audience: "model", lostOn: ["worker-eviction", "turn-end"],
    exposedAs: "ml.current.tasks",
    describe: "The run's calls that outran their lease and were detached: each one's tool, status, how long it has run, and its result once it finished.",
    read: ({ runId }) => (runId && tasks.get(runId)?.size ? rowsOf(runId, Date.now()) : undefined),
});

/**
 * Open a run's task table for its turn: a finished task is announced through `fan` as well as the inbox.
 * @param runId the run
 * @param fan the run host's announcement to its surfaces
 */
export function openTasks(runId: string, fan: (text: string, id: string, end: TaskEnd) => void): void {
    sinks.set(runId, fan);
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
    void spec.exec.settled.then((o) => finish(runId, t, o), (e) => finish(runId, t, { status: "failed", text: `${spec.tool} failed: ${(e as Error)?.message || String(e)}`, result: null }));
    return id;
}

/**
 * A task ended: record it, then hand its result to whoever is waiting, or to the inbox. A task whose run's turn
 * already ended is not delivered anywhere: nothing is injected into a later turn or another run.
 */
async function finish(runId: string, t: Task, o: TaskOutcome): Promise<void> {
    if (t.status !== "running" || t.ending) return;
    t.ending = true;
    const endedMs = Date.now();
    const text = (await forModel(o.text)).text;
    // Ended in the meantime (the turn's end cancelled it): its status is that end's.
    if (t.status !== "running") return;
    // All at once, after the scrub: a read in between sees a running task, never an ended one with no text.
    t.status = o.status;
    t.result = o.result;
    t.endedMs = endedMs;
    t.code = o.code ?? null;
    t.text = text;
    recordRunLog(runId, { ...(o.status === "done" ? {} : { level: "warn" as const }), subsystem: "task", kind: "ended", reason: o.status, ms: Date.now() - t.startedMs, detail: { id: t.id, tool: t.tool } });
    if (tasks.get(runId)?.get(t.id) !== t) return;
    if (t.waiter) { const w = t.waiter; t.waiter = undefined; t.delivered = true; w({ ...o, text: t.text }); return; }
    const inbox = runInboxes.get(runId);
    if (!inbox || t.delivered) return;
    // Queued only: it is delivered, and drawn, when the loop drains it (`taskDrained`). A turn that ends first drops it,
    // and nothing then shows a result the model never read.
    inbox.queue.push({ text: `[task ${t.id} ${o.status} after ${secs(endedMs - t.startedMs)}: ${t.text}]`, task: t.id });
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
    sinks.get(runId)?.(text, id, { status: t.status, ms: (t.endedMs ?? Date.now()) - t.startedMs, code: t.code });
    recordRunLog(runId, { subsystem: "task", kind: "collected", reason: "inbox", detail: { id } });
    return true;
}

/**
 * End a run's turn for its tasks: each still running is cancelled by its executor, and one whose cancel is not
 * confirmed is reported as an orphan. The table is dropped: no task outlives its turn.
 * @param runId the run
 */
export async function endTasks(runId: string): Promise<void> {
    sinks.delete(runId);
    const mine = tasks.get(runId);
    tasks.delete(runId);
    if (!mine) return;
    await Promise.all([...mine.values()].filter((t) => t.status === "running").map(async (t) => {
        t.waiter = undefined;
        const c = await t.exec.cancel().catch((e) => ({ confirmed: false, text: (e as Error)?.message || String(e) }));
        t.status = c.confirmed ? "cancelled" : "orphaned";
        recordRunLog(runId, { level: "warn", subsystem: "task", kind: c.confirmed ? "cancelled" : "orphaned", reason: "turn-end", detail: { id: t.id, tool: t.tool } });
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
export async function taskAction(runId: string, args: Record<string, unknown>): Promise<string | { content: string; textValue: string; textChars: number }> {
    const id = typeof args.id === "string" ? args.id : "";
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
        if (t.status !== "running") { t.delivered = true; return `task ${t.id} ${t.status}: ${t.text ?? ""}`; }
        if (t.waiter) return `task ${t.id}: another await is already waiting on it.`;
        const given = Number(args.timeout_ms);
        const expect = Number.isFinite(given) && given > 0 ? Math.min(Math.floor(given), TASK_AWAIT_MAX_MS) : null;
        const wait = expect ?? t.leaseMs;
        const signal = runControllers.get(runId)?.signal;
        const o = await new Promise<TaskOutcome | null>((resolve) => {
            const timer = setTimeout(() => { t.waiter = undefined; resolve(null); }, wait);
            const onAbort = () => { clearTimeout(timer); t.waiter = undefined; resolve(null); };
            signal?.addEventListener("abort", onAbort, { once: true });
            t.waiter = (x) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); resolve(x); };
        });
        if (o) return `task ${t.id} ${o.status} after ${secs(Date.now() - t.startedMs)}: ${o.text}`;
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

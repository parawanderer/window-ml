// sw-python-task.ts — a worker-hosted run's python_exec cell under its lease (docs/spec/ASYNC_CALLS.md, mode 1): attached
// until the lease, detached into a task past it, cancelled by its interrupt, and the run's kernel locked while it runs.

// The executor half of the task table (sw-tasks.ts) for Python, as sw-shell-call.ts is for `ml.sh`. The lease starts when
// the cell does (`PY_STARTED`), never while it waits for its runtime or its turn. Past it the tool call answers
// "detached" and the cell runs on in the offscreen document under the detached ceiling, its output kept there for `task
// tail`; when it ends, its result goes through python_exec's own formatter (the output cap, the pointer) and arrives as a
// task. A cancel is the cell's interrupt first and its sandbox's kill only when the interrupt does not land, and says
// which; a Stop of the run cancels an attached cell the same way.

import { detachTask, type TaskOutcome, type TailAnswer } from "./sw-tasks";
import { cancelPyCell, onPyCellStarted, tailPyCell } from "./sw-python";
import { recordRunLog } from "./sw-run-log";
import { runControllers } from "./sw-runs";
import { forModel } from "./sw-scrub";
import { storeText } from "./sw-values";
import { PY_DETACHED_MAX_MS, PY_INTERRUPT_KILL_MS, PY_LEASE_MS, type CellCancel } from "../python/py-lease";
import { OUTPUT_CAP } from "../contract/contract-pointers";
import { ASKED_TAIL_CHARS } from "../shell/sh-tail";

/** What the tool call answers once its cell has detached: the spec's tool shape (`{ status: "detached", id, elapsed_ms,
 *  tail }`), and the sentence the model reads. */
export interface PyDetached { detached: { id: string; elapsedMs: number; tail: string; text: string } }

/** The run's cell that is running detached, by run: the kernel is locked while it runs. */
const detachedCells = new Map<string, string>();   // state: plumbing — run id → the task id of its detached cell, for its turn

/**
 * The sentence a second python_exec reads while the run's detached cell still runs (the kernel lock), or null.
 * @param runId the run
 */
export function pyKernelBusy(runId: string): string | null {
    const id = detachedCells.get(runId);
    return id ? `busy: task ${id} is still running in this run's Python; await or cancel it first (the task tool).` : null;
}

const secs = (ms: number): string => `${Math.round(ms / 1000)} s`;

/**
 * What a cancel did, in words: a fact, never a promise.
 * @param how the sandbox's answer
 */
export function pyCancelText(how: CellCancel): string {
    if (how === "interrupted") return "interrupted (KeyboardInterrupt); its names are kept.";
    if (how === "killed") return `it did not stop within ${secs(PY_INTERRUPT_KILL_MS)} of its interrupt (most likely inside a C function), so the sandbox was terminated; this run's names are lost.`;
    return "it had already ended.";
}

/**
 * The text the tool call answers when its cell detaches: which of rule 2's two cases it was, the task's id and how its
 * result arrives, that it ends with the turn, and the ceiling the sandbox holds it to.
 * @param id the task
 * @param leaseMs how long it ran attached
 * @param expectMs the model's own estimate, or null
 * @param tail its output so far, already cut and scrubbed ("" for none)
 */
export function pyDetachedText(id: string, leaseMs: number, expectMs: number | null, tail: string): string {
    const why = expectMs !== null
        ? `you expected ~${secs(expectMs)} and it is still running: investigate the stall, or`
        : `no expect_ms was given, so the ${secs(leaseMs)} default applied and it is still running: estimate (expect_ms), investigate, or`;
    return `Detached: python_exec detached as task ${id} after ${secs(leaseMs)}; ${why} use the task tool (await, tail, cancel). Its result arrives as a [task ${id} …] message. `
        + `It is cancelled when this turn ends, and the sandbox ends it at ${secs(PY_DETACHED_MAX_MS)}. Until it is done or cancelled, another python_exec in this run is refused.`
        + (tail ? `\nOutput so far:\n${tail}` : "");
}

/**
 * The last `lines` lines of a cell's kept output, cut to `cap` characters from the end, with a header that says so.
 * @param ring what the offscreen document kept
 * @param lines how many lines at most
 * @param cap characters at most
 */
export function pyTailText(ring: string, lines: number, cap: number): { text: string; whole: string; cut: boolean } {
    if (!ring) return { text: "stdout: nothing printed yet", whole: "stdout: nothing printed yet", cut: false };
    const all = ring.split(/\r?\n/);
    if (all[all.length - 1] === "") all.pop();
    const kept = all.slice(-Math.max(1, Math.floor(lines) || 1));
    let body = kept.join("\n");
    const cut = body.length > cap;
    if (cut) { body = body.slice(-cap); if ((body.charCodeAt(0) & 0xFC00) === 0xDC00) body = body.slice(1); body = `…${body}`; }
    const head = `stdout (${all.length > kept.length ? `last ${kept.length} lines` : `${kept.length} lines`} so far)`;
    return { text: `${head}:\n${body}`, whole: `${head}:\n${all.join("\n")}`, cut };
}

/** What runs one leased cell. */
export interface LeasedCell<R> {
    runId: string;
    /** The cell's id, as its PY_RUN carried it. */
    cell: string;
    /** The model's own estimate (`expect_ms`), or null: it replaces the lease. */
    expectMs: number | null;
    /** The cell's run in the sandbox, already sent. */
    call: Promise<R>;
    /** Stop live output reaching the step, once it has detached. */
    onDetach?: () => void;
    /** The result as the task's outcome, through the tool's own formatter. */
    late: (r: R) => Promise<TaskOutcome>;
}

/**
 * Run a leased cell: its result while attached, or, past the lease, the detached answer, its result arriving later as a
 * task. A Stop of the run interrupts it while it is attached; once detached it is the task's to cancel, and the turn's end does.
 * @param o the cell
 * @returns the result, or {@link PyDetached}
 */
export function leaseCell<R>(o: LeasedCell<R>): Promise<R | PyDetached> {
    const leaseMs = Math.min(o.expectMs ?? PY_LEASE_MS, PY_DETACHED_MAX_MS);
    return new Promise<R | PyDetached>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let settleTask: ((r: { ok: R } | { err: unknown }) => void) | undefined;
        let cancelled: CellCancel | null = null;
        const signal = runControllers.get(o.runId)?.signal;
        // A Stop while the cell is attached: its interrupt (the tool call then answers with the KeyboardInterrupt). The
        // listener is removed when it detaches: a detached cell is the turn end's to cancel.
        const onAbort = () => { void cancelPyCell(o.cell); };
        signal?.addEventListener("abort", onAbort, { once: true });
        const forget = onPyCellStarted(o.cell, () => {
            const startedMs = Date.now();
            timer = setTimeout(() => void detach(startedMs), leaseMs);
        });
        const detach = async (startedMs: number) => {
            signal?.removeEventListener("abort", onAbort);
            const settled = new Promise<TaskOutcome>((done) => {
                settleTask = (x) => {
                    if ("err" in x) { done({ status: cancelled ? "cancelled" : "failed", text: `python_exec failed: ${(x.err as Error)?.message || String(x.err)}`, result: null }); return; }
                    o.late(x.ok).then((out) => done(cancelled ? { ...out, status: "cancelled", text: `${pyCancelText(cancelled)} ${out.text}` } : out),
                        (e) => done({ status: "failed", text: `python_exec failed: ${(e as Error)?.message || String(e)}`, result: null }));
                };
            });
            const task = detachTask(o.runId, { tool: "python_exec", startedMs, leaseMs, expectMs: o.expectMs, exec: {
                cancel: async () => { const how = await cancelPyCell(o.cell); if (how !== "ended") cancelled = how; return { confirmed: true, text: pyCancelText(how) }; },
                tail: async (n, asked): Promise<string | TailAnswer | null> => {
                    const ring = await tailPyCell(o.cell);
                    if (ring === null) return "It has just ended; its result arrives on its own.";
                    const d = pyTailText(ring, n, asked ? ASKED_TAIL_CHARS : OUTPUT_CAP.exec.default);
                    if (!asked || !d.cut) return d.text;
                    const value = await storeText((await forModel(d.whole)).text, `task tail ${o.cell}`).catch(() => undefined);
                    return value ? { text: d.text, value } : d.text;
                },
                tailAbsent: "", settled,
            } });
            detachedCells.set(o.runId, task);
            void settled.finally(() => { if (detachedCells.get(o.runId) === task) detachedCells.delete(o.runId); });
            o.onDetach?.();
            recordRunLog(o.runId, { subsystem: "python", kind: "detached", reason: o.expectMs !== null ? "expected" : "default", ms: leaseMs, detail: { id: task } });
            const ring = await tailPyCell(o.cell).catch(() => null);
            const tail = ring ? (await forModel(pyTailText(ring, 20, OUTPUT_CAP.exec.default).text)).text : "";
            resolve({ detached: { id: task, elapsedMs: Date.now() - startedMs, tail, text: pyDetachedText(task, leaseMs, o.expectMs, tail) } });
        };
        o.call.then((r) => ({ ok: r }), (err) => ({ err })).then((x) => {
            clearTimeout(timer);
            forget();
            signal?.removeEventListener("abort", onAbort);
            if (settleTask) { settleTask(x as { ok: R } | { err: unknown }); return; }
            if ("ok" in x) resolve(x.ok as R); else reject(x.err);
        });
    });
}

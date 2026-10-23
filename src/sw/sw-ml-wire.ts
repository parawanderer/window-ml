// sw-ml-wire.ts — `ml` over the wire: the clients the worker vouches for, and the ML_CALL handler that answers them.

// docs/spec/ML_WIRE.md. Code that cannot hold `window.ml` (a Pyodide cell, later CPython at the process host) calls it
// as a message. The worker OPENS a client when it starts that code, binding a fresh handle to the sender kind that will
// carry its calls, the run it is for and its realm; a call is answered only when both the handle and the browser-set
// sender match. The run id in the message is checked against the handle's, never read as authority: a hostile page
// knows every run id. `ML_CALL` is not in HANDLE_MAP, so no page can start one, and a tab's sender never matches.
//
// The members are the worker survey's own (`workerReadonlyMl` through `mlFacade` with realm "worker"), cut to
// ML_READONLY_METHODS: what reads the page is absent there, so it is absent here, and a member added to the list later
// arrives here without a second list to update.

import type { MlWireAnswer, MlWireRequest } from "../contract";
import { ML_READONLY_METHODS, mlFacade } from "../readonly-exec/policy";
import { workerReadonlyMl, derefWhole, type RunDeref } from "./worker-readonly-ml";
import { pipeStages } from "../pointers/token-pipe";
import type { PipeLimits } from "../pointers/text-pipe";
import { PIPE_CHARS_PER_STEP, STEP_BUDGET } from "../readonly-exec/limits";
import { derefByRun, runControllers, sessionTokens } from "./sw-runs";
import { shRead, shRun, type ShAnswer, type ShCallContext } from "./sw-shell-call";
import { forPage } from "./sw-scrub";
import { serveWireCall, wirePointer, WireError, wireClient, deliverIfOpen, type WireMember, type WireClient, type WireFrom } from "./ml-wire-serve";

/** The largest value a call answers in full, as JSON characters; past it, a pointer read answers its pointer instead.
 *  One megabyte: chrome serialises each message as JSON, and a cell awaiting more than this wants a pipe, not the bytes. */
export const WIRE_VALUE_CAP = 1 << 20;

/**
 * Whether the browser-set sender is the one the client was opened for. Every fact must match, and an absent one does not.
 * @param from the client's sender kind
 * @param sender the message's sender
 * @returns true when it is
 */
function senderIs(from: WireFrom, sender: chrome.runtime.MessageSender): boolean {
    return from.kind === "offscreen" && sender.tab == null && typeof sender.url === "string" && sender.url === chrome.runtime.getURL("offscreen.html");
}

/**
 * The members a client's realm has. `full` adds `sh.run`/`sh.read` for a client a running step of its run opened; the
 * other gated members (a live fetch, `chat`, `click`) come with the consent path, each with its own gate.
 * @param client the client
 * @returns its members, by name
 */
function membersFor(client: WireClient): Record<string, WireMember> {
    const deref = client.run ? derefByRun.get(client.run) : undefined;
    const facade = mlFacade(workerReadonlyMl(client.tabUrl(), deref, client.run ?? ""), undefined, undefined, undefined, "worker") ?? {};
    const out: Record<string, WireMember> = Object.create(null);
    for (const name of ML_READONLY_METHODS) {
        const fn = facade[name];
        if (typeof fn !== "function") continue;
        out[name] = { run: name === "dereference" && deref ? dereferenceOverWire(deref, client.run!, meterOf(client)) : fn as (...a: unknown[]) => unknown };
    }
    // ml.sh: an approved (full) client of a run, opened by one of its steps, and only while that run runs. Bound to the run
    // and step the HANDLE records, never to anything in the request; each call is judged or asked inside that step
    // (sw-shell-call.ts). A read-only client never has it.
    const sh = shContextFor(client);
    if (sh) {
        out["sh.run"] = { run: (...a: unknown[]) => shMember(shRun, sh, a) };
        out["sh.read"] = { run: (...a: unknown[]) => shMember(shRead, sh, a) };
    }
    return out;
}

/**
 * The context an `ml.sh` call from this client runs in, or undefined when the client may not have `ml.sh`.
 * @param client the client
 */
function shContextFor(client: WireClient): ShCallContext | undefined {
    if (client.realm !== "full" || !client.run || !client.step) return undefined;
    const ctl = runControllers.get(client.run);
    if (!ctl) return undefined;
    return { runId: client.run, seq: client.step.seq, local: { ...client.step.local }, signal: ctl.signal, tokens: sessionTokens(client.run) };
}

/**
 * One `ml.sh` call as a wire member: its value, or a WireError with the call's own code.
 * @param fn `shRun` or `shRead`
 * @param ctx the call's context
 * @param args the copied arguments
 */
async function shMember(fn: (c: ShCallContext, a: readonly unknown[]) => Promise<ShAnswer>, ctx: ShCallContext, args: unknown[]): Promise<unknown> {
    const r = await fn(ctx, args);
    if ("error" in r) throw new WireError(r.code, r.error);
    return r.ok;
}

/**
 * The pipe limits that charge a client's budget: what each stage reads and makes, at the dialect's rate, and what its
 * searches can cost (regex-cost.ts). A charge past what is left throws `OverBudget` before the work it prices runs.
 * One cell's calls draw on one budget; without it each is bounded alone and a loop of them is not.
 * @param client the client
 * @returns the limits
 */
function meterOf(client: WireClient): PipeLimits {
    const spend = (n: number): void => {
        if ((client.budget.left -= n) < 0) throw new WireError("OverBudget", `this code's ml calls are over their ${STEP_BUDGET.toLocaleString("en-US")} steps together; read less per call, or read once and work on the value in the cell`);
    };
    return { charge: (chars) => spend(Math.ceil(chars / PIPE_CHARS_PER_STEP)), steps: spend };
}

/**
 * `dereference` for the wire, read from the run's resolver rather than through the page's DerefText: its `DerefRead` is
 * already plain data. Answers `{ text, meta?, warning? }`, or the pointer when that is larger than {@link WIRE_VALUE_CAP}.
 * A text whose whole body is stored is read whole (`derefWhole`), so a pipe runs at the store and only its result crosses.
 * @param deref the run's pointer resolver
 * @param run the client's run, which must hold a stored value to read it
 * @param limits the client's budget, which the pipe charges
 * @returns the member's function
 */
function dereferenceOverWire(deref: RunDeref, run: string, limits: PipeLimits): (...a: unknown[]) => unknown {
    return async (ref: unknown, opts?: unknown) => {
        const o = opts && typeof opts === "object" ? opts as { pipe?: unknown } : {};
        const pipe = o.pipe ?? null;
        if (pipe !== null && typeof pipe !== "string" && !(Array.isArray(pipe) && pipe.every((x) => typeof x === "string")))
            throw new WireError("BadRequest", "dereference's pipe is a string or an array of strings");
        const read = await derefWhole(run, deref, String(ref ?? ""), pipeStages(pipe as string | string[] | null), limits);
        const value = { text: read.value, ...(read.meta ? { meta: read.meta } : {}), ...(read.warning ? { warning: read.warning } : {}) };
        const size = JSON.stringify(value).length;
        if (size <= WIRE_VALUE_CAP) return value;
        const id = read.meta?.id;
        if (!id) throw new WireError("TooLarge", `the value is ${size} characters, past the wire's ${WIRE_VALUE_CAP}; read part of it with a pipe`);
        return wirePointer({ token: `@tool:${id}`, label: read.meta?.label ?? read.meta?.tool ?? id, size });
    };
}

/** Scrub an error's text: every client's output reaches a page or the model (sw-scrub.ts). */
const scrub = async (text: string): Promise<string> => (await forPage({ error: text })).error;

/**
 * Deliver the final answer to a call that answered `ask` first, if its client is still open.
 * @param handle the client
 * @param answer the answer
 */
function deliverLater(handle: string, answer: MlWireAnswer): void {
    deliverIfOpen(handle, answer, (m) => { void chrome.runtime.sendMessage(m).catch(() => { /* the document went: nothing waits */ }); });
}

/**
 * ML_CALL: answer one wire request, from a client the worker opened and a sender that matches it.
 * @param message the request
 * @param sender the browser-set sender
 * @param sendResponse where the first answer goes
 * @returns true: the answer is asynchronous
 */
export function onMlCall(message: Partial<MlWireRequest>, sender: chrome.runtime.MessageSender, sendResponse: (a: MlWireAnswer) => void): boolean {
    const seq = typeof message?.seq === "number" ? message.seq : 0;
    const handle = typeof message?.client === "string" ? message.client : "";
    const client = wireClient(handle);
    // An unknown handle and a wrong sender read the same, so neither tells a caller which handles exist.
    if (!client || !senderIs(client.from, sender)) {
        sendResponse({ seq, error: { code: "Refused", message: "this sender cannot call ml over the wire" } });
        return true;
    }
    serveWireCall(message, { run: client.run, members: membersFor(client), later: (a) => deliverLater(handle, a), isOpen: () => wireClient(handle) !== undefined, scrub })
        .then(sendResponse, async (e) => sendResponse({ seq, error: { code: "Failed", message: await scrub(String((e as Error)?.message || e)) } }));
    return true;
}

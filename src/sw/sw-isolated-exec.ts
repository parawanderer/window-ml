// sw-isolated-exec.ts — run an approved exec in a world of its own on the run's tab, with `ml` bound by the worker.

// The page's scripts share the main world, so a script that needs the run's private data (a pointer value, `ml.current`)
// runs where they cannot reach it: a user-script world (`chrome.userScripts.execute`, a world per run), else a CDP
// isolated world (`Page.createIsolatedWorld`). Both share the page's DOM and nothing else (docs/spec/SITE_ACCESS.md,
// part 4; exec-routing.ts decides when).
//
// The script runs inside ONE self-contained wrapper, built here as source: it binds `ml` (the values the worker sent)
// and `state`, captures the console as the main-world exec does, and returns plain data. Nothing is evaluated from a
// string inside the page, so neither the page's CSP nor the world's matters: like `cdpEval`, the expression form is
// tried first and the statement body second. A pointer value is the page's own (isolated-kit.ts, spliced in as
// source); what it needs from the worker mid-script (a re-pipe, a stored table's columns) is asked over a channel only
// that world holds, answered for that call alone (iso-channel.ts).

import { parse } from "acorn";
import type { PreRead } from "../pointers/named-reads";
import type { RenderDescriptor } from "../contract";
import { currentForExec, type CurrentSnapshot, type ExecCurrent } from "../agent/current-context";
import { splitStages } from "../pointers/text-pipe";
import { execCodeIn, expandPointers } from "../pointers/pointer-macro";
import { OUTPUT_CEILING, clipHeadTail, panelHead, ceilingNote } from "../agent/output-clip";
import { UI_OUT_CAP } from "../contract/contract-chat";
import { clipOut } from "../dom/dom";
import { grantableOrigin } from "../site-access";
import type { ExecReason, Isolation } from "./exec-routing";
import { ensureDebuggerAttached, touchDebugger, hasDebuggerPermission } from "./sw-cdp";
import { siteDecision } from "./sw-site-access";
import { ISOLATED_KIT_SOURCE } from "../isolated-kit.gen";
import type { IsoAnswer } from "./iso-channel";

/** What the worker binds in the isolated world: the pointer reads the script names, and `ml.current` (or why not). */
export interface IsolatedBindings { reads: readonly PreRead[]; current?: ExecCurrent; currentError?: string }

/** What a run of the wrapper returns, the shape `cdpEval` reports. */
export type IsolatedResult = { ok: true; value: string; logs: string[]; dropped: number } | { error: string };

/** The `ml` members an isolated exec is given; anything else throws a sentence saying so. */
export const ISOLATED_ML_MEMBERS = ["current", "dereference"] as const;

// Live console lines, keyed by the call's nonce: the user-script world posts them through `onUserScriptMessage`, which
// only a world this extension configured can reach. The nonce is the second check, the tab the first.
const isoStreams = new Map<string, { tabId: number; push: (text: string, ts?: number) => void }>();   // state: plumbing — one in-flight call each

/** One in-flight user-script exec that may ask the worker for pointer reads: where it runs, and its server. */
interface IsoCall { tabId: number; documentId: string; worldId: string; serve: (req: unknown) => Promise<IsoAnswer> }
// Keyed by the call's nonce, set for the call and deleted when it ends: a request after that, or under another call's
// nonce, finds nothing. Only `onUserScriptMessage` reaches it, which the page's world cannot send on.
const isoCalls = new Map<string, IsoCall>();   // state: plumbing — one in-flight call each

/**
 * Route a user-script world's message: a console line to its call, or a pointer read to its call's server. Registered
 * at startup (background.ts) on `onUserScriptMessage`. A read is answered only from the call's own tab, top frame,
 * document and world, under its nonce; anything else gets no answer at all.
 * @returns true while an answer is pending (the channel stays open)
 */
export function onIsolatedMessage(msg: unknown, sender: chrome.runtime.MessageSender, sendResponse?: (r: IsoAnswer) => void): boolean {
    const m = msg as { type?: string; nonce?: string; text?: string; ts?: number; req?: unknown } | null;
    if (!m || typeof m.nonce !== "string") return false;
    if (m.type === "ISO_EXEC_STREAM") {
        if (typeof m.text !== "string") return false;
        const s = isoStreams.get(m.nonce);
        if (!s || sender.tab?.id !== s.tabId || sender.frameId !== 0) return false;
        s.push(m.text, typeof m.ts === "number" ? m.ts : undefined);
        return false;
    }
    if (m.type !== "ISO_EXEC_ASK" || !sendResponse) return false;
    const c = isoCalls.get(m.nonce);
    // Every fact the browser gives about the sender must be the call's, and an absent one is not: a world this extension
    // configured on another tab, frame or document (or, where Chrome names it, another run's world) gets nothing.
    const world = (sender as { userScriptWorldId?: string }).userScriptWorldId;
    if (!c || sender.tab?.id !== c.tabId || sender.frameId !== 0 || sender.documentId !== c.documentId || (world !== undefined && world !== c.worldId)) return false;
    c.serve(m.req).then(sendResponse, (e) => sendResponse({ error: (e as Error)?.message || String(e) }));
    return true;
}

/** A fresh random nonce for one call. */
const nonce = (): string => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * The wrapper's source for one form of the script.
 * @param inner the script as an async arrow's body: `(EXPR)` or `{ BODY }`
 * @param b what to bind
 * @param n the call's nonce
 * @param stream the expression that sends one console line live (`__t` is the text, `__ts` the time), or "" for none
 * @param ask an expression for the call's channel to the worker, `(req) => Promise<IsoAnswer>`, or "" for none
 */
export function isolatedWrapper(inner: string, b: IsolatedBindings, n: string, stream: string, ask = ""): string {
    const members = ISOLATED_ML_MEMBERS.filter((m) => m !== "current" || b.current || b.currentError);
    const bound = JSON.stringify({ reads: b.reads, current: b.current ?? null, currentError: b.currentError ?? null, members });
    return `(async () => {
    globalThis.__mlIsoStarted = ${JSON.stringify(n)};
    const __B = JSON.parse(${JSON.stringify(bound)});
    const __split = (${splitStages.toString()});
    const __stages = (p) => Array.isArray(p) ? p.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()) : (typeof p === "string" && p.trim() ? __split(p) : []);
    const __reads = new Map(__B.reads.map((r, i) => [JSON.stringify([r.ref, r.pipe]), { r, i }]));
    const __no = (k) => { throw new Error("ml." + k + " is not available in this exec, which runs in an isolated world: it has ml." + __B.members.join(", ml.") + ". Do the rest in another call."); };
    const __freeze = (o) => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) __freeze(o[k]); } return o; };
    const __cur = __B.current ? __freeze({ ...__B.current.current, log: Object.assign([...__B.current.current.log], { text: __B.current.logText }) }) : undefined;
    // The page's pointer value (deref-read.ts DerefText), from the kit; a re-pipe or a stored table's columns ask the
    // worker over the call's channel, which answers only for this call (iso-channel.ts).
    ${ISOLATED_KIT_SOURCE}
    const __chan = ${ask || "undefined"};
    const __chanAsk = __chan && (async (req) => {
        const r = await __chan(req);
        if (!r || typeof r !== "object") throw new Error("The worker did not answer this exec's pointer read.");
        if (typeof r.error === "string") throw new Error(r.error);
        return r.ok;
    });
    const __t0 = {
        dereference(ref, opts) {
            const e = __reads.get(JSON.stringify([String(ref), __stages(opts && opts.pipe)]));
            if (!e) throw new Error("ml.dereference(" + JSON.stringify(String(ref)) + ") was not named in the script, so its value was not sent with it. Write the pointer and its pipe as literals and run it again.");
            const r = e.r;
            if (r.error !== undefined && r.error !== null) throw new Error(r.error);
            if (r.warning) console.warn(r.warning);
            return __mlIsoKit.isoValue(r, e.i, __chanAsk);
        },
    };
    const ml = new Proxy(Object.freeze(__t0), { get(t, k) {
        if (typeof k === "symbol" || k === "then" || k === "toJSON") return undefined;
        if (k === "current") { if (__B.currentError) throw new Error(__B.currentError); if (__cur) return __cur; return __no(k); }
        return k in t ? t[k] : __no(k);
    }, set() { return false; } });
    const state = (globalThis.__mlState ??= {});
    const __logs = [], __M = ["log", "info", "warn", "error", "debug"], __S = {};
    let __c = 0, __d = 0;
    for (const m of __M) { __S[m] = console[m]; console[m] = (...a) => { const __s = a.map((x) => { try { return typeof x === "string" ? x : JSON.stringify(x); } catch { return String(x); } }).join(" "); const __k = __s.length + (__logs.length || __d ? 1 : 0); if (__d || __c + __k > ${OUTPUT_CEILING}) { __d += __k; return; } __c += __k; __logs.push(__s); ${stream ? `try { const __t = __s + "\\n", __ts = Date.now(); ${stream}; } catch {}` : ""} }; }
    try {
        const __v = await (async (ml, state) => ${inner})(ml, state);
        const __vs = __v === undefined ? "(undefined)" : (typeof __v === "string" || __v instanceof String) ? String(__v) : (typeof Element !== "undefined" && __v instanceof Element) ? __v.outerHTML.slice(0, 2000) : (() => { try { return JSON.stringify(__v); } catch { return String(__v); } })();
        return { __mlWrapped: true, v: __vs, logs: __logs, dropped: __d };
    } catch (e) {
        return { __mlWrapped: true, threw: (e && e.stack) || String(e), logs: __logs, dropped: __d };
    } finally { for (const m of __M) console[m] = __S[m]; }
})()`;
}

/**
 * A script whose last top-level statement is an expression, with that statement returned: the value a main-world exec
 * gets from `eval` (tools.ts), which a function body would drop. Anything else, or a script that does not parse, as it
 * came.
 * @param code the script, pointers already expanded
 * @returns the script, its last expression statement made a `return`
 */
export function returnLastExpression(code: string): string {
    type Stmt = { type: string; start: number; end: number; expression?: { start: number; end: number }; directive?: string };
    let body: Stmt[];
    try { body = (parse(code, { ecmaVersion: "latest", allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true }) as unknown as { body: Stmt[] }).body; }
    catch { return code; }
    const last = body.filter((st) => st.type !== "EmptyStatement").at(-1);
    if (!last || last.type !== "ExpressionStatement" || !last.expression || last.directive !== undefined) return code;
    return `${code.slice(0, last.start)}return (${code.slice(last.expression.start, last.expression.end)});${code.slice(last.end)}`;
}

/** The two forms, as `cdpEval` tries them: a trailing expression (its value), then a statement body that returns its
 *  last expression. */
const forms = (code: string): [string, string] => [`(${code.trim().replace(/;\s*$/, "")})`, `{ ${returnLastExpression(code)}\n}`];

type Wrapped = { __mlWrapped: true; v?: string; threw?: string; logs: string[]; dropped?: number };

/** A wrapped value as the caller's result. */
function unwrap(w: Wrapped): IsolatedResult {
    if (w.threw !== undefined) return { error: `The exec threw: ${w.threw}${w.logs.length ? `\nconsole:\n${w.logs.join("\n")}` : ""}` };
    return { ok: true, value: w.v ?? "(undefined)", logs: Array.isArray(w.logs) ? w.logs : [], dropped: typeof w.dropped === "number" ? w.dropped : 0 };
}

const isWrapped = (x: unknown): x is Wrapped => !!x && typeof x === "object" && (x as Wrapped).__mlWrapped === true;

/** Whether `chrome.userScripts` can be used: present, and allowed (Chrome throws on access while the person's "Allow
 *  User Scripts" toggle is off). */
export async function userScriptsAvailable(): Promise<boolean> {
    try {
        const us = (chrome as unknown as { userScripts?: typeof chrome.userScripts }).userScripts;
        if (!us || typeof us.execute !== "function") return false;
        await us.getWorldConfigurations();
        return true;
    } catch { return false; }
}

/**
 * Run the script in a user-script world of the run's own (`wml-<runId>`), in one document only.
 * @param tabId the run's tab
 * @param documentId the top-frame document its route was decided for
 * @param runId the run, which names the world
 * @param code the approved source, pointer macros expanded
 * @param b what to bind
 * @param onStream the call's live-output sink
 * @param serve the call's pointer-read server (iso-channel.ts), or undefined when it has nothing to ask for
 */
export async function runInUserScriptWorld(tabId: number, documentId: string, runId: string, code: string, b: IsolatedBindings, onStream?: (text: string, ts?: number) => void, serve?: (req: unknown) => Promise<IsoAnswer>): Promise<IsolatedResult> {
    const us = chrome.userScripts;
    const worldId = `wml-${runId}`;
    const n = nonce();
    if (onStream) isoStreams.set(n, { tabId, push: onStream });
    if (serve) isoCalls.set(n, { tabId, documentId, worldId, serve });
    const stream = onStream ? `chrome.runtime.sendMessage({ type: "ISO_EXEC_STREAM", nonce: ${JSON.stringify(n)}, text: __t, ts: __ts })` : "";
    const ask = serve ? `((req) => chrome.runtime.sendMessage({ type: "ISO_EXEC_ASK", nonce: ${JSON.stringify(n)}, req }))` : "";
    const run = async (inner: string): Promise<unknown> => {
        const [res] = await us.execute({ target: { tabId, documentIds: [documentId] }, worldId, injectImmediately: true, js: [{ code: isolatedWrapper(inner, b, n, stream, ask) }] });
        return (res as { result?: unknown } | undefined)?.result;
    };
    try {
        await us.configureWorld({ worldId, messaging: !!onStream || !!serve });
        const [expr, body] = forms(code);
        let out: unknown;
        try { out = await run(expr); } catch { out = undefined; }
        if (!isWrapped(out)) {
            // Not run, or stopped. Only a script that never started (the expression form did not parse), in the document
            // it was routed for, is tried again: a second run of one that started would repeat what it did, and a new
            // document is not the one the route was decided for.
            if (!(await stillOn(tabId, documentId))) return { error: "The exec stopped before it finished: the page navigated." };
            const [probe] = await us.execute({ target: { tabId, documentIds: [documentId] }, worldId, js: [{ code: "globalThis.__mlIsoStarted" }] });
            if ((probe as { result?: unknown } | undefined)?.result === n) return { error: "The exec stopped before it finished (did the page navigate?)." };
            out = await run(body);
        }
        return isWrapped(out) ? unwrap(out) : { error: "The exec could not run in its isolated world (a syntax error?)." };
    } catch (e) {
        return { error: `The isolated exec failed (${(e as Error)?.message || e}).` };
    } finally {
        isoStreams.delete(n);
        isoCalls.delete(n);
    }
}

/** The CDP binding an isolated world streams console lines through; scoped to that world's name, never the page's. */
const ISO_BINDING = "__mlIsoStream";

/**
 * Run the script in a CDP isolated world on the tab's top frame, created for this call, in one document only.
 * @param tabId the run's tab
 * @param documentId the top-frame document its route was decided for
 * @param runId the run, which names the world
 * @param code the approved source, pointer macros expanded
 * @param b what to bind
 * @param onStream the call's live-output sink
 * @param serve the call's pointer-read server (iso-channel.ts), or undefined when it has nothing to ask for
 */
export async function runInCdpWorld(tabId: number, documentId: string, runId: string, code: string, b: IsolatedBindings, onStream?: (text: string, ts?: number) => void, serve?: (req: unknown) => Promise<IsoAnswer>): Promise<IsolatedResult> {
    const at = await ensureDebuggerAttached(tabId);
    if ("error" in at) return { error: `Couldn't attach the debugger to run exec in an isolated world (${at.error}).` };
    const target: chrome.debugger.Debuggee = { tabId };
    const worldName = `wml-${runId}`;
    const n = nonce();
    let contextId: number | undefined, bound = false;
    const onEvent = (src: chrome.debugger.Debuggee, method: string, params?: object) => {
        if (src.tabId !== tabId || method !== "Runtime.bindingCalled") return;
        const p = params as { name?: string; payload?: string; executionContextId?: number } | undefined;
        if (!p || p.name !== ISO_BINDING || contextId === undefined || p.executionContextId !== contextId) return;
        let m: { nonce?: string; text?: string; ts?: number; ask?: unknown; req?: unknown };
        try { m = JSON.parse(p.payload || "{}"); } catch { return; }
        if (!m || m.nonce !== n) return;
        if (typeof m.text === "string" && m.text && onStream) { onStream(m.text, m.ts); return; }
        // A pointer read: answered into the same world, by context id, so nothing else sees it. A late answer (the world
        // gone with its document) fails quietly.
        if (serve && Number.isInteger(m.ask)) {
            const ctxNow = contextId;
            void serve(m.req).then((ans) => chrome.debugger.sendCommand(target, "Runtime.evaluate",
                { expression: `globalThis.__mlIsoAnswer(${JSON.stringify(m.ask)}, ${JSON.stringify(ans)})`, contextId: ctxNow })).catch(() => {});
        }
    };
    try {
        await chrome.debugger.sendCommand(target, "Runtime.enable");
        if (onStream || serve) {
            try {
                // Before the world exists, so it is installed there; named, so no other world (the page's) has it.
                await chrome.debugger.sendCommand(target, "Runtime.addBinding", { name: ISO_BINDING, executionContextName: worldName });
                chrome.debugger.onEvent.addListener(onEvent);
                bound = true;
            } catch { bound = false; }
        }
        const tree = await chrome.debugger.sendCommand(target, "Page.getFrameTree") as { frameTree?: { frame?: { id?: string } } };
        const frameId = tree?.frameTree?.frame?.id;
        if (!frameId) return { error: "The isolated exec could not find the page's frame." };
        const world = await chrome.debugger.sendCommand(target, "Page.createIsolatedWorld", { frameId, worldName, grantUniveralAccess: false }) as { executionContextId?: number };
        contextId = world?.executionContextId;
        if (contextId === undefined) return { error: "The isolated exec could not create its world." };
        // Created on whatever document the frame held; checked AFTER, so a world on any later document is refused (a
        // context dies with its document, so one created on the routed document cannot outlive it).
        if (!(await stillOn(tabId, documentId))) { contextId = undefined; return { error: "The exec did not run: the page navigated before it started." }; }
        const stream = bound && onStream ? `${ISO_BINDING}(JSON.stringify({ nonce: ${JSON.stringify(n)}, text: __t, ts: __ts }))` : "";
        // The binding carries a read out; the answer comes back by an evaluate in this context, to the pending promise.
        const ask = bound && serve ? `(() => { const P = new Map(); let k = 0; globalThis.__mlIsoAnswer = (id, r) => { const f = P.get(id); if (f) { P.delete(id); f(r); } }; return (req) => new Promise((res) => { const id = ++k; P.set(id, res); ${ISO_BINDING}(JSON.stringify({ nonce: ${JSON.stringify(n)}, ask: id, req })); }); })()` : "";
        type EvalResult = { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } };
        const evaluate = (inner: string) => chrome.debugger.sendCommand(target, "Runtime.evaluate",
            { expression: isolatedWrapper(inner, b, n, stream, ask), contextId, awaitPromise: true, returnByValue: true, userGesture: true }) as Promise<EvalResult>;
        const syntaxErr = (r: EvalResult) => /SyntaxError/.test(r?.exceptionDetails?.exception?.description || r?.exceptionDetails?.text || "");
        const [expr, body] = forms(code);
        let r = await evaluate(expr);
        if (syntaxErr(r)) r = await evaluate(body);
        if (r?.exceptionDetails) return { error: `The exec threw: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text || "error"}` };
        const out = r?.result?.value;
        return isWrapped(out) ? unwrap(out) : { error: "The isolated exec returned nothing." };
    } catch (e) {
        return { error: `The isolated exec failed (${(e as Error)?.message || e}).` };
    } finally {
        if (bound) {
            chrome.debugger.onEvent.removeListener(onEvent);
            await chrome.debugger.sendCommand(target, "Runtime.removeBinding", { name: ISO_BINDING }).catch(() => {});
        }
        touchDebugger(tabId);
    }
}

/** Whether the tab's top frame still holds `documentId` (the browser's answer; unknown reads as no). */
async function stillOn(tabId: number, documentId: string): Promise<boolean> {
    const f = await Promise.resolve(chrome.webNavigation?.getFrame?.({ tabId, frameId: 0 })).catch(() => null) as { documentId?: string } | null;
    return f?.documentId === documentId;
}

/** What this browser offers for isolation now: user scripts if the person allowed them, else CDP if its setting is on
 *  and the debugger permission is held. */
export async function isolationAvailable(cdpOn: boolean): Promise<Isolation> {
    return { userScripts: await userScriptsAvailable(), cdp: cdpOn && await hasDebuggerPermission() };
}

/** Whether the page at `url` is on an approved origin now (the site-access lists; sw-site-access.ts). */
export async function pageApproved(url: string): Promise<boolean> {
    const g = grantableOrigin({ origin: (() => { try { return new URL(url).origin; } catch { return undefined; } })(), url, frameId: 0 });
    if ("refused" in g) return false;
    const d = await siteDecision(g.origin);
    return d === "always" || d === "session";
}

/** Each reason, as the note's clause. */
const WHY: Record<ExecReason, string> = {
    "unapproved-page": "this site is not approved for window.ml",
    current: "it reads ml.current",
    pointer: "it reads pointer values",
    plain: "",
};

/** The output cap a CDP or isolated exec's console gets in the model's result: exec's default per-slot cap. */
const ISO_EXEC_CAP = 500;

/**
 * Run an approved exec of a worker-built run in an isolated world, and shape what it returns as the page's exec does.
 * @param o the call: its tab, the document its route was decided for (it runs there or nowhere), its run, the approved source, the mechanism and why, the pointer reads it names, and
 *   `current`, which makes `ml.current` for a script that names it (undefined: the run offers none)
 * @returns the tool result, with its In/Out renders and the one-line note on what differs from the page's world
 */
export async function runIsolatedExec(o: {
    tabId: number; documentId: string; runId: string; js: string; how: "userScripts" | "cdp"; reason: ExecReason; reads: readonly PreRead[];
    current?: () => Promise<CurrentSnapshot | undefined>; onStream?: (text: string, ts?: number) => void;
    /** The call's pointer-read server (iso-channel.ts): given only when a read was sent, so a call with none has no channel. */
    serve?: (req: unknown) => Promise<IsoAnswer>;
}): Promise<{ result: string; renderIn: RenderDescriptor; renderOut?: RenderDescriptor }> {
    const renderIn = execCodeIn(o.js);
    const b: IsolatedBindings = { reads: o.reads };
    if (o.current) {
        try {
            const c = currentForExec(await o.current(), true);
            if (c && "error" in c) b.currentError = c.error; else if (c) b.current = c.value;
        } catch (e) { b.currentError = `ml.current could not be read (${(e as Error)?.message || e}).`; }
    }
    const code = expandPointers(o.js).code;
    const serve = o.reads.some((r) => r.error === undefined) ? o.serve : undefined;
    const r = o.how === "userScripts" ? await runInUserScriptWorld(o.tabId, o.documentId, o.runId, code, b, o.onStream, serve) : await runInCdpWorld(o.tabId, o.documentId, o.runId, code, b, o.onStream, serve);
    const note = `(Ran in an isolated world because ${WHY[o.reason]}: it shares the page's DOM (clicks and reads work), but the page's own scripts and globals are not visible there, and ml has only ${["current", "dereference"].filter((m) => m !== "current" || b.current || b.currentError).map((m) => `ml.${m}`).join(" and ")}. If the page behaved differently, read what you need in a read-only exec and act in the next.)`;
    if ("error" in r) return { result: `Error: ${r.error}\n\n${note}`, renderIn, renderOut: { type: "exec-out", error: r.error } };
    const kept = r.logs.join("\n");
    const stdout = r.dropped ? `${kept}\n${ceilingNote(r.dropped)}` : kept;
    const text = r.logs.length ? `console:\n${clipOut(kept, ISO_EXEC_CAP)}${r.dropped ? `\n${ceilingNote(r.dropped)}` : ""}\n\nvalue: ${r.value}` : r.value;
    return {
        result: `${text}\n\n${note}`, renderIn,
        renderOut: { type: "exec-out", stdout: clipHeadTail(stdout, UI_OUT_CAP, panelHead(ISO_EXEC_CAP)), ...(stdout.length > UI_OUT_CAP ? { capture: clipOut(stdout, UI_OUT_CAP) } : {}), seen: Math.min(kept.length, ISO_EXEC_CAP), value: r.value },
    };
}

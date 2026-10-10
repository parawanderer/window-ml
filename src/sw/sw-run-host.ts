// sw-run-host.ts — hosting ONE background agent run: the loop runs at the extension origin and every tool is
// delegated back to the page that built the toolset (RUN_TOOL_IN_PAGE), with approval gated through the sidebar.
// This is design A, and it is the whole of it: the router in background.ts only hands a START_RUN / RESUME_RUN
// over and keeps the channel open until the run finishes.

import { runBackgroundAgent } from "../agent/agent-host";
import { evalReadonlyInWorker } from "./sw-readonly";
import { workerReadonlyMl } from "./worker-readonly-ml";
import { recordRunLog, runLog } from "./sw-run-log";
import { eventsForRun, type RunLogEvent } from "../log/run-log";
import { execCodeIn, expandPointers } from "../pointers/pointer-macro";
import { namedReads, type PreRead } from "../pointers/named-reads";
import type { CurrentSnapshot } from "../agent/current-context";
import type { ToolMeta } from "../agent/agent-loop";
import type { NeutralMessage, ToolCall, TokenUsage } from "../contract/contract-chat";
import { UI_OUT_CAP } from "../contract/contract-chat";
import { clipHeadTail, panelHead, ceilingNote } from "../agent/output-clip";
import type { ApprovalDecision } from "../contract/contract-agent";
import { stepBudget } from "../agent/step-budget";
import type { StartRunPayload, ResumeRunPayload } from "../contract/contract-messages";
import { type RequestHint, hintSession } from "../contract/contract-run";
import { externalSheetIds, clipOut, isCurrentPage } from "../dom/dom";
import { extractGrants, fetchUrlLiterals, tabGrantsForCall } from "./grant-extract";
import { parseInfo } from "../resource/resource-capacity";
import { cdpClick, cdpShadowResolve, cdpKeyType, cdpEval, releaseDebugger } from "./sw-cdp";
import { grantsFor, dropCallGrants, serverToolKey, pendingApprovals, grantCredFetch, consentFetch, persistGrants, fetchConsent } from "./sw-consent";
import { relayDebugEvent } from "./sw-debug";
import { streamAgentTurn, fetchLLM, getConfig, modelCapabilities, residentModels, fetchOllamaInfo } from "./sw-llm";
import { ensureLocalTools, noteLocalStep, runLocalTool, runsInWorker } from "./sw-local-tools";
import { lookPreviewArgs, workerLook } from "./worker-look";
import { workerLocate } from "./worker-locate";
import { runVision, workerWroteVision, type RunVision } from "./run-vision";
import { withUserWatches } from "./sw-shared-watches";
import { routeExec, execNames } from "./exec-routing";
import { answerFor, answerShapeFor, applyAnswerOps, resetAnswer, setAnswerSelector } from "./worker-answer";
import { finalizeAnswer, type AnswerShapeItem } from "../pointers/answer-set";
import { withEnv } from "./sw-current-env";
import { isolationAvailable, pageApproved, runIsolatedExec } from "./sw-isolated-exec";
import { grantRunFetch, runFetchConsented, grantRunPython, pageOnlyPython } from "./worker-tools";
import { isWorkerRun, runRebuilds, navBarrier, bgRuns, runControllers, runInboxes, trackRun, persistRun, bufferReplay, resurrectedRuns, sessionTokens, readoptPageInfo, derefByRun, contextByRun, turnByRun, execReads, tabPageUrl, untrackRun, deleteRun, runModelFor } from "./sw-runs";
import { ingestSessionEvent, saveRunHistory } from "./sw-sessions";
import { claimValue } from "./sw-values";
import { focusLineFor } from "./sw-focus";
import { delegateSend } from "./delegate-send";
import { checkVerifyRequest, verifyAsked, verifyVerb, withoutPageVision, workerVerify, VERIFY_REFUSED, VERIFY_WITHHELD, type VerifyOutcome, type WorkerVerify } from "./worker-verify";
import { topDocument } from "./worker-vision";

// The model-facing cap cdpEval clips its console to (exec's default per-slot cap) — the UI keeps far more, so
// `seen` marks where the model's copy stopped, exactly like the main-world exec path.
const CDP_EXEC_CAP = 500;

const STREAM_EMIT_MS = 90;   // min gap between live `agent-stream` deltas — smooth enough to read, not a flood

/** The tab's main-frame document: the barrier's record of the last commit, else the browser's answer (a worker that was
 *  evicted has no record). Undefined where neither knows, and then a re-adopt is judged on the navigation alone. */
async function documentOn(tabId: number): Promise<string | undefined> {
    const known = navBarrier.currentDocument(tabId);
    if (known) return known;
    const frame = await Promise.resolve(chrome.webNavigation?.getFrame?.({ tabId, frameId: 0 })).catch(() => null) as { documentId?: string } | null;
    return typeof frame?.documentId === "string" ? frame.documentId : undefined;
}

/** Resolve the pointer reads an approved `exec` script names, against the run's store: each one's value, or the error
 *  the read raises (a MemoryFault, a bad pipe), which the page then throws where the script reads it. */
function preReadsFor(runId: string, js: string): PreRead[] {
    const fn = derefByRun.get(runId);
    if (!fn) return [];
    return namedReads(expandPointers(js).code).map(({ ref, pipe }) => {
        try {
            const r = fn(ref, pipe);
            return { ref, pipe, value: r.value, ...(r.warning ? { warning: r.warning } : {}), ...(r.meta ? { meta: r.meta } : {}) };
        } catch (e) { return { ref, pipe, error: (e as Error)?.message || String(e) }; }
    });
}

// LIVE tool-output streaming on the BACKGROUND path: the in-flight delegated tool's onStream, keyed by runId.
// The loop delegates tool calls SEQUENTIALLY (one in flight per run), so runId alone correlates a page-posted
// PAGE_TOOL_STREAM chunk to the right callback. Set in delegateTool while a streaming call runs, deleted after.
export const delegateStreams = new Map<string, (chunk: string, ts?: number, skipped?: number) => void>();

/** Host one background agent run for a tab: START_RUN begins one, RESUME_RUN continues a stored one with a
 *  follow-up. The loop runs here (extension origin) and delegates every tool back to the page that built the
 *  toolset; `sendResponse` fires once the whole run finishes, so the caller keeps its channel open. */
export function startBackgroundRun(message: any, sender: chrome.runtime.MessageSender, sendResponse: (r: any) => void): void {
    // sender.tab.id is the delegation + debug-fanout target.
    const tabId = sender.tab?.id;
    if (tabId == null) { sendResponse({ error: `${message.type} must come from a tab (content script).` }); return; }
    hostRun(message, tabId, sendResponse);
}

/** Host a START_RUN / RESUME_RUN on `tabId`: the body of `startBackgroundRun`, callable by the worker itself for a run
 *  it built (sw-run-start.ts), where there is no sender. `sendResponse` fires once the whole run finishes. */
export function hostRun(message: any, tabId: number, sendResponse: (r: any) => void): void {
    // Design A: run an ml.agent loop HERE (extension origin), delegating each tool back to the page
    // (RUN_TOOL_IN_PAGE) and gating approval through the sidebar. Whoever built the run (the page for a console
    // ml.agent, the worker for a run the user started) registered the live builtin tools in the page under runId;
    // we hold only serializable descriptors.
    // RESUME continues a stored run: reuse its original StartRunPayload (deps rebuild from it) + its
    // accumulated history, overriding only the task with the follow-up. Only the owning tab may resume.
    let p: StartRunPayload;
    let resumeMessages: NeutralMessage[] | undefined;
    let priorSub: import("../contract").SubcallUsage | undefined;   // a resumed session's accumulated sub-call spend
    let resumeOriginalTask: string | undefined;   // the run's ORIGINAL task (rp.task is the follow-up; empty on an auto-resume)
    let capRaised = false;                        // this resume changed the step budget → say so, since no start event will
    if (message.type === "RESUME_RUN") {
        const rp = message.payload as ResumeRunPayload;
        const stored = bgRuns.get(rp.runId);
        if (!stored) { sendResponse({ error: `No resumable run "${rp.runId}" in the background — it may have been evicted; start a new run.` }); return; }
        if (stored.tabId !== tabId) { sendResponse({ error: `Run "${rp.runId}" belongs to another tab.` }); return; }
        // A budget the person chose overrides the stored one, and because it goes into `p` it is what gets stored
        // again below: raising a cap STICKS. Bounded the same way the loop is, so a bad number from a page cannot
        // ask the worker for an unbounded run.
        const budget = stepBudget(rp.maxSteps);
        p = { ...stored.p, task: rp.task, ...(budget ? { maxSteps: budget } : {}) };
        capRaised = budget != null && budget !== stored.p.maxSteps;
        resumeOriginalTask = stored.p.task;
        resumeMessages = stored.messages;
        priorSub = stored.sub;
    } else {
        p = message.payload as StartRunPayload;
        // A createAgent handle sends its prior history (control.messages) so the background CONTINUES
        // it — the page stays authoritative across turns, and the updated history rides back below.
        resumeMessages = p.resumeMessages;
        // A handle's 2nd+ turn re-enters via START_RUN (NOT RESUME_RUN), so seed the sub-call tally from
        // the stored run too — else subTally resets to 0 each turn and chat_metadata reports "none" on a
        // continued turn even after prior turns spent thousands (the UI chip hid this: it reads the last
        // non-empty step, which still holds the prior turn's total). First turn → no stored run → 0.
        priorSub = bgRuns.get(p.runId)?.sub;
    }
    const runId = p.runId;
    // A run switched to another model (`session.model`) keeps it, whoever starts its next turn: a handle sends the
    // model it was built with, and a stored snapshot may predate the switch.
    const switched = runModelFor(runId);
    if (switched) p = { ...p, model: switched };
    /** The model for THIS call: a switch made while the loop runs takes effect at its next step. */
    const modelNow = (): string | null => runModelFor(runId) ?? p.model;
    const stepBase = p.stepBase || 0, seqBase = p.seqBase || 0;   // offsets for a handle's continued turns
    let runMaxStep = 0, runMaxSeq = 0;   // this run's max step/seq (raw) → returned so the page advances its bases
    // The session's DELEGATED vision sub-call spend, summed from each delegated tool's envelope delta (the
    // page meters it in bus.ts; the SW can't read that, so each call reports its own). Feeds chat_metadata
    // + the UI "+N sub" chip on the background path, matching the page loop. CUMULATIVE across the session:
    // seeded from the resumed run's stored tally (a per-turn reset would make chat_metadata report "none"
    // on a turn that hadn't yet made a sub-call, even after prior turns spent thousands), persisted below.
    const subTally = { prompt: priorSub?.prompt || 0, completion: priorSub?.completion || 0, calls: priorSub?.calls || 0 };
    // Per-vision-model breakdown of the tally (chat_metadata "which model cost what"), seeded from the
    // resumed run's stored breakdown and merged from each delegated tool's byModel delta. A Map for O(1)
    // merge; snapSub() flattens it to a plain SubcallUsage for events/storage (deep — no shared refs).
    const subByModel = new Map<string, { prompt: number; completion: number; calls: number }>();
    for (const bm of priorSub?.byModel || []) subByModel.set(bm.model, { prompt: bm.prompt, completion: bm.completion, calls: bm.calls });
    // Each sub-call itself (with what spend reads: raw usage, prices, electricity), appended from each delta.
    const subCalls: import("../contract").SubcallRecord[] = (priorSub?.calls_ || []).map((c) => ({ ...c }));
    const addSub = (s: import("../contract").SubcallUsage | undefined): void => {
        if (!s || !s.calls) return;
        subTally.prompt += s.prompt; subTally.completion += s.completion; subTally.calls += s.calls;
        for (const bm of s.byModel || []) {
            const cur = subByModel.get(bm.model) || { prompt: 0, completion: 0, calls: 0 };
            cur.prompt += bm.prompt; cur.completion += bm.completion; cur.calls += bm.calls; subByModel.set(bm.model, cur);
        }
        for (const c of s.calls_ || []) subCalls.push({ ...c });
    };
    // Serialized visuals of `answer`-designated elements (data URLs), accumulated from each delegated
    // answer envelope → attached to the run's result + agent-result for the HUD completion card.
    const runAnswerMedia: import("../contract").AnswerMedia[] = [];
    // Flatten the tally to a serializable SubcallUsage (fresh objects → safe to store/emit repeatedly).
    const snapSub = (): import("../contract").SubcallUsage => ({
        ...subTally,
        ...(subByModel.size ? { byModel: [...subByModel.entries()].map(([model, u]) => ({ model, ...u })) } : {}),
        ...(subCalls.length ? { calls_: subCalls.map((c) => ({ ...c })) } : {}),
    });
    // Every tool send that names a tool goes through here. A run the worker built (sw-run-start.ts) runs its REMOTE tools
    // and the builtins that never read the page itself (sw-local-tools.ts, worker-tools.ts); everything else, and every
    // run a page built, goes to the page as before.
    /** Replay what a page-side script changed in the worker's answer set; a report it refuses is logged, never applied. */
    const replayOps = async (ops: unknown): Promise<void> => {
        const refused = await applyAnswerOps(runId, ops);
        if (refused) recordRunLog(runId, { level: "warn", subsystem: "routing", kind: "answer-ops-refused", reason: refused, detail: {} });
    };
    /** Whether this run's vision is the worker's: it built the run, or was handed it (`makeWorkerRun`), even mid-turn.
     *  Its verifies are taken here, and a page's envelope cannot carry a picture, a reply or a spend into it. A run handed
     *  over during its first turn is not in `bgRuns` yet, so `isWorkerRun` misses it; its rebuild record says so. */
    const workerVision = (): boolean => p.builtBy === "worker" || isWorkerRun(runId) || runRebuilds.get(runId)?.builtBy === "worker";
    const tabUrlNow = (): string => tabPageUrl.get(tabId) || p.pageUrl || "";
    /** Take a verify in the worker, pinned to `doc`, with the run's vision facts (carried in its rebuild config). */
    /** The run's vision facts for the worker's look, locate and verify: the worker's own for a run it built, a handed-over
     *  page-built run's held to what the runtime offers (run-vision.ts). Asked once per driver model. */
    let visionMemo: { model: string | null; facts: Promise<RunVision> } | null = null;
    const visionFacts = (): Promise<RunVision> => {
        const model = modelNow();
        if (!visionMemo || visionMemo.model !== model) visionMemo = { model, facts: runVision(p.rebuild, workerWroteVision(runId), model) };
        return visionMemo.facts;
    };
    const verifyHere = async (doc: string | null | undefined, req: WorkerVerify, verb: string): Promise<VerifyOutcome> =>
        workerVerify(runId, tabId, doc, req, verb, await visionFacts(), tabUrlNow);
    const sendTool = async (payload: { runId: string; name: string; args: Record<string, unknown>; stream?: boolean; renderOnly?: boolean; readonlyTry?: boolean; precheck?: boolean; reads?: PreRead[]; answerShape?: AnswerShapeItem[] }, onStream?: (chunk: string, ts?: number) => void, documentId?: string): Promise<unknown> => {
        // A worker-built run's REMOTE tool never goes to the page, which has no such tool. If this worker does not hold
        // it (rehydrated after an eviction, or a resumed session), it is rebuilt first.
        const tabUrl = tabUrlNow;
        // `look` of a run whose vision is the worker's runs here (worker-look.ts), pinned to the document the tab holds
        // once any navigation settles; the page is asked geometry only. A preview it still draws (the target's label) is
        // sent the target alone, never the question. A run that does not offer `look` never gets here with a call (the
        // loop answers a name outside its toolset itself); with no vision facts, workerLook captures nothing.
        // `locate` likewise (worker-locate.ts), with the run's reader and grounding model from the worker's own copy of its
        // rebuild; its preview is sent the target alone too, never the description.
        if ((payload.name === "look" || payload.name === "locate") && workerVision()) {
            if (payload.renderOnly || payload.precheck || payload.readonlyTry) payload = { ...payload, args: lookPreviewArgs(payload.args) };
            else {
                noteLocalStep(runId, payload.name);
                await navBarrier.whenReady(tabId);
                const doc = await topDocument(tabId);
                const vision = await visionFacts();
                return payload.name === "look"
                    ? workerLook(runId, tabId, doc, payload.args, vision, tabUrl)
                    : workerLocate(runId, tabId, doc, payload.args, vision, tabUrl);
            }
        }
        // To the page. The call itself of a run whose vision is the worker's is told so (its verify comes back as a
        // request), and what the page answers is held to that (`withoutPageVision`).
        const toPage = async (pin?: string): Promise<unknown> => {
            const vis = workerVision();
            const call = vis && !payload.renderOnly && !payload.precheck && !payload.readonlyTry;
            const env = await delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload: call ? { ...payload, verifyInWorker: true } : payload }, pin);
            // Asked again on the answer: a run the person took over while the call was in flight is the worker's now.
            return vis || workerVision() ? withoutPageVision(env) : env;
        };
        if (p.builtBy === "worker" && runsInWorker(p, payload.name)) {
            await ensureLocalTools(runId, p, tabId, tabUrl).catch(() => { /* answered below */ });
            const local = await runLocalTool({ ...payload, tabUrl: tabUrl() }, onStream);
            if (local) return local;
            // A remote tool has nowhere else to run; a builtin declined here (fetch_url's render of this very page) does.
            if (p.tools.some((t) => t.name === payload.name && t.remote))
                return { result: `Error: the server tool "${payload.name}" is not available any more (the server no longer lists it).` };
            return toPage();
        }
        return (await runLocalTool(payload, onStream)) ?? toPage(documentId);
    };
    const abortCtl = new AbortController();   // CANCEL_RUN aborts this → the loop resolves { cancelled }
    // Set once this run's page navigates: the page-side caller that normally emits the lifecycle
    // agent/agent-result (overlay/devtools) is then GONE (its context died with the old document), so the
    // BACKGROUND must fan the terminal result to the destination page instead — else the run finishes but
    // no surface ever learns it did (the observer/HUD sat on "running"). See emitLifecycle below.
    let hasNavigated = false;
    runControllers.set(runId, abortCtl);
    runInboxes.set(runId, { tabId, queue: [] });   // a.say() steering lands here while the run is live
    // Register the run against its tab so the navigation sensor watches it — UNLESS the run opted out of
    // cross-page persistence (navigate: false), in which case a nav simply ends it (no barrier, no adopt).
    if (p.crossPage !== false) trackRun(tabId, runId, p.rebuild);
    // Durable resume: snapshot the run NOW (before the first step) + after each step (the checkpoint dep),
    // so an SW evicted mid-run rehydrates from storage. Cleared when the run settles (finally).
    persistRun(runId, { p, tabId, messages: resumeMessages || [], sub: snapSub() });
    // `remote` has to survive into the loop's ToolMeta: it is what makes a remote tool's output CITABLE
    // (`meta?.remote` in agent-loop), and it cannot be recovered from the name — the name is generated
    // from the server's own bundle, so no hardcoded list can hold it. Dropping it here made the whole
    // feature page-path-only, silently: the tool ran, streamed and rendered exactly as it should, and
    // only reading the pointer back faulted with "nothing has been captured in this run".
    const toolMetas: ToolMeta[] = p.tools.map(t => ({ name: t.name, requiresApproval: t.requiresApproval, capabilities: t.capabilities, ...(t.remote ? { remote: t.remote } : {}) }));
    const toolDefs = p.tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    /** The refusal for a worker-built run's python_exec that names BOTH an external sheet and something only the page can
     *  supply (an image, a selector, `current`), or null. Such a call runs nowhere safely: the worker cannot read the page
     *  part, and sending it to the page would put the sheet grant on the TAB, where any script on it could spend it while
     *  the call ran (red-team T3 on #442). Checked in the precheck (before the gate) and where the call is delegated
     *  (the auto-approved path skips the precheck). */
    const mixedPythonRefusal = (name: string, args: Record<string, unknown>): string | null =>
        name === "python_exec" && p.builtBy === "worker" && pageOnlyPython(args) && externalSheetIds(args).length
            ? "Refused: a python_exec for this run cannot mix an external Google Sheet with a page source (an image, a CSS selector, or \"current\"). Load the sheet in its own call — the worker runs that, and the sheet's rows come back to you — then do the page part in the next call."
            : null;
    const approvedSheets = new Set<string>();   // external sheets approved this run (isSheetApproved)
    // Cross-origin navigation consent: origins this run may navigate to WITHOUT re-prompting — seeded
    // with the start origin, and each cross-origin nav the user approves is added (so repeat navs to it
    // skip the gate). A run that didn't opt into crossOrigin never gates (its tool refuses cross-origin).
    const consentedOrigins = new Set<string>();
    if (p.pageOrigin) consentedOrigins.add(p.pageOrigin);
    // The turn's ask and its grants, readable by the state inspector (`run.input`, `grants.turn`) for as long as the turn runs.
    const turnStarted = Date.now();
    turnByRun.set(runId, () => ({ task: p.task, images: p.images?.length ?? 0, origin: p.origin ?? null, startedTs: turnStarted,
        origins: [...consentedOrigins], sheets: [...approvedSheets], payload: p }));
    const navNeedsConsent = (url: string): boolean => {
        if (!p.crossOrigin) return false;   // can't cross origins → tool refuses cross-origin; same-site fine → no gate
        try {
            if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !url.startsWith("//")) return false;   // relative → same-origin
            const dest = new URL(url.startsWith("//") ? "https:" + url : url);
            return !consentedOrigins.has(dest.origin);   // a NEW cross-origin → gate; an already-consented one → no
        } catch { return false; }   // unparseable → the tool will error; no pointless gate
    };
    // Debug fan-out for this run → the active surface.
    //  · overlay: re-post to the PAGE window (ML_DEBUG_TO_PAGE → content.js → the shell → the iframe
    //    app), where the overlay app is mounted.
    //  · devtools: there's no iframe app on the page — fan straight to the panel via relayDebugEvent
    //    (→ the ml-devtools ports + the per-tab replay buffer, so a panel opened mid-run catches up).
    //    The page-emitted `agent`/`agent-result` events already reach the panel via the shell's
    //    __mlDebug→ML_DEBUG_EVENT forward; this covers the background-emitted agent-STEP events.
    // Fan a run's step events to the page. overlay AND off both stream to the page window
    // (ML_DEBUG_TO_PAGE → the shell → the iframe app) — off renders them in the corner CARD, a
    // curated view of the same data; devtools fans to the panel. The card mounts itself lazily on the
    // first of these (which reach the shell over chrome.runtime, never the page) and self-reveals for a pending gate / the
    // final answer, so a no-approval off run streams to a hidden, cheap-to-mount card.
    const emitStep = (ev: Record<string, unknown>): void => {
        // Once the run is aborted (CANCEL_RUN), stop fanning steps: an in-flight tool's DONE resolves
        // AFTER the abort (the page tool round-trip isn't cancellable), and a straggler landing after the
        // page's cancelled result would wrongly re-show "running" in the panel. Drop it at the source.
        if (abortCtl.signal.aborted) return;
        // Offset this turn's step/seq past the handle's prior turns so the sidebar's turn groups stay
        // distinct (the background twin of the page loop's control.stepBase/seqBase). Track the raw max
        // so the page can advance its bases for the next turn (returned in the response below).
        const rawStep = (ev.step as number) || 0;
        if (rawStep > runMaxStep) runMaxStep = rawStep;
        const rawSeq = ev.seq as number | undefined;
        if (rawSeq != null && rawSeq > runMaxSeq) runMaxSeq = rawSeq;
        const step = stepBase + rawStep;
        const seq = rawSeq != null ? seqBase + rawSeq : rawSeq;
        const event = {
            kind: "agent-step", id: runId, ts: Date.now(), save: false,
            session: { hash: runId, turn: step }, ...ev, step, localStep: rawStep, seq,
            // Running delegated-sub-call tally for the SESSION (seeded from the stored run's, so it carries across
            // turns), so the UI "+N sub" chip works on the background path too (the page path attaches
            // subcallUsage() the same way). Omit when nothing delegated.
            ...(subTally.calls ? { subUsage: snapSub() } : {}),
        };
        // Always fan to the PAGE (overlay / off card). For devtools ALSO fan to the panel — and the
        // page fan lets the optional corner card coexist with the panel (agentHudInDevtools); the
        // shell drops the page copy when no card is mounted, and never loops it back to the panel.
        chrome.tabs.sendMessage(tabId, { type: "ML_DEBUG_TO_PAGE", event }).catch(() => { /* tab gone / no receiver */ });
        // ALWAYS feed a connected DevTools panel (no-op if none). A background-hosted run is the SOLE source
        // of its events — the shell receives them over chrome.runtime and never re-forwards them as ML_DEBUG_EVENT, so
        // this can't double-relay. Gating on `surface === "devtools"` left an off/card run's panel (if the
        // user also has one open) stuck on the connect-time replay — the "panel stopped updating" bug.
        relayDebugEvent(tabId, event);
        ingestSessionEvent(event, { tabId, trusted: true });
        // Cross-page: remember this step so a fresh page after a nav can rebuild the card mid-run.
        if (p.crossPage !== false) bufferReplay(tabId, event);
    };
    // Fan a lightweight run event verbatim (no step/seq offset) to every surface — used for the
    // "seen" indicator (agent-say-seen), which keys off its own id, not a step position.
    const fanEvent = (event: Record<string, unknown>): void => {
        if (abortCtl.signal.aborted) return;
        chrome.tabs.sendMessage(tabId, { type: "ML_DEBUG_TO_PAGE", event }).catch(() => {});
        relayDebugEvent(tabId, event);   // always feed a connected panel (see emitStep — no double, no-op if none)
        ingestSessionEvent(event, { tabId, trusted: true });
        if (p.crossPage !== false) bufferReplay(tabId, event);
    };
    /** "A model call is underway" — the one stamp for it, since the pending step START fires only once a
     *  TOOL is about to run (i.e. after the generation) and a turn that emits nothing but a tool call
     *  produces no stream deltas at all. Re-fired on each phase change with the marks so far. */
    const emitTurn = (rawStep: number, phases?: import("../contract").GenPhase[]): void => {
        const step = stepBase + rawStep;
        fanEvent({ kind: "agent-turn", id: runId, ts: Date.now(), save: false,
                   session: { hash: runId, turn: step }, step, localStep: rawStep, ...(phases?.length ? { phases: phases.slice() } : {}) });
    };
    // OFF mode: the corner card is fed ENTIRELY by this background stream, because the page's own
    // debug bus (bus.ts) stays dormant in off mode — no `present` handshake, so its emitDebug is a
    // no-op and off mode keeps its zero-cost footprint until a privileged run actually starts. So for
    // OFF we emit the run's lifecycle (start + result) here too; overlay gets them from the page's bus
    // and devtools from the panel forward, so emitting them here as well would double up — off only.
    const emitLifecycle = (event: Record<string, unknown>): void => {
        // Buffer FIRST (before any fan decision) so the replay stream includes the `agent` start + result
        // even on an overlay run where the page-side caller — not this — is what fans them live. Without
        // the start event a re-adopted card can't rebuild the session.
        if (p.crossPage !== false) bufferReplay(tabId, event);
        // "off": the page-side caller emits nothing, so the background always fans lifecycle events.
        // overlay/devtools: the caller normally emits them page-side (incl. the panel, via the shell
        // forwarder) — EXCEPT once the run has navigated, when that caller's context is gone, so the
        // background fans to the destination page instead. UNLIKE per-step events (background-only source),
        // lifecycle is ALSO emitted page-side here, so relaying it below early would DOUBLE in the panel.
        // A run the WORKER built (or was handed: a durable resume, `makeWorkerRun`) has no page-side caller at all, on
        // any surface, so it fans its own from the start.
        if (p.surface !== "off" && !hasNavigated && p.builtBy !== "worker") return;
        chrome.tabs.sendMessage(tabId, { type: "ML_DEBUG_TO_PAGE", event }).catch(() => {});
        // We're the SOLE fanner in this branch (off, or overlay/devtools post-nav), so feed a connected panel
        // too — regardless of surface. Gating on `devtools` left an off/card run's answer never reaching a
        // connected panel (stuck on "running"). No double (page-side isn't fanning here); no-op without a panel.
        relayDebugEvent(tabId, event);
        ingestSessionEvent(event, { tabId, trusted: true });
    };
    // Only a FRESH run announces the session start; a RESUME continues an existing sidebar/card
    // session (re-emitting `agent` would wipe its accumulated steps), so it streams new steps + a
    // fresh agent-result under the same hash instead. EXCEPTION (fix C): a run RESURRECTED from storage
    // after an SW respawn has NO surface session anymore (memory + replay buffer were wiped), so it must
    // re-announce — else it drives INVISIBLY with no Stop button (the runaway-run bug). Use the ORIGINAL
    // task (rp.task is the empty auto-resume follow-up), and fanEvent (not emitLifecycle, whose overlay/
    // devtools gate would suppress it) so the row appears on every surface. The reducer's don't-wipe merge
    // makes this safe if a stray session somehow survived.
    const resurrected = resurrectedRuns.has(runId);
    resurrectedRuns.delete(runId);
    const startEvent = {
        kind: "agent", id: runId, ts: Date.now(), save: false, session: { hash: runId, turn: 0 },
        task: resurrected ? (resumeOriginalTask ?? p.task) : p.task, model: p.model, maxSteps: p.maxSteps,
        ...(p.display && !resurrected && p.builtBy === "worker" ? { display: p.display } : {}),
        pageUrl: p.pageUrl, pageTitle: p.pageTitle,
        resumed: resurrected || undefined,   // the sidebar can mark it "resumed after interruption"
        config: {
            system: p.systemPrompt, customSystem: false,
            tools: p.tools.map(t => ({ name: t.name, requiresApproval: t.requiresApproval, vision: t.capabilities.includes("vision"), description: t.description, parameters: t.parameters, summary: t.summary, ...(t.remote ? { remote: t.remote } : {}) })),
            maxSteps: p.maxSteps, think: p.think, env: true, vision: null, systemAppend: null, unattended: p.unattended, silent: p.silent,
            stream: p.stream,
        },
    };
    if (!resumeMessages) emitLifecycle(startEvent);
    else if (resurrected) fanEvent(startEvent);   // resurrected: no page-side caller emitted a start → fan it ourselves
    // A plain resume emits NEITHER, so a cap raised here would reach no surface: the step pill would keep counting
    // against the old number and the next Continue would offer the old budget back. `agent-cap` is the same event
    // a handle's setter fans page-side, and the reducer already folds it into the session.
    else if (capRaised) fanEvent({ kind: "agent-cap", id: runId, ts: Date.now(), save: false, session: { hash: runId, turn: 0 }, maxSteps: p.maxSteps });
    /** The run's context snapshot (`contextSink`), for `ml.current` in a survey the worker evaluates. */
    // A run the worker built keeps its curated answer here (worker-answer.ts): a new turn starts it empty (a run resurrected
    // after an eviction continues its turn, so keeps it), and its `answer` tool asks this tab for a selector's elements.
    // Only a run that has `answer` has a set to send: without it `ml.answer` is absent (ml-member-tools.ts), and a shape
    // would hand the page script an `AnswerLog` the run never offered.
    const workerAnswer = p.builtBy === "worker" && p.tools.some((t) => t.name === "answer");
    if (workerAnswer) {
        if (!resurrected) resetAnswer(runId);
        setAnswerSelector(runId, async (a) => {
            const env = await delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload: { runId, name: "answer", args: {}, answerSelect: a } })
                .catch((e) => ({ result: `Error: ${(e as Error)?.message || e}` })) as Partial<import("../contract").PageToolEnvelope> | null;
            return env?.answerSelection ?? { count: 0, error: String(env?.result || "the page did not answer").replace(/^Error: /, "") };
        });
    }
    runBackgroundAgent(
        { task: p.task, systemPrompt: p.systemPrompt, tools: toolMetas, model: p.model, think: p.think, maxSteps: p.maxSteps, autoApprovePython: p.autoApprovePython, autoApproveSameOriginAuth: p.autoApproveSameOriginAuth, autoApproveSelfSource: p.autoApproveSelfSource, unattended: p.unattended, toolTokens: p.toolTokens, stream: p.stream, ...(p.origin ? { origin: p.origin } : {}), runId, seqBase, tokenStore: sessionTokens(runId), labelMatch: p.labelMatch, resumeMessages, images: p.images,
          // A resumed turn follows a PERSON (a follow-up, Continue, Retry) — except a run resurrected after the
          // worker was evicted, where nobody was waited on.
          ...(resumeMessages && !resurrected ? { after: "human" as const } : {}) },
        {
            callModel: async (messages, opts) => {
                // WHAT THIS REQUEST IS FOR: an agent step, in this run's session (see RequestHint).
                const hint: RequestHint = { use: "agent", session: hintSession(runId), ...(opts?.after ? { after: opts.after } : {}) };
                // Thread the run's abort signal so a CANCEL_RUN kills a slow in-flight generation, not
                // just stops at the next step boundary.
                if (p.stream) {
                    // Opt-in streaming: emit the thinking/reply LIVE (throttled) so a long reasoning phase
                    // shows its text instead of a frozen token count. streamAgentTurn accumulates tool_calls
                    // too, so the loop still gets its authoritative { content, tool_calls } at the end.
                    const rawStep = (opts?.step as number) || 0, step = stepBase + rawStep;
                    let last = 0;
                    let tokens: number | undefined, reasoningTokens: number | undefined;
                    const flush = (acc: { reasoning: string; content: string; tokens?: number; reasoningTokens?: number }): void => {
                        if (abortCtl.signal.aborted) return;
                        last = Date.now();
                        if (acc.tokens != null) tokens = acc.tokens;
                        if (acc.reasoningTokens != null) reasoningTokens = acc.reasoningTokens;
                        fanEvent({ kind: "agent-stream", id: runId, ts: last, save: false, session: { hash: runId, turn: step }, step, localStep: rawStep,
                            ...(acc.reasoning ? { reasoning: acc.reasoning } : {}), ...(acc.content ? { content: acc.content } : {}),
                            ...(tokens != null ? { tokens } : {}), ...(reasoningTokens != null ? { reasoningTokens } : {}) });
                    };
                    const r = await streamAgentTurn({ messages, tools: toolDefs, model: modelNow(), think: p.think, hint },
                        (acc) => {
                            // Kept even when this delta is throttled away, so the next one out — or the final
                            // flush — carries the newest count rather than the last one that happened to fan.
                            if (acc.tokens != null) tokens = acc.tokens;
                            if (acc.reasoningTokens != null) reasoningTokens = acc.reasoningTokens;
                            // A phase CHANGE goes out immediately and unthrottled — there are a handful per
                            // turn, and it is the edge the live bar draws its divider at. Text deltas stay
                            // throttled; they are continuous.
                            if (acc.phaseChanged) emitTurn(rawStep, acc.phases);
                            if (Date.now() - last >= STREAM_EMIT_MS) flush(acc);
                        }, abortCtl.signal);
                    flush({ reasoning: r.reasoning || "", content: r.content || "" });   // final: land the last delta even if throttled
                    return { content: r.content, tool_calls: r.tool_calls, reasoning: r.reasoning, usage: r.usage };
                }
                const r = await fetchLLM({ messages, tools: toolDefs, model: modelNow(), think: p.think, raw: true, hint }, abortCtl.signal) as { content: string | null; tool_calls: ToolCall[]; reasoning: string | null; usage: TokenUsage | null };
                return { content: r.content, tool_calls: r.tool_calls, reasoning: r.reasoning, usage: r.usage };
            },
            delegateTool: async (name, args, onStream) => {
                // This call's own key for the grants it mints on the tab (sw-consent.ts): another run on the same tab
                // ending its call drops only its own.
                const callKey = {};
                // The mixed-call refusal again, for the call the precheck never saw: one AUTO-approved because an
                // earlier call got its sheet approved skips the gate and the precheck with it. Refused before any
                // grant is minted or anything is sent, with the same two-call steer (the tab grant staying unminted,
                // below, is the second layer).
                const mixed = mixedPythonRefusal(name, args);
                if (mixed) return { result: mixed };
                // Where an approved exec of a run the worker built runs (exec-routing.ts): the page's world, an isolated
                // world on the same tab (sw-isolated-exec.ts), or nowhere. Decided before any grant is minted on the tab.
                const js = name === "exec" && p.builtBy === "worker" && typeof (args as { js?: unknown }).js === "string" ? (args as { js: string }).js : undefined;
                let execNote: string | undefined, execDoc: string | undefined;
                if (js !== undefined) {
                    // The document FIRST, then its URL: the call is pinned to that document, so a navigation after this
                    // read makes the send fail instead of landing on the next page, whatever the URL then says. The URL
                    // is the browser's, not the run's start page (a worker that restarted has no navigation record).
                    execDoc = await documentOn(tabId);
                    const url = (await chrome.tabs.get(tabId).catch(() => null))?.url || tabPageUrl.get(tabId) || "";
                    const route = routeExec(js, await pageApproved(url), await isolationAvailable(!!(await getConfig()).cdp));
                    recordRunLog(runId, { subsystem: "routing", kind: `exec-${route.where}`, reason: route.reason, detail: { tool: name, ...(route.where === "isolated" ? { how: route.how } : {}) } });
                    if (route.where === "refused") return { result: route.result, renderIn: execCodeIn(js) };
                    if (route.where === "isolated") {
                        const snap = p.selfIntrospection === false ? undefined : contextByRun.get(runId);
                        // Never unpinned: what it is given is the run's, so with no document to hold it to, it does not run.
                        if (!execDoc) return { result: "Error: could not tell which page the tab holds now, so this exec was not run. Run it again.", renderIn: execCodeIn(js) };
                        return runIsolatedExec({
                            tabId, runId, js, how: route.how, reason: route.reason, reads: preReadsFor(runId, js), onStream, documentId: execDoc,
                            // Made only for a script that names it, as a survey's is (tryReadonly below).
                            ...(snap && execNames(js).current ? { current: async () => withEnv(await withUserWatches(snap({ model: modelNow(), log: eventsForRun(await runLog.all(), runId) })), tabId, !!p.autoApproveReadonly) } : {}),
                        });
                    }
                    execNote = route.note;
                }
                // Live output: register this call's stream sink under the runId so a PAGE_TOOL_STREAM chunk
                // the page posts mid-run reaches the loop's throttled fan. Cleared in the finally below.
                if (onStream) delegateStreams.set(runId, onStream);
                // Reaching here means the call is AUTHORIZED (approved / auto / cached alike). Mint the
                // choke-point grants for the privileged sub-ops this tool will make, bound to the exact
                // resources in its args — an untrusted page's FETCH_SHEET / full PYTHON_EXEC checks them.
                // Scoped to this delegation: cleared in `finally`, so a later call needs its own approval.
                // An APPROVED exec may fetch inline (ml.fetch) the URLs its code spells out: the person saw them. Only
                // those, parsed here: the page shares the tab, and an open grant lent it every URL while any exec ran.
                // The pointer reads an approved script names, resolved here and sent with it: the page answers only
                // those, so it cannot read the rest of the run's store while the call is in flight (named-reads.ts).
                const reads = name === "exec" && typeof (args as { js?: unknown }).js === "string" ? preReadsFor(runId, (args as { js: string }).js) : undefined;
                if (reads) execReads.set(runId, reads);
                // A remote tool's args LEAVE THE MACHINE, so the grant is minted for the exact call the
                // human saw — never for the tool in general. The identity comes from the tool's declared
                // `remote` target rather than its name, which is what keeps the approval card and the
                // grant reading the same thing: a friendly name cannot make the card say one callable
                // while the grant authorises another.
                const remote = p.tools.find(t => t.name === name)?.remote;
                // A python_exec the WORKER runs gets its grants as the RUN's call grant (worker-tools.ts): on the tab
                // they were a sheet read with the person's cookies, and full-mode Python, that any script on the
                // page could use while the call ran. One that needs the page (an image, a selector) still mints the
                // tab's, which that page call sends.
                const pyInWorker = name === "python_exec" && p.builtBy === "worker" && runsInWorker(p, name) && !pageOnlyPython(args as Record<string, unknown>);
                if (pyInWorker) {
                    await ensureLocalTools(runId, p, tabId, () => tabPageUrl.get(tabId) || p.pageUrl || "").catch(() => { /* nothing granted: fails closed */ });
                    grantRunPython(runId, { sheets: externalSheetIds(args), code: (args as { mode?: string }).mode === "full" ? String((args as { code?: unknown }).code ?? "") : null });
                }
                // What this call puts on the TAB for its own sub-ops (tabGrantsForCall, grant-extract.ts): an exec's literal
                // fetch URLs, a server tool's exact call, a page-run python_exec's full-mode code, and its sheets only for a
                // run the page built. Minted only when there is something to mint, so a call with none holds no entry.
                const minted = tabGrantsForCall({ name, args: args as Record<string, unknown>, builtByWorker: p.builtBy === "worker", pyInWorker,
                    ...(remote ? { remoteKey: serverToolKey(remote.toolId, remote.fn, args as Record<string, unknown>) } : {}) });
                if (minted.fetchUrls) grantsFor(tabId, callKey).fetchUrls = new Set(minted.fetchUrls);
                if (minted.serverTools.length || minted.sheets.length || minted.pyCode.length) {
                    const g = grantsFor(tabId, callKey);
                    for (const k of minted.serverTools) g.serverTools.add(k);
                    for (const id of minted.sheets) g.sheets.add(id);
                    for (const code of minted.pyCode) g.pyCode.add(code);
                }
                try {
                    // A delegated call can race a NAVIGATION — the tool's own action submits a form / follows a
                    // link, or the page redirects mid-call (common after an approval gate holds the call: e.g.
                    // google.com settling while `type` waited to be approved). The content script's channel then
                    // closes and Chrome's raw "message channel closed…" error is useless to the model. RECOGNISE
                    // it as a navigation: wait for the new document to settle (re-adopt) and hand back the new
                    // page's context — actionable, and safe (no blind retry that could double-submit a form).
                    const CHANNEL_GONE = /message channel closed|Receiving end does not exist|No tab with id/i;
                    let env: Partial<import("../contract").PageToolEnvelope>;
                    let workerMade = false;   // the worker wrote this result itself (the page could not be reached, or navigated)
                    // The document this call goes to: if the call navigates, that document stays alive a moment and
                    // still knows the run id, and its re-adopt must not pass for the destination's. Unknown while a
                    // navigation is in flight (the call then goes to whichever document re-adopts); never a wait of
                    // its own, since the barrier's timeout releases a waiter without ending the navigation.
                    const sentTo = navBarrier.isNavigating(tabId) ? undefined : await documentOn(tabId);
                    /** The destination's pageInfo, unless it came from the document this call left. */
                    const takeInfo = (): string | undefined => {
                        const r = readoptPageInfo.get(tabId); readoptPageInfo.delete(tabId);
                        return r && (sentTo === undefined || r.doc !== sentTo) ? r.info : undefined;
                    };
                    try {
                        // A worker-built run's answer set is the worker's: the script is sent its shape, and what it changed
                        // comes back to be replayed (worker-answer.ts).
                        const answerShape = js !== undefined && workerAnswer ? await answerShapeFor(runId) : undefined;
                        env = await sendTool({ runId, name, args, stream: !!onStream, ...(reads ? { reads } : {}), ...(answerShape ? { answerShape } : {}) }, onStream, execDoc) as Partial<import("../contract").PageToolEnvelope>;
                        if (answerShape && env?.answerOps !== undefined) await replayOps(env.answerOps);
                    } catch (e) {
                        const emsg = (e as Error)?.message || String(e);
                        if (!CHANNEL_GONE.test(emsg)) {
                            env = { result: `Error: could not reach the page to run "${name}" (${emsg}).` }; workerMade = true;
                        } else {
                            // The page navigated out from under the call. Its pageInfo may already be here (a fast
                            // re-adopt beat us); else engage the barrier and wait for it (bounded by the barrier's
                            // own timeout, then a generic "still loading" note).
                            let info = takeInfo();
                            if (!info) { navBarrier.noteNavigating(tabId, sentTo); await navBarrier.whenReady(tabId); info = takeInfo(); }
                            hasNavigated = true;   // the run moved pages → the terminal result must fan to the new page
                            workerMade = true;
                            env = { result: `The page navigated while running "${name}" — the action triggered a navigation, or the page redirected mid-call.${info ? `\n\nYou are now on the new page:\n${info}` : " The new page is still loading — wait, then look."}\n\nNOTE: "${name}" may NOT have taken effect on the previous page. Verify the CURRENT page (look / findByText) and re-run "${name}" here if the change didn't happen.` };
                        }
                    }
                    addSub(env?.subUsage);   // this tool's own delegated vision sub-call spend (look/locate)
                    // The document a verify of this call is pinned to: the one the call was sent to, else (a navigation was in
                    // flight) the tab's top document once the answer is in. A navigation the action itself caused lands the
                    // verify on a document it does not describe, which the vision host refuses (worker-verify.ts).
                    const actionDoc = async (): Promise<string | null> => sentTo ?? await topDocument(tabId);
                    /** A ring-back verify after an action the worker did through the debugger: taken here for a run whose
                     *  vision is the worker's, else the page takes it (`payload`). */
                    const ringVerify = async (req: WorkerVerify | null, verb: string, payload: Record<string, unknown>): Promise<{ vres: string; vimg?: string; vimgLabel?: string; vfeedback?: import("../contract").ToolFeedback }> => {
                        if (workerVision()) {
                            if (!req) return { vres: VERIFY_REFUSED };
                            const v = await verifyHere(await actionDoc(), req, verb);
                            addSub(v.subUsage);
                            return { vres: v.content, vimg: v.image, vimgLabel: v.imageLabel, vfeedback: v.feedback };
                        }
                        const venv = await delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload: { runId, ...payload } }).catch(() => null) as Partial<import("../contract").PageToolEnvelope> | null;
                        if (!venv) return { vres: "" };
                        addSub(venv.subUsage);
                        return { vres: venv.result || "", vimg: venv.image, vimgLabel: venv.imageLabel, vfeedback: venv.feedback };
                    };
                    if (env?.answerMedia?.length) runAnswerMedia.push(...env.answerMedia);   // answer's element visuals → HUD card
                    // Cross-page: the `navigate` tool DEFERS the real location change a tick, so its result
                    // returns before the document unloads. Engage the barrier NOW — not only via the async
                    // webNavigation.onCommitted, which can lose the race to the loop's next (fast, local)
                    // model call + tool delegation, letting the next tool fire into the dying document.
                    // The next delegateSend then waits for the new page to re-adopt. Skip an errored nav.
                    if (name === "navigate" && !String(env?.result || "").startsWith("Error")) {
                        navBarrier.noteNavigating(tabId, sentTo); hasNavigated = true;
                        // Orient-on-nav: WAIT for the new document to re-adopt, then fold its pageInfo into
                        // THIS tool's result — so the model's next turn already knows where it landed instead
                        // of spending a look()/pageInfo turn to find out. The barrier's own timeout is the
                        // fallback (a nav that never re-adopts → whenReady resolves, no pageInfo → plain result).
                        if (env) {
                            await navBarrier.whenReady(tabId);
                            const info = takeInfo();
                            if (info) env.result = `${env.result || ""}\n\nYou are now on the new page:\n${info}`;
                            // verify → fold a view of the DESTINATION page into the result, captured on the NEW
                            // page after re-adopt (same await path as the click/type verify). "viewport" (or
                            // legacy true) = a SCREENSHOT (vision inline / a delegated description for a text
                            // driver); "text" / "text-all" = the page distilled to MARKDOWN (fetch_url's HTML→MD;
                            // cheaper, no vision — "text" strips nav/chrome, "text-all" keeps it). Best-effort.
                            const rawVerify = (args as { verify?: unknown })?.verify;
                            const verify = rawVerify === true ? "viewport" : typeof rawVerify === "string" ? rawVerify : null;
                            // `pipe` scans the text-verify Markdown (text/text-all only) — threaded to the page.
                            const navPipe = typeof (args as { pipe?: unknown })?.pipe === "string" ? (args as { pipe: string }).pipe : undefined;
                            if (verify && !navBarrier.isNavigating(tabId)) {
                                const text = verify === "text" || verify === "text-all";
                                const payload = verify === "text" ? { runId, verifyText: "strip" as const, verifyPipe: navPipe }
                                    : verify === "text-all" ? { runId, verifyText: "all" as const, verifyPipe: navPipe }
                                    : { runId, verifyViewport: true };
                                // A screenshot of the destination for a run whose vision is the worker's is taken here, pinned to
                                // the document the tab holds now: the one the navigation landed on and that re-adopted the run.
                                // The Markdown is still the page's, and is all a page answer may carry into this run.
                                const v = !text && workerVision()
                                    ? await verifyHere(await topDocument(tabId), { kind: "viewport" }, "navigated").then((o) => ({ result: o.content, image: o.image, imageLabel: o.imageLabel, feedback: o.feedback, subUsage: o.subUsage }), () => null)
                                    : await delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload }).then((e) => (workerVision() ? withoutPageVision(e) : e), () => null) as Partial<import("../contract").PageToolEnvelope> | null;
                                if (v && (v.image || v.feedback || v.result)) {
                                    if (v.result) env.result = `${env.result || ""}\n\n${v.result}`;
                                    env.image = v.image; env.imageLabel = v.imageLabel; env.feedback = v.feedback;
                                    addSub(v.subUsage);
                                }
                            }
                            // `pipe` only filters the TEXT verify — if it was passed WITHOUT verify:"text"/"text-all"
                            // (a "viewport" screenshot, or no verify at all), say so instead of silently dropping it.
                            if (navPipe && verify !== "text" && verify !== "text-all" && env)
                                env.result = `${env.result || ""}\n\n(Note: your \`pipe\` was NOT applied — it filters only the verify:"text"/"text-all" Markdown. ${verify === "viewport" ? "You requested a \"viewport\" screenshot, which can't be piped." : "You didn't request a text verify."} Re-navigate with verify:"text" to use it.)`;
                        }
                    }
                    // RESERVED-surface click: the page couldn't synth-click a cross-origin iframe / sealed
                    // shadow target and handed back a CDP-click coordinate. The click was ALREADY approved
                    // above, and the trusted background performs the CDP click (the page can't). Gated on
                    // the off-by-default `cdpClick` flag (cdpClick() itself checks the debugger permission).
                    if (env?.cdpClick) {
                        const cfg = await getConfig();
                        if (!cfg.cdp) return { result: `${env.result || ""}\n\nThis needs a debugger (CDP) click, which is OFF — enable "Debugger-based actions (CDP)" in window.ml Settings → Advanced (cross-origin iframes / sealed shadow roots).`, renderIn: env.renderIn, renderOut: env.renderOut };
                        const r = await cdpClick(tabId, env.cdpClick.x, env.cdpClick.y);
                        const ok = "ok" in r;
                        if (!ok) return { result: (r as { error: string }).error, renderIn: env.renderIn, renderOut: env.renderOut };
                        // The click succeeded. If `verify` was asked, ring the PAGE back to capture the area at
                        // the click point NOW (it couldn't run inline — the click was deferred to us). Merge its
                        // image/description/feedback so the model gets the result in THIS step, not a stray look().
                        // Whether to verify is the MODEL's word for a run whose vision is the worker's, never the page's flag.
                        const wantVerify = workerVision() ? verifyAsked(name, args as Record<string, unknown>) : !!env.cdpClick.verify;
                        const { vres = "", vimg, vimgLabel, vfeedback } = wantVerify
                            // The point is the page's word: checked as a request of this call would be.
                            ? await ringVerify(checkVerifyRequest({ kind: "area", center: { x: env.cdpClick.x, y: env.cdpClick.y } }, { name, args: args as Record<string, unknown> }), "clicked", { verifyAt: { x: env.cdpClick.x, y: env.cdpClick.y } })
                            : { vres: "" };
                        // Append the page-side stuck-loop re-snap nudge (a repeat @pt click) to the SUCCESS result.
                        const tail = wantVerify ? "" : " Re-run look to see the result.";
                        return { result: `Clicked the reserved target at (${env.cdpClick.x}, ${env.cdpClick.y}) via the debugger.${tail}${env.cdpClick.hint || ""}${vres}`, image: vimg, imageLabel: vimgLabel, feedback: vfeedback, renderIn: env.renderIn, renderOut: env.renderOut };
                    }
                    // SEALED-SHADOW click: a `>>>` selector targeted content inside a closed/declarative shadow
                    // root the page couldn't enter. The click was ALREADY approved above; the trusted background
                    // RESOLVES the selector via CDP (which pierces closed roots) to a viewport coordinate, then
                    // CDP-clicks it — so a sealed root never dead-ends at locate/@pt. Same `cdp`-flag gate + verify
                    // ring-back as the reserved cdpClick path above.
                    if (env?.cdpShadowClick) {
                        const cfg = await getConfig();
                        if (!cfg.cdp) return { result: `${env.result || ""}\n\nReaching a sealed shadow root needs a debugger (CDP) click, which is OFF — enable "Debugger-based actions (CDP)" in window.ml Settings → Advanced.`, renderIn: env.renderIn, renderOut: env.renderOut };
                        const resolved = await cdpShadowResolve(tabId, env.cdpShadowClick.selector);
                        if ("error" in resolved) return { result: `${env.result || ""}\n\n${resolved.error}`, renderIn: env.renderIn, renderOut: env.renderOut };
                        const m = resolved.matches[env.cdpShadowClick.index || 0];
                        if (!m) return { result: `${env.result || ""}\n\nThe debugger couldn't reach "${env.cdpShadowClick.selector}" inside the sealed shadow root (no match). Check the selector, or fall back to locate/@pt.`, renderIn: env.renderIn, renderOut: env.renderOut };
                        const r = await cdpClick(tabId, m.cx, m.cy);
                        if (!("ok" in r)) return { result: (r as { error: string }).error, renderIn: env.renderIn, renderOut: env.renderOut };
                        const wantVerify = workerVision() ? verifyAsked(name, args as Record<string, unknown>) : !!env.cdpShadowClick.verify;
                        const { vres = "", vimg, vimgLabel, vfeedback } = wantVerify
                            ? await ringVerify({ kind: "area", center: { x: m.cx, y: m.cy } }, "clicked", { verifyAt: { x: m.cx, y: m.cy } })
                            : { vres: "" };
                        const tail = wantVerify ? "" : " Re-run look to see the result.";
                        return { result: `Clicked ${m.line} inside a sealed shadow root via the debugger (at ${m.cx}, ${m.cy}).${tail}${vres}`, image: vimg, imageLabel: vimgLabel, feedback: vfeedback, renderIn: env.renderIn, renderOut: env.renderOut };
                    }
                    // TRUSTED KEYBOARD: type into a canvas / WebGL / remote-desktop surface or a sealed field
                    // via CDP (real, isTrusted key events synthetic KeyboardEvents can't produce). Focus modes:
                    // a sealed `>>>` selector (CDP-resolve → click to focus) · an `@pt` (CDP-click to focus) ·
                    // or NEITHER (the page's current focus). Same `cdp`-flag gate + verify ring-back as cdpClick.
                    if (env?.cdpType) {
                        const cfg = await getConfig();
                        if (!cfg.cdp) return { result: `${env.result || ""}\n\nTrusted keyboard input (for a canvas / WebGL / remote-desktop / sealed target) needs a debugger (CDP), which is OFF — enable "Debugger-based actions (CDP)" in window.ml Settings → Advanced.`, renderIn: env.renderIn, renderOut: env.renderOut };
                        const t = env.cdpType;
                        // WHAT is typed is the MODEL's: `args.text` and `args.submit`, the call the human approved. The
                        // page's reply only says WHERE (focus / a point / a sealed selector); its `text`/`submit` are an
                        // echo the page could change, so they are never read. The page's type tool hands `text` over
                        // verbatim, so an honest page types exactly the same keys.
                        const own = args as { text?: unknown; submit?: unknown };
                        if (name !== "type" || typeof own.text !== "string") return { result: `Error: the page asked for a trusted (debugger) type the "${name}" call did not make; nothing was typed.`, renderIn: env.renderIn, renderOut: env.renderOut };
                        const text = own.text, submit = own.submit === true;
                        let fx = t.x, fy = t.y, where = "the page's current focus";
                        if (t.selector) {
                            const resolved = await cdpShadowResolve(tabId, t.selector);
                            if ("error" in resolved) return { result: `${env.result || ""}\n\n${resolved.error}`, renderIn: env.renderIn, renderOut: env.renderOut };
                            const m = resolved.matches[t.index || 0];
                            if (!m) return { result: `${env.result || ""}\n\nThe debugger couldn't reach "${t.selector}" inside the sealed shadow root (no match).`, renderIn: env.renderIn, renderOut: env.renderOut };
                            fx = m.cx; fy = m.cy; where = `${m.line} (sealed shadow root)`;
                        } else if (typeof fx === "number" && typeof fy === "number") { where = `the target at (${fx}, ${fy})`; }
                        // Establish focus with a TRUSTED click when we have a coordinate (@pt or a resolved sealed field).
                        if (typeof fx === "number" && typeof fy === "number") {
                            const c = await cdpClick(tabId, fx, fy);
                            if (!("ok" in c)) return { result: (c as { error: string }).error, renderIn: env.renderIn, renderOut: env.renderOut };
                        }
                        const typed = await cdpKeyType(tabId, text, submit);
                        if (!("ok" in typed)) return { result: (typed as { error: string }).error, renderIn: env.renderIn, renderOut: env.renderOut };
                        const wantVerify = workerVision() ? verifyAsked(name, args as Record<string, unknown>) : !!t.verify;
                        let verified: { vres: string; vimg?: string; vimgLabel?: string; vfeedback?: import("../contract").ToolFeedback } = { vres: "" };
                        if (wantVerify) {
                            // The verify PICTURE: the whole element (selector/canvas → verifyElement), the focused
                            // element (@focus → verifyFocus), else the point crop (an @pt / sealed field, by coords).
                            const payload = t.verifyElement ? { verifyElement: t.verifyElement }
                                : t.verifyFocus ? { verifyFocus: true }
                                : typeof fx === "number" && typeof fy === "number" ? { verifyAt: { x: fx, y: fy } }
                                : { verifyViewport: true };
                            // In the worker the target is the call's own: `@focus` is the focused element, a page-named element
                            // must be the call's selector and index (checkVerifyRequest), a point is where the worker typed.
                            const sel = String((args as { selector?: unknown }).selector ?? "").trim();
                            const req: WorkerVerify | null = sel === "@focus" || sel === "" ? { kind: "focus" }
                                : t.verifyElement !== undefined ? checkVerifyRequest({ kind: "element", selector: t.verifyElement, index: (args as { index?: unknown }).index ?? 0 }, { name, args: args as Record<string, unknown> })
                                : typeof fx === "number" && typeof fy === "number" ? checkVerifyRequest({ kind: "area", center: { x: fx, y: fy } }, { name, args: args as Record<string, unknown> })
                                : { kind: "viewport" };
                            // A point keeps the page ring-back's verb ("clicked"): the model is shown what it was shown before.
                            verified = await ringVerify(req, req?.kind === "area" ? "clicked" : "typed", payload);
                        }
                        const { vres, vimg, vimgLabel, vfeedback } = verified;
                        const shown = text.length > 60 ? text.slice(0, 60) + "…" : text;
                        const tail = wantVerify ? "" : " Re-run look to see the result.";
                        return { result: `Typed "${shown}" into ${where} via the debugger (trusted keyboard, additive).${submit ? " Submitted (Enter)." : ""}${tail}${vres}`, image: vimg, imageLabel: vimgLabel, feedback: vfeedback, renderIn: env.renderIn, renderOut: env.renderOut };
                    }
                    // STRICT-PAGE exec: main-world eval was CSP/TT-blocked and the page handed back a cdpExec
                    // signal. UNFORGEABLE: we re-run the exact source the human APPROVED — `args.js`, from the
                    // gate above — NEVER the page-echoed `env.cdpExec.source`, so this can only ever execute
                    // the approved code; and there is no page-reachable CDP-exec message, so the ONLY path is
                    // here, after the approval. No approved `js` → refuse (never CDP-eval a page value).
                    if (env?.cdpExec) {
                        const approvedSource = typeof (args as { js?: unknown })?.js === "string" ? (args as { js: string }).js : null;
                        if (!approvedSource) return { result: env.result || "", renderIn: env.renderIn, renderOut: env.renderOut };
                        const cfg = await getConfig();
                        if (!cfg.cdp) return { result: `${env.result || ""}\n\nRunning it needs Debugger-based actions (CDP), which are OFF — enable them in window.ml Settings → Advanced (the debugger clears the page's CSP/Trusted-Types), or fall back to a read-only survey / ml.fetch.`, renderIn: env.renderIn, renderOut: env.renderOut };
                        const r = await cdpEval(tabId, approvedSource, onStream);
                        if ("ok" in r) {
                            // Rebuild the Out cell from the CDP run's own console/value. `env.renderOut` is
                            // the page's CSP-BLOCKED render (an exec-out carrying that error), so forwarding
                            // it would show a red "this page blocks eval" next to a successful result — and
                            // would wipe the output the user just watched stream in.
                            const kept = r.logs.join("\n");
                            const stdout = r.dropped ? `${kept}\n${ceilingNote(r.dropped)}` : kept;   // past the ceiling, its last line says so
                            const seen = Math.min(kept.length, CDP_EXEC_CAP);
                            return { result: r.text, renderIn: env.renderIn,
                                renderOut: { type: "exec-out", stdout: clipHeadTail(stdout, UI_OUT_CAP, panelHead(CDP_EXEC_CAP)), ...(stdout.length > UI_OUT_CAP ? { capture: clipOut(stdout, UI_OUT_CAP) } : {}), seen, value: r.value } };
                        }
                        return { result: `${env.result || ""}\n\n${r.error}`, renderIn: env.renderIn, renderOut: env.renderOut };
                    }
                    // The verify of a click/type/wait in a run whose vision is the worker's: the page asked for it as data, and
                    // the worker takes it, pinned to the document the action ran in. A request the model did not ask for is
                    // dropped; a malformed one skips the verify with a fixed note.
                    // A page that sends no request for a verify the model asked for gets the fixed note, never silence.
                    if (env && !workerMade && workerVision() && verifyAsked(name, args as Record<string, unknown>)) {
                        if (env.verifyRequest !== undefined) {
                            const req = checkVerifyRequest(env.verifyRequest, { name, args: args as Record<string, unknown> });
                            const v = req ? await verifyHere(await actionDoc(), req, verifyVerb(name)) : { content: VERIFY_REFUSED } as VerifyOutcome;
                            addSub(v.subUsage);
                            env = { ...env, result: (env.result || "") + v.content, image: v.image, imageLabel: v.imageLabel, feedback: v.feedback };
                        } else env = { ...env, result: (env.result || "") + VERIFY_WITHHELD };
                    }
                    // The page already computed the rendered In/Out slots (descriptorFor) — forward them so
                    // the sidebar shows the rich view. `image` rides along for INLINE VISION (native look):
                    // the loop injects it into the model's next turn (pushToolImages).
                    return { result: (env?.result || `Error: the page returned nothing for tool "${name}".`) + (execNote ? `\n\n${execNote}` : ""), renderIn: env?.renderIn, renderOut: env?.renderOut, feedback: env?.feedback, image: env?.image, imageLabel: env?.imageLabel, images: env?.images, remoteMs: env?.remoteMs };
                } finally {
                    dropCallGrants(tabId, callKey);   // grants were for THIS approved call's sub-ops only; another run's call on the tab keeps its own
                    if (pyInWorker) grantRunPython(runId, null);
                    if (reads) execReads.delete(runId);
                    if (onStream) delegateStreams.delete(runId);   // the call is done — stop routing live chunks to it
                }
            },
            // Pre-run In render for a PENDING step (streaming runs): ask the page to compute the tool's
            // In descriptor without running it, so a step you watch stream shows exec's beautified JS /
            // python's code cell from the start instead of raw JSON args. Best-effort — raw args on failure.
            renderFor: async (name, args) => {
                // exec's In is pure (the page draws it with the same function), so the worker draws it: the script is
                // the model's text and may carry what it read elsewhere, which a step that never runs there should not
                // lend the page (docs/spec/SITE_ACCESS.md slice 2).
                if (name === "exec" && typeof args.js === "string") return execCodeIn(args.js);
                const env = await sendTool({ runId, name, args, renderOnly: true })
                    .catch(() => null) as { renderIn?: import("../contract").RenderDescriptor } | null;
                return env?.renderIn;
            },
            // Read-only try (exec only, and only when the user enabled autoApproveReadonly): ask the
            // page to run the call through the mediated interpreter — side-effect-free, so if it's
            // in-dialect it BOTH auto-approves AND returns the result, and the human gate is skipped.
            // Keep this run's pointer resolver: a survey reads it here (worker-readonly-ml.ts), and an approved exec
            // gets the reads its script names resolved by it (preReadsFor). Dropped in the run's finally.
            tokenSink: (fn) => { derefByRun.set(runId, fn); },
            // The live context, for `ml.current` and the state inspector (contextByRun). Per turn, like the resolver.
            contextSink: (fn) => { contextByRun.set(runId, fn); },
            // A pointer to a stored table: this session holds it until the session is released.
            claimValue: (key) => claimValue(key, runId),
            tryReadonly: p.autoApproveReadonly ? async (name, args, live) => {
                if (name !== "exec") return null;
                // The WORKER first (docs/spec/SITE_ACCESS.md slice 2): a survey that reads only the run and the box is
                // answered here, where the run's context and pointers live, and never enters the page. One that reaches
                // for the page comes back `needs-page` and goes there, where pointer reads are refused, so a survey that
                // needs both reaches the person.
                // `selfIntrospection` off: no `ml.current` at all (a survey naming it then goes to the page, where it refuses).
                const snap = p.selfIntrospection === false ? undefined : contextByRun.get(runId);
                const wantsLog = typeof args.js === "string" && /\bcurrent\b/.test(args.js);
                const log = snap && wantsLog ? eventsForRun(await runLog.all(), runId) : [];
                // Made once, here, only for a script that names `current`: the person's shared watches are evaluated
                // into it (sw-shared-watches.ts), which is async, and the evaluator asks for the snapshot synchronously.
                // A snapshot that cannot be made is not the run's end: the survey falls through to the person.
                let current: import("../agent/current-context").CurrentSnapshot | undefined;
                try { current = snap && wantsLog ? await withEnv(await withUserWatches(snap({ model: modelNow(), log })), tabId, !!p.autoApproveReadonly) : undefined; } catch (e) {
                    recordRunLog(runId, { level: "warn", subsystem: "routing", kind: "current-failed", reason: e instanceof Error ? e.message || e.name : String(e), detail: { tool: name } });
                    return null;
                }
                const w = await evalReadonlyInWorker(args, {
                    ...(snap ? { current: () => current ?? snap({ model: modelNow(), log }) } : {}),
                    ml: workerReadonlyMl(tabPageUrl.get(tabId) ?? "", derefByRun.get(runId), runId),
                    live,
                });
                if (w.kind !== "needs-page") {
                    recordRunLog(runId, { subsystem: "routing", kind: "readonly-worker", reason: w.kind === "answered" ? "no-page-reads" : "out-of-dialect", detail: { tool: name } });
                    return w.kind === "answered" ? { result: w.result, renderIn: w.renderIn, renderOut: w.renderOut } : null;
                }
                // Live console lines reach the loop's fan the way a delegated tool's do (delegateStreams). Dropped
                // BEFORE returning, so a chunk still in flight from a refused try cannot land after the loop's
                // discard: it finds no sink.
                if (live) delegateStreams.set(runId, live.push);
                try {
                    const answerShape = workerAnswer ? await answerShapeFor(runId) : undefined;
                    const env = await sendTool({ runId, name, args, readonlyTry: true, stream: !!live, ...(answerShape ? { answerShape } : {}) }, live?.push)
                        .catch(() => null) as Partial<import("../contract").PageToolEnvelope> | null;
                    // Only an answered survey's changes count: a refused try leaves nothing behind, as on the page.
                    if (answerShape && env?.readonly && env.answerOps !== undefined) await replayOps(env.answerOps);
                    recordRunLog(runId, { subsystem: "routing", kind: "readonly-page", reason: env?.readonly ? "reads-page" : "refused-in-page", detail: { tool: name } });
                    return env && env.readonly ? { result: env.result || "", renderIn: env.renderIn, renderOut: env.renderOut, reused: env.reused } : null;
                } finally {
                    if (live) delegateStreams.delete(runId);
                }
            } : undefined,
            // Doomed-action precheck (click/type): ask the page to resolve the target side-effect-free.
            // A non-null error → the gate is SKIPPED and the error returned. Only delegated for tools
            // that HAVE a precheck (avoids a useless round-trip on every gated call).
            precheck: async (name, args) => {
                // A worker-built run's python_exec that names BOTH an external sheet and something only the page can
                // supply (an image, a selector, `current`) cannot run anywhere safely: the worker cannot read the page
                // part, and sending it to the page would put the sheet grant on the TAB, where any script on it could
                // spend it while the call ran. So it runs nowhere — refused here, BEFORE the gate, rather than putting
                // the person through approving a call that must then fail (red-team T3 on #442).
                const mixed = mixedPythonRefusal(name, args);
                if (mixed) return mixed;
                if (!p.tools.some((t) => t.name === name && t.precheck)) return null;
                const env = await sendTool({ runId, name, args, precheck: true })
                    .catch(() => null) as Partial<import("../contract").PageToolEnvelope> | null;
                return env && env.precheckFailed ? (env.result || "") : null;
            },
            approve: async ({ tool, arguments: args, seq, step }) => {
                // Ask the page to compute the In render for THIS call (without running the tool) so the
                // blocking approval shows a pretty In — exec's beautified JS, python's code cell — not
                // raw args. Best-effort: raw args on any failure. (Out has nothing to render pre-run.)
                let renderIn: unknown = tool === "exec" && typeof args.js === "string" ? execCodeIn(args.js) : undefined;
                if (!renderIn) try {
                    const env = await sendTool({ runId, name: tool, args, renderOnly: true }) as { renderIn?: unknown };
                    renderIn = env?.renderIn;
                } catch { /* page gone → no preview, fall back to raw args */ }
                // Key by the OFFSET seq — the same value the app sees on the emitted step (emitStep
                // offsets raw→seqBase+raw) and echoes back in SET_APPROVAL. Keying by the raw seq meant a
                // follow-up turn (seqBase>0) never matched → the gate hung forever ("stuck on Approve" on
                // turn 2+). Turn 1 worked only because seqBase==0. (Mirror emitStep's null-guard exactly.)
                const gateSeq = seq != null ? seqBase + seq : seq;
                const key = `${runId}:${gateSeq}`;
                // button #3: statically extract the persistable egress grants (e.g. this exec's inline
                // ml.fetch literals) ONCE, background-side. The SAME list feeds the descriptor/step the
                // human reviews AND the persistence below, so what's shown IS what's remembered.
                const grants = extractGrants(tool, args);
                // A worker tool's approval is granted to the run's state in this worker (worker-tools.ts), rebuilt here
                // if an eviction took it, so the decision below has somewhere to put it.
                if (p.builtBy === "worker" && runsInWorker(p, tool)) await ensureLocalTools(runId, p, tabId, () => tabPageUrl.get(tabId) || p.pageUrl || "").catch(() => { /* nothing granted: fails closed */ });
                return new Promise<ApprovalDecision>((resolve) => {
                    pendingApprovals.set(key, {
                        resolve: (decision) => {
                            const ok = decision === true || (typeof decision === "object" && !!decision && decision.approved);
                            if (ok && tool === "python_exec") for (const id of externalSheetIds(args)) approvedSheets.add(id);
                            // Approving a cross-origin nav consents to that ORIGIN for the rest of the run
                            // (repeat navs to it then skip the gate).
                            if (ok && tool === "navigate") { try { consentedOrigins.add(new URL(String((args as { url?: unknown }).url ?? "")).origin); } catch { /* relative/bad url — nothing to remember */ } }
                            // Approving a fetch_url: a CREDENTIALED one (fetch-as-the-user — raw cookies, or a
                            // rendered load in your session) mints a ONE-TIME grant, NEVER persisted, so it
                            // always re-prompts. An UNCREDENTIALED one (a raw uncredentialed GET, or an
                            // INCOGNITO rendered load — no session, lower risk) consents to that EXACT url for
                            // the session (repeat fetches auto-approve — the rememberable path).
                            if (ok && tool === "fetch_url") {
                                const u = String((args as { url?: unknown }).url ?? "");
                                const cred = !!(args as { credentials?: unknown }).credentials;
                                // A worker-built run's fetch_url runs in the worker: its approval is the RUN's, so no
                                // script on the tab can use it (worker-tools.ts `grantRunFetch`), and it is NEVER minted
                                // on the tab, even when this worker lost the run's state (an eviction): then nothing is
                                // granted and the call is refused, rather than lent to the page. Else the tab's.
                                if (u && p.builtBy === "worker" && runsInWorker(p, "fetch_url")) grantRunFetch(runId, u, cred);
                                else if (u) { if (cred) grantCredFetch(tabId, u); else consentFetch(tabId, u); }
                            }
                            // button #3: "Approve + remember" — also persist the exec's static ml.fetch
                            // literals for the session (a positive `persist` decision only).
                            if (ok && typeof decision === "object" && decision.persist) persistGrants(tabId, grants);
                            // Clear the gate on EVERY surface the INSTANT it's decided — not only when the
                            // tool's DONE lands (which for a slow fetch is seconds off). Without this, a
                            // second UI (the other of DevTools panel / HUD card) kept showing approve/deny
                            // until the tool finished. This patches the pending step to non-awaiting on all
                            // surfaces (same seq); the DONE later fills the result. Fired BEFORE resolve() so
                            // it precedes the tool run.
                            // A CANCEL (Stop) resolves the gate with `{ cancelled:true }` — show "cancelled",
                            // not "denied", so a Stop doesn't flash a false accusation before the loop's own
                            // cancelled DONE lands.
                            const cancelledDecision = typeof decision === "object" && !!decision && !!decision.cancelled;
                            emitStep({ step, seq, pending: true, awaitingApproval: false, approval: cancelledDecision ? "cancelled" : ok ? "user" : "denied", tool, arguments: args });
                            resolve(decision);
                        },
                        // What the external approver sees when it enumerates gates (the UI shows the same
                        // via the emitStep below). args are already sanitized page-side for the render.
                        descriptor: { key, runId, seq: gateSeq ?? -1, step: step ?? -1, tool, arguments: args, ts: Date.now(), routing: p.approvalRouting || "ui" },
                    });
                    // Patch the pending step to show approve/deny (awaitingApproval) + the In preview. ALL
                    // three surfaces render it identically from this one step: overlay/off in the page
                    // iframe (slide-out panel vs corner card), devtools in the panel. The off-mode card
                    // reveals ITSELF on this step — no separate modal message — and the decision returns via
                    // the same origin-authed SET_APPROVAL, so the gate is unforgeable across every surface.
                    // approvalRouting "external" SUPPRESSES the UI buttons (the gate still blocks — only the
                    // __mlApprovals channel resolves it); "ui"/"both" show them as before.
                    emitStep({ step, seq, pending: true, awaitingApproval: p.approvalRouting !== "external", approvalExternal: p.approvalRouting === "external" || undefined, tool, arguments: args, renderIn, grants: grants.length ? grants : undefined });
                });
            },
            isSheetApproved: (id) => approvedSheets.has(id),
            navNeedsConsent,   // cross-origin nav → gate; same-site / already-consented → auto (see consentedOrigins)
            fetchNeedsConsent: (url) => !(runFetchConsented(runId, url) ?? fetchConsent.get(tabId)?.has(url)),   // a NEW url → gate; an already-approved one → auto
            // An UNCREDENTIALED fetch to an origin the run is at / has been consented to (relative, or in
            // consentedOrigins — seeded with the start origin) is FREE: the page can already fetch its own
            // origin, so it's no escalation. Used by the auto-approve (no prompt), like a same-origin navigate.
            // The page the run's tab is on NOW (not where it started — a run navigates). Only skips a prompt:
            // the FETCH_URL handler still judges an as-you read against the sender's real frame URL, so a
            // stale entry here can at worst ask for nothing or be refused there, never grant a read.
            fetchIsCurrentPage: (url: string): boolean => {
                const here = tabPageUrl.get(tabId) ?? p.pageUrl;
                return !!here && isCurrentPage(url, here);
            },
            fetchSameOrigin: (url: string): boolean => {
                try {
                    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !url.startsWith("//")) return true;   // relative → the page's own origin
                    return consentedOrigins.has(new URL(url.startsWith("//") ? "https:" + url : url).origin);
                } catch { return false; }
            },
            checkpoint: (messages) => {
                persistRun(runId, { p, tabId, messages, sub: snapSub() });   // durable resume snapshot per step
                // And the same history where a SAVED session keeps it. The snapshot above dies with the run
                // (it is deleted on settle, and is stale after five minutes); this one lives as long as the
                // session does, which is what `session.resume` needs from a run that ended yesterday.
                saveRunHistory(runId, { messages, payload: p, sub: snapSub() });
            },
            // This turn's delegated vision sub-call tally (accumulated from each delegated tool's envelope
            // delta in delegateTool) — so chat_metadata reports the real number on the background path too.
            subcallTokens: () => snapSub(),
            emit: (ev) => emitStep(ev as Record<string, unknown>),
            // "The model started" — see DebugAgentTurn. Fires on every run, streamed or not; the
            // streaming path re-fires it on each phase change with the marks so far.
            emitTurn: (ev) => emitTurn(ev.step, ev.phases),
            drainInbox: () => {   // a.say() steering (INJECT_MESSAGE); draining flips the "seen" indicator
                const items = (runInboxes.get(runId)?.queue || []).splice(0);
                for (const it of items) if (it.id) fanEvent({ kind: "agent-say-seen", id: runId, ts: Date.now(), save: false, session: { hash: runId, turn: 0 }, sayId: it.id });
                // Each says where it was typed, so a run steered from another surface reports THAT one.
                return items.map(it => (it.origin ? { text: it.text, origin: it.origin } : it.text));
            },
            signal: abortCtl.signal,
            // chat_metadata: the run's model FACTS from the SW's caches (the loop supplies the live
            // token/message counts). The SW can also read the URL → name the backend. Degrades to null.
            chatMeta: async () => {
                const model = modelNow() || null;
                const est = (s: unknown) => (s ? Math.round(String(s).length / 4) : 0);   // ~chars/4, no tokenizer
                let toolJson = ""; try { toolJson = JSON.stringify(p.tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }))); } catch { /* skip */ }
                const config = await getConfig();
                const fmt = config.apiFormat, url = config.chatUrl || "";
                const backend = fmt === "ollama" ? "Ollama (native)"
                    : /open-?webui|\/api\/chat\/completions/i.test(url) ? "OpenWebUI (server-side tools available)"
                    : "OpenAI-compatible";
                const overhead = { systemTokens: est(p.systemPrompt), toolTokens: est(toolJson), backend };
                if (!model) return { model, contextWindow: null, capabilities: null, userFocus: await focusLineFor(runId, tabId, "coarse").catch(() => null), ...overhead };
                const [capabilities, resident] = await Promise.all([
                    modelCapabilities(config, model).catch(() => null),
                    residentModels(config).catch(() => [] as { model?: string; name?: string; context_length?: number; size_vram?: number }[]),
                ]);
                const norm = (s: string) => s.replace(/:latest$/, "");
                const lm = resident.find(x => x.model === model || x.name === model || norm(x.model || x.name || "") === norm(model));
                const contextWindow = lm && typeof lm.context_length === "number" ? lm.context_length : null;
                const vramBytes = lm && lm.size_vram ? lm.size_vram : null;
                const local = capabilities !== null;   // caps came back from Ollama /api/show → resident/local
                // The machine (devices and memory, /api/info) — asked only for a LOCAL model; null where the route is missing.
                const capacity = local ? await fetchOllamaInfo().then((raw) => (raw ? parseInfo(raw) : null)).catch(() => null) : undefined;
                // Coarse: the run executes through this tab's page, which reads what the tool answers.
                const userFocus = await focusLineFor(runId, tabId, "coarse").catch(() => null);
                return { model, contextWindow, capabilities, vramBytes, local, capacity, userFocus, ...overhead };
            },
        },
    )
        .then(async ({ result: res, messages }) => {
            // Keep the run resumable: stash its full history + payload (deps rebuild from it) so a later
            // RESUME_RUN can continue it. Overwrites the prior turn's snapshot (same runId). SW-eviction
            // may drop this — resume then reports an actionable error (see bgRuns). `sub` carries the
            // cumulative sub-call tally so a resumed turn's chat_metadata keeps reporting the session total.
            // ADVANCE the stored step/seq base past THIS turn's extents: a follow-up that routes through
            // RESUME_RUN (a HUD composer follow-up AFTER the run navigated — the page handle died, so it goes
            // agentRegistry.resume → RESUME_RUN, not the page's control.stepBase path) must continue AFTER the
            // prior turns. Without this it reused base 0 and the new turn's steps collided at step/seq 1 with
            // turn 1's — the reducer patches by seq, so the follow-up's tool steps OVERWROTE turn 1's and
            // vanished from the sidebar/panel (and scrambled the export's chat-log order).
            // A run handed to the worker while this turn ran (`makeWorkerRun`) stays the worker's: `p` is the turn's
            // start payload, written before the hand-over, and storing it as it is would give the run back to the page.
            const handed = p.builtBy !== "worker" && isWorkerRun(runId)
                ? { builtBy: "worker" as const, ...(p.rebuild ? { rebuild: { ...p.rebuild, builtBy: "worker" as const } } : {}) } : {};
            const resumeP = { ...p, ...handed, stepBase: stepBase + runMaxStep, seqBase: seqBase + runMaxSeq };
            bgRuns.set(runId, { p: resumeP, tabId, messages, sub: snapSub() });
            // The same snapshot `bgRuns` holds, where it outlives the run: `resumeP` so a later turn continues
            // AFTER this one's steps rather than colliding with them.
            saveRunHistory(runId, { messages, payload: resumeP, sub: snapSub() });
            let answerMedia = runAnswerMedia.length ? runAnswerMedia : undefined;
            // A run the WORKER built has no page-side caller to assemble the turn's curated answer from the page's
            // answer set, so it is asked for here. Page data, exactly as a tool result is; absent if the page is gone.
            // Close the inbox FIRST: a message sent while the page is asked for the answer must not be reported as a
            // steer into an inbox nothing reads any more (it reads as "busy", and the person sends it again).
            runInboxes.delete(runId);
            const fin = p.builtBy === "worker"
                ? await delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload: { runId, finish: true, summary: res.summary } }).catch(() => null) as Partial<import("../contract").PageToolEnvelope> | null
                : null;
            // A worker-built run's answer is the worker's set (worker-answer.ts); the page's finish only ends its registration.
            const own = p.builtBy === "worker" ? await answerFor(runId) : undefined;
            const answer = own ? (finalizeAnswer(own, res.summary) || undefined) : typeof fin?.answer === "string" && fin.answer ? fin.answer : undefined;
            if (own) { const m = own.media(); answerMedia = m.length ? m : undefined; }
            emitLifecycle({
                kind: "agent-result", id: runId, ts: Date.now(), save: false, session: { hash: runId, turn: res.steps },
                summary: res.summary, steps: res.steps, hitCap: !!res.hitCap, cancelled: !!res.cancelled, answerMedia,
                ...(answer ? { answer } : {}),
            });
            // Sync the run's final history back so a createAgent handle's control.messages stays live,
            // + this run's step/seq extents so the page advances its bases for the NEXT turn's offset. The
            // answer element visuals ride on `res` too, so the page-side caller's own agent-result carries them.
            sendResponse({ data: { ...res, answerMedia }, messages, stepCount: runMaxStep, seqCount: runMaxSeq });
        })
        .catch((err) => {
            // A fatal loop error — surface it to the off-mode card (the page's bus is dormant there,
            // so injected can't), then reject the round-trip (injected re-throws → ml.agent rejects).
            emitLifecycle({
                kind: "agent-result", id: runId, ts: Date.now(), save: false, session: { hash: runId, turn: 0 },
                summary: "", steps: 0, hitCap: false, error: err?.message || String(err),
            });
            sendResponse({ error: err?.message || String(err) });
        })
        .finally(() => { runControllers.delete(runId); runInboxes.delete(runId); untrackRun(tabId, runId); deleteRun(runId); releaseDebugger(tabId); });   // detach the run's CDP debugger (attached once, reused across execs/clicks)
}

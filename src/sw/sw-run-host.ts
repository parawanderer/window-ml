// sw-run-host.ts — hosting ONE background agent run: the loop runs at the extension origin and every tool is
// delegated back to the page that built the toolset (RUN_TOOL_IN_PAGE), with approval gated through the sidebar.
// This is design A, and it is the whole of it: the router in background.ts only hands a START_RUN / RESUME_RUN
// over and keeps the channel open until the run finishes.

import { runBackgroundAgent } from "../agent/agent-host";
import { pythonCellInDialect, pythonOutsideWhy } from "../agent/python-dialect";
import { namesJsBridge } from "../python/bridge-names";
import { evalReadonlyInWorker } from "./sw-readonly";
import { deletePythonRun, markPythonBridged, pythonRunBridged } from "./sw-python";
import { workerReadonlyMl, derefWhole } from "./worker-readonly-ml";
import { pipeStages } from "../pointers/token-pipe";
import { recordRunLog, runLog } from "./sw-run-log";
import { forModel, forModelHistory, forPage } from "./sw-scrub";
import { eventsForRun, type RunLogEvent } from "../log/run-log";
import { execCodeIn, expandPointers } from "../pointers/pointer-macro";
import { namedReads, type PreRead } from "../pointers/named-reads";
import type { CurrentSnapshot } from "../agent/current-context";
import type { ToolMeta, ToolRunResult } from "../agent/agent-loop";
import type { NeutralMessage, ToolCall, TokenUsage } from "../contract/contract-chat";
import { UI_OUT_CAP } from "../contract/contract-chat";
import { clipHeadTail, panelHead, ceilingNote, pageWorldResult } from "../agent/output-clip";
import type { ApprovalDecision } from "../contract/contract-agent";
import { stepBudget } from "../agent/step-budget";
import { grantableOrigin, originOf } from "../site-access";
import type { StartRunPayload, ResumeRunPayload } from "../contract/contract-messages";
import { type MlConfig, modelFilterAllows } from "../contract/contract-config";
import { withPageContext } from "../agent/run-assembly";
import { workerPageContext } from "../agent/site-instructions";
import { ourToolTexts } from "./builtin-texts";
import { type RequestHint, hintSession } from "../contract/contract-run";
import { externalSheetIds, clipOut, isCurrentPage } from "../dom/dom";
import { sealedDescribe } from "../tools/tools";
import { extractGrants, fetchUrlLiterals, tabGrantsForCall } from "./grant-extract";
import { parseInfo } from "../resource/resource-capacity";
import { cdpClick, cdpShadowResolve, cdpKeyType, cdpEval, releaseDebugger } from "./sw-cdp";
import { grantsFor, dropCallGrants, serverToolKey, pendingApprovals, grantCredFetch, grantOnceFetch, consentFetch, fetchConsent } from "./sw-consent";
import { ASK_POLICY_CAUSE, judgeCall, fetchFacts, navigateFacts, rememberFetchUrls, withPolicies, addRunPolicy, askWhyOf, askedByPolicy, withoutAsked, takeArchiveNotice } from "./sw-policies";
import { checkProposal, recordedFetches, measureBreadth, breadthNote, type PolicyProposal } from "./policy-proposal";
import { approveManifest, checkManifestProposal, draftCardNote, type CheckedManifest } from "./sw-manifest-proposal";
import { approveLibrary, checkLibraryProposal, isLibraryDraft, precheckLibrary, type CheckedLibrary } from "./sw-library-proposal";
import { isExtensionSender } from "./sw-site-access";
import { relayDebugEvent } from "./sw-debug";
import { streamAgentTurn, fetchLLM, getConfig, modelCapabilities, residentModels, fetchOllamaInfo } from "./sw-llm";
import { ensureLocalTools, noteLocalStep, runLocalTool, runsInWorker } from "./sw-local-tools";
import { lookPreviewArgs, workerLook } from "./worker-look";
import { workerLocate } from "./worker-locate";
import { runVision, workerWroteVision, type RunVision } from "./run-vision";
import { withUserWatches } from "./sw-shared-watches";
import { routeExec, execNames, withoutWorld, worldCardNote, type ExecRoute } from "./exec-routing";
import { defaultExecWorld } from "../contract/contract-config";
import { outputCapPrecheck } from "../contract/contract-pointers";
import { pageWorldRefusal, withExecWorld } from "../tools/tool-details";
import { answerFor, answerShapeFor, applyAnswerOps, resetAnswer, setAnswerSelector } from "./worker-answer";
import { finalizeAnswer, type AnswerShapeItem } from "../pointers/answer-set";
import { withEnv } from "./sw-current-env";
import { withRuntime } from "./sw-current-runtime";
import { isolationAvailable, pageApproved, runIsolatedExec } from "./sw-isolated-exec";
import { handOverSettled } from "./nav-handover";
import { grantRunFetch, grantRunOrigin, runOriginGranted, runOrigins, runFetchConsented, grantRunPython, takePyRefusal, pythonDialectReady } from "./worker-tools";
import { autoApprovePython } from "../agent/auto-approve";
import { pyMediaFor, workerAnswerMedia } from "./worker-media";
import { PROPOSAL_TOOLS, withoutProposals, hydrationDone, isWorkerRun, runRebuilds, navBarrier, bgRuns, runControllers, runInboxes, trackRun, persistRun, bufferReplay, resurrectedRuns, sessionTokens, readoptPageInfo, derefByRun, contextByRun, pageValueSession, turnByRun, execReads, tabPageUrl, untrackRun, deleteRun, runModelFor, startingControllers, beginStart, endStart } from "./sw-runs";
import { ingestSessionEvent, saveRunHistory } from "./sw-sessions";
import { claimValue, runMayClaim, valueHolders, readStoredColumns, readStoredText, withHeldValuesOnly } from "./sw-values";
import { isoServer, type IsoDeps } from "./iso-channel";
import { shRead, shRun, takeShSpans } from "./sw-shell-call";
import { focusLineFor } from "./sw-focus";
import { delegateSend } from "./delegate-send";
import { GATED_BUILTINS } from "../tools/tool-registry";
import { checkVerifyRequest, verifyAsked, verifyVerb, withoutPageVision, workerVerify, VERIFY_REFUSED, VERIFY_WITHHELD, type VerifyOutcome, type WorkerVerify } from "./worker-verify";
import { topDocument } from "./worker-vision";
import { capPageAnswer, capPageContext } from "./page-answer-caps";
import { hostAsks, raiseAsk, stepAsks } from "./sw-asks";
import { ARRIVAL_ASK, ARRIVAL_DENIED } from "../contract";
import { arrivalAnsweredText, arrivalDeniedText, clickDeniedText, arrivalWaitingText, arrivalHold, arrivalLine, arrivalSettled, arrivalVerdict, clearArrival, holdArrival, judgeTurnStart, watchArrivals, watchBetweenTurns } from "./nav-arrival";
import { adoptOnTab } from "./adopt-run";
import { approvalFor, cancelReasons, gatePageTurn, noteRunEnd, noteRunStart, personClaimed } from "./sw-start-approval";
import { pageTurnText } from "../agent-start";

// The model-facing cap cdpEval clips its console to (exec's default per-slot cap) — the UI keeps far more, so
// `seen` marks where the model's copy stopped, exactly like the main-world exec path.
const CDP_EXEC_CAP = 500;

/** The answer to a page's START_RUN, RESUME_RUN or steer for a run the worker holds. */
export const WORKER_RUN_REFUSED = "Refused: this run was started from the extension, and only the extension can drive it.";

/** How long a page's START_RUN or RESUME_RUN waits for the worker to restore its runs before it is refused. */
export const RESTORE_WAIT_MS = 10_000;

/** The answer to a page's START_RUN or RESUME_RUN when the worker's runs are not restored within `RESTORE_WAIT_MS`. */
export const RESTORE_PENDING = "Refused for now: the extension is still restoring its runs. Try again.";

/** What the page that started a turn is answered when its run was handed to the worker during it: no result, no history. */
const HANDED_ANSWER = "This run was handed to the extension: this site may no longer use window.ml, so its result is not sent here.";

/** A tool call built for a page-built run whose run was handed to the worker before the call was sent. */
class HandedOverMidCall extends Error {
    constructor() { super("The run was handed to the worker before this call reached the page."); }
}

/**
 * Run a delegated call, and build it again from the start when its run was handed to the worker while it was being
 * built for the page (`HandedOverMidCall`): a hand-over is one way, so the second build is the worker's.
 * @param call one build and send of the call
 * @returns what the call returned
 */
async function againIfHandedOver<T>(call: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try { return await call(); } catch (e) { if (!(e instanceof HandedOverMidCall) || attempt >= 2) throw e; }
    }
}

/**
 * Run one tool call and attach the `ml.sh` calls it made to its result, for the event lane. A call that throws
 * drops its spans, so they are not left for a later step with the same seq (a resumed turn).
 * @param runId the run
 * @param seq the step's offset seq, or undefined for a call with no step
 * @param tool the dispatch
 * @returns the dispatch's result, with `shCalls` when the step made any
 */
async function withShCalls(runId: string, seq: number | undefined, tool: () => Promise<ToolRunResult>): Promise<ToolRunResult> {
    let r: ToolRunResult;
    try { r = await tool(); } catch (e) { if (seq !== undefined) takeShSpans(runId, seq); throw e; }
    const spans = seq === undefined ? undefined : takeShSpans(runId, seq);
    return spans ? { ...r, shCalls: spans } : r;
}

const STREAM_EMIT_MS = 90;   // min gap between live `agent-stream` deltas — smooth enough to read, not a flood

/** The tab's main-frame document: the barrier's record of the last commit, else the browser's answer (a worker that was
 *  evicted has no record). Undefined where neither knows, and then a re-adopt is judged on the navigation alone. */
async function documentOn(tabId: number): Promise<string | undefined> {
    const known = navBarrier.currentDocument(tabId);
    if (known) return known;
    const frame = await Promise.resolve(chrome.webNavigation?.getFrame?.({ tabId, frameId: 0 })).catch(() => null) as { documentId?: string } | null;
    return typeof frame?.documentId === "string" ? frame.documentId : undefined;
}

/** A thrown value as an execution-log `key`: its message, bounded; never a throw of its own (a value whose conversion
 *  throws is what made the call fail in the first place). */
function thrownKey(e: unknown): string {
    try { return String((e as Error)?.message ?? e).slice(0, 200); } catch { return "unprintable error"; }
}

/** Resolve the pointer reads an approved `exec` script names, against the run's store: each one's value, or the error
 *  the read raises (a MemoryFault, a bad pipe, a stored text that was evicted), which the page then throws where the
 *  script reads it. For an isolated world a stored text is read whole (`derefWhole`), as a survey of the same script
 *  reads it. For the page's MAIN world it is the preview, as before: a pointer-naming script reaches the main world only
 *  where no isolated world is available (exec-routing.ts, the owner's 2026-10-08 fallback), and a page approved for
 *  window.ml is not thereby approved to read the whole of what a run fetched elsewhere (POINTER_VALUES.md, slice 9).
 * @param whole whether a stored text is read whole: true only for an isolated world */
async function preReadsFor(runId: string, js: string, whole: boolean): Promise<PreRead[]> {
    const fn = derefByRun.get(runId);
    if (!fn) return [];
    return Promise.all(namedReads(expandPointers(js).code).map(async ({ ref, pipe }): Promise<PreRead> => {
        try {
            const r = whole ? await derefWhole(runId, fn, ref, pipeStages(pipe ?? null)) : fn(ref, pipe);
            return { ref, pipe, value: r.value, ...(r.warning ? { warning: r.warning } : {}), ...(r.meta ? { meta: r.meta } : {}) };
        } catch (e) { return { ref, pipe, error: (e as Error)?.message || String(e) }; }
    }));
}

/** The run's resolver for an isolated exec's re-pipes: a stored text read whole, as the pre-reads were. */
function wholeDerefFor(runId: string): IsoDeps["deref"] {
    return () => {
        const fn = derefByRun.get(runId);
        return fn && ((ref: string, pipe?: string | string[]) => derefWhole(runId, fn, ref, pipeStages(pipe ?? null)));
    };
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
    const runId = (message.payload as { runId?: unknown } | undefined)?.runId;
    /** A page may not start or continue a turn in a run the worker holds (built, or handed it). Asked here as well as in
     *  the router: the router's check reads the maps as they are, which are empty on a worker this message woke until
     *  the runs are restored from storage. */
    const workerHeld = (): boolean => !isExtensionSender(sender) && isWorkerRun(runId);
    /** A turn of this run is live (its loop holds the controller): a second turn under the same id would replace the
     *  controller and inbox, and whichever turn settled first would unregister the other, leaving it running with no Stop. */
    const running = (): boolean => typeof runId === "string" && runControllers.has(runId);
    const RUNNING = `Run "${String(runId)}" is already running: wait for its turn to end, or cancel it.`;
    // Registered BEFORE the first await: every wait below (the restore, the config, the start card) is a window a
    // CANCEL_RUN must reach, or the person's Stop is dropped and the run starts anyway. Two starts under one id
    // both register (so a stuck restore still reports its own bound to both) and `hostTurn` claims the live
    // controller, which refuses the second. `endStart` on every answer keeps a refused start from lingering.
    const starting = typeof runId === "string" ? beginStart(runId, tabId) : undefined;
    const startCancelled = (): boolean => !!starting?.signal.aborted;
    const endStarting = (): void => { if (typeof runId === "string" && starting) endStart(runId, starting); };
    const answer = (r: unknown): void => { endStarting(); sendResponse(r as Parameters<typeof sendResponse>[0]); };
    /** How a start the person stopped before its loop existed answers: cancelled, like a run that was aborted mid-flight. */
    const cancelledStart = (): { data: { cancelled: true; summary: string } } => ({ data: { cancelled: true, summary: "cancelled before the run started" } });
    // Bounded, and closed when the bound is hit: judged against maps not yet restored, a run the worker holds would
    // read as nobody's. A restore that never settles answers the page with an error rather than never.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const restored = Promise.race([
        hydrationDone.then(() => true, () => true),
        new Promise<false>((resolve) => {
            // Unref'd: this is a BACKSTOP (a start refused as RESTORE_PENDING when hydration is slow), not work
            // the process is waiting on. Every START_RUN raced it and a test that left hydration unsettled held
            // the Node process for the full ten seconds per start. Same as page-reachable's `defaultSleep`.
            timer = setTimeout(() => resolve(false), RESTORE_WAIT_MS) as unknown as ReturnType<typeof setTimeout> & { unref?: () => void };
            (timer as unknown as { unref?: () => void }).unref?.();
        }),
    ]);
    void restored.then((done) => {
        clearTimeout(timer);
        if (startCancelled()) { answer(cancelledStart()); return; }
        if (!done) { answer({ error: RESTORE_PENDING }); return; }
        if (workerHeld()) { answer({ error: WORKER_RUN_REFUSED }); return; }
        // A page's turn is a site's turn (docs/spec/SITE_ACCESS_SLICE3.md, PR 2): the start card's gate decides it, and
        // the model reads it as the page's. An extension page (the chat page, a panel) is not a site.
        const site = isExtensionSender(sender) ? null : grantableOrigin({ origin: sender.origin, url: sender.url ?? sender.tab?.url, frameId: sender.frameId });
        if (site && "refused" in site) { answer({ error: `Refused: ${site.refused}.` }); return; }
        const origin = site ? site.origin : null;
        const docId = typeof sender.documentId === "string" ? sender.documentId : undefined;
        if (message.type !== "START_RUN") {
            if (running()) { answer({ error: RUNNING }); return; }
            if (!origin) { endStarting(); hostRun(message, tabId, sendResponse); return; }
            const rp = (message.payload || {}) as ResumeRunPayload;
            const stored = typeof rp.runId === "string" ? bgRuns.get(rp.runId) : undefined;
            if (!stored) { endStarting(); hostRun(message, tabId, sendResponse); return; }   // hostRun answers "no resumable run"
            return getConfig().then(async (cfg) => {
                if (startCancelled()) { answer(cancelledStart()); return; }
                // The step budget this turn asks for: a raise is a widening, unless the person asked for it (Continue +N).
                const p = { ...stored.p, maxSteps: stepBudget(rp.maxSteps) ?? stored.p.maxSteps };
                const verdict = await gatePageTurn({ type: "RESUME_RUN", runId: rp.runId, tabId, origin, text: typeof rp.task === "string" ? rp.task : "",
                    p, model: stored.p.model || cfg.model || null, pageHistory: false, known: true, personClaimed: personClaimed(message), docId,
                    siteTools: ourToolTexts(stored.p, stored.p.pageUrl ?? "").siteTools });
                if (startCancelled()) { answer(cancelledStart()); return; }
                if ("error" in verdict) { answer({ error: verdict.error }); return; }
                // Again after the wait for the card: a hand-over, or another turn, may have landed meanwhile. A turn refused
                // here gives back what it spent (a page turn, the person's message).
                if (workerHeld()) { await verdict.refund(); answer({ error: WORKER_RUN_REFUSED }); return; }
                if (running()) { await verdict.refund(); answer({ error: RUNNING }); return; }
                // The person's turn runs at the budget they chose, never at one the page named.
                const resumed = verdict.person ? { ...message, payload: { ...rp, maxSteps: verdict.budget } } : message;
                endStarting();
                hostRun(resumed, tabId, sendResponse, undefined, { origin, person: verdict.person, first: false, docId, ...(verdict.pagePrefix ? { pagePrefix: verdict.pagePrefix } : {}) });
            }, (e) => answer({ error: (e as Error)?.message || String(e) }));
        }
        return getConfig().then(async (cfg) => {
            if (startCancelled()) { answer(cancelledStart()); return; }
            // Again after the config read: a hand-over may have landed meanwhile.
            if (workerHeld()) { answer({ error: WORKER_RUN_REFUSED }); return; }
            // A run id another tab holds (running, or settled and resumable) is that tab's: starting a turn under it from
            // here would take over its abort, its inbox and its stored history. Checked after the config read, so a run
            // the other tab started meanwhile counts.
            const owner = typeof runId === "string" ? runInboxes.get(runId)?.tabId ?? bgRuns.get(runId)?.tabId : undefined;
            if (owner != null && owner !== tabId) { answer({ error: `Run "${String(runId)}" belongs to another tab.` }); return; }
            if (running()) { answer({ error: RUNNING }); return; }
            const p = pageStartPayload(message.payload, sender, cfg) as StartRunPayload;
            if (!origin || !p || typeof p !== "object" || typeof p.runId !== "string" || !Array.isArray(p.tools)) { endStarting(); hostRun({ ...message, payload: p }, tabId, sendResponse); return; }
            const stored = bgRuns.get(p.runId);
            // A tool named like one of ours reads to the model as ours; a site's own tool's text is shown on the card (S2).
            const texts = ourToolTexts(p, p.pageUrl ?? sender.url ?? "");
            p.tools = texts.tools;
            // The model the run would call, after the filter: a start the filter refuses is refused before any card, as the
            // first model call would refuse it, so the card never names a model that cannot run.
            const model = p.model || cfg.model || null;
            const modelRefusal = model && !modelFilterAllows(model, cfg.modelFilter)
                ? `Model "${model}" is blocked by the model filter (/${cfg.modelFilter}/). Only matching models are callable — change or clear the filter in the extension settings.` : null;
            const verdict = await gatePageTurn({ type: "START_RUN", runId: p.runId, tabId, origin, text: typeof p.task === "string" ? p.task : "", p,
                model, pageHistory: Array.isArray(p.resumeMessages) && p.resumeMessages.length > 0, known: !!stored || !!approvalFor(p.runId),
                images: p.images, personClaimed: personClaimed(message), docId, modelRefusal, siteTools: texts.siteTools });
            if (startCancelled()) { answer(cancelledStart()); return; }
            if ("error" in verdict) { answer({ error: verdict.error }); return; }
            // Again after the wait for the card: a hand-over, or another turn, may have landed meanwhile. A turn refused
            // here gives back what it spent (a page turn, the person's message).
            if (workerHeld()) { await verdict.refund(); answer({ error: WORKER_RUN_REFUSED }); return; }
            if (running()) { await verdict.refund(); answer({ error: RUNNING }); return; }
            // The page's context is the worker's to write, from the browser's facts (B1): whatever context the page wrote
            // into its prompt is the site's, shown on the card as its instructions. Added after the card's snapshot, since
            // the time in it changes every turn.
            if (p.env !== false) {
                const title = (await Promise.resolve(chrome.tabs.get(tabId)).catch(() => null))?.title;
                p.systemPrompt = withPageContext(p.systemPrompt, workerPageContext(p.pageUrl ?? sender.url ?? "", title));
            }
            if (startCancelled()) { answer(cancelledStart()); return; }
            // The person's turn runs at the budget they chose (or the approved one), never at one the page named.
            if (verdict.person && verdict.budget) p.maxSteps = verdict.budget;
            // A later turn's history is the worker's, never the page's copy (Q4): what this run said and was told is what
            // the person allowed it, and a page could otherwise hand it a conversation it never had. None held (the worker
            // restarted between turns) is an empty one, which still continues the session rather than restarting it.
            const history = verdict.first ? undefined : (bgRuns.get(p.runId)?.messages ?? []);
            endStarting();
            hostRun({ ...message, payload: { ...p, resumeMessages: history } }, tabId, sendResponse, undefined, { origin, person: verdict.person, first: verdict.first, docId, ...(verdict.pagePrefix ? { pagePrefix: verdict.pagePrefix } : {}) });
        }, (e) => answer({ error: (e as Error)?.message || String(e) }));
    }).catch((e) => answer({ error: (e as Error)?.message || String(e) }));
}

/** The builtin tools whose factories set `requiresApproval`: the worker mints grants or consents for their calls, or
 *  acts for them with privileges (a debugger click), so a page's descriptor cannot take them off the gate. Read from the
 *  tool registry (`gated`); a site tool that takes one of these names is gated too. */
export const GATED_TOOL_NAMES: ReadonlySet<string> = GATED_BUILTINS;

/**
 * A page's START_RUN payload as the worker may trust it. A page's payload may ask for MORE gating, never less.
 * - Removed, the worker's to set: `builtBy`, `rebuild.builtBy`, `display` and `origin` (the PromptOrigin: a page could
 *   stamp its prompt as typed on an extension surface). Only the worker's own `hostRun` call
 *   (sw-run-start.ts) marks a run worker-built, and `makeWorkerRun` hands one over; a page's claim would give its run the
 *   worker's tool routing, grants, vision and answer, and lock the run as the person's.
 * - Removed from `tools`: `propose_policy`, which only a run the worker built offers (a page's run asking the person for
 *   policies would be the page writing the rules its own calls are judged by).
 * - Replaced by the sender's, as the browser stamped it (what the origin gate read): `pageOrigin` seeds the run's
 *   consented origins and `pageUrl` is "the page you are on", so a page naming another site would get navigations and
 *   reads there without a gate. Absent when the sender has none.
 * - Bounded: `maxSteps` goes through `stepBudget`, as on RESUME_RUN. By the worker's config: `autoApprovePython`, `autoApproveReadonly`,
 *   `autoApproveSelfSource` and `selfIntrospection` hold only when the config allows them too (the retired
 *   `autoApproveSameOriginAuth` is dropped); and a tool named in
 *   `GATED_TOOL_NAMES`, or a server tool (`remote`), always `requiresApproval`.
 * @param payload what the page sent
 * @param sender the message's sender
 * @param cfg the worker's config, read as the worker-built path reads it
 * @returns a copy; anything that is not an object, as it came
 */
export function pageStartPayload(payload: unknown, sender: chrome.runtime.MessageSender, cfg: Pick<MlConfig, "autoApprovePython" | "autoApproveReadonly" | "autoApproveSelfSource" | "selfIntrospection">): unknown {
    if (!payload || typeof payload !== "object") return payload;
    const { builtBy: _b, display: _d, origin: _p, pageOrigin: _o, pageUrl: _u, ...rest } = payload as StartRunPayload;
    // The budget RESUME_RUN honours, so a page cannot ask for an unbounded run; an invalid one is no budget, and the loop's default applies.
    const budget = stepBudget(rest.maxSteps);
    if (budget) rest.maxSteps = budget; else delete (rest as { maxSteps?: number }).maxSteps;
    if (rest.rebuild && typeof rest.rebuild === "object") {
        const { builtBy: _rb, ...rebuild } = rest.rebuild;
        rest.rebuild = rebuild;
    }
    rest.autoApprovePython = !!rest.autoApprovePython && !!cfg.autoApprovePython;
    rest.autoApproveReadonly = !!rest.autoApproveReadonly && !!cfg.autoApproveReadonly;
    delete (rest as { autoApproveSameOriginAuth?: unknown }).autoApproveSameOriginAuth;
    rest.autoApproveSelfSource = !!rest.autoApproveSelfSource && !!cfg.autoApproveSelfSource;
    // Absent is on, for the page's payload as for the config (an older stored config).
    rest.selfIntrospection = rest.selfIntrospection !== false && cfg.selfIntrospection !== false;
    // propose_policy and propose_manifest are the worker's to offer: a page naming one would turn its own run into a way to
    // ask for policies or manifests.
    if (Array.isArray(rest.tools)) rest.tools = rest.tools.filter((t) => !(t && typeof t === "object" && PROPOSAL_TOOLS.has(t.name)));
    if (Array.isArray(rest.tools)) rest.tools = rest.tools.map((t) => (t && typeof t === "object" && (GATED_TOOL_NAMES.has(t.name) || t.remote) ? { ...t, requiresApproval: true } : t));
    const url = sender.url ?? sender.tab?.url;
    const g = grantableOrigin({ origin: sender.origin, url, frameId: sender.frameId });
    if (!("origin" in g)) return rest;
    return { ...rest, pageOrigin: g.origin, ...(url && originOf(url) === g.origin ? { pageUrl: url } : {}) };
}

/** What a turn a SITE sent carries into `hostRun`: the site's origin, whether this turn is the person's own (a message
 *  they sent through the extension that the page relayed, `notePersonTurn`), whether it is the run's first, and the
 *  document that sent it. */
export interface SiteTurn { origin: string; person: boolean; first: boolean; docId?: string; /** the page's own text folded ahead of the person's (an idle `say()`), which stays the page's */ pagePrefix?: string }

/** Host a START_RUN / RESUME_RUN on `tabId`: the body of `startBackgroundRun`, callable by the worker itself for a run
 *  it built (sw-run-start.ts), where there is no sender. `sendResponse` fires once the whole run finishes. `turnOrigin`
 *  is where a resumed turn's message was typed: an argument rather than a payload field, because a page's RESUME_RUN
 *  reaches here unfiltered and must not stamp its message as typed somewhere else. */
export function hostRun(message: any, tabId: number, sendResponse: (r: any) => void, turnOrigin?: import("../contract/contract-run").PromptOrigin, site?: SiteTurn): void {
    // Whatever the turn's setup throws is answered, never left unhandled with the page waiting on it. What the setup had
    // registered by then is undone inside `hostTurn`, which alone knows how far it got.
    let answered = false;
    const once = (r: any): void => { if (answered) return; answered = true; sendResponse(r); };
    try { hostTurn(message, tabId, once, turnOrigin, site); } catch (e) { once({ error: (e as Error)?.message || String(e) }); }
}

/** The body of `hostRun`: one turn of one run, from its registrations to its answer. */
function hostTurn(message: any, tabId: number, sendResponse: (r: any) => void, turnOrigin?: import("../contract/contract-run").PromptOrigin, site?: SiteTurn): void {
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
        if (!stored) { sendResponse({ error: `No resumable run "${rp.runId}" in the background: it may have been evicted; start a new run.` }); return; }
        if (stored.tabId !== tabId) { sendResponse({ error: `Run "${rp.runId}" belongs to another tab.` }); return; }
        // A budget the person chose overrides the stored one, and because it goes into `p` it is what gets stored
        // again below: raising a cap STICKS. Bounded the same way the loop is, so a bad number from a page cannot
        // ask the worker for an unbounded run.
        const budget = stepBudget(rp.maxSteps);
        // No images: the first turn's were that turn's (a page's, for a run a site started), and a resumed turn that
        // carried them again would show the model the same pictures as this turn's, unlabelled.
        p = { ...stored.p, task: rp.task, images: undefined, ...(budget ? { maxSteps: budget } : {}), ...(turnOrigin ? { origin: turnOrigin } : {}) };
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
    // One turn per run id: a second start that raced through the same pre-hostRun awaits must not replace the
    // live controller (whichever settled first would be unregistered by the other, leaving it running with no
    // Stop). Same tick as the controller write below, so nothing can interleave between this check and that write.
    if (runControllers.has(runId)) {
        sendResponse({ error: `Run "${String(runId)}" is already running: wait for its turn to end, or cancel it.` });
        return;
    }
    // A start the person cancelled while it was still in its pre-hostRun awaits must not reach the loop. Checked
    // here as well as in `startBackgroundRun`: a worker-built start (`startUserRun`) and a chat-page resume come
    // straight to this function, and a cancel can land in their awaits too.
    const startingSet = startingControllers.get(runId);
    const cancelledEntry = startingSet ? [...startingSet].find((e) => e.ctl.signal.aborted) : undefined;
    if (cancelledEntry) {
        for (const e of startingSet ?? []) endStart(runId, e.ctl);
        sendResponse({ data: { cancelled: true, summary: "cancelled before the run started" } });
        return;
    }
    // A turn a site sent reaches the model marked as the site's, never as the person's (Q2a); the transcript shows the
    // site's words with its name instead. A turn the person sent through the extension, which the page only relayed, is
    // theirs (`site.person`).
    // A turn of images alone is the page's too: its marker is what tells the model whose pictures they are.
    const modelTask = site && site.person && site.pagePrefix ? `${pageTurnText(site.origin, site.pagePrefix)}\n\n${p.task.slice(site.pagePrefix.length + 2)}`
        : site && !site.person && (p.task || p.images?.length) ? pageTurnText(site.origin, p.task || "") : p.task;
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
    /** A page's answer, or a page text the worker folds into a call's answer, held to what the worker takes from a page it
     *  reads itself (pageRead's caps, page-answer-caps.ts): its renders on every kind of run (a render becomes the step's
     *  pointer), its text clipped for the model only while the worker holds the run (`byWorker()` when the answer is in).
     *  Each cut is a `page`/`answer-capped` record in the run's execution log. Declared before `byWorker`, read after. */
    const fromPage = <T>(env: T, tool: string, args: Record<string, unknown> | undefined): T => capPageAnswer(env, tool, args, (c) => recordRunLog(runId, { level: "warn", subsystem: "page", kind: "answer-capped", reason: c.what,
        detail: { tool, slot: c.slot, field: c.field, from: c.from, to: c.to } }), byWorker());
    /** Whether the worker drives this run NOW: it built it, or was handed it, during this turn included (a navigation onto
     *  a site that may not use window.ml, nav-handover.ts; a person's message from such a site, `userRunAction`). Read at
     *  each decision, never from `p`, which is the turn's start payload: everything the worker does for a run it built
     *  (its tools in the worker, the run's grants, its answer set, an isolated exec) applies from the hand-over on. */
    const byWorker = workerVision;
    /** Whether a turn its page started (`p` says the page built the run) is the worker's now: whoever waits on this turn's
     *  answer is that page, which lost the run at the hand-over. */
    const handedThisTurn = (): boolean => p.builtBy !== "worker" && byWorker();
    /** Whether this run may ask the person for a policy (`propose_policy`): one the worker BUILT, whose tools offer it. A
     *  page's run never does (`pageStartPayload`), nor one handed to the worker: within the turn of its hand-over `p` is
     *  still the page's, and after it the stored copy has the tool stripped (`markWorkerRun`). */
    const offersProposals = (): boolean => p.builtBy === "worker" && byWorker() && runsInWorker(p, "propose_policy");
    /** Whether this run may ask the person to store a program manifest (`propose_manifest`): one the worker built, whose
     *  tools offer it (the settings turned ml.sh on when it started). Whether the host answers is the check's. */
    const offersManifests = (): boolean => p.builtBy === "worker" && byWorker() && runsInWorker(p, "propose_manifest");
    /** `p` as the run is stored for a later turn or a worker restart: a run handed to the worker during this turn
     *  (`makeWorkerRun`) stays the worker's. `p` is the turn's start payload, written before the hand-over, and storing
     *  it as it is would give the run back to the page that built it, whose RESUME_RUN would then be honoured. Its tools
     *  lose `propose_policy` as `markWorkerRun`'s copy does, or this write would put it back. */
    const storedP = (): StartRunPayload => (p.builtBy !== "worker" && isWorkerRun(runId)
        ? { ...p, builtBy: "worker", tools: withoutProposals(p.tools), ...(p.rebuild ? { rebuild: { ...p.rebuild, builtBy: "worker" } } : {}) } : p);
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
    /** A worker-run python_exec's `image` and `cast`, through the worker's vision over this run's tab (worker-media.ts). */
    const pyMedia = pyMediaFor(runId, tabId);
    const verifyHere = async (doc: string | null | undefined, req: WorkerVerify, verb: string): Promise<VerifyOutcome> =>
        workerVerify(runId, tabId, doc, req, verb, await visionFacts(), tabUrlNow);
    /** Where an approved exec of this run would go now (exec-routing.ts): the tab's site as the browser reports it, the
     *  isolation it offers, the call's `world`, and the default world (the stored setting, else the build's). */
    const execRoute = async (js: string, world: unknown): Promise<ExecRoute> => {
        const url = (await chrome.tabs.get(tabId).catch(() => null))?.url || tabPageUrl.get(tabId) || "";
        const cfg = await getConfig();
        return routeExec(js, await pageApproved(url), await isolationAvailable(!!cfg.cdp), { world, defaultWorld: defaultExecWorld(cfg.execDefaultWorld) });
    };
    // The envelopes the worker made itself, by running the tool here (runLocalTool). Only these may name a stored text
    // body (`textValue`): a page's answer is deserialized, so it can never be one of them, and a copy made on the way
    // (a verify's) is not one either, which fails closed. state: plumbing
    const workerEnvelopes = new WeakSet<object>();
    const sendTool = async (payload: { runId: string; name: string; args: Record<string, unknown>; stream?: boolean; renderOnly?: boolean; readonlyTry?: boolean; precheck?: boolean; reads?: PreRead[]; answerShape?: AnswerShapeItem[] }, onStream?: (chunk: string, ts?: number) => void, documentId?: string, pageRouted = false): Promise<unknown> => {
        // A worker-built run's REMOTE tool never goes to the page, which has no such tool. If this worker does not hold
        // it (rehydrated after an eviction, or a resumed session), it is rebuilt first.
        const tabUrl = tabUrlNow;
        // An exec is routed here, so no message of any kind tells the page which world it asked for (withoutWorld).
        if (payload.name === "exec" && payload.args) payload = { ...payload, args: withoutWorld(payload.args) };
        // Nothing goes to the tab while a navigation's hand-over is undecided (nav-handover.ts): the send is routed by it.
        await handOverSettled(tabId);
        // Nor while the run is held on the page its tab holds (nav-arrival.ts): a preview, a precheck or a survey is not
        // asked of it, and a call is answered by the hold (a call reaching here past `withArrival` arrived meanwhile).
        await arrivalSettled(tabId);
        const held = arrivalHold(runId);
        if (held) {
            if (payload.renderOnly || payload.precheck || payload.readonlyTry) throw new Error("the run is held on this page");
            return { result: held.kind === "deny" ? arrivalDeniedText(held) : arrivalWaitingText(held) };
        }
        // A call built for the page-built run, whose run is the worker's now: built again (`againIfHandedOver`).
        const handedSince = (): void => { if (pageRouted && byWorker()) throw new HandedOverMidCall(); };
        handedSince();
        // At the send itself, decided again from the lists as they are then: a send held meanwhile (a navigation's wait, a
        // tab rebuilt) must not go out on a decision made before a revoke whose storage event this worker has not acted on.
        const decidedAtSend = async (): Promise<void> => {
            if (pageRouted) await handOverSettled(tabId);
            handedSince();
            await arrivalSettled(tabId);
            if (arrivalHold(runId)) throw new Error("the tab arrived on a page this run is held on");
        };
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
            // Asked again at the send itself, after any navigation's wait: a revoke decided meanwhile keeps the call here.
            const env = await delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload: call ? { ...payload, verifyInWorker: true } : payload }, pin, decidedAtSend);
            // Asked again on the answer: a run the person took over while the call was in flight is the worker's now.
            const seen = vis || workerVision() ? withoutPageVision(env) : env;
            // Nor a stored-value key this run may not claim: the render it rides is read by key in the sidebar.
            const held = await withHeldValuesOnly(seen, runId, runMayClaim(byWorker() ? null : pageValueSession(tabId)));
            // Nor more than the worker takes from a page it reads itself (`fromPage`).
            return fromPage(held, payload.name, payload.args);
        };
        if (byWorker() && runsInWorker(p, payload.name)) {
            await ensureLocalTools(runId, p, tabId, tabUrl, pyMedia).catch(() => { /* answered below */ });
            const local = await runLocalTool(payload, onStream);
            if (local) { workerEnvelopes.add(local); return local; }
            // Nowhere else to run: a remote tool has no page side, and a worker builtin sent to the page would put what
            // it reads there and have the page send for it (site access part 5), so neither falls back to the page.
            if (p.tools.some((t) => t.name === payload.name && t.remote))
                return { result: `Error: the server tool "${payload.name}" is not available any more (the server no longer lists it).` };
            // `look` and `locate` are not built here (each call is, above): only their preview reaches this, and the page
            // draws it from the target alone (`lookPreviewArgs`).
            if (payload.name === "look" || payload.name === "locate") return toPage();
            return { result: `Error: "${payload.name}" could not be set up for this run. Try again.` };
        }
        const local = await runLocalTool(payload, onStream);
        if (local) { workerEnvelopes.add(local); return local; }
        return toPage(documentId);
    };
    const abortCtl = new AbortController();   // CANCEL_RUN aborts this → the loop resolves { cancelled }
    // Set once this run's page navigates: the page-side caller that normally emits the lifecycle
    // agent/agent-result (overlay/devtools) is then GONE (its context died with the old document), so the
    // BACKGROUND must fan the terminal result to the destination page instead — else the run finishes but
    // no surface ever learns it did (the observer/HUD sat on "running"). See emitLifecycle below.
    let hasNavigated = false;
    // Undoes what this turn registered: run when the turn settles, and when its setup throws before the loop starts.
    let unhostAsks: (() => void) | undefined;   // set once the run's steps may raise nested asks (sw-asks.ts)
    let unwatchArrivals: (() => void) | undefined;   // set once the run judges its tab's arrivals (nav-arrival.ts)
    const settle = (): void => { unhostAsks?.(); unwatchArrivals?.(); if (unwatchArrivals) watchBetweenTurns(tabId, runId); cancelReasons.delete(runId); noteRunEnd(runId); runControllers.delete(runId); runInboxes.delete(runId); untrackRun(tabId, runId); deleteRun(runId); deletePythonRun(runId); releaseDebugger(tabId); };   // detach the run's CDP debugger (attached once, reused across execs/clicks); ROOT C: drop its kept Python namespace
    /** Ends the run's session on every surface when the setup throws after its start event went out; set once the fan exists. */
    let endSession: ((error: string) => void) | undefined;
    try {
        runControllers.set(runId, abortCtl);
        // The live controller takes over from any start registration: from here a CANCEL_RUN finds this one.
        for (const e of startingSet ?? []) endStart(runId, e.ctl);
        runInboxes.set(runId, { tabId, queue: [] });   // a.say() steering lands here while the run is live
        // Register the run against its tab so the navigation sensor watches it — UNLESS the run opted out of
        // cross-page persistence (navigate: false), in which case a nav simply ends it (no barrier, no adopt).
        if (p.crossPage !== false) trackRun(tabId, runId, p.rebuild);
        // Durable resume: snapshot the run NOW (before the first step) + after each step (the checkpoint dep),
        // so an SW evicted mid-run rehydrates from storage. Cleared when the run settles (finally).
        persistRun(runId, { p: storedP(), tabId, messages: resumeMessages || [], sub: snapSub() });
        // `remote` has to survive into the loop's ToolMeta: it is what makes a remote tool's output CITABLE
        // (`meta?.remote` in agent-loop), and it cannot be recovered from the name — the name is generated
        // from the server's own bundle, so no hardcoded list can hold it. Dropping it here made the whole
        // feature page-path-only, silently: the tool ran, streamed and rendered exactly as it should, and
        // only reading the pointer back faulted with "nothing has been captured in this run".
        const toolMetas: ToolMeta[] = p.tools.map(t => ({ name: t.name, requiresApproval: t.requiresApproval, capabilities: t.capabilities, ...(t.remote ? { remote: t.remote } : {}) }));
        // exec's `world` is offered only to a run the worker drives as this turn starts (withExecWorld): a page-built run's
        // exec runs in its page's world and nowhere else. The start event below carries the same list, so the export holds
        // what the model was sent.
        const offerWorld = byWorker();
        const modelTools = offerWorld ? withExecWorld(p.tools) : p.tools;
        const toolDefs = modelTools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
        const approvedSheets = new Set<string>();   // external sheets approved this run (isSheetApproved)
        // state: plumbing — why this run's python_exec cell was not run inside the dialect, by its exact source: written by the
        // read-only try, read once by the gate's why-asks line. A cell with no entry (edited, or never tried) is outside.
        const pyOutside = new Map<string, string>();
        // Cross-origin navigation consent: origins this run may navigate to WITHOUT re-prompting — seeded
        // with the start origin, and each cross-origin nav the user approves is added (so repeat navs to it
        // skip the gate). A run that didn't opt into crossOrigin never gates (its tool refuses cross-origin).
        // An origin the person approved in an earlier turn is theirs for the rest of the run, in both modes (POLICIES.md,
        // "One consent, scoped by the origin"): the worker's grant outlives the turn, so the turn starts from it.
        const consentedOrigins = new Set<string>(runOrigins(runId));
        if (p.pageOrigin) consentedOrigins.add(p.pageOrigin);
        // Origins an `allow` row let an arrival reach: consented for NAVIGATION only (POLICIES.md, ruling (b) as built). The
        // FETCH_URL choke point does not count them, so the gate does not either: a read there goes to its card.
        const navOnlyOrigins = new Set<string>();
        // The turn's ask and its grants, readable by the state inspector (`run.input`, `grants.turn`) for as long as the turn runs.
        const turnStarted = Date.now();
        turnByRun.set(runId, () => ({ task: p.task, images: p.images?.length ?? 0, origin: p.origin ?? null, startedTs: turnStarted,
            origins: [...consentedOrigins], sheets: [...approvedSheets], payload: p }));
        /** Where a navigate to `url` goes, resolved against the page the tab is on now; undefined when it cannot be read. */
        const navDest = (url: string): URL | undefined => {
            try { return new URL(url.startsWith("//") ? "https:" + url : url, tabPageUrl.get(tabId) ?? p.pageUrl ?? undefined); } catch { return undefined; }
        };
        const navNeedsConsent = (url: string): boolean => {
            if (!p.crossOrigin) return false;   // can't cross origins → tool refuses cross-origin; same-site fine → no gate
            try {
                if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !url.startsWith("//")) return false;   // relative → same-origin
                const dest = new URL(url.startsWith("//") ? "https:" + url : url);
                return !consentedOrigins.has(dest.origin) && !navOnlyOrigins.has(dest.origin);   // a NEW cross-origin → gate; an already-consented one → no
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
        // The last event of each step that carried its tool, by RAW seq: a nested ask re-emits it with the step's asks, so
        // the ask rides the event every surface already renders (sw-asks.ts). A turn's own; gone with it.
        const lastStepEv = new Map<number, Record<string, unknown>>();   // state: plumbing — one turn's step events, for re-emitting a step with its asks
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
            if (rawSeq != null && ev.tool != null) { const { asks: _asks, ...rest } = ev; lastStepEv.set(rawSeq, rest); }
            // A step that raised asks carries them on every later event too (its DONE included), so no surface, export
            // or saved session sees the step without what it asked.
            const asks = seq != null && ev.asks === undefined && ev.tool != null ? stepAsks(runId, seq) : undefined;
            const event = {
                kind: "agent-step", id: runId, ts: Date.now(), save: false,
                session: { hash: runId, turn: step }, ...ev, ...(asks?.length ? { asks } : {}), step, localStep: rawStep, seq,
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
            ingestSessionEvent(event, { tabId, trusted: true, hosts: byWorker() });
            // Cross-page: remember this step so a fresh page after a nav can rebuild the card mid-run.
            if (p.crossPage !== false) bufferReplay(tabId, event);
        };
        /** A site-run notice (contract-debug.ts `SiteRunEvent`) to every surface showing the run, and into the replay a
         *  re-adopting page's shell rebuilds the card from. */
        const siteNotice = (event: Record<string, unknown>): void => {
            chrome.tabs.sendMessage(tabId, { type: "ML_DEBUG_TO_PAGE", event }).catch(() => {});
            relayDebugEvent(tabId, event);
            if (p.crossPage !== false) bufferReplay(tabId, event);
            // The site's mark and its turns reach the session index too (it takes them from the worker only), so the chat
            // page names the site on its turns as every other surface does.
            if (event.kind === "agent-site" || event.kind === "agent-site-say") ingestSessionEvent(event, { tabId, trusted: true, hosts: byWorker() });
        };
        // Fan a lightweight run event verbatim (no step/seq offset) to every surface — used for the
        // "seen" indicator (agent-say-seen), which keys off its own id, not a step position.
        const fanEvent = (event: Record<string, unknown>): void => {
            if (abortCtl.signal.aborted) return;
            chrome.tabs.sendMessage(tabId, { type: "ML_DEBUG_TO_PAGE", event }).catch(() => {});
            relayDebugEvent(tabId, event);   // always feed a connected panel (see emitStep — no double, no-op if none)
            ingestSessionEvent(event, { tabId, trusted: true, hosts: byWorker() });
            if (p.crossPage !== false) bufferReplay(tabId, event);
        };
        // The run's steps may now raise nested asks: a call made from inside a running step that needs the person.
        unhostAsks = hostAsks({
            runId, unattended: !!p.unattended, routing: p.approvalRouting || "ui", signal: abortCtl.signal,
            emit: (seq, asks) => { const base = lastStepEv.get(seq - seqBase); if (base) emitStep({ ...base, asks }); },
            stepOf: (seq) => stepBase + (Number(lastStepEv.get(seq - seqBase)?.step) || 0),
            running: (seq) => !!lastStepEv.get(seq - seqBase)?.pending,
        });
        // Arrivals (nav-arrival.ts, docs/spec/POLICIES.md "judged on arrival"): every page the tab commits while this turn
        // runs is judged as the `fetch` consumer in its interactive mode, before the run re-adopts there. A hold is answered
        // by the person on a card raised under the step running then, or under the next call's step if none is.
        /** The OFFSET seq of the step running now, if any. */
        const runningSeq = (): number | undefined => {
            let raw: number | undefined;
            for (const [s, ev] of lastStepEv) if (ev.pending && (raw === undefined || s > raw)) raw = s;
            return raw === undefined ? undefined : seqBase + raw;
        };
        let denyCarded = false;   // the deny hold's card is up
        // The page the run's own navigate is going to, once it passed its gate (the policy, a card, the consent): its arrival
        // is that navigate's, already judged with the same facts, so it is not judged (or asked about) again. Any other
        // commit, a redirect included, clears it and is judged.
        let namedNav: string | undefined;
        /** A URL without its fragment, for telling the named page from another: a fragment is not another read. */
        const unfragmented = (url: string): string | undefined => { try { const u = new URL(url); u.hash = ""; return u.href; } catch { return undefined; } };
        // The ask hold's card, answered once for every call waiting on it: whether the run may act on the page, and what
        // the model reads of the answer.
        let askAnswer: Promise<{ allowed: boolean; text: string }> | undefined;
        // That answer when no call waited on it (the person answered while the step that moved the tab still ran): the
        // next call's result carries it, so the model reads it once.
        let unreadAnswer: string | undefined;
        /** The deny hold's card: Go back takes the tab back (that arrival is judged in turn), End run stops the run. */
        const raiseDenyCard = (seq = runningSeq()): void => {
            const h = arrivalHold(runId);
            if (h?.kind !== "deny" || denyCarded || seq === undefined) return;
            denyCarded = true;
            const line = arrivalLine(h);
            void raiseAsk(runId, seq, { kind: ARRIVAL_DENIED, facts: { url: h.url }, why: { line, detail: line, cause: "deny-policy", policy: h.label } }).then(async (o) => {
                if (arrivalHold(runId) !== h) return;
                if (o.allowed) { await Promise.resolve(chrome.tabs.goBack?.(tabId)).catch(() => {}); return; }
                if (o.state === "denied") { endRun(); return; }
                denyCarded = false;   // nobody answered: the next call raises it again
            });
        };
        /** The ask hold's card, raised under `seq`; undefined when nothing is held, or when no step is running to raise it under. */
        const answerArrival = (seq = runningSeq()): Promise<{ allowed: boolean; text: string }> | undefined => {
            const h = arrivalHold(runId);
            if (h?.kind !== "ask") return undefined;
            if (askAnswer || seq === undefined) return askAnswer;
            const line = arrivalLine(h);
            const answered = (a: { allowed: boolean; text: string }) => { unreadAnswer = a.text || undefined; return a; };
            askAnswer = raiseAsk(runId, seq, { kind: ARRIVAL_ASK, facts: { url: h.url }, why: { line, detail: line, cause: h.label !== undefined ? ASK_POLICY_CAUSE : "policies-unread", ...(h.label !== undefined ? { policy: h.label } : {}) } }).then(async (o) => {
                if (arrivalHold(runId) !== h) return { allowed: true, text: "" };   // judged again meanwhile: the new judgement holds or not
                if (o.allowed) {
                    // A person on a card: the origin is consented, and as the person for a fetch the worker runs.
                    consentedOrigins.add(h.origin);
                    if (byWorker() && runsInWorker(p, "fetch_url")) grantRunOrigin(runId, h.origin);
                    // Re-adopted while still held, and the answer kept before the hold goes: a call in between waits on
                    // this answer and carries it, instead of finding neither.
                    const info = await readoptHere();
                    const a = answered({ allowed: true, text: `${arrivalAnsweredText(h, true)}${info ? `\n\nYou are now on the new page:\n${info}` : ""}` });
                    if (arrivalHold(runId) === h) clearArrival(runId);
                    return a;
                }
                if (o.state !== "cancelled") await Promise.resolve(chrome.tabs.goBack?.(tabId)).catch(() => {});
                return answered({ allowed: false, text: arrivalAnsweredText(h, false, o.state === "denied" ? o.note : undefined) });
            });
            return askAnswer;
        };
        /** Register the run on the page it may now act on, as the re-adopt it was held from would have. */
        const readoptHere = async (): Promise<string | undefined> => {
            const rebuild = runRebuilds.get(runId) ?? p.rebuild;
            if (p.crossPage === false || !rebuild) return undefined;
            const r = await adoptOnTab(tabId, runId, rebuild).catch(() => null);
            return r?.pageInfo ? capPageContext(r.pageInfo, byWorker()) : undefined;
        };
        /** End the run from its deny card, as Stop does: the controller, and any gate it waits at. */
        const endRun = (): void => {
            abortCtl.abort();
            for (const [key, entry] of [...pendingApprovals]) if (key.startsWith(`${runId}:`)) { pendingApprovals.delete(key); entry.resolve({ approved: false, cancelled: true }); }
        };
        /**
         * What a call meets on a page its run is held on: the deny text at once (and the card, if it is not up), or the
         * ask's answer. Undefined when the run may act on the page; `{ text }` with `allowed` when the person let it.
         * @param seq the OFFSET seq of the call's step
         */
        const passArrival = async (seq?: number): Promise<{ allowed: boolean; text: string } | undefined> => {
            await arrivalSettled(tabId);
            const h = arrivalHold(runId);
            if (!h) {
                // The person answered an ask no call waited on: the tab is where their answer left it, so the call runs.
                const text = unreadAnswer;
                unreadAnswer = undefined;
                return text ? { allowed: true, text } : undefined;
            }
            if (h.kind === "deny") { raiseDenyCard(seq ?? runningSeq()); return { allowed: false, text: arrivalDeniedText(h) }; }
            const a = await answerArrival(seq ?? runningSeq());
            unreadAnswer = undefined;
            return a ?? { allowed: false, text: arrivalAnsweredText(h, false) };
        };
        /** Run a tool call unless the run is held on its page: refused with the hold's text, or run after the person let
         *  it act there, with their answer ahead of its result. */
        const withArrival = async <T extends { result?: string }>(call: { seq: number } | undefined, run: () => Promise<T>): Promise<T | { result: string }> => {
            const arrived = await passArrival(call ? seqBase + call.seq : undefined);
            if (arrived && !arrived.allowed) return { result: arrived.text };
            const env = await run();
            return arrived?.text ? { ...env, result: `${arrived.text}\n\n${env.result ?? ""}` } : env;
        };
        const judgeHere = (url: string): void => {
            const named = namedNav !== undefined && unfragmented(url) === namedNav;
            namedNav = undefined;
            if (named) { clearArrival(runId); return; }
            const j = judgeCall(runId, "fetch", navigateFacts(url));
            for (const b of j.broken) recordRunLog(runId, { level: "warn", subsystem: "policy", kind: "broken", reason: b.reason, detail: { policy: b.policy.id, tool: "arrival" } });
            const v = arrivalVerdict(url, j);
            if (v.kind === "pass") { clearArrival(runId); return; }
            // An `allow` row lets the run on, and consents the origin for navigation only: never for a read, which the
            // FETCH_URL choke point would refuse, and never as the person, which only a person on a card grants (ruling (b)).
            if (v.kind === "allow") { navOnlyOrigins.add(v.origin); clearArrival(runId); return; }
            const now = arrivalHold(runId);
            if (now?.kind === v.kind && now.url === v.url) return;   // the same page judged again: its card stands
            holdArrival(runId, v);
            denyCarded = false; askAnswer = undefined; unreadAnswer = undefined;
            recordRunLog(runId, { level: "warn", subsystem: "policy", kind: v.kind === "deny" ? "arrival-denied" : "arrival-asks", reason: v.label ?? "unread", detail: { tool: "arrival", url: v.url } });
            if (v.kind === "deny") raiseDenyCard(); else void answerArrival();
        };
        unwatchArrivals = watchArrivals(tabId, runId, judgeHere);
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
            if (p.surface !== "off" && !hasNavigated && !byWorker()) return;
            chrome.tabs.sendMessage(tabId, { type: "ML_DEBUG_TO_PAGE", event }).catch(() => {});
            // We're the SOLE fanner in this branch (off, or overlay/devtools post-nav), so feed a connected panel
            // too — regardless of surface. Gating on `devtools` left an off/card run's answer never reaching a
            // connected panel (stuck on "running"). No double (page-side isn't fanning here); no-op without a panel.
            relayDebugEvent(tabId, event);
            ingestSessionEvent(event, { tabId, trusted: true, hosts: byWorker() });
        };
        endSession = (error) => emitLifecycle({ kind: "agent-result", id: runId, ts: Date.now(), save: false, session: { hash: runId, turn: 0 }, summary: "", steps: 0, hitCap: false, error });
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
        // The page the tab holds now is judged before any tool of this turn reaches it, when no judge of this run spoke on it:
        // the tab moved between turns (by hand, a redirect, a timer). Always for a run held, or resurrected after an
        // eviction (its worker forgot the hold, and the page may have moved). A run's first turn is on the person's page.
        void judgeTurnStart(tabId, runId, { first: !resumeMessages, force: resurrected || !!arrivalHold(runId) });
        const startEvent = {
            kind: "agent", id: runId, ts: Date.now(), save: false, session: { hash: runId, turn: 0 },
            task: resurrected ? (resumeOriginalTask ?? p.task) : p.task, model: p.model, maxSteps: p.maxSteps,
            ...(p.display && !resurrected && p.builtBy === "worker" ? { display: p.display } : {}),
            pageUrl: p.pageUrl, pageTitle: p.pageTitle,
            resumed: resurrected || undefined,   // the sidebar can mark it "resumed after interruption"
            config: {
                system: p.systemPrompt, customSystem: false,
                tools: modelTools.map(t => ({ name: t.name, requiresApproval: t.requiresApproval, vision: t.capabilities.includes("vision"), description: t.description, parameters: t.parameters, summary: t.summary, ...(t.remote ? { remote: t.remote } : {}) })),
                maxSteps: p.maxSteps, think: p.think, env: true, vision: null, systemAppend: null, unattended: p.unattended, silent: p.silent,
                stream: p.stream,
            },
        };
        // Which document this run started on, for the navigation rule (sw-start-approval.ts `openedByRun`): the sender's for
        // a site's turn, the tab's for a run the worker starts. A run resurrected after an eviction has none, so no page on
        // its tab passes for its start page.
        if (site) noteRunStart(runId, tabId, site.docId);
        else if (!resurrected) void documentOn(tabId).then((d) => { if (runControllers.get(runId) === abortCtl) noteRunStart(runId, tabId, d); });
        if (!resumeMessages) emitLifecycle(startEvent);
        // A page-built run on the overlay or DevTools surface: the page announced the start with ITS tool texts, which
        // the worker rewrote above (`ourToolTexts`, `withExecWorld`) and the prompt it extended. The surfaces and both
        // exports must carry what the model is sent, so the worker says it after the page's start, on the same gate.
        if (!resumeMessages && p.surface !== "off" && !hasNavigated && !byWorker())
            fanEvent({ kind: "agent-config", id: runId, ts: Date.now(), save: false, session: { hash: runId, turn: 0 }, config: { system: startEvent.config.system, tools: startEvent.config.tools } });
        else if (resurrected) fanEvent(startEvent);   // resurrected: no page-side caller emitted a start → fan it ourselves
        // A plain resume emits NEITHER, so a cap raised here would reach no surface: the step pill would keep counting
        // against the old number and the next Continue would offer the old budget back. `agent-cap` is the same event
        // a handle's setter fans page-side, and the reducer already folds it into the session.
        else if (capRaised) fanEvent({ kind: "agent-cap", id: runId, ts: Date.now(), save: false, session: { hash: runId, turn: 0 }, maxSteps: p.maxSteps });
        // A run the person started (the worker built it): its gates may take the card's focus. Every other run's never do,
        // a run whose marker went missing included (Q15).
        if (p.builtBy === "worker") siteNotice({ kind: "agent-person", id: runId, ts: Date.now(), save: false, session: { hash: runId, turn: 0 } });
        if (site) {
            // The run is a site's: every surface marks it so (its gates take no focus, Q15), and a later turn is shown as the
            // site's or the person's, which the page's own copy of the message no longer is (event-admission.ts).
            siteNotice({ kind: "agent-site", id: runId, ts: Date.now(), save: false, session: { hash: runId, turn: 0 }, site: site.origin });
            if (!site.first && p.task) {
                if (site.person && site.pagePrefix) {
                    siteNotice({ kind: "agent-site-say", id: runId, ts: Date.now(), save: false, session: { hash: runId, turn: 0 }, text: site.pagePrefix, site: site.origin });
                    fanEvent({ kind: "agent-say", id: runId, ts: Date.now(), save: false, session: { hash: runId, turn: 0 }, text: p.task.slice(site.pagePrefix.length + 2) });
                } else if (site.person) fanEvent({ kind: "agent-say", id: runId, ts: Date.now(), save: false, session: { hash: runId, turn: 0 }, text: p.task });
                else siteNotice({ kind: "agent-site-say", id: runId, ts: Date.now(), save: false, session: { hash: runId, turn: 0 }, text: p.task, site: site.origin });
            }
        }
        /** The run's context snapshot (`contextSink`), for `ml.current` in a survey the worker evaluates. */
        // A run the worker built keeps its curated answer here (worker-answer.ts): a new turn starts it empty (a run resurrected
        // after an eviction continues its turn, so keeps it), and its `answer` tool asks this tab for a selector's elements.
        // Only a run that has `answer` has a set to send: without it `ml.answer` is absent (ml-member-tools.ts), and a shape
        // would hand the page script an `AnswerLog` the run never offered. A page-built run's set is the page's until the run is
        // handed to the worker (nav-handover.ts), when this one takes over: so it is set up, empty, for that run's turn too.
        const hasAnswer = p.tools.some((t) => t.name === "answer");
        const workerAnswer = (): boolean => hasAnswer && byWorker();
        if (hasAnswer) {
            if (!resurrected) resetAnswer(runId);
            // The page captures nothing for it (`mediaInWorker`): each element's media is cropped by the worker from its own
            // capture of the document the page answered in (worker-media.ts), pinned to it.
            setAnswerSelector(runId, async (a) => {
                const doc = await topDocument(tabId);
                const env = await delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload: { runId, name: "answer", args: {}, answerSelect: { ...a, mediaInWorker: true } } }, doc ?? undefined)
                    .catch((e) => ({ result: `Error: ${(e as Error)?.message || e}` })) as Partial<import("../contract").PageToolEnvelope> | null;
                const got = env?.answerSelection ?? { count: 0, error: String(env?.result || "the page did not answer").replace(/^Error: /, "") };
                return { ...got, documentId: doc };
            }, (doc, selector, index, media) => workerAnswerMedia(runId, tabId, doc, selector, index, media));
        }
        let historyScrubbed = false;   // the resumed history has crossed `forModel` (callModel's first call)
        /**
         * A python_exec cell, tried INSIDE the read-only dialect before the gate (docs/spec/PYTHON_DIALECT.md, "Membership
         * replaces `mode`"): run under the fork's gate in the worker, it is the call's result with no card. Refused (a
         * module, call, attribute or node outside the dialect, or its budget or memory cap), its output is discarded,
         * `pyOutside` says where, and the call goes to the person, whose approval runs it on the full path. Only a run the
         * worker drives, with Python auto-approval on and every other gate of `autoApprovePython` passed.
         */
        const tryPythonInside = async (args: Record<string, unknown>): Promise<import("../agent/agent-loop").ToolRunResult | null> => {
            const code = String((args as { code?: unknown }).code ?? "");
            pyOutside.delete(code);
            await handOverSettled(tabId);
            const declined = (why: string): null => { pyOutside.set(code, why); return null; };
            if (!p.autoApprovePython) return declined("auto-approval of Python is off");
            if (!byWorker() || !runsInWorker(p, "python_exec")) return declined("this run's Python runs on the page, where nothing is tried inside the dialect");
            if (!autoApprovePython(args, { autoApprovePython: true }, (id) => approvedSheets.has(id), () => true)) return declined("it asks for something the dialect does not decide (an unapproved sheet, a raised output cap, or hidden characters)");
            await ensureLocalTools(runId, p, tabId, () => tabPageUrl.get(tabId) || p.pageUrl || "", pyMedia);
            // A sandbox that cannot judge membership (the stock core) refuses every cell, so none of the call's inputs is read.
            const unready = await pythonDialectReady(runId);
            if (unready) return declined(unready);
            grantRunPython(runId, { sheets: externalSheetIds(args), code: null, inside: true });
            let env: Partial<import("../contract").PageToolEnvelope> | null;
            let refused: string | undefined;
            try { env = await sendTool({ runId, name: "python_exec", args }) as Partial<import("../contract").PageToolEnvelope> | null; }
            finally { refused = takePyRefusal(runId); grantRunPython(runId, null); }
            if (refused !== undefined) {
                recordRunLog(runId, { subsystem: "routing", kind: "python-outside", reason: "not-in-dialect", detail: { tool: "python_exec", where: refused } });
                return declined(refused);
            }
            if (!env) return declined("the worker did not run it");
            recordRunLog(runId, { subsystem: "routing", kind: "python-inside", reason: "in-dialect", detail: { tool: "python_exec" } });
            return { result: env.result || "", renderIn: env.renderIn, renderOut: env.renderOut, feedback: env.feedback, image: env.image, imageLabel: env.imageLabel, images: env.images, ...(env && workerEnvelopes.has(env as import("../contract").PageToolEnvelope) && typeof env.textValue === "string" ? { textValue: env.textValue } : {}) };
        };
        runBackgroundAgent(
            { task: modelTask, systemPrompt: p.systemPrompt, tools: toolMetas, model: p.model, think: p.think, maxSteps: p.maxSteps, autoApprovePython: p.autoApprovePython, autoApproveSelfSource: p.autoApproveSelfSource, unattended: p.unattended, toolTokens: p.toolTokens, stream: p.stream, ...(p.origin ? { origin: p.origin } : {}), runId, seqBase, tokenStore: sessionTokens(runId), labelMatch: p.labelMatch, resumeMessages, images: p.images,
              // A resumed turn follows a PERSON (a follow-up, Continue, Retry) — except a run resurrected after the
              // worker was evicted, where nobody was waited on.
              ...(resumeMessages && !resurrected ? { after: "human" as const } : {}) },
            {
                callModel: async (messages, opts) => {
                    // A resumed history was written before this run, perhaps before the scrub or under another config: its
                    // tool results reach the model again here, so they cross `forModel` too, once, in place (and are stored so).
                    if (!historyScrubbed) {
                        historyScrubbed = true;
                        if (resumeMessages?.length) await forModelHistory(messages);
                        // A session that comes back after an archive is told once, before its first step, that its run policies went. A SYSTEM
                        // message, never a user one: the note is the worker's, and must not read as the person's words.
                        // Only a resume the person started (`builtBy` is the worker's to set): a page naming a hash must not be told, or consume, another origin's note.
                        const gone = resumeMessages?.length && p.builtBy === "worker" ? takeArchiveNotice(runId) : undefined;
                        if (gone) { (messages as { role: string; content: string }[]).push({ role: "system", content: gone }); recordRunLog(runId, { subsystem: "policy", kind: "archive-told", reason: "archived" }); }
                    }
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
                        let calls: import("../contract").LiveToolCall[] | undefined;
                        const flush = (acc: { reasoning: string; content: string; tokens?: number; reasoningTokens?: number; calls?: import("../contract").LiveToolCall[] }): void => {
                            if (abortCtl.signal.aborted) return;
                            last = Date.now();
                            if (acc.tokens != null) tokens = acc.tokens;
                            if (acc.reasoningTokens != null) reasoningTokens = acc.reasoningTokens;
                            fanEvent({ kind: "agent-stream", id: runId, ts: last, save: false, session: { hash: runId, turn: step }, step, localStep: rawStep,
                                ...(acc.reasoning ? { reasoning: acc.reasoning } : {}), ...(acc.content ? { content: acc.content } : {}),
                                ...(tokens != null ? { tokens } : {}), ...(reasoningTokens != null ? { reasoningTokens } : {}),
                                // The call being WRITTEN, so a long argument (a script, a document) is watched arriving
                                // rather than appearing whole when the model stops.
                                ...(acc.calls?.length ? { calls: acc.calls } : {}) });
                        };
                        const r = await streamAgentTurn({ messages, tools: toolDefs, model: modelNow(), think: p.think, hint },
                            (acc) => {
                                // Kept even when this delta is throttled away, so the next one out — or the final
                                // flush — carries the newest count rather than the last one that happened to fan.
                                if (acc.tokens != null) tokens = acc.tokens;
                                if (acc.reasoningTokens != null) reasoningTokens = acc.reasoningTokens;
                                if (acc.calls) calls = acc.calls;
                                // A phase CHANGE goes out immediately and unthrottled — there are a handful per
                                // turn, and it is the edge the live bar draws its divider at. Text deltas stay
                                // throttled; they are continuous.
                                if (acc.phaseChanged) emitTurn(rawStep, acc.phases);
                                if (Date.now() - last >= STREAM_EMIT_MS) flush(acc);
                            }, abortCtl.signal);
                        // Final: land the last delta even if throttled. The calls as last written go too, so the preview holds until
                        // the step that runs them replaces it rather than blinking out in the gap before it.
                        flush({ reasoning: r.reasoning || "", content: r.content || "", ...(calls ? { calls } : {}) });
                        return { content: r.content, tool_calls: r.tool_calls, reasoning: r.reasoning, usage: r.usage };
                    }
                    const r = await fetchLLM({ messages, tools: toolDefs, model: modelNow(), think: p.think, raw: true, hint }, abortCtl.signal) as { content: string | null; tool_calls: ToolCall[]; reasoning: string | null; usage: TokenUsage | null };
                    return { content: r.content, tool_calls: r.tool_calls, reasoning: r.reasoning, usage: r.usage };
                },
                // Every result crosses into the model's context here, without the config's secrets; the text as the tool
                // wrote it goes to the execution log's `key`, which the person reads and the model never does.
                forModel: async (name, result) => {
                    const r = await forModel(result);
                    if (r.changed) recordRunLog(runId, { level: "warn", subsystem: "tool", kind: "scrubbed", reason: "config-secret", key: result, detail: { tool: name } });
                    return r.text;
                },
                // A call routed for the page-built run it was, whose run is handed to the worker before it is sent (a revoke while
                // it was being built, nav-handover.ts), is built again as the worker's run: never sent to the page as it was.
                // A page the run is held on (nav-arrival.ts) runs nothing of it: the call is answered by the hold, or waits for
                // the person's answer and carries it (`withArrival`).
                delegateTool: (name, args, onStream, call) => withArrival(call, () => withShCalls(runId, call ? seqBase + call.seq : undefined, () => againIfHandedOver(async () => {
                    // This call's own key for the grants it mints on the tab (sw-consent.ts): another run on the same tab
                    // ending its call drops only its own.
                    const callKey = {};
                    // Every routing decision below reads `byWorker()`: a navigation's hand-over must be decided first.
                    await handOverSettled(tabId);
                    // Routed for the page that built the run: sent only while the run is still the page's (`sendTool`).
                    const pageRouted = !byWorker();
                    // Where an approved exec of a run the worker built runs (exec-routing.ts): the page's world, an isolated
                    // world on the same tab (sw-isolated-exec.ts), or nowhere. Decided before any grant is minted on the tab.
                    const js = name === "exec" && byWorker() && typeof (args as { js?: unknown }).js === "string" ? (args as { js: string }).js : undefined;
                    let execNote: string | undefined, execDoc: string | undefined;
                    // The route is decided here, so the page is not told which world was asked for: it sees the call only when
                    // the call runs in its world, where that is no news.
                    const pageArgs = name === "exec" ? withoutWorld(args as Record<string, unknown>) : args;
                    // A page-built run's exec runs in its page's world or not at all (an approval's edit could have added one).
                    if (name === "exec" && !byWorker()) { const refused = pageWorldRefusal((args as { world?: unknown }).world); if (refused) return { result: refused }; }
                    if (js !== undefined) {
                        // The document FIRST, then its URL: the call is pinned to that document, so a navigation after this
                        // read makes the send fail instead of landing on the next page, whatever the URL then says. The URL
                        // is the browser's, not the run's start page (a worker that restarted has no navigation record).
                        execDoc = await documentOn(tabId);
                        const route = await execRoute(js, (args as { world?: unknown }).world);
                        recordRunLog(runId, { subsystem: "routing", kind: `exec-${route.where}`, reason: route.reason, detail: { tool: name, ...(route.where === "isolated" ? { how: route.how } : {}) } });
                        if (route.where === "refused") return { result: route.result, renderIn: execCodeIn(js) };
                        if (route.where === "isolated") {
                            const snap = p.selfIntrospection === false ? undefined : contextByRun.get(runId);
                            // Never unpinned: what it is given is the run's, so with no document to hold it to, it does not run.
                            if (!execDoc) return { result: "Error: could not tell which page the tab holds now, so this exec was not run. Run it again.", renderIn: execCodeIn(js) };
                            const reads = await preReadsFor(runId, js, true);
                            // ml.sh, for a script that names it: bound to THIS run and the step it runs in, never to anything the
                            // script says. Each call is judged by a policy or asked of the person inside the step (sw-shell-call.ts).
                            const shCtx = execNames(js).sh && call ? { runId, seq: seqBase + call.seq, local: call, signal: abortCtl.signal, tokens: sessionTokens(runId) } : undefined;
                            let shWaited = 0;
                            const sh = shCtx ? async (c: "run" | "read", a: unknown[]) => {
                                const r = c === "run" ? await shRun(shCtx, a) : await shRead(shCtx, a);
                                // The script's world shares the page's DOM: an error's text crosses scrubbed, as a page's would.
                                if ("error" in r) return { ...r, error: (await forPage({ error: r.error })).error };
                                const w = "ok" in r ? (r.ok as { waitedMs?: unknown } | null)?.waitedMs : undefined;
                                if (typeof w === "number") shWaited += w;
                                return r;
                            } : undefined;
                            const out = await runIsolatedExec({
                                tabId, runId, js, how: route.how, reason: route.reason, reads, onStream, documentId: execDoc, sh: !!sh,
                                // What the world may ask for while it runs: re-pipes of what it was sent, those stored tables, and ml.sh.
                                serve: isoServer(runId, reads, { deref: wholeDerefFor(runId), holders: valueHolders, columns: readStoredColumns, ...(sh ? { sh } : {}) }),
                                // Made only for a script that names it, as a survey's is (tryReadonly below).
                                ...(snap && execNames(js).current ? { current: async () => withPolicies(withRuntime(await withEnv(await withUserWatches(snap({ model: modelNow(), log: eventsForRun(await runLog.all(), runId) })), tabId, !!p.autoApproveReadonly, !byWorker())), runId) } : {}),
                            });
                            // A reading taken after a wait for the person is not simultaneous with one taken before: say so.
                            return shWaited >= 1000 ? { ...out, result: `${out.result}\n(ml.sh waited ${Math.round(shWaited / 1000)} s for the person to approve.)` } : out;
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
                    const reads = name === "exec" && typeof (args as { js?: unknown }).js === "string" ? await preReadsFor(runId, (args as { js: string }).js, false) : undefined;
                    if (reads) execReads.set(runId, reads);
                    // A remote tool's args LEAVE THE MACHINE, so the grant is minted for the exact call the
                    // human saw — never for the tool in general. The identity comes from the tool's declared
                    // `remote` target rather than its name, which is what keeps the approval card and the
                    // grant reading the same thing: a friendly name cannot make the card say one callable
                    // while the grant authorises another.
                    const remote = p.tools.find(t => t.name === name)?.remote;
                    // A python_exec the WORKER runs gets its grants as the RUN's call grant (worker-tools.ts): on the tab
                    // they were a sheet read with the person's cookies, and outside-the-dialect Python, that any script on the
                    // page could use while the call ran. Every python_exec of a run the worker drives runs there (an image
                    // and a page table are asked of the page as data, worker-media.ts, worker-page-read.ts); only a
                    // page-built run's still runs on its page, an approved site's, and mints the tab's.
                    const pyInWorker = name === "python_exec" && byWorker() && runsInWorker(p, name);
                    if (pyInWorker) {
                        await ensureLocalTools(runId, p, tabId, () => tabPageUrl.get(tabId) || p.pageUrl || "", pyMedia).catch(() => { /* nothing granted: fails closed */ });
                        const pyCode = String((args as { code?: unknown }).code ?? "");
                        const outsideCode = pythonCellInDialect(pyCode) ? null : pyCode;
                        // The JavaScript bridges only for a cell a PERSON approved with the card's line showing (bridge-names.ts).
                        const bridges = outsideCode !== null && call?.person === true && namesJsBridge(outsideCode);
                        if (bridges) await markPythonBridged(runId);
                        grantRunPython(runId, { sheets: externalSheetIds(args), code: outsideCode, ...(call ? { step: { seq: seqBase + call.seq, local: { seq: call.seq, step: call.step } } } : {}), ...(bridges ? { bridges: true } : {}) });
                    }
                    // What this call puts on the TAB for its own sub-ops (tabGrantsForCall, grant-extract.ts): an exec's literal
                    // fetch URLs, a server tool's exact call, and a page-built run's python_exec's outside-the-dialect code and sheets.
                    // Minted only when there is something to mint, so a call with none holds no entry.
                    const minted = tabGrantsForCall({ name, args: args as Record<string, unknown>, builtByWorker: byWorker(), pyInWorker,
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
                        if (name === "navigate") { const to = navDest(String((args as { url?: unknown }).url ?? "")); namedNav = to ? unfragmented(to.href) : undefined; }
                        /** The destination's pageInfo, unless it came from the document this call left. */
                        const takeInfo = (): string | undefined => {
                            const r = readoptPageInfo.get(tabId); readoptPageInfo.delete(tabId);
                            // The destination's own text, folded into this call's result: held as the call's answer is.
                            if (!r || (sentTo !== undefined && r.doc === sentTo)) return undefined;
                            const info = capPageContext(r.info, byWorker());
                            if (info !== undefined && info !== r.info) recordRunLog(runId, { level: "warn", subsystem: "page", kind: "answer-capped", reason: "result",
                                detail: { tool: "pageInfo", slot: "envelope", field: "pageInfo", from: r.info.length, to: UI_OUT_CAP } });
                            return info;
                        };
                        try {
                            // A worker-built run's answer set is the worker's: the script is sent its shape, and what it changed
                            // comes back to be replayed (worker-answer.ts).
                            const answerShape = js !== undefined && workerAnswer() ? await answerShapeFor(runId) : undefined;
                            env = await sendTool({ runId, name, args: pageArgs as Record<string, unknown>, stream: !!onStream, ...(reads ? { reads } : {}), ...(answerShape ? { answerShape } : {}) }, onStream, execDoc, pageRouted) as Partial<import("../contract").PageToolEnvelope>;
                            if (answerShape && env?.answerOps !== undefined) await replayOps(env.answerOps);
                        } catch (e) {
                            if (e instanceof HandedOverMidCall) throw e;
                            const emsg = (e as Error)?.message || String(e);
                            if (!CHANNEL_GONE.test(emsg)) {
                                env = { result: `Error: could not reach the page to run "${name}" (${emsg}).` }; workerMade = true;
                            } else {
                                // The page navigated out from under the call. Its pageInfo may already be here (a fast
                                // re-adopt beat us); else engage the barrier and wait for it (bounded by the barrier's
                                // own timeout, then a generic "still loading" note).
                                let info = takeInfo();
                                if (!info) { navBarrier.noteNavigating(tabId, sentTo); await navBarrier.whenReady(tabId); info = takeInfo(); }
                                const arrived = await passArrival(call ? seqBase + call.seq : undefined);
                                if (arrived) info = arrived.text;
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
                            const venv = fromPage(await delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload: { runId, ...payload } }).catch(() => null), name, args) as Partial<import("../contract").PageToolEnvelope> | null;
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
                                // Where it landed may hold the run (nav-arrival.ts): the model reads the hold, or the person's answer.
                                const arrived = await passArrival(call ? seqBase + call.seq : undefined);
                                const info = arrived ? undefined : takeInfo();
                                if (arrived) env.result = `${env.result || ""}\n\n${arrived.text}`;
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
                                        : await delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload }).then((e) => fromPage(workerVision() ? withoutPageVision(e) : e, name, args), () => null) as Partial<import("../contract").PageToolEnvelope> | null;
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
                        // describeElement into a SEALED shadow root, for a run the worker drives: the worker resolves the MODEL's
                        // selector through the debugger and writes the result (tools.ts `sealedDescribe`), where the page used to
                        // send CDP_SHADOW_RESOLVE itself. A page-built run's page resolves its own (an approved site's).
                        // Only describeElement asks for it: the page's echo on another tool is dropped, so it cannot drive the debugger.
                        if (env?.cdpShadowResolve && name !== "describeElement") { env = { ...env }; delete env.cdpShadowResolve; }
                        if (env?.cdpShadowResolve && byWorker()) {
                            const sel = typeof (args as { selector?: unknown }).selector === "string" ? (args as { selector: string }).selector : "";
                            // A `>>>` path is all the worker can check: whether its first hop is sealed is the page's DOM's to say.
                            const hops = sel.split(">>>").map((h) => h.trim()).filter(Boolean).length;
                            const r = hops >= 2 && (await getConfig()).cdp ? await cdpShadowResolve(tabId, sel) : null;
                            env = { ...env, result: sealedDescribe(sel, r && "matches" in r ? r.matches : null) };
                            delete env.cdpShadowResolve;
                        }
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
                            // Pinned to the document the exec was routed to (or sent to): the page can force this path and then
                            // navigate, and the approved code must not run, with a user gesture, on whatever document is next.
                            const cdpDoc = execDoc ?? sentTo;
                            if (!cdpDoc) return { result: `${env.result || ""}\n\nThe exec was not run through the debugger: could not tell which page the tab holds now. Run it again.`, renderIn: env.renderIn, renderOut: env.renderOut };
                            const r = await cdpEval(tabId, cdpDoc, approvedSource, onStream);
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
                            // An error the page's world shaped (the script threw in it) carries the page-world heading like a result does.
                            const failure = `${env.result || ""}\n\n${r.error}`;
                            return { result: "pageShaped" in r && r.pageShaped ? pageWorldResult(failure) : failure, renderIn: env.renderIn, renderOut: env.renderOut };
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
                        return { result: (env?.result || `Error: the page returned nothing for tool "${name}".`) + (execNote ? `\n\n${execNote}` : ""), renderIn: env?.renderIn, renderOut: env?.renderOut, feedback: env?.feedback, image: env?.image, imageLabel: env?.imageLabel, images: env?.images, remoteMs: env?.remoteMs, ...(env && workerEnvelopes.has(env) && typeof env.textValue === "string" ? { textValue: env.textValue } : {}) };
                    } finally {
                        dropCallGrants(tabId, callKey);   // grants were for THIS approved call's sub-ops only; another run's call on the tab keeps its own
                        if (pyInWorker) grantRunPython(runId, null);
                        if (reads) execReads.delete(runId);
                        if (onStream) delegateStreams.delete(runId);   // the call is done — stop routing live chunks to it
                    }
                }))),
                // Pre-run In render for a PENDING step (streaming runs): ask the page to compute the tool's
                // In descriptor without running it, so a step you watch stream shows exec's beautified JS /
                // python's code cell from the start instead of raw JSON args. Best-effort — raw args on failure.
                renderFor: async (name, args) => {
                    // exec's In is pure (the page draws it with the same function), so the worker draws it: the script is
                    // the model's text and may carry what it read elsewhere, which a step that never runs there should not
                    // lend the page (docs/spec/SITE_ACCESS.md slice 2).
                    if (name === "exec") return typeof args.js === "string" ? execCodeIn(args.js) : undefined;
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
                // A pointer to a stored table: this session holds it until the session is released. The key is read off the
                // step's render, which a page's answer writes, so only a value this run may hold is claimed (runMayClaim).
                claimValue: (key) => claimValue(key, runId, runMayClaim(byWorker() ? null : pageValueSession(tabId))),
                // The whole of a stored text the run's pointer names, for the dereference tool. Only a value this run holds.
                readText: (key) => readStoredText(key, runId),
                tryReadonly: p.autoApproveReadonly || p.autoApprovePython ? async (name, args, live) => {
                    // A run held on its page (nav-arrival.ts) surveys nothing there, and runs no cell: the call goes on to its hold.
                    await arrivalSettled(tabId);
                    if (arrivalHold(runId)) return null;
                    if (name === "python_exec") return tryPythonInside(args);
                    if (name !== "exec" || !p.autoApproveReadonly) return null;
                    // Every decision below reads `byWorker()`: a navigation's hand-over must be decided first, as delegateTool does.
                    await handOverSettled(tabId);
                    // A call that names its world: one it cannot have goes to the precheck, which says why, and one that asked
                    // for an isolated world is answered in the worker or not at all, never in the page's (the page leg below).
                    // Nor one the DEFAULT world isolates: the page would see its script and could answer for it.
                    const world = (args as { world?: unknown }).world ?? undefined;   // null is omitted
                    // A page-built run's exec runs in the page's world or not at all: a world it cannot have is refused in the
                    // precheck below, never surveyed by the page.
                    if (!byWorker() && pageWorldRefusal(world)) return null;
                    const worldAsked = byWorker() && world !== undefined;
                    if (worldAsked && (typeof args.js !== "string" || (await execRoute(args.js, world)).where === "refused")) return null;
                    let pageLegOk = !worldAsked || world === "page";
                    if (pageLegOk && !worldAsked && byWorker() && typeof args.js === "string" && defaultExecWorld((await getConfig()).execDefaultWorld) === "isolated") {
                        const r = await execRoute(args.js, undefined);
                        pageLegOk = !(r.where === "isolated" && r.reason === "default");
                    }
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
                    try { current = snap && wantsLog ? withPolicies(withRuntime(await withEnv(await withUserWatches(snap({ model: modelNow(), log })), tabId, !!p.autoApproveReadonly, !byWorker())), runId) : undefined; } catch (e) {
                        recordRunLog(runId, { level: "warn", subsystem: "routing", kind: "current-failed", reason: e instanceof Error ? e.message || e.name : String(e), detail: { tool: name } });
                        return null;
                    }
                    const w = await evalReadonlyInWorker(args, {
                        ...(snap ? { current: () => current ?? snap({ model: modelNow(), log }) } : {}),
                        ml: workerReadonlyMl(tabPageUrl.get(tabId) ?? "", derefByRun.get(runId), runId),
                        live,
                        signal: abortCtl.signal,
                    });
                    if (w.kind !== "needs-page") {
                        recordRunLog(runId, { subsystem: "routing", kind: "readonly-worker", reason: w.kind === "answered" ? "no-page-reads" : "out-of-dialect", detail: { tool: name } });
                        return w.kind === "answered" ? { result: w.result, renderIn: w.renderIn, renderOut: w.renderOut } : null;
                    }
                    if (!pageLegOk) {
                        recordRunLog(runId, { subsystem: "routing", kind: "readonly-worker", reason: "world-isolated", detail: { tool: name } });
                        return null;
                    }
                    // Live console lines reach the loop's fan the way a delegated tool's do (delegateStreams). Dropped
                    // BEFORE returning, so a chunk still in flight from a refused try cannot land after the loop's
                    // discard: it finds no sink.
                    if (live) delegateStreams.set(runId, live.push);
                    // STOP reaches the survey in the page too: the loop has stopped waiting for it (agent-loop.ts
                    // `orStopped`), and the page halts its interpreter at the next await. Fire-and-forget: a tab that
                    // cannot be told has a survey bounded by its own budget, whose answer nothing reads.
                    const tellStop = (): void => { void chrome.tabs.sendMessage(tabId, { type: "CANCEL_TOOL_IN_PAGE", payload: { runId } }).catch(() => {}); };
                    abortCtl.signal.addEventListener("abort", tellStop, { once: true });
                    try {
                        const answerShape = workerAnswer() ? await answerShapeFor(runId) : undefined;
                        const env = await sendTool({ runId, name, args: byWorker() ? withoutWorld(args) : args, readonlyTry: true, stream: !!live, ...(answerShape ? { answerShape } : {}) }, live?.push)
                            .catch(() => null) as Partial<import("../contract").PageToolEnvelope> | null;
                        // Only an answered survey's changes count: a refused try leaves nothing behind, as on the page.
                        // Nor a survey's that answered after Stop: the loop stopped reading it (agent-loop.ts `orStopped`).
                        if (answerShape && env?.readonly && env.answerOps !== undefined && !abortCtl.signal.aborted) await replayOps(env.answerOps);
                        recordRunLog(runId, { subsystem: "routing", kind: "readonly-page", reason: env?.readonly ? "reads-page" : "refused-in-page", detail: { tool: name } });
                        return env && env.readonly ? { result: env.result || "", renderIn: env.renderIn, renderOut: env.renderOut, reused: env.reused } : null;
                    } finally {
                        abortCtl.signal.removeEventListener("abort", tellStop);
                        if (live) delegateStreams.delete(runId);
                    }
                } : undefined,
                // A tool call that threw (a page's malformed answer, odd arguments) became an error result in the loop; the
                // execution log is where the person sees what threw. The message is free text, so it goes in `key`, which the
                // model's view of the log never carries.
                toolThrew: (name, phase, e) => recordRunLog(runId, { level: "error", subsystem: "tool", kind: "threw", reason: phase,
                    key: thrownKey(e), detail: { tool: name } }),
                // Doomed-action precheck (click/type): ask the page to resolve the target side-effect-free.
                // A non-null error → the gate is SKIPPED and the error returned. Only delegated for tools
                // that HAVE a precheck (avoids a useless round-trip on every gated call).
                precheck: async (name, args) => {
                    await arrivalSettled(tabId);
                    if (arrivalHold(runId)) return null;   // nothing is asked of a page the run is held on
                    // A proposal is checked in the worker: one that does not run, or a run that does not offer the tool, is
                    // told to the model and never shown to the person as a card.
                    if (name === "propose_policy") {
                        if (!offersProposals()) return `Error: propose_policy is not offered in this run.`;
                        const c = checkProposal(args);
                        return "error" in c ? c.error : null;
                    }
                    // A manifest draft is resolved through the host and checked as the store would; nothing runs.
                    if (name === "propose_manifest") {
                        if (!offersManifests()) return `Error: propose_manifest is not offered in this run.`;
                        // A library's file is resolved, never read, before the card: the read is the card's own step's call.
                        if (isLibraryDraft(args)) return precheckLibrary({ runId, seq: seqBase }, args);
                        const c = await checkManifestProposal({ runId, seq: seqBase }, args);
                        return "error" in c ? c.error : null;
                    }
                    // A worker-built run's exec is checked here, never on the page: its checks need nothing of the page's, and
                    // the page is not shown a call that may run in another world. A `world` it cannot have is refused before
                    // the person is asked to approve it (a call without one is routed after approval, as before).
                    if (name === "exec" && byWorker()) {
                        // Not routed, so not run: a call whose source is no string would otherwise go to the page as it came.
                        if (typeof args.js !== "string") return `Error: invalid arguments for "exec": "js" must be a string.`;
                        if (args.world != null) { const r = await execRoute(args.js, args.world); if (r.where === "refused") return r.result; }
                        return outputCapPrecheck("exec", args);
                    }
                    if (name === "exec") { const refused = pageWorldRefusal(args.world); if (refused) return refused; }
                    if (!p.tools.some((t) => t.name === name && t.precheck)) return null;
                    const env = await sendTool({ runId, name, args, precheck: true })
                        .catch(() => null) as Partial<import("../contract").PageToolEnvelope> | null;
                    if (env && env.precheckFailed) return env.result || "";
                    // A click on a link a policy denies is refused before the click: the describe layer of the arrival rule.
                    if (name === "click" && typeof env?.href === "string") {
                        const j = judgeCall(runId, "fetch", navigateFacts(env.href));
                        const v = arrivalVerdict(env.href, j);
                        if (v.kind === "deny" && j.by && j.by !== "builtin") {
                            recordRunLog(runId, { subsystem: "policy", kind: "deny", reason: j.by.label, detail: { policy: j.by.id, scope: j.by.scope, tool: "click", url: v.url } });
                            return clickDeniedText(v);
                        }
                    }
                    return null;
                },
                approve: async ({ tool, arguments: args, seq, step, askWhy: gateWhy }) => {
                    // A page the run is held on is answered first (nav-arrival.ts): this call's card follows only if the
                    // person lets the run act there.
                    const arrived = await passArrival(seq != null ? seqBase + seq : undefined);
                    if (arrived && !arrived.allowed) return { approved: false, feedback: arrived.text };
                    // Ask the page to compute the In render for THIS call (without running the tool) so the
                    // blocking approval shows a pretty In — exec's beautified JS, python's code cell — not
                    // raw args. Best-effort: raw args on any failure. (Out has nothing to render pre-run.)
                    let renderIn: unknown = tool === "exec" && typeof args.js === "string" ? execCodeIn(args.js) : undefined;
                    // propose_policy's card is the worker's alone: the code as sent, led by its breadth, measured here over
                    // the run's own fetch_url calls and a probe of unrelated sites, never anything the model said of it. What
                    // the person approves is `proposal`, and only that is added (the resolve below).
                    let proposal: PolicyProposal | undefined;
                    if (tool === "propose_policy") {
                        const c = offersProposals() ? checkProposal(args) : undefined;
                        if (c && "proposal" in c) {
                            proposal = c.proposal;
                            let messages: readonly import("../contract").NeutralMessage[] = [];
                            try { messages = contextByRun.get(runId)?.().messages ?? bgRuns.get(runId)?.messages ?? []; } catch { /* no history: measured over nothing, and the card says so */ }
                            renderIn = { type: "code", text: proposal.source, lang: "javascript", format: true, note: breadthNote(proposal, measureBreadth(proposal, recordedFetches(messages))) };
                        } else renderIn = { type: "code", text: "", lang: "javascript", note: "This proposal cannot be added: the run does not offer propose_policy, or it does not run." };
                    }
                    // propose_manifest's card is the worker's too: the draft pinned to what the host resolved, led by how it
                    // reads this run's own calls of the program (DERIVED: the host resolved them, nothing ran). What the
                    // person approves is `manifest`, and only that is stored (the resolve below).
                    let manifest: CheckedManifest | undefined;
                    // A library's card: its source as read by this step's recorded cat, under the shape rule's derived note.
                    let library: CheckedLibrary | undefined;
                    if (tool === "propose_manifest" && isLibraryDraft(args)) {
                        const local = { step: step ?? 0, seq: seq ?? 0 };
                        const c = offersManifests() ? await checkLibraryProposal({ runId, seq: seq != null ? seqBase + seq : seqBase, local, signal: abortCtl.signal, tokens: sessionTokens(runId) }, args) : undefined;
                        if (c && "request" in c) { library = c; renderIn = { type: "code", text: c.request.source, lang: "python", note: c.note }; }
                        else renderIn = { type: "code", text: "", lang: "python", note: c ? `This library cannot be stored: ${c.error.replace(/^Error: /, "")}` : "This library cannot be stored: the run does not offer propose_manifest, or ml.sh is not set up." };
                    } else if (tool === "propose_manifest") {
                        const owner = { runId, seq: seq != null ? seqBase + seq : seqBase };
                        const c = offersManifests() ? await checkManifestProposal(owner, args) : undefined;
                        if (c && "request" in c) {
                            manifest = c;
                            renderIn = { type: "code", text: JSON.stringify(c.request.manifest, null, 2), lang: "json", note: await draftCardNote(owner, c) };
                        } else renderIn = { type: "code", text: "", lang: "json", note: c ? `This manifest cannot be stored: ${c.error.replace(/^Error: /, "")}` : "This manifest cannot be stored: the run does not offer propose_manifest, or ml.sh is not set up." };
                    }
                    if (!renderIn) try {
                        const env = await sendTool({ runId, name: tool, args, renderOnly: true }) as { renderIn?: unknown };
                        renderIn = env?.renderIn;
                    } catch { /* page gone → no preview, fall back to raw args */ }
                    // A `world` that moves this exec away from where the default would run it is said on the card: under an
                    // isolated default, a page that steers the model to its own world is then seen by the person approving.
                    if (tool === "exec" && byWorker() && typeof args.js === "string" && args.world != null && renderIn && typeof renderIn === "object") {
                        const note = worldCardNote(await execRoute(args.js, args.world), await execRoute(args.js, undefined));
                        const prev = (renderIn as { note?: string }).note;
                        if (note) renderIn = { ...renderIn, note: prev ? `${prev}. ${note}` : note };
                    }
                    // Key by the OFFSET seq — the same value the app sees on the emitted step (emitStep
                    // offsets raw→seqBase+raw) and echoes back in SET_APPROVAL. Keying by the raw seq meant a
                    // follow-up turn (seqBase>0) never matched → the gate hung forever ("stuck on Approve" on
                    // turn 2+). Turn 1 worked only because seqBase==0. (Mirror emitStep's null-guard exactly.)
                    const gateSeq = seq != null ? seqBase + seq : seq;
                    const key = `${runId}:${gateSeq}`;
                    // button #3: statically extract the persistable egress grants (e.g. this exec's inline
                    // ml.fetch literals) ONCE, background-side. The SAME list feeds the descriptor/step the
                    // human reviews AND the persistence below, so what's shown IS what's remembered.
                    // A call an `ask` policy raised offers nothing to remember, and an exec's fetch literals an `ask` policy
                    // matches are not offered: the only result of remembering them would be an `allow` the `ask` overrides.
                    const byAsk = askedByPolicy(gateWhy);
                    const offered = byAsk ? { grants: [] } : withoutAsked(runId, extractGrants(tool, args));
                    const grants = offered.grants;
                    let askWhy = gateWhy ?? offered.why;
                    // A cell outside the dialect in a run whose earlier cell ran with the bridges lifted: its card says what that
                    // cell may have kept. Read here, where a wait is allowed: the mark outlives an evicted worker (sw-python.ts).
                    if (tool === "python_exec" && askWhy?.cause === "outside-dialect" && await pythonRunBridged(runId)) askWhy = { ...askWhy, bridged: true };
                    if (askWhy?.policy !== undefined && !askedByPolicy(askWhy)) recordRunLog(runId, { subsystem: "policy", kind: "lapsed", reason: askWhy.cause, detail: { tool, policy: askWhy.policy, ...(tool === "fetch_url" ? { url: String((args as { url?: unknown }).url ?? "") } : {}) } });
                    // A worker tool's approval is granted to the run's state in this worker (worker-tools.ts), rebuilt here
                    // if an eviction took it, so the decision below has somewhere to put it.
                    if (byWorker() && runsInWorker(p, tool)) await ensureLocalTools(runId, p, tabId, () => tabPageUrl.get(tabId) || p.pageUrl || "", pyMedia).catch(() => { /* nothing granted: fails closed */ });
                    return new Promise<ApprovalDecision>((resolve) => {
                        pendingApprovals.set(key, {
                            resolve: (decision) => {
                                const ok = decision === true || (typeof decision === "object" && !!decision && decision.approved);
                                // What a decision remembers (consents, grants) is read from the model's arguments, which can be
                                // anything: a throw there must not leave the gate hanging, so the decision is still delivered.
                                // A grant that was not minted fails closed: the call it was for is refused.
                                try {
                                    if (ok && tool === "python_exec") for (const id of externalSheetIds(args)) approvedSheets.add(id);
                                    // Approving a cross-origin nav consents to that ORIGIN for the rest of the run
                                    // (repeat navs to it then skip the gate).
                                    // It is also an as-you grant for that origin, in every mode (docs/spec/POLICIES.md, "One consent,
                                    // scoped by the origin"), held by the run in the worker, never on the tab: a script on the tab could
                                    // spend a tab's grant. A page-built run's fetch runs in the page and keeps its per-URL approvals.
                                    if (ok && tool === "navigate") {
                                        const dest = navDest(String((args as { url?: unknown }).url ?? ""));
                                        if (dest) { consentedOrigins.add(dest.origin); if (byWorker() && runsInWorker(p, "fetch_url")) grantRunOrigin(runId, dest.origin); }
                                    }
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
                                        if (u && byWorker() && runsInWorker(p, "fetch_url")) grantRunFetch(runId, u, cred);
                                        // A fetch an `ask` policy raised is approved for this one call: the tab remembers nothing.
                                        else if (u) { if (cred) grantCredFetch(tabId, u); else if (byAsk) grantOnceFetch(tabId, u); else consentFetch(tabId, u); }
                                    }
                                    // button #3: "Approve + remember" — the exec's static ml.fetch literals become RUN
                                    // policies (sw-policies.ts), one per URL the person saw: kept with the session, and
                                    // never lent to the tab, so the page's own FETCH_URL does not get them.
                                    if (ok && typeof decision === "object" && decision.persist)
                                        for (const g of grants) if (g.kind === "fetch-url") rememberFetchUrls(runId, g.urls);
                                    // A proposed policy is added HERE, from the person's answer, and only the proposal the card
                                    // showed; the tool's own run only reports whether it is there.
                                    // A proposed manifest is stored HERE, from the person's answer, and only the one the card showed;
                                    // its evidence run follows, and the tool's own run reports both.
                                    if (ok && tool === "propose_manifest" && manifest && offersManifests())
                                        approveManifest({ runId, seq: gateSeq ?? seqBase, signal: abortCtl.signal }, manifest);
                                    // A proposed library: loaded under the gate, and stored only if that load agrees.
                                    if (ok && tool === "propose_manifest" && library && offersManifests()) approveLibrary(runId, library);
                                    if (ok && tool === "propose_policy" && proposal && offersProposals()) {
                                        const added = addRunPolicy(runId, { consumer: "fetch", ...proposal, origin: "proposed" });
                                        recordRunLog(runId, { subsystem: "policy", kind: "added", reason: added.label, detail: { policy: added.id, effect: added.effect, tool } });
                                    }
                                } catch (e) {
                                    recordRunLog(runId, { level: "error", subsystem: "tool", kind: "threw", reason: "approve", key: thrownKey(e), detail: { tool } });
                                }
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
                            descriptor: ((base) =>
                                // An uncredentialed fetch_url the worker runs is a call a policy may decide, so the card
                                // is judged again when one changes (`rejudgePending`): its facts, resolved here.
                                tool === "fetch_url" && !(args as { credentials?: unknown }).credentials && byWorker() && runsInWorker(p, "fetch_url")
                                    ? { ...base, consumer: "fetch" as const, facts: fetchFacts(String((args as { url?: unknown }).url ?? ""), { rendered: !!(args as { rendered?: unknown }).rendered }) }
                                    : base)({ key, runId, seq: gateSeq ?? -1, step: step ?? -1, tool, arguments: args, ts: Date.now(), routing: p.approvalRouting || "ui" }),
                        });
                        // Patch the pending step to show approve/deny (awaitingApproval) + the In preview. ALL
                        // three surfaces render it identically from this one step: overlay/off in the page
                        // iframe (slide-out panel vs corner card), devtools in the panel. The off-mode card
                        // reveals ITSELF on this step — no separate modal message — and the decision returns via
                        // the same origin-authed SET_APPROVAL, so the gate is unforgeable across every surface.
                        // approvalRouting "external" SUPPRESSES the UI buttons (the gate still blocks — only the
                        // __mlApprovals channel resolves it); "ui"/"both" show them as before.
                        emitStep({ step, seq, pending: true, awaitingApproval: p.approvalRouting !== "external", approvalExternal: p.approvalRouting === "external" || undefined, tool, arguments: args, renderIn, grants: grants.length ? grants : undefined, askWhy });
                    });
                },
                isSheetApproved: (id) => approvedSheets.has(id),
                navNeedsConsent,   // cross-origin nav → gate; same-site / already-consented → auto (see consentedOrigins)
                // A page a policy denies runs no call of the run: refused without a card, and the deny card is put up.
                arrivalRefused: () => {
                    const h = arrivalHold(runId);
                    if (h?.kind !== "deny") return undefined;
                    raiseDenyCard();
                    return arrivalDeniedText(h);
                },
                // A navigate is the `fetch` consumer in its interactive mode: a policy over a host or a URL governs it as it
                // governs the fetch. An `allow` covers a navigate whoever built the run: its arrival is judged again there.
                navPolicy: (url) => {
                    const dest = navDest(url);
                    if (!dest) return undefined;   // unparseable → the tool will error
                    const j = judgeCall(runId, "fetch", navigateFacts(dest.href));
                    if (j.decision === "ask" && !j.by) return "unknown";
                    for (const b of j.broken) recordRunLog(runId, { level: "warn", subsystem: "policy", kind: "broken", reason: b.reason, detail: { policy: b.policy.id, tool: "navigate" } });
                    if (!j.decision || !j.by || j.by === "builtin") return undefined;
                    recordRunLog(runId, { subsystem: "policy", kind: j.decision, reason: j.by.label, detail: { policy: j.by.id, scope: j.by.scope, tool: "navigate", url: dest.href } });
                    return { decision: j.decision, label: j.by.label };
                },
                fetchNeedsConsent: (url) => !(runFetchConsented(runId, url) ?? fetchConsent.get(tabId)?.has(url)),   // a NEW url → gate; an already-approved one → auto
                // The person's policies (sw-policies.ts), judged here in the worker over facts the worker resolved. A `deny`
                // refuses any run's fetch; an `allow` answers only a fetch the worker itself runs, since only there does
                // the fetch's own choke point (worker-tools.ts `consented`) consult the same policies.
                // Why a fetch_url that asks is asking: a policy that would have allowed it is gone. Text only (judgeCall's `lapsed`).
                askWhy: (name, a) => {
                    // A Python cell asks because it is outside the dialect: where the inside try left it, keyed by its source.
                    if (name === "python_exec") return pythonOutsideWhy(pyOutside.get(String(a.code ?? "")));
                    if (name === "navigate") {
                        const dest = navDest(String(a.url ?? ""));
                        const j = dest ? judgeCall(runId, "fetch", navigateFacts(dest.href)) : undefined;
                        return j?.decision === "ask" ? askWhyOf(j) : undefined;
                    }
                    if (name !== "fetch_url") return undefined;
                    const j = judgeCall(runId, "fetch", fetchFacts(String(a.url ?? ""), { credentials: !!a.credentials, rendered: !!a.rendered }));
                    // An `ask` policy is named for any fetch_url the loop gates; a policy that is GONE only for an uncredentialed
                    // fetch the worker runs, the only kind an `allow` ever covered.
                    if (j.decision === "ask") return askWhyOf(j);
                    return a.credentials || !byWorker() || !runsInWorker(p, "fetch_url") ? undefined : askWhyOf(j);
                },
                fetchPolicy: (url, o) => {
                    const j = judgeCall(runId, "fetch", fetchFacts(url, o));
                    if (j.decision === "ask" && !j.by) return "unknown";   // not loaded yet: the call asks, free tiers included
                    for (const b of j.broken) recordRunLog(runId, { level: "warn", subsystem: "policy", kind: "broken", reason: b.reason, detail: { policy: b.policy.id, tool: "fetch_url" } });
                    if (!j.decision || !j.by || j.by === "builtin") return undefined;
                    // An `ask` policy puts the call to the person where a free tier or a remembered consent would run it; it
                    // judges any run the loop gates, as a `deny` does.
                    if (j.decision === "allow" && !(byWorker() && runsInWorker(p, "fetch_url"))) return undefined;
                    recordRunLog(runId, { subsystem: "policy", kind: j.decision, reason: j.by.label, detail: { policy: j.by.id, scope: j.by.scope, tool: "fetch_url", url } });
                    return { decision: j.decision, label: j.by.label };
                },
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
                fetchOnPageOrigin: (url: string): boolean => {
                    const here = tabPageUrl.get(tabId) ?? p.pageUrl;
                    try { return !!here && new URL(url, here).origin === new URL(here).origin; } catch { return false; }
                },
                fetchOriginGranted: (url: string): boolean => byWorker() && runsInWorker(p, "fetch_url") && runOriginGranted(runId, url),
                fetchSameOrigin: (url: string): boolean => {
                    try {
                        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !url.startsWith("//")) return true;   // relative → the page's own origin
                        return consentedOrigins.has(new URL(url.startsWith("//") ? "https:" + url : url).origin);
                    } catch { return false; }
                },
                checkpoint: (messages) => {
                    persistRun(runId, { p: storedP(), tabId, messages, sub: snapSub() });   // durable resume snapshot per step
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
                // Cancelled because its site lost the agent level (Q9): the result says so.
                const reason = cancelReasons.get(runId);
                if (reason && res.cancelled) res.summary = reason;
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
                // A run handed to the worker while this turn ran stays the worker's (`storedP`).
                const resumeP = { ...storedP(), stepBase: stepBase + runMaxStep, seqBase: seqBase + runMaxSeq };
                bgRuns.set(runId, { p: resumeP, tabId, messages, sub: snapSub() });
                // The same snapshot `bgRuns` holds, where it outlives the run: `resumeP` so a later turn continues
                // AFTER this one's steps rather than colliding with them.
                saveRunHistory(runId, { messages, payload: resumeP, sub: snapSub() });
                let answerMedia = runAnswerMedia.length ? runAnswerMedia : undefined;
                // Close the inbox FIRST: a message sent from here to the end of the turn must not be reported as a steer into
                // an inbox nothing reads any more (it reads as "busy", and the person sends it again).
                runInboxes.delete(runId);
                await handOverSettled(tabId);
                const workerNow = byWorker();
                // The page's finish only ends the run's registration there, so it carries the run id and nothing of the run:
                // no summary, which the page's world would read. A run the worker holds lends its page nothing, whether it
                // built the run or was handed it (a navigation onto an unapproved site, a revoke, nav-handover.ts). Its answer
                // is the worker's set (worker-answer.ts). Sent and not awaited: nothing the page answers is read, and a page
                // that never answers (content.ts waits two minutes) would hold the run's result and its next turn. A next
                // turn's adopt goes out behind it on the same channel, so the page still ends the old registration first.
                if (workerNow && !arrivalHold(runId)) void delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload: { runId, finish: true } }).catch(() => null);
                const own = workerNow ? await answerFor(runId) : undefined;
                const answer = own ? (finalizeAnswer(own, res.summary) || undefined) : undefined;
                if (own) { const m = own.media(); answerMedia = m.length ? m : undefined; }
                emitLifecycle({
                    kind: "agent-result", id: runId, ts: Date.now(), save: false, session: { hash: runId, turn: res.steps },
                    summary: res.summary, steps: res.steps, hitCap: !!res.hitCap, cancelled: !!res.cancelled, answerMedia,
                    ...(answer ? { answer } : {}),
                });
                // Sync the run's final history back so a createAgent handle's control.messages stays live,
                // + this run's step/seq extents so the page advances its bases for the NEXT turn's offset. The
                // answer element visuals ride on `res` too, so the page-side caller's own agent-result carries them.
                // A turn the page started whose run was handed to the worker meanwhile (a revoke, nav-handover.ts): the page
                // waiting on this answer is the one that lost the run, so it is told so and given nothing the worker did.
                if (handedThisTurn()) { sendResponse({ error: HANDED_ANSWER }); return; }
                sendResponse({ data: { ...res, answerMedia }, messages, stepCount: runMaxStep, seqCount: runMaxSeq });
            })
            .catch((err) => {
                // A fatal loop error — surface it to the off-mode card (the page's bus is dormant there,
                // so injected can't), then reject the round-trip (injected re-throws → ml.agent rejects).
                emitLifecycle({
                    kind: "agent-result", id: runId, ts: Date.now(), save: false, session: { hash: runId, turn: 0 },
                    summary: "", steps: 0, hitCap: false, error: err?.message || String(err),
                });
                sendResponse({ error: handedThisTurn() ? HANDED_ANSWER : err?.message || String(err) });
            })
            .finally(settle);
    } catch (e) {
        // A throw in the setup, before the loop owns the run: nothing else will undo the registrations above.
        const error = (e as Error)?.message || String(e);
        try { endSession?.(error); } catch { /* the answer below still goes out */ }
        settle();
        sendResponse({ error });
    }
}

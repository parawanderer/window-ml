// sw-run-host.ts — hosting ONE background agent run: the loop runs at the extension origin and every tool is
// delegated back to the page that built the toolset (RUN_TOOL_IN_PAGE), with approval gated through the sidebar.
// This is design A, and it is the whole of it: the router in background.ts only hands a START_RUN / RESUME_RUN
// over and keeps the channel open until the run finishes.

import { runBackgroundAgent } from "./agent-host";
import type { ToolMeta } from "./agent-loop";
import type { NeutralMessage, ToolCall, TokenUsage } from "./contract-chat";
import { UI_OUT_CAP } from "./contract-chat";
import type { ApprovalDecision } from "./contract-agent";
import { MAX_CONTINUE_STEPS } from "./step-budget";
import type { StartRunPayload, ResumeRunPayload } from "./contract-messages";
import { type RequestHint, hintSession } from "./contract-run";
import { externalSheetIds, clipOut, isCurrentPage } from "./dom";
import { extractGrants } from "./grant-extract";
import { parseInfo } from "./resource-model";
import { cdpClick, cdpShadowResolve, cdpKeyType, cdpEval, releaseDebugger } from "./sw-cdp";
import { grantsFor, serverToolKey, pendingGrants, pendingApprovals, grantCredFetch, consentFetch, persistGrants, fetchConsent } from "./sw-consent";
import { relayDebugEvent } from "./sw-debug";
import { streamAgentTurn, fetchLLM, getConfig, modelCapabilities, residentModels, fetchOllamaInfo } from "./sw-llm";
import { navBarrier, bgRuns, runControllers, runInboxes, trackRun, persistRun, bufferReplay, resurrectedRuns, sessionTokens, readoptPageInfo, derefByRun, tabPageUrl, untrackRun, deleteRun, runModelFor } from "./sw-runs";
import { ingestSessionEvent, saveRunHistory } from "./sw-sessions";
import { claimValue } from "./sw-values";
import { focusLineFor } from "./sw-focus";

// The model-facing cap cdpEval clips its console to (exec's default per-slot cap) — the UI keeps far more, so
// `seen` marks where the model's copy stopped, exactly like the main-world exec path.
const CDP_EXEC_CAP = 500;

const STREAM_EMIT_MS = 90;   // min gap between live `agent-stream` deltas — smooth enough to read, not a flood

// EVERY RUN_TOOL_IN_PAGE send goes through this: it waits out any in-flight navigation on the tab before
// delegating. On a tab with no navigation pending, whenReady resolves immediately (zero cost) — so a
// single-page run is unaffected.
const delegateSend = (tabId: number, msg: unknown): Promise<any> =>
    navBarrier.whenReady(tabId).then(() => chrome.tabs.sendMessage(tabId, msg));

// LIVE tool-output streaming on the BACKGROUND path: the in-flight delegated tool's onStream, keyed by runId.
// The loop delegates tool calls SEQUENTIALLY (one in flight per run), so runId alone correlates a page-posted
// PAGE_TOOL_STREAM chunk to the right callback. Set in delegateTool while a streaming call runs, deleted after.
export const delegateStreams = new Map<string, (chunk: string, ts?: number) => void>();

/** Host one background agent run for a tab: START_RUN begins one, RESUME_RUN continues a stored one with a
 *  follow-up. The loop runs here (extension origin) and delegates every tool back to the page that built the
 *  toolset; `sendResponse` fires once the whole run finishes, so the caller keeps its channel open. */
export function startBackgroundRun(message: any, sender: chrome.runtime.MessageSender, sendResponse: (r: any) => void): void {
    // Design A: run an ml.agent loop HERE (extension origin), delegating each tool back to the page
    // (RUN_TOOL_IN_PAGE) and gating approval through the sidebar. The page built the toolset + system
    // prompt (it has the DOM/config/factories) and registered the live tools under runId; we hold only
    // serializable descriptors. sender.tab.id is the delegation + debug-fanout target.
    const tabId = sender.tab?.id;
    if (tabId == null) { sendResponse({ error: `${message.type} must come from a tab (content script).` }); return; }
    // RESUME continues a stored run: reuse its original StartRunPayload (deps rebuild from it) + its
    // accumulated history, overriding only the task with the follow-up. Only the owning tab may resume.
    let p: StartRunPayload;
    let resumeMessages: NeutralMessage[] | undefined;
    let priorSub: import("./contract").SubcallUsage | undefined;   // a resumed session's accumulated sub-call spend
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
        const asked = rp.maxSteps;
        const budget = typeof asked === "number" && Number.isInteger(asked) && asked > 0 ? Math.min(asked, MAX_CONTINUE_STEPS) : undefined;
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
    const addSub = (s: import("./contract").SubcallUsage | undefined): void => {
        if (!s || !s.calls) return;
        subTally.prompt += s.prompt; subTally.completion += s.completion; subTally.calls += s.calls;
        for (const bm of s.byModel || []) {
            const cur = subByModel.get(bm.model) || { prompt: 0, completion: 0, calls: 0 };
            cur.prompt += bm.prompt; cur.completion += bm.completion; cur.calls += bm.calls; subByModel.set(bm.model, cur);
        }
    };
    // Serialized visuals of `answer`-designated elements (data URLs), accumulated from each delegated
    // answer envelope → attached to the run's result + agent-result for the HUD completion card.
    const runAnswerMedia: import("./contract").AnswerMedia[] = [];
    // Flatten the tally to a serializable SubcallUsage (fresh objects → safe to store/emit repeatedly).
    const snapSub = (): import("./contract").SubcallUsage => ({
        ...subTally,
        ...(subByModel.size ? { byModel: [...subByModel.entries()].map(([model, u]) => ({ model, ...u })) } : {}),
    });
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
    const approvedSheets = new Set<string>();   // external sheets approved this run (isSheetApproved)
    // Cross-origin navigation consent: origins this run may navigate to WITHOUT re-prompting — seeded
    // with the start origin, and each cross-origin nav the user approves is added (so repeat navs to it
    // skip the gate). A run that didn't opt into crossOrigin never gates (its tool refuses cross-origin).
    const consentedOrigins = new Set<string>();
    if (p.pageOrigin) consentedOrigins.add(p.pageOrigin);
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
    // first of these (tagged `__mlFromBg` by content.ts) and self-reveals for a pending gate / the
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
            // Running per-turn delegated-sub-call tally so the UI "+N sub" chip works on the background
            // path too (the page path attaches subcallUsage() the same way). Omit when nothing delegated.
            ...(subTally.calls ? { subUsage: snapSub() } : {}),
        };
        // Always fan to the PAGE (overlay / off card). For devtools ALSO fan to the panel — and the
        // page fan lets the optional corner card coexist with the panel (agentHudInDevtools); the
        // shell drops the page copy when no card is mounted, and never loops it back to the panel.
        chrome.tabs.sendMessage(tabId, { type: "ML_DEBUG_TO_PAGE", event }).catch(() => { /* tab gone / no receiver */ });
        // ALWAYS feed a connected DevTools panel (no-op if none). A background-hosted run is the SOLE source
        // of its events — the shell tags them __mlFromBg and never re-forwards them as ML_DEBUG_EVENT, so
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
    const emitTurn = (rawStep: number, phases?: import("./contract").GenPhase[]): void => {
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
        if (p.surface !== "off" && !hasNavigated) return;
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
    runBackgroundAgent(
        { task: p.task, systemPrompt: p.systemPrompt, tools: toolMetas, model: p.model, think: p.think, maxSteps: p.maxSteps, autoApprovePython: p.autoApprovePython, autoApproveSameOriginAuth: p.autoApproveSameOriginAuth, autoApproveSelfSource: p.autoApproveSelfSource, unattended: p.unattended, toolTokens: p.toolTokens, stream: p.stream, runId, seqBase, tokenStore: sessionTokens(runId), labelMatch: p.labelMatch, resumeMessages, images: p.images,
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
                // Live output: register this call's stream sink under the runId so a PAGE_TOOL_STREAM chunk
                // the page posts mid-run reaches the loop's throttled fan. Cleared in the finally below.
                if (onStream) delegateStreams.set(runId, onStream);
                // Reaching here means the call is AUTHORIZED (approved / auto / cached alike). Mint the
                // choke-point grants for the privileged sub-ops this tool will make, bound to the exact
                // resources in its args — an untrusted page's FETCH_SHEET / full PYTHON_EXEC checks them.
                // Scoped to this delegation: cleared in `finally`, so a later call needs its own approval.
                // An APPROVED exec may fetch inline (ml.fetch): the human saw the code, so allow its fetches
                // for THIS run (ephemeral — cleared below). Persisting a URL is button #3, not this.
                if (name === "exec") grantsFor(tabId).fetchOpen = true;
                // A remote tool's args LEAVE THE MACHINE, so the grant is minted for the exact call the
                // human saw — never for the tool in general. The identity comes from the tool's declared
                // `remote` target rather than its name, which is what keeps the approval card and the
                // grant reading the same thing: a friendly name cannot make the card say one callable
                // while the grant authorises another.
                const remote = p.tools.find(t => t.name === name)?.remote;
                if (remote) grantsFor(tabId).serverTools.add(serverToolKey(remote.toolId, remote.fn, args as Record<string, unknown>));
                if (name === "python_exec") {
                    const g = grantsFor(tabId);
                    for (const id of externalSheetIds(args)) g.sheets.add(id);
                    if ((args as { mode?: string }).mode === "full") g.pyCode.add(String((args as { code?: unknown }).code ?? ""));
                }
                try {
                    // A delegated call can race a NAVIGATION — the tool's own action submits a form / follows a
                    // link, or the page redirects mid-call (common after an approval gate holds the call: e.g.
                    // google.com settling while `type` waited to be approved). The content script's channel then
                    // closes and Chrome's raw "message channel closed…" error is useless to the model. RECOGNISE
                    // it as a navigation: wait for the new document to settle (re-adopt) and hand back the new
                    // page's context — actionable, and safe (no blind retry that could double-submit a form).
                    const CHANNEL_GONE = /message channel closed|Receiving end does not exist|No tab with id/i;
                    let env: Partial<import("./contract").PageToolEnvelope>;
                    try {
                        env = await delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload: { runId, name, args, stream: !!onStream } }) as Partial<import("./contract").PageToolEnvelope>;
                    } catch (e) {
                        const emsg = (e as Error)?.message || String(e);
                        if (!CHANNEL_GONE.test(emsg)) {
                            env = { result: `Error: could not reach the page to run "${name}" (${emsg}).` };
                        } else {
                            // The page navigated out from under the call. Its pageInfo may already be here (a fast
                            // re-adopt beat us); else engage the barrier and wait for it (bounded by the barrier's
                            // own timeout, then a generic "still loading" note).
                            let info = readoptPageInfo.get(tabId);
                            if (!info) { navBarrier.noteNavigating(tabId); await navBarrier.whenReady(tabId); info = readoptPageInfo.get(tabId); }
                            readoptPageInfo.delete(tabId);
                            hasNavigated = true;   // the run moved pages → the terminal result must fan to the new page
                            env = { result: `The page navigated while running "${name}" — the action triggered a navigation, or the page redirected mid-call.${info ? `\n\nYou are now on the new page:\n${info}` : " The new page is still loading — wait, then look."}\n\nNOTE: "${name}" may NOT have taken effect on the previous page. Verify the CURRENT page (look / findByText) and re-run "${name}" here if the change didn't happen.` };
                        }
                    }
                    addSub(env?.subUsage);   // this tool's own delegated vision sub-call spend (look/locate)
                    if (env?.answerMedia?.length) runAnswerMedia.push(...env.answerMedia);   // answer's element visuals → HUD card
                    // Cross-page: the `navigate` tool DEFERS the real location change a tick, so its result
                    // returns before the document unloads. Engage the barrier NOW — not only via the async
                    // webNavigation.onCommitted, which can lose the race to the loop's next (fast, local)
                    // model call + tool delegation, letting the next tool fire into the dying document.
                    // The next delegateSend then waits for the new page to re-adopt. Skip an errored nav.
                    if (name === "navigate" && !String(env?.result || "").startsWith("Error")) {
                        navBarrier.noteNavigating(tabId); hasNavigated = true;
                        // Orient-on-nav: WAIT for the new document to re-adopt, then fold its pageInfo into
                        // THIS tool's result — so the model's next turn already knows where it landed instead
                        // of spending a look()/pageInfo turn to find out. The barrier's own timeout is the
                        // fallback (a nav that never re-adopts → whenReady resolves, no pageInfo → plain result).
                        if (env) {
                            await navBarrier.whenReady(tabId);
                            const info = readoptPageInfo.get(tabId); readoptPageInfo.delete(tabId);
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
                                const payload = verify === "text" ? { runId, verifyText: "strip" as const, verifyPipe: navPipe }
                                    : verify === "text-all" ? { runId, verifyText: "all" as const, verifyPipe: navPipe }
                                    : { runId, verifyViewport: true };
                                const v = await delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload }).catch(() => null) as Partial<import("./contract").PageToolEnvelope> | null;
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
                        let vres = "", vimg: string | undefined, vimgLabel: string | undefined, vfeedback: import("./contract").ToolFeedback | undefined;
                        if (env.cdpClick.verify) {
                            const venv = await delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload: { runId, verifyAt: { x: env.cdpClick.x, y: env.cdpClick.y } } })
                                .catch(() => null) as Partial<import("./contract").PageToolEnvelope> | null;
                            if (venv) { vres = venv.result || ""; vimg = venv.image; vimgLabel = venv.imageLabel; vfeedback = venv.feedback; addSub(venv.subUsage); }
                        }
                        // Append the page-side stuck-loop re-snap nudge (a repeat @pt click) to the SUCCESS result.
                        const tail = env.cdpClick.verify ? "" : " Re-run look to see the result.";
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
                        let vres = "", vimg: string | undefined, vimgLabel: string | undefined, vfeedback: import("./contract").ToolFeedback | undefined;
                        if (env.cdpShadowClick.verify) {
                            const venv = await delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload: { runId, verifyAt: { x: m.cx, y: m.cy } } })
                                .catch(() => null) as Partial<import("./contract").PageToolEnvelope> | null;
                            if (venv) { vres = venv.result || ""; vimg = venv.image; vimgLabel = venv.imageLabel; vfeedback = venv.feedback; addSub(venv.subUsage); }
                        }
                        const tail = env.cdpShadowClick.verify ? "" : " Re-run look to see the result.";
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
                        const typed = await cdpKeyType(tabId, t.text, t.submit);
                        if (!("ok" in typed)) return { result: (typed as { error: string }).error, renderIn: env.renderIn, renderOut: env.renderOut };
                        let vres = "", vimg: string | undefined, vimgLabel: string | undefined, vfeedback: import("./contract").ToolFeedback | undefined;
                        if (t.verify) {
                            // The verify PICTURE: the whole element (selector/canvas → verifyElement), the focused
                            // element (@focus → verifyFocus), else the point crop (an @pt / sealed field, by coords).
                            const payload = t.verifyElement ? { runId, verifyElement: t.verifyElement }
                                : t.verifyFocus ? { runId, verifyFocus: true }
                                : typeof fx === "number" && typeof fy === "number" ? { runId, verifyAt: { x: fx, y: fy } }
                                : { runId, verifyViewport: true };
                            const venv = await delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload }).catch(() => null) as Partial<import("./contract").PageToolEnvelope> | null;
                            if (venv) { vres = venv.result || ""; vimg = venv.image; vimgLabel = venv.imageLabel; vfeedback = venv.feedback; addSub(venv.subUsage); }
                        }
                        const shown = t.text.length > 60 ? t.text.slice(0, 60) + "…" : t.text;
                        const tail = t.verify ? "" : " Re-run look to see the result.";
                        return { result: `Typed "${shown}" into ${where} via the debugger (trusted keyboard, additive).${t.submit ? " Submitted (Enter)." : ""}${tail}${vres}`, image: vimg, imageLabel: vimgLabel, feedback: vfeedback, renderIn: env.renderIn, renderOut: env.renderOut };
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
                            const stdout = r.logs.join("\n");
                            const seen = Math.min(stdout.length, CDP_EXEC_CAP);
                            return { result: r.text, renderIn: env.renderIn,
                                renderOut: { type: "exec-out", stdout: clipOut(stdout, UI_OUT_CAP), seen, value: r.value } };
                        }
                        return { result: `${env.result || ""}\n\n${r.error}`, renderIn: env.renderIn, renderOut: env.renderOut };
                    }
                    // The page already computed the rendered In/Out slots (descriptorFor) — forward them so
                    // the sidebar shows the rich view. `image` rides along for INLINE VISION (native look):
                    // the loop injects it into the model's next turn (pushToolImages).
                    return { result: env?.result || `Error: the page returned nothing for tool "${name}".`, renderIn: env?.renderIn, renderOut: env?.renderOut, feedback: env?.feedback, image: env?.image, imageLabel: env?.imageLabel, images: env?.images, remoteMs: env?.remoteMs };
                } finally {
                    pendingGrants.delete(tabId);   // grants were for THIS approved call's sub-ops only
                    if (onStream) delegateStreams.delete(runId);   // the call is done — stop routing live chunks to it
                }
            },
            // Pre-run In render for a PENDING step (streaming runs): ask the page to compute the tool's
            // In descriptor without running it, so a step you watch stream shows exec's beautified JS /
            // python's code cell from the start instead of raw JSON args. Best-effort — raw args on failure.
            renderFor: async (name, args) => {
                const env = await delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload: { runId, name, args, renderOnly: true } })
                    .catch(() => null) as { renderIn?: import("./contract").RenderDescriptor } | null;
                return env?.renderIn;
            },
            // Read-only try (exec only, and only when the user enabled autoApproveReadonly): ask the
            // page to run the call through the mediated interpreter — side-effect-free, so if it's
            // in-dialect it BOTH auto-approves AND returns the result, and the human gate is skipped.
            // Keep this run's pointer resolver so a page-side tool's `ml.dereference` (DEREF_TOKEN) can
            // read the outputs THIS run captured. Dropped in the run's finally, with the other per-run state.
            tokenSink: (fn) => { derefByRun.set(runId, fn); },
            // A pointer to a stored table: this session holds it until the session is released.
            claimValue: (key) => claimValue(key, runId),
            tryReadonly: p.autoApproveReadonly ? async (name, args) => {
                if (name !== "exec") return null;
                const env = await delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload: { runId, name, args, readonlyTry: true } })
                    .catch(() => null) as Partial<import("./contract").PageToolEnvelope> | null;
                return env && env.readonly ? { result: env.result || "", renderIn: env.renderIn, renderOut: env.renderOut, reused: env.reused } : null;
            } : undefined,
            // Doomed-action precheck (click/type): ask the page to resolve the target side-effect-free.
            // A non-null error → the gate is SKIPPED and the error returned. Only delegated for tools
            // that HAVE a precheck (avoids a useless round-trip on every gated call).
            precheck: async (name, args) => {
                if (!p.tools.some((t) => t.name === name && t.precheck)) return null;
                const env = await delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload: { runId, name, args, precheck: true } })
                    .catch(() => null) as Partial<import("./contract").PageToolEnvelope> | null;
                return env && env.precheckFailed ? (env.result || "") : null;
            },
            approve: async ({ tool, arguments: args, seq, step }) => {
                // Ask the page to compute the In render for THIS call (without running the tool) so the
                // blocking approval shows a pretty In — exec's beautified JS, python's code cell — not
                // raw args. Best-effort: raw args on any failure. (Out has nothing to render pre-run.)
                let renderIn: unknown;
                try {
                    const env = await delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload: { runId, name: tool, args, renderOnly: true } }) as { renderIn?: unknown };
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
                                if (u) { if ((args as { credentials?: unknown }).credentials) grantCredFetch(tabId, u); else consentFetch(tabId, u); }
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
            fetchNeedsConsent: (url) => !fetchConsent.get(tabId)?.has(url),   // a NEW url → gate; an already-approved one → auto
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
                return items.map(it => it.text);
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
        .then(({ result: res, messages }) => {
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
            const resumeP = { ...p, stepBase: stepBase + runMaxStep, seqBase: seqBase + runMaxSeq };
            bgRuns.set(runId, { p: resumeP, tabId, messages, sub: snapSub() });
            // The same snapshot `bgRuns` holds, where it outlives the run: `resumeP` so a later turn continues
            // AFTER this one's steps rather than colliding with them.
            saveRunHistory(runId, { messages, payload: resumeP, sub: snapSub() });
            const answerMedia = runAnswerMedia.length ? runAnswerMedia : undefined;
            emitLifecycle({
                kind: "agent-result", id: runId, ts: Date.now(), save: false, session: { hash: runId, turn: res.steps },
                summary: res.summary, steps: res.steps, hitCap: !!res.hitCap, cancelled: !!res.cancelled, answerMedia,
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

// ml-agent-run.ts — ONE agent run, from the toolset it builds to the result it resolves.
//
// `ml.agent`. The loop, the tool whitelist, the step cap and the approval gate all live on the CALLER side by
// design: the extension ships no loop and no overseer, so window.ml stays a primitive you compose. This is
// the reference composition of it, and the only member of the literal that was a decomposition rather than a
// move -- which is why it is a file rather than a family.
//
// Two things to know before editing it, both load bearing:
//
//   - It is the gate-before-execute path AGENTS.md names. An approval is asked at the choke point and the
//     answer is what runs; a tool's own claim about itself decides nothing. `approvedSheets` is here because
//     only this loop reads it -- the spreadsheets the user approved python_exec access to THIS page session,
//     gone on reload, never persisted.
//   - `_onSession` must stay on the FIRST-TURN path, beside `control.hash = runHash`. It is how a UI that
//     started the run (the chat page's `agent.start`) learns which session it got. Moved later -- after the
//     config read, say -- the command times out; moved onto every turn it fires repeatedly.
//     `tests/e2e/session-index.spec.mjs` fails if the call disappears.

import { CITABLE_TOOLS, type AgentLoopDeps, shotTurnMessage, runAgentLoop } from "./agent-loop";
import { resolveOutputs, makeAnswerFacade, finalizeAnswer } from "./answer-set";
import { defaultApprove, logStep, normalizeApproval, formatReadonlyExec, readonlyRefused } from "./approval";
import { autoApprovePython } from "./auto-approve";
import { makeBackgroundTaskPromise } from "./bridge";
import { BUILD_INFO } from "./build-info.gen";
import { buildServerTools, setCdpEnabled } from "./builtin-tools";
import { agentRegistry, resetSubcallUsage, handleRegistry, emitDebug, enterAgentRun, exitAgentRun, subcallUsage } from "./bus";
import { type MlApi, type MlTool, type ApprovalRequest, type ApprovalDecision, type AgentResult, DEFAULT_GROUNDING_RANGE, type VisionMemory, detectGroundingModel, shortHash, type MlAgentHandle, type NeutralMessage, type RenderDescriptor, type ToolFeedback, type TokenUsage, hintSession, type DerefRead, type ToolRenderInput, outputCapEscalated } from "./contract";
import { setPierceClosedShadow, externalSheetIds, isCurrentPage, elLine, errText } from "./dom";
import { type AgentControl, columnsViaBackground, sameOriginNav, sameOriginFetch } from "./ml-agent";
import { expandPointers } from "./pointer-macro";
import { UNATTENDED_EXEC_NOTE, UNATTENDED_PY_NOTE, AGENT_SYSTEM, VISION_CLAUSE, ANSWER_CLAUSE, TOOLTOKENS_CLAUSE, DEREF_CLAUSE, WAIT_CLAUSE, SHADOW_CLAUSE, SHADOW_CLOSED_PIERCE_NOTE, SHADOW_CLOSED_NOTE, IFRAME_CLAUSE, SHADOW_EXEC_NOTE, SELF_CLAUSE, PIPE_CLAUSE, PYTHON_CLAUSE, EXEC_COMPUTE_CLAUSE, EXEC_RANGE_CLAUSE, UNATTENDED_CLAUSE, NAV_OFF_CLAUSE } from "./prompts";
import { evalReadonly } from "./readonly-exec";
import { descriptorFor } from "./render-descriptor";
import { parseInfo } from "./resource-model";
import { registerRun, endRun, runAnswer } from "./run-delegation";
import { isSelfSourceUrl } from "./self-source";
import { TokenStore } from "./token-pipe";
import { toolContext, executeTool, withRunDeref } from "./tool-exec";
import { citeParam } from "./tool-params";
import { buildDereferenceTool } from "./tools";
import { pageContext } from "./util";
import { validateArgs } from "./validate";

/**
 * Run a full agent loop over a tool registry: the model calls tools, we
 * execute them in the page, feed the results back, and repeat until it
 * stops calling tools (returns a summary) or hits `maxSteps`. The loop, the
 * tool whitelist, the step cap and the approval gate all live here on the
 * caller side — window.ml stays a primitive you compose.
 *
 * @param {string} task Natural-language task for the agent.
 * @param {Object} [opts]
 * @param {MlTool[]} [opts.tools] Tool registry. ⚠ REPLACES the default
 *   `domTools` ({@link module:ml.domTools}) — passing e.g. `[clickTool()]`
 *   leaves the agent with ONLY that (plus auto-wired look/locate), stripping
 *   `exec`/DOM inspection, scroll, type, etc. To ADD a tool to the full default
 *   kit (the usual intent), use `extraTools`, not `tools`.
 * @param {MlTool[]} [opts.extraTools=[]] Extra tools APPENDED to the toolset
 *   (the default `domTools`, or `tools` if you overrode it). Use this to hand the
 *   agent an extra capability without losing the built-ins.
 * @param {string} [opts.system] System prompt (default the generic strategy preamble).
 * @param {string} [opts.systemAppend] Task-specific notes APPENDED to the system prompt
 *   (keeps the built-in workflow + tool clauses — unlike `system`, which
 *   REPLACES them). Put site/task facts here for a minimal setup.
 * @param {number} [opts.maxSteps=10] Hard cap on tool-executing turns.
 * @param {string} [opts.model] Model override, forwarded to each {@link module:ml.step}.
 * @param {boolean} [opts.think] Thinking flag, forwarded to each {@link module:ml.step}.
 * @param {(req: {tool: string, arguments: Object}) => (boolean|{approved: boolean, feedback?: string, arguments?: Object}|Promise<boolean|{approved: boolean, feedback?: string, arguments?: Object}>)} [opts.approve]
 *   Gate called before each model-driven call to a `requiresApproval` tool;
 *   defaults to a blocking `confirm()`. Return a boolean, or the richer
 *   contract `{ approved, feedback?, arguments? }`: on a rejection, `feedback`
 *   is fed to the model as the reason (instead of the fixed "Denied" note);
 *   on approval, `arguments` (when given) REPLACES the model's arguments
 *   before the tool runs — so a UI can edit an `exec` script before it fires.
 *   A denial (either form) is always fed back to the model.
 * @param {boolean} [opts.env=true] Prepend a "current page context" note
 *   (URL, title, language, date/time, locale) to the system prompt, so the
 *   model is oriented and knows what "today"/the locale is. Set false to skip.
 * @param {boolean|string} [opts.vision=null] Auto-register a `look` (vision)
 *   tool so the agent can see with no wiring. Default (`null`) probes the
 *   agent's model — and falls back to the configured OCR model — and adds
 *   `look` only when one is vision-capable (a positive Ollama capability;
 *   unknown/cloud models never qualify). Pass **`true` to FORCE NATIVE vision** on
 *   the agent's own model (bypass the probe — for a cloud/non-Ollama model you know
 *   sees, e.g. minimax/gpt-4o, so it gets the real pixels, not a text summary).
 *   Pass `false` to disable, or a model id to force a DELEGATED `look` onto that
 *   specific vision model. Skipped when the toolset already has a vision-capable tool.
 * @param {(ev: {step: number, thought?: string, tool?: string, arguments?: Object, result?: string, elements?: Node[]}) => void} [opts.onStep]
 *   Live tracer: fires `{ step, thought }` with the model's reasoning
 *   (its prose before the calls) and `{ step, tool, arguments, result,
 *   elements? }` for each tool call —
 *   `elements` holds real DOM nodes when the tool provided them (log them to
 *   hover in devtools).
 * @param {boolean} [opts.logDebug=false] Install a built-in console tracer
 *   ({@link module:ml._logStep}) that logs each thought and tool call —
 *   the quickest way to watch a run. Composes with `onStep` (both fire).
 * @param {AbortSignal} [opts.signal] Cancel the run. Checked at each step boundary
 *   (before the model call, before running a tool), AND it kills the in-flight model
 *   request (the signal reaches the background fetch, which aborts). On abort the loop
 *   stops and the promise RESOLVES with `{ cancelled: true }` and the partial transcript
 *   (it does not reject, matching the `hitCap` convention).
 * @returns {Promise<{summary: string, steps: number, transcript: Array<{thought?: string, tool?: string, arguments?: Object, result?: string, elements?: Node[]}>, elements: Node[], hitCap?: boolean, cancelled?: boolean}>}
 *   `elements` is the live DOM node(s) the model designated via an
 *   `answer`-capable tool (empty for tasks that just act on the page).
 */
export const agent = async function(this: MlApi, task: string, { tools = null, extraTools = [], serverTools = [], commanderTools = false, system = null, systemAppend = null, maxSteps = 10, model = null, think = null, approve = defaultApprove, onStep = null, env = true, vision = null, logDebug = false, signal = null, resume = null, silent = false, unattended = false, navigate = true, crossOrigin = false, approvalRouting = "ui", stream = false, toolTokens = false, images = [], _control = null, _onSession = null }: {
    tools?: MlTool[] | null;
    extraTools?: MlTool[];
    serverTools?: string[];
    /** HUD-only: also give this run the server-tool bundles marked always-present in Settings. A run
     *  driven from the Commander bar has no code to name one; a scripted call said what it wanted. */
    commanderTools?: boolean;
    system?: string | null;
    systemAppend?: string | null;
    maxSteps?: number;
    model?: string | null;
    think?: boolean | null;
    approve?: (req: ApprovalRequest) => boolean | ApprovalDecision | Promise<boolean | ApprovalDecision>;
    onStep?: ((ev: { step: number; thought?: string; tool?: string; arguments?: Record<string, unknown>; result?: string; elements?: Node[] }) => void) | null;
    env?: boolean;
    vision?: boolean | string | null;
    logDebug?: boolean;
    signal?: AbortSignal | null;
    resume?: string | null;
    silent?: boolean;
    unattended?: boolean;
    navigate?: boolean;   // may this run navigate to other pages (wires the `navigate` tool + cross-page persistence)? default true
    crossOrigin?: boolean;   // may `navigate` cross to OTHER SITES (different origins)? default false — same-site only
    approvalRouting?: "ui" | "both" | "external";   // where privileged gates resolve (bg runs): human UI (default) · UI + IPC · IPC only
    stream?: boolean;   // STREAM the model's thinking/reply live (agent-stream deltas) so a long reasoning phase isn't a frozen token count. Default false.
    toolTokens?: boolean;   // surface `@tool:<id>` on rich tool results so the model can cite exact outputs. Default false; HUD auto-on.
    images?: (string | HTMLImageElement)[];   // attachments for THIS turn (composer paste/upload)
    _control?: AgentControl | null;   // internal: a handle's persistent session state (ml.createAgent). Absent → a throwaway per-call one.
    _onSession?: ((hash: string) => void) | null;   // internal: called once, with the hash, the moment the FIRST turn mints it (a UI that started this run needs to know which session it got)
} = {}): Promise<AgentResult> {
    // Resume a run held in this tab: reuse its stored loop (same toolset/system/model +
    // accumulated messages), appending `task` as a follow-up user turn under the SAME hash,
    // so the sidebar/HUD keep it as one conversation. Only page-hosted runs register here;
    // a background/off-mode run's history lives in the service worker (resumes via a later
    // RESUME_RUN round-trip), so its hash won't be found → a clear error rather than a silent
    // fresh run. `resume` also short-circuits the (expensive) toolset/config resolution below.
    if (resume) {
        if (!task || typeof task !== "string") throw new Error("ml.agent(task, { resume }) needs a follow-up task string.");
        const handle = agentRegistry.get(resume);
        if (!handle) throw new Error(`ml.agent: no resumable run "${resume}" in this tab. (Same-tab page-hosted runs resume in-memory; a background/off-mode run isn't resumable this way yet.)`);
        return handle.resume(task);
    }
    // The session's mutable state. A handle (ml.createAgent) passes its OWN so run()/say()/maxSteps
    // span turns; a plain ml.agent() call gets a throwaway one. The page loop reads history / inbox /
    // cap / seq from it, so there's a single code path — a handle just persists it across turns.
    const control: AgentControl = _control ?? { hash: null, messages: [], inbox: [], maxSteps, running: false, seqBase: 0, stepBase: 0 };
    let toolset = [...(tools || this.domTools || []), ...extraTools];
    // Server-side tools, opt-in by bundle id. Resolved here rather than by the caller so the
    // function schemas the model sees are the server's own. A bundle that does not resolve (a stock
    // backend, a revoked key, a wrong id) is simply absent — a run should degrade to the tools it
    // does have rather than failing before it starts.
    // The user's curation is read beside the resolution it shapes. A config that cannot be read
    // curates NOTHING out and adds nothing: a run losing its tools because a message failed is worse
    // than one offering a tool the user had hidden.
    let srvOff: string[] = [], srvAlways: string[] = [];
    if (serverTools.length || commanderTools) {
        try {
            const cfg = await this.config();
            srvOff = cfg?.serverToolsOff || [];
            // Bundles marked always-present, for a run started from the HUD. Only that surface: a
            // scripted `ml.agent()` said exactly what it wanted and must not gain tools behind its
            // back.
            if (commanderTools) srvAlways = cfg?.commanderServerTools || [];
        } catch { /* no curation, no additions */ }
    }
    const wantBundles = [...new Set([...serverTools, ...srvAlways])];
    if (wantBundles.length) {
        try {
            const bundles = await this.serverTools();
            toolset = [...toolset, ...buildServerTools(this as unknown as MlApi, bundles, wantBundles, srvOff)];
        } catch { /* unreachable backend → no server tools, run anyway */ }
    }
    // Vision facts resolved ONCE below and carried on every tool's ToolContext, so nothing re-derives
    // them: `driverSees` = the agent's own model sees the pixels natively this run (drove native vs
    // delegated `look`; read by `locate`'s snap-feedback); `runVisionModel` = the resolved reader a
    // delegated vision sub-call uses. Both stay at their defaults unless a vision model resolves.
    let driverSees = false;
    let runVisionModel: string | null = null;
    // Grounding facts (opt-in) resolved in the vision block below — hoisted so the cross-page
    // rebuild-config can carry them, letting a re-adopted page rebuild `locate` identically.
    let runGroundingModel: string | null = null;
    let runGroundingRange = DEFAULT_GROUNDING_RANGE;
    // Config, fetched once (used for vision resolution + the read-only exec
    // auto-approve fast-path below).
    const agentCfg = await this.config().catch(() => null);
    // The run's driver model — the SINGLE resolution reused for vision wiring, the ToolContext, and the
    // loop below (was computed twice). The fresh-config fallback covers a momentarily-null agentCfg so
    // this can't be null while the reader resolves non-null. Null only when neither a per-call model nor
    // a configured default exists — the run then fails downstream at prepareRequest ("No model configured").
    const runModel = model || agentCfg?.model || (await this.config().catch(() => null))?.model || null;
    const autoRO = !!(agentCfg && (agentCfg as { autoApproveReadonly?: boolean }).autoApproveReadonly);
    const autoPy = !!(agentCfg && (agentCfg as { autoApprovePython?: boolean }).autoApprovePython);
    const autoSOA = !!(agentCfg && (agentCfg as { autoApproveSameOriginAuth?: boolean }).autoApproveSameOriginAuth);
    const autoSelfSrc = !!(agentCfg && (agentCfg as { autoApproveSelfSource?: boolean }).autoApproveSelfSource);
    // Which lexical metric ranks a near-miss on a pointer LABEL. Undefined = the built-in default;
    // it is a config value so the benchmark can vary it without a rebuild.
    const labelMatch = (agentCfg as { labelMatch?: import("./contract").LexicalMetric } | null)?.labelMatch;
    // Closed-shadow-root piercing (opt-in). Set the dom.ts module flag from THIS run's config before
    // any DOM tool executes — it governs both loop paths (the page loop below AND the background's
    // delegated page-side tool execution, since both call into the same main-world dom.ts). Off →
    // closed roots stay unreachable, exactly as before.
    const pierceClosed = !!(agentCfg && (agentCfg as { pierceClosedShadow?: boolean }).pierceClosedShadow);
    setPierceClosedShadow(pierceClosed);
    // CDP-trusted input flag — set AFTER the surface decision below (it's only usable on the
    // background-hosted path; gating it on that avoids regressing page-hosted canvas clicks to a no-op).
    const cdpOn = !!(agentCfg && (agentCfg as { cdp?: boolean }).cdp);
    // #8 + #3: give the agent eyes with no wiring, preferring NATIVE vision.
    // If the agent's OWN model is vision-capable, register a capture-only
    // `look` whose screenshot ml.agent injects straight into the model's
    // history (#3 inline vision), so it reasons over the real pixels instead
    // of a lossy delegated text summary — the failure mode where a model
    // "stumbles around" on an easy task. If only the OCR model can see, fall
    // back to the delegated `lookTool` (#8). A forced `vision:"<model>"` is
    // always delegated (can't inline a model that isn't the agent's).
    if (vision !== false && !toolset.some(t => t.capabilities && t.capabilities.includes("vision"))) {
        // The model that will SEE: forced value → agent's own (if it reports
        // vision) → the OCR model → null. `look` prefers NATIVE inline vision
        // when the agent's own model can see; otherwise it's delegated. `locate`
        // is ALWAYS delegated (it reads badges), so it just needs any resolved
        // reader — added alongside look whenever one exists.
        const visionModel = await this._resolveVisionModel(model, vision);
        if (visionModel) {
            runVisionModel = visionModel;
            // The driver sees the injected pixels NATIVELY iff the reader `_resolveVisionModel` picked
            // IS the agent's own model (`runModel`) — it returns that only when forced-native (`vision:true`)
            // or a probe confirms it sees; otherwise it returns a DELEGATED reader (the OCR model). Deriving
            // driverSees from that ONE decision — not a second, independently-resolved `_modelSees` probe —
            // is what stops look-wiring and locate's snap-feedback from disagreeing: the bug where a
            // vision-capable Ollama agent (gemma4) hit the delegated "you can't see images" path even though
            // its own model resolves as the reader.
            driverSees = !!runModel && visionModel === runModel;
            // One near-area memory SHARED by look + locate this run: a look({@pt}) or a locate
            // snap-inject records the spot, so a re-snap onto it doesn't re-inject the same crop.
            const visionMemory: VisionMemory = { seen: [], boundariesSeen: new Set() };
            if (driverSees) {
                toolset.push(this._nativeLookTool(visionMemory));
            } else {
                toolset.push(this.lookTool({ model: visionModel, memory: visionMemory }));
            }
            // Grounding (opt-in): the effective model is the explicit field, or
            // the auto-detected qwen when it's blank; plus its coordinate range.
            let groundingModel: string | null = null, groundingRange = DEFAULT_GROUNDING_RANGE;
            try {
                const cfg = await this.config();
                if (cfg.groundingEnabled) {
                    groundingRange = cfg.groundingRange || DEFAULT_GROUNDING_RANGE;
                    groundingModel = cfg.groundingModel.trim() || detectGroundingModel(await this.models()) || null;
                }
            } catch { /* config/models unavailable → Set-of-Marks only */ }
            runGroundingModel = groundingModel; runGroundingRange = groundingRange;   // carried for cross-page rebuild
            // driverSees rides the ToolContext (below), not a build opt; memory is the shared dedup registry.
            toolset.push(this.locateTool({ model: visionModel, groundingModel, groundingRange, memory: visionMemory }));
        }
    }
    // Cross-page navigation (idea #1). Default ON: wire a `navigate(url)` tool so a background-hosted
    // run can walk between same-site pages, surviving the full-page load (the barrier + re-adopt path
    // below). `navigate: false` disables it entirely — no tool, no cross-page persistence (the run
    // ends at a nav), and NAV_OFF_CLAUSE tells the model so instead of it wasting steps trying.
    if (navigate && !toolset.some(t => t.name === "navigate")) toolset.push(this.navigateTool({ crossOrigin }));
    // fetch_url: READ a URL the page can't (a raw file / API / other site) WITHOUT navigating — a gated
    // GET (uncredentialed by default; `credentials`/`rendered` opt into the user's session / a JS render).
    // Auto-wired into the DEFAULT kit only (`tools` not overridden); it needs no
    // navigation, so it's added even on a navigate:false run. A caller who hand-picks `tools` gets exactly
    // what they list (add `ml.fetchTool()` to include it) — unlike the vision tools, which augment any
    // driver because they're capability-probed. requiresApproval, so default-on is safe.
    if (!tools && !toolset.some(t => t.name === "fetch_url")) toolset.push(this.fetchTool());
    // Composer attachments for THIS turn's first user message (a screenshot pasted/uploaded into the
    // HUD/sidebar). A vision-capable driver sees them natively; otherwise transcribe via the reader
    // (ml.read → the OCR model) and fold the text into the task, so a text-only agent still gets the
    // content — with an honest note it didn't see the pixels itself. driverSees/runVisionModel are the
    // SAME values that chose native-vs-delegated `look`, so the image path matches the tool path.
    let pendingImages: string[] | undefined;
    let turnImages: string[] = [];   // the resolved data URLs, for the debug transcript (shown in BOTH the vision + OCR cases)
    if (images && images.length) {
        try {
            const urls = await Promise.all(images.map(im => this._imageToDataUrl(im)));
            turnImages = urls;
            if (driverSees) pendingImages = urls;
            else {
                const notes: string[] = [];
                for (let i = 0; i < urls.length; i++) {
                    let txt = "";
                    try { txt = await this.read(urls[i], { model: runVisionModel }); } catch { /* reader unavailable → leave blank */ }
                    const which = urls.length > 1 ? ` ${i + 1}` : "";
                    notes.push(`[Pasted image${which} — you can't see images, so here is its transcribed text:]\n${txt || "(could not read the image)"}`);
                }
                task = task ? `${task}\n\n${notes.join("\n\n")}` : notes.join("\n\n");
            }
        } catch { /* image conversion failed → proceed without the attachment */ }
    }
    // Unattended run: no human to approve, so shape the toolset for read-only autonomy. exec and
    // python_exec are kept ONLY when their read-only auto-approve path is configured on (a readonly
    // survey / the hardened sandbox run without a prompt); otherwise every call would need approval,
    // so they're dropped entirely. The kept ones get a note that the mutating/full half is refused.
    // Other approval-gated tools (click/type/…) stay wired but are refused at the gate below — the
    // model is told, not silently disarmed. Clone (don't mutate) the shared tool defs.
    if (unattended) {
        toolset = toolset.flatMap(t => {
            if (t.name === "exec") return autoRO ? [{ ...t, description: t.description + UNATTENDED_EXEC_NOTE }] : [];
            if (t.name === "python_exec") return autoPy ? [{ ...t, description: t.description + UNATTENDED_PY_NOTE }] : [];
            return [t];
        });
    }
    // Tool tokens (opt-in): expose a `token` param ONLY on the result-producing tools, and ONLY when the
    // run has tokens enabled — so a normal run's schemas aren't cluttered with a param that does nothing.
    // The model sets `token: true` on a call whose output it intends to CITE; the loop surfaces the
    // @tool:<id> only for those (see agent-loop). Clone the shared defs; don't mutate them.
    if (toolTokens) {
        // The other half of tool tokens: a token is a POINTER, not only a citation. `dereference` reads
        // the value back — cheaper than re-running a tool, and it reaches the FULL output rather than
        // the truncated copy the model was shown. The run loop answers it (agent-loop's derefLocally);
        // this only advertises the schema.
        toolset = [...toolset, buildDereferenceTool(window.ml.defineTool)];
        toolset = toolset.map(t => CITABLE_TOOLS.has(t.name)
            ? { ...t, parameters: { ...t.parameters, properties: { ...(t.parameters as { properties?: Record<string, unknown> }).properties,
                token: citeParam("the pricing table") } } }
            : t);
    }
    const byName = Object.fromEntries(toolset.map(t => [t.name, t]));
    const toolDefs = toolset.map(t => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters }
    }));
    const hasCap = (cap: "vision" | "answer") => toolset.some(t => t.capabilities && t.capabilities.includes(cap));
    let systemPrompt = system || AGENT_SYSTEM;
    if (!system) {
        // Adapt the default prompt to what the toolset can actually do.
        if (hasCap("vision")) systemPrompt += VISION_CLAUSE;
        if (hasCap("answer")) systemPrompt += ANSWER_CLAUSE;
        if (toolTokens) systemPrompt += TOOLTOKENS_CLAUSE + DEREF_CLAUSE;   // rich results carry an @tool: id — to cite verbatim, and to read back
        if (toolset.some(t => t.name === "wait")) systemPrompt += WAIT_CLAUSE;
        // The DOM tools all pierce open shadow roots + resolve `>>>` — tell the model, plus (only when
        // exec is wired) how the notation maps to JS. Gated on a representative DOM tool being present.
        if (toolset.some(t => ["findByText", "describeElement", "interactives", "click", "type"].includes(t.name))) {
            // The closed-root sentence differs by whether piercing is enabled (reachable via `>>>` vs
            // visual-only). SHADOW_EXEC_NOTE (`>>>` → JS) is still accurate either way.
            systemPrompt += SHADOW_CLAUSE + (pierceClosed ? SHADOW_CLOSED_PIERCE_NOTE : SHADOW_CLOSED_NOTE) + IFRAME_CLAUSE;
            if (toolset.some(t => t.name === "exec")) systemPrompt += SHADOW_EXEC_NOTE;
        }
        if (toolset.some(t => t.name === "agent_api_docs")) systemPrompt += SELF_CLAUSE;
        // The pipe dialect, ONCE, when anything in this toolset actually takes a `pipe`. Detected
        // from the SCHEMA rather than a list of tool names, so a new tool that grows a `pipe`
        // parameter is covered without anyone remembering this line — and a toolset with none of
        // them pays nothing. The tool and its dialect always arrive together, which is what lets
        // the parameters themselves be one sentence pointing here.
        if (toolset.some(t => !!(t.parameters?.properties as Record<string, unknown> | undefined)?.pipe))
            systemPrompt += PIPE_CLAUSE;
        // Deterministic-compute clause. python_exec is the better calculator; when it's
        // absent, exec (read-only JS: Array/Math/.reduce) is the fallback — either way the
        // model must compute, never guess. Mutually exclusive so the prompt isn't doubled.
        if (toolset.some(t => t.name === "python_exec")) systemPrompt += PYTHON_CLAUSE;
        else if (toolset.some(t => t.name === "exec")) systemPrompt += EXEC_COMPUTE_CLAUSE;
        // exec (JS) style: functional idioms + ml.range instead of loops/mutation. Independent of the
        // compute clause above (applies even alongside python_exec, since it's about exec JS specifically).
        if (toolset.some(t => t.name === "exec")) systemPrompt += EXEC_RANGE_CLAUSE;
        // Headless run: tell the model upfront it's unattended (read-only only), so it doesn't
        // waste steps attempting clicks/typing/mutations that the gate below will just refuse.
        if (unattended) systemPrompt += UNATTENDED_CLAUSE;
        // Navigation disabled: say so upfront (no navigate tool + a nav ends the run) so the model
        // reports back instead of clicking a link and silently dying.
        if (!navigate) systemPrompt += NAV_OFF_CLAUSE;
    }
    if (systemAppend) systemPrompt += `\n\nTask-specific notes:\n${systemAppend}`;
    if (env) {
        const ctx = pageContext(n => toolset.some(t => t.name === n));
        if (ctx) systemPrompt += `\n\nCurrent page context:\n${ctx}`;
    }
    // The run's curated answer set lives on the ToolContext (built at `toolCtx` below); the loop reads
    // `answerSet.elements()` / `.media()` / `.toMarkdown()` at assembly. (Was two accumulator arrays.)
    // Debug sidebar: announce the run + each step. Its own session hash
    // (an agent run isn't a createChat). elements can't cross the window
    // bus — send a count; real nodes still reach onStep/the console.
    // Mint the hash on the FIRST turn, then reuse it (a handle's later run()s continue the session).
    // firstTurn keys off whether this control ALREADY has a hash (a prior turn started the session),
    // NOT control.messages — computed BEFORE the hash is assigned below.
    const firstTurn = !control.hash;
    const runHash = control.hash ?? shortHash();
    control.hash = runHash;
    // Whoever started this run learns its session here and not before: the hash is minted inside the loop,
    // after the config read, so a caller that wanted it had to poll the handle until it appeared.
    if (firstTurn && typeof _onSession === "function") { try { _onSession(runHash); } catch { /* the caller went away */ } }
    // Delegated-sub-call token tally is CUMULATIVE across the whole session (all turns), matching the
    // "+N sub" gauge — reset ONCE when the session starts, not per turn. A per-turn reset made
    // chat_metadata report "none" on any turn that hadn't yet made a vision sub-call (e.g. asked at
    // step 1), even after prior turns had spent thousands.
    if (firstTurn) resetSubcallUsage();
    // Register a createAgent HANDLE (not a throwaway ml.agent control) by its hash so a sidebar/HUD
    // composer can drive this session — say()/run()/cancel() — knowing only the hash. `run` present
    // ⇒ it's an AgentHandle. Registered mid-run so the composer can steer while it's still going.
    if (_control && typeof (_control as unknown as MlAgentHandle).run === "function") handleRegistry.set(runHash, _control as unknown as MlAgentHandle);
    // A handle's 2nd+ turn continues an existing sidebar/HUD session, so it must NOT re-announce
    // `agent` (that would wipe its steps). This held via control.messages until a CANCELLED
    // background/devtools turn — which never syncs messages back (the round-trip rejects), leaving
    // control.messages empty → the next run re-announced `agent` and WIPED the history. control.hash
    // survives a cancel, so firstTurn (above) keys off it instead.
    // `runModel` (resolved once up top) is the driver model — config default when none was passed —
    // so the sidebar shows the REAL model (not "default") and can tell when a vision sub-call reused it.
    const mlApi = this as unknown as MlApi;   // typed self-ref for the deps' chatMeta (capabilities/ps)
    if (firstTurn) emitDebug({ kind: "agent", id: runHash, ts: Date.now(), save: false, session: { hash: runHash, turn: 0 }, task, images: turnImages.length ? turnImages : undefined, model: runModel, maxSteps, pageUrl: location.href, pageTitle: document.title || undefined, config: {
        system: systemPrompt, customSystem: !!system,
        tools: toolset.map(t => ({ name: t.name, requiresApproval: !!t.requiresApproval, vision: !!(t.capabilities && t.capabilities.includes("vision")), description: t.description, parameters: t.parameters, summary: t.summary, ...(t.remote ? { remote: t.remote } : {}) })),
        maxSteps, think: (think === true || think === false) ? think : null, env, vision: vision ?? null,
        driverSees, visionModel: runVisionModel, systemAppend: systemAppend || null, silent: silent || undefined, unattended: unattended || undefined,
        navigate, crossOrigin: crossOrigin || undefined, approvalRouting: approvalRouting !== "ui" ? approvalRouting : undefined,
        stream: stream || undefined,
    } });
    // A CONTINUATION (a handle's later run() with a task) shows the follow-up as a user message in the
    // conversation — the sidebar renders it exactly like the first task / a mid-run say (all "you").
    else if (task || turnImages.length) emitDebug({ kind: "agent-say", id: runHash, ts: Date.now(), save: false, session: { hash: runHash, turn: 0 }, text: task, images: turnImages.length ? turnImages : undefined });

    // ── Design A: route through the BACKGROUND loop so the approval gate lives at the extension
    // origin (unforgeable by the page — a page-set window.confirm or a hostile approve() can't
    // grant it). We route when EITHER a debug surface is active (overlay → the in-page iframe app;
    // devtools → the panel app) OR the run has a requiresApproval tool AND this origin is NOT on
    // the user's page-approval whitelist. The page built the toolset + system prompt above and
    // registers the LIVE tools under runHash; the background delegates each call back via
    // RUN_TOOL_IN_PAGE and gates approval through the surface (in `off` mode, a minimal modal the
    // content-script shell draws). A WHITELISTED origin (agentCfg.pageApprovalAllowed — the user
    // explicitly trusts this domain to self-gate) falls through to the in-page loop below, as does
    // a run with no privileged tool (nothing to gate). Caveats (v1): the caller's
    // `approve`/`onStep`/`logDebug` and rich tool renders don't apply on the background path.
    const surface = agentCfg?.debugMode;
    const hasApprovalTool = toolset.some(t => !!t.requiresApproval);
    // A run that can call python_exec starts Pyodide now, in parallel with the model's first turn, so the
    // first call does not pay the multi-second cold start. Both hosting paths pass through here.
    if (toolset.some(t => t.name === "python_exec"))
        makeBackgroundTaskPromise("PYTHON_PREWARM_REQUEST", "PYTHON_PREWARM_RESPONSE", { trigger: "run-start" }).catch(() => { /* a pre-warm is never worth a failure */ });
    // Off-mode closure: with no debug surface, a privileged run on a NON-whitelisted origin still
    // routes to the unforgeable background gate — the shell mounts an acrylic corner CARD (shell.ts
    // + app.tsx CardApp) that renders the pending approval and returns the decision via the same
    // origin-authed SET_APPROVAL. A WHITELISTED origin (the user trusts this domain to self-gate) or
    // a run with no privileged tool (nothing to gate) falls through to the in-page loop below.
    const bgSurface: "overlay" | "devtools" | "off" | null =
        (surface === "overlay" || surface === "devtools") ? surface
            : (hasApprovalTool && !agentCfg?.pageApprovalAllowed) ? "off" : null;
    control.bg = !!bgSurface;   // so a handle's mid-run say() knows to steer via INJECT_MESSAGE, not the page inbox
    // Trusted (CDP) input works ONLY on the background-hosted path (the page can't reach the debugger).
    // Gate the canvas-click trusted-vs-synthetic choice on that, so a page-hosted run keeps its synthetic
    // canvas click instead of emitting a cdpClick the page loop would drop. (Sealed/@pt/@focus envelopes
    // always emit and the background gates them — they have no synthetic path to regress.)
    setCdpEnabled(cdpOn && !!bgSurface);
    if (bgSurface) {
        registerRun(runHash, toolset, runModel, driverSees, runVisionModel);
        // Phase 2 resume for a BACKGROUND-hosted run: the run's history lives in the service worker,
        // so continuing it is a RESUME_RUN round-trip (not the page-loop's in-memory drive()). We
        // re-register the live tools (endRun cleared them after the prior turn) so delegation works
        // again, then the background reuses the stored payload + history and appends the follow-up.
        agentRegistry.set(runHash, {
            hash: runHash,
            resume: async (t: string): Promise<AgentResult> => {
                registerRun(runHash, toolset, runModel, driverSees, runVisionModel);
                enterAgentRun();
                try {
                    const res = await makeBackgroundTaskPromise<AgentResult>("RESUME_RUN_REQUEST", "RESUME_RUN_RESPONSE", { runId: runHash, task: t }, undefined, signal);
                    const run = endRun(runHash);
                    const { tokenRenders, ...resClean } = res;   // loop-internal — don't leak to the caller
                    const a = run ? runAnswer(run, res.summary) : { elements: [], media: [], answer: "" };
            const outputs = resolveOutputs(a.answer, res.summary, tokenRenders || []);   // structured data → res.outputs (headless)
                    emitDebug({ kind: "agent-result", id: runHash, ts: Date.now(), save: false, session: { hash: runHash, turn: res.steps }, summary: res.summary, steps: res.steps, hitCap: !!res.hitCap, cancelled: !!res.cancelled, ...(a.media.length ? { answerMedia: a.media } : {}), ...(a.answer ? { answer: a.answer } : {}) });
                    return { ...resClean, elements: a.elements, ...(a.media.length ? { answerMedia: a.media } : {}), ...(a.answer ? { answer: a.answer } : {}), ...(outputs.length ? { outputs } : {}), hash: runHash };
                } catch (e) {
                    // Mirror the START path: an aborted resume resolves as a clean cancel; any other failure
                    // (e.g. the background was evicted and can't rehydrate the run) surfaces to the card as a
                    // Run-failed result rather than an unhandled rejection with no UI.
                    const run = endRun(runHash);
                    if (signal?.aborted) {
                        emitDebug({ kind: "agent-result", id: runHash, ts: Date.now(), save: false, session: { hash: runHash, turn: 0 }, summary: "Cancelled by the caller.", steps: 0, hitCap: false, cancelled: true });
                        return { summary: "Cancelled by the caller.", steps: 0, transcript: [], elements: run ? runAnswer(run).elements : [], cancelled: true, hash: runHash };
                    }
                    emitDebug({ kind: "agent-result", id: runHash, ts: Date.now(), save: false, session: { hash: runHash, turn: 0 }, summary: "", steps: 0, hitCap: false, error: (e as Error)?.message || String(e) });
                    throw e;
                } finally { exitAgentRun(); }
            },
        });
        const descriptors = toolset.map(t => ({
            name: t.name, description: t.description, parameters: t.parameters,
            requiresApproval: !!t.requiresApproval, capabilities: t.capabilities || [], summary: t.summary,
            precheck: typeof t.precheck === "function",   // has a doomed-action precheck → the background delegates it before gating
            // Where a remote tool actually dispatches to. Travels so the background's approval card
            // and its per-call grant read the SAME identity — a page cannot make one say search_web
            // while the other authorises send_email.
            ...(t.remote ? { remote: t.remote } : {}),
        }));
        enterAgentRun();   // suppress orphan chat sessions from a delegated tool's internal ml.chat
        try {
            const res = await makeBackgroundTaskPromise<AgentResult>("START_RUN_REQUEST", "START_RUN_RESPONSE", {
                runId: runHash, task, systemPrompt, tools: descriptors,
                model: runModel, think: (think === true || think === false) ? think : null,
                maxSteps, autoApprovePython: autoPy, autoApproveReadonly: autoRO, autoApproveSameOriginAuth: autoSOA, autoApproveSelfSource: autoSelfSrc, labelMatch, surface: bgSurface, stream: stream || undefined, toolTokens: toolTokens || undefined,
                images: pendingImages,   // native-vision composer attachments for this turn's user message
                // (OCR fallback for a text-only driver is already folded into `task` above)
                unattended: unattended || undefined, silent: silent || undefined,
                // A handle's prior history (empty on the first turn) → the background CONTINUES it,
                // so control.messages stays authoritative across turns even on the background path.
                resumeMessages: control.messages.length ? control.messages : undefined,
                // Offsets so the background's emitted step/seq continue past prior turns (the sidebar's
                // turn groups stay distinct on the background path too — otherwise turn N's step 1
                // collides with turn 1's and the chat log scrambles).
                stepBase: control.stepBase, seqBase: control.seqBase,
                // Cross-page persistence: whether to track this run against its tab (survive a nav) +
                // the serializable state a fresh document needs to rebuild the BUILTIN toolset on
                // re-adopt. `navigate: false` opts out of both.
                crossPage: navigate,
                crossOrigin,   // may leave the origin (cross-origin nav gates for consent)
                approvalRouting,   // where privileged gates resolve (idea #2): ui | both | external
                pageOrigin: location.origin,   // seeds the run's consented-origins (cross-origin nav consent)
                pageUrl: location.href, pageTitle: document.title || undefined,   // provenance: WHICH page this ran on
                rebuild: {
                    toolNames: toolset.map(t => t.name),
                    model: runModel, driverSees, visionModel: runVisionModel,
                    groundingModel: runGroundingModel, groundingRange: runGroundingRange,
                    pierceClosed, cdp: cdpOn, crossOrigin,
                },
            }, (result, data) => {
                // Sync the run's final history back into the handle (page-authoritative). This is why
                // a.messages populates + a follow-up run()/say() continues, on the background path too.
                if (data && Array.isArray(data.messages)) control.messages = data.messages as NeutralMessage[];
                // Advance the bases past THIS turn's step/seq so the next turn's offset is right.
                if (data && typeof data.stepCount === "number") control.stepBase += data.stepCount;
                if (data && typeof data.seqCount === "number") control.seqBase += data.seqCount;
                return result as AgentResult;
            }, signal);
            // The real DOM nodes an answer-capable tool returned stayed page-side (they can't cross
            // the bus) — assemble AgentResult.elements from the page-side run record here.
            const run = endRun(runHash);
            const { tokenRenders, ...resClean } = res;   // loop-internal — don't leak to the caller
            const a = run ? runAnswer(run, res.summary) : { elements: [], media: [], answer: "" };
            const outputs = resolveOutputs(a.answer, res.summary, tokenRenders || []);   // structured data → res.outputs (headless)
            const full: AgentResult = { ...resClean, elements: a.elements, ...(a.media.length ? { answerMedia: a.media } : {}), ...(a.answer ? { answer: a.answer } : {}), ...(outputs.length ? { outputs } : {}), hash: runHash };
            emitDebug({ kind: "agent-result", id: runHash, ts: Date.now(), save: false, session: { hash: runHash, turn: res.steps }, summary: res.summary, steps: res.steps, hitCap: !!res.hitCap, cancelled: !!res.cancelled, ...(a.media.length ? { answerMedia: a.media } : {}), ...(a.answer ? { answer: a.answer } : {}) });
            return full;
        } catch (e) {
            const run = endRun(runHash);
            // A caller abort rejects the round-trip; mirror the page loop's clean cancel (resolve,
            // not throw) with the partial run. (The background fetch isn't killed yet — v1 caveat.)
            if (signal?.aborted) {
                emitDebug({ kind: "agent-result", id: runHash, ts: Date.now(), save: false, session: { hash: runHash, turn: 0 }, summary: "Cancelled by the caller.", steps: 0, hitCap: false, cancelled: true });
                return { summary: "Cancelled by the caller.", steps: 0, transcript: [], elements: run ? runAnswer(run).elements : [], cancelled: true, hash: runHash };
            }
            // A FATAL error (e.g. the model call failed) — surface it so the sidebar/card don't hang
            // as "running", then re-throw so ml.agent() still rejects. (No-op in off mode, where the
            // bus is dormant; the BACKGROUND emits the error result for the card there.)
            emitDebug({ kind: "agent-result", id: runHash, ts: Date.now(), save: false, session: { hash: runHash, turn: 0 }, summary: "", steps: 0, hitCap: false, error: (e as Error)?.message || String(e) });
            throw e;
        } finally { exitAgentRun(); }
    }

    // ── Page-hosted loop. It runs the SAME shared `runAgentLoop` (agent-loop.ts) the background
    // path uses — the SECURITY-CRITICAL gate ordering lives in ONE tested place — wired with
    // PAGE-SIDE deps: tools execute inline (executeTool), the caller's approve/onStep run directly,
    // and the debug-render / argIssues enrichment happens in `emit` here. One loop body, two
    // dep-sets (these vs the background's delegating deps in agent-host.ts): no drift.
    const toolMetas = toolset.map(t => ({ name: t.name, requiresApproval: !!t.requiresApproval, capabilities: t.capabilities, ...(t.remote ? { remote: t.remote } : {}) }));
    // runAgentLoop restarts its per-step `seq` at 0 each call, but the sidebar patches steps by
    // (hash, seq) — so a later turn would collide with an earlier one. control.seqBase offsets each
    // turn's seqs past the previous turn's, keeping them unique per SESSION across run()/say().
    let turnMaxSeq = 0, turnMaxStep = 0;

    // Enrich the loop's event with the page-only bits: argIssues, the element COUNT for the debug
    // event + the real nodes for onStep, and a best-effort In/Out render for a step the executor
    // DIDN'T run (pending START / denied / skipped), preferring the executor's own render when present.
    const emit = (ev: { step: number; seq?: number; pending?: boolean; thought?: string; reasoning?: unknown; tool?: string; arguments?: Record<string, unknown>; result?: string; modelResult?: string; token?: string; approval?: "readonly" | "sandbox" | "same-origin" | "consented" | "self-source" | "user" | "denied" | "skipped" | "cancelled"; renderIn?: RenderDescriptor; renderOut?: RenderDescriptor; feedback?: ToolFeedback; usage?: unknown; elements?: unknown[]; reused?: import("./contract").ReusedGrant[]; streamOutput?: string }) => {
        const tool = ev.tool ? byName[ev.tool] : undefined;
        const nodes = ev.elements as Node[] | undefined;
        const argIssues = ev.tool && tool ? validateArgs(tool.parameters, ev.arguments || {}) : undefined;
        let renderIn = ev.renderIn, renderOut = ev.renderOut;
        if (ev.tool && tool && renderIn === undefined && renderOut === undefined) {
            const d = descriptorFor(tool, { result: ev.result || "" }, ev.arguments || {});
            renderIn = d.in;
            renderOut = ev.pending ? undefined : d.out;
        }
        const seq = ev.seq != null ? control.seqBase + ev.seq : ev.seq;   // session-unique across turns
        if (ev.seq != null && ev.seq > turnMaxSeq) turnMaxSeq = ev.seq;
        // Cumulative step number across turns so the sidebar's turn groups (keyed by step) don't
        // MERGE turn N's step 1 with turn 1's step 1 — the "historical steps overwritten" bug.
        const step = control.stepBase + ev.step;
        if (ev.step > turnMaxStep) turnMaxStep = ev.step;
        const cb = { step, thought: ev.thought, tool: ev.tool, arguments: ev.arguments, result: ev.result, elements: nodes };
        if (logDebug && !ev.pending) logStep(cb);
        emitDebug({
            kind: "agent-step", id: runHash, ts: Date.now(), save: false, session: { hash: runHash, turn: step },
            step, localStep: ev.step, seq, pending: ev.pending || undefined,
            thought: ev.thought, reasoning: (ev.reasoning as string | null) || undefined, tool: ev.tool, arguments: ev.arguments,
            result: ev.result, modelResult: ev.modelResult, token: ev.token, elements: nodes ? nodes.length : undefined,
            renderIn, renderOut, feedback: ev.feedback, reused: ev.reused,
            argIssues: argIssues && argIssues.length ? argIssues : undefined,
            approval: ev.approval, usage: (ev.usage as TokenUsage | null) || undefined,
            streamOutput: ev.streamOutput,   // LIVE tool output delta (ctx.stream) — patches the pending row's Out

            // Running tally of delegated look/locate/verify token spend so far this turn (metered in
            // bus.ts). Rides every step so the UI bar can show it live; omitted when nothing delegated.
            subUsage: (() => { const s = subcallUsage(); return s.calls ? s : undefined; })(),
        });
        if (!onStep || ev.pending) return;
        try { onStep(cb); } catch (e) { console.error("ml.agent onStep threw:", e); }
    };

    // Execute a tool inline, compute its In/Out render slots, and collect answer-capable nodes.
    // The page analogue of the background's delegating runTool — but it runs in the page's world.
    // The runtime ToolContext for this run — built once from the finalised toolset (byName) + model,
    // so a tool's run(args, ctx) can adapt to which companion tools are wired (e.g. `locate`).
    const toolCtx = toolContext(byName, runModel, null, driverSees, runVisionModel);
    toolCtx.session = hintSession(runHash);   // a tool's own model calls belong to this run (RequestHint)
    // `ml.dereference` inside an approved exec: the loop hands its pointer resolver to `tokenSink`
    // below, and this closure is what the ToolContext binds — so the primitive is live only while a
    // tool of THIS run is executing (see tool-exec's activeDeref), and resolves against this run.
    let pageDeref: ((ref: string, pipe?: string | string[]) => DerefRead) | null = null;
    toolCtx.deref = async (ref, pipe) => {
        if (!pageDeref) throw new Error("This run has no captured outputs yet.");
        const read = pageDeref(ref, pipe);
        // The store lives page-side for this run, but a STORED table's bytes never do — they are in the
        // worker's value store, so its columns are read there, the same round trip a background-hosted run
        // makes (derefViaBackground binds the identical reader). The worker answers on the TAB's entitlement,
        // so the run hash below only labels the request.
        const key = read.meta?.table ? read.meta.value : undefined;
        const table = read.meta?.table;
        if (!key || !table) return read;
        return { ...read, readColumns: (names: string[]) => columnsViaBackground(runHash, key, names, { ...(table.delimiter ? { delimiter: table.delimiter } : {}), ...(table.headerless ? { headerless: true } : {}) }) };
    };
    // The run's curated answer set (created per run on the ToolContext). The `answer` tool mutates it
    // directly — no per-call accumulation here — and the loop reads it at assembly.
    const answerSet = toolCtx.answer!;
    const runToolDep = async (name: string, args: Record<string, unknown>, onStream?: (text: string) => void) => {
        const tool = byName[name];
        const env = await executeTool(tool, args, toolCtx, onStream);
        const { in: renderIn, out: renderOut } = descriptorFor(tool, env, args);
        // A CUSTOM answer-capable tool just returns nodes (it doesn't know about the answer set) →
        // accumulate them for the user. The built-in `answer` tool curates the set itself and flags
        // `answerManaged`, so it's skipped here (no double-count).
        if (tool && tool.capabilities && tool.capabilities.includes("answer") && env.elements && env.elements.length && !env.answerManaged)
            answerSet.add({ kind: "element", nodes: env.elements as Node[], preview: `${env.elements.length} element(s)`, ...(env.answerMedia && env.answerMedia.length ? { media: env.answerMedia } : {}) });
        return { result: String(env.result), elements: env.elements, renderIn, renderOut, image: env.image, imageLabel: env.imageLabel, images: env.images, feedback: env.feedback };
    };

    const deps: AgentLoopDeps = {
        // WHAT THIS REQUEST IS FOR: an agent step, in this run's session (see RequestHint).
        callModel: (messages, o) => this.step(messages as NeutralMessage[], { tools: toolDefs, model, think, signal,
            hint: { use: "agent", session: hintSession(runHash), ...(o.after ? { after: o.after } : {}) } }),
        runTool: runToolDep,
        // The pending step's pretty In. Page-side the tool object is right here, so this is
        // `descriptorFor` over an EMPTY envelope — the tool's own render(input, args), and nothing
        // that would need it to have run. Defensive: a throwing custom render must not stop a step.
        renderFor: async (name, args) => {
            try { return descriptorFor(byName[name], {} as ToolRenderInput, args).in; }
            catch { return undefined; }
        },
        approve: async ({ tool, arguments: args }) => {
            const d = normalizeApproval(await approve({ tool, arguments: args }), args);
            // Remember every approved external sheet for the rest of this page session (keyed off the
            // FINAL args, in case the user edited them) so a follow-up to the same sheet doesn't re-ask.
            if (d.approved) for (const id of externalSheetIds(d.arguments)) approvedSheets.add(id);
            return { approved: d.approved, feedback: d.feedback || undefined, arguments: d.arguments };
        },
        autoApprove: (name, args) => {
            if (name === "python_exec") {
                const prov = autoApprovePython(args, { autoApprovePython: autoPy }, (id: string) => approvedSheets.has(id));
                if (!prov) return null;
                // Which already-approved external sheet(s) this run reused → a "reused a grant" note.
                const reusedSheets = externalSheetIds(args).filter(id => approvedSheets.has(id));
                return reusedSheets.length ? { approval: prov, reused: reusedSheets.map(id => ({ kind: "sheet" as const, detail: id })) } : prov;
            }
            // navigate: SAME-ORIGIN auto-approves (no escalation); a CROSS-ORIGIN nav falls through to
            // the gate (a page can't silently send the agent to another site). location is authoritative.
            if (name === "navigate") return sameOriginNav(String((args as { url?: unknown }).url ?? "")) ? "same-origin" : null;
            // fetch_url: an UNCREDENTIALED same-origin read is free (the page could fetch its own origin
            // itself). A CREDENTIALED (as-you) same-origin fetch is free ONLY with the Advanced opt-in;
            // otherwise it — and any cross-origin fetch — falls through to the gate.
            if (name === "fetch_url") {
                const u = String((args as { url?: unknown }).url ?? "");
                // THE PAGE YOU ARE ON, in ANY mode — as-you included. The page already holds it, can fetch
                // its own URL with its own cookies, and a read-only exec reads its outerHTML for nothing, so
                // no mode of it is worth a prompt. Checked before the credentials rule, which is about the
                // REST of the origin. (Also why a file:// page works at all: its origin is "null".)
                if (isCurrentPage(u, location.href)) return "same-origin";
                const so = sameOriginFetch(u);
                if ((args as { credentials?: unknown }).credentials) return (agentCfg?.autoApproveSameOriginAuth && so) ? "same-origin" : null;
                if (so) return "same-origin";
                // Uncredentialed read of the agent's OWN repo source (committed files / structural API, NOT
                // a prose endpoint) → free (self-source.ts). Plain GET only — a `rendered` tab-load still asks.
                if (autoSelfSrc && !(args as { rendered?: unknown }).rendered && isSelfSourceUrl(u, BUILD_INFO.repoUrl)) return "self-source";
                return null;
            }
            return null;
        },
        // Read-only exec fast-path: the mediated interpreter is side-effect-free, so trying it is safe
        // and (in-dialect) BOTH auto-approves AND returns the result — no eval (clears Trusted Types).
        // `this` is window.ml; the interpreter reduces it to a facade of ML_READONLY_METHODS, so the
        // agent can read its own setup (getModel/config/…) without the gate and nothing else.
        tryReadonly: autoRO ? async (name, args) => {
            if (name !== "exec" || typeof (args as { js?: unknown }).js !== "string") return null;
            if (outputCapEscalated("exec", args)) return null;   // a raised output cap must hit the human gate, never auto-approve
            try {
                // Expand pointer macros BEFORE the dialect sees the source. `@tool:abc` is not
                // JavaScript, so the tokenizer rejects it and the whole survey falls through to the
                // approval gate — while the same read spelled `ml.dereference("@tool:abc")` is free,
                // since `dereference` is in ML_READONLY_METHODS. Without this the macro would teach
                // the model the MORE expensive spelling of a read it is allowed to do for nothing.
                //
                // Nothing is pre-hydrated here: the dialect auto-awaits a facade call, so a pointer
                // is a value on this path too — the same semantics, arrived at differently.
                const { code: roSrc } = expandPointers((args as { js: string }).js);
                // The run's resolver is bound for the attempt: it runs before any tool call, outside
                // executeTool's binding, and `ml.dereference` reads whatever is bound.
                const ro = await withRunDeref(toolCtx.deref, () => evalReadonly(roSrc, document, this,
                    makeAnswerFacade(answerSet, elLine), { checkpoint: () => answerSet.checkpoint() }));
                const { result, elements, render } = formatReadonlyExec(ro.value, ro.logs);
                const { in: renderIn, out: renderOut } = descriptorFor(byName[name], { result, elements, render }, args);
                // Cached ml.fetch URLs this survey re-read → a "reused a grant you approved" note (transparency).
                const urls = [...new Set(ro.reused)];
                const reused = urls.length ? urls.map(u => ({ kind: "fetch-url" as const, detail: u })) : undefined;
                return { result, elements, renderIn, renderOut, reused };
            } catch (e) {
                // A REFUSAL falls through to the human gate; a script error is answered here. See
                // readonlyRefused — approving a typo cannot make it run, and the approved attempt
                // throws the same error a moment later having spent the interrupt.
                if (readonlyRefused(e)) return null;
                // The line the interpreter was on, when it knows it — the same fact the approved path
                // reports from a real stack, and the model is retrying this code either way.
                const at = (e as { mlLine?: number })?.mlLine ?? null;
                const msg = `Error: ${errText(e)}${at ? ` (line ${at})` : ""}`;
                const { in: renderIn } = descriptorFor(byName[name], { result: msg }, args);
                return { result: msg, renderIn, renderOut: { type: "exec-out" as const, error: `${errText(e)}${at ? ` (line ${at})` : ""}`, ...(at ? { errorLine: at } : {}) } };
            }
        } : undefined,
        precheck: async (name, args) => {
            const tool = byName[name];
            if (typeof tool?.precheck !== "function") return null;
            try { return tool.precheck(args) || null; } catch { return null; }
        },
        // control.messages IS the live session history (the loop mutates it in place, so a.messages
        // reflects it and a handle's next turn continues it). Ensure the system prompt heads it, then
        // append this turn's task (empty when run() was called with no arg — it runs over prior say()s).
        buildMessages: (t) => {
            if (!control.messages.some(m => m.role === "system")) control.messages.unshift({ role: "system", content: systemPrompt });
            // Attach this turn's composer images to the user message (native-vision path); the OCR
            // path already folded its text into `t`. pendingImages is consumed once → first turn only.
            if (t || pendingImages) {
                const um: NeutralMessage = { role: "user", content: t || "" };
                if (pendingImages) { um.images = pendingImages; pendingImages = undefined; }
                control.messages.push(um);
            }
            return control.messages;
        },
        pushAssistant: (messages, msg) => (messages as NeutralMessage[]).push({ role: "assistant", content: msg.content || "", tool_calls: msg.tool_calls }),
        pushToolResult: (messages, call, result) => (messages as NeutralMessage[]).push({ role: "tool", tool_call_id: call.id, content: result }),
        // Mid-run steering (a.say()): drain the inbox at each step boundary and inject as user turns.
        // Draining IS the agent seeing each steer, so fan an `agent-say-seen` per bubble (the indicator).
        drainInbox: () => {
            const items = control.inbox.splice(0);
            if (control.hash) for (const it of items) emitDebug({ kind: "agent-say-seen", id: control.hash, ts: Date.now(), save: false, session: { hash: control.hash, turn: 0 }, sayId: it.id });
            return items.map(it => it.text);
        },
        pushUser: (messages, text) => (messages as NeutralMessage[]).push({ role: "user", content: text }),
        // #3 inline vision: a tool result can't carry an image, so hand any screenshots this step
        // captured to the (vision-capable) driver as a user turn for its NEXT call.
        pushToolImages: (messages, images) => (messages as NeutralMessage[]).push({
            role: "user",
            content: shotTurnMessage(images.map(p => p.label).join(", "), images.length),
            images: images.map(p => p.image),
        }),
        emit,
        // Delegated-sub-call token tally (this turn) for chat_metadata — the "invisible" spend of
        // the auto-wired look/locate/verify vision calls the loop never sees directly (metered in bus.ts).
        subcallTokens: () => subcallUsage(),
        // chat_metadata: resolve the run's model FACTS (the loop supplies the live token/message
        // counts). Each lookup degrades to null — the tool still reports the rest.
        chatMeta: async () => {
            let capabilities: string[] | null = null, contextWindow: number | null = null, vramBytes: number | null = null;
            if (runModel) {
                try { capabilities = await mlApi.capabilities(runModel); } catch { /* unknown */ }
                try { const lm = (await mlApi.ps()).find(m => m.model === runModel); contextWindow = lm?.contextLength ?? null; vramBytes = lm?.vramBytes ?? null; } catch { /* no ps */ }
            }
            // Resident in Ollama (caps came back) → local; else cloud/remote (or unknown w/o a model).
            const local = capabilities !== null ? true : runModel ? false : null;
            const fmt = (agentCfg as { apiFormat?: string } | null)?.apiFormat;
            const backend = fmt === "ollama" ? "Ollama (native)" : fmt === "openai" ? "OpenAI-compatible (e.g. OpenWebUI — server-side tools available)" : null;
            const est = (s: string) => (s ? Math.round(s.length / 4) : 0);   // ~chars/4, no real tokenizer
            let toolJson = "";
            try { toolJson = JSON.stringify(toolset.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }))); } catch { /* skip */ }
            // The machine: devices and memory, from /api/info (null on a server that does not serve it).
            // Asked only for a LOCAL model: a cloud model's hardware is not this box's.
            let capacity: import("./resource-model").Capacity | null | undefined;
            if (local === true) { try { const raw = await mlApi.info(); capacity = raw ? parseInfo(raw) : null; } catch { capacity = null; } }
            return { model: runModel, contextWindow, capabilities, vramBytes, local, backend, systemTokens: est(systemPrompt), toolTokens: est(toolJson), capacity };
        },
    };

    // One turn of the run. `t` is appended to control.messages (empty → run over prior say()s);
    // buildMessages continues the live history, and maxSteps is read fresh each step (handle can
    // raise it mid-run). answered resets per turn; the seq base advances so steps stay session-unique.
    // Turns this handle has run: a later one follows a PERSON (a follow-up, Continue, Retry), which is what its
    // first request's hint says (`after: "human"`). Counted here rather than read off `seqBase`, which stays
    // 0 after a turn that only answered.
    let turnsRun = 0;
    const drive = async (t: string): Promise<AgentResult> => {
        answerSet.clear();   // the answer set reflects THIS turn's designations only
        enterAgentRun();   // suppress orphan chat sessions from a tool's internal ml.chat; finally-decremented
        try {
            const r = await runAgentLoop(t, { tools: toolMetas, maxSteps: () => control.maxSteps, signal, unattended, toolTokens, runHash, seqBase: control.seqBase, ...(turnsRun++ > 0 ? { after: "human" as const } : {}), stream, tokenStore: (control.tokens ??= new TokenStore()), labelMatch, tokenSink: (fn) => { pageDeref = fn; } }, deps);
            control.seqBase += turnMaxSeq; turnMaxSeq = 0;   // next turn's step seqs continue past this turn's
            control.stepBase += turnMaxStep; turnMaxStep = 0;   // …and its step numbers, so turn groups stay distinct
            // The bottom-of-answer render: the outputs the model DESIGNATED into the answer set, minus
            // anything it already cited INLINE in its reply (no auto-fallback — nothing uncited is promoted).
            // `tokenRenders` is loop-internal — strip it from the result ml.agent() resolves to the caller.
            const { tokenRenders, ...rr } = r;
            const media = answerSet.media(); const answer = finalizeAnswer(answerSet, r.summary);
            const outputs = resolveOutputs(answer, r.summary, tokenRenders || []);   // structured data → res.outputs (headless)
            emitDebug({ kind: "agent-result", id: runHash, ts: Date.now(), save: false, session: { hash: runHash, turn: r.steps }, summary: r.summary, steps: r.steps, hitCap: !!r.hitCap, cancelled: !!r.cancelled, ...(media.length ? { answerMedia: media } : {}), ...(answer ? { answer } : {}) });
            return { ...rr, elements: answerSet.elements() as Node[], ...(media.length ? { answerMedia: media } : {}), ...(answer ? { answer } : {}), ...(outputs.length ? { outputs } : {}), hash: runHash };
        } catch (e) {
            // A FATAL error escaped the loop — surface it so the sidebar doesn't hang as "running",
            // then re-throw so ml.agent() still rejects. (An abort already resolved cleanly inside.)
            if (!signal?.aborted) emitDebug({ kind: "agent-result", id: runHash, ts: Date.now(), save: false, session: { hash: runHash, turn: 0 }, summary: "", steps: 0, hitCap: false, error: (e as Error)?.message || String(e) });
            throw e;
        } finally { exitAgentRun(); }
    };
    // Register the run so ml.agent(task, { resume }) can re-enter this turn's loop (createAgent uses
    // its own control instead). A resume continues control.messages just like a handle's run().
    agentRegistry.set(runHash, { hash: runHash, resume: (t: string) => drive(t) });
    return drive(task);
};

// Spreadsheets the user has approved `python_exec` access to THIS page session (keyed by
// Google spreadsheet id). Lets a repeat call to the same sheet skip the external-sheet
// re-prompt. Page-scoped (module lifetime) — gone on reload; never persisted.
const approvedSheets = new Set<string>();   // spreadsheets the user OK'd this page-session

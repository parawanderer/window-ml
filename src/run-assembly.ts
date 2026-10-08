// run-assembly.ts — turning a run's OPTIONS into the run: its toolset, its vision reader, its system prompt.
//
// Two hosts assemble runs, and they must assemble the same one. The page does it for a console `ml.agent()` (with
// the page's own `window.ml`); the service worker does it for a run the USER started from an extension surface (with
// `workerMl`, sw-run-start.ts), so that a page never decides what a run the user asked for contains
// (docs/spec/SITE_ACCESS.md, slice 0). One function, handed an `ml` by each host, is what stops the two drifting.
//
// Nothing here may touch the page. The page context goes into the system prompt AFTER assembly (`withPageContext`),
// because on the worker path it is the page's answer to a question asked once the toolset exists.

import { CITABLE_TOOLS } from "./agent-loop";
import { buildServerTools } from "./builtin-tools";
import { type MlApi, type MlTool, type MlPublicConfig, DEFAULT_GROUNDING_RANGE, type VisionMemory, detectGroundingModel, type LexicalMetric, type ElementContext } from "./contract";
import type { PromptOrigin } from "./contract/contract-run";
import type { StartRunPayload, RebuildConfig } from "./contract/contract-messages";
import { promptSurfaceClause, promptSurfaceOf } from "./prompt-surface";
import { stepBudget } from "./step-budget";
import { UNATTENDED_EXEC_NOTE, UNATTENDED_PY_NOTE, AGENT_SYSTEM, CALL_TITLE_CLAUSE, VISION_CLAUSE, ANSWER_CLAUSE, TOOLTOKENS_CLAUSE, DEREF_CLAUSE, WAIT_CLAUSE, SHADOW_CLAUSE, SHADOW_CLOSED_PIERCE_NOTE, SHADOW_CLOSED_NOTE, IFRAME_CLAUSE, SHADOW_EXEC_NOTE, SELF_CLAUSE, PIPE_CLAUSE, PYTHON_CLAUSE, EXEC_COMPUTE_CLAUSE, EXEC_RANGE_CLAUSE, UNATTENDED_CLAUSE, NAV_OFF_CLAUSE, HUD_PROSE_QUIET, HUD_PROSE_PROGRESS, askAboutTask } from "./prompts";
import { citeParam, withCallTitle } from "./tool-params";
import { buildDereferenceTool } from "./tools";

/** The part of `window.ml` assembly reads: config and capability probes, the model and server-tool lists, the tool
 *  factories, and the OCR reader for a pasted image. The worker's adapter implements exactly this. */
export type AssemblyMl = Pick<MlApi, "domTools" | "defineTool" | "config" | "models" | "serverTools" | "read" | "_imageToDataUrl"
    | "_resolveVisionModel" | "_nativeLookTool" | "lookTool" | "locateTool" | "navigateTool" | "fetchTool">;

/** The options of `ml.agent` that decide what a run CONTAINS, as opposed to how it is driven or observed. */
export interface AssemblyOptions {
    tools?: MlTool[] | null;
    extraTools?: MlTool[];
    serverTools?: string[];
    commanderTools?: boolean;
    system?: string | null;
    systemAppend?: string | null;
    model?: string | null;
    vision?: boolean | string | null;
    unattended?: boolean;
    navigate?: boolean;
    crossOrigin?: boolean;
    toolTokens?: boolean;
    images?: (string | HTMLImageElement)[];
}

/** What a run is, once assembled: everything the loop, the delegation and the cross-page rebuild need. */
export interface AssembledRun {
    toolset: MlTool[];
    byName: Record<string, MlTool>;
    toolDefs: { type: string; function: { name: string; description: string; parameters: unknown } }[];
    /** without the page context: append that with `withPageContext` */
    systemPrompt: string;
    /** the task, with a pasted image's transcription folded in when the driver cannot see it */
    task: string;
    /** native-vision attachments for the first user turn (only when the driver sees) */
    pendingImages: string[] | undefined;
    /** every attachment as a data URL, for the transcript */
    turnImages: string[];
    agentCfg: MlPublicConfig | null;
    runModel: string | null;
    driverSees: boolean;
    runVisionModel: string | null;
    runGroundingModel: string | null;
    runGroundingRange: number;
    autoRO: boolean;
    autoPy: boolean;
    autoSOA: boolean;
    autoSelfSrc: boolean;
    labelMatch: LexicalMetric | undefined;
    pierceClosed: boolean;
    cdpOn: boolean;
}

/**
 * Assemble a run from its options with the given `ml`. Probes the backend (vision capability, the model list for a
 * grounding model, the server-tool bundles) through `ml`, so the same call does the same thing in either host.
 * Side-effect free: the page path sets its module flags (closed-shadow piercing, CDP) from the result itself.
 * @param ml the host's `ml` (`window.ml` in a page, `workerMl` in the service worker)
 * @param task the run's task
 * @param opts what the run should contain
 * @returns the assembled run
 */
export async function assembleRun(ml: AssemblyMl, task: string, { tools = null, extraTools = [], serverTools = [], commanderTools = false, system = null, systemAppend = null, model = null, vision = null, unattended = false, navigate = true, crossOrigin = false, toolTokens = false, images = [] }: AssemblyOptions = {}): Promise<AssembledRun> {
    let toolset = [...(tools || ml.domTools || []), ...extraTools];
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
            const cfg = await ml.config();
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
            const bundles = await ml.serverTools();
            toolset = [...toolset, ...buildServerTools(ml as MlApi, bundles, wantBundles, srvOff)];
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
    const agentCfg = await ml.config().catch(() => null);
    // The run's driver model — the SINGLE resolution reused for vision wiring, the ToolContext, and the
    // loop below (was computed twice). The fresh-config fallback covers a momentarily-null agentCfg so
    // this can't be null while the reader resolves non-null. Null only when neither a per-call model nor
    // a configured default exists — the run then fails downstream at prepareRequest ("No model configured").
    const runModel = model || agentCfg?.model || (await ml.config().catch(() => null))?.model || null;
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
        const visionModel = await ml._resolveVisionModel(model, vision);
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
                toolset.push(ml._nativeLookTool(visionMemory));
            } else {
                toolset.push(ml.lookTool({ model: visionModel, memory: visionMemory }));
            }
            // Grounding (opt-in): the effective model is the explicit field, or
            // the auto-detected qwen when it's blank; plus its coordinate range.
            let groundingModel: string | null = null, groundingRange = DEFAULT_GROUNDING_RANGE;
            try {
                const cfg = await ml.config();
                if (cfg.groundingEnabled) {
                    groundingRange = cfg.groundingRange || DEFAULT_GROUNDING_RANGE;
                    groundingModel = cfg.groundingModel.trim() || detectGroundingModel(await ml.models()) || null;
                }
            } catch { /* config/models unavailable → Set-of-Marks only */ }
            runGroundingModel = groundingModel; runGroundingRange = groundingRange;   // carried for cross-page rebuild
            // driverSees rides the ToolContext (below), not a build opt; memory is the shared dedup registry.
            toolset.push(ml.locateTool({ model: visionModel, groundingModel, groundingRange, memory: visionMemory }));
        }
    }
    // Cross-page navigation (idea #1). Default ON: wire a `navigate(url)` tool so a background-hosted
    // run can walk between same-site pages, surviving the full-page load (the barrier + re-adopt path
    // below). `navigate: false` disables it entirely — no tool, no cross-page persistence (the run
    // ends at a nav), and NAV_OFF_CLAUSE tells the model so instead of it wasting steps trying.
    if (navigate && !toolset.some(t => t.name === "navigate")) toolset.push(ml.navigateTool({ crossOrigin }));
    // fetch_url: READ a URL the page can't (a raw file / API / other site) WITHOUT navigating — a gated
    // GET (uncredentialed by default; `credentials`/`rendered` opt into the user's session / a JS render).
    // Auto-wired into the DEFAULT kit only (`tools` not overridden); it needs no
    // navigation, so it's added even on a navigate:false run. A caller who hand-picks `tools` gets exactly
    // what they list (add `ml.fetchTool()` to include it) — unlike the vision tools, which augment any
    // driver because they're capability-probed. requiresApproval, so default-on is safe.
    if (!tools && !toolset.some(t => t.name === "fetch_url")) toolset.push(ml.fetchTool());
    // Composer attachments for THIS turn's first user message (a screenshot pasted/uploaded into the
    // HUD/sidebar). A vision-capable driver sees them natively; otherwise transcribe via the reader
    // (ml.read → the OCR model) and fold the text into the task, so a text-only agent still gets the
    // content — with an honest note it didn't see the pixels itself. driverSees/runVisionModel are the
    // SAME values that chose native-vs-delegated `look`, so the image path matches the tool path.
    let pendingImages: string[] | undefined;
    let turnImages: string[] = [];   // the resolved data URLs, for the debug transcript (shown in BOTH the vision + OCR cases)
    if (images && images.length) {
        try {
            const urls = await Promise.all(images.map(im => ml._imageToDataUrl(im)));
            turnImages = urls;
            if (driverSees) pendingImages = urls;
            else {
                const notes: string[] = [];
                for (let i = 0; i < urls.length; i++) {
                    let txt = "";
                    try { txt = await ml.read(urls[i], { model: runVisionModel }); } catch { /* reader unavailable → leave blank */ }
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
        toolset = [...toolset, buildDereferenceTool(ml.defineTool)];
        toolset = toolset.map(t => CITABLE_TOOLS.has(t.name)
            ? { ...t, parameters: { ...t.parameters, properties: { ...(t.parameters as { properties?: Record<string, unknown> }).properties,
                token: citeParam("the pricing table") } } }
            : t);
    }
    // THE MODEL'S OWN ACCOUNT of each call, offered on every tool. Injected into the TOOLSET and not only into
    // the model-facing `toolDefs`, which matters in three places at once: the background run's descriptors are
    // built from the toolset too (so one injection covers both loops), and both the loop's `validateArgs` and the
    // panel's argument-issue strip read `tool.parameters` — against which an unannounced `title` would read as an
    // unknown property and put a ⚠ on every call that used it.
    toolset = toolset.map(t => ({ ...t, parameters: withCallTitle(t.parameters) }));
    const byName = Object.fromEntries(toolset.map(t => [t.name, t]));
    const toolDefs = toolset.map(t => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters }
    }));
    const hasCap = (cap: "vision" | "answer") => toolset.some(t => t.capabilities && t.capabilities.includes(cap));
    let systemPrompt = system || AGENT_SYSTEM;
    if (!system) {
        // Adapt the default prompt to what the toolset can actually do.
        systemPrompt += CALL_TITLE_CLAUSE;   // every tool carries the param, so the instruction is unconditional
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

    return {
        toolset, byName, toolDefs, systemPrompt, task, pendingImages, turnImages, agentCfg, runModel, driverSees,
        runVisionModel, runGroundingModel, runGroundingRange, autoRO, autoPy, autoSOA, autoSelfSrc, labelMatch, pierceClosed, cdpOn,
    };
}

/**
 * Append the page's own context (URL, title, language, time, locale) to an assembled system prompt. Kept apart from
 * `assembleRun` because the worker learns it from the page AFTER assembly, and because it is page DATA: whatever the
 * page says about itself, exactly as a tool result is.
 * @param systemPrompt the assembled prompt
 * @param ctx the page context text, or null/empty for none
 * @returns the prompt with the context appended, or unchanged
 */
export function withPageContext(systemPrompt: string, ctx: string | null | undefined): string {
    return ctx ? `${systemPrompt}\n\nCurrent page context:\n${ctx}` : systemPrompt;
}

/** A run the USER asked for from one of the extension's own surfaces: the HUD Commander, the chat page, a right-click
 *  "ask about this". Everything here came from the person, not from the page the run will act on. */
export interface UserRunRequest {
    task: string;
    /** composer attachments, already data URLs */
    images?: string[];
    /** a right-clicked element, resolved by the shell; the task is framed around it */
    elementContext?: ElementContext;
    /** the composer's step budget */
    maxSteps?: number;
    /** the composer's model pick (absent: the configured default) */
    model?: string;
    /** force native vision on the picked model */
    vision?: true;
    /** stream the model's thinking live */
    stream?: true;
    /** the HUD verbosity setting: "quiet" keeps the model silent between steps */
    hud?: string;
    /** where the prompt was typed; anything unrecognised reads as the HUD */
    surface?: string;
}

/** The Commander kit's extra tools, from whichever host's factories. */
type KitMl = Pick<MlApi, "clickTool" | "typeTool" | "pythonTool" | "chatMetaTool">;

/**
 * The recipe for a run the user started from a surface: a capable kit (click, type, python and `chat_metadata` on top
 * of the default DOM tools and the auto-wired vision tools), the provenance and verbosity clauses, cross-origin
 * navigation (each crossing still asks), tool tokens, and the server-tool bundles marked always-present. The
 * worker assembles every such run from this (sw-run-start.ts).
 * @param ml the host's factories for the kit's extra tools
 * @param req what the person asked for
 * @returns the task (framed around a right-clicked element when there is one), the run's provenance, and the options
 *   to assemble it with
 */
export function userRunOptions(ml: KitMl, req: UserRunRequest): { task: string; origin: PromptOrigin; maxSteps?: number; stream: boolean; options: AssemblyOptions } {
    let task = String(req.task || "").trim();
    const ctx = req.elementContext;
    if (ctx && typeof ctx.selector === "string") task = askAboutTask(task, ctx);
    const origin: PromptOrigin = { surface: promptSurfaceOf(req.surface) ?? "hud" };
    const proseClause = req.hud === "quiet" ? HUD_PROSE_QUIET : HUD_PROSE_PROGRESS;
    const maxSteps = stepBudget(req.maxSteps);
    const model = typeof req.model === "string" && req.model.trim() ? req.model.trim() : undefined;
    return {
        task, origin,
        ...(maxSteps ? { maxSteps } : {}),
        stream: req.stream === true,
        options: {
            extraTools: [ml.clickTool(), ml.typeTool(), ml.pythonTool(), ml.chatMetaTool()],
            // `systemAppend`, not `system`: the run still needs the whole method, it just is not a console call.
            systemAppend: promptSurfaceClause(origin) + proseClause,
            crossOrigin: true,
            toolTokens: true,
            commanderTools: true,
            ...(model ? { model } : {}),
            ...(req.vision === true ? { vision: true } : {}),
            images: Array.isArray(req.images) ? req.images : undefined,
        },
    };
}

/**
 * The serializable descriptors a background-hosted run holds for its tools: what the model is shown, and what decides
 * how a call is gated. Built from the toolset by the host that assembled it, never from anything a page reports.
 * @param toolset the assembled tools
 * @returns one descriptor per tool, in order
 */
export function toolDescriptors(toolset: MlTool[]): StartRunPayload["tools"] {
    return toolset.map(t => ({
        name: t.name, description: t.description, parameters: t.parameters,
        requiresApproval: !!t.requiresApproval, capabilities: t.capabilities || [], summary: t.summary,
        precheck: typeof t.precheck === "function",   // has a doomed-action precheck → the background delegates it before gating
        // Where a remote tool actually dispatches to. Travels so the background's approval card
        // and its per-call grant read the SAME identity — a page cannot make one say search_web
        // while the other authorises send_email.
        ...(t.remote ? { remote: t.remote } : {}),
    }));
}

/**
 * What a fresh document needs to rebuild an assembled run's BUILTIN toolset: tool names and the vision facts, CARRIED
 * rather than re-probed. Remote tools are left out: they are never rebuilt in a page.
 * @param asm the assembled run
 * @param crossOrigin whether its `navigate` may cross origins
 * @param builtBy "worker" for a run the worker built and drives
 * @returns the rebuild config
 */
export function rebuildFor(asm: AssembledRun, crossOrigin: boolean, builtBy?: "worker"): RebuildConfig {
    return {
        ...(builtBy ? { builtBy } : {}),
        toolNames: asm.toolset.filter((t) => !t.remote).map((t) => t.name),
        model: asm.runModel, driverSees: asm.driverSees, visionModel: asm.runVisionModel,
        groundingModel: asm.runGroundingModel, groundingRange: asm.runGroundingRange,
        pierceClosed: asm.pierceClosed, cdp: asm.cdpOn, crossOrigin,
    };
}

/** How an assembled run is to be hosted: what the host decides rather than what assembly produced. */
export interface RunHosting {
    runId: string;
    /** the full prompt, page context included */
    systemPrompt: string;
    maxSteps: number;
    think: boolean | null;
    surface: StartRunPayload["surface"];
    stream?: boolean;
    toolTokens?: boolean;
    origin?: PromptOrigin | null;
    unattended?: boolean;
    silent?: boolean;
    /** may the run navigate (and survive a navigation)? */
    navigate: boolean;
    crossOrigin: boolean;
    approvalRouting: StartRunPayload["approvalRouting"];
    /** the page the run starts on: its origin seeds the cross-origin consent, the rest is provenance */
    page: { origin: string; url: string; title?: string };
    /** "worker" for a run the worker built (sw-run-start.ts) */
    builtBy?: "worker";
}

/**
 * The START_RUN payload for an assembled run: the ONE place its fields are filled, for a run the page built and one
 * the worker built alike, so a field added to the payload cannot reach one host and silently miss the other.
 * @param asm the assembled run
 * @param h how it is hosted
 * @returns the payload; a host adds what only it has (a handle's history and offsets)
 */
export function startPayload(asm: AssembledRun, h: RunHosting): StartRunPayload {
    return {
        runId: h.runId, task: asm.task, systemPrompt: h.systemPrompt, tools: toolDescriptors(asm.toolset),
        model: asm.runModel, think: h.think, maxSteps: h.maxSteps,
        autoApprovePython: asm.autoPy, autoApproveReadonly: asm.autoRO, autoApproveSameOriginAuth: asm.autoSOA, autoApproveSelfSource: asm.autoSelfSrc,
        labelMatch: asm.labelMatch, surface: h.surface,
        stream: h.stream || undefined, toolTokens: h.toolTokens || undefined, origin: h.origin || undefined,
        // native-vision composer attachments for this turn's user message (an OCR fallback is already in `task`)
        images: asm.pendingImages,
        unattended: h.unattended || undefined, silent: h.silent || undefined,
        // Cross-page persistence: whether to track this run against its tab (survive a nav), and what a fresh document
        // needs to rebuild the builtin toolset on re-adopt. `navigate: false` opts out of both.
        crossPage: h.navigate,
        crossOrigin: h.crossOrigin,
        approvalRouting: h.approvalRouting,
        pageOrigin: h.page.origin, pageUrl: h.page.url, pageTitle: h.page.title || undefined,
        rebuild: rebuildFor(asm, h.crossOrigin, h.builtBy),
        ...(h.builtBy ? { builtBy: h.builtBy } : {}),
    };
}

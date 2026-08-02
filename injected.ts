// This runs in the "Main World" (same as the page JS)

import type {
    MlPublicConfig,
    NeutralMessage,
    ToolResult,
    MlTool,
    ApprovalRequest,
    ApprovalDecision,
    AgentResult,
    AgentTranscriptEntry,
    SessionRef,
    DebugChatStart,
    DebugChatResult,
    DebugChatError,
    DebugSessionConfig,
    FetchLlmPayload,
    ChatOptions,
    ExtendProfile,
    JsonSchema,
    ToolCall,
    RenderDescriptor,
    ToolRenderInput,
    StoredSession,
    LoadedModel,
    TokenUsage,
    MlHistory,
    TableSource,
    TablePreview
} from "./contract";
import { detectGroundingModel, DEFAULT_GROUNDING_RANGE } from "./contract";
import { evalReadonly } from "./readonly-exec";
import { truncate, errText, elPath, describeSkeleton, queryAll, selectorError, extractTable, castTableColumns, googleSheetCsvUrl, googleSheetId, externalSheetIds, parseCsv, nonEmptyTables, classifyOverlay } from "./dom";
import { AGENT_SYSTEM, VISION_CLAUSE, ANSWER_CLAUSE, WAIT_CLAUSE, PYTHON_CLAUSE, EXEC_COMPUTE_CLAUSE } from "./prompts";
import { pageContext, cropDataUrl, MIN_SHOT_PX, POINT_RE, resolvePoint, PT_LOOK_RADIUS, BOX_RE, resolveBox } from "./util";
import type { ShotBox } from "./contract";
import { annotate, pickAccentColorForTarget } from "./som";
import { suspiciousArgsWarning, suspiciousChars } from "./security";
import { emitDebug, debugId, shortHash, sessionRegistry, enterAgentRun, exitAgentRun } from "./bus";
import { makeDomTools } from "./tools";
import { hideSidebarForShot, makeBackgroundTaskPromise, makeChatRequest, makeStreamingTaskPromise } from "./bridge";
import { validateArgs, validateExtend } from "./validate";
import { renderArgs, logStep, defaultApprove, normalizeApproval, formatReadonlyExec } from "./approval";
import { buildLookTool, buildLocateTool, buildClickTool, buildTypeTool, buildPythonTool, targetRender } from "./builtin-tools";
import { pyVarNameError } from "./python-env";
import { autoApprovePython } from "./auto-approve";
import { executeTool } from "./tool-exec";
import { installToolDelegation, registerRun, endRun } from "./run-delegation";
import { descriptorFor } from "./render-descriptor";

/** One resolved `python_exec` table source: its var name, provenance, and the payload the sandbox
 *  builds a DataFrame from (rows or read_html html). Internal to injected.ts. */
type LoadedTable = { name: string; source: TableSource; data: { kind: "rows"; columns: string[]; rows: (string | number | null)[][] } | { kind: "html"; html: string } };

(function() {

    // Spreadsheets the user has approved `python_exec` access to THIS page session (keyed by
    // Google spreadsheet id). Lets a repeat call to the same sheet skip the external-sheet
    // re-prompt. Page-scoped (module lifetime) — gone on reload; never persisted.
    const approvedSheets = new Set<string>();   // spreadsheets the user OK'd this page-session

    // ---- Agent tool helpers (page-context DOM introspection) ----
    // These keep observations SMALL on purpose: the point of the agent is to
    // iterate with cheap probes instead of dumping HTML into the model's
    // context. Every helper truncates hard and never returns outerHTML.



    /**
     * Render a tool's arguments for an approval prompt.
     * String values shown raw (real newlines — so an exec `js` blob is readable, not escaped JSON),
     * others as compact JSON.
     *
     * @param {Object} args The arguments to render.
     * @returns {string} The rendered arguments string.
     */

    window.ml = {
        /**
         * Create a stateful multi-turn chat session.
         *
         * Stateful multi-turn chat:
         *
         * ```js
         *   const history = ml.createChat({ system, model, think });
         *   await history.chat("first question", { images: [...] });
         *   await history.chat("follow-up");
         *   history.messages.at(-1)   // last message
         *   history.fork()            // independent copy of the conversation
         *
         * ```
         *
         * `history.messages` is a plain `[{ role, content, images? }]` array. You can
         * edit it freely (pop to retry, splice to prune, tweak `.content`).
         * A failed request leaves the history untouched.
         *
         * @param {Object} [options] Options object.
         * @param {string} [options.system] Optional system prompt (first message).
         * @param {string} [options.model] Default model for this chat; null uses the saved default.
         * @param {boolean} [options.think=false] True/false maps to Ollama's "think" parameter; null omits it.
         * @param {Object} [options.schema] JSON Schema to constrain reply to matching JSON (returns parsed object).
         * @param {string[]} [options.toolIds] OpenWebUI server-side tool ids (e.g. `["web_search"]`). OpenWebUI only.
         * @param {number} [options.maxTokens] Hard cap on generated tokens; null omits it.
         * @param {boolean} [options.save=false] Persist across reloads when debug sidebar is on.
         * @returns {{messages: Array<{role: string, content: string, images?: Array, sources?: Array}>, hash: string, model: string|null, think: boolean, schema: Object|null, toolIds: string[]|null, maxTokens: number|null, save: boolean, chat: Function, fork: Function}} Chat session object.
         */
        createChat: function({ system = null, model = null, extend = null, numCtx = null, numGpu = null, think = false, schema = null, toolIds = null, maxTokens = null, save = false }: Pick<ChatOptions, "system" | "model" | "extend" | "numCtx" | "numGpu" | "think" | "schema" | "toolIds" | "maxTokens"> & { save?: boolean } = {}): MlHistory {
            validateExtend(extend);
            const ml = this;
            const history: MlHistory = {
                messages: system ? [{ role: "system", content: system }] : [],
                // Stable per-session id (see the debug sidebar). Read it off the
                // history object (history.hash) to identify / later resume a chat.
                hash: shortHash(),
                model,
                extend,
                numCtx,
                numGpu,
                think,
                schema,
                toolIds,
                maxTokens,
                save,
                /**
                 * Send a turn in this chat session.
                 *
                 * @param {string} prompt The user prompt.
                 * @param {Object} [options] Options object.
                 * @param {Array} [options.images=[]] Images to include with the prompt.
                 * @param {string} [options.model=this.model] Model override for this turn.
                 * @param {boolean} [options.think=this.think] Thinking flag for this turn.
                 * @param {Object} [options.schema=this.schema] JSON Schema for structured output.
                 * @param {string[]} [options.toolIds=this.toolIds] OpenWebUI server-side tool ids.
                 * @param {number} [options.maxTokens=this.maxTokens] Token limit for this turn.
                 * @param {boolean} [options.save=this.save] Persist this turn when sidebar is on.
                 * @param {(delta: string, full: string) => void} [options.onToken=null] Streaming callback.
                 * @returns {Promise<string|Object>} The model's reply (parsed if schema set).
                 */
                chat: async function(this: MlHistory, prompt: string, { images = [], model = this.model, extend = this.extend, numCtx = this.numCtx, numGpu = this.numGpu, think = this.think, schema = this.schema, toolIds = this.toolIds, maxTokens = this.maxTokens, save = this.save, onToken, signal = null }: {
                    images?: (string | HTMLImageElement)[];
                    model?: string | null;
                    extend?: ExtendProfile | null;
                    numCtx?: number | null;
                    numGpu?: number | null;
                    think?: boolean | null;
                    schema?: JsonSchema | null;
                    toolIds?: string[] | null;
                    maxTokens?: number | null;
                    save?: boolean;
                    onToken?: (delta: string, full: string) => void;
                    signal?: AbortSignal | null;
                } = {}): Promise<string | Record<string, unknown>> {
                    validateExtend(extend);
                    const userMessage: NeutralMessage = { role: "user", content: prompt };
                    if (images.length) {
                        userMessage.images = await Promise.all(
                            images.map(image => ml._imageToDataUrl(image))
                        );
                    }

                    const requestPayload: FetchLlmPayload = { "messages": [...this.messages, userMessage], "think": think, "model": model, "extend": extend, "numCtx": numCtx, "numGpu": numGpu, "schema": schema, "toolIds": toolIds, "maxTokens": maxTokens };
                    // Debug sidebar: announce the request (no-op unless the sidebar is on).
                    const debug = debugId();
                    // Group turns of THIS conversation by the session hash; `turn` is
                    // this turn's 0-based index (prior user messages). Fixes the
                    // "each follow-up spawns a new block" bug in the sidebar.
                    const session: SessionRef = { hash: this.hash, turn: this.messages.filter(m => m.role === "user").length };
                    // The session's creation config (createChat options) — what
                    // the sidebar's "options" block shows, distinct from the
                    // per-turn request/messages below. Sourced from the history
                    // (this.*) + the closed-over `system`, so it reflects the
                    // createChat instantiation, not any per-turn overrides.
                    const config: DebugSessionConfig = {
                        system,
                        model: this.model,
                        think: (this.think === true || this.think === false) ? this.think : null,
                        schema: !!this.schema,
                        toolIds: this.toolIds || null,
                        maxTokens: this.maxTokens ?? null,
                        save: this.save
                    };
                    emitDebug({ kind: "chat", id: debug, ts: Date.now(), save, session, streaming: typeof onToken === "function" && !schema, config, request: {
                        model: model || null,
                        extend: extend || null,
                        messages: requestPayload.messages,
                        images: userMessage.images || null,
                        toolIds: toolIds || null,
                        schema: !!schema,
                        think: (think === true || think === false) ? think : null,
                        maxTokens: maxTokens ?? null
                    } });
                    let content, sources, resolvedModel, reasoning, usage;
                    try {
                        ({ content, sources, model: resolvedModel, reasoning, usage } = (typeof onToken === "function" && !schema)
                            ? await makeStreamingTaskPromise(requestPayload, onToken, signal)
                            : await makeChatRequest(requestPayload, signal));
                    } catch (err) {
                        emitDebug({ kind: "chat-error", id: debug, ts: Date.now(), save, session, error: String((err as Error).message || err) });
                        throw err;
                    }
                    const reply = content;
                    const assistantMessage: NeutralMessage = { role: "assistant", content: reply };
                    if (sources && sources.length) assistantMessage.sources = sources;
                    this.messages.push(userMessage, assistantMessage);
                    // Persist { save:true } sessions so ml.resumeChat survives reloads/tabs
                    // (fire-and-forget; no secrets in a session — just history + options).
                    if (save) makeBackgroundTaskPromise("SAVE_SESSION_REQUEST", "SAVE_SESSION_RESPONSE", {
                        hash: this.hash,
                        session: {
                            hash: this.hash, messages: this.messages, model: this.model, extend: this.extend,
                            numCtx: this.numCtx, numGpu: this.numGpu, think: this.think, schema: this.schema,
                            toolIds: this.toolIds, maxTokens: this.maxTokens, save: true,
                        },
                    }).catch(() => { /* storage full / unavailable — resume just won't have this turn */ });
                    emitDebug({ kind: "chat-result", id: debug, ts: Date.now(), save, session, content: reply, sources: (sources && sources.length) ? sources : null, structured: !!schema, model: resolvedModel || model || null, extend: extend || null, reasoning: reasoning || null, usage: usage || null });
                    return (schema ? ml._parseJSON(reply) : reply) as string | Record<string, unknown>;
                },
                /**
                 * Create an independent copy of this chat session.
                 *
                 * @returns {{messages: Array, hash: string, model: string|null, think: boolean, schema: Object|null, toolIds: string[]|null, maxTokens: number|null, save: boolean, chat: Function, fork: Function}} A new chat session with cloned messages.
                 */
                fork: function(this: MlHistory): MlHistory {
                    const copy = ml.createChat({ model: this.model, extend: this.extend, numCtx: this.numCtx, numGpu: this.numGpu, think: this.think, schema: this.schema, toolIds: this.toolIds, maxTokens: this.maxTokens, save: this.save });
                    copy.messages = structuredClone(this.messages);
                    return copy;
                }
            };
            sessionRegistry.set(history.hash, history);   // same-tab resume by hash
            return history;
        },
        /**
         * Resume a chat by its session hash (shown/copied in the debug sidebar).
         * Same-tab sessions resume from an in-memory registry; across reloads or
         * tabs only `{ save: true }` sessions survive (persisted to storage via
         * the background). Returns a history you can `.chat()` on to continue it.
         *
         * @param {string} hash The session hash.
         * @returns {Promise<Object>} A chat history continuing that conversation.
         * @throws {Error} If no resumable session exists for the hash.
         */
        resumeChat: async function(hash: string): Promise<MlHistory> {
            if (!hash || typeof hash !== "string") throw new Error("ml.resumeChat needs a session hash string.");
            const live = sessionRegistry.get(hash);
            if (live) return live;   // this tab → the same object, continue it
            const stored = await makeBackgroundTaskPromise<StoredSession | null>("GET_SESSION_REQUEST", "GET_SESSION_RESPONSE", { hash });
            if (!stored) throw new Error(
                `No resumable session "${hash}". Session-local chats live only in the tab that made them; ` +
                `pass { save: true } to ml.createChat for a chat that survives reloads/tabs.`
            );
            const h = this.createChat({
                model: stored.model, extend: stored.extend, numCtx: stored.numCtx, numGpu: stored.numGpu,
                think: stored.think, schema: stored.schema, toolIds: stored.toolIds, maxTokens: stored.maxTokens, save: stored.save,
            });
            h.messages = stored.messages || [];
            h.hash = hash;                  // keep the original hash (createChat minted a fresh one)
            sessionRegistry.set(hash, h);   // register the rehydrated session under its real hash
            return h;
        },
        /**
         * One-shot chat — a throwaway single-turn history.
         * Options: { system, think, images, model, schema, toolIds, maxTokens, save, onToken } as in createChat.
         *
         * @param {string} prompt The user prompt.
         * @param {Object} [options] Chat options (same as createChat).
         * @returns {Promise<string|Object>} The model's reply.
         */
        chat: async function(prompt: string, options: ChatOptions = {}): Promise<string | unknown> {
            return this.createChat(options).chat(prompt, options);
        },
        /**
         * Low-level single model turn WITH client-side tools.
         * Returns the raw assistant message { content, tool_calls: [{ id, name, arguments }] } and
         * hands control back to you: execute the calls, append the results as
         * { role: "tool", tool_call_id, content }, and call ml.step again to
         * continue. You own the loop (whitelist, limits, overseer — all yours).
         * Works on both OpenWebUI and plain Ollama (wire differences normalized).
         *
         * @param {Array<{role: string, content: string, tool_call_id?: string}>} messages The conversation messages.
         * @param {Object} [options] Options object.
         * @param {Array} [options.tools=[]] Client-side tool definitions.
         * @param {string} [options.model=null] Model override.
         * @param {boolean} [options.think=null] Thinking flag; null omits it.
         * @returns {Promise<{content: string, tool_calls: Array<{id?: string, name: string, arguments: Object}>}>} The assistant message with tool calls.
         */
        step: async function(messages: NeutralMessage[], { tools = [], model = null, think = null, signal = null }: {
            tools?: unknown[];
            model?: string | null;
            think?: boolean | null;
            signal?: AbortSignal | null;
        } = {}): Promise<{ content: string; tool_calls: ToolCall[]; reasoning?: string | null; usage?: TokenUsage | null }> {
            return makeBackgroundTaskPromise(
                "LLM_REQUEST",
                "LLM_RESPONSE",
                { "messages": messages, "tools": tools, "model": model, "think": think, "raw": true },
                undefined,
                signal,   // abort kills the in-flight fetch AND rejects here (the agent loop converts it to a clean cancel)
            );
        },
        /**
         * @typedef {Object} MlTool An agent tool the model can call.
         * @property {string} name The name the model calls.
         * @property {string} [description] What it does, shown to the model.
         * @property {Object} [parameters] JSON Schema for the arguments object.
         * @property {(args: Object) => (string|{content: string, elements?: Node[]}|Promise<string|{content: string, elements?: Node[]}>)} run
         *   Executes in the page context. Returns a short string for the model, or
         *   `{ content, elements }` to also route real DOM nodes to the loop's
         *   onStep/transcript (for hovering in devtools) — `elements` never reaches
         *   the model.
         * @property {boolean} [requiresApproval] When true, {@link module:ml.agent}
         *   pauses and calls its approval gate before every model-driven call —
         *   set it on anything with side effects or arbitrary power (e.g. `exec`).
         * @property {string[]} [capabilities] Role tags the agent adapts to, e.g.
         *   `["vision"]` (this tool lets the model see) or `["answer"]` (this tool
         *   designates result element(s), surfaced on `result.elements`).
         */

        /**
         * Build one agent tool: a JSON-schema function signature the model sees,
         * paired with a `run(args)` that executes in the page. Compose an array of
         * these and hand it to {@link module:ml.agent} — `ml.domTools` is just the
         * default array, so adding a tool is pushing another object (the "bash
         * tools" surface).
         *
         * @param {MlTool} tool
         * @returns {MlTool} The tool with defaults filled in.
         * @throws {Error} If `name` or a `run` function is missing.
         */
        defineTool: function({ name, description = "", parameters = { type: "object", properties: {} }, run, requiresApproval = false, capabilities = [], render, precheck }: Partial<MlTool> = {}): MlTool {
            if (!name || typeof run !== "function") {
                throw new Error("ml.defineTool needs a name and a run(args) function");
            }
            return { name, description, parameters, run, requiresApproval, capabilities, render, precheck };
        },
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
         * @param {string} [opts.hints] Task-specific notes APPENDED to the system prompt
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
        agent: async function(task: string, { tools = null, extraTools = [], system = null, hints = null, maxSteps = 10, model = null, think = null, approve = defaultApprove, onStep = null, env = true, vision = null, logDebug = false, signal = null }: {
            tools?: MlTool[] | null;
            extraTools?: MlTool[];
            system?: string | null;
            hints?: string | null;
            maxSteps?: number;
            model?: string | null;
            think?: boolean | null;
            approve?: (req: ApprovalRequest) => boolean | ApprovalDecision | Promise<boolean | ApprovalDecision>;
            onStep?: ((ev: { step: number; thought?: string; tool?: string; arguments?: Record<string, unknown>; result?: string; elements?: Node[] }) => void) | null;
            env?: boolean;
            vision?: boolean | string | null;
            logDebug?: boolean;
            signal?: AbortSignal | null;
        } = {}): Promise<AgentResult> {
            const toolset = [...(tools || this.domTools || []), ...extraTools];
            // Config, fetched once (used for vision resolution + the read-only exec
            // auto-approve fast-path below).
            const agentCfg = await this.config().catch(() => null);
            const autoRO = !!(agentCfg && (agentCfg as { autoApproveReadonly?: boolean }).autoApproveReadonly);
            const autoPy = !!(agentCfg && (agentCfg as { autoApprovePython?: boolean }).autoApprovePython);
            // #8 + #3: give the agent eyes with no wiring, preferring NATIVE vision.
            // If the agent's OWN model is vision-capable, register a capture-only
            // `look` whose screenshot ml.agent injects straight into the model's
            // history (#3 inline vision), so it reasons over the real pixels instead
            // of a lossy delegated text summary — the failure mode where a model
            // "stumbles around" on an easy task. If only the OCR model can see, fall
            // back to the delegated `lookTool` (#8). A forced `vision:"<model>"` is
            // always delegated (can't inline a model that isn't the agent's).
            if (vision !== false && !toolset.some(t => t.capabilities && t.capabilities.includes("vision"))) {
                const agentModel = model || agentCfg?.model || null;
                // The model that will SEE: forced value → agent's own (if it reports
                // vision) → the OCR model → null. `look` prefers NATIVE inline vision
                // when the agent's own model can see; otherwise it's delegated. `locate`
                // is ALWAYS delegated (it reads badges), so it just needs any resolved
                // reader — added alongside look whenever one exists.
                const visionModel = await this._resolveVisionModel(model, vision);
                if (visionModel) {
                    const forcedDelegate = typeof vision === "string" && !!vision;
                    // Native (agent sees the pixels) when the caller FORCES it (`vision:true`,
                    // bypassing the probe for a cloud model it knows sees) OR an auto-probe
                    // confirms the agent's own model is vision-capable; else delegated.
                    if (vision === true || (!forcedDelegate && await this._modelSees(agentModel))) {
                        toolset.push(this._nativeLookTool());
                    } else {
                        toolset.push(this.lookTool({ model: visionModel }));
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
                    toolset.push(this.locateTool({ model: visionModel, groundingModel, groundingRange }));
                }
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
                if (toolset.some(t => t.name === "wait")) systemPrompt += WAIT_CLAUSE;
                // Deterministic-compute clause. python_exec is the better calculator; when it's
                // absent, exec (read-only JS: Array/Math/.reduce) is the fallback — either way the
                // model must compute, never guess. Mutually exclusive so the prompt isn't doubled.
                if (toolset.some(t => t.name === "python_exec")) systemPrompt += PYTHON_CLAUSE;
                else if (toolset.some(t => t.name === "exec")) systemPrompt += EXEC_COMPUTE_CLAUSE;
            }
            if (hints) systemPrompt += `\n\nTask-specific notes:\n${hints}`;
            if (env) {
                const ctx = pageContext();
                if (ctx) systemPrompt += `\n\nCurrent page context:\n${ctx}`;
            }
            const messages: NeutralMessage[] = [
                { role: "system", content: systemPrompt },
                { role: "user", content: task }
            ];
            const transcript: AgentTranscriptEntry[] = [];
            const answered: Node[] = [];   // element(s) designated via an `answer`-capable tool
            // Debug sidebar: announce the run + each step. Its own session hash
            // (an agent run isn't a createChat). elements can't cross the window
            // bus — send a count; real nodes still reach onStep/the console.
            const runHash = shortHash();
            // Resolve the driver model to the config default when none was passed, so the
            // sidebar shows the REAL model (not "default") and can tell when a vision
            // sub-call reused it (its `model` matches this) vs. ran on a different one.
            const runModel = model || agentCfg?.model || null;
            emitDebug({ kind: "agent", id: runHash, ts: Date.now(), save: false, session: { hash: runHash, turn: 0 }, task, model: runModel, maxSteps, config: {
                system: systemPrompt, customSystem: !!system,
                tools: toolset.map(t => ({ name: t.name, requiresApproval: !!t.requiresApproval, vision: !!(t.capabilities && t.capabilities.includes("vision")), description: t.description, parameters: t.parameters })),
                maxSteps, think: (think === true || think === false) ? think : null, env, vision: vision ?? null, hints: hints || null,
            } });

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
            // Off-mode closure: with no debug surface, a privileged run on a NON-whitelisted origin still
            // routes to the unforgeable background gate — the shell mounts an acrylic corner CARD (shell.ts
            // + app.tsx CardApp) that renders the pending approval and returns the decision via the same
            // origin-authed SET_APPROVAL. A WHITELISTED origin (the user trusts this domain to self-gate) or
            // a run with no privileged tool (nothing to gate) falls through to the in-page loop below.
            const bgSurface: "overlay" | "devtools" | "off" | null =
                (surface === "overlay" || surface === "devtools") ? surface
                    : (hasApprovalTool && !agentCfg?.pageApprovalAllowed) ? "off" : null;
            if (bgSurface) {
                registerRun(runHash, toolset);
                const descriptors = toolset.map(t => ({
                    name: t.name, description: t.description, parameters: t.parameters,
                    requiresApproval: !!t.requiresApproval, capabilities: t.capabilities || [],
                    precheck: typeof t.precheck === "function",   // has a doomed-action precheck → the background delegates it before gating
                }));
                enterAgentRun();   // suppress orphan chat sessions from a delegated tool's internal ml.chat
                try {
                    const res = await makeBackgroundTaskPromise<AgentResult>("START_RUN_REQUEST", "START_RUN_RESPONSE", {
                        runId: runHash, task, systemPrompt, tools: descriptors,
                        model: runModel, think: (think === true || think === false) ? think : null,
                        maxSteps, autoApprovePython: autoPy, autoApproveReadonly: autoRO, surface: bgSurface,
                    }, undefined, signal);
                    // The real DOM nodes an answer-capable tool returned stayed page-side (they can't cross
                    // the bus) — assemble AgentResult.elements from the page-side run record here.
                    const run = endRun(runHash);
                    const full: AgentResult = { ...res, elements: run ? run.answered : [] };
                    emitDebug({ kind: "agent-result", id: runHash, ts: Date.now(), save: false, session: { hash: runHash, turn: res.steps }, summary: res.summary, steps: res.steps, hitCap: !!res.hitCap, cancelled: !!res.cancelled });
                    return full;
                } catch (e) {
                    const run = endRun(runHash);
                    // A caller abort rejects the round-trip; mirror the page loop's clean cancel (resolve,
                    // not throw) with the partial run. (The background fetch isn't killed yet — v1 caveat.)
                    if (signal?.aborted) {
                        emitDebug({ kind: "agent-result", id: runHash, ts: Date.now(), save: false, session: { hash: runHash, turn: 0 }, summary: "Cancelled by the caller.", steps: 0, hitCap: false, cancelled: true });
                        return { summary: "Cancelled by the caller.", steps: 0, transcript: [], elements: run ? run.answered : [], cancelled: true };
                    }
                    throw e;
                } finally { exitAgentRun(); }
            }

            let stepSeq = 0;   // monotonic id per tool-call step, correlating its in-flight START with its DONE
            const emit = (event: { step: number; seq?: number; pending?: boolean; thought?: string; reasoning?: string | null; tool?: string; arguments?: Record<string, unknown>; result?: string; elements?: Node[]; renderIn?: RenderDescriptor; renderOut?: RenderDescriptor; argIssues?: string[]; approval?: "readonly" | "sandbox" | "user" | "denied" | "skipped"; usage?: TokenUsage | null }) => {
                // A `pending` START is a sidebar-render-only event: it has no result yet, so it must
                // NOT reach onStep/logStep (those fire once per COMPLETED step, or they'd log "→ undefined").
                if (logDebug && !event.pending) logStep(event);
                emitDebug({
                    kind: "agent-step", id: runHash, ts: Date.now(), save: false, session: { hash: runHash, turn: event.step },
                    step: event.step, seq: event.seq, pending: event.pending || undefined,
                    thought: event.thought, reasoning: event.reasoning || undefined, tool: event.tool, arguments: event.arguments,
                    result: event.result, elements: event.elements ? event.elements.length : undefined,
                    renderIn: event.renderIn, renderOut: event.renderOut,
                    argIssues: event.argIssues && event.argIssues.length ? event.argIssues : undefined,
                    approval: event.approval, usage: event.usage || undefined,
                });
                if (!onStep || event.pending) return;
                try { onStep(event); } catch (e) { console.error("ml.agent onStep threw:", e); }
            };
            // The two render slots for a tool step (In = the call, Out = the result) are computed by
            // the shared `descriptorFor` (render-descriptor.ts) — the SAME function run-delegation.ts
            // uses on the background path, so both surfaces render identically.
            const finish = (r: AgentResult): AgentResult => {
                emitDebug({ kind: "agent-result", id: runHash, ts: Date.now(), save: false, session: { hash: runHash, turn: r.steps }, summary: r.summary, steps: r.steps, hitCap: !!r.hitCap, cancelled: !!r.cancelled });
                return r;
            };
            // Caller aborted via opts.signal → stop the loop, resolve (not reject) with the partial
            // run marked cancelled, mirroring the hitCap convention (the transcript so far is useful).
            const cancelled = (step: number): AgentResult =>
                finish({ summary: "Cancelled by the caller.", steps: step, transcript, elements: answered, cancelled: true });
            enterAgentRun();   // suppress orphan chat sessions from internal tool chats (see emitDebug); finally-decremented below
            try {
            for (let step = 1; step <= maxSteps; step++) {
                // Cancellation is checked at each step boundary — before the model call, and again
                // after it (the long wait) before running a tool — so an abort stops promptly at
                // whichever boundary comes next. `step - 1` steps are complete at this point. The
                // signal is ALSO passed into the model call, so an abort mid-request kills the fetch
                // and rejects here — caught and turned into the same clean cancel.
                if (signal?.aborted) return cancelled(step - 1);
                let msg;
                try { msg = await this.step(messages, { tools: toolDefs, model, think, signal }); }
                catch (e) { if (signal?.aborted) return cancelled(step - 1); throw e; }
                if (signal?.aborted) return cancelled(step - 1);
                if (!msg.tool_calls || !msg.tool_calls.length) {
                    // Final answer step: emit its usage (the run's peak context) + reasoning, no tool.
                    if (msg.usage || msg.reasoning) emit({ step, usage: msg.usage, reasoning: msg.reasoning });
                    return finish({ summary: (msg.content || "").trim(), steps: step - 1, transcript, elements: answered });
                }
                // `content` is the assistant's user-facing PROSE (shown as the step's thought);
                // `reasoning` is its separate thinking channel (rendered as a collapsible think
                // section). A model that thinks in reasoning_content leaves content empty while
                // tool-calling, so emit on reasoning too. Usage rides the same emit.
                const thought = (msg.content || "").trim();
                if (thought || msg.usage || msg.reasoning) {
                    if (thought) transcript.push({ thought });
                    emit({ step, thought: thought || undefined, reasoning: msg.reasoning, usage: msg.usage });
                }
                messages.push({ role: "assistant" as const, content: msg.content || "", tool_calls: msg.tool_calls });

                // Run a tool → its { result, elements?, image?, render? } envelope. Extracted to
                // `executeTool` (tool-exec.ts) — the SAME executor design A's RUN_TOOL_IN_PAGE handler
                // uses, so the page loop and the background-delegated path can't drift. Real DOM nodes
                // in `elements` reach onStep/the transcript (never the model).
                const runTool = executeTool;

                const pendingImages = [];   // #3: screenshots captured this turn, injected below
                for (const call of msg.tool_calls) {
                    const tool = byName[call.name];
                    let args = (call.arguments || {}) as Record<string, unknown>;
                    let result, elements, image, imageLabel, toolRender, toolRenderIn;
                    let approval: "readonly" | "sandbox" | "user" | "denied" | "skipped" | undefined;
                    // In-flight START: render the pending tool call NOW (name + args + best-effort In),
                    // patched by the DONE emit below (same seq). Paints before an auto-approved /
                    // non-approval tool runs; a blocking confirm() defers it until approved — the case
                    // inline approvals will remove. Sidebar-only (onStep/logStep skip a pending event).
                    const seq = ++stepSeq;
                    emit({ step, seq, tool: call.name, arguments: args, pending: true,
                        argIssues: tool ? validateArgs(tool.parameters, args) : undefined,
                        renderIn: descriptorFor(tool, { result: "" }, args).in });
                    if (!tool) {
                        result = `Error: no tool named "${call.name}".`;
                    } else if (tool.requiresApproval) {
                        // Experimental fast-path: a read-only `exec` survey runs via the
                        // mediated mini-interpreter with NO approval (and no eval → clears
                        // Trusted Types). The interpreter is side-effect-free, so simply
                        // *trying* it is safe: any NotInDialect/Denied throw means nothing
                        // observable happened, and we fall through to the normal gate.
                        let handled = false;
                        if (autoRO && tool.name === "exec" && typeof (args as { js?: unknown }).js === "string") {
                            try {
                                const ro = evalReadonly((args as { js: string }).js, document);
                                ({ result, elements } = formatReadonlyExec(ro.value, ro.logs));
                                handled = true;
                                approval = "readonly";
                            } catch { /* outside the dialect / blocked → normal approval path */ }
                        }
                        // Experimental fast-path: a READONLY-mode python_exec runs with no
                        // approval. The offscreen sandbox is hardened for readonly mode (no
                        // network / JS scope / DOM / filesystem — a pure function over the
                        // inputs), so it can't affect the page or exfiltrate. A `full`-mode
                        // call (network) always falls through to the gate. Hidden/bidi chars in
                        // the code also fall through, so the human sees the suspicious-char
                        // banner before it runs (the same check the manual prompt applies). An
                        // An EXTERNAL Google Sheet (a Sheets URL that isn't the current page — in the
                        // `sheet` arg OR any `tables` value) always asks: fetching arbitrary Google
                        // data the user didn't navigate to is privileged; `'current'` (the page they're
                        // on) is fine. But once the user has approved a given SPREADSHEET this
                        // page-session, don't re-escalate subsequent calls to it (they granted access to
                        // that resource) — this only lifts the external-sheet escalation, so a non-autoPy
                        // run is still gated on the code as usual; the cache just stops re-asking.
                        // The trusted-world auto-approve decision is now the shared `autoApprovePython`
                        // (auto-approve.ts) — pure, so design A's background loop makes the SAME call
                        // where the page can't forge it. Here it runs page-side (today's loop).
                        if (!handled && tool.name === "python_exec"
                            && autoApprovePython(args, { autoApprovePython: autoPy }, (id: string) => approvedSheets.has(id)) === "sandbox") {
                            approval = "sandbox";
                            ({ result, elements, image, imageLabel, render: toolRender, renderIn: toolRenderIn } = await runTool(tool, args));
                            handled = true;
                        }
                        // Doomed-action skip: a side-effect-free precheck (click/type target resolution). If
                        // the action can't proceed (no element, stale @pt, bad selector), return that error
                        // WITHOUT gating — approving something that will only fail is pointless friction. No
                        // approval provenance (it never ran, never gated).
                        if (!handled && typeof tool.precheck === "function") {
                            try { const pre = tool.precheck(args); if (pre) { result = pre; approval = "skipped"; handled = true; } } catch { /* precheck threw → fall through to the gate */ }
                        }
                        if (!handled) {
                            // Approval gate. `approve` may return a boolean or the rich
                            // contract { approved, feedback?, arguments? } — a rejection
                            // can hand the model a comment, an approval can edit the args.
                            const decision = normalizeApproval(await approve({ tool: call.name, arguments: args }), args);
                            if (!decision.approved) {
                                approval = "denied";
                                result = decision.feedback
                                    ? `Denied by the user: ${decision.feedback}\nDo not retry this exact call unchanged; address the feedback or try another approach.`
                                    : "Denied by the user. Do not retry this exact call; try another approach.";
                            } else {
                                approval = "user";
                                args = decision.arguments;   // possibly caller-edited before running
                                // Remember every approved external sheet for the rest of this page
                                // session, so a follow-up call to the same spreadsheet doesn't re-prompt
                                // (keyed off the FINAL args, in case the user edited them before approving).
                                for (const id of externalSheetIds(args)) approvedSheets.add(id);
                                ({ result, elements, image, imageLabel, render: toolRender, renderIn: toolRenderIn } = await runTool(tool, args));
                            }
                        }
                    } else {
                        ({ result, elements, image, imageLabel, render: toolRender } = await runTool(tool, args));
                    }
                    result = String(result);
                    const entry: AgentTranscriptEntry = { tool: call.name, arguments: args, result };
                    if (elements && elements.length) entry.elements = elements;
                    transcript.push(entry);
                    const { in: renderIn, out: renderOut } = descriptorFor(tool, { result, elements, image, imageLabel, render: toolRender, renderIn: toolRenderIn }, args);
                    const argIssues = tool ? validateArgs(tool.parameters, args) : undefined;
                    emit({ step, seq, ...entry, renderIn, renderOut, argIssues, approval });   // DONE — patches the pending START (same seq)
                    // An answer-capable tool designates the caller-facing result node(s).
                    if (tool && tool.capabilities && tool.capabilities.includes("answer") && elements && elements.length) {
                        answered.push(...elements);
                    }
                    messages.push({ role: "tool" as const, tool_call_id: call.id, content: result });
                    if (image) pendingImages.push({ image, label: imageLabel || "screenshot" });
                }

                // #3 inline vision: hand any screenshots captured this turn to the
                // agent's OWN (vision-capable) model as a user turn, so the next step
                // reasons over the real pixels. v1 is the "dumb" way — the image stays
                // in history (no purge), so context grows with each look; that's the
                // known tradeoff (see roadmap #3). Tool RESULTS can't carry images, a
                // user turn can — buildMessage already renders images per format.
                if (pendingImages.length) {
                    const labels = pendingImages.map(p => p.label).join(", ");
                    messages.push({
                        role: "user" as const,
                        content: `Screenshot${pendingImages.length > 1 ? "s" : ""} you requested (${labels}). ` +
                            "Describe what you see, then take the next action — or give your final answer if the task is done.",
                        images: pendingImages.map(p => p.image)
                    });
                }
            }
            return finish({ summary: `Stopped at the ${maxSteps}-step cap without finishing.`, steps: maxSteps, transcript, elements: answered, hitCap: true });
            } finally { exitAgentRun(); }
        },
        /**
         * A de-duplicating approval gate for {@link module:ml.agent}: prompts (via
         * confirm) the first time it sees a given call and remembers that answer per
         * **(tool + exact arguments)**. So an identical repeat isn't re-asked, but a
         * DIFFERENT call is — crucially, each distinct `exec` script must be approved
         * on its own (blanket-approving arbitrary eval would defeat the gate).
         * Denials are remembered too and fed back to the model. Pass it as `approve`:
         *   ml.agent(task, { approve: ml.approveOnce() })
         * @returns {(req: {tool: string, arguments: Object}) => boolean}
         */
        approveOnce: function(): (req: ApprovalRequest) => boolean {
            const remembered: Record<string, boolean> = {};   // (tool + args) key -> remembered decision
            return ({ tool, arguments: args }: ApprovalRequest): boolean => {
                let key;
                try { key = tool + " " + JSON.stringify(args); }
                catch { key = tool + " " + String(args); }
                if (!(key in remembered)) {
                    remembered[key] = (typeof window.confirm === "function") && window.confirm(
                        `${suspiciousArgsWarning(args)}window.ml agent wants to run "${tool}":\n\n${renderArgs(args)}\n\n` +
                        `Allow this call? (an identical repeat won't ask again)`
                    );
                }
                return remembered[key];
            };
        },
        /**
         * One-shot chat with a "short and concise" modifier.
         *
         * @param {string} prompt The user prompt.
         * @param {Object} [options] Chat options.
         * @returns {Promise<string>} The model's concise reply.
         */
        chatShort: async function(prompt: string, options: ChatOptions): Promise<string> {
            return (await this.chat(`${prompt}. Short and concise:`, options)) as string;
        },
        // OCR: transcribe baked-in text from an image to a plain string, using
        // the dedicated OCR (vision) model — so the reasoning model never sees
        // image tokens. Composes with chat:
        //   await ml.chat("Summarize: " + await ml.read($0))
        /**
         * OCR: transcribe baked-in text from an image to a plain string, using
         * the dedicated OCR (vision) model — so the reasoning model never sees
         * image tokens. Composes with chat:
         *   await ml.chat("Summarize: " + await ml.read($0))
         *   await Promise.all(imgs.map(i => ml.read(i)))
         *
         * @param {string|HTMLImageElement} image An <img> element or URL string.
         * @param {Object} [options] Options object.
         * @param {string} [options.model=null] Per-call override of the configured OCR model.
         * @param {string} [options.prompt=null] Override the default transcription prompt.
         * @returns {Promise<string>} The transcribed text.
         */
        read: async function(image: string | HTMLImageElement, { model = null, prompt = null }: { model?: string | null; prompt?: string | null } = {}): Promise<string> {
            const dataUrl = await this._imageToDataUrl(image);
            const instruction = prompt ||
                "Transcribe all text in this image exactly as it appears, " +
                "preserving reading order. Output only the transcribed text — " +
                "no commentary, no descriptions, no markdown.";
            const reply = await makeBackgroundTaskPromise<string>(
                "LLM_REQUEST",
                "LLM_RESPONSE",
                {
                    "messages": [{ role: "user", content: instruction, images: [dataUrl] }],
                    "think": null,
                    "model": model,
                    "ocr": true
                }
            );
            return reply.trim();
        },
        /**
         * Screenshot to a PNG data URL. With no target, captures the whole visible
         * viewport (use it to ORIENT — see the page like you would in devtools).
         * With a target, scrolls it into view and crops to its rect. Feed either
         * to a vision model:
         *
         * ```js
         *   await ml.chat("What does this show?", { images: [await ml.screenshot("#card")] })
         *   await ml.chat("What page is this?", { images: [await ml.screenshot()] })
         *```
         *
         * @param {string|Element|null} [target=null] A CSS selector, an Element, or null for the whole viewport.
         * @param {Object} [options] Options object.
         * @param {boolean} [options.scroll=true] Set false to skip scroll-into-view.
         * @param {boolean} [options.fullPage=false] Set true to capture the full page (stitched).
         * @param {number} [options.index=0] Which match of a selector to shoot (0-based).
         * @param {boolean} [options.raw=false] For an `@pt`/`@box` token: return the plain crop
         *   (no verify overlay/padding — the actual pixels). Default draws the marker/outline.
         * @param {number} [options.margin=0] For an `@pt` token: the crop radius (px) around the
         *   point. 0 = the default look-radius. Ignored otherwise.
         * @returns {Promise<string>} The screenshot as a PNG data URL.
         */
        screenshot: async function(target: string | Element | null = null, { scroll = true, fullPage = false, index = 0, raw = false, margin = 0 }: { scroll?: boolean; fullPage?: boolean; index?: number; raw?: boolean; margin?: number } = {}): Promise<string> {
            // Hide the debug sidebar overlay (if mounted) for the shot, so it isn't
            // captured into the agent's `look`; restore after. No wait when the
            // sidebar is off (no #ml-sb-root) — it's a no-op then.
            const viewport = async (): Promise<string> => {
                await hideSidebarForShot();
                try { return await makeBackgroundTaskPromise<string>("CAPTURE_TAB_REQUEST", "CAPTURE_TAB_RESPONSE", {}); }
                finally { window.postMessage({ __mlSidebarShot: "show" }, "*"); }
            };
            if (target == null) return fullPage ? this._stitchFullPage(viewport) : viewport();

            // An `@pt:` point token (a canvas coordinate from locate) → a cropped view around
            // the point with a MARK on the exact click spot, so look() can VERIFY what a click
            // will hit (a canvas has no DOM node to screenshot). Works for both look paths.
            if (typeof target === "string" && POINT_RE.test(target.trim())) {
                const pt = resolvePoint(target);
                if (!pt) throw new Error(`Unknown point token "${target}" — re-run locate for a fresh one.`);
                const dpr = window.devicePixelRatio || 1, R = margin > 0 ? margin : PT_LOOK_RADIUS;
                const left = Math.max(0, pt.x - R), top = Math.max(0, pt.y - R);
                const rect = { left, top, width: Math.min(window.innerWidth, pt.x + R) - left, height: Math.min(window.innerHeight, pt.y + R) - top };
                const cropped = await cropDataUrl(await viewport(), rect, dpr);
                if (raw) return cropped;   // pythonExec: raw pixels of the neighbourhood, no marker overlay
                const marker = { left: pt.x - left - 12, top: pt.y - top - 12, width: 24, height: 24 };
                // Contrast the marker with the background AND the target under it (in image px).
                const color = await pickAccentColorForTarget(cropped, { left: marker.left * dpr, top: marker.top * dpr, width: marker.width * dpr, height: marker.height * dpr });
                return annotate(cropped, [{ rect: marker, color, label: "click point", float: true }], dpr);
            }

            // An `@box:` container token (a canvas region from locate({ container: true })) →
            // a padded crop with the region OUTLINED, so look() can VERIFY what you scoped to
            // before operating inside it. The canvas analogue of screenshotting a container.
            if (typeof target === "string" && BOX_RE.test(target.trim())) {
                const bx = resolveBox(target);
                if (!bx) throw new Error(`Unknown container token "${target}" — re-run locate({ container: true }) for a fresh one.`);
                // raw (pythonExec): the EXACT box content — no padding, no outline — so the
                // pixels the sandbox sees are the container's, not the marker's. Non-raw
                // (look verify): pad + outline so the driver can see what it scoped to.
                const dpr = window.devicePixelRatio || 1, pad = raw ? 0 : 16;
                const left = Math.max(0, bx.left - pad), top = Math.max(0, bx.top - pad);
                const rect = { left, top, width: Math.min(window.innerWidth, bx.right + pad) - left, height: Math.min(window.innerHeight, bx.bottom + pad) - top };
                const cropped = await cropDataUrl(await viewport(), rect, dpr);
                if (raw) return cropped;
                const outline = { left: bx.left - left, top: bx.top - top, width: bx.right - bx.left, height: bx.bottom - bx.top };
                const color = await pickAccentColorForTarget(cropped, { left: outline.left * dpr, top: outline.top * dpr, width: outline.width * dpr, height: outline.height * dpr });
                return annotate(cropped, [{ rect: outline, color, label: "container" }], dpr);
            }

            let el = target;
            if (typeof target === "string") {
                el = queryAll(target)[index];   // Nth match (queryAll adds :contains support)
                if (!el) throw new Error(`No element matches "${target}"${index ? ` at index ${index}` : ""}.`);
            }
            if (!(el instanceof Element)) throw new Error("ml.screenshot needs a CSS selector, an Element, or nothing.");
            if (scroll) {
                el.scrollIntoView({ block: "center", inline: "center" });
                // Let the scroll paint before we capture.
                await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            }
            const rect = el.getBoundingClientRect();
            // A zero- or sliver-sized element (e.g. a 1px-tall spacer/rule, or a
            // collapsed container) crops to a degenerate 1px-by-N image the vision
            // model just hallucinates over. Reject it with an actionable message
            // rather than sending the sliver off (roadmap #10).
            if (rect.width < MIN_SHOT_PX || rect.height < MIN_SHOT_PX) {
                throw new Error(
                    `element is ${Math.round(rect.width)}×${Math.round(rect.height)}px — too small to ` +
                    `screenshot (hidden, collapsed, or a 1px spacer?). Target a parent container with real size.`
                );
            }
            return cropDataUrl(await viewport(), rect, window.devicePixelRatio || 1);
        },
        /**
         * The crop transform of a raw ml.screenshot({ raw:true }) of `target`: the crop's viewport
         * top-left (CSS px) + the dpr it was captured at. So a python_exec coordinate — computed in
         * the returned image's PIXELS — can be projected back to the viewport for a clickable @pt/@box
         * (projectShotPoint/Box). Mirrors screenshot's raw crop rects: @pt → a PT_LOOK_RADIUS/`margin`
         * box; @box → the box (pad 0); a selector/Element → its bounding rect. Call AFTER the shot so a
         * scrolled-into-view element's rect is settled.
         *
         * @returns {ShotBox|null} null if the target doesn't resolve.
         */
        _shotBox: function(target: string | Element, margin = 0): ShotBox | null {
            const dpr = window.devicePixelRatio || 1;
            if (typeof target === "string" && POINT_RE.test(target.trim())) {
                const pt = resolvePoint(target); if (!pt) return null;
                const R = margin > 0 ? margin : PT_LOOK_RADIUS;
                return { left: Math.max(0, pt.x - R), top: Math.max(0, pt.y - R), dpr };
            }
            if (typeof target === "string" && BOX_RE.test(target.trim())) {
                const bx = resolveBox(target); if (!bx) return null;
                return { left: Math.max(0, bx.left), top: Math.max(0, bx.top), dpr };   // raw: pad 0
            }
            const el = typeof target === "string" ? queryAll(target)[0] : target;
            if (!(el instanceof Element)) return null;
            const r = el.getBoundingClientRect();
            return { left: r.left, top: r.top, dpr };
        },
        /**
         * Scroll the page in viewport-height steps, capture each, and stitch them
         * vertically into one tall PNG data URL. Browser-only (canvas). Paces
         * captures to respect captureVisibleTab's 2/sec limit, with backoff retries.
         *
         * @param {Function} capture The capture function that returns a viewport screenshot.
         * @returns {Promise<string>} The stitched full-page screenshot as a PNG data URL.
         */
        _stitchFullPage: async function(capture: () => Promise<string>): Promise<string> {
            const dpr = window.devicePixelRatio || 1;
            const vh = window.innerHeight;
            // Cap at ~8 screens so the image stays sane
            const total = Math.min(document.documentElement.scrollHeight, vh * 8);
            const startY = window.scrollY;
            const shots: { y: number; url: string }[] = [];
            const paint = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

            // Detect PINNED overlays (position:fixed, or a currently-STUCK sticky) so we can stop
            // them being stamped into every tile: a fixed nav bar / footer is on screen in every
            // viewport, so a naive scroll+stitch repeats it down the whole image. We probe each
            // candidate's viewport rect at two scroll positions — an invariant top ⇒ pinned
            // (classifyOverlay) — and later show it on exactly ONE tile (a top header on the first,
            // a bottom footer on the last), hiding it on the rest so the content behind shows
            // through. Skipped for a single-viewport page (nothing can repeat). getComputedStyle
            // over the DOM is a one-time cost, negligible beside the paced 600ms/tile captures.
            const overlays: { el: HTMLElement; anchor: "top" | "bottom"; vis: string }[] = [];
            if (total > vh) {
                const cands = ([...document.querySelectorAll("*")] as HTMLElement[])
                    .filter(el => { const p = getComputedStyle(el).position; return p === "fixed" || p === "sticky"; });
                window.scrollTo(0, 0); await paint();
                const r0 = cands.map(el => el.getBoundingClientRect());
                window.scrollTo(0, Math.min(vh, Math.max(1, total - vh))); await paint();
                cands.forEach((el, i) => {
                    const c = classifyOverlay(r0[i], el.getBoundingClientRect(), vh);
                    if (c.pinned) overlays.push({ el, anchor: c.anchor, vis: el.style.visibility });
                });
            }

            try {
                for (let y = 0; y < total; y += vh) {
                    window.scrollTo(0, y);
                    // Wait for the browser to actually paint the new scroll position
                    await paint();
                    // Record where we ACTUALLY landed, not where we asked to go: scrollTo clamps at the
                    // page's max scroll, so the last step captures the bottom viewport (which overlaps the
                    // previous tile) but at a SMALLER offset than `y`. Drawing at the requested `y` painted
                    // that overlap band twice — the duplicated "Ridiculous mode"/torn-row seam. Drawing at
                    // the real scrollY makes the clamped tile overwrite the overlap with identical pixels.
                    const actualY = window.scrollY;
                    const isLast = actualY + vh >= total;
                    // Show each pinned overlay on ONLY its home tile (header→first, footer→last), hidden
                    // elsewhere. Drawn at actualY, the header lands at y≈0 and the footer at ≈page-bottom —
                    // each appearing exactly once instead of on every tile.
                    for (const o of overlays) o.el.style.visibility = (o.anchor === "top" ? y === 0 : isLast) ? o.vis : "hidden";

                    let url: string | null = null;
                    let retries = 3;

                    while (retries > 0 && !url) {
                        try {
                            // 600ms ensures we strictly stay under the 2 calls/sec limit
                            await new Promise(r => setTimeout(r, 600));
                            url = await capture();
                        } catch (e) {
                            // If we still hit the quota, back off for a full second and retry
                            if ((e as Error).message && (e as Error).message.includes("MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND")) {
                                console.warn(`Hit Chrome capture limit at scroll ${y}, backing off...`);
                                await new Promise(r => setTimeout(r, 1000));
                                retries--;
                            } else {
                                throw e; // Unrelated error, fail fast
                            }
                        }
                    }

                    if (!url) throw new Error("Failed to capture after retries due to quota limits.");
                    shots.push({ y: actualY, url });
                    // A clamped step reached the bottom — further steps would re-capture the same tile.
                    if (isLast) break;
                }
            } finally {
                // Restore every overlay's visibility (even on a capture throw) and the scroll position.
                for (const o of overlays) o.el.style.visibility = o.vis;
                window.scrollTo(0, startY);
            }

            return new Promise((resolve, reject) => {
                if (!shots.length) return reject(new Error("nothing captured"));
                const imgs: HTMLImageElement[] = [];
                let loaded = 0;
                const done = () => {
                    const canvas = document.createElement("canvas");
                    canvas.width = imgs[0].naturalWidth;
                    canvas.height = Math.round(total * dpr);
                    const ctx = canvas.getContext("2d")!;
                    shots.forEach((s, i) => ctx.drawImage(imgs[i], 0, Math.round(s.y * dpr)));
                    resolve(canvas.toDataURL("image/png"));
                };
                shots.forEach((s, i) => {
                    const img = new Image();
                    img.onload = () => { imgs[i] = img; if (++loaded === shots.length) done(); };
                    img.onerror = () => reject(new Error("failed to load a capture"));
                    img.src = s.url;
                });
            });
        },
        /**
         * Build a "look" agent tool: it screenshots an element and returns a
         * vision-model *description* as text, so a text-only reasoning agent can
         * still "see" (icons, badges, greyed-out/sponsored styling, layout). Not
         * in ml.domTools by default because it needs a vision model and a capture
         * round-trip — opt in by composing it:
         *
         * ```js
         *   ml.agent(task, { extraTools: [ml.lookTool({ model: "qwen2.5vl" })] })
         *```
         *
         * @param {Object} [options] Options object.
         * @param {string} [options.model=null] Vision model for the description (null = the saved default).
         * @param {number} [options.maxTokens=512] Hard cap on the description length.
         * @returns {MlTool} A tool with `name: "look"` and `capabilities: ["vision"]`.
         */
        lookTool: function(opts: { model?: string | null; maxTokens?: number } = {}): MlTool {
            return buildLookTool(this, opts);
        },
        /**
         * Build a delegated Set-of-Marks `locate` tool (see builtin-tools/som): find
         * an element by describing it, via a vision sub-call over a badged screenshot.
         * Auto-wired into ml.agent alongside `look` when a vision model resolves.
         *
         * @param {Object} [opts]
         * @param {string} [opts.model=null] Vision model that reads the badges.
         * @param {number} [opts.maxTokens=64] Cap on the sub-call (it returns a number).
         * @returns {MlTool} A tool with `name: "locate"` and `capabilities: ["vision"]`.
         */
        locateTool: function(opts: { model?: string | null; groundingModel?: string | null; groundingRange?: number; maxTokens?: number } = {}): MlTool {
            return buildLocateTool(this, opts);
        },
        /**
         * Build a "click" interaction tool: click a link/button/tab/result.
         * Navigation, form submit, expand/collapse — irreversible, hence gated.
         * Interaction tools that DRIVE the page (real side effects), so they are
         * `requiresApproval` and deliberately NOT in the default read-only domTools —
         * opt in per task, gated by the approval flow:
         *
         * ```js
         *   ml.agent(task, { extraTools: [ml.clickTool(), ml.typeTool()] })
         * ```
         *
         * @returns {MlTool} A tool with `name: "click"` and `requiresApproval: true`.
         */
        clickTool: function(): MlTool {
            return buildClickTool(this);
        },
        /**
         * Build a "type" interaction tool: type text into an input/textarea/contenteditable (e.g. a search
         * box), firing input/change so the page's JS reacts. Side-effecting (it can
         * trigger live search / autosave), so gated + opt-in like click. `submit`
         * presses Enter afterwards, so "search for X" is one call without eval.
         *
         * @returns {MlTool} A tool with `name: "type"` and `requiresApproval: true`.
         */
        typeTool: function(): MlTool {
            return buildTypeTool(this);
        },
        /**
         * Run a sandboxed Python snippet (Pyodide/WASM in an offscreen doc) with numpy +
         * Pillow — for pixel/array/spatial work Python does better than JS. `image` (a CSS
         * selector, an `@pt:`/`@box:` token, or an Element) is screenshotted and injected as
         * `img` (PIL.Image) + `img_np` (H×W×3 uint8). The sandbox has NO network/filesystem/
         * DOM access. Needs the bundled Pyodide (`npm i` + `npm run fetch-pyodide`).
         *
         * @param {string} code Python. Reference `img`/`img_np`; `return` a value, or a base64
         *   image via `to_base64(...)`. `print()` output is captured as `stdout`.
         * @param {Object} [opts]
         * @param {string|Element} [opts.image] What to screenshot into the sandbox (omit for none).
         * @param {"readonly"|"full"} [opts.mode] `"readonly"` (default) hardens the sandbox — no
         *   network, no JS/extension scope — so it's a pure function over the injected data;
         *   `"full"` leaves those bridges intact (network etc.), and the agent tool always asks
         *   for approval before a full-mode run.
         * @param {number} [opts.margin] For an `@pt` image: the crop radius (px) around the point.
         *   Defaults to the look-radius. Ignored for `@box`/selectors.
         * @param {string|Element|Object} [opts.tables] Spreadsheet/table data to load as pandas
         *   DataFrame(s). A single source (a CSS selector for a page table, a Google Sheets URL, or
         *   `"current"`) → loaded as `df`; a map `{ name: source }` → loaded under those variable
         *   names (so you can join them). A Sheets URL is fetched with the user's Google login; an
         *   external one requires approval. Each arrives ALREADY parsed — reference it, don't re-load it.
         * @returns {Promise<{ ok, value?, stdout, error?, inputImage?, inputTables? }>}
         *   `inputImage`/`inputTables` are what the sandbox saw (for the debug render).
         */
        pythonExec: async function(code: string, { image = null, mode = "readonly", margin = 0, tableRaw = false, tables = null }: { image?: string | Element | null; mode?: "readonly" | "full"; margin?: number; tableRaw?: boolean; tables?: string | Element | Record<string, string | Element> | null } = {}): Promise<{ ok: boolean; value?: unknown; stdout: string; error?: string; inputImage?: string; inputTables?: TablePreview[]; imageBox?: ShotBox }> {
            // raw: the sandbox must see the container's/point's actual pixels — NOT the
            // look-verify overlay (the drawn @box outline / @pt marker) or its padding.
            // `margin` sets the crop radius around an @pt (default: the look-radius).
            const img = image != null ? await this.screenshot(image as string | Element, { raw: true, margin }) : null;
            // The image's crop transform (viewport top-left + dpr), so a cast:'pt'/'box' can project
            // the sandbox's IMAGE-pixel coordinate back to the viewport (else @pt/@box click off-target
            // on a dpr>1 display / an offset element). Computed AFTER the shot (post scroll-into-view).
            const imageBox = image != null ? this._shotBox(image as string | Element, margin) : null;
            // `tables` is a single source (→ `df`) OR a map { name: source }. Normalize to an ordered
            // [name, src] list; every source auto-dispatches by shape (a Sheets URL / 'current' →
            // sheet, else a DOM selector/Element) so one call can join a page table and a sheet.
            const specs: { name: string; src: string | Element }[] = [];
            if (tables != null) {
                if (typeof tables === "string" || (typeof Element !== "undefined" && tables instanceof Element)) specs.push({ name: "df", src: tables as string | Element });
                else for (const [name, src] of Object.entries(tables)) {
                    const nameErr = pyVarNameError(name);
                    if (nameErr) throw new Error(`pythonExec tables: ${nameErr}`);
                    specs.push({ name, src });
                }
            }
            const loaded: LoadedTable[] = [];
            for (const spec of specs) loaded.push(await this._loadTable(spec.name, spec.src, tableRaw));

            const r = await makeBackgroundTaskPromise("PYTHON_EXEC_REQUEST", "PYTHON_EXEC_RESPONSE",
                { code, image: img, hardened: mode !== "full", tables: loaded.map(l => ({ name: l.name, data: l.data })) }) as { ok: boolean; value?: unknown; stdout: string; error?: string; table?: { columns: string[]; rows: (string | number | null)[][] } };
            const extra: { inputImage?: string; inputTables?: TablePreview[]; imageBox?: ShotBox; resultTable?: { columns: string[]; rows: (string | number | null)[][] } } = {};
            if (img) extra.inputImage = img;
            if (imageBox) extra.imageBox = imageBox;   // for cast:'pt'/'box' → project image px → viewport
            if (r.table) extra.resultTable = r.table;   // a returned DataFrame → the UI renders a real table
            if (loaded.length) extra.inputTables = loaded.map(l => ({
                name: l.name, source: l.source,
                ...(l.data.kind === "rows" ? { columns: l.data.columns, rows: l.data.rows } : { html: true }),
            }));
            return Object.keys(extra).length ? { ...r, ...extra } : r;
        },
        /**
         * Resolve ONE `tables` source to a loaded DataFrame spec `{ name, source, data }`, dispatching
         * by the value's shape: `'current'` or a Google Sheets URL → fetch its CSV; anything else →
         * a DOM selector/Element (a page table). `source` carries the provenance for the debug
         * render's label + tooltip. Page-side; async (sheets go through the background fetch).
         */
        _loadTable: async function(name: string, src: string | Element, raw = false): Promise<LoadedTable> {
            const isCurrent = src === "current";
            if (isCurrent || (typeof src === "string" && googleSheetCsvUrl(src))) {
                const target = isCurrent ? (typeof location !== "undefined" ? location.href : "") : String(src);
                const csvUrl = googleSheetCsvUrl(target);
                if (!csvUrl) {
                    // `current` on a NON-sheet page → the page's single non-empty <table> (the shorthand
                    // the tool only advertises when there's exactly one). 0 or >1 → say so, steer to a selector.
                    if (isCurrent) {
                        const tables = typeof document !== "undefined" ? nonEmptyTables(document) : [];
                        if (tables.length === 1) {
                            const data = this._resolveTable(tables[0], raw);
                            return { name, source: { kind: "dom", label: "current page table" }, data };
                        }
                        throw new Error(tables.length === 0
                            ? "pythonExec tables:'current' — this page is neither a Google Sheet nor has a table with data. Pass a CSS selector."
                            : `pythonExec tables:'current' — this page has ${tables.length} tables (ambiguous). Pass a CSS selector to pick one.`);
                    }
                    throw new Error(`pythonExec — "${String(src)}" isn't a Google Sheets URL.`);
                }
                const { csv, name: sheetName } = await makeBackgroundTaskPromise<{ csv: string; name: string | null }>("FETCH_SHEET_REQUEST", "FETCH_SHEET_RESPONSE", { url: csvUrl });
                const all = parseCsv(csv), columns = all[0] || [], dataRows = all.slice(1);
                const source: TableSource = isCurrent
                    ? { kind: "sheet-current", label: (typeof document !== "undefined" && document.title) ? document.title : "current sheet" }
                    : { kind: "sheet-external", label: googleSheetId(String(src)) || String(src), name: sheetName };   // label = id (for the link), name = the real title (chip)
                return { name, source, data: { kind: "rows", columns, rows: raw ? dataRows : castTableColumns(columns, dataRows) } };
            }
            const data = this._resolveTable(src, raw);
            return { name, source: { kind: "dom", label: typeof src === "string" ? src : elPath(src) }, data };
        },
        /**
         * Resolve a `table` target (selector/Element) to what the sandbox loads as `df`:
         * a structured `{ kind:"rows", columns, rows }` from a clean table/ARIA grid (numeric
         * columns cast page-side so pandas infers numbers, unless `raw`), else `{ kind:"html",
         * html }` (the element's outerHTML) for `pd.read_html`. Page-side.
         */
        _resolveTable: function(target: string | Element, raw = false): { kind: "rows"; columns: string[]; rows: (string | number | null)[][] } | { kind: "html"; html: string } {
            const el = typeof target === "string" ? queryAll(target)[0] : target;
            if (!(el instanceof Element)) throw new Error(`ml.pythonExec: no table element matches "${String(target)}".`);
            const t = extractTable(el);
            if (!t) {
                // extractTable couldn't parse it (spans/nested/non-table) → the pd.read_html fallback
                // over outerHTML. That only works if a NON-EMPTY <table> is actually present, so guard
                // the two ways it isn't — a collapsed/lazily-rendered table (the node exists, its rows
                // don't) is the common trigger — with an actionable message, instead of the obscure
                // pandas ValueError it becomes downstream ("No tables found matching pattern '.+'").
                const label = typeof target === "string" ? target : elPath(el);
                const tbl = el.matches("table") ? el : el.querySelector("table");
                if (!tbl) {
                    // No <table> to read_html. An ARIA grid extractTable couldn't parse gets its own
                    // message (read_html can't help it — it has no <table> tag by construction).
                    if (el.matches("[role=table], [role=grid], [role=treegrid]") || el.querySelector("[role=table], [role=grid], [role=treegrid]"))
                        throw new Error(`ml.pythonExec: "${label}" is an ARIA grid python_exec couldn't parse — it may be empty, virtualized, or missing role=row/cell markup. Reveal/scroll its rows into view, or target a clean <table>.`);
                    throw new Error(`ml.pythonExec: "${label}" matched a <${el.tagName.toLowerCase()}> with no <table> inside — python_exec needs a <table> or a clean ARIA grid.`);
                }
                if (!tbl.querySelector("tr") || !(tbl.textContent || "").trim()) throw new Error(`ml.pythonExec: "${label}" matched an EMPTY table (no rows) — it may be collapsed or lazily rendered. Reveal it first (scroll it into view / click a "show"/"load" control), then retry.`);
                return { kind: "html", html: el.outerHTML };
            }
            return { kind: "rows", columns: t.columns, rows: raw ? t.rows : castTableColumns(t.columns, t.rows) };
        },
        /**
         * Agent tool wrapping {@link module:ml.pythonExec} — sandboxed Python (numpy/Pillow)
         * for pixel/array work. Opt-in like clickTool; `requiresApproval` (arbitrary code). A
         * returned `[x,y]`/`{x,y}` becomes a clickable `@pt`, a box an `@box`, a base64 image is
         * shown — the same coordinate currency as locate.
         *
         * @returns {MlTool} A tool with `name: "python_exec"` and `requiresApproval: true`.
         */
        pythonTool: function(): MlTool {
            return buildPythonTool(this);
        },
        /**
         * Pick a vision model for the auto-registered `look` tool (see ml.agent's `vision` option).
         * Returns a model id the agent can see with, or null. `agentModel` is the agent's own model
         * (opts.model, or null = the saved default). A string `vision` forces that model; otherwise
         * probe the agent's model, then the configured OCR model, accepting only a POSITIVE Ollama
         * vision capability — unknown/null (cloud/non-Ollama) must NOT qualify, or we'd send image
         * tokens to a text-only model. The caps probe is cached per service-worker lifetime in the
         * background worker.
         *
         * @param {string|null} agentModel The agent's model (or null for default).
         * @param {string|boolean|null} [vision] Vision option from ml.agent options.
         * @returns {Promise<string|null>} A vision-capable model id, or null.
         */
        _resolveVisionModel: async function(agentModel: string | null, vision: boolean | string | null): Promise<string | null> {
            if (typeof vision === "string" && vision) return vision;   // forced delegated model
            let cfg: MlPublicConfig | null;
            try { cfg = await this.config(); } catch (e) { cfg = null; }
            const primary = agentModel || (cfg && cfg.model);
            if (vision === true) return primary || null;   // forced NATIVE → the agent's own model (no probe)
            if (await this._modelSees(primary)) return primary;
            const ocr = cfg && cfg.ocrModel;
            if (ocr && ocr !== primary && await this._modelSees(ocr)) return ocr;
            return null;
        },
        /**
         * True only when `model` POSITIVELY reports vision capability.
         * Unknown/null (cloud, non-Ollama, unreachable) is false — never send image
         * tokens to a model we can't confirm sees. Caps are cached in the worker.
         *
         * @param {string|null} model The model id to check.
         * @returns {Promise<boolean>} True if the model has vision capability.
         */
        _modelSees: async function(model: string | null): Promise<boolean> {
            if (!model) return false;
            let caps: string[] | null;
            try { caps = await this.capabilities(model); } catch (e) { return false; }
            return Array.isArray(caps) && caps.includes("vision");
        },
        /**
         * Build a capture-only `look` tool for a vision-capable AGENT model.
         * It screenshots and hands the raw image back to ml.agent, which injects it
         * into the model's OWN history so it reasons over the real pixels (vs the
         * delegated lookTool, which returns a second model's text description).
         *
         * @returns {MlTool} A tool with `name: "look"`, `capabilities: ["vision"]`, returning
         *   `{ content, image, imageLabel, elements }` for inline vision.
         */
        _nativeLookTool: function(): MlTool {
            const ml = this;
            return ml.defineTool({
                name: "look",
                capabilities: ["vision"],
                description: "See the page with your OWN eyes — this screenshots the page (or an element) " +
                    "and shows YOU the image directly. Call with NO selector to see the viewport and ORIENT " +
                    "when a task is vague; pass a selector to inspect one element (icons, badges, whether " +
                    "something looks sponsored / greyed-out / out of stock); pass scope:'page' (no selector) " +
                    "to see the whole page stitched into one tall image (DOWNSCALED — use it for layout, not " +
                    "small text). To CLASSIFY items in a grid/list (which show a cat?), pass the item selector " +
                    "and iterate `index` (0,1,2,…) for a tight crop of each. After looking, DESCRIBE what you " +
                    "see, then take the next action.",
                parameters: {
                    type: "object",
                    properties: {
                        selector: { type: "string", description: "CSS selector of an element; omit to see the page." },
                        scope: { type: "string", enum: ["viewport", "page"], description: "'viewport' (default), or 'page' to scroll+stitch the full page (only when no selector)." },
                        index: { type: "integer", description: "Which match of the selector to look at (0-based); iterate a grid with 0,1,2,…" },
                        margin: { type: "number", description: "For an @pt: token only — the crop RADIUS in px around the point (bigger = more context). Ignored for CSS selectors." }
                    }
                },
                // In: the target as a hoverable ref (hover → outline it on the page). No selector → raw args.
                render: (_input, args) => targetRender(args),
                run: async ({ selector, scope, index, margin }: { selector?: string; scope?: "viewport" | "page"; index?: number; margin?: number } = {}): Promise<string | ToolResult> => {
                    const fullPage = scope === "page" && !selector;
                    let shot;
                    try { shot = await ml.screenshot(selector || null, { fullPage, index: index || 0, margin: typeof margin === "number" ? margin : 0 }); }
                    catch (e) { return `Error: ${errText(e)}`; }
                    const label = selector
                        ? `element "${selector}"${index ? ` #${index}` : ""}`
                        : (fullPage ? "full page" : "viewport");
                    // @pt verify shot → disclose the snap-around-point recovery, @pt-only: the
                    // driver can see here whether the mark grazes a target it can otherwise see.
                    const isPoint = !!selector && POINT_RE.test((selector as string).trim());
                    const pointTip = isPoint
                        ? `\n\n(Verify before clicking. If the target IS visible in this crop but the mark isn't on it, re-locate just this area to snap onto it: locate({ selector: "${selector}", strategy: "grounding", description: "…" }) — searches only this box (add margin: 40–120 if the target is partly cut off at the edge). If the target ISN'T in this crop at all, it's the wrong spot: change region/description, don't re-verify here.)`
                        : "";
                    // Hand the screenshotted element back on the elements side-channel
                    // so it's hoverable in `logDebug`/`onStep` (never sent to the model).
                    // Guarded: a bad/stub-DOM selector just yields no node.
                    let elements;
                    if (selector) { try { const el = queryAll(selector)[index || 0]; if (el) elements = [el]; } catch {} }
                    return {
                        content: `Screenshot of the ${label} captured — shown to you in the next message.${pointTip}`,
                        image: shot,
                        imageLabel: label,
                        elements
                    };
                }
            });
        },
        // The built-in ml.agent({ logDebug: true }) tracer; pass as onStep too.
        _logStep: logStep,
        // Design A tool delegation (run-delegation.ts): register an agent run's live toolset page-side
        // so the background loop can run its tools via RUN_TOOL_IN_PAGE. ml.agent's START_RUN shim
        // will call these; exposed under `_` so the transport is unit-testable (tests/delegation.test.js).
        _registerRun: function(runId: string, tools: MlTool[]): void { registerRun(runId, tools); },
        _endRun: function(runId: string): void { endRun(runId); },
        // Internal DOM helpers used by the agent tools, exposed under `_` (as
        // with _parseJSON below) so tests and console debugging can reach them.
        _truncate: truncate,
        _suspiciousChars: suspiciousChars,
        _renderArgs: renderArgs,
        _elPath: elPath,
        _describeSkeleton: describeSkeleton,
        _queryAll: queryAll,
        _selectorError: selectorError,
        // Parses a structured-output reply, tolerating a stray ```json fence
        // and surfacing the raw text on failure for debugging.
        /**
         * Parse a structured-output reply, tolerating a stray ```json fence
         * and surfacing the raw text on failure for debugging.
         *
         * @param {string} text The JSON text to parse.
         * @returns {Object} The parsed JSON object.
         * @throws {Error} If the text is not valid JSON.
         */
        _parseJSON: function(text: string): unknown {
            const stripped = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
            try {
                return JSON.parse(stripped);
            } catch (err) {
                throw new Error(
                    `schema was set but the reply wasn't valid JSON (${(err as Error).message}). ` +
                    `Got: ${text.slice(0, 200)}`
                );
            }
        },
        /**
         * Convert an image to a data URL.
         * Accepts a URL string or <img> element, returns "data:image/...;base64,...".
         * Handles data URIs (passed through), blob URIs (read via FileReader),
         * and external URLs (delegated to background for CORS).
         *
         * @param {string|HTMLImageElement} image A URL string or <img> element.
         * @returns {Promise<string>} The image as a data URL.
         */
        _imageToDataUrl: async function(image: string | HTMLImageElement): Promise<string> {
            let url = "";

            if (typeof image === "string") {
                url = image;
            } else if (image instanceof HTMLImageElement) {
                url = image.currentSrc || image.src;
            } else {
                throw new Error("Image must be a URL string or <img> element!");
            }

            // Case A: Data URI (Already Base64)
            // e.g. "data:image/png;base64,iVBOR..."
            if (url.startsWith("data:")) {
                return url;
            }

            // Case B: Blob URI (Local Memory)
            // e.g. "blob:https://example.com/..."
            // The Background Script CANNOT fetch these (they exist only in the Tab).
            // We must fetch them here in the Main World.
            if (url.startsWith("blob:")) {
                return new Promise((resolve, reject) => {
                    fetch(url)
                        .then(r => r.blob())
                        .then(blob => {
                            const reader = new FileReader();
                            reader.onloadend = () => resolve(reader.result as string);
                            reader.readAsDataURL(blob);
                        })
                        .catch(e => reject("Failed to read Blob: " + (e as Error).message));
                });
            }

            // Case C: Standard HTTP/HTTPS (External Images)
            // The Page Context will likely fail (CORS).
            // The Background Script will SUCCEED (Extension Permissions).
            // We delegate the fetch to the background.
            return this._fetchImageBase64(url);
        },
        /**
         * Fetch an external image as base64 via the background worker (for CORS).
         *
         * @param {string} url The image URL to fetch.
         * @returns {Promise<string>} The image as a base64 data URL.
         */
        _fetchImageBase64: async function(url: string): Promise<string> {
            return makeBackgroundTaskPromise(
                "B64_REQUEST",
                "B64_RESPONSE",
                { "url": url }
            );
        },
        /**
         * Get available model ids on the server.
         *
         * @returns {Promise<string[]>} Array of model ids.
         */
        models: async function(): Promise<string[]> {
            return makeBackgroundTaskPromise("LIST_MODELS_REQUEST", "LIST_MODELS_RESPONSE", {});
        },
        /**
         * Get capability list for a model, read from Ollama's /api/show.
         * Returns e.g. ["completion", "tools", "vision", "thinking"]. Handy for feature
         * gating (e.g. only offer server-side tools on a tool-capable model).
         * Returns null when it can't be determined (cloud/non-Ollama model, old
         * Ollama, unreachable) — treat null as "unknown", never as "no".
         *
         * @param {string} [model=null] The model id (omitted = saved default).
         * @returns {Promise<string[]|null>} Array of capabilities, or null if undeterminable.
         */
        capabilities: async function(model: string | null = null): Promise<string[] | null> {
            return makeBackgroundTaskPromise("CAPS_REQUEST", "CAPS_RESPONSE", { "model": model });
        },
        /**
         * Get the saved default model.
         *
         * @returns {Promise<string|null>} The model id.
         */
        getModel: async function(): Promise<string | null> {
            return makeBackgroundTaskPromise("GET_MODEL_REQUEST", "GET_MODEL_RESPONSE", {});
        },
        /**
         * Get the non-secret saved config the page is allowed to read:
         * { model, ocrModel, apiFormat }. The server URL and API key are never
         * exposed to the page (see the security invariants in CLAUDE.md).
         * ml.agent uses this to auto-wire a vision tool from the OCR model.
         *
         * @returns {Promise<{model: string, ocrModel: string, apiFormat: string}>} The config object.
         */
        config: async function(): Promise<MlPublicConfig> {
            return makeBackgroundTaskPromise("CONFIG_REQUEST", "CONFIG_RESPONSE", {});
        },
        /**
         * Persistently switch the default model (validated against the server;
         * the settings popup picks it up automatically).
         *
         * @param {string} model The model id to set.
         * @returns {Promise<string>} The newly set model id.
         */
        setModel: async function(model: string): Promise<string> {
            return makeBackgroundTaskPromise("SET_MODEL_REQUEST", "SET_MODEL_RESPONSE", { "model": model });
        },
        /**
         * Get models currently loaded in VRAM.
         *
         * @returns {Promise<Array<{model: string, vramGB: number, expiresAt: number}>>} Array of loaded models.
         */
        ps: async function(): Promise<LoadedModel[]> {
            return makeBackgroundTaskPromise("PS_REQUEST", "PS_RESPONSE", {});
        },
        /**
         * Evict a model from VRAM (keep_alive: 0).
         * No argument = evict all. Returns the list of models that were told to unload.
         *
         * @param {string} [model] The model id to evict; omitted = evict all.
         * @returns {Promise<string[]>} The unloaded models.
         */
        unload: async function(model: string | null = null): Promise<string[]> {
            return makeBackgroundTaskPromise("UNLOAD_REQUEST", "UNLOAD_RESPONSE", { "model": model });
        },
        /**
         * Chat and log the response to the console.
         *
         * @param {string} prompt The user prompt.
         * @param {Object} [options] Chat options.
         */
        logChat: async function(prompt: string, options: ChatOptions): Promise<void> {
            const response = await this.chat(prompt, options);
            console.log(response);
        },
        /**
         * Chat with a "short and concise" modifier and log the response.
         *
         * @param {string} prompt The user prompt.
         * @param {Object} [options] Chat options.
         */
        logChatShort: async function(prompt: string, options: ChatOptions): Promise<void> {
            const response = await this.chatShort(prompt, options);
            console.log(response);
        },
    };

    // ---- Default agent tool registry (ml.domTools) ----
    // Generic, page-agnostic DOM introspection + escape-hatch tools; defined in
    // tools.ts. Pass this array (or a superset — `[...ml.domTools, myTool]`) to
    // ml.agent. defineTool is detached (this-free), so pass it directly.
    window.ml.domTools = makeDomTools(window.ml.defineTool);

    // listen for the background loop's delegated tool-run requests (relayed by content.ts
    // as PAGE_TOOL_RUN). A no-op until an agent run registers a toolset via _registerRun.
    installToolDelegation();

    // Sidebar hover-highlight for @pt/@box: the shell (a content script) can't read this main-world
    // point/box registry, so it asks us to resolve a token to viewport coords, then draws the overlay
    // itself (in its shadow root — no page mutation). `seq` echoes back so a stale hover is ignored.
    window.addEventListener("message", (e: MessageEvent) => {
        if (e.source !== window || !e.data || e.data.type !== "ML_HL_RESOLVE") return;
        // A CSS/custom SELECTOR the shell couldn't resolve natively (ml's :contains/:has-text/:eq that
        // document.querySelectorAll rejects) → resolve via queryAll and return the element's viewport box.
        if (typeof e.data.selector === "string") {
            let box: { left: number; top: number; right: number; bottom: number } | null = null;
            let label = "";
            try {
                const el = queryAll(e.data.selector)[e.data.index || 0];
                if (el) {
                    const r = el.getBoundingClientRect();
                    if (r.width || r.height) { box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; label = `${el.tagName.toLowerCase()} · ${Math.round(r.width)}×${Math.round(r.height)}`; }
                }
            } catch { /* still not resolvable — no box */ }
            window.postMessage({ type: "ML_HL_AT", seq: e.data.seq, point: null, box, label }, "*");
            return;
        }
        const token = String(e.data.token || "");
        const point = resolvePoint(token);
        const box = point ? null : resolveBox(token);
        window.postMessage({ type: "ML_HL_AT", seq: e.data.seq, point: point || null, box: box || null }, "*");
    });

    // Readiness signal for scripts (e.g. userscripts) that may run before this
    // one injects. Resolves immediately since window.ml is fully synchronous:
    //   const ml = await (window.ml?.ready
    //       ?? new Promise(r => addEventListener("ml:ready", () => r(window.ml), { once: true })));
    window.ml.ready = Promise.resolve(window.ml);
    window.dispatchEvent(new Event("ml:ready"));

    console.log("🟢 window.ml is ready.");
})();
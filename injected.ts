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
    MlHistory
} from "./contract";
import { evalReadonly } from "./readonly-exec";
import { truncate, errText, elPath, describeSkeleton, queryAll, selectorError } from "./dom";
import { AGENT_SYSTEM, VISION_CLAUSE, ANSWER_CLAUSE, WAIT_CLAUSE } from "./prompts";
import { pageContext, cropDataUrl, MIN_SHOT_PX } from "./util";
import { suspiciousArgsWarning, suspiciousChars } from "./security";
import { emitDebug, debugId, shortHash, sessionRegistry, enterAgentRun, exitAgentRun } from "./bus";
import { makeDomTools } from "./tools";
import { hideSidebarForShot, makeBackgroundTaskPromise, makeChatRequest, makeStreamingTaskPromise } from "./bridge";
import { validateArgs, validateExtend } from "./validate";
import { renderArgs, logStep, defaultApprove, normalizeApproval, formatReadonlyExec } from "./approval";
import { buildLookTool, buildLocateTool, buildClickTool, buildTypeTool } from "./builtin-tools";

(function() {


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
                chat: async function(this: MlHistory, prompt: string, { images = [], model = this.model, extend = this.extend, numCtx = this.numCtx, numGpu = this.numGpu, think = this.think, schema = this.schema, toolIds = this.toolIds, maxTokens = this.maxTokens, save = this.save, onToken }: {
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
                    let content, sources, resolvedModel, reasoning;
                    try {
                        ({ content, sources, model: resolvedModel, reasoning } = (typeof onToken === "function" && !schema)
                            ? await makeStreamingTaskPromise(requestPayload, onToken)
                            : await makeChatRequest(requestPayload));
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
                    emitDebug({ kind: "chat-result", id: debug, ts: Date.now(), save, session, content: reply, sources: (sources && sources.length) ? sources : null, structured: !!schema, model: resolvedModel || model || null, extend: extend || null, reasoning: reasoning || null });
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
        step: async function(messages: NeutralMessage[], { tools = [], model = null, think = null }: {
            tools?: unknown[];
            model?: string | null;
            think?: boolean | null;
        } = {}): Promise<{ content: string; tool_calls: ToolCall[] }> {
            return makeBackgroundTaskPromise(
                "LLM_REQUEST",
                "LLM_RESPONSE",
                { "messages": messages, "tools": tools, "model": model, "think": think, "raw": true }
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
        defineTool: function({ name, description = "", parameters = { type: "object", properties: {} }, run, requiresApproval = false, capabilities = [], render }: Partial<MlTool> = {}): MlTool {
            if (!name || typeof run !== "function") {
                throw new Error("ml.defineTool needs a name and a run(args) function");
            }
            return { name, description, parameters, run, requiresApproval, capabilities, render };
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
         * @param {MlTool[]} [opts.tools] Tool registry (default {@link module:ml.domTools}).
         * @param {MlTool[]} [opts.extraTools=[]] Extra tools appended to `tools`.
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
         *   unknown/cloud models never qualify). Pass `false` to disable, or a model
         *   id to force `look` onto that specific vision model. Skipped when the
         *   toolset already contains a vision-capable tool.
         * @param {(ev: {step: number, thought?: string, tool?: string, arguments?: Object, result?: string, elements?: Node[]}) => void} [opts.onStep]
         *   Live tracer: fires `{ step, thought }` with the model's reasoning
         *   (its prose before the calls) and `{ step, tool, arguments, result,
         *   elements? }` for each tool call —
         *   `elements` holds real DOM nodes when the tool provided them (log them to
         *   hover in devtools).
         * @param {boolean} [opts.logDebug=false] Install a built-in console tracer
         *   ({@link module:ml._logStep}) that logs each thought and tool call —
         *   the quickest way to watch a run. Composes with `onStep` (both fire).
         * @returns {Promise<{summary: string, steps: number, transcript: Array<{thought?: string, tool?: string, arguments?: Object, result?: string, elements?: Node[]}>, elements: Node[], hitCap?: boolean}>}
         *   `elements` is the live DOM node(s) the model designated via an
         *   `answer`-capable tool (empty for tasks that just act on the page).
         */
        agent: async function(task: string, { tools = null, extraTools = [], system = null, hints = null, maxSteps = 10, model = null, think = null, approve = defaultApprove, onStep = null, env = true, vision = null, logDebug = false }: {
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
        } = {}): Promise<AgentResult> {
            const toolset = [...(tools || this.domTools || []), ...extraTools];
            // Config, fetched once (used for vision resolution + the read-only exec
            // auto-approve fast-path below).
            const agentCfg = await this.config().catch(() => null);
            const autoRO = !!(agentCfg && (agentCfg as { autoApproveReadonly?: boolean }).autoApproveReadonly);
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
                    const forced = typeof vision === "string" && !!vision;
                    if (!forced && await this._modelSees(agentModel)) {
                        toolset.push(this._nativeLookTool());
                    } else {
                        toolset.push(this.lookTool({ model: visionModel }));
                    }
                    toolset.push(this.locateTool({ model: visionModel }));
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
            emitDebug({ kind: "agent", id: runHash, ts: Date.now(), save: false, session: { hash: runHash, turn: 0 }, task, model: model || null, maxSteps, config: {
                system: systemPrompt, customSystem: !!system,
                tools: toolset.map(t => ({ name: t.name, requiresApproval: !!t.requiresApproval, vision: !!(t.capabilities && t.capabilities.includes("vision")) })),
                maxSteps, think: (think === true || think === false) ? think : null, env, vision: vision ?? null, hints: hints || null,
            } });
            const emit = (event: { step: number; thought?: string; tool?: string; arguments?: Record<string, unknown>; result?: string; elements?: Node[]; render?: RenderDescriptor; argIssues?: string[]; approval?: "readonly" | "user" | "denied" }) => {
                if (logDebug) logStep(event);
                emitDebug({
                    kind: "agent-step", id: runHash, ts: Date.now(), save: false, session: { hash: runHash, turn: event.step },
                    step: event.step, thought: event.thought, tool: event.tool, arguments: event.arguments,
                    result: event.result, elements: event.elements ? event.elements.length : undefined, render: event.render,
                    argIssues: event.argIssues && event.argIssues.length ? event.argIssues : undefined,
                    approval: event.approval,
                });
                if (!onStep) return;
                try { onStep(event); } catch (e) { console.error("ml.agent onStep threw:", e); }
            };
            // A serializable render descriptor for a tool step: the tool's own
            // `render` (page-side, defensive) wins; else auto-derive image/elements
            // from the envelope; else undefined → the sidebar's default In:/Out:.
            const descriptorFor = (tool: MlTool | undefined, input: ToolRenderInput, args: Record<string, unknown>): RenderDescriptor | undefined => {
                if (input.render && input.render.type) return input.render;   // run() precomputed one (e.g. locate's marks)
                if (tool?.render) {
                    try { const d = tool.render(input, args); if (d && d.type) return d; }
                    catch (e) { console.error(`ml tool "${tool.name}" render threw:`, e); }
                }
                if (input.image) return { type: "image", src: input.image, label: input.imageLabel };
                if (input.elements?.length) return {
                    type: "elements",
                    items: input.elements.slice(0, 50).map((el: Node, i: number) => ({
                        path: (typeof Element !== "undefined" && el instanceof Element) ? elPath(el) : String(el.nodeName || "node"),
                        text: truncate((el as Element).textContent || "", 60), index: i,
                    })),
                };
                return undefined;
            };
            const finish = (r: AgentResult): AgentResult => {
                emitDebug({ kind: "agent-result", id: runHash, ts: Date.now(), save: false, session: { hash: runHash, turn: r.steps }, summary: r.summary, steps: r.steps, hitCap: !!r.hitCap });
                return r;
            };
            enterAgentRun();   // suppress orphan chat sessions from internal tool chats (see emitDebug); finally-decremented below
            try {
            for (let step = 1; step <= maxSteps; step++) {
                const msg = await this.step(messages, { tools: toolDefs, model, think });
                if (!msg.tool_calls || !msg.tool_calls.length) {
                    return finish({ summary: (msg.content || "").trim(), steps: step - 1, transcript, elements: answered });
                }
                // Surface the model's reasoning (its prose before the tool calls)
                // so callers can watch it think, not just navigate.
                const thought = (msg.content || "").trim();
                if (thought) {
                    transcript.push({ thought });
                    emit({ step, thought });
                }
                messages.push({ role: "assistant" as const, content: msg.content || "", tool_calls: msg.tool_calls });

                // Run a tool, unwrapping its { content, elements } envelope. A tool
                // may return a plain string, or { content, elements } to also hand
                // back real DOM nodes — routed to onStep/the transcript for hovering
                // in devtools, never to the model.
                const runTool = async (tool: MlTool, args: Record<string, unknown>) => {
                    // Check the model's args against the tool's schema (the same
                    // validateArgs that feeds the debug ⚠ strip) and surface it to the
                    // MODEL, not just the sidebar. A MISSING REQUIRED arg means the tool
                    // can't run usefully — e.g. click with no `selector` returns a
                    // baffling "No element matches undefined" — so short-circuit with the
                    // schema error, which says what to fix. Softer issues (an unknown/
                    // extra property, a bad enum, a type mismatch) don't block; the tool
                    // runs and we PREPEND the note, so a lenient validator never rejects a
                    // legitimate call.
                    const issues = validateArgs(tool.parameters, args);
                    if (issues.some(s => s.startsWith("missing required"))) {
                        // "Error:" so the sidebar's toolFailed marks the step failed (red
                        // dot), not a green "completed" — the tool never ran.
                        return { result: `Error: invalid arguments for "${tool.name}" — ${issues.join("; ")}. Call it again with the correct argument name(s).` };
                    }
                    // Soft issues APPEND (not prepend), so a real "Error:"/"Denied" prefix
                    // stays at position 0 where toolFailed can see it.
                    const note = issues.length ? `\n\n⚠ Argument schema issue(s): ${issues.join("; ")}` : "";
                    try {
                        const raw = await tool.run(args);
                        // A tool may also hand back { image, imageLabel } — a screenshot
                        // for #3 inline vision, injected into the model's own history.
                        if (raw && typeof raw === "object" && typeof raw.content === "string") {
                            return { result: raw.content + note, elements: raw.elements, image: raw.image, imageLabel: raw.imageLabel, render: raw.render };
                        }
                        return { result: String(raw) + note };
                    } catch (e) { return { result: `Error: ${errText(e)}` + note }; }
                };

                const pendingImages = [];   // #3: screenshots captured this turn, injected below
                for (const call of msg.tool_calls) {
                    const tool = byName[call.name];
                    let args = (call.arguments || {}) as Record<string, unknown>;
                    let result, elements, image, imageLabel, toolRender;
                    let approval: "readonly" | "user" | "denied" | undefined;
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
                                ({ result, elements, image, imageLabel, render: toolRender } = await runTool(tool, args));
                            }
                        }
                    } else {
                        ({ result, elements, image, imageLabel, render: toolRender } = await runTool(tool, args));
                    }
                    result = String(result);
                    const entry: AgentTranscriptEntry = { tool: call.name, arguments: args, result };
                    if (elements && elements.length) entry.elements = elements;
                    transcript.push(entry);
                    const render = descriptorFor(tool, { result, elements, image, imageLabel, render: toolRender }, args);
                    const argIssues = tool ? validateArgs(tool.parameters, args) : undefined;
                    emit({ step, ...entry, render, argIssues, approval });
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
         * @returns {Promise<string>} The screenshot as a PNG data URL.
         */
        screenshot: async function(target: string | Element | null = null, { scroll = true, fullPage = false, index = 0 }: { scroll?: boolean; fullPage?: boolean; index?: number } = {}): Promise<string> {
            // Hide the debug sidebar overlay (if mounted) for the shot, so it isn't
            // captured into the agent's `look`; restore after. No wait when the
            // sidebar is off (no #ml-sb-root) — it's a no-op then.
            const viewport = async (): Promise<string> => {
                await hideSidebarForShot();
                try { return await makeBackgroundTaskPromise<string>("CAPTURE_TAB_REQUEST", "CAPTURE_TAB_RESPONSE", {}); }
                finally { window.postMessage({ __mlSidebarShot: "show" }, "*"); }
            };
            if (target == null) return fullPage ? this._stitchFullPage(viewport) : viewport();

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

            for (let y = 0; y < total; y += vh) {
                window.scrollTo(0, y);
                // Wait for the browser to actually paint the new scroll position
                await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

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
                shots.push({ y, url });
            }
            window.scrollTo(0, startY);

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
        locateTool: function(opts: { model?: string | null; maxTokens?: number } = {}): MlTool {
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
            if (typeof vision === "string" && vision) return vision;   // forced
            let cfg: MlPublicConfig | null;
            try { cfg = await this.config(); } catch (e) { cfg = null; }
            const primary = agentModel || (cfg && cfg.model);
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
                        index: { type: "integer", description: "Which match of the selector to look at (0-based); iterate a grid with 0,1,2,…" }
                    }
                },
                run: async ({ selector, scope, index }: { selector?: string; scope?: "viewport" | "page"; index?: number } = {}): Promise<string | ToolResult> => {
                    const fullPage = scope === "page" && !selector;
                    let shot;
                    try { shot = await ml.screenshot(selector || null, { fullPage, index: index || 0 }); }
                    catch (e) { return `Error: ${errText(e)}`; }
                    const label = selector
                        ? `element "${selector}"${index ? ` #${index}` : ""}`
                        : (fullPage ? "full page" : "viewport");
                    // Hand the screenshotted element back on the elements side-channel
                    // so it's hoverable in `logDebug`/`onStep` (never sent to the model).
                    // Guarded: a bad/stub-DOM selector just yields no node.
                    let elements;
                    if (selector) { try { const el = queryAll(selector)[index || 0]; if (el) elements = [el]; } catch {} }
                    return {
                        content: `Screenshot of the ${label} captured — shown to you in the next message. Describe it, then continue.`,
                        image: shot,
                        imageLabel: label,
                        elements
                    };
                }
            });
        },
        // The built-in ml.agent({ logDebug: true }) tracer; pass as onStep too.
        _logStep: logStep,
        // Internal DOM helpers used by the agent tools, exposed under `_` (as
        // with _parseJSON below) so tests and console debugging can reach them.
        _truncate: truncate,
        _suspiciousChars: suspiciousChars,
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

    // Readiness signal for scripts (e.g. userscripts) that may run before this
    // one injects. Resolves immediately since window.ml is fully synchronous:
    //   const ml = await (window.ml?.ready
    //       ?? new Promise(r => addEventListener("ml:ready", () => r(window.ml), { once: true })));
    window.ml.ready = Promise.resolve(window.ml);
    window.dispatchEvent(new Event("ml:ready"));

    console.log("🟢 window.ml is ready.");
})();
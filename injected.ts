// This runs in the "Main World" (same as the page JS)

import type {
    MlPublicConfig,
    NeutralMessage,
    ToolResult,
    MlTool,
    ApprovalRequest,
    ApprovalDecision,
    AgentResult,
    AgentOptions,
    MlAgentHandle,
    MlApi,
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
    ToolFeedback,
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
import { truncate, errText, elPath, describeSkeleton, queryAll, selectorError, extractTable, castTableColumns, googleSheetCsvUrl, googleSheetId, externalSheetIds, parseCsv, nonEmptyTables, classifyOverlay, setPierceClosedShadow, viewportRect, isElement, navTarget, clipOut } from "./dom";
import { AGENT_SYSTEM, VISION_CLAUSE, ANSWER_CLAUSE, WAIT_CLAUSE, SHADOW_CLAUSE, SHADOW_CLOSED_NOTE, SHADOW_CLOSED_PIERCE_NOTE, SHADOW_EXEC_NOTE, IFRAME_CLAUSE, SELF_CLAUSE, HUD_HINT, HUD_PROSE_PROGRESS, HUD_PROSE_QUIET, PYTHON_CLAUSE, EXEC_COMPUTE_CLAUSE, EXEC_RANGE_CLAUSE, NAV_OFF_CLAUSE, UNATTENDED_CLAUSE, UNATTENDED_REFUSAL, UNATTENDED_EXEC_NOTE, UNATTENDED_PY_NOTE, askAboutTask } from "./prompts";
import { pageContext, cropDataUrl, MIN_SHOT_PX, POINT_RE, resolvePoint, markSeen, PT_LOOK_RADIUS, BOX_RE, resolveBox, agentState, mlRange } from "./util";
import type { ShotBox, ServerTool, VisionMemory, RebuildConfig, AnswerMedia } from "./contract";
import { annotate, pickAccentColorForTarget } from "./locate";
import { suspiciousArgsWarning, suspiciousChars } from "./security";
import { emitDebug, debugId, shortHash, sessionRegistry, agentRegistry, handleRegistry, enterAgentRun, exitAgentRun, resetSubcallUsage, subcallUsage } from "./bus";
import { makeDomTools } from "./tools";
import { hideSidebarForShot, makeBackgroundTaskPromise, makeChatRequest, makeStreamingTaskPromise } from "./bridge";
import { validateArgs, validateExtend } from "./validate";
import { renderArgs, logStep, defaultApprove, normalizeApproval, formatReadonlyExec } from "./approval";
import { buildLookTool, buildLocateTool, buildClickTool, buildTypeTool, buildPythonTool, targetRender, captureVerify, lookViews, BOX_OVER_TEXT_TIP, VIEWS_PARAM, legendFor } from "./builtin-tools";
import { pyVarNameError } from "./python-env";
import { autoApprovePython } from "./auto-approve";
import { executeTool, toolContext } from "./tool-exec";
import { runAgentLoop, shotTurnMessage } from "./agent-loop";
import type { AgentLoopDeps } from "./agent-loop";

/** The mutable state of ONE agent session, shared between ml.agent's page loop and (for a handle) the
 *  ml.createAgent handle that steers it. A plain ml.agent() call makes a throwaway one per call; a handle
 *  keeps its own so run()/say()/maxSteps span turns. Page-loop only — a background-hosted run's history
 *  lives in the service worker (see Phase 2). */
interface AgentControl {
    hash: string | null;          // the session hash (minted on the first turn, then stable)
    messages: NeutralMessage[];   // the live history — the source of truth; the loop mutates it in place
    inbox: { id: string; text: string }[];   // say()'d messages waiting to be injected at the next step boundary (id = "seen"-indicator key)
    maxSteps: number;             // the step cap, read live so a handle can raise it mid-run
    running: boolean;             // is a loop in flight?
    seqBase: number;              // monotonic step-seq base so seqs stay session-unique across turns
    stepBase: number;             // monotonic STEP base so turn groups stay distinct in the sidebar across turns
    bg?: boolean;                 // the CURRENT run routed to the background → a mid-run say() steers via INJECT_MESSAGE
}
import { installToolDelegation, registerRun, endRun } from "./run-delegation";
import { descriptorFor } from "./render-descriptor";

// Monotonic id per mid-run steer (a.say()), so the "seen" indicator can key an `agent-say-seen` event
// back to its `agent-say` bubble. Globally unique across handles/turns — a plain counter suffices.
let steerSeq = 0;
const nextSteerId = (): string => `sy_${++steerSeq}`;

/** Is a `navigate(url)` target SAME-ORIGIN as the current page? Cross-origin navs need consent (the gate);
 *  same-origin auto-approve. Reuses navTarget's origin logic; a bad URL counts as same-origin (the tool
 *  errors on it anyway, so no pointless prompt). Used by the page loop's autoApprove. */
const sameOriginNav = (url: string): boolean => {
    const t = navTarget(url, location.href, { allowCrossOrigin: true });
    return "error" in t ? true : !t.crossOrigin;
};

/** One resolved `python_exec` table source: its var name, provenance, and the payload the sandbox
 *  builds a DataFrame from (rows or read_html html). Internal to injected.ts. */
type LoadedTable = { name: string; source: TableSource; data: { kind: "rows"; columns: string[]; rows: (string | number | null)[][] } | { kind: "html"; html: string } };

/** The object ml.createAgent returns. It IS the session's AgentControl — the same instance is threaded
 *  into ml.agent as `_control`, so the loop mutates the very fields (hash/messages/inbox/seqBase) the
 *  handle exposes. `say` writes a user message into the session (steer if a loop is running, else queue
 *  for the next run()); `run` executes the loop; `maxSteps` is live (raise it mid-run). Page-loop only —
 *  a background-hosted run's history lives in the service worker (see Phase 2). */
class AgentHandle implements MlAgentHandle, AgentControl {
    hash: string | null = null;
    messages: NeutralMessage[] = [];
    inbox: { id: string; text: string }[] = [];
    running = false;
    seqBase = 0;
    stepBase = 0;
    bg = false;   // set by ml.agent when the current run routes to the background (say() then uses INJECT_MESSAGE)
    private _maxSteps: number;
    private _ctrl = new AbortController();
    private _transcript: AgentTranscriptEntry[] = [];   // the WHOLE session's actions (accumulated across turns)
    constructor(private _ml: MlApi, private _opts: AgentOptions) { this._maxSteps = _opts.maxSteps ?? 10; }

    get maxSteps(): number { return this._maxSteps; }
    set maxSteps(n: number) {
        this._maxSteps = n;
        // Reflect the new cap in the sidebar/HUD the instant it's set — the running loop reads it live for
        // the "STEP x/N" display. Only meaningful once a run has minted the session hash.
        if (this.hash) emitDebug({ kind: "agent-cap", id: this.hash, ts: Date.now(), save: false, session: { hash: this.hash, turn: 0 }, maxSteps: n });
    }

    /** Run a full loop until the agent completes its turn. Call again for the next turn (same session).
     *  Rejects while a loop is in flight. No task → runs over whatever say() has queued into history. */
    async run(task?: string, images?: (string | HTMLImageElement)[]): Promise<AgentResult> {
        if (this.running) throw new Error("ml.createAgent: a run is already in flight — use say() to add to it, or cancel() first.");
        // Flush any leftover steering into the history so it's never lost: a mid-run say() that a background
        // loop couldn't drain live (arrived after its last step) sits in the inbox — pick it up this run.
        // Processing it now IS the agent seeing it, so flip the "seen" indicator on each flushed bubble.
        for (const { id, text } of this.inbox.splice(0)) {
            this.messages.push({ role: "user", content: text });
            if (this.hash) emitDebug({ kind: "agent-say-seen", id: this.hash, ts: Date.now(), save: false, session: { hash: this.hash, turn: 0 }, sayId: id });
        }
        // Fresh controller PER RUN: a prior cancel() aborted the previous one for good, so reusing it would
        // insta-cancel this turn. (A caller-supplied signal still governs — cancel() then only aborts ours.)
        this._ctrl = new AbortController();
        this.running = true;
        try {
            // images are PER-TURN (a composer paste), so they override any left on _opts.
            const r = await this._ml.agent(task ?? "", { ...this._opts, images: images || [], signal: this._opts.signal || this._ctrl.signal, _control: this } as AgentOptions);
            // Accumulate: a handle's transcript is the WHOLE conversation's actions, not just this turn's
            // (mirrors messages/hash spanning turns). ml.agent()'s per-call transcript is unchanged.
            this._transcript.push(...r.transcript);
            return { ...r, transcript: this._transcript.slice() };
        } finally { this.running = false; }
    }

    /** Put a user message into the session. Mid-run → steer (queued for the next step boundary, shown in
     *  the UI immediately); idle → append to history for the next run(), with a console note. Never throws. */
    say(text: string): void {
        if (this.running) {
            // A stable id ties this steer's bubble to its later "seen" flip (page loop drains → agent-say-seen;
            // a bg loop fans the same event from the SW, keyed by this same id via INJECT_MESSAGE.sayId).
            const sayId = nextSteerId();
            // Steer the live loop. A BACKGROUND run's loop is in the service worker, so route the message
            // there (INJECT_MESSAGE, drained at its next step); a PAGE-loop run drains the local inbox.
            if (this.bg && this.hash) makeBackgroundTaskPromise("INJECT_MESSAGE_REQUEST", "INJECT_MESSAGE_RESPONSE", { runId: this.hash, text, sayId }).catch(() => { /* run finished first → the next run()'s flush catches it */ });
            this.inbox.push({ id: sayId, text });   // page loop drains this; for a bg run it's the run()-flush safety net
            if (this.hash) emitDebug({ kind: "agent-say", id: this.hash, ts: Date.now(), save: false, session: { hash: this.hash, turn: 0 }, text, sayId });
        } else {
            this.messages.push({ role: "user", content: text });
            console.info("ml.agent: no run in flight — say() queued the message into history; call run() to have the agent process it.");
        }
    }

    cancel(): void {
        this._ctrl.abort();
        // A background run's loop lives in the service worker. Aborting the page controller only rejects the
        // round-trip (→ ABORT_TASK, which kills a FETCH_LLM, not the run), so the SW loop would keep stepping
        // and emit a stale approval AFTER the "cancelled" bubble. Relay CANCEL_RUN to actually stop it.
        if (this.bg && this.hash) window.postMessage({ type: "CANCEL_RUN_REQUEST", payload: { runId: this.hash } }, "*");
    }

    /** A new handle (fresh hash) seeded with a COPY of this history — diverge without touching this one. */
    fork(): MlAgentHandle {
        const f = new AgentHandle(this._ml, this._opts);
        f.messages = this.messages.map(m => ({ ...m }));
        return f;
    }
}

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
        /** The agent's persistent JS scratchpad (also injected into every `exec` body as `state`). A live
         *  page kernel: stash reusable functions/results here and pick them up on a later call. Page-lifetime,
         *  shared across runs. A GETTER (no setter) so it can't be reassigned/clobbered — mutate its props. */
        get state(): Record<string, unknown> { return agentState; },
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
        defineTool: function({ name, description = "", summary, parameters = { type: "object", properties: {} }, run, requiresApproval = false, capabilities = [], render, precheck }: Partial<MlTool> = {}): MlTool {
            if (!name || typeof run !== "function") {
                throw new Error("ml.defineTool needs a name and a run(args) function");
            }
            return { name, description, summary, parameters, run, requiresApproval, capabilities, render, precheck };
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
        agent: async function(task: string, { tools = null, extraTools = [], system = null, hints = null, maxSteps = 10, model = null, think = null, approve = defaultApprove, onStep = null, env = true, vision = null, logDebug = false, signal = null, resume = null, silent = false, unattended = false, navigate = true, crossOrigin = false, approvalRouting = "ui", images = [], _control = null }: {
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
            resume?: string | null;
            silent?: boolean;
            unattended?: boolean;
            navigate?: boolean;   // may this run navigate to other pages (wires the `navigate` tool + cross-page persistence)? default true
            crossOrigin?: boolean;   // may `navigate` cross to OTHER SITES (different origins)? default false — same-site only
            approvalRouting?: "ui" | "both" | "external";   // where privileged gates resolve (bg runs): human UI (default) · UI + IPC · IPC only
            images?: (string | HTMLImageElement)[];   // attachments for THIS turn (composer paste/upload)
            _control?: AgentControl | null;   // internal: a handle's persistent session state (ml.createAgent). Absent → a throwaway per-call one.
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
            // Closed-shadow-root piercing (opt-in). Set the dom.ts module flag from THIS run's config before
            // any DOM tool executes — it governs both loop paths (the page loop below AND the background's
            // delegated page-side tool execution, since both call into the same main-world dom.ts). Off →
            // closed roots stay unreachable, exactly as before.
            const pierceClosed = !!(agentCfg && (agentCfg as { pierceClosedShadow?: boolean }).pierceClosedShadow);
            setPierceClosedShadow(pierceClosed);
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
            // fetch_url: READ a URL the page can't (a raw file / API / other site) WITHOUT navigating — a gated,
            // uncredentialed GET. Auto-wired into the default kit (like navigate); it needs no navigation, so it's
            // added even on a navigate:false run. requiresApproval, so always-on is safe.
            if (!toolset.some(t => t.name === "fetch_url")) toolset.push(this.fetchTool());
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
                // The DOM tools all pierce open shadow roots + resolve `>>>` — tell the model, plus (only when
                // exec is wired) how the notation maps to JS. Gated on a representative DOM tool being present.
                if (toolset.some(t => ["findByText", "describeElement", "interactives", "click", "type"].includes(t.name))) {
                    // The closed-root sentence differs by whether piercing is enabled (reachable via `>>>` vs
                    // visual-only). SHADOW_EXEC_NOTE (`>>>` → JS) is still accurate either way.
                    systemPrompt += SHADOW_CLAUSE + (pierceClosed ? SHADOW_CLOSED_PIERCE_NOTE : SHADOW_CLOSED_NOTE) + IFRAME_CLAUSE;
                    if (toolset.some(t => t.name === "exec")) systemPrompt += SHADOW_EXEC_NOTE;
                }
                if (toolset.some(t => t.name === "agent_api_docs")) systemPrompt += SELF_CLAUSE;
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
            if (hints) systemPrompt += `\n\nTask-specific notes:\n${hints}`;
            if (env) {
                const ctx = pageContext();
                if (ctx) systemPrompt += `\n\nCurrent page context:\n${ctx}`;
            }
            const answered: Node[] = [];   // element(s) an `answer`-capable tool designated (returned as AgentResult.elements)
            const answerMedia: AnswerMedia[] = [];   // their serialized visuals → the HUD completion card (page loop)
            // Debug sidebar: announce the run + each step. Its own session hash
            // (an agent run isn't a createChat). elements can't cross the window
            // bus — send a count; real nodes still reach onStep/the console.
            // Mint the hash on the FIRST turn, then reuse it (a handle's later run()s continue the session).
            // firstTurn keys off whether this control ALREADY has a hash (a prior turn started the session),
            // NOT control.messages — computed BEFORE the hash is assigned below.
            const firstTurn = !control.hash;
            const runHash = control.hash ?? shortHash();
            control.hash = runHash;
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
            if (firstTurn) emitDebug({ kind: "agent", id: runHash, ts: Date.now(), save: false, session: { hash: runHash, turn: 0 }, task, images: turnImages.length ? turnImages : undefined, model: runModel, maxSteps, config: {
                system: systemPrompt, customSystem: !!system,
                tools: toolset.map(t => ({ name: t.name, requiresApproval: !!t.requiresApproval, vision: !!(t.capabilities && t.capabilities.includes("vision")), description: t.description, parameters: t.parameters, summary: t.summary })),
                maxSteps, think: (think === true || think === false) ? think : null, env, vision: vision ?? null,
                driverSees, visionModel: runVisionModel, hints: hints || null, silent: silent || undefined, unattended: unattended || undefined,
                navigate, crossOrigin: crossOrigin || undefined, approvalRouting: approvalRouting !== "ui" ? approvalRouting : undefined,
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
            // Off-mode closure: with no debug surface, a privileged run on a NON-whitelisted origin still
            // routes to the unforgeable background gate — the shell mounts an acrylic corner CARD (shell.ts
            // + app.tsx CardApp) that renders the pending approval and returns the decision via the same
            // origin-authed SET_APPROVAL. A WHITELISTED origin (the user trusts this domain to self-gate) or
            // a run with no privileged tool (nothing to gate) falls through to the in-page loop below.
            const bgSurface: "overlay" | "devtools" | "off" | null =
                (surface === "overlay" || surface === "devtools") ? surface
                    : (hasApprovalTool && !agentCfg?.pageApprovalAllowed) ? "off" : null;
            control.bg = !!bgSurface;   // so a handle's mid-run say() knows to steer via INJECT_MESSAGE, not the page inbox
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
                            emitDebug({ kind: "agent-result", id: runHash, ts: Date.now(), save: false, session: { hash: runHash, turn: res.steps }, summary: res.summary, steps: res.steps, hitCap: !!res.hitCap, cancelled: !!res.cancelled, ...(res.answerMedia ? { answerMedia: res.answerMedia } : {}) });
                            return { ...res, elements: run ? run.answered : [], hash: runHash };
                        } catch (e) {
                            // Mirror the START path: an aborted resume resolves as a clean cancel; any other failure
                            // (e.g. the background was evicted and can't rehydrate the run) surfaces to the card as a
                            // Run-failed result rather than an unhandled rejection with no UI.
                            const run = endRun(runHash);
                            if (signal?.aborted) {
                                emitDebug({ kind: "agent-result", id: runHash, ts: Date.now(), save: false, session: { hash: runHash, turn: 0 }, summary: "Cancelled by the caller.", steps: 0, hitCap: false, cancelled: true });
                                return { summary: "Cancelled by the caller.", steps: 0, transcript: [], elements: run ? run.answered : [], cancelled: true, hash: runHash };
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
                }));
                enterAgentRun();   // suppress orphan chat sessions from a delegated tool's internal ml.chat
                try {
                    const res = await makeBackgroundTaskPromise<AgentResult>("START_RUN_REQUEST", "START_RUN_RESPONSE", {
                        runId: runHash, task, systemPrompt, tools: descriptors,
                        model: runModel, think: (think === true || think === false) ? think : null,
                        maxSteps, autoApprovePython: autoPy, autoApproveReadonly: autoRO, surface: bgSurface,
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
                        rebuild: {
                            toolNames: toolset.map(t => t.name),
                            model: runModel, driverSees, visionModel: runVisionModel,
                            groundingModel: runGroundingModel, groundingRange: runGroundingRange,
                            pierceClosed, crossOrigin,
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
                    const full: AgentResult = { ...res, elements: run ? run.answered : [], hash: runHash };
                    emitDebug({ kind: "agent-result", id: runHash, ts: Date.now(), save: false, session: { hash: runHash, turn: res.steps }, summary: res.summary, steps: res.steps, hitCap: !!res.hitCap, cancelled: !!res.cancelled, ...(res.answerMedia ? { answerMedia: res.answerMedia } : {}) });
                    return full;
                } catch (e) {
                    const run = endRun(runHash);
                    // A caller abort rejects the round-trip; mirror the page loop's clean cancel (resolve,
                    // not throw) with the partial run. (The background fetch isn't killed yet — v1 caveat.)
                    if (signal?.aborted) {
                        emitDebug({ kind: "agent-result", id: runHash, ts: Date.now(), save: false, session: { hash: runHash, turn: 0 }, summary: "Cancelled by the caller.", steps: 0, hitCap: false, cancelled: true });
                        return { summary: "Cancelled by the caller.", steps: 0, transcript: [], elements: run ? run.answered : [], cancelled: true, hash: runHash };
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
            const toolMetas = toolset.map(t => ({ name: t.name, requiresApproval: !!t.requiresApproval, capabilities: t.capabilities }));
            // runAgentLoop restarts its per-step `seq` at 0 each call, but the sidebar patches steps by
            // (hash, seq) — so a later turn would collide with an earlier one. control.seqBase offsets each
            // turn's seqs past the previous turn's, keeping them unique per SESSION across run()/say().
            let turnMaxSeq = 0, turnMaxStep = 0;

            // Enrich the loop's event with the page-only bits: argIssues, the element COUNT for the debug
            // event + the real nodes for onStep, and a best-effort In/Out render for a step the executor
            // DIDN'T run (pending START / denied / skipped), preferring the executor's own render when present.
            const emit = (ev: { step: number; seq?: number; pending?: boolean; thought?: string; reasoning?: unknown; tool?: string; arguments?: Record<string, unknown>; result?: string; approval?: "readonly" | "sandbox" | "user" | "denied" | "skipped" | "cancelled"; renderIn?: RenderDescriptor; renderOut?: RenderDescriptor; feedback?: ToolFeedback; usage?: unknown; elements?: unknown[] }) => {
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
                    result: ev.result, elements: nodes ? nodes.length : undefined,
                    renderIn, renderOut, feedback: ev.feedback,
                    argIssues: argIssues && argIssues.length ? argIssues : undefined,
                    approval: ev.approval, usage: (ev.usage as TokenUsage | null) || undefined,
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
            const runToolDep = async (name: string, args: Record<string, unknown>) => {
                const tool = byName[name];
                const env = await executeTool(tool, args, toolCtx);
                const { in: renderIn, out: renderOut } = descriptorFor(tool, env, args);
                if (tool && tool.capabilities && tool.capabilities.includes("answer") && env.elements && env.elements.length) answered.push(...env.elements as Node[]);
                if (env.answerMedia && env.answerMedia.length) answerMedia.push(...env.answerMedia);
                return { result: String(env.result), elements: env.elements, renderIn, renderOut, image: env.image, imageLabel: env.imageLabel, images: env.images, feedback: env.feedback };
            };

            const deps: AgentLoopDeps = {
                callModel: (messages) => this.step(messages as NeutralMessage[], { tools: toolDefs, model, think, signal }),
                runTool: runToolDep,
                approve: async ({ tool, arguments: args }) => {
                    const d = normalizeApproval(await approve({ tool, arguments: args }), args);
                    // Remember every approved external sheet for the rest of this page session (keyed off the
                    // FINAL args, in case the user edited them) so a follow-up to the same sheet doesn't re-ask.
                    if (d.approved) for (const id of externalSheetIds(d.arguments)) approvedSheets.add(id);
                    return { approved: d.approved, feedback: d.feedback || undefined, arguments: d.arguments };
                },
                autoApprove: (name, args) => {
                    if (name === "python_exec") return autoApprovePython(args, { autoApprovePython: autoPy }, (id: string) => approvedSheets.has(id));
                    // navigate: SAME-ORIGIN auto-approves (no escalation); a CROSS-ORIGIN nav falls through to
                    // the gate (a page can't silently send the agent to another site). location is authoritative.
                    if (name === "navigate") return sameOriginNav(String((args as { url?: unknown }).url ?? "")) ? "same-origin" : null;
                    return null;
                },
                // Read-only exec fast-path: the mediated interpreter is side-effect-free, so trying it is safe
                // and (in-dialect) BOTH auto-approves AND returns the result — no eval (clears Trusted Types).
                // `this` is window.ml; the interpreter reduces it to a facade of ML_READONLY_METHODS, so the
                // agent can read its own setup (getModel/config/…) without the gate and nothing else.
                tryReadonly: autoRO ? async (name, args) => {
                    if (name !== "exec" || typeof (args as { js?: unknown }).js !== "string") return null;
                    try {
                        const ro = await evalReadonly((args as { js: string }).js, document, this);
                        const { result, elements } = formatReadonlyExec(ro.value, ro.logs);
                        const { in: renderIn, out: renderOut } = descriptorFor(byName[name], { result, elements }, args);
                        return { result, elements, renderIn, renderOut };
                    } catch { return null; }
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
                    let capabilities: string[] | null = null, contextWindow: number | null = null, vramGB: number | null = null;
                    if (runModel) {
                        try { capabilities = await mlApi.capabilities(runModel); } catch { /* unknown */ }
                        try { const lm = (await mlApi.ps()).find(m => m.model === runModel); contextWindow = lm?.contextLength ?? null; vramGB = lm?.vramGB ?? null; } catch { /* no ps */ }
                    }
                    // Resident in Ollama (caps came back) → local; else cloud/remote (or unknown w/o a model).
                    const local = capabilities !== null ? true : runModel ? false : null;
                    const fmt = (agentCfg as { apiFormat?: string } | null)?.apiFormat;
                    const backend = fmt === "ollama" ? "Ollama (native)" : fmt === "openai" ? "OpenAI-compatible (e.g. OpenWebUI — server-side tools available)" : null;
                    const est = (s: string) => (s ? Math.round(s.length / 4) : 0);   // ~chars/4, no real tokenizer
                    let toolJson = "";
                    try { toolJson = JSON.stringify(toolset.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }))); } catch { /* skip */ }
                    return { model: runModel, contextWindow, capabilities, vramGB, local, backend, systemTokens: est(systemPrompt), toolTokens: est(toolJson) };
                },
            };

            // One turn of the run. `t` is appended to control.messages (empty → run over prior say()s);
            // buildMessages continues the live history, and maxSteps is read fresh each step (handle can
            // raise it mid-run). answered resets per turn; the seq base advances so steps stay session-unique.
            const drive = async (t: string): Promise<AgentResult> => {
                answered.length = 0; answerMedia.length = 0;   // both reflect THIS turn's answers only (mirror each other)
                enterAgentRun();   // suppress orphan chat sessions from a tool's internal ml.chat; finally-decremented
                try {
                    const r = await runAgentLoop(t, { tools: toolMetas, maxSteps: () => control.maxSteps, signal, unattended }, deps);
                    control.seqBase += turnMaxSeq; turnMaxSeq = 0;   // next turn's step seqs continue past this turn's
                    control.stepBase += turnMaxStep; turnMaxStep = 0;   // …and its step numbers, so turn groups stay distinct
                    emitDebug({ kind: "agent-result", id: runHash, ts: Date.now(), save: false, session: { hash: runHash, turn: r.steps }, summary: r.summary, steps: r.steps, hitCap: !!r.hitCap, cancelled: !!r.cancelled, ...(answerMedia.length ? { answerMedia } : {}) });
                    return { ...r, elements: answered, ...(answerMedia.length ? { answerMedia } : {}), hash: runHash };
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
        },
        /**
         * A stateful agent session — the agent analogue of {@link module:ml.createChat}. Two primitives:
         * `say` writes a user message into the session, `run` executes the loop until the agent's turn is
         * complete; everything shares one hash. Call `run` again for the next turn; `say` mid-run STEERS
         * (injected at the next step boundary), idle it queues for the next `run`. `maxSteps` is live
         * (raise it mid-run to keep going); `messages` is the raw, mutable history; `fork()` branches it.
         *   const a = ml.createAgent({ maxSteps: 20 });
         *   const done = a.run("Reorganise these tabs by topic.");
         *   a.say("actually, keep the pinned ones where they are");   // steer mid-run
         *   await done;
         *   await a.run("Now close the empty groups.");               // another turn, same session
         * @param {AgentOptions} [opts] the same options as ml.agent (tools, model, vision, …)
         * @returns {MlAgentHandle} a handle: run/say/cancel/fork + hash/messages/maxSteps/running
         */
        createAgent: function(opts: AgentOptions = {}): MlAgentHandle {
            return new AgentHandle(this as unknown as MlApi, opts);
        },
        /**
         * Re-acquire a live agent handle by its session hash (shown/copied in the debug sidebar). The agent
         * analogue of {@link module:ml.resumeChat}: returns the SAME handle the run is using, so you can read
         * or mutate its `messages`, `say()`/`run()` to continue it, `fork()` it, or `cancel()` it — without
         * having kept the original `createAgent()` reference.
         *
         * Same-tab `createAgent` / HUD-started runs only. A one-shot `ml.agent(task)` (no handle) and a
         * background/off-mode run (its history lives in the service worker) aren't handle-resumable this way —
         * the low-level `ml.agent(task, { resume: hash })` still CONTINUES those.
         *
         * @param {string} hash The run's session hash.
         * @returns {MlAgentHandle} the live handle (run/say/cancel/fork + hash/messages/maxSteps).
         * @throws {Error} If no handle-backed run exists for the hash in this tab.
         */
        resumeAgent: function(hash: string): MlAgentHandle {
            if (!hash || typeof hash !== "string") throw new Error("ml.resumeAgent needs a run hash string.");
            const handle = handleRegistry.get(hash);
            if (!handle) throw new Error(
                `No resumable agent handle "${hash}" in this tab. Handles come from ml.createAgent (or a ` +
                `HUD-started run); a one-shot ml.agent(task) or a background/off-mode run isn't handle-resumable ` +
                `— use ml.agent(task, { resume: "${hash}" }) to continue it instead.`
            );
            return handle;
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
        read: async function(image: string | HTMLImageElement, { model = null, prompt = null, numCtx = null }: { model?: string | null; prompt?: string | null; numCtx?: number | null } = {}): Promise<string> {
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
                    // Per-call override; when omitted, prepareRequest applies the small config.ocrNumCtx
                    // default (residency-guarded, so a bigger already-loaded model is reused, not reloaded).
                    "numCtx": typeof numCtx === "number" ? numCtx : undefined,
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
        screenshot: async function(target: string | Element | null = null, { scroll = true, fullPage = false, index = 0, raw = false, margin = 0, noOverlay = false, capture = null }: { scroll?: boolean; fullPage?: boolean; index?: number; raw?: boolean; margin?: number; noOverlay?: boolean; capture?: string | null } = {}): Promise<string> {
            // Hide the debug sidebar overlay (if mounted) for the shot, so it isn't
            // captured into the agent's `look`; restore after. No wait when the
            // sidebar is off (no #ml-sb-root) — it's a no-op then.
            // `capture` (a pre-taken viewport data-URL) SHORT-CIRCUITS this: `look`'s two-view mode
            // (overlay + no-overlay) crops both from ONE capture instead of re-screenshotting the tab.
            const viewport = async (): Promise<string> => {
                if (capture) return capture;
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
                if (raw || noOverlay) return cropped;   // raw: pythonExec pixels · noOverlay: look's clean copy (same crop, no marker)
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
                if (noOverlay) return cropped;   // look's clean copy: same PADDED framing as the marked one, just no outline
                const outline = { left: bx.left - left, top: bx.top - top, width: bx.right - bx.left, height: bx.bottom - bx.top };
                const color = await pickAccentColorForTarget(cropped, { left: outline.left * dpr, top: outline.top * dpr, width: outline.width * dpr, height: outline.height * dpr });
                return annotate(cropped, [{ rect: outline, color, label: "container" }], dpr);
            }

            let el = target;
            if (typeof target === "string") {
                el = queryAll(target)[index];   // Nth match (queryAll adds :contains + `>>>` shadow/iframe crossing)
                if (!el) throw new Error(`No element matches "${target}"${index ? ` at index ${index}` : ""}.`);
            }
            // isElement = cross-realm nodeType check (dom.ts) — a `>>>` iframe-inner element is in the frame's
            // realm, so `instanceof Element` fails. Type guard → `el` narrows to Element below (no casts).
            if (!isElement(el)) throw new Error("ml.screenshot needs a CSS selector, an Element, or nothing.");
            if (scroll) {
                el.scrollIntoView({ block: "center", inline: "center" });
                // Let the scroll paint before we capture.
                await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            }
            // viewportRect (not getBoundingClientRect) — an element inside a same-origin iframe reports a
            // FRAME-LOCAL rect, but the captured tab image is the TOP viewport, so the crop must be composed
            // across the frame offset (else it crops the wrong region — the page's top-left).
            const rect = viewportRect(el);
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
            if (!isElement(el)) return null;   // cross-realm nodeType check (iframe-inner elements)
            const r = viewportRect(el);   // top-viewport (composes iframe offsets)
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
        lookTool: function(opts: { model?: string | null; maxTokens?: number; memory?: VisionMemory } = {}): MlTool {
            return buildLookTool(this, opts);
        },
        /**
         * Build a delegated Set-of-Marks `locate` tool (see builtin-tools/locate): find
         * an element by describing it, via a vision sub-call over a badged screenshot.
         * Auto-wired into ml.agent alongside `look` when a vision model resolves.
         *
         * @param {Object} [opts]
         * @param {string} [opts.model=null] Vision model that reads the badges.
         * @param {number} [opts.maxTokens=64] Cap on the sub-call (it returns a number).
         * @returns {MlTool} A tool with `name: "locate"` and `capabilities: ["vision"]`.
         */
        locateTool: function(opts: { model?: string | null; groundingModel?: string | null; groundingRange?: number; maxTokens?: number; memory?: VisionMemory } = {}): MlTool {
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
         * Build the `navigate(url)` tool: navigate the tab to another SAME-SITE URL, continuing the run on
         * the new page. Auto-wired into ml.agent unless `navigate: false`. Same-origin only in v1 — a
         * cross-origin URL is refused (`navTarget`) pending per-origin consent. The nav is DEFERRED a tick so
         * this tool's result posts back to the loop before the document unloads; the navigation barrier then
         * holds the next delegated tool until the fresh page re-adopts the run.
         *
         * @returns {MlTool} A tool with `name: "navigate"` (no approval for same-site).
         */
        navigateTool: function(opts: { crossOrigin?: boolean } = {}): MlTool {
            const ml = this;
            const allowCrossOrigin = !!opts.crossOrigin;
            return ml.defineTool({
                name: "navigate",
                // requiresApproval so a CROSS-ORIGIN nav hits the unforgeable gate (a page can't tell the agent
                // to silently jump to another site). SAME-ORIGIN navs auto-approve (no prompt) via autoApprove.
                requiresApproval: true,
                summary: allowCrossOrigin ? "Navigates the tab to another page (any site)." : "Navigates the tab to another same-site page.",
                description: "Navigate the browser tab to another URL (absolute or site-relative, e.g. " +
                    "\"/step2\" or \"https://this-site.example/page\"). The run CONTINUES on the new page: after " +
                    "navigating, `wait` for it to settle, then read/act as usual. " +
                    (allowCrossOrigin
                        ? "This run MAY cross to other SITES (different origins) — do so only when the task needs it, and never carry sensitive info from one site into another site's forms. "
                        : "Same-origin ONLY — a cross-site URL is refused (tell the user instead). ") +
                    "Prefer this over clicking a link when you already know the destination URL.",
                parameters: {
                    type: "object",
                    properties: {
                        url: { type: "string", description: "The URL to go to (absolute or site-relative, e.g. \"/dashboard\")." },
                        verify: { type: "boolean", description: "Set true to fold a SCREENSHOT of the destination page into the result (an inline look — saves a `wait`+`look` turn to see where you landed). Like the verify on click/type." },
                    },
                    required: ["url"],
                },
                // Show the DESTINATION in the approval card — a consent gate is meaningless without the URL the
                // agent wants to leave for. An `action` render → the sidebar's intent sentence ("Agent wants to
                // go to <url>", the url styled like a significant action). Resolve relative → absolute so the
                // origin is always visible.
                render: (_input: unknown, args?: Record<string, unknown>): RenderDescriptor => {
                    const raw = String((args as { url?: unknown } | undefined)?.url ?? "");
                    let shown = raw;
                    try { shown = new URL(raw, location.href).href; } catch { /* keep raw */ }
                    return { type: "action", verb: "go to", target: shown };
                },
                run: async ({ url }: { url?: unknown } = {}): Promise<string> => {
                    const t = navTarget(typeof url === "string" ? url : "", location.href, { allowCrossOrigin });
                    if ("error" in t) return `Error: ${t.error}`;
                    // Defer so the RESULT posts back to the (background) loop before the document unloads —
                    // otherwise the delegated-tool round-trip is lost and the run can't record the nav.
                    setTimeout(() => { try { location.href = t.dest; } catch { /* navigation blocked */ } }, 0);
                    return `Navigating to ${t.dest} …${t.crossOrigin ? " (a DIFFERENT site — the run continues there)" : ""} wait for the new page to load, then continue.`;
                },
            });
        },
        /**
         * Build the `fetch_url` tool: GET a URL's content (uncredentialed, via the background) so the agent can
         * READ a file/API/other page WITHOUT navigating there. requiresApproval — a new URL hits the unforgeable
         * gate; an already-approved one auto-approves. Auto-wired into ml.agent unless `fetch: false`.
         *
         * @returns {MlTool} A tool with `name: "fetch_url"` and `requiresApproval: true`.
         */
        fetchTool: function(): MlTool {
            const ml = this;
            return ml.defineTool({
                name: "fetch_url",
                requiresApproval: true,   // a NEW url hits the unforgeable gate; an approved one auto-approves (autoApprove)
                summary: "Fetches a URL's content (uncredentialed GET) to read a file/API the page can't.",
                description: "GET a URL's content via the extension — bypasses CORS, sends NO cookies. Use it to " +
                    "READ a raw file, a JSON API, or another site WITHOUT navigating there (also works on pages " +
                    "that block the extension, e.g. raw.githubusercontent.com). The result reports the body plus a " +
                    "best-effort TYPE (json/csv/html/xml/markdown/code/text) so you can chain — JSON comes " +
                    "pre-parsed, hand a CSV to python_exec, a code file names its language. The type is a HEURISTIC " +
                    "(resolved from the Content-Type header, a content sniff, and the URL extension — a server can " +
                    "mislabel), not authoritative. GET only (no headers/body/auth). Each NEW url is approved once by " +
                    "the user, then remembered for the session. Prefer this over `navigate` when you only need to READ a URL.",
                parameters: {
                    type: "object",
                    properties: { url: { type: "string", description: "The absolute http(s) URL to fetch." } },
                    required: ["url"],
                },
                // Show the URL in the approval card (an `action` render → the intent sentence "Agent wants to fetch <url>").
                render: (_input: unknown, args?: Record<string, unknown>): RenderDescriptor =>
                    ({ type: "action", verb: "fetch", target: String((args as { url?: unknown } | undefined)?.url ?? "") }),
                run: async ({ url }: { url?: unknown } = {}): Promise<string> => {
                    if (typeof url !== "string" || !url.trim()) return "Error: fetch_url needs a `url`.";
                    let r: import("./contract").FetchResult;
                    try { r = await ml.fetch(url); }
                    catch (e) { return `Error: ${errText(e)}`; }
                    const mislabel = r.typeByHeader && r.typeByHeader !== r.type ? ` (header said "${r.typeByHeader}")` : "";
                    const head = `Fetched ${r.url} — HTTP ${r.status}, type: ${r.type}${r.language ? ` (${r.language})` : ""}${mislabel}${r.truncated ? " · body truncated" : ""}.`;
                    const body = r.json !== undefined ? JSON.stringify(r.json, null, 2) : r.text;
                    return `${head}\n\n${clipOut(body, 4000)}`;
                },
            });
        },
        /**
         * Cross-page persistence: rebuild a run's BUILTIN toolset from a serializable {@link RebuildConfig}
         * (tool names + carried vision facts) on a fresh document after a same-site navigation. Only builtin
         * tools cross a nav — custom function tools (passed via `tools`/`extraTools`) don't serialize, so a
         * cross-page run is limited to the default/HUD kit by design. Vision facts are CARRIED (not re-probed),
         * so native-vs-delegated `look` on the new page matches the original run exactly.
         */
        _rebuildToolset: function(rebuild: RebuildConfig): MlTool[] {
            const ml = this;
            const want = new Set(rebuild.toolNames);
            const out: MlTool[] = [];
            // Read-only DOM base, filtered to the run's names.
            for (const t of (ml.domTools || [])) if (want.has(t.name)) out.push(t);
            // Builtin interaction/privileged tools (originally added via extraTools — e.g. the HUD kit).
            if (want.has("click")) out.push(ml.clickTool());
            if (want.has("type")) out.push(ml.typeTool());
            if (want.has("python_exec")) out.push(ml.pythonTool());
            if (want.has("chat_metadata")) out.push(ml.chatMetaTool());
            if (want.has("navigate")) out.push(ml.navigateTool({ crossOrigin: rebuild.crossOrigin }));
            if (want.has("fetch_url")) out.push(ml.fetchTool());
            // Auto-wired vision tools, rebuilt from the carried facts (no re-probe) with a fresh near-area memory.
            if (want.has("look") || want.has("locate")) {
                const memory: VisionMemory = { seen: [], boundariesSeen: new Set() };
                if (want.has("look")) out.push(rebuild.driverSees ? ml._nativeLookTool(memory) : ml.lookTool({ model: rebuild.visionModel, memory }));
                if (want.has("locate")) out.push(ml.locateTool({ model: rebuild.visionModel, groundingModel: rebuild.groundingModel, groundingRange: rebuild.groundingRange, memory }));
            }
            return out;
        },
        /**
         * Cross-page persistence: re-adopt a background-hosted run on a fresh document (after a same-site
         * navigation). Rebuild the run's builtin toolset from the carried config + re-register it under the
         * run id, so the background's held delegated tool can execute here. Re-applies the closed-shadow
         * flag first (a module flag the new document reset). Called from the CONTENT_READY → adopt round-trip.
         */
        _adoptRun: function(runId: string, rebuild: RebuildConfig): void {
            setPierceClosedShadow(!!rebuild.pierceClosed);
            const toolset = this._rebuildToolset(rebuild);
            const model = rebuild.model ?? null, driverSees = !!rebuild.driverSees, visionModel = rebuild.visionModel ?? null;
            registerRun(runId, toolset, model, driverSees, visionModel);
            // Re-register a RESUME handle so a HUD composer follow-up (a run() turn) can continue this
            // background run BY HASH — the original page's AgentHandle died with the navigation, so without
            // this a follow-up typed on the new page falls through to the chat path and is silently dropped.
            agentRegistry.set(runId, {
                hash: runId,
                resume: async (t: string): Promise<AgentResult> => {
                    registerRun(runId, toolset, model, driverSees, visionModel);   // endRun clears the live tools each turn
                    enterAgentRun();
                    try {
                        const res = await makeBackgroundTaskPromise<AgentResult>("RESUME_RUN_REQUEST", "RESUME_RUN_RESPONSE", { runId, task: t });
                        const run = endRun(runId);
                        emitDebug({ kind: "agent-result", id: runId, ts: Date.now(), save: false, session: { hash: runId, turn: res.steps }, summary: res.summary, steps: res.steps, hitCap: !!res.hitCap, cancelled: !!res.cancelled, ...(res.answerMedia ? { answerMedia: res.answerMedia } : {}) });
                        return { ...res, elements: run ? run.answered : [], hash: runId };
                    } finally { exitAgentRun(); }
                },
            });
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

            // Alias each df in the `tables` dict by its SOURCE string too (e.g. a single source "current"
            // → tables['current']): a model that passed `"tables": "current"` naturally reaches for
            // tables['current'], not the internal `df` name. Accommodate it (string sources only).
            const r = await makeBackgroundTaskPromise("PYTHON_EXEC_REQUEST", "PYTHON_EXEC_RESPONSE",
                { code, image: img, hardened: mode !== "full", tables: loaded.map((l, i) => ({ name: l.name, data: l.data, alias: typeof specs[i].src === "string" ? specs[i].src as string : null })) }) as { ok: boolean; value?: unknown; stdout: string; error?: string; table?: { columns: string[]; rows: (string | number | null)[][] } };
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
            if (!isElement(el)) throw new Error(`ml.pythonExec: no table element matches "${String(target)}".`);
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
         * A read-only self-introspection tool for `ml.agent` — pass it via `extraTools` (it is NOT a default
         * tool). Lets the agent answer questions about ITSELF: which model it's on, its context window and
         * how much is used, tokens generated so far this run, the message/image counts, and the model's
         * capabilities. The agent LOOP answers it (it holds the live token/message state), so the numbers are
         * accurate on both the page and background paths. Handy in the HUD, unneeded for most automation.
         *
         *   ml.agent(task, { extraTools: [ml.chatMetaTool()] })
         *
         * @returns {MlTool} A tool with `name: "chat_metadata"`, no args, no approval.
         */
        chatMetaTool: function(): MlTool {
            return {
                name: "chat_metadata",
                description: "Report metadata about THIS conversation: the model you're running on, its context window and how much of it is used, how many tokens you've generated this run, the number of messages and images so far, and which features the model supports (tools/vision/thinking). Call it when the user asks about your model, context, or token usage. Read-only; costs nothing.",
                parameters: { type: "object", properties: {}, additionalProperties: false },
                requiresApproval: false,
                capabilities: ["meta"],
                summary: "Introspect this run: model, context, tokens, messages.",
                // Answered by the agent loop (it owns the live stats); this stub never runs.
                run: async () => "(chat_metadata is answered by the agent loop)",
            } as MlTool;
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
            try { caps = await this.capabilities(model); } catch (e) { caps = null; }
            if (Array.isArray(caps)) return caps.includes("vision");   // we KNOW (Ollama /api/show) — authoritative
            // Undeterminable (cloud / non-Ollama / old Ollama): fall back to the user's declared capability for
            // the DEFAULT model — the only way such a model can be marked vision-capable (e.g. HUD native vision
            // on gpt-4o/minimax). Detection above always wins for Ollama, so this never overrides a known answer.
            try {
                const cfg = await this.config();
                if (cfg && cfg.model && model === cfg.model && cfg.defaultModelVision) return cfg.defaultModelVision === "yes";
            } catch (e) { /* no config → treat as unknown = no */ }
            return false;
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
        _nativeLookTool: function(memory?: VisionMemory): MlTool {
            const ml = this;
            return ml.defineTool({
                name: "look",
                summary: "Screenshots the page so the agent can see it.",
                capabilities: ["vision"],
                description: "See the page with your OWN eyes — this screenshots the page (or an element) " +
                    "and shows YOU the image directly. Call with NO selector to see the viewport and ORIENT " +
                    "when a task is vague; pass a selector to inspect one element (icons, badges, whether " +
                    "something looks sponsored / greyed-out / out of stock); pass scope:'page' (no selector) " +
                    "to see the whole page stitched into one tall image (DOWNSCALED — use it for layout, not " +
                    "small text). To CLASSIFY items in a grid/list (which show a cat?), pass the item selector " +
                    "and iterate `index` (0,1,2,…) for a tight crop of each. After looking, DESCRIBE what you " +
                    "see, then take the next action. BONUS: alongside the image the result appends a \"DOM in " +
                    "view\" legend — the exact visible TEXT, controls and boundaries under the crop with their " +
                    "selectors — so you read the ground-truth characters instead of guessing them from pixels " +
                    "(no OCR risk) and get a ready anchor for click/type. It's a heuristic: it can't reach a " +
                    "CANVAS or a CROSS-ORIGIN iframe (no DOM there), and a BUSY or LARGE selection skips the " +
                    "text listing (too much to be useful) — so a tight crop gets the richest legend.",
                parameters: {
                    type: "object",
                    properties: {
                        selector: { type: "string", description: "CSS selector of an element; omit to see the page." },
                        scope: { type: "string", enum: ["viewport", "page"], description: "'viewport' (default), or 'page' to scroll+stitch the full page (only when no selector)." },
                        index: { type: "integer", description: "Which match of the selector to look at (0-based); iterate a grid with 0,1,2,…" },
                        margin: { type: "number", description: "For an @pt: token only — the crop RADIUS in px around the point (bigger = more context). Ignored for CSS selectors." },
                        views: VIEWS_PARAM
                    }
                },
                // In: the target as a hoverable ref (hover → outline it on the page). No selector → raw args.
                render: (_input, args) => targetRender(args),
                run: async ({ selector, scope, index, margin, views }: { selector?: string; scope?: "viewport" | "page"; index?: number; margin?: number; views?: string[] } = {}): Promise<string | ToolResult> => {
                    const fullPage = scope === "page" && !selector;
                    const isPoint = !!selector && POINT_RE.test(selector.trim());
                    const isMarked = !!selector && (isPoint || BOX_RE.test(selector.trim()));
                    // Looking at an @pt marks it SEEN → locate's snap-feedback won't re-inject its crop.
                    if (isPoint) { const p = resolvePoint(selector!); if (p) markSeen(memory, p.x, p.y); }
                    // A marked target honours `views` (overlay / no-overlay / both, ONE capture); the driver sees
                    // each crop as its own inline image. Everything else is the usual single shot.
                    let shots: { image: string; label: string }[], crossesText = false;
                    try {
                        if (isMarked) { const v = await lookViews(ml, selector!, margin as number, views); shots = v.images; crossesText = v.crossesText; }
                        else { const shot = await ml.screenshot(selector || null, { fullPage, index: index || 0, margin: typeof margin === "number" ? margin : 0 }); shots = [{ image: shot, label: selector ? `element "${selector}"${index ? ` #${index}` : ""}` : (fullPage ? "full page" : "viewport") }]; }
                    }
                    catch (e) { return `Error: ${errText(e)}`; }
                    const label = shots[0].label;
                    // @pt verify shot → disclose the snap-around-point recovery, @pt-only: the
                    // driver can see here whether the mark grazes a target it can otherwise see.
                    const pointTip = isPoint
                        ? `\n\n(Verify before clicking. If the target IS visible in this crop but the mark isn't on it, re-locate just this area to snap onto it: locate({ selector: "${selector}", strategy: "grounding", description: "…" }) — searches only this box (add margin: 40–120 if the target is partly cut off at the edge). If the target ISN'T in this crop at all, it's the wrong spot: change region/description, don't re-verify here.)`
                        : "";
                    // Targeted no-overlay nudge — only when the box was DETECTED over text AND a clean copy wasn't already sent.
                    const overTextTip = crossesText && shots.length === 1 ? BOX_OVER_TEXT_TIP : "";
                    const multi = shots.length > 1 ? ` (${shots.length} crops: ${shots.map(s => s.label).join(" · ")})` : "";
                    // DOM legend of what's IN this crop — actionable selectors beside the pixels. Skip for a
                    // downscaled full-page overview (the model shouldn't act on tiny elements from it).
                    const legend = fullPage ? "" : legendFor(selector || null, typeof margin === "number" ? margin : 0);
                    // Hand the screenshotted element back on the elements side-channel
                    // so it's hoverable in `logDebug`/`onStep` (never sent to the model).
                    // Guarded: a bad/stub-DOM selector just yields no node.
                    let elements;
                    if (selector) { try { const el = queryAll(selector)[index || 0]; if (el) elements = [el]; } catch {} }
                    return {
                        content: `Screenshot of the ${label}${multi} captured — shown to you in the next message.${pointTip}${overTextTip}${legend}`,
                        // One view → the single `image` shortcut; two → `images` (each injected as its own turn).
                        ...(shots.length > 1 ? { images: shots } : { image: shots[0].image, imageLabel: label }),
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
        // Public alias: a shadow/iframe-piercing `document.querySelectorAll` the model can call from
        // `exec` (and the readonly dialect) instead of hand-chaining `.shadowRoot`/`.contentDocument`.
        queryAll,
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
         * List the OpenWebUI server-side tools the configured API key may use — the
         * valid ids for `ml.chat`'s `toolIds`, each with the function specs the model
         * would be shown. Discovery, so a script doesn't have to hardcode ids copied
         * out of the OpenWebUI URL bar.
         *
         * A bare-Ollama (or non-OpenWebUI) endpoint has no such concept and returns [].
         *
         * @returns {Promise<ServerTool[]>} The available server-side tools.
         */
        serverTools: async function(): Promise<ServerTool[]> {
            return makeBackgroundTaskPromise("LIST_SERVER_TOOLS_REQUEST", "LIST_SERVER_TOOLS_RESPONSE", {});
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
         * A bounded integer range, like Python's `range()` — the terminating counter loop for `exec`
         * (no `for`/`while` needed): `ml.range(8).map(i => …)`. Forms: `range(stop)`, `range(start, stop)`,
         * `range(start, stop, step)`. Returns a real array capped at 100k elements (over → throws), so it
         * can never run away or blow up memory.
         *
         * @param {number} a `stop`, or `start` when `b` is given.
         * @param {number} [b] `stop`.
         * @param {number} [step=1] Increment (may be negative).
         * @returns {number[]} The integer sequence.
         */
        range: mlRange,
        /**
         * GET a URL's content via the background worker — bypasses CORS (host permissions), sends NO cookies
         * (uncredentialed). Use it to READ a page/file the current DOM can't reach — a raw source file, a JSON
         * API, another site — instead of NAVIGATING there (which also dodges pages that block the extension,
         * e.g. raw.githubusercontent.com's sandbox CSP).
         *
         * Returns a FetchResult: `.type` classifies the body as json/csv/html/xml/markdown/code/text so you can
         * chain — `.json` is pre-parsed for JSON; hand a CSV's `.text` to `python_exec`; `.language` names a
         * code file's language. The type is a best-effort HEURISTIC (resolved from the Content-Type header,
         * then a content sniff, then the URL extension — a server can mislabel, so `.typeByHeader`/`.typeByContent`/
         * `.typeByExtension` are all reported); don't treat it as authoritative.
         *
         * GET only — no headers, body, or auth. Each NEW url needs the user's one-time approval; then it's
         * remembered for the session.
         *
         * @param {string} url An absolute http(s) URL.
         * @returns {Promise<FetchResult>} { url, status, ok, type, language?, text, json?, typeBy*, truncated? }.
         */
        fetch: function(url: string): Promise<import("./contract").FetchResult> {
            return makeBackgroundTaskPromise("FETCH_URL_REQUEST", "FETCH_URL_RESPONSE", { url: String(url) });
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
    // Pass a `verifyArea` capability (closes over ml) so the pure `wait` domTool can `verify` too — the
    // domTools stay ml-free; they just receive this function. center=null → a viewport shot (wait is area-first).
    window.ml.domTools = makeDomTools(window.ml.defineTool,
        (ctx, center, verb, mutated) => captureVerify(window.ml as unknown as MlApi, ctx, center, verb, mutated),
        // captureAnswer: serialize each element an `answer` designates, for the HUD completion card (user-facing
        // output — NOT the debug sidebar). ml-backed, so the domTools stay ml-free. Capped + per-element failures
        // swallowed; the answer still stands without the media. An <img> → its FULL-RES src (crop fallback); any
        // other element → a screenshot crop. `mode` = show ?? (image → inline, element → highlight).
        async (els: Element[], note?: string, show?: "inline" | "highlight"): Promise<AnswerMedia[]> => {
            const ml = window.ml as unknown as MlApi & { _imageToDataUrl: (el: HTMLImageElement) => Promise<string> };
            const out: AnswerMedia[] = [];
            for (const el of els.slice(0, 6)) {
                const isImg = el instanceof HTMLImageElement;
                const kind: AnswerMedia["kind"] = isImg ? "image" : "element";
                const mode: AnswerMedia["mode"] = show || (isImg ? "inline" : "highlight");
                let image = "";
                try { image = isImg ? await ml._imageToDataUrl(el as HTMLImageElement) : await ml.screenshot(el, { noOverlay: true }); }
                catch { try { image = await ml.screenshot(el, { noOverlay: true }); } catch { /* no visual — keep the chip via selector */ image = ""; } }
                out.push({ image, label: note, selector: elPath(el), kind, mode });
            }
            return out;
        });

    // listen for the background loop's delegated tool-run requests (relayed by content.ts
    // as PAGE_TOOL_RUN). A no-op until an agent run registers a toolset via _registerRun.
    installToolDelegation();

    // Cross-page persistence: a FRESH document (after a same-site navigation) must RE-ADOPT any
    // background-hosted run its tab still hosts — rebuild + re-register the toolset so the loop's held
    // delegated tool can run here. content.ts asks the background on our behalf (CONTENT_READY) and relays
    // the rebuild-config back as an ADOPT_RUN window message; we rebuild, then post RUN_READOPTED so the
    // background releases the navigation barrier. We DRIVE it (post PAGE_ADOPT_HELLO now that this listener
    // exists) so content.ts only sends ADOPT_RUN after we're listening — avoiding a missed message on the
    // async <script> injection.
    window.addEventListener("message", (e: MessageEvent) => {
        if (e.source !== window || !e.data || e.data.type !== "ADOPT_RUN") return;
        const { runId, rebuild, resume } = e.data as { runId?: string; rebuild?: RebuildConfig; resume?: boolean };
        if (!runId || !rebuild) return;
        try { (window.ml as unknown as MlApi)._adoptRun(runId, rebuild); }
        catch { /* rebuild failed → the barrier times out and the loop gets a clear "no active run" error */ }
        // Carry the DESTINATION page's context back: the background folds it into the `navigate` tool's
        // result, so the model's next turn is oriented on the new page without a wasted look()/pageInfo turn.
        window.postMessage({ type: "RUN_READOPTED", runId, pageInfo: pageContext() }, "*");
        // Durable resume: an INTERRUPTED (SW-evicted) run auto-CONTINUES from its checkpointed history — the
        // resume handle _adoptRun just re-registered drives a RESUME_RUN (empty follow-up = "carry on").
        if (resume) {
            try { const bg = agentRegistry.get(runId); if (bg) void bg.resume(""); }
            catch { /* resume unavailable → the run stays paused, no worse than before */ }
        }
    });
    window.postMessage({ type: "PAGE_ADOPT_HELLO" }, "*");

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
                    // viewportRect (not getBoundingClientRect) so an element inside a same-origin iframe is
                    // placed in the TOP viewport, not at its frame-local position (the overlay is top-level).
                    const r = viewportRect(el);
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

    // The HUD composer (Spotlight bar) asks the page to START a run — relayed by the shell as
    // __mlStartAgent. Run it as a real ml.agent() call so it's a genuine session (hash, resumable,
    // appendable), which in off/devtools mode routes to the background-hosted loop like a console run.
    // Grants nothing extra: the page already has window.ml.agent, and every tool gates on the background.
    window.addEventListener("message", (e: MessageEvent) => {
        if (e.source !== window || !e.data || !e.data.__mlStartAgent) return;
        let task = String(e.data.__mlStartAgent.task || "").trim();
        // Composer attachments (pasted/uploaded screenshots) — the shell already sanitised them to data URLs.
        const images = Array.isArray(e.data.__mlStartAgent.images) ? e.data.__mlStartAgent.images as string[] : undefined;
        // Right-click "ask about this": the shell resolved the clicked element to a clean ElementContext.
        // Frame it around the user's question (content as context + the scope selector for the DOM tools).
        const elementContext = e.data.__mlStartAgent.elementContext as import("./contract").ElementContext | undefined;
        if (elementContext && typeof elementContext.selector === "string") task = askAboutTask(task, elementContext);
        if (!task && !(images && images.length)) return;   // allow an image-only start
        // A UI-started run is a PRODUCT surface (a user typing "click the button" expects click to work),
        // so give it a capable default kit — click/type/python ON TOP of the default domTools + auto-wired
        // look/locate. (The console `ml.agent` primitive stays minimal — callers compose their own.) Each
        // added tool still requires approval, gated by the unforgeable card.
        const maxSteps = Number(e.data.__mlStartAgent.maxSteps);
        const ml = window.ml as unknown as {
            createAgent: (o?: unknown) => MlAgentHandle & { run: (t?: string, images?: (string | HTMLImageElement)[]) => Promise<unknown> };
            clickTool: () => unknown; typeTool: () => unknown; pythonTool: () => unknown; chatMetaTool: () => unknown;
        };
        // `hints` (appended to the system prompt) rather than `system` (which would REPLACE the
        // preamble): the run still needs the whole method, it just isn't a console call.
        // chatMetaTool: a HUD user often asks "which model am I / how much context have I used?" — give the
        // HUD agent the self-introspection tool by default (a scripted ml.agent still opts in via extraTools).
        // HUD verbosity (passed by the shell): quiet → tell the model to stay silent between steps; progress
        // → keep between-step prose to one short live line. Defaults to progress.
        const proseClause = e.data.__mlStartAgent.hud === "quiet" ? HUD_PROSE_QUIET : HUD_PROSE_PROGRESS;
        // Commander/HUD runs allow cross-origin navigation by default — a HUD user driving a real task often
        // needs to cross sites, and each crossing still hits the consent gate (a new origin prompts), so it's
        // safe. A scripted console `ml.agent()` still defaults to same-site only.
        const opts: Record<string, unknown> = { extraTools: [ml.clickTool(), ml.typeTool(), ml.pythonTool(), ml.chatMetaTool()], hints: HUD_HINT + proseClause, crossOrigin: true };
        if (Number.isFinite(maxSteps) && maxSteps > 0) opts.maxSteps = maxSteps;   // the composer's step budget
        // The composer's per-call model pick (omitted ⇒ the configured default) + a per-call FORCE-NATIVE
        // vision override for a non-Ollama model (omitted ⇒ ml.agent's default vision routing). Same knobs a
        // console ml.agent({ model, vision }) exposes — the HUD just wires the picker to them.
        const startModel = e.data.__mlStartAgent.model;
        if (typeof startModel === "string" && startModel.trim()) opts.model = startModel.trim();
        if (e.data.__mlStartAgent.vision === true) opts.vision = true;
        // createAgent (not ml.agent) so the run registers a HANDLE the sidebar/HUD composer can drive —
        // follow-up run()s + say() steering from the "Send a message to this session…" box.
        try { void ml.createAgent(opts).run(task, images); }
        catch (err) { console.error("ml: UI-started run failed:", err); }
    });

    // Sidebar/HUD composer → drive a handle-backed session by hash. The app decides which to send from the
    // run's live state: say() to STEER a running loop or append when idle; run() a follow-up turn; cancel()
    // the in-flight turn (the stop button). Same origin check as the others; the registry holds only this
    // page's own createAgent sessions, so there's nothing cross-origin to reach.
    // Composer-initiated chat turns need a cancel channel too (the stop button). A plain chat turn is a
    // single fetch — unlike an agent loop there's no handle to hold it — so we track the in-flight
    // AbortController per session hash and abort it on cancel. Only composer-driven turns are tracked (a
    // console `history.chat()` isn't), which is fine: the stop button only fronts turns the composer started.
    const chatInflight = new Map<string, AbortController>();
    async function continueChatSession(hash: string, text: string, images?: (string | HTMLImageElement)[]): Promise<void> {
        // Same-tab sessions live in the registry; a saved session from another tab/reload rehydrates.
        const resume = (window.ml as unknown as { resumeChat: (h: string) => Promise<MlHistory> }).resumeChat;
        let h = sessionRegistry.get(hash);
        if (!h) { try { h = await resume(hash); } catch { return; } }   // unknown/unsaved hash → nothing to continue
        if (!h) return;
        const ctrl = new AbortController();
        chatInflight.set(hash, ctrl);
        try { await h.chat(text, { images: images || [], signal: ctrl.signal }); }
        catch { /* aborted or failed — the chat-error event already surfaced it in the sidebar */ }
        finally { if (chatInflight.get(hash) === ctrl) chatInflight.delete(hash); }
    }

    window.addEventListener("message", (e: MessageEvent) => {
        if (e.source !== window || !e.data) return;
        const d = e.data as { __mlSessionSend?: { hash: string; text: string; images?: string[]; elementContext?: import("./contract").ElementContext }; __mlCancelSession?: { hash: string } };
        try {
            if (d.__mlSessionSend) {
                const hash = String(d.__mlSessionSend.hash);
                const rawText = String(d.__mlSessionSend.text || "");
                const images = Array.isArray(d.__mlSessionSend.images) ? d.__mlSessionSend.images : undefined;
                // Right-click "Add to current run" carries an element context — fold it into the message the
                // same way a fresh "ask about this" run does (askAboutTask), so an appended turn/steer gets the
                // element's clean content + selector. An element-only send (no typed text) is then non-empty.
                const ec = d.__mlSessionSend.elementContext;
                const text = (ec && typeof ec.selector === "string") ? askAboutTask(rawText, ec) : rawText;
                if (!text && !(images && images.length)) return;   // allow an image-only follow-up
                const h = handleRegistry.get(hash);
                // An AGENT handle holds live state: steer a RUNNING loop (say — text only, no image mid-steer),
                // else a new turn (run, which carries this turn's images).
                if (h) { if (h.running) h.say(text); else void h.run(text, images); return; }
                // No local handle — e.g. a HUD run that NAVIGATED (its page-side handle died with the old
                // document). If it re-adopted as a resumable BACKGROUND run (agentRegistry, keyed by hash),
                // continue it with a follow-up TURN rather than dropping the message into the chat path.
                const bg = agentRegistry.get(hash);
                if (bg) {
                    emitDebug({ kind: "agent-say", id: hash, ts: Date.now(), save: false, session: { hash, turn: 0 }, text });
                    void bg.resume(text);
                    return;
                }
                // Otherwise it's a plain chat session — continue the conversation with another turn.
                void continueChatSession(hash, text, images);
                return;
            }
            if (d.__mlCancelSession) {
                const hash = String(d.__mlCancelSession.hash);
                const h = handleRegistry.get(hash);
                if (h) { h.cancel(); return; }   // agent loop hosted on THIS page
                // No local handle — a HUD/cross-page run that NAVIGATED (its page-side handle died with the old
                // document) and re-adopted as a resumable BACKGROUND run (agentRegistry). Relay CANCEL_RUN so the
                // background aborts the run's OWN controller AND resolves any open approval gate (mirrors the
                // __mlSessionSend agentRegistry fallback). Without this, the composer's Stop button was inert
                // cross-page — the run stayed stuck "waiting for your approval…" with no way to cancel it.
                if (agentRegistry.has(hash)) { window.postMessage({ type: "CANCEL_RUN_REQUEST", payload: { runId: hash } }, "*"); return; }
                chatInflight.get(hash)?.abort();  // chat turn started from the composer
                return;
            }
        } catch (err) { console.error("ml: session composer action failed:", err); }
    });

    // Readiness signal for scripts (e.g. userscripts) that may run before this
    // one injects. Resolves immediately since window.ml is fully synchronous:
    //   const ml = await (window.ml?.ready
    //       ?? new Promise(r => addEventListener("ml:ready", () => r(window.ml), { once: true })));
    window.ml.ready = Promise.resolve(window.ml);
    window.dispatchEvent(new Event("ml:ready"));

    console.log("🟢 window.ml is ready.");
})();
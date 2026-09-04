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
    TablePreview,
    ServerToolResult
} from "./contract";
import { detectGroundingModel, DEFAULT_GROUNDING_RANGE, outputCapEscalated } from "./contract";
import { evalReadonly } from "./readonly-exec";
import { expandPointers } from "./pointer-macro";   // `@tool:` → a real dereference call, before the dialect sees it
import { htmlToMarkdown } from "./html-to-md";
import { runPipe, mlPipe, pipeHint, PIPE_SYNTAX } from "./text-pipe";
import { truncate, errText, elPath, describeSkeleton, queryAll, selectorError, extractTable, castTableColumns, googleSheetCsvUrl, googleSheetId, externalSheetIds, parseCsv, nonEmptyTables, classifyOverlay, setPierceClosedShadow, viewportRect, isElement, navTarget, clipOut, askReaderNumCtx, jsonShape, joinShapes, jsonValue, shadowHostReport, clickSelector, elLine } from "./dom";
import { makeAnswerFacade, finalizeAnswer, resolveOutputs } from "./answer-set";
import { isSelfSourceUrl } from "./self-source";
import { BUILD_INFO } from "./build-info.gen";
import { accessibleName, roleOf, ariaState } from "./a11y";
import { AGENT_SYSTEM, VISION_CLAUSE, ANSWER_CLAUSE, TOOLTOKENS_CLAUSE, DEREF_CLAUSE, WAIT_CLAUSE, SHADOW_CLAUSE, SHADOW_CLOSED_NOTE, SHADOW_CLOSED_PIERCE_NOTE, SHADOW_EXEC_NOTE, IFRAME_CLAUSE, SELF_CLAUSE, HUD_HINT, HUD_PROSE_PROGRESS, HUD_PROSE_QUIET, PYTHON_CLAUSE, EXEC_COMPUTE_CLAUSE, EXEC_RANGE_CLAUSE, NAV_OFF_CLAUSE, UNATTENDED_CLAUSE, UNATTENDED_REFUSAL, UNATTENDED_EXEC_NOTE, UNATTENDED_PY_NOTE, askAboutTask } from "./prompts";
import { pageContext, cropDataUrl, MIN_SHOT_PX, POINT_RE, resolvePoint, markSeen, PT_LOOK_RADIUS, BOX_RE, resolveBox, agentState, mlRange } from "./util";
import type { DerefValue, ShotBox, ServerTool, OllamaInfo, VisionMemory, RebuildConfig, AnswerMedia, MlAnswer } from "./contract";
import { annotate, pickAccentColorForTarget } from "./locate";
import { suspiciousArgsWarning, suspiciousChars } from "./security";
import { emitDebug, debugId, shortHash, sessionRegistry, agentRegistry, handleRegistry, enterAgentRun, exitAgentRun, resetSubcallUsage, subcallUsage } from "./bus";
import { makeDomTools, buildDereferenceTool } from "./tools";
import { pipeStages, TokenStore, type DerefRead } from "./token-pipe";
import { Embedding } from "./embedding";
import { toolNameError } from "./token-id";
import { hideSidebarForShot, makeBackgroundTaskPromise, makeChatRequest, makeStreamingTaskPromise } from "./bridge";
import { validateArgs, validateExtend } from "./validate";
import { makeDynamicTools } from "./dynamic-tools";
import type { DynamicToolNamespace } from "./dynamic-tools";
import { renderArgs, logStep, defaultApprove, normalizeApproval, formatReadonlyExec } from "./approval";
import { buildServerTools, buildLookTool, buildLocateTool, buildClickTool, buildTypeTool, buildPythonTool, targetRender, captureVerify, lookViews, BOX_OVER_TEXT_TIP, VIEWS_PARAM, legendFor, setCdpEnabled } from "./builtin-tools";
import { pyVarNameError } from "./python-env";
import { autoApprovePython } from "./auto-approve";
import { executeTool, toolContext, currentAnswer, currentDeref, currentServerAllow } from "./tool-exec";
import { runAgentLoop, shotTurnMessage, CITABLE_TOOLS } from "./agent-loop";
import type { AgentLoopDeps } from "./agent-loop";
import { installToolDelegation, registerRun, endRun, runAnswer } from "./run-delegation";
import { descriptorFor } from "./render-descriptor";
import { AgentHandle, sameOriginNav, sameOriginFetch, DerefText } from "./ml-agent";   // run-control object (createAgent/agent) + page-loop same-origin auto-approve predicates
import type { AgentControl } from "./ml-agent";

/** One resolved `python_exec` table source: its var name, provenance, and the payload the sandbox
 *  builds a DataFrame from (rows or read_html html). Internal to injected.ts. */
/** ONE session for every `ml.embed()` on this page, created lazily. Embedding is usually done in a loop, so
 *  a session per call would flood the list with one-turn entries; a single accumulating session keeps the
 *  spans on the lane without burying everything else. */
let _embedHash: string | null = null;
let _embedTurn = 0;
const embedSession = () => ({ hash: (_embedHash ||= `embed${Math.random().toString(16).slice(2, 8)}`), turn: _embedTurn });
const embedTurn = () => ++_embedTurn;

type LoadedTable = { name: string; source: TableSource; data: { kind: "rows"; columns: string[]; rows: (string | number | null)[][] } | { kind: "html"; html: string } };

(function() {

    // Spreadsheets the user has approved `python_exec` access to THIS page session (keyed by
    // Google spreadsheet id). Lets a repeat call to the same sheet skip the external-sheet
    // re-prompt. Page-scoped (module lifetime) — gone on reload; never persisted.
    const approvedSheets = new Set<string>();   // spreadsheets the user OK'd this page-session

    // Results of successful `ml.fetch(url)` calls, keyed by URL. Populated when a fetch resolves (the fetch
    // itself was already approved/consented to reach the background), so a follow-up READONLY `exec` that
    // re-reads the same URL gets the cached result with NO approval — the `_fetchCached` reader the read-only
    // dialect's `ml.fetch` is bound to. The python_exec+Google-Sheet parallel: approve the source ONCE, then
    // operate on it freely. Page-scoped (module lifetime); holds only public, uncredentialed, non-rendered bytes
    // (a credentialed / rendered fetch is authenticated or session-bound → NEVER cached).
    const mlFetchCache = new Map<string, import("./contract").FetchResult>();

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
        /** The CURRENT run's user-facing answer set — a run-bound collection (add/remove/clear/length/dump).
         *  A GETTER, so it always targets the run whose tool is executing; from the console outside a run it
         *  THROWS (a clear message beats a baffling failure on the next `.add`). Free to curate from `exec`. */
        get answer(): MlAnswer {
            const set = currentAnswer();
            if (!set) throw new Error("ml.answer is only live inside an ml.agent run (it curates that run's user-facing answer).");
            return makeAnswerFacade(set, elLine);
        },
        /**
         * Read a `@tool:<id>` pointer — an output THIS run already produced — instead of re-running the tool
         * that made it, or retyping a value. Reaches the FULL capture, not the truncated copy the model was
         * shown, so it can recover data that is otherwise unreachable.
         *
         * Run-bound like `ml.answer`: it resolves against the run whose tool is currently executing, so it is
         * live inside an approved `exec` and THROWS from a page's own console (there is no run, so there is no
         * store). The binding is what scopes it, not a permission check.
         *
         * ```js
         *   const rows = JSON.parse(await ml.dereference("@tool:a1b2c3", { pipe: ".rows" }));
         *   rows.filter(r => r[2] > 100).length
         * ```
         *
         * WHY THIS IS ASYNC, since the page path does not need it: when the run is PAGE-hosted the resolver
         * behind this is synchronous — a pure read of in-memory run state — and the await is ceremony. It is
         * async for the BACKGROUND-hosted path (design A, the default whenever a debug surface is open),
         * where the pointer store lives in the service worker and the read is a postMessage round trip. The
         * signature cannot vary by host: the same call must work either way, and returning a value in one
         * case and a promise in the other would be an invisible footgun. The cost lands in the READ-ONLY exec
         * dialect, whose evaluator is a generator precisely because every ml method is async — its `runSync`
         * driver (for arrows a host method invokes) throws NotInDialect on an await, so
         * `ids.map(id => ml.dereference(id))` inside a read-only survey falls through to approval.
         *
         * @param ref A pointer: `@tool:<id>`, the bare id, or a builtin's name for its latest call. `:in` reads
         *            the call/arguments instead of the result.
         * @param options `pipe` reduces the value first — the text-pipe dialect as a string
         *                (`".rows | head 5"`, split on unquoted `|`), or as an ARRAY with one stage per entry
         *                (`[".rows", "head 5"]`), which is never re-split. Reach for the array when a stage
         *                contains a `|` — `["grep -E error|warn"]` needs no quoting, where the string form
         *                needs `"grep -E 'error|warn'"`. (Quoting an argument with SPACES is unchanged in
         *                both forms: `grep -i 'pricing plan'`.)
         * @returns The value, reduced by the pipe. Rejects with an actionable message when the pointer doesn't
         *          exist (a MemoryFault naming the nearest real pointers) or a pipe stage is wrong.
         */
        dereference: async function(ref: string, { pipe = null }: { pipe?: string | string[] | null } = {}): Promise<DerefValue> {
            const fn = currentDeref();
            if (!fn) throw new Error("ml.dereference is only live inside an ml.agent run (it reads that run's captured tool outputs).");
            // STAGES cross the boundary, not a joined string — a stage may hold a bare `|` (see pipeStages).
            const read = await fn(String(ref ?? ""), pipeStages(pipe));
            // The advisory goes to console, NOT into the return value — this result is about to be parsed,
            // split or piped by the calling script, and exec captures console output into the step's result
            // and its live stream, so the warning still reaches the model without touching the data.
            if (read.warning) { try { console.warn(read.warning); } catch { /* no console in this realm */ } }
            // A String subclass, so every previous spelling still works while `.type`/`.json`/`.table`
            // answer what the caller used to have to sniff out of the bytes. `.pipe()` re-reads the SAME
            // pointer with more stages rather than piping the text it already holds — the store keeps the
            // fuller capture, so going back to it can return more than this text has.
            // Always a promise here: a `pipe` re-read cannot be pre-resolved (the stages are only known now),
            // so the sync path in `exec` deliberately falls through to this one. Wrapped so the type is the
            // promise it actually is rather than the union the declaration allows.
            const again = (stages: string | string[]): Promise<DerefValue> => Promise.resolve(window.ml.dereference(ref, { pipe: stages }));
            return new DerefText(read.value, read.meta, again);
        },
        /**
         * The TypeScript-like type of some JSON — one document, or the JOINED type of several.
         *
         * ```js
         *   ml.schema(r.json)                                   // one document's shape
         *   await ml.schema(ml.dereference(a), ml.dereference(b))   // the type that covers both
         * ```
         *
         * Instances of the same thing collapse into one object whose sometimes-present keys become
         * optional; genuinely different things stay a union, since merging them would describe an object
         * that never existed. Arguments are AWAITED, so pointer reads can be passed straight in without
         * an await each. A JSON string is parsed; prose is refused rather than shaped, because there is
         * no honest type for it.
         *
         * @param values The documents. One value = its own shape; several = the joined type.
         * @returns The TS-like shape.
         */
        schema: async function(...values: unknown[]): Promise<string> {
            const vs = await Promise.all(values);
            if (!vs.length) throw new Error("ml.schema needs at least one value — pass a JSON value, a JSON string, a fetch result, or a pointer read.");
            const label = (i: number) => vs.length === 1 ? "the argument" : `argument ${i + 1}`;
            return joinShapes(vs.map((v, i) => jsonValue(v, label(i))));
        },
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
            // The name goes into a `@tool:<name>` reference bare, so it has to be shaped like one — and must
            // not look like a generated id, which is what keeps the three reference forms tellable apart.
            // Thrown at DEFINITION time: a custom tool with an unusable name should fail where it is written,
            // not silently become uncitable halfway through a run.
            const nameErr = toolNameError(name);
            if (nameErr) throw new Error(`ml.defineTool: ${nameErr}`);
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
        agent: async function(task: string, { tools = null, extraTools = [], serverTools = [], commanderTools = false, system = null, hints = null, maxSteps = 10, model = null, think = null, approve = defaultApprove, onStep = null, env = true, vision = null, logDebug = false, signal = null, resume = null, silent = false, unattended = false, navigate = true, crossOrigin = false, approvalRouting = "ui", stream = false, toolTokens = false, images = [], _control = null }: {
            tools?: MlTool[] | null;
            extraTools?: MlTool[];
            serverTools?: string[];
            /** HUD-only: also give this run the server-tool bundles marked always-present in Settings. A run
             *  driven from the Commander bar has no code to name one; a scripted call said what it wanted. */
            commanderTools?: boolean;
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
            stream?: boolean;   // STREAM the model's thinking/reply live (agent-stream deltas) so a long reasoning phase isn't a frozen token count. Default false.
            toolTokens?: boolean;   // surface `@tool:<id>` on rich tool results so the model can cite exact outputs. Default false; HUD auto-on.
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
                        token: { type: ["boolean", "string"], description: "Keep a handle to this call's output. `true`, or better a SHORT LABEL for yourself (\"the pricing table\") — the label is how you'll recognise it a dozen steps later, and you can find it by that name. The result then ends with an @tool:<id>: embed it in your answer with `![caption](@tool:<id>:out)`, and/or read it back with `dereference`. Opt in whenever the output is worth keeping — to show OR to reuse; off for exploratory steps." } } } }
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
                driverSees, visionModel: runVisionModel, hints: hints || null, silent: silent || undefined, unattended: unattended || undefined,
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
            // `ml.dereference` inside an approved exec: the loop hands its pointer resolver to `tokenSink`
            // below, and this closure is what the ToolContext binds — so the primitive is live only while a
            // tool of THIS run is executing (see tool-exec's activeDeref), and resolves against this run.
            let pageDeref: ((ref: string, pipe?: string | string[]) => DerefRead) | null = null;
            toolCtx.deref = async (ref, pipe) => {
                if (!pageDeref) throw new Error("This run has no captured outputs yet.");
                return pageDeref(ref, pipe);
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
                        const ro = await evalReadonly(roSrc, document, this, makeAnswerFacade(answerSet, elLine));
                        const { result, elements } = formatReadonlyExec(ro.value, ro.logs);
                        const { in: renderIn, out: renderOut } = descriptorFor(byName[name], { result, elements }, args);
                        // Cached ml.fetch URLs this survey re-read → a "reused a grant you approved" note (transparency).
                        const urls = [...new Set(ro.reused)];
                        const reused = urls.length ? urls.map(u => ({ kind: "fetch-url" as const, detail: u })) : undefined;
                        return { result, elements, renderIn, renderOut, reused };
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
                answerSet.clear();   // the answer set reflects THIS turn's designations only
                enterAgentRun();   // suppress orphan chat sessions from a tool's internal ml.chat; finally-decremented
                try {
                    const r = await runAgentLoop(t, { tools: toolMetas, maxSteps: () => control.maxSteps, signal, unattended, toolTokens, runHash, seqBase: control.seqBase, stream, tokenStore: (control.tokens ??= new TokenStore()), labelMatch, tokenSink: (fn) => { pageDeref = fn; } }, deps);
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
                        verify: { type: "string", enum: ["viewport", "text", "text-all"], description: "Fold a view of the DESTINATION page into the result (saves a `wait`+`look`/`fetch` turn to see where you landed). \"viewport\" = a SCREENSHOT (an inline look); \"text\" = the page distilled to clean Markdown (nav/chrome stripped — cheaper, no vision needed); \"text-all\" = the same Markdown but keeping nav/header/footer. Omit to skip." },
                        pipe: { type: "string", description: "Optional, only with verify:\"text\"/\"text-all\". Scan/filter the destination page's Markdown before it reaches you — e.g. \"grep -i '^## ' | head\" to see just the headings of where you landed. " + PIPE_SYNTAX },
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
         * Build the `fetch_url` tool: GET a URL's content via the background so the agent can READ a
         * file/API/other page WITHOUT navigating there. Uncredentialed by default; `credentials` fetches in the
         * user's session and `rendered` loads it in a tab so its JS runs (see the tool description).
         * requiresApproval — a new URL hits the unforgeable gate; an already-approved one auto-approves.
         * Auto-wired into ml.agent unless `fetch: false`.
         *
         * @returns {MlTool} A tool with `name: "fetch_url"` and `requiresApproval: true`.
         */
        fetchTool: function(): MlTool {
            const ml = this;
            // Char budget for the ASK-mode reader sub-call: enough to fit a typical utility-model context
            // window (~6k tokens) with room for the question + answer; a larger body is clipped (and flagged).
            const FETCH_ASK_MAX = 24000;
            return ml.defineTool({
                name: "fetch_url",
                requiresApproval: true,   // a NEW url hits the unforgeable gate; an approved one auto-approves (autoApprove)
                summary: "Fetches a URL's content (GET) to read a file/API the page can't; optional as-you / rendered modes.",
                description: "GET a URL's content via the extension — bypasses CORS, and by default sends NO cookies. Use it to " +
                    "READ a raw file, a JSON API, or another site WITHOUT navigating there (also works on pages " +
                    "that block the extension, e.g. raw.githubusercontent.com). The result reports the body plus a " +
                    "best-effort TYPE (json/csv/html/xml/markdown/code/text) so you can chain — JSON comes " +
                    "pre-parsed, hand a CSV to python_exec, a code file names its language. The type is a HEURISTIC " +
                    "(resolved from the Content-Type header, a content sniff, and the URL extension — a server can " +
                    "mislabel), not authoritative. GET only (no headers/body/auth). Each NEW url is approved once by " +
                    "the user, then remembered for the session. Prefer this over `navigate` when you only need to READ a URL. " +
                    "Set `schema: true` when you KNOW it returns JSON and only need the STRUCTURE — you get a compact " +
                    "TS-like shape (`{ id: number, items: { name: string }[] }`) instead of the whole payload (and a " +
                    "clear error, saying what it actually was, if it isn't JSON). " +
                    "Set `credentials: true` to fetch AS THE USER (sends their cookies) — for AUTHENTICATED data (a " +
                    "private gist, a logged-in dashboard's API). It ALWAYS asks the user (never remembered) and is " +
                    "never cached; use it ONLY when public access won't do. " +
                    "Set `rendered: true` when a plain GET returns an EMPTY / skeleton page because the content is " +
                    "drawn by JavaScript (a client-rendered SPA, an infinite-scroll feed's first screen): it opens the " +
                    "URL in a background tab so the page's JS runs, then returns the SETTLED DOM — with cookie/consent/ad " +
                    "overlays heuristically stripped. It renders in an INCOGNITO tab (NO session/cookies — a safe read), " +
                    "so a SAME-ORIGIN render is FREE (no prompt, like a same-origin navigate) and a cross-origin one asks " +
                    "once then is remembered (both need the extension's 'Allow in Incognito' setting on — you'll get a " +
                    "clear message if it's off). ADD `credentials: true` to render in the USER'S logged-in SESSION instead " +
                    "(a normal tab that carries their cookies — for a page that only shows content when signed in); that " +
                    "runs as-the-user so it ALWAYS re-asks, same-origin or not, and is never remembered. " +
                    "Either way it's slower/heavier than a raw GET; reach for it only when the raw fetch's HTML is clearly " +
                    "unrendered. It waits for the page to settle (not a fixed delay) and scrolls to trip lazy content; a few " +
                    "widgets that only load when signed-in or focused/visible may still not appear in a background render " +
                    "(credentials:true covers signed-in; enabling CDP in settings lets it emulate foreground). Never cached. " +
                    "Set `ask: \"<question>\"` to have a fast reader model READ the fetched content and answer that " +
                    "question — you get back the ANSWER, not the (possibly huge) body, so a big page/API never floods " +
                    "your context. Use it when you need a FACT out of the content, not the raw bytes to process further. " +
                    "An HTML page is auto-converted to clean Markdown (scripts/nav/chrome stripped) so you get the " +
                    "readable content, not tag soup. Better still, many docs sites PUBLISH their own Markdown version of a page — " +
                    "this NEGOTIATES for it (asking the server, then following any version the page declares, then a " +
                    "conventional `.md` URL) and falls back to converting the HTML itself, so you usually get the site's " +
                    "authored text rather than our reduction of its markup. Set `format: \"html\"` if you specifically " +
                    "need the original markup and no negotiation. " +
                    "**NOTE:** When a user asks you to get information from a user-facing HTML page, assume the user " +
                    "wants you to actually navigate them to a page by default so that they see the information themselves. " +
                    "You can still use this tool to fetch the information for your own usage, but navigate the user so that " +
                    "they have parity to you. Only when the prompt is clearly indicative of a programmatic lookup or the user " +
                    "clearly does not want to see your work should you use this tool without updating the user's web browser view " +
                    "(e.g. querying an API to locate the target in the background before navigating the user, or answering a question " +
                    "that does not indicate the user would like to see the page/information off the page themselves). Users most " +
                    "likely do NOT want to see raw text documents or JSON, but generally MAY be interested to see user-facing HTML " +
                    "pages.",
                parameters: {
                    type: "object",
                    properties: {
                        url: { type: "string", description: "The absolute http(s) URL to fetch." },
                        schema: { type: "boolean", description: "If true, return a compact TS-like SHAPE of the JSON (not the body). Errors if the URL isn't JSON." },
                        credentials: { type: "boolean", description: "If true, fetch AS THE USER (send their cookies) for authenticated data. Always prompts; never cached/remembered." },
                        rendered: { type: "boolean", description: "If true, load the URL in a background tab so its JavaScript runs, then return the SETTLED DOM — for client-rendered/SPA pages a raw GET returns empty. Renders in INCOGNITO (no session/cookies): same-origin is FREE, cross-origin asks once then remembered (needs 'Allow in Incognito'). Add credentials:true to render in the user's SESSION (a normal tab with cookies) — always re-asks. Slower/heavier; never cached." },
                        ask: { type: "string", description: "If set, a fast reader model reads the fetched content and answers THIS question; you get the answer, not the body (keeps a large page out of your context). Takes precedence over `schema`." },
                        format: { type: "string", enum: ["markdown", "html"], description: "What DOCUMENT to fetch. \"markdown\" (default) negotiates for the site's own Markdown version of the page and falls back to converting its HTML. \"html\" returns the ORIGINAL markup in one plain request, no negotiation — for when you need the markup itself (a selector, an attribute, an embedded script). Data bodies (JSON/CSV/code) are unaffected either way." },
                        pipe: { type: "string", description: "Optional. SCAN/FILTER the returned text through a small shell-style pipeline BEFORE it reaches you — so you read only the relevant lines instead of the whole doc (cheaper). " + PIPE_SYNTAX + " For anything MORE COMPLEX than this dialect, use exec instead: `const { markdown } = await ml.fetch('<the url>');` then process that string with JS." },
                    },
                    required: ["url"],
                },
                // Show the URL in the approval card + the In render (an `action` render → "fetch <url>"). The
                // note flags the SCHEMA-only ask, and — importantly for consent — a CREDENTIALED (as-you) fetch.
                render: (_input: unknown, args?: Record<string, unknown>): RenderDescriptor => {
                    const a = args as { url?: unknown; schema?: unknown; credentials?: unknown; rendered?: unknown; ask?: unknown; pipe?: unknown } | undefined;
                    const note = a?.rendered ? (a?.credentials ? "rendered in your session (runs the page's JS)" : "rendered privately (incognito — no cookies, runs the page's JS)") : a?.credentials ? "as you (sends your cookies)" : a?.schema ? "schema only" : a?.ask ? undefined : "full page";
                    // The ASK gets its OWN line (full text, never truncated), not squeezed into the inline note.
                    const ask = (typeof a?.ask === "string" && a.ask.trim()) ? a.ask.trim() : undefined;
                    const pipe = (typeof a?.pipe === "string" && a.pipe.trim()) ? a.pipe.trim() : undefined;
                    return { type: "action", verb: "fetch", target: String(a?.url ?? ""), ...(note ? { note } : {}), ...(ask ? { ask } : {}), ...(pipe ? { pipe } : {}) };
                },
                run: async ({ url, schema = false, credentials = false, rendered = false, ask = null, format = "markdown", pipe = null }: { url?: unknown; schema?: boolean; credentials?: boolean; rendered?: boolean; ask?: unknown; format?: unknown; pipe?: unknown } = {}, ctx?: import("./contract").ToolContext): Promise<string | ToolResult> => {
                    if (typeof url !== "string" || !url.trim()) return "Error: fetch_url needs a `url`.";
                    let r: import("./contract").FetchResult;
                    const wantHtml = format === "html";
                    try { r = await ml.fetch(url, { credentials, rendered, format: wantHtml ? "html" : "markdown" }); }
                    catch (e) { return `Error: ${errText(e)}`; }
                    const mislabel = r.typeByHeader && r.typeByHeader !== r.type ? ` (header said "${r.typeByHeader}")` : "";
                    const head = `Fetched ${r.url} — HTTP ${r.status}, type: ${r.type}${r.language ? ` (${r.language})` : ""}${mislabel}${r.truncated ? " · body truncated" : ""}.`;
                    // HTML → Markdown by DEFAULT (readability): an HTML page is mostly slop (scripts/nav/chrome) to a
                    // reading model, so distil it unless `raw` is set. Only HTML — json/csv/code/text/markdown are
                    // already clean. Applies to BOTH the normal view and the ask-mode reader input.
                    const converted = r.type === "html" && !wantHtml && !schema && r.json === undefined;
                    // Say WHOSE Markdown this is. The site's own is authored for reading and is the better text;
                    // ours is a reduction of the page's markup with nav/header/footer stripped. A model that
                    // can't tell them apart can't judge whether a missing detail was never there or was cut.
                    const by = r.negotiation?.resolvedBy;
                    const mdNote = converted
                        ? "\n\n(This page was HTML; the tool converted it to Markdown itself for readability — nav/header/footer stripped. Re-run with \"format\": \"html\" for the original markup.)"
                        : (by === "accept" || by === "declared" || by === "sibling")
                        ? `\n\n(This is the SITE'S OWN Markdown version of the page${by === "declared" ? ", the one it declares for agents" : by === "sibling" ? ", from its .md URL" : ", served by content negotiation"} — authored text, not our conversion of the HTML. Re-run with "format": "html" for the original markup.)`
                        : "";
                    // The body to read/return: converted Markdown for HTML (unless raw), else the JSON/raw text.
                    // ml.fetch already attached `.markdown` for HTML; reuse it (fall back to a fresh conversion).
                    const bodyText = (): string => r.json !== undefined ? JSON.stringify(r.json, null, 2) : (converted ? (r.markdown ?? htmlToMarkdown(r.text)) : r.text);
                    // `pipe`: SCAN/FILTER the body through the safe line-scanning dialect (PIPE_CMDS). Applied to
                    // BOTH the default view AND (BEFORE) the ask-reader input, so both see the filtered stream. Pure
                    // text; on a bad command it returns { err } → an actionable message pointing at the exec escape
                    // hatch. The FOOTER states the result's size (lines / chars, vs source) so the model has a
                    // reference for what it's operating on. `pipeStr` is the trimmed pipe (falsy = no pipe).
                    const pipeStr = typeof pipe === "string" && pipe.trim() ? pipe.trim() : "";
                    /** ONE In descriptor for every return path, so no path can quietly drop a field. It used to
                     *  be built per-path, which is why a credentialed PIPED fetch lost its "as you" note. Carries
                     *  the Markdown ladder's trace when negotiation ran — the sidebar draws it as a resolution
                     *  tree, and the export mirrors it. */
                    const inRender = (extra: Record<string, unknown> = {}): RenderDescriptor => ({
                        type: "action", verb: "fetch", target: r.url,
                        ...(credentials ? { note: "as you (sends your cookies)" } : rendered ? { note: "rendered (ran the page's JS)" } : {}),
                        ...(pipeStr ? { pipe: pipeStr } : {}),
                        ...(r.negotiation ? { attempts: r.negotiation.attempts, resolvedBy: r.negotiation.resolvedBy } : {}),
                        ...extra,
                    } as RenderDescriptor);
                    const nlines = (s: string): number => s === "" ? 0 : s.replace(/\n$/, "").split("\n").length;
                    const doPipe = (src: string): { text: string; footer: string; err?: string } => {
                        if (!pipeStr) return { text: src, footer: "" };
                        let out: string;
                        try { out = runPipe(src, pipeStr); }
                        // The exec escape-hatch hint only makes sense when `exec` is actually wired this run — gate it.
                        catch (e) { const escape = ctx?.hasTool("exec") ? ` For anything more complex, use exec: \`const { markdown } = await ml.fetch(${JSON.stringify(r.url)});\` then process the string in JS.` : ""; return { text: src, footer: "", err: `${head}\n\nPipe error: ${errText(e)}${pipeHint(errText(e))}${escape}` }; }
                        // Minified source (essentially one line, but large) → line tools can't split it usefully. This
                        // is the RAW-HTML footgun: grep/head over a one-line minified page is near-useless. Nudge to
                        // drop raw:true (the default HTML→Markdown lines up cleanly) or otherwise reformat first.
                        const srcLines = nlines(src);
                        const minified = srcLines <= 2 && src.length > 800;
                        const warn = minified ? ` — ⚠ the source is ${srcLines} line${srcLines === 1 ? "" : "s"} (minified?), so line tools couldn't split it${r.type === "html" && wantHtml ? "; drop \"format\": \"html\" to pipe the clean Markdown instead" : ""}` : "";
                        return { text: out, footer: `\n\n(piped through \`${pipeStr}\`: ${nlines(out)} lines, ${out.length.toLocaleString()} chars — filtered from ${srcLines} source lines${warn})` };
                    };
                    // ASK mode: distill the body through a fast reader model (extend:"utility") instead of returning
                    // it — a large page/API answers a question without ever entering the driver's context (the
                    // look/read delegate-and-distill pattern, for text). Metered as a sub-call (runs under inAgentRun).
                    if (typeof ask === "string" && ask.trim()) {
                        const question = ask.trim();
                        // pipe FIRST (if set): the reader answers over the FILTERED stream, not the whole page.
                        const pp = doPipe(bodyText());
                        if (pp.err) return pp.err;
                        const body = pp.text;
                        const clipped = clipOut(body, FETCH_ASK_MAX);
                        const cut = clipped.length < body.length;
                        // Tell the reader the content is a PIPE-PROCESSED partial view (so it doesn't assume it's the
                        // whole page / treats a missing detail as "filtered out", not "absent from the source").
                        const pipeForReader = pipeStr ? ` — PRE-FILTERED through the shell pipe \`${pipeStr}\`, so this is a PARTIAL view of the page, not the whole document` : "";
                        const beforeU = subcallUsage();   // the reader sub-call's cost (model + tokens) for the render
                        let answer: string;
                        try {
                            answer = await ml.chat(
                                `Content fetched from ${r.url} (${r.type}, HTTP ${r.status}${pipeForReader}${cut ? ", truncated" : ""}):\n\n${clipped}\n\n---\nUsing ONLY the content above, answer concisely. If the answer isn't present in it, say so plainly.\n\nQuestion: ${question}`,
                                // A summariser needs a window sized to the content, not the tiny utility default —
                                // else Ollama silently drops the top of a big page. Residency guard reuses a bigger
                                // resident model for free (see background prepareRequest); only a fresh load is bounded.
                                { extend: "utility", numCtx: askReaderNumCtx(clipped.length) },
                            ) as string;
                        } catch (e) { return `${head}\n\nError reading the content to answer: ${errText(e)}`; }
                        // Which model answered + how many tokens it spent — the subcallUsage DELTA around the chat
                        // (metered in bus.ts while inAgentRun). Best-effort: 0/unknown just omits that render line.
                        const afterU = subcallUsage();
                        const tokens = (afterU.prompt - beforeU.prompt) + (afterU.completion - beforeU.completion);
                        const prevCalls = new Map((beforeU.byModel || []).map(m => [m.model, m.calls]));
                        const answeredBy = (afterU.byModel || []).find(m => (m.calls - (prevCalls.get(m.model) || 0)) > 0)?.model || null;
                        const content = `${head}\n\nAnswer${cut ? " (the content was truncated before reading — it may be incomplete)" : ""}:\n${answer}${mdNote}${pp.footer}`;
                        const renderIn: RenderDescriptor = inRender({
                            ask: question,
                            ...(answeredBy ? { answeredBy } : {}), ...(tokens > 0 ? { tokens } : {}),
                            // The content handed to the reader — the in-the-middle step, so the distill is auditable
                            // (like locate's per-substep prompt). JSON is highlighted; a converted HTML page shows as
                            // the Markdown the reader actually saw, not the original tag soup.
                            askBody: clipped, askBodyLang: r.json !== undefined ? "json" : converted ? "markdown" : "text",
                            ...(cut ? { askBodyTruncated: true } : {}),
                        });
                        return { content, renderIn };
                    }
                    // `schema: true` — the caller wants the JSON's STRUCTURE, not the body.
                    if (schema) {
                        if (r.json === undefined) {
                            // Not JSON (or unparseable / truncated) — tell the model what it ACTUALLY was so it can adjust.
                            const why = r.truncated ? "the body was too large to parse whole" : `it's ${r.type}, Content-Type: ${r.contentType || "(none)"}`;
                            return `Error: you asked for the JSON schema, but ${r.url} isn't JSON — ${why}${mislabel}. First bytes:\n\n${clipOut(r.text, 600)}`;
                        }
                        const sig = r.schema ?? jsonShape(r.json), rawJson = JSON.stringify(r.json, null, 2);
                        // If the shape is bigger than the payload itself (a tiny/flat object), just dump the JSON.
                        if (sig.length >= rawJson.length) return { content: `${head}\n\n${clipOut(rawJson, 4000)}\n\n(raw JSON shown — its schema would be larger than the object itself.)`, renderIn: inRender() };
                        return { content: `${head}\n\nJSON schema:\n${clipOut(sig, 4000)}`, renderIn: inRender() };
                    }
                    // Default: the body (HTML → Markdown unless raw), optionally scanned through `pipe` (which the
                    // model uses to filter a big doc to the relevant lines BEFORE the clip). For a LARGE json, prepend
                    // the shape so the structure survives the clip — but only when NOT piped (a piped body is already
                    // a filtered view) and the shape is actually SMALLER than the payload.
                    const pd = doPipe(bodyText());
                    if (pd.err) return pd.err;
                    const body = pd.text;
                    const shapeLine = (!pipeStr && r.json !== undefined && r.schema && (r.truncated || body.length > 600) && r.schema.length < body.length)
                        ? `JSON schema: ${r.schema}\n\n` : "";
                    // The pipe footer (size/lines) goes at the END, so the model has a reference for the doc it got.
                    const buildTool = (t: string): string => `${head}${mdNote}\n\n${shapeLine}${t}${pd.footer}`;
                    return { content: buildTool(clipOut(body, 4000)), renderIn: inRender() };
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
            setCdpEnabled(!!rebuild.cdp);
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
                        const { tokenRenders, ...resClean } = res;   // loop-internal — don't leak to the caller
                        const a = run ? runAnswer(run, res.summary) : { elements: [], media: [], answer: "" };
                    const outputs = resolveOutputs(a.answer, res.summary, tokenRenders || []);   // structured data → res.outputs (headless)
                        emitDebug({ kind: "agent-result", id: runId, ts: Date.now(), save: false, session: { hash: runId, turn: res.steps }, summary: res.summary, steps: res.steps, hitCap: !!res.hitCap, cancelled: !!res.cancelled, ...(a.media.length ? { answerMedia: a.media } : {}), ...(a.answer ? { answer: a.answer } : {}) });
                        return { ...resClean, elements: a.elements, ...(a.media.length ? { answerMedia: a.media } : {}), ...(a.answer ? { answer: a.answer } : {}), ...(outputs.length ? { outputs } : {}), hash: runId };
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
        pythonExec: async function(code: string, { image = null, mode = "readonly", margin = 0, tableRaw = false, tables = null, onStdout = undefined }: { image?: string | Element | null; mode?: "readonly" | "full"; margin?: number; tableRaw?: boolean; tables?: string | Element | Record<string, string | Element> | null; onStdout?: (chunk: string, ts?: number) => void } = {}): Promise<{ ok: boolean; value?: unknown; stdout: string; error?: string; inputImage?: string; inputTables?: TablePreview[]; imageBox?: ShotBox }> {
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
            // Args arrive off the wire as JSON, so `tables` can be any shape regardless of the declared type.
            // An ARRAY is neither documented form, but models write `tables: ["current"]` — the schema is a
            // `oneOf`, and wrapping a lone value in a list is an easy slip. A ONE-element array is unambiguous
            // (it IS the single source), so take it rather than burning a turn. More than one carries no NAMES,
            // which is the entire point of the map form, so say that — instead of letting Object.entries turn
            // the indices into "0"/"1" and reporting `"0" isn't a valid Python variable name`, a name the model
            // never wrote and could not act on (it retried the same call and looped).
            let tableArg: unknown = tables;
            if (Array.isArray(tableArg)) {
                if (tableArg.length === 0) tableArg = null;
                else if (tableArg.length === 1) tableArg = tableArg[0];
                else throw new Error(`pythonExec tables: got an array of ${tableArg.length} sources, which carries no variable NAMES — a list can't say what to call each DataFrame. Pass a MAP so each one has a name you can use in the code, e.g. {"sales": ${JSON.stringify(String(tableArg[0]))}, "targets": ${JSON.stringify(String(tableArg[1]))}}. For ONE table, pass the source string on its own and it loads as \`df\`.`);
            }
            if (tableArg != null) {
                if (typeof tableArg === "string" || (typeof Element !== "undefined" && tableArg instanceof Element)) specs.push({ name: "df", src: tableArg as string | Element });
                else if (typeof tableArg !== "object") throw new Error(`pythonExec tables: expected a source string or a {name: source} map, got ${typeof tableArg}.`);
                else for (const [name, src] of Object.entries(tableArg as Record<string, string>)) {
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
                { code, image: img, hardened: mode !== "full", stream: !!onStdout, tables: loaded.map((l, i) => ({ name: l.name, data: l.data, alias: typeof specs[i].src === "string" ? specs[i].src as string : null })) },
                undefined, null,
                // LIVE stdout (opt-in): each PYTHON_STREAM chunk for this run → onStdout (the tool's ctx.stream).
                onStdout ? { type: "PYTHON_STREAM", onProgress: (d) => onStdout(String((d as { chunk?: string }).chunk ?? ""), (d as { ts?: number }).ts) } : undefined) as { ok: boolean; value?: unknown; stdout: string; error?: string; table?: { columns: string[]; rows: (string | number | null)[][] }; render?: "latex" | "img" };
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
            let el: Element | undefined;
            if (typeof target === "string") {
                try { el = queryAll(target)[0]; }
                catch {
                    // Invalid CSS selector — almost always the model wrapped it in extra quotes ("table#sales"
                    // instead of table#sales), producing a raw, opaque querySelectorAll SyntaxError. ACCOMMODATE:
                    // strip surrounding quotes and retry; only if THAT still fails, give a clear, actionable error.
                    const bare = target.replace(/^\s*['"`]+|['"`]+\s*$/g, "").trim();
                    try { if (bare && bare !== target) el = queryAll(bare)[0]; } catch { /* still invalid */ }
                    if (!isElement(el)) throw new Error(`ml.pythonExec tables: "${target}" is not a valid CSS selector. Pass a BARE selector (e.g. \`#sales\` or \`table#sales\`), NOT a quoted string.`);
                }
            } else el = target;
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
                    // The SUBJECT for the content line — for a marked target, `shots[0].label` is a VIEW label
                    // ("with click-point box"), NOT a subject, which read as "Screenshot of the with click-point
                    // box". Name the target itself; the crop labels still appear in `multi`.
                    const subject = isMarked ? (isPoint ? `marked point ${selector!.trim()}` : `marked region ${selector!.trim()}`) : label;
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
                        content: `Screenshot of the ${subject}${multi} captured — shown to you in the next message.${pointTip}${overTextTip}${legend}`,
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
        // The screen-reader + actionable view of ONE element as a single object — the a11y/reference expertise
        // the interactives/findByText tools use, exposed as a read-only primitive so `exec` can COMPOSE its own
        // finder (blessed in the readonly dialect → a survey that uses it auto-approves). One call gives the role,
        // accessible name, aria state, and the stable `>>>` reference to hand click/type. All pure reads.
        a11y: (el: Element): { role: string; name: string; state: string; selector: string } =>
            ({ role: roleOf(el), name: accessibleName(el), state: ariaState(el), selector: clickSelector(el) }),
        // PRIVATE debug helper (underscore → not in agent_api_docs, the agent never learns of it): list every
        // shadow-root host + whether the tools can enter it — `{ open, pierced, sealed, empty, hosts }`, each host
        // `{ selector, tag, state }` with state open / pierced / sealed / empty. Call `ml._shadowRoots()` from the
        // console to see where the "N closed roots" pageInfo counts actually are (sealed = real barrier; empty =
        // unopened menu/emulated host, not a barrier). Temporary; keep it OUT of the public MlApi.
        _shadowRoots: function() { return shadowHostReport(document); },
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
         * The server-side tools, as a callable NAMESPACE: `ml.dynamicTools.<bundle>.<fn>(args)`.
         *
         * Namespaced by BUNDLE rather than flattened, because function names come from the server and two
         * bundles can both expose `search` — flattening would silently call the wrong one.
         *
         * Each callable carries its own contract: `.schema` is the function's JSON Schema and `.spec` the
         * whole declaration. That is the SAME object the call validates against, so what you inspect is
         * literally what checks your arguments rather than a second copy that can drift.
         *
         * Populated in two stages, because `window.ml` is defined synchronously at document_start and the
         * tool list needs a fetch. A Proxy dispatches by name immediately — a call works before any list has
         * arrived — and the real keys appear once `ml.serverTools()` has resolved, so tab-completion works
         * from then on. `await ml.dynamicTools.load()` forces that early.
         *
         * Same gate as {@link execServerTool}: privileged, so from an untrusted page it runs only a call an
         * agent run already approved. Inside a run, the loop narrows this to the tools that run whitelisted.
         */
        get dynamicTools(): DynamicToolNamespace {
            return (this._dynamicTools ||= makeDynamicTools(this as unknown as MlApi, undefined, currentServerAllow));
        },
        /**
         * Run ONE server-side tool ourselves, in our own loop, with the arguments we chose — as opposed to
         * `ml.chat`'s `toolIds`, which hands the whole loop to the model and gets back a finished answer.
         *
         * PRIVILEGED, and gated accordingly: the fetch spends the user's API key and the tool is
         * caller-chosen, so from an untrusted page this only runs a call an agent run already approved.
         * Needs the patched OpenWebUI (see docs/FORKED-BACKENDS.md); a stock one has no such endpoint.
         *
         * The two failure kinds are kept apart, because only one is something a model can act on. A tool
         * that THREW resolves with `ok: true` and an `error` on its result — a normal outcome to read and
         * react to. A stream that could not be read at all resolves with `ok: false` and a
         * `transportError`, which must never be reported to a model as a tool that returned nothing.
         *
         * @param {string} toolId The tool BUNDLE's id, as `ml.serverTools()` lists it.
         * @param {string} name The function within that bundle.
         * @param {object} [args] The function's arguments.
         * @param {object} [options]
         * @param {(text: string, ts?: number) => void} [options.onOutput] Live output as it is produced —
         *   `ts` is when the EXECUTOR produced it, not when we saw it.
         * @param {AbortSignal} [options.signal] Cancels the call; the executor sees the connection close.
         * @returns {Promise<ServerToolResult>} What the tool produced, and how long it took.
         */
        execServerTool: async function(
            toolId: string,
            name: string,
            args: Record<string, unknown> = {},
            options: { onOutput?: (text: string, ts?: number) => void; signal?: AbortSignal } = {},
        ): Promise<ServerToolResult> {
            const { onOutput, signal } = options;
            return makeBackgroundTaskPromise("SERVER_TOOL_REQUEST", "SERVER_TOOL_RESPONSE",
                { toolId, name, args, stream: !!onOutput }, undefined, signal,
                onOutput ? {
                    type: "SERVER_TOOL_STREAM",
                    onProgress: (d) => {
                        const f = (d as { frame?: { type?: string; text?: string } }).frame;
                        // Only OUTPUT frames are text. An `event` frame is structural — feeding it here is
                        // how UI plumbing ends up in something a model reads.
                        if (f?.type === "output") onOutput(String(f.text ?? ""), (d as { at?: number }).at);
                    },
                } : undefined) as Promise<ServerToolResult>;
        },
        /**
         * The machine's memory CAPACITY — per-device VRAM totals/free and system RAM, from Ollama's
         * `/api/info`. `ml.ps()` says what is RESIDENT; this says what there is room for, so together they
         * answer "will this model fit" and "what is using my box".
         *
         * Every figure is raw BYTES and BINARY (a card sold as 96GB reports 94.97 GiB) — render through
         * `formatBytes`, never a hand-rolled `/1e9`.
         *
         * Returns **null** when the route isn't available: only a patched Ollama behind an OpenWebUI with the
         * passthrough serves it, and everything else answers with the SPA's HTML. Treat null as "capacity
         * unknown", never as zero.
         *
         * @returns {Promise<OllamaInfo|null>} The machine's capacity, or null when undeterminable.
         */
        info: async function(): Promise<OllamaInfo | null> {
            return makeBackgroundTaskPromise("INFO_REQUEST", "INFO_RESPONSE", {});
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
        pipe: mlPipe,
        /**
         * Embed text with the configured embedding model — for comparing MEANING rather than spelling.
         *
         * Returns an {@link Embedding}: a UNIT vector, so `.dot(other)` is cosine similarity by construction
         * rather than by assumption. Pass an array to embed in ONE round trip (the modern Ollama endpoint
         * batches; the legacy one is a per-input fallback).
         *
         * ```js
         *   const [q, ...docs] = await ml.embed(["sales figures", "the Q3 table", "a screenshot"]);
         *   q.rank(docs.map((embedding, key) => ({ key, embedding })));   // most similar first
         * ```
         *
         * @param {string|string[]} input Text, or several strings embedded together.
         * @param {{model?: string}} [opts] Override the configured model. Vectors from DIFFERENT models are
         *        different geometries, so comparing across them throws rather than returning a meaningless number.
         * @returns {Promise<Embedding|Embedding[]>} One per input, in order.
         */
        embed: async function<T extends string | string[]>(input: T, opts?: { model?: string }): Promise<T extends string[] ? Embedding[] : Embedding> {
            const many = Array.isArray(input);
            const inputs = (many ? input as string[] : [input as string]).map(String);
            // An embed is a real model call: it occupies VRAM and takes time, and it emitted NOTHING — so an
            // embedding model's footprint moved on the memory trace with no event beside it to explain why.
            // Reported through the ordinary chat machinery so it needs no new event kind, and into ONE
            // session for the page rather than a session per call: embedding is usually done in a loop, and
            // a hundred one-turn sessions is a flood, not a record.
            const t0 = Date.now();
            const session = embedSession();
            const turn = embedTurn();
            emitDebug({ kind: "chat", id: session.hash, ts: t0, save: false, session, streaming: false, sessionKind: "embed",
                        // A real config, not null: an embed has no chat options to speak of, but every
                        // consumer of a session expects the shape.
                        config: { model: opts?.model || null, system: null, think: null, schema: false,
                                  toolIds: null, maxTokens: null, save: false } as never,
                        request: {
                model: opts?.model || null, extend: null,
                messages: [{ role: "user", content: `embed ${inputs.length} input${inputs.length === 1 ? "" : "s"}` }],
                images: null, toolIds: null, schema: false, think: null, maxTokens: null,
            } });
            const r = await makeBackgroundTaskPromise<{ model: string; vectors: number[][] }>(
                "EMBED_REQUEST", "EMBED_RESPONSE", { inputs, ...(opts?.model ? { model: opts.model } : {}) })
                .catch((e) => {
                    emitDebug({ kind: "chat-result", id: session.hash, ts: Date.now(), save: false, session,
                                content: `embed failed: ${String((e as Error)?.message || e)}`, model: opts?.model || null,
                                sources: null, structured: false, extend: null, reasoning: null, usage: null });
                    throw e;
                });
            // Wall clock only — the endpoint reports no eval timings and no token counts, so the span says
            // how long it took and claims nothing about how much it read.
            emitDebug({ kind: "chat-result", id: session.hash, ts: Date.now(), save: false, session,
                        content: `${r.vectors.length} vector${r.vectors.length === 1 ? "" : "s"} · ${r.vectors[0]?.length ?? 0} dimensions`,
                        // Token counts are UNKNOWN here — the endpoint reports none — so they are zero rather than invented,
                        // and `genBasis` says the rate is wall clock.
                        model: r.model || opts?.model || null, sources: null, structured: false, extend: null, reasoning: null,
                        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, genMs: Date.now() - t0 } });
            void turn;
            const out = r.vectors.map(v => Embedding.from(v));
            // The one cast a conditional return type always needs; the SHAPE is checked by the branch above.
            return (many ? out : out[0]) as T extends string[] ? Embedding[] : Embedding;
        },
        /**
         * GET a URL's content via the background worker — bypasses CORS (host permissions), and by DEFAULT sends
         * no cookies (uncredentialed; `credentials`/`rendered` opt in — see below). Use it to READ a page/file
         * the current DOM can't reach — a raw source file, a JSON API, another site — instead of NAVIGATING
         * there (which also dodges pages that block the extension, e.g. raw.githubusercontent.com's sandbox CSP).
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
         * Re-reading a URL you've already fetched is FREE: a SUCCESSFUL result is cached (page-lifetime), and a
         * read-only `exec` calling `ml.fetch(url)` on a cached URL returns it with no approval (only a NEW url
         * asks). Approve the source once, then operate on it — like `python_exec` on a Google Sheet. Failures
         * (non-2xx) are NOT cached, so a retry after the server recovers re-fetches. Pass `{ fresh: true }` to
         * SKIP the cache and force a fresh fetch (a real fetch → needs approval even for a cached url).
         *
         * `{ credentials: true }` fetches AS THE USER (sends their cookies) — for authenticated data (a private
         * gist, a logged-in dashboard's API). It's a powerful, gated primitive: it ALWAYS prompts (never
         * auto-approved, never remembered), is NEVER cached, and works only via the `fetch_url` tool (an
         * explicit, human-approved URL) — an inline credentialed `ml.fetch` in `exec` is refused.
         *
         * When the body is JSON, `.json` is the parsed value and `.schema` is a compact TS-like SHAPE of it
         * (`{ id: number, items: { name: string }[] }`) — the structure to write code against without holding
         * the whole payload. When the body is HTML, `.markdown` is a clean Markdown distillation (scripts, nav,
         * and page chrome stripped) — read that for the content; `.text` still holds the original raw HTML.
         *
         * `{ rendered: true }` loads the URL in a background tab so its JavaScript runs, then returns the SETTLED
         * DOM (for client-rendered/SPA pages a raw GET returns empty). Like `credentials` it's as-the-user
         * (a real tab load carries the session), always prompts, is never cached, and works only via `fetch_url`.
         *
         * @param {string} url An absolute http(s) URL.
         * @param {{ fresh?: boolean; credentials?: boolean; rendered?: boolean }} [opts] `fresh` bypasses the read cache; `credentials` fetches with the user's cookies; `rendered` loads it in a background tab and returns the settled DOM (both gated, uncached).
         * @returns {Promise<FetchResult>} { url, status, ok, type, language?, text, json?, schema?, typeBy*, truncated?, rendered?, headers? }. `headers` is a SAFELIST of non-sensitive response headers (link/etag/lastModified/retryAfter/contentLength/contentDisposition/cacheControl/date) — auth headers (Cookie/Authorization/…) are never exposed.
         */
        fetch: function(url: string, opts?: { fresh?: boolean; credentials?: boolean; rendered?: boolean; format?: import("./contract").FetchFormat }): Promise<import("./contract").FetchResult> {
            const key = String(url);   // the real method always fetches live; `fresh` only matters for the read-only cache path
            const credentials = !!opts?.credentials;
            const rendered = !!opts?.rendered;
            const format = opts?.format === "html" ? "html" as const : "markdown" as const;
            return makeBackgroundTaskPromise<import("./contract").FetchResult>("FETCH_URL_REQUEST", "FETCH_URL_RESPONSE", { url: key, credentials, rendered, format })
                .then(r => {
                    // For an HTML body, attach a `.markdown` distillation (scripts/nav/chrome stripped) so ANY
                    // caller — exec, a read-only survey (`ml.fetch(url).markdown`), the fetch_url tool — gets the
                    // readable content without re-converting. Computed here in the page main world (has a DOM);
                    // the cost is negligible and the cached copy carries it. `.text` still holds the raw HTML.
                    if (r && r.type === "html" && typeof r.text === "string" && r.markdown === undefined) {
                        try { r.markdown = htmlToMarkdown(r.text); } catch { /* leave undefined — callers fall back to .text */ }
                    }
                    // Cache ONLY a successful UNCREDENTIALED, non-rendered fetch (as-you bytes are authenticated —
                    // never cache). Keyed by url ALONE, so only the DEFAULT format is cached: `format:"html"`
                    // returns different bytes for the same url, and letting it share the key would hand a later
                    // reader the wrong document.
                    if (r && r.ok && !credentials && !rendered && format === "markdown") mlFetchCache.set(key, r);
                    return r;
                });
        },
        /**
         * Internal: the CACHE-ONLY read the read-only dialect's `ml.fetch` is bound to. Returns a prior
         * successful `ml.fetch(url)` result, or undefined on a miss (→ the dialect throws → the exec falls to
         * the normal approval, which does the real fetch). Never egresses — a pure read of already-approved bytes.
         * @param {string} url The URL to look up.
         * @returns {FetchResult|undefined} The cached result, or undefined if this URL hasn't been fetched.
         */
        _fetchCached: function(url: string): import("./contract").FetchResult | undefined {
            return mlFetchCache.get(String(url));
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
        },
        // shadowResolve: describeElement's discovery into a SEALED (closed/declarative) shadow root — round-trips
        // to the background, which CDP-resolves the `>>>` selector (piercing the closed root a page selector
        // can't enter) and returns describe lines. Off (cdp flag) / no match → the message errors → null → the
        // normal "no match" path. Read-only; the privileged sealed CLICK still flows through the trusted envelope.
        async (selector: string): Promise<{ line: string }[] | null> => {
            try {
                const matches = await makeBackgroundTaskPromise<{ line: string }[]>("CDP_SHADOW_RESOLVE_REQUEST", "CDP_SHADOW_RESOLVE_RESPONSE", { selector });
                return Array.isArray(matches) ? matches : null;
            } catch { return null; }
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
        window.postMessage({ type: "RUN_READOPTED", runId, pageInfo: pageContext(n => (rebuild.toolNames || []).includes(n)) }, "*");
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
        if (e.data.__mlStartAgent.stream === true) opts.stream = true;   // the composer's "live" toggle → stream the thinking
        opts.toolTokens = true;   // HUD runs auto-enable tool tokens (the rich answer card is where citing exact outputs pays off)
        // createAgent (not ml.agent) so the run registers a HANDLE the sidebar/HUD composer can drive —
        // follow-up run()s + say() steering from the "Send a message to this session…" box.
        // Bundles the user marked always-present. Read HERE rather than inside `ml.agent`, because this is
        // the surface that needs them: a Commander run has no code to name a bundle, while a scripted
        // `ml.agent()` said exactly what it wanted and must not have tools added behind its back.
        // `commanderTools` rather than resolving the bundles HERE: reading the config first made starting a
        // run wait on a message round-trip, so a slow or unanswered read delayed — or never started — a run
        // the user had already typed. The loop already reads the config in its own async setup.
        opts.commanderTools = true;
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
        const d = e.data as { __mlSessionSend?: { hash: string; text: string; images?: string[]; elementContext?: import("./contract").ElementContext }; __mlCancelSession?: { hash: string }; __mlContinueRun?: { hash: string } };
        try {
            if (d.__mlContinueRun) {
                // "Continue (+N steps)" on a step-capped run: resume it with an EMPTY task — a resume re-enters
                // the loop with a FRESH maxSteps budget (the loop restarts its step count), so the run keeps
                // going from its stored state with N more steps, without the user typing a follow-up. Bypasses
                // the __mlSessionSend empty-text guard on purpose (there IS no text — it's "just keep going").
                const hash = String(d.__mlContinueRun.hash);
                const h = handleRegistry.get(hash);
                if (h) { if (!h.running) void h.run(""); return; }   // page-hosted handle: continue over prior messages
                const bg = agentRegistry.get(hash);
                if (bg) { void bg.resume(""); return; }              // background-hosted / cross-page run: RESUME_RUN, empty task
                return;
            }
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

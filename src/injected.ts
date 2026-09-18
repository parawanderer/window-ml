// This runs in the "Main World" (same as the page JS)

import type {
    NeutralMessage,
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
    TokenUsage,
    MlHistory,
    TableSource, TableValue,
    TablePreview,
    DerefValue, ShotBox, VisionMemory, RebuildConfig, AnswerMedia, MlAnswer, RequestHint, RequestUse
} from "./contract";
import { detectGroundingModel, DEFAULT_GROUNDING_RANGE, outputCapEscalated, hintSession, shortHash } from "./contract";
import { evalReadonly } from "./readonly-exec";
import { expandPointers } from "./pointer-macro";   // `@tool:` → a real dereference call, before the dialect sees it
import { htmlToMarkdown } from "./html-to-md";
import { mlPipe, PIPE_SYNTAX } from "./text-pipe";
import { citeParam } from "./tool-params";
import { truncate, errText, elPath, describeSkeleton, queryAll, selectorError, extractTable, googleSheetCsvUrl, googleSheetId, externalSheetIds, nonEmptyTables, setPierceClosedShadow, viewportRect, isElement, jsonShape, joinShapes, jsonValue, shadowHostReport, clickSelector, elLine, isCurrentPage, typeFromExtension } from "./dom";
import { castTableColumns, tableFromDelimited, tableShape, asTable } from "./table-data";
import { FetchCache, estimateFetchResultBytes } from "./fetch-cache";
import { isTable } from "./table-brand";
import { parseInfo } from "./resource-model";   // chat_metadata: the machine's devices and memory
/** The page fetch cache's estimated memory budget. Enough for the table a step just fetched plus a few smaller
 *  bodies; far below what an unbounded session used to accumulate in the user's tab. */
const FETCH_CACHE_BUDGET_BYTES = 64_000_000;
import { makeAnswerFacade, finalizeAnswer, resolveOutputs } from "./answer-set";
import { isSelfSourceUrl } from "./self-source";
import { BUILD_INFO } from "./build-info.gen";
import { accessibleName, roleOf, ariaState } from "./a11y";
import { AGENT_SYSTEM, VISION_CLAUSE, ANSWER_CLAUSE, TOOLTOKENS_CLAUSE, DEREF_CLAUSE, WAIT_CLAUSE, SHADOW_CLAUSE, SHADOW_CLOSED_NOTE, SHADOW_CLOSED_PIERCE_NOTE, SHADOW_EXEC_NOTE, IFRAME_CLAUSE, SELF_CLAUSE, HUD_HINT, HUD_PROSE_PROGRESS, HUD_PROSE_QUIET, PYTHON_CLAUSE, EXEC_COMPUTE_CLAUSE, PIPE_CLAUSE, EXEC_RANGE_CLAUSE, NAV_OFF_CLAUSE, UNATTENDED_CLAUSE, UNATTENDED_REFUSAL, UNATTENDED_EXEC_NOTE, UNATTENDED_PY_NOTE, askAboutTask } from "./prompts";
import { pageContext, resolvePoint, resolveBox, agentState, mlRange } from "./util";
import { suspiciousArgsWarning, suspiciousChars } from "./security";
import { emitDebug, debugId, sessionRegistry, agentRegistry, handleRegistry, enterAgentRun, exitAgentRun, resetSubcallUsage, subcallUsage } from "./bus";
import { makeDomTools, buildDereferenceTool } from "./tools";
import { pipeStages, TokenStore, type DerefRead } from "./token-pipe";
import { makeBackgroundTaskPromise, makeChatRequest, makeStreamingTaskPromise } from "./bridge";
import { validateArgs, validateExtend } from "./validate";
import { makeDynamicTools } from "./dynamic-tools";
import type { DynamicToolNamespace } from "./dynamic-tools";
import { renderArgs, logStep, defaultApprove, normalizeApproval, formatReadonlyExec, readonlyRefused } from "./approval";
import { buildServerTools, captureVerify, setCdpEnabled } from "./builtin-tools";
import { pyVarNameError } from "./python-env";
import { autoApprovePython } from "./auto-approve";
import { executeTool, toolContext, currentAnswer, currentDeref, currentServerAllow, currentRunSession, currentHasTool, withRunDeref } from "./tool-exec";
import { runAgentLoop, shotTurnMessage, CITABLE_TOOLS } from "./agent-loop";
import type { AgentLoopDeps } from "./agent-loop";
import { installToolDelegation, registerRun, endRun, runAnswer } from "./run-delegation";
import { descriptorFor } from "./render-descriptor";
import { AgentHandle, sameOriginNav, sameOriginFetch, DerefText, columnsViaBackground } from "./ml-agent";   // run-control object (createAgent/agent) + page-loop same-origin auto-approve predicates
import type { AgentControl } from "./ml-agent";
import { models, serverTools, execServerTool, info, capabilities, getModel, embed, config, setModel, ps, unload } from "./ml-server";
import { defineTool, lookTool, locateTool, clickTool, typeTool, navigateTool, fetchTool, pythonTool, chatMetaTool } from "./ml-tool-factories";
import { read, screenshot, _shotBox, _stitchFullPage, _resolveVisionModel, _modelSees, _nativeLookTool, _imageToDataUrl, _fetchImageBase64 } from "./ml-vision";

/** Histories `ml.chat` made for a single call. They have no conversation behind them, so their requests carry no
 *  hint session — a new session per call is the "per message" case, from which the server learns nothing. */
const oneShotChats = new WeakSet<object>();

/** Is this a table handed over BY VALUE (see {@link TableValue})? The `Table` facade throws on keys it does not have, so
 *  it is recognised by its brand before anything probes it. */
const isTableValue = (v: unknown): v is TableValue =>
    isTable(v) || (!!v && typeof v === "object" && !(typeof Element !== "undefined" && v instanceof Element)
        && Array.isArray((v as { columns?: unknown }).columns) && Array.isArray((v as { rows?: unknown }).rows));
// `value`: the whole table is in the value store under `key`, and the sandbox reads it there; only its preview rows (for the
// render) stay page-side, and they never travel with the run.
type LoadedTable = { name: string; source: TableSource; preview?: (string | number | boolean | null)[][]; rowCount?: number; data: { kind: "rows"; columns: string[]; rows: (string | number | boolean | null)[][] } | { kind: "html"; html: string } | { kind: "value"; key: string; label: string; columns: string[]; delimiter?: string; headerless?: boolean } };

// ---- the SERVER surface of window.ml ----------------------------------------------------------------
// Lifted out of the object literal so it can be moved to a module of its own: these eleven ask the background
// about the SERVER (models, capabilities, residency, server-side tools) and touch none of the IIFE's state, so
// column scope costs them nothing and makes them movable by scripts/move-symbols.mjs rather than by hand.

// ---- the TOOL FACTORIES of window.ml ---------------------------------------------------------------
// Each `ml.xxxTool()` builds one MlTool the caller passes to `ml.agent({ extraTools })` — lifted out of the object
// literal so they can move to a module of their own (scripts/move-symbols.mjs takes top-level declarations only).

// ---- the VISION surface of window.ml --------------------------------------------------------------
// Pixels and what reads them: capturing a region or a whole page, turning an <img>/blob/URL into a data URL a
// model can be sent, deciding WHICH model can see, and the native-vision look tool. Lifted out of the object
// literal so they can move to a module of their own (move-symbols takes top-level declarations only).

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
    // BUDGETED (fetch-cache.ts): it was a bare Map that kept every fetched body — and every parsed CSV's rows —
    // in the user's tab for the life of the page. The most recent fetch is always kept, since the next step
    // reading it is the handoff this cache exists for; evicted URLs are remembered so a miss can say so.
    // Each budget eviction goes to the housekeeping log (docs/dev/housekeeping.md), reported from here because the
    // cache lives in the page: the worker stamps it page-origin, and only this tab reads its key (the URL) back.
    const mlFetchCache = new FetchCache<import("./contract").FetchResult>(FETCH_CACHE_BUDGET_BYTES, estimateFetchResultBytes, undefined, (key, bytes) => {
        makeBackgroundTaskPromise("HOUSEKEEPING_REPORT_REQUEST", "HOUSEKEEPING_REPORT_RESPONSE", { subsystem: "fetch-cache", kind: "evict", reason: "budget", key, bytes, detail: { budgetBytes: FETCH_CACHE_BUDGET_BYTES } }).catch(() => { /* a log, never worth a failure */ });
    });

    /** `ml.fetch(ownUrl, { rendered: true, credentials: true })` on a local page, answered from the live
     *  document (see `isCurrentPage`). `rendered` is set because that is what it is: a settled DOM, not a
     *  response body. A plain object of strings — the serialized DOM, never a node — so handing it to the read-only dialect
     *  leaks nothing a survey of `outerHTML` would not already return. Not cached: the DOM changes, and a
     *  cached copy would answer a later read with an older page. */
    const liveDocumentFetch = (): import("./contract").FetchResult => {
        const doctype = document.doctype ? `<!DOCTYPE ${document.doctype.name}>\n` : "";
        const text = doctype + document.documentElement.outerHTML;
        let markdown: string | undefined;
        try { markdown = htmlToMarkdown(text); } catch { /* callers fall back to .text */ }
        return {
            url: location.href, status: 200, ok: true, type: "html", typeByHeader: null, typeByContent: "html",
            typeByExtension: typeFromExtension(location.href), contentType: "text/html", text,
            ...(markdown !== undefined ? { markdown } : {}), rendered: true, live: true,
        };
    };

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
            return new DerefText(read.value, read.meta, again, read.readColumns);
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
            // A TABLE has a structure, but not a JSON one: its rows are a matrix, so a JSON shape of them
            // says `(string | number)[][]` — true, and useless. Describe it as a FRAME instead (the same
            // answer `fetch_url`'s `schema: true` and a pointer's `.schema()` give), so asking a CSV for its
            // schema returns its columns and dtypes rather than the type of its text.
            const asTable = (v: unknown): import("./contract").TableLike | undefined =>
                (v && typeof v === "object" ? (v as { table?: import("./contract").TableLike }).table : undefined);
            if (vs.some(asTable)) {
                return vs.map((v, i) => {
                    const t = asTable(v);
                    const prefix = vs.length === 1 ? "" : `${label(i)}: `;
                    return prefix + (t ? tableShape(t) : jsonShape(jsonValue(v, label(i))));
                }).join("\n\n");
            }
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
        createChat: function({ system = null, model = null, extend = null, numCtx = null, numGpu = null, think = false, schema = null, toolIds = null, maxTokens = null, save = false, use = undefined }: Pick<ChatOptions, "system" | "model" | "extend" | "numCtx" | "numGpu" | "think" | "schema" | "toolIds" | "maxTokens" | "use"> & { save?: boolean } = {}): MlHistory {
            validateExtend(extend);
            const ml = this;
            const chatUse = use;   // who waits for this conversation's replies, if the caller said (RequestHint)
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
                chat: async function(this: MlHistory, prompt: string, { images = [], model = this.model, extend = this.extend, numCtx = this.numCtx, numGpu = this.numGpu, think = this.think, schema = this.schema, toolIds = this.toolIds, maxTokens = this.maxTokens, save = this.save, onToken, signal = null, use = chatUse }: {
                    use?: RequestUse;
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

                    // WHAT THIS REQUEST IS FOR (RequestHint). Inside a tool of a run, the run's: the loop waits on it. Else
                    // what the caller said — no `use` when it did not (a person at the console and a script look the
                    // same) — in this conversation's session, except for a one-shot `ml.chat`, which has none (a new id
                    // per call would make every request its own session).
                    const runSession = currentRunSession();
                    const hint: RequestHint = runSession ? { use: "agent", session: runSession }
                        : { ...(use ? { use } : {}), ...(oneShotChats.has(this) ? {} : { session: hintSession(this.hash) }) };
                    const requestPayload: FetchLlmPayload = { "messages": [...this.messages, userMessage], "think": think, "model": model, "extend": extend, "numCtx": numCtx, "numGpu": numGpu, "schema": schema, "toolIds": toolIds, "maxTokens": maxTokens, "hint": hint };
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
            const history = this.createChat(options);
            oneShotChats.add(history);   // no conversation behind it, so no hint session
            return history.chat(prompt, options);
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
        step: async function(messages: NeutralMessage[], { tools = [], model = null, think = null, signal = null, hint = null }: {
            tools?: unknown[];
            model?: string | null;
            think?: boolean | null;
            signal?: AbortSignal | null;
            /** What this request is for (RequestHint). Default: an agent step — a program that acts on the reply —
             *  in the session of the run whose tool is executing, if any. */
            hint?: RequestHint | null;
        } = {}): Promise<{ content: string; tool_calls: ToolCall[]; reasoning?: string | null; usage?: TokenUsage | null }> {
            const runSession = currentRunSession();
            return makeBackgroundTaskPromise(
                "LLM_REQUEST",
                "LLM_RESPONSE",
                { "messages": messages, "tools": tools, "model": model, "think": think, "raw": true,
                  "hint": hint ?? { use: "agent", ...(runSession ? { session: runSession } : {}) } },
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

        defineTool: defineTool,
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
        agent: async function(task: string, { tools = null, extraTools = [], serverTools = [], commanderTools = false, system = null, systemAppend = null, maxSteps = 10, model = null, think = null, approve = defaultApprove, onStep = null, env = true, vision = null, logDebug = false, signal = null, resume = null, silent = false, unattended = false, navigate = true, crossOrigin = false, approvalRouting = "ui", stream = false, toolTokens = false, images = [], _control = null }: {
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
        read: read,
        screenshot: screenshot,
        _shotBox: _shotBox,
        _stitchFullPage: _stitchFullPage,
        lookTool: lookTool,
        locateTool: locateTool,
        clickTool: clickTool,
        typeTool: typeTool,
        navigateTool: navigateTool,
        fetchTool: fetchTool,
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
        pythonExec: async function(code: string, { image = null, mode = "readonly", margin = 0, tableRaw = false, tables = null, onStdout = undefined }: { image?: string | Element | null; mode?: "readonly" | "full"; margin?: number; tableRaw?: boolean; tables?: string | Element | TableValue | Record<string, string | Element | TableValue> | null; onStdout?: (chunk: string, ts?: number) => void } = {}): Promise<{ ok: boolean; value?: unknown; stdout: string; error?: string; inputImage?: string; inputTables?: TablePreview[]; imageBox?: ShotBox; bootMs?: number; runMs?: number }> {
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
            const specs: { name: string; src: string | Element | TableValue }[] = [];
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
                if (typeof tableArg === "string" || (typeof Element !== "undefined" && tableArg instanceof Element) || isTableValue(tableArg)) specs.push({ name: "df", src: tableArg as string | Element | TableValue });
                else if (typeof tableArg !== "object") throw new Error(`pythonExec tables: expected a source string or a {name: source} map, got ${typeof tableArg}.`);
                else for (const [name, src] of Object.entries(tableArg as Record<string, string | TableValue>)) {
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
            // bootMs/runMs come back from the WORKER (the executor): a cold start is charged to the call
            // that paid for it, so a first run does not report the runtime download as its own script time.
            const r = await makeBackgroundTaskPromise("PYTHON_EXEC_REQUEST", "PYTHON_EXEC_RESPONSE",
                { code, image: img, hardened: mode !== "full", stream: !!onStdout, tables: loaded.map((l, i) => ({ name: l.name, data: l.data, alias: typeof specs[i].src === "string" ? specs[i].src as string : null })) },
                undefined, null,
                // LIVE stdout (opt-in): each PYTHON_STREAM chunk for this run → onStdout (the tool's ctx.stream).
                onStdout ? { type: "PYTHON_STREAM", onProgress: (d) => onStdout(String((d as { chunk?: string }).chunk ?? ""), (d as { ts?: number }).ts) } : undefined) as { ok: boolean; value?: unknown; stdout: string; error?: string; table?: { columns: string[]; rows: (string | number | boolean | null)[][]; rowCount?: number }; valueKey?: string; render?: "latex" | "img"; bootMs?: number; runMs?: number };
            const extra: { inputImage?: string; inputTables?: TablePreview[]; imageBox?: ShotBox; resultTable?: { columns: string[]; rows: (string | number | boolean | null)[][] } } = {};
            if (img) extra.inputImage = img;
            if (imageBox) extra.imageBox = imageBox;   // for cast:'pt'/'box' → project image px → viewport
            // A returned DataFrame → the UI renders a real table. Past its preview it carries the whole frame's row count, and
            // the value-store key its pointer will name.
            if (r.table) extra.resultTable = { ...r.table, ...(r.valueKey ? { value: r.valueKey } : {}) };
            if (loaded.length) extra.inputTables = loaded.map(l => ({
                name: l.name, source: l.source,
                ...(l.data.kind === "rows" ? { columns: l.data.columns, rows: l.data.rows } : l.data.kind === "value" ? { columns: l.data.columns, rows: l.preview ?? [], ...(l.rowCount != null ? { rowCount: l.rowCount } : {}) } : { html: true }),
            }));
            return Object.keys(extra).length ? { ...r, ...extra } : r;
        },
        /**
         * Resolve ONE `tables` source to a loaded DataFrame spec `{ name, source, data }`, dispatching
         * by the value's shape: `'current'` or a Google Sheets URL → fetch its CSV; anything else →
         * a DOM selector/Element (a page table). `source` carries the provenance for the debug
         * render's label + tooltip. Page-side; async (sheets go through the background fetch).
         */
        _loadTable: async function(name: string, src: string | Element | TableValue, raw = false): Promise<LoadedTable> {
            // A TABLE BY VALUE: a pointer's table the loop resolved, or a table a page script already holds. Whole tables
            // only. A prefix analysed as a DataFrame gives confident wrong numbers (a sum over the first 200 of 48,231
            // rows), so it is refused with the forms that load the rest.
            if (isTableValue(src)) {
                const facade = isTable(src);
                const pointer = facade ? undefined : src.pointer;
                const what = pointer ?? "this table";
                const total = src.shape?.[0];
                const preview = src.truncated || (typeof total === "number" && total > src.rows.length);
                // A preview whose whole table is STORED: the sandbox reads the stored bytes (the background checks the
                // caller is entitled to them — a run it hosts, or the tab it gave the key to). The columns and split
                // decisions go along, so pandas names and parses it as the preview did.
                if (preview && !facade && src.value)
                    return { name, source: { kind: "pointer", label: pointer ?? "a table value" }, preview: src.rows as (string | number | boolean | null)[][], ...(typeof total === "number" ? { rowCount: total } : {}),
                        data: { kind: "value", key: src.value, label: what, columns: [...src.columns], ...(src.delimiter ? { delimiter: src.delimiter } : {}), ...(src.headerless ? { headerless: true } : {}) } };
                if (preview)
                    throw new Error(`pythonExec tables — ${what} holds ${src.rows.length.toLocaleString("en-US")} of ${typeof total === "number" ? total.toLocaleString("en-US") : "more"} rows, a preview rather than the whole table, so it is not loaded. Pass the URL fetch_url read (tables: {df: "<the url>"}) to load the whole parsed table.`);
                return { name, source: { kind: "pointer", label: pointer ?? "a table value" }, data: { kind: "rows", columns: [...src.columns], rows: src.rows as (string | number | boolean | null)[][] } };
            }
            const isCurrent = src === "current";
            // A URL THE RUN ALREADY FETCHED. `fetch_url` parses a CSV into a TableLike and the fetch cache holds
            // it, so naming that URL here loads the WHOLE table as a DataFrame with no second request, no
            // re-parse, and no `read_csv` in the sandbox (which has no network anyway). The cache is the gate:
            // a URL that was never fetched is refused rather than fetched, so this cannot become an egress that
            // skips the approval `fetch_url` went through.
            if (typeof src === "string" && /^https?:\/\//i.test(src) && !googleSheetCsvUrl(src)) {
                const cached = mlFetchCache.get(src);
                if (cached?.table) {
                    const t = cached.table;
                    return { name, source: { kind: "fetch", label: cached.url }, data: { kind: "rows", columns: t.columns, rows: t.rows } };
                }
                throw new Error(cached
                    ? `pythonExec tables — "${src}" was fetched but isn't a table (type: ${cached.type}). Only a CSV/TSV parses into a DataFrame this way.`
                    // EVICTED is not NEVER FETCHED. Telling a model a URL it fetched two steps ago was never
                    // fetched sends it hunting for a mistake it did not make.
                    : mlFetchCache.wasEvicted(src)
                        ? `pythonExec tables — "${src}" was fetched earlier, but its parsed table has since been dropped from the page's fetch cache to keep memory bounded. Call fetch_url on it again (it is already approved), then pass the URL here.`
                        : `pythonExec tables — "${src}" hasn't been fetched in this run. Call fetch_url on it first; its parsed table is then loaded from the cache.`);
            }
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
                // The Sheets export is ALWAYS comma-separated, so it is named rather than discovered: a sheet
                // whose first row holds no comma (one column, or a title cell) would otherwise be guessed at.
                const sheet = tableFromDelimited(csv, { delimiter: ",", raw });
                const source: TableSource = isCurrent
                    ? { kind: "sheet-current", label: (typeof document !== "undefined" && document.title) ? document.title : "current sheet" }
                    : { kind: "sheet-external", label: googleSheetId(String(src)) || String(src), name: sheetName };   // label = id (for the link), name = the real title (chip)
                return { name, source, data: { kind: "rows", columns: sheet.columns, rows: sheet.rows } };
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
        _resolveTable: function(target: string | Element, raw = false): { kind: "rows"; columns: string[]; rows: (string | number | boolean | null)[][] } | { kind: "html"; html: string } {
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
        pythonTool: pythonTool,
        chatMetaTool: chatMetaTool,
        _resolveVisionModel: _resolveVisionModel,
        _modelSees: _modelSees,
        _nativeLookTool: _nativeLookTool,
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
        _imageToDataUrl: _imageToDataUrl,
        _fetchImageBase64: _fetchImageBase64,
        models: models,
        serverTools: serverTools,
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
        execServerTool: execServerTool,
        info: info,
        capabilities: capabilities,
        getModel: getModel,
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
        embed: embed,
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
            // A SESSION RENDER OF THE PAGE YOU ARE ON. `rendered + credentials` asks for "this URL, its JS run, in
            // my own session" — and for the page the call came from, that is exactly the DOM already in front of
            // it. So it is answered from there: no second tab re-running the page's scripts (and their side
            // effects), no request, no grant. ONLY this mode: a plain or `format: "html"` fetch promises the
            // server's (or the file's) own BYTES, which the live DOM is not, and a sessionless `rendered` load is
            // a FRESH page rather than this one — those still go to the network. On a file:// page they cannot
            // (Chrome's fetch has no file scheme), and the background's refusal names this mode as the one that
            // works (see `isCurrentPage`).
            if (credentials && rendered && isCurrentPage(key, location.href)) return Promise.resolve(liveDocumentFetch());
            return makeBackgroundTaskPromise<import("./contract").FetchResult>("FETCH_URL_REQUEST", "FETCH_URL_RESPONSE", { url: key, credentials, rendered, format })
                .then(r => {
                    // For an HTML body, attach a `.markdown` distillation (scripts/nav/chrome stripped) so ANY
                    // caller — exec, a read-only survey (`ml.fetch(url).markdown`), the fetch_url tool — gets the
                    // readable content without re-converting. Computed here in the page main world (has a DOM);
                    // the cost is negligible and the cached copy carries it. `.text` still holds the raw HTML.
                    if (r && r.type === "html" && typeof r.text === "string" && r.markdown === undefined) {
                        try { r.markdown = htmlToMarkdown(r.text); } catch { /* leave undefined — callers fall back to .text */ }
                    }
                    // Same move for a CSV/TSV body: attach the PARSED table, with its separator discovered and
                    // numeric columns cast, so no caller has to re-split the text (and get the separator wrong —
                    // the reason this exists is that they did). Page-side for the same reason as `.markdown`: the
                    // text has already crossed the message channel, so parsing here adds nothing to the wire.
                    if (r && r.type === "csv" && typeof r.text === "string" && r.table === undefined) {
                        try {
                            const parsed = tableFromDelimited(r.text);
                            // A body clipped at the size cap ends mid-row, so that row is a fragment rather than
                            // data. Drop it and say the table is a prefix — silently keeping it would put a
                            // half-parsed record into a DataFrame. BEFORE wrapping: the facade is read-only, and
                            // trimming through it threw halfway, leaving the fragment dropped but the shape wrong.
                            if (r.truncated && parsed.rows.length) {
                                parsed.rows.pop();
                                parsed.shape = [parsed.rows.length, parsed.columns.length];
                                parsed.truncated = true;
                                // …unless the worker read the whole body (it is stored), in which case its real length is
                                // known: the preview is a prefix of a table this big, not the whole of a table this small.
                                const whole = typeof r.bodyLines === "number" ? r.bodyLines - (parsed.headerless ? 0 : 1) : 0;
                                if (whole > parsed.rows.length) parsed.shape = [whole, parsed.columns.length];
                            }
                            r.table = parsed;
                        } catch { /* leave undefined — callers fall back to .text */ }
                    }
                    // Every table a caller receives is a FACADE, not the bare data — a Parquet one decoded in the
                    // worker as much as a CSV parsed here: the description is pandas-shaped, so the object has to
                    // answer a pandas reach with a message rather than `undefined`. Whether the message may point
                    // at python_exec is read from the running run's toolset.
                    if (r && r.table && !isTable(r.table)) r.table = asTable(r.table, { python: currentHasTool("python_exec") });
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
        _fetchCached: function(url: string, mode?: { credentials?: boolean; rendered?: boolean; format?: string }): import("./contract").FetchResult | undefined {
            // A session render of the local page you are on is its live DOM — which this dialect already reads
            // through `outerHTML` — so it answers here rather than costing an approval for the same bytes.
            if (mode?.rendered && mode?.credentials) return isCurrentPage(String(url), location.href) ? liveDocumentFetch() : undefined;
            // The cache holds DEFAULT-mode results only (see `fetch`). Any other mode is a different document,
            // so it misses rather than handing back the wrong one.
            if (mode?.rendered || mode?.credentials || mode?.format === "html") return undefined;
            return mlFetchCache.get(String(url));
        },
        config: config,
        setModel: setModel,
        ps: ps,
        /**
         * DEBUG DUMP — everything the resource panel derives its timeline from, in one object. For reporting a
         * lane that draws something that makes no sense: the drawn events are DERIVED (`eventsFrom` +
         * `machineEventFrom`, both pure), so handing over the INPUTS lets the exact picture be rebuilt and
         * turned into a test, where a screenshot can only be described.
         *
         * `{ debug }` is this tab's own `__mlDebug` stream (runs, steps, usage), `{ frames }` the server's
         * event-stream frames with the wall clock each was resolved to, plus the current `ps`/`info` and the
         * stream's status. Underscored because it is a debugging aid, not API: shape may change freely.
         *
         * TWO THINGS TO KNOW when capturing. `frames` is only collected while a resource panel is OPEN —
         * nothing subscribes to the stream when nobody is looking — so open the panel before the run you
         * want. And `debug` is the BACKGROUND's ring: it holds everything in `debugMode: "devtools"`, and
         * only the background-hosted half of a run in `"overlay"`.
         *
         * @param opts.download Save it as `ml-events-<time>.json` instead of only returning it.
         * @returns {Promise<object>} The raw inputs, JSON-serializable.
         */
        __events: async function(opts?: { download?: boolean }): Promise<Record<string, unknown>> {
            const dump = await makeBackgroundTaskPromise("DUMP_EVENTS_REQUEST", "DUMP_EVENTS_RESPONSE", {}) as Record<string, unknown>;
            if (opts?.download) {
                // Straight to a file: this is usually several megabytes of screenshots and step results, which
                // no console can be asked to hold, let alone copy out of.
                const url = URL.createObjectURL(new Blob([JSON.stringify(dump, null, 1)], { type: "application/json" }));
                const a = document.createElement("a");
                a.href = url; a.download = `ml-events-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 10_000);
            }
            return dump;
        },
        /**
         * One record per model LOAD, for tuning the server's VRAM predictor — collected in the service worker
         * while the resource panel's "load predictions" toggle is on (off by default), and kept across worker
         * restarts. Each has the server's prediction (`estimate`, verbatim), the load's own figures
         * (`complete`, verbatim), and the measured `trace`: where it peaked, where it settled, and every sample
         * between as `[ms since the load began, bytes]`. The panel must be OPEN while loads happen — the stream
         * is only connected then. Underscored: a debugging aid, not API.
         *
         * @param opts.download Save them as `ml-loads-<time>.json` instead of only returning them.
         * @param opts.clear Empty the store after reading it.
         * @returns {Promise<object[]>} The records, oldest first.
         */
        /**
         * The HOUSEKEEPING LOG: what the system decided on its own — cache evictions, sweeps, service-worker
         * restarts (inferred from a heartbeat, since an evicted worker writes nothing on its way out), Python
         * cold starts. One structured event each, oldest first, kept in `chrome.storage.session` so it outlives
         * the worker and clears with the browser. `origin` is who reported it, stamped by the worker; this page
         * sees `key` and string `detail` values only on events its own tab reported. Underscored: a debugging aid, not API.
         * See docs/dev/housekeeping.md.
         *
         * @param opts.download Save it as `ml-housekeeping-<time>.json` instead of only returning it.
         * @returns {Promise<object[]>} The events, oldest first.
         */
        __housekeeping: async function(opts?: { download?: boolean }): Promise<unknown[]> {
            const events = await makeBackgroundTaskPromise("DUMP_HOUSEKEEPING_REQUEST", "DUMP_HOUSEKEEPING_RESPONSE", {}) as unknown[];
            if (opts?.download) {
                const url = URL.createObjectURL(new Blob([JSON.stringify(events, null, 1)], { type: "application/json" }));
                const a = document.createElement("a");
                a.href = url; a.download = `ml-housekeeping-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 10_000);
            }
            return events;
        },
        __loads: async function(opts?: { download?: boolean; clear?: boolean }): Promise<unknown[]> {
            const records = await makeBackgroundTaskPromise("DUMP_LOADS_REQUEST", "DUMP_LOADS_RESPONSE", { clear: !!opts?.clear }) as unknown[];
            if (opts?.download) {
                const url = URL.createObjectURL(new Blob([JSON.stringify(records, null, 1)], { type: "application/json" }));
                const a = document.createElement("a");
                a.href = url; a.download = `ml-loads-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 10_000);
            }
            return records;
        },
        unload: unload,
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
        // `systemAppend` (appended to the system prompt) rather than `system` (which would REPLACE the
        // preamble): the run still needs the whole method, it just isn't a console call.
        // chatMetaTool: a HUD user often asks "which model am I / how much context have I used?" — give the
        // HUD agent the self-introspection tool by default (a scripted ml.agent still opts in via extraTools).
        // HUD verbosity (passed by the shell): quiet → tell the model to stay silent between steps; progress
        // → keep between-step prose to one short live line. Defaults to progress.
        const proseClause = e.data.__mlStartAgent.hud === "quiet" ? HUD_PROSE_QUIET : HUD_PROSE_PROGRESS;
        // Commander/HUD runs allow cross-origin navigation by default — a HUD user driving a real task often
        // needs to cross sites, and each crossing still hits the consent gate (a new origin prompts), so it's
        // safe. A scripted console `ml.agent()` still defaults to same-site only.
        const opts: Record<string, unknown> = { extraTools: [ml.clickTool(), ml.typeTool(), ml.pythonTool(), ml.chatMetaTool()], systemAppend: HUD_HINT + proseClause, crossOrigin: true };
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
    async function continueChatSession(hash: string, text: string, images?: (string | HTMLImageElement)[], started?: (found: boolean) => void): Promise<void> {
        // Same-tab sessions live in the registry; a saved session from another tab/reload rehydrates.
        const resume = (window.ml as unknown as { resumeChat: (h: string) => Promise<MlHistory> }).resumeChat;
        let h = sessionRegistry.get(hash);
        if (!h) { try { h = await resume(hash); } catch { started?.(false); return; } }   // unknown/unsaved hash → nothing to continue
        if (!h) { started?.(false); return; }
        started?.(true);
        const ctrl = new AbortController();
        chatInflight.set(hash, ctrl);
        try { await h.chat(text, { images: images || [], signal: ctrl.signal }); }
        catch { /* aborted or failed — the chat-error event already surfaced it in the sidebar */ }
        finally { if (chatInflight.get(hash) === ctrl) chatInflight.delete(hash); }
    }

    window.addEventListener("message", (e: MessageEvent) => {
        if (e.source !== window || !e.data) return;
        const d = e.data as { __mlSessionSend?: { hash: string; text: string; images?: string[]; elementContext?: import("./contract").ElementContext; reqId?: string }; __mlCancelSession?: { hash: string; reqId?: string }; __mlContinueRun?: { hash: string; reqId?: string } };
        // A request the shell relayed from an extension page (the chat page) carries a `reqId` and wants to hear what
        // happened, so the page can say "steered", "started a turn" or "not on this page" instead of guessing.
        const reqId = d.__mlSessionSend?.reqId ?? d.__mlCancelSession?.reqId ?? d.__mlContinueRun?.reqId;
        const done = (outcome: "steer" | "turn" | "cancelled" | "continued" | "busy" | "none"): void => {
            if (typeof reqId === "string") window.postMessage({ __mlSessionDone: { reqId, outcome } }, "*");
        };
        try {
            if (d.__mlContinueRun) {
                // "Continue (+N steps)" on a step-capped run: resume it with an EMPTY task — a resume re-enters
                // the loop with a FRESH maxSteps budget (the loop restarts its step count), so the run keeps
                // going from its stored state with N more steps, without the user typing a follow-up. Bypasses
                // the __mlSessionSend empty-text guard on purpose (there IS no text — it's "just keep going").
                const hash = String(d.__mlContinueRun.hash);
                const h = handleRegistry.get(hash);
                if (h) { if (!h.running) { void h.run(""); done("continued"); } else done("busy"); return; }   // page-hosted handle: continue over prior messages
                const bg = agentRegistry.get(hash);
                if (bg) { void bg.resume(""); done("continued"); return; }              // background-hosted / cross-page run: RESUME_RUN, empty task
                done("none");
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
                if (!text && !(images && images.length)) { done("none"); return; }   // allow an image-only follow-up
                const h = handleRegistry.get(hash);
                // An AGENT handle holds live state: steer a RUNNING loop (say — text only, no image mid-steer),
                // else a new turn (run, which carries this turn's images).
                if (h) { if (h.running) { h.say(text); done("steer"); } else { void h.run(text, images); done("turn"); } return; }
                // No local handle — e.g. a HUD run that NAVIGATED (its page-side handle died with the old
                // document). If it re-adopted as a resumable BACKGROUND run (agentRegistry, keyed by hash),
                // continue it with a follow-up TURN rather than dropping the message into the chat path.
                const bg = agentRegistry.get(hash);
                if (bg) {
                    emitDebug({ kind: "agent-say", id: hash, ts: Date.now(), save: false, session: { hash, turn: 0 }, text });
                    void bg.resume(text);
                    done("turn");
                    return;
                }
                // Otherwise it's a plain chat session — continue the conversation with another turn.
                void continueChatSession(hash, text, images, (found) => done(found ? "turn" : "none"));
                return;
            }
            if (d.__mlCancelSession) {
                const hash = String(d.__mlCancelSession.hash);
                const h = handleRegistry.get(hash);
                if (h) { h.cancel(); done("cancelled"); return; }   // agent loop hosted on THIS page
                // No local handle — a HUD/cross-page run that NAVIGATED (its page-side handle died with the old
                // document) and re-adopted as a resumable BACKGROUND run (agentRegistry). Relay CANCEL_RUN so the
                // background aborts the run's OWN controller AND resolves any open approval gate (mirrors the
                // __mlSessionSend agentRegistry fallback). Without this, the composer's Stop button was inert
                // cross-page — the run stayed stuck "waiting for your approval…" with no way to cancel it.
                if (agentRegistry.has(hash)) { window.postMessage({ type: "CANCEL_RUN_REQUEST", payload: { runId: hash } }, "*"); done("cancelled"); return; }
                const inflight = chatInflight.get(hash);   // chat turn started from the composer
                inflight?.abort();
                done(inflight ? "cancelled" : "none");
                return;
            }
        } catch (err) { console.error("ml: session composer action failed:", err); done("none"); }
    });

    // Readiness signal for scripts (e.g. userscripts) that may run before this
    // one injects. Resolves immediately since window.ml is fully synchronous:
    //   const ml = await (window.ml?.ready
    //       ?? new Promise(r => addEventListener("ml:ready", () => r(window.ml), { once: true })));
    window.ml.ready = Promise.resolve(window.ml);
    window.dispatchEvent(new Event("ml:ready"));

    console.log("🟢 window.ml is ready.");
})();

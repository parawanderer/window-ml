// ml-chat.ts — the CHAT surface of window.ml: a raw model call, and a conversation that remembers.
//
// `chat` is one call with no memory; `createChat` returns the MlHistory that keeps the messages and every
// option the conversation was opened with, and `resumeChat` rebuilds one from its hash. `step` is the
// tool-calling single turn the agent loop is built out of, and it lives here rather than with the agent
// because it is a model call: it runs one turn and returns, and the loop around it is the agent's business.
//
// The distinction to keep is the one callers get wrong: none of this sees the page. A chat receives the
// prompt and any images and nothing else, which is why `ml.chat("what is on this page?")` cannot work and
// `ml.agent` is the one that can. The generated API reference says so at the top for the same reason.

import { makeStreamingTaskPromise, makeChatRequest, makeBackgroundTaskPromise } from "./bridge";
import { debugId, emitDebug, sessionRegistry } from "./bus";
import { type MlApi, type ChatOptions, type MlHistory, shortHash, type RequestUse, type ExtendProfile, type JsonSchema, type NeutralMessage, type RequestHint, hintSession, type FetchLlmPayload, type SessionRef, type DebugSessionConfig, type StoredSession, type ToolCall, type TokenUsage } from "./contract";
import { currentRunSession } from "./tool-exec";
import { validateExtend } from "./validate";

/** Histories `ml.chat` made for a single call. They have no conversation behind them, so their requests carry no
 *  hint session — a new session per call is the "per message" case, from which the server learns nothing. */
const oneShotChats = new WeakSet<object>();

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
export const createChat = function(this: MlApi, { system = null, model = null, extend = null, numCtx = null, numGpu = null, think = false, schema = null, toolIds = null, maxTokens = null, save = false, use = undefined }: Pick<ChatOptions, "system" | "model" | "extend" | "numCtx" | "numGpu" | "think" | "schema" | "toolIds" | "maxTokens" | "use"> & { save?: boolean } = {}): MlHistory {
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
};

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
export const resumeChat = async function(this: MlApi, hash: string): Promise<MlHistory> {
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
};

/**
 * One-shot chat — a throwaway single-turn history.
 * Options: { system, think, images, model, schema, toolIds, maxTokens, save, onToken } as in createChat.
 *
 * @param {string} prompt The user prompt.
 * @param {Object} [options] Chat options (same as createChat).
 * @returns {Promise<string|Object>} The model's reply.
 */
export const chat = async function(this: MlApi, prompt: string, options: ChatOptions = {}): Promise<string | unknown> {
    const history = this.createChat(options);
    oneShotChats.add(history);   // no conversation behind it, so no hint session
    return history.chat(prompt, options);
};

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
export const step = async function(messages: NeutralMessage[], { tools = [], model = null, think = null, signal = null, hint = null }: {
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
};

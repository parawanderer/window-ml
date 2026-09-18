// ml-server.ts — the SERVER half of `window.ml`: everything a caller can ask about the backend rather than about
// the page or the run.
//
// Which models exist and which one is current, what a model can do (`capabilities`), what is resident right now and
// what to unload, the OpenWebUI server-side tools and running one directly, embeddings, and the non-secret config
// subset a page is allowed to read. Split out of injected.ts, whose 3,000-line `window.ml` literal is the reason
// this file exists at all: these eleven share a subject and touch nothing else in it.
//
// They are ordinary module-scope functions that the literal references by name, NOT methods — none of them uses
// `this`, so nothing is lost by moving them out and the page still sees exactly the same object. Each one is a
// thin `makeBackgroundTaskPromise` round trip, because the worker holds the config and the host permissions; the
// page never talks to the backend itself. The SECRETS stay there too: `config` returns the public subset only
// (no URL, no API key, no modelFilter), which is a security invariant, not a convenience.

import { makeBackgroundTaskPromise } from "./bridge";
import { emitDebug } from "./bus";
import type { ServerTool, ServerToolResult, OllamaInfo, MlPublicConfig, LoadedModel } from "./contract";
import { Embedding } from "./embedding";

/** One resolved `python_exec` table source: its var name, provenance, and the payload the sandbox
 *  builds a DataFrame from (rows or read_html html). Internal to injected.ts. */
/** ONE session for every `ml.embed()` on this page, created lazily. Embedding is usually done in a loop, so
 *  a session per call would flood the list with one-turn entries; a single accumulating session keeps the
 *  spans on the lane without burying everything else. */
let _embedHash: string | null = null;

let _embedTurn = 0;

const embedSession = () => ({ hash: (_embedHash ||= `embed${Math.random().toString(16).slice(2, 8)}`), turn: _embedTurn });

const embedTurn = () => ++_embedTurn;

/**
 * Get available model ids on the server.
 *
 * @returns {Promise<string[]>} Array of model ids.
 */
export const models = async function(): Promise<string[]> {
    return makeBackgroundTaskPromise("LIST_MODELS_REQUEST", "LIST_MODELS_RESPONSE", {});
};

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
export const serverTools = async function(): Promise<ServerTool[]> {
    return makeBackgroundTaskPromise("LIST_SERVER_TOOLS_REQUEST", "LIST_SERVER_TOOLS_RESPONSE", {});
};

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
export const execServerTool = async function(
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
};

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
export const info = async function(): Promise<OllamaInfo | null> {
    return makeBackgroundTaskPromise("INFO_REQUEST", "INFO_RESPONSE", {});
};

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
export const capabilities = async function(model: string | null = null): Promise<string[] | null> {
    return makeBackgroundTaskPromise("CAPS_REQUEST", "CAPS_RESPONSE", { "model": model });
};

/**
 * Get the saved default model.
 *
 * @returns {Promise<string|null>} The model id.
 */
export const getModel = async function(): Promise<string | null> {
    return makeBackgroundTaskPromise("GET_MODEL_REQUEST", "GET_MODEL_RESPONSE", {});
};

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
export const embed = async function<T extends string | string[]>(input: T, opts?: { model?: string }): Promise<T extends string[] ? Embedding[] : Embedding> {
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
};

/**
 * Get the non-secret saved config the page is allowed to read:
 * { model, ocrModel, apiFormat }. The server URL and API key are never
 * exposed to the page (see the security invariants in CLAUDE.md).
 * ml.agent uses this to auto-wire a vision tool from the OCR model.
 *
 * @returns {Promise<{model: string, ocrModel: string, apiFormat: string}>} The config object.
 */
export const config = async function(): Promise<MlPublicConfig> {
    return makeBackgroundTaskPromise("CONFIG_REQUEST", "CONFIG_RESPONSE", {});
};

/**
 * Persistently switch the default model (validated against the server;
 * the settings popup picks it up automatically).
 *
 * @param {string} model The model id to set.
 * @returns {Promise<string>} The newly set model id.
 */
export const setModel = async function(model: string): Promise<string> {
    return makeBackgroundTaskPromise("SET_MODEL_REQUEST", "SET_MODEL_RESPONSE", { "model": model });
};

/**
 * Get models currently loaded in VRAM.
 *
 * @returns {Promise<Array<{model: string, vramGB: number, expiresAt: number}>>} Array of loaded models.
 */
export const ps = async function(): Promise<LoadedModel[]> {
    return makeBackgroundTaskPromise("PS_REQUEST", "PS_RESPONSE", {});
};

/**
 * Evict a model from VRAM (keep_alive: 0).
 * No argument = evict all. Returns the list of models that were told to unload.
 *
 * @param {string} [model] The model id to evict; omitted = evict all.
 * @returns {Promise<string[]>} The unloaded models.
 */
export const unload = async function(model: string | null = null): Promise<string[]> {
    return makeBackgroundTaskPromise("UNLOAD_REQUEST", "UNLOAD_RESPONSE", { "model": model });
};

// LLM request/response layer for the service worker — the per-format request builders (API_FORMATS), the
// config accessor, model-capability/resident-model probes, and the actual chat calls (fetchLLM / streamLLM /
// streamAgentTurn) with their prepareRequest setup, rate-limit + network-retry backoff, and the OpenWebUI
// server-tool-mode handback probe. Also the model-list/server-tool/setModel/unload plumbing. Extracted from
// background.ts verbatim; it depends only on the shared contract (types + DEFAULT_CONFIG/modelFilterAllows)
// and chrome/fetch. All server JSON is genuinely opaque, so it's typed `any`; our own data uses the contract.
import type { MlConfig, ApiFormat, NeutralMessage, ToolCall, FetchLlmPayload, LlmResult, LoadedModel, ServerTool, JsonSchema, TokenUsage, GenPhase } from "./contract";
import { DEFAULT_CONFIG, modelFilterAllows, generatesText, producesEmbeddings } from "./contract";   // single source of truth (see contract.ts)
import { loadedFrom } from "./resource-events";

// The wire body we assemble for a chat request (grows per format/options).
interface ChatBody {
    model: string;
    messages: any[];
    think?: boolean;
    response_format?: unknown;
    format?: unknown;
    max_tokens?: number;
    options?: Record<string, unknown>;      // Ollama runtime opts (ollama format)
    tools?: unknown[];
    tool_ids?: string[];
    params?: Record<string, unknown>;       // OpenWebUI reads runtime params here (openai format)
}

interface ApiFormatHandler {
    buildMessage(m: NeutralMessage): any;
    extractContent(data: any): string | null | undefined;
    // Does the response have this format's message CONTAINER (openai: `choices`;
    // ollama: `message`)? Distinguishes an empty/filtered reply (container present,
    // content null — a valid-but-empty response) from a genuine format/endpoint
    // mismatch (no container at all — e.g. the SPA HTML from a wrong route).
    hasContainer(data: any): boolean;
    // The model's separate reasoning/thinking text (OpenAI reasoning_content /
    // Ollama message.thinking), when present — kept out of `content`.
    extractReasoning(data: any): string | null | undefined;
    extractToolCalls(data: any): ToolCall[];
    expectedShape: string;
    applyFormat(body: ChatBody, schema: JsonSchema): void;
    applyMaxTokens(body: ChatBody, n: number): void;
    // num_ctx / num_gpu placement differs by backend: Ollama's native route reads
    // an `options` object; OpenWebUI's OpenAI route ignores `options` and expects
    // these as TOP-LEVEL fields (the OpenAI-compatible convention).
    applyRuntimeOptions(body: ChatBody, opts: { numCtx?: number; numGpu?: number }): void;
    // Ollama's thinking toggle. Native route reads a top-level `think`; OpenWebUI's
    // OpenAI route reads it from `params` (same channel as num_ctx) — a top-level
    // `think` there is dropped, so `think:false` silently fails to disable it.
    applyThink(body: ChatBody, think: boolean): void;
    streamChunk(line: string): { delta: string; reasoning?: string; toolCall: boolean; toolCallDelta?: unknown[] | null; sources?: unknown[] | null; usage?: TokenUsage | null } | null;
}

/** Normalize a server's token counts into TokenUsage, or null when absent.
 *  Handles every spelling we see from one place: OpenAI (`prompt_tokens`), the
 *  newer OpenAI naming (`input_tokens`), and Ollama-native (`prompt_eval_count`).
 *  OpenWebUI's `usage` block carries all three, and Ollama puts its counts at the
 *  response root — so callers pass `data.usage || data` and this sorts it out. */
export const normalizeUsage = (u: any): TokenUsage | null => {
    if (!u || typeof u !== "object") return null;
    const n = (v: any) => (typeof v === "number" && isFinite(v) ? v : null);
    const p = n(u.prompt_tokens) ?? n(u.input_tokens) ?? n(u.prompt_eval_count);
    const c = n(u.completion_tokens) ?? n(u.output_tokens) ?? n(u.eval_count);
    if (p == null && c == null) return null;   // no counts at all → report nothing, never a fake 0
    const promptTokens = p ?? 0, completionTokens = c ?? 0;
    // Ollama-native generation time (`eval_duration`, nanoseconds) — the generation-only rate basis, when present.
    const evalNs = n(u.eval_duration);
    // How long this call spent LOADING the model before generating a token. Ollama reports it on every native
    // call — a few ms when the model was already resident, tens of seconds when it had to come off disk.
    const loadNs = n(u.load_duration);
    // Reading the PROMPT — real model work, and the half of "time to first token" that belongs to the model
    // rather than to the box. Without it, wall-minus-generation lumps prompt eval in with queue and network,
    // and a difference between two models cannot be attributed to either.
    const promptNs = n(u.prompt_eval_duration);
    const out: TokenUsage = { promptTokens, completionTokens, totalTokens: n(u.total_tokens) ?? promptTokens + completionTokens };
    if (evalNs != null && evalNs > 0) out.evalMs = evalNs / 1e6;
    if (loadNs != null && loadNs > 0) out.loadMs = loadNs / 1e6;
    if (promptNs != null && promptNs > 0) out.promptEvalMs = promptNs / 1e6;
    return out;
};

// Stamp the measured wall-clock of a model call onto its usage (source-side timing the server doesn't report),
// so a run's tok/s can divide by "time spent waiting on the model" (excluding our tool runs, which happen
// between calls). No usage (server reported no counts) → nothing to stamp. Never mutates the input.
const withGenMs = (usage: TokenUsage | null, genMs: number): TokenUsage | null =>
    usage ? { ...usage, genMs } : usage;

// OpenAI serves tool-call arguments as a JSON string; Ollama as an object.
// Normalize to a parsed object, falling back to the raw value on bad JSON.
function parseToolArgs(args: unknown): Record<string, unknown> | string {
    if (args == null) return {};
    if (typeof args === "object") return args as Record<string, unknown>;
    try { return JSON.parse(args as string); } catch { return args as string; }
}

// OpenWebUI's server-side tool-execution loop (which runs a `tool_ids` tool and
// returns a finished answer) is selected per-request via params.function_calling,
// but its label was renamed across versions — "legacy" on v0.10.0+, "default"
// on older builds. Rather than sniff the version (a mapping that rots every time
// they reshuffle), we try these in order and detect which one the server
// actually honored. See isHandedBack + the toolIds path in fetchLLM.
const SERVER_TOOL_MODES = ["legacy", "default"];

// A "handed-back" response is OpenWebUI returning an unexecuted tool_call (empty
// content + tool_calls present) instead of running the server-side tool and
// answering — the signature of native function calling, or of a function_calling
// value the server didn't honor.
function isHandedBack(format: ApiFormatHandler, data: any): boolean {
    const content = format.extractContent(data);
    return (!content || !content.trim()) && format.extractToolCalls(data).length > 0;
}

// Messages arrive in a neutral shape: { role, content, images?, tool_calls?,
// tool_call_id? } with images as full data URLs; each format converts them to
// its wire representation. tool_calls are normalized as { id, name, arguments }.
const API_FORMATS: Record<ApiFormat, ApiFormatHandler> = {
    // chat/completions (OpenWebUI /api, or any OpenAI-compatible server)
    openai: {
        buildMessage({ role, content, images = [], tool_calls, tool_call_id }: NeutralMessage) {
            if (role === "tool") return { role: "tool", tool_call_id, content };
            if (tool_calls) {
                return {
                    role,
                    content: content ?? "",
                    tool_calls: tool_calls.map((tc, i) => ({
                        id: tc.id ?? `call_${i}`,
                        type: "function",
                        function: {
                            name: tc.name,
                            arguments: typeof tc.arguments === "string"
                                ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
                        },
                    })),
                };
            }
            if (!images.length) return { role, content };
            return {
                role,
                content: [
                    { type: "text", text: content },
                    ...images.map(u => ({ type: "image_url", image_url: { url: u } })),
                ],
            };
        },
        extractContent: (data: any) => data.choices?.[0]?.message?.content,
        hasContainer: (data: any) => Array.isArray(data?.choices),
        extractReasoning: (data: any) => data.choices?.[0]?.message?.reasoning_content,
        extractToolCalls: (data: any): ToolCall[] => (data.choices?.[0]?.message?.tool_calls || []).map((tc: any) => ({
            id: tc.id,
            name: tc.function?.name,
            arguments: parseToolArgs(tc.function?.arguments),
        })),
        expectedShape: "choices[0].message.content",
        // OpenAI structured outputs: response_format with a JSON schema.
        applyFormat(body, schema) {
            body.response_format = {
                type: "json_schema",
                json_schema: { name: "response", strict: true, schema },
            };
        },
        // Cap generated tokens (OpenAI-compatible field).
        applyMaxTokens(body, n) { body.max_tokens = n; },
        // OpenWebUI reads model runtime params from a request-body `params` object
        // (apply_params_to_form_data), then maps them into Ollama's `options` for
        // Ollama-owned models — the SAME channel function_calling rides. A direct
        // `options` object on this route is overwritten; top-level fields dropped.
        // (Confirmed in OpenWebUI's source: utils/middleware.py + utils/payload.py.)
        applyRuntimeOptions(body, { numCtx, numGpu }) {
            const p: Record<string, unknown> = {};
            if (typeof numCtx === "number") p.num_ctx = numCtx;
            if (typeof numGpu === "number") p.num_gpu = numGpu;
            if (Object.keys(p).length) body.params = { ...body.params, ...p };
        },
        // OpenWebUI reads `think` from params (same channel as num_ctx); top-level is dropped.
        applyThink(body, think) { body.params = { ...body.params, think }; },
        // Parse one line of a streamed SSE response into { delta, toolCall }, or
        // null to skip (comments, blanks, the [DONE] sentinel, non-JSON).
        streamChunk(line) {
            if (!line.startsWith("data:")) return null;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") return null;
            let obj: any;
            try { obj = JSON.parse(payload); } catch { return null; }
            const choice = obj.choices?.[0] || {};
            return {
                delta: choice.delta?.content || "",
                reasoning: choice.delta?.reasoning_content || "",
                toolCall: choice.finish_reason === "tool_calls" || !!choice.delta?.tool_calls,
                // The raw tool_call FRAGMENTS (OpenAI streams them incrementally, keyed by `index`: id + name +
                // arguments-string pieces across chunks). streamAgentTurn accumulates them by index.
                toolCallDelta: Array.isArray(choice.delta?.tool_calls) ? choice.delta.tool_calls : null,
                // OpenWebUI emits tool/RAG provenance on its own line: { sources: [...] }.
                sources: Array.isArray(obj.sources) ? obj.sources : null,
                // Usage rides the final SSE chunk (stream_options.include_usage / OpenWebUI).
                usage: normalizeUsage(obj.usage),
            };
        },
    },
    // Ollama native /api/chat (e.g. OpenWebUI's /ollama/api/chat passthrough)
    ollama: {
        buildMessage({ role, content, images = [], tool_calls }: NeutralMessage) {
            // Ollama tool results carry no tool_call_id (matched by order).
            if (role === "tool") return { role: "tool", content };
            if (tool_calls) {
                return {
                    role,
                    content: content ?? "",
                    tool_calls: tool_calls.map(tc => ({
                        function: { name: tc.name, arguments: parseToolArgs(tc.arguments) },
                    })),
                };
            }
            const message: any = { role, content };
            if (images.length) message.images = images.map(u => u.split(",")[1]);
            return message;
        },
        extractContent: (data: any) => data.message?.content,
        hasContainer: (data: any) => data?.message != null,
        extractReasoning: (data: any) => data.message?.thinking,
        extractToolCalls: (data: any): ToolCall[] => (data.message?.tool_calls || []).map((tc: any, i: number) => ({
            id: `call_${i}`,
            name: tc.function?.name,
            arguments: tc.function?.arguments,
        })),
        expectedShape: "message.content",
        // Ollama takes a JSON schema (or the string "json") directly as `format`.
        applyFormat(body, schema) {
            body.format = schema;
        },
        // Cap generated tokens (Ollama's num_predict lives under options).
        applyMaxTokens(body, n) { body.options = { ...body.options, num_predict: n }; },
        // Ollama reads runtime options from the `options` object (native route).
        applyRuntimeOptions(body, { numCtx, numGpu }) {
            if (typeof numCtx === "number") body.options = { ...body.options, num_ctx: numCtx };
            if (typeof numGpu === "number") body.options = { ...body.options, num_gpu: numGpu };
        },
        // Ollama's native route reads a top-level `think`.
        applyThink(body, think) { body.think = think; },
        // Ollama streams newline-delimited JSON objects ({ message.content,
        // done }); each whole line is a chunk.
        streamChunk(line) {
            let obj: any;
            try { obj = JSON.parse(line); } catch { return null; }
            // Ollama puts prompt_eval_count/eval_count on the FINAL object (done:true).
            return { delta: obj.message?.content || "", reasoning: obj.message?.thinking || "", toolCall: !!obj.message?.tool_calls,
                // Ollama sends tool_calls WHOLE in a chunk (object args, no index/id) — not fragmented like OpenAI.
                toolCallDelta: Array.isArray(obj.message?.tool_calls) ? obj.message.tool_calls : null,
                usage: obj.done ? normalizeUsage(obj) : null };
        },
    },
};

export function getConfig(): Promise<MlConfig> {
    return chrome.storage.sync.get(DEFAULT_CONFIG) as Promise<MlConfig>;
}

// model -> capabilities array | null, per service-worker lifetime
const capabilitiesCache = new Map<string, string[] | null>();
// Output DIMENSIONS, from the same /api/show response — `model_info["<family>.embedding_length"]`. Filled by
// modelCapabilities so the settings picker costs no extra round trip.
//
// NOTE this field is present for CHAT models too, where it is the hidden size (qwen3.8:27b reports 5120), so
// it must never be used to DETECT an embedding model — only `capabilities` can. It is shown beside a model
// the user has already chosen as an embedding model, which is the only context where it means what it says.
const dimsCache = new Map<string, number | null>();

// Short-lived cache of Ollama's resident set (/api/ps). It changes as models load
// and unload, so a few seconds keeps the num_ctx-reuse check cheap across a run's
// burst of vision sub-calls without going stale. Short by design: a stale "resident"
// would wrongly skip the cap on a fresh load (risking a huge-context OOM), so we
// bound the risk window rather than trust it for long.
let psCache: { ts: number; models: any[] } | null = null;
const PS_CACHE_MS = 2500;

export async function residentModels(config: MlConfig): Promise<any[]> {
    if (psCache && Date.now() - psCache.ts < PS_CACHE_MS) return psCache.models;
    let models: any[] = [];
    try { models = (await findOllamaBase(config)).loaded; } catch { /* no Ollama → treat as nothing resident */ }
    psCache = { ts: Date.now(), models };
    return models;
}

// The context window a model is currently LOADED with (Ollama /api/ps
// `context_length`), or null when it isn't resident or the server is too old to
// report it. Used to skip a num_ctx override that would needlessly reload an
// already-loaded model. Matches on the full tagged name (only normalising :latest).
async function residentContextLength(config: MlConfig, model: string): Promise<number | null> {
    const norm = (m: string) => m.replace(/:latest$/, "");
    const hit = (await residentModels(config)).find(
        (x: any) => x.model === model || x.name === model || norm(x.model || x.name || "") === norm(model));
    return hit && typeof hit.context_length === "number" ? hit.context_length : null;
}

// Asks Ollama's /api/show (directly or via the OpenWebUI passthrough) for a
// model's capability list, e.g. ["completion", "tools", "vision", "thinking"].
// Returns the array, or null when it can't be determined (non-Ollama backend,
// old Ollama, cloud model, unreachable) — callers must treat null as "unknown"
// and degrade gracefully, never as "no".
/** Capabilities for MANY models at once, for the settings pickers. Sequential per model would be ~39 round
 *  trips on a real box; bounded concurrency turns that into well under a second, and `capabilitiesCache`
 *  makes every later call free. A model that fails to answer resolves to null (unknown) rather than
 *  rejecting the batch — one unreachable model must not blank the whole picker. */
/** Embed one or more strings, returning raw vectors in the same order. Throws with an actionable message
 *  rather than returning null: unlike a capability probe, a caller asking for an embedding has no sensible
 *  way to continue without one, and "which model, and is it pulled" is exactly what the human needs told.
 *
 *  Two endpoint shapes, tried in order (both verified against a live Ollama):
 *    · `/api/embed`      modern, `{model, input: string[]}` -> `{embeddings: number[][]}` — BATCHES, so N
 *                        strings cost one round trip. Preferred for that reason alone.
 *    · `/api/embeddings` legacy, `{model, prompt: string}` -> `{embedding: number[]}` — one at a time.
 *  Each is tried under the OpenWebUI passthrough prefix first, then bare, matching `modelCapabilities`. */
export async function embedTexts(config: MlConfig, model: string, inputs: string[]): Promise<number[][]> {
    if (!model) throw new Error("No embedding model configured. Set one in Settings (Models), e.g. embeddinggemma:300m, and make sure it is pulled.");
    if (!inputs.length) return [];
    const origin = new URL(config.chatUrl).origin;
    const headers = authHeaders(config);
    // Residency and placement, both measured rather than assumed (see MlConfig):
    //  · keep_alive -1 pins the model, because a cold embed is 29x a warm one and this is a SPARSE caller.
    //  · num_gpu 0 costs 33ms warm and saves the whole VRAM footprint, which the chat model wants.
    // Sent on every request, which is also what makes eviction from the VRAM panel work with no state: the
    // next call re-pins. Both are plain Ollama fields on the native route, so they pass the OpenWebUI
    // passthrough unchanged (verified: expires_at comes back in the year 2318, and size_vram is 0).
    const runtime: Record<string, unknown> = {
        ...(config.embeddingKeepAlive === false ? {} : { keep_alive: -1 }),
        ...(config.embeddingForceCpu === false ? {} : { options: { num_gpu: 0 } }),
    };
    const post = async (path: string, body: unknown): Promise<any | null> => {
        try {
            const res = await fetch(origin + path, { method: "POST", headers, body: JSON.stringify(body) });
            if (!res.ok) return null;
            return await res.json();
        } catch { return null; }
    };

    for (const path of ["/ollama/api/embed", "/api/embed"]) {
        const data = await post(path, { model, input: inputs, ...runtime });
        const vecs = data?.embeddings;
        // Length-check rather than truthiness: a partial batch would silently pair the wrong vector with
        // the wrong string, which no caller could detect.
        if (Array.isArray(vecs) && vecs.length === inputs.length) return vecs as number[][];
    }
    for (const path of ["/ollama/api/embeddings", "/api/embeddings"]) {
        const out: number[][] = [];
        for (const input of inputs) {
            const data = await post(path, { model, prompt: input, ...runtime });
            if (!Array.isArray(data?.embedding)) { out.length = 0; break; }
            out.push(data.embedding as number[]);
        }
        if (out.length === inputs.length) return out;
    }
    throw new Error(`The server returned no embeddings for "${model}". It may not be an embedding model, or not pulled — check Settings (Models), where only models reporting the embedding capability are offered.`);
}

export async function modelCapabilitiesBatch(config: MlConfig, models: string[], concurrency = 6): Promise<{ caps: Record<string, string[] | null>; dims: Record<string, number | null> }> {
    const caps: Record<string, string[] | null> = {};
    const dims: Record<string, number | null> = {};
    const queue = [...models];
    const worker = async (): Promise<void> => {
        for (let m = queue.shift(); m !== undefined; m = queue.shift()) {
            try { caps[m] = await modelCapabilities(config, m); }
            catch { caps[m] = null; }
            // Same /api/show response, so the dimensions cost nothing extra.
            const d = dimsCache.get(`${config.chatUrl}|${m}`);
            if (d != null) dims[m] = d;
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, models.length) }, worker));
    return { caps, dims };
}

export async function modelCapabilities(config: MlConfig, model: string): Promise<string[] | null> {
    const cacheKey = `${config.chatUrl}|${model}`;
    if (capabilitiesCache.has(cacheKey)) return capabilitiesCache.get(cacheKey)!;

    const origin = new URL(config.chatUrl).origin;
    const headers = authHeaders(config);

    let result: string[] | null = null;
    for (const path of ["/ollama/api/show", "/api/show"]) {
        try {
            const res = await fetch(origin + path, {
                method: "POST",
                headers,
                body: JSON.stringify({ model }),
            });
            if (!res.ok) continue;
            const data: any = await res.json();
            if (Array.isArray(data.capabilities)) {
                result = data.capabilities;
                const info = data.model_info || {};
                const dimKey = Object.keys(info).find((k) => k.endsWith(".embedding_length"));
                dimsCache.set(cacheKey, dimKey && Number.isFinite(info[dimKey]) ? Number(info[dimKey]) : null);
                break;
            }
        } catch {
            // unreachable or non-JSON — try the next candidate
        }
    }

    capabilitiesCache.set(cacheKey, result);
    return result;
}

// Whether a model has the "vision" capability: true/false, or null when the
// capability list can't be determined (see modelCapabilities).
async function modelSupportsVision(config: MlConfig, model: string): Promise<boolean | null> {
    const caps = await modelCapabilities(config, model);
    return caps === null ? null : caps.includes("vision");
}

// Rate-limit backoff tuning for `send`'s 429 handling: how many times to retry, and the per-wait ceiling.
const RATE_LIMIT_RETRIES = 4;
const RATE_LIMIT_MAX_WAIT_MS = 30_000;

// Transient network-failure RESILIENCE for `send`: a model call whose fetch fails at the NETWORK level (the
// box briefly down / restarting / a blip) is RETRIED with backoff instead of failing the run — so an ONGOING
// run rides out a short outage and RECOVERS the moment the backend returns. Bounded (attempts × wait ≈ the
// window ridden out), abort-aware (a cancel during the wait rejects cleanly). After the cap it throws the
// actionable offline error (the run fails; the sidebar's health probe shows the banner). Harmless locally.
const NET_RETRIES = 6;
// ~6 × 4s ≈ 24s of outage ridden out before giving up. Overridable (tests set 0 so the retry path runs
// instantly instead of adding 24s of real waits per down-backend test).
const NET_RETRY_WAIT_MS: number = ((): number => { try { return (globalThis as { __ML_NET_RETRY_WAIT_MS?: number }).__ML_NET_RETRY_WAIT_MS ?? 4000; } catch { return 4000; } })();
/** How long to pause before retrying a 429: the `Retry-After` header (seconds) if present, else a
 *  "try again in Xs" hint in the body, else a default. +250ms slack so we clear the window; bounded by
 *  RATE_LIMIT_MAX_WAIT_MS. Pure (header + body strings in) → unit-tested in tests/background.test.js. */
function rateLimitWaitMs(retryAfter: string | null, body: string): number {
    const cap = (ms: number) => Math.min(Math.max(ms, 0), RATE_LIMIT_MAX_WAIT_MS);
    if (retryAfter) { const s = parseFloat(retryAfter); if (!isNaN(s)) return cap(s * 1000 + 250); }
    const m = body.match(/try again in ([\d.]+)\s*s/i);
    if (m) return cap(parseFloat(m[1]) * 1000 + 250);
    return 3000;
}

// Shared setup for a chat request: resolves the model, runs the vision
// fail-fast, builds the wire body, and returns a `send(body, stream)` that does
// the privileged fetch (returning parsed JSON, or the raw Response when
// streaming). fetchLLM and streamLLM both build on this.
export async function prepareRequest(payload: FetchLlmPayload, signal?: AbortSignal) {
    const config = await getConfig();
    const headers = authHeaders(config);

    // Model resolution, in priority order: an explicit model always wins; then
    // the extend:"utility" profile's utilityModel; then the OCR model (ml.read
    // sets ocr:true, keeping the reasoning model free of image tokens); then the
    // default. utility/ocr fall back to the default model when unset.
    const useUtility = payload.extend === "utility";
    const model = payload.model
        || (useUtility && config.utilityModel)
        || (payload.ocr && config.ocrModel)
        || config.model;
    if (!model) {
        throw new Error(
            payload.ocr
                ? "No OCR model configured. Set an OCR (vision) model like qwen2.5vl " +
                  "in the popup or the sidebar settings."
                : "No model configured. Set a Model in the popup or the sidebar settings."
        );
    }
    // Model-filter whitelist: the wrapper only calls models matching the configured
    // regex (a guard against a page invoking, e.g., an expensive cloud model). Applies
    // to the RESOLVED model — main/ocr/grounding/utility all pass through here.
    if (!modelFilterAllows(model, config.modelFilter)) {
        throw new Error(`Model "${model}" is blocked by the model filter (/${config.modelFilter}/). Only matching models are callable — change or clear the filter in the extension settings.`);
    }
    // No server to talk to at all. The URL/key never leave the background (not in the page's GET_CONFIG
    // subset), so this is the only layer that can catch a missing/unreachable server — the composer can't
    // pre-flight it the way it does the model.
    if (!config.chatUrl) {
        throw new Error("No server URL configured. Set the Server URL (e.g. http://localhost:3000) and API key in the extension settings.");
    }

    const messages = payload.messages || [];
    const hasImages = messages.some(m => m.images && m.images.length);

    // Fail fast with a clear error instead of sending images to a text-only
    // model, which would otherwise error cryptically or ignore them silently.
    let visionConfirmed = false;
    if (hasImages) {
        const supportsVision = await modelSupportsVision(config, model);
        if (supportsVision === false) {
            throw new Error(
                `Model "${model}" does not support image input — ` +
                `pick a vision-capable model (e.g. qwen2.5vl, gemma3, llava).`
            );
        }
        visionConfirmed = supportsVision === true;
    }

    // tool_ids invokes OpenWebUI's server-side tools — an OpenWebUI concept that
    // plain Ollama has no notion of. Fail clearly rather than silently no-op.
    if (payload.toolIds?.length && config.apiFormat === "ollama") {
        throw new Error(
            "Server-side tool_ids requires OpenWebUI; the Ollama-native endpoint " +
            "doesn't support it. Use client-side tools (ml.step) instead."
        );
    }

    const format = API_FORMATS[config.apiFormat] || API_FORMATS.openai;

    const body: ChatBody = {
        model,
        messages: messages.map(m => format.buildMessage(m)),
    };
    // Ollama's thinking toggle. Only sent when explicitly boolean — models without
    // thinking support reject the param. Placement is per-format (see applyThink):
    // OpenWebUI's OpenAI route needs it in `params`, not top-level.
    if (typeof payload.think === "boolean") format.applyThink(body, payload.think);

    // Structured output: constrain the reply to a JSON schema. The wire shape
    // differs per backend; the caller parses the returned JSON string.
    if (payload.schema) format.applyFormat(body, payload.schema);

    // Cap generated tokens (openai max_tokens / ollama num_predict). Guards
    // against a runaway generation pegging the model — see ml.lookTool, which
    // bounds vision calls where this has bitten.
    if (typeof payload.maxTokens === "number" && Number.isInteger(payload.maxTokens) && payload.maxTokens > 0) {
        format.applyMaxTokens(body, payload.maxTokens);
    }

    // Ollama runtime options: context window (num_ctx) + GPU layers (num_gpu, 0 =
    // force CPU). extend:"utility" fills these from the utility-model config;
    // explicit numCtx/numGpu override. Opt-in, so only present when asked. The
    // format handler puts them where each backend reads them (Ollama `options` vs
    // OpenAI-compat top-level) — OpenWebUI's OpenAI route ignores an options
    // object, so mis-placing them silently dropped Force-CPU / context.
    // extend:"utility" → the utility profile's num_ctx; ml.read (ocr) → the small ocrNumCtx so the OCR
    // model doesn't fresh-load at its full 256K window. An explicit payload.numCtx overrides either. The
    // residency guard below then reuses an already-loaded (bigger) model instead of reloading it.
    let numCtx = payload.numCtx ?? (useUtility ? config.utilityNumCtx : payload.ocr ? config.ocrNumCtx : undefined);
    const numGpu = payload.numGpu ?? (useUtility && config.utilityForceCpu ? 0 : undefined);
    // Reuse an already-loaded model instead of reloading it at a smaller context.
    // A num_ctx override that's SMALLER than what the model is currently resident
    // with forces Ollama to unload + reload — the churn behind the latency and the
    // flapping usage bar when delegated vision sub-calls (capped at VISION_NUM_CTX)
    // hit the agent's own driver model. The cap only exists to bound a FRESH load;
    // if the model already fits the request, send the RESIDENT value (not undefined).
    //
    // Why not drop it to undefined: `undefined` = "no num_ctx", and if our residency
    // belief is stale (the ~short ps cache raced an eviction / keep-alive expiry), a
    // request with NO num_ctx makes Ollama FRESH-load the model at its default — which
    // on a big-VRAM box auto-sizes to the model's full window (e.g. qwen2.5vl → 128K),
    // ballooning KV cache for a task that needs ~1.4K tokens. Sending the believed value
    // instead: a genuinely-resident model matches → no reload; a mistaken/fresh load
    // still stays bounded at that value, never the auto-sized default.
    if (typeof numCtx === "number") {
        const resident = await residentContextLength(config, model);
        if (resident !== null && resident >= numCtx) numCtx = resident;
    }
    format.applyRuntimeOptions(body, {
        numCtx: typeof numCtx === "number" ? numCtx : undefined,
        numGpu: typeof numGpu === "number" ? numGpu : undefined,
    });

    // Client-side tool definitions (ml.step): passed through to the model, which
    // may reply with tool_calls. Same schema shape for both backends.
    if (payload.tools?.length) body.tools = payload.tools;
    // Server-side tools run by OpenWebUI (ml.chat { toolIds }). tool_ids only
    // works with OpenWebUI's server-side execution loop; the per-request
    // function_calling override that selects it is applied in the send loop
    // below (its label is version-dependent, so we probe SERVER_TOOL_MODES).
    if (payload.toolIds?.length) body.tool_ids = payload.toolIds;

    // Wait ms, but reject early if the run is aborted mid-pause (so a cancel during a rate-limit backoff
    // doesn't hang until the timer fires).
    const abortableWait = (ms: number): Promise<void> => new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
    });

    const send = async (requestBody: ChatBody, stream = false): Promise<any> => {
        // Rate-limit backoff: a free tier / shared backend answers 429 with a Retry-After (or a "try again in
        // Xs" in the body). Rather than fail the whole run, pace ourselves — wait the advised delay and retry.
        // Bounded (attempts + per-wait cap) so it can be slow but never hangs. Harmless on a local backend
        // (Ollama never 429s). See RATE_LIMIT_* below.
        for (let attempt = 0; ; attempt++) {
            let res: Response;
            try {
                res = await fetch(config.chatUrl, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({ ...requestBody, stream }),
                    signal,   // ABORT_TASK → this fetch rejects with an AbortError (kills a slow generation)
                });
            } catch (e: any) {
                if (e?.name === "AbortError") throw e;   // a real cancel — leave it for the loop to read as cancelled
                // A network-level failure (server down, wrong host/port, DNS, refused connection, TLS/CORS) —
                // fetch rejects with a bare "Failed to fetch". RETRY with backoff first: a transient blip
                // (box restarting mid-run) is ridden out so the run RECOVERS when the backend returns. Only
                // after the bounded window do we give up with an actionable message (the raw one is meaningless
                // and identical for every cause). abortableWait rejects on a cancel, so Stop still works.
                if (attempt < NET_RETRIES) { await abortableWait(NET_RETRY_WAIT_MS); continue; }
                throw new Error(
                    `Couldn't reach the server at ${config.chatUrl} (${e?.message || e}). ` +
                    `Is OpenWebUI / Ollama running there? Check the Server URL, API key, and API format in the extension settings.`
                );
            }
            if (res.status === 429 && attempt < RATE_LIMIT_RETRIES) {
                const text = await res.text().catch(() => "");
                await abortableWait(rateLimitWaitMs(res.headers?.get("retry-after") ?? null, text));
                continue;   // retry the same request after the advised pause
            }
            if (!res.ok) {
                const text = await res.text().catch(() => "");
                let msg = `HTTP ${res.status} from ${config.chatUrl}: ${text.slice(0, 300)}`;
                // Capability probe was inconclusive for this backend, so the images
                // themselves are a plausible culprit — say so.
                if (hasImages && !visionConfirmed) {
                    msg += " (request included images — the model may not support image input)";
                }
                throw new Error(msg);
            }
            return stream ? res : res.json();
        }
    };

    return { config, format, body, send, model };
}

const HANDBACK_ERROR =
    "OpenWebUI returned the tool call without executing it (empty content, " +
    "finish_reason=tool_calls), so no answer was produced. Set this model's " +
    'Function Calling to the server-side loop ("Legacy" on OpenWebUI v0.10.0+, ' +
    '"Default" on older builds), or check that the tool id is correct.';

export async function fetchLLM(payload: FetchLlmPayload, signal?: AbortSignal): Promise<LlmResult | { content: string | null; tool_calls: ToolCall[]; usage: TokenUsage | null }> {
    const { config, format, body, send, model } = await prepareRequest(payload, signal);
    const _t0 = Date.now();   // wall-clock of this model call → usage.genMs (for the run's tok/s)

    let data: any;
    if (payload.toolIds?.length && !payload.raw) {
        // Force OpenWebUI's server-side execution loop so it runs the tool and
        // returns finished content. We try each mode label until the server
        // stops handing back an unexecuted tool_call — version-agnostic, no
        // version sniffing, just check what actually came back.
        for (const mode of SERVER_TOOL_MODES) {
            body.params = { ...body.params, function_calling: mode };
            data = await send(body);
            if (!isHandedBack(format, data)) break;
        }
        if (isHandedBack(format, data)) throw new Error(HANDBACK_ERROR);
    } else {
        data = await send(body);
    }

    // Raw mode (ml.step): hand back content + normalized tool_calls so the
    // caller drives the loop. content may be null when the model chose a tool.
    // Usage rides along so the agent loop can track its context occupancy per step.
    if (payload.raw) {
        return {
            content: format.extractContent(data) ?? null,
            tool_calls: format.extractToolCalls(data),
            // The model's separate thinking channel (reasoning_content / message.thinking). The agent
            // loop surfaces it as a collapsible "think" section, distinct from `content` (its prose).
            reasoning: format.extractReasoning(data) || null,
            usage: withGenMs(normalizeUsage(data.usage || data), Date.now() - _t0),
        };
    }

    const content = format.extractContent(data);

    if (content == null) {
        // The message CONTAINER is there but content is null → a valid-but-EMPTY reply
        // (the model said nothing, refused, or a provider content-filtered it — e.g.
        // MiniMax's `output_sensitive`). Return "" so a vision sub-call degrades to a
        // no-match and a chat gets an empty string, rather than crashing the run. Only a
        // MISSING container is a real format/endpoint mismatch (e.g. a wrong route's SPA HTML).
        if (format.hasContainer(data)) {
            return { content: "", sources: [], model, reasoning: format.extractReasoning(data) || null, usage: withGenMs(normalizeUsage(data.usage || data), Date.now() - _t0) };
        }
        throw new Error(
            `Response did not match the "${config.apiFormat}" format ` +
            `(expected ${format.expectedShape}). ` +
            `Top-level keys were: ${Object.keys(data).join(", ")} — ` +
            `check the API format setting in the extension popup.`
        );
    }

    // sources: server-side tool / RAG provenance (OpenWebUI attaches it top-level
    // when a tool runs). Absent on plain chats and the Ollama-native format.
    // usage: OpenWebUI nests it under `usage`; Ollama-native puts counts at the root.
    return { content, sources: Array.isArray(data.sources) ? data.sources : [], model, reasoning: format.extractReasoning(data) || null, usage: withGenMs(normalizeUsage(data.usage || data), Date.now() - _t0) };
}

// Streaming variant of fetchLLM: reads the SSE/NDJSON response and calls
// onDelta(text) for each content chunk, returning the full concatenated text.
// Text-only — no schema/raw/tools; toolIds is supported (streams each
// server-side mode; a handed-back attempt streams no content, so nothing is
// emitted to the caller before we retry the next mode).
export async function streamLLM(payload: FetchLlmPayload, onDelta: (delta: string) => void, signal?: AbortSignal): Promise<{ content: string; sources: unknown[]; model: string; reasoning: string | null; usage: TokenUsage | null }> {
    const { format, body, send, model } = await prepareRequest(payload, signal);
    const _t0 = Date.now();   // wall-clock of this streamed call → usage.genMs

    const consume = async (res: Response) => {
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "", content = "", reasoning = "", sawToolCall = false;
        let sources: unknown[] = [];
        let usage: TokenUsage | null = null;
        const handleLine = (line: string) => {
            const chunk = format.streamChunk(line);
            if (!chunk) return;
            if (chunk.delta) { content += chunk.delta; onDelta(chunk.delta); }
            if (chunk.reasoning) reasoning += chunk.reasoning;   // separate thinking stream (not emitted to the caller)
            if (chunk.toolCall) sawToolCall = true;
            // sources arrive on their own SSE line (no choices) — capture them.
            if (Array.isArray(chunk.sources)) sources = chunk.sources;
            if (chunk.usage) usage = chunk.usage;   // rides the final chunk
        };
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (line) handleLine(line);
            }
        }
        if (buffer.trim()) handleLine(buffer.trim());
        return { content, sawToolCall, sources, reasoning: reasoning || null, usage };
    };

    if (payload.toolIds?.length) {
        for (const mode of SERVER_TOOL_MODES) {
            body.params = { ...body.params, function_calling: mode };
            const { content, sawToolCall, sources, reasoning, usage } = await consume(await send(body, true));
            if (content.trim() || !sawToolCall) return { content, sources, model, reasoning, usage: withGenMs(usage, Date.now() - _t0) };   // real answer, or a plain empty completion
        }
        throw new Error(HANDBACK_ERROR);
    }

    const { content, sources, reasoning, usage } = await consume(await send(body, true));
    return { content, sources, model, reasoning, usage: withGenMs(usage, Date.now() - _t0) };
}

/** Streaming variant for the AGENT loop (opt-in `stream:true`). Unlike streamLLM (text-only), it ACCUMULATES
 *  tool_calls from the stream too — the loop needs them — while calling `onDelta({reasoning, content})` with the
 *  running accumulation so a long "thinking" phase shows live. Returns the same shape as fetchLLM `raw`. The
 *  agent loop uses client-side `tools` (not `tool_ids`), so no SERVER_TOOL_MODES probe is needed here. */
export async function streamAgentTurn(
    payload: FetchLlmPayload,
    onDelta: (acc: { reasoning: string; content: string; phases: GenPhase[]; phaseChanged: boolean }) => void,
    signal?: AbortSignal,
): Promise<{ content: string | null; tool_calls: ToolCall[]; reasoning: string | null; usage: TokenUsage | null }> {
    const { format, body, send } = await prepareRequest(payload, signal);
    const _t0 = Date.now();   // wall-clock of this streamed agent-turn call → usage.genMs
    let content = "", reasoning = "";
    // OpenAI streams tool_calls as FRAGMENTS keyed by `index` (id + name + arguments-string pieces); Ollama
    // sends them WHOLE in a chunk. Accumulate both, then normalize via the format's own extractToolCalls.
    const byIndex = new Map<number, { id?: string; name?: string; args: string }>();
    let ollamaCalls: unknown[] | null = null;
    let usage: TokenUsage | null = null;
    // WHAT the model is doing, moment to moment. This is the only place it is observable: the parsed chunk
    // says which channel a line carried, and everything downstream sees just the accumulated strings. Stamped
    // HERE because the service worker is the executor — a mark taken after the port hop measures the hop.
    // Appended only on a CHANGE, so a turn costs a handful of entries rather than one per line.
    const phases: GenPhase[] = [];
    const mark = (kind: GenPhase["kind"]): boolean => {
        if (phases.length && phases[phases.length - 1].kind === kind) return false;
        phases.push({ kind, atMs: Date.now() - _t0 });
        return true;
    };
    const reader = (await send(body, true)).body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const handleLine = (line: string) => {
        const chunk = format.streamChunk(line);
        if (!chunk) return;
        let changed = false, phaseChanged = false;
        if (chunk.delta) { content += chunk.delta; changed = true; phaseChanged = mark("answer") || phaseChanged; }
        if (chunk.reasoning) { reasoning += chunk.reasoning; changed = true; phaseChanged = mark("think") || phaseChanged; }
        if (chunk.usage) usage = chunk.usage;
        if (Array.isArray(chunk.toolCallDelta)) {
            phaseChanged = mark("call") || phaseChanged;
            for (const tc of chunk.toolCallDelta as any[]) {
                if (typeof tc?.index === "number") {   // OpenAI fragment
                    const cur = byIndex.get(tc.index) || { args: "" };
                    if (tc.id) cur.id = tc.id;
                    if (tc.function?.name) cur.name = tc.function.name;
                    if (typeof tc.function?.arguments === "string") cur.args += tc.function.arguments;
                    byIndex.set(tc.index, cur);
                } else { ollamaCalls = chunk.toolCallDelta; }   // Ollama whole array
            }
        }
        // A phase change is reported even with no new TEXT: a turn that only calls a tool produces no content
        // or reasoning deltas at all, so a caller throttling on text alone would never hear that it started.
        if (changed || phaseChanged) onDelta({ reasoning, content, phases, phaseChanged });
    };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (line) handleLine(line);
        }
    }
    if (buffer.trim()) handleLine(buffer.trim());
    // Reconstruct a non-streaming-shaped object so the SAME format.extractToolCalls normalizes it → {id,name,arguments}.
    let tool_calls: ToolCall[] = [];
    if (ollamaCalls) tool_calls = format.extractToolCalls({ message: { tool_calls: ollamaCalls } } as any);
    else if (byIndex.size) {
        const arr = [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => ({ id: v.id, type: "function", function: { name: v.name, arguments: v.args } }));
        tool_calls = format.extractToolCalls({ choices: [{ message: { tool_calls: arr } }] } as any);
    }
    const timed = withGenMs(usage, Date.now() - _t0);
    return { content: content || null, tool_calls, reasoning: reasoning || null,
             usage: timed && phases.length ? { ...timed, genPhases: phases } : timed };
}

export function authHeaders(config: MlConfig): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;
    return headers;
}

// Fetches available model ids. The list route differs by backend — OpenWebUI
// serves /api/models, other OpenAI-compatible servers /v1/models, direct
// Ollama /api/tags — and unknown GET routes on OpenWebUI return the frontend
// HTML, so a non-JSON body just means "wrong path, try the next one".
// Returns the model ids plus, when the source reveals it, the subset that is
// Ollama-backed (local). `ollamaModels` is null when the source can't tell
// (e.g. /v1/models has no provenance) — callers must treat null as "unknown",
// not "none", so a bare OpenAI-compat endpoint doesn't mark everything cloud.
export async function listAvailableModels(overrides: Partial<MlConfig> = {}): Promise<{ ids: string[]; ollamaModels: string[] | null }> {
    const config = { ...(await getConfig()), ...overrides };
    const origin = new URL(config.chatUrl).origin;
    const errors: string[] = [];

    for (const path of ["/api/models", "/v1/models", "/api/tags"]) {
        let list: any;
        try {
            const res = await fetch(origin + path, { headers: authHeaders(config) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            let data: any;
            try {
                data = await res.json();
            } catch {
                throw new Error("returned HTML, not JSON (route not found)");
            }

            list = data.data || data.models;
            if (!Array.isArray(list)) throw new Error("no model list in response");
        } catch (err) {
            errors.push(`${path}: ${(err as Error).message}`);
            continue;
        }

        // A valid-but-empty list is authoritative: the server is fine, it
        // just has nothing installed — don't bury that in route errors.
        if (!list.length) {
            throw new Error(
                "The server is reachable but has no models installed. " +
                "Pull one first (e.g. `ollama pull llama3.2`) or add a " +
                "model connection in OpenWebUI, then reload the list."
            );
        }
        const ids = list.map((m: any) => m.id || m.name).filter(Boolean);
        // Provenance per source: /api/models (OpenWebUI) tags each model with
        // owned_by/connection_type; /api/tags is Ollama's own endpoint (all
        // local); /v1/models is opaque → unknown.
        let ollamaModels: string[] | null;
        if (path === "/api/tags") {
            ollamaModels = ids;
        } else if (path === "/v1/models") {
            ollamaModels = null;
        } else {
            ollamaModels = list
                .filter((m: any) => m.owned_by === "ollama" || m.connection_type === "local" || m.ollama != null)
                .map((m: any) => m.id || m.name).filter(Boolean);
        }
        return { ids, ollamaModels };
    }
    throw new Error(errors.join("; "));
}

/**
 * Lists OpenWebUI's server-side tools (the valid `toolIds`) with their function specs.
 *
 * The route is OpenWebUI-only: a bare Ollama endpoint has no such concept, and — like
 * every unknown GET there — an OpenWebUI 404 returns the frontend HTML, so a non-JSON
 * body means "not an OpenWebUI server" rather than an error worth throwing. Both cases
 * degrade to an empty list: "this server has no server-side tools" is the honest
 * answer, not a failure.
 *
 * A tool server (OpenAPI/MCP) lists as ONE entry with no specs — OpenWebUI resolves its
 * function list only at call time — so `functions` is empty there by design.
 *
 * @returns {Promise<ServerTool[]>} The tools this API key may use; empty on a non-OpenWebUI server.
 */
export async function listServerTools(): Promise<ServerTool[]> {
    const config = await getConfig();
    const origin = new URL(config.chatUrl).origin;

    let list: any;
    try {
        const res = await fetch(`${origin}/api/v1/tools/`, { headers: authHeaders(config) });
        if (!res.ok) return [];
        list = await res.json();
    } catch {
        return [];   // unreachable, or the SPA HTML (not OpenWebUI)
    }
    if (!Array.isArray(list)) return [];

    return list.map((t: any): ServerTool => ({
        id: t.id,
        name: t.name || t.id,
        description: t.meta?.description || "",
        // The synthetic ids OpenWebUI mints for proxied servers: `server:<id>` (OpenAPI)
        // and `server:mcp:<id>`. Anything else is a local Python tool.
        kind: String(t.id).startsWith("server:mcp:") ? "mcp"
            : String(t.id).startsWith("server:") ? "openapi" : "local",
        functions: (Array.isArray(t.specs) ? t.specs : []).map((s: any) => ({
            name: s.name,
            description: s.description || "",
            parameters: s.parameters || null,
        })),
    })).filter((t: ServerTool) => !!t.id);
}

// Persistently switches the default model, validating against the server's
// model list so page scripts can't write junk into the saved config.
export async function setModel(model: unknown): Promise<string> {
    if (!model || typeof model !== "string") {
        throw new Error("setModel expects a model id string.");
    }
    const { ids } = await listAvailableModels();
    if (!ids.includes(model)) {
        throw new Error(`Unknown model "${model}". Available: ${ids.join(", ")}`);
    }
    const config = await getConfig();
    if (!modelFilterAllows(model, config.modelFilter)) {
        throw new Error(`Model "${model}" is blocked by the model filter (/${config.modelFilter}/). Pick a matching model, or change the filter in the extension settings.`);
    }
    await chrome.storage.sync.set({ model });
    return model;
}

// Locates the Ollama API root behind the configured chat URL — either the
// OpenWebUI /ollama passthrough or a direct Ollama server — and returns it
// along with the currently loaded models. /api/ps only exists on Ollama, so
// it doubles as the discriminator.
export async function findOllamaBase(config: MlConfig): Promise<{ base: string; loaded: any[] }> {
    const origin = new URL(config.chatUrl).origin;
    for (const base of [`${origin}/ollama`, origin]) {
        try {
            const res = await fetch(`${base}/api/ps`, { headers: authHeaders(config) });
            if (!res.ok) continue;
            const data: any = await res.json();
            if (Array.isArray(data.models)) return { base, loaded: data.models };
        } catch {
            // unreachable or non-JSON — try the next candidate
        }
    }
    throw new Error(`Could not reach an Ollama API behind ${origin}.`);
}

export async function listLoadedModels(): Promise<LoadedModel[]> {
    const config = await getConfig();
    const { loaded } = await findOllamaBase(config);
    // The row -> LoadedModel mapping lives in resource-events.ts because the event stream's `sample` frames
    // embed this same body verbatim. Two transports, one parser: the polled panel and the streamed one
    // cannot end up disagreeing about what a model IS.
    return loadedFrom(loaded);
}

/** GET Ollama `/api/info` — the machine's CAPACITY (per-device VRAM, system RAM), through the same base
 *  discovery `/api/ps` uses. Only a patched Ollama behind an OpenWebUI with the passthrough serves this;
 *  everything else answers with the SPA's HTML. Returns **null** rather than throwing in that case — the same
 *  convention as `modelCapabilities` and `listServerTools`: unknown, never "no". */
export async function fetchOllamaInfo(): Promise<import("./contract").OllamaInfo | null> {
    const config = await getConfig();
    const origin = new URL(config.chatUrl).origin;
    for (const base of [`${origin}/ollama`, origin]) {
        try {
            const res = await fetch(`${base}/api/info`, { headers: authHeaders(config) });
            if (!res.ok) continue;
            // A non-JSON body means the wrong route (the SPA's HTML) — not a capacity of zero.
            const body = await res.json();
            if (body && typeof body === "object" && body.compute && body.compute.system_compute) return body;
        } catch { /* try the next base, then give up */ }
    }
    return null;
}

// A generate request with keep_alive: 0 tells Ollama to evict the model
// from VRAM immediately. No model argument = unload everything loaded.
export async function unloadModels(modelName?: string): Promise<string[]> {
    const config = await getConfig();
    const { base, loaded } = await findOllamaBase(config);

    const targets: string[] = modelName
        ? [modelName]
        : loaded.map((m: any) => m.model || m.name);

    for (const model of targets) {
        const res = await fetch(`${base}/api/generate`, {
            method: "POST",
            headers: authHeaders(config),
            body: JSON.stringify({ model, keep_alive: 0 }),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`Failed to unload ${model}: HTTP ${res.status} ${text.slice(0, 200)}`);
        }
    }

    return targets;
}

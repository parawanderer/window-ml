// Background service worker: owns config, builds per-format request bodies,
// extracts replies, and makes the privileged (host-permissioned) fetches. All
// server JSON is genuinely opaque, so it's typed `any`; our own data uses the
// shared contract types.
import type { MlConfig, ApiFormat, NeutralMessage, ToolCall, FetchLlmPayload, LlmResult, LoadedModel, ServerTool, JsonSchema, TokenUsage, StartRunPayload, SetApprovalPayload, CancelRunPayload, ResumeRunPayload, InjectMessagePayload, ApprovalDecision } from "./contract";
import { DEFAULT_CONFIG, modelFilterAllows, bgRunResumable, acceptLanguageFrom, pushReplay } from "./contract";   // single source of truth (see contract.ts)
import { runBackgroundAgent } from "./agent-host";   // design A: the background-hosted agent loop
import type { ToolMeta } from "./agent-loop";
import { externalSheetIds, googleSheetId, classifyContent, jsonShape, clipOut } from "./dom";   // track approved external sheets across a run + the choke-point grants; classify a fetched body + summarise its JSON shape
import { extractGrants } from "./grant-extract";   // button #3: static egress-grant extraction for "Approve + remember"
import type { FetchResult } from "./contract";
import { createNavBarrier } from "./nav-barrier";   // cross-page persistence: hold delegated tools while a run's tab navigates

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
    return { promptTokens, completionTokens, totalTokens: n(u.total_tokens) ?? promptTokens + completionTokens };
};

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

function getConfig(): Promise<MlConfig> {
    return chrome.storage.sync.get(DEFAULT_CONFIG) as Promise<MlConfig>;
}

// model -> capabilities array | null, per service-worker lifetime
const capabilitiesCache = new Map<string, string[] | null>();

// Short-lived cache of Ollama's resident set (/api/ps). It changes as models load
// and unload, so a few seconds keeps the num_ctx-reuse check cheap across a run's
// burst of vision sub-calls without going stale. Short by design: a stale "resident"
// would wrongly skip the cap on a fresh load (risking a huge-context OOM), so we
// bound the risk window rather than trust it for long.
let psCache: { ts: number; models: any[] } | null = null;
const PS_CACHE_MS = 2500;

async function residentModels(config: MlConfig): Promise<any[]> {
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
async function modelCapabilities(config: MlConfig, model: string): Promise<string[] | null> {
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
async function prepareRequest(payload: FetchLlmPayload, signal?: AbortSignal) {
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

async function fetchLLM(payload: FetchLlmPayload, signal?: AbortSignal): Promise<LlmResult | { content: string | null; tool_calls: ToolCall[]; usage: TokenUsage | null }> {
    const { config, format, body, send, model } = await prepareRequest(payload, signal);

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
            usage: normalizeUsage(data.usage || data),
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
            return { content: "", sources: [], model, reasoning: format.extractReasoning(data) || null, usage: normalizeUsage(data.usage || data) };
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
    return { content, sources: Array.isArray(data.sources) ? data.sources : [], model, reasoning: format.extractReasoning(data) || null, usage: normalizeUsage(data.usage || data) };
}

// Streaming variant of fetchLLM: reads the SSE/NDJSON response and calls
// onDelta(text) for each content chunk, returning the full concatenated text.
// Text-only — no schema/raw/tools; toolIds is supported (streams each
// server-side mode; a handed-back attempt streams no content, so nothing is
// emitted to the caller before we retry the next mode).
async function streamLLM(payload: FetchLlmPayload, onDelta: (delta: string) => void, signal?: AbortSignal): Promise<{ content: string; sources: unknown[]; model: string; reasoning: string | null; usage: TokenUsage | null }> {
    const { format, body, send, model } = await prepareRequest(payload, signal);

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
            if (content.trim() || !sawToolCall) return { content, sources, model, reasoning, usage };   // real answer, or a plain empty completion
        }
        throw new Error(HANDBACK_ERROR);
    }

    const { content, sources, reasoning, usage } = await consume(await send(body, true));
    return { content, sources, model, reasoning, usage };
}

/** Streaming variant for the AGENT loop (opt-in `stream:true`). Unlike streamLLM (text-only), it ACCUMULATES
 *  tool_calls from the stream too — the loop needs them — while calling `onDelta({reasoning, content})` with the
 *  running accumulation so a long "thinking" phase shows live. Returns the same shape as fetchLLM `raw`. The
 *  agent loop uses client-side `tools` (not `tool_ids`), so no SERVER_TOOL_MODES probe is needed here. */
async function streamAgentTurn(
    payload: FetchLlmPayload,
    onDelta: (acc: { reasoning: string; content: string }) => void,
    signal?: AbortSignal,
): Promise<{ content: string | null; tool_calls: ToolCall[]; reasoning: string | null; usage: TokenUsage | null }> {
    const { format, body, send } = await prepareRequest(payload, signal);
    let content = "", reasoning = "";
    // OpenAI streams tool_calls as FRAGMENTS keyed by `index` (id + name + arguments-string pieces); Ollama
    // sends them WHOLE in a chunk. Accumulate both, then normalize via the format's own extractToolCalls.
    const byIndex = new Map<number, { id?: string; name?: string; args: string }>();
    let ollamaCalls: unknown[] | null = null;
    let usage: TokenUsage | null = null;
    const reader = (await send(body, true)).body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const handleLine = (line: string) => {
        const chunk = format.streamChunk(line);
        if (!chunk) return;
        let changed = false;
        if (chunk.delta) { content += chunk.delta; changed = true; }
        if (chunk.reasoning) { reasoning += chunk.reasoning; changed = true; }
        if (chunk.usage) usage = chunk.usage;
        if (Array.isArray(chunk.toolCallDelta)) {
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
        if (changed) onDelta({ reasoning, content });
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
    return { content: content || null, tool_calls, reasoning: reasoning || null, usage };
}

function authHeaders(config: MlConfig): Record<string, string> {
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
async function listAvailableModels(overrides: Partial<MlConfig> = {}): Promise<{ ids: string[]; ollamaModels: string[] | null }> {
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
async function listServerTools(): Promise<ServerTool[]> {
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
async function setModel(model: unknown): Promise<string> {
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
async function findOllamaBase(config: MlConfig): Promise<{ base: string; loaded: any[] }> {
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

async function listLoadedModels(): Promise<LoadedModel[]> {
    const config = await getConfig();
    const { loaded } = await findOllamaBase(config);
    return loaded.map((m: any) => ({
        model: m.model || m.name,
        vramGB: m.size_vram ? +(m.size_vram / 1e9).toFixed(1) : null,
        sizeGB: m.size ? +(m.size / 1e9).toFixed(1) : null,
        // The context window it was loaded with. Ollama preallocates KV cache for the
        // FULL window, so this explains a big share of size_vram (a 256K-ctx load is
        // mostly cache). Older servers don't report it → null, and the UI hides it.
        contextLength: typeof m.context_length === "number" ? m.context_length : null,
        expiresAt: m.expires_at || null,
    }));
}

// A generate request with keep_alive: 0 tells Ollama to evict the model
// from VRAM immediately. No model argument = unload everything loaded.
async function unloadModels(modelName?: string): Promise<string[]> {
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

// In-flight FETCH_LLM AbortControllers, keyed by the page's requestId, so an ABORT_TASK message
// (ml.agent's signal fired) can cancel the actual fetch. Deleted when the request settles.
const inflight = new Map<string, AbortController>();

// Design A: pending background-run approvals, keyed by `${runId}:${seq}`, resolved by a SET_APPROVAL
// message the sidebar app sends (origin-authed by the shell — it only forwards a decision from the real
// extension iframe). The approve/deny decision is made here and never crosses the page: the point of A.
// Each entry keeps the resolver AND a serializable DESCRIPTOR (what's being approved) so an EXTERNAL
// approver — the `__mlApprovals` IPC channel below — can enumerate and decide gates exactly like the UI.
interface PendingApprovalDescriptor { key: string; runId: string; seq: number; step: number; tool: string; arguments: Record<string, unknown>; ts: number; routing: "ui" | "both" | "external"; }
// A gate is reachable by the external channel ONLY if its run OPTED IN (approvalRouting "both"/"external").
// A default "ui" run's gate can't be silently approved from outside — the driver must declare intent.
const externallyResolvable = (d: PendingApprovalDescriptor): boolean => d.routing === "both" || d.routing === "external";
interface PendingApproval { resolve: (d: ApprovalDecision) => void; descriptor: PendingApprovalDescriptor; }
const pendingApprovals = new Map<string, PendingApproval>();

// Resolve a pending gate by key — the SINGLE path both the origin-authed SET_APPROVAL message and the
// external `__mlApprovals` channel funnel through, so a decision from either resolves the gate everywhere
// (the same "one press resolves every surface" property, now extended to an out-of-browser approver).
// Returns false if the key is unknown (already resolved / cancelled). The stored resolver applies any side
// effects (e.g. remembering an approved sheet) and unblocks the loop.
function resolveApproval(key: string, decision: ApprovalDecision): boolean {
    const entry = pendingApprovals.get(key);
    if (!entry) return false;
    pendingApprovals.delete(key);
    entry.resolve(decision);
    return true;
}

// The EXTERNAL approval channel (idea #2). Reachable ONLY from the service-worker realm — Playwright's
// `serviceWorker.evaluate(...)` today, a desktop orchestrator via onMessageExternal / native messaging
// later — NEVER from the page main world (a web page has no chrome.runtime and can't reach this realm), so
// it grants no new power to a hostile page: it's the same unforgeable gate, opened by an automated driver
// instead of a human click. `list()` enumerates the pending gates (with what each is approving); `resolve()`
// approves/denies one by key. A driver can therefore run the whole agent HEADLESS while the browser gate
// still blocks until the driver decides. See docs / tests/e2e for the harness wiring.
(globalThis as unknown as { __mlApprovals?: unknown }).__mlApprovals = {
    // Only OPTED-IN gates (approvalRouting "both"/"external") are visible/resolvable here — a default "ui"
    // run stays human-only, so an orchestrator can't approve a run that never asked to be driven externally.
    list: (): PendingApprovalDescriptor[] => [...pendingApprovals.values()].map(v => v.descriptor).filter(externallyResolvable),
    resolve: (key: string, decision: boolean | ApprovalDecision): boolean => {
        const entry = pendingApprovals.get(key);
        if (!entry || !externallyResolvable(entry.descriptor)) return false;   // unknown, or a UI-only gate
        const norm: ApprovalDecision = (decision === true || (typeof decision === "object" && !!decision && (decision as { approved?: boolean }).approved))
            ? { approved: true, source: "external" }
            : { approved: false, feedback: (typeof decision === "object" && decision && (decision as { feedback?: string }).feedback) || undefined, source: "external" };
        return resolveApproval(key, norm);
    },
};

// Design A: the AbortController for each live background run, keyed by runId, so a CANCEL_RUN message
// (the HUD's "Cancel agent run") stops the loop at the next boundary AND kills a slow in-flight model
// call. Deleted when the run settles. Aborting resolves the loop as { cancelled: true } (partial transcript).
const runControllers = new Map<string, AbortController>();

// Design A resume (Phase 2): after a background-hosted run settles, keep enough to CONTINUE it — the
// full message history + the original StartRunPayload (deps are rebuilt from it) + the owning tab. A
// RESUME_RUN {runId, task} re-enters the loop from this history. In-memory only, so it's subject to
// MV3 service-worker eviction (~30s idle) — resume works while the SW is warm (the common
// finish-then-follow-up flow); an evicted run reports an actionable error and the caller starts fresh.
const bgRuns = new Map<string, { p: StartRunPayload; tabId: number; messages: NeutralMessage[]; sub?: import("./contract").SubcallUsage }>();

// ---- Durable resume ----
// A LIVE run's resumable snapshot is also mirrored to chrome.storage.local, so a re-spawned SW (MV3 evicts
// ~30s idle) can rehydrate an in-flight run instead of losing it. Storage holds ONLY running runs — deleted
// the moment a run settles; the in-memory bgRuns above additionally keeps COMPLETED runs for a follow-up
// RESUME (still eviction-bound, as before). Snapshot shape == a bgRuns entry.
type BgRunSnap = { p: StartRunPayload; tabId: number; messages: NeutralMessage[]; sub?: import("./contract").SubcallUsage; version?: string; ts?: number };
const BGRUN_KEY = (runId: string): string => `ml_bgrun_${runId}`;
// This extension build's version — stamped on every snapshot so a snapshot written by a PREVIOUS version
// (a reload/update happened) is recognised and invalidated on hydrate rather than silently resumed.
const EXT_VERSION: string = (() => { try { return chrome.runtime?.getManifest?.().version || ""; } catch { return ""; } })();
const persistRun = (runId: string, snap: BgRunSnap): void => {
    // Stamp version + a fresh timestamp on every write so hydrate can tell a live (evicted-seconds-ago) run
    // from a zombie (bgRunResumable), and reject a cross-version snapshot outright.
    try { void chrome.storage?.local?.set({ [BGRUN_KEY(runId)]: { ...snap, version: EXT_VERSION, ts: Date.now() } }); } catch { /* storage unavailable */ }
};
const deleteRun = (runId: string): void => {
    try { void chrome.storage?.local?.remove(BGRUN_KEY(runId)); } catch { /* storage unavailable */ }
};
// Purge EVERY persisted background run (storage + any already-hydrated in-memory state). Called on an
// extension install/update (a deliberate reload / a version bump): in-flight runs must NOT survive it — their
// snapshot may be from old code, and a reload is often exactly how you try to kill a runaway.
async function purgeAllBgRuns(): Promise<void> {
    try {
        const all = await chrome.storage.local.get(null);
        const keys = Object.keys(all || {}).filter(k => k.startsWith("ml_bgrun_"));
        if (keys.length) await chrome.storage.local.remove(keys);
    } catch { /* storage unavailable */ }
    // Drop anything hydrate already loaded this spawn so a page load can't re-adopt + resume it.
    for (const runId of [...hydratedRuns]) {
        const snap = bgRuns.get(runId);
        if (snap) untrackRun(snap.tabId, runId);
        bgRuns.delete(runId); hydratedRuns.delete(runId);
    }
    resurrectedRuns.clear();
}
// On SW startup: rehydrate any in-flight runs from storage into bgRuns + re-track them against their tab
// (activeRuns/runRebuilds) so the nav sensor + re-adopt find them. A run then continues via the existing
// resume path (page-driven today; auto-resume-on-readopt is the next slice). No-op on a first, clean spawn.
// Runs loaded from storage on THIS SW spawn = INTERRUPTED (evicted mid-flight, never settled — their storage
// snapshot outlived them). A fresh page re-adopt AUTO-RESUMES these (part 2); a run that merely COMPLETED
// (its snapshot was deleted in the finally) is not here, so it's never re-driven.
const hydratedRuns = new Set<string>();
// Runs RESURRECTED from storage after an SW respawn (hydrated → auto-resumed). CONTENT_READY moves a runId
// here as it marks the adopt `resume:true` (and clears it from hydratedRuns). RESUME_RUN reads it to know
// the surface LOST this run's session (the respawn wiped in-memory + the replay buffer), so it must RE-EMIT
// the `agent` start — a visible, Stoppable row — instead of silently resuming into a ghost.
const resurrectedRuns = new Set<string>();
async function hydratePersistedRuns(): Promise<void> {
    try {
        const all = await chrome.storage.local.get(null);
        for (const [k, v] of Object.entries(all)) {
            if (!k.startsWith("ml_bgrun_") || !v) continue;
            const snap = v as BgRunSnap;
            const runId = snap.p?.runId;
            if (!runId || typeof snap.tabId !== "number" || bgRuns.has(runId)) continue;
            // Invalidate a snapshot from a different extension version (reload/update) or a stale one (zombie):
            // delete the storage key and never resume it. Un-stamped legacy snapshots fail the version check
            // here too — the self-heal for zombies written before this guard existed.
            if (!bgRunResumable(snap, EXT_VERSION, Date.now())) { deleteRun(runId); continue; }
            bgRuns.set(runId, snap);
            hydratedRuns.add(runId);
            if (snap.p.crossPage !== false) trackRun(snap.tabId, runId, snap.p.rebuild);
        }
    } catch { /* storage unavailable / empty */ }
}
// Resolves once the startup rehydrate is done — CONTENT_READY awaits it so a page loading right after an SW
// respawn doesn't miss the in-flight run (the respawn race).
const hydrationDone: Promise<void> = (typeof chrome !== "undefined" && chrome.storage?.local) ? hydratePersistedRuns() : Promise.resolve();

// TEST-ONLY (reachable only from the SW realm via serviceWorker.evaluate, like __mlApprovals — no page can
// reach it, and nothing in prod calls it): simulate an MV3 eviction by dropping all in-memory run state, then
// re-hydrating from storage as a respawn would. An orphaned (gate-suspended) loop is left dangling exactly as
// a real eviction leaves it — its finally never runs, so the storage snapshot survives. Lets an e2e exercise
// durable resume without waiting ~30s for a real eviction.
(globalThis as unknown as { __mlEvictForTest?: unknown }).__mlEvictForTest = async (): Promise<void> => {
    runControllers.clear(); runInboxes.clear(); bgRuns.clear(); activeRuns.clear();
    runRebuilds.clear(); runReplayBuffer.clear(); pendingApprovals.clear(); hydratedRuns.clear(); resurrectedRuns.clear(); readoptPageInfo.clear();
    await hydratePersistedRuns();
};
// TEST-ONLY: seed a minimal resumable bgRun for a tab, so a unit test can exercise the "don't wipe a tab that
// still has a recoverable run" guard (resetDebug / tabHasBgRun) without driving a whole run to completion.
(globalThis as unknown as { __mlSeedBgRunForTest?: unknown }).__mlSeedBgRunForTest = (tabId: number, runId: string): void => {
    bgRuns.set(runId, { p: { runId } as unknown as StartRunPayload, tabId, messages: [] });
};

// Per-run steering inbox (a.say() mid-run): the SW-side twin of the page loop's control.inbox. INJECT_MESSAGE
// pushes here (only the owning tab may); the run's loop drains it at each step boundary (deps.drainInbox).
// Present only while a run is live (set at start, deleted in finally).
const runInboxes = new Map<string, { tabId: number; queue: { id?: string; text: string }[] }>();

// ---- Cross-page persistence (Variant A; design tmp/cross-page-agent.md) ----
// A background-hosted run delegates each DOM tool to its tab by tabId. When the page NAVIGATES the old
// document — and the toolset it registered — is destroyed and the new document loads a fresh, EMPTY toolset;
// firing the next delegated tool into that gap hits "no active agent run on this page". The barrier holds a
// delegated send while the tab is mid-navigation and releases when the new document RE-ADOPTS the run
// (rebuilds + re-registers its toolset — the CONTENT_READY → adopt round-trip). `activeRuns` maps a tab to
// the run ids it hosts so the webNavigation sensor knows which tabs to watch. See nav-barrier.ts.
const navBarrier = createNavBarrier();
const activeRuns = new Map<number, Set<string>>();   // tabId → runIds hosted in that tab
// The rebuild-config for each LIVE cross-page run (runId → RebuildConfig), set at START and cleared in the
// run's finally. bgRuns only stores a snapshot at run COMPLETION, so a MID-run navigation reads this instead.
const runRebuilds = new Map<string, import("./contract").RebuildConfig>();
// Overlay/off REPLAY buffer (cross-page): a background-hosted, cross-page-capable run's FULL debug-event
// stream per tab, so a FRESH page after a same-site navigation can rebuild the run's card MID-run (with its
// history) instead of only catching the tail. Kept separate from the DevTools debugBuffer (further below) so
// the two surfaces' replay don't entangle. Bounded ring; cleared when the tab's runs end (untrackRun).
const runReplayBuffer = new Map<number, unknown[]>();
const REPLAY_CAP = 400;   // drop-oldest (screenshots are big)
const STREAM_EMIT_MS = 90;   // min gap between live `agent-stream` deltas — smooth enough to read, not a flood
// The destination page's pageInfo, captured on re-adopt (RUN_READOPTED) and consumed ONCE by the navigate
// tool call awaiting it — so a nav's result carries the new page's context (orient-on-nav). Keyed by tab.
const readoptPageInfo = new Map<number, string>();
// captureVisibleTab quota backoff: retry a rate-limited screenshot (~2/sec cap) rather than failing the step.
const CAPTURE_RETRIES = 5;       // ~5 tries…
const CAPTURE_RETRY_MS = 550;    // …spaced just over the 1s/2-call window → clears the transient quota
const bufferReplay = (tabId: number, event: unknown): void => {
    let buf = runReplayBuffer.get(tabId);
    if (!buf) { buf = []; runReplayBuffer.set(tabId, buf); }
    pushReplay(buf, event, REPLAY_CAP);
};
const trackRun = (tabId: number, runId: string, rebuild?: import("./contract").RebuildConfig): void => {
    const s = activeRuns.get(tabId) ?? new Set<string>();
    // A fresh run on an IDLE tab starts a clean replay buffer — drop a prior COMPLETED run's retained history
    // (see untrackRun) so a new run's replay isn't polluted by the last one's. But a RESUME of a run still in
    // bgRuns (a follow-up turn under the SAME hash) MUST keep the buffer: a resume never re-emits the `agent`
    // start, so if the turn then navigates, the destination page's card has NO session to rebuild from and
    // shows blank (the reported "HUD gone after a resume that navigates"). Same run resuming → keep; a
    // different new run → wipe.
    if (!s.size && !bgRuns.has(runId)) runReplayBuffer.delete(tabId);
    s.add(runId); activeRuns.set(tabId, s);
    if (rebuild) runRebuilds.set(runId, rebuild);
};
// True if a COMPLETED-but-resumable run still lives on this tab (bgRuns keeps a snapshot at completion for a
// follow-up resume). Such a run's HUD replay buffer must survive untrackRun so a page that loads LATE (on-click
// site access, or a reload after the run finished) can still rebuild its corner card. Dropped on tab close /
// after a one-time completed replay / when a fresh run starts.
const tabHasBgRun = (tabId: number): boolean => { for (const r of bgRuns.values()) if (r.tabId === tabId) return true; return false; };
const untrackRun = (tabId: number, runId: string): void => {
    runRebuilds.delete(runId);
    const s = activeRuns.get(tabId);
    if (!s) return;
    s.delete(runId);
    if (!s.size) {
        activeRuns.delete(tabId); navBarrier.forget(tabId); readoptPageInfo.delete(tabId);
        // Keep the replay buffer if a just-completed run is still resumable on this tab (bgRuns.set ran in the
        // run's .then, before this .finally) — a late/reloaded page replays it once (CONTENT_READY). Else drop it.
        if (!tabHasBgRun(tabId)) runReplayBuffer.delete(tabId);
    }
};
// EVERY RUN_TOOL_IN_PAGE send goes through this: it waits out any in-flight navigation on the tab before
// delegating. On a tab with no navigation pending, whenReady resolves immediately (zero cost) — so a
// single-page run is unaffected.
const delegateSend = (tabId: number, msg: unknown): Promise<any> =>
    navBarrier.whenReady(tabId).then(() => chrome.tabs.sendMessage(tabId, msg));

// The navigation SENSOR: a committed MAIN-frame navigation on a tab that hosts a live run means its document
// (and registered toolset) is going away → engage the barrier so the next delegated tool waits for re-adopt.
// Sub-frame navigations (frameId != 0) don't replace the run's document, so they're ignored.
if (typeof chrome !== "undefined" && chrome.webNavigation?.onCommitted) {
    chrome.webNavigation.onCommitted.addListener((d) => {
        if (d.frameId === 0 && activeRuns.has(d.tabId)) navBarrier.noteNavigating(d.tabId);
    });
}
if (typeof chrome !== "undefined" && chrome.tabs?.onRemoved) {
    chrome.tabs.onRemoved.addListener((tabId) => { activeRuns.delete(tabId); navBarrier.forget(tabId); readoptPageInfo.delete(tabId); fetchConsent.delete(tabId); credFetchGrants.delete(tabId); runReplayBuffer.delete(tabId); releaseDebugger(tabId); });
}

// ---- Choke-point consent (docs/spec/CHOKEPOINT_CONSENT_SPEC.md) ----
// The boundary for the credentialed/unbounded ops lives HERE, not in the bypassable client-side approval.
// A privileged call passes iff: a trusted surface (sender.tab == null), a whitelisted domain, or a per-call
// grant the design-A loop minted after an iframe approval. Grants are scoped to the approved tool's
// delegation (minted in delegateTool, cleared when it returns), keyed by (tabId, resource).
// `fetchOpen` = an approved `exec` is running: its inline `ml.fetch()` calls are allowed FOR THIS RUN (the
// human approved the code containing them). Ephemeral like the rest — cleared when the exec delegation
// returns; persisting a fetched URL for the session is the separate, explicit button-#3 path (not this).
type TabGrants = { sheets: Set<string>; pyCode: Set<string>; fetchOpen?: boolean };
const pendingGrants = new Map<number, TabGrants>();
// PERSISTENT per-tab consent for `ml.fetch` — the exact URLs the user has approved fetching this session
// (per-URL, not per-origin: the human sees + approves each). Grown ONLY inside a background run's approval
// `resolve` (unforgeable — a page can't add to it); read by the FETCH_URL handler to authorise an untrusted
// page's fetch and by `fetchNeedsConsent` to auto-approve a repeat. Cleared when the tab closes.
const fetchConsent = new Map<number, Set<string>>();
const consentFetch = (tabId: number, url: string): void => {
    let s = fetchConsent.get(tabId);
    if (!s) { s = new Set(); fetchConsent.set(tabId, s); }
    s.add(url);
};
// ONE-TIME per-URL grants for a CREDENTIALED ml.fetch (fetch-as-the-user). Minted ONLY when a `fetch_url`
// call with credentials is APPROVED, and CONSUMED on the fetch — never persisted (unlike fetchConsent), so a
// credentialed fetch ALWAYS re-prompts. `execOpen`/`fetchConsent` deliberately do NOT authorize credentialed
// (it spends the user's cookies — too sensitive for the broad exec grant or a remembered consent).
const credFetchGrants = new Map<number, Set<string>>();
const grantCredFetch = (tabId: number, url: string): void => {
    let s = credFetchGrants.get(tabId);
    if (!s) { s = new Set(); credFetchGrants.set(tabId, s); }
    s.add(url);
};
/** Consume a one-time credentialed grant for (tabId, url): true if it existed (and is now spent), else false. */
const takeCredFetch = (tabId: number | undefined, url: string): boolean => {
    if (tabId == null) return false;
    const s = credFetchGrants.get(tabId);
    if (!s?.has(url)) return false;
    s.delete(url);
    return true;
};
// button #3 ("Approve + remember"): persist a gated call's static egress grants for the session. Keyed by
// `kind` so a new egress kind is one case here + one extractor in grant-extract.ts + one UI branch. Called
// ONLY from a run's approval `resolve` on a positive persist decision (unforgeable — grants are re-derived
// background-side from the call, never trusted from the message).
const persistGrants = (tabId: number, grants: import("./contract").PersistGrant[]): void => {
    for (const g of grants) {
        if (g.kind === "fetch-url") for (const u of g.urls) consentFetch(tabId, u);
    }
};
const grantsFor = (tabId: number): TabGrants => {
    let g = pendingGrants.get(tabId);
    if (!g) { g = { sheets: new Set(), pyCode: new Set() }; pendingGrants.set(tabId, g); }
    return g;
};

/** Hostname of the message's real sender (the browser-stamped tab URL — a page can't forge it). */
function senderHost(sender: chrome.runtime.MessageSender): string {
    try { return new URL(sender.tab?.url || sender.url || "").hostname.toLowerCase(); } catch { return ""; }
}

/** Trust tier of a message's sender: `surface` = internal extension page (fully trusted); `whitelisted` =
 *  a domain the user trusts to self-gate; `untrusted` = a page that must present a per-call grant. Uses the
 *  same origin derivation GET_CONFIG does for `pageApprovalAllowed`. */
async function senderTrust(sender: chrome.runtime.MessageSender): Promise<"surface" | "whitelisted" | "untrusted"> {
    if (sender.tab == null) return "surface";
    const host = senderHost(sender);
    const cfg = await getConfig();
    return host && (cfg.pageApprovalDomains || []).includes(host) ? "whitelisted" : "untrusted";
}

/** Is the `debugger` permission held? It's declared at INSTALL time (in `permissions`, not optional) —
 *  Chrome forbids `debugger` as a runtime-optional grant (`permissions.request` rejects it: "Only permissions
 *  specified in the manifest may be requested"). So this always holds once the extension is loaded + its
 *  permissions accepted; the defensive check just degrades gracefully (actionable error) if it's somehow
 *  absent (e.g. an update pending re-approval). The `cdpClick` config flag is the actual on/off. */
async function hasDebuggerPermission(): Promise<boolean> {
    try { return await chrome.permissions.contains({ permissions: ["debugger"] }); } catch { return false; }
}

// CDP debugger attach lifecycle. On a strict-CSP page EVERY exec (and every reserved-element click) runs
// through the debugger — and attach/detach is the dominant per-call cost (the eval/click itself is instant;
// the page work + content-script relay are sub-millisecond, measured). Attaching/detaching per call also
// flickers the "being debugged" infobar each time. So we attach ONCE per tab on first CDP use and REUSE it
// across the run, detaching when the run ends, the tab closes, or the tab goes idle. Chrome auto-detaches if
// the SW is evicted, so a lost cleanup can't strand the infobar.
const attachedDebuggees = new Set<number>();          // tabIds we currently hold the debugger on
const debuggerIdleTimers = new Map<number, ReturnType<typeof setTimeout>>();
const DEBUGGER_IDLE_MS = 20_000;   // detach a tab's debugger after this long with no CDP use (covers a standalone CDP_CLICK with no run to clean up)

/** Attach the debugger to `tabId` if we don't already hold it (idempotent), reusing a live attachment across
 *  calls. Returns ok, or an actionable error (missing permission / another debugger already attached). */
async function ensureDebuggerAttached(tabId: number): Promise<{ ok: true } | { error: string; needsPermission?: true }> {
    if (!(await hasDebuggerPermission())) return { error: "The `debugger` permission isn't granted — enable \"Debugger-based actions (CDP)\" in window.ml Settings → Advanced.", needsPermission: true };
    if (attachedDebuggees.has(tabId)) return { ok: true };
    try {
        await chrome.debugger.attach({ tabId }, "1.3");
        attachedDebuggees.add(tabId);
        return { ok: true };
    } catch (e) {
        const msg = (e as Error)?.message || String(e);
        if (/already attached/i.test(msg)) { attachedDebuggees.add(tabId); return { ok: true }; }   // a prior attach we didn't track / a race
        return { error: msg };
    }
}
/** Detach the debugger from `tabId` (if held) and clear its idle timer. Idempotent. */
function releaseDebugger(tabId: number): void {
    const timer = debuggerIdleTimers.get(tabId);
    if (timer) { clearTimeout(timer); debuggerIdleTimers.delete(tabId); }
    if (!attachedDebuggees.has(tabId)) return;
    attachedDebuggees.delete(tabId);
    try { void chrome.debugger.detach({ tabId }).catch(() => {}); } catch { /* already gone / tab closed */ }
}
/** Reset the idle-detach timer after a CDP op — a run detaches eagerly in its finally, but a standalone
 *  CDP_CLICK (no run) relies on this so the debugger doesn't stay attached forever. */
function touchDebugger(tabId: number): void {
    const prev = debuggerIdleTimers.get(tabId);
    if (prev) clearTimeout(prev);
    debuggerIdleTimers.set(tabId, setTimeout(() => { debuggerIdleTimers.delete(tabId); releaseDebugger(tabId); }, DEBUGGER_IDLE_MS));
}
// Chrome detached the debugger out from under us (DevTools opened on the tab, the target crashed/closed, or
// the user clicked "cancel" on the infobar) → forget the tab so the next CDP use re-attaches cleanly.
try { chrome.debugger.onDetach.addListener((source) => { if (source.tabId != null) { attachedDebuggees.delete(source.tabId); const t = debuggerIdleTimers.get(source.tabId); if (t) { clearTimeout(t); debuggerIdleTimers.delete(source.tabId); } } }); } catch { /* no debugger API in this context */ }

/** Click at a VIEWPORT coordinate via CDP — the ONLY way to reach a "reserved" surface (a cross-origin
 *  iframe, or a declarative/native closed shadow root): the BROWSER hit-tests the point, so the click
 *  retargets INTO the frame / closed tree and is a TRUSTED, user-activated event (a synthetic dispatch is
 *  neither — it fires on the named element and can't cross those boundaries). Attaches the debugger (its
 *  unsuppressible banner is the honest "input-level control" signal — and it's shown ONLY for these reserved
 *  clicks, so the flash marks the risk), sends press+release, and ALWAYS detaches. See docs/spec/CDP_CLICK.md. */
async function cdpClick(tabId: number, x: number, y: number): Promise<{ ok: true } | { error: string; needsPermission?: true }> {
    const at = await ensureDebuggerAttached(tabId);   // reuses a live attachment; attaches once per run (see the lifecycle above)
    if ("error" in at) return { error: `Couldn't attach the debugger to click a reserved element (${at.error}). Another debugger (DevTools?) may be attached to this tab.`, ...(at.needsPermission ? { needsPermission: true } : {}) };
    const target: chrome.debugger.Debuggee = { tabId };
    const send = (type: string, buttons: number) =>
        chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: 1 });
    try {
        await send("mousePressed", 1);
        await send("mouseReleased", 0);
        return { ok: true };
    } catch (e) {
        return { error: `The CDP click failed (${(e as Error)?.message || e}).` };
    } finally {
        touchDebugger(tabId);   // keep the attachment warm; the run's finally (or the idle timer) detaches
    }
}

/** Run `source` via CDP `Runtime.evaluate` in the tab's MAIN world — the ONLY way to execute imperative JS on
 *  a page whose CSP omits 'unsafe-eval' or enforces Trusted Types (the debugger is exempt). `source` is the
 *  ALREADY-APPROVED exec code (main-world eval was blocked at COMPILE → nothing ran). window.ml, page globals,
 *  and the live DOM are all reachable (it runs in the page's own main world). Attaches the debugger (its
 *  banner is the honest "the browser is being driven" signal), evaluates, ALWAYS detaches. Two shapes, like
 *  the main-world exec: a trailing-expression first (REPL value), then a statement body (the model `return`s).
 *  See docs/spec/EXEC_STRICT_CSP.md. */
async function cdpEval(tabId: number, source: string): Promise<{ ok: true; value: string } | { error: string; needsPermission?: true }> {
    const at = await ensureDebuggerAttached(tabId);   // reuses a live attachment; attach/detach is the dominant per-exec cost on a strict page
    if ("error" in at) return { error: `Couldn't attach the debugger to run exec (${at.error}). Another debugger (DevTools?) may be attached to this tab.`, ...(at.needsPermission ? { needsPermission: true } : {}) };
    const target: chrome.debugger.Debuggee = { tabId };
    type WrapVal = { __mlWrapped: true; v: string; logs: string[] };
    type EvalResult = { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } };
    const evaluate = (expression: string) => chrome.debugger.sendCommand(target, "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true, userGesture: true }) as Promise<EvalResult>;
    const syntaxErr = (r: EvalResult) => /SyntaxError/.test(r?.exceptionDetails?.exception?.description || r?.exceptionDetails?.text || "");
    // Capture console output the SAME way the main-world exec path does — the model can't see the page's real
    // console, and a `Runtime.evaluate` that only returns the completion value silently drops every console.log
    // (the reported "logs got lost in CDP"). Patch console INSIDE the page (via the wrapper), collect the lines,
    // stringify the completion value there too (so returnByValue always gets a clean string[]+string), restore.
    const wrap = (inner: string) => `(async () => {
        const __logs = [], __M = ['log','info','warn','error','debug'], __S = {};
        for (const m of __M) { __S[m] = console[m]; console[m] = (...a) => __logs.push(a.map(x => { try { return typeof x === 'string' ? x : JSON.stringify(x); } catch { return String(x); } }).join(' ')); }
        try {
            const __v = await (${inner});
            const __vs = __v === undefined ? '(undefined)' : typeof __v === 'string' ? __v : (() => { try { return JSON.stringify(__v); } catch { return String(__v); } })();
            return { __mlWrapped: true, v: __vs, logs: __logs };
        } finally { for (const m of __M) console[m] = __S[m]; }
    })()`;
    try {
        const CAP = 500;   // match exec's default per-slot output cap (the tool's resolveOutputCap default)
        const expr = source.trim().replace(/;\s*$/, "");
        // Trailing-expression form first (REPL value, like the main-world fast path); a statement body isn't a
        // valid parenthesised expression → SyntaxError → retry as a body where the model `return`s its value.
        let r = await evaluate(wrap(`(${expr})`));
        if (syntaxErr(r)) r = await evaluate(wrap(`(async () => { ${source} })()`));
        if (r?.exceptionDetails) return { error: `The exec threw (via CDP): ${r.exceptionDetails.exception?.description || r.exceptionDetails.text || "error"}` };
        const out = r?.result?.value as WrapVal | undefined;
        const value = out && out.__mlWrapped ? out.v : "(undefined)";
        const logs = out && Array.isArray(out.logs) ? out.logs : [];
        // Prefix captured console output onto the value, exactly like the main-world path's `withLogs`.
        const combined = logs.length ? `console:\n${clipOut(logs.join("\n"), CAP)}\n\nvalue: ${value}` : value;
        return { ok: true, value: combined };
    } catch (e) {
        return { error: `The CDP exec failed (${(e as Error)?.message || e}).` };
    } finally {
        touchDebugger(tabId);   // keep the attachment for the next exec; the run's finally (or the idle timer) detaches
    }
}

/** Screenshot the tab's viewport via CDP `Page.captureScreenshot`. The point of this over
 *  `chrome.tabs.captureVisibleTab`: captureVisibleTab specifically needs the `activeTab` OR `<all_urls>`
 *  permission (Chromium's kActiveTabOrAllUrls) — a per-HOST grant does NOT satisfy it, and "On click" site
 *  access withholds <all_urls> — so look/locate/screenshot fail on e.g. GitHub. The DEBUGGER is exempt (same
 *  as exec/click), so when CDP is enabled we capture through it instead, no host grant needed. Returns a PNG
 *  data URL matching captureVisibleTab's shape. Reuses the run's live attachment (attach once, see the
 *  lifecycle above). */
async function cdpScreenshot(tabId: number): Promise<{ ok: true; dataUrl: string } | { error: string; needsPermission?: true }> {
    const at = await ensureDebuggerAttached(tabId);
    if ("error" in at) return { error: at.error, ...(at.needsPermission ? { needsPermission: true } : {}) };
    try {
        const r = await chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", { format: "png", captureBeyondViewport: false }) as { data?: string };
        if (!r?.data) return { error: "the CDP screenshot returned no data." };
        return { ok: true, dataUrl: `data:image/png;base64,${r.data}` };
    } catch (e) {
        return { error: `the CDP screenshot failed (${(e as Error)?.message || e}).` };
    } finally {
        touchDebugger(tabId);
    }
}

// A match the CDP shadow resolver returns: one element reached across a closed/declarative shadow boundary —
// its describe line (tag#id.classes "own text") + its viewport CENTRE (for a coordinate click) + its box size.
export interface CdpShadowMatch { line: string; cx: number; cy: number; w: number; h: number; }
// Runs IN THE PAGE (via callFunctionOn) on a resolved node — the node lives in a closed shadow root a page
// selector can't reach, but it IS a real Element in the page's realm, so getBoundingClientRect/textContent work.
// Returns the same one-line shape elLine builds, plus the click centre. Self-contained (no closure deps).
const CDP_SHADOW_DESC_FN = `function () {
    var el = this;
    if (!el || el.nodeType !== 1) return null;
    var tag = (el.tagName || '').toLowerCase();
    var id = el.id ? '#' + el.id : '';
    var cls = (el.classList && el.classList.length) ? '.' + Array.prototype.slice.call(el.classList, 0, 4).join('.') : '';
    var own = '';
    try { own = Array.prototype.filter.call(el.childNodes, function (n) { return n.nodeType === 3; }).map(function (n) { return n.textContent; }).join(' ').trim().slice(0, 60); } catch (e) {}
    var r = { left: 0, top: 0, width: 0, height: 0 };
    try { r = el.getBoundingClientRect(); } catch (e) {}
    return { line: tag + id + cls + (own ? (' "' + own + '"') : ''), cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
}`;

/** Resolve a `>>>` selector across ALL shadow boundaries — OPEN, closed-programmatic, AND the declarative/native
 *  CLOSED roots the page's own JS (and our attachShadow capture) can NOT enter — using the CDP DOM domain, which
 *  pierces every boundary. This is the ONE thing page-world JS structurally can't do, and it's used ONLY when
 *  `firstHopSealed` confirmed a genuinely sealed host is in the path (never as a general query path). Walks the
 *  hops server-side: querySelectorAll each hop in its scope, and at a boundary descend into the host's shadow
 *  roots (describeNode `pierce` → the closed root's node → push it to the frontend so the next hop can query it).
 *  Each final match is resolved to a live JS handle (resolveNode) and callFunctionOn runs the describe fn ON it —
 *  so we get the element's real describe line + viewport centre for a coordinate click. Read-only: it never
 *  mutates; clicking is a SEPARATE cdpClick the caller makes with the returned centre. */
async function cdpShadowResolve(tabId: number, selector: string, cap = 25): Promise<{ ok: true; matches: CdpShadowMatch[] } | { error: string; needsPermission?: true }> {
    const at = await ensureDebuggerAttached(tabId);
    if ("error" in at) return { error: at.error, ...(at.needsPermission ? { needsPermission: true } : {}) };
    const target: chrome.debugger.Debuggee = { tabId };
    const send = <T = Record<string, unknown>>(method: string, params: Record<string, unknown>): Promise<T> =>
        chrome.debugger.sendCommand(target, method, params) as Promise<T>;
    try {
        // getDocument (depth 0 — cheap) establishes the root node; querySelectorAll then resolves server-side
        // against the LIVE DOM (not the returned tree), so depth 0 is enough and we avoid shipping a huge tree.
        const doc = await send<{ root?: { nodeId?: number } }>("DOM.getDocument", { depth: 0 });
        const rootId = doc?.root?.nodeId;
        if (!rootId) return { error: "CDP couldn't read the document root." };
        const hops = String(selector).split(">>>").map(s => s.trim()).filter(Boolean);
        if (hops.length < 2) return { ok: true, matches: [] };   // no boundary to cross — not this resolver's job
        let scopes: number[] = [rootId];
        for (let i = 0; i < hops.length; i++) {
            const isLast = i === hops.length - 1;
            const next: number[] = [];
            for (const scope of scopes) {
                let nodeIds: number[] = [];
                try { ({ nodeIds = [] } = await send<{ nodeIds?: number[] }>("DOM.querySelectorAll", { nodeId: scope, selector: hops[i] })); } catch { /* hop invalid in this scope */ }
                if (isLast) { next.push(...nodeIds); continue; }
                // Not the last hop → each match is a HOST; descend into its shadow roots (open + closed).
                for (const hostId of nodeIds) {
                    let node: { shadowRoots?: { nodeId?: number; backendNodeId?: number }[] } | undefined;
                    try { ({ node } = await send<{ node?: typeof node }>("DOM.describeNode", { nodeId: hostId, depth: 0, pierce: true })); } catch { continue; }
                    for (const sr of node?.shadowRoots || []) {
                        let srId = sr.nodeId;
                        if (!srId && sr.backendNodeId != null) {
                            try { const pushed = await send<{ nodeIds?: number[] }>("DOM.pushNodesByBackendIdsToFrontend", { backendNodeIds: [sr.backendNodeId] }); srId = pushed?.nodeIds?.[0]; } catch { /* couldn't map → skip this root */ }
                        }
                        if (srId) next.push(srId);
                    }
                }
            }
            scopes = next;
            if (!scopes.length) break;
        }
        const matches: CdpShadowMatch[] = [];
        for (const nodeId of scopes.slice(0, cap)) {
            try {
                const { object } = await send<{ object?: { objectId?: string } }>("DOM.resolveNode", { nodeId });
                if (!object?.objectId) continue;
                const { result } = await send<{ result?: { value?: CdpShadowMatch } }>("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: CDP_SHADOW_DESC_FN, returnByValue: true });
                await send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => { /* best-effort */ });
                if (result?.value && typeof result.value.line === "string") matches.push(result.value);
            } catch { /* one node failed to resolve → skip it */ }
        }
        return { ok: true, matches };
    } catch (e) {
        return { error: `the CDP shadow resolve failed (${(e as Error)?.message || e}).` };
    } finally {
        touchDebugger(tabId);
    }
}

/** SSRF denylist for the uncredentialed image fetch: refuse loopback / private / link-local / metadata
 *  hosts (and non-http schemes / unparseable URLs), so a page can't probe the user's internal network
 *  through the extension's `<all_urls>` reach. */
function isBlockedFetchTarget(rawUrl: string): boolean {
    let u: URL;
    try { u = new URL(rawUrl); } catch { return true; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return true;
    const h = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (h === "localhost" || h.endsWith(".localhost") || h === "::1") return true;
    if (h.startsWith("fe80") || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("::ffff:127.")) return true;   // IPv6 link-local / ULA / mapped-loopback
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
        const a = +m[1], b = +m[2];
        if (a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return true;
    }
    return false;
}

chrome.runtime.onMessage.addListener((message: any, sender, sendResponse) => {
    // The content-script shell forwards each __mlDebug event here so a DevTools panel
    // (which can't see page window-messages) can mirror the overlay's stream. Fire-and-
    // forget — no response. RESET clears a tab's buffer on navigation (fresh page).
    if (message.type === "ML_DEBUG_EVENT") { if (sender.tab?.id != null) relayDebugEvent(sender.tab.id, message.event); return; }
    // Await the startup rehydrate before deciding whether to wipe: right after an SW respawn (e.g. a site-access
    // grant cycled the worker), a fresh page's ML_DEBUG_RESET can RACE hydratePersistedRuns — if it wins,
    // activeRuns/bgRuns are still empty and it wipes an interrupted run's session before it's re-tracked.
    if (message.type === "ML_DEBUG_RESET") { const tid = sender.tab?.id; if (tid != null) void hydrationDone.then(() => resetDebug(tid)); return; }
    // DevTools-panel hover-highlight reverse channel: the panel (a devtools page) can't reach the
    // inspected page, so it asks us to relay its highlight request to that tab's content-script shell,
    // which draws the box. Only the extension can call a typed background message like this — a web page
    // has no chrome.runtime path to it — and drawing is a read-only pointer-events:none overlay anyway.
    if (message.type === "ML_HL_REMOTE" && typeof message.tabId === "number") {
        try { void chrome.tabs.sendMessage(message.tabId, { type: "ML_HL_REMOTE", ref: message.ref }).catch(() => {}); } catch { /* tab gone */ }
        return;
    }
    // DevTools session composer → the inspected tab's shell → the page's handle registry (say/run/cancel).
    // The panel is an extension page (can chrome.runtime.sendMessage); the inspected page has no such path,
    // so it can't forge this. Same relay shape as ML_HL_REMOTE.
    if (message.type === "ML_SESSION_REMOTE" && typeof message.tabId === "number") {
        try { void chrome.tabs.sendMessage(message.tabId, { type: "ML_SESSION_TO_PAGE", action: message.action, hash: message.hash, text: message.text, images: message.images }).catch(() => {}); } catch { /* tab gone */ }
        return;
    }
    if (message.type === "SET_APPROVAL") {
        // The surface's approve/deny for a pending background-run gate. Reaches here only from a TRUSTED
        // extension context: the content-script shell (overlay) or panel.ts (devtools) — each forwards it
        // ONLY for a message from the real extension-iframe app (e.source === frame). A web page can't
        // forge it: it's not an extension context (can't chrome.runtime.sendMessage), and SET_APPROVAL is
        // not a content-relayed HANDLE_MAP type — so a page-set window.confirm / hostile approve() can't
        // reach here even though the page knows its own runId. Design A's crux.
        const p = message.payload as SetApprovalPayload;
        resolveApproval(`${p.runId}:${p.seq}`, p.decision ? { approved: true, source: "user", persist: p.persist } : { approved: false, feedback: p.feedback, source: "user" });
        return;   // fire-and-forget
    }
    if (message.type === "CONTENT_READY") {
        // Cross-page persistence: a fresh document loaded in a tab. If it still hosts live cross-page run(s),
        // reply with each run's rebuild-config so the new page re-adopts (rebuilds + re-registers its
        // toolset). A fresh content script on a tab with active runs MEANS the document was replaced (the old
        // page is gone), so this fires the re-adopt regardless of the barrier's exact state. Empty otherwise.
        const tabId = sender.tab?.id;
        // Await the startup rehydrate first — a page loading right after an SW respawn must see the in-flight
        // runs storage restored, or it would miss the re-adopt + auto-resume.
        void hydrationDone.then(() => {
            const ids = tabId != null ? activeRuns.get(tabId) : undefined;
            // `resume` marks an INTERRUPTED (evicted) run — the fresh page auto-continues it (durable resume).
            const adopt: { runId: string; rebuild: import("./contract").RebuildConfig; resume?: boolean }[] = [];
            const seen = new Set<string>();
            const addAdopt = (runId: string, rebuild: import("./contract").RebuildConfig): void => {
                if (seen.has(runId)) return;
                seen.add(runId);
                const resume = hydratedRuns.has(runId) && !runControllers.has(runId);   // evicted & not running → re-drive
                if (resume) { hydratedRuns.delete(runId); resurrectedRuns.add(runId); }   // auto-resume ONCE; RESUME_RUN re-emits its `agent` start
                adopt.push({ runId, rebuild, resume: resume || undefined });
            };
            if (ids) for (const runId of ids) { const rebuild = runRebuilds.get(runId); if (rebuild) addAdopt(runId, rebuild); }
            // ALSO re-adopt recently-COMPLETED-but-resumable runs on this tab (bgRuns): a HUD run that navigated
            // and then FINISHED (its fast final answer needs no delegation, so the loop never waits for the new
            // page) would otherwise leave the destination page with no resume handle — and a composer follow-up
            // would be dropped. Re-adopting registers the toolset + the by-hash resume handle. (Not `resume`:
            // a completed run isn't in hydratedRuns, so it re-adopts but doesn't auto-re-drive.)
            if (tabId != null) for (const [runId, snap] of bgRuns) {
                if (snap.tabId === tabId && snap.p.rebuild) addAdopt(runId, snap.p.rebuild);
            }
            sendResponse({ adopt });
            // Overlay/off HUD replay-across-nav: stream the run's buffered history so the fresh card/overlay
            // rebuilds MID-run (start + every step so far), not just post-nav events. The shell buffers these
            // __mlFromBg events while its iframe mounts, absorbing an ordering race against the handshake.
            // Fires for a LIVE run (every nav) AND — the on-click/late-injection fix — for a page that loads
            // AFTER the run finished: a completed run re-adopted from bgRuns replays its history ONCE so the
            // destination page still gets its card + final answer (else the corner card is blank there).
            const hasActive = !!(ids && ids.size);
            if (tabId != null && adopt.length) {
                const history = runReplayBuffer.get(tabId) || [];
                if (history.length) {
                    for (const event of history) chrome.tabs.sendMessage(tabId, { type: "ML_DEBUG_TO_PAGE", event }).catch(() => {});
                    // A COMPLETED-only re-adopt (no live run) has served its purpose — drop the buffer so a later
                    // reload doesn't re-show a finished card. A live run keeps its buffer for the next nav.
                    if (!hasActive) runReplayBuffer.delete(tabId);
                }
            }
        });
        return true;   // async: sendResponse fires after hydration resolves
    }
    if (message.type === "RUN_READOPTED") {
        // The fresh document re-registered a run's toolset → release the navigation barrier so the held
        // delegated tool runs against the new page. Keyed by tab (the barrier is per-tab). Fire-and-forget.
        const tabId = sender.tab?.id;
        const pageInfo = (message.payload as { pageInfo?: string })?.pageInfo;
        if (tabId != null) {
            // Stash the new page's context BEFORE releasing the barrier, so the `navigate` tool call awaiting
            // re-adoption reads it and folds it into its result (orient-on-nav — see the navigate branch below).
            if (pageInfo) readoptPageInfo.set(tabId, pageInfo);
            navBarrier.noteReadopted(tabId);
        }
        return;
    }
    if (message.type === "CANCEL_RUN") {
        // The HUD's "Cancel agent run" (relayed by the trusted content-script shell). Abort the run's
        // controller → the loop stops at the next boundary and resolves { cancelled: true }; the model
        // call in flight is aborted too. A page can't forge this (no chrome.runtime path), and even a
        // forged cancel only aborts that page's own run — harmless.
        const runId = (message.payload as CancelRunPayload)?.runId;
        const ctl = runControllers.get(runId);
        if (ctl) ctl.abort();
        // If the run is BLOCKED on an OPEN approval gate, aborting the controller alone can't unblock it — the
        // gate promise only resolves via SET_APPROVAL. So resolve any pending gate for this run now with an
        // explicit CANCELLATION (`{ approved:false, cancelled:true }`), NOT a bare `false`: the loop then exits
        // as cancelled even when the controller is GONE (an evicted/re-adopted run, where `ctl` above is
        // undefined so the signal never aborts). A bare `false` there read as a DENY → the loop stepped on
        // forever ("auto-denied + can't Stop", the reported bug). A later SET_APPROVAL click finds no entry — a
        // harmless no-op.
        for (const [key, entry] of [...pendingApprovals]) {
            if (key.startsWith(`${runId}:`)) { pendingApprovals.delete(key); entry.resolve({ approved: false, cancelled: true }); }
        }
        return;   // fire-and-forget
    }
    if (message.type === "CANCEL_ALL_RUNS") {
        // The popup's "Stop all agent runs" panic button — the guaranteed kill switch for a runaway that has
        // no visible surface (e.g. a resumed run whose card never mounted). Abort every live controller,
        // resolve every open approval gate, and purge all persisted snapshots so nothing re-adopts + resumes.
        const n = runControllers.size;
        for (const [, ctl] of [...runControllers]) { try { ctl.abort(); } catch { /* already gone */ } }
        for (const [key, entry] of [...pendingApprovals]) { pendingApprovals.delete(key); try { entry.resolve(false); } catch { /* gone */ } }
        void purgeAllBgRuns();
        sendResponse({ data: { cancelled: n } });
        return true;
    }
    if (message.type === "CDP_CLICK") {
        // Click a RESERVED surface (cross-origin iframe / declarative-or-native closed shadow) at a viewport
        // coordinate via CDP — the only mechanism that reaches it with a trusted, hit-tested event.
        // CHOKE-POINT: this is privileged (attaches the debugger) so it must NOT be page-forgeable. An
        // UNTRUSTED page is refused; a `surface` (internal extension page — the approval UI) or a
        // `whitelisted` origin (the user trusts it to self-gate) may initiate it, and the per-click approval
        // still governs upstream. Gated behind the off-by-default `cdpClick` flag. A page targets only its
        // OWN tab (sender.tab.id); a surface passes the inspected tabId in the payload.
        (async () => {
            const cfg = await getConfig();
            if (!cfg.cdp) { sendResponse({ error: "Debugger-based actions (CDP) are off — enable them in window.ml Settings → Advanced." }); return; }
            if (await senderTrust(sender) === "untrusted") { sendResponse({ error: "Refused: a reserved-element (CDP) click can't be initiated by this page." }); return; }
            const p = (message.payload || {}) as { x?: number; y?: number; tabId?: number };
            const tabId = sender.tab?.id ?? p.tabId;   // a page → its own tab; a trusted surface → the payload's
            if (typeof tabId !== "number" || typeof p.x !== "number" || typeof p.y !== "number") { sendResponse({ error: "CDP_CLICK needs a tab and numeric x/y." }); return; }
            sendResponse(await cdpClick(tabId, p.x, p.y));
        })();
        return true;   // async
    }
    if (message.type === "CDP_SHADOW_RESOLVE") {
        // READ-ONLY resolve of a `>>>` selector across sealed (closed/declarative) shadow roots via CDP — the
        // discovery half of the sealed-shadow reach (describeElement inside a host the JS path can't enter).
        // Gated on the off-by-default `cdp` flag (the debugger banner is the visible signal); a page targets
        // only its OWN tab. NOT senderTrust-gated: it only READS same-document, same-origin content the page's
        // own server authored (no cross-origin gain), and its output (describe lines + coordinates) is not
        // actionable on its own — CDP_CLICK stays untrusted-refused, and a synthetic click on a sealed host
        // can't reach the inner control. The privileged CLICK still flows through the trusted envelope path.
        (async () => {
            const cfg = await getConfig();
            if (!cfg.cdp) { sendResponse({ error: "Debugger-based actions (CDP) are off — enable them in window.ml Settings → Advanced to reach sealed shadow roots." }); return; }
            const p = (message.payload || {}) as { selector?: string; tabId?: number };
            const tabId = sender.tab?.id ?? p.tabId;
            if (typeof tabId !== "number" || typeof p.selector !== "string") { sendResponse({ error: "CDP_SHADOW_RESOLVE needs a tab and a selector." }); return; }
            const r = await cdpShadowResolve(tabId, p.selector);
            sendResponse("error" in r ? { error: r.error } : { data: r.matches });
        })();
        return true;   // async
    }
    if (message.type === "INJECT_MESSAGE") {
        // a.say() steering a RUNNING background run: push the text into that run's inbox → the loop drains it
        // at the next step boundary. Only the OWNING tab may steer; an unknown/finished run is a no-op (the
        // page's run()-flush safety net picks up anything that lands too late).
        const p = message.payload as InjectMessagePayload;
        const inbox = runInboxes.get(p.runId);
        const injected = !!(inbox && inbox.tabId === sender.tab?.id && typeof p.text === "string");
        if (injected) inbox!.queue.push({ id: p.sayId, text: p.text });
        sendResponse({ data: injected });
        return true;
    }
    if (message.type === "START_RUN" || message.type === "RESUME_RUN") {
        // Design A: run an ml.agent loop HERE (extension origin), delegating each tool back to the page
        // (RUN_TOOL_IN_PAGE) and gating approval through the sidebar. The page built the toolset + system
        // prompt (it has the DOM/config/factories) and registered the live tools under runId; we hold only
        // serializable descriptors. sender.tab.id is the delegation + debug-fanout target.
        const tabId = sender.tab?.id;
        if (tabId == null) { sendResponse({ error: `${message.type} must come from a tab (content script).` }); return true; }
        // RESUME continues a stored run: reuse its original StartRunPayload (deps rebuild from it) + its
        // accumulated history, overriding only the task with the follow-up. Only the owning tab may resume.
        let p: StartRunPayload;
        let resumeMessages: NeutralMessage[] | undefined;
        let priorSub: import("./contract").SubcallUsage | undefined;   // a resumed session's accumulated sub-call spend
        let resumeOriginalTask: string | undefined;   // the run's ORIGINAL task (rp.task is the follow-up; empty on an auto-resume)
        if (message.type === "RESUME_RUN") {
            const rp = message.payload as ResumeRunPayload;
            const stored = bgRuns.get(rp.runId);
            if (!stored) { sendResponse({ error: `No resumable run "${rp.runId}" in the background — it may have been evicted; start a new run.` }); return true; }
            if (stored.tabId !== tabId) { sendResponse({ error: `Run "${rp.runId}" belongs to another tab.` }); return true; }
            p = { ...stored.p, task: rp.task };
            resumeOriginalTask = stored.p.task;
            resumeMessages = stored.messages;
            priorSub = stored.sub;
        } else {
            p = message.payload as StartRunPayload;
            // A createAgent handle sends its prior history (control.messages) so the background CONTINUES
            // it — the page stays authoritative across turns, and the updated history rides back below.
            resumeMessages = p.resumeMessages;
            // A handle's 2nd+ turn re-enters via START_RUN (NOT RESUME_RUN), so seed the sub-call tally from
            // the stored run too — else subTally resets to 0 each turn and chat_metadata reports "none" on a
            // continued turn even after prior turns spent thousands (the UI chip hid this: it reads the last
            // non-empty step, which still holds the prior turn's total). First turn → no stored run → 0.
            priorSub = bgRuns.get(p.runId)?.sub;
        }
        const runId = p.runId;
        const stepBase = p.stepBase || 0, seqBase = p.seqBase || 0;   // offsets for a handle's continued turns
        let runMaxStep = 0, runMaxSeq = 0;   // this run's max step/seq (raw) → returned so the page advances its bases
        // The session's DELEGATED vision sub-call spend, summed from each delegated tool's envelope delta (the
        // page meters it in bus.ts; the SW can't read that, so each call reports its own). Feeds chat_metadata
        // + the UI "+N sub" chip on the background path, matching the page loop. CUMULATIVE across the session:
        // seeded from the resumed run's stored tally (a per-turn reset would make chat_metadata report "none"
        // on a turn that hadn't yet made a sub-call, even after prior turns spent thousands), persisted below.
        const subTally = { prompt: priorSub?.prompt || 0, completion: priorSub?.completion || 0, calls: priorSub?.calls || 0 };
        // Per-vision-model breakdown of the tally (chat_metadata "which model cost what"), seeded from the
        // resumed run's stored breakdown and merged from each delegated tool's byModel delta. A Map for O(1)
        // merge; snapSub() flattens it to a plain SubcallUsage for events/storage (deep — no shared refs).
        const subByModel = new Map<string, { prompt: number; completion: number; calls: number }>();
        for (const bm of priorSub?.byModel || []) subByModel.set(bm.model, { prompt: bm.prompt, completion: bm.completion, calls: bm.calls });
        const addSub = (s: import("./contract").SubcallUsage | undefined): void => {
            if (!s || !s.calls) return;
            subTally.prompt += s.prompt; subTally.completion += s.completion; subTally.calls += s.calls;
            for (const bm of s.byModel || []) {
                const cur = subByModel.get(bm.model) || { prompt: 0, completion: 0, calls: 0 };
                cur.prompt += bm.prompt; cur.completion += bm.completion; cur.calls += bm.calls; subByModel.set(bm.model, cur);
            }
        };
        // Serialized visuals of `answer`-designated elements (data URLs), accumulated from each delegated
        // answer envelope → attached to the run's result + agent-result for the HUD completion card.
        const runAnswerMedia: import("./contract").AnswerMedia[] = [];
        // Flatten the tally to a serializable SubcallUsage (fresh objects → safe to store/emit repeatedly).
        const snapSub = (): import("./contract").SubcallUsage => ({
            ...subTally,
            ...(subByModel.size ? { byModel: [...subByModel.entries()].map(([model, u]) => ({ model, ...u })) } : {}),
        });
        const abortCtl = new AbortController();   // CANCEL_RUN aborts this → the loop resolves { cancelled }
        // Set once this run's page navigates: the page-side caller that normally emits the lifecycle
        // agent/agent-result (overlay/devtools) is then GONE (its context died with the old document), so the
        // BACKGROUND must fan the terminal result to the destination page instead — else the run finishes but
        // no surface ever learns it did (the observer/HUD sat on "running"). See emitLifecycle below.
        let hasNavigated = false;
        runControllers.set(runId, abortCtl);
        runInboxes.set(runId, { tabId, queue: [] });   // a.say() steering lands here while the run is live
        // Register the run against its tab so the navigation sensor watches it — UNLESS the run opted out of
        // cross-page persistence (navigate: false), in which case a nav simply ends it (no barrier, no adopt).
        if (p.crossPage !== false) trackRun(tabId, runId, p.rebuild);
        // Durable resume: snapshot the run NOW (before the first step) + after each step (the checkpoint dep),
        // so an SW evicted mid-run rehydrates from storage. Cleared when the run settles (finally).
        persistRun(runId, { p, tabId, messages: resumeMessages || [], sub: snapSub() });
        const toolMetas: ToolMeta[] = p.tools.map(t => ({ name: t.name, requiresApproval: t.requiresApproval, capabilities: t.capabilities }));
        const toolDefs = p.tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
        const approvedSheets = new Set<string>();   // external sheets approved this run (isSheetApproved)
        // Cross-origin navigation consent: origins this run may navigate to WITHOUT re-prompting — seeded
        // with the start origin, and each cross-origin nav the user approves is added (so repeat navs to it
        // skip the gate). A run that didn't opt into crossOrigin never gates (its tool refuses cross-origin).
        const consentedOrigins = new Set<string>();
        if (p.pageOrigin) consentedOrigins.add(p.pageOrigin);
        const navNeedsConsent = (url: string): boolean => {
            if (!p.crossOrigin) return false;   // can't cross origins → tool refuses cross-origin; same-site fine → no gate
            try {
                if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !url.startsWith("//")) return false;   // relative → same-origin
                const dest = new URL(url.startsWith("//") ? "https:" + url : url);
                return !consentedOrigins.has(dest.origin);   // a NEW cross-origin → gate; an already-consented one → no
            } catch { return false; }   // unparseable → the tool will error; no pointless gate
        };
        // Debug fan-out for this run → the active surface.
        //  · overlay: re-post to the PAGE window (ML_DEBUG_TO_PAGE → content.js → the shell → the iframe
        //    app), where the overlay app is mounted.
        //  · devtools: there's no iframe app on the page — fan straight to the panel via relayDebugEvent
        //    (→ the ml-devtools ports + the per-tab replay buffer, so a panel opened mid-run catches up).
        //    The page-emitted `agent`/`agent-result` events already reach the panel via the shell's
        //    __mlDebug→ML_DEBUG_EVENT forward; this covers the background-emitted agent-STEP events.
        // Fan a run's step events to the page. overlay AND off both stream to the page window
        // (ML_DEBUG_TO_PAGE → the shell → the iframe app) — off renders them in the corner CARD, a
        // curated view of the same data; devtools fans to the panel. The card mounts itself lazily on the
        // first of these (tagged `__mlFromBg` by content.ts) and self-reveals for a pending gate / the
        // final answer, so a no-approval off run streams to a hidden, cheap-to-mount card.
        const emitStep = (ev: Record<string, unknown>): void => {
            // Once the run is aborted (CANCEL_RUN), stop fanning steps: an in-flight tool's DONE resolves
            // AFTER the abort (the page tool round-trip isn't cancellable), and a straggler landing after the
            // page's cancelled result would wrongly re-show "running" in the panel. Drop it at the source.
            if (abortCtl.signal.aborted) return;
            // Offset this turn's step/seq past the handle's prior turns so the sidebar's turn groups stay
            // distinct (the background twin of the page loop's control.stepBase/seqBase). Track the raw max
            // so the page can advance its bases for the next turn (returned in the response below).
            const rawStep = (ev.step as number) || 0;
            if (rawStep > runMaxStep) runMaxStep = rawStep;
            const rawSeq = ev.seq as number | undefined;
            if (rawSeq != null && rawSeq > runMaxSeq) runMaxSeq = rawSeq;
            const step = stepBase + rawStep;
            const seq = rawSeq != null ? seqBase + rawSeq : rawSeq;
            const event = {
                kind: "agent-step", id: runId, ts: Date.now(), save: false,
                session: { hash: runId, turn: step }, ...ev, step, localStep: rawStep, seq,
                // Running per-turn delegated-sub-call tally so the UI "+N sub" chip works on the background
                // path too (the page path attaches subcallUsage() the same way). Omit when nothing delegated.
                ...(subTally.calls ? { subUsage: snapSub() } : {}),
            };
            // Always fan to the PAGE (overlay / off card). For devtools ALSO fan to the panel — and the
            // page fan lets the optional corner card coexist with the panel (agentHudInDevtools); the
            // shell drops the page copy when no card is mounted, and never loops it back to the panel.
            chrome.tabs.sendMessage(tabId, { type: "ML_DEBUG_TO_PAGE", event }).catch(() => { /* tab gone / no receiver */ });
            if (p.surface === "devtools") relayDebugEvent(tabId, event);
            // Cross-page: remember this step so a fresh page after a nav can rebuild the card mid-run.
            if (p.crossPage !== false) bufferReplay(tabId, event);
        };
        // Fan a lightweight run event verbatim (no step/seq offset) to every surface — used for the
        // "seen" indicator (agent-say-seen), which keys off its own id, not a step position.
        const fanEvent = (event: Record<string, unknown>): void => {
            if (abortCtl.signal.aborted) return;
            chrome.tabs.sendMessage(tabId, { type: "ML_DEBUG_TO_PAGE", event }).catch(() => {});
            if (p.surface === "devtools") relayDebugEvent(tabId, event);
            if (p.crossPage !== false) bufferReplay(tabId, event);
        };
        // OFF mode: the corner card is fed ENTIRELY by this background stream, because the page's own
        // debug bus (bus.ts) stays dormant in off mode — no `present` handshake, so its emitDebug is a
        // no-op and off mode keeps its zero-cost footprint until a privileged run actually starts. So for
        // OFF we emit the run's lifecycle (start + result) here too; overlay gets them from the page's bus
        // and devtools from the panel forward, so emitting them here as well would double up — off only.
        const emitLifecycle = (event: Record<string, unknown>): void => {
            // Buffer FIRST (before any fan decision) so the replay stream includes the `agent` start + result
            // even on an overlay run where the page-side caller — not this — is what fans them live. Without
            // the start event a re-adopted card can't rebuild the session.
            if (p.crossPage !== false) bufferReplay(tabId, event);
            // "off": the page-side caller emits nothing, so the background always fans lifecycle events.
            // overlay/devtools: the caller normally emits them page-side — EXCEPT once the run has navigated,
            // when that caller's context is gone, so the background fans them to the destination page instead.
            if (p.surface !== "off" && !hasNavigated) return;
            chrome.tabs.sendMessage(tabId, { type: "ML_DEBUG_TO_PAGE", event }).catch(() => {});
            // DEVTOOLS after a nav: the page-side caller that normally feeds the panel (via the shell forwarder)
            // is GONE, and the shell drops __mlFromBg events for the panel (dedup) — so fan lifecycle straight to
            // the panel port too, mirroring emitStep. Without this a navigated devtools run never gets its
            // agent-result → the panel sticks on "running" with no answer (the HUD, page-fed, had it). Only fires
            // when we actually fan (off, or overlay/devtools post-nav), so a pre-nav result can't double up.
            if (p.surface === "devtools") relayDebugEvent(tabId, event);
        };
        // Only a FRESH run announces the session start; a RESUME continues an existing sidebar/card
        // session (re-emitting `agent` would wipe its accumulated steps), so it streams new steps + a
        // fresh agent-result under the same hash instead. EXCEPTION (fix C): a run RESURRECTED from storage
        // after an SW respawn has NO surface session anymore (memory + replay buffer were wiped), so it must
        // re-announce — else it drives INVISIBLY with no Stop button (the runaway-run bug). Use the ORIGINAL
        // task (rp.task is the empty auto-resume follow-up), and fanEvent (not emitLifecycle, whose overlay/
        // devtools gate would suppress it) so the row appears on every surface. The reducer's don't-wipe merge
        // makes this safe if a stray session somehow survived.
        const resurrected = resurrectedRuns.has(runId);
        resurrectedRuns.delete(runId);
        const startEvent = {
            kind: "agent", id: runId, ts: Date.now(), save: false, session: { hash: runId, turn: 0 },
            task: resurrected ? (resumeOriginalTask ?? p.task) : p.task, model: p.model, maxSteps: p.maxSteps,
            resumed: resurrected || undefined,   // the sidebar can mark it "resumed after interruption"
            config: {
                system: p.systemPrompt, customSystem: false,
                tools: p.tools.map(t => ({ name: t.name, requiresApproval: t.requiresApproval, vision: t.capabilities.includes("vision"), description: t.description, parameters: t.parameters, summary: t.summary })),
                maxSteps: p.maxSteps, think: p.think, env: true, vision: null, hints: null, unattended: p.unattended, silent: p.silent,
                stream: p.stream,
            },
        };
        if (!resumeMessages) emitLifecycle(startEvent);
        else if (resurrected) fanEvent(startEvent);   // resurrected: no page-side caller emitted a start → fan it ourselves
        runBackgroundAgent(
            { task: p.task, systemPrompt: p.systemPrompt, tools: toolMetas, model: p.model, think: p.think, maxSteps: p.maxSteps, autoApprovePython: p.autoApprovePython, unattended: p.unattended, resumeMessages, images: p.images },
            {
                callModel: async (messages, opts) => {
                    // Thread the run's abort signal so a CANCEL_RUN kills a slow in-flight generation, not
                    // just stops at the next step boundary.
                    if (p.stream) {
                        // Opt-in streaming: emit the thinking/reply LIVE (throttled) so a long reasoning phase
                        // shows its text instead of a frozen token count. streamAgentTurn accumulates tool_calls
                        // too, so the loop still gets its authoritative { content, tool_calls } at the end.
                        const rawStep = (opts?.step as number) || 0, step = stepBase + rawStep;
                        let last = 0;
                        const flush = (acc: { reasoning: string; content: string }): void => {
                            if (abortCtl.signal.aborted) return;
                            last = Date.now();
                            fanEvent({ kind: "agent-stream", id: runId, ts: last, save: false, session: { hash: runId, turn: step }, step, localStep: rawStep,
                                ...(acc.reasoning ? { reasoning: acc.reasoning } : {}), ...(acc.content ? { content: acc.content } : {}) });
                        };
                        const r = await streamAgentTurn({ messages, tools: toolDefs, model: p.model, think: p.think },
                            (acc) => { if (Date.now() - last >= STREAM_EMIT_MS) flush(acc); }, abortCtl.signal);
                        flush({ reasoning: r.reasoning || "", content: r.content || "" });   // final: land the last delta even if throttled
                        return { content: r.content, tool_calls: r.tool_calls, reasoning: r.reasoning, usage: r.usage };
                    }
                    const r = await fetchLLM({ messages, tools: toolDefs, model: p.model, think: p.think, raw: true }, abortCtl.signal) as { content: string | null; tool_calls: ToolCall[]; reasoning: string | null; usage: TokenUsage | null };
                    return { content: r.content, tool_calls: r.tool_calls, reasoning: r.reasoning, usage: r.usage };
                },
                delegateTool: async (name, args) => {
                    // Reaching here means the call is AUTHORIZED (approved / auto / cached alike). Mint the
                    // choke-point grants for the privileged sub-ops this tool will make, bound to the exact
                    // resources in its args — an untrusted page's FETCH_SHEET / full PYTHON_EXEC checks them.
                    // Scoped to this delegation: cleared in `finally`, so a later call needs its own approval.
                    // An APPROVED exec may fetch inline (ml.fetch): the human saw the code, so allow its fetches
                    // for THIS run (ephemeral — cleared below). Persisting a URL is button #3, not this.
                    if (name === "exec") grantsFor(tabId).fetchOpen = true;
                    if (name === "python_exec") {
                        const g = grantsFor(tabId);
                        for (const id of externalSheetIds(args)) g.sheets.add(id);
                        if ((args as { mode?: string }).mode === "full") g.pyCode.add(String((args as { code?: unknown }).code ?? ""));
                    }
                    try {
                        // A delegated call can race a NAVIGATION — the tool's own action submits a form / follows a
                        // link, or the page redirects mid-call (common after an approval gate holds the call: e.g.
                        // google.com settling while `type` waited to be approved). The content script's channel then
                        // closes and Chrome's raw "message channel closed…" error is useless to the model. RECOGNISE
                        // it as a navigation: wait for the new document to settle (re-adopt) and hand back the new
                        // page's context — actionable, and safe (no blind retry that could double-submit a form).
                        const CHANNEL_GONE = /message channel closed|Receiving end does not exist|No tab with id/i;
                        let env: Partial<import("./contract").PageToolEnvelope>;
                        try {
                            env = await delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload: { runId, name, args } }) as Partial<import("./contract").PageToolEnvelope>;
                        } catch (e) {
                            const emsg = (e as Error)?.message || String(e);
                            if (!CHANNEL_GONE.test(emsg)) {
                                env = { result: `Error: could not reach the page to run "${name}" (${emsg}).` };
                            } else {
                                // The page navigated out from under the call. Its pageInfo may already be here (a fast
                                // re-adopt beat us); else engage the barrier and wait for it (bounded by the barrier's
                                // own timeout, then a generic "still loading" note).
                                let info = readoptPageInfo.get(tabId);
                                if (!info) { navBarrier.noteNavigating(tabId); await navBarrier.whenReady(tabId); info = readoptPageInfo.get(tabId); }
                                readoptPageInfo.delete(tabId);
                                hasNavigated = true;   // the run moved pages → the terminal result must fan to the new page
                                env = { result: `The page navigated while running "${name}" — the action triggered a navigation, or the page redirected mid-call.${info ? `\n\nYou are now on the new page:\n${info}` : " The new page is still loading — wait, then look."}\n\nNOTE: "${name}" may NOT have taken effect on the previous page. Verify the CURRENT page (look / findByText) and re-run "${name}" here if the change didn't happen.` };
                            }
                        }
                        addSub(env?.subUsage);   // this tool's own delegated vision sub-call spend (look/locate)
                        if (env?.answerMedia?.length) runAnswerMedia.push(...env.answerMedia);   // answer's element visuals → HUD card
                        // Cross-page: the `navigate` tool DEFERS the real location change a tick, so its result
                        // returns before the document unloads. Engage the barrier NOW — not only via the async
                        // webNavigation.onCommitted, which can lose the race to the loop's next (fast, local)
                        // model call + tool delegation, letting the next tool fire into the dying document.
                        // The next delegateSend then waits for the new page to re-adopt. Skip an errored nav.
                        if (name === "navigate" && !String(env?.result || "").startsWith("Error")) {
                            navBarrier.noteNavigating(tabId); hasNavigated = true;
                            // Orient-on-nav: WAIT for the new document to re-adopt, then fold its pageInfo into
                            // THIS tool's result — so the model's next turn already knows where it landed instead
                            // of spending a look()/pageInfo turn to find out. The barrier's own timeout is the
                            // fallback (a nav that never re-adopts → whenReady resolves, no pageInfo → plain result).
                            if (env) {
                                await navBarrier.whenReady(tabId);
                                const info = readoptPageInfo.get(tabId); readoptPageInfo.delete(tabId);
                                if (info) env.result = `${env.result || ""}\n\nYou are now on the new page:\n${info}`;
                                // verify → fold a view of the DESTINATION page into the result, captured on the NEW
                                // page after re-adopt (same await path as the click/type verify). "viewport" (or
                                // legacy true) = a SCREENSHOT (vision inline / a delegated description for a text
                                // driver); "text" / "text-all" = the page distilled to MARKDOWN (fetch_url's HTML→MD;
                                // cheaper, no vision — "text" strips nav/chrome, "text-all" keeps it). Best-effort.
                                const rawVerify = (args as { verify?: unknown })?.verify;
                                const verify = rawVerify === true ? "viewport" : typeof rawVerify === "string" ? rawVerify : null;
                                if (verify && !navBarrier.isNavigating(tabId)) {
                                    const payload = verify === "text" ? { runId, verifyText: "strip" as const }
                                        : verify === "text-all" ? { runId, verifyText: "all" as const }
                                        : { runId, verifyViewport: true };
                                    const v = await delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload }).catch(() => null) as Partial<import("./contract").PageToolEnvelope> | null;
                                    if (v && (v.image || v.feedback || v.result)) {
                                        if (v.result) env.result = `${env.result || ""}\n\n${v.result}`;
                                        env.image = v.image; env.imageLabel = v.imageLabel; env.feedback = v.feedback;
                                        addSub(v.subUsage);
                                    }
                                }
                            }
                        }
                        // RESERVED-surface click: the page couldn't synth-click a cross-origin iframe / sealed
                        // shadow target and handed back a CDP-click coordinate. The click was ALREADY approved
                        // above, and the trusted background performs the CDP click (the page can't). Gated on
                        // the off-by-default `cdpClick` flag (cdpClick() itself checks the debugger permission).
                        if (env?.cdpClick) {
                            const cfg = await getConfig();
                            if (!cfg.cdp) return { result: `${env.result || ""}\n\nThis needs a debugger (CDP) click, which is OFF — enable "Debugger-based actions (CDP)" in window.ml Settings → Advanced (cross-origin iframes / sealed shadow roots).`, renderIn: env.renderIn, renderOut: env.renderOut };
                            const r = await cdpClick(tabId, env.cdpClick.x, env.cdpClick.y);
                            const ok = "ok" in r;
                            if (!ok) return { result: (r as { error: string }).error, renderIn: env.renderIn, renderOut: env.renderOut };
                            // The click succeeded. If `verify` was asked, ring the PAGE back to capture the area at
                            // the click point NOW (it couldn't run inline — the click was deferred to us). Merge its
                            // image/description/feedback so the model gets the result in THIS step, not a stray look().
                            let vres = "", vimg: string | undefined, vimgLabel: string | undefined, vfeedback: import("./contract").ToolFeedback | undefined;
                            if (env.cdpClick.verify) {
                                const venv = await delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload: { runId, verifyAt: { x: env.cdpClick.x, y: env.cdpClick.y } } })
                                    .catch(() => null) as Partial<import("./contract").PageToolEnvelope> | null;
                                if (venv) { vres = venv.result || ""; vimg = venv.image; vimgLabel = venv.imageLabel; vfeedback = venv.feedback; addSub(venv.subUsage); }
                            }
                            // Append the page-side stuck-loop re-snap nudge (a repeat @pt click) to the SUCCESS result.
                            const tail = env.cdpClick.verify ? "" : " Re-run look to see the result.";
                            return { result: `Clicked the reserved target at (${env.cdpClick.x}, ${env.cdpClick.y}) via the debugger.${tail}${env.cdpClick.hint || ""}${vres}`, image: vimg, imageLabel: vimgLabel, feedback: vfeedback, renderIn: env.renderIn, renderOut: env.renderOut };
                        }
                        // SEALED-SHADOW click: a `>>>` selector targeted content inside a closed/declarative shadow
                        // root the page couldn't enter. The click was ALREADY approved above; the trusted background
                        // RESOLVES the selector via CDP (which pierces closed roots) to a viewport coordinate, then
                        // CDP-clicks it — so a sealed root never dead-ends at locate/@pt. Same `cdp`-flag gate + verify
                        // ring-back as the reserved cdpClick path above.
                        if (env?.cdpShadowClick) {
                            const cfg = await getConfig();
                            if (!cfg.cdp) return { result: `${env.result || ""}\n\nReaching a sealed shadow root needs a debugger (CDP) click, which is OFF — enable "Debugger-based actions (CDP)" in window.ml Settings → Advanced.`, renderIn: env.renderIn, renderOut: env.renderOut };
                            const resolved = await cdpShadowResolve(tabId, env.cdpShadowClick.selector);
                            if ("error" in resolved) return { result: `${env.result || ""}\n\n${resolved.error}`, renderIn: env.renderIn, renderOut: env.renderOut };
                            const m = resolved.matches[env.cdpShadowClick.index || 0];
                            if (!m) return { result: `${env.result || ""}\n\nThe debugger couldn't reach "${env.cdpShadowClick.selector}" inside the sealed shadow root (no match). Check the selector, or fall back to locate/@pt.`, renderIn: env.renderIn, renderOut: env.renderOut };
                            const r = await cdpClick(tabId, m.cx, m.cy);
                            if (!("ok" in r)) return { result: (r as { error: string }).error, renderIn: env.renderIn, renderOut: env.renderOut };
                            let vres = "", vimg: string | undefined, vimgLabel: string | undefined, vfeedback: import("./contract").ToolFeedback | undefined;
                            if (env.cdpShadowClick.verify) {
                                const venv = await delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload: { runId, verifyAt: { x: m.cx, y: m.cy } } })
                                    .catch(() => null) as Partial<import("./contract").PageToolEnvelope> | null;
                                if (venv) { vres = venv.result || ""; vimg = venv.image; vimgLabel = venv.imageLabel; vfeedback = venv.feedback; addSub(venv.subUsage); }
                            }
                            const tail = env.cdpShadowClick.verify ? "" : " Re-run look to see the result.";
                            return { result: `Clicked ${m.line} inside a sealed shadow root via the debugger (at ${m.cx}, ${m.cy}).${tail}${vres}`, image: vimg, imageLabel: vimgLabel, feedback: vfeedback, renderIn: env.renderIn, renderOut: env.renderOut };
                        }
                        // STRICT-PAGE exec: main-world eval was CSP/TT-blocked and the page handed back a cdpExec
                        // signal. UNFORGEABLE: we re-run the exact source the human APPROVED — `args.js`, from the
                        // gate above — NEVER the page-echoed `env.cdpExec.source`, so this can only ever execute
                        // the approved code; and there is no page-reachable CDP-exec message, so the ONLY path is
                        // here, after the approval. No approved `js` → refuse (never CDP-eval a page value).
                        if (env?.cdpExec) {
                            const approvedSource = typeof (args as { js?: unknown })?.js === "string" ? (args as { js: string }).js : null;
                            if (!approvedSource) return { result: env.result || "", renderIn: env.renderIn, renderOut: env.renderOut };
                            const cfg = await getConfig();
                            if (!cfg.cdp) return { result: `${env.result || ""}\n\nRunning it needs Debugger-based actions (CDP), which are OFF — enable them in window.ml Settings → Advanced (the debugger clears the page's CSP/Trusted-Types), or fall back to a read-only survey / ml.fetch.`, renderIn: env.renderIn, renderOut: env.renderOut };
                            const r = await cdpEval(tabId, approvedSource);
                            if ("ok" in r) return { result: r.value, renderIn: env.renderIn, renderOut: env.renderOut };
                            return { result: `${env.result || ""}\n\n${r.error}`, renderIn: env.renderIn, renderOut: env.renderOut };
                        }
                        // The page already computed the rendered In/Out slots (descriptorFor) — forward them so
                        // the sidebar shows the rich view. `image` rides along for INLINE VISION (native look):
                        // the loop injects it into the model's next turn (pushToolImages).
                        return { result: env?.result || `Error: the page returned nothing for tool "${name}".`, renderIn: env?.renderIn, renderOut: env?.renderOut, feedback: env?.feedback, image: env?.image, imageLabel: env?.imageLabel, images: env?.images };
                    } finally {
                        pendingGrants.delete(tabId);   // grants were for THIS approved call's sub-ops only
                    }
                },
                // Read-only try (exec only, and only when the user enabled autoApproveReadonly): ask the
                // page to run the call through the mediated interpreter — side-effect-free, so if it's
                // in-dialect it BOTH auto-approves AND returns the result, and the human gate is skipped.
                tryReadonly: p.autoApproveReadonly ? async (name, args) => {
                    if (name !== "exec") return null;
                    const env = await delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload: { runId, name, args, readonlyTry: true } })
                        .catch(() => null) as Partial<import("./contract").PageToolEnvelope> | null;
                    return env && env.readonly ? { result: env.result || "", renderIn: env.renderIn, renderOut: env.renderOut, reused: env.reused } : null;
                } : undefined,
                // Doomed-action precheck (click/type): ask the page to resolve the target side-effect-free.
                // A non-null error → the gate is SKIPPED and the error returned. Only delegated for tools
                // that HAVE a precheck (avoids a useless round-trip on every gated call).
                precheck: async (name, args) => {
                    if (!p.tools.some((t) => t.name === name && t.precheck)) return null;
                    const env = await delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload: { runId, name, args, precheck: true } })
                        .catch(() => null) as Partial<import("./contract").PageToolEnvelope> | null;
                    return env && env.precheckFailed ? (env.result || "") : null;
                },
                approve: async ({ tool, arguments: args, seq, step }) => {
                    // Ask the page to compute the In render for THIS call (without running the tool) so the
                    // blocking approval shows a pretty In — exec's beautified JS, python's code cell — not
                    // raw args. Best-effort: raw args on any failure. (Out has nothing to render pre-run.)
                    let renderIn: unknown;
                    try {
                        const env = await delegateSend(tabId, { type: "RUN_TOOL_IN_PAGE", payload: { runId, name: tool, args, renderOnly: true } }) as { renderIn?: unknown };
                        renderIn = env?.renderIn;
                    } catch { /* page gone → no preview, fall back to raw args */ }
                    // Key by the OFFSET seq — the same value the app sees on the emitted step (emitStep
                    // offsets raw→seqBase+raw) and echoes back in SET_APPROVAL. Keying by the raw seq meant a
                    // follow-up turn (seqBase>0) never matched → the gate hung forever ("stuck on Approve" on
                    // turn 2+). Turn 1 worked only because seqBase==0. (Mirror emitStep's null-guard exactly.)
                    const gateSeq = seq != null ? seqBase + seq : seq;
                    const key = `${runId}:${gateSeq}`;
                    // button #3: statically extract the persistable egress grants (e.g. this exec's inline
                    // ml.fetch literals) ONCE, background-side. The SAME list feeds the descriptor/step the
                    // human reviews AND the persistence below, so what's shown IS what's remembered.
                    const grants = extractGrants(tool, args);
                    return new Promise<ApprovalDecision>((resolve) => {
                        pendingApprovals.set(key, {
                            resolve: (decision) => {
                                const ok = decision === true || (typeof decision === "object" && !!decision && decision.approved);
                                if (ok && tool === "python_exec") for (const id of externalSheetIds(args)) approvedSheets.add(id);
                                // Approving a cross-origin nav consents to that ORIGIN for the rest of the run
                                // (repeat navs to it then skip the gate).
                                if (ok && tool === "navigate") { try { consentedOrigins.add(new URL(String((args as { url?: unknown }).url ?? "")).origin); } catch { /* relative/bad url — nothing to remember */ } }
                                // Approving a fetch_url: an UNCREDENTIALED one consents to that EXACT url for the
                                // session (repeat fetches auto-approve). A CREDENTIALED one (fetch-as-the-user)
                                // instead mints a ONE-TIME grant for this url — NEVER persisted, so it always
                                // re-prompts; consumed by the FETCH_URL handler's credentialed GET.
                                if (ok && tool === "fetch_url") {
                                    const u = String((args as { url?: unknown }).url ?? "");
                                    if (u) { if ((args as { credentials?: unknown }).credentials) grantCredFetch(tabId, u); else consentFetch(tabId, u); }
                                }
                                // button #3: "Approve + remember" — also persist the exec's static ml.fetch
                                // literals for the session (a positive `persist` decision only).
                                if (ok && typeof decision === "object" && decision.persist) persistGrants(tabId, grants);
                                // Clear the gate on EVERY surface the INSTANT it's decided — not only when the
                                // tool's DONE lands (which for a slow fetch is seconds off). Without this, a
                                // second UI (the other of DevTools panel / HUD card) kept showing approve/deny
                                // until the tool finished. This patches the pending step to non-awaiting on all
                                // surfaces (same seq); the DONE later fills the result. Fired BEFORE resolve() so
                                // it precedes the tool run.
                                // A CANCEL (Stop) resolves the gate with `{ cancelled:true }` — show "cancelled",
                                // not "denied", so a Stop doesn't flash a false accusation before the loop's own
                                // cancelled DONE lands.
                                const cancelledDecision = typeof decision === "object" && !!decision && !!decision.cancelled;
                                emitStep({ step, seq, pending: true, awaitingApproval: false, approval: cancelledDecision ? "cancelled" : ok ? "user" : "denied", tool, arguments: args });
                                resolve(decision);
                            },
                            // What the external approver sees when it enumerates gates (the UI shows the same
                            // via the emitStep below). args are already sanitized page-side for the render.
                            descriptor: { key, runId, seq: gateSeq ?? -1, step: step ?? -1, tool, arguments: args, ts: Date.now(), routing: p.approvalRouting || "ui" },
                        });
                        // Patch the pending step to show approve/deny (awaitingApproval) + the In preview. ALL
                        // three surfaces render it identically from this one step: overlay/off in the page
                        // iframe (slide-out panel vs corner card), devtools in the panel. The off-mode card
                        // reveals ITSELF on this step — no separate modal message — and the decision returns via
                        // the same origin-authed SET_APPROVAL, so the gate is unforgeable across every surface.
                        // approvalRouting "external" SUPPRESSES the UI buttons (the gate still blocks — only the
                        // __mlApprovals channel resolves it); "ui"/"both" show them as before.
                        emitStep({ step, seq, pending: true, awaitingApproval: p.approvalRouting !== "external", approvalExternal: p.approvalRouting === "external" || undefined, tool, arguments: args, renderIn, grants: grants.length ? grants : undefined });
                    });
                },
                isSheetApproved: (id) => approvedSheets.has(id),
                navNeedsConsent,   // cross-origin nav → gate; same-site / already-consented → auto (see consentedOrigins)
                fetchNeedsConsent: (url) => !fetchConsent.get(tabId)?.has(url),   // a NEW url → gate; an already-approved one → auto
                checkpoint: (messages) => persistRun(runId, { p, tabId, messages, sub: snapSub() }),   // durable resume snapshot per step
                // This turn's delegated vision sub-call tally (accumulated from each delegated tool's envelope
                // delta in delegateTool) — so chat_metadata reports the real number on the background path too.
                subcallTokens: () => snapSub(),
                emit: (ev) => emitStep(ev as Record<string, unknown>),
                drainInbox: () => {   // a.say() steering (INJECT_MESSAGE); draining flips the "seen" indicator
                    const items = (runInboxes.get(runId)?.queue || []).splice(0);
                    for (const it of items) if (it.id) fanEvent({ kind: "agent-say-seen", id: runId, ts: Date.now(), save: false, session: { hash: runId, turn: 0 }, sayId: it.id });
                    return items.map(it => it.text);
                },
                signal: abortCtl.signal,
                // chat_metadata: the run's model FACTS from the SW's caches (the loop supplies the live
                // token/message counts). The SW can also read the URL → name the backend. Degrades to null.
                chatMeta: async () => {
                    const model = p.model || null;
                    const est = (s: unknown) => (s ? Math.round(String(s).length / 4) : 0);   // ~chars/4, no tokenizer
                    let toolJson = ""; try { toolJson = JSON.stringify(p.tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }))); } catch { /* skip */ }
                    const config = await getConfig();
                    const fmt = config.apiFormat, url = config.chatUrl || "";
                    const backend = fmt === "ollama" ? "Ollama (native)"
                        : /open-?webui|\/api\/chat\/completions/i.test(url) ? "OpenWebUI (server-side tools available)"
                        : "OpenAI-compatible";
                    const overhead = { systemTokens: est(p.systemPrompt), toolTokens: est(toolJson), backend };
                    if (!model) return { model, contextWindow: null, capabilities: null, ...overhead };
                    const [capabilities, resident] = await Promise.all([
                        modelCapabilities(config, model).catch(() => null),
                        residentModels(config).catch(() => [] as { model?: string; name?: string; context_length?: number; size_vram?: number }[]),
                    ]);
                    const norm = (s: string) => s.replace(/:latest$/, "");
                    const lm = resident.find(x => x.model === model || x.name === model || norm(x.model || x.name || "") === norm(model));
                    const contextWindow = lm && typeof lm.context_length === "number" ? lm.context_length : null;
                    const vramGB = lm && lm.size_vram ? +(lm.size_vram / 1e9).toFixed(1) : null;
                    const local = capabilities !== null;   // caps came back from Ollama /api/show → resident/local
                    return { model, contextWindow, capabilities, vramGB, local, ...overhead };
                },
            },
        )
            .then(({ result: res, messages }) => {
                // Keep the run resumable: stash its full history + payload (deps rebuild from it) so a later
                // RESUME_RUN can continue it. Overwrites the prior turn's snapshot (same runId). SW-eviction
                // may drop this — resume then reports an actionable error (see bgRuns). `sub` carries the
                // cumulative sub-call tally so a resumed turn's chat_metadata keeps reporting the session total.
                // ADVANCE the stored step/seq base past THIS turn's extents: a follow-up that routes through
                // RESUME_RUN (a HUD composer follow-up AFTER the run navigated — the page handle died, so it goes
                // agentRegistry.resume → RESUME_RUN, not the page's control.stepBase path) must continue AFTER the
                // prior turns. Without this it reused base 0 and the new turn's steps collided at step/seq 1 with
                // turn 1's — the reducer patches by seq, so the follow-up's tool steps OVERWROTE turn 1's and
                // vanished from the sidebar/panel (and scrambled the export's chat-log order).
                const resumeP = { ...p, stepBase: stepBase + runMaxStep, seqBase: seqBase + runMaxSeq };
                bgRuns.set(runId, { p: resumeP, tabId, messages, sub: snapSub() });
                const answerMedia = runAnswerMedia.length ? runAnswerMedia : undefined;
                emitLifecycle({
                    kind: "agent-result", id: runId, ts: Date.now(), save: false, session: { hash: runId, turn: res.steps },
                    summary: res.summary, steps: res.steps, hitCap: !!res.hitCap, cancelled: !!res.cancelled, answerMedia,
                });
                // Sync the run's final history back so a createAgent handle's control.messages stays live,
                // + this run's step/seq extents so the page advances its bases for the NEXT turn's offset. The
                // answer element visuals ride on `res` too, so the page-side caller's own agent-result carries them.
                sendResponse({ data: { ...res, answerMedia }, messages, stepCount: runMaxStep, seqCount: runMaxSeq });
            })
            .catch((err) => {
                // A fatal loop error — surface it to the off-mode card (the page's bus is dormant there,
                // so injected can't), then reject the round-trip (injected re-throws → ml.agent rejects).
                emitLifecycle({
                    kind: "agent-result", id: runId, ts: Date.now(), save: false, session: { hash: runId, turn: 0 },
                    summary: "", steps: 0, hitCap: false, error: err?.message || String(err),
                });
                sendResponse({ error: err?.message || String(err) });
            })
            .finally(() => { runControllers.delete(runId); runInboxes.delete(runId); untrackRun(tabId, runId); deleteRun(runId); releaseDebugger(tabId); });   // detach the run's CDP debugger (attached once, reused across execs/clicks)
        return true;   // async: sendResponse fires when the whole run finishes
    }
    if (message.type === "PYTHON_EXEC") {
        // Route the sandboxed-Python run to the offscreen Pyodide host (the service worker can't run WASM).
        // CHOKE-POINT: FULL (unhardened) mode is network at the extension origin — gate it. Readonly is a
        // network-nulled sandbox (safe for any caller); full is allowed only from a trusted surface, a
        // whitelisted domain, or with a per-call grant for THIS code. An untrusted page without one is
        // REJECTED (a clear error, not a silent readonly downgrade).
        (async () => {
            const wantsFull = message.payload?.hardened === false;
            if (wantsFull) {
                const trust = await senderTrust(sender);
                if (trust === "untrusted") {
                    const code = String(message.payload?.code ?? "");
                    if (!(sender.tab?.id != null && pendingGrants.get(sender.tab.id)?.pyCode.has(code))) {
                        sendResponse({ error: "Refused: network-enabled (full) Python needs approval on this page — run it through an agent and approve it, or add this site to the approval whitelist." });
                        return;
                    }
                }
            }
            const payload = { type: "PY_RUN", code: message.payload?.code, image: message.payload?.image ?? null, hardened: message.payload?.hardened !== false, tables: message.payload?.tables ?? null };
            const attempt = () => ensureOffscreen().then(() => chrome.runtime.sendMessage(payload));
            attempt()
                .catch((err) => {
                    // The offscreen doc can be gone (SW slept and the doc was torn down, or a stale cached-
                    // ready) → "Receiving end does not exist." Drop the cache, recreate, retry ONCE.
                    if (!/Receiving end does not exist|Could not establish connection/.test(String(err?.message || err))) throw err;
                    offscreenReady = null;
                    return attempt();
                })
                .then((res) => sendResponse({ data: res }))
                .catch((err) => sendResponse({ error: err?.message || String(err) }));
        })();
        return true;   // async
    }
    if (message.type === "FETCH_SHEET") {
        // Fetch a Google Sheet's CSV export CREDENTIALED (the user's own Google session), so it works on
        // private corporate sheets — the DOM path is useless (Sheets is canvas). CHOKE-POINT: the host-lock
        // stops general SSRF, but the sheet id is caller-chosen and this spends the user's cookies — so an
        // untrusted page may only read a sheet it holds a per-call grant for (minted when its agent run
        // approved it). A trusted surface / whitelisted domain is unrestricted (host-lock still applies).
        (async () => {
            const url = message.payload?.url || "";
            if (await senderTrust(sender) === "untrusted") {
                const id = googleSheetId(url);
                if (!(id && sender.tab?.id != null && pendingGrants.get(sender.tab.id)?.sheets.has(id))) {
                    sendResponse({ error: "Refused: this sheet hasn't been approved for this page — run it through an agent and approve it, or add this site to the approval whitelist." });
                    return;
                }
            }
            try { sendResponse({ data: await fetchSheetCsv(url) }); }   // { csv, name } — name from Content-Disposition
            catch (err) { sendResponse({ error: (err as Error)?.message || String(err) }); }
        })();
        return true;   // async
    }
    if (message.type === "FETCH_URL") {
        // ml.fetch(url): an UNCREDENTIALED GET the agent uses to READ content the page can't (a raw file, a
        // JSON API, another site) — bypasses CORS via host permissions, but sends NO cookies. CHOKE-POINT:
        // there's no URL host-lock (arbitrary URLs are the point), so the boundary IS the consent — an
        // untrusted page may fetch only a URL the user approved for THIS tab (grown in a run's approval,
        // unforgeable). A trusted surface / whitelisted domain is unrestricted. Only http(s) targets.
        (async () => {
            const url = String((message.payload as { url?: unknown })?.url || "");
            const credentials = !!(message.payload as { credentials?: unknown })?.credentials;
            let scheme = "";
            try { scheme = new URL(url).protocol; } catch { sendResponse({ error: `Refused: "${url}" is not a valid URL.` }); return; }
            if (scheme !== "http:" && scheme !== "https:") { sendResponse({ error: `Refused: ml.fetch supports only http(s) URLs (got "${scheme}").` }); return; }
            const tabId = sender.tab?.id;
            const untrusted = await senderTrust(sender) === "untrusted";
            // CREDENTIALED (fetch-as-the-user): sends the user's cookies → a "read any URL as you" primitive, so
            // an untrusted page needs a ONE-TIME per-URL grant (minted by an approved fetch_url, consumed here).
            // execOpen/consent deliberately DON'T authorize it, so an inline `ml.fetch(url,{credentials:true})`
            // in exec is refused (no per-URL grant) — directs the model to the explicit, human-approved tool.
            if (credentials) {
                if (untrusted && !takeCredFetch(tabId, url)) {
                    sendResponse({ error: `Refused: a credentialed fetch of "${url}" wasn't approved. A fetch AS THE USER (cookies) must be approved per-URL via the fetch_url tool ({ credentials: true }); it can't run inline in exec or reuse a prior grant.` });
                    return;
                }
            } else {
                // UNCREDENTIALED: fetchOpen = an approved exec is running (its inline fetches are the human-approved
                // code); per-URL consent = the human approved EXACTLY this url (and it's remembered).
                const execOpen = tabId != null && !!pendingGrants.get(tabId)?.fetchOpen;
                if (untrusted && !execOpen && !(tabId != null && fetchConsent.get(tabId)?.has(url))) {
                    sendResponse({ error: `Refused: "${url}" hasn't been approved for fetching on this page. Use the fetch_url tool (each new URL is approved once, then remembered for the session), or call ml.fetch inside an approved exec.` });
                    return;
                }
            }
            const execOpen = tabId != null && !!pendingGrants.get(tabId)?.fetchOpen;
            try {
                const data = await fetchUrlContent(url, credentials);
                // Redirect guard: a per-URL-consented fetch (NOT a surface/whitelisted/exec one) that ends on a
                // DIFFERENT, un-consented origin followed a redirect off the approved resource — withhold the body
                // (a consented public URL could redirect to a private/other target). The GET already happened but
                // no data leaves, and returning nothing is safe. exec (execOpen) trusts the code's own redirects.
                if (untrusted && !execOpen) {
                    let sameOrigin = true;
                    try { sameOrigin = new URL(data.url).origin === new URL(url).origin; } catch { /* keep true */ }
                    if (!sameOrigin && !fetchConsent.get(tabId!)?.has(data.url)) {
                        sendResponse({ error: `"${url}" redirected to a different origin (${(() => { try { return new URL(data.url).origin; } catch { return data.url; } })()}), which hasn't been approved. Fetch that URL directly to approve it.` });
                        return;
                    }
                }
                sendResponse({ data });
            }
            catch (err) {
                const m = (err as Error)?.message || String(err);
                // A redirect loop / too-many-redirects surfaces as a generic "Failed to fetch" (Chrome opaques the
                // reason), so we can only HINT at it — the exact hops aren't visible to fetch.
                sendResponse({ error: `Could not fetch "${url}" (${m}). Possible causes: a redirect loop / too many redirects (the chain isn't visible to the extension), the extension lacking host access (grant "On all sites"), or the URL being unreachable.` });
            }
        })();
        return true;   // async
    }
    if (message.type === "FETCH_SHEET_TITLE") {
        // TITLE-ONLY, pre-approval: the approval card fetches just the sheet name so the USER sees WHICH
        // sheet they're granting (the MODEL never gets it). INTERNAL-ONLY — it's not in the content relay.
        // Gate on the sender's ORIGIN, not on sender.tab: the DevTools panel is a top-level extension page
        // (sender.tab == null), but the overlay/off-mode card is our extension-origin IFRAME embedded in a
        // page tab (sender.tab is SET, sender.url is our origin). The old `sender.tab != null` guard wrongly
        // refused that embedded card, so the HUD showed the generic "Google Sheet" instead of the real title.
        // A web page can't reach chrome.runtime.onMessage at all; a content script's sender.url is the page url.
        if (!(sender.url || "").startsWith(chrome.runtime.getURL(""))) { sendResponse({ data: null }); return true; }
        const id = String(message.payload?.id || "").trim();
        const url = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=0`;
        if (!/^[A-Za-z0-9_-]+$/.test(id) || !SHEET_URL_OK.test(url)) { sendResponse({ data: null }); return true; }
        fetch(url, { method: "HEAD", credentials: "include" })
            .then((res) => sendResponse({ data: res.ok ? sheetNameFromDisposition(res.headers.get("content-disposition")) : null }))
            .catch(() => sendResponse({ data: null }));
        return true;   // async
    }
    if (message.type === "ABORT_TASK") {
        // Cancel an in-flight task by its requestId (currently only FETCH_LLM registers a
        // controller). Fire-and-forget — no sendResponse, so don't keep the channel open.
        const ctl = inflight.get(message.payload?.requestId);
        if (ctl) { ctl.abort(); inflight.delete(message.payload.requestId); }
        return;
    }
    if (message.type === "FETCH_LLM") {
        // Register an AbortController keyed by requestId so an ABORT_TASK (from ml.agent's signal)
        // can kill the in-flight fetch — don't leave a slow local generation running after cancel.
        const rid: string | undefined = message.requestId;
        const ctl = new AbortController();
        if (rid) inflight.set(rid, ctl);
        const done = () => { if (rid) inflight.delete(rid); };
        fetchLLM(message.payload, ctl.signal)
            // raw (ml.step) returns { content, tool_calls } as data; normal chat
            // returns the content string, with sources alongside only when present.
            .then((result: any) => {
                if (message.payload.raw) return sendResponse({ data: result });
                const resp: any = { data: result.content, model: result.model ?? null };
                if (result.sources && result.sources.length) resp.sources = result.sources;
                if (result.reasoning) resp.reasoning = result.reasoning;
                if (result.usage) resp.usage = result.usage;
                sendResponse(resp);
            })
            .catch(err => sendResponse({ error: err.message }))
            .finally(done);
        return true; // Keep channel open for async fetch

    } else if (message.type === "LIST_MODELS") {
        // Config overrides are only honored from the extension's own pages
        // (popup); pages relaying through the content script (sender.tab set)
        // must not be able to point the saved API key at another host.
        // Filter the returned list by the model-filter whitelist too, so a page's
        // ml.models() never even SEES an excluded (e.g. cloud) model, and the settings
        // datalists only offer allowed ones. Enforcement still lives in prepareRequest;
        // this is the "don't surface it" half.
        Promise.all([listAvailableModels(sender.tab ? {} : (message.payload || {})), getConfig()])
            .then(([{ ids, ollamaModels }, cfg]) => {
                const keep = (m: string) => modelFilterAllows(m, cfg.modelFilter);
                sendResponse({ data: ids.filter(keep), ollamaModels: ollamaModels ? ollamaModels.filter(keep) : null });
            })
            .catch(err => sendResponse({ error: err.message }));
        return true;

    } else if (message.type === "LIST_SERVER_TOOLS") {
        // Read-only discovery of what `toolIds` accepts. No sender gating: the tool
        // list is scoped to the saved API key by OpenWebUI itself (its access control),
        // and names/specs are no more secret than the model list — the URL and key stay
        // behind the worker either way.
        listServerTools()
            .then(tools => sendResponse({ data: tools }))
            .catch(err => sendResponse({ error: err.message }));
        return true;

    } else if (message.type === "SET_MODEL") {
        setModel(message.payload && message.payload.model)
            .then(model => sendResponse({ data: model }))
            .catch(err => sendResponse({ error: err.message }));
        return true;

    } else if (message.type === "GET_MODEL") {
        getConfig()
            .then(config => sendResponse({ data: config.model }))
            .catch(err => sendResponse({ error: err.message }));
        return true;

    } else if (message.type === "GET_INVOCATION") {
        // How to open the HUD on THIS install. The shortcut is user-rebindable at
        // chrome://extensions/shortcuts, so we report what chrome.commands says is bound RIGHT NOW
        // (and whether that still matches the manifest) rather than letting anything hardcode
        // "Alt+Space" — a stale answer sends the user to a key that does nothing. Non-secret:
        // it's the user's own UI affordance, so no sender gating.
        const manifest = chrome.runtime.getManifest?.() || {} as chrome.runtime.Manifest;
        const suggested = manifest.commands?.["open-composer"]?.suggested_key;
        const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent || "");
        const defaultShortcut = (typeof suggested === "string" ? suggested
            : (isMac ? suggested?.mac : suggested?.default) || suggested?.default) || "";
        // contextMenus is a permission-gated API, so the manifest declaring it is a truthful proxy
        // for "the right-click entry exists" — this line turns itself on when that feature lands.
        const contextMenu = (manifest.permissions || []).includes("contextMenus");
        Promise.resolve(chrome.commands?.getAll?.() ?? [])
            .then((cmds: chrome.commands.Command[]) => {
                const shortcut = cmds.find(c => c.name === "open-composer")?.shortcut || "";
                sendResponse({ data: { shortcut, defaultShortcut, isDefault: !!shortcut && shortcut === defaultShortcut, contextMenu } });
            })
            .catch(() => sendResponse({ data: { shortcut: "", defaultShortcut, isDefault: false, contextMenu } }));
        return true;

    } else if (message.type === "GET_CONFIG") {
        // Non-secret config the page may read (model/OCR model/format). The URL
        // and API key are deliberately withheld — see the security invariants.
        getConfig()
            .then(config => {
                // Compute whether THIS page's origin is on the user's page-approval whitelist. The origin
                // comes from the trusted `sender` (the content script's tab URL), NOT anything the page
                // sends — so a page can't claim to be whitelisted. Only the boolean crosses to the page;
                // the domain list never does.
                let pageApprovalAllowed = false;
                try {
                    const url = sender.tab?.url || sender.url || "";
                    const host = url ? new URL(url).hostname : "";
                    pageApprovalAllowed = !!host && (config.pageApprovalDomains || []).includes(host);
                } catch { /* opaque/blank origin → not allowed */ }
                sendResponse({ data: {
                    model: config.model, ocrModel: config.ocrModel, ocrNumCtx: config.ocrNumCtx, apiFormat: config.apiFormat,
                    defaultModelVision: config.defaultModelVision,
                    utilityModel: config.utilityModel, utilityNumCtx: config.utilityNumCtx, utilityForceCpu: config.utilityForceCpu,
                    autoApproveReadonly: config.autoApproveReadonly, autoApprovePython: config.autoApprovePython,
                    pierceClosedShadow: config.pierceClosedShadow,
                    groundingEnabled: config.groundingEnabled, groundingModel: config.groundingModel,
                    groundingRange: config.groundingRange, debugMode: config.debugMode, pageApprovalAllowed,
                } });
            })
            .catch(err => sendResponse({ error: err.message }));
        return true;

    } else if (message.type === "MODEL_CAPS") {
        getConfig()
            .then(config => modelCapabilities(config, (message.payload && message.payload.model) || config.model))
            .then(caps => sendResponse({ data: caps }))
            .catch(err => sendResponse({ error: err.message }));
        return true;

    } else if (message.type === "OLLAMA_PS") {
        listLoadedModels()
            .then(models => sendResponse({ data: models }))
            .catch(err => sendResponse({ error: err.message }));
        return true;

    } else if (message.type === "OLLAMA_UNLOAD") {
        unloadModels(message.payload && message.payload.model)
            .then(unloaded => sendResponse({ data: unloaded }))
            .catch(err => sendResponse({ error: err.message }));
        return true;

    } else if (message.type === "FETCH_IMAGE_B64") {
        // Uncredentialed (no auth-data leak), but a "read any URL's bytes" primitive at the extension
        // origin — so an SSRF denylist keeps a page from probing/reading the user's internal network.
        if (isBlockedFetchTarget(message.payload?.url || "")) {
            sendResponse({ error: "Refused: cannot fetch a private / loopback / link-local / metadata address." });
            return true;
        }
        fetch(message.payload.url)
            .then(response => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.blob();
            })
            .then(blob => {
                const reader = new FileReader();
                reader.onloadend = () => {
                    // Returns "data:image/jpeg;base64,..."
                    sendResponse({ data: reader.result });
                };
                reader.readAsDataURL(blob);
            })
            .catch(err => sendResponse({ error: err.message }));
        return true;

    } else if (message.type === "CAPTURE_TAB") {
        // Screenshot the visible viewport so the page can crop it to an element.
        // Privileged: pages can't capture pixels, and a cross-origin canvas would
        // taint — same escalation the FETCH_IMAGE_B64 fetch already grants. For a
        // page-relayed message sender.tab is set; its windowId targets the tab.
        const doCapture = () => sender.tab
            ? chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" })
            : chrome.tabs.captureVisibleTab({ format: "png" });
        (async () => {
            const cfg = await getConfig();
            const tabId = sender.tab?.id;
            // PREFER CDP when it's enabled: Page.captureScreenshot captures the SAME viewport at the SAME device
            // pixel ratio as captureVisibleTab (verified: 800x600@2 → 1600x1200), so the coordinate math is
            // identical — but it works on strict / "On click" pages with NO host grant (the debugger is exempt,
            // like exec/click) and is NOT subject to captureVisibleTab's ~2/sec quota. The debugger is attached
            // once per run (reused), so a multi-look run shows the infobar steadily rather than per-shot.
            let cdpErr = "";
            if (cfg.cdp && tabId != null) {
                const shot = await cdpScreenshot(tabId);
                if ("ok" in shot) { sendResponse({ data: shot.dataUrl }); return; }
                cdpErr = shot.error;   // attach conflict (real DevTools open) / no debugger permission → fall back below
            }
            // Fallback (CDP off, or its attach failed): captureVisibleTab. Chrome RATE-LIMITS it (~2/sec —
            // MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND); a burst of look()/locate() trips a TRANSIENT quota error
            // the model can't act on, so wait out the ~1s window and retry a few times before surfacing it.
            for (let attempt = 0; ; attempt++) {
                try { sendResponse({ data: await doCapture() }); return; }
                catch (err) {
                    const emsg = (err as Error)?.message || String(err);
                    if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(emsg) && attempt < CAPTURE_RETRIES) {
                        await new Promise(r => setTimeout(r, CAPTURE_RETRY_MS)); continue;
                    }
                    // captureVisibleTab needs activeTab OR <all_urls> specifically (Chromium's
                    // kActiveTabOrAllUrls) — a per-HOST grant like github.com does NOT satisfy it, and "On click"
                    // withholds <all_urls> while a navigation revokes activeTab. The clean fix is the debugger
                    // (exempt), so steer to CDP; a per-host grant would be a dead end.
                    if (/all_urls|activeTab|permission is required/i.test(emsg)) {
                        const cdpNote = cdpErr
                            ? ` The debugger route (CDP) is enabled but couldn't attach here (${cdpErr}) — close Chrome DevTools on this tab if it's open, then retry.`
                            : " Easiest fix: enable \"Debugger-based actions (CDP)\" in window.ml Settings → Advanced — then look/locate screenshot via the debugger (exempt from site access), exactly how exec works here.";
                        sendResponse({ error:
                            `Can't screenshot this page — captureVisibleTab needs "On all sites" access; a per-site grant like this host does NOT enable it.${cdpNote} ` +
                            "Alternatively set the extension's site access to \"On all sites\" (right-click the toolbar icon → \"This can read and change " +
                            "site data\" → \"On all sites\"). Then ask me to look again."
                        });
                        return;
                    }
                    sendResponse({ error: emsg }); return;
                }
            }
        })();
        return true;

    } else if (message.type === "SAVE_SESSION") {
        // Persist a { save:true } chat session so ml.resumeChat can rehydrate it
        // across reloads/tabs. Page-provided message history + createChat options
        // — no secrets (URL/key never live in a session). Main world can't touch
        // storage, hence this round-trip.
        const { hash, session } = message.payload || {};
        chrome.storage.local.set({ [`ml_session_${hash}`]: session })
            .then(() => sendResponse({ data: true }))
            .catch(err => sendResponse({ error: err.message }));
        return true;

    } else if (message.type === "GET_SESSION") {
        const key = `ml_session_${(message.payload || {}).hash}`;
        chrome.storage.local.get(key)
            .then((d: any) => sendResponse({ data: d[key] || null }))
            .catch(err => sendResponse({ error: err.message }));
        return true;
    }
});

// Streaming uses a Port instead of the one-shot sendMessage/sendResponse, so
// tokens can arrive as many messages. The content script opens the port and
// posts { payload }; we stream { type: "chunk", delta } and finish with
// { type: "done", content, sources, model } or { type: "error", error }. A connected
// port also keeps the MV3 service worker alive for the request's duration.
chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "LLM_STREAM") return;
    // The Port IS the cancellation channel: content.js disconnects it when the caller aborts
    // (ml.chat's signal) → abort the streaming fetch so a slow generation stops. `closed` guards
    // against posting to the dead port after a disconnect.
    const ctl = new AbortController();
    let closed = false;
    port.onDisconnect.addListener(() => { closed = true; ctl.abort(); });
    port.onMessage.addListener((message: any) => {
        streamLLM(message.payload, (delta) => { if (!closed) port.postMessage({ type: "chunk", delta }); }, ctl.signal)
            .then(({ content, sources, model, reasoning, usage }) => { if (!closed) port.postMessage({ type: "done", content, sources, model, reasoning, usage }); })
            .catch((err) => { if (!closed) port.postMessage({ type: "error", error: err.message }); });
    });
});

// ---- DevTools panel debug stream (opt-in second surface for the sidebar) ----
// The in-page overlay receives __mlDebug via window-messages; a DevTools panel can't, so
// the content-script shell also forwards each event here (ML_DEBUG_EVENT). We buffer per
// inspected tab — a panel opened mid-run replays what it missed (the overlay never needs
// this, it's always mounted) — and fan out to any connected panel for that tab.
const devtoolsPorts = new Map<number, Set<chrome.runtime.Port>>();
const debugBuffer = new Map<number, unknown[]>();
const DEBUG_BUFFER_CAP = 500;   // drop-oldest ring; screenshots are big, so keep it modest

function relayDebugEvent(tabId: number, event: unknown): void {
    let buf = debugBuffer.get(tabId);
    if (!buf) { buf = []; debugBuffer.set(tabId, buf); }
    buf.push(event);
    if (buf.length > DEBUG_BUFFER_CAP) buf.splice(0, buf.length - DEBUG_BUFFER_CAP);
    const ports = devtoolsPorts.get(tabId);
    if (ports) for (const p of ports) { try { p.postMessage({ __mlDebug: event }); } catch { /* port closing */ } }
}

// A fresh page mount (shell remount → ML_DEBUG_RESET) clears the buffer AND tells any
// connected panel to drop its stale sessions — the panel's app outlives a page reload, so
// without this it keeps the prior load's data while new events pile on under it.
function resetDebug(tabId: number): void {
    // A cross-page run's shell remounts on the new page and fires ML_DEBUG_RESET — but the run may STILL be
    // live (activeRuns) OR resumable (bgRuns: completed-but-follow-up-able, or INTERRUPTED by an SW restart —
    // e.g. a mid-run site-access grant that cycled the worker). In any of those the session is on disk / in
    // bgRuns and about to recover, so keep its history: a late CS injection's reset must NOT drop the panel/HUD
    // session out from under a run that's coming back (the reported "the session vanished after I granted the
    // site" bug). Only a tab with NO run at all clears.
    if (activeRuns.has(tabId) || tabHasBgRun(tabId)) return;
    debugBuffer.delete(tabId);
    const ports = devtoolsPorts.get(tabId);
    if (ports) for (const p of ports) { try { p.postMessage({ reset: true }); } catch { /* port closing */ } }
}

chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "ml-devtools") return;
    let tabId: number | null = null;
    port.onMessage.addListener((msg: any) => {
        if (msg?.type === "ml-devtools-init" && typeof msg.tabId === "number") {
            const tid: number = msg.tabId;   // const local: TS narrows it (a captured `let` wouldn't)
            tabId = tid;
            let set = devtoolsPorts.get(tid);
            if (!set) { set = new Set(); devtoolsPorts.set(tid, set); }
            set.add(port);
            port.postMessage({ replay: debugBuffer.get(tid) || [] });   // catch a late-opened panel up
        }
    });
    port.onDisconnect.addListener(() => {
        const tid = tabId;
        if (tid == null) return;
        const set = devtoolsPorts.get(tid);
        if (set) { set.delete(port); if (!set.size) devtoolsPorts.delete(tid); }
    });
});

// The Spotlight command bar keyboard shortcut (manifest `commands`, default Alt+Space, user-rebindable
// at chrome://extensions/shortcuts). Tell the active tab's shell to open the HUD composer; the shell
// no-ops unless the HUD is the active surface. `chrome.commands` may be absent in a test harness.
chrome.commands?.onCommand.addListener((command, tab) => {
    if (command === "open-composer" && tab?.id != null)
        chrome.tabs.sendMessage(tab.id, { type: "ML_OPEN_COMPOSER" }).catch(() => { /* no content script on this tab */ });
});

// Right-click "Ask window.ml about this" — the content-script shell resolves the clicked element's
// semantic container + clean context and opens the Commander pre-loaded with it (see shell.ts). Created on
// install (persists); re-created defensively in case the item was cleared. contextMenus may be absent in tests.
chrome.runtime.onInstalled?.addListener((details) => {
    // A deliberate reload or an update (NOT an idle SW respawn — that never fires onInstalled): invalidate any
    // in-flight background run. Its snapshot may be from OLD code, and this is often how you kill a runaway —
    // it must never silently resume across the reload. hydrate() may have loaded old snapshots into memory a
    // moment ago on this same spawn; purge those too.
    if (details?.reason === "install" || details?.reason === "update") void purgeAllBgRuns();
    try {
        chrome.contextMenus?.removeAll?.(() => {
            // Fresh run.
            chrome.contextMenus?.create({ id: "ml-ask-about-this", title: "Ask window.ml about this…", contexts: ["all"] });
            // Append to the run already open in the HUD (steer if running, follow-up if idle). Falls back to a
            // fresh composer page-side when nothing's open, so it's never a dead entry.
            chrome.contextMenus?.create({ id: "ml-add-to-run", title: "Add this to the current window.ml run…", contexts: ["all"] });
        });
    } catch { /* not available */ }
});
chrome.contextMenus?.onClicked.addListener((info, tab) => {
    if (tab?.id == null) return;
    if (info.menuItemId === "ml-ask-about-this")
        chrome.tabs.sendMessage(tab.id, { type: "ML_ASK_ABOUT_THIS" }).catch(() => { /* no content script on this tab */ });
    else if (info.menuItemId === "ml-add-to-run")
        chrome.tabs.sendMessage(tab.id, { type: "ML_ADD_TO_CURRENT_RUN" }).catch(() => { /* no content script on this tab */ });
});

// ---- Google Sheets CSV fetch (python_exec `sheet`) ----
// Fetch the sheet's CSV export with the user's own cookies (credentials:"include"), so a
// PRIVATE sheet they can see works — the page DOM can't (Sheets renders to canvas). If they
// aren't signed in / lack access, Google redirects the export to an HTML login page instead
// of CSV; detect that and return an actionable error the model relays to the user.
// Only a Google Sheets CSV-export URL may be fetched here. This is the ONLY defense against a
// hostile page: the approval gate lives client-side (injected.ts), but the raw FETCH_SHEET message
// is reachable by any page via the content-script relay, and this fetch is CREDENTIALED — without
// this check it's a cookie-authenticated "read any URL" (SSRF/exfil) primitive. Confine it to the
// docs.google.com export endpoint; Google's own redirects (login/large-file) are still followed.
const SHEET_URL_OK = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]+\/export\?/;

// The sheet's TITLE from the export's Content-Disposition ("Name - Tab.csv" → "Name"). Shared by the
// full CSV fetch and the title-only HEAD (approval chip). A background fetch with host permission reads
// all headers (no CORS limit). null on a missing/garbled header.
function sheetNameFromDisposition(cd: string | null): string | null {
    try {
        // PREFER filename* (RFC 5987, UTF-8 %-encoded → keeps spaces) over the ASCII `filename=`
        // fallback, which Google SPACE-STRIPS ("quarterly sales" → "quarterlysales"). Google sends both;
        // the plain one appears first, so a naive left-to-right match picks the wrong (stripped) one.
        const star = /filename\*=(?:[^']*'')?([^;]+)/i.exec(cd || "");
        const plain = /filename="?([^";]+)"?/i.exec(cd || "");
        const enc = star ? star[1].trim() : (plain ? plain[1].trim() : "");
        if (!enc) return null;
        const fn = star ? decodeURIComponent(enc) : enc;   // only filename* is %-encoded
        // "<Spreadsheet> - <Tab>.csv" → the SPREADSHEET name. Strip the LAST "-<tab>" segment (spaces
        // around the dash optional — Google's filename separator varies), keeping earlier dashes.
        return fn.replace(/\.csv$/i, "").replace(/\s*-\s*[^-]*$/, "").trim() || null;
    } catch { return null; }
}

// The largest body ml.fetch keeps. `ml.fetch()` is meant to feed CODE (parse a whole JSON/CSV/source file
// in `exec`/`python_exec`), so it must NOT truncate at a small context-sized cap — the model-facing DISPLAY
// is clipped separately (the fetch_url tool's clipOut, and exec/python's own output clip), so this bound is
// only a memory/message-channel safety net for a pathologically huge response, set well above realistic files.
const FETCH_URL_MAX = 8_000_000;
/** Browser-IDENTITY request headers for ml.fetch, so a fetch acts like the user's own browser rather than a
 *  bare programmatic request — many sites (GitHub's "Whoa there!" abuse page) block the latter's tell-tale
 *  missing headers. This sends the browser's PUBLIC identity (its real User-Agent + Accept-Language), NOT the
 *  user's private data: no cookies here (those ride only the gated `credentials:"include"` path). We set only
 *  headers `fetch` actually lets us override — `Sec-Fetch-*`/`Origin`/`Referer`/`Cookie` are browser-controlled
 *  (forbidden header names) and left untouched; `Accept`/`Accept-Language` are CORS-safelisted, and modern
 *  Chrome allows overriding `User-Agent`. */
function browserFetchHeaders(): Record<string, string> {
    // HTML/XML first like a browser, but welcome JSON/anything — ml.fetch reads APIs too.
    const h: Record<string, string> = { "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8" };
    try { if (typeof navigator !== "undefined" && navigator.userAgent) h["User-Agent"] = navigator.userAgent; } catch { /* no navigator → skip */ }
    try {
        const langs = typeof navigator !== "undefined"
            ? (navigator.languages && navigator.languages.length ? [...navigator.languages] : [navigator.language])
            : [];
        const al = acceptLanguageFrom(langs.filter(Boolean) as string[]);
        if (al) h["Accept-Language"] = al;
    } catch { /* skip */ }
    return h;
}
/** Perform the actual uncredentialed GET for ml.fetch (host permissions bypass CORS; NO cookies). Classifies
 *  the body by header AND content (a server can mislabel), pre-parses JSON, and caps the size. Throws on a
 *  network/permission failure (the handler turns that into an actionable message). */
async function fetchUrlContent(url: string, credentials = false): Promise<FetchResult> {
    // `credentials:"include"` sends the user's cookies (authenticated fetch — gated + one-time upstream);
    // default `"omit"` reads only public bytes. Browser-identity headers either way (see browserFetchHeaders).
    const res = await fetch(url, { method: "GET", credentials: credentials ? "include" : "omit", redirect: "follow", headers: browserFetchHeaders() });
    const contentType = res.headers.get("content-type") || "";
    let text = await res.text();
    const truncated = text.length > FETCH_URL_MAX;
    if (truncated) text = text.slice(0, FETCH_URL_MAX);
    const { type, language, byHeader, byContent, byExtension } = classifyContent(contentType, text, url);
    const out: FetchResult = {
        url: res.url || url, status: res.status, ok: res.ok, type, language,
        typeByHeader: byHeader, typeByContent: byContent, typeByExtension: byExtension, contentType, text,
        truncated: truncated || undefined, redirected: res.redirected || undefined,
    };
    // Pre-parse JSON only when it's whole — a truncated body can't parse. (type stays "json" so the agent knows.)
    // A parsed value also gets a compact TS-like `schema` (jsonShape) so the model can see the structure
    // without the whole payload — on the return object, and the tool can prefer it.
    if (type === "json" && !truncated) {
        try { out.json = JSON.parse(text); out.schema = jsonShape(out.json); } catch { /* mislabelled → leave as text */ }
    }
    return out;
}

async function fetchSheetCsv(url: string): Promise<{ csv: string; name: string | null }> {
    if (!url) throw new Error("No sheet URL.");
    if (!SHEET_URL_OK.test(url)) throw new Error("Refused: only Google Sheets CSV-export URLs can be fetched here.");
    let res: Response;
    try { res = await fetch(url, { credentials: "include", redirect: "follow" }); }
    catch (e: any) {
        // A network throw here is usually the extension's SERVICE-WORKER host access being WITHHELD:
        // "On click" grants activeTab (content scripts on the tab) but NOT the background fetch's
        // host permission, so the CSV fetch is unauthorized even while you're ON the sheet. And the
        // export can REDIRECT (login → accounts.google.com; big files → *.googleusercontent.com), so
        // whitelisting only docs.google.com can still fail on the hop → recommend "On all sites".
        // The popup's "Enable Google Sheets access" button requests these persistently in one click.
        let granted = true;
        try { granted = await chrome.permissions.contains({ origins: ["https://docs.google.com/*"] }); } catch { /* older Chrome → assume granted, fall through to the generic error */ }
        if (!granted) {
            // Nudge the user straight to the one-click grant: pop the toolbar popup, where the
            // "Permissions → Enable" button lives. Best-effort — openPopup needs a focused window
            // and is Chrome 127+, so tolerate a throw; the message below still guides them.
            try { await (chrome.action as any).openPopup?.(); } catch { /* no gesture / unsupported → rely on the message */ }
            throw new Error(
                "Can't fetch this Google Sheet — the extension has no host access to docs.google.com (\"On click\" " +
                "site access lets it run on the page but NOT make the background request that pulls the CSV). " +
                "Tell the USER: I've opened this extension's toolbar popup — under \"Permissions\", click \"Enable " +
                "Google Sheets access\" (one click). If it didn't open, click the extension's icon in the browser " +
                "toolbar and do the same. (Or: the browser's Extensions manager → this extension → \"Site access\" " +
                "→ \"On all sites\", recommended since the export can redirect across Google domains.) Then have them " +
                "ask me to try again. It's a browser permission, not a Google login."
            );
        }
        throw new Error(`Couldn't reach the sheet (${e?.message || e}).`);
    }
    const body = await res.text();
    const ct = res.headers.get("content-type") || "";
    if (!res.ok || /text\/html/i.test(ct) || /^﻿?\s*<(!doctype|html)\b/i.test(body)) {
        throw new Error(
            "Not signed in to Google, or no access to this sheet. Tell the USER to open the " +
            "sheet's link in this browser, sign in (or request access), then ask you to try again."
        );
    }
    return { csv: body, name: sheetNameFromDisposition(res.headers.get("content-disposition")) };
}

// ---- Offscreen Pyodide host (python_exec) ----
// The service worker can't run WASM, so python_exec runs in an offscreen document
// (extension-origin, 'wasm-unsafe-eval' CSP). Created lazily on first use, reused after.
let offscreenReady: Promise<void> | null = null;
function ensureOffscreen(): Promise<void> {
    if (offscreenReady) return offscreenReady;
    offscreenReady = (async () => {
        if (await chrome.offscreen.hasDocument?.()) return;
        try {
            await chrome.offscreen.createDocument({
                url: "offscreen.html",
                reasons: [chrome.offscreen.Reason.WORKERS],
                justification: "Runs the sandboxed Python (Pyodide/WASM) execution for the python_exec tool.",
            });
        } catch (e) {
            if (!(await chrome.offscreen.hasDocument?.())) throw e;   // tolerate a concurrent create
        }
    })();
    offscreenReady.catch(() => { offscreenReady = null; });   // let a failed create be retried
    return offscreenReady;
}

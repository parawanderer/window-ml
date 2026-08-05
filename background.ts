// Background service worker: owns config, builds per-format request bodies,
// extracts replies, and makes the privileged (host-permissioned) fetches. All
// server JSON is genuinely opaque, so it's typed `any`; our own data uses the
// shared contract types.
import type { MlConfig, ApiFormat, NeutralMessage, ToolCall, FetchLlmPayload, LlmResult, LoadedModel, ServerTool, JsonSchema, TokenUsage, StartRunPayload, SetApprovalPayload, CancelRunPayload, ResumeRunPayload, InjectMessagePayload, ApprovalDecision } from "./contract";
import { DEFAULT_CONFIG, modelFilterAllows } from "./contract";   // single source of truth (see contract.ts)
import { runBackgroundAgent } from "./agent-host";   // design A: the background-hosted agent loop
import type { ToolMeta } from "./agent-loop";
import { externalSheetIds, googleSheetId } from "./dom";   // track approved external sheets across a run + the choke-point grants

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
    streamChunk(line: string): { delta: string; reasoning?: string; toolCall: boolean; sources?: unknown[] | null; usage?: TokenUsage | null } | null;
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
            return { delta: obj.message?.content || "", reasoning: obj.message?.thinking || "", toolCall: !!obj.message?.tool_calls, usage: obj.done ? normalizeUsage(obj) : null };
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
    let numCtx = payload.numCtx ?? (useUtility ? config.utilityNumCtx : undefined);
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

    const send = async (requestBody: ChatBody, stream = false): Promise<any> => {
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
            // fetch rejects with a bare "Failed to fetch". Translate it into an actionable message; the raw
            // one is meaningless to a user and identical for every cause.
            throw new Error(
                `Couldn't reach the server at ${config.chatUrl} (${e?.message || e}). ` +
                `Is OpenWebUI / Ollama running there? Check the Server URL, API key, and API format in the extension settings.`
            );
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
const pendingApprovals = new Map<string, (d: ApprovalDecision) => void>();

// Design A: the AbortController for each live background run, keyed by runId, so a CANCEL_RUN message
// (the HUD's "Cancel agent run") stops the loop at the next boundary AND kills a slow in-flight model
// call. Deleted when the run settles. Aborting resolves the loop as { cancelled: true } (partial transcript).
const runControllers = new Map<string, AbortController>();

// Design A resume (Phase 2): after a background-hosted run settles, keep enough to CONTINUE it — the
// full message history + the original StartRunPayload (deps are rebuilt from it) + the owning tab. A
// RESUME_RUN {runId, task} re-enters the loop from this history. In-memory only, so it's subject to
// MV3 service-worker eviction (~30s idle) — resume works while the SW is warm (the common
// finish-then-follow-up flow); an evicted run reports an actionable error and the caller starts fresh.
const bgRuns = new Map<string, { p: StartRunPayload; tabId: number; messages: NeutralMessage[] }>();

// Per-run steering inbox (a.say() mid-run): the SW-side twin of the page loop's control.inbox. INJECT_MESSAGE
// pushes here (only the owning tab may); the run's loop drains it at each step boundary (deps.drainInbox).
// Present only while a run is live (set at start, deleted in finally).
const runInboxes = new Map<string, { tabId: number; queue: string[] }>();

// ---- Choke-point consent (docs/spec/CHOKEPOINT_CONSENT_SPEC.md) ----
// The boundary for the credentialed/unbounded ops lives HERE, not in the bypassable client-side approval.
// A privileged call passes iff: a trusted surface (sender.tab == null), a whitelisted domain, or a per-call
// grant the design-A loop minted after an iframe approval. Grants are scoped to the approved tool's
// delegation (minted in delegateTool, cleared when it returns), keyed by (tabId, resource).
type TabGrants = { sheets: Set<string>; pyCode: Set<string> };
const pendingGrants = new Map<number, TabGrants>();
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

/** Is the optional `debugger` permission held? CHECK ONLY — never request here. `permissions.request`
 *  requires a user GESTURE in a FOREGROUND context, which the service worker doesn't have, so the actual
 *  grant rides a user gesture in a real surface (the "Approve" click in the sidebar/DevTools extension page,
 *  or the popup/Settings "Enable reserved-element clicking" button — the same pattern as the Google-Sheets
 *  host grant, which this SW likewise only `contains()`-checks). Missing → cdpClick returns an actionable
 *  error steering the user to grant it. */
async function hasDebuggerPermission(): Promise<boolean> {
    try { return await chrome.permissions.contains({ permissions: ["debugger"] }); } catch { return false; }
}

/** Click at a VIEWPORT coordinate via CDP — the ONLY way to reach a "reserved" surface (a cross-origin
 *  iframe, or a declarative/native closed shadow root): the BROWSER hit-tests the point, so the click
 *  retargets INTO the frame / closed tree and is a TRUSTED, user-activated event (a synthetic dispatch is
 *  neither — it fires on the named element and can't cross those boundaries). Attaches the debugger (its
 *  unsuppressible banner is the honest "input-level control" signal — and it's shown ONLY for these reserved
 *  clicks, so the flash marks the risk), sends press+release, and ALWAYS detaches. See docs/spec/CDP_CLICK.md. */
async function cdpClick(tabId: number, x: number, y: number): Promise<{ ok: true } | { error: string; needsPermission?: true }> {
    if (!(await hasDebuggerPermission())) return { error: "The `debugger` permission is required to click a reserved (cross-origin / sealed) element — grant it in the window.ml popup or settings, then retry.", needsPermission: true };
    const target: chrome.debugger.Debuggee = { tabId };
    try {
        await chrome.debugger.attach(target, "1.3");
    } catch (e) {
        return { error: `Couldn't attach the debugger to click a reserved element (${(e as Error)?.message || e}). Another debugger (DevTools?) may be attached to this tab.` };
    }
    const send = (type: string, buttons: number) =>
        chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: 1 });
    try {
        await send("mousePressed", 1);
        await send("mouseReleased", 0);
        return { ok: true };
    } catch (e) {
        return { error: `The CDP click failed (${(e as Error)?.message || e}).` };
    } finally {
        try { await chrome.debugger.detach(target); } catch { /* already detached / tab gone */ }
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
    if (message.type === "ML_DEBUG_RESET") { if (sender.tab?.id != null) resetDebug(sender.tab.id); return; }
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
        try { void chrome.tabs.sendMessage(message.tabId, { type: "ML_SESSION_TO_PAGE", action: message.action, hash: message.hash, text: message.text }).catch(() => {}); } catch { /* tab gone */ }
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
        const resolve = pendingApprovals.get(`${p.runId}:${p.seq}`);
        if (resolve) {
            pendingApprovals.delete(`${p.runId}:${p.seq}`);
            resolve(p.decision ? { approved: true } : { approved: false, feedback: p.feedback });
        }
        return;   // fire-and-forget
    }
    if (message.type === "CANCEL_RUN") {
        // The HUD's "Cancel agent run" (relayed by the trusted content-script shell). Abort the run's
        // controller → the loop stops at the next boundary and resolves { cancelled: true }; the model
        // call in flight is aborted too. A page can't forge this (no chrome.runtime path), and even a
        // forged cancel only aborts that page's own run — harmless.
        const ctl = runControllers.get((message.payload as CancelRunPayload)?.runId);
        if (ctl) ctl.abort();
        return;   // fire-and-forget
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
            if (!cfg.cdpClick) { sendResponse({ error: "Reserved-element clicking is off — enable it in window.ml Settings → Advanced." }); return; }
            if (await senderTrust(sender) === "untrusted") { sendResponse({ error: "Refused: a reserved-element (CDP) click can't be initiated by this page." }); return; }
            const p = (message.payload || {}) as { x?: number; y?: number; tabId?: number };
            const tabId = sender.tab?.id ?? p.tabId;   // a page → its own tab; a trusted surface → the payload's
            if (typeof tabId !== "number" || typeof p.x !== "number" || typeof p.y !== "number") { sendResponse({ error: "CDP_CLICK needs a tab and numeric x/y." }); return; }
            sendResponse(await cdpClick(tabId, p.x, p.y));
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
        if (injected) inbox!.queue.push(p.text);
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
        if (message.type === "RESUME_RUN") {
            const rp = message.payload as ResumeRunPayload;
            const stored = bgRuns.get(rp.runId);
            if (!stored) { sendResponse({ error: `No resumable run "${rp.runId}" in the background — it may have been evicted; start a new run.` }); return true; }
            if (stored.tabId !== tabId) { sendResponse({ error: `Run "${rp.runId}" belongs to another tab.` }); return true; }
            p = { ...stored.p, task: rp.task };
            resumeMessages = stored.messages;
        } else {
            p = message.payload as StartRunPayload;
            // A createAgent handle sends its prior history (control.messages) so the background CONTINUES
            // it — the page stays authoritative across turns, and the updated history rides back below.
            resumeMessages = p.resumeMessages;
        }
        const runId = p.runId;
        const stepBase = p.stepBase || 0, seqBase = p.seqBase || 0;   // offsets for a handle's continued turns
        let runMaxStep = 0, runMaxSeq = 0;   // this run's max step/seq (raw) → returned so the page advances its bases
        const abortCtl = new AbortController();   // CANCEL_RUN aborts this → the loop resolves { cancelled }
        runControllers.set(runId, abortCtl);
        runInboxes.set(runId, { tabId, queue: [] });   // a.say() steering lands here while the run is live
        const toolMetas: ToolMeta[] = p.tools.map(t => ({ name: t.name, requiresApproval: t.requiresApproval, capabilities: t.capabilities }));
        const toolDefs = p.tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
        const approvedSheets = new Set<string>();   // external sheets approved this run (isSheetApproved)
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
            };
            // Always fan to the PAGE (overlay / off card). For devtools ALSO fan to the panel — and the
            // page fan lets the optional corner card coexist with the panel (agentHudInDevtools); the
            // shell drops the page copy when no card is mounted, and never loops it back to the panel.
            chrome.tabs.sendMessage(tabId, { type: "ML_DEBUG_TO_PAGE", event }).catch(() => { /* tab gone / no receiver */ });
            if (p.surface === "devtools") relayDebugEvent(tabId, event);
        };
        // OFF mode: the corner card is fed ENTIRELY by this background stream, because the page's own
        // debug bus (bus.ts) stays dormant in off mode — no `present` handshake, so its emitDebug is a
        // no-op and off mode keeps its zero-cost footprint until a privileged run actually starts. So for
        // OFF we emit the run's lifecycle (start + result) here too; overlay gets them from the page's bus
        // and devtools from the panel forward, so emitting them here as well would double up — off only.
        const emitLifecycle = (event: Record<string, unknown>): void => {
            if (p.surface !== "off") return;
            chrome.tabs.sendMessage(tabId, { type: "ML_DEBUG_TO_PAGE", event }).catch(() => {});
        };
        // Only a FRESH run announces the session start; a RESUME continues an existing sidebar/card
        // session (re-emitting `agent` would wipe its accumulated steps), so it streams new steps + a
        // fresh agent-result under the same hash instead.
        if (!resumeMessages) emitLifecycle({
            kind: "agent", id: runId, ts: Date.now(), save: false, session: { hash: runId, turn: 0 },
            task: p.task, model: p.model, maxSteps: p.maxSteps,
            config: {
                system: p.systemPrompt, customSystem: false,
                tools: p.tools.map(t => ({ name: t.name, requiresApproval: t.requiresApproval, vision: t.capabilities.includes("vision"), description: t.description, parameters: t.parameters, summary: t.summary })),
                maxSteps: p.maxSteps, think: p.think, env: true, vision: null, hints: null, unattended: p.unattended, silent: p.silent,
            },
        });
        runBackgroundAgent(
            { task: p.task, systemPrompt: p.systemPrompt, tools: toolMetas, model: p.model, think: p.think, maxSteps: p.maxSteps, autoApprovePython: p.autoApprovePython, unattended: p.unattended, resumeMessages },
            {
                callModel: async (messages) => {
                    // Thread the run's abort signal so a CANCEL_RUN kills a slow in-flight generation, not
                    // just stops at the next step boundary.
                    const r = await fetchLLM({ messages, tools: toolDefs, model: p.model, think: p.think, raw: true }, abortCtl.signal) as { content: string | null; tool_calls: ToolCall[]; reasoning: string | null; usage: TokenUsage | null };
                    return { content: r.content, tool_calls: r.tool_calls, reasoning: r.reasoning, usage: r.usage };
                },
                delegateTool: async (name, args) => {
                    // Reaching here means the call is AUTHORIZED (approved / auto / cached alike). Mint the
                    // choke-point grants for the privileged sub-ops this tool will make, bound to the exact
                    // resources in its args — an untrusted page's FETCH_SHEET / full PYTHON_EXEC checks them.
                    // Scoped to this delegation: cleared in `finally`, so a later call needs its own approval.
                    if (name === "python_exec") {
                        const g = grantsFor(tabId);
                        for (const id of externalSheetIds(args)) g.sheets.add(id);
                        if ((args as { mode?: string }).mode === "full") g.pyCode.add(String((args as { code?: unknown }).code ?? ""));
                    }
                    try {
                        const env = await chrome.tabs.sendMessage(tabId, { type: "RUN_TOOL_IN_PAGE", payload: { runId, name, args } })
                            .catch((e: unknown) => ({ result: `Error: could not reach the page to run "${name}" (${(e as Error)?.message || e}).` })) as Partial<import("./contract").PageToolEnvelope>;
                        // The page already computed the rendered In/Out slots (descriptorFor) — forward them so
                        // the sidebar shows the rich view. `image` rides along for INLINE VISION (native look):
                        // the loop injects it into the model's next turn (pushToolImages).
                        return { result: env?.result || `Error: the page returned nothing for tool "${name}".`, renderIn: env?.renderIn, renderOut: env?.renderOut, image: env?.image, imageLabel: env?.imageLabel };
                    } finally {
                        pendingGrants.delete(tabId);   // grants were for THIS approved call's sub-ops only
                    }
                },
                // Read-only try (exec only, and only when the user enabled autoApproveReadonly): ask the
                // page to run the call through the mediated interpreter — side-effect-free, so if it's
                // in-dialect it BOTH auto-approves AND returns the result, and the human gate is skipped.
                tryReadonly: p.autoApproveReadonly ? async (name, args) => {
                    if (name !== "exec") return null;
                    const env = await chrome.tabs.sendMessage(tabId, { type: "RUN_TOOL_IN_PAGE", payload: { runId, name, args, readonlyTry: true } })
                        .catch(() => null) as Partial<import("./contract").PageToolEnvelope> | null;
                    return env && env.readonly ? { result: env.result || "", renderIn: env.renderIn, renderOut: env.renderOut } : null;
                } : undefined,
                // Doomed-action precheck (click/type): ask the page to resolve the target side-effect-free.
                // A non-null error → the gate is SKIPPED and the error returned. Only delegated for tools
                // that HAVE a precheck (avoids a useless round-trip on every gated call).
                precheck: async (name, args) => {
                    if (!p.tools.some((t) => t.name === name && t.precheck)) return null;
                    const env = await chrome.tabs.sendMessage(tabId, { type: "RUN_TOOL_IN_PAGE", payload: { runId, name, args, precheck: true } })
                        .catch(() => null) as Partial<import("./contract").PageToolEnvelope> | null;
                    return env && env.precheckFailed ? (env.result || "") : null;
                },
                approve: async ({ tool, arguments: args, seq, step }) => {
                    // Ask the page to compute the In render for THIS call (without running the tool) so the
                    // blocking approval shows a pretty In — exec's beautified JS, python's code cell — not
                    // raw args. Best-effort: raw args on any failure. (Out has nothing to render pre-run.)
                    let renderIn: unknown;
                    try {
                        const env = await chrome.tabs.sendMessage(tabId, { type: "RUN_TOOL_IN_PAGE", payload: { runId, name: tool, args, renderOnly: true } }) as { renderIn?: unknown };
                        renderIn = env?.renderIn;
                    } catch { /* page gone → no preview, fall back to raw args */ }
                    // Key by the OFFSET seq — the same value the app sees on the emitted step (emitStep
                    // offsets raw→seqBase+raw) and echoes back in SET_APPROVAL. Keying by the raw seq meant a
                    // follow-up turn (seqBase>0) never matched → the gate hung forever ("stuck on Approve" on
                    // turn 2+). Turn 1 worked only because seqBase==0. (Mirror emitStep's null-guard exactly.)
                    const gateSeq = seq != null ? seqBase + seq : seq;
                    return new Promise<ApprovalDecision>((resolve) => {
                        pendingApprovals.set(`${runId}:${gateSeq}`, (decision) => {
                            const ok = decision === true || (typeof decision === "object" && !!decision && decision.approved);
                            if (ok && tool === "python_exec") for (const id of externalSheetIds(args)) approvedSheets.add(id);
                            resolve(decision);
                        });
                        // Patch the pending step to show approve/deny (awaitingApproval) + the In preview. ALL
                        // three surfaces render it identically from this one step: overlay/off in the page
                        // iframe (slide-out panel vs corner card), devtools in the panel. The off-mode card
                        // reveals ITSELF on this step — no separate modal message — and the decision returns via
                        // the same origin-authed SET_APPROVAL, so the gate is unforgeable across every surface.
                        emitStep({ step, seq, pending: true, awaitingApproval: true, tool, arguments: args, renderIn });
                    });
                },
                isSheetApproved: (id) => approvedSheets.has(id),
                emit: (ev) => emitStep(ev as Record<string, unknown>),
                drainInbox: () => (runInboxes.get(runId)?.queue || []).splice(0),   // a.say() steering (INJECT_MESSAGE)
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
                // may drop this — resume then reports an actionable error (see bgRuns).
                bgRuns.set(runId, { p, tabId, messages });
                emitLifecycle({
                    kind: "agent-result", id: runId, ts: Date.now(), save: false, session: { hash: runId, turn: res.steps },
                    summary: res.summary, steps: res.steps, hitCap: !!res.hitCap, cancelled: !!res.cancelled,
                });
                // Sync the run's final history back so a createAgent handle's control.messages stays live,
                // + this run's step/seq extents so the page advances its bases for the NEXT turn's offset.
                sendResponse({ data: res, messages, stepCount: runMaxStep, seqCount: runMaxSeq });
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
            .finally(() => { runControllers.delete(runId); runInboxes.delete(runId); });
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
    if (message.type === "FETCH_SHEET_TITLE") {
        // TITLE-ONLY, pre-approval: the approval card fetches just the sheet name so the USER sees WHICH
        // sheet they're granting (the MODEL never gets it). INTERNAL-ONLY — it's not in the content relay,
        // so only the extension-origin card iframe (sender.tab == null) may call it; refuse any page.
        if (sender.tab != null) { sendResponse({ data: null }); return true; }
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
                    model: config.model, ocrModel: config.ocrModel, apiFormat: config.apiFormat,
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
        const capture = sender.tab
            ? chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" })
            : chrome.tabs.captureVisibleTab({ format: "png" });
        capture
            .then(dataUrl => sendResponse({ data: dataUrl }))
            .catch(err => sendResponse({ error: err.message }));
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

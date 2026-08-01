// Background service worker: owns config, builds per-format request bodies,
// extracts replies, and makes the privileged (host-permissioned) fetches. All
// server JSON is genuinely opaque, so it's typed `any`; our own data uses the
// shared contract types.
import type { MlConfig, ApiFormat, NeutralMessage, ToolCall, FetchLlmPayload, LlmResult, LoadedModel, JsonSchema, TokenUsage, StartRunPayload, SetApprovalPayload, ApprovalDecision } from "./contract";
import { DEFAULT_CONFIG, modelFilterAllows } from "./contract";   // single source of truth (see contract.ts)
import { runBackgroundAgent } from "./agent-host";   // design A: the background-hosted agent loop
import type { ToolMeta } from "./agent-loop";
import { externalSheetIds } from "./dom";   // track approved external sheets across a run

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
        const res = await fetch(config.chatUrl, {
            method: "POST",
            headers,
            body: JSON.stringify({ ...requestBody, stream }),
            signal,   // ABORT_TASK → this fetch rejects with an AbortError (kills a slow generation)
        });
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

chrome.runtime.onMessage.addListener((message: any, sender, sendResponse) => {
    // The content-script shell forwards each __mlDebug event here so a DevTools panel
    // (which can't see page window-messages) can mirror the overlay's stream. Fire-and-
    // forget — no response. RESET clears a tab's buffer on navigation (fresh page).
    if (message.type === "ML_DEBUG_EVENT") { if (sender.tab?.id != null) relayDebugEvent(sender.tab.id, message.event); return; }
    if (message.type === "ML_DEBUG_RESET") { if (sender.tab?.id != null) resetDebug(sender.tab.id); return; }
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
    if (message.type === "START_RUN") {
        // Design A: run an ml.agent loop HERE (extension origin), delegating each tool back to the page
        // (RUN_TOOL_IN_PAGE) and gating approval through the sidebar. The page built the toolset + system
        // prompt (it has the DOM/config/factories) and registered the live tools under runId; we hold only
        // serializable descriptors. sender.tab.id is the delegation + debug-fanout target.
        const tabId = sender.tab?.id;
        if (tabId == null) { sendResponse({ error: "START_RUN must come from a tab (content script)." }); return true; }
        const p = message.payload as StartRunPayload;
        const runId = p.runId;
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
        const emitStep = (ev: Record<string, unknown>): void => {
            const event = {
                kind: "agent-step", id: runId, ts: Date.now(), save: false,
                session: { hash: runId, turn: (ev.step as number) || 0 }, ...ev,
            };
            if (p.surface === "devtools") relayDebugEvent(tabId, event);
            else chrome.tabs.sendMessage(tabId, { type: "ML_DEBUG_TO_PAGE", event }).catch(() => { /* tab gone / no receiver */ });
        };
        runBackgroundAgent(
            { task: p.task, systemPrompt: p.systemPrompt, tools: toolMetas, model: p.model, think: p.think, maxSteps: p.maxSteps, autoApprovePython: p.autoApprovePython },
            {
                callModel: async (messages) => {
                    const r = await fetchLLM({ messages, tools: toolDefs, model: p.model, think: p.think, raw: true }) as { content: string | null; tool_calls: ToolCall[]; usage: TokenUsage | null };
                    return { content: r.content, tool_calls: r.tool_calls, usage: r.usage };
                },
                delegateTool: async (name, args) => {
                    const env = await chrome.tabs.sendMessage(tabId, { type: "RUN_TOOL_IN_PAGE", payload: { runId, name, args } })
                        .catch((e: unknown) => ({ result: `Error: could not reach the page to run "${name}" (${(e as Error)?.message || e}).` })) as Partial<import("./contract").PageToolEnvelope>;
                    // The page already computed the rendered In/Out slots (descriptorFor) — forward them so
                    // the sidebar shows the rich view. `image` rides along for INLINE VISION (native look):
                    // the loop injects it into the model's next turn (pushToolImages).
                    return { result: env?.result || `Error: the page returned nothing for tool "${name}".`, renderIn: env?.renderIn, renderOut: env?.renderOut, image: env?.image, imageLabel: env?.imageLabel };
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
                approve: async ({ tool, arguments: args, seq, step }) => {
                    // Ask the page to compute the In render for THIS call (without running the tool) so the
                    // blocking approval shows a pretty In — exec's beautified JS, python's code cell — not
                    // raw args. Best-effort: raw args on any failure. (Out has nothing to render pre-run.)
                    let renderIn: unknown;
                    try {
                        const env = await chrome.tabs.sendMessage(tabId, { type: "RUN_TOOL_IN_PAGE", payload: { runId, name: tool, args, renderOnly: true } }) as { renderIn?: unknown };
                        renderIn = env?.renderIn;
                    } catch { /* page gone → no preview, fall back to raw args */ }
                    return new Promise<ApprovalDecision>((resolve) => {
                        pendingApprovals.set(`${runId}:${seq}`, (decision) => {
                            const ok = decision === true || (typeof decision === "object" && !!decision && decision.approved);
                            if (ok && tool === "python_exec") for (const id of externalSheetIds(args)) approvedSheets.add(id);
                            resolve(decision);
                        });
                        // Patch the pending step to show approve/deny (awaitingApproval) + the In preview.
                        emitStep({ step, seq, pending: true, awaitingApproval: true, tool, arguments: args, renderIn });
                    });
                },
                isSheetApproved: (id) => approvedSheets.has(id),
                emit: (ev) => emitStep(ev as Record<string, unknown>),
                signal: null,
            },
        )
            .then((res) => sendResponse({ data: res }))
            .catch((err) => sendResponse({ error: err?.message || String(err) }));
        return true;   // async: sendResponse fires when the whole run finishes
    }
    if (message.type === "PYTHON_EXEC") {
        // Route the sandboxed-Python run to the offscreen Pyodide host (the service worker
        // can't run WASM). Spin the offscreen doc up on first use, then relay PY_RUN to it.
        const payload = { type: "PY_RUN", code: message.payload?.code, image: message.payload?.image ?? null, hardened: message.payload?.hardened !== false, tables: message.payload?.tables ?? null };
        const attempt = () => ensureOffscreen().then(() => chrome.runtime.sendMessage(payload));
        attempt()
            .catch((err) => {
                // The offscreen doc can be gone (SW slept and the doc was torn down, or a
                // stale cached-ready) → "Receiving end does not exist." Drop the cache,
                // recreate the doc, and retry ONCE before surfacing the error.
                if (!/Receiving end does not exist|Could not establish connection/.test(String(err?.message || err))) throw err;
                offscreenReady = null;
                return attempt();
            })
            .then((res) => sendResponse({ data: res }))
            .catch((err) => sendResponse({ error: err?.message || String(err) }));
        return true;   // async
    }
    if (message.type === "FETCH_SHEET") {
        // Fetch a Google Sheet's CSV export CREDENTIALED (the user's own Google session), so
        // it works on private corporate sheets — the DOM path is useless (Sheets is canvas).
        fetchSheetCsv(message.payload?.url)
            .then((csv) => sendResponse({ data: csv }))
            .catch((err) => sendResponse({ error: err?.message || String(err) }));
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

    } else if (message.type === "GET_CONFIG") {
        // Non-secret config the page may read (model/OCR model/format). The URL
        // and API key are deliberately withheld — see the security invariants.
        getConfig()
            .then(config => sendResponse({ data: {
                model: config.model, ocrModel: config.ocrModel, apiFormat: config.apiFormat,
                utilityModel: config.utilityModel, utilityNumCtx: config.utilityNumCtx, utilityForceCpu: config.utilityForceCpu,
                autoApproveReadonly: config.autoApproveReadonly, autoApprovePython: config.autoApprovePython,
                groundingEnabled: config.groundingEnabled, groundingModel: config.groundingModel,
                groundingRange: config.groundingRange, debugMode: config.debugMode,
            } }))
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

async function fetchSheetCsv(url: string): Promise<string> {
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
    return body;
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

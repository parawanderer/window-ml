// Background service worker: owns config, builds per-format request bodies,
// extracts replies, and makes the privileged (host-permissioned) fetches. All
// server JSON is genuinely opaque, so it's typed `any`; our own data uses the
// shared contract types.
import type { MlConfig, ApiFormat, NeutralMessage, ToolCall, FetchLlmPayload, LlmResult, LoadedModel, JsonSchema } from "./contract";
import { DEFAULT_CONFIG } from "./contract";   // single source of truth (see contract.ts)

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
    streamChunk(line: string): { delta: string; reasoning?: string; toolCall: boolean; sources?: unknown[] | null } | null;
}

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
            return { delta: obj.message?.content || "", reasoning: obj.message?.thinking || "", toolCall: !!obj.message?.tool_calls };
        },
    },
};

function getConfig(): Promise<MlConfig> {
    return chrome.storage.sync.get(DEFAULT_CONFIG) as Promise<MlConfig>;
}

// model -> capabilities array | null, per service-worker lifetime
const capabilitiesCache = new Map<string, string[] | null>();

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
async function prepareRequest(payload: FetchLlmPayload) {
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
    const numCtx = payload.numCtx ?? (useUtility ? config.utilityNumCtx : undefined);
    const numGpu = payload.numGpu ?? (useUtility && config.utilityForceCpu ? 0 : undefined);
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

async function fetchLLM(payload: FetchLlmPayload): Promise<LlmResult | { content: string | null; tool_calls: ToolCall[] }> {
    const { config, format, body, send, model } = await prepareRequest(payload);

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
    if (payload.raw) {
        return {
            content: format.extractContent(data) ?? null,
            tool_calls: format.extractToolCalls(data),
        };
    }

    const content = format.extractContent(data);

    if (content == null) {
        throw new Error(
            `Response did not match the "${config.apiFormat}" format ` +
            `(expected ${format.expectedShape}). ` +
            `Top-level keys were: ${Object.keys(data).join(", ")} — ` +
            `check the API format setting in the extension popup.`
        );
    }

    // sources: server-side tool / RAG provenance (OpenWebUI attaches it top-level
    // when a tool runs). Absent on plain chats and the Ollama-native format.
    return { content, sources: Array.isArray(data.sources) ? data.sources : [], model, reasoning: format.extractReasoning(data) || null };
}

// Streaming variant of fetchLLM: reads the SSE/NDJSON response and calls
// onDelta(text) for each content chunk, returning the full concatenated text.
// Text-only — no schema/raw/tools; toolIds is supported (streams each
// server-side mode; a handed-back attempt streams no content, so nothing is
// emitted to the caller before we retry the next mode).
async function streamLLM(payload: FetchLlmPayload, onDelta: (delta: string) => void): Promise<{ content: string; sources: unknown[]; model: string; reasoning: string | null }> {
    const { format, body, send, model } = await prepareRequest(payload);

    const consume = async (res: Response) => {
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "", content = "", reasoning = "", sawToolCall = false;
        let sources: unknown[] = [];
        const handleLine = (line: string) => {
            const chunk = format.streamChunk(line);
            if (!chunk) return;
            if (chunk.delta) { content += chunk.delta; onDelta(chunk.delta); }
            if (chunk.reasoning) reasoning += chunk.reasoning;   // separate thinking stream (not emitted to the caller)
            if (chunk.toolCall) sawToolCall = true;
            // sources arrive on their own SSE line (no choices) — capture them.
            if (Array.isArray(chunk.sources)) sources = chunk.sources;
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
        return { content, sawToolCall, sources, reasoning: reasoning || null };
    };

    if (payload.toolIds?.length) {
        for (const mode of SERVER_TOOL_MODES) {
            body.params = { ...body.params, function_calling: mode };
            const { content, sawToolCall, sources, reasoning } = await consume(await send(body, true));
            if (content.trim() || !sawToolCall) return { content, sources, model, reasoning };   // real answer, or a plain empty completion
        }
        throw new Error(HANDBACK_ERROR);
    }

    const { content, sources, reasoning } = await consume(await send(body, true));
    return { content, sources, model, reasoning };
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

chrome.runtime.onMessage.addListener((message: any, sender, sendResponse) => {
    if (message.type === "FETCH_LLM") {
        fetchLLM(message.payload)
            // raw (ml.step) returns { content, tool_calls } as data; normal chat
            // returns the content string, with sources alongside only when present.
            .then((result: any) => {
                if (message.payload.raw) return sendResponse({ data: result });
                const resp: any = { data: result.content, model: result.model ?? null };
                if (result.sources && result.sources.length) resp.sources = result.sources;
                if (result.reasoning) resp.reasoning = result.reasoning;
                sendResponse(resp);
            })
            .catch(err => sendResponse({ error: err.message }));
        return true; // Keep channel open for async fetch

    } else if (message.type === "LIST_MODELS") {
        // Config overrides are only honored from the extension's own pages
        // (popup); pages relaying through the content script (sender.tab set)
        // must not be able to point the saved API key at another host.
        listAvailableModels(sender.tab ? {} : (message.payload || {}))
            .then(({ ids, ollamaModels }) => sendResponse({ data: ids, ollamaModels }))
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
                autoApproveReadonly: config.autoApproveReadonly,
                groundingEnabled: config.groundingEnabled, groundingModel: config.groundingModel,
                groundingRange: config.groundingRange,
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
    port.onMessage.addListener((message: any) => {
        streamLLM(message.payload, (delta) => port.postMessage({ type: "chunk", delta }))
            .then(({ content, sources, model, reasoning }) => port.postMessage({ type: "done", content, sources, model, reasoning }))
            .catch((err) => port.postMessage({ type: "error", error: err.message }));
    });
});

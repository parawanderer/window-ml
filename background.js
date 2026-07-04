const DEFAULT_CONFIG = {
    // OpenWebUI's OpenAI-compatible chat completions endpoint. There is no
    // root-level /v1 alias (tested on 0.9.5 and 0.10.2); external API clients
    // use /api/chat/completions, which is broken on 0.9.5 (issue #24550,
    // fixed by 0.10.x) — the /ollama/api/chat passthrough works around that.
    chatUrl: "http://localhost:3000/api/chat/completions",
    // Bearer token, generated in OpenWebUI under Settings -> Account.
    apiKey: "",
    // Model id as listed by GET /v1/models.
    model: "",
    // Request body + response shape, see API_FORMATS.
    apiFormat: "openai",
    // Vision model ml.read() uses for OCR, independent of `model` so a text-only
    // reasoning model can stay the default. Empty = fall back to `model`.
    ocrModel: ""
};

// OpenAI serves tool-call arguments as a JSON string; Ollama as an object.
// Normalize to a parsed object, falling back to the raw value on bad JSON.
function parseToolArgs(args) {
    if (args == null) return {};
    if (typeof args === "object") return args;
    try { return JSON.parse(args); } catch { return args; }
}

// Messages arrive in a neutral shape: { role, content, images?, tool_calls?,
// tool_call_id? } with images as full data URLs; each format converts them to
// its wire representation. tool_calls are normalized as { id, name, arguments }.
const API_FORMATS = {
    // chat/completions (OpenWebUI /api, or any OpenAI-compatible server)
    openai: {
        buildMessage({ role, content, images = [], tool_calls, tool_call_id }) {
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
                                ? tc.arguments : JSON.stringify(tc.arguments ?? {})
                        }
                    }))
                };
            }
            if (!images.length) return { role, content };
            return {
                role,
                content: [
                    { type: "text", text: content },
                    ...images.map(u => ({ type: "image_url", image_url: { url: u } }))
                ]
            };
        },
        extractContent: (data) => data.choices?.[0]?.message?.content,
        extractToolCalls: (data) => (data.choices?.[0]?.message?.tool_calls || []).map(tc => ({
            id: tc.id,
            name: tc.function?.name,
            arguments: parseToolArgs(tc.function?.arguments)
        })),
        expectedShape: "choices[0].message.content",
        // OpenAI structured outputs: response_format with a JSON schema.
        applyFormat(body, schema) {
            body.response_format = {
                type: "json_schema",
                json_schema: { name: "response", strict: true, schema }
            };
        }
    },
    // Ollama native /api/chat (e.g. OpenWebUI's /ollama/api/chat passthrough)
    ollama: {
        buildMessage({ role, content, images = [], tool_calls }) {
            // Ollama tool results carry no tool_call_id (matched by order).
            if (role === "tool") return { role: "tool", content };
            if (tool_calls) {
                return {
                    role,
                    content: content ?? "",
                    tool_calls: tool_calls.map(tc => ({
                        function: { name: tc.name, arguments: parseToolArgs(tc.arguments) }
                    }))
                };
            }
            const message = { role, content };
            if (images.length) message.images = images.map(u => u.split(",")[1]);
            return message;
        },
        extractContent: (data) => data.message?.content,
        extractToolCalls: (data) => (data.message?.tool_calls || []).map((tc, i) => ({
            id: `call_${i}`,
            name: tc.function?.name,
            arguments: tc.function?.arguments
        })),
        expectedShape: "message.content",
        // Ollama takes a JSON schema (or the string "json") directly as `format`.
        applyFormat(body, schema) {
            body.format = schema;
        }
    }
};

function getConfig() {
    return chrome.storage.sync.get(DEFAULT_CONFIG);
}

// model -> true/false/null, per service-worker lifetime
const visionSupportCache = new Map();

// Asks Ollama's /api/show (directly or via the OpenWebUI passthrough) whether
// the model has the "vision" capability. Returns true/false, or null when
// capabilities can't be determined (non-Ollama backend, old Ollama, etc.).
async function modelSupportsVision(config, model) {
    const cacheKey = `${config.chatUrl}|${model}`;
    if (visionSupportCache.has(cacheKey)) return visionSupportCache.get(cacheKey);

    const origin = new URL(config.chatUrl).origin;
    const headers = { "Content-Type": "application/json" };
    if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;

    let result = null;
    for (const path of ["/ollama/api/show", "/api/show"]) {
        try {
            const res = await fetch(origin + path, {
                method: "POST",
                headers,
                body: JSON.stringify({ model })
            });
            if (!res.ok) continue;
            const data = await res.json();
            if (Array.isArray(data.capabilities)) {
                result = data.capabilities.includes("vision");
                break;
            }
        } catch {
            // unreachable or non-JSON — try the next candidate
        }
    }

    visionSupportCache.set(cacheKey, result);
    return result;
}

async function fetchLLM(payload) {
    const config = await getConfig();

    const headers = { "Content-Type": "application/json" };
    if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;

    // ml.read() sets ocr:true so OCR resolves to the dedicated ocrModel first,
    // keeping the reasoning model (config.model) free of image tokens.
    const model = payload.model || (payload.ocr && config.ocrModel) || config.model;
    if (!model) {
        throw new Error(
            payload.ocr
                ? "No OCR model configured. Set an OCR model (a vision model like " +
                  "qwen2.5vl) in the extension popup."
                : "No model configured. Open the extension popup and use Load to pick one."
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

    const body = {
        model: model,
        messages: messages.map(m => format.buildMessage(m)),
        stream: false
    };
    // Ollama's native thinking toggle, forwarded by OpenWebUI. Only sent when
    // explicitly boolean — models without thinking support reject the param.
    if (typeof payload.think === "boolean") body.think = payload.think;

    // Structured output: constrain the reply to a JSON schema. The wire shape
    // differs per backend; the caller parses the returned JSON string.
    if (payload.schema) format.applyFormat(body, payload.schema);

    // Client-side tool definitions (ml.step): passed through to the model, which
    // may reply with tool_calls. Same schema shape for both backends.
    if (payload.tools?.length) body.tools = payload.tools;
    // Server-side tools run by OpenWebUI (ml.chat { toolIds }).
    if (payload.toolIds?.length) body.tool_ids = payload.toolIds;

    const res = await fetch(config.chatUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body)
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

    const data = await res.json();

    // Raw mode (ml.step): hand back content + normalized tool_calls so the
    // caller drives the loop. content may be null when the model chose a tool.
    if (payload.raw) {
        return {
            content: format.extractContent(data) ?? null,
            tool_calls: format.extractToolCalls(data)
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

    return content;
}

function authHeaders(config) {
    const headers = { "Content-Type": "application/json" };
    if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;
    return headers;
}

// Fetches available model ids. The list route differs by backend — OpenWebUI
// serves /api/models, other OpenAI-compatible servers /v1/models, direct
// Ollama /api/tags — and unknown GET routes on OpenWebUI return the frontend
// HTML, so a non-JSON body just means "wrong path, try the next one".
async function listAvailableModels(overrides = {}) {
    const config = { ...(await getConfig()), ...overrides };
    const origin = new URL(config.chatUrl).origin;
    const errors = [];

    for (const path of ["/api/models", "/v1/models", "/api/tags"]) {
        let list;
        try {
            const res = await fetch(origin + path, { headers: authHeaders(config) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            let data;
            try {
                data = await res.json();
            } catch {
                throw new Error("returned HTML, not JSON (route not found)");
            }

            list = data.data || data.models;
            if (!Array.isArray(list)) throw new Error("no model list in response");
        } catch (err) {
            errors.push(`${path}: ${err.message}`);
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
        return list.map(m => m.id || m.name).filter(Boolean);
    }
    throw new Error(errors.join("; "));
}

// Persistently switches the default model, validating against the server's
// model list so page scripts can't write junk into the saved config.
async function setModel(model) {
    if (!model || typeof model !== "string") {
        throw new Error("setModel expects a model id string.");
    }
    const models = await listAvailableModels();
    if (!models.includes(model)) {
        throw new Error(`Unknown model "${model}". Available: ${models.join(", ")}`);
    }
    await chrome.storage.sync.set({ model: model });
    return model;
}

// Locates the Ollama API root behind the configured chat URL — either the
// OpenWebUI /ollama passthrough or a direct Ollama server — and returns it
// along with the currently loaded models. /api/ps only exists on Ollama, so
// it doubles as the discriminator.
async function findOllamaBase(config) {
    const origin = new URL(config.chatUrl).origin;
    for (const base of [`${origin}/ollama`, origin]) {
        try {
            const res = await fetch(`${base}/api/ps`, { headers: authHeaders(config) });
            if (!res.ok) continue;
            const data = await res.json();
            if (Array.isArray(data.models)) return { base, loaded: data.models };
        } catch {
            // unreachable or non-JSON — try the next candidate
        }
    }
    throw new Error(`Could not reach an Ollama API behind ${origin}.`);
}

async function listLoadedModels() {
    const config = await getConfig();
    const { loaded } = await findOllamaBase(config);
    return loaded.map(m => ({
        model: m.model || m.name,
        vramGB: m.size_vram ? +(m.size_vram / 1e9).toFixed(1) : null,
        expiresAt: m.expires_at || null
    }));
}

// A generate request with keep_alive: 0 tells Ollama to evict the model
// from VRAM immediately. No model argument = unload everything loaded.
async function unloadModels(modelName) {
    const config = await getConfig();
    const { base, loaded } = await findOllamaBase(config);

    const targets = modelName
        ? [modelName]
        : loaded.map(m => m.model || m.name);

    for (const model of targets) {
        const res = await fetch(`${base}/api/generate`, {
            method: "POST",
            headers: authHeaders(config),
            body: JSON.stringify({ model: model, keep_alive: 0 })
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`Failed to unload ${model}: HTTP ${res.status} ${text.slice(0, 200)}`);
        }
    }

    return targets;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "FETCH_LLM") {
        fetchLLM(message.payload)
            .then(content => sendResponse({ data: content }))
            .catch(err => sendResponse({ error: err.message }));
        return true; // Keep channel open for async fetch

    } else if (message.type === "LIST_MODELS") {
        // Config overrides are only honored from the extension's own pages
        // (popup); pages relaying through the content script (sender.tab set)
        // must not be able to point the saved API key at another host.
        listAvailableModels(sender.tab ? {} : (message.payload || {}))
            .then(models => sendResponse({ data: models }))
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
    }
});

// Content script (isolated world): injects injected.js into the page's main world
// and relays messages between it and the background worker (window.postMessage ⇄
// chrome.runtime), bridging CORS. Streaming rides a long-lived Port instead.
import type { PageRequestType, BackgroundMessageType } from "./contract";

// 1. Inject injected.js into the main world.
const s = document.createElement("script");
s.src = chrome.runtime.getURL("injected.js");
s.onload = () => s.remove();
(document.head || document.documentElement).appendChild(s);

interface RelayEntry { type: BackgroundMessageType; responseType: string; }

// Page request type → background message type + the response type to post back.
const HANDLE_MAP: Partial<Record<PageRequestType, RelayEntry>> = {
    LLM_REQUEST: { type: "FETCH_LLM", responseType: "LLM_RESPONSE" },
    B64_REQUEST: { type: "FETCH_IMAGE_B64", responseType: "B64_RESPONSE" },
    LIST_MODELS_REQUEST: { type: "LIST_MODELS", responseType: "LIST_MODELS_RESPONSE" },
    GET_MODEL_REQUEST: { type: "GET_MODEL", responseType: "GET_MODEL_RESPONSE" },
    SET_MODEL_REQUEST: { type: "SET_MODEL", responseType: "SET_MODEL_RESPONSE" },
    CAPS_REQUEST: { type: "MODEL_CAPS", responseType: "CAPS_RESPONSE" },
    CONFIG_REQUEST: { type: "GET_CONFIG", responseType: "CONFIG_RESPONSE" },
    PS_REQUEST: { type: "OLLAMA_PS", responseType: "PS_RESPONSE" },
    UNLOAD_REQUEST: { type: "OLLAMA_UNLOAD", responseType: "UNLOAD_RESPONSE" },
    CAPTURE_TAB_REQUEST: { type: "CAPTURE_TAB", responseType: "CAPTURE_TAB_RESPONSE" },
    SAVE_SESSION_REQUEST: { type: "SAVE_SESSION", responseType: "SAVE_SESSION_RESPONSE" },
    GET_SESSION_REQUEST: { type: "GET_SESSION", responseType: "GET_SESSION_RESPONSE" },
    PYTHON_EXEC_REQUEST: { type: "PYTHON_EXEC", responseType: "PYTHON_EXEC_RESPONSE" },
    FETCH_SHEET_REQUEST: { type: "FETCH_SHEET", responseType: "FETCH_SHEET_RESPONSE" },
};

interface BgResponse { data?: unknown; sources?: unknown; model?: unknown; reasoning?: unknown; usage?: unknown; error?: string; }

const sendRuntimeMessage = (type: BackgroundMessageType, requestId: string, payload: unknown, responseType: string): void => {
    // requestId travels to the background too, so it can key an AbortController for the task
    // (see ABORT_REQUEST below → ABORT_TASK). Only FETCH_LLM currently registers one.
    chrome.runtime.sendMessage({ type, payload, requestId }, (response: BgResponse | undefined) => {
        // Send the response back to the main world.
        window.postMessage({
            type: responseType,
            requestId,
            result: response && response.data,
            sources: response && response.sources,
            model: response && response.model,   // resolved model, for the debug sidebar's provenance
            reasoning: response && response.reasoning,   // separate thinking text, for the sidebar
            usage: response && response.usage,   // token counts, for the sidebar's context gauge
            error: response && response.error,
        }, "*");
    });
};

interface StreamMsg { type: "chunk" | "done" | "error"; delta?: string; content?: string; sources?: unknown; model?: string; reasoning?: string; usage?: unknown; error?: string; }

// Live streaming Ports, keyed by requestId, so an ABORT_REQUEST from the page can disconnect the
// matching one — disconnecting the Port is what tells the background to abort the streaming fetch.
const streamPorts = new Map<string, chrome.runtime.Port>();

// Streaming can't use the one-shot sendMessage (it answers once), so it rides a
// long-lived Port: forward the payload, relay each { chunk | done | error } back.
const startStream = (requestId: string, payload: unknown): void => {
    const port = chrome.runtime.connect({ name: "LLM_STREAM" });
    streamPorts.set(requestId, port);
    const end = () => { streamPorts.delete(requestId); port.disconnect(); };
    port.onMessage.addListener((msg: StreamMsg) => {
        if (msg.type === "chunk") {
            window.postMessage({ type: "LLM_STREAM_CHUNK", requestId, delta: msg.delta }, "*");
        } else if (msg.type === "done") {
            window.postMessage({ type: "LLM_STREAM_DONE", requestId, content: msg.content, sources: msg.sources, model: msg.model, reasoning: msg.reasoning, usage: msg.usage }, "*");
            end();
        } else if (msg.type === "error") {
            window.postMessage({ type: "LLM_STREAM_ERROR", requestId, error: msg.error }, "*");
            end();
        }
    });
    port.postMessage({ payload });
};

interface PageMessage { type?: string; requestId?: string; payload?: unknown; }

// Design A — background → page tool delegation (the REVERSE of the page→background relay below). The
// background-hosted agent loop runs a page-context tool by `chrome.tabs.sendMessage(tabId, ...)`, which
// lands here. We relay it to the main world as a PAGE_TOOL_RUN window message, await the matching
// PAGE_TOOL_RESULT (correlated by a locally-minted callId), and hand the envelope back via
// sendResponse. Returning true keeps the message channel open for that async reply.
chrome.runtime.onMessage.addListener((message: PageMessage, _sender, sendResponse) => {
    if (!message || message.type !== "RUN_TOOL_IN_PAGE") return undefined;
    const { runId, name, args } = (message.payload || {}) as { runId: string; name: string; args: unknown };
    const callId = Math.random().toString(36).slice(2);
    const onResult = (event: MessageEvent) => {
        if (event.source !== window || !event.data || event.data.type !== "PAGE_TOOL_RESULT" || event.data.callId !== callId) return;
        window.removeEventListener("message", onResult);
        sendResponse(event.data.envelope);
    };
    window.addEventListener("message", onResult);
    window.postMessage({ type: "PAGE_TOOL_RUN", callId, runId, name, args }, "*");
    return true;   // async sendResponse (the window round-trip completes later)
});

// 2. Listen for messages from injected.js (main world).
window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window || !event.data) return;
    const data = event.data as PageMessage;
    const requestId = data.requestId ?? "";

    if (data.type === "LLM_STREAM_REQUEST") {
        startStream(requestId, data.payload);
        return;
    }
    if (data.type === "ABORT_REQUEST") {
        // Cancel the in-flight task for this requestId. Streaming rides a Port → disconnecting it is
        // what aborts the fetch (the background listens on onDisconnect). Non-streaming has no port →
        // relay ABORT_TASK so the background aborts the FETCH_LLM controller. Fire-and-forget.
        const port = streamPorts.get(requestId);
        if (port) { streamPorts.delete(requestId); port.disconnect(); }
        else chrome.runtime.sendMessage({ type: "ABORT_TASK", payload: { requestId } });
        return;
    }
    // 3. Forward to the background worker (to bypass CORS).
    const entry = HANDLE_MAP[data.type as PageRequestType];
    if (!entry) return;
    sendRuntimeMessage(entry.type, requestId, data.payload, entry.responseType);
});

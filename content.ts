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
};

interface BgResponse { data?: unknown; sources?: unknown; model?: unknown; error?: string; }

const sendRuntimeMessage = (type: BackgroundMessageType, requestId: string, payload: unknown, responseType: string): void => {
    chrome.runtime.sendMessage({ type, payload }, (response: BgResponse | undefined) => {
        // Send the response back to the main world.
        window.postMessage({
            type: responseType,
            requestId,
            result: response && response.data,
            sources: response && response.sources,
            model: response && response.model,   // resolved model, for the debug sidebar's provenance
            error: response && response.error,
        }, "*");
    });
};

interface StreamMsg { type: "chunk" | "done" | "error"; delta?: string; content?: string; sources?: unknown; model?: string; error?: string; }

// Streaming can't use the one-shot sendMessage (it answers once), so it rides a
// long-lived Port: forward the payload, relay each { chunk | done | error } back.
const startStream = (requestId: string, payload: unknown): void => {
    const port = chrome.runtime.connect({ name: "LLM_STREAM" });
    port.onMessage.addListener((msg: StreamMsg) => {
        if (msg.type === "chunk") {
            window.postMessage({ type: "LLM_STREAM_CHUNK", requestId, delta: msg.delta }, "*");
        } else if (msg.type === "done") {
            window.postMessage({ type: "LLM_STREAM_DONE", requestId, content: msg.content, sources: msg.sources, model: msg.model }, "*");
            port.disconnect();
        } else if (msg.type === "error") {
            window.postMessage({ type: "LLM_STREAM_ERROR", requestId, error: msg.error }, "*");
            port.disconnect();
        }
    });
    port.postMessage({ payload });
};

interface PageMessage { type?: string; requestId?: string; payload?: unknown; }

// 2. Listen for messages from injected.js (main world).
window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window || !event.data) return;
    const data = event.data as PageMessage;
    const requestId = data.requestId ?? "";

    if (data.type === "LLM_STREAM_REQUEST") {
        startStream(requestId, data.payload);
        return;
    }
    // 3. Forward to the background worker (to bypass CORS).
    const entry = HANDLE_MAP[data.type as PageRequestType];
    if (!entry) return;
    sendRuntimeMessage(entry.type, requestId, data.payload, entry.responseType);
});

// 1. Inject the "injected.js" file into the Main World
const s = document.createElement('script');
s.src = chrome.runtime.getURL('injected.js');
s.onload = function() { this.remove(); };
(document.head || document.documentElement).appendChild(s);

const HANDLE_MAP = {
    "LLM_REQUEST": {
        type: "FETCH_LLM",
        responseType: "LLM_RESPONSE"
    },
    "B64_REQUEST": {
        type: "FETCH_IMAGE_B64",
        responseType: "B64_RESPONSE"
    },
    "LIST_MODELS_REQUEST": {
        type: "LIST_MODELS",
        responseType: "LIST_MODELS_RESPONSE"
    },
    "GET_MODEL_REQUEST": {
        type: "GET_MODEL",
        responseType: "GET_MODEL_RESPONSE"
    },
    "SET_MODEL_REQUEST": {
        type: "SET_MODEL",
        responseType: "SET_MODEL_RESPONSE"
    },
    "CAPS_REQUEST": {
        type: "MODEL_CAPS",
        responseType: "CAPS_RESPONSE"
    },
    "PS_REQUEST": {
        type: "OLLAMA_PS",
        responseType: "PS_RESPONSE"
    },
    "UNLOAD_REQUEST": {
        type: "OLLAMA_UNLOAD",
        responseType: "UNLOAD_RESPONSE"
    },
    "CAPTURE_TAB_REQUEST": {
        type: "CAPTURE_TAB",
        responseType: "CAPTURE_TAB_RESPONSE"
    }
};

const sendRuntimeMessage = (type, requestId, payload, responseType) => {
    chrome.runtime.sendMessage(
        { type: type, payload: payload },
        (response) => {
            // 4. Send response back to Main World
            window.postMessage({
                type: responseType,
                requestId: requestId,
                result: response && response.data,
                sources: response && response.sources,
                error: response && response.error
            }, "*");
        }
    );
};

// Streaming can't use the one-shot sendMessage/sendResponse (it answers once),
// so it rides a long-lived Port: open it, forward the payload, and relay each
// { chunk | done | error } from the background back to the Main World.
const startStream = (requestId, payload) => {
    const port = chrome.runtime.connect({ name: "LLM_STREAM" });
    port.onMessage.addListener((msg) => {
        if (msg.type === "chunk") {
            window.postMessage({ type: "LLM_STREAM_CHUNK", requestId, delta: msg.delta }, "*");
        } else if (msg.type === "done") {
            window.postMessage({ type: "LLM_STREAM_DONE", requestId, content: msg.content, sources: msg.sources }, "*");
            port.disconnect();
        } else if (msg.type === "error") {
            window.postMessage({ type: "LLM_STREAM_ERROR", requestId, error: msg.error }, "*");
            port.disconnect();
        }
    });
    port.postMessage({ payload });
};

// 2. Listen for messages from injected.js (Main World)
window.addEventListener("message", (event) => {
    // Only accept messages from our own window
    if (event.source !== window || !event.data) {
        return;
    }

    const { requestId, payload } = event.data;

    if (event.data.type === "LLM_STREAM_REQUEST") {
        startStream(requestId, payload);
        return;
    }

    // 3. Forward to Background Script (to bypass CORS)
    if (!HANDLE_MAP[event.data.type]) return;

    const { type, responseType } = HANDLE_MAP[event.data.type];
    sendRuntimeMessage(type, requestId, payload, responseType);
});
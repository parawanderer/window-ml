/**
 * Page↔background/shell transport for window.ml. Every window.ml method that
 * needs the service worker's privileges posts a message here and awaits the matching
 * response (correlated by a random requestId); streaming rides a Port instead.
 * Extracted from injected.ts — these close over only window/document globals.
 */

import type { FetchLlmPayload, TokenUsage } from "./contract";
import { SB_ROOT } from "./ids";

/**
 * Ask the debug sidebar shell to hide its overlay for a screenshot (so it
 * isn't captured into the agent's `look`), resolving once it has painted the
 * hidden state (the shell acks after two frames). No-op with no wait when the
 * sidebar isn't mounted. The caller restores it with `{ __mlSidebarShot: "show" }`.
 *
 * @returns {Promise<void>} Resolves once the sidebar has painted its hidden state (or immediately if unmounted).
 */
export const hideSidebarForShot = (): Promise<void> => new Promise(resolve => {
    const mounted = typeof document.getElementById === "function" && document.getElementById(SB_ROOT);
    if (!mounted) return resolve();   // sidebar off → nothing to hide, no wait
    let done = false;
    const finish = () => { if (done) return; done = true; window.removeEventListener("message", onAck); clearTimeout(timer); resolve(); };
    const onAck = (e: MessageEvent) => { if (e.data && e.data.__mlSidebarShot === "hidden") finish(); };
    window.addEventListener("message", onAck);
    const timer = setTimeout(finish, 200);   // safety net if the shell never acks
    window.postMessage({ __mlSidebarShot: "hide" }, "*");
});

/**
 * Make a background task promise that communicates with the content script via postMessage.
 * Posts a request and waits for the matching response, resolving with the result or rejecting with an error.
 *
 * @param {string} requestType The type of request to send.
 * @param {string} responseType The type of response to listen for.
 * @param {Object} payload The request payload.
 * @param {(result: any) => any} [callbackOnResponseSuccess] Optional callback to transform the result before resolving.
 * @returns {Promise<any>} The task result.
 */
export const makeBackgroundTaskPromise = <T = unknown>(
    requestType: string,
    responseType: string,
    payload: unknown,
    callbackOnResponseSuccess?: (result: unknown) => T
): Promise<T> => {
    return new Promise((resolve, reject) => {
        const requestId = Math.random().toString(36).substring(7);

        function handleResponse(event: MessageEvent) {
            if (event.data.type === responseType && event.data.requestId === requestId) {
                window.removeEventListener("message", handleResponse);
                if (event.data.error) {
                    reject(event.data.error);
                } else {
                    let result = event.data.result;
                    if (callbackOnResponseSuccess) result = callbackOnResponseSuccess(result);
                    resolve(result);
                }
            }
        }

        window.addEventListener("message", handleResponse);

        window.postMessage({
            type: requestType,
            requestId: requestId,
            payload: payload
        }, "*");
    });
};

/**
 * Make a chat request that resolves { content, sources }.
 * The content string plus any server-side tool / RAG provenance the backend attached (empty otherwise).
 *
 * @param {FetchLlmPayload} payload The chat request payload.
 * @returns {Promise<{content: string, sources: Array}>} The chat response.
 */
export const makeChatRequest = (payload: FetchLlmPayload): Promise<{ content: string; sources: unknown[]; model: string | null; reasoning: string | null; usage: TokenUsage | null }> => {
    return new Promise((resolve, reject) => {
        const requestId = Math.random().toString(36).substring(7);
        function handle(event: MessageEvent) {
            const d = event.data;
            if (!d || d.type !== "LLM_RESPONSE" || d.requestId !== requestId) return;
            window.removeEventListener("message", handle);
            if (d.error) reject(d.error);
            else resolve({ content: d.result, sources: d.sources || [], model: d.model ?? null, reasoning: d.reasoning ?? null, usage: d.usage ?? null });
        }
        window.addEventListener("message", handle);
        window.postMessage({ type: "LLM_REQUEST", requestId, payload }, "*");
    });
};

/**
 * Make a streaming chat request that fires onToken(delta, full) for each streamed chunk
 * and resolves { content, sources } once done. Rides a Port on the
 * content-script side (many messages), vs the one-shot request/response above.
 *
 * @param {FetchLlmPayload} payload The chat request payload.
 * @param {(delta: string, full: string) => void} onToken Callback fired for each streamed token.
 * @returns {Promise<{content: string, sources: Array}>} The chat response.
 */
export const makeStreamingTaskPromise = (
    payload: FetchLlmPayload,
    onToken: (delta: string, full: string) => void
): Promise<{ content: string; sources: unknown[]; model: string | null; reasoning: string | null; usage: TokenUsage | null }> => {
    return new Promise((resolve, reject) => {
        const requestId = Math.random().toString(36).substring(7);
        let full = "";

        function handle(event: MessageEvent) {
            const d = event.data;
            if (!d || d.requestId !== requestId) return;
            if (d.type === "LLM_STREAM_CHUNK") {
                const delta = d.delta || "";
                full += delta;
                // A throwing caller callback shouldn't break the stream.
                try { onToken(delta, full); } catch (e) { console.error("ml onToken threw:", e); }
            } else if (d.type === "LLM_STREAM_DONE") {
                window.removeEventListener("message", handle);
                resolve({ content: d.content != null ? d.content : full, sources: d.sources || [], model: d.model ?? null, reasoning: d.reasoning ?? null, usage: d.usage ?? null });
            } else if (d.type === "LLM_STREAM_ERROR") {
                window.removeEventListener("message", handle);
                reject(d.error);
            }
        }

        window.addEventListener("message", handle);
        window.postMessage({ type: "LLM_STREAM_REQUEST", requestId, payload }, "*");
    });
};

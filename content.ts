// Content script (isolated world): injects injected.js into the page's main world
// and relays messages between it and the background worker (window.postMessage ⇄
// chrome.runtime), bridging CORS. Streaming rides a long-lived Port instead.
import type { PageRequestType, BackgroundMessageType } from "./contract";

// 1. Inject injected.js into the main world.
// If the page's Content-Security-Policy refuses the main-world script — e.g. raw.githubusercontent.com serves
// everything with `default-src 'none'; sandbox`, which disables injected scripts — then window.ml never comes
// up, so a delegated agent tool would post into the void and HANG (the round-trip below has no answerer). Two
// signals catch it: `injectedBlocked` (an `error` event on the element — fires when the fetch is refused, e.g.
// script-src 'none') and `injectedAlive` (set when injected posts its load-time PAGE_ADOPT_HELLO — the
// reliable positive signal, since a `sandbox` CSP LOADS the script but blocks EXECUTION, firing neither error).
let injectedBlocked = false;
let injectedAlive = false;
// How long to wait for injected to prove it's alive before declaring a delegated tool dead on a page that
// blocks it. Short — injected posts its hello the instant it runs; if it hasn't by now, it never will here.
const INJECTED_ABSENT_GRACE_MS = 4_000;
// Backstop bound once injected IS alive but a tool doesn't answer: generous — longer than any realistic tool
// (a long `wait`, a heavy `python_exec`) — so it only ever catches a genuine hang, not a slow-but-live tool.
const TOOL_RELAY_TIMEOUT_MS = 120_000;
const CSP_BLOCK_MSG = (name: string): string => `Error: this page blocks the extension's page script, so "${name}" can't run here. Its Content-Security-Policy disables injected scripts — raw.githubusercontent.com does this (it serves files with a "sandbox" CSP). Better: don't navigate here at all — if you just need this URL's CONTENT, navigate BACK to a working page and use \`fetch_url\` (or \`ml.fetch(url)\`) to read it directly (a background GET, no injected script needed). Otherwise open a normal page (e.g. the github.com "…/blob/…" view, not the raw host).`;
const s = document.createElement("script");
s.src = chrome.runtime.getURL("injected.js");
s.onload = () => s.remove();
s.onerror = () => { injectedBlocked = true; s.remove(); };
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
    LIST_SERVER_TOOLS_REQUEST: { type: "LIST_SERVER_TOOLS", responseType: "LIST_SERVER_TOOLS_RESPONSE" },
    CONFIG_REQUEST: { type: "GET_CONFIG", responseType: "CONFIG_RESPONSE" },
    INVOCATION_REQUEST: { type: "GET_INVOCATION", responseType: "INVOCATION_RESPONSE" },
    PS_REQUEST: { type: "OLLAMA_PS", responseType: "PS_RESPONSE" },
    UNLOAD_REQUEST: { type: "OLLAMA_UNLOAD", responseType: "UNLOAD_RESPONSE" },
    CAPTURE_TAB_REQUEST: { type: "CAPTURE_TAB", responseType: "CAPTURE_TAB_RESPONSE" },
    SAVE_SESSION_REQUEST: { type: "SAVE_SESSION", responseType: "SAVE_SESSION_RESPONSE" },
    GET_SESSION_REQUEST: { type: "GET_SESSION", responseType: "GET_SESSION_RESPONSE" },
    PYTHON_EXEC_REQUEST: { type: "PYTHON_EXEC", responseType: "PYTHON_EXEC_RESPONSE" },
    FETCH_SHEET_REQUEST: { type: "FETCH_SHEET", responseType: "FETCH_SHEET_RESPONSE" },
    FETCH_URL_REQUEST: { type: "FETCH_URL", responseType: "FETCH_URL_RESPONSE" },
    CDP_SHADOW_RESOLVE_REQUEST: { type: "CDP_SHADOW_RESOLVE", responseType: "CDP_SHADOW_RESOLVE_RESPONSE" },
    // Design A: kick off a background-hosted ml.agent loop. The single response carries the final
    // AgentResult (the run's debug events stream separately via ML_DEBUG_TO_PAGE, below).
    START_RUN_REQUEST: { type: "START_RUN", responseType: "START_RUN_RESPONSE" },
    RESUME_RUN_REQUEST: { type: "RESUME_RUN", responseType: "RESUME_RUN_RESPONSE" },
    INJECT_MESSAGE_REQUEST: { type: "INJECT_MESSAGE", responseType: "INJECT_MESSAGE_RESPONSE" },
};

interface BgResponse { data?: unknown; sources?: unknown; model?: unknown; reasoning?: unknown; usage?: unknown; messages?: unknown; stepCount?: unknown; seqCount?: unknown; error?: string; }

const sendRuntimeMessage = (type: BackgroundMessageType, requestId: string, payload: unknown, responseType: string): void => {
    // requestId travels to the background too, so it can key an AbortController for the task
    // (see ABORT_REQUEST below → ABORT_TASK). Only FETCH_LLM currently registers one.
    chrome.runtime.sendMessage({ type, payload, requestId }, (response: BgResponse | undefined) => {
        // A MISSING response (undefined) means the background never called sendResponse — the channel closed
        // under it: the MV3 service worker was evicted/reloaded mid-task (common for a long agent run — the
        // design-A eviction case), or the listener returned before responding. Reading chrome.runtime.lastError
        // both HANDLES it (silences the "Unchecked lastError" console noise) and gives us the reason. Synthesise
        // an error so the page REJECTS cleanly instead of resolving `undefined` — which crashed downstream as the
        // opaque "Cannot read properties of undefined (reading 'steps')".
        const lastErr = chrome.runtime.lastError;
        const error = (response && response.error)
            || (!response ? ((lastErr && lastErr.message ? lastErr.message + " — " : "")
                + "the extension background didn't respond (it may have been reloaded or evicted mid-run). Try again.") : undefined);
        // Send the response back to the main world.
        window.postMessage({
            type: responseType,
            requestId,
            result: response && response.data,
            sources: response && response.sources,
            model: response && response.model,   // resolved model, for the debug sidebar's provenance
            reasoning: response && response.reasoning,   // separate thinking text, for the sidebar
            usage: response && response.usage,   // token counts, for the sidebar's context gauge
            messages: response && response.messages,   // a background run's final history, synced back to a createAgent handle
            stepCount: response && response.stepCount,  // + its step/seq extents, so the handle offsets the next turn
            seqCount: response && response.seqCount,
            error,
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
chrome.runtime.onMessage.addListener((message: PageMessage & { event?: unknown }, _sender, sendResponse) => {
    // A debug event from a background-hosted run → re-post it on the page window as __mlDebug, so the
    // overlay shell (which reads page window-messages) relays it into the sidebar app. Tagged
    // `__mlFromBg` so the shell can tell background-origin events (this stream) apart from the page's
    // OWN injected events (bus.ts ring + replay) — the off-mode card buffers only the former while its
    // lazily-mounted iframe loads, so the two sources never double up. Fire-and-forget.
    if (message && message.type === "ML_DEBUG_TO_PAGE") {
        window.postMessage({ __mlDebug: message.event, __mlFromBg: true }, "*");
        return undefined;
    }
    // A LIVE python_exec stdout chunk (opt-in streaming) → re-post on the page window so ml.pythonExec's
    // in-flight promise (keyed by requestId) resolves it as a progress event to the tool's ctx.stream.
    if (message && message.type === "PYTHON_STREAM") {
        window.postMessage({ type: "PYTHON_STREAM", requestId: (message as { requestId?: string }).requestId, chunk: (message as { chunk?: string }).chunk, ts: (message as { ts?: number }).ts }, "*");
        return undefined;
    }
    if (!message || message.type !== "RUN_TOOL_IN_PAGE") return undefined;
    const { runId, name, args, renderOnly, readonlyTry, precheck, verifyAt, verifyViewport, verifyText, verifyPipe, verifyElement, verifyFocus, stream } = (message.payload || {}) as { runId: string; name: string; args: unknown; renderOnly?: boolean; readonlyTry?: boolean; precheck?: boolean; verifyAt?: { x: number; y: number }; verifyViewport?: boolean; verifyText?: "strip" | "all"; verifyPipe?: string; verifyElement?: string; verifyFocus?: boolean; stream?: boolean };
    // window.ml's script was fetch-refused by CSP (script-src 'none') — nothing will ever answer. Fail fast.
    if (injectedBlocked) { sendResponse({ result: CSP_BLOCK_MSG(name) }); return true; }
    const callId = Math.random().toString(36).slice(2);
    let done = false;
    const finish = (envelope: unknown, clearAll = true) => {
        if (done) return;
        done = true;
        if (clearAll) { clearTimeout(graceTimer); clearTimeout(backstop); }
        window.removeEventListener("message", onResult);
        sendResponse(envelope);
    };
    const onResult = (event: MessageEvent) => {
        if (event.source !== window || !event.data || event.data.type !== "PAGE_TOOL_RESULT" || event.data.callId !== callId) return;
        finish(event.data.envelope);
    };
    // GRACE: if injected still hasn't proven it's alive (no PAGE_ADOPT_HELLO) by now, window.ml isn't coming up
    // on this page — a `sandbox` CSP LOADS the script but blocks EXECUTION (no error event), so this positive
    // signal is what catches it. Fail the tool fast + actionable instead of wedging the run. If injected IS
    // alive (just slow), let the long backstop govern. A stray race (result already in flight) is guarded by `done`.
    const graceTimer = setTimeout(() => {
        if (done || injectedAlive) return;   // alive-but-slow → the backstop below owns it
        clearTimeout(backstop);
        finish({ result: CSP_BLOCK_MSG(name) }, false);
    }, INJECTED_ABSENT_GRACE_MS);
    // BACKSTOP: injected is alive but a tool never answered (a lost result, a mid-call teardown, a stalled tool).
    // Never wedge the run forever; generous so a legitimately slow tool still completes.
    const backstop = setTimeout(() => {
        if (done) return;
        clearTimeout(graceTimer);
        finish({ result: `Error: the page didn't respond while running "${name}" (timed out). It may be mid-navigation. Re-check the page (look / pageInfo) and retry, or navigate to a different page.` }, false);
    }, TOOL_RELAY_TIMEOUT_MS);
    window.addEventListener("message", onResult);
    window.postMessage({ type: "PAGE_TOOL_RUN", callId, runId, name, args, renderOnly, readonlyTry, precheck, verifyAt, verifyViewport, verifyText, verifyPipe, verifyElement, verifyFocus, stream }, "*");
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
    if (data.type === "CANCEL_RUN_REQUEST") {
        // A createAgent handle cancelling its OWN background-hosted run. Aborting the page-side controller
        // only rejects the round-trip (and routes to ABORT_TASK, which kills a FETCH_LLM — not the run's
        // loop), so the SW loop would keep stepping and emit a stale approval AFTER the "cancelled" bubble.
        // Relay CANCEL_RUN so the background aborts the run's OWN controller. Fire-and-forget; a forged
        // cancel only aborts that page's own run (the background comment notes this) — harmless.
        chrome.runtime.sendMessage({ type: "CANCEL_RUN", payload: data.payload });
        return;
    }
    if (data.type === "PAGE_ADOPT_HELLO") {
        injectedAlive = true;   // injected ran → window.ml is up on this page (the signal the delegation grace checks)
        // Cross-page persistence: injected.js just went live on a fresh document. Ask the background whether
        // this tab still hosts any background-run(s) mid-navigation; for each, relay the rebuild-config back
        // to the main world as an ADOPT_RUN so injected re-registers the toolset. Empty on a normal page.
        chrome.runtime.sendMessage({ type: "CONTENT_READY" }, (resp: { adopt?: { runId: string; rebuild: unknown; resume?: boolean }[] } | undefined) => {
            void chrome.runtime.lastError;   // SW asleep / no active run → no adopt; swallow the "no response" noise
            for (const a of (resp && resp.adopt) || []) {
                window.postMessage({ type: "ADOPT_RUN", runId: a.runId, rebuild: a.rebuild, resume: a.resume }, "*");
            }
        });
        return;
    }
    if (data.type === "RUN_READOPTED") {
        // injected finished re-registering the run's toolset on the new document → tell the background to
        // release the navigation barrier so the held delegated tool runs against this page. Fire-and-forget.
        chrome.runtime.sendMessage({ type: "RUN_READOPTED", payload: { runId: (data as { runId?: string }).runId, pageInfo: (data as { pageInfo?: string }).pageInfo } });
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
    // A LIVE output chunk from a DELEGATED tool (its ctx.stream, posted by run-delegation) → forward to the
    // background, which routes it to the in-flight call's sink by runId (→ the loop's fan → a streamOutput
    // delta on every surface). Fire-and-forget; a dropped chunk only costs a frame of live output.
    // `ml.dereference` from inside a delegated tool of a BACKGROUND-hosted run: the pointer store lives in the
    // service worker, so relay the read and post the answer back to the page. Request/response, id-matched.
    if (data.type === "PAGE_DEREF") {
        const d = data as { id?: string; runId?: string; ref?: string; pipe?: string };
        chrome.runtime.sendMessage({ type: "DEREF_TOKEN", runId: d.runId, ref: d.ref, pipe: d.pipe }, (resp: { value?: string; error?: string } = {}) => {
            const err = chrome.runtime.lastError?.message || resp?.error;
            window.postMessage({ type: "PAGE_DEREF_RESULT", id: d.id, ...(err ? { error: err } : { value: resp?.value ?? "" }) }, "*");
        });
        return;
    }
    if (data.type === "PAGE_TOOL_STREAM") {
        chrome.runtime.sendMessage({ type: "PAGE_TOOL_STREAM", runId: (data as { runId?: string }).runId, chunk: (data as { chunk?: string }).chunk, ts: (data as { ts?: number }).ts });
        return;
    }
    // 3. Forward to the background worker (to bypass CORS).
    const entry = HANDLE_MAP[data.type as PageRequestType];
    if (!entry) return;
    sendRuntimeMessage(entry.type, requestId, data.payload, entry.responseType);
});

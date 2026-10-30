// Content script (isolated world, document_start): relays messages between injected.js in the page's main world and
// the background worker (the page channel ⇄ chrome.runtime), bridging CORS. Streaming rides a long-lived Port instead.
// It no longer puts injected.js into the page: the worker registers it for the origins that may see window.ml and
// injects it into a hidden page only for a run the person starts there (sw-presence.ts). On a hidden page this script
// says nothing to the page and answers nothing it posts (page-gate.ts, docs/spec/SITE_PRESENCE.md step 2).
import type { PageRequestType, BackgroundMessageType } from "./contract/contract-messages";
import { HANDLE_MAP } from "./page-relay";
import { gateOpen, gateState, setGate, setAsk, gateAsks, whenOpen, whenDecided, markAlive, pageAlive, setVisible } from "./page-gate";
import { listenForPage, toPage, onPage, offPage, rearmForPage, type ChannelMessage } from "./page-channel";
import { watchGestures, hasPageGesture } from "./page-gesture";

// Before injected.js runs (a registered page script runs right after this, at document_start): take the port it hands
// over (page-channel.ts). Nothing between us and the page script crosses the page's window.
listenForPage();
// And before any page script can register a listener of its own: the page's trusted input, for `ml.requestAccess` (Q11).
watchGestures();

// 1. Whether injected.js is up in the main world. If it never comes up (a `sandbox` CSP blocks script EXECUTION in the
// page), a delegated agent tool would post into the void and HANG, so the waits below are bounded: `pageAlive()` is set
// when injected posts its load-time PAGE_ADOPT_HELLO, the reliable positive signal. Whether we speak to the page at all
// is the gate's (page-gate.ts), set only by the worker.
// How long to wait for injected to prove it's alive before declaring a delegated tool dead on a page that
// blocks it. Short — injected posts its hello the instant it runs; if it hasn't by now, it never will here.
const INJECTED_ABSENT_GRACE_MS = 4_000;
// Backstop bound once injected IS alive but a tool doesn't answer: generous — longer than any realistic tool
// (a long `wait`, a heavy `python_exec`) — so it only ever catches a genuine hang, not a slow-but-live tool.
const TOOL_RELAY_TIMEOUT_MS = 120_000;
/** How long the content script waits for the page to answer a state read before answering the worker with nothing. */
const PAGE_STATE_RELAY_MS = 1200;
const CSP_BLOCK_MSG = (name: string): string => `Error: this page blocks the extension's page script, so "${name}" can't run here. Its Content-Security-Policy disables injected scripts — raw.githubusercontent.com does this (it serves files with a "sandbox" CSP). Better: don't navigate here at all — if you just need this URL's CONTENT, navigate BACK to a working page and use \`fetch_url\` (or \`ml.fetch(url)\`) to read it directly (a background GET, no injected script needed). Otherwise open a normal page (e.g. the github.com "…/blob/…" view, not the raw host).`;
/** Why a run cannot start on a page whose CSP keeps the extension's page script from running. */
const CSP_START_MSG = "this page blocks the extension's page script (its Content-Security-Policy disables injected scripts), so an agent cannot run on it. Open an ordinary page and start the run there.";
/** Why a delegated tool cannot run: the worker never let this document hear from us (a hidden page with no run). */
const SHUT_MSG = "Error: the extension's page script is not in this page.";
/** How long a document the worker answered open waits for the page script's hello before saying it has none
 *  (PAGE_SCRIPT_MISSING): injected.js says hello as it runs, at document_start, so this only ever waits out a document
 *  that loaded before its origin's registration covered it. */
const PAGE_SCRIPT_MISSING_MS = 1500;
/** What waits for injected's hello in this document. */
const onAlive: (() => void)[] = [];

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
        toPage({
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
        });
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
            toPage({ type: "LLM_STREAM_CHUNK", requestId, delta: msg.delta });
        } else if (msg.type === "done") {
            toPage({ type: "LLM_STREAM_DONE", requestId, content: msg.content, sources: msg.sources, model: msg.model, reasoning: msg.reasoning, usage: msg.usage });
            end();
        } else if (msg.type === "error") {
            toPage({ type: "LLM_STREAM_ERROR", requestId, error: msg.error });
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
chrome.runtime.onMessage.addListener(onWorkerMessage);

/** What the worker asks of this page, held while the gate is pending so the answer follows the worker's own word. */
const HELD_WHILE_PENDING = new Set(["ADOPT_RUN_NOW", "RUN_STATE_IN_PAGE", "CANCEL_TOOL_IN_PAGE", "RUN_TOOL_IN_PAGE", "SERVER_TOOL_STREAM", "PYTHON_STREAM"]);

/**
 * One message from the worker to this tab.
 * @param message the message
 * @param _sender who sent it (the worker)
 * @param sendResponse the answer
 * @returns true when the answer comes later
 */
function onWorkerMessage(message: PageMessage & { event?: unknown }, _sender: chrome.runtime.MessageSender, sendResponse: (r?: unknown) => void): true | undefined {
    if (message && HELD_WHILE_PENDING.has(message.type ?? "") && gateState() === "pending" && (message.payload as { injected?: unknown } | undefined)?.injected !== true) {
        whenDecided(() => { onWorkerMessage(message, _sender, sendResponse); });
        return true;
    }
    // The worker asking whether this page was told it is hidden (an origin allowed since it loaded), and then opening
    // the gate once it has put the page script in (sw-presence.ts `showInOpenTabs`). Only the worker reaches this listener.
    if (message && message.type === "PRESENCE_CHECK") { sendResponse({ gate: gateState(), alive: pageAlive(), ask: gateAsks() }); return undefined; }
    // The worker has put the stub into this page (an origin just marked visible): its access request may now be relayed.
    if (message && message.type === "PRESENCE_ASK") { setAsk(true); sendResponse(true); return undefined; }
    // The worker says this page's origin is hidden now (unmarked, the setting turned off, or denied): a stub it loaded with
    // keeps its `window.ml`, but nothing it posts is relayed any more.
    if (message && message.type === "PRESENCE_HIDE") { setAsk(false); sendResponse(true); return undefined; }
    // The worker is about to put injected.js in (sw-presence.ts injectPageScripts): a port the page handed over before
    // is dropped, and the next one taken (page-channel.ts).
    if (message && message.type === "PAGE_PORT_ARM") { rearmForPage(); sendResponse(true); return undefined; }
    if (message && message.type === "PRESENCE_OPEN") { setVisible(); setGate(true); sendResponse(true); return undefined; }
    // A debug event from a background-hosted run is the SHELL's (sidebar/shell.ts receives ML_DEBUG_TO_PAGE itself). It
    // is not re-posted on the page window: this used to, and the page read every step of every run that reached the
    // tab, and posted its own as the worker's (docs/spec/SITE_ACCESS.md, attack 15).
    if (message && message.type === "ML_DEBUG_TO_PAGE") return undefined;
    // A LIVE python_exec stdout chunk (opt-in streaming) → re-post on the page window so ml.pythonExec's
    // in-flight promise (keyed by requestId) resolves it as a progress event to the tool's ctx.stream.
    if (message && message.type === "SERVER_TOOL_STREAM") {
        // A live frame from a running server-side tool → the page's awaiting call (keyed by requestId), which
        // hands it to the tool's ctx.stream. Same one-way shape as PYTHON_STREAM.
        const m = message as { requestId?: string; frame?: unknown; at?: number };
        if (gateOpen()) toPage({ type: "SERVER_TOOL_STREAM", requestId: m.requestId, frame: m.frame, at: m.at });
        return;
    }
    if (message && message.type === "PYTHON_STREAM") {
        if (gateOpen()) toPage({ type: "PYTHON_STREAM", requestId: (message as { requestId?: string }).requestId, chunk: (message as { chunk?: string }).chunk, ts: (message as { ts?: number }).ts });
        return undefined;
    }
    // A run the WORKER is starting on this tab (sw-run-start.ts): register its builtin toolset here, exactly as a
    // navigation's re-adopt does, and answer with this page's context. The worker built the run; the page supplies
    // only what it is (its context) and, later, the tool executions.
    if (message && message.type === "ADOPT_RUN_NOW") {
        const { runId, rebuild } = (message.payload || {}) as { runId?: string; rebuild?: unknown };
        // A hidden page has no page script until the worker puts one in: ask for it, and the worker sends this again with
        // `injected` once it has (sw-run-start.ts `adoptOnTab`). Decided by the gate, never by a hello the page can forge.
        if ((message.payload as { injected?: unknown } | undefined)?.injected === true) setGate(true);
        if (!gateOpen()) { sendResponse({ needInject: true }); return true; }
        const reply = Math.random().toString(36).slice(2);
        let done = false;
        const finish = (r: { pageInfo?: string; error?: string }) => {
            if (done) return;
            done = true; clearTimeout(timer);
            offPage(onAdopted);
            sendResponse(r);
        };
        const onAdopted = (event: ChannelMessage) => {
            if (!event.data || event.data.type !== "RUN_ADOPTED_NOW" || event.data.reply !== reply) return;
            finish({ pageInfo: typeof event.data.pageInfo === "string" ? event.data.pageInfo : "" });
        };
        // Same two bounds as a delegated tool: short while the page script has not proved it is alive, long once it has.
        const timer = setTimeout(() => finish({ error: pageAlive() ? "the page did not answer while the run was starting" : CSP_START_MSG }),
            pageAlive() ? TOOL_RELAY_TIMEOUT_MS : INJECTED_ABSENT_GRACE_MS);
        onPage(onAdopted);
        toPage({ type: "ADOPT_RUN", runId, rebuild, reply });
        return true;
    }
    // The state inspector asking what this page holds for a run (sw-run-state.ts). Short, and never retried: the
    // worker asks again in two seconds, and a page that cannot answer is reported as such rather than waited on.
    if (message && message.type === "RUN_STATE_IN_PAGE") {
        const { runId } = (message.payload || {}) as { runId?: string };
        if (!gateOpen() || typeof runId !== "string") { sendResponse(null); return true; }
        const callId = Math.random().toString(36).slice(2);
        const finish = (r: unknown) => { clearTimeout(timer); offPage(onState); sendResponse(r); };
        const onState = (event: ChannelMessage) => {
            if (!event.data || event.data.type !== "PAGE_STATE_RESULT" || event.data.callId !== callId) return;
            finish({ members: event.data.members, entries: event.data.entries });
        };
        const timer = setTimeout(() => finish(null), PAGE_STATE_RELAY_MS);
        onPage(onState);
        toPage({ type: "PAGE_STATE_READ", callId, runId });
        return true;
    }
    // The run was stopped while its read-only survey ran here (sw-run-host.ts): the main world halts it. No answer.
    if (message && message.type === "CANCEL_TOOL_IN_PAGE") {
        const { runId } = (message.payload || {}) as { runId?: unknown };
        if (typeof runId === "string" && gateOpen()) toPage({ type: "PAGE_TOOL_CANCEL", runId });
        return undefined;
    }
    if (!message || message.type !== "RUN_TOOL_IN_PAGE") return undefined;
    const { runId, name, args, renderOnly, readonlyTry, precheck, verifyAt, verifyViewport, verifyText, verifyPipe, verifyElement, verifyFocus, verifyInWorker, stream, finish: finishTurn, reads, answerShape, answerSelect, geometry, pageRead } = (message.payload || {}) as { pageRead?: unknown; verifyInWorker?: boolean; runId: string; name: string; args: unknown; reads?: unknown[]; answerShape?: unknown[]; answerSelect?: unknown; geometry?: unknown; renderOnly?: boolean; readonlyTry?: boolean; precheck?: boolean; verifyAt?: { x: number; y: number }; verifyViewport?: boolean; verifyText?: "strip" | "all"; verifyPipe?: string; verifyElement?: string; verifyFocus?: boolean; stream?: boolean; finish?: boolean };
    // Nothing of ours is in this page, so nothing will ever answer. Fail fast, and post nothing to it.
    if (!gateOpen()) { sendResponse({ result: SHUT_MSG }); return true; }
    const callId = Math.random().toString(36).slice(2);
    let done = false;
    const finish = (envelope: unknown, clearAll = true) => {
        if (done) return;
        done = true;
        if (clearAll) { clearTimeout(graceTimer); clearTimeout(backstop); }
        offPage(onResult);
        sendResponse(envelope);
    };
    const onResult = (event: ChannelMessage) => {
        if (!event.data || event.data.type !== "PAGE_TOOL_RESULT" || event.data.callId !== callId) return;
        finish(event.data.envelope);
    };
    // GRACE: if injected still hasn't proven it's alive (no PAGE_ADOPT_HELLO) by now, window.ml isn't coming up
    // on this page — a `sandbox` CSP LOADS the script but blocks EXECUTION (no error event), so this positive
    // signal is what catches it. Fail the tool fast + actionable instead of wedging the run. If injected IS
    // alive (just slow), let the long backstop govern. A stray race (result already in flight) is guarded by `done`.
    const graceTimer = setTimeout(() => {
        if (done || pageAlive()) return;   // alive-but-slow → the backstop below owns it
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
    onPage(onResult);
    toPage({ type: "PAGE_TOOL_RUN", callId, runId, name, args, reads, renderOnly, readonlyTry, precheck, verifyAt, verifyViewport, verifyText, verifyPipe, verifyElement, verifyFocus, verifyInWorker, stream, finish: finishTurn, answerShape, answerSelect, geometry, pageRead });
    return true;   // async sendResponse (the window round-trip completes later)
}

// 2. Listen for messages from injected.js (main world). A hello only marks the page script alive; everything else waits
// for the gate, so a hidden page that posts our types is neither answered nor relayed (it is held while the worker has
// not answered yet, and dropped once it says the page is hidden).
onPage((event: ChannelMessage) => {
    if (!event.data) return;
    const data = event.data as PageMessage;
    if (data.type === "PAGE_ADOPT_HELLO") {
        markAlive();   // injected ran → window.ml is up on this page (the signal the delegation grace checks)
        for (const f of onAlive.splice(0)) f();
        return;
    }
    if (gateState() === "open") onPageMessage(data);
    else if (data.type === "REQUEST_ACCESS_REQUEST") askThroughClosedGate(data);
    else whenOpen(() => onPageMessage(data));
});

/** How many access requests wait for the worker's first answer: the page cannot queue more than this. */
let asksHeld = 0;   // state: plumbing

/**
 * An access request from a page whose gate is not open: relayed when the worker said the page has the stub
 * (`gateAsks`), or opened it meanwhile; dropped unanswered otherwise, as a hidden page's every post is.
 * @param data what the page posted
 */
function askThroughClosedGate(data: PageMessage): void {
    const relay = (): void => { if (gateOpen() || gateAsks()) requestAccessFromPage(data.requestId ?? "", data.payload); };
    if (gateState() !== "pending") { relay(); return; }
    if (asksHeld >= 16) return;
    asksHeld++;
    whenDecided(() => { asksHeld--; relay(); });
}

/**
 * One message from the main world, once the gate is open.
 * @param data what the page posted
 */
function onPageMessage(data: PageMessage): void {
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
        // Its own type, not CANCEL_RUN: the shell's Stop sends CANCEL_RUN from this same world, and the background
        // has to be able to gate the PAGE's cancel by the page's origin without gating the person's Stop.
        chrome.runtime.sendMessage({ type: "PAGE_CANCEL_RUN", payload: data.payload });
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
    // A stored table's columns, read for a background-hosted run (`t.col(…)` on a stored table's facade). Id-matched; the
    // worker checks the run is hosted on this tab and that the key was sent with its in-flight call.
    if (data.type === "PAGE_VALUE_COLUMNS") {
        const d = data as { id?: string; runId?: string; key?: string; names?: string[]; delimiter?: string; headerless?: boolean };
        chrome.runtime.sendMessage({ type: "VALUE_COLUMNS", runId: d.runId, key: d.key, names: d.names, delimiter: d.delimiter, headerless: d.headerless }, (resp: { rowCount?: number; columns?: unknown; error?: string } = {}) => {
            const err = chrome.runtime.lastError?.message || resp?.error;
            toPage({ type: "PAGE_VALUE_COLUMNS_RESULT", id: d.id, ...(err ? { error: err } : { rowCount: resp?.rowCount, columns: resp?.columns }) });
        });
        return;
    }
    if (data.type === "PAGE_TOOL_STREAM") {
        chrome.runtime.sendMessage({ type: "PAGE_TOOL_STREAM", runId: (data as { runId?: string }).runId, chunk: (data as { chunk?: string }).chunk, ts: (data as { ts?: number }).ts, skipped: (data as { skipped?: number }).skipped });
        return;
    }
    if (data.type === "REQUEST_ACCESS_REQUEST") { requestAccessFromPage(requestId, data.payload); return; }
    // 3. Forward to the background worker (to bypass CORS).
    const entry = HANDLE_MAP[data.type as PageRequestType];
    if (!entry) return;
    sendRuntimeMessage(entry.type, requestId, data.payload, entry.responseType);
}

/** The `ml.requestAccess` calls waiting on the one in flight, by request id: answered with its answer. */
let accessWaiting: string[] | null = null;   // state: plumbing

/**
 * Relay one `ml.requestAccess` call, with the one fact only this world can vouch for: whether the person just acted on
 * the page itself (`hasPageGesture`, Q11). It travels beside the payload, which is rebuilt from the fields the request
 * has, so nothing the page posts can stand in for it. One request is in flight per document; calls made meanwhile get
 * its answer and are never relayed, so a page that calls it a thousand times costs the worker one request.
 * @param requestId the page's request id
 * @param raw what the page passed
 */
function requestAccessFromPage(requestId: string, raw: unknown): void {
    const answer = (r: { data?: unknown; error?: string } | undefined, id: string): void => {
        toPage({ type: "REQUEST_ACCESS_RESPONSE", requestId: id, result: r?.data, error: r?.data === undefined ? (r?.error || "the extension background didn't respond; try again.") : undefined });
    };
    if (accessWaiting) { if (accessWaiting.length < 256) accessWaiting.push(requestId); return; }
    accessWaiting = [requestId];
    const p = (raw && typeof raw === "object" ? raw : {}) as { agents?: unknown; level?: unknown; reason?: unknown };
    const payload = { agents: p.agents === true, level: p.level === "self-approve" ? "self-approve" : undefined, reason: typeof p.reason === "string" ? p.reason.slice(0, 1000) : undefined };
    chrome.runtime.sendMessage({ type: "REQUEST_ACCESS", payload, requestId, gesture: hasPageGesture() }, (r: { data?: unknown; error?: string } | undefined) => {
        void chrome.runtime.lastError;
        const ids = accessWaiting ?? [];
        accessWaiting = null;
        for (const id of ids) answer(r, id);
    });
}

// 4. Ask the worker what this document is, as it starts: whether its origin may see window.ml (which opens the gate; its
// page script is registered and has run or is about to), and whether this tab still hosts background runs
// mid-navigation. For a hidden page with runs, the worker has put the page script in before it answers. Each run is
// re-adopted once injected is up: an ADOPT_RUN makes it re-register the toolset. Sent from here, not on injected's
// hello, because a hidden page has no injected to say hello.

/**
 * Ask, and ask again a few times if the worker did not answer (it was restarting): until it does, the gate stays
 * pending, so the page's own window.ml calls wait and nothing is posted to the page.
 * @param tries how many asks are left
 */
function contentReady(tries = 4): void {
    chrome.runtime.sendMessage({ type: "CONTENT_READY" }, (resp: { open?: boolean; ask?: boolean; adopt?: { runId: string; rebuild: unknown }[] } | undefined) => {
        void chrome.runtime.lastError;
        if (!resp) { if (tries > 1) setTimeout(() => contentReady(tries - 1), 500); return; }
        setAsk(resp.ask === true);
        if (resp.open === true) setVisible();
        setGate(resp.open === true);
        // Open with no page script (SITE_PRESENCE.md step 2, the race the janitor found): the origin turned visible while this
        // document loaded, before the registration covered it. Said once; the worker decides from the sender's own origin.
        if (gateOpen() && !pageAlive()) setTimeout(() => { if (!pageAlive()) chrome.runtime.sendMessage({ type: "PAGE_SCRIPT_MISSING" }, () => void chrome.runtime.lastError); }, PAGE_SCRIPT_MISSING_MS);
        const adopt = (resp.adopt || []).filter((a) => a && typeof a.runId === "string");
        if (!adopt.length || !gateOpen()) return;
        const post = () => { for (const a of adopt) toPage({ type: "ADOPT_RUN", runId: a.runId, rebuild: a.rebuild }); };
        if (pageAlive()) post(); else onAlive.push(post);
    });
}
contentReady();

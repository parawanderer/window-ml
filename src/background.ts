// Background service worker: owns config, builds per-format request bodies,
// extracts replies, and makes the privileged (host-permissioned) fetches. All
// server JSON is genuinely opaque, so it's typed `any`; our own data uses the
// shared contract types.
import { LOAD_RECORDS_KEY } from "./load-records";
import type { ApprovalDecision } from "./contract-agent";
import type { StartRunPayload, SetApprovalPayload, CancelRunPayload, InjectMessagePayload } from "./contract-messages";
import { modelFilterAllows } from "./contract-config";
import { googleSheetId, isCurrentPage } from "./dom";
import { isSelfSourceUrl } from "./self-source";   // trusted-side enforcement of the self-source auto-approve (uncredentialed own-repo reads)
import { BUILD_INFO } from "./build-info.gen";
import { browserInfo } from "./util";   // the fork's settings scheme (page-context Browser line)
import { ensureDebuggerAttached, releaseDebugger, cdpClick, cdpScreenshot, cdpShadowResolve } from "./sw-cdp";   // CDP/debugger layer (strict-CSP exec, trusted click/type, host-grant-free screenshot)
import { fetchUrlContent, fetchRenderedContent, fetchSheetCsv, SHEET_URL_OK, sheetNameFromDisposition } from "./sw-fetch";   // outbound fetch layer (ml.fetch, rendered fetch, credentialed Google Sheets CSV)
import { executeServerTool } from "./sw-tools";   // run ONE OpenWebUI-configured tool ourselves (privileged fetch)
import { fetchOllamaInfo, getConfig, fetchLLM, streamLLM, prepareRequest, modelCapabilities, listAvailableModels, listServerTools, setModel, listLoadedModels, unloadModels, modelCapabilitiesBatch, embedTexts } from "./sw-llm";   // LLM request/response layer (config, per-format request build, chat calls, model plumbing)
import { subscribeResourceEvents, recentFrames, resourceStreamStatus } from "./sw-events";
import { configureSessionCommands, ingestSessionEvent, keepSession, saveChatSession, senderPage, serveSessionsPort, sessionServer, sessionStorageStats, sessionStore, storageReport } from "./sw-sessions";   // the cross-tab session index the chat page reads
import { folderAction } from "./sw-archive";   // the session archive's folder, for Settings
import { ensureHubRuntime, hubDevices, hubLog, hubState, revokeHubDevice, stopHubRuntime } from "./sw-hub";   // this browser as a runtime on a hub
import { housekeeping, handleHousekeepingReport, handleHousekeepingDump, senderOrigin } from "./sw-housekeeping";
import { storeFetchedBody, claimValue, releaseSessionValues, startValueSweeps, valueHolders, readStoredColumns } from "./sw-values";   // where a table larger than its preview lives (docs/spec/POINTER_VALUES.md)   // what the system decided on its own (docs/dev/housekeeping.md)
import { PendingApprovalDescriptor, pendingApprovals, externallyResolvable, resolveApproval, fetchConsent, credFetchGrants, senderTrust, serverToolKey, pendingGrants, takeCredFetch } from "./sw-consent";
import { runControllers, runInboxes, bgRuns, activeRuns, runRebuilds, runReplayBuffer, hydratedRuns, resurrectedRuns, readoptPageInfo, hydratePersistedRuns, navBarrier, pageValueSession, hydrationDone, purgeAllBgRuns, bufferReplay, derefByRun, deleteRun, releaseSessionTokens, tabPageUrl } from "./sw-runs";
import { relayDebugEvent, resetDebug, debugBuffer, serveDevtoolsPort } from "./sw-debug";   // the DevTools panel's copy of the page debug stream
import { startBackgroundRun, delegateStreams } from "./sw-run-host";
import { pythonPrewarm, pythonExec, relayPyStdout } from "./sw-python";
import { focusLineFor } from "./sw-focus";


// In-flight FETCH_LLM AbortControllers, keyed by the page's requestId, so an ABORT_TASK message
// (ml.agent's signal fired) can cancel the actual fetch. Deleted when the request settles.
const inflight = new Map<string, AbortController>();

// The EXTERNAL approval channel (idea #2). Reachable ONLY from the service-worker realm — Playwright's
// `serviceWorker.evaluate(...)` today, a desktop orchestrator via onMessageExternal / native messaging
// later — NEVER from the page main world (a web page has no chrome.runtime and can't reach this realm), so
// it grants no new power to a hostile page: it's the same unforgeable gate, opened by an automated driver
// instead of a human click. `list()` enumerates the pending gates (with what each is approving); `resolve()`
// approves/denies one by key. A driver can therefore run the whole agent HEADLESS while the browser gate
// still blocks until the driver decides. See docs / tests/e2e for the harness wiring.
(globalThis as unknown as { __mlApprovals?: unknown }).__mlApprovals = {
    // Only OPTED-IN gates (approvalRouting "both"/"external") are visible/resolvable here — a default "ui"
    // run stays human-only, so an orchestrator can't approve a run that never asked to be driven externally.
    list: (): PendingApprovalDescriptor[] => [...pendingApprovals.values()].map(v => v.descriptor).filter(externallyResolvable),
    resolve: (key: string, decision: boolean | ApprovalDecision): boolean => {
        const entry = pendingApprovals.get(key);
        if (!entry || !externallyResolvable(entry.descriptor)) return false;   // unknown, or a UI-only gate
        const norm: ApprovalDecision = (decision === true || (typeof decision === "object" && !!decision && (decision as { approved?: boolean }).approved))
            ? { approved: true, source: "external" }
            : { approved: false, feedback: (typeof decision === "object" && decision && (decision as { feedback?: string }).feedback) || undefined, source: "external" };
        return resolveApproval(key, norm);
    },
};

// Resolves once the startup rehydrate is done — CONTENT_READY awaits it so a page loading right after an SW
// respawn doesn't miss the in-flight run (the respawn race).
// Logs this worker's start, and infers the previous one's eviction from a heartbeat it left in storage.session.
void housekeeping.start();
// The value store's idle sweep: now, and on an alarm, since a worker evicted mid-run never releases what its session held.
startValueSweeps();

// TEST-ONLY (reachable only from the SW realm via serviceWorker.evaluate, like __mlApprovals — no page can
// reach it, and nothing in prod calls it): simulate an MV3 eviction by dropping all in-memory run state, then
// re-hydrating from storage as a respawn would. An orphaned (gate-suspended) loop is left dangling exactly as
// a real eviction leaves it — its finally never runs, so the storage snapshot survives. Lets an e2e exercise
// durable resume without waiting ~30s for a real eviction.
(globalThis as unknown as { __mlEvictForTest?: unknown }).__mlEvictForTest = async (): Promise<void> => {
    runControllers.clear(); runInboxes.clear(); bgRuns.clear(); activeRuns.clear();
    runRebuilds.clear(); runReplayBuffer.clear(); pendingApprovals.clear(); hydratedRuns.clear(); resurrectedRuns.clear(); readoptPageInfo.clear();
    await hydratePersistedRuns();
};
// TEST-ONLY: seed a minimal resumable bgRun for a tab, so a unit test can exercise the "don't wipe a tab that
// still has a recoverable run" guard (resetDebug / tabHasBgRun) without driving a whole run to completion.
(globalThis as unknown as { __mlSeedBgRunForTest?: unknown }).__mlSeedBgRunForTest = (tabId: number, runId: string): void => {
    bgRuns.set(runId, { p: { runId } as unknown as StartRunPayload, tabId, messages: [] });
};

// captureVisibleTab quota backoff: retry a rate-limited screenshot (~2/sec cap) rather than failing the step.
const CAPTURE_RETRIES = 5;       // ~5 tries…
const CAPTURE_RETRY_MS = 550;    // …spaced just over the 1s/2-call window → clears the transient quota

if (typeof chrome !== "undefined" && chrome.webNavigation?.onCommitted) {
    chrome.webNavigation.onCommitted.addListener((d) => {
        if (d.frameId === 0) tabPageUrl.set(d.tabId, d.url);
        // The old document is gone and any page-hosted run in it with it: drop what that tab was entitled to read.
        // A BACKGROUND run survives the navigation and keeps its own per-run claim, so this never cuts one short.
        if (d.frameId === 0) releaseSessionValues(pageValueSession(d.tabId));
        if (d.frameId === 0 && activeRuns.has(d.tabId)) navBarrier.noteNavigating(d.tabId);
    });
    chrome.webNavigation.onHistoryStateUpdated?.addListener((d) => { if (d.frameId === 0) tabPageUrl.set(d.tabId, d.url); });
}
if (typeof chrome !== "undefined" && chrome.tabs?.onRemoved) {
    chrome.tabs.onRemoved.addListener((tabId) => { tabPageUrl.delete(tabId); activeRuns.delete(tabId); navBarrier.forget(tabId); readoptPageInfo.delete(tabId); fetchConsent.delete(tabId); credFetchGrants.delete(tabId); runReplayBuffer.delete(tabId); releaseSessionValues(pageValueSession(tabId)); releaseDebugger(tabId); sessionServer.pageGone(tabId, { closed: true }); });
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

// PDF-export docs awaiting their print.html tab (key → rendered HTML + its TTL timer). Kept out of the URL
// because a session doc with inlined screenshots is large; the tab fetches it by key, and it's deleted on
// read (the timer cleared then) or after a TTL so a dismissed export never leaks.
const pendingPrints = new Map<string, { html: string; timer: ReturnType<typeof setTimeout> }>();

// The same, for a server tool's frames: streamId (the page's requestId) → tabId, so a frame reaches the
// page that asked for it and no other.
const serverToolTabs = new Map<string, number>();

const PRINT_DOC_TTL_MS = 60_000;
function dropPrintDoc(key: string): void {
    const e = pendingPrints.get(key);
    if (e) { clearTimeout(e.timer); pendingPrints.delete(key); }
}


chrome.runtime.onMessage.addListener((message: any, sender, sendResponse) => {
    housekeeping.beat();   // a message is the worker being alive: the heartbeat an eviction is inferred from (throttled)
    // The content-script shell forwards each __mlDebug event here so a DevTools panel
    // (which can't see page window-messages) can mirror the overlay's stream. Fire-and-
    // forget — no response. RESET clears a tab's buffer on navigation (fresh page).
    if (message.type === "ML_DEBUG_EVENT") {
        if (sender.tab?.id != null) {
            relayDebugEvent(sender.tab.id, message.event);
            ingestSessionEvent(message.event, { tabId: sender.tab.id, trusted: false, page: senderPage(sender.tab) });
        }
        return;
    }
    // A page's own session events, forwarded by the shell for the session index only (overlay mode, whose events
    // otherwise never leave the page, and off mode with `listPageSessions`). Bound to the sending tab: the index
    // refuses a page writing into a session another tab owns.
    if (message.type === "ML_SESSION_EVENT") {
        if (sender.tab?.id != null) ingestSessionEvent(message.event, { tabId: sender.tab.id, trusted: false, page: senderPage(sender.tab) });
        return;
    }
    // A run this browser's own UI started, reporting its session so the worker keeps it past its own life
    // (`config.persistUiRuns`). The worker decides what it keeps; the page only says which session it made, and a
    // hash nobody holds is ignored. A page could claim any hash, which costs it a session row already bounded by
    // the store's budget — the same standing a page's own `{ save: true }` chat has had all along.
    if (message.type === "ML_KEEP_SESSION") {
        if (typeof message.hash === "string") keepSession(message.hash);
        return;
    }
    // Await the startup rehydrate before deciding whether to wipe: right after an SW respawn (e.g. a site-access
    // grant cycled the worker), a fresh page's ML_DEBUG_RESET can RACE hydratePersistedRuns — if it wins,
    // activeRuns/bgRuns are still empty and it wipes an interrupted run's session before it's re-tracked.
    if (message.type === "ML_DEBUG_RESET") {
        const tid = sender.tab?.id;
        if (tid != null) {
            // A new document in the tab: the runs the old one hosted cannot finish. Synchronous, so the new document's
            // first events (which follow this message) are not caught by it.
            sessionServer.pageGone(tid, { closed: false });
            void hydrationDone.then(() => resetDebug(tid));
        }
        return;
    }
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
        try { void chrome.tabs.sendMessage(message.tabId, { type: "ML_SESSION_TO_PAGE", action: message.action, hash: message.hash, text: message.text, images: message.images }).catch(() => {}); } catch { /* tab gone */ }
        return;
    }
    // PDF export prints from a REAL browser tab, not the sidebar app's own frame: window.print() is
    // suppressed for a frame inside DOCKED DevTools (the panel surface), so PDF export there silently did
    // nothing (markdown export worked — it downloads via <a download>). The app (either surface) posts its
    // rendered doc here; we stash it and open a bundled print.html tab keyed to it, which renders + prints +
    // closes itself. A page can't usefully abuse this — it prints an extension-rendered doc into its OWN tab.
    if (message.type === "PRINT_SESSION" && typeof message.payload?.html === "string") {
        const key = Math.random().toString(36).slice(2, 10);
        const timer = setTimeout(() => pendingPrints.delete(key), PRINT_DOC_TTL_MS);   // never leak a doc whose tab never fetched it
        pendingPrints.set(key, { html: message.payload.html, timer });
        chrome.tabs.create({ url: chrome.runtime.getURL(`print.html?k=${key}`), active: true }).catch(() => dropPrintDoc(key));
        return;
    }
    // print.html fetches its doc ONCE, by key (deleted on read, TTL timer cleared — one tab, one fetch).
    if (message.type === "GET_PRINT_DOC" && typeof message.k === "string") {
        const entry = pendingPrints.get(message.k);
        dropPrintDoc(message.k);
        sendResponse({ html: entry ? entry.html : null });
        return;   // synchronous response
    }
    // print.html closes its own tab after printing (belt-and-suspenders to its window.close()).
    if (message.type === "CLOSE_PRINT_TAB") {
        if (sender.tab?.id != null) chrome.tabs.remove(sender.tab.id).catch(() => {});
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
        resolveApproval(`${p.runId}:${p.seq}`, p.decision ? { approved: true, source: "user", persist: p.persist } : { approved: false, feedback: p.feedback, source: "user" });
        return;   // fire-and-forget
    }
    if (message.type === "CONTENT_READY") {
        // Cross-page persistence: a fresh document loaded in a tab. If it still hosts live cross-page run(s),
        // reply with each run's rebuild-config so the new page re-adopts (rebuilds + re-registers its
        // toolset). A fresh content script on a tab with active runs MEANS the document was replaced (the old
        // page is gone), so this fires the re-adopt regardless of the barrier's exact state. Empty otherwise.
        const tabId = sender.tab?.id;
        // Await the startup rehydrate first — a page loading right after an SW respawn must see the in-flight
        // runs storage restored, or it would miss the re-adopt + auto-resume.
        void hydrationDone.then(() => {
            const ids = tabId != null ? activeRuns.get(tabId) : undefined;
            // `resume` marks an INTERRUPTED (evicted) run — the fresh page auto-continues it (durable resume).
            const adopt: { runId: string; rebuild: import("./contract").RebuildConfig; resume?: boolean }[] = [];
            const seen = new Set<string>();
            const addAdopt = (runId: string, rebuild: import("./contract").RebuildConfig): void => {
                if (seen.has(runId)) return;
                seen.add(runId);
                const resume = hydratedRuns.has(runId) && !runControllers.has(runId);   // evicted & not running → re-drive
                if (resume) { hydratedRuns.delete(runId); resurrectedRuns.add(runId); }   // auto-resume ONCE; RESUME_RUN re-emits its `agent` start
                adopt.push({ runId, rebuild, resume: resume || undefined });
            };
            if (ids) for (const runId of ids) { const rebuild = runRebuilds.get(runId); if (rebuild) addAdopt(runId, rebuild); }
            // ALSO re-adopt recently-COMPLETED-but-resumable runs on this tab (bgRuns): a HUD run that navigated
            // and then FINISHED (its fast final answer needs no delegation, so the loop never waits for the new
            // page) would otherwise leave the destination page with no resume handle — and a composer follow-up
            // would be dropped. Re-adopting registers the toolset + the by-hash resume handle. (Not `resume`:
            // a completed run isn't in hydratedRuns, so it re-adopts but doesn't auto-re-drive.)
            if (tabId != null) for (const [runId, snap] of bgRuns) {
                if (snap.tabId === tabId && snap.p.rebuild) addAdopt(runId, snap.p.rebuild);
            }
            sendResponse({ adopt });
            // Overlay/off HUD replay-across-nav: stream the run's buffered history so the fresh card/overlay
            // rebuilds MID-run (start + every step so far), not just post-nav events. The shell buffers these
            // __mlFromBg events while its iframe mounts, absorbing an ordering race against the handshake.
            // Fires for a LIVE run (every nav) AND — the on-click/late-injection fix — for a page that loads
            // AFTER the run finished: a completed run re-adopted from bgRuns replays its history ONCE so the
            // destination page still gets its card + final answer (else the corner card is blank there).
            const hasActive = !!(ids && ids.size);
            if (tabId != null && adopt.length) {
                const history = runReplayBuffer.get(tabId) || [];
                if (history.length) {
                    for (const event of history) chrome.tabs.sendMessage(tabId, { type: "ML_DEBUG_TO_PAGE", event }).catch(() => {});
                    // A COMPLETED-only re-adopt (no live run) has served its purpose — drop the buffer so a later
                    // reload doesn't re-show a finished card. A live run keeps its buffer for the next nav.
                    if (!hasActive) runReplayBuffer.delete(tabId);
                }
            }
        });
        return true;   // async: sendResponse fires after hydration resolves
    }
    if (message.type === "RUN_READOPTED") {
        // The fresh document re-registered a run's toolset → release the navigation barrier so the held
        // delegated tool runs against the new page. Keyed by tab (the barrier is per-tab). Fire-and-forget.
        const tabId = sender.tab?.id;
        const pageInfo = (message.payload as { pageInfo?: string })?.pageInfo;
        if (tabId != null) {
            // Stash the new page's context BEFORE releasing the barrier, so the `navigate` tool call awaiting
            // re-adoption reads it and folds it into its result (orient-on-nav — see the navigate branch below).
            if (pageInfo) readoptPageInfo.set(tabId, pageInfo);
            navBarrier.noteReadopted(tabId);
        }
        return;
    }
    if (message.type === "CANCEL_RUN") {
        // The HUD's "Cancel agent run" (relayed by the trusted content-script shell). Abort the run's
        // controller → the loop stops at the next boundary and resolves { cancelled: true }; the model
        // call in flight is aborted too. A page can't forge this (no chrome.runtime path), and even a
        // forged cancel only aborts that page's own run — harmless.
        cancelBackgroundRun((message.payload as CancelRunPayload)?.runId);
        return;   // fire-and-forget
    }
    if (message.type === "CANCEL_ALL_RUNS") {
        // The popup's "Stop all agent runs" panic button — the guaranteed kill switch for a runaway that has
        // no visible surface (e.g. a resumed run whose card never mounted). Abort every live controller,
        // resolve every open approval gate, and purge all persisted snapshots so nothing re-adopts + resumes.
        const n = runControllers.size;
        for (const [, ctl] of [...runControllers]) { try { ctl.abort(); } catch { /* already gone */ } }
        for (const [key, entry] of [...pendingApprovals]) { pendingApprovals.delete(key); try { entry.resolve(false); } catch { /* gone */ } }
        void purgeAllBgRuns();
        sendResponse({ data: { cancelled: n } });
        return true;
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
            if (!cfg.cdp) { sendResponse({ error: "Debugger-based actions (CDP) are off — enable them in window.ml Settings → Advanced." }); return; }
            if (await senderTrust(sender) === "untrusted") { sendResponse({ error: "Refused: a reserved-element (CDP) click can't be initiated by this page." }); return; }
            const p = (message.payload || {}) as { x?: number; y?: number; tabId?: number };
            const tabId = sender.tab?.id ?? p.tabId;   // a page → its own tab; a trusted surface → the payload's
            if (typeof tabId !== "number" || typeof p.x !== "number" || typeof p.y !== "number") { sendResponse({ error: "CDP_CLICK needs a tab and numeric x/y." }); return; }
            sendResponse(await cdpClick(tabId, p.x, p.y));
        })();
        return true;   // async
    }
    if (message.type === "CDP_SHADOW_RESOLVE") {
        // READ-ONLY resolve of a `>>>` selector across sealed (closed/declarative) shadow roots via CDP — the
        // discovery half of the sealed-shadow reach (describeElement inside a host the JS path can't enter).
        // Gated on the off-by-default `cdp` flag (the debugger banner is the visible signal); a page targets
        // only its OWN tab. NOT senderTrust-gated: it only READS same-document, same-origin content the page's
        // own server authored (no cross-origin gain), and its output (describe lines + coordinates) is not
        // actionable on its own — CDP_CLICK stays untrusted-refused, and a synthetic click on a sealed host
        // can't reach the inner control. The privileged CLICK still flows through the trusted envelope path.
        (async () => {
            const cfg = await getConfig();
            if (!cfg.cdp) { sendResponse({ error: "Debugger-based actions (CDP) are off — enable them in window.ml Settings → Advanced to reach sealed shadow roots." }); return; }
            const p = (message.payload || {}) as { selector?: string; tabId?: number };
            const tabId = sender.tab?.id ?? p.tabId;
            if (typeof tabId !== "number" || typeof p.selector !== "string") { sendResponse({ error: "CDP_SHADOW_RESOLVE needs a tab and a selector." }); return; }
            const r = await cdpShadowResolve(tabId, p.selector);
            sendResponse("error" in r ? { error: r.error } : { data: r.matches });
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
        if (injected) inbox!.queue.push({ id: p.sayId, text: p.text });
        sendResponse({ data: injected });
        return true;
    }
    if (message.type === "START_RUN" || message.type === "RESUME_RUN") {
        startBackgroundRun(message, sender, sendResponse);
        return true;   // async: sendResponse fires when the whole run finishes
    }
    if (message.type === "PYTHON_PREWARM") { pythonPrewarm(message, sendResponse); return true; }
    if (message.type === "PYTHON_EXEC") { pythonExec(message, sender, sendResponse); return true; }   // async
    // A page-side tool of a background-hosted run calling `ml.dereference`. Answered only for a run WE are
    // hosting, from that run's own pointer store — the resolver the loop handed us at start (tokenSink).
    // A stored table's columns (`t.col(…)` on a stored table's facade, POINTER_VALUES slice 7). Answered only for a run WE
    // host, running on the SENDER's tab, that holds the value: the key reaches the page with the pointer, so the key
    // alone must never be enough.
    if (message.type === "VALUE_COLUMNS") {
        (async () => {
            const runId = String(message.runId || ""), key = String(message.key || "");
            const names = Array.isArray(message.names) ? (message.names as unknown[]).map(String) : [];
            const tabId = sender.tab?.id;
            const holders = await valueHolders(key);
            // A PAGE-HOSTED run has no run id this worker can check, so its entitlement is the tab's: the value was
            // disclosed to this tab and the document it was disclosed to is still here (pageValueSession). The run id
            // in the message is then decorative, and deliberately not trusted for anything.
            const viaPage = tabId != null && !!holders?.includes(pageValueSession(tabId));
            if (!viaPage && (!derefByRun.has(runId) || tabId == null || !activeRuns.get(tabId)?.has(runId))) {
                sendResponse({ error: `No run on this page holds a stored table to read ("${runId}").` });
                return;
            }
            if (!viaPage && holders && !holders.includes(runId)) { sendResponse({ error: "That stored table is not held by this run." }); return; }
            try {
                const r = await readStoredColumns(key, names, { ...(typeof message.delimiter === "string" ? { delimiter: message.delimiter } : {}), ...(message.headerless ? { headerless: true } : {}) });
                sendResponse(r);
            } catch (e) { sendResponse({ error: (e as Error)?.message || String(e) }); }
        })();
        return true;
    }
    if (message.type === "DEREF_TOKEN") {
        const fn = derefByRun.get(String(message.runId || ""));
        if (!fn) { sendResponse({ error: `No active background run "${message.runId}" to read pointers from.` }); return true; }
        // `pipe` is EITHER the dialect string or an ARRAY of stages — keep the array intact. `String(array)`
        // comma-joins it ("grep -E a|b,head 5"), which is not the dialect and silently mangles the read.
        const pipe = Array.isArray(message.pipe)
            ? (message.pipe as unknown[]).filter((x): x is string => typeof x === "string")
            : String(message.pipe || "");
        // The advisory rides ALONGSIDE the value across the relay, for the same reason it does in-process:
        // the page-side caller is a script that will operate on the value.
        try { const read = fn(String(message.ref || ""), pipe); sendResponse({ value: read.value, ...(read.warning ? { warning: read.warning } : {}), ...(read.meta ? { meta: read.meta } : {}) }); }
        catch (e) { sendResponse({ error: (e as Error)?.message || String(e) }); }
        return true;
    }
    if (message.type === "PAGE_TOOL_STREAM") {
        // A LIVE output chunk from a DELEGATED page tool (its ctx.stream) → hand it to the in-flight call's
        // sink, which is the loop's throttled fan → an agent-step `streamOutput` delta on every surface.
        // Keyed by runId: the loop delegates tool calls sequentially, so one is in flight per run.
        const sink = delegateStreams.get(message.runId);
        if (sink) { try { sink(String(message.chunk ?? ""), typeof message.ts === "number" ? message.ts : undefined); } catch { /* a bad sink must not break the run */ } }
        return false;
    }
    if (message.type === "PY_STDOUT") { relayPyStdout(message); return false; }
    if (message.type === "SERVER_TOOL_EXEC") {
        // Run ONE OpenWebUI-configured tool. CHOKE POINT, and a real one: the fetch spends the user's API
        // key, and the tool it runs is caller-chosen — a hostile page reaching this handler directly could
        // invoke any tool the user has configured, which is a different capability from spending tokens on
        // a chat call. So an untrusted page may only run a call it holds a per-call grant for, minted when
        // its agent run APPROVED that exact call. Same shape as full-mode Python and FETCH_SHEET.
        (async () => {
            const toolId = String(message.payload?.toolId ?? "");
            const name = String(message.payload?.name ?? "");
            const args = (message.payload?.args ?? {}) as Record<string, unknown>;
            if (await senderTrust(sender) === "untrusted") {
                const key = serverToolKey(toolId, name, args);
                if (!(sender.tab?.id != null && pendingGrants.get(sender.tab.id)?.serverTools.has(key))) {
                    sendResponse({ error: "Refused: running a server-side tool needs approval on this page — run it through an agent and approve it, or add this site to the approval whitelist." });
                    return;
                }
            }
            // LIVE frames (opt-in), keyed by the page's requestId exactly as python's stdout is.
            const streamId: string | undefined = message.payload?.stream ? message.requestId : undefined;
            if (streamId && sender.tab?.id != null) serverToolTabs.set(streamId, sender.tab.id);
            const ctl = new AbortController();
            if (message.requestId) inflight.set(message.requestId, ctl);
            try {
                const end = await executeServerTool({
                    toolId, name, args, signal: ctl.signal,
                    onFrame: streamId ? (frame, at) => {
                        const tabId = serverToolTabs.get(streamId);
                        if (tabId != null) chrome.tabs.sendMessage(tabId, { type: "SERVER_TOOL_STREAM", requestId: streamId, frame, at }).catch(() => { /* page gone */ });
                    } : undefined,
                });
                // The ok/not-ok split is carried through verbatim rather than flattened: a tool that THREW is
                // a step outcome the model reads, and a stream that never completed is not.
                sendResponse(end.ok
                    ? { data: { ok: true, result: end.result, output: end.state.output, marks: end.state.marks, events: end.state.events } }
                    : { data: { ok: false, transportError: end.transportError, output: end.state.output, marks: end.state.marks, events: end.state.events } });
            } catch (e) {
                sendResponse({ error: String((e as Error)?.message || e) });
            } finally {
                if (streamId) serverToolTabs.delete(streamId);
                if (message.requestId) inflight.delete(message.requestId);
            }
        })();
        return true;
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
    if (message.type === "FETCH_URL") {
        // ml.fetch(url): a GET the agent uses to READ content the page can't (a raw file, a JSON API, another
        // site) — bypasses CORS via host permissions. Uncredentialed by default (no cookies); `credentials`
        // sends the user's session and `rendered` loads it in a tab so its JS runs (see the branches). CHOKE-POINT:
        // there's no URL host-lock (arbitrary URLs are the point), so the boundary IS the consent — an
        // untrusted page may fetch only a URL the user approved for THIS tab (grown in a run's approval,
        // unforgeable). A trusted surface / whitelisted domain is unrestricted. Only http(s) targets.
        (async () => {
            const url = String((message.payload as { url?: unknown })?.url || "");
            const credentials = !!(message.payload as { credentials?: unknown })?.credentials;
            const rendered = !!(message.payload as { rendered?: unknown })?.rendered;
            // Only "html" opts OUT of the Markdown ladder; anything else (absent, junk) takes the default.
            const format = (message.payload as { format?: unknown })?.format === "html" ? "html" as const : "markdown" as const;
            let scheme = "";
            try { scheme = new URL(url).protocol; } catch { sendResponse({ error: `Refused: "${url}" is not a valid URL.` }); return; }
            if (scheme !== "http:" && scheme !== "https:") {
                // A local file is refused because it could be ANY file on the machine — and Chrome's fetch has no
                // file scheme anyway. The one file:// read that works is a session render of the page the call
                // came from, answered page-side from its live DOM and never reaching here. So a file: URL here is
                // either another file, or this page in a mode that would need its BYTES; the refusal says which,
                // and names the mode that works, so the model does not retry the same thing.
                const from = sender.url ?? sender.tab?.url ?? "";   // the frame's URL, else its tab's
                const own = from.startsWith("file:") && isCurrentPage(url, from);
                sendResponse({ error: scheme !== "file:"
                    ? `Refused: ml.fetch supports only http(s) URLs (got "${scheme}").`
                    : own
                    ? `Refused: "${url}" is the page you are on, but a local file's bytes cannot be fetched. Use rendered: true with credentials: true to get its live DOM.`
                    : `Refused: ml.fetch cannot read local files ("${url}"). The only one it reads is the page you are on${from.startsWith("file:") ? ` (${from.replace(/#.*$/, "")})` : ""}, with rendered: true and credentials: true.` });
                return;
            }
            const tabId = sender.tab?.id;
            const untrusted = await senderTrust(sender) === "untrusted";
            // SAME-ORIGIN as the sender's page: a free read (the page can already `fetch()` its own origin, and
            // navigate there is free) — applies to a plain GET AND a rendered load. Used by the gate below AND
            // the render dispatch (a same-origin render uses the SESSION tab, not incognito — no leak, you're
            // already signed in there).
            const sameOriginAsSender = (() => { try { return !!sender.url && new URL(url, sender.url).origin === new URL(sender.url).origin; } catch { return false; } })();
            const cfg = await getConfig();   // the same-origin as-you opt-in + the cdp render setting
            // CREDENTIALED (fetch-as-the-user — a raw GET with cookies, OR a rendered load in a NORMAL tab that
            // carries the session) → a "read any URL as you" primitive, so an untrusted page needs a ONE-TIME
            // per-URL grant (minted by an approved fetch_url, consumed here). EXCEPTION: a SAME-ORIGIN as-you fetch
            // is allowed WITHOUT a grant when the user opted into `autoApproveSameOriginAuth` (Advanced). Cross-
            // origin always needs the grant; execOpen/consent never authorize the credentialed path.
            if (credentials) {
                const sameOriginAuthOk = !!cfg.autoApproveSameOriginAuth && sameOriginAsSender;
                // THE SENDER'S OWN PAGE, as a raw GET: the page can already `fetch(location.href, {credentials:
                // "include"})` itself, so it gains nothing here. Judged against the sender's REAL frame URL — the
                // loop's auto-approve only skipped a prompt. A RENDER of it is not included: that would open a
                // second tab of the page (re-running its scripts), which the page side never asks for — it
                // answers a session render of itself from its live DOM.
                const ownPage = !rendered && !!sender.url && isCurrentPage(url, sender.url);
                if (untrusted && !sameOriginAuthOk && !ownPage && !takeCredFetch(tabId, url)) {
                    sendResponse({ error: `Refused: an as-you fetch of "${url}" wasn't approved. A fetch AS THE USER (${rendered ? "rendered in your session" : "cookies"}) must be approved per-URL via the fetch_url tool; it can't run inline in exec or reuse a prior grant.` });
                    return;
                }
            } else {
                // UNCREDENTIALED: fetchOpen = an approved exec is running (its inline fetches are the human-approved
                // code); per-URL consent = the human approved EXACTLY this url (and it's remembered). SAME-ORIGIN is
                // FREE (no grant) — including a same-origin RENDER (it renders in your own session, no more than a
                // free same-origin navigate). A CROSS-origin uncredentialed render runs in INCOGNITO (no session) and
                // takes the rememberable consent path, same as a raw cross-origin GET.
                const execOpen = tabId != null && !!pendingGrants.get(tabId)?.fetchOpen;
                // SELF-SOURCE: an uncredentialed, non-rendered read of the agent's OWN repo source (committed files
                // / structural API, NOT a prose endpoint) is allowed WITHOUT a per-URL grant, gated on the config
                // flag. Enforced HERE, trusted-side (the client autoApprove only skips the prompt; the background is
                // the authority — a forged "self-source" can't make this true for a non-self URL). See self-source.ts.
                const selfSrc = !!cfg.autoApproveSelfSource && !rendered && isSelfSourceUrl(url, BUILD_INFO.repoUrl);
                if (untrusted && !sameOriginAsSender && !execOpen && !selfSrc && !(tabId != null && fetchConsent.get(tabId)?.has(url))) {
                    sendResponse({ error: `Refused: "${url}" hasn't been approved for fetching on this page. Use the fetch_url tool (each new URL is approved once, then remembered for the session), or call ml.fetch inside an approved exec.` });
                    return;
                }
            }
            const execOpen = tabId != null && !!pendingGrants.get(tabId)?.fetchOpen;
            try {
                // rendered: an uncredentialed render is INCOGNITO (session-less — a safe read, which is why a
                // same-origin one is free); a credentialed render uses the SESSION tab (as-you → always prompts).
                // A session (non-incognito) render is NEVER free. The `cdp` setting lets it emulate foreground so
                // a backgrounded tab's gated loads fire.
                // A table whose preview is not the whole of it hands back its body; it is stored only once the result is
                // actually released below.
                const kept: { body?: import("./sw-fetch").FetchedBody } = {};
                const data = rendered ? await fetchRenderedContent(url, !credentials, !!cfg.cdp) : await fetchUrlContent(url, credentials, format, (b) => { kept.body = b; });
                // Redirect guard: a per-URL-consented fetch (NOT a surface/whitelisted/exec one) that ends on a
                // DIFFERENT, un-consented origin followed a redirect off the approved resource — withhold the body
                // (a consented public URL could redirect to a private/other target). The GET already happened but
                // no data leaves, and returning nothing is safe. exec (execOpen) trusts the code's own redirects.
                if (untrusted && !execOpen) {
                    let sameOrigin = true;
                    try { sameOrigin = new URL(data.url).origin === new URL(url).origin; } catch { /* keep true */ }
                    if (!sameOrigin && !fetchConsent.get(tabId!)?.has(data.url)) {
                        sendResponse({ error: `"${url}" redirected to a different origin (${(() => { try { return new URL(data.url).origin; } catch { return data.url; } })()}), which hasn't been approved. Fetch that URL directly to approve it.` });
                        return;
                    }
                }
                if (kept.body) {
                    const key = await storeFetchedBody(kept.body, data.url);
                    // Handing the key over IS the claim (see pageValueSession): this is the only way a key reaches a
                    // page, so recording it here is what later lets that tab's PAGE-HOSTED run read the value, with no
                    // claim message to forge and no page-supplied run id to trust. A background-hosted run claims it
                    // again under its own session when the pointer is stored, which is what survives a navigation.
                    if (key) { data.valueKey = key; if (tabId != null) claimValue(key, pageValueSession(tabId)); }
                }
                sendResponse({ data });
            }
            catch (err) {
                const m = (err as Error)?.message || String(err);
                // A redirect loop / too-many-redirects surfaces as a generic "Failed to fetch" (Chrome opaques the
                // reason), so we can only HINT at it — the exact hops aren't visible to fetch.
                sendResponse({ error: `Could not fetch "${url}" (${m}). Possible causes: a redirect loop / too many redirects (the chain isn't visible to the extension), the extension lacking host access (grant "On all sites"), or the URL being unreachable.` });
            }
        })();
        return true;   // async
    }
    if (message.type === "OPEN_EXTENSIONS_PAGE") {
        // Deep-link to THIS extension's details page (where "Allow in Incognito" lives) — opened for the
        // Settings/popup "Incognito rendering" button. EXTENSION-ORIGIN ONLY (a page can't reach
        // chrome.runtime.onMessage, but guard anyway): the URL is derived here (browser-correct scheme +
        // chrome.runtime.id), never taken from the sender, so this can't be turned into an "open any URL".
        if (!(sender.url || "").startsWith(chrome.runtime.getURL(""))) { sendResponse({ error: "refused" }); return true; }
        let scheme = "chrome"; try { scheme = browserInfo().scheme; } catch { /* default */ }
        chrome.tabs.create({ url: `${scheme}://extensions/?id=${chrome.runtime.id}` })
            .then(() => sendResponse({ data: true }))
            .catch((e) => sendResponse({ error: (e as Error)?.message || String(e) }));
        return true;   // async
    }
    if (message.type === "FETCH_SHEET_TITLE") {
        // TITLE-ONLY, pre-approval: the approval card fetches just the sheet name so the USER sees WHICH
        // sheet they're granting (the MODEL never gets it). INTERNAL-ONLY — it's not in the content relay.
        // Gate on the sender's ORIGIN, not on sender.tab: the DevTools panel is a top-level extension page
        // (sender.tab == null), but the overlay/off-mode card is our extension-origin IFRAME embedded in a
        // page tab (sender.tab is SET, sender.url is our origin). The old `sender.tab != null` guard wrongly
        // refused that embedded card, so the HUD showed the generic "Google Sheet" instead of the real title.
        // A web page can't reach chrome.runtime.onMessage at all; a content script's sender.url is the page url.
        if (!(sender.url || "").startsWith(chrome.runtime.getURL(""))) { sendResponse({ data: null }); return true; }
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
        // `kinds: true` additionally reports each model's CAPABILITIES, so a picker can tell a chat model
        // from an embedding one. OPT-IN because it costs an /api/show per model (~60-110ms each, bounded
        // concurrency, cached for the worker's life): the settings and popup pickers want it, while the
        // composer and the VRAM panel just want names and must not pay for it.
        const wantKinds = !sender.tab && !!(message.payload as { kinds?: unknown })?.kinds;
        Promise.all([listAvailableModels(sender.tab ? {} : (message.payload || {})), getConfig()])
            .then(async ([{ ids, ollamaModels }, cfg]) => {
                const keep = (m: string) => modelFilterAllows(m, cfg.modelFilter);
                const data = ids.filter(keep);
                const info = wantKinds ? await modelCapabilitiesBatch(cfg, data) : undefined;
                sendResponse({ data, ollamaModels: ollamaModels ? ollamaModels.filter(keep) : null, ...(info ? { kinds: info.caps, dims: info.dims } : {}) });
            })
            .catch(err => sendResponse({ error: err.message }));
        return true;

    } else if (message.type === "OLLAMA_INFO") {
        // Read-only machine CAPACITY (per-device VRAM, system RAM). No sender gating, for the same reason as
        // OLLAMA_PS: it exposes nothing about the URL or key, only what hardware the box has. Resolves to null
        // when the route isn't served, which the page must read as "unknown", never as zero.
        fetchOllamaInfo()
            .then(info => sendResponse({ data: info }))
            .catch(e => sendResponse({ error: String((e as Error)?.message || e) }));
        return true;
    } else if (message.type === "USER_FOCUS") {
        // chat_metadata's "user focus" line, relative to the SENDER's own tab and always COARSE: it names no other
        // site, since the asking page reads the answer. What coarse reveals (another tab, the chat page, away from the
        // browser) is no more than a page can infer from its own focus and visibility, bar that the chat page is
        // open. A sender with no tab gets nothing: this is a page's question about itself.
        const tabId = sender.tab?.id;
        const hash = typeof message.payload?.hash === "string" ? message.payload.hash.slice(0, 64) : "";
        if (tabId == null) { sendResponse({ data: null }); return; }
        focusLineFor(hash, tabId, "coarse").then((line) => sendResponse({ data: line })).catch(() => sendResponse({ data: null }));
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
                    model: config.model, ocrModel: config.ocrModel, ocrNumCtx: config.ocrNumCtx, apiFormat: config.apiFormat,
                    defaultModelVision: config.defaultModelVision,
                    utilityModel: config.utilityModel, utilityNumCtx: config.utilityNumCtx, utilityForceCpu: config.utilityForceCpu,
                    autoApproveReadonly: config.autoApproveReadonly, autoApprovePython: config.autoApprovePython,
                    serverToolsOff: config.serverToolsOff || [], commanderServerTools: config.commanderServerTools || [],
                    autoApproveSameOriginAuth: config.autoApproveSameOriginAuth, autoApproveSelfSource: config.autoApproveSelfSource,
                    pierceClosedShadow: config.pierceClosedShadow, cdp: config.cdp,
                    groundingEnabled: config.groundingEnabled, groundingModel: config.groundingModel,
                    groundingRange: config.groundingRange, debugMode: config.debugMode, pageApprovalAllowed,
                } });
            })
            .catch(err => sendResponse({ error: err.message }));
        return true;

    } else if (message.type === "EMBED") {
        // Embedding runs on the user's own box like any other model call, so a page may ask — the same
        // reasoning that lets a page call ml.chat. An explicit model still passes the access whitelist, so a
        // page cannot reach a model the user excluded, and the resolved model is reported back so a caller
        // can see WHICH geometry the vectors are in (comparing across models is meaningless).
        (async () => {
            const inputs = (message.payload as { inputs?: unknown })?.inputs;
            const asked = String((message.payload as { model?: unknown })?.model || "");
            if (!Array.isArray(inputs) || inputs.some((i) => typeof i !== "string")) { sendResponse({ error: "EMBED needs `inputs`: an array of strings." }); return; }
            try {
                const cfg = await getConfig();
                const model = asked || cfg.embeddingModel;
                if (asked && !modelFilterAllows(asked, cfg.modelFilter)) { sendResponse({ error: `Refused: "${asked}" is excluded by the model filter.` }); return; }
                sendResponse({ data: { model, vectors: await embedTexts(cfg, model, inputs as string[]) } });
            } catch (e) { sendResponse({ error: (e as Error)?.message || String(e) }); }
        })();
        return true;

    } else if (message.type === "MODEL_CAPS") {
        getConfig()
            .then(config => modelCapabilities(config, (message.payload && message.payload.model) || config.model))
            .then(caps => sendResponse({ data: caps }))
            .catch(err => sendResponse({ error: err.message }));
        return true;

    } else if (message.type === "DUMP_EVENTS") {
        // `ml.__events()` — everything the panel derives its timeline FROM, in one object, so a lane that
        // draws something impossible can be reproduced instead of described. Deliberately the raw INPUTS
        // rather than the drawn events: the derivation (`eventsFrom` + `machineEventFrom`) is pure and
        // shared, so a fixture built from these exercises the real thing rather than a snapshot of its
        // output. Exposes nothing the page cannot already see — the debug stream is what the page itself
        // emitted, and the frames are machine capacity, no URL and no key.
        (async () => {
            const tabId = sender.tab?.id;
            sendResponse({ data: {
                capturedAt: Date.now(),
                tabId: tabId ?? null,
                debug: tabId != null ? (debugBuffer.get(tabId) || []) : [],
                frames: recentFrames(),
                stream: resourceStreamStatus(),
                ps: await listLoadedModels().catch(() => null),
                info: await fetchOllamaInfo().catch(() => null),
            } });
        })();
        return true;

    } else if (message.type === "HOUSEKEEPING_REPORT") {
        // Another context (the offscreen doc, a page's fetch cache) reporting what it decided. `origin` comes
        // from `sender`, never the payload; nothing reads the log to decide anything, so a page may report.
        sendResponse(handleHousekeepingReport(message.payload, sender));
        return;

    } else if (message.type === "DUMP_HOUSEKEEPING") {
        // `ml.__housekeeping()` and the DevTools panel. A page sees another tab's events without their key/detail.
        handleHousekeepingDump(message.payload, sender).then(sendResponse, (e) => sendResponse({ error: String((e as Error)?.message || e) }));
        return true;

    } else if (message.type === "SESSION_STORAGE_STATS") {
        // Extension pages only. The answer lists session hashes, and a saved session is readable by any page that
        // knows its hash, so a page must never be able to ask for the list.
        if (senderOrigin(sender) === "page") { sendResponse({ error: "Refused: session storage stats are for extension pages." }); return; }
        sessionStorageStats().then((data) => sendResponse({ data }), (e) => sendResponse({ error: String((e as Error)?.message || e) }));
        return true;

    } else if (message.type === "STORAGE_HISTORY") {
        // The DevTools Settings Storage section. Extension pages only, like SESSION_STORAGE_STATS: it names sessions.
        if (senderOrigin(sender) === "page") { sendResponse({ error: "Refused: storage history is for extension pages." }); return; }
        if (!sessionStore) { sendResponse({ data: null }); return; }
        storageReport().then((data) => sendResponse({ data }), (e) => sendResponse({ error: String((e as Error)?.message || e) }));
        return true;

    } else if (message.type === "ARCHIVE_FOLDER") {
        // Settings' archive folder section: its state, or what to do after a click. Extension pages only.
        if (senderOrigin(sender) === "page") { sendResponse({ error: "Refused: the archive folder is for extension pages." }); return; }
        folderAction((message.payload as { action?: unknown } | undefined)?.action).then((data) => sendResponse({ data }), (e) => sendResponse({ error: String((e as Error)?.message || e) }));
        return true;

    } else if (message.type === "HUB_RUNTIME") {
        // This browser as a runtime on a hub: where it stands, or what just happened in the page that paired it
        // (`paired`: read the keyring again; `left`: stop), its allowlist (`devices`, `revoke` + `principal`), and its history (`log`). Extension pages only — a page's main world must not
        // even learn whether this browser is reachable from elsewhere.
        if (senderOrigin(sender) === "page") { sendResponse({ error: "Refused: the hub connection is for extension pages." }); return; }
        const { action, principal } = (message.payload ?? {}) as { action?: unknown; principal?: unknown };
        if (action === "devices") { void ensureHubRuntime().then(() => sendResponse({ data: hubDevices() })); return true; }
        if (action === "log") { void hubLog().then((data) => sendResponse({ data })); return true; }
        if (action === "revoke") {
            revokeHubDevice(String(principal ?? "")).then((data) => sendResponse({ data }), (e) => sendResponse({ error: String((e as Error)?.message || e) }));
            return true;
        }
        if (action === "left") stopHubRuntime();
        const ready = action === "paired" ? (stopHubRuntime(), ensureHubRuntime()) : Promise.resolve();
        ready.then(() => sendResponse({ data: hubState() }), (e) => sendResponse({ error: String((e as Error)?.message || e) }));
        return true;

    } else if (message.type === "DUMP_LOADS") {
        // `ml.__loads()` — the per-load records kept for tuning the VRAM predictor (see load-records.ts). Machine
        // facts only, like DUMP_EVENTS: no URL, no key. Clearing them is harmless to anything but the collection,
        // so a page may ask; they are only ever gathered while the user has the toggle on.
        (async () => {
            const got = await chrome.storage.local.get({ [LOAD_RECORDS_KEY]: [] });
            if ((message.payload as { clear?: boolean } | undefined)?.clear) await chrome.storage.local.set({ [LOAD_RECORDS_KEY]: [] });
            sendResponse({ data: got[LOAD_RECORDS_KEY] });
        })().catch((e) => sendResponse({ error: String((e as Error)?.message || e) }));
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
        const doCapture = () => sender.tab
            ? chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" })
            : chrome.tabs.captureVisibleTab({ format: "png" });
        (async () => {
            const cfg = await getConfig();
            const tabId = sender.tab?.id;
            // PREFER CDP when it's enabled: Page.captureScreenshot captures the SAME viewport at the SAME device
            // pixel ratio as captureVisibleTab (verified: 800x600@2 → 1600x1200), so the coordinate math is
            // identical — but it works on strict / "On click" pages with NO host grant (the debugger is exempt,
            // like exec/click) and is NOT subject to captureVisibleTab's ~2/sec quota. The debugger is attached
            // once per run (reused), so a multi-look run shows the infobar steadily rather than per-shot.
            let cdpErr = "";
            if (cfg.cdp && tabId != null) {
                const shot = await cdpScreenshot(tabId);
                if ("ok" in shot) { sendResponse({ data: shot.dataUrl }); return; }
                cdpErr = shot.error;   // attach conflict (real DevTools open) / no debugger permission → fall back below
            }
            // Fallback (CDP off, or its attach failed): captureVisibleTab. Chrome RATE-LIMITS it (~2/sec —
            // MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND); a burst of look()/locate() trips a TRANSIENT quota error
            // the model can't act on, so wait out the ~1s window and retry a few times before surfacing it.
            for (let attempt = 0; ; attempt++) {
                try { sendResponse({ data: await doCapture() }); return; }
                catch (err) {
                    const emsg = (err as Error)?.message || String(err);
                    if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(emsg) && attempt < CAPTURE_RETRIES) {
                        await new Promise(r => setTimeout(r, CAPTURE_RETRY_MS)); continue;
                    }
                    // captureVisibleTab needs activeTab OR <all_urls> specifically (Chromium's
                    // kActiveTabOrAllUrls) — a per-HOST grant like github.com does NOT satisfy it, and "On click"
                    // withholds <all_urls> while a navigation revokes activeTab. The clean fix is the debugger
                    // (exempt), so steer to CDP; a per-host grant would be a dead end.
                    if (/all_urls|activeTab|permission is required/i.test(emsg)) {
                        const cdpNote = cdpErr
                            ? ` The debugger route (CDP) is enabled but couldn't attach here (${cdpErr}) — close Chrome DevTools on this tab if it's open, then retry.`
                            : " Easiest fix: enable \"Debugger-based actions (CDP)\" in window.ml Settings → Advanced — then look/locate screenshot via the debugger (exempt from site access), exactly how exec works here.";
                        sendResponse({ error:
                            `Can't screenshot this page — captureVisibleTab needs "On all sites" access; a per-site grant like this host does NOT enable it.${cdpNote} ` +
                            "Alternatively set the extension's site access to \"On all sites\" (right-click the toolbar icon → \"This can read and change " +
                            "site data\" → \"On all sites\"). Then ask me to look again."
                        });
                        return;
                    }
                    sendResponse({ error: emsg }); return;
                }
            }
        })();
        return true;

    } else if (message.type === "SAVE_SESSION") {
        // Persist a { save:true } chat session so ml.resumeChat can rehydrate it
        // across reloads/tabs. Page-provided message history + createChat options
        // — no secrets (URL/key never live in a session). Main world can't touch
        // storage, hence this round-trip.
        // ONE writer (sw-sessions.ts): the same call the worker's own chats make, so the record on disk and the
        // saved session's history can never disagree about what this chat is.
        const { hash, session } = message.payload || {};
        saveChatSession(hash, session)
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

// The resource panel's live feed. ONE connection to the server's event stream per worker, fanned out to
// every open panel — see sw-events.ts, which also owns the reconnect and the backfill that makes an evicted
// worker cost latency rather than history.
chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "ml-resource") return;
    subscribeResourceEvents(port);
});

// The chat page's local host: the cross-tab session index and each session's events (sw-sessions.ts).
chrome.runtime.onConnect.addListener(serveSessionsPort);

/** Abort a background-hosted run and close its open gates. Returns whether there was anything live to stop. */
function cancelBackgroundRun(runId: string): boolean {
    const ctl = runControllers.get(runId);
    if (ctl) ctl.abort();
    let gates = 0;
    // If the run is BLOCKED on an OPEN approval gate, aborting the controller alone can't unblock it — the
    // gate promise only resolves via SET_APPROVAL. So resolve any pending gate for this run now with an
    // explicit CANCELLATION (`{ approved:false, cancelled:true }`), NOT a bare `false`: the loop then exits
    // as cancelled even when the controller is GONE (an evicted/re-adopted run, where `ctl` above is
    // undefined so the signal never aborts). A bare `false` there read as a DENY → the loop stepped on
    // forever ("auto-denied + can't Stop", the reported bug). A later SET_APPROVAL click finds no entry — a
    // harmless no-op.
    for (const [key, entry] of [...pendingApprovals]) {
        if (key.startsWith(`${runId}:`)) { pendingApprovals.delete(key); entry.resolve({ approved: false, cancelled: true }); gates++; }
    }
    return !!ctl || gates > 0;
}

// The chat page's commands reach the runs through these; everything else they need is the browser's (sw-sessions.ts).
let chatSteerSeq = 0;
configureSessionCommands({
    // A steer from the chat page goes into the running loop's inbox, the same one a handle's say() reaches through
    // INJECT_MESSAGE, and is shown the way say() shows it: an `agent-say` bubble the loop marks seen when it drains.
    steer: (hash, text) => {
        const inbox = runInboxes.get(hash);
        if (!inbox) return false;
        const sayId = `sc_${Date.now().toString(36)}_${++chatSteerSeq}`;
        inbox.queue.push({ id: sayId, text });
        const event = { kind: "agent-say", id: hash, ts: Date.now(), save: false, session: { hash, turn: 0 }, text, sayId };
        chrome.tabs.sendMessage(inbox.tabId, { type: "ML_DEBUG_TO_PAGE", event }).catch(() => { /* tab gone */ });
        relayDebugEvent(inbox.tabId, event);
        ingestSessionEvent(event, { tabId: inbox.tabId, trusted: true });
        bufferReplay(inbox.tabId, event);
        return true;
    },
    cancelRun: cancelBackgroundRun,
    resolveApproval: (key, decision) => resolveApproval(key, decision.approved
        ? { approved: true, source: "user", ...(decision.persist ? { persist: true } : {}) }
        : { approved: false, source: "user", ...(decision.feedback ? { feedback: decision.feedback } : {}) }),
    forgetRun: (hash) => {
        if (runControllers.has(hash)) return;   // never a live run: the command refuses those first
        bgRuns.delete(hash); hydratedRuns.delete(hash); releaseSessionTokens(hash);
        deleteRun(hash);
    },
});

chrome.runtime.onConnect.addListener(serveDevtoolsPort);

// The Spotlight command bar keyboard shortcut (manifest `commands`, default Alt+Space, user-rebindable
// at chrome://extensions/shortcuts). Tell the active tab's shell to open the HUD composer; the shell
// no-ops unless the HUD is the active surface. `chrome.commands` may be absent in a test harness.
chrome.commands?.onCommand.addListener((command, tab) => {
    if (command === "open-composer" && tab?.id != null)
        chrome.tabs.sendMessage(tab.id, { type: "ML_OPEN_COMPOSER" }).catch(() => { /* no content script on this tab */ });
});

// Right-click "Ask window.ml about this" — the content-script shell resolves the clicked element's
// semantic container + clean context and opens the Commander pre-loaded with it (see shell.ts). Created on
// install (persists); re-created defensively in case the item was cleared. contextMenus may be absent in tests.
chrome.runtime.onInstalled?.addListener((details) => {
    // A deliberate reload or an update (NOT an idle SW respawn — that never fires onInstalled): invalidate any
    // in-flight background run. Its snapshot may be from OLD code, and this is often how you kill a runaway —
    // it must never silently resume across the reload. hydrate() may have loaded old snapshots into memory a
    // moment ago on this same spawn; purge those too.
    if (details?.reason === "install" || details?.reason === "update") void purgeAllBgRuns();
    try {
        chrome.contextMenus?.removeAll?.(() => {
            // Fresh run.
            chrome.contextMenus?.create({ id: "ml-ask-about-this", title: "Ask window.ml about this…", contexts: ["all"] });
            // Append to the run already open in the HUD (steer if running, follow-up if idle). Falls back to a
            // fresh composer page-side when nothing's open, so it's never a dead entry.
            chrome.contextMenus?.create({ id: "ml-add-to-run", title: "Add this to the current window.ml run…", contexts: ["all"] });
        });
    } catch { /* not available */ }
});
chrome.contextMenus?.onClicked.addListener((info, tab) => {
    if (tab?.id == null) return;
    if (info.menuItemId === "ml-ask-about-this")
        chrome.tabs.sendMessage(tab.id, { type: "ML_ASK_ABOUT_THIS" }).catch(() => { /* no content script on this tab */ });
    else if (info.menuItemId === "ml-add-to-run")
        chrome.tabs.sendMessage(tab.id, { type: "ML_ADD_TO_CURRENT_RUN" }).catch(() => { /* no content script on this tab */ });
});

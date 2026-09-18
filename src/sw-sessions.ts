// The background's session index, as the chat page's local host sees it: one `SessionIndex` for this worker's life,
// served over the `ml-sessions` port to extension pages (session-server.ts). background.ts feeds it from the same
// places that feed the DevTools panel, so the index holds what a panel would show for every tab at once
// (docs/dev/chat-page.md §The local index).
import { hintSession } from "./contract";
import { type MlDebugEvent } from "./contract-debug";
import { createCommandHandler, type CommandDeps, type PageOutcome } from "./session-commands";
import { cancelBackgroundChat, configureBackgroundChats, forgetBackgroundChat, isBackgroundChat, sendBackgroundChat, startBackgroundChat } from "./sw-chat";
import { SESSION_CONTRACT_VERSION, type Command, type CommandResult, type CommandType, type RuntimeInfo, type TabInfo } from "./session-host";
import { SessionIndex, type IngestSource } from "./session-index";
import { SESSIONS_PORT, SessionServer } from "./session-server";
import { fetchLLM } from "./sw-llm";

/** This browser's runtime id until the extension has a key to derive one from (docs/spec/SESSION_CONTRACT.md). */
export const LOCAL_RUNTIME = "local";

/** A new value per worker life, so a stream position from an evicted worker never resumes. */
const spawn = (() => {
    try { const b = new Uint8Array(4); crypto.getRandomValues(b); return [...b].map((x) => x.toString(16).padStart(2, "0")).join(""); }
    catch { return Math.random().toString(16).slice(2, 10); }
})();

/** Whether a utility model is set (see the storage listener below). */
let utilityModelSet = false;
/** The page a blank agent target opens when the command names none (see the storage listener below). */
let agentStartPage = "";

/** How long a freshly opened tab gets to load the extension into itself before a run on it is given up on. */
const TAB_READY_MS = 15_000, TAB_POLL_MS = 250;

/** The local runtime as the chat page sees it. Capabilities are added as each command lands. */
function localRuntime(): RuntimeInfo {
    return {
        id: LOCAL_RUNTIME, name: "This browser", kind: "browser", online: true, contractVersion: SESSION_CONTRACT_VERSION,
        capabilities: { chat: true, agent: true, tabs: true, highlight: true, screenshots: true, sideCalls: utilityModelSet },
        // This browser's own pages hold every scope.
        grants: [{ scope: "view" }, { scope: "drive" }, { scope: "approve" }, { scope: "screen" }],
    };
}

/** What only background.ts can do, because it owns the runs: set once at startup by `configureSessionCommands`. */
export type RunDeps = Pick<CommandDeps, "steer" | "cancelRun" | "resolveApproval"> & {
    /** drop a finished run's resumable snapshot and pointer store */
    forgetRun(hash: string): void;
};

let handler: ((command: Command) => Promise<CommandResult<CommandType>>) | null = null;

async function runCommand(command: Command): Promise<CommandResult<CommandType>> {
    if (!handler) return { ok: false, error: { code: "unavailable", message: "the extension's worker is still starting" } };
    return handler(command);
}

const tabInfo = (t: chrome.tabs.Tab): TabInfo | null =>
    t.id == null ? null : { tabId: t.id, url: t.url || "", title: t.title || "", active: !!t.active, ...(t.windowId != null ? { windowId: t.windowId } : {}) };

const CAPTURE_RETRIES = 5, CAPTURE_RETRY_MS = 550;   // captureVisibleTab allows about two calls a second

/** Wire the command handler to the browser and to background.ts's runs. */
export function configureSessionCommands(run: RunDeps): void {
    // A worker-hosted chat has no tab, so its transcript reaches the index from here and nowhere else (sw-chat.ts
    // says why that is not the double-feed AGENTS.md warns about).
    configureBackgroundChats({
        emit: (event) => ingestSessionEvent(event, { trusted: true }),
        call: async (req, signal) => await fetchLLM(req, signal) as import("./contract").LlmResult,
        load: async (hash) => {
            const key = `ml_session_${hash}`;
            try { return ((await chrome.storage.local.get(key)) as Record<string, never>)[key] ?? null; } catch { return null; }
        },
        save: async (hash, session) => { await chrome.storage.local.set({ [`ml_session_${hash}`]: session }); },
        now: () => Date.now(),
    });
    handler = createCommandHandler({
        runtime: LOCAL_RUNTIME,
        index: sessionServer.index,
        removeFromIndex: (id) => { sessionServer.remove(id); },
        listTabs: async () => (await chrome.tabs.query({})).filter((t) => /^https?:/.test(t.url || "")).map(tabInfo).filter((t): t is TabInfo => !!t),
        getTab: async (tabId) => { try { return tabInfo(await chrome.tabs.get(tabId)); } catch { return null; } },
        toPage: async (tabId, action, body) => {
            const reqId = Math.random().toString(36).slice(2, 12);
            const reply = await chrome.tabs.sendMessage(tabId, { type: "ML_SESSION_TO_PAGE", action, ...body, reqId }) as { outcome?: PageOutcome } | undefined;
            return reply?.outcome ?? "no-answer";
        },
        highlight: (tabId, ref) => { chrome.tabs.sendMessage(tabId, { type: "ML_HL_REMOTE", ref, anyMode: true }).catch(() => { /* tab gone */ }); },
        steer: run.steer,
        cancelRun: run.cancelRun,
        resolveApproval: run.resolveApproval,
        forgetStored: async (hash) => {
            run.forgetRun(hash);
            forgetBackgroundChat(hash);
            try { await chrome.storage.local.remove(`ml_session_${hash}`); } catch { /* storage unavailable */ }
        },
        startChat: (opts) => startBackgroundChat(opts),
        startAgent: async (tabId, opts) => {
            const reqId = Math.random().toString(36).slice(2, 12);
            const reply = await chrome.tabs.sendMessage(tabId, { type: "ML_START_AGENT", reqId, ...opts }) as { outcome?: PageOutcome | "started"; hash?: string } | undefined;
            return { outcome: reply?.outcome ?? "no-answer", ...(reply?.hash ? { hash: reply.hash } : {}) };
        },
        openTab: async (url) => {
            const tab = await chrome.tabs.create({ url, active: true });
            if (tab.id == null) throw new Error("the browser opened a tab with no id");
            // Wait for `window.ml` to EXIST in the new page, not for the tab to report "complete" and not for the
            // content script to answer. The content script registers its listener before `injected.js` runs, so a
            // start relayed on that signal reaches a page whose `__mlStartAgent` listener is not there yet, and the
            // run is lost to a timeout. What the run needs is the main world, so that is what this asks.
            const until = Date.now() + TAB_READY_MS;
            for (;;) {
                try {
                    const [probe] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: () => !!(window as { ml?: unknown }).ml });
                    if (probe?.result === true) return tab.id;
                } catch { /* still loading, or the extension cannot script this page yet */ }
                if (Date.now() > until) throw new Error("the new tab never loaded window.ml (the extension may not be allowed to run there)");
                await new Promise((r) => setTimeout(r, TAB_POLL_MS));
            }
        },
        startPage: () => agentStartPage,
        sendChat: (hash, text, images) => sendBackgroundChat(hash, text, images),
        cancelChat: (hash) => cancelBackgroundChat(hash),
        hostsChat: (hash) => isBackgroundChat(hash),
        utilityConfigured: () => utilityModelSet,
        sideCall: async ({ messages, schema, maxTokens, session }) => {
            const r = await fetchLLM({
                messages, extend: "utility", maxTokens, think: false,
                ...(schema ? { schema: schema as never } : {}),
                hint: { use: "utility", ...(session ? { session: hintSession(session) } : {}) },
            }) as { content: string | null; usage?: unknown };
            return { content: r.content ?? "", usage: r.usage };
        },
        captureVisible: async (windowId, opts) => {
            for (let attempt = 0; ; attempt++) {
                try { return await chrome.tabs.captureVisibleTab(windowId, opts); }
                catch (err) {
                    if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test((err as Error)?.message || "") && attempt < CAPTURE_RETRIES) {
                        await new Promise((r) => setTimeout(r, CAPTURE_RETRY_MS));
                        continue;
                    }
                    throw err;
                }
            }
        },
        now: () => Date.now(),
    });
}

/** The index and its server, for this worker's life. */
export const sessionServer = new SessionServer(new SessionIndex({ runtime: LOCAL_RUNTIME, spawn }), { runtime: localRuntime, command: runCommand });

// Kept current from storage: `side.call` needs a utility model, and the runtime's capabilities say whether it has one.
// After `sessionServer` exists, since a storage callback may run synchronously.
try {
    chrome.storage.sync.get({ utilityModel: "", agentStartPage: "" }, (cfg) => {
        utilityModelSet = !!String(cfg?.utilityModel ?? "").trim();
        agentStartPage = String(cfg?.agentStartPage ?? "").trim();
        sessionServer.runtimeChanged();
    });
    chrome.storage.onChanged?.addListener((changes, area) => {
        if (area !== "sync") return;
        if (changes.agentStartPage) agentStartPage = String(changes.agentStartPage.newValue ?? "").trim();
        if (!changes.utilityModel) return;
        utilityModelSet = !!String(changes.utilityModel.newValue ?? "").trim();
        sessionServer.runtimeChanged();
    });
} catch { /* no storage (a test harness) */ }

/** Fold one debug event into the index. Never throws: a malformed event must not break the relay it rides beside. */
export function ingestSessionEvent(event: unknown, source: IngestSource): void {
    try { sessionServer.ingest(event as MlDebugEvent, source); } catch { /* refused */ }
}

/** The sender tab's URL and title, as the browser reports them. */
export function senderPage(tab: chrome.tabs.Tab | undefined): IngestSource["page"] {
    return tab?.url ? { url: tab.url, ...(tab.title ? { title: tab.title } : {}) } : undefined;
}

/** Serve an `ml-sessions` port, if an extension page opened it. A content script's sender URL is its page's, so this
 *  refuses every page: the index spans every tab, and a page's main world is hostile. */
export function serveSessionsPort(port: chrome.runtime.Port): void {
    if (port.name !== SESSIONS_PORT) return;
    if (!(port.sender?.url || "").startsWith(chrome.runtime.getURL(""))) {
        try { port.disconnect(); } catch { /* already gone */ }
        return;
    }
    sessionServer.attach(port);
}

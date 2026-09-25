// The background's session index, as the chat page's local host sees it: one `SessionIndex` for this worker's life,
// served over the `ml-sessions` port to extension pages (session-server.ts). background.ts feeds it from the same
// places that feed the DevTools panel, so the index holds what a panel would show for every tab at once
// (docs/dev/chat-page.md §The local index).
import { hintSession } from "./contract-run";
import { type MlDebugEvent } from "./contract-debug";
import { createCommandHandler, type CommandDeps, type PageOutcome } from "./session-commands";
import { cancelBackgroundChat, configureBackgroundChats, forgetBackgroundChat, isBackgroundChat, sendBackgroundChat, setBackgroundChatModel, startBackgroundChat } from "./sw-chat";
import { type StoredSession } from "./contract-messages";
import { SESSION_CONTRACT_VERSION, type Command, type CommandResult, type CommandType, type ArchiveCapability, type BlankStartCapability, type RuntimeInfo, type SessionSummary, type TabGroupInfo, type TabInfo } from "./session-host";
import { FaviconCache, stripOrder } from "./tab-favicons";
import { tabReadyFailure } from "./tab-ready";
import { browserInfo } from "./util";
import { SessionIndex, type IngestSource } from "./session-index";
import { SESSIONS_PORT, SessionServer } from "./session-server";
import { STORE_MAX_SESSIONS, SessionStore, indexedDbBackend, type SessionHistory } from "./session-store";
import { AGENT_START_PAGE, DEFAULT_CONFIG, modelFilterAllows } from "./contract-config";
import type { NeutralMessage } from "./contract-chat";
import { cleanTitle, titleMessages } from "./session-title";
import { bgRuns, trackRun, untrackRun } from "./sw-runs";
import { fetchLLM, getConfig, listAvailableModels, modelCapabilitiesBatch } from "./sw-llm";
import { pythonBundlePresent } from "./sw-python";
import { recordHousekeeping } from "./sw-housekeeping";
import { archiveCall, lastFolderReport, onFolderChange, scheduleFolderSync } from "./sw-archive";
import { attentionCodes, recomputeAttention, refreshBackendAttention, watchAttention } from "./sw-attention";
import { appendSnapshot, measureEvents, summarizeStore, type StorageReport, type StorageSnapshot, type StoreBytes } from "./session-storage-stats";

/**
 * What this browser is called before it has a key to derive an id from (docs/spec/SESSION_CONTRACT.md), and the
 * ALIAS it answers to afterwards.
 *
 * It stops being this browser's id the moment the browser is paired: over a hub the same browser is its principal,
 * a SHA-256 of its identity key, and a client that saw `"local"` from one host and a hash from the other would list
 * one browser twice — dedupe is by id, so two ids never collide and no priority rule ever fires.
 *
 * So the id is READ, never assumed (`localRuntimeId`), and this constant remains something the runtime answers to.
 * A page open across a pairing, a bookmarked `#s=local:<hash>`, and a session key kept on disk all keep working;
 * without the alias they would each become a session on a runtime that no longer exists.
 */
export const LOCAL_RUNTIME = "local";

/**
 * This browser's runtime id: its principal once it is paired, and {@link LOCAL_RUNTIME} until then.
 *
 * A function rather than a constant so that nothing in the codebase can hold the assumption that this browser is
 * called `"local"` — the assumption is invisible once it is spread, and the hub connector is where it would bite.
 */
export function localRuntimeId(): string {
    return LOCAL_RUNTIME;
}

/** Is `id` this browser, by either name? `"local"` stays an alias for whatever this browser's id currently is. */
export function isLocalRuntime(id: unknown): boolean {
    return id === localRuntimeId() || id === LOCAL_RUNTIME;
}

/** A new value per worker life, so a stream position from an evicted worker never resumes. */
const spawn = (() => {
    try { const b = new Uint8Array(4); crypto.getRandomValues(b); return [...b].map((x) => x.toString(16).padStart(2, "0")).join(""); }
    catch { return Math.random().toString(16).slice(2, 10); }
})();

/** Whether a utility model is set (see the storage listener below). */
let utilityModelSet = false;
/** Whether this build can run Python (`pythonBundlePresent`): false until the bundle has been looked at, so a client
 *  never offers a bench on a guess. */
let pythonBundled = false;
/** whether `pythonBundled` has been measured yet (an unmeasured build is never reported as missing its wheels) */
let pythonMeasured = false;
/** The page a blank agent target opens when the command names none (see the storage listener below). */
let agentStartPage = "";

/** How long a freshly opened tab gets to load the extension into itself before a run on it is given up on. */
const TAB_READY_MS = 15_000, TAB_POLL_MS = 250;

/** The local runtime as the chat page sees it. Capabilities are added as each command lands. */
function localRuntime(): RuntimeInfo {
    return {
        id: localRuntimeId(), name: "This browser", kind: "browser", online: true, contractVersion: SESSION_CONTRACT_VERSION,
        // `resourcePanel` and `pythonBench` are not commands: they say the box behind this runtime can be drawn and
        // its sandbox can be driven, which a client offers only where it ALSO holds an implementation (the chat
        // page's `ChatExtras`). A phone reaching this same runtime over the hub reports the capability and draws
        // nothing, because it has nothing to draw with. `resourcePanel` is true by construction (a browser with a
        // backend behind it); `pythonBench` is MEASURED, because a checkout without the wheels builds a bundle whose
        // bench would fail at run time. `localSettings`: this browser's pages may edit its settings, which only the
        // extension's own pages can (a phone over the hub reports the capability and holds nothing to edit with).
        capabilities: { chat: true, agent: true, tabs: true, highlight: true, screenshots: true, sideCalls: utilityModelSet, persistence: !!sessionStore, resourcePanel: true, pythonBench: pythonBundled, localSettings: true, switchModel: true, ...archiveCapability(), ...blankStartCapability(), ...(attentionCodes().length ? { attention: attentionCodes() } : {}) },
        // This browser's own pages hold every scope.
        grants: [{ scope: "view" }, { scope: "drive" }, { scope: "approve" }, { scope: "screen" }],
    };
}

/** Where a blank run goes, and whether this browser may open it — the PRECISE answer the coarse `site-access`
 *  attention code cannot give, since that one asks only whether `<all_urls>` is held. Read from a cache the
 *  permission listeners refresh, because assembling a runtime's description must not await anything. */
function blankStartCapability(): { blankStart?: BlankStartCapability } {
    const url = (agentStartPage || "").trim() || AGENT_START_PAGE;
    if (!/^https?:\/\//i.test(url)) return {};
    return { blankStart: {
        url, granted: blankStartGranted,
        ...(blankStartGranted || !blankStartOrigins.length ? {} : { origins: blankStartOrigins }),
        ...(browserName ? { browser: browserName } : {}),
        ...(chrome.runtime?.id ? { extensionId: chrome.runtime.id } : {}),
    } };
}

/** What this browser calls itself, for a client wording the fix for THIS machine while reading it on another. */
const browserName = browserInfo().name;

/** Where this browser COULD start a blank run today, when it may not start one at the configured page: the origins
 *  it already holds. Empty while everything is granted (there is nothing to propose) and while nothing is. */
let blankStartOrigins: string[] = [];

/** How many already-granted sites are worth proposing. A list this long is a picker; longer is an inventory. */
const PROPOSE_MAX = 20;

/** Host access for the blank-start page's origin, as last read. Starts true so nothing is accused before the first
 *  answer: a warning that turns out to be wrong costs more than one that arrives a moment late. */
let blankStartGranted = true;

/** Re-read it and announce the runtime again when the answer moved. Called at start, on a permission change, and
 *  when the start page setting is edited — a new URL is a new origin, and the old answer does not carry over. */
export async function refreshBlankStart(): Promise<void> {
    const url = (agentStartPage || "").trim() || AGENT_START_PAGE;
    let next = true;
    try {
        const origin = new URL(url).origin + "/*";
        next = typeof chrome.permissions?.contains === "function"
            ? await chrome.permissions.contains({ origins: [origin] }).catch(() => true)
            : true;
    } catch { next = true; }   // not a URL we can ask about: do not accuse it
    // Blocked: what CAN this browser open? On a remote runtime that is the only route out, since no client can
    // grant a permission on another machine. Read only while blocked, so a working runtime ships no site list.
    let origins: string[] = [];
    if (!next) {
        const all = await chrome.permissions?.getAll?.().catch(() => null);
        origins = (all?.origins ?? [])
            .filter((o) => /^https?:\/\//i.test(o) && o !== "<all_urls>")
            .slice(0, PROPOSE_MAX);
    }
    if (next === blankStartGranted && origins.join() === blankStartOrigins.join()) return;
    blankStartGranted = next;
    blankStartOrigins = origins;
    sessionServer.runtimeChanged();
}

/** The archive's entry in the capabilities: absent while it is off, and "none" until its folder was first read. */
function archiveCapability(): { archive?: ArchiveCapability } {
    if (!archiveOn || !sessionStore) return {};
    const f = lastFolderReport();
    return { archive: { folder: f?.state ?? "none", ...(f?.pending ? { pending: f.pending } : {}), ...(f?.lastSync ? { lastSync: f.lastSync } : {}) } };
}

/** The archive was switched on, or the worker started with it on: read the folder's state, which announces itself
 *  through `onFolderChange`. Switched off, the capability goes now. */
function archiveToggled(): void {
    sessionServer.runtimeChanged();
    recomputeAttention();
    if (archiveOn) void archiveCall("folder").catch(() => { /* no OPFS: the capability stays "none" */ });
}

/** What only background.ts can do, because it owns the runs: set once at startup by `configureSessionCommands`. */
export type RunDeps = Pick<CommandDeps, "steer" | "cancelRun" | "resolveApproval" | "setRunModel"> & {
    /** drop a finished run's resumable snapshot and pointer store */
    forgetRun(hash: string): void;
};

let handler: ((command: Command) => Promise<CommandResult<CommandType>>) | null = null;

/** Run one contract command through the same handler the extension's pages use: the hub connection's way in. */
export function runSessionCommand(command: Command): Promise<CommandResult<CommandType>> {
    return runCommand(command);
}

async function runCommand(command: Command): Promise<CommandResult<CommandType>> {
    if (!handler) return { ok: false, error: { code: "unavailable", message: "the extension's worker is still starting" } };
    return handler(command);
}

const tabInfo = (t: chrome.tabs.Tab): TabInfo | null =>
    t.id == null ? null : {
        tabId: t.id, url: t.url || "", title: t.title || "", active: !!t.active,
        ...(t.windowId != null ? { windowId: t.windowId } : {}),
        ...(typeof t.index === "number" ? { index: t.index } : {}),
        // -1 is Chrome's "in no group".
        ...(typeof t.groupId === "number" && t.groupId >= 0 ? { groupId: t.groupId } : {}),
    };

/** The tab picker's icons, fetched here and handed over as data URLs (tab-favicons.ts). */
const favicons = new FaviconCache();

/**
 * http(s) tabs in strip order, the focused window first, with their icons, and how many were WITHHELD: with site access
 * limited ("On click", or some sites), a tab on any other site reaches the extension with no `url` and no `title`, so it
 * cannot be listed. Counted only while `<all_urls>` is not granted; with it, the tabs still without an address are the
 * browser's own pages, which are left out on purpose and are nothing to warn about.
 */
async function listTabsForPicker(): Promise<{ tabs: TabInfo[]; withheld: number }> {
    const all = await chrome.tabs.query({});
    const raw = all.filter((t) => /^https?:/.test(t.url || ""));
    const allSites = await chrome.permissions.contains({ origins: ["<all_urls>"] }).catch(() => true);
    const withheld = allSites ? 0 : all.filter((t) => !t.url && !t.pendingUrl && !t.incognito).length;
    const focused = await chrome.windows.getLastFocused().then((w) => w.id, () => undefined);
    const ordered = stripOrder(raw, focused);
    const icons = await favicons.many(ordered.map((t) => t.favIconUrl));
    const tabs = ordered.map((t, i) => {
        const info = tabInfo(t);
        return info && icons[i] ? { ...info, favicon: icons[i]! } : info;
    }).filter((t): t is TabInfo => !!t);
    return { tabs, withheld };
}

/**
 * Tab groups with their names and colours. Needs `tabGroups`, an OPTIONAL permission (it carries an install warning,
 * so it is asked for from Settings, never at install): without it the API is absent and this is empty, and a picker
 * still indents grouped tabs by `groupId`.
 */
async function listTabGroups(): Promise<TabGroupInfo[]> {
    const api = (chrome as unknown as { tabGroups?: { query(q: object): Promise<{ id: number; title?: string; color?: string; collapsed?: boolean }[]> } }).tabGroups;
    if (!api) return [];
    return (await api.query({})).map((g) => ({ id: g.id, ...(g.title ? { title: g.title } : {}), ...(g.color ? { color: g.color } : {}), ...(g.collapsed ? { collapsed: true } : {}) }));
}

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
        save: saveChatSession,
        now: () => Date.now(),
    });
    handler = createCommandHandler({
        runtime: localRuntimeId(),
        ownsRuntime: isLocalRuntime,
        // ONE description, shared with the runtime list, so a client that asks cannot be told something the list
        // does not already say.
        describe: () => { const { kind, contractVersion, capabilities } = localRuntime(); return { kind, contractVersion, capabilities }; },
        index: sessionServer.index,
        removeFromIndex: (id) => { sessionServer.remove(id); },
        listTabs: listTabsForPicker,
        listTabGroups,
        listArchived: async (o) => {
            if (!archiveOn) return [];
            const rows = await archiveCall<{ summary: SessionSummary; snippet?: string }[]>("list", o);
            return rows.map((r) => ({ summary: r.summary, ...(r.snippet ? { snippet: r.snippet } : {}) }));
        },
        unarchive: unarchiveSession,
        getTab: async (tabId) => { try { return tabInfo(await chrome.tabs.get(tabId)); } catch { return null; } },
        focusTab: async (tabId, windowId) => {
            try {
                await chrome.tabs.update(tabId, { active: true });
                // The tab being active in a window nobody is looking at is not what was asked: bring the window too.
                if (windowId != null) await chrome.windows.update(windowId, { focused: true });
                return true;
            } catch { return false; }   // closed between the check and the focus
        },
        toPage: async (tabId, action, body) => {
            const reqId = Math.random().toString(36).slice(2, 12);
            const reply = await chrome.tabs.sendMessage(tabId, { type: "ML_SESSION_TO_PAGE", action, ...body, reqId }) as { outcome?: PageOutcome } | undefined;
            return reply?.outcome ?? "no-answer";
        },
        highlight: (tabId, ref) => { chrome.tabs.sendMessage(tabId, { type: "ML_HL_REMOTE", ref, anyMode: true }).catch(() => { /* tab gone */ }); },
        steer: run.steer,
        setRunModel: run.setRunModel,
        cancelRun: run.cancelRun,
        resolveApproval: run.resolveApproval,
        forgetStored: async (hash) => {
            run.forgetRun(hash);
            forgetBackgroundChat(hash);
            await sessionStore?.forget([hash]);
            // A session is in the live store OR the archive; deleting it means from both. Only when the archive is on:
            // otherwise nothing was ever moved there, and asking would start SQLite for every delete.
            if (archiveOn) {
                const removed = await archiveCall<boolean>("remove", { hash }).catch(() => false);
                if (removed) scheduleFolderSync();   // its month's folder file is rewritten without it
            }
            try { await chrome.storage.local.remove(`ml_session_${hash}`); } catch { /* storage unavailable */ }
        },
        keepSession,
        pinSession,
        renameSession,
        ...(sessionStore ? { storageReport } : {}),
        listModels: async () => {
            const [{ ids, ollamaModels }, cfg] = await Promise.all([listAvailableModels(), getConfig()]);
            const allowed = ids.filter((m) => modelFilterAllows(m, cfg.modelFilter));
            // Ollama's own list says which are local; without it (a backend that is not Ollama-backed) nothing is said.
            const local = ollamaModels ? new Set(ollamaModels) : null;
            // Kinds cost an /api/show per model, cached for the worker's life: what lets a picker leave out an
            // embedding model someone could not chat with.
            const { caps } = await modelCapabilitiesBatch(cfg, allowed).catch(() => ({ caps: {} as Record<string, string[] | null> }));
            const models = allowed.map((id) => ({
                id, ...(caps[id] ? { kinds: caps[id]! } : {}), ...(id === cfg.model ? { default: true as const } : {}),
                ...(local ? { where: local.has(id) ? "local" as const : "cloud" as const } : {}),
            }));
            // That a filter is on, and how much it hid: never the filter itself (modelFilter stays unreadable).
            return cfg.modelFilter.trim() ? { models, filtered: { hidden: ids.length - allowed.length } } : models;
        },
        startChat: (opts) => startBackgroundChat(opts),
        startAgent: async (tabId, opts) => {
            const reqId = Math.random().toString(36).slice(2, 12);
            const reply = await chrome.tabs.sendMessage(tabId, { type: "ML_START_AGENT", reqId, ...opts }) as { outcome?: PageOutcome | "started"; hash?: string } | undefined;
            return { outcome: reply?.outcome ?? "no-answer", ...(reply?.hash ? { hash: reply.hash } : {}) };
        },
        history: async (hash) => (sessionStore ? await sessionStore.history(hash) : null),
        ...(sessionStore ? { storedEvents: (hash: string) => sessionStore.read(hash) } : {}),
        adoptSession: async (tabId, hash, history) => {
            if (history.kind !== "agent" || !history.payload) return "none";
            // Put the run back where a resume looks for it. `RESUME_RUN` reads `bgRuns` and nothing else, and it is
            // worker MEMORY: a run that settled yesterday is not in it, which is the whole reason a saved session
            // keeps its own copy. Hydrating here means the resume path itself needs no second source.
            bgRuns.set(hash, { p: history.payload, tabId, messages: history.messages, ...(history.sub ? { sub: history.sub } : {}) });
            trackRun(tabId, hash, history.payload.rebuild);
            const reply = await chrome.tabs.sendMessage(tabId, { type: "ML_ADOPT_SESSION", hash, rebuild: history.payload.rebuild }) as { outcome?: PageOutcome | "adopted" } | undefined;
            const outcome = reply?.outcome ?? "no-answer";
            // A page that did not take it must not leave a run hydrated against a tab that is not holding it: the
            // next thing to read `bgRuns` would believe that tab owns this session.
            if (outcome !== "adopted") { bgRuns.delete(hash); untrackRun(tabId, hash); }
            return outcome;
        },
        noteResumed: (hash, tabId, note) => {
            ingestSessionEvent(
                { kind: "session-resumed", ts: Date.now(), save: false, session: { hash, turn: 0 }, ...note },
                { tabId, trusted: true },
            );
        },
        openTab: async (url) => {
            const tab = await chrome.tabs.create({ url, active: true });
            const tabId = tab.id;
            if (tabId == null) throw new Error("the browser opened a tab with no id");
            // WHY IT FAILED, not merely that it did. `executeScript` throws the same way whether the page never
            // loaded or this browser will not let the extension run on it, so the wait used to report one of them
            // for both — and since a blank run now defaults to a page nobody typed, the wrong half of that answer
            // reads as the extension going somewhere on its own. `onErrorOccurred` is what tells them apart.
            let netError: string | undefined;
            const onError = (d: { tabId: number; frameId: number; error?: string }) => {
                if (d.tabId === tabId && d.frameId === 0) netError = d.error || "the load failed";
            };
            chrome.webNavigation.onErrorOccurred.addListener(onError);
            try {
                // Wait for `window.ml` to EXIST in the new page, not for the tab to report "complete" and not for the
                // content script to answer. The content script registers its listener before `injected.js` runs, so a
                // start relayed on that signal reaches a page whose `__mlStartAgent` listener is not there yet, and the
                // run is lost to a timeout. What the run needs is the main world, so that is what this asks.
                const until = Date.now() + TAB_READY_MS;
                for (;;) {
                    try {
                        const [probe] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: () => !!(window as { ml?: unknown }).ml });
                        if (probe?.result === true) return tabId;
                    } catch { /* still loading, or the extension cannot script this page yet */ }
                    // A load that FAILED is never going to succeed, so it is reported at once rather than after the
                    // full budget: fifteen seconds of nothing is a long way to go to be told the host is down.
                    if (netError) throw new Error(tabReadyFailure(url, netError));
                    if (Date.now() > until) throw new Error(tabReadyFailure(url, null));
                    await new Promise((r) => setTimeout(r, TAB_POLL_MS));
                }
            } catch (err) {
                // Nothing useful is left in a tab a run could not start on, and leaving it is how someone ends up
                // with a browser-error page at an address they never typed and no way to connect it to the run.
                await chrome.tabs.remove(tabId).catch(() => {});
                throw err;
            } finally {
                chrome.webNavigation.onErrorOccurred.removeListener(onError);
            }
        },
        startPage: () => agentStartPage,
        sendChat: (hash, text, images) => sendBackgroundChat(hash, text, images),
        setChatModel: (hash, model) => setBackgroundChatModel(hash, model),
        checkModel: async (model) => {
            // The same two checks `setModel` makes, without making it the default: the server offers it, and the
            // whitelist lets it through.
            const { ids } = await listAvailableModels();
            if (!ids.includes(model)) return `this runtime does not offer "${model}"`;
            const config = await getConfig();
            if (!modelFilterAllows(model, config.modelFilter)) return `"${model}" is not allowed by this runtime's model filter`;
            return null;
        },
        remodel: (hash, model) => {
            const row = sessionServer.remodel(hash, model);
            if (row) sessionStore?.putSummary(row);
        },
        cancelChat: (hash) => cancelBackgroundChat(hash),
        hostsChat: (hash) => isBackgroundChat(hash),
        utilityConfigured: () => utilityModelSet,
        sideCall: utilityCall,
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

const DAY_MS = 24 * 60 * 60 * 1000;
/** `sessionArchive`, as the store reads it: an evicted session moves to the SQLite archive rather than being deleted.
 *  False until read, so nothing is moved on a guess. */
let archiveOn = false;

/** `sessionRetentionDays`, as the store reads it. Kept current from storage; 0 until read, which keeps everything. */
let retentionDays = 0;
/**
 * `sessionStoreBudgetMB`, as the store reads it. NULL until read, and null means no cap: someone who set 0 may hold
 * gigabytes, and a write landing before the setting was read must not evict them down to the default.
 */
let budgetMB: number | null = null;

/** The store's caps from the setting: 0 is none at all, of either kind. */
function storeLimits(): { budgetBytes: number; maxSessions: number } {
    if (budgetMB == null || budgetMB <= 0) return { budgetBytes: Infinity, maxSessions: Infinity };
    return { budgetBytes: budgetMB * 1024 * 1024, maxSessions: STORE_MAX_SESSIONS };
}

/** Saved sessions, which outlive this worker. A worker with no IndexedDB (a test harness) simply saves nothing.
 *  What a page is subscribed to is what someone is looking at, so that is what an eviction may never take. */
export const sessionStore = (() => {
    try {
        return new SessionStore(indexedDbBackend(), {
            protect: () => sessionServer.subscribed(),
            // The store decides whether a saved session exists, so an eviction there is one here too. Without this a
            // session stayed listed after its history had left the disk.
            onEvict: (hashes) => { for (const hash of hashes) sessionServer.remove({ runtime: localRuntimeId(), hash }); },
            // Every session the store drops without being asked is a housekeeping decision, whichever rule made it.
            onEvicted: (e) => recordHousekeeping({
                subsystem: "sessions", kind: e.outcome === "kept" ? "archive-failed" : "evict", reason: e.reason, key: e.hash, bytes: e.bytes,
                detail: { outcome: e.outcome, idleDays: Math.floor(e.idleMs / DAY_MS), ...(e.error ? { error: e.error } : {}) },
            }),
            archive: {
                enabled: () => archiveOn,
                move: async (row, events) => {
                    await archiveCall<boolean>("put", { input: { summary: row.summary, events, history: row.history ?? null, split: row.split, bytes: row.bytes }, archivedTs: Date.now() });
                    scheduleFolderSync();
                },
            },
            retainMs: () => Math.max(0, retentionDays) * DAY_MS,
            limits: storeLimits,
        });
    }
    catch { return null; }
})();

/** The index and its server, for this worker's life. */
export const sessionServer = new SessionServer(new SessionIndex({ runtime: localRuntimeId(), spawn }), {
    runtime: localRuntime,
    command: runCommand,
    ...(sessionStore ? {
        stored: (hash: string) => sessionStore.read(hash),
        // Only a kept session's events are stored, so only they have a position `session.backfill` can page from.
        position: (hash: string) => (sessionServer.index.get(hash)?.saved ? sessionStore.nextPos(hash) : undefined),
    } : {}),
});

// What a previous worker saved, so an evicted service worker comes back with its list rather than with nothing. The
// events stay on disk until something subscribes to that session.
// Retention runs BEFORE the list is restored, so a session past its time is forgotten rather than listed for a moment
// and then removed; which needs the setting first.
/** The worker's session settings, read once at startup whether or not there is a store: titling needs them too. */
const settingsRead = readSessionSettings();
// The folder's state rides the runtime's description, so every change to it is one to that.
onFolderChange(() => { sessionServer.runtimeChanged(); recomputeAttention(); });
// `pythonMissing` reads the measured bundle check below: false until measured, so an unmeasured build is not flagged.
let archiveKnown = false;
watchAttention({ archiveOn: () => (archiveKnown ? archiveOn : null), onChange: () => sessionServer.runtimeChanged(), pythonMissing: () => pythonMeasured && !pythonBundled });
// A grant made while someone is looking at the question should answer it, without polling and without a reload.
try {
    chrome.permissions?.onAdded?.addListener(() => void refreshBlankStart());
    chrome.permissions?.onRemoved?.addListener(() => void refreshBlankStart());
    void refreshBlankStart();
} catch { /* no permissions API (a test harness) */ }
// Whether the archive is on is read at start like everything else; until it is, "archive-off" would be a guess.
void settingsRead.then(() => { archiveKnown = true; recomputeAttention(); });
// A lapsed grant shows only after a restart, which is also when this runs.
void settingsRead.then(() => { if (archiveOn) archiveToggled(); });
if (sessionStore) {
    const store = sessionStore;
    void settingsRead
        .then(() => store.sweep())
        // A sweep that fails must not cost the list: the sessions it meant to drop are listed one more time instead.
        .catch(() => [])
        .then(() => store.open())
        .then((rows) => {
            sessionServer.restored(sessionServer.index.restore(rows.map((r) => ({ summary: r.summary, count: r.count }))));
            void recordStorageSnapshot().catch(() => { /* storage unavailable */ });
        })
        .catch(() => { /* no storage: the list is whatever this worker sees from now on */ });
}

/** Read the session settings once (retention, budget, titles); never rejects, since a worker without storage keeps
 *  everything and titles nothing. */
async function readSessionSettings(): Promise<void> {
    try {
        const cfg = await chrome.storage.sync.get({ sessionRetentionDays: 0, sessionStoreBudgetMB: DEFAULT_CONFIG.sessionStoreBudgetMB, autoTitles: DEFAULT_CONFIG.autoTitles, utilityModel: "", sessionArchive: DEFAULT_CONFIG.sessionArchive }) as { sessionRetentionDays?: unknown; sessionStoreBudgetMB?: unknown; autoTitles?: unknown; utilityModel?: unknown; sessionArchive?: unknown };
        autoTitles = cfg?.autoTitles !== false;
        archiveOn = cfg?.sessionArchive === true;
        // Also read by the callback below; read here too, since titling waits on this read and not on that one.
        utilityModelSet = !!String(cfg?.utilityModel ?? "").trim();
        retentionDays = Math.max(0, Number(cfg?.sessionRetentionDays) || 0);
        budgetMB = parseBudget(cfg?.sessionStoreBudgetMB);
    } catch { /* keep everything */ }
}

/** A budget from storage: a non-negative number of MB, or the default when it is not one. */
function parseBudget(v: unknown): number {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CONFIG.sessionStoreBudgetMB;
}

// The bundle is looked at once; a client already connected hears the answer as a runtime update.
void pythonBundlePresent().then((ok) => {
    pythonMeasured = true;
    if (ok !== pythonBundled) { pythonBundled = ok; sessionServer.runtimeChanged(); }
    recomputeAttention();
});

// Kept current from storage: `side.call` needs a utility model, and the runtime's capabilities say whether it has one.
// After `sessionServer` exists, since a storage callback may run synchronously.
try {
    chrome.storage.sync.get({ utilityModel: "", agentStartPage: "" }, (cfg) => {
        utilityModelSet = !!String(cfg?.utilityModel ?? "").trim();
        agentStartPage = String(cfg?.agentStartPage ?? "").trim();
        sessionServer.runtimeChanged();
        void refreshBlankStart();
    });
    chrome.storage.onChanged?.addListener((changes, area) => {
        if (area !== "sync") return;
        // A new start page is a new ORIGIN, so the old answer about it does not carry over.
        if (changes.agentStartPage) { agentStartPage = String(changes.agentStartPage.newValue ?? "").trim(); void refreshBlankStart(); }
        if (changes.autoTitles) autoTitles = changes.autoTitles.newValue !== false;
        if (changes.sessionArchive) { archiveOn = changes.sessionArchive.newValue === true; archiveToggled(); }
        // A shorter retention applies now, not on the next write: someone who just lowered it expects the list to
        // shrink while they watch.
        if (changes.sessionRetentionDays || changes.sessionStoreBudgetMB) {
            if (changes.sessionRetentionDays) retentionDays = Math.max(0, Number(changes.sessionRetentionDays.newValue) || 0);
            if (changes.sessionStoreBudgetMB) budgetMB = parseBudget(changes.sessionStoreBudgetMB.newValue);
            void sessionStore?.sweep().catch(() => { /* storage unavailable */ });
        }
        if (!changes.utilityModel) return;
        utilityModelSet = !!String(changes.utilityModel.newValue ?? "").trim();
        sessionServer.runtimeChanged();
    });
} catch { /* no storage (a test harness) */ }

/** Sessions asked for before the index had heard of them. A run mints its hash just BEFORE its first event, so a
 *  request to keep it can arrive first; a hash is held here until an event for it turns up. Bounded, because the
 *  request reaches the worker from a page and a page can name a hash that never arrives. */
const pendingKeep = new Set<string>();
const MAX_PENDING_KEEP = 32;

/**
 * Keep this session past the worker's life: what `ephemeral` absent means on `chat.start` and `agent.start`, and
 * what `config.persistUiRuns` means for a run the HUD started.
 *
 * Whatever the session has already emitted is written too, because a session cannot be marked until its hash
 * exists and by then its first events may have been ingested. And a hash the index has never seen is REMEMBERED
 * rather than dropped: the hash is minted a moment before the first event, so arriving early is the common case,
 * not the exception.
 */
export function keepSession(hash: string): void {
    const summary = sessionServer.index.get(hash);
    if (!summary) {
        if (pendingKeep.size >= MAX_PENDING_KEEP) pendingKeep.delete(pendingKeep.values().next().value as string);
        pendingKeep.add(hash);
        return;
    }
    pendingKeep.delete(hash);
    const already = sessionServer.markSaved(hash);
    if (!sessionStore) return;
    for (const event of already) sessionStore.put({ ...summary, saved: true }, event);
}

const HISTORY_KEY = "ml_storage_history";
const SNAPSHOT_ALARM = "ml-storage-snapshot";
/** A snapshot a day; the alarm checks more often, so a browser closed at the usual time still records one. */
const SNAPSHOT_EVERY_MS = 20 * 60 * 60 * 1000;
const SNAPSHOT_CHECK_MIN = 6 * 60;

/** The recorded history, oldest first. Empty when nothing was recorded or storage is unavailable. */
async function storageHistory(): Promise<StorageSnapshot[]> {
    try {
        const got = await chrome.storage.local.get(HISTORY_KEY) as Record<string, unknown>;
        return Array.isArray(got[HISTORY_KEY]) ? got[HISTORY_KEY] as StorageSnapshot[] : [];
    } catch { return []; }
}

/**
 * Record today's snapshot when the last one is a day old. Sums the rows' running breakdowns, so it costs nothing like
 * a read of the store; it is what lets the Storage page show what grew, over months of real use, which no single
 * measurement can.
 */
export async function recordStorageSnapshot(): Promise<void> {
    if (!sessionStore) return;
    const next = appendSnapshot(await storageHistory(), await sessionStore.snapshot(), SNAPSHOT_EVERY_MS);
    if (next) await chrome.storage.local.set({ [HISTORY_KEY]: next });
}

/** `storage.stats`, and the DevTools Storage section: the history, today's picture, and the largest sessions. */
export async function storageReport(): Promise<StorageReport> {
    const store = sessionStore!;
    const [history, now, largest] = await Promise.all([storageHistory(), store.snapshot(), store.largest()]);
    // Only when it is on: asking would start SQLite for a page that has never used the archive.
    const archive = archiveOn ? await archiveCall<NonNullable<StorageReport["archive"]>>("stats").catch(() => undefined) : undefined;
    return { history, now, largest, ...(archive ? { archive } : {}) };
}

/**
 * Where the saved-session store's bytes go (session-storage-stats.ts). Reads every session from disk one at a time,
 * so it is for a person asking, never for anything on a timer. Null when this worker has no store.
 */
export async function sessionStorageStats(): Promise<StoreBytes | null> {
    if (!sessionStore) return null;
    const seen = new Map<string, number>();
    const rows = [];
    for (const row of await sessionStore.open()) {
        const events = await sessionStore.read(row.hash);
        rows.push({ hash: row.hash, ...(row.summary.title ? { title: row.summary.title } : {}), events: events.length, ...measureEvents(events, seen) });
    }
    return summarizeStore(rows, seen);
}

/** A small model call on the utility profile: `side.call`, and the runtime's own titles. */
async function utilityCall({ messages, schema, maxTokens, session }: { messages: NeutralMessage[]; schema?: object; maxTokens: number; session?: string }): Promise<{ content: string; usage?: unknown }> {
    const r = await fetchLLM({
        messages, extend: "utility", maxTokens, think: false,
        ...(schema ? { schema: schema as never } : {}),
        hint: { use: "utility", ...(session ? { session: hintSession(session) } : {}) },
    }) as { content: string | null; usage?: unknown };
    return { content: r.content ?? "", usage: r.usage };
}

/** `autoTitles`, as the worker reads it: the same switch that lets the sidebar title sessions. */
let autoTitles = DEFAULT_CONFIG.autoTitles;
/** Sessions a title was asked for in this worker's life, so a failure is not retried on every event. Bounded. */
const titleAsked = new Set<string>();
const MAX_TITLE_ASKED = 1000;

/**
 * Title a session this runtime keeps, once: so every device shows one name rather than each generating its own.
 * Only a SAVED session (an ephemeral one is gone before the name matters), one with something to summarise, not
 * already titled or named by a person, and only with a utility model set and auto-titles on — without a utility
 * model the call would fall to the main model, which nobody asked to spend on this.
 */
export function maybeTitle(hash: string): void {
    const row = sessionServer.index.get(hash);
    if (!row?.saved || row.title || row.renamed || row.kind === "embed" || !row.task?.trim()) return;
    if (!utilityModelSet || !autoTitles || titleAsked.has(hash)) return;
    if (titleAsked.size >= MAX_TITLE_ASKED) titleAsked.delete(titleAsked.values().next().value as string);
    titleAsked.add(hash);
    void utilityCall({ messages: titleMessages(row.task), maxTokens: 32, session: hash }).then((r) => {
        const title = cleanTitle(r.content);
        const now = sessionServer.index.get(hash);
        // Renamed, titled or deleted while the model was asked: that answer wins.
        if (!title || !now || now.title || now.renamed) return;
        const changed = sessionServer.retitle(hash, title);
        if (changed) sessionStore?.putSummary(changed);
    }).catch(() => { /* no title: the list shows the task */ });
}

/**
 * `session.unarchive`: bring a session back from the archive into the live store, so it can be opened and resumed
 * like any other. Written to the store FIRST and removed from the archive after, so a failure between the two leaves it
 * in both rather than in neither. Its month's folder file is then rewritten without it, until it is archived again.
 */
export async function unarchiveSession(hash: string): Promise<boolean> {
    if (!sessionStore) return false;
    const got = await archiveCall<{ summary: SessionSummary; events: MlDebugEvent[]; history: SessionHistory | null } | null>("read", { hash }).catch(() => null);
    if (!got) return false;
    await sessionStore.restoreSession(got.summary, got.events, got.history, Date.now());
    sessionServer.restored(sessionServer.index.restore([{ summary: got.summary, count: got.events.length }]));
    await archiveCall("remove", { hash }).catch(() => { /* in both until the next archive: harmless */ });
    scheduleFolderSync();
    return true;
}

/** `session.rename`: a person's title, which the runtime never replaces; or null, back to a generated one. */
export function renameSession(hash: string, title: string | null): void {
    const row = sessionServer.retitle(hash, title, !!title);
    if (row) sessionStore?.putSummary(row);
    if (!title) { titleAsked.delete(hash); maybeTitle(hash); }
}

/**
 * Pin a session, or unpin it. Pinning keeps it first, through `keepSession`, so the events it has already emitted
 * reach the store with it; the row then carries `pinned`, which is what the store's eviction reads and what a
 * restarted worker restores. Unpinning leaves the session saved.
 */
export function pinSession(hash: string, pinned: boolean): void {
    if (pinned) keepSession(hash);
    const row = sessionServer.pin(hash, pinned);
    if (row) sessionStore?.putSummary(row);
    // A finished session emits nothing more, so being kept is the last chance to title it.
    if (pinned) maybeTitle(hash);
}

/**
 * Write a chat where BOTH readers look: the `ml_session_<hash>` record `ml.resumeChat` rehydrates from, and the saved
 * session's own history, which is what `session.resume` continues from.
 *
 * One function because it is one fact. A page's `{ save: true }` chat, a chat this worker hosts itself and a resumed
 * chat all have to agree about what that chat's latest state is, and three writers agreeing is something that holds
 * right up until a fourth is added.
 *
 * A chat that persists itself is also a session to KEEP — the two spellings of saved were separate before, so a
 * `{ save: true }` chat had its record on disk and no row to hang a history on, and resuming it would have found
 * nothing.
 */
export async function saveChatSession(hash: string, session: StoredSession): Promise<void> {
    keepSession(hash);
    await chrome.storage.local.set({ [`ml_session_${hash}`]: session });
    sessionStore?.putHistory(hash, { kind: "chat", session });
}

/**
 * What a run would be continued from. A run has no `ml_session_` record — that key is a chat's, and `resumeChat`
 * reads it — so this writes the one half a run has.
 *
 * Unlike a chat's, this does NOT decide that the session is kept: `{ save: true }` is a page ASKING for a chat to
 * persist, while whether a run is kept was already answered by `ephemeral` or by `persistUiRuns`. A history for a
 * session the store does not hold is dropped, which is what keeps a one-off run one-off.
 */
export function saveRunHistory(hash: string, history: Omit<Extract<SessionHistory, { kind: "agent" }>, "kind">): void {
    sessionStore?.putHistory(hash, { kind: "agent", ...history });
}

/** Fold one debug event into the index, and save it when the session is one we keep. Never throws: a malformed event
 *  must not break the relay it rides beside, and a full disk must not stop a run. */
export function ingestSessionEvent(event: unknown, source: IngestSource): void {
    try {
        const out = sessionServer.ingest(event as MlDebugEvent, source);
        if (!out.accepted) return;
        // `out.summary` is the row only when it CHANGED, which most events do not: keying the write on it stored a
        // saved run's start and end and dropped the steps between, so a restarted worker served a transcript with
        // holes. Whether to write is whether the session is saved, read from the index every time — and read BEFORE
        // a pending keep runs, since that writes the ring, this event included.
        const wasSaved = !!(out.summary ?? sessionServer.index.get(out.session.hash))?.saved;
        // A request to keep this session that arrived before the session did.
        if (pendingKeep.has(out.session.hash)) keepSession(out.session.hash);
        const row = sessionServer.index.get(out.session.hash);
        if (wasSaved && row && sessionStore) sessionStore.put(row, out.event);
        if (row?.saved) maybeTitle(out.session.hash);
    } catch { /* refused */ }
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
    refreshBackendAttention();
}

// The storage history's clock. An alarm, not a timer: a timer is what would keep the worker alive to wait for it.
try {
    chrome.alarms?.onAlarm.addListener((a) => {
        if (a.name !== SNAPSHOT_ALARM) return;
        void recordStorageSnapshot().catch(() => {});
        // The same clock catches a folder whose grant came back (re-granted from a page since the last write).
        if (archiveOn) void archiveCall("sync").catch(() => {});
    });
    void chrome.alarms?.get(SNAPSHOT_ALARM).then((a) => { if (!a) void chrome.alarms.create(SNAPSHOT_ALARM, { periodInMinutes: SNAPSHOT_CHECK_MIN }); }).catch(() => {});
} catch { /* no alarms (a test harness) */ }

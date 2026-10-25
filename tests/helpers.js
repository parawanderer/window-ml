// Test harness: loads the extension's plain (non-module) scripts into
// isolated vm contexts with mocked chrome/fetch/window globals, so tests
// exercise the real message contracts without a browser.
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
// Tests exercise the BUILT extension (esbuild output). `npm test` runs `pretest`
// (npm run build) first, so dist/ is fresh. .env still lives at the repo root.
const DIST = path.join(ROOT, "dist");

// A per-sandbox QUIET console. The loaded extension code chatters on stdout — injected.js prints
// "🟢 window.ml is ready." on EVERY boot, plus assorted console.warn/error — and in a vm sandbox that raw
// (multi-byte) output goes straight to the test process's stdout, INTERLEAVING with node:test's
// V8-serialized child→parent protocol. On Node 22's runner that intermittently misframes a message
// ("Unable to deserialize cloned data due to invalid or unsupported version" — a flaky CI red on
// tests/relay.test.js; Node 24/26 tolerate it). None of this output is asserted (the exec tool and the
// readonly interpreter capture their OWN logs by reassigning the methods, which a fresh object still allows),
// so route it to no-ops. Fresh object PER sandbox so exec's save/restore can't bleed across worlds. Set
// SANDBOX_CONSOLE=1 to see the real output while debugging a test.
/**
 * A MessagePort for the vm worlds (page-channel.ts): linked to its peer, delivering a structured clone by microtask, as
 * a real port delivers by task. What arrives before `onmessage` is set waits, as a real port's queue does until started.
 */
class FakeMessagePort {
    constructor() { this.other = null; this.closed = false; this._on = null; this._held = []; }
    get onmessage() { return this._on; }
    set onmessage(f) { this._on = f; for (const d of this._held.splice(0)) queueMicrotask(() => this._on && this._on({ data: d })); }
    postMessage(data) {
        const o = this.other, copy = structuredClone(data);
        queueMicrotask(() => { if (!o || o.closed) return; if (o._on) o._on({ data: copy }); else o._held.push(copy); });
    }
    start() {}
    close() { this.closed = true; }
}
/** A MessageChannel of two {@link FakeMessagePort}s. */
class FakeMessageChannel {
    constructor() { this.port1 = new FakeMessagePort(); this.port2 = new FakeMessagePort(); this.port1.other = this.port2; this.port2.other = this.port1; }
}
/** A MessageEvent that carries `ports`, as the page channel's hand-off needs. */
class FakeMessageEvent {
    constructor(type, init = {}) { this.type = type; this.data = init.data; this.ports = init.ports || []; this.source = init.source ?? null; }
}

function mkConsole() {
    if (process.env.SANDBOX_CONSOLE) return console;
    const noop = () => {};
    const c = {};
    for (const m of ["log", "info", "warn", "error", "debug", "trace", "dir", "group", "groupCollapsed", "groupEnd", "table", "assert", "count", "countReset", "time", "timeLog", "timeEnd"]) c[m] = noop;
    return c;
}

// Loads KEY=VALUE pairs from a repo-root .env into process.env, for the opt-in
// live tests. Zero-dependency (no `dotenv`); missing file is a no-op so CI and
// offline runs are unaffected. Real environment variables win over .env, so an
// inline `OPENWEBUI_MODEL=... npm test` still overrides the file.
function loadDotEnv() {
    let text;
    try {
        text = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
    } catch {
        return; // no .env — nothing to load
    }
    for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq === -1) continue;
        const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
        // Split on the first "=" only; keys/tokens may contain "=". Strip one
        // layer of surrounding quotes but leave the rest (incl. "#") intact.
        let value = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
        if (key && !(key in process.env)) process.env[key] = value;
    }
}

function jsonResponse(obj, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => obj,
        text: async () => JSON.stringify(obj)
    };
}

// What OpenWebUI's SPA catch-all does for unknown routes.
function htmlResponse(status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => { throw new Error("Unexpected token '<'"); },
        text: async () => "<!doctype html><html></html>"
    };
}

// A streaming response stub: `lines` are raw wire lines (SSE "data: {...}\n" or
// Ollama NDJSON) fed through body.getReader() one read() at a time.
/** A BINARY streamed response, with the content-type that selects the protobuf path. Chunk boundaries are
 *  whatever the caller passes, deliberately: the framing has to survive a message split across two reads. */
function binaryStreamResponse(chunks, { status = 200, type = "application/protobuf; delimited=varint" } = {}) {
    let i = 0;
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? type : null) },
        body: {
            getReader: () => ({
                read: async () => (i < chunks.length
                    ? { done: false, value: new Uint8Array(chunks[i++]) }
                    : { done: true, value: undefined })
            })
        },
        text: async () => { throw new Error("binary response has no text()"); },
        json: async () => { throw new Error("streaming response has no json()"); }
    };
}

function streamResponse(lines, { status = 200 } = {}) {
    const enc = new TextEncoder();
    let i = 0;
    return {
        ok: status >= 200 && status < 300,
        status,
        body: {
            getReader: () => ({
                read: async () => (i < lines.length
                    ? { done: false, value: enc.encode(lines[i++]) }
                    : { done: true, value: undefined })
            })
        },
        text: async () => lines.join(""),
        json: async () => { throw new Error("streaming response has no json()"); }
    };
}

// Loads background.js. `onFetch` receives { url, opts, body } (body already
// JSON-parsed for requests that have one) and returns a response stub.
// `commandShortcut` is what chrome.commands reports as CURRENTLY bound for the HUD
// (null = the API is unavailable, "" = the user cleared the binding); `manifestPermissions`
// lets a test declare contextMenus, which GET_INVOCATION reads as "the right-click entry exists".
// `holdPolicies` is a promise the policy store's first storage read waits on.
// `holdRestore` is a promise the worker's read of ALL of local storage (its run restore) waits on.
function loadBackground({ config = {}, local = {}, session = {}, onFetch, onCaptureTab, onPyRun, onTabMessage, onDebuggerCommand, onArchiveOp, commandShortcut = "Alt+Space", manifestPermissions = ["scripting", "activeTab", "storage", "offscreen"], debuggerPermission = true, manifestVersion = "9.9.9", indexedDB, focusedWindow, openTabs = [], allSites = true, siteGate = false, siteAgents = "always", userScripts, onTabsGet, holdRestore, onNative, dialectInside, pyInside, holdPolicies }) {
    const calls = [];
    // chrome.runtime.connectNative: each host name asked for, in order. With `onNative(name, end)`, the test plays the
    // native host: `end.send(msg)` delivers a message to the worker's port, `end.close(why)` disconnects it, and the
    // returned function receives what the worker posts. Without it, every connect fails the way an uninstalled host does.
    const nativeConnects = [];
    const captures = [];        // captureVisibleTab arg lists, for screenshot tests
    const tabMessages = [];     // chrome.tabs.sendMessage arg lists, for reverse-channel tests
    const tabsCreated = [];     // chrome.tabs.create props, for the PDF-print tab flow
    const tabsRemoved = [];     // chrome.tabs.remove ids
    const tabsBack = [];        // chrome.tabs.goBack ids
    const pyRuns = [];          // PY_RUN payloads relayed to the offscreen doc (for python_exec tests)
    // A run's try of a python_exec cell INSIDE the dialect (`inside: true`), kept apart from `pyRuns`. `pyInside(msg)`
    // answers it; absent, it is answered as the stock Pyodide core answers (no membership predicate), so the cell asks.
    const pyInsideRuns = [];
    const pyDeletes = [];       // PY_DELETE_RUN messages (a settled run's kept Python namespace is dropped)
    const pyDrops = [];         // PY_DROP_LIBRARIES messages (a removed tier 3 library restarts the workers holding one)
    const htmlToMd = [];        // HTML the worker asked the offscreen document to convert to Markdown
    const debuggerCalls = [];   // chrome.debugger attach/sendCommand/detach, for CDP_CLICK tests
    const debuggerEventListeners = new Set();   // chrome.debugger.onEvent listeners (CDP streaming)
    // chrome.userScripts, present only when a test passes `userScripts: { execute(injection) }` (an isolated exec's world).
    // `available: false` makes it throw on use, as Chrome does while the person's "Allow User Scripts" toggle is off.
    const userScriptCalls = [];
    // chrome.scripting: what the worker registered for the visible origins and injected into a hidden page for a run
    // (sw-presence.ts, SITE_PRESENCE.md step 2). `registered` is the live registration list, by id.
    const scriptingCalls = [];
    const registered = new Map();
    const userScriptListeners = [];
    let permsHeld = new Set(debuggerPermission ? ["debugger"] : []);
    const permAddedListeners = [];
    const committedListeners = [];   // chrome.webNavigation.onCommitted listeners; fired by bg.commit(tabId, …)
    const targetListeners = [];      // chrome.webNavigation.onCreatedNavigationTarget listeners; fired by bg.openedFrom(…)
    const sameDocListeners = { history: [], fragment: [] };   // onHistoryStateUpdated / onReferenceFragmentUpdated; fired by bg.sameDocumentNav
    const committedDocs = new Map();   // tabId → the main-frame documentId last committed, for webNavigation.getFrame
    /** The tab's top-frame document now: the last committed, else an open tab's first (`doc-<tabId>`). */
    let topFrame = "F-top";   // the frame id the last Page.getFrameTree reported (a debugger fake below)
    const docOf = (tabId) => committedDocs.get(tabId) ?? (openTabs.some((t) => t.id === tabId) ? `doc-${tabId}` : undefined);
    const committedUrls = new Map();   // tabId → the main-frame URL last committed (or activated), for webNavigation.getFrame
    /** The tab's top-frame URL now, as getFrame reports it: the last committed, else the open tab's. */
    const urlOf = (tabId) => committedUrls.get(tabId) ?? openTabs.find((t) => t.id === tabId)?.url;
    const listeners = [];
    const connectListeners = [];
    const tabRemovedListeners = [];   // chrome.tabs.onRemoved listeners; fired by bg.closeTab(id)
    const tabActivatedListeners = new Set();   // chrome.tabs.onActivated listeners; fired by bg.activateTab(id)
    const tabReplacedListeners = new Set();   // chrome.tabs.onReplaced listeners; fired by bg.replaceTab(oldId, newId)
    const badges = new Map();   // tabId (or "default") → { text, title }: what chrome.action was told for each tab (the toolbar badge)
    badges.shown = (tabId) => {
        const own = badges.get(tabId) ?? {}, dflt = badges.get("default") ?? {};
        return { text: own.text ?? dflt.text ?? "", title: own.title ?? dflt.title ?? "window.ml" };
    };
    const stored = { ...config };
    const syncListeners = [];
    const localStore = { ...local };   // seed chrome.storage.local (e.g. ml_bgrun_* snapshots for durable-resume tests)
    // Every origin a test seeds as allowed may also start agents without a card (`siteAgents`), unless the seed names
    // its level: the tests here predate the agent level (SITE_ACCESS_SLICE3.md, PR 2) and are about what a run does.
    // `siteAgents: null` keeps the seed as written (the upgrade fixtures, the agent level's own tests).
    if (siteAgents) {
        const seeded = [...(Array.isArray(local.ml_site_always) ? local.ml_site_always : []), ...(Array.isArray(session.ml_site_session) ? session.ml_site_session : [])];
        if (seeded.length) {
            const agents = { ...(local.ml_site_agents || {}) };
            for (const o of seeded) if (typeof o === "string" && !(o in agents) && !(session.ml_site_agents && o in session.ml_site_agents)) agents[o] = siteAgents;
            localStore.ml_site_agents = agents;
        }
    }
    /** Put a page sender's origin on the approved list, as a person allowing the site would (see `send` below). */
    const approveSender = (sender) => {
        if (!sender?.tab) return;
        // The browser always says where a content script's message came from; a test sender built as `{ tab: { id } }`
        // does not. Give it a page of its own, at an origin no test fetches, so no same-page check is satisfied by it.
        if (!sender.url && !sender.origin && !sender.tab.url) sender.url = "https://page.test/";
        const url = sender.origin || sender.url || sender.tab.url;
        let o;
        try { o = new URL(url).origin; } catch { return; }
        if (!/^https?:/.test(o)) return;
        const list = localStore.ml_site_always || (localStore.ml_site_always = []);
        if (!list.includes(o)) list.push(o);
        // And lets it start agents without a card, as the tests here predate the agent level (SITE_ACCESS_SLICE3.md,
        // PR 2): they are about what a run does, not whether the site may start one. tests/redteam-agent-level.test.mjs
        // is where the level is tested, with `siteGate: true`.
        if (!siteAgents) return;
        const agents = localStore.ml_site_agents || (localStore.ml_site_agents = {});
        if (!(o in agents)) agents[o] = siteAgents;
    };
    /** storage.onChanged's `changes` for a write of `obj` over `store`. */
    const changesOf = (store, obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, { oldValue: store[k], newValue: v }]));
    /** Fire storage.onChanged as the browser does after a write; nothing fires for an empty change. */
    const fireChanged = (changes, area) => { if (Object.keys(changes).length) for (const fn of [...syncListeners]) fn(changes, area); };
    const sessionStore = { ...session };   // seed chrome.storage.session (e.g. a housekeeping heartbeat left by an "earlier" worker)
    let offscreenDoc = false;

    const context = {
        console: mkConsole(),
        URL,
        TextDecoder,
        TextEncoder,
        structuredClone,   // every service worker has it; a fetch cache keeps a frozen copy made with it
        // WebCrypto, which every MV3 service worker has: the worker mints each request's id (`hint.request`) with it.
        crypto: globalThis.crypto,
        // As every worker has it. Without it `ml.current` (snapshotCurrent copies the context) threw in this realm
        // only, so no test here had read a run's own context through the worker.
        structuredClone,
        // SW-realm navigator: ml.fetch's browser-identity headers read userAgent/languages; the HUD-invocation
        // doc reads userAgent for the Cmd/Alt hint. A non-Mac UA keeps that path's isMac false (as when absent).
        navigator: { userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", languages: ["en-US", "en"], language: "en-US" },
        AbortController,   // FETCH_LLM registers one per request (for ABORT_TASK cancellation)
        __ML_NET_RETRY_WAIT_MS: 0,   // network-retry backoff → instant in tests (no 24s of real waits per down-backend test)
        setTimeout, clearTimeout, DOMException,   // rate-limit backoff (abortableWait) uses timers + abort
        Response,          // some paths construct/inspect Response
        Blob,              // the value store keeps a fetched body as a Blob
        atob, btoa,        // a worker realm has both (imageSize reads a capture's PNG header through atob)
        // The value store's database. Absent by default, as in any realm with no IndexedDB, which leaves the store off;
        // a test that exercises it passes a `fake-indexeddb` IDBFactory.
        // A key range is how the store deletes a session's events, so a worker given a database needs it too: without
        // it every eviction threw, and nothing noticed until retention was the first test to evict through a worker. It
        // is the CommonJS build's, so a test that evicts must take its IDBFactory from `require("fake-indexeddb")` too:
        // the ESM build's database refuses the other build's key range.
        ...(indexedDB ? { indexedDB, IDBKeyRange: require("fake-indexeddb").IDBKeyRange } : {}),
        fetch: async (url, opts = {}) => {
            // The extension's own files: this harness has no bundle, and Chrome REJECTS a missing extension resource
            // rather than answering 404. Not a call to the backend, so never recorded or handed to `onFetch`.
            if (String(url).startsWith("chrome-extension://")) throw new TypeError("Failed to fetch");
            const call = {
                url: String(url),
                opts,
                body: opts.body ? JSON.parse(opts.body) : null
            };
            calls.push(call);
            return onFetch(call);
        },
        chrome: {
            // The toolbar button: per-tab badge text and tooltip, recorded in `badges`; the colours in `badges.colours`.
            action: {
                // No tabId sets the default; a tab's `null` resets it to the default, as in Chrome. `badges.shown(tab)`
                // is what that tab shows.
                setBadgeText: async ({ tabId, text }) => { badges.set(tabId ?? "default", { ...badges.get(tabId ?? "default"), text }); },
                setTitle: async ({ tabId, title }) => { badges.set(tabId ?? "default", { ...badges.get(tabId ?? "default"), title }); },
                setBadgeBackgroundColor: async ({ color }) => { badges.colours = { ...badges.colours, bg: color }; },
                setBadgeTextColor: async ({ color }) => { badges.colours = { ...badges.colours, fg: color }; },
            },
            // Only what the worker reads to know which document a tab holds: a commit is fired by bg.commit, never by
            // the harness on its own, so a test that never commits sees no document at all.
            webNavigation: {
                onCommitted: { addListener: (fn) => committedListeners.push(fn), removeListener: (fn) => { const i = committedListeners.indexOf(fn); if (i >= 0) committedListeners.splice(i, 1); } },
                onCreatedNavigationTarget: { addListener: (fn) => targetListeners.push(fn) },
                // Like the browser, a live tab always has a top-frame document: the last one committed, else its first.
                getFrame: async ({ tabId, frameId }) => (frameId === 0 && docOf(tabId) ? { documentId: docOf(tabId), frameId: 0, ...(urlOf(tabId) ? { url: urlOf(tabId) } : {}) } : null),
                // A same-document navigation (pushState, a fragment) keeps the document: fired by bg.sameDocumentNav only.
                onHistoryStateUpdated: { addListener: (fn) => sameDocListeners.history.push(fn), removeListener: (fn) => { const i = sameDocListeners.history.indexOf(fn); if (i >= 0) sameDocListeners.history.splice(i, 1); } },
                onReferenceFragmentUpdated: { addListener: (fn) => sameDocListeners.fragment.push(fn), removeListener: (fn) => { const i = sameDocListeners.fragment.indexOf(fn); if (i >= 0) sameDocListeners.fragment.splice(i, 1); } },
            },
            storage: {
                sync: {
                    get: async (defaults) => ({ ...defaults, ...stored }),
                    set: async (obj) => { Object.assign(stored, obj); }
                },
                onChanged: { addListener: (fn) => syncListeners.push(fn) },
                local: {
                    get: async (key) => {
                        // get(null) → ALL keys (hydratePersistedRuns/purgeAllBgRuns). `holdRestore` (a promise) slows exactly this
                        // read, so a test can deliver a message to a worker that has not restored its runs yet.
                        // A copy, as the browser's storage returns: a worker that changes what it read does not change storage.
                        if (key == null) { if (holdRestore) await holdRestore; return structuredClone(localStore); }
                        if (holdPolicies && Array.isArray(key) && key.includes("ml_policies_global")) await holdPolicies;   // the policy store's first read
                        const keys = typeof key === "string" ? [key] : Array.isArray(key) ? key : Object.keys(key || {});
                        const out = {};
                        for (const k of keys) if (k in localStore) out[k] = structuredClone(localStore[k]);
                        return out;
                    },
                    // Like the browser, a write fires storage.onChanged in this worker too (area "local").
                    // Copies both ways, as the browser does (and as the session area below does).
                    set: async (obj) => { const changes = changesOf(localStore, obj); Object.assign(localStore, structuredClone(obj)); fireChanged(changes, "local"); },
                    remove: async (keys) => { const ks = Array.isArray(keys) ? keys : [keys]; const changes = Object.fromEntries(ks.filter((k) => k in localStore).map((k) => [k, { oldValue: localStore[k] }])); for (const k of ks) delete localStore[k]; fireChanged(changes, "local"); },
                },
                session: {
                    get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in sessionStore).map((k) => [k, structuredClone(sessionStore[k])])),
                    set: async (obj) => { const changes = changesOf(sessionStore, obj); Object.assign(sessionStore, structuredClone(obj)); fireChanged(changes, "session"); },
                },
            },
            // GET_INVOCATION reads the manifest's suggested key + the contextMenus permission.
            commands: commandShortcut === null ? undefined : {
                onCommand: { addListener: () => {} },
                getAll: async () => [{ name: "open-composer", shortcut: commandShortcut }],
            },
            runtime: {
                getURL: (p = "") => `chrome-extension://test/${p}`,   // origin checks (e.g. FETCH_SHEET_TITLE's sender-origin gate)
                getManifest: () => ({
                    version: manifestVersion,
                    permissions: manifestPermissions,
                    commands: { "open-composer": { suggested_key: { default: "Alt+Space", mac: "Alt+Space" } } },
                }),
                onMessage: { addListener: (fn) => listeners.push(fn) },
                onConnect: { addListener: (fn) => connectListeners.push(fn) },
                onUserScriptMessage: { addListener: (fn) => userScriptListeners.push(fn) },
                lastError: undefined,
                connectNative: (name) => {
                    nativeConnects.push(name);
                    const onMsg = [], onDisc = [];
                    let closed = false;
                    const close = (why) => {
                        if (closed) return;
                        closed = true;
                        setTimeout(() => {
                            context.chrome.runtime.lastError = why ? { message: why } : undefined;
                            for (const fn of onDisc) fn();
                            context.chrome.runtime.lastError = undefined;
                        }, 0);
                    };
                    const end = { send: (m) => { if (!closed) setTimeout(() => { for (const fn of onMsg) fn(JSON.parse(JSON.stringify(m))); }, 0); }, close };
                    const receive = onNative ? onNative(name, end) : null;
                    if (!receive) close("Specified native messaging host not found.");
                    return {
                        name,
                        postMessage: (m) => { if (closed) throw new Error("Attempting to use a disconnected port object"); receive?.(JSON.parse(JSON.stringify(m))); },
                        disconnect: () => { closed = true; },
                        onMessage: { addListener: (fn) => onMsg.push(fn) },
                        onDisconnect: { addListener: (fn) => onDisc.push(fn) },
                    };
                },
                // The PYTHON_EXEC handler relays PY_RUN to the offscreen doc via runtime.sendMessage —
                // capture the payload (esp. `hardened`) so tests can assert what the sandbox is told to run.
                sendMessage: async (msg) => {
                    if (msg?.type === "PY_RUN" && msg.inside) { pyInsideRuns.push(msg); return pyInside ? pyInside(msg) : { ok: false, stdout: "", notInDialect: "this Pyodide build has no membership predicate (the stock core, not the restricted-mode fork)" }; }
                    if (msg?.type === "PY_RUN") { pyRuns.push(msg); return onPyRun ? onPyRun(msg) : { ok: true, value: null, stdout: "" }; }
                    if (msg?.type === "PY_DELETE_RUN") { pyDeletes.push(msg); return { ok: true }; }
                    if (msg?.type === "PY_DROP_LIBRARIES") { pyDrops.push(msg); return { ok: true, restarted: 1 }; }
                    if (msg?.type === "PY_PREWARM") { pyRuns.push(msg); return onPyRun ? onPyRun(msg) : { ok: true, prewarm: "started" }; }
                    // The session archive's worker, behind the offscreen document: `onArchiveOp(msg)` answers for it.
                    if (msg?.type === "ARCHIVE_OP" && onArchiveOp) return onArchiveOp(msg);
                    // HTML→Markdown for a fetch the worker made: a stand-in for the offscreen document's converter.
                    if (msg?.type === "HTML_TO_MD") { htmlToMd.push(msg.html); return { markdown: `MD(${String(msg.html).replace(/<[^>]*>/g, "").trim()})` }; }
                    return undefined;
                },
            },
            offscreen: {
                Reason: { WORKERS: "WORKERS", DOM_PARSER: "DOM_PARSER" },
                hasDocument: async () => offscreenDoc,
                createDocument: async () => { offscreenDoc = true; },
            },
            // Optional-permission checks (debugger for CDP_CLICK, Google origins for FETCH_SHEET). request()
            // needs a gesture in the real API, but the SW only ever contains()-checks — so the mock's request
            // is just for completeness.
            permissions: {
                // Track named permissions (debugger); treat origin grants as present (FETCH_SHEET only
                // contains()-checks Google origins, and the harness assumes those are granted).
                // `allSites: false` withholds `<all_urls>`, as site access "On click" does.
                contains: async ({ permissions = [], origins = [] }) => permissions.every(p => permsHeld.has(p)) && (allSites || !origins.includes("<all_urls>")),
                request: async ({ permissions = [] }) => { permissions.forEach(p => permsHeld.add(p)); for (const fn of permAddedListeners) fn({ permissions }); return true; },
                onAdded: { addListener: (fn) => permAddedListeners.push(fn) },
                onRemoved: { addListener: () => {} },
            },
            // CDP surface for reserved-element clicks. Records attach/sendCommand/detach so tests assert the
            // press+release sequence and that we always detach.
            scripting: {
                executeScript: async (injection) => { scriptingCalls.push(["executeScript", injection]); return [{ frameId: 0, result: undefined }]; },
                registerContentScripts: async (list) => { scriptingCalls.push(["registerContentScripts", list]); for (const r of list) { if (registered.has(r.id)) throw new Error(`Duplicate script ID '${r.id}'`); registered.set(r.id, r); } },
                unregisterContentScripts: async (filter) => { scriptingCalls.push(["unregisterContentScripts", filter]); for (const id of filter?.ids ?? [...registered.keys()]) registered.delete(id); },
                getRegisteredContentScripts: async () => [...registered.values()],
            },
            ...(userScripts ? { userScripts: {
                getWorldConfigurations: async () => { if (userScripts.available === false) throw new Error("The userScripts API is not available"); return []; },
                configureWorld: async (props) => { userScriptCalls.push(["configureWorld", props]); },
                // An injection pinned to documents the tab no longer holds is refused, as Chrome refuses it.
                execute: async (injection) => {
                    const docs = injection.target?.documentIds, tabId = injection.target?.tabId;
                    userScriptCalls.push(["execute", injection]);   // what was asked for, refused or not
                    if (docs && docOf(tabId) && !docs.includes(docOf(tabId))) throw new Error(`No document with id ${docs[0]} in tab ${tabId}.`);
                    return [{ frameId: 0, result: await userScripts.execute(injection) }];
                },
            } } : {}),
            debugger: {
                attach: async (target, version) => { debuggerCalls.push(["attach", target, version]); },
                // `onDebuggerCommand(method, params)` lets a test script the reply (e.g. Runtime.evaluate's
                // result / exceptionDetails for the CDP-exec tests); default returns undefined (clicks need none).
                // Unscripted, a tab's top frame is "F-top" and, as Chrome does on the enable that turns Runtime on, enabling
                // Runtime reports its main world as context 1 (cdpEval pins every evaluate to it, sw-cdp.ts mainWorldContext).
                sendCommand: async (target, method, params) => {
                    debuggerCalls.push(["sendCommand", target, method, params]);
                    const r = onDebuggerCommand ? await onDebuggerCommand(method, params) : undefined;
                    if (method === "Page.getFrameTree") { topFrame = r?.frameTree?.frame?.id ?? "F-top"; if (r === undefined) return { frameTree: { frame: { id: topFrame } } }; }
                    if (method === "Runtime.enable" && r === undefined)
                        [...debuggerEventListeners].forEach((fn) => fn(target, "Runtime.executionContextCreated", { context: { id: 1, auxData: { isDefault: true, frameId: topFrame } } }));
                    return r;
                },
                detach: async (target) => { debuggerCalls.push(["detach", target]); },
                onDetach: { addListener: () => {} },   // the SW listens for an external detach (DevTools opened, target gone)
                // CDP EVENTS (Runtime.bindingCalled — how a strict-page exec streams its console out live).
                // Tests fire one with bg.emitDebuggerEvent(target, method, params).
                onEvent: {
                    addListener: (fn) => { debuggerEventListeners.add(fn); },
                    removeListener: (fn) => { debuggerEventListeners.delete(fn); },
                },
            },
            // The browser's focus, for chat_metadata's "user focus" line: `focusedWindow` is what getLastFocused
            // answers (`{ focused, incognito, tabs }`); unset, no window has focus.
            windows: {
                getLastFocused: async () => (typeof focusedWindow === "function" ? focusedWindow() : focusedWindow) ?? { focused: false, tabs: [] },
                update: async () => ({}),
            },
            tabs: {
                // Records args so tests can assert the windowId; onCaptureTab (if
                // given) provides the data URL or throws to simulate a failure.
                captureVisibleTab: async (...args) => {
                    captures.push(args);
                    return onCaptureTab ? onCaptureTab(...args) : "data:image/png;base64,SHOT";
                },
                // Records (tabId, message) so reverse-channel tests can assert what the background
                // relays to a tab's content script (e.g. ML_HL_REMOTE). Resolves like the real API.
                // Records (tabId, message); onTabMessage (if given) can inspect it AND drive side effects —
                // e.g. simulate the page tool calling FETCH_SHEET back during a RUN_TOOL_IN_PAGE delegation.
                // A send pinned to a document (`{ documentId }`) that the tab no longer holds is refused, as Chrome refuses it,
                // and never reaches the page.
                sendMessage: async (...args) => {
                    const pin = args[2]?.documentId;
                    if (pin && docOf(args[0]) && docOf(args[0]) !== pin) throw new Error("Could not establish connection. Receiving end does not exist.");
                    tabMessages.push(args); return onTabMessage ? await onTabMessage(...args) : undefined;
                },
                // The PDF-print flow opens a print.html tab and later removes it by id.
                create: async (props) => { tabsCreated.push(props); return { id: 4242 + tabsCreated.length }; },
                remove: async (id) => { tabsRemoved.push(id); },
                goBack: async (id) => { tabsBack.push(id); },
                onRemoved: { addListener: (fn) => tabRemovedListeners.push(fn) },
                onActivated: { addListener: (fn) => tabActivatedListeners.add(fn), removeListener: (fn) => tabActivatedListeners.delete(fn) },
                onReplaced: { addListener: (fn) => tabReplacedListeners.add(fn), removeListener: (fn) => tabReplacedListeners.delete(fn) },
                // What `tabs.query({})` answers: `openTabs`, as the browser reports them (a tab on a site the
                // extension may not read has no `url` and no `title`).
                query: async () => openTabs.map((t) => ({ ...t })),
                // One of `openTabs` by id, rejecting like the real API for a tab that is not there.
                // `onTabsGet(id, answer)` (if given) runs after the browser has answered and before the caller sees it: the
                // moment a tab can change under an answer that is already on its way.
                get: async (id) => {
                    const t = openTabs.find((x) => x.id === id);
                    if (!t) throw new Error(`No tab with id: ${id}.`);
                    const answer = { ...t };
                    if (onTabsGet) await onTabsGet(id, answer);
                    return answer;
                },
            }
        }
    };
    vm.createContext(context);
    // `dialectInside`: a substring that marks a python_exec cell as INSIDE the read-only dialect. The built worker has no
    // real membership predicate yet (agent/python-dialect.ts), and a bundle in a vm cannot reach the source module's test
    // seam, so the default verdict is replaced in the bundle's text.
    let bgSrc = fs.readFileSync(path.join(DIST, "background.js"), "utf8");
    if (dialectInside) {
        const patched = bgSrc.replace("membership = () => false", `membership = (code) => code.includes(${JSON.stringify(dialectInside)})`);
        if (patched === bgSrc) throw new Error("loadBackground: dialectInside found no membership default in dist/background.js");
        bgSrc = patched;
    }
    vm.runInContext(bgSrc, context);

    return {
        calls,
        badges,   // tabId → { text, title } the toolbar button shows there (chrome.action)
        nativeConnects,
        captures,
        tabMessages,
        tabsCreated,
        tabsRemoved,
        tabsBack,
        pyRuns,
        pyInsideRuns,
        pyDeletes,
        pyDrops,
        htmlToMd,
        debuggerCalls,
        debuggerEventListeners,
        /** Fire a CDP event at every listener the SW registered (e.g. Runtime.bindingCalled). */
        userScriptCalls,
        scriptingCalls,
        registered,
        /** Deliver a message from a user-script world. Resolves with the answer a listener sent, or undefined when none
         *  kept the channel open (as Chrome's `runtime.sendMessage` resolves when no one answers). */
        emitUserScriptMessage: (msg, sender) => new Promise((resolve) => {
            let open = false;
            for (const fn of userScriptListeners) if (fn(msg, sender, resolve) === true) open = true;
            if (!open) resolve(undefined);
        }),
        emitDebuggerEvent: (target, method, params) => { [...debuggerEventListeners].forEach(fn => fn(target, method, params)); },
        /** Write chrome.storage.local the way another extension surface would (the popup, a Settings panel, a sync of
         *  the lists): stored, then storage.onChanged with area "local". */
        setLocal: (obj) => { const changes = changesOf(localStore, obj); Object.assign(localStore, obj); fireChanged(changes, "local"); },
        /** Change synced settings the way the settings panel does: stored, then storage.onChanged with area "sync". */
        setSync: (obj) => {
            const changes = Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, { oldValue: stored[k], newValue: v }]));
            Object.assign(stored, obj);
            for (const fn of syncListeners) fn(changes, "sync");
        },
        /** Commit a main-frame document on a tab, the way the browser reports a navigation (webNavigation.onCommitted). */
        commit: (tabId, { documentId, url = "https://page.test/", frameId = 0, ...extra }) => {
            if (frameId === 0) { committedDocs.set(tabId, documentId); committedUrls.set(tabId, url); }
            for (const fn of [...committedListeners]) fn({ tabId, frameId, documentId, url, ...extra });
        },
        /** A tab opened FROM another tab's page (a link into a new tab, `window.open`): webNavigation.onCreatedNavigationTarget. */
        openedFrom: (sourceTabId, tabId, url = "https://page.test/") => { for (const fn of [...targetListeners]) fn({ sourceTabId, sourceFrameId: 0, tabId, url }); },
        /** A prerendered document becoming the tab's top frame (activation): the browser fires no main-frame commit
         *  for it (its commit was reported earlier, with the prerender's own non-zero frameId); getFrame names it. */
        activate: (tabId, { documentId, url }) => { committedDocs.set(tabId, documentId); committedUrls.set(tabId, url); },
        /** A same-document navigation of the tab's top frame, as the browser reports one: `kind` "history" (pushState) or
         *  "fragment" (a hash change). The document, and its id, stay. */
        sameDocumentNav: (tabId, { kind = "history", url = "https://page.test/" } = {}) => {
            for (const fn of [...sameDocListeners[kind]]) fn({ tabId, frameId: 0, documentId: docOf(tabId), url });
        },
        /** Grant a permission the way the browser's prompt does: held, then permissions.onAdded. */
        grantPermission: (name) => { permsHeld.add(name); for (const fn of permAddedListeners) fn({ permissions: [name] }); },
        stored,
        localStore,   // chrome.storage.local contents — tests assert a snapshot was kept/removed
        sessionStore,   // chrome.storage.session contents — the housekeeping log lives here
        context,      // the vm sandbox — reach test-only globalThis hooks (e.g. __mlSeedBgRunForTest)
        // Simulates chrome.runtime.sendMessage hitting the listener.
        // A page sender's origin is APPROVED first unless the test asked for the real gate (`siteGate: true`): the
        // tests here predate the origin gate (docs/spec/SITE_ACCESS.md) and are about what a handler does for a page
        // that may use it. tests/site-access-gate.test.mjs is where the gate itself is tested.
        send: (message, sender = {}) => {
            if (!siteGate) approveSender(sender);
            return new Promise((resolve) => {
                // The gate answers asynchronously, and a fire-and-forget handler answers `undefined`; both resolve here.
                listeners[0](message, sender, resolve);
            });
        },
        /** Simulates the user closing a tab (chrome.tabs.onRemoved). */
        closeTab: (tabId) => { badges.delete(tabId); for (const fn of tabRemovedListeners) fn(tabId, {}); },   // a tab's badge goes with it
        /** Simulates the user switching to a tab: it becomes its window's `active` one in `openTabs`, and
         *  chrome.tabs.onActivated fires. */
        activateTab: (tabId) => {
            const t = openTabs.find((x) => x.id === tabId);
            for (const o of openTabs) if (o.windowId === t.windowId) o.active = o.id === tabId;
            for (const fn of [...tabActivatedListeners]) fn({ tabId, windowId: t.windowId });
        },
        /** Simulates Chrome swapping a tab's contents under a new id (a prerender or a discard restored): the tab is
         *  `newId` in `openTabs` from now on, and chrome.tabs.onReplaced fires. onActivated does not: the window still
         *  shows the same strip slot. */
        replaceTab: (oldId, newId) => {
            const t = openTabs.find((x) => x.id === oldId);
            t.id = newId;
            for (const fn of [...tabReplacedListeners]) fn(newId, oldId);
        },
        // Simulates the content script opening a streaming Port. Returns a client
        // handle: send(msg) posts to the background port; onMessage(fn) receives
        // background pushes; messages[] collects them.
        connect: (name = "LLM_STREAM", sender = undefined) => {
            if (!siteGate && sender) approveSender(sender);
            const messages = [];
            const clientHandlers = [];
            const backgroundHandlers = [];
            const disconnectHandlers = [];   // background-side port.onDisconnect listeners
            let disconnected = false;
            const port = {
                name,
                // who opened it: `{ url }` for an extension page, `{ url, tab }` for a content script
                ...(sender ? { sender } : {}),
                onMessage: { addListener: (fn) => backgroundHandlers.push(fn) },
                postMessage: (msg) => { messages.push(msg); for (const h of clientHandlers) h(msg); },
                onDisconnect: { addListener: (fn) => disconnectHandlers.push(fn) },
                // the background closing the port itself
                disconnect: () => { disconnected = true; }
            };
            for (const fn of connectListeners) fn(port);
            return {
                messages,
                onMessage: (fn) => clientHandlers.push(fn),
                send: (msg) => { for (const h of backgroundHandlers) h(msg); },
                // Simulate content.js disconnecting the port (what an ABORT_REQUEST triggers) →
                // fires the background's onDisconnect handlers, which abort the streaming fetch.
                disconnect: () => { for (const h of disconnectHandlers) h(); },
                /** did the background close this port? */
                wasDisconnected: () => disconnected,
            };
        }
    };
}

// Loads content.js + injected.js into one fake "page world" so ml.* calls
// travel the real postMessage relay. `onRuntimeMessage` plays the background:
// it gets the runtime message and returns { data } or { error }.
function loadPageWorld({ onRuntimeMessage, onStream, config, caps, dialectInside, visible = true, beforeInjected } = {}) {
    // #8: ml.agent probes config + model capabilities on every call to decide
    // whether to auto-wire a `look` tool. Answer those probes from `config`/`caps`
    // (defaults: no OCR model, no capabilities → no vision tool) so loop tests
    // needn't script them. `caps` may be a value or a fn(model) → capability list.
    // Default the test origin to TRUSTED (pageApprovalAllowed: true) so ml.agent honours the caller's
    // own approve()/confirm gate — the in-page loop these agent tests exercise. A test that wants the
    // design-A background gate instead (the [HOLE→design-A] tests) passes `pageApprovalAllowed: false`.
    const agentConfig = { pageApprovalAllowed: true, model: "", ocrModel: "", ...config };
    const probeReply = (message) => {
        if (message.type === "GET_CONFIG") return { data: agentConfig };
        if (message.type === "MODEL_CAPS") {
            const m = message.payload && message.payload.model;
            return { data: typeof caps === "function" ? caps(m) : (caps ?? null) };
        }
        return undefined;
    };
    const runtimeCalls = [];
    const prewarms = [];   // PYTHON_PREWARM payloads, in order
    const listeners = {};       // type -> fn[]
    const dispatchedEvents = []; // event types dispatched (for assertions)
    const windowPosts = [];      // everything posted on the page's window (page-channel.ts: nothing of ours should be)
    const runtimeMsgListeners = []; // chrome.runtime.onMessage listeners (content.js's reverse channel)

    // A real (jsdom) DOMParser so page-world code that parses HTML strings works in the sandbox — e.g. the
    // fetch_url tool's HTML→Markdown conversion (turndown reads `DOMParser` off the global `window`). The stub
    // `document` below is enough for injected.js's own boot; parsing a fetched HTML page needs the real thing.
    const domParser = new JSDOM("").window.DOMParser;
    // The page channel's isolated end (page-channel.ts), taken from injected.js's hand-off as content.js takes it.
    const channel = { iso: null };
    const win = {
        DOMParser: domParser,
        addEventListener: (type, fn) => {
            (listeners[type] ??= []).push(fn);
        },
        removeEventListener: (type, fn) => {
            const arr = listeners[type];
            if (arr) {
                const i = arr.indexOf(fn);
                if (i >= 0) arr.splice(i, 1);
            }
        },
        dispatchEvent: (event) => {
            dispatchedEvents.push(event.type);
            if (event.type === "ml-page-port" && event.ports?.[0] && !channel.iso) channel.iso = event.ports[0];
            for (const fn of [...(listeners[event.type] || [])]) fn(event);
            return true;
        },
        postMessage: (data) => {
            windowPosts.push(data);
            queueMicrotask(() => {
                for (const fn of [...(listeners.message || [])]) fn({ source: win, data });
            });
        }
    };

    const context = {
        console: mkConsole(),
        Math,
        Date,
        Intl,
        structuredClone,
        DOMParser: domParser,   // real HTML parsing for turndown (fetch_url HTML→Markdown); see win.DOMParser above
        AbortController,   // a standard web global injected.js uses (e.g. ml.createAgent's cancel())
        // Real timers: injected.js uses them for waits and for bounding background lookups. Without
        // these, that code hit a ReferenceError swallowed by its own catch — a silently degraded path
        // that tests then "passed" against.
        setTimeout, clearTimeout,
        Event: class Event { constructor(type) { this.type = type; } },
        MessageChannel: FakeMessageChannel,
        MessagePort: FakeMessagePort,
        MessageEvent: FakeMessageEvent,
        window: win,
        // injected.js is a browser script — `location` is always present there (used for the run's
        // pageOrigin + the navigate tool's same-origin check). Mock it for the vm.
        location: { origin: "https://test.example", href: "https://test.example/", protocol: "https:" },
        URL,
        HTMLImageElement: class HTMLImageElement {},
        document: {
            createElement: () => ({ remove() {} }),
            head: { appendChild: () => {} },
            documentElement: { appendChild: () => {} }
        },
        chrome: {
            runtime: {
                getURL: (p) => `chrome-extension://test/${p}`,
                sendMessage: (message, cb) => {
                    // The callback is OPTIONAL in the real API — fire-and-forget messages
                    // (e.g. ABORT_TASK) pass none, so never assume `cb` exists.
                    // content.js sends CONTENT_READY as it starts, on EVERY page. It carries no run to adopt in these node:vm
                    // tests, so answer it empty and keep it OUT of runtimeCalls (like the config/caps probes) — else it
                    // shifts every relay/agent test's message indices. `open` is the page's presence (SITE_PRESENCE.md
                    // step 2): visible unless the test says hidden. (The handler itself is tested in
                    // tests/background.test.js against the real background.)
                    if (message && message.type === "CONTENT_READY") { queueMicrotask(() => cb && cb({ adopt: [], open: visible })); return; }
                    // The Pyodide pre-warm a run with python_exec sends at start: a side call, answered here and kept
                    // out of runtimeCalls, or it eats a scripted model turn. Recorded in `prewarms` for the tests of it.
                    if (message && message.type === "PYTHON_PREWARM") { prewarms.push(message.payload); queueMicrotask(() => cb && cb({ data: "started" })); return; }
                    queueMicrotask(async () => {
                        let response = onRuntimeMessage ? await onRuntimeMessage(message) : undefined;
                        // Fall back to the default probe answer for the agent's
                        // config/capability lookups, and keep those OUT of
                        // runtimeCalls so model-call indices stay stable for tests.
                        if (response === undefined) {
                            const probe = probeReply(message);
                            if (probe !== undefined) return void (cb && cb(probe));
                        }
                        // Snapshot the messages array at SEND time. The agent loop mutates one
                        // `messages` array in place (it only ever APPENDS — assistant turns, tool
                        // results, the final answer), so recording `message` by reference would let a
                        // later push retroactively shift the positions an earlier call's assertions see.
                        // A shallow copy freezes each recorded call to what was actually sent.
                        runtimeCalls.push(
                            message && message.payload && Array.isArray(message.payload.messages)
                                ? { ...message, payload: { ...message.payload, messages: [...message.payload.messages] } }
                                : message,
                        );
                        if (cb) cb(response);
                    });
                },
                // Streaming Port. content.js posts { payload }; the test's onStream
                // plays the background, calling emit({ type, ... }) to push chunks
                // back down the port to content.js.
                connect: () => {
                    const portHandlers = [];
                    return {
                        onMessage: { addListener: (fn) => portHandlers.push(fn) },
                        postMessage: (msg) => {
                            if (onStream) onStream(msg, (m) =>
                                queueMicrotask(() => { for (const h of portHandlers) h(m); }));
                        },
                        onDisconnect: { addListener: () => {} },
                        disconnect: () => {}
                    };
                },
                // content.js's REVERSE channel (design A): the background delivers RUN_TOOL_IN_PAGE
                // here via chrome.tabs.sendMessage. Tests fire it with fireRuntimeMessage() below.
                onMessage: { addListener: (fn) => runtimeMsgListeners.push(fn) }
            }
        }
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(DIST, "content.js"), "utf8"), context);
    // The page's own scripts, run before injected.js: what a page given injected.js LATE (a run on a hidden page, an
    // origin allowed while it is open) can do first. Never possible on a visible page, where injected.js is first. A late
    // injected.js always comes through the worker's injectPageScripts, which re-arms the content script first.
    if (beforeInjected) {
        vm.runInContext(beforeInjected, context);
        for (const fn of runtimeMsgListeners) fn({ type: "PAGE_PORT_ARM" }, {}, () => {});
    }
    let injectedSrc = fs.readFileSync(path.join(DIST, "injected.js"), "utf8");
    if (dialectInside) {   // as in loadBackground: the bundle has no real membership predicate yet, so patch the default verdict's text
        const patched = injectedSrc.replace("membership = () => false", `membership = (code) => code.includes(${JSON.stringify(dialectInside)})`);
        if (patched === injectedSrc) throw new Error("loadPageWorld: dialectInside found no membership default in dist/injected.js");
        injectedSrc = patched;
    }
    vm.runInContext(injectedSrc, context);

    // Simulate the background delivering a message to this tab's content script (chrome.tabs.sendMessage
    // → chrome.runtime.onMessage). Resolves with whatever sendResponse is eventually called with — for
    // RUN_TOOL_IN_PAGE that's the page's tool envelope, which arrives after the window round-trip.
    const fireRuntimeMessage = (message, sender = {}) => new Promise((resolve) => {
        let async = false;
        for (const fn of runtimeMsgListeners) {
            if (fn(message, sender, resolve) === true) async = true;
        }
        if (!async) resolve(undefined);   // no listener kept the channel open
    });

    // THE PAGE CHANNEL, from either end. `asContent(data)` sends to injected.js as content.js or the shell would;
    // `asInjected(data)` sends to them as injected.js would. A test that posts on `window` speaks as the PAGE, which no
    // longer reaches either.
    const asContent = (data) => { if (!channel.iso) throw new Error("loadPageWorld: injected.js never handed over its port"); channel.iso.postMessage(data); };
    const asInjected = (data) => { if (!channel.iso) throw new Error("loadPageWorld: injected.js never handed over its port"); channel.iso.other.postMessage(data); };

    // What injected.js sends to content.js and the shell: `fn` hears `{ data }` beside content.js's own listeners.
    const fromInjected = (fn) => { context.__mlPageChannel.listeners.push(fn); };
    // What content.js and the shell send to injected.js: `fn` hears `{ data }` just before injected.js does.
    const fromContent = (fn) => {
        const port = channel.iso.other, prev = port._on;
        port._on = (e) => { fn(e); if (prev) prev(e); };
    };

    return { ml: win.ml, runtimeCalls, prewarms, context, dispatchedEvents, windowPosts, fireRuntimeMessage, asContent, asInjected, fromInjected, fromContent, pageRun: (src) => vm.runInContext(src, context) };
}

// Boots ONLY injected.js over a real jsdom document, so the agent's DOM
// helpers (ml._elPath, ml._describeSkeleton, ...) traverse a faithful DOM
// instead of a hand-rolled fake. No content.js relay — these helpers are pure
// page-context DOM code and never touch the background. `html` is the <body>
// inner HTML. Returns { ml, window, document } for querying in assertions.
// `url` sets the document's address (jsdom's default is about:blank), for code that branches on where the page
// IS — a local file:// page, for one.
function loadDomWorld(html = "", { url, beforeInjected } = {}) {
    const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, url ? { url } : undefined);
    const win = dom.window;
    const context = {
        console: mkConsole(),
        Math,
        Date,
        Intl,
        structuredClone,
        window: win,
        document: win.document,
        location: win.location,
        // A browser global; without it every `new URL` in injected.js throws inside its own try and reads as
        // "not a URL", which silently takes whichever branch a failed parse means.
        URL,
        Event: win.Event,
        CustomEvent: win.CustomEvent,
        MessageChannel: FakeMessageChannel,
        MessagePort: FakeMessagePort,
        MessageEvent: FakeMessageEvent,
        HTMLImageElement: win.HTMLImageElement,
        // DOM globals the agent tools reference (real in a browser main world).
        Element: win.Element,
        NodeList: win.NodeList,
        HTMLCollection: win.HTMLCollection,
        MutationObserver: win.MutationObserver,
        setTimeout: win.setTimeout.bind(win),
        clearTimeout: win.clearTimeout.bind(win)
    };
    // The page channel's isolated end (page-channel.ts). jsdom's dispatchEvent refuses the fake hand-off event, so it is taken
    // here; with no content.js in this world, `fromInjected` hears what injected.js sends and `asContent` answers it.
    const channel = { iso: null, listeners: [] };
    const dispatch = win.dispatchEvent.bind(win);
    win.dispatchEvent = (event) => {
        if (!(event instanceof FakeMessageEvent)) return dispatch(event);
        if (event.type === "ml-page-port" && event.ports?.[0] && !channel.iso) {
            channel.iso = event.ports[0];
            channel.iso.onmessage = (e) => { for (const fn of [...channel.listeners]) fn(e); };
        }
        return true;
    };
    vm.createContext(context);
    // The document_start patch first, as the browser runs it: it captures closed roots and answers the DOM tools' ask.
    vm.runInContext(fs.readFileSync(path.join(DIST, "shadow-patch.js"), "utf8"), context);
    // The page's own scripts, which run before injected.js (it loads at document_idle).
    if (beforeInjected) vm.runInContext(beforeInjected, context);
    vm.runInContext(fs.readFileSync(path.join(DIST, "injected.js"), "utf8"), context);
    const asContent = (data) => { if (!channel.iso) throw new Error("loadDomWorld: injected.js never handed over its port"); channel.iso.postMessage(data); };
    const fromInjected = (fn) => { channel.listeners.push(fn); };
    return { ml: win.ml, window: win, document: win.document, context, asContent, fromInjected };
}

// Boots the BUILT sidebar app (dist/sidebar-app.js, a Preact bundle) over a jsdom
// window with mocked chrome/matchMedia, so we can drive it with __mlDebug events
// and assert on the rendered shadow DOM. Independent of injected.js.
// jsdom windows created for sidebar tests. The VRAM panel's setInterval keeps a
// window's timers (and thus the Node event loop) alive, so a test file MUST
// close them in an after() hook or the runner hangs forever after all tests pass.
const _sidebarWins = [];
function closeSidebarWorlds() {
    while (_sidebarWins.length) { try { _sidebarWins.pop().close(); } catch { /* already closed */ } }
}

// Loads the sidebar APP bundle (dist/sidebar-app.js) as if it were the iframe
// document (sidebar.html): renders into #root, no shadow root. In the real
// extension the content-script shell relays __mlDebug in from the parent window;
// in jsdom window.parent === window, so dispatch posts with source: win.
async function loadSidebarWorld({ sync = {}, local = {}, models = [], ollamaModels = null, fetchLlm = () => ({ data: "OK" }), sessionTitle = () => ({ data: null }), vram = [], info = null, holdInfo = null, invocation = null, psError = null, caps = null, pythonExec = null, listModels = null, embed = null, serverTools = null, housekeeping = [], indexedDB = null, priceCalls = null, siteLists = null, siteAccess = null, accessRequests = null } = {}) {
    const unloadCalls = [];
    const pyCalls = [];   // PYTHON_EXEC payloads the app sent (the bench)
    const hkCalls = [];   // DUMP_HOUSEKEEPING payloads (the Settings → Housekeeping log)
    let hkEvents = housekeeping;   // the log the worker would return; setHousekeeping() changes it AND fires storage.onChanged
    const printCalls = [];   // PRINT_SESSION payloads (the PDF export routes its rendered doc to the background)
    let psVram = vram;   // mutable so a test can change the resident set mid-run (setVram)
    const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, { runScripts: "outside-only", pretendToBeVisual: true });
    const win = dom.window;
    // TIME RUNS FAST IN HERE. The panel polls `/api/ps` on a 2-second interval and ticks its TTL countdowns
    // every second, and a test that wants "the resident set changed" has no way to ask for a poll — it can
    // only wait for one. So the sidebar tests were littered with `for (…25) { flush(); sleep(150) }` loops
    // whose real cost was waiting out an interval, and the nine slowest were 26 seconds of the suite between
    // them, all of it sleeping.
    //
    // Compressing INTERVALS (not timeouts) collapses that to nothing and changes no behaviour under test: an
    // interval here is a poll or a clock tick, and both are things a test wants MORE of, sooner. Timeouts are
    // left exactly alone, because those ARE behaviour — a debounce, an easing, "stays quiet for the first
    // half second" — and speeding them up would make those assertions meaningless rather than fast.
    const realSetInterval = win.setInterval;
    win.setInterval = (fn, ms, ...rest) => realSetInterval.call(win, fn, Math.min(ms || 0, 120), ...rest);
    _sidebarWins.push(win);   // closed in an after() hook — the VRAM panel's setInterval keeps the event loop alive otherwise
    const syncStore = { debugMode: "overlay", theme: "auto", ...sync };
    // The event LANE is collapsed by default in the product. Most sidebar tests that touch it are about what
    // it draws rather than about the default, so they get it OPEN unless they ask otherwise — the default is
    // pinned by its own test, in the browser, where the collapse is a CSS grid transition jsdom cannot see.
    const localStore = { ml_debug_fontscale: 1, ml_res_sections: { lane: true, models: true }, ...local };
    const changeListeners = [];
    // Fire storage.onChanged like Chrome does, so cross-context (popup↔sidebar)
    // config sync is exercised. `set` merges then notifies.
    const syncSet = (obj) => {
        const changes = {};
        for (const k of Object.keys(obj)) changes[k] = { oldValue: syncStore[k], newValue: obj[k] };
        Object.assign(syncStore, obj);
        for (const fn of changeListeners) fn(changes, "sync");
    };
    win.chrome = {
        runtime: {
            getURL: (f) => f,
            lastError: undefined,
            sendMessage: (msg, cb) => {
                if (msg && msg.type === "PRINT_SESSION") { printCalls.push(msg.payload); return; }   // fire-and-forget → the background opens a print tab
                if (!cb) return;
                const type = msg && msg.type;
                if (type === "LIST_MODELS") cb(listModels ? listModels(msg.payload) : { data: models, ollamaModels });
                else if (type === "FETCH_LLM") cb(fetchLlm(msg.payload));
                // A session's title is the worker's (titleSession): the panel asks for it rather than calling the model.
                else if (type === "SESSION_TITLE") cb(sessionTitle(msg.payload));
                else if (type === "MODEL_CAPS") cb({ data: typeof caps === "function" ? caps(msg.payload && msg.payload.model) : caps });
                // `embed` may be a function (inspect the payload) or a dims NUMBER, which is the common case:
                // a settings test cares that a real vector came back and how wide it is, not its contents.
                else if (type === "EMBED") cb(typeof embed === "function" ? embed(msg.payload)
                    : embed == null ? { error: "no embedding model configured" }
                    : { data: { model: msg.payload && msg.payload.model, vectors: (msg.payload?.inputs || [""]).map(() => Array(embed).fill(0.1)) } });
                else if (type === "OLLAMA_PS") cb(psError ? { error: psError } : { data: psVram });
                // Machine CAPACITY (/api/info). `info: null` (or omitted) is the common case — a stock Ollama
                // doesn't serve the route — and the panel must treat it as UNKNOWN, never as zero.
                // `holdInfo` (a promise) delays the answer, so a test can observe what the panel shows while
                // capacity is still UNKNOWN — the moment it used to flash the legacy sparkline.
                // How the HUD is invoked on this install — the empty state offers the LIVE shortcut.
                else if (type === "GET_INVOCATION") cb({ data: invocation });
                else if (type === "OLLAMA_INFO") {
                    // `info` may be a FUNCTION, so a test can make the box stop answering mid-session — the
                    // case where capacity must persist rather than flip the panel back to the legacy chart.
                    const now = typeof info === "function" ? info() : info;
                    if (holdInfo) holdInfo.then(() => cb({ data: now ?? null }));
                    else cb({ data: now ?? null });
                }
                else if (type === "OLLAMA_UNLOAD") { unloadCalls.push(msg.payload); cb({ data: [] }); }
                // The Settings → Server-side tools browser. A function may THROW to play an unreachable
                // backend, since "empty" and "could not reach it" must not look the same in the UI.
                else if (type === "LIST_SERVER_TOOLS") {
                    let reply = { data: [] };
                    if (typeof serverTools === "function") { try { reply = { data: serverTools() }; } catch (e) { reply = { error: String(e.message || e) }; } }
                    else if (serverTools) reply = { data: serverTools };
                    cb(reply);
                }
                // The spend chip asks the worker to price a session's calls; `priceCalls(calls)` plays the worker.
                else if (type === "PRICE_CALLS") cb(priceCalls ? { data: priceCalls(msg.payload.calls) } : { data: null });
                else if (type === "DUMP_HOUSEKEEPING") { hkCalls.push(msg.payload); cb({ data: hkEvents }); }
                else if (type === "PYTHON_EXEC") { pyCalls.push(msg.payload); cb({ data: typeof pythonExec === "function" ? pythonExec(msg.payload) : (pythonExec || { ok: true, value: 42, stdout: "" }) }); }   // background wraps: { data: PyResult }
                // The site lists. `siteAccess(payload)` plays the worker (a real bundle's SITE_ACCESS, edits included);
                // `siteLists` only answers a read with fixed lists.
                else if (type === "SITE_ACCESS" && siteAccess) Promise.resolve(siteAccess(msg.payload || {})).then((r) => cb(JSON.parse(JSON.stringify(r ?? null))));
                else if (type === "SITE_ACCESS" && siteLists) cb({ data: { lists: siteLists } });
                // The sites waiting for an answer. `accessRequests(payload)` plays the worker's ACCESS_REQUESTS and answers `{ requests }` (or a promise of it).
                else if (type === "ACCESS_REQUESTS" && accessRequests) Promise.resolve(accessRequests(msg.payload || {})).then((r) => cb(JSON.parse(JSON.stringify(r ?? null))));
                else cb({ data: null });
            },
        },
        storage: {
            sync: { get: (defaults, cb) => cb({ ...defaults, ...syncStore }), set: syncSet },
            local: {
                get: (defaults, cb) => cb({ ...defaults, ...localStore }),
                set: (obj) => Object.assign(localStore, obj)
            },
            onChanged: { addListener: (fn) => changeListeners.push(fn), removeListener: (fn) => { const i = changeListeners.indexOf(fn); if (i >= 0) changeListeners.splice(i, 1); } }
        }
    };
    win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    // The value store an extension frame reads a stored table from. Absent by default, as in a realm with no IndexedDB, which
    // leaves `services().storedTable` null; a test passes a `fake-indexeddb` IDBFactory to give the frame one.
    if (indexedDB) { win.indexedDB = indexedDB; win.TextDecoder ??= TextDecoder; }
    win.eval(fs.readFileSync(path.join(DIST, "sidebar-app.js"), "utf8"));

    const tick = () => new Promise((r) => win.setTimeout(r, 0));   // flush async mount / Preact renders
    for (let i = 0; i < 60 && !win.document.querySelector(".app"); i++) await tick();
    // Post an arbitrary message to the app (as the shell/parent would).
    const raw = async (data) => {
        const e = new win.MessageEvent("message", { data });
        Object.defineProperty(e, "source", { value: win });   // app checks e.source === window.parent (=== window in jsdom)
        win.dispatchEvent(e);
        await tick();
    };
    const dispatch = (ev) => raw({ __mlDebug: ev });
    // Wait past a requestAnimationFrame so Preact useEffect (e.g. VRAM polling)
    // has run, then flush the resulting async state update + re-render.
    const flush = async () => { await new Promise((r) => win.setTimeout(r, 30)); await tick(); };
    const setVram = (v) => { psVram = v; };   // change the resident set a later poll will see
    // Replace the housekeeping log the way the worker's flush does: the store changes and storage.onChanged fires.
    const setHousekeeping = (events) => { const old = hkEvents; hkEvents = events; for (const fn of [...changeListeners]) fn({ ml_hk_log: { oldValue: old, newValue: events } }, "session"); };
    return { window: win, shadow: win.document, dispatch, raw, tick, flush, changeListeners, syncStore, localStore, unloadCalls, pyCalls, printCalls, hkCalls, setHousekeeping, setVram };
}

module.exports = { FakeMessageChannel, FakeMessageEvent, jsonResponse, htmlResponse, streamResponse, binaryStreamResponse, loadBackground, loadPageWorld, loadDomWorld, loadSidebarWorld, closeSidebarWorlds, loadDotEnv };

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
function loadBackground({ config = {}, local = {}, onFetch, onCaptureTab, onPyRun, onTabMessage, onDebuggerCommand, commandShortcut = "Alt+Space", manifestPermissions = ["scripting", "activeTab", "storage", "offscreen"], debuggerPermission = true, manifestVersion = "9.9.9" }) {
    const calls = [];
    const captures = [];        // captureVisibleTab arg lists, for screenshot tests
    const tabMessages = [];     // chrome.tabs.sendMessage arg lists, for reverse-channel tests
    const tabsCreated = [];     // chrome.tabs.create props, for the PDF-print tab flow
    const tabsRemoved = [];     // chrome.tabs.remove ids
    const pyRuns = [];          // PY_RUN payloads relayed to the offscreen doc (for python_exec tests)
    const debuggerCalls = [];   // chrome.debugger attach/sendCommand/detach, for CDP_CLICK tests
    const debuggerEventListeners = new Set();   // chrome.debugger.onEvent listeners (CDP streaming)
    let permsHeld = new Set(debuggerPermission ? ["debugger"] : []);
    const listeners = [];
    const connectListeners = [];
    const stored = { ...config };
    const localStore = { ...local };   // seed chrome.storage.local (e.g. ml_bgrun_* snapshots for durable-resume tests)
    let offscreenDoc = false;

    const context = {
        console: mkConsole(),
        URL,
        TextDecoder,
        TextEncoder,
        // SW-realm navigator: ml.fetch's browser-identity headers read userAgent/languages; the HUD-invocation
        // doc reads userAgent for the Cmd/Alt hint. A non-Mac UA keeps that path's isMac false (as when absent).
        navigator: { userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", languages: ["en-US", "en"], language: "en-US" },
        AbortController,   // FETCH_LLM registers one per request (for ABORT_TASK cancellation)
        __ML_NET_RETRY_WAIT_MS: 0,   // network-retry backoff → instant in tests (no 24s of real waits per down-backend test)
        setTimeout, clearTimeout, DOMException,   // rate-limit backoff (abortableWait) uses timers + abort
        Response,          // some paths construct/inspect Response
        fetch: async (url, opts = {}) => {
            const call = {
                url: String(url),
                opts,
                body: opts.body ? JSON.parse(opts.body) : null
            };
            calls.push(call);
            return onFetch(call);
        },
        chrome: {
            storage: {
                sync: {
                    get: async (defaults) => ({ ...defaults, ...stored }),
                    set: async (obj) => { Object.assign(stored, obj); }
                },
                local: {
                    get: async (key) => {
                        if (key == null) return { ...localStore };   // get(null) → ALL keys (hydratePersistedRuns/purgeAllBgRuns)
                        const keys = typeof key === "string" ? [key] : Array.isArray(key) ? key : Object.keys(key || {});
                        const out = {};
                        for (const k of keys) if (k in localStore) out[k] = localStore[k];
                        return out;
                    },
                    set: async (obj) => { Object.assign(localStore, obj); },
                    remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) delete localStore[k]; },
                }
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
                // The PYTHON_EXEC handler relays PY_RUN to the offscreen doc via runtime.sendMessage —
                // capture the payload (esp. `hardened`) so tests can assert what the sandbox is told to run.
                sendMessage: async (msg) => {
                    if (msg?.type === "PY_RUN") { pyRuns.push(msg); return onPyRun ? onPyRun(msg) : { ok: true, value: null, stdout: "" }; }
                    return undefined;
                },
            },
            offscreen: {
                Reason: { WORKERS: "WORKERS" },
                hasDocument: async () => offscreenDoc,
                createDocument: async () => { offscreenDoc = true; },
            },
            // Optional-permission checks (debugger for CDP_CLICK, Google origins for FETCH_SHEET). request()
            // needs a gesture in the real API, but the SW only ever contains()-checks — so the mock's request
            // is just for completeness.
            permissions: {
                // Track named permissions (debugger); treat origin grants as present (FETCH_SHEET only
                // contains()-checks Google origins, and the harness assumes those are granted).
                contains: async ({ permissions = [] }) => permissions.every(p => permsHeld.has(p)),
                request: async ({ permissions = [] }) => { permissions.forEach(p => permsHeld.add(p)); return true; },
            },
            // CDP surface for reserved-element clicks. Records attach/sendCommand/detach so tests assert the
            // press+release sequence and that we always detach.
            debugger: {
                attach: async (target, version) => { debuggerCalls.push(["attach", target, version]); },
                // `onDebuggerCommand(method, params)` lets a test script the reply (e.g. Runtime.evaluate's
                // result / exceptionDetails for the CDP-exec tests); default returns undefined (clicks need none).
                sendCommand: async (target, method, params) => { debuggerCalls.push(["sendCommand", target, method, params]); return onDebuggerCommand ? onDebuggerCommand(method, params) : undefined; },
                detach: async (target) => { debuggerCalls.push(["detach", target]); },
                onDetach: { addListener: () => {} },   // the SW listens for an external detach (DevTools opened, target gone)
                // CDP EVENTS (Runtime.bindingCalled — how a strict-page exec streams its console out live).
                // Tests fire one with bg.emitDebuggerEvent(target, method, params).
                onEvent: {
                    addListener: (fn) => { debuggerEventListeners.add(fn); },
                    removeListener: (fn) => { debuggerEventListeners.delete(fn); },
                },
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
                sendMessage: async (...args) => { tabMessages.push(args); return onTabMessage ? await onTabMessage(...args) : undefined; },
                // The PDF-print flow opens a print.html tab and later removes it by id.
                create: async (props) => { tabsCreated.push(props); return { id: 4242 + tabsCreated.length }; },
                remove: async (id) => { tabsRemoved.push(id); },
            }
        }
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(DIST, "background.js"), "utf8"), context);

    return {
        calls,
        captures,
        tabMessages,
        tabsCreated,
        tabsRemoved,
        pyRuns,
        debuggerCalls,
        debuggerEventListeners,
        /** Fire a CDP event at every listener the SW registered (e.g. Runtime.bindingCalled). */
        emitDebuggerEvent: (target, method, params) => { [...debuggerEventListeners].forEach(fn => fn(target, method, params)); },
        stored,
        localStore,   // chrome.storage.local contents — tests assert a snapshot was kept/removed
        context,      // the vm sandbox — reach test-only globalThis hooks (e.g. __mlSeedBgRunForTest)
        // Simulates chrome.runtime.sendMessage hitting the listener.
        send: (message, sender = {}) =>
            new Promise((resolve) => listeners[0](message, sender, resolve)),
        // Simulates the content script opening a streaming Port. Returns a client
        // handle: send(msg) posts to the background port; onMessage(fn) receives
        // background pushes; messages[] collects them.
        connect: (name = "LLM_STREAM") => {
            const messages = [];
            const clientHandlers = [];
            const backgroundHandlers = [];
            const disconnectHandlers = [];   // background-side port.onDisconnect listeners
            const port = {
                name,
                onMessage: { addListener: (fn) => backgroundHandlers.push(fn) },
                postMessage: (msg) => { messages.push(msg); for (const h of clientHandlers) h(msg); },
                onDisconnect: { addListener: (fn) => disconnectHandlers.push(fn) },
                disconnect: () => {}
            };
            for (const fn of connectListeners) fn(port);
            return {
                messages,
                onMessage: (fn) => clientHandlers.push(fn),
                send: (msg) => { for (const h of backgroundHandlers) h(msg); },
                // Simulate content.js disconnecting the port (what an ABORT_REQUEST triggers) →
                // fires the background's onDisconnect handlers, which abort the streaming fetch.
                disconnect: () => { for (const h of disconnectHandlers) h(); }
            };
        }
    };
}

// Loads content.js + injected.js into one fake "page world" so ml.* calls
// travel the real postMessage relay. `onRuntimeMessage` plays the background:
// it gets the runtime message and returns { data } or { error }.
function loadPageWorld({ onRuntimeMessage, onStream, config, caps } = {}) {
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
    const listeners = {};       // type -> fn[]
    const dispatchedEvents = []; // event types dispatched (for assertions)
    const runtimeMsgListeners = []; // chrome.runtime.onMessage listeners (content.js's reverse channel)

    // A real (jsdom) DOMParser so page-world code that parses HTML strings works in the sandbox — e.g. the
    // fetch_url tool's HTML→Markdown conversion (turndown reads `DOMParser` off the global `window`). The stub
    // `document` below is enough for injected.js's own boot; parsing a fetched HTML page needs the real thing.
    const domParser = new JSDOM("").window.DOMParser;
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
            for (const fn of [...(listeners[event.type] || [])]) fn(event);
            return true;
        },
        postMessage: (data) => {
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
                    // Cross-page housekeeping: injected posts PAGE_ADOPT_HELLO on load → content sends
                    // CONTENT_READY on EVERY page. It carries no run to adopt in these node:vm tests, so
                    // answer it empty and keep it OUT of runtimeCalls (like the config/caps probes) — else it
                    // shifts every relay/agent test's message indices. (The handler itself is tested in
                    // tests/background.test.js against the real background.)
                    if (message && message.type === "CONTENT_READY") { queueMicrotask(() => cb && cb({ adopt: [] })); return; }
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
    vm.runInContext(fs.readFileSync(path.join(DIST, "injected.js"), "utf8"), context);

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

    return { ml: win.ml, runtimeCalls, context, dispatchedEvents, fireRuntimeMessage };
}

// Boots ONLY injected.js over a real jsdom document, so the agent's DOM
// helpers (ml._elPath, ml._describeSkeleton, ...) traverse a faithful DOM
// instead of a hand-rolled fake. No content.js relay — these helpers are pure
// page-context DOM code and never touch the background. `html` is the <body>
// inner HTML. Returns { ml, window, document } for querying in assertions.
function loadDomWorld(html = "") {
    const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
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
        Event: win.Event,
        HTMLImageElement: win.HTMLImageElement,
        // DOM globals the agent tools reference (real in a browser main world).
        Element: win.Element,
        NodeList: win.NodeList,
        HTMLCollection: win.HTMLCollection,
        MutationObserver: win.MutationObserver,
        setTimeout: win.setTimeout.bind(win),
        clearTimeout: win.clearTimeout.bind(win)
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(DIST, "injected.js"), "utf8"), context);
    return { ml: win.ml, window: win, document: win.document };
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
async function loadSidebarWorld({ sync = {}, local = {}, models = [], ollamaModels = null, fetchLlm = () => ({ data: "OK" }), vram = [], psError = null, caps = null, pythonExec = null, listModels = null } = {}) {
    const unloadCalls = [];
    const pyCalls = [];   // PYTHON_EXEC payloads the app sent (the bench)
    const printCalls = [];   // PRINT_SESSION payloads (the PDF export routes its rendered doc to the background)
    let psVram = vram;   // mutable so a test can change the resident set mid-run (setVram)
    const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, { runScripts: "outside-only", pretendToBeVisual: true });
    const win = dom.window;
    _sidebarWins.push(win);   // closed in an after() hook — the VRAM panel's setInterval keeps the event loop alive otherwise
    const syncStore = { debugMode: "overlay", theme: "auto", ...sync };
    const localStore = { ml_debug_fontscale: 1, ...local };
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
                else if (type === "MODEL_CAPS") cb({ data: typeof caps === "function" ? caps(msg.payload && msg.payload.model) : caps });
                else if (type === "OLLAMA_PS") cb(psError ? { error: psError } : { data: psVram });
                else if (type === "OLLAMA_UNLOAD") { unloadCalls.push(msg.payload); cb({ data: [] }); }
                else if (type === "PYTHON_EXEC") { pyCalls.push(msg.payload); cb({ data: typeof pythonExec === "function" ? pythonExec(msg.payload) : (pythonExec || { ok: true, value: 42, stdout: "" }) }); }   // background wraps: { data: PyResult }
                else cb({ data: null });
            },
        },
        storage: {
            sync: { get: (defaults, cb) => cb({ ...defaults, ...syncStore }), set: syncSet },
            local: {
                get: (defaults, cb) => cb({ ...defaults, ...localStore }),
                set: (obj) => Object.assign(localStore, obj)
            },
            onChanged: { addListener: (fn) => changeListeners.push(fn) }
        }
    };
    win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
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
    return { window: win, shadow: win.document, dispatch, raw, tick, flush, changeListeners, syncStore, localStore, unloadCalls, pyCalls, printCalls, setVram };
}

module.exports = { jsonResponse, htmlResponse, streamResponse, loadBackground, loadPageWorld, loadDomWorld, loadSidebarWorld, closeSidebarWorlds, loadDotEnv };

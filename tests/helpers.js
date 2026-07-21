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
function loadBackground({ config = {}, onFetch, onCaptureTab }) {
    const calls = [];
    const captures = [];        // captureVisibleTab arg lists, for screenshot tests
    const listeners = [];
    const connectListeners = [];
    const stored = { ...config };
    const localStore = {};

    const context = {
        console,
        URL,
        TextDecoder,
        TextEncoder,
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
                        const keys = typeof key === "string" ? [key] : Array.isArray(key) ? key : Object.keys(key || {});
                        const out = {};
                        for (const k of keys) if (k in localStore) out[k] = localStore[k];
                        return out;
                    },
                    set: async (obj) => { Object.assign(localStore, obj); }
                }
            },
            runtime: {
                onMessage: { addListener: (fn) => listeners.push(fn) },
                onConnect: { addListener: (fn) => connectListeners.push(fn) }
            },
            tabs: {
                // Records args so tests can assert the windowId; onCaptureTab (if
                // given) provides the data URL or throws to simulate a failure.
                captureVisibleTab: async (...args) => {
                    captures.push(args);
                    return onCaptureTab ? onCaptureTab(...args) : "data:image/png;base64,SHOT";
                }
            }
        }
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(DIST, "background.js"), "utf8"), context);

    return {
        calls,
        captures,
        stored,
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
            const port = {
                name,
                onMessage: { addListener: (fn) => backgroundHandlers.push(fn) },
                postMessage: (msg) => { messages.push(msg); for (const h of clientHandlers) h(msg); },
                onDisconnect: { addListener: () => {} },
                disconnect: () => {}
            };
            for (const fn of connectListeners) fn(port);
            return {
                messages,
                onMessage: (fn) => clientHandlers.push(fn),
                send: (msg) => { for (const h of backgroundHandlers) h(msg); }
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
    const agentConfig = config || { model: "", ocrModel: "" };
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

    const win = {
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
        console,
        Math,
        Date,
        Intl,
        structuredClone,
        Event: class Event { constructor(type) { this.type = type; } },
        window: win,
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
                    queueMicrotask(async () => {
                        let response = onRuntimeMessage ? await onRuntimeMessage(message) : undefined;
                        // Fall back to the default probe answer for the agent's
                        // config/capability lookups, and keep those OUT of
                        // runtimeCalls so model-call indices stay stable for tests.
                        if (response === undefined) {
                            const probe = probeReply(message);
                            if (probe !== undefined) return cb(probe);
                        }
                        runtimeCalls.push(message);
                        cb(response);
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
                }
            }
        }
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(DIST, "content.js"), "utf8"), context);
    vm.runInContext(fs.readFileSync(path.join(DIST, "injected.js"), "utf8"), context);

    return { ml: win.ml, runtimeCalls, context, dispatchedEvents };
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
        console,
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
async function loadSidebarWorld({ sync = {}, local = {}, models = [], ollamaModels = null, fetchLlm = () => ({ data: "OK" }), vram = [], psError = null, caps = null } = {}) {
    const unloadCalls = [];
    const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, { runScripts: "outside-only", pretendToBeVisual: true });
    const win = dom.window;
    _sidebarWins.push(win);   // closed in an after() hook — the VRAM panel's setInterval keeps the event loop alive otherwise
    const syncStore = { sidebar: true, theme: "auto", ...sync };
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
                if (!cb) return;
                const type = msg && msg.type;
                if (type === "LIST_MODELS") cb({ data: models, ollamaModels });
                else if (type === "FETCH_LLM") cb(fetchLlm(msg.payload));
                else if (type === "MODEL_CAPS") cb({ data: typeof caps === "function" ? caps(msg.payload && msg.payload.model) : caps });
                else if (type === "OLLAMA_PS") cb(psError ? { error: psError } : { data: vram });
                else if (type === "OLLAMA_UNLOAD") { unloadCalls.push(msg.payload); cb({ data: [] }); }
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
    return { window: win, shadow: win.document, dispatch, raw, tick, flush, changeListeners, syncStore, localStore, unloadCalls };
}

module.exports = { jsonResponse, htmlResponse, streamResponse, loadBackground, loadPageWorld, loadDomWorld, loadSidebarWorld, closeSidebarWorlds, loadDotEnv };

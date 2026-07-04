// Test harness: loads the extension's plain (non-module) scripts into
// isolated vm contexts with mocked chrome/fetch/window globals, so tests
// exercise the real message contracts without a browser.
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

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

// Loads background.js. `onFetch` receives { url, opts, body } (body already
// JSON-parsed for requests that have one) and returns a response stub.
function loadBackground({ config = {}, onFetch }) {
    const calls = [];
    const listeners = [];
    const stored = { ...config };

    const context = {
        console,
        URL,
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
                }
            },
            runtime: {
                onMessage: { addListener: (fn) => listeners.push(fn) }
            }
        }
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), context);

    return {
        calls,
        stored,
        // Simulates chrome.runtime.sendMessage hitting the listener.
        send: (message, sender = {}) =>
            new Promise((resolve) => listeners[0](message, sender, resolve))
    };
}

// Loads content.js + injected.js into one fake "page world" so ml.* calls
// travel the real postMessage relay. `onRuntimeMessage` plays the background:
// it gets the runtime message and returns { data } or { error }.
function loadPageWorld({ onRuntimeMessage }) {
    const runtimeCalls = [];
    const messageListeners = [];

    const win = {
        addEventListener: (type, fn) => {
            if (type === "message") messageListeners.push(fn);
        },
        removeEventListener: (type, fn) => {
            const i = messageListeners.indexOf(fn);
            if (i >= 0) messageListeners.splice(i, 1);
        },
        postMessage: (data) => {
            queueMicrotask(() => {
                for (const fn of [...messageListeners]) fn({ source: win, data });
            });
        }
    };

    const context = {
        console,
        Math,
        structuredClone,
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
                    runtimeCalls.push(message);
                    queueMicrotask(async () => cb(await onRuntimeMessage(message)));
                }
            }
        }
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(ROOT, "content.js"), "utf8"), context);
    vm.runInContext(fs.readFileSync(path.join(ROOT, "injected.js"), "utf8"), context);

    return { ml: win.ml, runtimeCalls, context };
}

module.exports = { jsonResponse, htmlResponse, loadBackground, loadPageWorld };

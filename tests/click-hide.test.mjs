// click-hide.test.mjs — the extension's UI is hidden around a trusted (CDP) click, so the browser's hit-test reaches the
// page element the act judge resolved beneath it (SITE_PRESENCE gap 8). The worker half runs in the real bundle against
// a mocked chrome (the order of what it sends the tab and the debugger); the shell half is the BUILT sidebar-shell.js in
// jsdom (who may hide it, that the page's own "show" does not lift the worker's hide, and that one click's show does not
// lift another's).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const { loadBackground, FakeMessageChannel, FakeMessageEvent } = require("./helpers");
const { JSDOM } = require("jsdom");

const T = { timeout: 30000 };
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const plain = (x) => JSON.parse(JSON.stringify(x ?? null));
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", cdp: true };
/** The worker's ack bound (sw-cdp.ts `CLICK_HIDE_ACK_MS`), read from the source so a change to it moves the test. */
const CLICK_HIDE_ACK_MS = Number(fs.readFileSync(new URL("../src/sw/sw-cdp.ts", import.meta.url), "utf8").match(/CLICK_HIDE_ACK_MS = (\d+)/)[1]);

/**
 * The worker with a shell on tab 9 answering `CLICK_HIDE` as `answer` says, logging the tab's messages and the
 * debugger's dispatches in one order.
 * @param {(m: any) => any} answer what the shell answers a `CLICK_HIDE`
 */
function clickWorld(answer) {
    const order = [], ids = [];
    const bg = loadBackground({
        config,
        onTabMessage: (tabId, m, opts) => { if (m?.type === "CLICK_HIDE") { ids.push(m.id); order.push(`${m.hidden ? "hide" : "show"}@${tabId}/${opts?.frameId}`); return answer(m); } },
        onDebuggerCommand: (method, params) => { if (method === "Input.dispatchMouseEvent") order.push(params.type); },
    });
    return { bg, order, ids };
}

// --- the worker: hide, wait for the ack, dispatch, show ---

test("a trusted click hides the extension's UI in the tab's top frame first, dispatches once the shell says it hid it, then shows it under the same id", T, async () => {
    const { bg, order, ids } = clickWorld(() => ({ ok: true }));
    assert.deepEqual(plain(await bg.send({ type: "CDP_CLICK", payload: { x: 120, y: 340, tabId: 9 } }, {})), { ok: true });
    await flush();
    assert.deepEqual(order, ["hide@9/0", "mouseMoved", "mousePressed", "mouseReleased", "show@9/0"]);
    assert.ok(typeof ids[0] === "string" && ids[0].length > 0 && ids[1] === ids[0], `the show names the hide's id: ${JSON.stringify(ids)}`);
});

test("two clicks on one tab hold their hides under different ids", T, async () => {
    const { bg, ids } = clickWorld(() => ({ ok: true }));
    await Promise.all([bg.send({ type: "CDP_CLICK", payload: { x: 1, y: 2, tabId: 9 } }, {}), bg.send({ type: "CDP_CLICK", payload: { x: 3, y: 4, tabId: 9 } }, {})]);
    await flush();
    assert.equal(new Set(ids).size, 2, `one id per click: ${JSON.stringify(ids)}`);
});

for (const [what, answer] of [["nothing answers", () => undefined], ["the message has no receiver", () => Promise.reject(new Error("Could not establish connection. Receiving end does not exist."))]])
test(`a tab with no shell (${what}) is clicked without a show, and without waiting out the bound`, T, async () => {
    const { bg, order } = clickWorld(answer);
    const t0 = Date.now();
    assert.deepEqual(plain(await bg.send({ type: "CDP_CLICK", payload: { x: 1, y: 2, tabId: 9 } }, {})), { ok: true });
    await flush();
    assert.ok(Date.now() - t0 < CLICK_HIDE_ACK_MS, "an absent shell held the click");
    assert.deepEqual(order, ["hide@9/0", "mouseMoved", "mousePressed", "mouseReleased"]);
});

test("a shell that never acks (the page holds its main thread) gets no click: it is refused within the bound, and the hide is taken back", T, async () => {
    const { bg, order } = clickWorld(() => new Promise(() => {}));
    const t0 = Date.now();
    const res = plain(await bg.send({ type: "CDP_CLICK", payload: { x: 1, y: 2, tabId: 9 } }, {}));
    const took = Date.now() - t0;
    assert.ok(took >= CLICK_HIDE_ACK_MS - 50 && took < CLICK_HIDE_ACK_MS + 1000, `the refusal took ${took} ms`);
    assert.match(res?.error ?? "", /did not let the extension hide its own UI/, `refused, not clicked: ${JSON.stringify(res)}`);
    await flush();
    assert.deepEqual(order, ["hide@9/0", "show@9/0"], "a click was dispatched onto a point our UI may cover");
});

// --- the shell: the worker's hide, and only the worker's ---

/**
 * The BUILT content.js and sidebar-shell.js in one jsdom window on a page the worker said is visible, with the overlay
 * mounted, and the shell's chrome.runtime listeners captured so a test can deliver a message as any sender.
 */
async function shellWorld() {
    const dom = new JSDOM("<!doctype html><html><head></head><body><p>a page</p></body></html>", { url: "https://allowed.example/", runScripts: "outside-only", pretendToBeVisual: true });
    const w = dom.window, listeners = [], portListeners = [];
    w.chrome = {
        runtime: {
            id: "test", getURL: (p) => `chrome-extension://test/${p}`, lastError: undefined,
            sendMessage: (m, cb) => {
                const answer = m?.type === "CONTENT_READY" ? { open: true, adopt: [] } : undefined;
                if (cb) queueMicrotask(() => cb(answer));
                return Promise.resolve(answer);
            },
            onMessage: { addListener: (f) => listeners.push(f) },
            connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {}, disconnect() {} }),
        },
        storage: {
            sync: { get: (d, cb) => { const r = { ...d, debugMode: "overlay" }; if (cb) cb(r); return Promise.resolve(r); } },
            local: { get: (d, cb) => { if (cb) cb(d || {}); return Promise.resolve(d || {}); }, set: () => Promise.resolve() },
            onChanged: { addListener() {} },
        },
        dom: { openOrClosedShadowRoot: () => null },
    };
    w.MessageChannel = FakeMessageChannel;
    w.MessageEvent = FakeMessageEvent;
    if (!w.matchMedia) w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    const add = w.addEventListener.bind(w);
    w.addEventListener = (t, f, o) => { if (t === "ml-page-port") portListeners.push(f); else add(t, f, o); };
    w.eval(fs.readFileSync(new URL("../dist/content.js", import.meta.url), "utf8"));
    w.eval(fs.readFileSync(new URL("../dist/sidebar-shell.js", import.meta.url), "utf8"));
    await flush(20);
    /** Deliver `msg` to the content scripts' runtime listeners as `sender`, resolving with what was answered (or undefined). */
    const deliver = (msg, sender) => new Promise((resolve) => {
        let async = false;
        for (const f of listeners) if (f(msg, sender, resolve) === true) async = true;
        if (!async) setTimeout(() => resolve(undefined), 50);
    });
    /** Hand the shell a page port, as injected.js does on a visible page, and return its far end. */
    const handOver = () => {
        const ch = new FakeMessageChannel();
        ch.port1.onmessage = () => {};
        for (const f of portListeners) f(new FakeMessageEvent("ml-page-port", { ports: [ch.port2] }));
        return { post: (d) => ch.port1.postMessage(d) };
    };
    const host = () => w.document.getElementById("ml-sb-root");
    const hidden = () => host()?.style.getPropertyValue("visibility") === "hidden" && host()?.style.getPropertyPriority("visibility") === "important";
    return { w, deliver, handOver, host, hidden, close: () => w.close() };
}

const WORKER = { id: "test" };   // this extension, no tab: what the browser stamps on a message from the worker

test("the worker's CLICK_HIDE hides the overlay's host with !important and acks; its show brings it back", T, async () => {
    const s = await shellWorld();
    assert.ok(s.host(), "setup: the overlay is mounted on a visible page");
    assert.deepEqual(plain(await s.deliver({ type: "CLICK_HIDE", hidden: true, id: "a" }, WORKER)), { ok: true });
    assert.ok(s.hidden(), "the host is not hidden with !important, so the host's own `all: initial !important` wins");
    await s.deliver({ type: "CLICK_HIDE", hidden: false, id: "a" }, WORKER);
    assert.equal(s.hidden(), false);
    s.close();
});

for (const [what, sender] of [["a page's content script (a sender with a tab)", { id: "test", tab: { id: 9 } }], ["another extension", { id: "other" }]])
test(`a CLICK_HIDE from ${what} hides nothing and is not answered`, T, async () => {
    const s = await shellWorld();
    assert.equal(await s.deliver({ type: "CLICK_HIDE", hidden: true, id: "a" }, sender), undefined);
    assert.equal(s.hidden(), false);
    s.close();
});

test("the page's own shot \"show\" does not bring the UI back under the worker's click; the worker's show does", T, async () => {
    const s = await shellWorld();
    const page = s.handOver();
    await flush(10);
    await s.deliver({ type: "CLICK_HIDE", hidden: true, id: "a" }, WORKER);
    page.post({ __mlSidebarShot: "hide" });
    page.post({ __mlSidebarShot: "show" });
    await flush(10);
    assert.ok(s.hidden(), "the page lifted the worker's hide: the click would land on our host");
    await s.deliver({ type: "CLICK_HIDE", hidden: false, id: "a" }, WORKER);
    assert.equal(s.hidden(), false, "the worker's show, with no other holder, brings it back");
    s.close();
});

test("one click's show does not lift another click's hide on the same tab; the last show does", T, async () => {
    const s = await shellWorld();
    await s.deliver({ type: "CLICK_HIDE", hidden: true, id: "a" }, WORKER);
    await s.deliver({ type: "CLICK_HIDE", hidden: true, id: "b" }, WORKER);
    await s.deliver({ type: "CLICK_HIDE", hidden: false, id: "a" }, WORKER);
    assert.ok(s.hidden(), "the first click's show lifted the hide under the second click's dispatch");
    await s.deliver({ type: "CLICK_HIDE", hidden: false, id: "b" }, WORKER);
    assert.equal(s.hidden(), false);
    s.close();
});

test("a CLICK_HIDE with no id hides nothing", T, async () => {
    const s = await shellWorld();
    await s.deliver({ type: "CLICK_HIDE", hidden: true }, WORKER);
    assert.equal(s.hidden(), false);
    s.close();
});

test("a worker hide whose show never comes lifts on its own", T, async () => {
    const hold = Number(fs.readFileSync(new URL("../src/sidebar/shell-shot.ts", import.meta.url), "utf8").match(/CLICK_HIDE_HOLD_MS = (\d+)/)[1]);
    const s = await shellWorld();
    await s.deliver({ type: "CLICK_HIDE", hidden: true, id: "a" }, WORKER);
    assert.ok(s.hidden());
    await new Promise((r) => setTimeout(r, hold + 200));
    assert.equal(s.hidden(), false);
    s.close();
});

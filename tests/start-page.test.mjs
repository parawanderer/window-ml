// start-page.test.mjs — the chat page's start box takes images the way a session's composer does: a "+" and a paste,
// a strip of thumbnails, and an image alone is enough to start. What it sends is read off the fake host's commands.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

let h, render, StartPage, ChatStore, FakeHost, saveDraft, saveDraftImages, loadDraftImages, doc, win;
const IMG = "data:image/png;base64,iVBORw0KGgo=";
const IMG2 = "data:image/png;base64,AAAA";
const flush = async (ms = 120) => { await new Promise((r) => setTimeout(r, ms)); };

before(async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true, url: "https://chat.test/" });
    win = dom.window;
    for (const k of ["localStorage", "window", "document", "Node", "FileReader", "Event", "HTMLElement"]) {
        Object.defineProperty(globalThis, k, { value: win[k] ?? dom.window[k], configurable: true, writable: true });
    }
    doc = win.document;
    ({ h, render } = require_("preact"));
    ({ StartPage } = await import("../src/chat/start-page.tsx"));
    ({ ChatStore } = await import("../src/chat/chat-store.ts"));
    ({ FakeHost } = await import("../src/chat/fake-host.ts"));
    ({ saveDraft, saveDraftImages, loadDraftImages } = await import("../src/sidebar/drafts.ts"));
});

const runtime = () => ({ id: "laptop", name: "laptop", kind: "browser", online: true, contractVersion: 1,
    capabilities: { chat: true, agent: true, tabs: true }, grants: [{ scope: "view" }, { scope: "drive" }, { scope: "approve" }, { scope: "screen" }] });

let store, fake, started;
/** Mount the page on a store over a fake host; `started` collects the keys it reports. */
async function mount(initialKind = "agent") {
    fake = new FakeHost({ runtimes: [runtime()] });
    store = new ChatStore(fake);
    store.start();
    await flush();
    const host = doc.getElementById("root");
    render(null, host);
    render(h(StartPage, { store, narrow: true, initialKind, onStarted: (k) => started.push(k) }), host);
    await flush();
    return host;
}
const box = (host) => host.querySelector("textarea");
const type = async (host, text) => { const t = box(host); t.value = text; t.dispatchEvent(new win.Event("input", { bubbles: true })); await flush(); };
/** Paste `items` ({ kind, type, file }) into the box; returns whether the page took the event over. */
const paste = async (host, items) => {
    const e = new win.Event("paste", { bubbles: true, cancelable: true });
    e.clipboardData = { items };
    box(host).dispatchEvent(e);
    await flush();
    return e.defaultPrevented;
};
const imageFile = (name = "a.png") => new win.File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });
const send = (host) => host.querySelector(".chat-start-send");
const startCommands = () => fake.commands.filter((c) => c.type === "agent.start" || c.type === "chat.start");

beforeEach(() => {
    win.localStorage.clear();
    saveDraftImages("start", []);
    started = [];
});

// --- attaching and starting ---

test("an attached image goes out on agent.start with the task", async () => {
    const host = await mount("agent");
    await type(host, "look at this");
    await paste(host, [{ kind: "file", type: "image/png", getAsFile: imageFile }]);
    assert.equal(host.querySelectorAll(".cthumb img").length, 1, "the strip shows it");
    send(host).click();
    await flush();
    const [c] = startCommands();
    assert.equal(c.type, "agent.start");
    assert.equal(c.task, "look at this");
    assert.equal(c.images.length, 1);
    assert.match(c.images[0], /^data:image\/png/);
});

test("an attached image goes out on chat.start with the message", async () => {
    const host = await mount("chat");
    await type(host, "what is this");
    await paste(host, [{ kind: "file", type: "image/png", getAsFile: imageFile }]);
    send(host).click();
    await flush();
    const [c] = startCommands();
    assert.equal(c.type, "chat.start");
    assert.equal(c.images.length, 1);
});

test("with no image the command carries no images key at all", async () => {
    const host = await mount("agent");
    await type(host, "just words");
    send(host).click();
    await flush();
    assert.equal("images" in startCommands()[0], false);
});

// --- an image alone ---

test("an image with no text is enough to start, and a box with neither is not", async () => {
    saveDraftImages("start", []);
    const host = await mount("agent");
    assert.equal(send(host).disabled, true, "nothing to send");
    await paste(host, [{ kind: "file", type: "image/png", getAsFile: imageFile }]);
    assert.equal(send(host).disabled, false, "the image alone is ready");
    send(host).click();
    await flush();
    assert.equal(startCommands()[0].task, "");
    assert.equal(startCommands()[0].images.length, 1);
});

// --- what is left after a start ---

test("a successful start empties the images and the draft", async () => {
    const host = await mount("agent");
    await type(host, "go");
    saveDraft("start", "go");
    await paste(host, [{ kind: "file", type: "image/png", getAsFile: imageFile }]);
    send(host).click();
    await flush();
    assert.equal(started.length, 1);
    assert.deepEqual(loadDraftImages("start"), []);
    assert.equal(host.querySelectorAll(".cthumb img").length, 0);
});

test("a refused start keeps the text and the images, to try again", async () => {
    const host = await mount("agent");
    fake.handlers["agent.start"] = () => ({ ok: false, error: { code: "forbidden", message: "no" } });
    await type(host, "go");
    await paste(host, [{ kind: "file", type: "image/png", getAsFile: imageFile }]);
    send(host).click();
    await flush();
    assert.equal(started.length, 0);
    assert.equal(host.querySelectorAll(".cthumb img").length, 1, "still attached");
    assert.equal(box(host).value, "go");
    assert.equal(loadDraftImages("start").length, 1);
    delete fake.handlers["agent.start"];
});

// --- removing, and the draft ---

test("the × on a thumbnail removes that image", async () => {
    saveDraftImages("start", [IMG, IMG2]);
    const host = await mount("agent");
    assert.equal(host.querySelectorAll(".cthumb img").length, 2);
    host.querySelectorAll(".cthumb-x")[0].click();
    await flush();
    assert.deepEqual(loadDraftImages("start"), [IMG2]);
});

test("images held for the start draft are back when the page is mounted again", async () => {
    saveDraftImages("start", [IMG]);
    const host = await mount("agent");
    assert.equal(host.querySelector(".cthumb img").getAttribute("src"), IMG);
    assert.equal(send(host).disabled, false);
});

// --- seeing an attached image full size ---

test("clicking a thumbnail opens that image full size and keeps it attached", async () => {
    const { installServices, services } = await import("../src/sidebar/services.ts");
    const before = services(), opened = [];
    installServices({ ...before, openLightbox: (src) => opened.push(src) });
    try {
        saveDraftImages("start", [IMG, IMG2]);
        const host = await mount("agent");
        host.querySelectorAll(".cthumb img")[1].click();
        await flush();
        assert.deepEqual(opened, [IMG2]);
        assert.deepEqual(loadDraftImages("start"), [IMG, IMG2]);
    } finally { installServices(before); }
});

// --- paste ---

test("pasting something that is not an image is left to paste its text", async () => {
    const host = await mount("agent");
    const took = await paste(host, [{ kind: "string", type: "text/plain", getAsFile: () => null }]);
    assert.equal(took, false, "not prevented");
    assert.equal(host.querySelectorAll(".cthumb").length, 0);
});

// --- THE UPGRADE: a draft the old code saved ---

test("upgrade: a text-only start draft, as the old code saved it, loads with no images and no error", async () => {
    // The old page wrote only `wml-draft:start`; there was no images entry of any kind.
    win.localStorage.setItem("wml-draft:start", JSON.stringify("an old half-typed task"));
    const host = await mount("agent");
    assert.equal(box(host).value, "an old half-typed task");
    assert.equal(host.querySelectorAll(".cthumb").length, 0);
    assert.equal(send(host).disabled, false);
    send(host).click();
    await flush();
    assert.equal("images" in startCommands()[0], false);
});

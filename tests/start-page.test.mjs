// start-page.test.mjs — the chat page's start box takes images the way a session's composer does: a "+" and a paste,
// a strip of thumbnails, and an image alone is enough to start. What it sends is read off the fake host's commands.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

let h, render, StartPage, ChatStore, FakeHost, saveDraft, saveDraftImages, loadDraftImages, loadDraftFiles, saveDraftFiles, doc, win;
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
    ({ saveDraft, saveDraftImages, loadDraftImages, loadDraftFiles, saveDraftFiles } = await import("../src/sidebar/drafts.ts"));
    // jsdom's File has no arrayBuffer(); a browser's does, and the page reads files through it.
    if (!win.File.prototype.arrayBuffer) win.File.prototype.arrayBuffer = function () { return new Promise((res) => { const r = new win.FileReader(); r.onload = () => res(r.result); r.readAsArrayBuffer(this); }); };
});

const runtime = (caps = {}) => ({ id: "laptop", name: "laptop", kind: "browser", online: true, contractVersion: 1,
    capabilities: { chat: true, agent: true, tabs: true, ...caps }, grants: [{ scope: "view" }, { scope: "drive" }, { scope: "approve" }, { scope: "screen" }] });

let store, fake, started;
/** Mount the page on a store over a fake host; `started` collects the keys it reports. */
async function mount(initialKind = "agent", caps = {}) {
    fake = new FakeHost({ runtimes: [runtime(caps)] });
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
    saveDraftFiles("start", []);
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

// --- attaching text files (docs/spec/FILE_ATTACHMENTS.md, slice 1) ---

const CAN = { attachFiles: true };
const textFile = (name, text, type = "text/plain") => new win.File([new TextEncoder().encode(text)], name, { type });
const pasteFiles = (host, ...files) => paste(host, files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })));
const pills = (host) => [...host.querySelectorAll(".cfiles .file-pill")];
/** The reason a pill gives for refusing its file (a refused pill shows it in place of its summary), or null. */
const why = (pill) => (pill.classList.contains("refused") ? pill.querySelector(".el-pill-txt").textContent : null);

test("a pasted text file shows as a pill with its summary, and goes out on agent.start in files with the task", async () => {
    const host = await mount("agent", CAN);
    await type(host, "why did it fail?");
    const took = await pasteFiles(host, textFile("server.log", "boot ok\nfatal: disk\n"));
    assert.equal(took, true, "the page takes the file over from paste");
    assert.equal(pills(host).length, 1);
    assert.equal(pills(host)[0].querySelector(".el-pill-txt").textContent, "server.log · text, 2 lines");
    assert.equal(why(pills(host)[0]), null);
    send(host).click();
    await flush();
    const [c] = startCommands();
    assert.equal(c.type, "agent.start");
    assert.equal(c.task, "why did it fail?", "the words are untouched: the runtime frames the message");
    assert.deepEqual(c.files, [{ name: "server.log", type: "text/plain", text: "boot ok\nfatal: disk\n" }]);
    assert.equal(pills(host).length, 0, "a started run empties the box");
    assert.deepEqual(loadDraftFiles("start"), []);
});

test("on chat.start the same, and a file alone is enough to start", async () => {
    const host = await mount("chat", CAN);
    assert.equal(send(host).disabled, true);
    await pasteFiles(host, textFile("notes.md", "# hi", "text/markdown"));
    assert.equal(send(host).disabled, false, "a file alone is a message");
    send(host).click();
    await flush();
    const [c] = startCommands();
    assert.equal(c.type, "chat.start");
    assert.equal(c.text, "");
    assert.deepEqual(c.files, [{ name: "notes.md", type: "text/markdown", text: "# hi" }]);
});

test("the + picker and a drop take text files too: the input offers them, a drop attaches", async () => {
    const host = await mount("chat", CAN);
    const input = host.querySelector('input[type="file"]');
    assert.match(input.getAttribute("accept"), /image\/\*/);
    assert.match(input.getAttribute("accept"), /\.log/);
    const drop = new win.Event("drop", { bubbles: true, cancelable: true });
    drop.dataTransfer = { files: [textFile("a.txt", "dropped")], types: ["Files"] };
    host.querySelector(".chat-start-box").dispatchEvent(drop);
    await flush();
    assert.equal(drop.defaultPrevented, true);
    assert.equal(pills(host).length, 1);
    const over = new win.Event("dragover", { bubbles: true, cancelable: true });
    over.dataTransfer = { types: ["text/plain"] };
    host.querySelector(".chat-start-box").dispatchEvent(over);
    assert.equal(over.defaultPrevented, false, "text dragged in keeps the browser's own behaviour");
});

test("a runtime that does not list attachFiles is never sent the field: the file is refused beside its chip, the picker offers images only", async () => {
    const host = await mount("chat", {});
    assert.equal(host.querySelector('input[type="file"]').getAttribute("accept"), "image/*");
    await type(host, "hello");
    await pasteFiles(host, textFile("server.log", "x"));
    assert.equal(pills(host).length, 1);
    assert.match(why(pills(host)[0]), /does not take files yet/);
    send(host).click();
    await flush();
    assert.equal("files" in startCommands()[0], false, "an older runtime would drop it silently, so it is not sent");
});

test("a file that is not text is refused by name next to its chip and is not sent; a PDF gets its own sentence", async () => {
    const host = await mount("chat", CAN);
    await type(host, "look");
    await pasteFiles(host,
        new win.File([new Uint8Array([0xff, 0xfe, 0x00, 0x80])], "x.bin", { type: "application/octet-stream" }),
        new win.File([new TextEncoder().encode("%PDF-1.7")], "report.pdf", { type: "application/pdf" }),
        textFile("ok.txt", "fine"));
    assert.deepEqual(pills(host).map(why), ["x.bin is not a text file", "report.pdf is a PDF, which this runtime does not read", null]);
    send(host).click();
    await flush();
    assert.deepEqual(startCommands()[0].files, [{ name: "ok.txt", type: "text/plain", text: "fine" }], "only what was accepted");
});

test("a runtime that reads PDFs takes one as its bytes on a chat, offers .pdf in the picker, and refuses it on a run", async () => {
    const PDF_CAN = { ...CAN, attachPdf: true };
    const pdf = () => new win.File([new TextEncoder().encode("%PDF-1.7\n")], "paper.pdf", { type: "application/pdf" });
    const chat = await mount("chat", PDF_CAN);
    assert.match(chat.querySelector('input[type="file"]').getAttribute("accept"), /application\/pdf,\.pdf/);
    await pasteFiles(chat, pdf());
    assert.deepEqual(pills(chat).map(why), [null]);
    assert.match(pills(chat)[0].textContent, /paper\.pdf · PDF, 9 B/);
    send(chat).click();
    await flush();
    assert.deepEqual(startCommands().at(-1).files, [{ name: "paper.pdf", type: "application/pdf", data: "JVBERi0xLjcK" }]);

    const agent = await mount("agent", PDF_CAN);
    await pasteFiles(agent, pdf());
    assert.equal(why(pills(agent)[0]), "paper.pdf is a PDF; an agent run will read PDFs in a later change");
});

test("a file over the cap says its size and the limit, with the chat wording on a chat and the agent wording on a run", async () => {
    const big = "x".repeat(210_000);
    const chat = await mount("chat", CAN);
    await pasteFiles(chat, textFile("server.log", big));
    assert.equal(why(pills(chat)[0]), "server.log is too large to send whole: 210 kB; a message takes up to 32 kB of files");
    const agent = await mount("agent", CAN);
    await pasteFiles(agent, textFile("server.log", big));
    assert.match(why(pills(agent)[0]), /^server\.log is too large to send whole: 210 kB; a message takes up to 32 kB of files\. An agent run will read large files on demand in a later change$/);
    assert.equal(send(agent).disabled, true, "a refused file alone is not a message");
});

test("two files that fit alone but not together: the second is refused, and removing the first frees it", async () => {
    const host = await mount("chat", CAN);
    await pasteFiles(host, textFile("a.txt", "a".repeat(20_000)), textFile("b.txt", "b".repeat(20_000)));
    assert.deepEqual(pills(host).map(why), [null, "b.txt is too large to send whole together with the other files: 20 kB; a message takes up to 32 kB of files"]);
    host.querySelectorAll(".cfiles .el-pill-x")[0].click();
    await flush();
    assert.deepEqual(pills(host).map(why), [null], "b.txt now fits");
});

test("the x on a file pill removes that file", async () => {
    const host = await mount("chat", CAN);
    await pasteFiles(host, textFile("a.txt", "a"), textFile("b.txt", "b"));
    host.querySelectorAll(".cfiles .el-pill-x")[0].click();
    await flush();
    assert.deepEqual(pills(host).map((p) => p.querySelector(".el-pill-txt").textContent), ["b.txt · text, 1 line"]);
    assert.deepEqual(loadDraftFiles("start").map((f) => f.name), ["b.txt"]);
});

test("pending files are a draft: back when the page is mounted again, and a refused start keeps them", async () => {
    saveDraftFiles("start", [{ name: "kept.log", type: "text/plain", text: "from before" }]);
    const host = await mount("chat", CAN);
    assert.equal(pills(host)[0].querySelector(".el-pill-txt").textContent, "kept.log · text, 1 line");
    assert.equal(send(host).disabled, false);
    // A start the runtime refuses leaves the box as it was.
    fake.handlers["chat.start"] = () => ({ ok: false, error: { code: "invalid", message: "no" } });
    send(host).click();
    await flush();
    assert.equal(started.length, 0);
    assert.equal(pills(host).length, 1);
    assert.deepEqual(loadDraftFiles("start").map((f) => f.name), ["kept.log"]);
    delete fake.handlers["chat.start"];
});

test("UPGRADE: with files supported and none attached, the command carries no files key", async () => {
    const host = await mount("chat", CAN);
    await type(host, "just words");
    send(host).click();
    await flush();
    assert.equal("files" in startCommands()[0], false);
});

test("what the runtime makes of a started chat: the model gets the blocks, the transcript keeps the chip", async () => {
    const host = await mount("chat", CAN);
    await type(host, "read it");
    await pasteFiles(host, textFile("a.txt", "hello"));
    send(host).click();
    await flush();
    const chat = fake.history(started[0]).find((e) => e.kind === "chat");
    assert.equal(chat.request.messages[0].content, 'read it\n\n<file name="a.txt" type="text/plain" bytes="5">\nhello\n</file>');
    assert.deepEqual(chat.display, { typed: "read it", context: [{ kind: "file", file: { name: "a.txt", type: "text/plain", bytes: 5, lines: 1 } }] });
});

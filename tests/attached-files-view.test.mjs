// attached-files-view.test.mjs — what a person SEES of a text file they attached, and what the exports keep (docs/spec/
// FILE_ATTACHMENTS.md, slice 1): the event carries the file, the calm view draws the words and a chip with its tooltip,
// the raw view is exactly what the model got, and both exports carry that text. Sessions from before the feature
// (no `display` on the event) render and export as they always did.
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
import "./stub-css.mjs";
import { framePrompt } from "../src/agent/prompts.ts";

const dom = new JSDOM("<body></body>", { pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, getComputedStyle: dom.window.getComputedStyle, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Event: dom.window.Event });
const { h, render } = createRequire(import.meta.url)("preact");
const flush = () => new Promise((r) => setTimeout(r, 10));

let MessageTurn, UserBubble, cursorTip, onDebug, sessionMap, serializeSession, sessionToJson;
before(async () => {
    ({ MessageTurn } = await import("../src/sidebar/transcript/reply.tsx"));
    ({ UserBubble } = await import("../src/sidebar/transcript/agent-detail.tsx"));
    ({ cursorTip } = await import("../src/sidebar/ui-kit.tsx"));
    ({ onDebug } = await import("../src/sidebar/debug-reducer.ts"));
    ({ sessionMap } = await import("../src/sidebar/store.ts"));
    ({ serializeSession } = await import("../src/sidebar/export/export.ts"));
    ({ sessionToJson } = await import("../src/sidebar/export/export-json.ts"));
});
beforeEach(() => sessionMap.clear());

const LOG = { name: "server.log", type: "text/plain", text: "boot ok\nlistening\nfatal: disk\n" };
const framed = framePrompt("why did it die?", null, [LOG]);
const chatEvent = (hash, over = {}) => ({
    kind: "chat", id: `${hash}-1`, ts: 5000, save: true, session: { hash, turn: 1 }, streaming: false,
    config: { system: null, model: "m", think: null, schema: false, toolIds: null, maxTokens: null, save: true },
    request: { model: "m", extend: null, messages: [{ role: "user", content: framed.text }], images: null, toolIds: null, schema: false, think: null, maxTokens: null },
    ...over,
});
const resultEvent = (hash) => ({ kind: "chat-result", id: `${hash}-1`, ts: 5001, save: true, session: { hash, turn: 1 }, content: "the disk is full", sources: null, structured: false, model: "m", extend: null, reasoning: null, usage: null });
const mount = async (vnode) => { const root = document.createElement("div"); document.body.appendChild(root); render(vnode, root); await flush(); return root; };

// --- the event carries the file ---

test("a chat event with a display puts the words and the file's descriptor on the turn; the message stays what the model got", () => {
    onDebug(chatEvent("c1", { display: framed.display }));
    const [t] = sessionMap.get("c1").turns;
    assert.equal(t.user, framed.text, "the raw view: the <file> block is in it");
    assert.match(t.user, /<file name="server.log"/);
    assert.deepEqual(t.display, { typed: "why did it die?", context: [{ kind: "file", file: { name: "server.log", type: "text/plain", bytes: 30, lines: 3 } }] });
});

test("UPGRADE: a chat event stored before the feature (no display) reduces as before", () => {
    onDebug(chatEvent("c2", { request: { ...chatEvent("c2").request, messages: [{ role: "user", content: "plain question" }] } }));
    const [t] = sessionMap.get("c2").turns;
    assert.equal(t.user, "plain question");
    assert.equal("display" in t, false);
});

// --- the calm view ---

test("calm view: your words in the bubble, the file as a chip under it with its summary", async () => {
    onDebug(chatEvent("c3", { display: framed.display }));
    onDebug(resultEvent("c3"));
    const root = await mount(h(MessageTurn, { t: sessionMap.get("c3").turns[0], hash: "c3" }));
    assert.equal(root.querySelector(".utext").textContent, "why did it die?", "no <file> block in the bubble");
    const pills = root.querySelectorAll(".sent-ctx .file-pill");
    assert.equal(pills.length, 1);
    assert.equal(pills[0].querySelector(".el-pill-txt").textContent, "server.log · text, 3 lines");
});

test("the chip's info icon uses the panel's tooltip (never `title`) and says it went in full", async () => {
    onDebug(chatEvent("c4", { display: framed.display }));
    const root = await mount(h(MessageTurn, { t: sessionMap.get("c4").turns[0], hash: "c4" }));
    const info = root.querySelector(".file-pill-info");
    assert.equal(info.getAttribute("title"), null, "no browser tooltip");
    assert.equal(info.getAttribute("aria-label"), "Sent to the model in full.", "the accessible name is the same sentence");
    cursorTip.value = null;
    info.dispatchEvent(new dom.window.Event("pointerenter", { bubbles: true }));
    info.dispatchEvent(Object.assign(new dom.window.Event("pointermove", { bubbles: true }), { clientX: 10, clientY: 10 }));
    assert.equal(cursorTip.value?.text, "Sent to the model in full.");
});

test("dev view: the raw switch shows exactly what the model received, the <file> blocks included, and no chip", async () => {
    onDebug(chatEvent("c5", { display: framed.display }));
    const root = await mount(h(MessageTurn, { t: sessionMap.get("c5").turns[0], hash: "c5" }));
    const raw = [...root.querySelectorAll(".rr-toggle button")].find((b) => b.textContent === "raw");
    raw.click();
    await flush();
    assert.equal(root.querySelector(".utext").textContent, framed.text);
    assert.equal(root.querySelector(".file-pill"), null, "the chip is the rendered half");
});

test("a message of only a file draws the chip and no empty bubble text", async () => {
    const only = framePrompt("", null, [LOG]);
    onDebug(chatEvent("c6", { request: { ...chatEvent("c6").request, messages: [{ role: "user", content: only.text }] }, display: only.display }));
    const root = await mount(h(MessageTurn, { t: sessionMap.get("c6").turns[0], hash: "c6" }));
    assert.equal(root.querySelector(".utext"), null);
    assert.ok(root.querySelector(".msg.user.no-text"));
    assert.equal(root.querySelectorAll(".file-pill").length, 1);
});

test("an agent run's task and a steer show the same chip, through the display they already carry", async () => {
    const root = await mount(h(UserBubble, { text: framed.text, ts: 1, display: framed.display }));
    assert.equal(root.querySelector(".utext").textContent, "why did it die?");
    assert.equal(root.querySelectorAll(".file-pill").length, 1);
    assert.match(root.querySelector(".file-pill-info").getAttribute("aria-label"), /in full/);
});

test("UPGRADE: a message with no display (a session from before the feature) is drawn as it always was", async () => {
    onDebug(chatEvent("c7", { request: { ...chatEvent("c7").request, messages: [{ role: "user", content: "old message" }] } }));
    const root = await mount(h(MessageTurn, { t: sessionMap.get("c7").turns[0], hash: "c7" }));
    assert.equal(root.querySelector(".utext").textContent, "old message");
    assert.equal(root.querySelector(".rr-toggle"), null, "no rendered/raw switch where there is nothing to switch");
    assert.equal(root.querySelector(".file-pill"), null);
});

// --- the exports carry what the model saw ---

const chatSession = (display) => ({
    hash: "c8", kind: "chat", model: "m", tag: "saved", createdTs: 1, lastTs: 2, status: "ok", config: {},
    turns: [{ id: "c8-1", ts: 1, user: display ? framed.text : "plain question", ...(display ? { display } : {}), images: null, assistant: "the disk is full", status: "ok" }], steps: [],
});

test("markdown export: the user's turn is the text the model got, with the file's block, and a row names the file", () => {
    const { md } = serializeSession(chatSession(framed.display));
    assert.ok(md.includes('<file name="server.log" type="text/plain" bytes="30">'), "the block is in the export");
    assert.ok(md.includes("fatal: disk"), "and its text");
    assert.match(md, /File: server\.log · text, 3 lines, 30 bytes/);
    assert.match(md, /\*\*User:\*\*\n\nwhy did it die\?\n\n> _File/, "the words come first, as typed");
    assert.match(md, /<summary>User · raw \(as the model got it\)<\/summary>/);
});

test("JSON export: the message text is what the model got, and the descriptor rides in display", () => {
    const doc = sessionToJson(chatSession(framed.display));
    const user = doc.session.messages.find((m) => m.role === "user");
    assert.equal(user.text, framed.text);
    assert.deepEqual(user.display, framed.display);
});

test("an agent run's task: the raw block is in both exports, and the meta names the file", () => {
    const s = { hash: "a1", kind: "agent", model: "m", tag: "session", createdTs: 1, lastTs: 2, status: "ok", turns: [], steps: [],
        task: framed.text, taskDisplay: framed.display, answers: [{ text: "done", ts: 3, atStep: 0, status: "ok" }] };
    const { md } = serializeSession(s);
    assert.ok(md.includes('<file name="server.log"'));
    assert.match(md, /\*\*File:\*\* server\.log/);
    assert.deepEqual(sessionToJson(s).session.messages[0].display, framed.display);
});

test("UPGRADE: a session stored before the feature exports exactly as it did (no File row, no display)", () => {
    const { md } = serializeSession(chatSession(null));
    assert.doesNotMatch(md, /File:|<file/);
    const user = sessionToJson(chatSession(null)).session.messages.find((m) => m.role === "user");
    assert.equal("display" in user, false);
    assert.equal(user.text, "plain question");
});

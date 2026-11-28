// files-panel.test.mjs — the files panel (src/chat/files-panel.tsx) over the client store and the fake host: when a folder is
// asked for, what a row shows, what a `files-changed` hint re-lists, and what the header button says. The panel is a
// plain file tree first; the annotations (hidden, the model's name) are checked as a layer on top of it
// (docs/spec/FILE_ATTACHMENTS.md, "The files panel" and "The file browser shows the mounts").
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
import "./stub-css.mjs";
import { ChatStore } from "../src/chat/chat-store.ts";
import { FakeHost } from "../src/chat/fake-host.ts";
import { SESSION_CONTRACT_VERSION } from "../src/session/session-host.ts";

const dom = new JSDOM("<body></body>", { pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, getComputedStyle: dom.window.getComputedStyle, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Event: dom.window.Event });
const { h, render } = createRequire(import.meta.url)("preact");
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
// An effect runs after paint, which jsdom's `requestAnimationFrame` puts a frame away.
const frame = () => new Promise((r) => setTimeout(r, 60));

let FilesPanel, FilesButton, filesOpen, loadFilesOpen, setFilesOpen, FILES_OPEN_KEY, cursorTip;
before(async () => {
    ({ FilesPanel, FilesButton, filesOpen, loadFilesOpen, setFilesOpen, FILES_OPEN_KEY } = await import("../src/chat/files-panel.tsx"));
    ({ cursorTip } = await import("../src/sidebar/ui-kit.tsx"));
});

const KEY = "r:aaaa0001";
const runtime = { id: "r", name: "r", kind: "browser", online: true, contractVersion: SESSION_CONTRACT_VERSION, capabilities: { chat: true, agent: true }, grants: [{ scope: "view" }, { scope: "drive" }] };
const summary = { id: { runtime: "r", hash: "aaaa0001" }, kind: "agent", status: "running", task: "t", createdTs: 1000, lastTs: 1000, pendingApprovals: 0, saved: true };
const file = (name, over = {}) => ({ name, size: 100, mtimeMs: 1795100000000, ...over });
const dir = (name, children, over = {}) => ({ name, children, ...over });

let host, store, root;
const listed = () => host.commands.filter((c) => c.type === "files.list" && c.limit !== 1).map((c) => `${c.path}${c.cursor ? "@" + c.cursor : ""}`);
async function setup(tree, pageSize) {
    host = new FakeHost({ runtimes: [runtime], sessions: [{ summary }] });
    if (pageSize) host.filesPageSize = pageSize;
    host.setFiles(KEY, tree);
    store = new ChatStore(host);
    store.start();
    await flush();
    store.open(KEY);
    await flush();
    root = document.createElement("div");
    document.body.innerHTML = "";
    document.body.appendChild(root);
    // what the page does with a `files-changed` hint the host delivers on the subscription: the store reacts to it
    return store;
}
const mountPanel = async () => { render(h(FilesPanel, { store, sessionKey: KEY, narrow: false }), root); await frame(); await flush(); };
const rows = () => [...root.querySelectorAll(".fp-row")];
const rowOf = (label) => rows().find((r) => r.querySelector(".fp-name")?.textContent === label);
const click = async (el) => { assert.ok(el, `no such row in: ${root.innerHTML.slice(0, 400)}`); el.dispatchEvent(new dom.window.Event("click", { bubbles: true })); await flush(); };
const prefs = (init = {}) => { const m = new Map(Object.entries(init)); return { get: (k) => m.get(k), set: (k, v) => m.set(k, v), m }; };
const TREE = [
    dir("attached", [file("a.txt"), file("b.txt"), file("c.txt"), dir("sub", [file("deep.txt")])]),
    dir("agent", []),
];

// --- whether the panel is open: closed by default, remembered per device, never moved by an attach ---

beforeEach(() => { filesOpen.value = false; });

test("the panel is closed by default", () => {
    loadFilesOpen(prefs());
    assert.equal(filesOpen.value, false);
});

test("open state survives a reload: the remembered key is read back, and a change is written", () => {
    const p = prefs({ [FILES_OPEN_KEY]: true });
    loadFilesOpen(p);
    assert.equal(filesOpen.value, true, "a reload reads the remembered state");
    setFilesOpen(false);
    assert.equal(p.m.get(FILES_OPEN_KEY), false);
    loadFilesOpen(prefs({ [FILES_OPEN_KEY]: false }));
    assert.equal(filesOpen.value, false);
});

test("an attach moves the count and does not open the panel", async () => {
    await setup(TREE);
    loadFilesOpen(prefs());
    render(h(FilesButton, { store, sessionKey: KEY }), root);
    await flush();
    assert.equal(root.querySelector(".chat-files-n").textContent, "4");
    host.setFiles(KEY, [TREE[0].children ? dir("attached", [...TREE[0].children, file("new.txt")]) : TREE[0], TREE[1]]);
    store.filesChanged(KEY);
    await flush();
    assert.equal(root.querySelector(".chat-files-n").textContent, "5", "the count moved");
    assert.equal(filesOpen.value, false, "and the panel stayed shut");
    assert.equal(root.querySelector(".chat-files-btn").getAttribute("aria-expanded"), "false");
});

// --- the header button: with the agent's count absent it never presents `attached` as the total ---

const hover = (el) => { for (const t of ["pointermove", "PointerMove"]) el.dispatchEvent(new dom.window.Event(t, { bubbles: true })); };

test("with `agent` absent the button's name and tip say \"N attached files\"; with it, the total", async () => {
    await setup(TREE);
    host.filesCountsAgent = false;
    await store.refreshFilesCount(KEY);
    render(h(FilesButton, { store, sessionKey: KEY }), root);
    await flush();
    const btn = root.querySelector(".chat-files-btn");
    assert.equal(btn.getAttribute("aria-label"), "4 attached files");
    cursorTip.value = null;
    hover(btn);
    assert.equal(cursorTip.value?.text, "4 attached files");
    host.filesCountsAgent = true;
    host.setFiles(KEY, [TREE[0], dir("agent", [file("out.json"), file("o2.json")])]);
    await store.refreshFilesCount(KEY);
    await flush();
    assert.equal(root.querySelector(".chat-files-btn").getAttribute("aria-label"), "6 files", "4 attached and 2 made by runs");
});

test("a runtime that does not list files has no button", async () => {
    await setup(TREE);
    host.filesListed = false;
    await store.refreshFilesCount(KEY);
    render(h(FilesButton, { store, sessionKey: KEY }), root);
    await flush();
    assert.equal(root.querySelector(".chat-files-btn"), null);
});

// --- listing: lazy, paged ---

test("a directory is fetched only when it is opened, once, and again after it was closed", async () => {
    await setup(TREE);
    await mountPanel();
    assert.deepEqual(listed(), [""], "only the root while nothing is open");
    assert.deepEqual(rows().map((r) => r.querySelector(".fp-name").textContent), ["attached", "agent"]);
    await click(rowOf("attached"));
    assert.deepEqual(listed(), ["", "attached"]);
    await click(rowOf("attached"));   // close
    assert.equal(rowOf("a.txt"), undefined, "a closed folder holds nothing");
    await click(rowOf("attached"));
    assert.deepEqual(listed(), ["", "attached", "attached"], "reopening asks again, so what it shows is not stale");
});

test("`next` fetches the next page, from a \"more\" row", async () => {
    await setup(TREE);
    host.filesPageSize = 2;
    await mountPanel();
    await click(rowOf("attached"));
    assert.deepEqual(rows().map((r) => r.querySelector(".fp-name").textContent), ["attached", "a.txt", "b.txt", "agent"]);
    const more = root.querySelector(".fp-more");
    assert.ok(more, "a more row");
    await click(more);
    assert.deepEqual(listed(), ["", "attached", "attached@2"]);
    assert.deepEqual(rows().map((r) => r.querySelector(".fp-name").textContent), ["attached", "a.txt", "b.txt", "c.txt", "sub", "agent"]);
    assert.equal(root.querySelector(".fp-more"), null, "none on the last page");
});

// --- rows ---

test("a hidden entry shows its name, a hidden mark, its size and time, and nothing to preview", async () => {
    await setup([dir("attached", [file("keys.env", { hidden: true, size: 2048 })]), dir("agent", [])]);
    await mountPanel();
    await click(rowOf("attached"));
    const r = rowOf("keys.env");
    assert.ok(r.querySelector(".fp-hidden"), "the hidden mark");
    assert.equal(r.querySelector(".fp-hidden").getAttribute("aria-label"), "Hidden", "named, not only drawn");
    assert.equal(r.querySelector(".fp-size").textContent, "2.00 KiB");
    assert.ok(r.querySelector(".fp-time").textContent.length > 0);
    assert.equal(r.tagName, "DIV", "a file row is not a button: there is nothing to open");
    assert.equal(root.querySelector("img, pre, iframe"), null, "no preview");
});

test("two entries with one shown label are two rows, each with its own size", async () => {
    await setup([dir("attached", [file("data.csv", { size: 10 }), file("data.csv", { size: 3000 })]), dir("agent", [])]);
    await mountPanel();
    await click(rowOf("attached"));
    const same = rows().filter((r) => r.querySelector(".fp-name").textContent === "data.csv");
    assert.equal(same.length, 2);
    assert.deepEqual(same.map((r) => r.querySelector(".fp-size").textContent), ["10 B", "2.93 KiB"]);
});

test("a folder whose shown name is shared is not openable and says why; a file of that name needs nothing", async () => {
    await setup([dir("attached", [dir("old", []), dir("old", [])]), dir("agent", [])]);
    await mountPanel();
    await click(rowOf("attached"));
    const olds = rows().filter((r) => r.querySelector(".fp-name").textContent === "old");
    assert.equal(olds.length, 2);
    for (const o of olds) { assert.equal(o.getAttribute("aria-disabled"), "true"); assert.notEqual(o.tagName, "BUTTON"); }
    await click(olds[0]);
    assert.deepEqual(listed(), ["", "attached"], "never asked for through the shared name");
    cursorTip.value = null;
    hover(olds[0]);
    assert.equal(cursorTip.value?.text, "Two entries share this name");
});

test("a row shows `realName` when there is one and carries the annotation; without it the masked name, no annotation", async () => {
    await setup([dir("attached", [file("upload-1.txt", { realName: "quarterly report.txt" }), file("plain.txt")]), dir("agent", [])]);
    await mountPanel();
    await click(rowOf("attached"));
    const r = rowOf("quarterly report.txt");
    assert.ok(r, "the stored name is shown");
    assert.equal(rowOf("upload-1.txt"), undefined);
    const note = r.querySelector(".fp-sees");
    assert.equal(note.getAttribute("aria-label"), "The model sees this as upload-1.txt");
    cursorTip.value = null;
    hover(note);
    assert.equal(cursorTip.value?.text, "The model sees this as upload-1.txt");
    assert.equal(rowOf("plain.txt").querySelector(".fp-notes").children.length, 0, "a row with no annotation is a plain row");
});

test("an empty folder says so, and a failed listing says why where the rows would be", async () => {
    await setup(TREE);
    await mountPanel();
    await click(rowOf("agent"));
    assert.match(root.textContent, /Nothing here yet/);
    host.handlers["files.list"] = (c) => (c.path === "attached" ? { ok: false, error: { code: "unavailable", message: "the runtime is unreachable" } } : undefined);
    await click(rowOf("attached"));
    assert.match(root.querySelector(".fp-error").textContent, /unreachable/);
});

// --- a `files-changed` hint ---

test("a hint naming an open folder re-lists it; one naming a closed folder does not; with no `dirs` every open one is re-listed", async () => {
    await setup(TREE);
    await mountPanel();
    await click(rowOf("attached"));
    await click(rowOf("agent"));
    const before = listed().length;
    store.filesChanged(KEY, { dirs: ["attached"] });
    await flush();
    assert.deepEqual(listed().slice(before), ["attached"], "the named open folder");
    const b2 = listed().length;
    store.filesChanged(KEY, { dirs: ["attached/sub"] });
    await flush();
    assert.deepEqual(listed().slice(b2), [], "a closed folder is left alone");
    const b3 = listed().length;
    store.filesChanged(KEY, {});
    await flush();
    assert.deepEqual(listed().slice(b3).sort(), ["", "agent", "attached"], "every open folder, the root included");
});

test("the hint arrives over the host's subscription and reaches the store through the feed; the panel shows what changed", async () => {
    await setup(TREE);
    await mountPanel();
    await click(rowOf("attached"));
    host.setFiles(KEY, [dir("attached", [file("a.txt"), file("fresh.txt")]), dir("agent", [])]);
    host.filesChanged(KEY, ["attached"]);
    await flush();
    assert.ok(rowOf("fresh.txt"), "listed again");
});

test("a re-list keeps as many pages as were showing", async () => {
    await setup(TREE);
    host.filesPageSize = 2;
    await mountPanel();
    await click(rowOf("attached"));
    await click(root.querySelector(".fp-more"));
    assert.ok(rowOf("sub"));
    store.filesChanged(KEY, { dirs: ["attached"] });
    await flush();
    assert.ok(rowOf("sub"), "the second page is read back, so the list does not shrink under the person");
});

test("the read-only mark shows only where a row differs from its folder", async () => {
    const ro = (n) => ({ ...n, readonly: true, ...(n.children ? { children: n.children.map(ro) } : {}) });
    await setup([ro(dir("attached", [dir("3fa91c2", [file("report.pdf")])])), dir("agent", [file("mine.txt"), file("pinned.txt", { readonly: true })])]);
    await mountPanel();
    await click(rowOf("attached"));
    await click(rowOf("3fa91c2"));
    await click(rowOf("agent"));
    assert.ok(rowOf("attached").querySelector(".fp-ro"), "attached/ differs from the root, which is writable");
    assert.equal(rowOf("report.pdf").querySelector(".fp-ro"), null, "a file inside a read-only folder says nothing more");
    assert.equal(rowOf("mine.txt").querySelector(".fp-ro"), null);
    assert.ok(rowOf("pinned.txt").querySelector(".fp-ro"), "a read-only file in a writable folder is marked");
});

test("a folder row's size cell is empty", async () => {
    await setup(TREE);
    await mountPanel();
    assert.equal(rowOf("attached").querySelector(".fp-size").textContent, "");
});

// The Settings archive folder section (src/sidebar/archive-section.tsx): each permission state says what to do next,
// Brave gets its flag, and a panel framed inside a web page points to the chat page instead of offering a click the
// browser would refuse.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

let h, render, ArchiveFolderBody, BRAVE_FLAG, doc;
before(async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Node = dom.window.Node;
    doc = dom.window.document;
    ({ h, render } = require_("preact"));
    ({ ArchiveFolderBody, BRAVE_FLAG } = await import("../src/sidebar/archive-section.tsx"));
});

const clicks = [];
const base = { archiveOn: true, isBrave: false, canAskHere: true, busy: null, message: "",
    onPick: () => clicks.push("pick"), onRegrant: () => clicks.push("regrant"), onSync: () => clicks.push("sync"), onImport: () => clicks.push("import"), onForget: () => clicks.push("forget") };
const show = (over) => { const host = doc.getElementById("root"); render(null, host); render(h(ArchiveFolderBody, { ...base, ...over }), host); return host; };
const buttons = (host) => [...host.querySelectorAll("button")].map((b) => b.textContent);

test("no folder: one primary action, and why a folder is worth having", () => {
    const host = show({ report: { state: "none", pending: 0, lastSync: null } });
    assert.deepEqual(buttons(host), ["Pick a folder…"]);
    assert.match(host.textContent, /one SQLite file per month/);
    host.querySelector("button").click();
    assert.equal(clicks.at(-1), "pick");
});

test("a lapsed grant: says what happened, what waits, and to choose Allow on every visit", () => {
    const host = show({ report: { state: "needs-grant", name: "Archive", pending: 3, lastSync: 1 } });
    assert.deepEqual(buttons(host), ["Reconnect"]);
    assert.match(host.textContent, /Allow on every visit/);
    assert.match(host.textContent, /3 month files wait to be written\. Nothing is lost/);
});

test("connected: the folder, its last write, and the four actions", () => {
    const host = show({ report: { state: "connected", name: "Archive", pending: 0, lastSync: Date.now() } });
    assert.deepEqual(buttons(host), ["Write now", "Import from this folder", "Change folder…", "Stop using this folder"]);
    assert.match(host.textContent, /Archive, written just now/);
});

test("unsupported: Brave gets its flag to copy, anything else a plain sentence", () => {
    const brave = show({ report: { state: "unsupported", pending: 0, lastSync: null }, isBrave: true });
    assert.ok(brave.textContent.includes(BRAVE_FLAG));
    assert.deepEqual(buttons(brave), ["Copy that address"]);
    const other = show({ report: { state: "unsupported", pending: 0, lastSync: null } });
    assert.match(other.textContent, /does not let an extension use a folder/);
    assert.deepEqual(buttons(other), []);
});

test("inside a web page's frame, a click the browser would refuse becomes where to go instead", () => {
    const host = show({ report: { state: "needs-grant", name: "Archive", pending: 1, lastSync: null }, canAskHere: false });
    assert.deepEqual(buttons(host), []);
    assert.match(host.textContent, /open Settings in the chat page/);
    const conn = show({ report: { state: "connected", name: "Archive", pending: 0, lastSync: null }, canAskHere: false });
    assert.deepEqual(buttons(conn), ["Write now", "Import from this folder", "Stop using this folder"]);
});

test("the archive switched off is said, since nothing would reach the folder", () => {
    const host = show({ report: { state: "none", pending: 0, lastSync: null }, archiveOn: false });
    assert.match(host.textContent, /Archive sessions instead of deleting them/);
});

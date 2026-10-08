// The execution log panel's narrowing controls (src/sidebar/run-log-view.tsx), drawn in jsdom from a fixed DUMP_RUN_LOG
// answer: the least-level choice, offered only when a record is above info and counting what each choice would show,
// and the text filter. The pure filter is tests/run-log.test.mjs; this is the panel around it.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

let h, render, act, V, doc, win;
let events = [];
before(async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true, url: "https://extension.test/" });
    win = dom.window;
    for (const k of ["window", "document", "Node", "HTMLElement", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"])
        globalThis[k] = k === "window" ? win : win[k];
    globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async () => {} }, platform: "Test" } });
    globalThis.chrome = {
        runtime: { sendMessage: (_msg, cb) => cb({ data: { events, runs: [] } }), lastError: undefined },
        storage: { local: { get: (_k, cb) => cb({}), set: () => {} }, onChanged: { addListener: () => {}, removeListener: () => {} } },
    };
    // export.ts imports highlight.js's stylesheet, which esbuild bundles and Node cannot parse: a stylesheet is
    // nothing to a jsdom test, so it loads as an empty module.
    require_.extensions[".css"] = (module) => { module.exports = {}; };
    doc = win.document;
    ({ h, render } = require_("preact"));
    ({ act } = require_("preact/test-utils"));
    V = await import("../src/sidebar/run-log-view.tsx");
});
afterEach(() => { act(() => render(null, doc.getElementById("root"))); });

const rec = (kind, over = {}) => ({ run: "r1", t: 1, origin: "worker", subsystem: "page", kind, ...over });
async function show(list) {
    events = list;
    const host = doc.getElementById("root");
    act(() => render(null, host));
    await act(async () => { render(h(V.RunLogView, { run: "r1" }), host); });
    return host;
}
const openMenu = async (host) => { await act(async () => { host.querySelector(".runlog-menu button").click(); }); };
const choices = (host) => [...host.querySelectorAll('[role="menuitemradio"]')].map((b) => [b.textContent, b.getAttribute("aria-checked")]);
const logText = (host) => host.querySelector("pre.code")?.textContent ?? "";

// --- the least level: a choice only when there is one to make ---

test("no record above info: no level choice, since all three would mean everything", async () => {
    const host = await show([rec("held"), rec("recovered")]);
    await openMenu(host);
    assert.deepEqual(choices(host), []);
});

test("a warning or an error: three choices, each with how many records it would show, Everything chosen", async () => {
    const host = await show([rec("held"), rec("discarded", { level: "warn" }), rec("unreachable", { level: "error", reason: "gone" })]);
    await openMenu(host);
    // The tick is part of a row's text: it marks the chosen one.
    assert.deepEqual(choices(host), [["✓Everything3", "true"], ["Warnings and errors2", "false"], ["Errors only1", "false"]]);
});

test("choosing a level narrows the lines, keeps the choice offered so the way back is there, and Everything restores", async () => {
    const host = await show([rec("held"), rec("discarded", { level: "warn" }), rec("unreachable", { level: "error", reason: "gone" })]);
    await openMenu(host);
    const pick = async (label) => { await act(async () => { [...host.querySelectorAll('[role="menuitemradio"]')].find((b) => b.textContent.startsWith(label)).click(); }); };
    await pick("Errors only");
    assert.match(logText(host), /ERROR/);
    assert.doesNotMatch(logText(host), /held|discarded/);
    await pick("Warnings and errors");
    assert.match(logText(host), /WARN\s+discarded/);
    assert.doesNotMatch(logText(host), /held/);
    await pick("Everything");
    for (const k of ["held", "discarded", "unreachable"]) assert.match(logText(host), new RegExp(k));
});

// --- the text filter ---

test("the text filter hides what does not match, says so when nothing does, and clearing it brings the lines back", async () => {
    const host = await show([rec("held", { detail: { tab: 12 } }), rec("pinned", { subsystem: "tab", detail: { tab: 9 } })]);
    const filter = host.querySelector(".runlog-find");
    const type = async (v) => { await act(async () => { filter.value = v; filter.dispatchEvent(new win.Event("input", { bubbles: true })); }); };
    await type("tab=9");
    assert.match(logText(host), /pinned/);
    assert.doesNotMatch(logText(host), /held/);
    await type("no such mechanic");
    assert.match(host.textContent, /No record matches the filters/);
    await type("");
    assert.match(logText(host), /held/);
    assert.match(logText(host), /pinned/);
});

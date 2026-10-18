// target-pick.test.mjs — when the WHERE picker asks the runtime for tabs again (src/chat/new-session.tsx, `useTargetPick`):
// a full ask when the machine changes, a refresh when the same one re-announces after a worker restart, and a failed
// refresh that keeps the list it had rather than flashing empty (docs/dev/chat-page.md).
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://extension.test/" });
for (const k of ["window", "document", "Node", "HTMLElement", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"])
    globalThis[k] = k === "window" ? dom.window : dom.window[k];
// Through require, NOT `import("preact")`: tsx compiles the component to CJS, and an ESM import here would be a second
// preact whose hooks have no current component (as tests/output-cell.test.mjs says).
const require_ = createRequire(import.meta.url);
const { h, render } = require_("preact");
const { act } = require_("preact/test-utils");
const { useTargetPick } = await import("../src/chat/new-session.tsx");

/* ------------------------------ the ask policy ------------------------------ */

const tab = (tabId, title) => ({ tabId, title, url: `http://127.0.0.1/${tabId}`, active: tabId === 1, windowId: 1 });
const runtime = (id, over = {}) => ({ id, name: id, kind: "browser", online: true, capabilities: { chat: true, agent: true, tabs: true }, ...over });

/** A store whose `tabs.list` answers come from `answers` (each a result or a function returning one), and records the asks. */
function fakeStore(answers) {
    const asks = [];
    let pending = Promise.resolve();
    return {
        asks,
        /** resolves once every ask this store has seen has settled and its setState has drawn */
        settled: () => pending.then(() => new Promise((r) => setTimeout(r, 0))),
        send(cmd) {
            asks.push(cmd);
            const a = answers.length ? answers.shift() : { ok: true, data: { tabs: [] } };
            const p = Promise.resolve(typeof a === "function" ? a() : a);
            pending = pending.then(() => p);
            return p;
        },
    };
}

function Probe({ store, rt, pick }) {
    Object.assign(pick, useTargetPick(store, rt, true));
    return pick.fields;
}

/** A fresh mount point, so two scenarios never share one hook's state (a same-root render updates, it does not remount). */
function mount() {
    return document.body.appendChild(document.createElement("div"));
}

/**
 * Draw the WHERE form against `rt` on `root`. `pick` is filled with the hook's return; the tab titles its native select
 * holds are reported, or null where the form is on "A new tab" and there is no tab select.
 */
async function draw(store, rt, pick, root) {
    await act(async () => { render(h(Probe, { store, rt, pick }), root); });
    await act(async () => { await store.settled(); });
    const sel = root.querySelector('[data-field="tab"] select');
    return sel ? [...sel.querySelectorAll("option")].map((o) => o.textContent) : null;
}

test("a first ask is a full one: the list arrives, and an empty one falls back to a new tab", async () => {
    const pick = {};
    const s = fakeStore([{ ok: true, data: { tabs: [tab(1, "one")] } }]);
    assert.deepEqual(await draw(s, runtime("local"), pick, mount()), ["one"]);
    assert.equal(s.asks.length, 1);
    assert.equal(pick.blank, false, "the runtime's tab is the choice");

    const pick2 = {};
    const s2 = fakeStore([{ ok: true, data: { tabs: [] } }]);
    assert.equal(await draw(s2, runtime("local"), pick2, mount()), null, "no tab select when the answer is a new tab");
    assert.equal(pick2.blank, true, "no tab to run on means a new tab, not a disabled choice");
});

test("the same runtime object re-draws without asking", async () => {
    const root = mount();
    const pick = {};
    const s = fakeStore([{ ok: true, data: { tabs: [tab(1, "one")] } }]);
    const rt = runtime("local");
    assert.deepEqual(await draw(s, rt, pick, root), ["one"]);

    // A parent redraw with the SAME runtime object is not a re-announce: the effect's deps do not move.
    await act(async () => { render(h(Probe, { store: s, rt, pick }), root); });
    await act(async () => { await s.settled(); });
    assert.equal(s.asks.length, 1, "an unrelated redraw does not re-ask");
});

test("a refresh that failed leaves the list it had, and the next re-announce replaces it", async () => {
    const root = mount();
    const pick = {};
    const s = fakeStore([
        { ok: true, data: { tabs: [tab(1, "one")] } },
        // The port is down when the ask lands: a refresh that fails must not drop the list on screen.
        { ok: false, error: { code: "unavailable", message: "the extension's worker restarted" } },
        // The worker re-announces the SAME id under a new object, and the tab opened during the gap is there.
        { ok: true, data: { tabs: [tab(1, "one"), tab(2, "two")] } },
    ]);
    await draw(s, runtime("local"), pick, root);

    // Same id, new object — a re-announce whose ask still fails.
    assert.deepEqual(await draw(s, runtime("local"), pick, root), ["one"], "a failed refresh never blanks the list");

    // Same id, new object again: the worker is answering, and the new tab is in.
    assert.deepEqual(await draw(s, runtime("local"), pick, root), ["one", "two"]);
    assert.equal(s.asks.length, 3);
    assert.ok(s.asks.every((c) => c.type === "tabs.list" && c.runtime === "local"));
});

test("a different machine is a full ask and drops the tab that belonged to the old one", async () => {
    const root = mount();
    const pick = {};
    const s = fakeStore([
        { ok: true, data: { tabs: [tab(1, "desk"), tab(2, "mail")] } },
        { ok: true, data: { tabs: [tab(9, "box"), tab(10, "box2")] } },
    ]);
    await draw(s, runtime("desk"), pick, root);
    assert.equal(pick.target().kind, "tab", "the desk's tab is chosen");

    // The form goes back to "A new tab" — a tab is the old machine's, and silently starting on the new machine's
    // foreground page would be a second choice nobody made. The new machine's list is still asked, so switching the
    // choice back to an open tab has it.
    assert.equal(await draw(s, runtime("box"), pick, root), null);
    assert.equal(pick.blank, true);
    assert.equal(pick.target().kind, "blank");
    assert.equal(s.asks.length, 2);
    pick.useTabs();
    await act(async () => {});
    assert.equal(pick.blank, false);
    assert.equal(pick.target().kind, "tab", "the box's tab is what an open-tab choice now offers");
    assert.equal(s.asks.length, 2, "coming back to tabs does not re-ask: the list was already loaded");
});

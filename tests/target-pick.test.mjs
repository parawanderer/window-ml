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
const { useTargetPick, rememberedTab } = await import("../src/chat/new-session.tsx");
const { lastTargets, targetsFrom } = await import("../src/chat/view-mode.tsx");

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

function Probe({ store, rt, pick, remember = false }) {
    Object.assign(pick, useTargetPick(store, rt, true, undefined, remember));
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
async function draw(store, rt, pick, root, remember = false) {
    await act(async () => { render(h(Probe, { store, rt, pick, remember }), root); });
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

// --- the list is current when you come back to the page: a tab is opened by leaving it ---

test("the page shown again, or its window focused again, re-asks; the choice made stays made", async () => {
    const root = mount();
    const pick = {};
    const s = fakeStore([
        { ok: true, data: { tabs: [tab(1, "one")] } },
        { ok: true, data: { tabs: [tab(1, "one"), tab(2, "opened while away")] } },
        { ok: true, data: { tabs: [tab(1, "one"), tab(2, "opened while away"), tab(3, "and another")] } },
    ]);
    const rt = runtime("local");
    assert.deepEqual(await draw(s, rt, pick, root), ["one"]);
    await act(async () => { window.dispatchEvent(new window.Event("focus")); await s.settled(); });
    assert.deepEqual([...root.querySelectorAll('[data-field="tab"] option')].map((o) => o.textContent), ["one", "opened while away"]);
    await act(async () => { document.dispatchEvent(new window.Event("visibilitychange")); await s.settled(); });
    assert.equal(root.querySelectorAll('[data-field="tab"] option').length, 3);
    assert.equal(s.asks.length, 3);
    assert.deepEqual(pick.target(), { kind: "tab", tabId: 1 }, "a refresh never moves the choice to the new tab");
    // Gone from the screen: nothing asks while nobody can see the answer.
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    try {
        await act(async () => { document.dispatchEvent(new window.Event("visibilitychange")); await s.settled(); });
        assert.equal(s.asks.length, 3, "a page being hidden is not a reason to ask");
    } finally { delete document.visibilityState; }
    // Unmounted: the listeners went with it.
    await act(async () => { render(null, root); });
    window.dispatchEvent(new window.Event("focus"));
    assert.equal(s.asks.length, 3);
});

// --- the last tab picked is offered again, while it is still open ---

test("what a remembered pick means among the tabs open now", () => {
    const tabs = [tab(1, "one"), { ...tab(7, "pr list"), url: "https://github.com/o/r/pulls" }];
    assert.equal(rememberedTab(undefined, tabs), null, "nothing remembered: the usual first guess");
    assert.equal(rememberedTab({ blank: true }, tabs), "blank", "a new tab is always there to go back to");
    assert.equal(rememberedTab({ tabId: 7, url: "https://github.com/o/r/pulls" }, tabs), 7);
    // The same tab, navigated within its site since: still the tab that was picked.
    assert.equal(rememberedTab({ tabId: 7, url: "https://github.com/o/r/pull/12" }, tabs), 7);
    // The same id on ANOTHER site is a browser restart reusing a number, not the tab that was picked.
    assert.equal(rememberedTab({ tabId: 1, url: "https://github.com/o/r/pulls" }, tabs), 7, "found by its address instead");
    assert.equal(rememberedTab({ tabId: 1, url: "https://mail.example/" }, tabs), null, "and nowhere else");
    // Closed: nothing to go back to.
    assert.equal(rememberedTab({ tabId: 99, url: "https://gone.example/" }, tabs), null);
    // An address that does not parse never matches a tab by its id.
    assert.equal(rememberedTab({ tabId: 7, url: "" }, tabs), null);
});

test("the start page offers the remembered tab when it opens, and a resume does not", async () => {
    lastTargets.value = { local: { tabId: 2, url: "http://127.0.0.1/2" } };
    try {
        const answer = () => ({ ok: true, data: { tabs: [tab(1, "front"), tab(2, "picked last time")] } });
        const pick = {};
        await draw(fakeStore([answer()]), runtime("local"), pick, mount(), true);
        assert.deepEqual(pick.target(), { kind: "tab", tabId: 2 }, "the start page goes back to the tab picked last time");

        const resume = {};
        await draw(fakeStore([answer()]), runtime("local"), resume, mount(), false);
        assert.deepEqual(resume.target(), { kind: "tab", tabId: 1 }, "a resume starts from the tab in front, as it did");

        // Remembered per runtime: another machine's pick says nothing here.
        const other = {};
        await draw(fakeStore([answer()]), runtime("desk"), other, mount(), true);
        assert.deepEqual(other.target(), { kind: "tab", tabId: 1 });

        // A remembered NEW tab comes back as one, even with tabs open.
        lastTargets.value = { local: { blank: true } };
        const blank = {};
        await draw(fakeStore([answer()]), runtime("local"), blank, mount(), true);
        assert.equal(blank.blank, true);

        // Closed since: the usual first guess, and no tab that closed is offered.
        lastTargets.value = { local: { tabId: 5, url: "http://127.0.0.1/5" } };
        const closed = {};
        await draw(fakeStore([answer()]), runtime("local"), closed, mount(), true);
        assert.deepEqual(closed.target(), { kind: "tab", tabId: 1 });
    } finally { lastTargets.value = {}; }
});

test("a stored map of the wrong shape reads as nothing remembered, entry by entry", () => {
    assert.deepEqual(targetsFrom(null), {});
    assert.deepEqual(targetsFrom([{ tabId: 1, url: "x" }]), {});
    assert.deepEqual(targetsFrom({ a: { tabId: 1, url: "https://a/" }, b: { blank: true }, c: { tabId: "1", url: "x" }, d: { blank: "yes" }, e: null }),
        { a: { tabId: 1, url: "https://a/" }, b: { blank: true } });
});

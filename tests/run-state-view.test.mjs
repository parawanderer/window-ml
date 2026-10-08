// The Run state panel's view (src/sidebar/run-state-view.tsx), drawn in jsdom from a fixed DUMP_RUN_STATE answer: how a
// member is NAMED (the model's own path, or `inspector.`), what its tooltip says, which chips it carries, when the panel
// says the session holds nothing live, and what a folded group counts. The e2e (chat-page.spec.mjs) covers the same
// panel against a real worker; this enumerates the cases a real run is too slow or too rare to stage.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

let h, render, act, V, ui, doc, win;
let answer = null;
before(async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div><div id='tip'></div></body></html>", { pretendToBeVisual: true, url: "https://extension.test/" });
    win = dom.window;
    for (const k of ["window", "document", "Node", "HTMLElement", "MutationObserver", "getComputedStyle"]) globalThis[k] = k === "window" ? win : win[k];
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async () => {} }, platform: "Test" } });
    globalThis.chrome = {
        runtime: { sendMessage: (_msg, cb) => cb(answer), lastError: undefined },
        storage: { local: { get: (_k, cb) => cb({}), set: () => {} } },
    };
    doc = win.document;
    ({ h, render } = require_("preact"));
    ({ act } = require_("preact/test-utils"));
    V = await import("../src/sidebar/run-state-view.tsx");
    ui = await import("../src/sidebar/ui-kit.tsx");
});
// The view polls on an interval: unmount after every test, or the runner never exits.
afterEach(() => { act(() => render(null, doc.getElementById("root"))); });

const member = (id, over = {}) => ({ id, realm: "worker", scope: "run", audience: "model", lostOn: ["worker-eviction"], describe: `${id} holds things`, ...over });
const entry = (m, value, over = {}) => ({ ...m, value, ...over });
/** Draw the view for run `r1` against this dump, and wait for its first read to land. */
async function show(dump, run = "r1") {
    answer = { data: { ts: 0, ...dump } };
    const host = doc.getElementById("root");
    // A fresh mount each time: the view reads on mount and on its timer, so a re-render with the same run keeps the
    // answer it already has.
    act(() => render(null, host));
    await act(async () => { render(h(V.RunStateView, { run }), host); });
    return host;
}
const row = (host, id) => host.querySelector(`[data-member="${id}"]`);
/** The tooltip a member's name would show, rendered on its own so its rows can be read. */
function tipOf(host, id) {
    const key = row(host, id).querySelector(".rstate-key");
    key.dispatchEvent(new win.PointerEvent("pointermove", { bubbles: true, clientX: 5, clientY: 5 }));
    const node = ui.cursorTip.value?.node;
    const out = doc.getElementById("tip");
    render(node ?? null, out);
    const facts = Object.fromEntries([...out.querySelectorAll(".rc-tip-line")].map((l) => [l.firstElementChild.textContent, l.lastElementChild.textContent]));
    render(null, out);
    return facts;
}

// --- names: the expression that reaches a member ---

test("a member the model reads is named by its ml.current path; any other by `inspector.` and its id, the root dimmed", async () => {
    const exposed = member("run.messages", { exposedAs: "ml.current.messages" });
    const notYet = member("run.pointers"), mine = member("run.mailbox", { audience: "human" });
    const host = await show({ members: [exposed, notYet, mine], entries: [entry(exposed, [1]), entry(notYet, []), entry(mine, [])] });
    assert.equal(row(host, "run.messages").querySelector(".rstate-key").textContent, "ml.current.messages:");
    assert.equal(row(host, "run.messages").querySelector(".rstate-root"), null, "nothing dimmed: it is the model's path");
    assert.equal(row(host, "run.pointers").querySelector(".rstate-key").textContent, "inspector.run.pointers:");
    assert.equal(row(host, "run.pointers").querySelector(".rstate-root").textContent, "inspector.");
    assert.equal(V.memberPath(exposed), "ml.current.messages");
    assert.equal(V.memberPath(mine), "inspector.run.mailbox");
});

test("the tooltip says who reads it, how long it lives, what holds it, what loses it, and its path", async () => {
    const exposed = member("run.messages", { exposedAs: "ml.current.messages", scope: "session" });
    const notYet = member("run.pointers", { realm: "page", lostOn: ["navigation", "turn-end"] });
    const mine = member("grants.call", { audience: "human", lostOn: [] });
    const host = await show({ members: [exposed, notYet, mine], entries: [] });
    assert.deepEqual(tipOf(host, "run.messages"), { "read by": "the model", "lives for": "this session, every turn", "held by": "the service worker",
        "lost when": "the service worker stops (after ~30 s idle)", path: "ml.current.messages" });
    const p = tipOf(host, "run.pointers");
    assert.equal(p["read by"], "meant for the model, not yet");
    assert.equal(p["held by"], "the page");
    assert.equal(p["lost when"], "the tab navigates, or the turn ends");
    assert.equal(tipOf(host, "grants.call")["lost when"], "kept in storage");
    assert.equal(tipOf(host, "grants.call")["read by"], "only you");
});

test("the tooltip's sentence is markdown: a backticked name is code, not backticks", async () => {
    const m = member("run.pointers", { describe: "The run's `@tool:` values." });
    const host = await show({ members: [m], entries: [] });
    row(host, "run.pointers").querySelector(".rstate-key").dispatchEvent(new win.PointerEvent("pointermove", { bubbles: true, clientX: 5, clientY: 5 }));
    const out = doc.getElementById("tip");
    render(ui.cursorTip.value.node, out);
    const desc = out.querySelector(".rstate-tip-desc");
    assert.equal(desc.querySelector("code")?.textContent, "@tool:");
    assert.doesNotMatch(desc.textContent, /`/);
    render(null, out);
});

// --- chips: a decision is marked, a gap is not, and the page's word says so ---

test("chips: \"you only\" for the person's own, none for a model member, \"from the page\" when the member OR its entry is the page's", async () => {
    const mine = member("run.mailbox", { audience: "human" }), model = member("run.init");
    const pageMember = member("run.answer", { realm: "page" }), workerIdPageEntry = member("run.messages");
    const host = await show({
        members: [mine, model, pageMember, workerIdPageEntry],
        entries: [entry(model, {}), entry(workerIdPageEntry, [], { realm: "page" })],
    });
    const chips = (id) => [...row(host, id).querySelectorAll(".rstate-aud")].map((c) => c.textContent);
    assert.deepEqual(chips("run.mailbox"), ["you only"]);
    assert.deepEqual(chips("run.init"), []);
    assert.deepEqual(chips("run.answer"), ["from the page"], "a page member, even holding nothing");
    assert.deepEqual(chips("run.messages"), ["from the page"], "a worker member the page answered for (a page-hosted run)");
});

// --- the sentence for a session this browser holds nothing live for ---

test("nothing live: only in-memory state counts, never the stored log or the name, and a page that could not be asked is its own message", async () => {
    const title = member("session.title", { scope: "session" });
    const log = member("run.log", { audience: "human", lostOn: ["browser-restart"] });
    const init = member("run.init");
    const ms = [title, log, init];
    const idle = async (dump) => !!(await show({ members: ms, ...dump })).querySelector(".rstate-idle");
    assert.equal(await idle({ entries: [] }), true, "nothing at all");
    assert.equal(await idle({ entries: [entry(title, { title: "t" })] }), true, "only its name");
    assert.equal(await idle({ entries: [entry(log, [{ kind: "pinned" }])] }), true, "only its execution log, which outlives the run on purpose");
    assert.equal(await idle({ entries: [entry(title, {}), entry(log, [])] }), true, "both, and still nothing live");
    assert.equal(await idle({ entries: [entry(init, {})] }), false, "one in-memory member and it is live");
    assert.equal(await idle({ entries: [], pageError: "the run's tab is closed" }), false, "the page's own message instead");
    const host = await show({ members: ms, entries: [], pageError: "the run's tab is closed" });
    assert.match(host.textContent, /not shown: the run's tab is closed\./);
});

test("with nothing open the panel says so, and asks the worker for no run", async () => {
    const sent = [];
    const was = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = (msg, cb) => { sent.push(msg.payload); cb({ data: { ts: 0, members: [], entries: [] } }); };
    try {
        const host = doc.getElementById("root");
        await act(async () => { render(h(V.RunStateView, { run: null }), host); });
        assert.match(host.textContent, /Open a session to see what its run holds/);
        assert.deepEqual(sent, [{}]);
    } finally { chrome.runtime.sendMessage = was; }
});

// --- groups ---

test("a folded group counts its members and how many hold something, and draws none of them", async () => {
    const a = member("grants.call"), b = member("grants.fetch"), c = member("grants.turn"), r = member("run.init");
    const host = await show({ members: [a, b, c, r], entries: [entry(b, {}), entry(c, {}), entry(r, {})] });
    const grants = host.querySelector('[data-group="grants"]');
    await act(async () => { grants.querySelector(".rstate-group-head").click(); });
    assert.equal(grants.querySelector(".rstate-count").textContent, "3 members · 2 holding something");
    assert.equal(grants.querySelectorAll(".rstate-member").length, 0);
    assert.equal(host.querySelectorAll('[data-group="run"] .rstate-member').length, 1, "another group is untouched");
    await act(async () => { grants.querySelector(".rstate-group-head").click(); });
    assert.equal(grants.querySelectorAll(".rstate-member").length, 3);
    assert.equal(grants.querySelector(".rstate-count"), null);
});

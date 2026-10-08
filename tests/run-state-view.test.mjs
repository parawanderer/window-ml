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
    for (const k of ["window", "document", "Node", "HTMLElement", "MutationObserver", "getComputedStyle", "requestAnimationFrame"]) globalThis[k] = k === "window" ? win : win[k];
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
        assert.deepEqual(sent, [{ watches: [] }], "ONE read on mount, naming no run");
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

// --- one column of names ---

test("every member's name starts in the same column: an empty one keeps the chevron's width blank", async () => {
    const a = member("run.init"), b = member("run.model"), c = member("run.sub");
    const host = await show({ members: [a, b, c], entries: [entry(a, { task: "x" }), entry(c, 3)] });
    for (const id of ["run.init", "run.model", "run.sub"]) {
        const first = row(host, id).querySelector(".jt-row").firstElementChild;
        assert.ok(first.classList.contains("tri"), `${id} opens with a chevron or its blank`);
    }
    assert.ok(row(host, "run.model").querySelector(".jt-tri-space"), "empty: blank");
    assert.ok(row(host, "run.sub").querySelector(".jt-tri-space"), "a single value: blank");
    assert.equal(row(host, "run.init").querySelector(".jt-tri-space"), null, "a branch: its real chevron");
});

// --- watches: pinned expressions, evaluated by the worker with each read ---

/** Answer each read as the worker would: the dump, plus a result for every watch the panel sent. */
function withWatches(dump, results) {
    const sent = [];
    chrome.runtime.sendMessage = (msg, cb) => {
        sent.push(msg.payload);
        cb({ data: { ts: 0, ...dump, watches: (msg.payload.watches ?? []).map((w) => results[w] ?? { expr: w, nodes: [] }) } });
    };
    return sent;
}
const watchRow = (host, expr) => host.querySelector(`[data-watch="${CSS.escape(expr)}"]`);
globalThis.CSS ??= { escape: (s) => s.replace(/["\\]/g, "\\$&") };

test("a watch typed in is sent with the next read at once, and drawn by what it matched: one value, nothing, or a refusal", async () => {
    V.watches.value = [];
    const init = member("run.init");
    const sent = withWatches({ members: [init], entries: [entry(init, { task: "count" })] }, {
        "inspector.run.init.task": { expr: "inspector.run.init.task", nodes: [{ path: "$['inspector']['run']['init']['task']", value: "count" }] },
        "inspector.run.nope": { expr: "inspector.run.nope", nodes: [] },
        "run.init": { expr: "run.init", error: "a watch starts at inspector. or ml.current." },
    });
    const host = await show({ members: [init], entries: [] });
    const input = host.querySelector(".rstate-watch-input");
    for (const w of ["inspector.run.init.task", "inspector.run.nope", "run.init", "inspector.run.init.task"]) {
        await act(async () => { input.value = w; input.dispatchEvent(new win.Event("input", { bubbles: true })); });
        await act(async () => { input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    }
    assert.deepEqual(V.watches.value, ["inspector.run.init.task", "inspector.run.nope", "run.init"], "a watch already there is not added twice");
    assert.deepEqual(sent.at(-1).watches, V.watches.value, "the latest read carried the whole list");
    assert.match(watchRow(host, "inspector.run.init.task").textContent, /inspector\.run\.init\.task:"count"/);
    assert.match(watchRow(host, "inspector.run.nope").textContent, /no match/);
    assert.match(watchRow(host, "run.init").querySelector(".rstate-watch-err").textContent, /starts at inspector/);
    assert.equal(input.value, "", "the line clears for the next one");
});

test("a watch's ✕ stops watching it, and the list is kept on this device", async () => {
    V.watches.value = ["inspector.a", "inspector.b"];
    const stored = [];
    const was = chrome.storage.local.set;
    chrome.storage.local.set = (o) => stored.push(o);
    try {
        withWatches({ members: [], entries: [] }, {});
        const host = await show({ members: [], entries: [] });
        await act(async () => { watchRow(host, "inspector.a").querySelector(".rstate-unwatch").click(); });
        assert.deepEqual(V.watches.value, ["inspector.b"]);
        assert.deepEqual(stored.at(-1), { ml_runstate_watches: ["inspector.b"] });
        assert.equal(watchRow(host, "inspector.a"), null);
    } finally { chrome.storage.local.set = was; }
});

test("\"Watch this\" on any row of a member watches that row's path", async () => {
    V.watches.value = [];
    const init = member("run.init");
    withWatches({ members: [init], entries: [entry(init, { task: "count", tools: ["exec"] })] }, {});
    const host = await show({ members: [init], entries: [entry(init, { task: "count", tools: ["exec"] })] });
    const first = row(host, "run.init").querySelector(".jt-row");
    first.dispatchEvent(new win.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    assert.deepEqual(ui.ctxMenu.value.items.map((i) => i.label), ["Copy value", "Copy path", "Watch this"]);
    await act(async () => { ui.ctxMenu.value.items.find((i) => i.label === "Watch this").run(); });
    assert.deepEqual(V.watches.value, ["inspector.run.init"]);
    ui.ctxMenu.value = null;
});

test("a JS watch is drawn by its value: a plain path's rows offer \"Watch this\", a computed value's rows only copy", async () => {
    V.watches.value = ["inspector.run.init", "inspector.run.init.tools.length", "inspector.gone"];
    withWatches({ members: [], entries: [] }, {
        "inspector.run.init": { expr: "inspector.run.init", value: { task: "count" }, at: "inspector.run.init" },
        "inspector.run.init.tools.length": { expr: "inspector.run.init.tools.length", value: 2 },
        "inspector.gone": { expr: "inspector.gone", value: undefined },
    });
    const host = await show({ members: [], entries: [] });
    assert.match(watchRow(host, "inspector.run.init.tools.length").textContent, /:2/);
    assert.match(watchRow(host, "inspector.gone").textContent, /undefined/);
    const menuOf = (expr) => {
        watchRow(host, expr).querySelector(".jt-row").dispatchEvent(new win.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
        const items = ui.ctxMenu.value?.items.map((i) => i.label) ?? null;
        ui.ctxMenu.value = null;
        return items;
    };
    assert.deepEqual(menuOf("inspector.run.init"), ["Copy value", "Copy path", "Watch this"]);
    assert.equal(menuOf("inspector.run.init.tools.length"), null, "no path to name, so no path menu");
});

// --- completion in the watch input: over the shape the worker sends with each read ---

const SHAPE = { t: "object", keys: { inspector: { t: "object", keys: { run: { t: "object", keys: {
    init: { t: "object", keys: { task: { t: "string" }, tools: { t: "array", n: 2, item: { t: "string" } } } } } } } } } };
async function typeInto(input, v) {
    await act(async () => { input.value = v; input.setSelectionRange(v.length, v.length); input.dispatchEvent(new win.Event("input", { bubbles: true })); });
}
const key = (input, k) => act(async () => { input.dispatchEvent(new win.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
const offered = (host) => [...host.querySelectorAll(".rstate-complete-row")].map((r) => r.querySelector(".rstate-complete-label").textContent);
const hotRow = (host) => host.querySelector('.rstate-complete-row[aria-selected="true"] .rstate-complete-label')?.textContent ?? null;

test("typing a chain lists what may follow it, with what each holds; Tab takes the highlighted one", async () => {
    V.watches.value = [];
    withWatches({ members: [], entries: [], shape: SHAPE }, {});
    const host = await show({ members: [], entries: [], shape: SHAPE });
    const input = host.querySelector(".rstate-watch-input");
    await typeInto(input, "inspector.run.init.");
    assert.deepEqual(offered(host), ["task", "tools"]);
    assert.equal(host.querySelector(".rstate-complete-row:nth-child(2) .rstate-complete-detail").textContent, "[2]");
    assert.equal(input.getAttribute("aria-expanded"), "true");
    assert.equal(hotRow(host), "task", "the first row is highlighted");
    await key(input, "Tab");
    assert.equal(input.value, "inspector.run.init.task");
    assert.deepEqual(offered(host), [], "a name typed in full has nothing more after it");
    assert.deepEqual(V.watches.value, [], "taking a completion does not add the watch");
});

test("the arrows move the highlight and Enter then takes it; Enter without the arrows adds the watch as typed", async () => {
    V.watches.value = [];
    withWatches({ members: [], entries: [], shape: SHAPE }, {});
    const host = await show({ members: [], entries: [], shape: SHAPE });
    const input = host.querySelector(".rstate-watch-input");
    await typeInto(input, "inspector.run.init.t");
    await key(input, "ArrowDown");
    assert.equal(hotRow(host), "tools");
    await key(input, "ArrowDown");
    assert.equal(hotRow(host), "task", "it wraps");
    await key(input, "ArrowUp");
    await key(input, "Enter");
    assert.equal(input.value, "inspector.run.init.tools");
    assert.deepEqual(V.watches.value, []);
    await typeInto(input, "inspector.run.init.tools.j");
    assert.deepEqual(offered(host), ["join"]);
    await key(input, "Enter");
    assert.deepEqual(V.watches.value, ["inspector.run.init.tools.j"], "the list did not take Enter from a person who never went into it");
});

test("a method is taken with its parenthesis open; Escape shuts the list first and clears the line second", async () => {
    V.watches.value = [];
    withWatches({ members: [], entries: [], shape: SHAPE }, {});
    const host = await show({ members: [], entries: [], shape: SHAPE });
    const input = host.querySelector(".rstate-watch-input");
    await typeInto(input, "inspector.run.init.tools.fil");
    assert.deepEqual(offered(host), ["filter"]);
    await key(input, "Tab");
    assert.equal(input.value, "inspector.run.init.tools.filter(");
    await typeInto(input, "inspector.run.init.");
    await key(input, "Escape");
    assert.deepEqual(offered(host), []);
    assert.equal(input.value, "inspector.run.init.", "the first Escape only shut the list");
    await key(input, "Escape");
    assert.equal(input.value, "");
});

test("a row is taken by pointer, before the input's blur can shut the list", async () => {
    V.watches.value = [];
    withWatches({ members: [], entries: [], shape: SHAPE }, {});
    const host = await show({ members: [], entries: [], shape: SHAPE });
    const input = host.querySelector(".rstate-watch-input");
    await typeInto(input, "inspector.");
    await act(async () => { host.querySelector(".rstate-complete-row").dispatchEvent(new win.PointerEvent("pointerdown", { bubbles: true, cancelable: true })); });
    assert.equal(input.value, "inspector.run");
});

// --- sharing a watch with the model ---

test("the eye shares a watch with the model and stops sharing it; the list is kept beside the watches", async () => {
    V.watches.value = ["ml.current.run.step"];
    V.shared.value = [];
    const stored = [];
    const was = chrome.storage.local.set;
    chrome.storage.local.set = (o) => stored.push(o);
    try {
        withWatches({ members: [], entries: [] }, {});
        const host = await show({ members: [], entries: [] });
        const eye = () => watchRow(host, "ml.current.run.step").querySelector(".rstate-share");
        assert.equal(eye().getAttribute("aria-pressed"), "false");
        await act(async () => { eye().click(); });
        assert.deepEqual(V.shared.value, ["ml.current.run.step"]);
        assert.deepEqual(stored.at(-1), { ml_runstate_shared: ["ml.current.run.step"] });
        assert.equal(eye().getAttribute("aria-pressed"), "true");
        assert.match(eye().className, /\bon\b/);
        await act(async () => { eye().click(); });
        assert.deepEqual(V.shared.value, []);
    } finally { chrome.storage.local.set = was; }
});

test("a watch over inspector. cannot be shared, and its eye says why; removing a shared watch stops sharing it", async () => {
    V.watches.value = ["inspector.grants.turn", "ml.current.run.step"];
    V.shared.value = ["ml.current.run.step"];
    withWatches({ members: [], entries: [] }, {});
    const host = await show({ members: [], entries: [] });
    const eye = watchRow(host, "inspector.grants.turn").querySelector(".rstate-share");
    assert.equal(eye.disabled, true);
    V.toggleShared("inspector.grants.turn");
    assert.deepEqual(V.shared.value, ["ml.current.run.step"], "nor by calling the toggle directly");
    await act(async () => { watchRow(host, "ml.current.run.step").querySelector(".rstate-unwatch").click(); });
    assert.deepEqual(V.shared.value, []);
});

test("no more than MAX_SHARED_WATCHES are shared: past it the other eyes are disabled", async () => {
    const { MAX_SHARED_WATCHES } = await import("../src/state-watch.ts");
    const all = Array.from({ length: MAX_SHARED_WATCHES + 1 }, (_, i) => `ml.current.run.step + ${i}`);
    V.watches.value = all;
    V.shared.value = all.slice(0, MAX_SHARED_WATCHES);
    withWatches({ members: [], entries: [] }, {});
    const host = await show({ members: [], entries: [] });
    assert.equal(watchRow(host, all.at(-1)).querySelector(".rstate-share").disabled, true);
    assert.equal(watchRow(host, all[0]).querySelector(".rstate-share").disabled, false, "a shared one can still be unshared");
    V.toggleShared(all.at(-1));
    assert.equal(V.shared.value.length, MAX_SHARED_WATCHES);
});

// --- the note on a shared watch ---

test("a shared watch has a note line, saved on Enter and kept beside the watches; an unshared one has none", async () => {
    V.watches.value = ["ml.current.run.step", "ml.current.messages.length"];
    V.shared.value = ["ml.current.run.step"];
    V.notes.value = {};
    const stored = [];
    const was = chrome.storage.local.set;
    chrome.storage.local.set = (o) => stored.push(o);
    try {
        withWatches({ members: [], entries: [] }, {});
        const host = await show({ members: [], entries: [] });
        const line = (e) => host.querySelector(`[data-note-for="${CSS.escape(e)}"]`);
        assert.ok(line("ml.current.run.step"));
        assert.equal(line("ml.current.messages.length"), null, "not shared: nothing to say to the model");
        const input = line("ml.current.run.step").querySelector("input");
        await act(async () => { input.value = "  is it climbing?  "; input.dispatchEvent(new win.Event("input", { bubbles: true })); });
        await act(async () => { input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
        assert.deepEqual({ ...V.notes.value }, { "ml.current.run.step": "is it climbing?" });
        assert.deepEqual(stored.at(-1), { ml_runstate_watch_notes: { "ml.current.run.step": "is it climbing?" } });
        // Removing the watch takes its note with it.
        await act(async () => { watchRow(host, "ml.current.run.step").querySelector(".rstate-unwatch").click(); });
        assert.deepEqual({ ...V.notes.value }, {});
    } finally { chrome.storage.local.set = was; }
});

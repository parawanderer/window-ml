// badge.test.mjs — the toolbar badge and START_ASKS (docs/spec/SITE_ACCESS_SLICE3.md 1.2 and PR 3): the count of what is
// waiting for the person, per tab, derived from the start asks; and the popup's read of them, which no page may make.
//
// The worker runs in the real bundle (node:vm, mocked chrome); `bg.badges` is what chrome.action shows on each tab.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");
const { badgeFor, BADGE_IDLE_TITLE } = await import("../src/sw/sw-badge.ts");

const T = { timeout: 30000 };
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const plain = (x) => JSON.parse(JSON.stringify(x ?? null));
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off" };
const A = "https://a.example", B = "https://b.example";
const page = (tab, origin) => ({ tab: { id: tab, url: `${origin}/p` }, url: `${origin}/p`, origin, frameId: 0, documentId: `doc-${tab}` });
const EXT = { url: "chrome-extension://test/popup.html" };
const ONE = "window.ml: an agent start is waiting for you on this tab";
const payload = (runId) => ({ runId, task: "Summarise.", systemPrompt: "S", tools: [], model: "m", think: null, maxSteps: 2,
    autoApprovePython: false, autoApproveReadonly: false, surface: "off" });

/** A worker where sites A (tab 7) and B (tab 8) may use window.ml and are asked before an agent starts. */
function world({ timeoutMs = 4000 } = {}) {
    const events = [];
    const bg = loadBackground({
        config, siteGate: true, siteAgents: null,
        openTabs: [{ id: 7, url: `${A}/p`, title: "A" }, { id: 8, url: `${B}/p`, title: "B" }, { id: 9, url: "https://c.example/", title: "C" }],
        local: { ml_site_schema: 2, ml_site_always: [A, B], ml_site_agents: { [A]: "ask", [B]: "ask" } },
        onFetch: (call) => jsonResponse(call.url.includes("/chat/completions") ? { choices: [{ message: { content: "done" } }] } : {}),
        onTabMessage: async (tabId, msg) => { if (msg.type === "ML_DEBUG_TO_PAGE") events.push(plain(msg.event)); return undefined; },
    });
    bg.context.__mlStartAskTimeoutMsForTest = timeoutMs;
    const asks = () => events.filter((e) => e.kind === "agent-start-ask").map((e) => e.ask);
    /** Start run `runId` from `origin` on `tab`; resolves once its card is up. */
    const start = async (tab, origin, runId) => {
        const n = asks().length;
        void bg.send({ type: "START_RUN", payload: payload(runId) }, page(tab, origin));
        assert.ok(await until(() => asks().length > n), `${runId}: the start card was raised`);
        await flush();
        return asks().at(-1);
    };
    const shown = (tab) => bg.badges.shown(tab);
    return { bg, asks, start, shown };
}

async function until(fn, n = 400) { for (let i = 0; i < n && !fn(); i++) await new Promise((r) => setTimeout(r, 2)); return fn(); }
const idle = { text: "", title: BADGE_IDLE_TITLE };

// --- what the badge says ---

test("badgeFor: nothing is blank with the plain title, one names the agent start, more count to 9 then 9+", () => {
    const asks = (n) => Array.from({ length: n }, (_, i) => ({ requestId: `q${i}`, runId: `r${i}`, tabId: 7, origin: A, since: i }));
    assert.deepEqual(badgeFor([]), idle);
    assert.deepEqual(badgeFor(asks(1)), { text: "1", title: ONE });
    for (const [n, text] of [[2, "2"], [9, "9"], [10, "9+"], [25, "9+"]]) {
        assert.deepEqual(badgeFor(asks(n)), { text, title: `window.ml: ${n} things are waiting for you` }, `n=${n}`);
    }
});

// --- per tab, from the start asks ---

test("at worker start every open tab is cleared (an evicted worker's asks are gone) and the colours are the panel's amber", T, async () => {
    const { bg, shown } = world();
    await flush();
    for (const tab of [7, 8, 9]) assert.deepEqual(shown(tab), idle, `tab ${tab}`);
    assert.deepEqual(bg.badges.get(7), { text: null, title: null }, "tab 7 was reset to the default, not just left alone");
    assert.deepEqual(bg.badges.get("default"), idle);
    assert.deepEqual(bg.badges.colours, { bg: "#eab308", fg: "#1a1400" });
});

test("a start ask counts on its own tab only, and each tab counts its own", T, async () => {
    const w = world();
    await w.start(7, A, "r1");
    assert.deepEqual(w.shown(7), { text: "1", title: ONE });
    assert.deepEqual(w.shown(8), idle);
    await w.start(8, B, "r2");
    assert.deepEqual(w.shown(7), { text: "1", title: ONE });
    assert.deepEqual(w.shown(8), { text: "1", title: ONE });
    assert.deepEqual(w.shown(9), idle);
});

test("the badge clears when the ask settles: by a decision, a timeout, a cancel, or its tab closing", T, async () => {
    // Decision.
    let w = world();
    const ask = await w.start(7, A, "r1");
    void w.bg.send({ type: "SET_START_APPROVAL", payload: { requestId: ask.requestId, decision: "deny" } }, EXT);
    await flush();
    assert.deepEqual(w.shown(7), idle, "after a decision");
    // Timeout.
    w = world({ timeoutMs: 30 });
    await w.start(7, A, "r1");
    assert.ok(await until(() => w.shown(7).text === ""), "after a timeout");
    assert.equal(w.shown(7).title, BADGE_IDLE_TITLE);
    // The person's cancel, from an extension surface.
    w = world();
    await w.start(7, A, "r1");
    await w.start(8, B, "r2");
    void w.bg.send({ type: "CANCEL_RUN", payload: { runId: "r1" } }, EXT);
    await flush();
    assert.deepEqual(w.shown(7), idle, "after a cancel");
    assert.deepEqual(w.shown(8), { text: "1", title: ONE }, "another run's ask still counts");
    // Its tab closing.
    w = world();
    await w.start(7, A, "r1");
    w.bg.closeTab(7);
    await flush();
    assert.deepEqual(w.shown(7), idle, "after its tab closed");
    const r = await w.bg.send({ type: "START_ASKS", payload: { tabId: 7 } }, EXT);
    assert.deepEqual(plain(r.data.asks), [], "the closed tab's ask is gone");
});

// --- START_ASKS: the popup's read ---

test("START_ASKS answers an extension surface with the tab's asks, oldest first, and nothing about another tab", T, async () => {
    const w = world();
    const a = await w.start(7, A, "r1");
    await w.start(8, B, "r2");
    const r = await w.bg.send({ type: "START_ASKS", payload: { tabId: 7 } }, EXT);
    assert.equal(r.data.asks.length, 1);
    assert.equal(r.data.asks[0].requestId, a.requestId);
    assert.equal(r.data.asks[0].origin, A);
    assert.equal(typeof r.data.asks[0].since, "number");
    assert.equal(r.data.shown, undefined, "no show asked, no shown field");
    assert.deepEqual(plain((await w.bg.send({ type: "START_ASKS", payload: { tabId: 9 } }, EXT)).data.asks), []);
    assert.match((await w.bg.send({ type: "START_ASKS", payload: {} }, EXT)).error, /tabId/);
});

test("START_ASKS show opens the card on its own tab's top frame; an ask of another tab shows nothing", T, async () => {
    const w = world();
    const a = await w.start(7, A, "r1");
    const b = await w.start(8, B, "r2");
    const shows = () => w.bg.tabMessages.filter(([, m]) => m?.type === "ML_SHOW_START_ASK").map(([tab, m, o]) => ({ tab, runId: m.runId, frameId: o?.frameId }));
    // Tab 7's popup naming tab 8's ask: refused, and nothing reaches either tab.
    const cross = await w.bg.send({ type: "START_ASKS", payload: { tabId: 7, show: b.requestId } }, EXT);
    assert.equal(cross.data.shown, false);
    assert.deepEqual(shows(), []);
    const own = await w.bg.send({ type: "START_ASKS", payload: { tabId: 7, show: a.requestId } }, EXT);
    assert.equal(own.data.shown, true);
    await flush();
    assert.deepEqual(shows(), [{ tab: 7, runId: "r1", frameId: 0 }]);
});

test("START_ASKS is no page's to send: a page, even one whose site may start agents, is refused and learns no ask", T, async () => {
    const w = world();
    const a = await w.start(7, A, "r1");
    for (const sender of [page(7, A), page(8, B), page(9, "https://c.example")]) {
        const r = await w.bg.send({ type: "START_ASKS", payload: { tabId: 7, show: a.requestId } }, sender);
        assert.equal(r?.data, undefined, `${sender.origin} got an answer`);
        assert.doesNotMatch(JSON.stringify(r ?? null), new RegExp(a.requestId), `${sender.origin} learned the request id`);
    }
    await flush();
    assert.deepEqual(w.bg.tabMessages.filter(([, m]) => m?.type === "ML_SHOW_START_ASK"), [], "a page made a card show");
});

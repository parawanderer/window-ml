// sw-side-panel.test.mjs — the side panel of a hidden page (docs/spec/SITE_PRESENCE.md step 4): the cut that keeps a run's UI
// out of a hidden page, the per-tab panel options, the cues a gesture leaves for a panel, the start gesture, and the
// red-team halves: a page (a sender with a tab, or a web URL) gets no panel port, starts no run through PANEL_START_RUN and
// reads nothing of PANEL_WAITS.
//
// sw-side-panel.ts, sw-badge.ts and sw-consent.ts are imported directly over a mocked `chrome`; the router and the port
// server run in the real bundle (node:vm, tests/helpers.js).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");

const VIS = "https://vis.example", HID = "https://hid.example";
const EXT = "chrome-extension://test/";
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

// --- a mocked chrome the direct imports run over ---

/** What the mock records, and the knobs a test turns. */
const rec = { setOptions: [], sent: [], opens: [], openResult: "resolve", tabUrls: {}, latches: null, readFails: false, titles: [] };
globalThis.chrome = {
    runtime: { getURL: (p = "") => `${EXT}${p}` },
    storage: {
        local: {
            get: async () => {
                if (rec.readFails) throw new Error("storage unreadable");
                if (rec.latches) await new Promise((r) => rec.latches.push(r));
                return { ml_site_schema: 2, ml_site_always: [VIS] };
            },
            set: async () => {},
        },
        sync: { get: async () => ({}) },
        session: { get: async () => ({}), set: async () => {} },
    },
    tabs: {
        get: async (id) => ({ id, url: rec.tabUrls[id] }),
        query: async () => [],
        sendMessage: async (tabId, message, options) => { rec.sent.push({ tabId, message, options }); },
    },
    sidePanel: {
        setOptions: async (o) => { rec.setOptions.push(o); },
        open: (o) => { rec.opens.push(o); return rec.openResult === "resolve" ? Promise.resolve() : Promise.reject(new Error("No active side panel")); },
    },
};

const SP = await import("../src/sw/sw-side-panel.ts");
const consent = await import("../src/sw/sw-consent.ts");
const badge = await import("../src/sw/sw-badge.ts");
const runs = await import("../src/sw/sw-runs.ts");

beforeEach(() => {
    SP.resetSidePanelForTest();
    Object.assign(rec, { setOptions: [], sent: [], opens: [], openResult: "resolve", tabUrls: {}, latches: null, readFails: false, titles: [] });
    globalThis.chrome.sidePanel = SP_MOCK;
    consent.pendingApprovals.clear();
    runs.runInboxes.clear();
});
const SP_MOCK = globalThis.chrome.sidePanel;

/** A side panel's end of a port, as the worker sees it. */
function fakePort(o = {}) {
    const name = o.name ?? "ml-sidepanel", sender = "sender" in o ? o.sender : { url: `${EXT}sidepanel.html?tabId=5` };
    const onMsg = [], onDisc = [], posted = [];
    let disconnected = false;
    const port = {
        name, sender, posted,
        onMessage: { addListener: (f) => onMsg.push(f) },
        onDisconnect: { addListener: (f) => onDisc.push(f) },
        postMessage: (m) => { posted.push(m); },
        disconnect: () => { disconnected = true; },
    };
    return { port, posted, wasDisconnected: () => disconnected, say: (m) => onMsg.forEach((f) => f(m)), hangUp: () => onDisc.forEach((f) => f()) };
}
const open = (tabId, opts) => { const p = fakePort(opts); SP.servePanelPort(p.port); p.say({ type: "ml-sidepanel-init", tabId }); return p; };

// --- the cut: a hidden page gets nothing of the run's UI ---

test("toPageUi: sends to the tab when the page is visible (presence full)", async () => {
    rec.tabUrls[5] = `${VIS}/p`;
    SP.toPageUi(5, { type: "M1" }, { frameId: 0 });
    await flush();
    assert.deepEqual(rec.sent, [{ tabId: 5, message: { type: "M1" }, options: { frameId: 0 } }]);
});

test("toPageUi: sends NOTHING to a hidden page (any presence but full)", async () => {
    rec.tabUrls[5] = `${HID}/p`;
    SP.toPageUi(5, { type: "M1" });
    await flush();
    assert.deepEqual(rec.sent, []);
});

test("toPageUi: sends NOTHING when the presence read rejects (a failed read counts as hidden)", async () => {
    rec.tabUrls[5] = `${VIS}/p`;
    rec.readFails = true;
    SP.toPageUi(5, { type: "M1" });
    await flush();
    assert.deepEqual(rec.sent, []);
    assert.equal(await SP.tabHidden(5), true);
});

test("toPageUi: without chrome.sidePanel it always sends, even to a hidden page, synchronously", () => {
    delete globalThis.chrome.sidePanel;
    rec.tabUrls[5] = `${HID}/p`;
    SP.toPageUi(5, { type: "M1" });
    assert.equal(rec.sent.length, 1);
    assert.equal(rec.sent[0].tabId, 5);
});

test("toPageUi: messages to one tab keep their order while the read is in flight", async () => {
    rec.tabUrls[5] = `${VIS}/p`;
    rec.latches = [];
    SP.toPageUi(5, { type: "A" });
    SP.toPageUi(5, { type: "B" });
    SP.toPageUi(5, { type: "C" });
    await flush();
    assert.equal(rec.latches.length, 1, "one read serves the three sends");
    rec.latches.forEach((r) => r());
    await flush();
    assert.deepEqual(rec.sent.map((s) => s.message.type), ["A", "B", "C"]);
});

// --- the panel's options follow the document ---

test("notePage: a hidden document gets its panel enabled at sidepanel.html?tabId=N", async () => {
    assert.equal(await SP.notePage(5, `${HID}/p`), true);
    await flush();
    assert.deepEqual(rec.setOptions, [{ tabId: 5, path: "sidepanel.html?tabId=5", enabled: true }]);
    assert.equal(SP.tabHiddenNow(5), true);
});

test("notePage: a visible document gets its panel disabled", async () => {
    assert.equal(await SP.notePage(5, `${VIS}/p`), false);
    await flush();
    assert.deepEqual(rec.setOptions, [{ tabId: 5, enabled: false }]);
    assert.equal(SP.tabHiddenNow(5), false);
});

test("notePage: a stale read does not overwrite the later one for the same tab", async () => {
    rec.latches = [];
    void SP.notePage(5, `${HID}/old`);
    void SP.notePage(5, `${VIS}/new`);
    await flush();
    assert.equal(rec.latches.length, 2);
    rec.latches[1]();   // the newer read settles first
    await flush();
    rec.latches[0]();   // the older one after
    await flush();
    assert.deepEqual(rec.setOptions, [{ tabId: 5, enabled: false }], "only the newer read wrote options");
    assert.equal(SP.tabHiddenNow(5), false);
});

// --- the cues a gesture leaves for a panel ---

const cueN = (n) => ({ n });

test("cuePanel: queues while no port is connected; tabsWithCues lists the tab; panelOpen is false", () => {
    SP.cuePanel(5, cueN(1));
    assert.deepEqual(SP.tabsWithCues(), [5]);
    assert.equal(SP.panelOpen(5), false);
});

test("cuePanel: caps the queue at 8, dropping the oldest", () => {
    for (let i = 1; i <= 11; i++) SP.cuePanel(5, cueN(i));
    const p = open(5);
    assert.deepEqual(p.posted.map((m) => m.cue.n), [4, 5, 6, 7, 8, 9, 10, 11]);
});

test("cuePanel: queued cues flush in order on ml-sidepanel-init from an accepted port, then the queue is empty", () => {
    SP.cuePanel(5, cueN(1)); SP.cuePanel(5, cueN(2)); SP.cuePanel(6, cueN(9));
    const p = open(5);
    assert.deepEqual(p.posted, [{ cue: cueN(1) }, { cue: cueN(2) }]);
    assert.equal(SP.panelOpen(5), true);
    assert.deepEqual(SP.tabsWithCues(), [6], "tab 5's cues were handed over; tab 6 still waits");
});

test("cuePanel: posts directly to an open panel and queues nothing", () => {
    const p = open(5);
    SP.cuePanel(5, cueN(1));
    assert.deepEqual(p.posted, [{ cue: cueN(1) }]);
    assert.deepEqual(SP.tabsWithCues(), []);
});

test("tabsWithCues: leaves out a tab whose panel is open", () => {
    SP.cuePanel(5, cueN(1));
    SP.cuePanel(6, cueN(1));
    open(6);   // flushes 6's cue
    SP.cuePanel(5, cueN(2));
    assert.deepEqual(SP.tabsWithCues(), [5]);
});

test("forgetTab: drops the tab's cues and its remembered presence", async () => {
    SP.cuePanel(5, cueN(1));
    await SP.notePage(5, `${HID}/p`);
    SP.forgetTab(5);
    assert.deepEqual(SP.tabsWithCues(), []);
    assert.equal(SP.tabHiddenNow(5), undefined);
    assert.deepEqual(open(5).posted, []);
});

test("onPanelsChanged: fires when a cue is queued, a port connects and disconnects", () => {
    let n = 0;
    SP.onPanelsChanged(() => { n++; });
    SP.cuePanel(5, cueN(1));
    assert.equal(n, 1);
    const p = open(5);
    assert.equal(n, 2);
    p.hangUp();
    assert.equal(n, 3);
});

// --- servePanelPort: only the extension's own page, once ---

test("servePanelPort: disconnects a port whose sender has a tab (a content script's page)", () => {
    const p = fakePort({ sender: { url: `${EXT}sidepanel.html`, tab: { id: 5 } } });
    SP.servePanelPort(p.port);
    assert.equal(p.wasDisconnected(), true);
    p.say({ type: "ml-sidepanel-init", tabId: 5 });
    assert.equal(SP.panelOpen(5), false);
});

test("servePanelPort: disconnects a port from a web URL, and one with no sender url", () => {
    for (const sender of [{ url: "https://hid.example/p" }, { url: `${EXT.replace("test", "other")}x.html` }, {}, undefined]) {
        const p = fakePort({ sender });
        SP.servePanelPort(p.port);
        assert.equal(p.wasDisconnected(), true, String(JSON.stringify(sender)));
        p.say({ type: "ml-sidepanel-init", tabId: 5 });
    }
    assert.equal(SP.panelOpen(5), false);
});

test("servePanelPort: ignores a port with another name", () => {
    const p = fakePort({ name: "ml-devtools", sender: { url: "https://hid.example/p" } });
    SP.servePanelPort(p.port);
    assert.equal(p.wasDisconnected(), false);
    p.say({ type: "ml-sidepanel-init", tabId: 5 });
    assert.equal(SP.panelOpen(5), false);
});

test("servePanelPort: ignores a second init on the same port, and an init without a numeric tabId", () => {
    const p = fakePort();
    SP.servePanelPort(p.port);
    p.say({ type: "ml-sidepanel-init", tabId: "5" });
    assert.equal(SP.panelOpen(5), false);
    p.say({ type: "ml-sidepanel-init", tabId: 5 });
    p.say({ type: "ml-sidepanel-init", tabId: 6 });
    assert.equal(SP.panelOpen(5), true);
    assert.equal(SP.panelOpen(6), false);
});

test("servePanelPort: removes the port on disconnect", () => {
    const p = open(5);
    assert.equal(SP.panelOpen(5), true);
    p.hangUp();
    assert.equal(SP.panelOpen(5), false);
});

test("servePanelPort: a tab keeps its panel open until its last port goes", () => {
    const a = open(5), b = open(5);
    a.hangUp();
    assert.equal(SP.panelOpen(5), true);
    b.hangUp();
    assert.equal(SP.panelOpen(5), false);
});

// --- startGesture: open inside the gesture, then decide ---

test("startGesture: calls sidePanel.open synchronously, before it returns", () => {
    SP.startGesture(5, async () => cueN(1), () => {});
    assert.deepEqual(rec.opens, [{ tabId: 5 }]);
});

test("startGesture: when open resolves the cue goes to the panel and inPage is NOT called", async () => {
    const p = open(5);
    let inPage = 0;
    SP.startGesture(5, async () => cueN(1), () => { inPage++; });
    await flush();
    assert.equal(inPage, 0);
    assert.deepEqual(p.posted, [{ cue: cueN(1) }]);
});

test("startGesture: open rejects and the re-read says full -> inPage runs, no cue", async () => {
    rec.openResult = "reject";
    rec.tabUrls[5] = `${VIS}/p`;
    let inPage = 0;
    SP.startGesture(5, async () => cueN(1), () => { inPage++; });
    await flush();
    assert.equal(inPage, 1);
    assert.deepEqual(SP.tabsWithCues(), []);
});

test("startGesture: open rejects but the re-read says hidden -> nothing in the page, the cue waits for the panel", async () => {
    rec.openResult = "reject";
    rec.tabUrls[5] = `${HID}/p`;
    let inPage = 0;
    SP.startGesture(5, async () => cueN(1), () => { inPage++; });
    await flush();
    assert.equal(inPage, 0);
    assert.deepEqual(SP.tabsWithCues(), [5]);
    assert.deepEqual(open(5).posted, [{ cue: cueN(1) }]);
});

test("openPanelNow: false without chrome.sidePanel, and when open throws synchronously", async () => {
    globalThis.chrome.sidePanel = { open: () => { throw new Error("gesture lost"); } };
    assert.equal(await SP.openPanelNow(5), false);
    delete globalThis.chrome.sidePanel;
    assert.equal(await SP.openPanelNow(5), false);
});

// --- the router and the port server, in the real bundle ---

const A = "https://a.example";
const pageSender = (tab = 7) => ({ tab: { id: tab, url: `${A}/p` }, url: `${A}/p`, origin: A, frameId: 0, documentId: `doc-${tab}` });
const EXT_SENDER = { url: `${EXT}sidepanel.html?tabId=7` };
const worker = () => loadBackground({
    config: { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "m", apiFormat: "openai", ocrModel: "", debugMode: "off" },
    siteGate: true,
    openTabs: [{ id: 7, url: `${A}/p`, title: "A" }],
    local: { ml_site_schema: 2, ml_site_always: [A], ml_site_agents: { [A]: "ask" } },
    onFetch: () => jsonResponse({ choices: [{ message: { content: "done" } }] }),
});
const RUN = { task: "t", systemPrompt: "S", tools: [], model: "m", maxSteps: 2 };

test("PANEL_START_RUN: refused for a page sender (a tab set), even with a numeric tabId", async () => {
    const bg = worker();
    const res = await bg.send({ type: "PANEL_START_RUN", payload: { ...RUN, tabId: 7 } }, pageSender());
    assert.equal(res?.data, undefined);
    assert.ok(res?.error, "an error came back");
    assert.equal(bg.fetchCalls?.length ?? 0, 0);
});

test("PANEL_START_RUN: refused for a non-extension url with no tab", async () => {
    const bg = worker();
    const res = await bg.send({ type: "PANEL_START_RUN", payload: { ...RUN, tabId: 7 } }, { url: "https://evil.example/p" });
    assert.equal(res?.data, undefined);
    assert.ok(res?.error);
});

test("PANEL_START_RUN: refused for an extension url that carries a tab", async () => {
    const bg = worker();
    const res = await bg.send({ type: "PANEL_START_RUN", payload: { ...RUN, tabId: 7 } }, { url: `${EXT}x.html`, tab: { id: 7 } });
    assert.equal(res?.error, "refused");
});

test("PANEL_START_RUN: refused without a numeric tabId", async () => {
    const bg = worker();
    for (const payload of [RUN, { ...RUN, tabId: "7" }, { ...RUN, tabId: null }, undefined]) {
        const res = await bg.send({ type: "PANEL_START_RUN", payload }, EXT_SENDER);
        assert.equal(res?.error, "refused", String(JSON.stringify(payload)).slice(0, 40));
    }
});

test("PANEL_START_RUN: the panel starts a run on the tab it names, a hidden one, with the tools in our world only", async () => {
    const adopts = [];
    const bg = loadBackground({
        config: { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "m", apiFormat: "openai", ocrModel: "", debugMode: "off" },
        siteGate: true,
        openTabs: [{ id: 8, url: "https://hidden.example/p", title: "H" }],
        local: { ml_site_schema: 2 },
        onFetch: () => jsonResponse({ choices: [{ message: { content: "done" } }] }),
        onTabMessage: async (_tab, msg) => {
            if (msg.type !== "ADOPT_RUN_NOW") return undefined;
            adopts.push(msg.payload);
            return msg.payload.injected === true ? { pageInfo: "here" } : { needInject: true };
        },
    });
    const res = await bg.send({ type: "PANEL_START_RUN", keep: false, payload: { task: "read it", surface: "hud", tabId: 8 } }, { url: `${EXT}sidepanel.html?tabId=8` });
    assert.ok(res?.data?.hash, `the run started: ${JSON.stringify(res)}`);
    assert.ok(adopts.length >= 1, "the run adopted the named tab");
    const ex = bg.scriptingCalls.filter(([k]) => k === "executeScript").map(([, i]) => i);
    assert.ok(ex.length >= 1 && ex.every((i) => i.world === "ISOLATED" && i.target.tabId === 8), JSON.stringify(ex));
});

test("PANEL_WAITS: refused for a page sender and for a web url; the extension gets { tabs }", async () => {
    const bg = worker();
    for (const sender of [pageSender(), { url: "https://evil.example/p" }, {}]) {
        const res = await bg.send({ type: "PANEL_WAITS" }, sender);
        assert.equal(res?.data, undefined, JSON.stringify(sender));
        assert.ok(res?.error, JSON.stringify(sender));
    }
    const ok = await bg.send({ type: "PANEL_WAITS" }, EXT_SENDER);
    assert.deepEqual(JSON.parse(JSON.stringify(ok)), { data: { tabs: [] } });
});

test("ml-sidepanel port (sw-debug): a page's port gets no debug feed and is dropped by the panel server", async () => {
    const bg = worker();
    for (const sender of [{ url: "https://evil.example/p" }, { url: `${EXT}sidepanel.html`, tab: { id: 7 } }, pageSender()]) {
        const port = bg.connect("ml-sidepanel", sender);
        port.send({ type: "ml-sidepanel-init", tabId: 7 });
        await flush();
        assert.equal(port.wasDisconnected(), true, JSON.stringify(sender));
        assert.deepEqual(port.messages, [], `no replay for ${JSON.stringify(sender)}`);
    }
});

test("ml-sidepanel port (sw-debug): an extension page with no tab gets the replay once; a second init is ignored", async () => {
    const bg = worker();
    const port = bg.connect("ml-sidepanel", EXT_SENDER);
    port.send({ type: "ml-sidepanel-init", tabId: 7 });
    port.send({ type: "ml-sidepanel-init", tabId: 8 });
    await flush();
    assert.equal(port.wasDisconnected(), false);
    assert.deepEqual(port.messages.filter((m) => "replay" in m).length, 1);
});

// --- the badge ---

test("badgeFor: everything waiting is in the panel -> the panel-only title, counted", () => {
    const title = "window.ml: something is waiting for you in the side panel on this tab";
    assert.deepEqual(badge.badgeFor([], [], 1), { text: "1", title });
    assert.deepEqual(badge.badgeFor([], [], 3), { text: "3", title });
    assert.deepEqual(badge.badgeFor([], [], 12), { text: "9+", title });
});

test("badgeFor: panel waits beside a start ask or a site request fall back to the count title", () => {
    const ask = { requestId: "q", runId: "r", tabId: 7, origin: A, since: 1 };
    assert.deepEqual(badge.badgeFor([ask], [], 1), { text: "2", title: "window.ml: 2 things are waiting for you" });
    assert.deepEqual(badge.badgeFor([], [], 0), { text: "", title: badge.BADGE_IDLE_TITLE });
});

test("badgeFor: a site request plus panel waits is not titled as sites asking for access", () => {
    assert.deepEqual(badge.badgeFor([], [{ origin: A }], 2), { text: "3", title: "window.ml: 3 things are waiting for you" });
    assert.deepEqual(badge.badgeFor([], [{ origin: A }], 1).title, "window.ml: 2 things are waiting for you");
});

const gate = (runId, seq) => consent.pendingApprovals.set(`${runId}:${seq}`, { resolve() {}, descriptor: { runId } });

test("panelWaits: counts gates of runs on a hidden tab with a closed panel, plus its queued cues", async () => {
    rec.tabUrls[5] = `${HID}/p`;
    await SP.notePage(5, `${HID}/p`);
    runs.runInboxes.set("r1", { tabId: 5, queue: [] });
    gate("r1", 1); gate("r1", 2);
    SP.cuePanel(5, cueN(1));
    assert.deepEqual(await badge.panelWaits(), [{ tabId: 5, origin: HID, waiting: 3 }]);
});

test("panelWaits: nothing for a visible tab, an open panel, or a gate whose run has no tab", async () => {
    await SP.notePage(5, `${VIS}/p`);
    await SP.notePage(6, `${HID}/p`);
    runs.runInboxes.set("r1", { tabId: 5, queue: [] });
    runs.runInboxes.set("r2", { tabId: 6, queue: [] });
    gate("r1", 1); gate("r2", 1); gate("ghost", 1);
    open(6);
    assert.deepEqual(await badge.panelWaits(), []);
});

test("refreshBadges: draws the panel-only title on a hidden tab whose closed panel has a gate waiting", async () => {
    const drawn = [];
    globalThis.chrome.action = {
        setBadgeText: async (o) => { drawn.push({ ...o }); },
        setTitle: async (o) => { drawn.push({ ...o }); },
    };
    try {
        await SP.notePage(5, `${HID}/p`);
        runs.runInboxes.set("r1", { tabId: 5, queue: [] });
        gate("r1", 1);
        await badge.refreshBadges();
        assert.ok(drawn.some((d) => d.tabId === 5 && d.title === "window.ml: something is waiting for you in the side panel on this tab"), JSON.stringify(drawn));
        assert.ok(drawn.some((d) => d.tabId === 5 && d.text === "1"));
    } finally { delete globalThis.chrome.action; }
});

// --- the approvals map says when it changes ---

test("onApprovalsChanged: fires on set, delete and clear, and not on a delete that removed nothing", () => {
    let n = 0;
    consent.onApprovalsChanged(() => { n++; });
    consent.pendingApprovals.set("k:1", { resolve() {}, descriptor: { runId: "k" } });
    assert.equal(n, 1);
    consent.pendingApprovals.delete("k:none");
    assert.equal(n, 1);
    consent.pendingApprovals.delete("k:1");
    assert.equal(n, 2);
    consent.pendingApprovals.set("k:2", { resolve() {}, descriptor: { runId: "k" } });
    consent.pendingApprovals.clear();
    assert.equal(n, 4);
});

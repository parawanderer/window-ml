// redteam-presence.test.mjs — what a HIDDEN page must not get from the extension (docs/spec/SITE_PRESENCE.md, step 2):
// no page script, no answer, nothing it can tell a denied origin from an unknown one by; and what a visible page gets
// instead, registered from the lists rather than named in the manifest.
//
// The worker runs in the real bundle (node:vm, mocked chrome, `siteGate: true` so a page is judged by the lists). The
// oracles are what the worker asks of chrome.scripting (`scriptingCalls`, the live `registered` map) and what it answers
// the content script. The content script's own silence is tested in the page world (`loadPageWorld({ visible })`).
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground, loadPageWorld, loadDomWorld, FakeMessageChannel, FakeMessagePort, FakeMessageEvent } = require("./helpers");
const { JSDOM } = require("jsdom");

const T = { timeout: 30000 };
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const plain = (x) => JSON.parse(JSON.stringify(x ?? null));
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off" };
const PAGE_FILES = ["shadow-patch.js", "injected.js"];
/** A page on tab 7, as the browser stamps its content script's messages. */
const sender = (origin, documentId = "doc-1") => ({ tab: { id: 7, url: `${origin}/page` }, url: `${origin}/page`, origin, frameId: 0, documentId });
const executes = (bg) => bg.scriptingCalls.filter(([k]) => k === "executeScript").map(([, i]) => plain(i));
/** The worker, with the lists stored as an install of the build before this one left them. */
const worker = (opts = {}) => loadBackground({
    config, siteGate: true,
    local: { ml_site_schema: 2, ml_site_always: [], ml_site_denied: [], ml_site_selfapprove: [], ...opts.local },
    session: { ml_site_session: [], ...opts.session },
    onFetch: () => jsonResponse({ choices: [{ message: { content: "done" } }] }),
    ...opts.extra,
});

// --- a hidden page: no page script, and an answer that says nothing ---

test("a hidden page's content script is told the page is closed, and nothing is injected into it", T, async () => {
    const bg = worker({ local: { ml_site_denied: ["https://denied.example"] } });
    for (const origin of ["https://unknown.example", "https://denied.example"]) {
        const r = plain(await bg.send({ type: "CONTENT_READY" }, sender(origin)));
        assert.deepEqual(r, { adopt: [], open: false }, origin);
    }
    assert.deepEqual(executes(bg), [], "nothing was injected into a hidden page");
});

test("a denied origin and an unknown one get the same answer, so a page cannot tell which it is", T, async () => {
    const bg = worker({ local: { ml_site_denied: ["https://denied.example"] } });
    const a = plain(await bg.send({ type: "CONTENT_READY" }, sender("https://denied.example")));
    const b = plain(await bg.send({ type: "CONTENT_READY" }, sender("https://unknown.example")));
    assert.deepEqual(a, b);
});

test("a visible page is told it is open, and gets nothing injected: its scripts are registered", T, async () => {
    const bg = worker({ local: { ml_site_always: ["https://ok.example"] }, session: { ml_site_session: ["https://s.example"] } });
    for (const origin of ["https://ok.example", "https://s.example"])
        assert.deepEqual(plain(await bg.send({ type: "CONTENT_READY" }, sender(origin))), { adopt: [], open: true }, origin);
    assert.deepEqual(executes(bg), []);
});

// --- the registration follows the lists ---

test("UPGRADE: lists an older build stored register the page scripts for exactly the allowed origins, each port pinned", T, async () => {
    const bg = worker({
        local: { ml_site_always: ["https://a.example", "http://b.example:8080"], ml_site_denied: ["https://d.example", "https://both.example"], ml_site_selfapprove: ["https://self.example"] },
        session: { ml_site_session: ["https://s.example", "https://both.example"] },
    });
    await flush(20);
    const lasting = plain(bg.registered.get("ml-main-lasting")), session = plain(bg.registered.get("ml-main-session"));
    assert.ok(lasting && session, `registered: ${[...bg.registered.keys()]}`);
    assert.deepEqual([...lasting.matches].sort(), ["http://b.example:8080/*", "https://a.example:443/*", "https://self.example:443/*"]);
    assert.deepEqual(session.matches, ["https://s.example:443/*"]);
    for (const r of [lasting, session]) {
        assert.deepEqual(r.js, PAGE_FILES, "the closed-root capture first, then window.ml");
        assert.equal(r.world, "MAIN");
        assert.equal(r.runAt, "document_start");
        assert.equal(r.allFrames, false);
    }
    assert.equal(lasting.persistAcrossSessions, true);
    assert.equal(session.persistAcrossSessions, false, "a session grant's scripts end with the session");
    assert.ok(!JSON.stringify(plain([...bg.registered.values()])).includes("d.example"), "a denied origin is registered nowhere");
    assert.ok(!JSON.stringify(plain([...bg.registered.values()])).includes("both.example"), "a denial wins over a session grant");
});

test("an empty list registers nothing; revoking and denying unregister, allowing registers", T, async () => {
    const bg = worker();
    await flush(20);
    assert.deepEqual([...bg.registered.keys()], [], "the default is hidden");
    bg.setLocal({ ml_site_always: ["https://a.example"] });
    await flush(20);
    assert.deepEqual(plain(bg.registered.get("ml-main-lasting")?.matches), ["https://a.example:443/*"]);
    bg.setLocal({ ml_site_denied: ["https://a.example"] });
    await flush(20);
    assert.equal(bg.registered.has("ml-main-lasting"), false, "denied: hidden at the next navigation");
    bg.setLocal({ ml_site_denied: [], ml_site_always: ["https://a.example", "https://c.example"] });
    await flush(20);
    bg.setLocal({ ml_site_always: ["https://c.example"] });
    await flush(20);
    assert.deepEqual(plain(bg.registered.get("ml-main-lasting")?.matches), ["https://c.example:443/*"], "revoked: gone from the list");
});

test("the manifest names no main-world script and does not expose injected.js to pages", () => {
    const m = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
    for (const cs of m.content_scripts) {
        assert.notEqual(cs.world, "MAIN", `a manifest main-world script runs on every page: ${cs.js}`);
        for (const f of PAGE_FILES) assert.ok(!cs.js.includes(f), `${f} is in the manifest's content scripts`);
    }
    for (const w of m.web_accessible_resources) assert.ok(!w.resources.includes("injected.js"), "injected.js is fetchable by any page");
    const content = m.content_scripts.find((cs) => cs.js.includes("content.js"));
    assert.equal(content.run_at, "document_start", "the content script must be listening before a registered page script says hello");
});

// --- a run the person starts on a hidden page ---

test("a run the person starts on a hidden page puts its tools into the content scripts' world only after the content script asked, then adopts: nothing into the page's", T, async () => {
    const adopts = [];
    const bg = worker({ extra: {
        openTabs: [{ id: 7, url: "https://hidden.example/page" }],
        onTabMessage: async (_tab, msg) => {
            if (msg.type !== "ADOPT_RUN_NOW") return undefined;
            adopts.push(plain(msg.payload));
            return msg.payload.injected === true ? { pageInfo: "here" } : { needInject: true };
        },
    } });
    const r = plain(await bg.send({ type: "USER_START_RUN", keep: false, payload: { task: "read it", surface: "hud" } }, sender("https://hidden.example")));
    assert.ok(r?.data?.hash, `the run started: ${JSON.stringify(r)}`);
    assert.equal(adopts.length, 2, JSON.stringify(adopts));
    assert.equal(adopts[0].injected, undefined, "the first ask carries no injected flag");
    assert.equal(adopts[1].injected, true);
    const ex = executes(bg);
    assert.equal(ex.length, 1, JSON.stringify(ex));
    assert.equal(ex[0].world, "ISOLATED", "the run's tools go into our world (SITE_PRESENCE.md step 3), never the page's");
    assert.deepEqual(ex[0].files, ["injected-isolated.js"]);
    assert.equal(ex[0].target.tabId, 7);
    assert.ok(!ex[0].target.allFrames, "the top frame only");
});

test("a page that says it has no page script on a VISIBLE origin is still given one only through the same ask (no double injection without it)", T, async () => {
    const bg = worker({ local: { ml_site_always: ["https://ok.example"] }, extra: {
        openTabs: [{ id: 7, url: "https://ok.example/page" }],
        onTabMessage: async (_tab, msg) => msg.type === "ADOPT_RUN_NOW" ? { pageInfo: "here" } : undefined,
    } });
    const r = plain(await bg.send({ type: "USER_START_RUN", keep: false, payload: { task: "read it", surface: "hud" } }, sender("https://ok.example")));
    assert.ok(r?.data?.hash, JSON.stringify(r));
    assert.deepEqual(executes(bg), [], "a page whose content script did not ask is not injected into");
});

// --- the content script on a hidden page ---

test("on a hidden page the content script relays nothing the page posts and answers nothing", T, async () => {
    const w = loadPageWorld({ visible: false, onRuntimeMessage: () => ({ data: "ANSWERED" }) });
    const posted = [];
    w.context.window.addEventListener("message", (e) => { if (e.data?.type?.endsWith?.("_RESPONSE")) posted.push(e.data.type); });
    w.fromContent((e) => { if (e.data?.type?.endsWith?.("_RESPONSE")) posted.push(e.data.type); });
    // On the window, and on injected.js's port as a page that took it would.
    for (const type of ["INFO_REQUEST", "LLM_REQUEST", "LIST_MODELS_REQUEST", "START_RUN_REQUEST"]) {
        w.context.window.postMessage({ type, requestId: `x-${type}`, payload: {} }, "*");
        w.asInjected({ type, requestId: `p-${type}`, payload: {} });
    }
    await flush(30);
    assert.deepEqual(w.runtimeCalls.map((c) => c.type), [], "a hidden page's post reached the worker");
    assert.deepEqual(posted, [], "a hidden page was answered");
});

test("on a visible page what the page posted before the worker answered is relayed once it does (positive control)", T, async () => {
    const w = loadPageWorld({ visible: true, onRuntimeMessage: () => ({ data: "ANSWERED" }) });
    w.asInjected({ type: "INFO_REQUEST", requestId: "early", payload: {} });
    await flush(30);
    assert.ok(w.runtimeCalls.some((c) => c.type === "GET_INFO" || c.requestId === "early" || JSON.stringify(c).includes("early")), JSON.stringify(w.runtimeCalls));
});

// --- the card's replay across a navigation ---

for (const shown of ["visible", "hidden"])
test(`a finished run's history is replayed to the shell of the tab's next document only on a ${shown === "visible" ? "visible origin (positive control)" : "visible origin: a hidden one is told nothing"}`, T, async () => {
    const origin = "https://site.example";
    const bg = worker({ local: shown === "visible" ? { ml_site_always: [origin] } : {}, extra: {
        openTabs: [{ id: 7, url: `${origin}/page` }],
        onTabMessage: async (_tab, msg) => msg.type === "ADOPT_RUN_NOW" ? (msg.payload.injected === true || shown === "visible" ? { pageInfo: "here" } : { needInject: true }) : undefined,
    } });
    const r = plain(await bg.send({ type: "USER_START_RUN", keep: false, payload: { task: "read it", surface: "hud" } }, sender(origin)));
    assert.ok(r?.data?.hash, JSON.stringify(r));
    await flush(40);
    const replays = () => bg.tabMessages.filter(([t, m]) => t === 7 && m?.type === "ML_DEBUG_TO_PAGE").length;
    const before = replays();
    assert.ok(before > 0, "positive control: the run sent its events to the tab");
    const next = sender(origin, "doc-2");
    await bg.send({ type: "CONTENT_READY" }, next);
    void bg.send({ type: "SHELL_LISTENING" }, next);   // no answer: fire and forget, as the shell sends it
    await flush(20);
    if (shown === "visible") assert.ok(replays() > before, "the visible page's card got the finished run's history");
    else assert.equal(replays(), before, "a hidden page's shell was sent a finished run's history");
});

// --- the page channel (step 2b): who holds the port, and what crosses the page's window ---
//
// page-channel.ts: injected.js hands port2 of a MessageChannel to the isolated world with one `ml-page-port` event on
// window; content.js (and the shell, on the same isolated side) keep the FIRST port. A page script that runs after
// injected.js (every page script on a visible origin) can dispatch its own `ml-page-port` events and post on window as
// it likes. `beforeInjected` plays a page that ran first, which happens only where injected.js is put in late.

/** Page code: open a channel, record what arrives on the page's end, and hand the other end over as `ml-page-port`. */
const pagePort = (ports = 1) => `
    globalThis.__heard = [];
    globalThis.__mine = [];
    const handed = [];
    for (let i = 0; i < ${ports}; i++) {
        const ch = new MessageChannel();
        ch.port1.onmessage = (e) => __heard.push(e.data);
        __mine.push(ch.port1); handed.push(ch.port2);
    }
    window.dispatchEvent(new MessageEvent("ml-page-port", { ports: handed }));
`;

for (const ports of [1, 3])
test(`a page that hands over ${ports === 1 ? "its own port" : "several ports"} after injected.js did is not taken: it hears nothing and nothing it posts is relayed`, T, async () => {
    const w = loadPageWorld({ visible: true, onRuntimeMessage: (m) => (m.type === "OLLAMA_INFO" ? { data: { marker: "honest-answer" } } : undefined) });
    await flush(10);
    w.pageRun(pagePort(ports));
    w.pageRun(`for (const p of __mine) p.postMessage({ type: "INFO_REQUEST", requestId: "forged", payload: { marker: "forged" } });`);
    // Positive control: injected.js's own call still goes out and is answered, on the port it handed over.
    const answer = plain(await Promise.race([w.ml.info(), new Promise((r) => setTimeout(() => r("timeout"), 3000))]));
    assert.match(JSON.stringify(answer), /honest-answer/, "positive control: window.ml's own call was answered");
    await flush(20);
    assert.ok(!JSON.stringify(w.runtimeCalls).includes("forged"), `the page's port was relayed: ${JSON.stringify(w.runtimeCalls)}`);
    assert.deepEqual(plain(w.pageRun("__heard")), [], "content.js spoke on the page's port");
});

test("an `ml-page-port` event that carries no port does not use up the isolated side's one slot", T, async () => {
    const w = loadPageWorld({ visible: true, beforeInjected: `window.dispatchEvent(new MessageEvent("ml-page-port", { ports: [] })); window.dispatchEvent(new MessageEvent("ml-page-port", {}));`,
        onRuntimeMessage: (m) => (m.type === "OLLAMA_INFO" ? { data: { marker: "honest-answer" } } : undefined) });
    const answer = plain(await Promise.race([w.ml.info(), new Promise((r) => setTimeout(() => r("timeout"), 3000))]));
    assert.match(JSON.stringify(answer), /honest-answer/, "injected.js's port was refused after an empty hand-off");
});

test("on a hidden page whose page holds a port, nothing the worker sends reaches it while the gate is closed", T, async () => {
    const w = loadPageWorld({ visible: false, beforeInjected: pagePort(1) });
    const answers = [];
    for (const type of ["ADOPT_RUN_NOW", "RUN_STATE_IN_PAGE", "CANCEL_TOOL_IN_PAGE", "RUN_TOOL_IN_PAGE", "SERVER_TOOL_STREAM", "PYTHON_STREAM", "PRESENCE_CHECK"])
        answers.push(Promise.race([w.fireRuntimeMessage({ type, requestId: "r", chunk: "SECRET", frame: "SECRET", payload: { runId: "run-SECRET", name: "exec", args: { js: "SECRET" }, rebuild: { toolNames: ["exec"], builtBy: "worker" } } }), new Promise((r) => setTimeout(() => r("pending"), 2000))]));
    const got = plain(await Promise.all(answers));
    await flush(20);
    assert.deepEqual(got[0], { needInject: true }, "positive control: the adopt was refused as a hidden page's");
    assert.ok(w.context.__mlPageChannel.port, "setup: the page's port is the isolated side's");
    assert.deepEqual(plain(w.pageRun("__heard")), [], "a hidden page's own port was spoken on");
});

for (const where of ["hidden", "visible"])
test(`a port a page handed over before injected.js arrived is not the one a run on that page talks on (${where === "hidden" ? "a hidden page" : "a visible page whose content scripts were restored, sw-page-restore.ts"})`, { ...T }, async () => {
    const w = loadPageWorld({ visible: where === "visible", beforeInjected: pagePort(1) + `
        __mine[0].onmessage = (e) => {
            __heard.push(e.data);
            if (e.data && e.data.type === "ADOPT_RUN") __mine[0].postMessage({ type: "RUN_ADOPTED_NOW", reply: e.data.reply, pageInfo: "FORGED BY THE PAGE" });
        };` });
    await flush(10);
    // The person's run starts: on a hidden page the worker has put injected.js in and asks again with `injected` (sw-run-start.ts adoptOnTab).
    const r = plain(await Promise.race([w.fireRuntimeMessage({ type: "ADOPT_RUN_NOW", payload: { runId: "run-of-the-person", rebuild: { toolNames: ["exec"], builtBy: "worker" }, ...(where === "hidden" ? { injected: true } : {}) } }), new Promise((res) => setTimeout(() => res("timeout"), 5000))]));
    assert.notEqual(r?.pageInfo, "FORGED BY THE PAGE", "the run's page context is the page's forgery");
    assert.ok(!JSON.stringify(plain(w.pageRun("__heard"))).includes("run-of-the-person"), "the page heard the person's run id and rebuild");
    assert.ok(typeof r?.pageInfo === "string" && r.pageInfo.length > 0, `positive control: injected.js answered the adopt: ${JSON.stringify(r)}`);
});

test("nothing of ours is posted on the page's window, and the only events dispatched on it are the hand-off and ml:ready", T, async () => {
    const w = loadPageWorld({ visible: true, onRuntimeMessage: (m) => (m.type === "OLLAMA_INFO" ? { data: { ok: 1 } } : undefined) });
    await flush(10);
    // A call, a run adopted and a delegated tool, the sidebar's handshake and a debug event: every kind of traffic.
    assert.match(JSON.stringify(plain(await w.ml.info())), /ok/, "positive control: a call round-tripped");
    const adopt = plain(await w.fireRuntimeMessage({ type: "ADOPT_RUN_NOW", payload: { runId: "r-win", rebuild: { toolNames: ["exec"], builtBy: "worker" } } }));
    assert.equal(typeof adopt?.pageInfo, "string", `positive control: the run was adopted: ${JSON.stringify(adopt)}`);
    const tool = plain(await w.fireRuntimeMessage({ type: "RUN_TOOL_IN_PAGE", payload: { runId: "r-win", name: "exec", args: { js: "console.log('out'); 1 + 1" }, stream: true } }));
    assert.ok(tool && JSON.stringify(tool).length > 2, `positive control: the delegated tool answered: ${JSON.stringify(tool)}`);
    w.asContent({ __mlSidebar: "present" }); w.asContent({ __mlSidebar: "ready" });
    await w.ml.info();
    await flush(20);
    assert.deepEqual(plain(w.windowPosts), [], "something of ours was posted on the page's window");
    // injected-isolated.js (WML_PAGE_BUNDLE, SITE_PRESENCE.md step 3) attaches its port in-process and dispatches nothing at all.
    if (process.env.WML_PAGE_BUNDLE === "injected-isolated.js") return void assert.deepEqual(w.dispatchedEvents, [], "the isolated bundle dispatched an event on the page's window");
    assert.deepEqual([...new Set(w.dispatchedEvents)].filter((t) => !["ml-page-port", "ml:ready", "wml-closed-roots"].includes(t)), [], "an event of ours was dispatched on the page's window");
    assert.equal(w.dispatchedEvents.filter((t) => t === "ml-page-port").length, 1, "the port was handed over more than once");
});

test("a page that wraps MessagePort.prototype.postMessage on a visible origin does not get injected.js's port, so cannot hear what content.js sends it", { ...T }, async () => {
    const w = loadPageWorld({ visible: true, onRuntimeMessage: (m) => (m.type === "OLLAMA_INFO" ? { data: { ok: 1 } } : undefined) });
    await flush(10);
    w.pageRun(`
        globalThis.__heard = [];
        const proto = Object.getPrototypeOf(new MessageChannel().port1);
        const post = proto.postMessage;
        proto.postMessage = function (m) {
            // INFO_REQUEST is sent only by injected.js, so this port is its port1.
            if (m && m.type === "INFO_REQUEST" && !globalThis.__port) {
                globalThis.__port = this;
                const theirs = this.onmessage;
                this.onmessage = function (e) { __heard.push(e.data); return theirs.call(this, e); };
            }
            return post.apply(this, arguments);
        };
    `);
    await w.ml.info();   // any window.ml call: the page calls its own API
    const adopt = plain(await w.fireRuntimeMessage({ type: "ADOPT_RUN_NOW", payload: { runId: "run-of-the-person", rebuild: { toolNames: ["exec"], builtBy: "worker" } } }));
    assert.equal(typeof adopt?.pageInfo, "string", `positive control: the person's run was adopted: ${JSON.stringify(adopt)}`);
    assert.ok(!JSON.stringify(plain(w.pageRun("__heard"))).includes("run-of-the-person"), "the page read the person's run id and rebuild off injected.js's port");
});

// --- the sidebar shell on the page channel ---
//
// The BUILT content.js and sidebar-shell.js in one jsdom window, as the browser runs them in one isolated world, with the
// worker's CONTENT_READY answer deciding the gate. `handOver()` plays whoever hands over a port first (injected.js on a
// visible page; on a hidden one, the page itself, which can at any time) and returns the far end to speak on.

/**
 * @param {{ open: boolean, sync?: object }} opts the worker's word on the page, and the stored settings
 * @returns the world: its document, what was sent to the worker, and handOver()
 */
function shellWorld({ open, sync = {} }) {
    const dom = new JSDOM("<!doctype html><html><head></head><body><p>a page</p></body></html>", { url: "https://hidden.example/", runScripts: "outside-only", pretendToBeVisual: true });
    const w = dom.window, sent = [], portListeners = [];
    const settings = { debugMode: "off", ...sync };
    w.chrome = {
        runtime: {
            id: "test", getURL: (p) => `chrome-extension://test/${p}`, lastError: undefined,
            sendMessage: (m, cb) => {
                sent.push(m);
                const answer = m?.type === "CONTENT_READY" ? { open, adopt: [] } : m?.type === "OLLAMA_INFO" ? { data: "answered" } : undefined;
                if (cb) queueMicrotask(() => cb(answer));
                return Promise.resolve(answer);
            },
            onMessage: { addListener() {} },
            connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {}, disconnect() {} }),
        },
        storage: {
            sync: { get: (d, cb) => { const r = { ...d, ...settings }; if (cb) cb(r); return Promise.resolve(r); } },
            local: { get: (d, cb) => { if (cb) cb(d || {}); return Promise.resolve(d || {}); }, set: () => Promise.resolve() },
            onChanged: { addListener() {} },
        },
        dom: { openOrClosedShadowRoot: () => null },
    };
    w.MessageChannel = FakeMessageChannel;
    w.MessageEvent = FakeMessageEvent;
    if (!w.matchMedia) w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    // The fake hand-off is not a jsdom Event, so the isolated side's `ml-page-port` listener is called by hand.
    const add = w.addEventListener.bind(w);
    w.addEventListener = (t, f, o) => { if (t === "ml-page-port") portListeners.push(f); else add(t, f, o); };
    w.eval(fs.readFileSync(new URL("../dist/content.js", import.meta.url), "utf8"));
    w.eval(fs.readFileSync(new URL("../dist/sidebar-shell.js", import.meta.url), "utf8"));
    const handOver = () => {
        const ch = new FakeMessageChannel(), heard = [];
        ch.port1.onmessage = (e) => heard.push(e.data);
        for (const f of portListeners) f(new FakeMessageEvent("ml-page-port", { ports: [ch.port2] }));
        return { post: (d) => ch.port1.postMessage(d), heard };
    };
    const ours = () => [...w.document.documentElement.querySelectorAll("[id^='ml-']")].map((e) => e.id);
    return { w, sent, handOver, ours, close: () => w.close() };
}

const AGENT_START = { kind: "agent", session: "s-forged", hash: "s-forged", task: "a run the page made up", ts: 1 };
const SHELL_SETTINGS = { debugMode: "devtools", agentHudInDevtools: true };   // the corner card beside the DevTools panel

for (const open of [true, false])
test(`a run's start sent on the page channel mounts the corner card only on a page the worker said is visible (${open ? "positive control" : "a hidden page holding a port mounts nothing"})`, { ...T, ...(open ? {} : {}) }, async () => {
    const world = shellWorld({ open, sync: SHELL_SETTINGS });
    await flush(10);
    const page = world.handOver();
    assert.deepEqual(world.ours(), [], "setup: nothing of ours in the page before the event");
    page.post({ __mlDebug: AGENT_START });
    await flush(20);
    if (open) assert.deepEqual(world.ours(), ["ml-sb-card"], "positive control: a visible page's run mounts the card");
    else assert.deepEqual(world.ours(), [], "a hidden page made the card mount: it can see the extension is there");
    world.close();
});

test("content.js and the shell share one port and handle each message once: one relay per request, one handshake per hello", T, async () => {
    const world = shellWorld({ open: true, sync: { debugMode: "devtools" } });
    await flush(10);
    const port = world.handOver();
    await flush(10);
    const before = port.heard.length;
    port.post({ type: "INFO_REQUEST", requestId: "once", payload: {} });
    port.post({ __mlSidebar: "hello" });
    await flush(20);
    assert.equal(world.sent.filter((m) => m?.type === "OLLAMA_INFO").length, 1, "the request was relayed other than once");
    const after = port.heard.slice(before);
    assert.equal(after.filter((d) => d?.type === "INFO_RESPONSE").length, 1, `the answer came other than once: ${JSON.stringify(after)}`);
    assert.equal(after.filter((d) => d?.__mlSidebar === "present").length, 1, `the handshake came other than once: ${JSON.stringify(after)}`);
    world.close();
});

// --- step 3: a hidden page with a run (docs/spec/SITE_PRESENCE.md step 3; the red team's rule-10 rows) ---
//
// What the lane's build must do (feat/hidden-isolated-tools): tools run in the content script's isolated world; on a
// hidden page NOTHING of ours enters MAIN (not shadow-patch.js, not injected.js); the page-side tool stack is a second
// build loaded into the isolated world (executeScript world ISOLATED); closed roots are read with
// chrome.dom.openOrClosedShadowRoot. These rows state the properties before the build (rule 10: nothing of the lane's
// build is read here — they run against main). Each failing row fails today for the reason in its todo; P3 already
// holds and lands as a plain row. The oracle for every injection row is `mainFiles(bg)` — what the worker put in a
// page's MAIN world (the restore probe's `world: "MAIN", func:` call is not a file injection and is excluded by
// `files`). The page-world rows drive the hidden-page-with-run state as it is TODAY: injected.js put into MAIN late,
// after the page's own scripts (beforeInjected) — exactly the state step 3 removes.

/** The page scripts the worker asked chrome.scripting to run in a page's MAIN world (step 3: there must be none). */
const mainFiles = (bg) => executes(bg).filter((i) => i.world === "MAIN" && Array.isArray(i.files) && i.files.length > 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A saved global policy over fetch, as the policy page stores one (nav-arrival-host.test.mjs's shape). */
const policy = (id, effect, source, label) => ({ id, scope: "global", consumer: "fetch", effect, source, label, origin: "person", created: 1760000000000 });

// P1: no MAIN injection on a hidden page, through each of the four flows that put scripts there today.

test("step 3 P1a: a run the person starts on a hidden page puts no page script in the page's MAIN world", { ...T, todo: "Step 3 (docs/spec/SITE_PRESENCE.md) gives a hidden page with a run no MAIN-world script at all: the tools run in the content script's isolated world, from the isolated bundle. Today sw-run-start.ts's adoptOnTab answers the content script's needInject ask with injectPageScripts([shadow-patch.js, injected.js], world MAIN) — the row above pins that protocol as it is and the fix's PR reconciles the two. Rule 10: written against main, no part of feat/hidden-isolated-tools read." }, async () => {
    const adopts = [];
    let calls = 0;
    const bg = worker({ extra: {
        openTabs: [{ id: 7, url: "https://hidden.example/page" }],
        onFetch: (call) => {
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            return calls++ === 0
                ? jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "scroll", arguments: JSON.stringify({ direction: "down" }) } }] } }] })
                : jsonResponse({ choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (_tab, msg) => {
            if (msg.type === "ADOPT_RUN_NOW") { adopts.push(plain(msg.payload)); return msg.payload.injected === true ? { pageInfo: "here" } : { needInject: true }; }
            if (msg.type === "RUN_TOOL_IN_PAGE") return { result: "ran" };
            return undefined;
        },
    } });
    const r = plain(await bg.send({ type: "USER_START_RUN", keep: false, payload: { task: "read it", surface: "hud" } }, sender("https://hidden.example")));
    assert.ok(r?.data?.hash, `positive control: the run started: ${JSON.stringify(r)}`);
    for (let i = 0; i < 1500 && calls < 2; i++) {
        for (const g of bg.context.__mlApprovals.list()) bg.context.__mlApprovals.resolve(g.key, true);
        await sleep(2);
    }
    assert.ok(adopts.length >= 1, `positive control: the adopt round-tripped: ${JSON.stringify(adopts)}`);
    assert.ok(bg.tabMessages.some(([, m]) => m?.type === "RUN_TOOL_IN_PAGE"), "positive control: the run's tool reached the tab");
    assert.deepEqual(mainFiles(bg), [], "a run the person starts on a hidden page must not put our page scripts in the page's MAIN world");
});

test("step 3 P1b: a follow-up to a run on a hidden page puts no page script in the page's MAIN world", { ...T, todo: "sw-run-start.ts userRunAction re-adopts on every follow-up (the document may not be the one the last turn ran on) and the adopt's needInject ask is answered with the same MAIN-world injectPageScripts. Step 3 keeps that adopt (the run must re-register) but nothing may enter MAIN on the hidden page. The delta is what the follow-up phase adds, so the row holds after the fix whether or not the start's own injection is gone." }, async () => {
    const adopts = [];
    let calls = 0;
    const bg = worker({ extra: {
        openTabs: [{ id: 7, url: "https://hidden.example/page" }],
        onFetch: (call) => {
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            const n = calls++;
            return n === 0
                ? jsonResponse({ choices: [{ message: { content: "done" } }] })
                : n === 1
                    ? jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "scroll", arguments: JSON.stringify({ direction: "down" }) } }] } }] })
                    : jsonResponse({ choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (_tab, msg) => {
            if (msg.type === "ADOPT_RUN_NOW") { adopts.push(plain(msg.payload)); return msg.payload.injected === true ? { pageInfo: "here" } : { needInject: true }; }
            if (msg.type === "RUN_TOOL_IN_PAGE") return { result: "ran" };
            return undefined;
        },
    } });
    const r = plain(await bg.send({ type: "USER_START_RUN", keep: false, payload: { task: "read it", surface: "hud" } }, sender("https://hidden.example")));
    assert.ok(r?.data?.hash, JSON.stringify(r));
    for (let i = 0; i < 1500 && calls < 1; i++) await sleep(2);
    await flush(60);
    const beforeMain = mainFiles(bg).length, beforeAdopts = adopts.length;
    const more = plain(await bg.context.__mlUserRunActionForTest(r.data.hash, "send", { text: "and the rest", surface: "hud" }));
    assert.equal(more, "turn", `positive control: the follow-up was taken: ${JSON.stringify(more)}`);
    for (let i = 0; i < 1500 && calls < 3; i++) {
        for (const g of bg.context.__mlApprovals.list()) bg.context.__mlApprovals.resolve(g.key, true);
        await sleep(2);
    }
    await flush(60);
    assert.ok(adopts.length > beforeAdopts, "positive control: the follow-up re-adopted the run on the tab");
    assert.ok(calls >= 2, "positive control: the model was called for the follow-up");
    assert.equal(mainFiles(bg).length, beforeMain, `a follow-up on a hidden page must not put our page scripts in the page's MAIN world (had ${beforeMain} before the follow-up, ${mainFiles(bg).length} now)`);
});

test("step 3 P1c: an arrival the person approves re-adopts the run on a hidden page without a page script in its MAIN world", { ...T, todo: "sw-run-host.ts readoptHere → adoptOnTab answers the destination content script's needInject ask with the same MAIN-world injectPageScripts. The held arrival's CONTENT_READY adopts nothing (background.ts addAdopt skips arrivalHold runs), so this row's only injection site is the readopt itself — the flow step 3 must route into the isolated world. The destination is in no list (hidden): the visible start page never injects (its adopt is answered pageInfo), so mainFiles is empty until the readopt." }, async () => {
    const tab = { id: 7, windowId: 3, active: true, url: "https://site.example/page", title: "Site" };
    let turns = 0, docN = 1, bg;
    const asks = [], adopts = [];
    const answered = new Set();
    const to = () => ({ tab: { id: 7, url: tab.url }, url: tab.url, origin: new URL(tab.url).origin, frameId: 0, documentId: `doc-${docN}` });
    const commit = (url) => { tab.url = url; docN++; bg.commit(7, { documentId: `doc-${docN}`, url }); };
    const ready = async () => {
        const r = plain(await bg.send({ type: "CONTENT_READY" }, to()));
        for (const a of r?.adopt ?? []) void bg.send({ type: "RUN_READOPTED", payload: { runId: a.runId, pageInfo: `You are on ${tab.url}` } }, to());
        return r;
    };
    bg = worker({
        local: { ml_policies_global: [policy("p-ask", "ask", '(c) => c.host === "b.example"', "Check with me on b.example")], ml_site_always: ["https://site.example"] },
        extra: {
            openTabs: [tab],
            onFetch: async (call) => {
                if (!call.url.includes("/chat/completions")) return jsonResponse({});
                const next = turns++ === 0 ? { name: "click", args: { selector: "#docs" } } : null;
                return next
                    ? jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: `c${turns}`, type: "function", function: { name: next.name, arguments: JSON.stringify(next.args) } }] } }] })
                    : jsonResponse({ choices: [{ message: { content: "done" } }] });
            },
            onTabMessage: async (_t, msg) => {
                if (msg.type === "ADOPT_RUN_NOW") {
                    adopts.push(tab.url);
                    return tab.url.startsWith("https://b.example")
                        ? (msg.payload.injected === true ? { pageInfo: "You are on b.example" } : { needInject: true })
                        : { pageInfo: `You are on ${tab.url}` };
                }
                if (msg.type === "ML_DEBUG_TO_PAGE") {
                    const e = msg.event;
                    if (e?.awaitingApproval && !answered.has(`${e.id}:${e.seq}`)) {
                        answered.add(`${e.id}:${e.seq}`);
                        void bg.send({ type: "SET_APPROVAL", payload: { runId: e.id, seq: e.seq, decision: true } });
                    }
                    for (const a of e?.asks ?? []) {
                        if (a.state !== "pending" || answered.has(a.id)) continue;
                        answered.add(a.id);
                        asks.push({ kind: a.kind, line: a.why?.line });
                        void bg.send({ type: "SET_APPROVAL", payload: { runId: e.id, seq: e.seq, ask: a.id, decision: true } });
                    }
                    return undefined;
                }
                if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
                const p = plain(msg.payload);
                if (p.finish || p.precheck || p.renderOnly || p.readonlyTry || p.geometry) return { result: "" };
                // The click lands on the link's page: the browser commits, then the destination's content script is ready.
                commit("https://b.example/docs");
                setTimeout(() => void ready(), 5);
                return { result: "Clicked #docs." };
            },
        },
    });
    await bg.context.__mlStartUserRunForTest(7, { task: "work on the site", surface: "hud" });
    for (let i = 0; i < 1500 && turns < 2; i++) await sleep(2);
    await sleep(60);
    assert.ok(asks.length >= 1, `positive control: the arrival raised a card the person answered: ${JSON.stringify(asks)}`);
    assert.ok(adopts.some((u) => u.startsWith("https://b.example")), `positive control: the run was re-adopted on the destination: ${JSON.stringify(adopts)}`);
    assert.equal(turns, 2, "positive control: the run continued after the person approved");
    assert.deepEqual(mainFiles(bg), [], "an approved arrival on a hidden page must not get our page scripts in its MAIN world");
});

test("step 3 P1d: a new document on a hidden page's tab re-adopts the tab's run without a page script in its MAIN world", { ...T, todo: "background.ts's CONTENT_READY branch injects directly when the destination is hidden and the adopt list is non-empty (injectPageScripts, world MAIN) — no ask of the content script at all. Step 3 must route that re-adopt's tool stack into the isolated world (or carry the already-built one) with nothing in MAIN." }, async () => {
    const HIDDEN = "https://hidden.example/page";
    let driver = 0, bg, readyAnswer = null;
    bg = worker({
        local: { ml_site_always: ["https://site.example"] },
        extra: {
            openTabs: [{ id: 9, windowId: 1, active: true, url: "https://site.example/" }],
            onFetch: (call) => {
                if (!call.url.includes("/chat/completions")) return jsonResponse({});
                if (driver === 0) {
                    bg.commit(9, { documentId: "doc-2", url: HIDDEN });
                    const sender = { tab: { id: 9, url: HIDDEN }, url: HIDDEN, frameId: 0, documentId: "doc-2" };
                    void bg.send({ type: "CONTENT_READY" }, sender).then((r) => {
                        readyAnswer = plain(r);
                        void bg.send({ type: "RUN_READOPTED", payload: { pageInfo: "" } }, sender);
                    });
                }
                const next = driver++ === 0 ? { name: "scroll", args: { direction: "down" } } : null;
                return next
                    ? jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: `f${driver}`, type: "function", function: { name: next.name, arguments: JSON.stringify(next.args) } }] } }] })
                    : jsonResponse({ choices: [{ message: { content: "done" } }] });
            },
            onTabMessage: async (_t, msg) => (msg.type === "ADOPT_RUN_NOW" ? { pageInfo: "" } : msg.type === "RUN_TOOL_IN_PAGE" ? { result: "" } : undefined),
        },
    });
    await bg.context.__mlStartUserRunForTest(9, { task: "read it", surface: "hud" });
    for (let i = 0; i < 1500 && driver < 2; i++) {
        for (const g of bg.context.__mlApprovals.list()) bg.context.__mlApprovals.resolve(g.key, true);
        await sleep(2);
    }
    await sleep(60);
    assert.ok(readyAnswer?.adopt?.length > 0, `positive control: the new document was handed the run to re-adopt: ${JSON.stringify(readyAnswer)}`);
    assert.equal(driver, 2, "positive control: the run continued past the navigation");
    assert.deepEqual(mainFiles(bg), [], "a navigation to a hidden page must not get our page scripts in its MAIN world");
});

// P2/P3/P5: what the page can see of a run the person started there. P2 and P5 fail today (injected.js is in MAIN);
// P3 holds and is the plain row.

test("step 3 P2: a hidden page with a run sees no event of ours, no window.ml global and nothing posted on its window", { ...T, todo: "The residual detection-surface.spec.mjs pins today (hidden-with-run pageEvents ['ml-page-port','ml:ready']): with injected.js put into MAIN late the page gets the ml-page-port hand-off, ml:ready and the window.ml global. Step 3 (no MAIN script on a hidden page) removes all three while the traffic below — adopt, tool, shell handshake — runs in the content script's isolated world and still answers. (This world has no CustomEvent, so the closed-root claim's dispatch is not expressible here: that detection is P2b's row.)" }, async () => {
    const w = loadPageWorld({ visible: false, main: "injected-isolated.js", pageRealm: true, onRuntimeMessage: (m) => (m.type === "OLLAMA_INFO" ? { data: { ok: 1 } } : undefined) });
    await flush(10);
    const adopt = plain(await w.fireRuntimeMessage({ type: "ADOPT_RUN_NOW", payload: { runId: "r-hidden", rebuild: { toolNames: ["exec"], builtBy: "worker" }, injected: true } }));
    assert.equal(typeof adopt?.pageInfo, "string", `positive control: the run was adopted: ${JSON.stringify(adopt)}`);
    const tool = plain(await w.fireRuntimeMessage({ type: "RUN_TOOL_IN_PAGE", payload: { runId: "r-hidden", name: "exec", args: { js: "1 + 1" }, stream: true } }));
    assert.ok(tool && JSON.stringify(tool).length > 2, `positive control: the delegated tool answered: ${JSON.stringify(tool)}`);
    w.asContent({ __mlSidebar: "present" }); w.asContent({ __mlSidebar: "ready" });
    await flush(20);
    assert.deepEqual([...new Set(w.dispatchedEvents)], [], "a hidden page with a run must see no event of ours on its window");
    assert.equal(w.pageRun("typeof globalThis.ml"), "undefined", "a hidden page with a run must have no window.ml global");
    assert.deepEqual(plain(w.windowPosts), [], "a hidden page with a run must have nothing of ours posted on its window");
});

test("step 3 P2b (the :309 twin): a hidden page with a run cannot tell window.ml is installed by the closed-root claim, nor take its reader", { ...T, todo: "redteam-exec-shared-world.test.mjs's :309 row is the ask-AFTER-start shape (it holds); this is its hidden-with-run twin: today [shadow-patch.js, injected.js] are put into the page's MAIN world at run start, after the page's scripts ran, so the claim at injected.ts's start dispatches wml-closed-roots through the page's window.dispatchEvent (dom.ts) and the page's wrap — or an ask of its own — takes the one-shot reader. Fixed when a hidden page with a run carries no MAIN-world script (closed roots read with chrome.dom from the isolated world)." }, async () => {
    const w = loadDomWorld("<sealed-widget></sealed-widget>", {
        url: "https://hidden.example/page", isolated: true,
        beforeInjected: `
            globalThis.__seen = [];
            globalThis.__stolen = undefined;
            const real = window.dispatchEvent.bind(window);
            window.dispatchEvent = function (e) {
                __seen.push(e && e.type);
                if (e && e.type === "wml-closed-roots" && e.detail && typeof e.detail.read === "function") __stolen = e.detail.read;
                return real(e);
            };
        `,
    });
    // Positive control: the claim happened and the tools hold the reader (a root the late patch captured shows).
    w.document.querySelector("sealed-widget").attachShadow({ mode: "closed" }).innerHTML = '<button class="secret">real</button>';
    w.ml._adoptRun("r-p2b", { toolNames: [], pierceClosed: true, builtBy: "worker" });
    const desc = (sel) => String(w.ml.domTools.find((t) => t.name === "describeElement").run({ selector: sel }).content);
    assert.match(desc("sealed-widget >>> button.secret"), /real/, "positive control: the claim happened and the tools hold the reader");
    assert.deepEqual(plain(w.pageRun("__seen")).filter((t) => t === "wml-closed-roots"), [], "the page saw the closed-root claim's dispatch: it can tell window.ml is installed");
    assert.notEqual(w.pageRun("typeof __stolen"), "function", "the page took the closed-root reader from the claim's dispatch");
});

test("step 3 P3: nothing of ours is posted on a hidden page's window across run start, tool call and cancel", T, async () => {
    const w = loadPageWorld({ visible: false, main: "injected-isolated.js", pageRealm: true, onRuntimeMessage: (m) => (m.type === "OLLAMA_INFO" ? { data: { ok: 1 } } : undefined) });
    await flush(10);
    const adopt = plain(await w.fireRuntimeMessage({ type: "ADOPT_RUN_NOW", payload: { runId: "r-silence", rebuild: { toolNames: ["exec"], builtBy: "worker" }, injected: true } }));
    assert.equal(typeof adopt?.pageInfo, "string", `positive control: run start — the run was adopted: ${JSON.stringify(adopt)}`);
    const tool = plain(await w.fireRuntimeMessage({ type: "RUN_TOOL_IN_PAGE", payload: { runId: "r-silence", name: "exec", args: { js: "1 + 1" }, stream: true } }));
    assert.ok(tool && JSON.stringify(tool).length > 2, `positive control: tool call — the delegated tool answered: ${JSON.stringify(tool)}`);
    await w.fireRuntimeMessage({ type: "CANCEL_TOOL_IN_PAGE", payload: { runId: "r-silence", callId: "c1" } });
    assert.deepEqual(plain(w.windowPosts), [], "something of ours was posted on the hidden page's window");
});

// P4: closed roots. A root attached BEFORE our scripts were put in is invisible to the late patch (P4a); our own
// sidebar hosts' roots must never be read into a tool result whatever captured them (P4b).

test("step 3 P4a: a closed root attached before our scripts were put into a hidden page is readable with pierceClosedShadow", { ...T, todo: "shadow-patch.js cannot capture a root attached before it ran — and on a hidden page with a run it runs LATE (the page's document built its roots first). Step 3 reads closed roots with chrome.dom.openOrClosedShadowRoot (sidebar/shell.ts's setClosedRootReader), which sees every root regardless of when it was attached; until then a pre-run root is invisible to a piercing run. Positive control in the same world: a root attached after the patch (the captured shape) shows." }, async () => {
    const w = loadDomWorld("<sealed-widget></sealed-widget><post-widget></post-widget>", { url: "https://hidden.example/page", isolated: true, beforeInjected: `
        const root = document.querySelector("sealed-widget").attachShadow({ mode: "closed" });
        root.innerHTML = '<button class="secret">real</button>';
    ` });
    const post = w.document.querySelector("post-widget").attachShadow({ mode: "closed" });
    post.innerHTML = '<button class="secret">real</button>';
    w.ml._adoptRun("r-p4a", { toolNames: [], pierceClosed: true, builtBy: "worker" });
    const desc = (sel) => String(w.ml.domTools.find((t) => t.name === "describeElement").run({ selector: sel }).content);
    assert.match(desc("post-widget >>> button.secret"), /real/, "positive control: a root attached after the patch is readable with pierceClosedShadow");
    assert.match(desc("sealed-widget >>> button.secret"), /real/, "a root attached before our scripts were put into the page must be readable with pierceClosedShadow");
});

test("step 3 P4b: our own hosts' closed roots are never read into a tool result", { ...T, todo: "Nothing consults the mark today: page-gesture.ts's markOwnHost records our sidebar hosts (KEY __mlOwnHosts on the world's global; the callers are sidebar/shell.ts's card, shell and hl hosts), and dom.ts's traversableRoot reads any captured root into a describeElement result — our own card's internals included. Step 3's chrome.dom read is where the mark must be honoured (a host the extension created is ours whatever the page does). Positive control: a page host's root is shown." }, async () => {
    const w = loadDomWorld('<div id="ml-sb-card"></div><sealed-widget></sealed-widget>', { url: "https://hidden.example/page", isolated: true });
    w.document.querySelector("sealed-widget").attachShadow({ mode: "closed" }).innerHTML = '<button class="secret">real</button>';
    vm.runInContext(`
        const ours = document.querySelector("#ml-sb-card");
        const root = ours.attachShadow({ mode: "closed" });
        root.innerHTML = '<div class="secret">SECRET-OF-OURS</div>';
        globalThis.__mlOwnHosts = new WeakSet([ours]);
    `, w.context);
    w.ml._adoptRun("r-own", { toolNames: [], pierceClosed: true, builtBy: "worker" });
    const desc = (sel) => String(w.ml.domTools.find((t) => t.name === "describeElement").run({ selector: sel }).content);
    assert.match(desc("sealed-widget >>> button.secret"), /real/, "positive control: a page host's closed root is shown");
    assert.ok(!desc("#ml-sb-card >>> .secret").includes("SECRET-OF-OURS"), `our own hosts' closed roots must never be read into a tool result: ${desc("#ml-sb-card >>> .secret")}`);
});

// P5: builtin wrapping. Every wrap below is installed BEFORE injected.js is put in late — the hidden-page-with-run
// shape — so a kept builtin kept at module load IS the page's wrapper.

test("step 3 P5: wrapping MessagePort.prototype.postMessage, window.dispatchEvent, Element.prototype.attachShadow and JSON.stringify sees nothing of a hidden-page run", { ...T, todo: "The vectors each wrap meets today: page-channel.ts keeps nativePost at module load, which IS the page's wrapper when the page wrapped first (the wrap-after-load case is the kept builtin's defence and holds — see the :272 ruling in redteam-exec-shared-world.test.mjs), so the port's posts cross it; the ml-page-port hand-off and ml:ready go through the page's window.dispatchEvent; shadow-patch.js displaces the page's Element.prototype.attachShadow with its own; and the exec's value serialisation (tools.ts, the main-world :240 row's vector) calls the page's JSON.stringify — exec-routing refuses an exec on a hidden page today, so that half pins the tool stack step 3 moves into the isolated world. Fixed when nothing of ours runs in MAIN there at all." }, async () => {
    const w = loadPageWorld({
        visible: false, main: "injected-isolated.js", pageRealm: true, onRuntimeMessage: () => undefined,
        beforeInjected: `
            class Element {}
            Element.prototype.attachShadow = function (init) { return { __shimRoot: true, mode: init && init.mode }; };
            globalThis.Element = Element;
            window.Element = Element;
            globalThis.__postSeen = []; globalThis.__dispSeen = []; globalThis.__jsonSeen = [];
            globalThis.__attachWrap = Element.prototype.attachShadow;
            const portProto = MessagePort.prototype;
            const realPost = portProto.postMessage;
            portProto.postMessage = function (m) { __postSeen.push(m && m.type); return realPost.call(this, m); };
            const realDisp = window.dispatchEvent;
            window.dispatchEvent = function (e) { __dispSeen.push(e && e.type); return realDisp.call(this, e); };
            const realJson = JSON.stringify;
            JSON.stringify = function (v) {
                __jsonSeen.push(v == null ? String(v) : typeof v === "object" ? "obj[" + Object.keys(v).slice(0, 6).join(",") + "]" : typeof v + ":" + String(v).slice(0, 40));
                return realJson.apply(this, arguments);
            };
        `,
    });
    await flush(10);
    const adopt = plain(await w.fireRuntimeMessage({ type: "ADOPT_RUN_NOW", payload: { runId: "r-wrap", rebuild: { toolNames: ["exec"], builtBy: "worker" }, injected: true } }));
    assert.equal(typeof adopt?.pageInfo, "string", `positive control: the run was adopted: ${JSON.stringify(adopt)}`);
    const tool = plain(await w.fireRuntimeMessage({ type: "RUN_TOOL_IN_PAGE", payload: { runId: "r-wrap", name: "exec", args: { js: "({ price: 10 })" }, stream: true } }));
    assert.ok(tool && JSON.stringify(tool).length > 2, `positive control: the delegated tool answered: ${JSON.stringify(tool)}`);
    await w.fireRuntimeMessage({ type: "CANCEL_TOOL_IN_PAGE", payload: { runId: "r-wrap", callId: "c1" } });
    await flush(20);
    assert.deepEqual(plain(w.pageRun("__postSeen")), [], "the page's MessagePort.prototype.postMessage wrap read the run's port traffic");
    assert.deepEqual(plain(w.pageRun("__dispSeen")), [], "the page's window.dispatchEvent wrap saw an event of ours");
    assert.equal(w.pageRun("Element.prototype.attachShadow === __attachWrap"), true, "shadow-patch.js displaced the page's Element.prototype.attachShadow");
    assert.deepEqual(plain(w.pageRun("__jsonSeen")), [], "the page's JSON.stringify wrap read one of our values");
});

// --- a document that loaded before its origin's registration covered it (the race the janitor found) ---

test("a visible origin's document that says it heard no page script gets the page scripts put into it, that document only", T, async () => {
    const bg = worker({ local: { ml_site_always: ["https://ok.example"] } });
    const r = plain(await bg.send({ type: "PAGE_SCRIPT_MISSING" }, sender("https://ok.example", "doc-late")));
    assert.deepEqual(r, { data: true });
    const ex = executes(bg);
    assert.equal(ex.length, 1, JSON.stringify(ex));
    assert.equal(ex[0].world, "MAIN");
    assert.deepEqual(ex[0].files, PAGE_FILES);
    assert.deepEqual(ex[0].target, { tabId: 7, documentIds: ["doc-late"] });
});

test("a hidden origin's PAGE_SCRIPT_MISSING gets nothing, whatever its payload names, and a denied one the same answer", T, async () => {
    const bg = worker({ local: { ml_site_always: ["https://ok.example"], ml_site_denied: ["https://denied.example"] } });
    const answers = [];
    for (const origin of ["https://unknown.example", "https://denied.example"])
        answers.push(plain(await bg.send({ type: "PAGE_SCRIPT_MISSING", payload: { origin: "https://ok.example", url: "https://ok.example/" } }, sender(origin))));
    assert.deepEqual(answers, [{ data: false }, { data: false }]);
    assert.deepEqual(executes(bg), [], "a hidden page was given the page scripts");
});

test("PAGE_SCRIPT_MISSING from a subframe, or from no tab, gets nothing", T, async () => {
    const bg = worker({ local: { ml_site_always: ["https://ok.example"] } });
    const frame = { ...sender("https://ok.example"), frameId: 3 };
    assert.deepEqual(plain(await bg.send({ type: "PAGE_SCRIPT_MISSING" }, frame)), { data: false });
    assert.deepEqual(plain(await bg.send({ type: "PAGE_SCRIPT_MISSING" }, { url: "https://ok.example/", origin: "https://ok.example" })), { data: false });
    assert.deepEqual(executes(bg), []);
});

test("the content script says PAGE_SCRIPT_MISSING once on an open page with no page script, and never on a page that has one or is hidden", T, async () => {
    const missing = (w) => w.runtimeCalls.filter((c) => c.type === "PAGE_SCRIPT_MISSING").length;
    const late = loadPageWorld({ visible: true, main: null });
    const fine = loadPageWorld({ visible: true });
    const hidden = loadPageWorld({ visible: false, main: null });
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal(missing(late), 1, "an open page with no page script did not say so");
    assert.equal(missing(fine), 0, "a page whose page script said hello was reported missing");
    assert.equal(missing(hidden), 0, "a hidden page reported a page script it is not meant to have");
});

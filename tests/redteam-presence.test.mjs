// redteam-presence.test.mjs — what a HIDDEN page must not get from the extension (docs/spec/SITE_PRESENCE.md, step 2):
// no page script, no answer, nothing it can tell a denied origin from an unknown one by; and what a visible page gets
// instead, registered from the lists rather than named in the manifest.
//
// The worker runs in the real bundle (node:vm, mocked chrome, `siteGate: true` so a page is judged by the lists). The
// oracles are what the worker asks of chrome.scripting (`scriptingCalls`, the live `registered` map) and what it answers
// the content script. The content script's own silence is tested in the page world (`loadPageWorld({ visible })`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground, loadPageWorld, FakeMessageChannel, FakeMessageEvent } = require("./helpers");
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

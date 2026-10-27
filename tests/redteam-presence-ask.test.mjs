// redteam-presence-ask.test.mjs — the red-team pass on the stub window.ml (docs/spec/SITE_PRESENCE.md "The rule", site
// access PR 4b): what a page must NOT get from a closed gate that can ask, from the ungated REQUEST_ACCESS, and from the
// stub itself. Each property is a test with its positive control; a property that does not hold yet carries a `todo`.
//
// Two harnesses, often joined: the real worker bundle in node:vm with mocked chrome (`loadBackground({ siteGate: true })`),
// and the real content script with the real main-world script (ask.js, injected.js or none) in a page world
// (`loadPageWorld`). Joined, the content script's runtime messages go to the worker with the browser's sender for the
// page, and the worker's tab messages come back to the content script: the whole path a page's post takes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground, loadPageWorld } = require("./helpers");
const { HANDLE_MAP, PAGE_STARTED_TYPES, PAGE_UNGATED_TYPES } = await import("../src/page-relay.ts");
const { ASK_REFUSED } = await import("../src/site-requests.ts");

const T = { timeout: 30000 };
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const plain = (x) => JSON.parse(JSON.stringify(x ?? null));
const SECRET_URL = "http://secret-host.internal:3000/api/chat/completions", SECRET_KEY = "sk-SECRET-KEY-123", SECRET_FILTER = "^secret-filter-[a-z]+$";
const config = { chatUrl: SECRET_URL, apiKey: SECRET_KEY, modelFilter: SECRET_FILTER, model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off" };
const MARKED = "https://marked.example", ALLOWED = "https://ok.example", DENIED = "https://denied.example", OTHER = "https://unknown.example";
/** A content script's sender, as the browser stamps it: a tab, the frame's own URL and origin, a document. */
const sender = (origin, { tabId = 7, tabOrigin = origin, frameId = 0, documentId = "doc-1" } = {}) =>
    ({ tab: { id: tabId, url: `${tabOrigin}/page` }, url: `${origin}/page`, origin, frameId, documentId });
/** The worker, with the lists as stored. */
const worker = (opts = {}) => loadBackground({
    config: { ...config, ...opts.config }, siteGate: true,
    local: { ml_site_schema: 2, ml_site_always: [], ml_site_denied: [], ml_site_selfapprove: [], ...opts.local },
    session: { ml_site_session: [] },
    onFetch: () => jsonResponse({ choices: [{ message: { content: "BACKEND-ANSWER" } }] }),
    ...opts.extra,
});
/** Send and race a short timer: a type nothing answers never settles. */
const ask = (bg, msg, s, ms = 1500) => Promise.race([bg.send(msg, s), new Promise((r) => setTimeout(() => r("silent"), ms))]).then(plain);
const executes = (bg) => bg.scriptingCalls.filter(([k]) => k === "executeScript").map(([, i]) => plain(i));
const requestsStored = (bg) => plain(bg.localStore.ml_site_requests ?? null);

/** Every type a page can post to the content script on the page channel: the relay map's, and every one content.ts
 *  handles by name before it (read from the source, so a new one is enumerated without editing this file). */
const CHANNEL_TYPES = [...new Set([
    ...Object.keys(HANDLE_MAP),
    ...[...fs.readFileSync(new URL("../src/content.ts", import.meta.url), "utf8").matchAll(/data\.type === "([A-Z_]+)"/g)].map((m) => m[1]),
])].filter((t) => t !== "PAGE_ADOPT_HELLO").sort();

/**
 * A page world whose content script talks to the real worker as the page at `origin` (`senderOf`), and whose tab
 * messages from the worker reach that content script.
 */
function joined(bg, { origin, main = "ask.js", senderOf = () => sender(origin), holdReady } = {}) {
    let w;
    const toWorker = (m) => bg.send(m, senderOf());
    w = loadPageWorld({
        main, visible: false,
        onContentReady: async (m) => { if (holdReady) await holdReady; return plain(await toWorker(m)); },
        onRuntimeMessage: async (m) => plain(await toWorker(m)),
        onStream: () => { w.streams.push("stream"); },
    });
    w.streams = [];
    w.heard = [];
    return w;
}

/** Give the page world a gesture the content script counts (Q11): the browser's activation and a trusted pointerdown. */
function gesture(w) {
    w.context.performance = performance;
    w.context.navigator = { userActivation: { isActive: true } };
    w.context.window.dispatchEvent({ type: "pointerdown", isTrusted: true, composedPath: () => [] });
}

// --- the ask gate: only the access request crosses a closed gate, whatever the page posts ---

test("CHANNEL_TYPES: the enumeration is the relay map plus content.ts's own types, and includes the ones that matter", () => {
    for (const t of ["REQUEST_ACCESS_REQUEST", "LLM_STREAM_REQUEST", "CANCEL_RUN_REQUEST", "ABORT_REQUEST", "PAGE_TOOL_STREAM", "PAGE_VALUE_COLUMNS", "RUN_READOPTED", "START_RUN_REQUEST", "INFO_REQUEST"])
        assert.ok(CHANNEL_TYPES.includes(t), t);
    assert.ok(CHANNEL_TYPES.length >= Object.keys(HANDLE_MAP).length + 5, String(CHANNEL_TYPES.length));
});

test("a page with the stub: every other type it can post, on the stub's own port, reaches neither the worker nor a stream, and is never answered", T, async () => {
    const w = loadPageWorld({ main: "ask.js", visible: false, ask: true, onRuntimeMessage: () => ({ data: { state: "pending" } }), onStream: () => { streams.push(1); } });
    const streams = [], heard = [];
    await flush(10);
    w.fromContent((e) => heard.push(e.data?.type));
    for (const type of CHANNEL_TYPES) if (type !== "REQUEST_ACCESS_REQUEST")
        w.asInjected({ type, requestId: `x-${type}`, payload: { runId: "r", model: "m", messages: [] }, runId: "r", chunk: "c", key: "k" });
    await flush(30);
    assert.deepEqual(w.runtimeCalls.map((c) => c.type), [], "a type other than the request crossed the ask gate");
    assert.deepEqual(streams, [], "a stream port was opened");
    assert.deepEqual(heard, [], "the page was answered");
    // Positive control: the request itself crosses, once, and is answered on the same port.
    w.asInjected({ type: "REQUEST_ACCESS_REQUEST", requestId: "ask-1", payload: {} });
    await flush(30);
    assert.deepEqual(w.runtimeCalls.map((c) => c.type), ["REQUEST_ACCESS"]);
    assert.deepEqual(heard, ["REQUEST_ACCESS_RESPONSE"]);
});

for (const decided of ["ask", "hidden"])
test(`while the gate is pending, every type is held; once the worker says ${decided === "ask" ? "the page asks, only the request crosses, and no more than 16 are held" : "the page is hidden, nothing crosses and nothing is answered"}`, T, async () => {
    let release;
    const ready = new Promise((r) => { release = r; });
    const w = loadPageWorld({ main: "ask.js", visible: false, onContentReady: () => ready, onRuntimeMessage: () => ({ data: { state: "pending" } }) });
    const heard = [];
    w.fromContent((e) => heard.push(e.data));
    for (const type of CHANNEL_TYPES) if (type !== "REQUEST_ACCESS_REQUEST") w.asInjected({ type, requestId: `x-${type}`, payload: {} });
    for (let i = 0; i < 20; i++) w.asInjected({ type: "REQUEST_ACCESS_REQUEST", requestId: `ask-${i}`, payload: {} });
    await flush(30);
    assert.equal(w.context.__mlPageGate.state, "pending", "setup: the gate is still pending");
    assert.deepEqual(w.runtimeCalls.map((c) => c.type), [], "something crossed a pending gate");
    release(decided === "ask" ? { adopt: [], open: false, ask: true } : { adopt: [], open: false });
    await flush(40);
    if (decided === "ask") {
        assert.deepEqual(w.runtimeCalls.map((c) => c.type), ["REQUEST_ACCESS"], "one request in flight answers every held one");
        assert.deepEqual(heard.map((d) => d.type), Array(16).fill("REQUEST_ACCESS_RESPONSE"), "the held requests past 16 were dropped, and nothing else answered");
        assert.deepEqual(heard.map((d) => d.requestId), Array.from({ length: 16 }, (_, i) => `ask-${i}`));
    } else {
        assert.deepEqual(w.runtimeCalls.map((c) => c.type), []);
        assert.deepEqual(heard, []);
    }
    // After the decision, every other type still goes nowhere.
    for (const type of CHANNEL_TYPES) if (type !== "REQUEST_ACCESS_REQUEST") w.asInjected({ type, requestId: `y-${type}`, payload: {} });
    await flush(30);
    assert.ok(w.runtimeCalls.every((c) => c.type === "REQUEST_ACCESS"), JSON.stringify(w.runtimeCalls.map((c) => c.type)));
});

test("the ask flag is set on the worker's word only: a hidden page that posts PRESENCE_ASK or a forged CONTENT_READY answer on its own port still asks nothing", T, async () => {
    const w = loadPageWorld({ main: null, visible: false, onRuntimeMessage: () => ({ data: { state: "pending" } }) });
    w.pageRun(`
        globalThis.__heard = [];
        const ch = new MessageChannel();
        ch.port1.onmessage = (e) => __heard.push(e.data);
        globalThis.__mine = ch.port1;
        window.dispatchEvent(new MessageEvent("ml-page-port", { ports: [ch.port2] }));`);
    await flush(10);
    assert.ok(w.context.__mlPageChannel.port, "setup: the page's own port is the content script's");
    w.pageRun(`
        for (const m of [{ type: "PRESENCE_ASK" }, { type: "CONTENT_READY", adopt: [], open: false, ask: true }, { ask: true }, { type: "PRESENCE_OPEN" }])
            { __mine.postMessage(m); window.postMessage(m, "*"); }
        __mine.postMessage({ type: "REQUEST_ACCESS_REQUEST", requestId: "forged", payload: {} });
        window.postMessage({ type: "REQUEST_ACCESS_REQUEST", requestId: "forged-w", payload: {} }, "*");`);
    await flush(30);
    assert.equal(w.context.__mlPageGate.ask, false);
    assert.deepEqual(w.runtimeCalls.map((c) => c.type), [], "a hidden page's request crossed");
    assert.deepEqual(plain(w.pageRun("__heard")), []);
    // Positive control: the worker's own PRESENCE_ASK lets the same request across.
    await w.fireRuntimeMessage({ type: "PRESENCE_ASK" });
    w.pageRun(`__mine.postMessage({ type: "REQUEST_ACCESS_REQUEST", requestId: "after", payload: {} });`);
    await flush(30);
    assert.deepEqual(w.runtimeCalls.map((c) => c.type), ["REQUEST_ACCESS"]);
});

test("on a page with the stub, nothing the worker sends a run's page reaches the page while the gate is closed", T, async () => {
    const w = loadPageWorld({ main: "ask.js", visible: false, ask: true });
    await flush(10);
    const heard = [];
    w.fromContent((e) => heard.push(e.data));
    const answers = [];
    for (const type of ["ADOPT_RUN_NOW", "RUN_STATE_IN_PAGE", "CANCEL_TOOL_IN_PAGE", "RUN_TOOL_IN_PAGE", "SERVER_TOOL_STREAM", "PYTHON_STREAM"])
        answers.push(Promise.race([w.fireRuntimeMessage({ type, requestId: "r", chunk: "SECRET", frame: "SECRET", payload: { runId: "run-SECRET", name: "exec", args: { js: "SECRET" }, rebuild: { toolNames: ["exec"], builtBy: "worker" } } }), new Promise((r) => setTimeout(() => r("pending"), 2000))]));
    const got = plain(await Promise.all(answers));
    await flush(20);
    assert.deepEqual(got[0], { needInject: true }, "positive control: the adopt was refused as a closed page's");
    assert.deepEqual(heard, [], "the stub's page heard a run's traffic");
});

test("gateAsks is read only where the request crosses: the shell and every other relay check gateOpen", () => {
    const uses = [];
    const walk = (dir) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${f.name}`;
        if (f.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(f.name) && !/\.gen\.ts$/.test(f.name) && p !== "src/page-gate.ts") for (const [i, line] of fs.readFileSync(p, "utf8").split("\n").entries()) if (/gateAsks\(\)/.test(line)) uses.push(`${p}:${i + 1}`);
    } };
    walk("src");
    const content = fs.readFileSync("src/content.ts", "utf8").split("\n");
    assert.ok(uses.length > 0 && uses.every((u) => u.startsWith("src/content.ts:")), uses.join(", "));
    for (const u of uses) {
        const line = content[Number(u.split(":")[1]) - 1];
        assert.ok(/PRESENCE_CHECK|requestAccessFromPage/.test(line), `gateAsks read outside the PRESENCE_CHECK reply and the request's relay: ${line.trim()}`);
    }
});

// --- a hidden origin: nothing at all, and denied looks like unknown ---

const HIDDEN = [
    ["unknown, setting off", OTHER, { config: { siteRequests: false } }],
    ["denied, setting off", DENIED, { config: { siteRequests: false }, local: { ml_site_denied: [DENIED] } }],
    ["denied, setting on", DENIED, { config: { siteRequests: true }, local: { ml_site_denied: [DENIED] } }],
    ["denied and still marked (a list from a restore), setting on", DENIED, { config: { siteRequests: true }, local: { ml_site_denied: [DENIED], ml_site_visible: [DENIED] } }],
];

test("a hidden page, with the stub's script in it all the same, gets no answer to its request, no window message and no side effect", T, async () => {
    for (const [what, origin, opts] of HIDDEN) {
        const bg = worker(opts);
        await flush(20);
        const w = joined(bg, { origin });
        await flush(20);
        assert.equal(w.context.__mlPageGate.state, "closed", `${what}: setup`);
        w.fromContent((e) => w.heard.push(e.data));
        gesture(w);
        const r = await Promise.race([w.ml.requestAccess({ agents: true, reason: "x" }), new Promise((res) => setTimeout(() => res("silent"), 1500))]);
        assert.equal(r, "silent", `${what}: answered ${JSON.stringify(r)}`);
        for (const type of CHANNEL_TYPES) w.asInjected({ type, requestId: `x-${type}`, payload: {} });
        await flush(30);
        assert.deepEqual(w.runtimeCalls.map((c) => c.type), [], `${what}: a post reached the worker`);
        assert.deepEqual(w.heard, [], `${what}: the page was answered`);
        assert.deepEqual(w.windowPosts, [], `${what}: something was posted on the page's window`);
        assert.deepEqual(bg.calls, [], `${what}: the backend was reached`);
        assert.equal(requestsStored(bg), null, `${what}: a request was stored`);
        assert.deepEqual(executes(bg), [], `${what}: a script was put into the page`);
    }
    // Positive control: a marked origin's same call is relayed and answered by the worker.
    const bg = worker({ local: { ml_site_visible: [MARKED] } });
    await flush(20);
    const w = joined(bg, { origin: MARKED });
    await flush(20);
    gesture(w);
    assert.deepEqual(plain(await w.ml.requestAccess({ agents: true })), { state: "pending" });
});

// Only the ungated type is compared: a gated type's refusal names "not allowed" vs "not approved" (sw-site-access.ts
// pageRefusal, from before this change), which a hidden page never reads because its content script relays nothing
// (the test above). Every type is still sent, for the side effects.
test("at the worker, a denied origin and an unknown one get the same answer to the ungated REQUEST_ACCESS, and no page-started type has a side effect", T, async () => {
    const types = [...new Set([...PAGE_STARTED_TYPES, ...PAGE_UNGATED_TYPES])].sort();
    const norm = (x, origin) => JSON.stringify(x).split(origin).join("<origin>").split(new URL(origin).host).join("<host>");
    const answersOf = async ([, origin, opts]) => {
        const bg = worker(opts);
        await flush(20);
        const out = {};
        for (const type of types) { const r = norm(await ask(bg, { type, requestId: "r", payload: { agents: true, model: "m", messages: [{ role: "user", content: "x" }] }, gesture: true }, sender(origin), 800), origin); if (PAGE_UNGATED_TYPES.has(type)) out[type] = r; }
        assert.deepEqual(bg.calls, [], "the backend was reached");
        assert.equal(requestsStored(bg), null, "a request was stored");
        return out;
    };
    const base = await answersOf(HIDDEN[0]);
    for (const h of HIDDEN.slice(1)) assert.deepEqual(await answersOf(h), base, `${h[0]} answers unlike an unknown origin`);
    assert.equal(base.REQUEST_ACCESS, JSON.stringify({ data: { state: "refused", reason: ASK_REFUSED.off } }));
});

// --- a page cannot change its own presence ---

test("no page, even an allowed one, reaches the visible mark, siteRequests or SITE_ACCESS: every page-started type and every extension-only one", T, async () => {
    const EXT_ONLY = ["SITE_ACCESS", "ACCESS_REQUESTS", "START_ASKS", "POLICIES"];
    const types = [...new Set([...PAGE_STARTED_TYPES, ...PAGE_UNGATED_TYPES, ...EXT_ONLY, "SET_MODEL", "GET_CONFIG"])].sort();
    const bg = worker({ local: { ml_site_always: [ALLOWED] }, extra: { siteAgents: "always" } });
    await flush(20);
    for (const origin of [ALLOWED, MARKED]) for (const type of types) {
        const payload = {
            origin, edit: { op: "visible", origin, on: true }, siteRequests: true, model: "default-model",
            decision: { kind: "access", answer: "allow" }, ml_site_visible: [origin], config: { siteRequests: true },
        };
        await ask(bg, { type, requestId: "r", payload, siteRequests: true, gesture: true }, sender(origin), 600);
    }
    await flush(20);
    assert.notEqual(bg.stored.siteRequests, true, "a page turned on Let sites ask");
    assert.deepEqual(plain(bg.localStore.ml_site_visible ?? []), [], "a page marked an origin visible");
    assert.equal(bg.registered.has("ml-main-ask"), false, "the stub was registered");
    assert.deepEqual(plain(bg.localStore.ml_site_always), [ALLOWED]);
    // The relay map names none of the extension-only types, so the content script never sends one.
    for (const e of Object.values(HANDLE_MAP)) assert.ok(!EXT_ONLY.includes(e.type), e.type);
    // GET_CONFIG, which any allowed page reads, does not carry the setting or the mark.
    const c = plain(await bg.send({ type: "GET_CONFIG" }, sender(ALLOWED)));
    assert.ok(c?.data && !("siteRequests" in c.data) && !JSON.stringify(c).includes("visible"), JSON.stringify(c));
    // Positive control: the same edit from an extension page marks the origin.
    await bg.send({ type: "SITE_ACCESS", payload: { edit: { op: "visible", origin: MARKED, on: true } } }, { url: "chrome-extension://test/popup.html" });
    await flush(20);
    assert.deepEqual(plain(bg.localStore.ml_site_visible), [MARKED]);
});

// --- the origin is the sender's, never the payload's ---

test("a payload or message field naming another origin changes nothing: CONTENT_READY and REQUEST_ACCESS read the sender alone", T, async () => {
    const bg = worker({ local: { ml_site_visible: [MARKED], ml_site_always: [ALLOWED] } });
    await flush(20);
    const forged = { origin: MARKED, url: `${MARKED}/p`, tab: { id: 7, url: `${MARKED}/p` }, sender: { origin: MARKED, url: `${MARKED}/p` }, frameId: 0 };
    assert.deepEqual(await ask(bg, { type: "CONTENT_READY", payload: forged, ...forged }, sender(OTHER)), { adopt: [], open: false });
    assert.deepEqual(await ask(bg, { type: "CONTENT_READY", payload: { ...forged, origin: ALLOWED, url: `${ALLOWED}/p` } }, sender(OTHER)), { adopt: [], open: false });
    const off = await ask(bg, { type: "REQUEST_ACCESS", payload: { agents: true, ...forged }, ...forged, gesture: true }, sender(OTHER, { documentId: "d2" }));
    assert.deepEqual(off, { data: { state: "refused", reason: ASK_REFUSED.off } });
    assert.equal(requestsStored(bg), null);
    // Positive control: the marked origin's own request is stored under its own origin, whatever its payload names.
    const ok = await ask(bg, { type: "REQUEST_ACCESS", payload: { agents: true, origin: OTHER, url: `${OTHER}/p` }, origin: OTHER, gesture: true }, sender(MARKED, { documentId: "d3" }));
    assert.deepEqual(ok, { data: { state: "pending" } });
    assert.deepEqual(requestsStored(bg).entries.map((e) => e.origin), [MARKED]);
});

// --- frames and ports: each document gets its own origin's presence ---

test("frames: a hidden frame in an asking or allowed tab is hidden; an asking frame in a hidden tab gets its own origin's ask, and cannot ask from a sub-frame", T, async () => {
    const bg = worker({ local: { ml_site_visible: [MARKED], ml_site_always: [ALLOWED] } });
    await flush(20);
    const ready = (origin, tabOrigin) => ask(bg, { type: "CONTENT_READY" }, sender(origin, { tabOrigin, frameId: 3, documentId: `f-${origin}-${tabOrigin}` }));
    assert.deepEqual(await ready(OTHER, MARKED), { adopt: [], open: false }, "a hidden frame in a marked tab");
    assert.deepEqual(await ready(OTHER, ALLOWED), { adopt: [], open: false }, "a hidden frame in an allowed tab");
    assert.deepEqual(await ready(MARKED, OTHER), { adopt: [], open: false, ask: true }, "a marked frame in a hidden tab: its own origin's presence");
    assert.deepEqual(await ready(ALLOWED, OTHER), { adopt: [], open: true }, "positive control: an allowed frame is open on its own origin");
    // A marked origin in a sub-frame asks nothing: only a top frame can.
    const r = await ask(bg, { type: "REQUEST_ACCESS", payload: {}, gesture: true }, sender(MARKED, { tabOrigin: OTHER, frameId: 3, documentId: "f9" }));
    assert.deepEqual(r, { data: { state: "refused", reason: ASK_REFUSED.frame } });
    assert.equal(requestsStored(bg), null);
    // The stub is registered for top frames only.
    assert.equal(plain(bg.registered.get("ml-main-ask")).allFrames, false);
});

test("ports: marking http://host.test:8080 does not make http://host.test ask, nor the reverse; exclusions are by exact port too", T, async () => {
    const A = "http://host.test", B = "http://host.test:8080";
    for (const [marked, other] of [[B, A], [A, B]]) {
        const bg = worker({ local: { ml_site_visible: [marked] } });
        await flush(20);
        assert.deepEqual(await ask(bg, { type: "CONTENT_READY" }, sender(marked)), { adopt: [], open: false, ask: true }, `positive control: ${marked}`);
        assert.deepEqual(await ask(bg, { type: "CONTENT_READY" }, sender(other, { documentId: "d2" })), { adopt: [], open: false }, `${other} borrowed ${marked}'s mark`);
        assert.deepEqual(await ask(bg, { type: "REQUEST_ACCESS", payload: {}, gesture: true }, sender(other, { documentId: "d3" })), { data: { state: "refused", reason: ASK_REFUSED.off } });
        assert.deepEqual(plain(bg.registered.get("ml-main-ask").matches), [marked === A ? "http://host.test:80/*" : "http://host.test:8080/*"]);
    }
    // With every site asking and :8080 allowed, the bare host still asks and :8080 has the full API alone.
    const bg = worker({ local: { ml_site_always: [B] }, config: { siteRequests: true } });
    await flush(20);
    assert.deepEqual(plain(bg.registered.get("ml-main-ask").excludeMatches), ["http://host.test:8080/*"]);
    assert.deepEqual(await ask(bg, { type: "CONTENT_READY" }, sender(A)), { adopt: [], open: false, ask: true });
    assert.deepEqual(await ask(bg, { type: "CONTENT_READY" }, sender(B, { documentId: "d2" })), { adopt: [], open: true });
});

// --- the stub is the stub: one member, no way to the full relay ---

test("the stub's window.ml has requestAccess and nothing else, posts nothing on the window, and fires no ml:ready", T, async () => {
    const w = loadPageWorld({ main: "ask.js", visible: false, ask: true });
    await flush(10);
    assert.deepEqual(Object.keys(w.context.window.ml), ["requestAccess"]);
    assert.deepEqual(Object.getOwnPropertyNames(w.context.window.ml), ["requestAccess"]);
    assert.deepEqual(w.windowPosts, []);
    assert.deepEqual(w.dispatchedEvents, ["ml-page-port"], "the only event is the port's hand-off, before any page script");
    // A page that defined window.ml first keeps its own: the stub does not overwrite it.
    const pre = loadPageWorld({ main: null, visible: false, ask: true });
    pre.pageRun(`window.ml = { mine: true };`);
    pre.pageRun(fs.readFileSync("dist/ask.js", "utf8"));
    assert.deepEqual(plain(pre.context.window.ml), { mine: true });
});

test("requestAccess with no gesture is refused end to end and stores nothing; with one it waits (positive control)", T, async () => {
    const bg = worker({ local: { ml_site_visible: [MARKED] } });
    await flush(20);
    const w = joined(bg, { origin: MARKED });
    await flush(20);
    assert.deepEqual(plain(await w.ml.requestAccess({ agents: true, reason: "no click" })), { state: "refused", reason: ASK_REFUSED.gesture });
    assert.equal(requestsStored(bg), null);
    gesture(w);
    assert.deepEqual(plain(await w.ml.requestAccess({ agents: true, reason: "a click" })), { state: "pending" });
    assert.deepEqual(requestsStored(bg).entries.map((e) => [e.origin, e.state]), [[MARKED, "pending"]]);
});

test("a page that hands over its own port after the stub did is not taken: what it posts is not relayed, and the stub still asks", T, async () => {
    const w = loadPageWorld({ main: "ask.js", visible: false, ask: true, onRuntimeMessage: (m) => ({ data: { state: "pending", via: m.requestId } }) });
    await flush(10);
    w.pageRun(`
        globalThis.__heard = [];
        const ch = new MessageChannel();
        ch.port1.onmessage = (e) => __heard.push(e.data);
        window.dispatchEvent(new MessageEvent("ml-page-port", { ports: [ch.port2] }));
        ch.port1.postMessage({ type: "REQUEST_ACCESS_REQUEST", requestId: "forged", payload: {} });
        ch.port1.postMessage({ type: "INFO_REQUEST", requestId: "forged-info", payload: {} });`);
    await flush(30);
    assert.deepEqual(w.runtimeCalls, [], "the page's own port was relayed");
    assert.deepEqual(plain(w.pageRun("__heard")), []);
    const r = plain(await w.ml.requestAccess());
    assert.equal(r.state, "pending", "positive control: the stub's own request crossed");
});

test("after a grant the full API replaces the stub in the open page with no reload; a reference the page kept to the stub is inert", T, async () => {
    let onTab = async () => undefined;
    const bg = worker({ local: { ml_site_visible: [MARKED] }, extra: { openTabs: [{ id: 7, url: `${MARKED}/page`, active: true, windowId: 1 }], onTabMessage: (...a) => onTab(...a) } });
    await flush(20);
    const w = joined(bg, { origin: MARKED });
    onTab = async (_tabId, msg) => {
        // executeScript is recorded by the worker; play its effect here, in the order the worker asks for it.
        return plain(await w.fireRuntimeMessage(msg));
    };
    await flush(20);
    w.pageRun(`globalThis.__stub = window.ml; globalThis.__stubAsk = window.ml.requestAccess;`);
    // The person allows the site from its request.
    bg.setLocal({ ml_site_always: [MARKED] });
    await flush(40);
    const injected = executes(bg).find((e) => JSON.stringify(e.files) === JSON.stringify(["shadow-patch.js", "injected.js"]));
    assert.ok(injected, `the worker put the full scripts into the open tab: ${JSON.stringify(executes(bg))}`);
    w.pageRun(fs.readFileSync("dist/injected.js", "utf8"));
    await w.fireRuntimeMessage({ type: "PRESENCE_OPEN" });
    await flush(20);
    assert.equal(w.context.__mlPageGate.state, "open");
    assert.notEqual(w.pageRun("window.ml"), w.pageRun("__stub"), "window.ml is still the stub");
    assert.equal(typeof w.pageRun("window.ml.info"), "function", "the full API is there");
    assert.deepEqual(Object.keys(w.pageRun("__stub")), ["requestAccess"], "the old stub object grew members");
    // What the page kept: the stub's request went out on the port the content script dropped at PAGE_PORT_ARM.
    const kept = await Promise.race([w.pageRun("__stubAsk()"), new Promise((r) => setTimeout(() => r("silent"), 1500))]);
    assert.equal(kept, "silent", `the kept stub still reaches the content script: ${JSON.stringify(kept)}`);
});

// --- what an answer carries: the scrub ---

test("every answer to the stub's request is scrubbed: no server URL, key or model filter, an error from the handler included", T, async () => {
    const bg = worker({ local: { ml_site_visible: [MARKED] } });
    await flush(20);
    const leaks = (x) => ["secret-host.internal", SECRET_KEY, SECRET_FILTER, "secret-filter"].filter((s) => JSON.stringify(x).includes(s));
    const shapes = [{}, { agents: true }, { level: "self-approve" }, { reason: SECRET_KEY }, { agents: "yes", level: 3, reason: { toString: 1 } }];
    for (const [i, payload] of shapes.entries()) {
        const r = await ask(bg, { type: "REQUEST_ACCESS", payload, gesture: i === 1 }, sender(MARKED, { documentId: `d${i}` }));
        assert.ok(r && r !== "silent", `answered: ${JSON.stringify(r)}`);
        assert.deepEqual(leaks(r), [], JSON.stringify(r));
    }
    // An error inside the handler carries the secrets; the page gets them scrubbed.
    const local = bg.context.chrome.storage.local, get = local.get.bind(local);
    local.get = (k, ...rest) => { if (k === "ml_site_requests") throw new Error(`failed at ${SECRET_URL} with ${SECRET_KEY} for ${SECRET_FILTER}`); return get(k, ...rest); };
    const r = await ask(bg, { type: "REQUEST_ACCESS", payload: {}, gesture: true }, sender(MARKED, { documentId: "dx" }));
    assert.ok(typeof r?.error === "string", `positive control: the handler's error reached the answer: ${JSON.stringify(r)}`);
    assert.deepEqual(leaks(r), [], JSON.stringify(r));
});

// --- taking the presence away: the registration, and what an open page keeps ---

for (const how of ["unmarked", "setting off", "denied"])
test(`once the origin is ${how}, the stub's registration goes and an open page's request gets no answer at all`, T, async () => {
    const opts = how === "setting off" ? { config: { siteRequests: true } } : { local: { ml_site_visible: [MARKED] } };
    let w;
    const bg = worker({ ...opts, extra: { openTabs: [{ id: 7, url: `${MARKED}/page`, active: true, windowId: 1 }], onTabMessage: async (_t, msg) => plain(await w.fireRuntimeMessage(msg)) } });
    await flush(20);
    w = joined(bg, { origin: MARKED });
    await flush(20);
    assert.equal(w.context.__mlPageGate.ask, true, "setup: the page asks");
    assert.ok(bg.registered.has("ml-main-ask"), "setup: the stub is registered");
    if (how === "unmarked") bg.setLocal({ ml_site_visible: [] });
    else if (how === "setting off") bg.setSync({ siteRequests: false });
    else bg.setLocal({ ml_site_visible: [], ml_site_denied: [MARKED] });
    await flush(40);
    assert.equal(bg.registered.has("ml-main-ask"), false, "the stub is still registered");
    gesture(w);
    const r = await Promise.race([w.ml.requestAccess({ agents: true }), new Promise((res) => setTimeout(() => res("silent"), 1500))]);
    assert.equal(r, "silent", `a page that is hidden now was answered: ${JSON.stringify(r)}`);
    assert.equal(requestsStored(bg), null);
});

test("marking an origin puts the stub only into the document whose origin was checked: the injection names that document", T, async () => {
    const bg = worker({ extra: { openTabs: [{ id: 7, url: `${MARKED}/page`, active: true, windowId: 1 }], onTabMessage: async (_t, msg) => (msg.type === "PRESENCE_CHECK" ? { gate: "closed", alive: false, ask: false } : true) } });
    await flush(20);
    bg.setLocal({ ml_site_visible: [MARKED] });
    await flush(40);
    const stub = executes(bg).find((e) => JSON.stringify(e.files) === JSON.stringify(["ask.js"]));
    assert.ok(stub, `positive control: the open tab was given the stub: ${JSON.stringify(executes(bg))}`);
    assert.ok(Array.isArray(stub.target.documentIds) && stub.target.documentIds.length === 1, `the injection is not pinned to a document: ${JSON.stringify(stub.target)}`);
});

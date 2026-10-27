// presence-ask.test.mjs — the stub window.ml (docs/spec/SITE_PRESENCE.md "The rule", site access PR 4b): which pages get
// ask.js, what the worker tells their content script, and that the one request the stub sends is the only thing that
// crosses. The worker runs in the real bundle (node:vm, mocked chrome, `siteGate: true`); the content script in the page
// world. The hostile-page half is in redteam-presence.test.mjs and redteam.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground, loadPageWorld } = require("./helpers");

const T = { timeout: 30000 };
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const plain = (x) => JSON.parse(JSON.stringify(x ?? null));
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off" };
const sender = (origin, documentId = "doc-1") => ({ tab: { id: 7, url: `${origin}/page` }, url: `${origin}/page`, origin, frameId: 0, documentId });
const MARKED = "https://marked.example", ALLOWED = "https://ok.example", DENIED = "https://denied.example", OTHER = "https://unknown.example";
/** The worker, with the lists as stored (no `ml_site_visible` and no `siteRequests` unless a test sets them). */
const worker = (opts = {}) => loadBackground({
    config: { ...config, ...opts.config }, siteGate: true,
    local: { ml_site_schema: 2, ml_site_always: [], ml_site_denied: [], ml_site_selfapprove: [], ...opts.local },
    session: { ml_site_session: [] },
    onFetch: () => jsonResponse({ choices: [{ message: { content: "done" } }] }),
});

// --- what the worker tells a page's content script ---

test("CONTENT_READY: a marked site and, with the setting on, any unknown site may ask; allowed is open; denied looks like unknown-and-off", T, async () => {
    const lists = { ml_site_visible: [MARKED, DENIED], ml_site_always: [ALLOWED], ml_site_denied: [DENIED] };
    const cases = [
        [false, MARKED, { adopt: [], open: false, ask: true }],
        [false, OTHER, { adopt: [], open: false }],
        [false, DENIED, { adopt: [], open: false }],
        [false, ALLOWED, { adopt: [], open: true }],
        [true, MARKED, { adopt: [], open: false, ask: true }],
        [true, OTHER, { adopt: [], open: false, ask: true }],
        [true, DENIED, { adopt: [], open: false }],
        [true, ALLOWED, { adopt: [], open: true }],
    ];
    for (const [siteRequests, origin, want] of cases) {
        const bg = worker({ local: lists, config: { siteRequests } });
        assert.deepEqual(plain(await bg.send({ type: "CONTENT_READY" }, sender(origin))), want, `${origin}, setting ${siteRequests}`);
    }
});

test("UPGRADE: an install from before the mark (no ml_site_visible, no siteRequests) shows the stub nowhere", T, async () => {
    const bg = worker();
    await flush(20);
    assert.deepEqual(plain(await bg.send({ type: "CONTENT_READY" }, sender(OTHER))), { adopt: [], open: false });
    assert.equal(bg.registered.has("ml-main-ask"), false);
});

// --- the stub's registration follows the mark and the setting ---

test("a marked site gets ask.js registered for its exact origin, in the main world at document_start, never beside injected.js", T, async () => {
    const bg = worker({ local: { ml_site_visible: [MARKED, "http://marked.example:8080"], ml_site_always: [ALLOWED] } });
    await flush(20);
    const r = plain(bg.registered.get("ml-main-ask"));
    assert.ok(r, `registered: ${[...bg.registered.keys()]}`);
    assert.deepEqual([...r.matches].sort(), ["http://marked.example:8080/*", "https://marked.example:443/*"]);
    assert.deepEqual(r.js, ["ask.js"]);
    assert.equal(r.world, "MAIN");
    assert.equal(r.runAt, "document_start");
    assert.equal(r.allFrames, false);
    assert.equal(r.persistAcrossSessions, true);
    assert.deepEqual(r.excludeMatches, ["https://ok.example:443/*"], "an allowed origin gets the full API alone");
    assert.ok(!plain(bg.registered.get("ml-main-lasting")).js.includes("ask.js"));
});

test("with \"Let sites ask\" on, the stub is registered for every http(s) page but the allowed and denied origins; turning it off unregisters it", T, async () => {
    const bg = worker({ local: { ml_site_always: [ALLOWED], ml_site_denied: [DENIED] }, config: { siteRequests: true } });
    await flush(20);
    let r = plain(bg.registered.get("ml-main-ask"));
    assert.deepEqual(r?.matches, ["http://*/*", "https://*/*"]);
    assert.deepEqual([...r.excludeMatches].sort(), ["https://denied.example:443/*", "https://ok.example:443/*"]);
    bg.setSync({ siteRequests: false });
    await flush(20);
    assert.equal(bg.registered.has("ml-main-ask"), false, "off, and nothing marked: no stub anywhere");
    bg.setSync({ siteRequests: true });
    await flush(20);
    r = plain(bg.registered.get("ml-main-ask"));
    assert.deepEqual(r?.matches, ["http://*/*", "https://*/*"], "on again");
});

test("marking, allowing and unmarking a site move it between the stub's registration and the full one", T, async () => {
    const bg = worker();
    await flush(20);
    assert.equal(bg.registered.has("ml-main-ask"), false);
    bg.setLocal({ ml_site_visible: [MARKED] });
    await flush(20);
    assert.deepEqual(plain(bg.registered.get("ml-main-ask")?.matches), ["https://marked.example:443/*"]);
    bg.setLocal({ ml_site_always: [MARKED] });
    await flush(20);
    assert.equal(bg.registered.has("ml-main-ask"), false, "allowed: the marked site gets the full API, not the stub");
    assert.deepEqual(plain(bg.registered.get("ml-main-lasting")?.matches), ["https://marked.example:443/*"]);
    bg.setLocal({ ml_site_always: [], ml_site_visible: [] });
    await flush(20);
    assert.equal(bg.registered.has("ml-main-ask"), false, "unmarked: hidden again");
});

// --- the stub's one request ---

test("REQUEST_ACCESS: a marked site's request waits for the person; an unmarked one is refused with nothing stored", T, async () => {
    const bg = worker({ local: { ml_site_visible: [MARKED] } });
    await flush(20);
    const r = plain(await bg.send({ type: "REQUEST_ACCESS", payload: { agents: false }, requestId: "r1", gesture: true }, sender(MARKED)));
    assert.equal(r?.data?.state, "pending", JSON.stringify(r));
    const off = plain(await bg.send({ type: "REQUEST_ACCESS", payload: { agents: false }, requestId: "r2", gesture: true }, sender(OTHER, "doc-2")));
    assert.deepEqual(off?.data, { state: "refused", reason: "this browser does not take requests from sites" });
    const store = plain(bg.localStore?.ml_site_requests ?? null);
    assert.ok(!JSON.stringify(store).includes("unknown.example"), `stored: ${JSON.stringify(store)}`);
});

test("REQUEST_ACCESS: with the setting on, any unknown site's request waits; a denied site's is refused", T, async () => {
    const bg = worker({ local: { ml_site_denied: [DENIED] }, config: { siteRequests: true } });
    await flush(20);
    const r = plain(await bg.send({ type: "REQUEST_ACCESS", payload: {}, requestId: "r1", gesture: true }, sender(OTHER)));
    assert.equal(r?.data?.state, "pending", JSON.stringify(r));
    const d = plain(await bg.send({ type: "REQUEST_ACCESS", payload: {}, requestId: "r2", gesture: true }, sender(DENIED, "doc-2")));
    assert.notEqual(d?.data?.state, "pending");
    assert.notEqual(d?.data?.state, "granted");
});

// --- the content script on a page with the stub ---

test("a page with the stub: its access request is relayed with the gesture fact, and nothing else it posts reaches the worker", T, async () => {
    const w = loadPageWorld({ visible: false, ask: true, onRuntimeMessage: () => ({ data: { state: "pending" } }) });
    await flush(10);
    for (const type of ["INFO_REQUEST", "LLM_REQUEST", "START_RUN_REQUEST", "LIST_MODELS_REQUEST"]) w.asInjected({ type, requestId: `p-${type}`, payload: {} });
    w.asInjected({ type: "REQUEST_ACCESS_REQUEST", requestId: "ask-1", payload: { agents: true } });
    await flush(30);
    assert.deepEqual(w.runtimeCalls.map((c) => c.type), ["REQUEST_ACCESS"]);
    assert.equal(typeof w.runtimeCalls[0].gesture, "boolean", "the content script adds the gesture fact");
});

test("a hidden page (no stub): even its access request is dropped unanswered", T, async () => {
    const w = loadPageWorld({ visible: false, onRuntimeMessage: () => ({ data: { state: "pending" } }) });
    await flush(10);
    w.asInjected({ type: "REQUEST_ACCESS_REQUEST", requestId: "ask-1", payload: {} });
    await flush(30);
    assert.deepEqual(w.runtimeCalls.map((c) => c.type), []);
});

test("an access request posted before the worker answered is relayed once it says the page has the stub (and only once)", T, async () => {
    const w = loadPageWorld({ visible: false, ask: true, onRuntimeMessage: () => ({ data: { state: "pending" } }) });
    w.asInjected({ type: "REQUEST_ACCESS_REQUEST", requestId: "early", payload: {} });
    await flush(30);
    assert.deepEqual(w.runtimeCalls.map((c) => c.type), ["REQUEST_ACCESS"]);
});

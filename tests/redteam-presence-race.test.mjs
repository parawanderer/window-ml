// redteam-presence-race.test.mjs — what a hostile page must NOT get from PAGE_SCRIPT_MISSING (docs/spec/SITE_PRESENCE.md,
// step 2, "FOUND 2026-10-27 by the janitor"): the content script's once-only "I was answered open and heard no page
// script", which makes the worker put shadow-patch.js + injected.js into ONE document of a tab.
//
// The threat: a hidden page getting window.ml's page script (so it can see, or use, the extension) by this route; a document
// other than the sender's getting it; a page told apart as denied-vs-unknown by the answer. A page cannot send a runtime
// message itself: the only producer is the content script, which speaks only after the worker opened its gate. So the shapes
// split in two: the worker handler judged on every sender shape (the browser's facts), and the content script judged on what
// a page can post to it.
//
// Shapes that HELD and are pinned below: unknown / denied / merely-visible ("ask") origin; payload naming an allowed origin;
// sender.url hidden while tab.url is allowed; about:blank, data:, blob:, about:srcdoc, file:, extension URLs; lookalike
// origins (userinfo, other scheme, other port, suffix host); frameId != 0; no tab; origin revoked while the message is in
// flight; a navigation between the send and the inject (the target is the sender's documentId, never the tab); the page
// forging the message on its window or on the port; a hidden / pending / ask-only gate; a hello that arrives late.
// Shapes that are OPEN are `todo` tests: no documentId (falls back to the tab's CURRENT document), and a repeated message
// (injects twice; the second run replaces window.ml and re-arms the port, orphaning a run on the first instance).
// Not worth a test: the content script is the only producer and `contentReady` retries only when the worker gave NO answer,
// so the real sender cannot repeat; the page cannot forge the hello on a hidden page because the gate drops it unread.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground, loadPageWorld } = require("./helpers");

const T = { timeout: 30000 };
const plain = (x) => JSON.parse(JSON.stringify(x ?? null));
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off" };
const PAGE_FILES = ["shadow-patch.js", "injected.js"];
const OK = "https://ok.example";
/** A top-frame content script on tab 7, as the browser stamps its messages. */
const sender = (origin, documentId = "doc-1") => ({ tab: { id: 7, url: `${origin}/page` }, url: `${origin}/page`, origin, frameId: 0, documentId });
const executes = (bg) => bg.scriptingCalls.filter(([k]) => k === "executeScript").map(([, i]) => plain(i));
const worker = (local = {}, session = {}) => loadBackground({
    config, siteGate: true,
    local: { ml_site_schema: 2, ml_site_always: [OK], ml_site_denied: ["https://denied.example"], ml_site_selfapprove: [], ml_site_visible: ["https://ask.example"], ...local },
    session: { ml_site_session: [], ...session },
    onFetch: () => jsonResponse({ choices: [{ message: { content: "done" } }] }),
});
const MISSING = { type: "PAGE_SCRIPT_MISSING" };
const NO = { data: false };
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

// --- 1. a hidden page gets no page script, by any sender shape ---

test("positive control: the allowed origin's top-frame document is injected, in the main world, that document only", T, async () => {
    const bg = worker();
    assert.deepEqual(plain(await bg.send(MISSING, sender(OK, "doc-7"))), { data: true });
    const ex = executes(bg);
    assert.equal(ex.length, 1);
    assert.equal(ex[0].world, "MAIN");
    assert.deepEqual(ex[0].files, PAGE_FILES);
    assert.deepEqual(ex[0].target, { tabId: 7, documentIds: ["doc-7"] });
});

for (const [name, s] of Object.entries({
    "an unknown origin": sender("https://unknown.example"),
    "a denied origin": sender("https://denied.example"),
    "an origin marked visible but not allowed (presence ask)": sender("https://ask.example"),
    "a denied origin whose message payload names an allowed one": { ...sender("https://denied.example"), payload: { origin: OK } },
    "a lookalike: the allowed host as userinfo": { ...sender("https://evil.example"), url: `${OK}@evil.example/`, tab: { id: 7, url: `${OK}@evil.example/` } },
    "a lookalike: the allowed host as a suffix label": sender(`${OK}.evil.example`),
    "a lookalike: the allowed host under another scheme": sender("http://ok.example"),
    "a lookalike: the allowed host on another port": sender("https://ok.example:8443"),
    "a hidden url while tab.url names the allowed origin": { ...sender("https://unknown.example"), tab: { id: 7, url: `${OK}/page` } },
    "an about:blank document inside an allowed tab": { ...sender(OK), url: "about:blank" },
    "an about:srcdoc document inside an allowed tab": { ...sender(OK), url: "about:srcdoc" },
    "a data: document": { ...sender(OK), url: "data:text/html,<p>x</p>" },
    "a blob: document": { ...sender(OK), url: `blob:${OK}/1234` },
    "a file: document": { ...sender(OK), url: "file:///etc/passwd" },
    "an extension page's url": { ...sender(OK), url: "chrome-extension://abc/popup.html" },
    "a subframe of an allowed page": { ...sender(OK), frameId: 3 },
    "a subframe of an allowed page, frameId a string": { ...sender(OK), frameId: "0" },
    "no tab (an extension page or a worker)": { url: `${OK}/page`, origin: OK, frameId: 0, documentId: "d" },
    "no url at all and no tab url": { tab: { id: 7 }, frameId: 0, documentId: "d" },
})) {
    test(`${name} is answered {data:false} and nothing is injected or sent to the tab`, T, async () => {
        const bg = worker();
        assert.deepEqual(plain(await bg.send(MISSING, s)), NO);
        await settle();
        assert.deepEqual(executes(bg), [], "the page scripts were injected");
        assert.deepEqual(plain(bg.tabMessages), [], "the worker spoke to the tab (PAGE_PORT_ARM) for a page it should ignore");
    });
}

test("session-granted origin is allowed (control) and a denial wins over the same origin's session grant", T, async () => {
    const bg = worker({ ml_site_denied: ["https://s.example"] }, { ml_site_session: ["https://s.example", "https://t.example"] });
    assert.deepEqual(plain(await bg.send(MISSING, sender("https://s.example"))), NO);
    assert.deepEqual(plain(await bg.send(MISSING, sender("https://t.example", "doc-t"))), { data: true });
    assert.deepEqual(executes(bg).map((e) => e.target.documentIds), [["doc-t"]]);
});

test("an origin revoked while the message is in flight gets nothing: the lists are read when it is handled", T, async () => {
    const bg = worker();
    const answer = bg.send(MISSING, sender(OK));
    bg.setLocal({ ml_site_always: [], ml_site_denied: [OK] });
    assert.deepEqual(plain(await answer), NO);
    assert.deepEqual(executes(bg), []);
});

// --- 2. a visible page is not injected twice ---

test("a repeated PAGE_SCRIPT_MISSING from one document injects once", { ...T, todo: "OPEN: the handler keeps no per-document memory, so a repeat injects again; the second injected.js replaces window.ml and, after the PAGE_PORT_ARM, takes the content script's port, orphaning a run on the first instance. The only producer (content.ts) sends once, so a page cannot cause it; a worker-side race with showInOpenTabs (sw-presence.ts, injects on gate open + alive:false) can" }, async () => {
    const bg = worker();
    assert.deepEqual(plain(await bg.send(MISSING, sender(OK, "doc-r"))), { data: true });
    await bg.send(MISSING, sender(OK, "doc-r"));
    assert.equal(executes(bg).length, 1, "the same document was injected twice");
});

test("cost of a double injection (pins why the todo above matters): a second injected.js replaces window.ml", T, async () => {
    const w = loadPageWorld({ visible: true });
    const first = w.ml;
    w.pageRun(fs.readFileSync(new URL("../dist/injected.js", import.meta.url), "utf8"));
    assert.notEqual(w.context.window.ml, first, "if this ever becomes the same object, injected.js is idempotent and the todo can go");
    assert.equal(w.dispatchedEvents.filter((e) => e === "ml-page-port").length, 2, "a second hand-off of a port to the content script");
});

test("two different documents of one tab are each injected once, in their own right (no cross-document dedupe)", T, async () => {
    const bg = worker();
    await bg.send(MISSING, sender(OK, "doc-a"));
    await bg.send(MISSING, sender(OK, "doc-b"));
    assert.deepEqual(executes(bg).map((e) => e.target.documentIds), [["doc-a"], ["doc-b"]]);
});

// --- 3. never a document other than the sender's ---

test("a navigation between the send and the inject does not retarget: the target is the sender's document id", T, async () => {
    const bg = worker();
    bg.commit(7, { documentId: "doc-old", url: `${OK}/page` });
    const answer = bg.send(MISSING, sender(OK, "doc-old"));
    bg.commit(7, { documentId: "doc-new", url: "https://unknown.example/" });
    await answer;
    await settle();
    for (const e of executes(bg)) assert.deepEqual(e.target, { tabId: 7, documentIds: ["doc-old"] }, "injected somewhere other than the sender's document");
    for (const [tabId, msg, opts] of bg.tabMessages) if (msg?.type === "PAGE_PORT_ARM") assert.deepEqual([tabId, plain(opts)], [7, { documentId: "doc-old" }], "the port re-arm went to another document");
});

test("the tab id comes from the sender, never from the message", T, async () => {
    const bg = worker();
    await bg.send({ ...MISSING, tabId: 99, payload: { tabId: 99, documentId: "doc-victim", documentIds: ["doc-victim"] }, documentId: "doc-victim" }, sender(OK, "doc-mine"));
    assert.deepEqual(executes(bg).map((e) => e.target), [{ tabId: 7, documentIds: ["doc-mine"] }]);
});

test("a sender with no documentId is not injected into the tab's CURRENT document", { ...T, todo: "OPEN: injectPageScripts(tabId, undefined) targets {tabId}, i.e. whatever top document the tab shows when executeScript runs (and PAGE_PORT_ARM goes to frameId 0), so a navigation after the origin check lands the scripts in a page whose origin was never read. Real content-script senders always carry documentId, so this is a fail-open on an absent field, not a reachable page attack; the fix is to answer {data:false} when sender.documentId is not a string" }, async () => {
    const bg = worker();
    const { documentId: _d, ...noDoc } = sender(OK);
    await bg.send(MISSING, noDoc);
    for (const e of executes(bg)) assert.ok(e.target.documentIds?.length, `injected by tab only: ${JSON.stringify(e.target)}`);
});

// --- 4. nothing tells a hidden page from a denied one ---

test("every refusal gives the same answer and the same side effects, whatever the reason", T, async () => {
    const shapes = [sender("https://unknown.example"), sender("https://denied.example"), sender("https://ask.example"), { ...sender(OK), frameId: 2 }, { ...sender(OK), url: "about:blank" }];
    const seen = [];
    for (const s of shapes) {
        const bg = worker();
        const r = plain(await bg.send(MISSING, s));
        await settle();
        seen.push(JSON.stringify([r, executes(bg), plain(bg.tabMessages), bg.scriptingCalls.filter(([k]) => k !== "registerContentScripts" && k !== "unregisterContentScripts" && k !== "getRegisteredContentScripts").length, bg.calls.length]));
    }
    assert.equal(new Set(seen).size, 1, `the refusals differ: ${seen.join(" | ")}`);
    assert.deepEqual(JSON.parse(seen[0])[0], NO);
});

test("the CONTENT_READY answer and the PAGE_SCRIPT_MISSING answer agree: a page closed at one is refused at the other", T, async () => {
    const bg = worker();
    for (const origin of ["https://unknown.example", "https://denied.example", "https://ask.example"]) {
        const ready = plain(await bg.send({ type: "CONTENT_READY" }, sender(origin)));
        assert.equal(ready.open, false, origin);
        assert.deepEqual(plain(await bg.send(MISSING, sender(origin))), NO, origin);
    }
    assert.deepEqual(executes(bg), []);
});

// --- 5. timing and forgery in the content script ---

const missing = (w) => w.runtimeCalls.filter((c) => c.type === "PAGE_SCRIPT_MISSING").length;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("a gate still pending (the worker has not answered) reports nothing", T, async () => {
    const w = loadPageWorld({ visible: true, main: null, onContentReady: () => new Promise(() => {}) });
    await wait(2000);
    assert.equal(missing(w), 0, "reported on a page whose gate never opened");
});

test("a closed gate that may ask (the stub page) reports nothing", T, async () => {
    const w = loadPageWorld({ visible: false, ask: true, main: "ask.js" });
    await wait(2000);
    assert.equal(missing(w), 0);
});

test("a worker that answers late (first ask unanswered, retry opens) still yields exactly one report", T, async () => {
    let n = 0;
    const w = loadPageWorld({ visible: true, main: null, onContentReady: async () => (++n === 1 ? undefined : { adopt: [], open: true }) });
    await wait(3200);
    assert.ok(n >= 2, "setup: the ask was retried");
    assert.equal(missing(w), 1);
});

test("a page script that says hello before the timer fires cancels the report", T, async () => {
    const w = loadPageWorld({ visible: true, main: null });
    await wait(700);
    w.pageRun(fs.readFileSync(new URL("../dist/injected.js", import.meta.url), "utf8"));
    await wait(1600);
    assert.equal(missing(w), 0, "reported a page script that had said hello");
});

test("a page cannot make the content script send it: forged posts on window, and on the port, are not relayed", T, async () => {
    for (const visible of [true, false]) {
        const w = loadPageWorld({ visible, main: visible ? "injected.js" : null });
        await wait(30);
        w.context.window.postMessage({ type: "PAGE_SCRIPT_MISSING" }, "*");
        w.context.window.postMessage({ type: "PAGE_SCRIPT_MISSING", requestId: "x", payload: {} }, "*");
        if (visible) { w.asInjected({ type: "PAGE_SCRIPT_MISSING" }); w.asInjected({ type: "PAGE_SCRIPT_MISSING_REQUEST", requestId: "y", payload: {} }); }
        await wait(1700 - 30);
        const fromForgery = w.runtimeCalls.filter((c) => c.type === "PAGE_SCRIPT_MISSING" || c.type === "PAGE_SCRIPT_MISSING_REQUEST");
        assert.equal(fromForgery.length, 0, `visible=${visible}: a forged post reached the worker: ${JSON.stringify(fromForgery)}`);
    }
});

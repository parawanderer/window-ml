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
const { jsonResponse, loadBackground, loadPageWorld } = require("./helpers");

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

test("a run the person starts on a hidden page injects the page scripts only after the content script asked, then adopts", T, async () => {
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
    assert.equal(ex[0].world, "MAIN");
    assert.deepEqual(ex[0].files, PAGE_FILES);
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
    for (const type of ["INFO_REQUEST", "LLM_REQUEST", "LIST_MODELS_REQUEST", "START_RUN_REQUEST"])
        w.context.window.postMessage({ type, requestId: `x-${type}`, payload: {} }, "*");
    await flush(30);
    assert.deepEqual(w.runtimeCalls.map((c) => c.type), [], "a hidden page's post reached the worker");
    assert.deepEqual(posted, [], "a hidden page was answered");
});

test("on a visible page what the page posted before the worker answered is relayed once it does (positive control)", T, async () => {
    const w = loadPageWorld({ visible: true, onRuntimeMessage: () => ({ data: "ANSWERED" }) });
    w.context.window.postMessage({ type: "INFO_REQUEST", requestId: "early", payload: {} }, "*");
    await flush(30);
    assert.ok(w.runtimeCalls.some((c) => c.type === "GET_INFO" || c.requestId === "early" || JSON.stringify(c).includes("early")), JSON.stringify(w.runtimeCalls));
});

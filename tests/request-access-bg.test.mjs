// request-access-bg.test.mjs — ml.requestAccess in the worker (docs/spec/SITE_ACCESS_SLICE3.md PR 4): REQUEST_ACCESS from
// a page, the popup's ACCESS_REQUESTS read and answer, and the badge's count of what is asking.
//
// The worker runs in the real bundle (node:vm, mocked chrome). The rules themselves are site-requests.test.mjs's; this is
// the wiring: who may ask, what the worker reads from the sender instead of the page, and what an answer edits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");

const T = { timeout: 30000 };
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const plain = (x) => JSON.parse(JSON.stringify(x ?? null));
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off" };
const A = "https://a.example", C = "https://c.example";
const page = (tab, origin, o = {}) => ({ tab: { id: tab, url: `${origin}/p` }, url: `${origin}/p`, origin, frameId: 0, documentId: `doc-${tab}`, ...o });
const EXT = { url: "chrome-extension://test/popup.html" };

/** A worker where site A (tab 7) may use window.ml but not start agents, and site C (tab 9) may not use it. */
function world() {
    const bg = loadBackground({
        config, siteGate: true, siteAgents: null,
        openTabs: [{ id: 7, url: `${A}/p`, title: "A" }, { id: 9, url: `${C}/p`, title: "C" }],
        local: { ml_site_schema: 2, ml_site_always: [A] },
        onFetch: () => jsonResponse({}),
    });
    const ask = (payload, sender = page(7, A), gesture = true) => bg.send({ type: "REQUEST_ACCESS", payload, gesture }, sender);
    const waiting = async () => plain((await bg.send({ type: "ACCESS_REQUESTS", payload: {} }, EXT)).data.requests);
    const levels = async (origin) => plain((await bg.send({ type: "SITE_ACCESS", payload: { origin } }, EXT)).data.levels);
    return { bg, ask, waiting, levels };
}

// --- who may ask ---

test("an allowed site asking for agents with a gesture waits for the person; the popup lists it as allowed, and the badge names it", T, async () => {
    const w = world();
    const r = await w.ask({ agents: true, reason: "to run my checks" });
    assert.deepEqual(plain(r.data), { state: "granted", agents: "pending" }, "it may use window.ml; its agents wait");
    const list = await w.waiting();
    assert.equal(list.length, 1);
    assert.equal(list[0].origin, A, "the origin is the sender's, never the page's word");
    assert.equal(list[0].kind, "access");
    assert.equal(list[0].agents, true);
    assert.equal(list[0].allowed, true);
    assert.equal(list[0].reason, "to run my checks");
    await flush();
    assert.deepEqual(w.bg.badges.shown(9), { text: "1", title: "window.ml: a.example is asking for access" }, "on every tab, not only the asker's");
});

test("no gesture, a subframe, or a site that may not use window.ml: refused, and nothing waits", T, async () => {
    const w = world();
    assert.deepEqual(plain((await w.ask({ agents: true }, page(7, A), false)).data), { state: "refused", reason: "needs a user gesture" });
    const sub = await w.ask({ agents: true }, page(7, A, { frameId: 3 }));
    assert.ok(sub?.data == null || sub.data.state === "refused", `a subframe was answered ${JSON.stringify(sub)}`);
    const c = await w.ask({ agents: true }, page(9, C));
    assert.notEqual(c?.data?.state, "pending", "the origin gate answers an unapproved site, never the request store");
    assert.deepEqual(await w.waiting(), []);
    await flush();
    assert.equal(w.bg.badges.shown(7).text ?? "", "");
});

test("a gesture fact the page puts in its payload counts for nothing: only the content script's own field is read", T, async () => {
    const w = world();
    const r = await w.ask({ agents: true, gesture: true }, page(7, A), false);
    assert.deepEqual(plain(r.data), { state: "refused", reason: "needs a user gesture" });
});

// --- ACCESS_REQUESTS: the popup's read and the person's answer ---

test("Let it start agents sets the site's agent level to ask; the request is answered, and asking again is granted", T, async () => {
    const w = world();
    await w.ask({ agents: true });
    const after = await w.bg.send({ type: "ACCESS_REQUESTS", payload: { origin: A, decision: { kind: "access", answer: "agents" } } }, EXT);
    assert.deepEqual(plain(after.data.requests), []);
    assert.equal((await w.levels(A)).agents, "ask");
    const again = await w.ask({ agents: true });
    assert.deepEqual(plain(again.data), { state: "granted", agents: "granted" });
    await flush();
    assert.equal(w.bg.badges.shown(7).text ?? "", "", "nothing waits");
});

test("Deny on an allowed site's agents request denies its agents, and it may still use window.ml", T, async () => {
    const w = world();
    await w.ask({ agents: true });
    await w.bg.send({ type: "ACCESS_REQUESTS", payload: { origin: A, decision: { kind: "access", answer: "deny" } } }, EXT);
    const l = await w.levels(A);
    assert.equal(l.agents, "denied");
    assert.equal(l.use, "always");
});

test("a self-approval request, allowed on the confirmation, puts the site on the self-approval list", T, async () => {
    const w = world();
    assert.deepEqual(plain((await w.ask({ level: "self-approve" })).data), { state: "pending" });
    assert.equal((await w.waiting())[0].kind, "selfApprove");
    await w.bg.send({ type: "ACCESS_REQUESTS", payload: { origin: A, decision: { kind: "selfApprove", answer: "allow" } } }, EXT);
    assert.equal((await w.levels(A)).selfApprove, true);
});

test("ACCESS_REQUESTS is no page's to send: a page can neither read what is waiting nor answer for the person", T, async () => {
    const w = world();
    await w.ask({ agents: true });
    for (const sender of [page(7, A), page(9, C)]) {
        const read = await w.bg.send({ type: "ACCESS_REQUESTS", payload: {} }, sender);
        assert.equal(read?.data, undefined, `${sender.origin} read the waiting list`);
        const answer = await w.bg.send({ type: "ACCESS_REQUESTS", payload: { origin: A, decision: { kind: "access", answer: "agents" } } }, sender);
        assert.equal(answer?.data, undefined, `${sender.origin} answered`);
    }
    assert.equal((await w.levels(A)).agents, "off");
    assert.equal((await w.waiting()).length, 1);
});

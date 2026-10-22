// policy-ask-worker.test.mjs — an `ask` policy on a worker-hosted run's fetch_url, through the BUILT worker in node:vm
// (docs/spec/POLICIES.md, "A policy may also answer ask"; rebuild first, `npm run build:all`). What the unit tests of
// `judgeCall` and the loop cannot show: the card names the policy, offers nothing to remember, the person's approval of
// one call does not become a free pass for the next, an `ask` never runs a call the person declined, and a hostile page
// is still refused before any policy is read. Code under test: src/sw/sw-run-host.ts (`fetchPolicy`, `askWhy`,
// `approve`), src/agent/agent-host.ts (`autoApprove`), src/sw/sw-policies.ts, src/background.ts (the origin gate).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");

const T = { timeout: 30000 };
const BUILDER = "https://builder.example/start";
const BUILDER_ORIGIN = "https://builder.example";
const OTHER = "https://other.example/private";
const EXT_PAGE = { url: "chrome-extension://test/sidebar.html" };
const BODY = "<h1>OTHER SITE</h1>";
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off", autoApproveReadonly: true };
const plain = (x) => JSON.parse(JSON.stringify(x ?? null));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

/**
 * A browser on tab 7 whose model answers `calls` in turn, then "done". Every approval card is recorded in `cards` and passed
 * to `onCard(event, ctx)` (not awaited); the default refuses it.
 */
function browser({ calls, onCard = (e, ctx) => ctx.answer(e, false), local = {}, cfg = {} }) {
    const bodies = [], cards = [];
    const tab = { id: 7, windowId: 3, active: true, url: BUILDER, title: "Tab" };
    let bg;
    const ctx = { answer: (e, decision) => bg.send({ type: "SET_APPROVAL", payload: { runId: e.id, seq: e.seq, decision } }, EXT_PAGE), get bg() { return bg; } };
    bg = loadBackground({
        config: { ...config, ...cfg }, openTabs: [tab], siteGate: true, local: { ml_site_always: [BUILDER_ORIGIN], ...local },
        onFetch: (call) => {
            if (call.url.startsWith("https://other.example/"))
                return { ok: true, status: 200, url: call.url, headers: { get: (h) => (/content-type/i.test(h) ? "text/html; charset=utf-8" : null) }, text: async () => BODY, arrayBuffer: async () => new TextEncoder().encode(BODY).buffer, body: null };
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            bodies.push(plain(call.body));
            const next = calls[bodies.length - 1];
            if (!next) return jsonResponse({ choices: [{ message: { content: "done" } }] });
            return jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: `c${bodies.length}`, type: "function", function: { name: next.name, arguments: JSON.stringify(next.args) } }] }, finish_reason: "tool_calls" }] });
        },
        onTabMessage: async (_t, msg) => {
            if (msg.type === "ADOPT_RUN_NOW") return { pageInfo: "" };
            if (msg.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) { const e = plain(msg.event); cards.push(e); void Promise.resolve().then(() => onCard(e, ctx)); }
            if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
            const p = plain(msg.payload);
            if (p.finish || p.renderOnly || p.precheck || p.readonlyTry) return { result: "" };
            return { result: `the page ran ${p.name}` };
        },
    });
    const results = () => (bodies.at(-1)?.messages ?? []).filter((m) => m.role === "tool").map((m) => String(m.content));
    const fetched = () => bg.calls.filter((c) => c.url.startsWith("https://other.example/")).length;
    return { get bg() { return bg; }, bodies, cards, ctx, results, fetched };
}
async function untilCalls(b, n, cap = 1500) { for (let i = 0; i < cap && b.bodies.length < n; i++) await sleep(2); await flush(30); }
// The worker reads the saved policies once at load, and that read REPLACES the global list: a policy added before it lands is
// lost (a real worker adds one minutes in), so the test waits for the read first.
const settled = new WeakSet();
const policies = async (bg, payload) => {
    if (!settled.has(bg)) { settled.add(bg); await flush(40); }
    return plain(await bg.send({ type: "POLICIES", payload }, EXT_PAGE)).data;
};
const addAsk = (bg, label = "Ask about other.example") => policies(bg, { op: "add", effect: "ask", source: '(c) => c.host === "other.example"', label });
const addAllow = (bg, label = "Read other.example") => policies(bg, { op: "add", effect: "allow", source: '(c) => c.host === "other.example" && !c.credentials', label });

// --- the card says why, and offers nothing to remember ---

test("an ask policy raises the card for a fetch an allow policy would have run; the card names the policy and carries no remember grant", T, async () => {
    const b = browser({ calls: [{ name: "fetch_url", args: { url: OTHER } }], onCard: () => {} });
    await addAllow(b.bg);
    await addAsk(b.bg, "Ask about other.example");
    await b.bg.context.__mlStartUserRunForTest(7, { task: "read the other site", surface: "hud" });
    await untilCalls(b, 1);
    for (let i = 0; i < 200 && !b.cards.length; i++) await sleep(2);
    assert.equal(b.cards.length, 1, "the allow did not run it: the ask put it to the person");
    assert.equal(b.cards[0].awaitingApproval, true);
    assert.equal(b.cards[0].askWhy?.cause, "ask-policy");
    assert.equal(b.cards[0].askWhy.policy, "Ask about other.example");
    assert.match(b.cards[0].askWhy.line, /Ask about other\.example/);
    assert.equal(b.cards[0].grants, undefined, "nothing to remember: a remembered allow would be overridden by the ask");
    assert.equal(b.fetched(), 0, "nothing ran before the person answered");
});

test("the control: with the allow alone the same fetch runs with no card, which is what the ask overrode", T, async () => {
    const b = browser({ calls: [{ name: "fetch_url", args: { url: OTHER } }] });
    await addAllow(b.bg);
    await b.bg.context.__mlStartUserRunForTest(7, { task: "read the other site", surface: "hud" });
    await untilCalls(b, 2);
    assert.equal(b.cards.length, 0);
    assert.equal(b.fetched(), 1);
});

test("the model reads which policy asked, in the result of an approved call", T, async () => {
    const b = browser({ calls: [{ name: "fetch_url", args: { url: OTHER } }], onCard: (e, ctx) => ctx.answer(e, true) });
    await addAsk(b.bg, "Ask about other.example");
    await b.bg.context.__mlStartUserRunForTest(7, { task: "read the other site", surface: "hud" });
    await untilCalls(b, 2);
    assert.equal(b.fetched(), 1, "approved once: it ran");
    assert.match(b.results().join("\n"), /the policy "Ask about other\.example" asks the person about calls like it/);
});

// --- an exec's "Keep" would remember an allow the ask overrides ---

const EXEC = { name: "exec", args: { js: 'return await ml.fetch("https://other.example/a")' } };

test("an exec card offers to remember its fetch URLs, except those an ask policy matches; the card names the policy", T, async () => {
    const plainRun = browser({ calls: [EXEC], cfg: { autoApproveReadonly: false }, onCard: () => {} });
    await plainRun.bg.context.__mlStartUserRunForTest(7, { task: "fetch it", surface: "hud" });
    for (let i = 0; i < 200 && !plainRun.cards.length; i++) await sleep(2);
    assert.deepEqual(plainRun.cards[0]?.grants, [{ kind: "fetch-url", urls: ["https://other.example/a"] }], "the control: Keep is offered with no ask");
    assert.equal(plainRun.cards[0].askWhy, undefined);

    const b = browser({ calls: [EXEC], cfg: { autoApproveReadonly: false }, onCard: () => {} });
    await addAsk(b.bg, "Ask about other.example");
    await b.bg.context.__mlStartUserRunForTest(7, { task: "fetch it", surface: "hud" });
    for (let i = 0; i < 200 && !b.cards.length; i++) await sleep(2);
    assert.equal(b.cards.length, 1);
    assert.equal(b.cards[0].grants, undefined, "nothing to keep: an ask would override the allow Keep makes");
    assert.equal(b.cards[0].askWhy?.cause, "ask-policy");
    assert.equal(b.cards[0].askWhy.policy, "Ask about other.example");
});

test("an exec approved with persist remembers no URL an ask matches, and still approves once", T, async () => {
    const b = browser({ calls: [EXEC], cfg: { autoApproveReadonly: false }, onCard: (e, ctx) => ctx.answer(e, { approved: true, persist: true }) });
    await addAsk(b.bg);
    await b.bg.context.__mlStartUserRunForTest(7, { task: "fetch it", surface: "hud" });
    await untilCalls(b, 2);
    assert.equal(b.cards.length, 1);
    assert.equal((await policies(b.bg, {})).runs.length, 0, "no allow policy was made");
    assert.match(b.results().join("\n"), /the page ran exec/, "approved once: the exec ran");
});

// --- approving once does not become a free pass, and a refusal is final ---

test("an ask beats a remembered approval: the person approves a URL, and the next fetch of the same URL asks again", T, async () => {
    const b = browser({ calls: [{ name: "fetch_url", args: { url: OTHER } }, { name: "fetch_url", args: { url: OTHER } }], onCard: (e, ctx) => ctx.answer(e, { approved: true, persist: true }) });
    await addAsk(b.bg);
    await b.bg.context.__mlStartUserRunForTest(7, { task: "read the other site twice", surface: "hud" });
    await untilCalls(b, 3);
    assert.equal(b.cards.length, 2, "both calls went to the person");
    assert.equal((await policies(b.bg, {})).runs.length, 0, "persist on an ask's card added no allow policy");
});

test("the same two fetches with no ask: the first approval is remembered and the second runs without a card (the tier the ask overrides)", T, async () => {
    const b = browser({ calls: [{ name: "fetch_url", args: { url: OTHER } }, { name: "fetch_url", args: { url: OTHER } }], onCard: (e, ctx) => ctx.answer(e, true) });
    await b.bg.context.__mlStartUserRunForTest(7, { task: "read the other site twice", surface: "hud" });
    await untilCalls(b, 3);
    assert.equal(b.cards.length, 1);
});

test("an ask added AFTER a URL was approved still asks the next time (a policy saved mid-run takes effect at once)", T, async () => {
    let first = true;
    const b = browser({ calls: [{ name: "fetch_url", args: { url: OTHER } }, { name: "fetch_url", args: { url: OTHER } }],
        onCard: async (e, ctx) => { if (first) { first = false; await addAsk(ctx.bg); } ctx.answer(e, true); } });
    await b.bg.context.__mlStartUserRunForTest(7, { task: "read the other site twice", surface: "hud" });
    await untilCalls(b, 3);
    assert.equal(b.cards.length, 2, "the first approval minted a consent; the ask outranks it");
});

test("an ask never runs a call the person declines: nothing is fetched and the model is told", T, async () => {
    const b = browser({ calls: [{ name: "fetch_url", args: { url: OTHER } }], onCard: (e, ctx) => ctx.answer(e, false) });
    await addAsk(b.bg);
    await addAllow(b.bg);
    await b.bg.context.__mlStartUserRunForTest(7, { task: "read the other site", surface: "hud" });
    await untilCalls(b, 2);
    assert.equal(b.cards.length, 1);
    assert.equal(b.fetched(), 0);
    assert.match(b.results().join("\n"), /Denied by the user/);
});

test("a deny and an ask that both match: the fetch is refused with no card", T, async () => {
    const b = browser({ calls: [{ name: "fetch_url", args: { url: OTHER } }] });
    await addAsk(b.bg);
    await policies(b.bg, { op: "add", effect: "deny", source: '(c) => c.host === "other.example"', label: "never other.example" });
    await b.bg.context.__mlStartUserRunForTest(7, { task: "read the other site", surface: "hud" });
    await untilCalls(b, 2);
    assert.equal(b.cards.length, 0);
    assert.equal(b.fetched(), 0);
    assert.match(b.results().join("\n"), /Refused by the policy "never other\.example"/);
});

// --- the policy page and the store ---

test("the policy page adds an ask, lists it, edits it into an allow and back, and refuses an effect that is none of the three", T, async () => {
    const b = browser({ calls: [] });
    const v = await addAsk(b.bg, "listed");
    const id = v.global.at(-1).id;
    assert.equal(v.global.at(-1).effect, "ask");
    assert.equal((await policies(b.bg, { op: "edit", id, effect: "allow" })).global.at(-1).effect, "allow");
    assert.equal((await policies(b.bg, { op: "edit", id, effect: "ask" })).global.at(-1).effect, "ask");
    const bad = plain(await b.bg.send({ type: "POLICIES", payload: { op: "add", effect: "prompt", source: "(c) => true", label: "x" } }, EXT_PAGE));
    assert.match(bad.error, /allow, deny or ask/);
});

// --- an ask never lifts the refused tier ---

test("a page's FETCH_URL from an unapproved origin is refused before any policy runs, with an ask policy stored; a page cannot add the ask either", T, async () => {
    const b = browser({ calls: [] });
    await addAsk(b.bg);
    const evil = { tab: { id: 9, url: "https://evil.example/" }, url: "https://evil.example/", origin: "https://evil.example", frameId: 0, documentId: "d" };
    const before = b.bg.calls.length;
    const res = plain(await b.bg.send({ type: "FETCH_URL", payload: { url: OTHER } }, evil));
    assert.match(res?.error || "", /Refused: https:\/\/evil\.example is not approved/);
    assert.equal(b.bg.calls.length, before, "no request left the worker");
    const add = plain(await b.bg.send({ type: "POLICIES", payload: { op: "add", effect: "ask", source: "(c) => true", label: "x" } }, evil));
    assert.match(add?.error || "", /Refused|refused/);
    assert.equal((await policies(b.bg, {})).global.length, 1, "the page's add changed nothing");
});

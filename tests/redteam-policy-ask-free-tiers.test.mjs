// redteam-policy-ask-free-tiers.test.mjs — an `ask` policy must put a page-side fetch to the person even where a
// free tier would have run it (POLICIES.md, "A policy may also answer ask"; the claim of #999). Recheck 2026-10-23.
//
// The worker-hosted loop's `autoApprove` (agent-host.ts) consults `fetchPolicy` before every free tier, so it holds
// there. The PAGE's own `ml.fetch` (`FETCH_URL`) and the page-hosted loop's `autoApprove` (ml-agent-run.ts) consult
// no policy at all: same-origin, self-source and the current page run past an `ask` with no card. These tests assert
// the defended outcome and fail until both layers judge the person's policies. Rebuild first (`npm run build:all`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground, loadPageWorld } = require("./helpers");

const T = { timeout: 30000 };
const EXT_PAGE = { url: "chrome-extension://test/sidebar.html" };
const HERE = "https://site.example/inbox?id=3";
const SAME = "https://site.example/other";
const SELF = "https://raw.githubusercontent.com/parawanderer/window-ml/main/src/util.ts";
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off", autoApproveReadonly: true, autoApproveSelfSource: true };
const plain = (x) => JSON.parse(JSON.stringify(x ?? null));
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

const settled = new WeakSet();
const policies = async (bg, payload) => {
    if (!settled.has(bg)) { settled.add(bg); await flush(40); }
    return plain(await bg.send({ type: "POLICIES", payload }, EXT_PAGE)).data;
};
const addAsk = (bg, label = "Ask about site.example") => policies(bg, { op: "add", effect: "ask", source: '(c) => c.host === "site.example" || c.url.includes("window-ml")', label });

/** A background whose fetch of site.example / the repo answers. */
function bgWith() {
    const urls = [];
    const bg = loadBackground({
        config,
        onFetch: (call) => {
            if (call.url.includes("/chat/completions")) return jsonResponse({ choices: [{ message: { content: "done" } }] });
            urls.push(call.url);
            return { ok: true, status: 200, url: call.url, headers: { get: (h) => (/content-type/i.test(h) ? "text/plain; charset=utf-8" : null) }, text: async () => "body", arrayBuffer: async () => new TextEncoder().encode("body").buffer, body: null };
        },
    });
    return { bg, urls };
}

// --- the page's own ml.fetch (FETCH_URL): a free tier must not answer an ask ---

test("FETCH_URL: a same-origin read an ask policy matches is not free — the person is asked, and the request is not sent", { todo: "FETCH_URL judges no policy: same-origin / self-source / current-page run past an ask (sw-fetch-url.ts)" }, T, async () => {
    const { bg, urls } = bgWith();
    await addAsk(bg);
    const sender = { tab: { id: 9, url: HERE }, url: HERE };
    const r = await bg.send({ type: "FETCH_URL", payload: { url: SAME } }, sender);
    assert.ok(r.error, `the ask matched and no person approved: the fetch must not run freely (${JSON.stringify(r).slice(0, 200)})`);
    assert.deepEqual(urls, [], "the request was never sent");
});

test("FETCH_URL: a self-source read an ask policy matches is not free — the person is asked, and the request is not sent", { todo: "FETCH_URL judges no policy: a self-source read runs past an ask (sw-fetch-url.ts)" }, T, async () => {
    const { bg, urls } = bgWith();
    await addAsk(bg);
    const untrusted = { tab: { id: 9, url: "https://evil.example/" }, url: "https://evil.example/" };
    const r = await bg.send({ type: "FETCH_URL", payload: { url: SELF } }, untrusted);
    assert.ok(r.error, `the ask matched and no person approved: the fetch must not run freely (${JSON.stringify(r).slice(0, 200)})`);
    assert.deepEqual(urls, [], "the request was never sent");
});

test("the controls: with no ask the same two reads are free, which is what the ask withholds", T, async () => {
    const { bg, urls } = bgWith();
    const same = await bg.send({ type: "FETCH_URL", payload: { url: SAME } }, { tab: { id: 9, url: HERE }, url: HERE });
    assert.ok(!same.error, `same-origin is free with no ask: ${same.error}`);
    const self = await bg.send({ type: "FETCH_URL", payload: { url: SELF } }, { tab: { id: 9, url: "https://evil.example/" }, url: "https://evil.example/" });
    assert.ok(!self.error, `self-source is free with no ask: ${self.error}`);
    assert.deepEqual(urls, [SAME, SELF], "both requests ran — the free tier the ask overrides");
});

// --- the page-hosted loop (window.ml.agent): its free tiers must not answer an ask ---

test("a page-hosted run's fetch_url of a same-origin URL an ask policy matches hits the gate", { todo: "the page loop's autoApprove has no fetchPolicy dep: current page / same origin / self-source run past an ask (ml-agent-run.ts)" }, T, async () => {
    // The defended outcome: before freeing a tier the loop consults the person's policies; an `ask` means the
    // call reaches `approve`. Today the loop frees same-origin outright, so this fails with gates === 0.
    let gates = 0;
    const world = loadPageWorld({
        config: { autoApproveSelfSource: true },
        onRuntimeMessage: (m) => {
            if (m.type === "FETCH_URL") return { data: { url: m.payload.url, ok: true, status: 200, type: "text", text: "body" } };
            if (m.type === "FETCH_LLM") return { data: { choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "fetch_url", arguments: JSON.stringify({ url: SAME }) } }] }, finish_reason: "tool_calls" }] } };
            return undefined;
        },
    });
    await world.ml.agent("read the other page", {
        tools: [world.ml.fetchTool()],
        approve: () => { gates++; return true; },
    });
    assert.equal(gates, 1, "the ask put the same-origin fetch to the person");
});

// redteam-policy-ask-free-tiers.test.mjs — where an `ask` policy reaches on the page's side, and where it cannot
// (POLICIES.md, "A policy may also answer ask"; docs/dev/policies.md, "What an ask cannot reach"). Red-team recheck of
// #999, 2026-10-23: the worker-hosted loop's `autoApprove` (agent-host.ts) consults `fetchPolicy` before every free tier.
// The PAGE's own `ml.fetch` (`FETCH_URL`) and the page-hosted loop (ml-agent-run.ts) do not, and these tests pin why:
// a same-origin, current-page or self-source read is one the page can make itself with a plain fetch(), and the
// page-hosted loop's `approve` is a callback the page supplies, so no card there binds the page. What an `ask` DOES
// withdraw on the page's side, a consent the tab remembers from an earlier approval, is in policy-ask-worker.test.mjs.
// Rebuild first (`npm run build:all`).
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

// --- the page's own ml.fetch (FETCH_URL): what the page can read itself stays free ---

test("FETCH_URL: a same-origin read stays free under an ask that matches it: the page could fetch its own origin itself", T, async () => {
    const { bg, urls } = bgWith();
    await addAsk(bg);
    const sender = { tab: { id: 9, url: HERE }, url: HERE };
    const r = await bg.send({ type: "FETCH_URL", payload: { url: SAME } }, sender);
    assert.ok(!r.error, `a read the page can make itself is not withheld: ${r.error}`);
    assert.deepEqual(urls, [SAME]);
});

test("FETCH_URL: an uncredentialed self-source read stays free under an ask that matches it: a public repo the page can read itself", T, async () => {
    const { bg, urls } = bgWith();
    await addAsk(bg);
    const untrusted = { tab: { id: 9, url: "https://evil.example/" }, url: "https://evil.example/" };
    const r = await bg.send({ type: "FETCH_URL", payload: { url: SELF } }, untrusted);
    assert.ok(!r.error, `a read the page can make itself is not withheld: ${r.error}`);
    assert.deepEqual(urls, [SELF]);
});

test("the controls: with no ask the same two reads are free, which is what the ask withholds", T, async () => {
    const { bg, urls } = bgWith();
    const same = await bg.send({ type: "FETCH_URL", payload: { url: SAME } }, { tab: { id: 9, url: HERE }, url: HERE });
    assert.ok(!same.error, `same-origin is free with no ask: ${same.error}`);
    const self = await bg.send({ type: "FETCH_URL", payload: { url: SELF } }, { tab: { id: 9, url: "https://evil.example/" }, url: "https://evil.example/" });
    assert.ok(!self.error, `self-source is free with no ask: ${self.error}`);
    assert.deepEqual(urls, [SAME, SELF], "both requests ran — the free tier the ask overrides");
});

// --- the page-hosted loop (window.ml.agent): the page answers its own cards ---

test("a page-hosted run frees a same-origin fetch_url without calling its approve: the page supplies that callback, so a card would not bind it", T, async () => {
    // The loop runs in the page's world and `approve` is the page's own function: an `ask` routed there is answered by
    // the page. What the fetch reaches is decided at FETCH_URL, above.
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
    assert.equal(gates, 0, "the same-origin tier answered; the page's approve was never consulted");
});

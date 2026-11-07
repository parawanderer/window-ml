// redteam-embed-filter.test.mjs — what a PAGE must not get from `ml.embed` (src/background.ts's EMBED branch,
// src/sw/sw-llm.ts `embedTexts`): a model the person's `modelFilter` excludes, reached by NOT asking for one; and an
// embedding model the page leaves PINNED on the person's box.
//
// Both are one call from a page today. `ml.embed` is a page-started type (HANDLE_MAP), and a read-only survey runs a
// page's text through this same branch, so the survey's `ml.embed` (src/readonly-exec, #1336) is the same shape: no
// `model`, which the branch resolves to `cfg.embeddingModel` and then never passes through the filter. Measured here
// on the page path because that branch is what both reach; the survey-shaped row lands with #1336's surface.
//
// Each hole row has a control beside it that lets the same call through, so a fixture refusing every embed fails
// rather than passing. Both land as `{ todo }` while the hole is open: each fails on main at the assertion it carries
// (measured: a request left for `embedbox.example/ollama/api/embed` with `modelFilter: "^qwen"`, and the body carried
// `keep_alive: -1`), and each is flipped plain by the commit that turns it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonResponse, loadBackground } from "./helpers.js";

const HOST = "http://embedbox.example";
const KEY = "sk-redteam-embed-0123456789";
/** The config a person has: a filter that names the chat models they use, an embedding model they pulled earlier. */
const config = (o = {}) => ({
    chatUrl: `${HOST}/api/chat/completions`, apiKey: KEY, model: "qwen3:14b", apiFormat: "openai",
    ocrModel: "", embeddingModel: "embeddinggemma:300m", ...o,
});
/** A page's sender: the browser stamps the tab, the URL and the origin; the page supplies none of it. */
const PAGE = { tab: { id: 4 }, url: "https://site.example/p", origin: "https://site.example", frameId: 0 };
/** Every request the worker made, as its URL and body. */
function calls() {
    const made = [];
    return { made, onFetch: (c) => { made.push({ url: c.url, body: c.body }); return /\/api\/embed$/.test(c.url) ? jsonResponse({ embeddings: [[1, 0]] }) : jsonResponse({}, 404); } };
}

// --- the filter decides which models a page may reach, whatever the page asks ---

test("RED TEAM: a page's embed with no model cannot reach an embedding model the filter excludes", { todo: "open: the EMBED branch filters only an ASKED model (background.ts:1148), so the configured one is unfiltered" }, async () => {
    const c = calls();
    const r = await loadBackground({ config: config({ modelFilter: "^qwen" }), onFetch: c.onFetch })
        .send({ type: "EMBED", payload: { inputs: ["page text the filter's owner never sent to this model"] } }, PAGE);
    assert.equal(c.made.length, 0, `a request left the worker for an excluded model: ${JSON.stringify(c.made.map((x) => x.url))}`);
    assert.ok(r.error, `the page was answered instead of refused: ${JSON.stringify(r)}`);
    assert.match(r.error, /filter/i, `the refusal does not say the filter is why: ${r.error}`);
    assert.ok(!r.error.includes(HOST) && !r.error.includes(KEY), `the refusal names the server or the key: ${r.error}`);
});

test("CONTROL: the same call goes through when the filter allows the configured embedding model", async () => {
    const c = calls();
    const r = await loadBackground({ config: config({ modelFilter: "^qwen|^embeddinggemma" }), onFetch: c.onFetch })
        .send({ type: "EMBED", payload: { inputs: ["a"] } }, PAGE);
    assert.equal(c.made.length, 1, "the allowed embedding model was not asked");
    assert.equal(r.data?.model, "embeddinggemma:300m", "the answer does not say which geometry it is in");
    assert.deepEqual(r.data?.vectors, [[1, 0]]);
});

test("CONTROL: no filter at all still embeds (the hole's row is the filter, not the call)", async () => {
    const c = calls();
    const r = await loadBackground({ config: config(), onFetch: c.onFetch }).send({ type: "EMBED", payload: { inputs: ["a"] } }, PAGE);
    assert.equal(c.made.length, 1, "an unfiltered embed was refused");
    assert.equal(r.data?.model, "embeddinggemma:300m");
});

// --- a page's call does not pin the person's box ---

test("RED TEAM: a page's embed does not leave the embedding model pinned on the box", { todo: "open: embedTexts sends keep_alive -1 on every request a page makes" }, async () => {
    // keep_alive -1 is Ollama's "keep it forever": the model stays resident (expires_at in the year 2318, measured).
    // The person's own Settings may ask for that; a page must not, since it can then hold the box's memory forever
    // from one line of script.
    const c = calls();
    const r = await loadBackground({ config: config(), onFetch: c.onFetch }).send({ type: "EMBED", payload: { inputs: ["a"] } }, PAGE);
    assert.equal(c.made.length, 1, "the embed did not run at all, so this row checks nothing");
    assert.ok(r.data?.vectors?.length, "the call did not answer with vectors");
    const body = c.made[0].body ?? {};
    assert.notEqual(body.keep_alive, -1, `a page's call pinned the embedding model with no expiry: ${JSON.stringify(body)}`);
    assert.notEqual(String(body.keep_alive), "-1", `a page's call pinned the embedding model with no expiry: ${JSON.stringify(body)}`);
});

test("CONTROL: the page's embed is still a real request, with its placement fields intact", async () => {
    const c = calls();
    await loadBackground({ config: config(), onFetch: c.onFetch }).send({ type: "EMBED", payload: { inputs: ["a", "b"] } }, PAGE);
    const body = c.made[0]?.body ?? {};
    assert.equal(body.model, "embeddinggemma:300m", "the resolved model is not on the request");
    assert.deepEqual(body.input, ["a", "b"], "the inputs are not the page's text");
});

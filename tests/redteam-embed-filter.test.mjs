// redteam-embed-filter.test.mjs — what a PAGE must not get from `ml.embed` (src/background.ts's EMBED branch,
// src/sw/sw-llm.ts `embedTexts`): a model the person's `modelFilter` excludes, reached by NOT asking for one.
//
// `ml.embed` is a page-started type (HANDLE_MAP), and a read-only survey runs a page's text through this same branch,
// so the survey's `ml.embed` (src/readonly-exec, #1336) is the same shape: no `model`, which the branch resolves to
// `cfg.embeddingModel` and then never passes through the filter. The invariant is about the RESOLVED model, not about
// who asked (`AGENTS.md`, "modelFilter … is enforced on the RESOLVED model"), so the hole rows enumerate the sender
// shapes rather than sampling one: a page's call and a worker-built run's call with no sender both have to be refused,
// and a fix that gates on `sender.tab` passes the first and fails the second. Measured here on the page path because
// that branch is what both reach; the survey-shaped row lands with #1336's surface.
//
// The keep_alive pin is NOT a hole: it is `embeddingKeepAlive`, a documented Setting on by default for a model placed
// on the CPU, and a page's `ml.chat` keeps the chat model resident with no rule against it. The controls below hold it
// from both sides (on sends -1, off sends no keep_alive at all) and hold the boundary that IS a rule: a page cannot
// choose the pin, the placement or the model on the wire — its payload fields are dropped and config decides.
//
// The two hole rows were `{ todo }` while the hole was open and are flipped plain by the commit that turns them
// (de5a412b): on main each failed at the assertion it carries (a request left for `embedbox.example/ollama/api/embed`
// with `modelFilter: "^qwen"`); here they assert the defended outcome. Every refusal also asserts what the caller is
// TOLD: the resolved model and that the filter excluded it, never the filter's own regex (the scrub invariant).
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
/**
 * The one assertion every refusal shares: nothing left the worker, and the answer says the filter is why, scrubbed of
 * everything but the model — not the server, not the key, and not the filter's own regex (every literal piece of
 * `filter` is a piece of the person's setting, so none of it may reach the page). On a page's call `sw-scrub.ts` is
 * what replaces the filter with `[model filter]`, measured; the assertion is also what holds the caller with no sender
 * — a run's own call, which nothing scrubs — to the same wording.
 * @param c the fetch spy
 * @param r the worker's answer
 * @param filter the `modelFilter` the config carried
 */
function refused(c, r, filter) {
    assert.equal(c.made.length, 0, `a request left the worker for an excluded model: ${JSON.stringify(c.made.map((x) => x.url))}`);
    assert.ok(r.error, `the caller was answered instead of refused: ${JSON.stringify(r)}`);
    assert.match(r.error, /filter/i, `the refusal does not say the filter is why: ${r.error}`);
    assert.ok(!r.error.includes(HOST) && !r.error.includes(KEY), `the refusal names the server or the key: ${r.error}`);
    for (const piece of filter.match(/[A-Za-z0-9_.:-]{3,}/g) ?? []) {
        assert.ok(!r.error.includes(piece), `the refusal carries the filter's own ${JSON.stringify(piece)}: ${r.error}`);
    }
}

// --- the filter decides which models may be reached, whatever the caller asks ---

test("RED TEAM: a page's embed with no model cannot reach an embedding model the filter excludes", async () => {
    const c = calls();
    const r = await loadBackground({ config: config({ modelFilter: "^qwen" }), onFetch: c.onFetch })
        .send({ type: "EMBED", payload: { inputs: ["page text the filter's owner never sent to this model"] } }, PAGE);
    refused(c, r, "^qwen");
});

test("RED TEAM: a worker-built run's unasked embed is filtered too, so a gate on sender.tab is not the fix", async () => {
    // No sender at all is the shape a call the worker builds for itself has; the invariant is on the RESOLVED model,
    // so this must refuse exactly as the page's call does. A fix written as `if (sender.tab && …)` passes the row
    // above and fails this one.
    const c = calls();
    const r = await loadBackground({ config: config({ modelFilter: "^qwen" }), onFetch: c.onFetch })
        .send({ type: "EMBED", payload: { inputs: ["a run's own text"] } });
    refused(c, r, "^qwen");
});

test("RED TEAM: an ASKED model is filtered too, and the fix must keep that gate", async () => {
    const c = calls();
    const r = await loadBackground({ config: config({ modelFilter: "^qwen|^nomic" }), onFetch: c.onFetch })
        .send({ type: "EMBED", payload: { inputs: ["a"], model: "llama3:8b" } }, PAGE);
    refused(c, r, "^qwen|^nomic");
});

test("CONTROL: no embedding model configured keeps its own error, asked or not, and asks nothing", async () => {
    // The fix's boundary: with nothing to resolve, the filter has no say, and the person is told to set a model —
    // not that one was filtered. An ASKED model still needs no configured default.
    const c = calls();
    const r = await loadBackground({ config: config({ embeddingModel: "", modelFilter: "^qwen" }), onFetch: c.onFetch })
        .send({ type: "EMBED", payload: { inputs: ["a"] } }, PAGE);
    assert.equal(c.made.length, 0, "an embed went out with no model configured");
    assert.match(String(r.error), /No embedding model configured/, `the empty model's error changed: ${r.error}`);
    assert.doesNotMatch(String(r.error), /filter/i, `the empty model's error blames the filter: ${r.error}`);
    const asked = await loadBackground({ config: config({ embeddingModel: "" }), onFetch: c.onFetch })
        .send({ type: "EMBED", payload: { inputs: ["a"], model: "nomic-embed-text" } }, PAGE);
    assert.equal(c.made.length, 1, "an asked model was not sent for want of a configured default");
    assert.equal(asked.data?.model, "nomic-embed-text", "an asked model was refused for want of a configured default");
});

// --- the controls: the same call goes through when the filter allows it ---

test("CONTROL: the same call goes through when the filter allows the configured embedding model", async () => {
    const c = calls();
    const r = await loadBackground({ config: config({ modelFilter: "^qwen|^embeddinggemma" }), onFetch: c.onFetch })
        .send({ type: "EMBED", payload: { inputs: ["a"] } }, PAGE);
    assert.equal(c.made.length, 1, "the allowed embedding model was not asked");
    assert.equal(r.data?.model, "embeddinggemma:300m", "the answer does not say which geometry it is in");
    assert.deepEqual(r.data?.vectors, [[1, 0]]);
});

test("CONTROL: an ASKED model the filter allows is the one asked, and reported", async () => {
    const c = calls();
    const r = await loadBackground({ config: config({ modelFilter: "^qwen|^nomic" }), onFetch: c.onFetch })
        .send({ type: "EMBED", payload: { inputs: ["a"], model: "nomic-embed-text" } }, PAGE);
    assert.equal(c.made.length, 1, "an allowed asked model was refused");
    assert.equal(c.made[0].body.model, "nomic-embed-text");
    assert.equal(r.data?.model, "nomic-embed-text");
});

test("CONTROL: no filter at all still embeds (the hole's rows are the filter, not the call)", async () => {
    const c = calls();
    const r = await loadBackground({ config: config(), onFetch: c.onFetch }).send({ type: "EMBED", payload: { inputs: ["a"] } }, PAGE);
    assert.equal(c.made.length, 1, "an unfiltered embed was refused");
    assert.equal(r.data?.model, "embeddinggemma:300m");
});

// --- the pin is the person's setting; the boundary is that the page cannot choose it ---

test("CONTROL: `embeddingKeepAlive` is honoured both ways — on sends keep_alive -1, off sends no keep_alive", async () => {
    const on = calls();
    await loadBackground({ config: config(), onFetch: on.onFetch }).send({ type: "EMBED", payload: { inputs: ["a"] } }, PAGE);
    assert.equal(on.made[0]?.body?.keep_alive, -1, "the setting's default (on) did not pin: embeddingKeepAlive");
    const off = calls();
    await loadBackground({ config: config({ embeddingKeepAlive: false }), onFetch: off.onFetch }).send({ type: "EMBED", payload: { inputs: ["a"] } }, PAGE);
    assert.equal(Object.hasOwn(off.made[0]?.body ?? {}, "keep_alive"), false, `the setting off still sent keep_alive: embeddingKeepAlive ${JSON.stringify(off.made[0]?.body)}`);
});

test("CONTROL: a page cannot choose the pin, the placement or the model on the wire", async () => {
    // Every residency field the page puts in its payload is dropped: the wire body is config's model, the page's
    // inputs, and the setting's `keep_alive`/`options`. That is the boundary; whether the setting pins is not the page's.
    const c = calls();
    await loadBackground({ config: config(), onFetch: c.onFetch })
        .send({ type: "EMBED", payload: { inputs: ["a"], keep_alive: 0, options: { num_gpu: 9 }, model: "" } }, PAGE);
    const body = c.made[0]?.body ?? {};
    assert.equal(body.keep_alive, -1, `a page's own keep_alive reached the wire: ${JSON.stringify(body)}`);
    assert.equal(body.options?.num_gpu, 0, `a page's own options reached the wire: ${JSON.stringify(body)}`);
    assert.equal(body.model, "embeddinggemma:300m", "the page chose the model without asking for one through `model`");
});

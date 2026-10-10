// What a model call cost, worked out on read (tests/e2e/bench/cost.mjs) from a REAL price snapshot trimmed to five of
// the box's models: one per way a model is joined to a price, a local one, and one nothing prices.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { priceBook, callCost, priceCalls, spendByModel } from "../tests/e2e/bench/cost.mjs";

const SNAP = JSON.parse(readFileSync(new URL("./fixtures/bench/price-snapshot.json", import.meta.url)));
const asBytes = (o) => Buffer.from(JSON.stringify(o));
const book = priceBook(Object.fromEntries(Object.entries(SNAP).map(([k, v]) => [k, asBytes(v)])));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);

// --- joining a model to its price ---

test("each external model is joined through the box's list, by the id after its connection's prefix, to the first source that has it", () => {
    assert.deepEqual([book("litellm.google/gemini-pro-latest").basis, book("litellm.google/gemini-pro-latest").key], ["litellm_model_info", "google/gemini-pro-latest"]);
    assert.deepEqual([book("openrouter.z-ai/glm-5.3-flash").basis, book("openrouter.z-ai/glm-5.3-flash").key], ["openrouter", "z-ai/glm-5.3-flash"]);
    assert.deepEqual([book("deepseek.deepseek-flash").basis, book("deepseek.deepseek-flash").key], ["litellm_map", "deepseek-flash"]);
    // The map keys Moonshot's models under the provider, which is what the connection is named.
    assert.deepEqual([book("moonshot.kimi-k3").basis, book("moonshot.kimi-k3").key], ["litellm_map", "moonshot/kimi-k3"]);
});

test("a model made in Open WebUI is priced as the model it wraps, recursively; a local base is electricity; a loop prices nothing", () => {
    const p = book("ui.gemini-pro-latest", 1000);
    assert.deepEqual([p.basis, p.key, p.via], ["litellm_model_info", "google/gemini-pro-latest", ["ui.gemini-pro-latest"]]);
    assert.deepEqual(book("ui.gemma4-31b"), { local: true, via: ["ui.gemma4-31b"] });
    const wrap = (id, base) => ({ id, connection_type: "external", info: { base_model_id: base } });
    const chain = priceBook({ ...SNAP, owui_models: { data: [...SNAP.owui_models.data, wrap("ui.a", "ui.gemini-pro-latest"), wrap("ui.x", "ui.y"), wrap("ui.y", "ui.x")] } });
    assert.deepEqual(chain("ui.a").via, ["ui.a", "ui.gemini-pro-latest"]);
    assert.deepEqual(chain("ui.x"), { none: "ui.x wraps itself" });
});

test("a local model is electricity; a model nothing prices, or none at all, says why", () => {
    assert.deepEqual(book("glm-4.7-flash:latest"), { local: true });
    assert.deepEqual(book("moonshot.kimi-k2.7-code-highspeed"), { none: "no price for kimi-k2.7-code-highspeed" });
    assert.match(book(null).none, /did not say which model/);
    assert.deepEqual(priceBook({ openrouter: asBytes(SNAP.openrouter) })("x"), { none: "the snapshot has no model list" });
});

test("a source that is not JSON (a pricing page) is no source, not a failure", () => {
    const b = priceBook({ ...SNAP, deepseek_pricing_page: Buffer.from("<!doctype html><html>") });
    assert.equal(b("deepseek.deepseek-flash").basis, "litellm_map");
});

test("a 0 from LiteLLM is no price (it writes a missing one as 0); a 0 from OpenRouter is free", () => {
    const zero = { ...SNAP, litellm_map: { ...SNAP.litellm_map, "deepseek-flash": { ...SNAP.litellm_map["deepseek-flash"], output_cost_per_token: 0 } },
        openrouter: { data: [{ id: "z-ai/glm-5.3-flash", pricing: { prompt: "0", completion: "0" } }] } };
    const b = priceBook(zero);
    const ds = callCost({ promptTokens: 100, completionTokens: 10 }, "deepseek.deepseek-flash", b);
    assert.deepEqual([ds.computed, ds.unpriced], [null, ["output"]]);
    assert.equal(callCost({ promptTokens: 100, completionTokens: 10 }, "openrouter.z-ai/glm-5.3-flash", b).computed, 0);
    // A whole entry at 0 is no entry: the model is unpriced, not free.
    const allZero = priceBook({ ...SNAP, litellm_map: { "moonshot/kimi-k3": { input_cost_per_token: 0, output_cost_per_token: 0 } } });
    assert.deepEqual(allZero("moonshot.kimi-k3"), { none: "no price for kimi-k3" });
});

test("a prompt past a long-context threshold is priced at that tier", () => {
    assert.equal(book("litellm.google/gemini-pro-latest", 1000).rates.input, 0.000002);
    assert.equal(book("litellm.google/gemini-pro-latest", 250000).rates.input, 0.000004);
    assert.equal(book("litellm.google/gemini-pro-latest", 250000).rates.output, 0.000018);
});

// --- one call ---

test("computed prices uncached prompt, cache reads and output at their own rates", () => {
    const c = callCost({ promptTokens: 12050, cachedTokens: 1792, completionTokens: 59 }, "deepseek.deepseek-flash", book);
    near(c.computed, (12050 - 1792) * 3e-7 + 1792 * 6e-9 + 59 * 0.0000012);
    assert.equal(c.reported, null);
    assert.match(c.notes.join(), /off-peak/);
});

test("the provider's own figure is reported beside the computed one, never instead of it", () => {
    const c = callCost({ promptTokens: 1000, completionTokens: 10, raw: { cost: 0.5 } }, "openrouter.z-ai/glm-5.3-flash", book);
    assert.equal(c.reported, 0.5);
    near(c.computed, 1000 * 0.00000015 + 10 * 0.0000005);
});

test("a token class with no rate leaves computed null and names the class; never priced at 0", () => {
    // OpenRouter's entry has no cache-write rate; a provider that counted cache writes cannot be computed.
    const c = callCost({ promptTokens: 1000, completionTokens: 10, raw: { cache_creation_input_tokens: 400 } }, "openrouter.z-ai/glm-5.3-flash", book);
    assert.equal(c.computed, null);
    assert.deepEqual(c.unpriced, ["cache write"]);
    assert.match(c.why, /no rate for cache write/);
});

test("a call that names no snapshot is reported only; a local one is electricity", () => {
    const none = callCost({ promptTokens: 10, completionTokens: 1, raw: { cost: 0.01 } }, "deepseek.deepseek-flash", null);
    assert.deepEqual([none.reported, none.computed, none.why], [0.01, null, "no price snapshot recorded"]);
    const local = callCost({ promptTokens: 10, completionTokens: 1 }, "glm-4.7-flash:latest", book);
    assert.deepEqual([local.local, local.computed], [true, null]);
});

// --- many calls ---

test("calls are priced against their own snapshot and summed per run's model, with the unpriced counted and explained", () => {
    const sources = { owui_models: "h1", litellm_map: "h2", openrouter: "h3", litellm_model_info: "h4" };
    const bodies = { h1: asBytes(SNAP.owui_models), h2: asBytes(SNAP.litellm_map), h3: asBytes(SNAP.openrouter), h4: asBytes(SNAP.litellm_model_info) };
    const calls = [
        { run: "r1", call: 0, model: "deepseek.deepseek-flash", usage: { promptTokens: 1000, completionTokens: 10, prices: { sources } } },
        { run: "r1", call: 1, model: "deepseek.deepseek-flash", usage: { promptTokens: 2000, completionTokens: 20, prices: { sources } } },
        { run: "r2", call: 0, model: "moonshot.kimi-k2.7-code-highspeed", usage: { promptTokens: 10, completionTokens: 1, prices: { sources } } },
        { run: "r3", call: 0, model: "deepseek.deepseek-flash", usage: { promptTokens: 10, completionTokens: 1 } },
    ];
    const seen = [];
    const priced = priceCalls(calls, (h) => (seen.push(h), bodies[h] ?? null));
    assert.equal(seen.length, 4, "one book for the one snapshot set");
    const byRun = { r1: "deepseek.deepseek-flash", r2: "moonshot.kimi-k2.7-code-highspeed", r3: "deepseek.deepseek-flash" };
    const [ds, moon] = spendByModel(priced, (r) => byRun[r]);
    assert.deepEqual([ds.model, ds.calls, ds.runs, ds.computedCalls, ds.unpriced, ds.why], ["deepseek.deepseek-flash", 3, 2, 2, 1, "no price snapshot recorded"]);
    near(ds.computed, 3000 * 3e-7 + 30 * 0.0000012);
    assert.deepEqual([moon.computed, moon.unpriced, moon.why], [0, 1, "no price for kimi-k2.7-code-highspeed"]);
});

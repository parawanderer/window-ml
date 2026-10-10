// cost.mjs — what a model call cost, worked out when it is READ from the raw rows spend.mjs keeps: the provider's own
// figure when its usage carried one (`reported`), and the call's tokens priced from the price snapshot it ran under
// (`computed`). No price is kept by hand: a model is joined to a price through the box's own model list and the price
// sources, and a model nothing prices says why instead of costing 0.
//
// The join, measured over the box's model list (tmp/BENCH_COST_PLAN.md): an Open WebUI id is `<connection>.<upstream id>`
// for an external model; a local one (the list entry carries `ollama`) is paid in electricity, not tokens. The upstream id
// is looked up EXACTLY, in order: the box's LiteLLM routes (`litellm_model_info`, its `model_name`), OpenRouter's list,
// then LiteLLM's public map. Prices in all three are per token, in USD.

/** The currency the price sources quote in. */
export const PRICE_CURRENCY = "USD";

/** A source body as JSON, or null when it is not JSON (the pricing pages are HTML) or absent. */
const parsed = (body) => {
    if (body == null) return null;
    if (typeof body === "object" && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) return body;
    try { return JSON.parse(Buffer.from(body).toString("utf8")); } catch { return null; }
};
const list = (j) => (Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : null);
const num = (v) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * LiteLLM's per-token rates for a call of `prompt` tokens: the base rate, or the long-context tier the prompt is past
 * (`<rate>_above_<N>k_tokens`, the highest N below it).
 */
function litellmRates(info, prompt) {
    const tiered = (base) => {
        let best = num(info[base]), at = -1;
        for (const [k, v] of Object.entries(info)) {
            const m = new RegExp(`^${base}_above_(\\d+)k_tokens$`).exec(k);
            if (m && prompt > Number(m[1]) * 1000 && Number(m[1]) > at && num(v) != null) { best = num(v); at = Number(m[1]); }
        }
        return best;
    };
    return { input: tiered("input_cost_per_token"), output: tiered("output_cost_per_token"), cacheRead: tiered("cache_read_input_token_cost"),
        cacheWrite: tiered("cache_creation_input_token_cost"), reasoning: num(info.output_cost_per_reasoning_token) };
}

/** OpenRouter's per-token rates (strings in its list). */
const openrouterRates = (p) => ({ input: num(p.prompt), output: num(p.completion), cacheRead: num(p.input_cache_read), cacheWrite: num(p.input_cache_write), reasoning: num(p.internal_reasoning) });

/**
 * A price book over one call's snapshot: `{ <source name>: body }` (bytes or parsed). Returns `priceOf(model, prompt)` →
 * `{ local: true }` for a local model, `{ basis, key, rates }` for a priced one, or `{ none: "<why>" }`.
 */
export function priceBook(sources) {
    const owui = list(parsed(sources.owui_models)) ?? [];
    const routes = new Map((list(parsed(sources.litellm_model_info)) ?? []).map((r) => [r.model_name, r]));
    const openrouter = new Map((list(parsed(sources.openrouter)) ?? []).map((m) => [m.id, m]));
    const map = parsed(sources.litellm_map);
    const litellmMap = map && !Array.isArray(map) && typeof map === "object" ? map : {};
    return (model, prompt = 0) => {
        if (!model) return { none: "the run did not say which model served this call" };
        const entry = owui.find((m) => m.id === model);
        if (entry?.ollama) return { local: true };
        // An external model's id carries its connection's prefix; one the list does not know is tried as given too.
        const ids = entry?.connection_type === "external" && model.includes(".") ? [model.slice(model.indexOf(".") + 1), model] : [model];
        for (const id of ids) {
            const r = routes.get(id);
            if (r?.model_info) return { basis: "litellm_model_info", key: id, rates: litellmRates(r.model_info, prompt) };
            const o = openrouter.get(id);
            if (o?.pricing) return { basis: "openrouter", key: id, rates: openrouterRates(o.pricing) };
            const l = litellmMap[id];
            if (l && typeof l === "object" && num(l.input_cost_per_token) != null) return { basis: "litellm_map", key: id, rates: litellmRates(l, prompt), offPeak: !!l.off_peak_pricing };
        }
        if (!owui.length) return { none: "the snapshot has no model list" };
        return { none: `no price for ${ids[0]}` };
    };
}

/**
 * What one call cost, from its usage as recorded and its price (`priceOf` from {@link priceBook}, or null when the call
 * names no snapshot). `reported` is the provider's own `raw.cost`; `computed` prices each token class: uncached prompt,
 * cache reads, cache writes (from the raw block, when the provider counts them) and completion. A class with tokens and
 * no rate is listed in `unpriced` and leaves `computed` null, never priced at 0; a cache read with no cache rate is priced
 * at the input rate and said so in `notes`.
 */
export function callCost(usage, model, priceOf) {
    const raw = usage.raw ?? {};
    const reported = num(raw.cost);
    const out = { reported, computed: null, basis: null, key: null, local: false, why: null, unpriced: [], notes: [] };
    if (!priceOf) { out.why = "no price snapshot recorded"; return out; }
    const price = priceOf(model, usage.promptTokens ?? 0);
    if (price.local) { out.local = true; out.why = "a local model: its cost is electricity"; return out; }
    if (price.none) { out.why = price.none; return out; }
    out.basis = price.basis; out.key = price.key;
    if (price.offPeak) out.notes.push("priced at the peak rate (the source's off-peak windows are not applied)");
    const r = price.rates;
    const cached = usage.cachedTokens ?? 0;
    const write = num(raw.cache_creation_input_tokens) ?? 0;
    const classes = [
        ["input", Math.max(0, (usage.promptTokens ?? 0) - cached - write), r.input],
        ["cache read", cached, r.cacheRead ?? (cached ? (out.notes.push("cache reads priced at the input rate (no cache rate)"), r.input) : null)],
        ["cache write", write, r.cacheWrite],
        ["output", usage.completionTokens ?? 0, r.output],
    ];
    let sum = 0;
    for (const [name, n, rate] of classes) {
        if (!n) continue;
        if (rate == null) out.unpriced.push(name);
        else sum += n * rate;
    }
    out.computed = out.unpriced.length ? null : sum;
    if (out.unpriced.length) out.why = `no rate for ${out.unpriced.join(", ")}`;
    return out;
}

/**
 * Every call priced (`readCalls` rows), each against its own snapshot: `bodyOf(hash)` gives a stored body or null. Books
 * are built once per snapshot set. Returns the calls with `cost` added.
 */
export function priceCalls(calls, bodyOf) {
    const books = new Map();
    return calls.map((c) => {
        const sources = c.usage.prices?.sources;
        let priceOf = null;
        if (sources) {
            const key = JSON.stringify(Object.entries(sources).sort());
            if (!books.has(key)) books.set(key, priceBook(Object.fromEntries(Object.entries(sources).map(([name, h]) => [name, bodyOf(h)]))));
            priceOf = books.get(key);
        }
        return { ...c, cost: callCost(c.usage, c.model, priceOf) };
    });
}

/**
 * Spend per driver model (the `runs` row's model) over priced calls: how many calls, how much the provider reported and
 * over how many calls, how much was computed and over how many, and the calls neither could price with the most common
 * reason. `runModel(run)` maps a call's run to its row's model. Sorted by computed spend, highest first.
 */
export function spendByModel(priced, runModel) {
    const by = new Map();
    for (const c of priced) {
        const model = runModel(c.run);
        if (!model) continue;
        const s = by.get(model) ?? by.set(model, { model, calls: 0, runs: new Set(), reported: 0, reportedCalls: 0, computed: 0, computedCalls: 0, local: 0, unpriced: 0, why: new Map() }).get(model);
        s.calls++; s.runs.add(c.run);
        if (c.cost.reported != null) { s.reported += c.cost.reported; s.reportedCalls++; }
        if (c.cost.computed != null) { s.computed += c.cost.computed; s.computedCalls++; }
        if (c.cost.local) s.local++;
        if (c.cost.reported == null && c.cost.computed == null && !c.cost.local) { s.unpriced++; s.why.set(c.cost.why, (s.why.get(c.cost.why) ?? 0) + 1); }
    }
    return [...by.values()].map((s) => ({ ...s, runs: s.runs.size, why: [...s.why].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null }))
        .sort((a, b) => b.computed - a.computed || b.reported - a.reported);
}

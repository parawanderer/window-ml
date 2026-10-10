// price-book.ts — what a model call cost in money, from its recorded usage and the price snapshot it ran under. One
// join for every reader: the extension's spend view (through the worker, which holds the snapshot bodies) and the
// bench (tests/e2e/bench/cost.mjs). No price is kept by hand, and a model nothing prices says why instead of costing 0.
//
// The join, measured over the box's model list (tmp/BENCH_COST_PLAN.md): an Open WebUI id is `<connection>.<upstream id>`
// for an external model; a local one (the list entry carries `ollama`) is paid in electricity, not tokens. A model made in
// Open WebUI (a preset, `ui.*`) names the model it wraps (`info.base_model_id`) and is priced as that one, recursively. The upstream id
// is looked up EXACTLY, in order: the box's LiteLLM routes (`litellm_model_info`, its `model_name`), OpenRouter's list,
// then LiteLLM's public map, there also as `<connection>/<id>` (moonshot.kimi-k3 is the map's moonshot/kimi-k3). Prices in
// all three are per token, in USD. LiteLLM writes a price it does not have as 0, so a 0 from LiteLLM is missing, never
// free; OpenRouter's 0 is real (its free models).

import type { TokenUsage } from "../contract/contract-chat";

/** The currency the price sources quote in. */
export const PRICE_CURRENCY = "USD";

/** One source body as stored (bytes, or text) or already parsed. */
export type SourceBody = Uint8Array | string | object | null | undefined;

/** Per-token rates for one model, each null where the source has none. */
export interface Rates { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; reasoning: number | null }

/** What a price book says about one model: local (paid in electricity), priced, or unpriced with the reason. */
export type Price =
    | { local: true; none?: undefined }
    | { local?: undefined; none?: undefined; basis: string; key: string; rates: Rates; offPeak?: boolean; via?: string[] }
    | { local?: undefined; none: string };

/** A model's price for a call of `prompt` tokens. */
export type PriceOf = (model: string | null | undefined, prompt?: number, seen?: Set<string>) => Price;

/** What one call cost: the provider's own figure, the computed one, and why either is missing. */
export interface CallCost {
    reported: number | null;
    computed: number | null;
    basis: string | null;
    key: string | null;
    local: boolean;
    why: string | null;
    unpriced: string[];
    notes: string[];
}

/** Third-party JSON, read defensively. */
type Json = any;

/** One model call to price: its usage as recorded and the model that served it. */
export interface CallToPrice { usage: Pick<TokenUsage, "promptTokens" | "completionTokens" | "cachedTokens" | "raw" | "prices">; model: string | null }

/** A source body as JSON, or null when it is not JSON (the pricing pages are HTML) or absent. */
const parsed = (body: SourceBody): Json => {
    if (body == null) return null;
    if (typeof body === "object" && !(body instanceof Uint8Array)) return body;
    try { return JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body)); } catch { return null; }
};

const list = (j: Json): Json[] | null => (Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : null);

const num = (v: unknown): number | null => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** A LiteLLM rate: 0 is how it writes "no price", so it is missing. */
const lnum = (v: unknown): number | null => (num(v) ? num(v) : null);

/**
 * LiteLLM's per-token rates for a call of `prompt` tokens: the base rate, or the long-context tier the prompt is past
 * (`<rate>_above_<N>k_tokens`, the highest N below it).
 */
function litellmRates(info: Json, prompt: number): Rates {
    const tiered = (base: string) => {
        let best = lnum(info[base]), at = -1;
        for (const [k, v] of Object.entries(info)) {
            const m = new RegExp(`^${base}_above_(\\d+)k_tokens$`).exec(k);
            if (m && prompt > Number(m[1]) * 1000 && Number(m[1]) > at && lnum(v) != null) { best = lnum(v); at = Number(m[1]); }
        }
        return best;
    };
    return { input: tiered("input_cost_per_token"), output: tiered("output_cost_per_token"), cacheRead: tiered("cache_read_input_token_cost"),
        cacheWrite: tiered("cache_creation_input_token_cost"), reasoning: lnum(info.output_cost_per_reasoning_token) };
}

/** OpenRouter's per-token rates (strings in its list). */
const openrouterRates = (p: Json): Rates => ({ input: num(p.prompt), output: num(p.completion), cacheRead: num(p.input_cache_read), cacheWrite: num(p.input_cache_write), reasoning: num(p.internal_reasoning) });

/**
 * A price book over one call's snapshot: `{ <source name>: body }` (bytes or parsed). Returns `priceOf(model, prompt)` →
 * `{ local: true }` for a local model, `{ basis, key, rates }` for a priced one, or `{ none: "<why>" }`.
 */
export function priceBook(sources: Record<string, SourceBody>): PriceOf {
    const owui = list(parsed(sources.owui_models)) ?? [];
    const routes = new Map((list(parsed(sources.litellm_model_info)) ?? []).map((r) => [r.model_name, r]));
    const openrouter = new Map((list(parsed(sources.openrouter)) ?? []).map((m) => [m.id, m]));
    const map = parsed(sources.litellm_map);
    const litellmMap: Json = map && !Array.isArray(map) && typeof map === "object" ? map : {};
    const priceOf: PriceOf = (model, prompt = 0, seen = new Set()) => {
        if (!model) return { none: "the run did not say which model served this call" };
        const entry = owui.find((m) => m.id === model);
        if (entry?.ollama) return { local: true };
        // A preset is priced as the model it wraps; a chain that comes back to itself prices nothing.
        const base = entry?.info?.base_model_id;
        if (base && base !== model) {
            if (seen.has(model)) return { none: `${model} wraps itself` };
            const p = priceOf(base, prompt, new Set(seen).add(model));
            return p.none != null ? p : ({ ...p, via: [model, ...("via" in p && p.via ? p.via : [])] } as Price);
        }
        // An external model's id carries its connection's prefix; one the list does not know is tried as given too.
        const external = entry?.connection_type === "external" && model.includes(".");
        const ids = external ? [model.slice(model.indexOf(".") + 1), model] : [model];
        // The map also keys a provider's models as `<provider>/<id>`, and a connection is often named for its provider.
        const mapIds = external ? [...ids, `${model.slice(0, model.indexOf("."))}/${ids[0]}`] : ids;
        for (const id of ids) {
            const r = routes.get(id);
            if (r?.model_info) return { basis: "litellm_model_info", key: id, rates: litellmRates(r.model_info, prompt) };
            const o = openrouter.get(id);
            if (o?.pricing) return { basis: "openrouter", key: id, rates: openrouterRates(o.pricing) };
        }
        for (const id of mapIds) {
            const l = litellmMap[id];
            if (l && typeof l === "object" && lnum(l.input_cost_per_token) != null) return { basis: "litellm_map", key: id, rates: litellmRates(l, prompt), offPeak: !!l.off_peak_pricing };
        }
        // A base model the list does not carry but whose id says local (an ollama tag has no connection prefix) is
        // not guessed: it is unpriced, like any other miss.
        if (!owui.length) return { none: "the snapshot has no model list" };
        return { none: `no price for ${ids[0]}` };
    };
    return priceOf;
}

/**
 * What one call cost, from its usage as recorded and its price (`priceOf` from {@link priceBook}, or null when the call
 * names no snapshot). `reported` is the provider's own `raw.cost`; `computed` prices each token class: uncached prompt,
 * cache reads, cache writes (from the raw block, when the provider counts them) and completion. A class with tokens and
 * no rate is listed in `unpriced` and leaves `computed` null, never priced at 0; a cache read with no cache rate is priced
 * at the input rate and said so in `notes`.
 */
export function callCost(usage: Pick<TokenUsage, "promptTokens" | "completionTokens" | "cachedTokens" | "raw">, model: string | null | undefined, priceOf: PriceOf | null): CallCost {
    const raw: Json = usage.raw ?? {};
    const reported = num(raw.cost);
    const out: CallCost = { reported, computed: null, basis: null, key: null, local: false, why: null, unpriced: [], notes: [] };
    if (!priceOf) { out.why = "no price snapshot recorded"; return out; }
    const price = priceOf(model, usage.promptTokens ?? 0);
    if (price.local) { out.local = true; out.why = "a local model: its cost is electricity"; return out; }
    if (price.none != null) { out.why = price.none; return out; }
    out.basis = price.basis; out.key = price.key;
    if (price.offPeak) out.notes.push("priced at the peak rate (the source's off-peak windows are not applied)");
    const r = price.rates;
    const cached = usage.cachedTokens ?? 0;
    const write = num(raw.cache_creation_input_tokens) ?? 0;
    const classes: [string, number, number | null][] = [
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

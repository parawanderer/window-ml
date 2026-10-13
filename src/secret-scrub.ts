// secret-scrub.ts — takes the configured server URLs, the API key and the model filter out of text bound for a page or the model.

import type { MlConfig } from "./contract/contract-config";

/** One secret and what stands in for it. */
export interface SecretSub { find: string; put: string; }

/** What a configured server URL is written as in an error: the place, never where it is. */
const SERVER = "[server]";
/** The same for the price service's URL. */
const PRICES = "[price service]";

/** Regex metacharacters: a filter with none of them is a plain word, which also names models. */
const REGEX_META = /[\\^$.|?*+()[\]{}]/;

/**
 * Each form a URL takes in an error: the URL as configured, its origin (the worker builds `${origin}/api/models` and
 * the like from it), and its host with any port.
 * @param url a configured URL, or empty
 * @returns the strings to replace, longest first by the caller
 */
function urlForms(url: string): string[] {
    const u = (url || "").trim();
    if (!u) return [];
    const out = [u, u.replace(/\/+$/, "")];
    try {
        const p = new URL(u);
        out.push(p.origin, p.host);
    } catch { /* not a URL: the string as given is all there is */ }
    return out.filter((s) => s.length >= 4);
}

/**
 * The secrets in a config, as the substitutions `scrubSecrets` applies: the chat server's URL in each form, the
 * price service's, the API key, and the model filter. Longest first, so a URL is replaced before its own host.
 * @param config the stored config, or the part of it that is known
 * @returns the substitutions
 */
export function secretsOf(config: Partial<Pick<MlConfig, "chatUrl" | "apiKey" | "modelFilter" | "priceSnapshotUrl">>): SecretSub[] {
    const subs: SecretSub[] = [
        ...urlForms(config.chatUrl ?? "").map((find) => ({ find, put: SERVER })),
        ...urlForms(config.priceSnapshotUrl ?? "").map((find) => ({ find, put: PRICES })),
    ];
    const key = (config.apiKey ?? "").trim();
    if (key.length >= 4) subs.push({ find: key, put: "[API key]" });
    const filter = (config.modelFilter ?? "").trim();
    if (filter) {
        // The form the worker's errors write it in, always; the bare pattern only when it is a regex rather than a
        // word, since "qwen" is also part of every qwen model's name.
        subs.push({ find: `/${filter}/`, put: "[model filter]" });
        if (REGEX_META.test(filter) && filter.length >= 4) subs.push({ find: filter, put: "[model filter]" });
    }
    const seen = new Set<string>();
    return subs.filter((s) => !seen.has(s.find) && seen.add(s.find)).sort((a, b) => b.find.length - a.find.length);
}

/**
 * Text with every secret replaced: the one rule for an error's text that leaves the worker for a page or the model.
 * @param text the text
 * @param secrets from `secretsOf`
 * @returns the text, with each secret's placeholder in its place
 */
export function scrubSecrets(text: string, secrets: readonly SecretSub[]): string {
    let out = text;
    for (const s of secrets) if (out.includes(s.find)) out = out.split(s.find).join(s.put);
    return out;
}

/**
 * A response with every string under an `error` key scrubbed, at any depth: how the worker answers a page. Data fields
 * are the handler's answer and are left as they are; an error is the worker's own text.
 * @param value the response
 * @param secrets from `secretsOf`
 * @param depth how deep to look; nothing a handler answers nests further
 * @returns the response, copied where something changed
 */
export function scrubErrors<T>(value: T, secrets: readonly SecretSub[], depth = 6): T {
    if (!secrets.length || depth < 0 || value == null || typeof value !== "object") return value;
    if (Array.isArray(value)) {
        let changed = false;
        const out = value.map((v) => { const s = scrubErrors(v, secrets, depth - 1); if (s !== v) changed = true; return s; });
        return (changed ? out : value) as T;
    }
    let out: Record<string, unknown> | null = null;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const s = k === "error" && typeof v === "string" ? scrubSecrets(v, secrets) : scrubErrors(v, secrets, depth - 1);
        if (s !== v) (out ??= { ...(value as Record<string, unknown>) })[k] = s;
    }
    return (out ?? value) as T;
}

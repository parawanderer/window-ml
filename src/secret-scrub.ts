// secret-scrub.ts — takes the configured server URLs, the API key and the model filter out of text bound for a page or the model.

import type { MlConfig } from "./contract/contract-config";

/** One secret and what stands in for it. `ci`: matched in any letter case (a host name is case-insensitive). */
export interface SecretSub { find: string; put: string; ci?: boolean; }

/** What a configured server URL is written as in an error: the place, never where it is. */
const SERVER = "[server]";
/** The same for the price service's URL. */
const PRICES = "[price service]";

/** Regex metacharacters bar `.`: a filter with none of them reads as a model name ("qwen3.5"), which is also in text
 *  that names that model, so only its error form is scrubbed. */
const REGEX_META = /[\\^$|?*+()[\]{}]/;

/** Names that say nothing about where a server is, and are ordinary words in text: never scrubbed bare. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);

/** Shorter than this, an API key is a placeholder (`ollama`, `EMPTY`, `sk-1234`) and also an ordinary word. */
const MIN_KEY = 12;

/**
 * A host name to scrub on its own, without its port: one with a dot or a colon (a domain, an IP address), never a
 * dotless docker name ("ollama") or a loopback name, which are ordinary words in a page or a model's text.
 * @param name a host name, bracketed when IPv6
 * @returns the forms to scrub, empty when it is not to be scrubbed bare
 */
function bareHost(name: string): string[] {
    if (!/[.:]/.test(name) || LOOPBACK.has(name.toLowerCase())) return [];
    return [name, name.replace(/^\[|\]$/g, "")];
}

/**
 * Each form a URL takes in an error: the URL as configured, its origin (the worker builds `${origin}/api/models` and
 * the like from it), its host with any port, and the host name alone, each as typed (a Unicode or mixed-case host)
 * and as the URL parser writes it (punycode, lower case).
 * @param url a configured URL, or empty
 * @returns the strings to replace, longest first by the caller
 */
function urlForms(url: string): string[] {
    const u = (url || "").trim();
    if (!u) return [];
    const out = [u, u.replace(/\/+$/, "")];
    const typed = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/?#]+)/i.exec(u)?.[1];
    if (typed) out.push(typed, ...bareHost(typed.replace(/:\d+$/, "")));
    try {
        const p = new URL(u);
        out.push(p.origin, p.host, ...bareHost(p.hostname));
    } catch { /* not a URL: the string as given is all there is */ }
    return out.filter((s) => s.length >= 4);
}

/**
 * A secret and the forms it takes inside other text: JSON-escaped (with and without `\/`) and percent-encoded, which is
 * how a backend's error body or a redirect's query echoes it.
 * @param s the secret
 * @returns the forms, the secret itself first
 */
function encodedForms(s: string): string[] {
    const json = JSON.stringify(s).slice(1, -1);
    return [s, json, json.replace(/\//g, "\\/"), encodeURIComponent(s)];
}

/**
 * The secrets in a config, as the substitutions `scrubSecrets` applies: the chat server's URL in each form, the
 * price service's, the API key, and the model filter. Longest first, so a URL is replaced before its own host.
 * @param config the stored config, or the part of it that is known
 * @returns the substitutions
 */
export function secretsOf(config: Partial<Pick<MlConfig, "chatUrl" | "apiKey" | "modelFilter" | "priceSnapshotUrl">>): SecretSub[] {
    const subs: SecretSub[] = [
        ...urlForms(config.chatUrl ?? "").flatMap(encodedForms).map((find) => ({ find, put: SERVER, ci: true })),
        ...urlForms(config.priceSnapshotUrl ?? "").flatMap(encodedForms).map((find) => ({ find, put: PRICES, ci: true })),
    ];
    const key = (config.apiKey ?? "").trim();
    if (key.length >= MIN_KEY) subs.push(...encodedForms(key).map((find) => ({ find, put: "[API key]" })));
    const filter = (config.modelFilter ?? "").trim();
    if (filter) {
        // The form the worker's errors write it in ("blocked by the model filter (/re/)"), parenthesised so a short
        // filter does not take `/a/` out of every path; the bare pattern only when it cannot be a model's name.
        subs.push({ find: `(/${filter}/)`, put: "([model filter])" });
        if (REGEX_META.test(filter) && filter.length >= 4) subs.push(...encodedForms(filter).map((find) => ({ find, put: "[model filter]" })));
    }
    return mergeSecrets([subs]);
}

/**
 * Several configs' substitutions as one list: each `find` once, longest first.
 * @param lists from `secretsOf`, one per config
 * @returns the merged substitutions
 */
export function mergeSecrets(lists: readonly (readonly SecretSub[])[]): SecretSub[] {
    const seen = new Set<string>();
    return lists.flat().filter((s) => s.find.length > 0 && !seen.has(s.find) && !!seen.add(s.find)).sort((a, b) => b.find.length - a.find.length);
}

/** Regex-escaped, for a literal search in any letter case. */
const escapeRe = (s: string): string => s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

/**
 * Text with every secret replaced: the one rule for an error's text that leaves the worker for a page or the model.
 * @param text the text
 * @param secrets from `secretsOf`
 * @returns the text, with each secret's placeholder in its place
 */
export function scrubSecrets(text: string, secrets: readonly SecretSub[]): string {
    let out = text;
    for (const s of secrets) {
        if (s.ci) out = out.replace(new RegExp(escapeRe(s.find), "gi"), () => s.put);
        else if (out.includes(s.find)) out = out.split(s.find).join(s.put);
    }
    return out;
}

/** A key whose string value is error text. */
const ERROR_KEY = /error$/i;

/**
 * A response with every string under an error key (`error`, `transportError`: any key ending in "error") scrubbed, at
 * any depth: how the worker answers a page. Data fields are the handler's answer and are left as they are; an error is
 * the worker's own text, or a backend's body it quotes.
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
        const s = ERROR_KEY.test(k) && typeof v === "string" ? scrubSecrets(v, secrets) : scrubErrors(v, secrets, depth - 1);
        if (s !== v) (out ??= { ...(value as Record<string, unknown>) })[k] = s;
    }
    return (out ?? value) as T;
}

/**
 * The first `n` characters of a backend's body, cut before any secret the cut would land inside: a cut through the key
 * or the URL leaves a prefix no form in `secrets` matches. How the worker quotes a body in an error.
 * @param text the body
 * @param n how many characters to keep at most
 * @param secrets from `secretsOf`
 * @returns the clipped body
 */
export function clipClear(text: string, n: number, secrets: readonly SecretSub[]): string {
    let cut = Math.min(n, text.length);
    for (let moved = true; moved && cut > 0 && cut < text.length;) {
        moved = false;
        for (const s of secrets) {
            const lo = Math.max(0, cut - s.find.length + 1);
            const win = text.slice(lo, cut + s.find.length - 1);
            const at = s.ci ? win.toLowerCase().indexOf(s.find.toLowerCase()) : win.indexOf(s.find);
            if (at >= 0 && lo + at < cut) { cut = lo + at; moved = true; }
        }
    }
    return text.slice(0, cut);
}

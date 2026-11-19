// sw-scrub.ts — the worker's crossings for text that leaves it: a page's answer (its error strings: the config's secrets, and each registered value as a bare `[REDACTED]`), a page-started model request (every message, bare `[REDACTED]`), a run's model input, a script's input, the run's stored renders and pointers (the config's secrets and each registered value as `[REDACTED:<NAME>]`), the live output and the run log's key (registered values only). `GET_CONFIG`'s data is not among them (SECRET_HANDLES.md, Known limits).

import { getConfig } from "./sw-llm";
import { mapErrorStrings, mergeSecrets, scrubSecrets, secretsOf, type SecretSub } from "../secret-scrub";
import type { MlConfig } from "../contract/contract-config";
import type { NeutralMessage } from "../contract/contract-chat";
import { heldTail, redactedLine, scrubRegistry, type RegistrySub } from "../secret-registry";
import { registryIsReady, registryReady, registrySubsNow } from "./sw-secret-registry";

/** The settings `secretsOf` reads. With the legacy site list, exactly the `secret` class of
 *  setting-class.ts (tests/setting-class.test.mjs holds the two together). */
export const SECRET_KEYS = ["chatUrl", "apiKey", "modelFilter", "priceSnapshotUrl"] as const;
/** How many replaced settings are remembered. */
const RETIRED_MAX = 8;

/** The values of secret settings replaced since the worker started, newest first: an error written under the old URL
 *  (a request in flight when the setting changed) reaches a crossing after the change, and is scrubbed by them too. */
const retired: Partial<MlConfig>[] = [];   // state: cache
// Guarded: a module imported outside the worker (a test, a page bundle) has no `chrome` at import.
if (typeof chrome !== "undefined") chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "sync") return;
    const old: Record<string, string> = {};
    for (const k of SECRET_KEYS) {
        const v = changes[k]?.oldValue;
        if (typeof v === "string" && v.trim()) old[k] = v;
    }
    if (Object.keys(old).length) { retired.unshift(old as Partial<MlConfig>); retired.length = Math.min(retired.length, RETIRED_MAX); }
});

/** The secrets in the stored config now, read at the crossing so a URL changed a moment ago is the one scrubbed, and
 *  those of the settings it replaced. */
async function configSecrets(): Promise<SecretSub[]> {
    return mergeSecrets([secretsOf(await getConfig()), ...retired.map(secretsOf)]);
}

/**
 * A response bound for a page, with every `error` string scrubbed: the config's secrets, then each registered value as
 * a bare `[REDACTED]`, so a page never learns a name. Applied by the router to every answer to a page-started message
 * and to the streaming port's error. Fails closed: a config or a registry that cannot be read leaves an error carrying
 * nothing but that the request failed.
 * @param response what the handler answered
 * @returns the response a page may read
 */
export async function forPage<T>(response: T): Promise<T> {
    try {
        const secrets = await configSecrets();
        await registryReady();
        const subs = bareSubs();
        return mapErrorStrings(response, (s) => scrubRegistry(scrubSecrets(s, secrets), subs).text);
    } catch { return (response && typeof response === "object" && "error" in response ? { error: "The request failed." } : response) as T; }
}

/** The keys of a render whose strings are image data, which the scrub leaves alone. */
const IMAGE_KEY = /^(src|image|rawImage)$/;
/** What a stored string becomes when the secrets could not be read to scrub it. */
const STORED_WITHHELD = "[withheld: the registered secrets could not be read]";

/**
 * A value the run STORES or shows beside what the model read (a tool's Out render, a pointer's fuller capture), with
 * every string scrubbed the way {@link forModel} scrubs a result, less the count line: the sidebar, both exports and a
 * later `@tool:` read then hold no more than the model saw. Image data is not scanned. Fails closed: when the
 * secrets cannot be read, every string is withheld.
 * @param value the render, or a text
 * @returns the value, copied where something changed
 */
export async function forStored<T>(value: T): Promise<T> {
    let f: (s: string) => string;
    try {
        const secrets = await configSecrets();
        await registryReady();
        const subs = registrySubsNow();
        f = (s) => scrubRegistry(scrubSecrets(s, secrets), subs).text;
    } catch { f = () => STORED_WITHHELD; }
    return mapStrings(value, f, 8);
}

/** What a subtree deeper than the stored scrub reads becomes when it holds text. */
export const DEPTH_WITHHELD = "[withheld: nested deeper than the scrub reads]";

/** Whether a string is anywhere under `value`, but under an image key. */
function holdsText(value: unknown): boolean {
    if (typeof value === "string") return true;
    return value != null && typeof value === "object" && Object.entries(value).some(([k, v]) => !IMAGE_KEY.test(k) && holdsText(v));
}

/**
 * Every string in a value, through `f`, but those under an image key.
 * @param value the value
 * @param f what each string becomes
 * @param depth how deep to look
 * @returns the value, copied where something changed
 */
function mapStrings<T>(value: T, f: (s: string) => string, depth: number): T {
    if (typeof value === "string") return f(value) as T;
    if (value == null || typeof value !== "object") return value;
    // Deeper than the scrub reads: a subtree holding any text is withheld rather than kept as it is.
    if (depth < 0) return (holdsText(value) ? DEPTH_WITHHELD : value) as T;
    if (Array.isArray(value)) {
        let changed = false;
        const out = value.map((v) => { const s = mapStrings(v, f, depth - 1); if (s !== v) changed = true; return s; });
        return (changed ? out : value) as T;
    }
    let out: Record<string, unknown> | null = null;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (IMAGE_KEY.test(k)) continue;
        const s = mapStrings(v, f, depth - 1);
        if (s !== v) (out ??= { ...(value as Record<string, unknown>) })[k] = s;
    }
    return (out ?? value) as T;
}

/**
 * A text bound for a script or a run's model, scrubbed: the config's secrets (`scrubSecrets`), then every registered
 * secret's value in each of its forms, as `[REDACTED:<NAME>]` (SECRET_HANDLES.md, "The scrub as built"). The caller
 * keeps the text as the tool wrote it, less the registered values, where only the person reads it (the run log's
 * `key`, {@link forPerson}).
 * @param text the tool's result
 * @returns the text the model may read, whether it differs from `text`, and how many registered values each name had
 */
export async function forModel(text: string): Promise<{ text: string; changed: boolean; counts: Record<string, number> }> {
    let secrets: SecretSub[];
    try { secrets = await configSecrets(); await registryReady(); } catch { return { text: "Error: the tool failed (its message could not be checked).", changed: true, counts: {} }; }
    const reg = scrubRegistry(scrubSecrets(text, secrets), registrySubsNow());
    return { text: reg.text, changed: reg.text !== text, counts: reg.counts };
}

/**
 * The line a tool result ends with when registered values were taken out of it: names and a count, never a value, so
 * the model does not conclude the value was absent.
 * @param counts from {@link forModel}
 * @returns `\n[1 secret redacted (NAME)]`, or empty
 */
export function redactedNote(counts: Record<string, number>): string {
    const line = redactedLine(counts);
    return line ? `\n[${line}]` : "";
}

/**
 * A text the person reads (the run log's `key`, which keeps an error's raw text for extension pages): the registered
 * values taken out, the backend's own secrets left as they are.
 * @param text the raw text
 * @returns the text without a registered value
 */
export function forPerson(text: string): string {
    if (!registryIsReady()) { void registryReady().catch(() => {}); return REGISTRY_NOT_READ; }
    return scrubRegistry(text, registrySubsNow()).text;
}

/** What a crossing that cannot wait shows in place of its text before the registry is read. */
const REGISTRY_NOT_READ = "[held back: the registered secrets are not read yet]";

/**
 * A live output's text so far (`streamOutput`), for a crossing that cannot wait: the registered values replaced, and
 * any tail that begins one held back, so a value split across two deltas never shows its front.
 * @param text the output so far
 * @returns what the sidebar may show now
 */
export function forLive(text: string): string {
    // Nothing is shown before the registry is read; the next delta carries the whole output so far.
    if (!registryIsReady()) { void registryReady().catch(() => {}); return ""; }
    const subs = registrySubsNow();
    if (!subs.length) return text;
    const t = scrubRegistry(text, subs).text;
    return t.slice(0, t.length - heldTail(t, subs));
}

/** The registry's substitutions with the bare marker: a page-started request names no secret to the model it drives. */
function bareSubs(): RegistrySub[] {
    return registrySubsNow().map((s) => ({ ...s, put: "[REDACTED]" }));
}

/**
 * A page-started model request, scrubbed where it leaves the worker for the backend: every message's text, in every
 * role (the page composed all of them), has each registered value replaced by `[REDACTED]`, with no name and no count.
 * Nothing about it is reported to the page.
 * @param payload the request as the page sent it
 * @returns the request the backend may get (the same object when nothing matched)
 */
export async function forBackendFromPage<T>(payload: T): Promise<T> {
    await registryReady();
    const subs = bareSubs();
    if (!subs.length || !payload || typeof payload !== "object") return payload;
    const msgs = (payload as { messages?: unknown }).messages;
    if (!Array.isArray(msgs)) return payload;
    let changed = false;
    const scrub = (t: string): string => { const r = scrubRegistry(t, subs).text; if (r !== t) changed = true; return r; };
    const next = msgs.map((m) => {
        if (!m || typeof m !== "object") return m;
        const c = (m as { content?: unknown }).content;
        let out = m as Record<string, unknown>;
        if (typeof c === "string") out = { ...out, content: scrub(c) };
        else if (Array.isArray(c)) out = { ...out, content: c.map((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? { ...part, text: scrub((part as { text: string }).text) } : part) };
        // An assistant turn the page wrote carries its calls' arguments as text too.
        const calls = (m as { tool_calls?: unknown }).tool_calls;
        if (Array.isArray(calls)) out = { ...out, tool_calls: calls.map((tc) => {
            const f = tc && typeof tc === "object" ? (tc as { function?: { arguments?: unknown } }).function : undefined;
            return f && typeof f.arguments === "string" ? { ...tc, function: { ...f, arguments: scrub(f.arguments) } } : tc;
        }) };
        return out;
    });
    return changed ? { ...payload, messages: next } : payload;
}

/**
 * A history a run resumes from, scrubbed in place: the tool results and the model's own replies of a session saved
 * before the scrub existed (or under another config) carry the raw text, and the model reads them again on resume.
 * @param messages the history, as the loop will send it
 * @returns how many messages changed
 */
export async function forModelHistory(messages: NeutralMessage[]): Promise<number> {
    let changed = 0;
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if ((m.role !== "tool" && m.role !== "assistant") || typeof m.content !== "string" || !m.content) continue;
        const r = await forModel(m.content);
        if (r.changed) { messages[i] = { ...m, content: r.text }; changed++; }
    }
    return changed;
}

// sw-scrub.ts — the worker's crossings for text that leaves it: a page's answer (its error strings: the config's secrets, and each registered value as a bare `[REDACTED]`), a page-started model request (every message, bare `[REDACTED]`), a run's model input, a script's input, the run's stored renders and pointers (the config's secrets and each registered value as `[REDACTED:<NAME>]`), the live output and the run log's key (registered values only), and what a person or a page sends where it becomes a turn (`forTurn`: registered values and the extension's own key). `GET_CONFIG`'s data is not among them (SECRET_HANDLES.md, Known limits).

import { getConfig } from "./sw-llm";
import { mapErrorStrings, mergeSecrets, scrubSecrets, secretsOf, type SecretSub } from "../secret-scrub";
import type { MlConfig } from "../contract/contract-config";
import type { NeutralMessage, ToolCall } from "../contract/contract-chat";
import { findSpans, heldTail, redactedLine, scrubRegistry, TurnUnreadable, type RegistrySub } from "../secret-registry";
import { registryIsReady, registryReady, registrySubsNow } from "./sw-secret-registry";
import { rowForEgress, textForEgress } from "../session/session-row-scrub";
import type { SessionSummary } from "../session/session-host";

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
 * later `@tool:` read then hold no more than the model saw. Image data is not scanned. An object's keys are scrubbed as
 * its values are. Fails closed: when the secrets cannot be read, every string is withheld, and every key but one shaped
 * like a schema's own ({@link SCHEMA_KEY}), so the record keeps its shape.
 * @param value the render, or a text
 * @returns the value, copied where something changed
 */
export async function forStored<T>(value: T): Promise<T> {
    let f: (s: string) => string;
    let key: (k: string) => string;
    try {
        const secrets = await configSecrets();
        await registryReady();
        const subs = registrySubsNow();
        f = (s) => scrubRegistry(scrubSecrets(s, secrets), subs).text;
        key = f;
    } catch {
        f = () => STORED_WITHHELD;
        key = (k) => (SCHEMA_KEY.test(k) ? k : STORED_WITHHELD);
    }
    return mapStrings(value, f, key, 8);
}

/**
 * A key kept when the secrets cannot be read: letters only, starting lowercase, at most 32 (`type`, `stdout`,
 * `byColumn`). The residue, stated: a registered value of that shape used as a key survives that path.
 */
const SCHEMA_KEY = /^[a-z][A-Za-z]{0,31}$/;

/** What a subtree deeper than the stored scrub reads becomes when it holds text. */
export const DEPTH_WITHHELD = "[withheld: nested deeper than the scrub reads]";

/** Whether a string is anywhere under `value` but under an image key, or a key `key` would change. */
function holdsText(value: unknown, key: (s: string) => string): boolean {
    if (typeof value === "string") return true;
    // A key is text too, where the scrub would change it: a registered value used as a key.
    return value != null && typeof value === "object"
        && Object.entries(value).some(([k, v]) => key(k) !== k || (!IMAGE_KEY.test(k) && holdsText(v, key)));
}

/**
 * Every string in a value through `f`, but the values under an image key, and every key through `key`.
 * @param value the value
 * @param f what each string becomes
 * @param key what each key becomes
 * @param depth how deep to look
 * @returns the value, copied where something changed
 */
function mapStrings<T>(value: T, f: (s: string) => string, key: (k: string) => string, depth: number): T {
    if (typeof value === "string") return f(value) as T;
    if (value == null || typeof value !== "object") return value;
    // Deeper than the scrub reads: a subtree holding any text is withheld rather than kept as it is.
    if (depth < 0) return (holdsText(value, key) ? DEPTH_WITHHELD : value) as T;
    if (Array.isArray(value)) {
        let changed = false;
        const out = value.map((v) => { const s = mapStrings(v, f, key, depth - 1); if (s !== v) changed = true; return s; });
        return (changed ? out : value) as T;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    const keys = entries.map(([k]) => key(k));
    let changed = keys.some((k, i) => k !== entries[i][0]);
    const vals = entries.map(([k, v]) => {
        if (IMAGE_KEY.test(k)) return v;
        const s = mapStrings(v, f, key, depth - 1);
        if (s !== v) changed = true;
        return s;
    });
    if (!changed) return value;
    // Two keys can scrub to one text (two values of one name, or every key when the registry is unreadable): the later
    // ones are numbered, so no value is lost, and a key the scrub left alone keeps its name.
    const taken = new Set(keys.filter((k, i) => k === entries[i][0]));
    const named = keys.map((k, i) => {
        if (k === entries[i][0]) return k;
        let name = k;
        for (let n = 2; taken.has(name); n++) name = `${k} (${n})`;
        taken.add(name);
        return name;
    });
    // fromEntries defines each key as data, so a "__proto__" key stays a key.
    return Object.fromEntries(named.map((k, i) => [k, vals[i]])) as T;
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
 * The messages of a model call the worker composes itself (the utility profile's titles and `side.call`), scrubbed the
 * way {@link forModel} scrubs a result, in every role: a person's task or a sidebar's excerpt can hold a registered
 * value. Copies, so the asker's array is left as it was. Fails closed by THROWING, so the call is never sent.
 * @param messages the call's messages
 * @returns the messages the backend may get
 * @throws when the config or the registry cannot be read, with nothing of either in the message, or when a message's
 *  content is not text
 */
export async function forModelMessages(messages: NeutralMessage[]): Promise<NeutralMessage[]> {
    let secrets: SecretSub[];
    try { secrets = await configSecrets(); await registryReady(); } catch { throw new Error("The request was not sent: the registered secrets could not be read to check it."); }
    const subs = registrySubsNow();
    // A message is text or nothing (NeutralMessage). Content of any other shape (an array of parts an asker built) is
    // refused rather than sent unread: the scrub reads only strings.
    if (messages.some((m) => m.content != null && typeof m.content !== "string")) throw new Error("The request was not sent: a message's content was not text.");
    const scrub = (t: string): string => scrubRegistry(scrubSecrets(t, secrets), subs).text;
    // The content, and an assistant turn's thinking, which a backend that asks for it is sent too.
    // An assistant turn's calls carry their arguments as text (or an object whose string leaves are text) too.
    const deep = (v: unknown): unknown => typeof v === "string" ? scrub(v) : Array.isArray(v) ? v.map(deep) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v;
    return messages.map((m) => ({
        ...m,
        ...(typeof m.content === "string" && m.content ? { content: scrub(m.content) } : {}),
        ...(m.reasoning ? { reasoning: scrub(m.reasoning) } : {}),
        ...(Array.isArray(m.tool_calls) ? { tool_calls: m.tool_calls.map((tc) => tc && typeof tc === "object" ? { ...tc, arguments: deep(tc.arguments) as ToolCall["arguments"] } : tc) } : {}),
    }));
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

/** The name the extension's own saved API key is redacted under in a person's turn: a lowercase slug, so it never meets a
 *  registry name, which is upper case by its bound (SECRET_HANDLES.md, "The extension's own key, with no registration"). */
export const OWN_KEY_NAME = "window-ml-api-key";

/** The scrub of one turn's input, its substitutions read once: every text of the turn goes through the same one, and
 *  the note counts them all. */
export interface TurnScrub {
    /** a text of the turn, scrubbed, and what it took out counted for the note */
    text(s: string): string;
    /** a second copy of a text already counted (the typed words beside the framed task), scrubbed without counting it */
    again(s: string): string;
    /** an EARLIER turn's text crossing again (a stored chat's turn from before the input scrub): scrubbed and counted,
     *  with none of this turn's exemptions, which are for what the person sends now */
    prior(s: string): string;
    /** every string in a value (a turn's `display`, its page context), scrubbed as {@link TurnScrub.text} does */
    deep<T>(v: T): T;
    /** the line the model reads after the turn (`redactedNote`), for what this scrub took out so far; empty for a page's */
    note(): string;
    /** the names of the values this turn sent as is ("send as is" on the composer's chip), for the turn's display: names
     *  only, never a token */
    sentAsIs(): string[];
}

/** A scrub that changes nothing: the setting is off, or the person's call asked for its turn as it is. */
const AS_IS: TurnScrub = { text: (s) => s, again: (s) => s, prior: (s) => s, deep: (v) => v, note: () => "", sentAsIs: () => [] };

/**
 * The person's substitutions for a turn: every registered value under its name, and the extension's own saved API key
 * (and those replaced since the worker started) as {@link OWN_KEY_NAME}, from 12 characters.
 * @param cfg the config, for the saved key
 * @param put the marker for a name
 * @returns the substitutions, longest first within each source
 */
function turnSubs(cfg: MlConfig, put: (name: string) => string): RegistrySub[] {
    const own = mergeSecrets([cfg, ...retired].map((c) => secretsOf({ apiKey: c.apiKey }).filter((s) => s.put === "[API key]")));
    return [
        ...registrySubsNow().map((s) => ({ ...s, put: put(s.name) })),
        ...own.map((s) => ({ find: s.find, put: put(OWN_KEY_NAME), name: OWN_KEY_NAME })),
    ];
}

/** Where the key the exemption tokens are made with lives: the worker's session storage, which no content script or
 *  page reads (nothing here widens its access level) and the browser clears when it restarts. */
export const EXEMPT_KEY = "ml_turn_exempt_key";

// state: cache (the key read once a worker life; a cleared store mints a new one, and every token made before it
// stops matching, so a send exempts nothing: it fails closed)
let exemptKey: Promise<CryptoKey> | null = null;

/** The HMAC key exemption tokens are made with, minted on first use. */
function tokenKey(): Promise<CryptoKey> {
    exemptKey ??= (async () => {
        const got = await chrome.storage.session.get(EXEMPT_KEY);
        let raw = typeof got?.[EXEMPT_KEY] === "string" ? got[EXEMPT_KEY] as string : "";
        if (!/^[0-9a-f]{64}$/.test(raw)) {
            raw = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
            await chrome.storage.session.set({ [EXEMPT_KEY]: raw });
        }
        const bytes = new Uint8Array(raw.match(/../g)!.map((h) => parseInt(h, 16)));
        return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    })().catch((e) => { exemptKey = null; throw e; });
    return exemptKey;
}

/** Forget the key read this worker life, as a restarted worker would (tests: a cleared session store). */
export function _forgetExemptKeyForTest(): void { exemptKey = null; }

/**
 * The exemption token for one matched span's content: HMAC-SHA256 under {@link tokenKey}, so a token read from a
 * draft's scan is no guessing oracle for the value without the key, which never leaves the worker's session storage.
 * @param content the span's content, the registered form it matched
 * @returns the token, 32 hex characters
 */
async function exemptToken(content: string): Promise<string> {
    const mac = await crypto.subtle.sign("HMAC", await tokenKey(), new TextEncoder().encode(content));
    return [...new Uint8Array(mac).slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** One registered value in a draft, as the composer's chip is told of it: where, whose, and the token "send as is"
 *  sends back. Never the value or its length beyond the offsets into the composer's own text. */
export interface ScanSpan { start: number; end: number; name: string; token: string }

/**
 * A composer's draft, scanned for what {@link forTurn} would take out of a person's turn (the `SCAN_TURN` message, from
 * an extension sender only): for each text, the spans with names and tokens.
 * @param texts the draft's words and its text files' contents
 * @returns the spans of each text; `off` when the person's turns are not scrubbed (`scrubPersonInput` off)
 * @throws {TurnUnreadable} the config or the registry could not be read, as the send would be refused
 */
export async function scanTurn(texts: readonly string[]): Promise<{ spans: ScanSpan[][]; off?: true }> {
    let cfg: MlConfig;
    try { cfg = await getConfig(); } catch { throw new TurnUnreadable(true); }
    if (cfg.scrubPersonInput === false) return { spans: texts.map(() => []), off: true };
    try { await registryReady(); } catch { throw new TurnUnreadable(true); }
    const subs = turnSubs(cfg, (n) => `[REDACTED:${n}]`);
    const tokens = new Map<string, string>();
    const spans: ScanSpan[][] = [];
    for (const t of texts) {
        const out: ScanSpan[] = [];
        for (const h of findSpans(t, subs)) {
            let token = tokens.get(h.find);
            if (!token) { token = await exemptToken(h.find); tokens.set(h.find, token); }
            out.push({ start: h.start, end: h.end, name: h.name, token });
        }
        spans.push(out);
    }
    return { spans };
}

/**
 * The scrub for what a person or a page SENDS, where it becomes a turn (ruling 39, SECRET_HANDLES.md, "What the person
 * sends is scrubbed too"): every registered value, and the extension's own saved API key (and those replaced since the
 * worker started) from 12 characters, by value. A person's turn shows names (`[REDACTED:<NAME>]`,
 * `[REDACTED:window-ml-api-key]`) and its note names them; a page's gets the bare `[REDACTED]` and no note, since the page
 * reads the reply. A person's turn is left as it is when `scrubPersonInput` is off or the call asked (`off`); a page's
 * never is, as a page's `scrubInput: false` turns off only the shape detector, which is not built yet.
 * A person's `asIs` tokens ("send as is" on the composer's chip, {@link scanTurn}) leave the values whose content each
 * names, matched again here, and nothing else; a page's are ignored.
 * @param opts `site`: the turn is a page's. `off`: the person's call passed `scrubInput: false`. `asIs`: the person's
 *  exemption tokens
 * @returns the turn's scrub
 * @throws {TurnUnreadable} the config or the registry could not be read: the turn is held, never sent unchecked (ruling 44)
 */
export async function forTurn(opts: { site?: boolean; off?: boolean; asIs?: readonly string[] } = {}): Promise<TurnScrub> {
    const site = !!opts.site;
    let cfg: MlConfig;
    try { cfg = await getConfig(); } catch { throw new TurnUnreadable(!site); }
    if (!site && (opts.off || cfg.scrubPersonInput === false)) return AS_IS;
    try { await registryReady(); } catch { throw new TurnUnreadable(!site); }
    const all = turnSubs(cfg, (name) => (site ? "[REDACTED]" : `[REDACTED:${name}]`));
    if (!all.length) return AS_IS;
    // A token exempts the form whose content it was made from. A key that cannot be read exempts nothing.
    const asked = new Set(site ? [] : (opts.asIs ?? []).filter((t) => typeof t === "string"));
    const exempt: RegistrySub[] = [];
    if (asked.size) {
        for (const s of all) {
            const token = await exemptToken(s.find).catch(() => "");
            if (token && asked.has(token)) exempt.push(s);
        }
    }
    const subs = exempt.length ? all.filter((s) => !exempt.includes(s)) : all;
    const counts: Record<string, number> = {};
    const kept = new Set<string>();
    const counted = (s: string, by: RegistrySub[]): string => {
        const r = scrubRegistry(s, by);
        for (const [n, c] of Object.entries(r.counts)) counts[n] = (counts[n] ?? 0) + c;
        return r.text;
    };
    const text = (s: string): string => {
        const out = counted(s, subs);
        if (exempt.length) for (const h of findSpans(out, exempt)) kept.add(h.name);
        return out;
    };
    return {
        text, again: (s) => scrubRegistry(s, subs).text, prior: (s) => counted(s, all), deep: (v) => mapStrings(v, text, (k) => k, 8),
        note: () => (site ? "" : redactedNote(counts)), sentAsIs: () => [...kept].sort(),
    };
}

/**
 * The exemption tokens a person's message carries (`asIs`), read as the scrub takes them: strings only, at most 64.
 * @param v the field as it arrived
 * @returns the tokens, or undefined when there are none
 */
export function asIsTokens(v: unknown): string[] | undefined {
    if (!Array.isArray(v)) return undefined;
    const out = v.filter((t): t is string => typeof t === "string" && t.length <= 64).slice(0, 64);
    return out.length ? out : undefined;
}

/**
 * A turn's display with the names it sent as is ({@link TurnScrub.sentAsIs}), so the transcript and both exports mark
 * the value by name: the value itself is in the message, as the model read it.
 * @param display the turn's display, scrubbed
 * @param sc the turn's scrub, after every text of the turn went through it
 * @param typed the words to show when the turn had no display and one is needed to carry the names
 * @returns the display, unchanged when nothing was sent as is
 */
export function withAsIs<T extends { typed: string; context: unknown[] }>(display: T | undefined, sc: TurnScrub, typed?: string): T | { typed: string; context: unknown[]; asIs: string[] } | undefined {
    const names = sc.sentAsIs();
    if (!names.length) return display;
    if (display) return { ...display, asIs: names };
    return typed === undefined ? undefined : { typed, context: [], asIs: names };
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
        // An assistant turn carries its calls' arguments as text too: in the neutral shape every sender here builds
        // (`{ id, name, arguments }`, a string or an object, which API_FORMATS converts at send time), and in OpenAI's
        // wire shape (`function.arguments`) a page may send as it is.
        const calls = (m as { tool_calls?: unknown }).tool_calls;
        if (Array.isArray(calls)) out = { ...out, tool_calls: calls.map((tc) => {
            if (!tc || typeof tc !== "object") return tc;
            let call = tc as Record<string, unknown>;
            if ("arguments" in call) call = { ...call, arguments: scrubArgs(call.arguments, scrub) };
            const f = call.function as { arguments?: unknown } | undefined;
            if (f && typeof f === "object" && "arguments" in f) call = { ...call, function: { ...f, arguments: scrubArgs(f.arguments, scrub) } };
            return call;
        }) };
        return out;
    });
    return changed ? { ...payload, messages: next } : payload;
}

/**
 * A tool call's arguments, scrubbed: a string as text, an object through its JSON (keys included) and back. A scrubbed
 * JSON that no longer parses is sent as the scrubbed text, which holds no value either.
 * @param args the arguments, a string or an object
 * @param scrub the text scrub
 * @returns the arguments, the same value when nothing changed
 */
function scrubArgs(args: unknown, scrub: (t: string) => string): unknown {
    if (typeof args === "string") return scrub(args);
    if (!args || typeof args !== "object") return args;
    const text = JSON.stringify(args);
    const out = scrub(text);
    if (out === text) return args;
    try { return JSON.parse(out); } catch { return out; }
}

/**
 * A history a run resumes from, scrubbed in place: the tool results and the model's own replies of a session saved
 * before the scrub existed (or under another config) carry the raw text, and the model reads them again on resume.
 * A session stored before what the person sends was scrubbed (ruling 39) holds their turns raw too: given `users`, the
 * user turns go through it, so the model's history holds the placeholder while the stored session is not rewritten.
 * @param messages the history, as the loop will send it
 * @param users the scrub for the user turns of a history stored before the input scrub ({@link forTurn}); absent, they are left
 * @returns how many messages changed
 */
export async function forModelHistory(messages: NeutralMessage[], users?: TurnScrub): Promise<number> {
    let changed = 0;
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (users && m.role === "user" && typeof m.content === "string" && m.content) {
            const t = users.text(m.content);
            if (t !== m.content) { messages[i] = { ...m, content: t }; changed++; }
            continue;
        }
        if ((m.role !== "tool" && m.role !== "assistant") || typeof m.content !== "string" || !m.content) continue;
        const r = await forModel(m.content);
        if (r.changed) { messages[i] = { ...m, content: r.text }; changed++; }
    }
    return changed;
}

/**
 * A session row as it leaves the worker (the session server's index updates and snapshot, the hub's list, `session.list`,
 * the HUD's bring-here list): every registered value in its text as `[REDACTED:<NAME>]`, exempt or not (ruling 61,
 * SECRET_HANDLES.md). Synchronous, since the index is sent from synchronous code;
 * fails closed: before the registry's first read, the row's text is withheld (`onRegistryChanged` sends it again once it
 * can be scrubbed). By registered value only.
 * @param row the row
 * @returns the row a client may read
 */
export function forRow<T extends SessionSummary>(row: T): T {
    return rowForEgress(row, registryIsReady() ? registrySubsNow() : null);
}

/**
 * One text sent beside a row (a held run's page URL in the bring-here list, a title in the storage report), as
 * {@link forRow} sends a row's.
 * @param text the text
 * @returns the text, or undefined when it is withheld
 */
export function forRowText(text: string): string | undefined {
    return textForEgress(text, registryIsReady() ? registrySubsNow() : null);
}

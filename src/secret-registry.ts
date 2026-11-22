// secret-registry.ts — the values the person registered as secret (a name and a value each) and the pure matching over them: the forms a value is written in, the scrub of a text, of bytes and of a read range, and how much of a cut text's end to hold back.

import type { SecretSub } from "./secret-scrub";

/** One registered secret: the NAME written into model-facing text in its place, and the value that is never shown. */
export interface RegistryEntry { name: string; value: string }

/** One substitution of the registry: a form of a value, the marker that replaces it, and whose it is. */
export type RegistrySub = SecretSub & { name: string };

/** The most entries the registry holds. */
export const REGISTRY_MAX_ENTRIES = 64;

/** The fewest characters a value may have: a shorter one would match ordinary text. */
export const REGISTRY_MIN_VALUE = 8;

/** The most characters a value may have: the margins and the base64 forms grow with it. */
export const REGISTRY_MAX_VALUE = 512;

/** What a name looks like: it is written into model-facing text, so it is held to a plain slug. */
export const REGISTRY_NAME = /^[A-Z0-9_]{1,40}$/;

/** The shortest base64 form worth matching; a shorter run is ordinary text. */
const MIN_B64 = 8;

/** An existing marker, which is never matched again. */
const MARKER = /\[REDACTED:[A-Z0-9_]{1,40}\]/y;

/** The marker's opening, for the byte scan. */
const MARKER_OPEN = "[REDACTED:";

/**
 * Why an entry may not be added, or null when it may. An entry with the SAME NAME replaces the old one, so it is never
 * refused for its name and does not count against the cap.
 * @param existing the entries already registered
 * @param e the entry to add
 * @returns a short sentence naming the bound it breaks, or null
 */
export function entryRefusal(existing: readonly RegistryEntry[], e: RegistryEntry): string | null {
    if (!REGISTRY_NAME.test(e.name)) return "The name must be 1 to 40 characters of A-Z, 0-9 and _.";
    const n = [...e.value].length;
    if (n < REGISTRY_MIN_VALUE || n > REGISTRY_MAX_VALUE) return `The value must be ${REGISTRY_MIN_VALUE} to ${REGISTRY_MAX_VALUE} characters.`;
    if (!existing.some((x) => x.name === e.name) && existing.length >= REGISTRY_MAX_ENTRIES) return `At most ${REGISTRY_MAX_ENTRIES} secrets can be registered.`;
    return null;
}

/**
 * The URL-safe spelling of a standard base64 string.
 * @param s standard base64
 * @returns the same with `-` and `_` for `+` and `/`
 */
function urlSafe(s: string): string {
    return s.replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * The base64 forms a value takes inside a longer run, at each of the three byte alignments: only the characters whose
 * six bits all come from the value's bytes, since the neighbours decide the rest.
 * @param value the secret
 * @returns standard and URL-safe forms, without padding, those of at least 8 characters
 */
function base64Forms(value: string): string[] {
    const bytes = new TextEncoder().encode(value);
    const out: string[] = [];
    for (let k = 0; k < 3; k++) {
        const bin = String.fromCharCode(...new Array<number>(k).fill(0), ...bytes);
        const b64 = btoa(bin).replace(/=+$/, "");
        const core = b64.slice(Math.ceil((8 * k) / 6), Math.floor((8 * (k + bytes.length)) / 6));
        if (core.length >= MIN_B64) out.push(core);
        const safe = urlSafe(core);
        if (safe.length >= MIN_B64) out.push(safe);
    }
    return out;
}

/**
 * Every form a value is matched in: as written, JSON-escaped (with and without `\/`), percent-encoded, base64 (both
 * alphabets, three alignments) and shell-escaped (single-quoted and backslash style).
 * @param value the secret
 * @returns the distinct forms, the value itself first
 */
export function valueForms(value: string): string[] {
    const json = JSON.stringify(value).slice(1, -1);
    const forms = [value, json, json.replace(/\//g, "\\/"), encodeURIComponent(value), ...base64Forms(value)];
    forms.push(value.replace(/'/g, "'\\''"), value.replace(/[^A-Za-z0-9_./:@%+,=-]/gu, "\\$&"));
    return [...new Set(forms)].filter((f) => f.length > 0);
}

/**
 * The substitutions for a registry: one per form per entry, each form once (the first entry wins), longest first.
 * @param entries the registered secrets
 * @returns the substitutions, `put` being `[REDACTED:<NAME>]`
 */
export function registrySubs(entries: readonly RegistryEntry[]): RegistrySub[] {
    const seen = new Set<string>();
    const subs: RegistrySub[] = [];
    for (const e of entries) {
        for (const find of valueForms(e.value)) {
            if (seen.has(find)) continue;
            seen.add(find);
            subs.push({ find, put: `[REDACTED:${e.name}]`, name: e.name });
        }
    }
    return subs.sort((a, b) => b.find.length - a.find.length);
}

/** One match of a form in a text: where, and whose. */
interface Hit { start: number; end: number; put: string; name: string }

/**
 * The matches in a text: left to right, none overlapping, the longest form where several start at one place, and an
 * existing marker stepped over whole.
 * @param text the text
 * @param subs from `registrySubs`
 * @returns the matches in order
 */
function findHits(text: string, subs: readonly RegistrySub[]): Hit[] {
    const hits: Hit[] = [];
    if (!subs.length) return hits;
    const byFirst = new Map<string, RegistrySub[]>();
    for (const s of [...subs].sort((a, b) => b.find.length - a.find.length)) {
        const list = byFirst.get(s.find[0]);
        if (list) list.push(s); else byFirst.set(s.find[0], [s]);
    }
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (c === "[") {
            MARKER.lastIndex = i;
            const m = MARKER.exec(text);
            if (m) { i += m[0].length; continue; }
        }
        const hit = byFirst.get(c)?.find((s) => text.startsWith(s.find, i));
        if (hit) { hits.push({ start: i, end: i + hit.find.length, put: hit.put, name: hit.name }); i += hit.find.length; } else i++;
    }
    return hits;
}

/** One match a composer is told of: where in its own text, and whose. Never the value, which the text already holds. */
export interface SpanHit { start: number; end: number; name: string }

/**
 * The matches in a text, as {@link scrubRegistry} would replace them: offsets and names only.
 * @param text the text
 * @param subs from `registrySubs`
 * @returns the matches in order, each with the form it matched (`find`), for the worker's own use
 */
export function findSpans(text: string, subs: readonly RegistrySub[]): (SpanHit & { find: string })[] {
    return findHits(text, subs).map((h) => ({ start: h.start, end: h.end, name: h.name, find: text.slice(h.start, h.end) }));
}

/**
 * A text with every registered form replaced by its marker.
 * @param text the text
 * @param subs from `registrySubs`
 * @returns the text and how many matches each name had
 */
export function scrubRegistry(text: string, subs: readonly RegistrySub[]): { text: string; counts: Record<string, number> } {
    const counts: Record<string, number> = {};
    const hits = findHits(text, subs);
    if (!hits.length) return { text, counts };
    let out = "";
    let pos = 0;
    for (const h of hits) {
        out += text.slice(pos, h.start) + h.put;
        pos = h.end;
        counts[h.name] = (counts[h.name] ?? 0) + 1;
    }
    return { text: out + text.slice(pos), counts };
}

/**
 * The line a scrub adds to a result: how many secrets were redacted and whose, never a value.
 * @param counts from a scrub
 * @returns `1 secret redacted (NAME)` or `3 secrets redacted (A, B)`, empty when nothing matched
 */
export function redactedLine(counts: Record<string, number>): string {
    const names = Object.keys(counts).filter((n) => counts[n] > 0).sort();
    const total = names.reduce((a, n) => a + counts[n], 0);
    if (!total) return "";
    return `${total} ${total === 1 ? "secret" : "secrets"} redacted (${names.join(", ")})`;
}

/**
 * How many characters at the end of a text to hold back because they begin some form: a cut there would show a prefix
 * of a secret. A whole form at the end is a match, not a prefix, and is not held.
 * @param text the text so far
 * @param subs from `registrySubs`
 * @returns the length of the longest suffix that is a proper prefix of a form, 0 when none
 */
export function heldTail(text: string, subs: readonly RegistrySub[]): number {
    const longest = margin(subs);
    for (let m = Math.min(longest - 1, text.length); m > 0; m--) {
        const tail = text.slice(text.length - m);
        if (subs.some((s) => s.find.length > m && s.find.startsWith(tail))) return m;
    }
    return 0;
}

/**
 * How far a read range must be widened on each side to see every match that overlaps it.
 * @param subs from `registrySubs`
 * @returns the longest form's length, 0 when there are none
 */
export function margin(subs: readonly RegistrySub[]): number {
    return subs.reduce((n, s) => Math.max(n, s.find.length), 0);
}

/**
 * Whether the bytes at a position are an existing marker, and how long it is.
 * @param bytes the bytes
 * @param i the position
 * @returns the marker's length, 0 when there is none
 */
function markerBytesAt(bytes: Uint8Array, i: number): number {
    for (let j = 0; j < MARKER_OPEN.length; j++) if (bytes[i + j] !== MARKER_OPEN.charCodeAt(j)) return 0;
    let p = i + MARKER_OPEN.length;
    const start = p;
    while (p < bytes.length && p - start <= 40 && /[A-Z0-9_]/.test(String.fromCharCode(bytes[p]))) p++;
    return p > start && bytes[p] === 0x5d ? p + 1 - i : 0;
}

/**
 * Raw bytes with every registered form replaced, each form matched as its UTF-8 encoding.
 * @param bytes the bytes
 * @param subs from `registrySubs`
 * @returns the bytes (the same array when nothing matched) and the number of matches
 */
export function scrubBytes(bytes: Uint8Array, subs: readonly RegistrySub[]): { bytes: Uint8Array; scrubbed: number } {
    const enc = new TextEncoder();
    const forms = [...subs].sort((a, b) => b.find.length - a.find.length).map((s) => ({ find: enc.encode(s.find), put: enc.encode(s.put) }));
    const parts: Uint8Array[] = [];
    let pos = 0;
    let scrubbed = 0;
    let i = 0;
    while (i < bytes.length) {
        if (bytes[i] === 0x5b) {
            const m = markerBytesAt(bytes, i);
            if (m) { i += m; continue; }
        }
        const f = forms.find((x) => x.find.length <= bytes.length - i && x.find.every((b, j) => bytes[i + j] === b));
        if (!f) { i++; continue; }
        parts.push(bytes.subarray(pos, i), f.put);
        i += f.find.length;
        pos = i;
        scrubbed++;
    }
    if (!scrubbed) return { bytes, scrubbed };
    parts.push(bytes.subarray(pos));
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return { bytes: out, scrubbed };
}

/**
 * The slice [from, to) of a text fetched with a margin on both sides, scrubbed: matches are found in the whole window,
 * and one that overlaps the slice becomes its marker (once, its outside part dropped), so a cut never shows a prefix.
 * @param window the fetched text
 * @param from the start of the wanted slice, in the window
 * @param to the end of the wanted slice, exclusive
 * @param subs from `registrySubs`
 * @returns the slice and the counts of the matches that overlap it
 */
export function scrubRange(window: string, from: number, to: number, subs: readonly RegistrySub[]): { text: string; counts: Record<string, number> } {
    const lo = Math.max(0, from);
    const hi = Math.min(window.length, to);
    const counts: Record<string, number> = {};
    let out = "";
    let pos = lo;
    for (const h of findHits(window, subs)) {
        if (h.end <= lo) continue;
        if (h.start >= hi) break;
        if (h.start > pos) out += window.slice(pos, h.start);
        out += h.put;
        pos = Math.max(pos, h.end);
        counts[h.name] = (counts[h.name] ?? 0) + 1;
    }
    if (pos < hi) out += window.slice(pos, hi);
    return { text: out, counts };
}

/**
 * A person's or a page's turn held because the registered secrets it is checked against could not be read (ruling 44,
 * SECRET_HANDLES.md): a store that cannot be read is not an empty one, so the turn is not sent. The message is the
 * one the sender reads. A person is told how to send it as it is; a page is not, since its `scrubInput: false` never
 * turns off the scrub by value.
 */
export class TurnUnreadable extends Error {
    /** @param person whether the turn is the person's (an extension sender), rather than a page's */
    constructor(person: boolean) {
        super(person
            ? "The message was not sent: the secret store could not be read to check it. Try again, or send it with scrubInput: false to send it as it is."
            : "The message was not sent: the secret store could not be read to check it. Try again once it can be read.");
        this.name = "TurnUnreadable";
    }
}

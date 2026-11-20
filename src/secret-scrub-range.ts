// secret-scrub-range.ts — scrubs a TEXT RANGE of a file for `ml.fs` reads, so a secret is never split across two reads.

import { GITHUB_TOKEN, GITHUB_TOKEN_PUT, type SecretSub } from "./secret-scrub";

/** The widest window a range read widens by; a longer secret form reads the whole file or is refused. */
export const SCRUB_WINDOW_CEILING = 4096;

/** The largest file scrubbed whole (`ML_FS_READFILE_MAX`, 8 MiB), in source units. */
export const SCRUB_WHOLE_MAX = 8 * 1024 * 1024;

/** The longest a GitHub token can be: `github_pat_` and at most 255 more characters. */
const GITHUB_TOKEN_MAX = "github_pat_".length + 255;

/** A text that can be read in slices: `slice(a, b)` is the source's characters [a, b). */
export type TextSource = { length: number; slice(a: number, b: number): Promise<string> };

/** Refusal of a range read whose secret form is too long to window: names the setting KEY only, never its value or length. */
export class ScrubWindowTooLong extends Error {
    key: string;
    /** @param key the config key of the over-long secret */
    constructor(key: string) {
        super(`cannot scrub a text range of a file this large: the setting ${key} is too long to scan for in a file over 8 MiB; shorten ${key} in Settings`);
        this.name = "ScrubWindowTooLong";
        this.key = key;
    }
}

/** The setting a substitution's placeholder stands for. */
const KEY_OF_PUT: Record<string, string> = {
    "[server]": "chatUrl",
    "[price service]": "priceSnapshotUrl",
    "[API key]": "apiKey",
    "[model filter]": "modelFilter",
    "([model filter])": "modelFilter",
};

/** One occurrence of a secret: [start, end) in the window, and what replaces it. */
type Hit = { start: number; end: number; put: string };

/**
 * Every match in `text` the way `scrubSecrets` applies them: the GitHub token first, then each substitution in order,
 * each occurrence non-overlapping with what is already claimed.
 * @param text the window
 * @param secrets from `secretsOf`
 * @returns the hits, in order of position
 */
function findHits(text: string, secrets: readonly SecretSub[]): Hit[] {
    const hits: Hit[] = [];
    const free = (a: number, b: number): boolean => !hits.some((h) => a < h.end && h.start < b);
    const token = new RegExp(GITHUB_TOKEN.source, "g");
    for (let m; (m = token.exec(text));) hits.push({ start: m.index, end: m.index + m[0].length, put: GITHUB_TOKEN_PUT });
    for (const s of secrets) {
        if (!s.find) continue;
        const re = s.ci ? new RegExp(s.find.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"), "gi") : null;
        for (let at = 0; at <= text.length;) {
            let i: number;
            let len = s.find.length;
            if (re) { re.lastIndex = at; const m = re.exec(text); if (!m) break; i = m.index; len = m[0].length; }
            else { i = text.indexOf(s.find, at); if (i < 0) break; }
            if (free(i, i + len)) { hits.push({ start: i, end: i + len, put: s.put }); at = i + len; }
            else at = i + 1;
        }
    }
    return hits.sort((a, b) => a.start - b.start);
}

/**
 * The text of [start, end) of a source with every secret replaced, read over a window widened by the longest form so
 * a secret straddling either edge is seen whole. A secret starting in the range is replaced there, and when it runs
 * past `end` the read consumes to its end; one starting before `start` is removed from the range.
 * @param src the source text
 * @param start first position to read
 * @param end one past the last position to read
 * @param secrets from `secretsOf`
 * @returns the scrubbed text and how far the source was consumed: the next read starts there
 * @throws ScrubWindowTooLong when a form is longer than the ceiling and the source is too large to scan whole
 */
export async function scrubRange(src: TextSource, start: number, end: number, secrets: readonly SecretSub[]): Promise<{ text: string; consumed: number }> {
    const a = Math.max(0, Math.min(start, src.length));
    const b = Math.max(a, Math.min(end, src.length));
    const longest = secrets.reduce<SecretSub | null>((m, s) => (!m || s.find.length > m.find.length ? s : m), null);
    const W = Math.max(longest?.find.length ?? 0, GITHUB_TOKEN_MAX);
    let lo: number, hi: number;
    if (W <= SCRUB_WINDOW_CEILING) { lo = Math.max(0, a - (W - 1)); hi = Math.min(src.length, b + W - 1); }
    else if (src.length <= SCRUB_WHOLE_MAX) { lo = 0; hi = src.length; }
    else throw new ScrubWindowTooLong(KEY_OF_PUT[longest!.put] ?? "a configured secret");
    const win = await src.slice(lo, hi);
    let out = "";
    let pos = a;
    let consumed = b;
    for (const h of findHits(win, secrets)) {
        const hs = h.start + lo, he = h.end + lo;
        if (he <= a) continue;
        if (hs >= b) break;
        if (hs < a) { pos = Math.min(Math.max(pos, he), b); consumed = Math.max(consumed, he); continue; }
        out += win.slice(pos - lo, hs - lo) + h.put;
        pos = he;
        consumed = Math.max(consumed, he);
    }
    if (pos < b) out += win.slice(pos - lo, b - lo);
    return { text: out, consumed };
}

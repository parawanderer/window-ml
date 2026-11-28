// secret-mask.ts — the scrub of a byte range that keeps its LENGTH: every byte of a secret's match becomes `*` (0x2A), so a reader that seeks by offset and reads `st_size` (Python's `/files` mount) sees the same sizes and offsets (FILE_ATTACHMENTS.md, "Python's view: two mounts").

import { GITHUB_TOKEN, GITHUB_TOKEN_PUT } from "./secret-scrub";

/** One secret in one of its written forms, matched as its UTF-8 bytes, ASCII letters in any case when `ci`. `put` is
 *  what a NAME shows in its place ({@link maskName}): `[REDACTED:<NAME>]`, as the turn's scrub writes it. */
export interface SecretForm { find: string; ci?: boolean; put?: string }

/** What a name shows for a form that came with no `put`. */
const NAME_PUT = "[REDACTED]";

/** The byte a match's every byte is replaced by: `*`. */
export const MASK_BYTE = 0x2a;

/** The longest text `GITHUB_TOKEN` matches: `github_pat_` and 255 characters. */
const GITHUB_TOKEN_MAX = 266;

const utf8 = new TextEncoder();

/**
 * Bytes as a string of one character per byte (codes 0 to 255), so a native string search finds byte offsets.
 * @param b the bytes
 * @returns the string, `b.length` long
 */
function byteString(b: Uint8Array): string {
    let s = "";
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return s;
}

/** ASCII letters lowered and nothing else, so a folded string keeps every byte's offset. */
const foldAscii = (s: string): string => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

/**
 * How far a range must be widened on each side so a match that overlaps it is seen whole: the longest form's UTF-8
 * length, or the GitHub token pattern's when that is longer, less one byte.
 * @param forms the secrets' forms
 * @returns the overlap in bytes
 */
export function maskOverlap(forms: readonly SecretForm[]): number {
    let longest = GITHUB_TOKEN_MAX;
    for (const f of forms) longest = Math.max(longest, utf8.encode(f.find).length);
    return longest - 1;
}

/**
 * Masks `bytes` in place: every match of a form's UTF-8 bytes, and every GitHub token, becomes as many `*` bytes.
 * Matches may overlap; each is masked whole. Only literal bytes match: a form written in another encoding (UTF-16, a
 * compressed or base64 container the forms do not list) is not seen.
 * @param bytes the window to mask, changed in place
 * @param forms the secrets' forms
 * @returns how many matches were masked
 */
export function maskSecretBytes(bytes: Uint8Array, forms: readonly SecretForm[]): number {
    const s = byteString(bytes);
    let folded: string | undefined;
    let count = 0;
    const mask = (at: number, len: number): void => { bytes.fill(MASK_BYTE, at, at + len); count++; };
    for (const f of forms) {
        if (!f.find) continue;
        const needle = byteString(utf8.encode(f.find));
        const hay = f.ci ? (folded ??= foldAscii(s)) : s;
        const n = f.ci ? foldAscii(needle) : needle;
        for (let i = hay.indexOf(n); i >= 0; i = hay.indexOf(n, i + 1)) mask(i, n.length);
    }
    for (const m of s.matchAll(new RegExp(GITHUB_TOKEN))) mask(m.index, m[0].length);
    return count;
}

/**
 * A file's name as `/files` shows it (FILE_ATTACHMENTS.md, "Names under `/files`"): every match of a form becomes that
 * form's `put`, the longest form at each position first, and every GitHub token its marker, as the turn's scrub writes
 * the framed task. Matched on the string, ASCII letters in any case when `ci`.
 * @param name the stored name
 * @param forms the secrets' forms
 * @returns the shown name, `name` itself when nothing matched
 */
export function maskName(name: string, forms: readonly SecretForm[]): string {
    const live = forms.filter((f) => f.find).sort((a, b) => b.find.length - a.find.length);
    const folded = foldAscii(name);
    let out = "";
    let i = 0;
    while (i < name.length) {
        const hit = live.find((f) => (f.ci ? folded.startsWith(foldAscii(f.find), i) : name.startsWith(f.find, i)));
        if (hit) { out += hit.put ?? NAME_PUT; i += hit.find.length; } else out += name[i++];
    }
    return out.replace(new RegExp(GITHUB_TOKEN), GITHUB_TOKEN_PUT);
}

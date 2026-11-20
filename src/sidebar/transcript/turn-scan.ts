// turn-scan.ts — what a composer does with the worker's scan of a draft: the chips, the file counts, and the tokens a send carries.

// SECRET_HANDLES.md, "What the person sees". The worker answers `SCAN_TURN` with, for each text it was given, the spans of
// registered values in it (an offset pair, the entry's name and an opaque token), never a value. The composer shows one chip
// per distinct value, and a send carries the tokens of the values the person chose to send as is. Pure: no DOM, no chrome.

/** One registered value found in a text. Defined as `ScanSpan` in src/sw/sw-scrub.ts (worker code, not imported into a UI bundle). */
export interface ScanSpan { start: number; end: number; name: string; token: string }

/** What a scan came to, as a composer reads it. `spans[0]` is the typed words, then one entry per scanned file, in `fileAt` order. */
export interface TurnScan {
    spans: ScanSpan[][];
    /** for each file of the box, its index in `spans`, or -1 when it was not scanned (a PDF, a refused file) */
    fileAt: number[];
    /** the person turned the scrub off (`scrubPersonInput`): no chips */
    off: boolean;
    /** the secret store could not be read: a send is refused as well, and the box says so quietly */
    unreadable: boolean;
}

/** A scan that found nothing, for a box with `files` files. */
export const noScan = (files = 0): TurnScan => ({ spans: [], fileAt: Array.from({ length: files }, () => -1), off: false, unreadable: false });

/** One chip: a registered value in the typed words. One per distinct value, since a token names a value by its content. */
export interface TurnChip { token: string; name: string; /** how many times it occurs in the typed words */ count: number }

/**
 * Read the worker's answer to `SCAN_TURN`, defensively: anything that is not the documented shape is "no chips".
 * @param res the response
 * @param fileAt for each file of the box, its index in the texts that were sent, or -1
 * @returns the scan
 */
export function readScan(res: unknown, fileAt: number[]): TurnScan {
    const r = (res && typeof res === "object" ? res : {}) as { data?: { spans?: unknown; off?: unknown }; unreadable?: unknown; error?: unknown };
    if (r.unreadable === true) return { ...noScan(), fileAt, unreadable: true };
    const d = r.data;
    if (!d || !Array.isArray(d.spans)) return { ...noScan(), fileAt };
    if (d.off === true) return { ...noScan(), fileAt, off: true };
    const spans = d.spans.map((list) => (Array.isArray(list) ? list.filter(isSpan) : []));
    return { spans, fileAt, off: false, unreadable: false };
}

/** @returns whether `v` has the shape of a {@link ScanSpan} */
function isSpan(v: unknown): v is ScanSpan {
    const s = v as ScanSpan | null;
    return !!s && typeof s.name === "string" && typeof s.token === "string" && typeof s.start === "number" && typeof s.end === "number";
}

/**
 * The chips of the typed words: one per distinct token, in the order they first appear.
 * @param scan the latest scan
 * @returns the chips
 */
export function chipsOf(scan: TurnScan): TurnChip[] {
    const out = new Map<string, TurnChip>();
    for (const s of scan.spans[0] ?? []) {
        const had = out.get(s.token);
        if (had) had.count++;
        else out.set(s.token, { token: s.token, name: s.name, count: 1 });
    }
    return [...out.values()];
}

/** What one file shows: how many registered values it holds, which tokens those are, and what they are called. */
export interface FileScan { count: number; tokens: string[]; names: string[] }

/**
 * The scan of file `i` of the box, or null when it holds nothing (or was not scanned).
 * @param scan the latest scan
 * @param i the file's index in the box
 */
export function fileScanOf(scan: TurnScan, i: number): FileScan | null {
    const at = scan.fileAt[i];
    const list = at === undefined || at < 0 ? [] : scan.spans[at] ?? [];
    if (!list.length) return null;
    const tokens = [...new Set(list.map((s) => s.token))];
    const names = [...new Set(list.map((s) => s.name))];
    return { count: list.length, tokens, names };
}

/** Every token the latest scan holds, in the order the box shows them. */
export function tokensIn(scan: TurnScan): string[] {
    return [...new Set(scan.spans.flat().map((s) => s.token))];
}

/**
 * Flip one value's "send as is".
 * @param chosen the tokens chosen so far
 * @param token the chip's token
 * @returns the new set
 */
export function toggleToken(chosen: ReadonlySet<string>, token: string): Set<string> {
    const next = new Set(chosen);
    if (!next.delete(token)) next.add(token);
    return next;
}

/**
 * Flip "send as is" for a whole file: on for every value in it unless every one already is, then off for all of them.
 * @param chosen the tokens chosen so far
 * @param tokens the file's tokens
 * @returns the new set
 */
export function toggleFile(chosen: ReadonlySet<string>, tokens: readonly string[]): Set<string> {
    const next = new Set(chosen);
    if (tokens.length && tokens.every((t) => next.has(t))) for (const t of tokens) next.delete(t);
    else for (const t of tokens) next.add(t);
    return next;
}

/**
 * What a send carries: the chosen tokens that the latest scan still holds, once each. A token the draft no longer contains
 * (the value was edited or removed) is left out, so an old choice never exempts a value typed later.
 * @param chosen the tokens chosen
 * @param scan the latest scan
 * @returns the tokens, or undefined when there are none, so the field is left off
 */
export function asIsFor(chosen: ReadonlySet<string>, scan: TurnScan): string[] | undefined {
    if (!chosen.size || scan.off || scan.unreadable) return undefined;
    const held = tokensIn(scan).filter((t) => chosen.has(t));
    return held.length ? held : undefined;
}

/**
 * The choices that survive a new scan: the chosen tokens it still holds.
 * @param chosen the tokens chosen
 * @param scan the new scan
 * @returns `chosen` itself when nothing is dropped, so a state setter sees no change
 */
export function pruneChosen(chosen: ReadonlySet<string>, scan: TurnScan): ReadonlySet<string> {
    const held = new Set(tokensIn(scan));
    const keep = [...chosen].filter((t) => held.has(t));
    return keep.length === chosen.size ? chosen : new Set(keep);
}

/**
 * The tokens a shell relays to the worker: strings only, at most 64, or undefined. The worker reads them again and trusts
 * none of it, so this only keeps a malformed field from travelling.
 * @param v what the composer's frame posted
 */
export function cleanAsIs(v: unknown): string[] | undefined {
    if (!Array.isArray(v)) return undefined;
    const out = v.filter((t): t is string => typeof t === "string" && t.length > 0 && t.length <= 256).slice(0, 64);
    return out.length ? out : undefined;
}

/** The texts a scan is asked about, and which file each belongs to. */
export interface ScanTexts { texts: string[]; fileAt: number[] }

/**
 * The texts to scan for a box: the typed words, then each attached text file's contents (a PDF or a refused file is not
 * scanned). At most 64, which is what the worker takes.
 * @param typed what is typed
 * @param docs the box's files
 */
export function textsToScan(typed: string, docs: readonly { text?: string; data?: string; why?: string }[]): ScanTexts {
    const texts = [typed];
    const fileAt = docs.map((d) => {
        if (d.text === undefined || d.data !== undefined || d.why || texts.length >= 64) return -1;
        texts.push(d.text);
        return texts.length - 1;
    });
    return { texts, fileAt };
}

/** A stretch of a person's message: plain text, or the marker the scrub left where a registered value was. */
export type MarkPart = { text: string } | { mark: string };

/**
 * Split a person's message at its `[REDACTED:<NAME>]` markers, so a bubble can draw each as a chip. The marker is what the
 * model read in place of the value; the text of the message is not changed (the raw view shows it as it is).
 * @param text the message as stored
 * @returns the parts in order; a message with no marker is one text part
 */
export function splitMarks(text: string): MarkPart[] {
    const out: MarkPart[] = [];
    let at = 0;
    for (const m of text.matchAll(/\[REDACTED:([A-Za-z0-9_-]{1,64})\]/g)) {
        if (m.index > at) out.push({ text: text.slice(at, m.index) });
        out.push({ mark: m[1] });
        at = m.index + m[0].length;
    }
    if (at < text.length || !out.length) out.push({ text: text.slice(at) });
    return out;
}

/**
 * The names under a bubble's "Sent as is" line: each once, in order. Names only, whatever the display carried.
 * @param asIs `display.asIs`
 */
export function sentAsIsNames(asIs: unknown): string[] {
    return Array.isArray(asIs) ? [...new Set(asIs.filter((n): n is string => typeof n === "string" && n.length > 0))] : [];
}

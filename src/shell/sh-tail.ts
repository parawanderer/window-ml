// sh-tail.ts — what a detached `ml.sh` call's `tail` says: the host's `peek` answer (the last bytes of a running call's
// output) turned into the lines a model reads, with the cut the host made left out.

// Pure: no `chrome`, no host. The worker (sw-shell-call.ts) asks `peek` and hands the answer here; the text then goes
// through the secret scrub and exec's output cap like any tool output (docs/dev/shell.md, "A running call's tail").

import { bytesOf, type HostPeek, type HostPeekStream } from "./host-protocol";
import { OUTPUT_CAP } from "../contract/contract-pointers";

/** The most bytes a `peek` may ask for: the host clamps to this (PROTOCOL.md), so asking for more buys nothing. */
export const PEEK_MAX_BYTES = 512 * 1024;

/** The host's default read for a `peek` that names no size: what a tail nobody asked for requests. */
export const PEEK_DEFAULT_BYTES = 4096;

/** The characters per stream a tail the model ASKED for (`task tail`) may show, from the end. Past it the whole is stored. */
export const ASKED_TAIL_CHARS = 8192;

/**
 * How many bytes to ask `peek` for to show `lines` lines. A line of program output is rarely over 120 bytes and a
 * log line can be twice that, so 240 per line covers the usual case; a longer line shows as its last part, which is
 * what a tail is for. The first line is always cut, so one more is asked for. Clamped to the host's ceiling, and
 * never under the host's default of 4096 (a small read costs no more than a small one).
 * @param lines how many lines the model asked for
 */
export function peekBytesFor(lines: number): number {
    const n = Math.max(1, Math.floor(lines) || 1);
    return Math.min(PEEK_MAX_BYTES, Math.max(PEEK_DEFAULT_BYTES, (n + 1) * 240));
}

/**
 * The end of `b` without a UTF-8 sequence the stream has not finished yet: a lead byte whose continuations have not
 * all arrived is dropped, so the decoder is never handed half a character that this cut made.
 */
function withoutPartialTail(b: Uint8Array): Uint8Array {
    for (let back = 1; back <= Math.min(3, b.length); back++) {
        const c = b[b.length - back];
        if ((c & 0xc0) === 0x80) continue;   // a continuation: keep looking for its lead
        const need = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1;
        return need > back ? b.subarray(0, b.length - back) : b;
    }
    return b;
}

/** One stream as shown, and as the whole peeked stream: `cut` is true when the character cap shortened what is shown. */
interface StreamParts { text: string; whole: string; cut: boolean }

/**
 * One stream's lines. `label` is "stdout" or "stderr".
 * @param label the stream's name
 * @param s what `peek` answered for it
 * @param lines how many lines at most, from the end
 * @param cap the most characters of text to keep, from the end
 */
function streamText(label: string, s: HostPeekStream, lines: number, cap: number): StreamParts {
    let b = bytesOf(s.data);
    const fromStart = s.size <= b.length;
    if (b.length === 0) { const t = s.size === 0 ? `${label}: empty` : `${label} (${s.size} B so far): nothing readable`; return { text: t, whole: t, cut: false }; }
    // The host cut at a byte, not a character: drop a half character at the front when the data is not the stream's start.
    if (!fromStart) { let i = 0; while (i < b.length && i < 3 && (b[i] & 0xc0) === 0x80) i++; b = b.subarray(i); }
    b = withoutPartialTail(b);
    let text = new TextDecoder().decode(b);
    // The first line is partial when the data does not start the stream: drop it, but keep a lone fragment (a long line
    // with no newline yet) rather than say nothing.
    let note = "";
    if (!fromStart) {
        const nl = text.indexOf("\n");
        if (nl >= 0) text = text.slice(nl + 1); else note = " (start of the line cut)";
    }
    const all = text.split(/\r?\n/);
    if (all.length && all[all.length - 1] === "") all.pop();
    const kept = all.slice(-lines);
    let body = kept.join("\n");
    const cut = body.length > cap;
    if (cut) { body = `…${body.slice(-cap)}`; }
    const head = `${label} (${s.size} B so far${all.length > kept.length ? `, last ${kept.length} lines` : ""}${s.truncated ? "; passed the host's output cap, later output is not kept" : ""})${note}`;
    if (!kept.length) { const t = `${head}: no complete line yet`; return { text: t, whole: t, cut: false }; }
    return { text: `${head}:\n${body}`, whole: `${head}:\n${all.join("\n")}`, cut };
}

/**
 * What the model reads for a `peek` answer, and the whole of it: both streams, labelled, the last `lines` lines of each
 * cut to `cap` characters from the end. `whole` is every peeked line of both streams, uncut, for a value the model can
 * point at; `cut` says `text` is shorter than it. A null stdout feeds the next pipeline stage and cannot be read; an
 * empty stream says so.
 * @param p the host's answer
 * @param lines how many lines at most, per stream
 * @param cap characters per stream; exec's own output cap by default
 */
export function peekDetail(p: HostPeek, lines: number, cap: number = OUTPUT_CAP.exec.default): { text: string; whole: string; cut: boolean } {
    const n = Math.max(1, Math.floor(lines) || 1);
    const parts = [p.stdout ? streamText("stdout", p.stdout, n, cap) : { text: "stdout: feeds the next pipeline stage, not readable", whole: "stdout: feeds the next pipeline stage, not readable", cut: false }, streamText("stderr", p.stderr, n, cap)];
    return { text: parts.map((x) => x.text).join("\n"), whole: parts.map((x) => x.whole).join("\n"), cut: parts.some((x) => x.cut) };
}

/**
 * What the model reads for a `peek` answer: {@link peekDetail}'s text.
 * @param p the host's answer
 * @param lines how many lines at most, per stream
 * @param cap characters per stream; exec's own output cap by default
 */
export function peekText(p: HostPeek, lines: number, cap: number = OUTPUT_CAP.exec.default): string {
    return peekDetail(p, lines, cap).text;
}

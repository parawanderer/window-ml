// stream-close.ts — what a STREAMING reply should be drawn as right now: its text with the Markdown it has opened and
// not yet closed closed for it, and the few things that cannot be guessed held back until the next characters decide.
//
// Rendering the raw text so far flickers: `**bold` shows its asterisks until the closing pair arrives and then snaps to
// bold, a half-open code fence turns the rest of the reply into code and back, a link shows `[text](htt` for a moment.
// Closing what is open before each render draws every intermediate state as the finished reply will draw it, so the
// text only ever GROWS (Gemini does this; Vercel's `streamdown` is the same idea).
//
// What prediction cannot cover is held back, never guessed: a line that may be a table's header (until its `|---|`
// line arrives), a lone `*`/`-`/`+`/`#` at the start of a line (a bullet, a heading, or emphasis), a half-written
// image, and display math with no closing delimiter. Each is at most a line, and it appears the moment it is decided.
// An unclosed single `$` needs nothing: `markdown()` draws an unmatched `$` as text.

/** The inline markers closed for a streaming reply, longest first so `**` is never read as two `*`. */
const INLINE = ["**", "~~", "*"] as const;

/**
 * The text to draw for a reply that is still streaming: `src` with its open Markdown closed and its undecidable tail
 * held back. A finished reply is drawn from its own text, never through this.
 */
export function closeStreaming(src: string): string {
    const lines = src.split("\n");
    // A fence open at the end: everything after it is code, and closing the fence is all it needs.
    let fenceAt = -1;
    lines.forEach((l, i) => { if (/^\s*```/.test(l)) fenceAt = fenceAt < 0 ? i : -1; });
    if (fenceAt >= 0) return `${lines.slice(0, fenceAt).map(String).join("\n")}${fenceAt ? "\n" : ""}${closeFenced(lines.slice(fenceAt))}`;
    return closeProse(holdTail(lines).join("\n"));
}

/** An open fence and its code so far, closed. A fence line still being typed (` `` `) is not a fence yet. */
function closeFenced(fenced: string[]): string {
    return `${fenced.join("\n").replace(/\n$/, "")}\n\`\`\``;
}

/** Drop the trailing lines nothing can draw correctly yet. */
function holdTail(lines: string[]): string[] {
    const out = [...lines];
    const last = (): string => out[out.length - 1] ?? "";
    // A half-typed fence (` or ``) at the start of the last line: whether it opens code is one character away.
    if (/^\s*`{1,2}$/.test(last())) out.pop();
    // A lone list or heading marker: `*` may still be emphasis, `-` a rule, `#` a heading.
    if (/^\s*([*+-]|\*\*|#{1,6})$/.test(last())) out.pop();
    // A table is a table only once the line under its header is `|---|`: until then its rows are held back, or they
    // are drawn as a paragraph of pipes and then jump into a grid.
    let start = out.length;
    while (start > 0 && /^\s*\|/.test(out[start - 1])) start--;
    if (start < out.length && !(start + 1 < out.length && /^\s*\|?\s*:?-{3,}/.test(out[start + 1]))) out.length = start;
    // Display math with no closing delimiter is raw TeX until it closes.
    const text = out.join("\n");
    const dd = text.split("$$").length - 1;
    if (dd % 2) return text.slice(0, text.lastIndexOf("$$")).split("\n");
    const open = text.lastIndexOf("\\["), close = text.lastIndexOf("\\]");
    if (open > close) return text.slice(0, open).split("\n");
    return out;
}

/** Close the inline Markdown left open in the last paragraph: code spans, then emphasis, in reverse order of opening. */
function closeProse(text: string): string {
    const para = text.lastIndexOf("\n\n") + 1;
    const head = text.slice(0, para);
    let tail = text.slice(para);
    // A half-written image draws nothing useful; a half-written link draws its text, which is what it will look like.
    tail = tail.replace(/!\[[^\]]*(\]\([^)]*)?$/, "");
    tail = tail.replace(/\[([^\]]*)\]\([^)]*$/, "$1").replace(/\[([^\]]*)$/, "$1");
    const stack: string[] = [];
    let i = 0;
    while (i < tail.length) {
        const c = tail[i];
        if (c === "\\") { i += 2; continue; }
        if (c === "`") {
            const run = /^`+/.exec(tail.slice(i))![0];
            const end = tail.indexOf(run, i + run.length);
            if (end < 0) {
                // An open code span: what follows is literal, so it closes and nothing after it is emphasis.
                if (i + run.length >= tail.length) return head + closeMarkers(tail.slice(0, i), stack);
                return head + closeMarkers(`${tail}${run}`, stack, i);
            }
            i = end + run.length;
            continue;
        }
        const m = INLINE.find((k) => tail.startsWith(k, i));
        if (m) {
            if (stack[stack.length - 1] === m) stack.pop();
            else stack.push(m);
            i += m.length;
            continue;
        }
        i++;
    }
    return head + closeMarkers(tail, stack);
}

/** Append the closers for `stack`, innermost first. An opener with nothing after it yet is dropped instead: `foo **`
 *  would otherwise draw an empty bold span, or worse, four asterisks. `from` limits that check to text before it. */
function closeMarkers(text: string, stack: string[], from = text.length): string {
    let t = text;
    const open = [...stack];
    while (open.length) {
        const m = open[open.length - 1];
        const before = t.slice(0, from);
        if (from === t.length && before.endsWith(m)) { t = t.slice(0, t.length - m.length).replace(/\s+$/, ""); open.pop(); continue; }
        break;
    }
    return t + open.reverse().join("");
}

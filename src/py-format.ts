// PRETTY-PRINT PYTHON FOR THE HUMAN, never for the model.
//
// A model writes dense one-liners on purpose — `{'metric':['Grand total','Per quarter']+['Top rep: '+r]}`
// costs it fewer tokens, and that is the right trade for the thing paying per token. It is the wrong trade
// for the person reading the step, so the RENDERED view reflows it and the model's own text is left exactly
// as it was (the raw view, the export and the context all keep it).
//
// Two rules make that safe rather than a second source of truth:
//
//   1. TOKENS ARE NEVER CHANGED. This only inserts whitespace and newlines between tokens that were already
//      there. It cannot rename, reorder, drop or merge anything, so the displayed code always runs the same
//      as the code that ran. Strings and comments are copied byte-for-byte.
//   2. IT REPORTS WHAT IT DID. Reflowing moves line numbers, and a traceback's whole content is a line
//      number — so `pyFormat` returns a MAP from the original line to the displayed one. A renderer that
//      shows reformatted code and an unmapped traceback is worse than one that does not reformat at all.
//
// And when it does not understand something, it returns the input unchanged with an identity map. A
// formatter that is wrong is worse than one that declines: the reader would be looking at code that is not
// what ran, with no way to tell.

export interface PyFormatted {
    /** The reflowed source. Identical to the input when nothing could be improved (or understood). */
    text: string;
    /** Original 1-based line → displayed 1-based line. A logical line broken across several displayed lines
     *  maps every one of its original lines to where that statement STARTS, which is the line a traceback
     *  means for a multi-line statement anyway. */
    map: number[];
    /** Whether anything actually moved. A caveat on an unchanged line ("this may have looked different") is
     *  noise that undermines the times it is true, so surfaces check per line, not per file. */
    changed: boolean;
}

type Tok = { kind: "str" | "comment" | "op" | "word" | "space" | "nl"; text: string; line: number };

const OPEN = "([{", CLOSE = ")]}";
const CLOSER: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/** Split Python into tokens. Only enough structure to know what must not be touched (strings, comments) and
 *  where the brackets are — this is not a parser and does not need to be. Returns null on anything it cannot
 *  account for, which is the signal to leave the source alone. */
export function tokenizePy(src: string): Tok[] | null {
    const toks: Tok[] = [];
    let i = 0, line = 1;
    const push = (kind: Tok["kind"], text: string) => { toks.push({ kind, text, line }); };
    while (i < src.length) {
        const c = src[i];
        if (c === "\n") { push("nl", "\n"); i++; line++; continue; }
        if (c === " " || c === "\t" || c === "\r") {
            let j = i; while (j < src.length && (src[j] === " " || src[j] === "\t" || src[j] === "\r")) j++;
            push("space", src.slice(i, j)); i = j; continue;
        }
        if (c === "#") {
            let j = i; while (j < src.length && src[j] !== "\n") j++;
            push("comment", src.slice(i, j)); i = j; continue;
        }
        // A string, with any prefix (r, b, f, rb, …). The prefix is part of the token so nothing can be
        // inserted between it and the quote.
        const m = /^(?:[rRbBuUfF]{0,3})?('''|"""|'|")/.exec(src.slice(i));
        if (m && /^[rRbBuUfF]*$/.test(m[0].slice(0, m[0].length - m[1].length))) {
            const q = m[1], start = i;
            let j = i + m[0].length;
            for (;;) {
                if (j >= src.length) return null;                 // unterminated: not ours to guess at
                if (src[j] === "\\") { j += 2; continue; }
                if (src.startsWith(q, j)) { j += q.length; break; }
                if (src[j] === "\n" && q.length === 1) return null;  // a single-quoted string cannot span lines
                if (src[j] === "\n") line++;
                j++;
            }
            const text = src.slice(start, j);
            // A triple-quoted string carries its own newlines; record the line it STARTED on.
            toks.push({ kind: "str", text, line: line - (text.match(/\n/g)?.length ?? 0) });
            i = j; continue;
        }
        if (/[A-Za-z_À-￿0-9.]/.test(c)) {
            let j = i; while (j < src.length && /[A-Za-z_À-￿0-9.]/.test(src[j])) j++;
            push("word", src.slice(i, j)); i = j; continue;
        }
        push("op", c); i++; continue;
    }
    return toks;
}

/** One logical line: the tokens of a statement, however many physical lines it spanned. */
interface Logical { toks: Tok[]; indent: string; lines: number[] }

/** Group tokens into logical lines. A newline inside brackets continues the statement, which is exactly what
 *  a model's wrapped dict literal is, and joining those is what lets it be re-broken sensibly. */
function logicalLines(toks: Tok[]): Logical[] {
    const out: Logical[] = [];
    let cur: Tok[] = [], depth = 0, lines = new Set<number>();
    const flush = () => {
        if (!cur.length) { cur = []; lines = new Set(); return; }
        const indent = cur[0].kind === "space" ? cur[0].text : "";
        out.push({ toks: cur[0].kind === "space" ? cur.slice(1) : cur, indent, lines: [...lines].sort((a, b) => a - b) });
        cur = []; lines = new Set();
    };
    for (const t of toks) {
        if (t.kind === "nl") {
            // A newline ENDS a statement; it does not also add a blank one. Emitting both put an empty line
            // between every pair of statements, which is the formatter rewriting the author's paragraphing.
            if (depth === 0) { const had = cur.some((x) => x.kind !== "space"); flush(); if (!had) out.push({ toks: [], indent: "", lines: [] }); continue; }
            continue;   // inside brackets a newline is not a statement boundary
        }
        if (t.kind === "op" && OPEN.includes(t.text)) depth++;
        if (t.kind === "op" && CLOSE.includes(t.text)) depth = Math.max(0, depth - 1);
        lines.add(t.line);
        cur.push(t);
    }
    flush();
    return out;
}

/** Render tokens back to one line, with PEP8-ish spacing. Whitespace only — every token is emitted verbatim,
 *  in order. `,` gets a following space; a dict `:` does too. A `:` inside `[]` is left ALONE, because a
 *  slice (`a[1:2]`) and an annotation look identical without a parser and PEP8 wants them spaced
 *  differently — leaving it is always correct, spacing it sometimes is not. Keyword `=` stays tight, which
 *  is what PEP8 asks for and what the model already writes. */
function joinToks(toks: Tok[], enclosing: string[] = []): string {
    let out = "";
    const stack: string[] = [...enclosing];
    for (let k = 0; k < toks.length; k++) {
        const t = toks[k];
        if (t.kind === "space") continue;                          // re-derived below, never carried over
        if (t.kind === "op" && OPEN.includes(t.text)) stack.push(t.text);
        const prev = toks[k - 1];
        const next = toks.slice(k + 1).find((x) => x.kind !== "space");
        // Re-insert exactly one space where the source had any, so `a  +  b` normalises but `a+b` is not
        // pulled apart — this is a reflow, not a restyle.
        const prevReal = toks.slice(0, k).reverse().find((x) => x.kind !== "space");
        const afterSep = prevReal?.kind === "op" && (prevReal.text === "," || (prevReal.text === ":" && out.endsWith(": ")));
        if (out && prev?.kind === "space" && !afterSep
            && !(t.kind === "op" && (CLOSE.includes(t.text) || t.text === "," || t.text === ":"))) out += " ";
        out += t.text;
        if (t.kind === "op" && CLOSE.includes(t.text)) stack.pop();
        if (t.kind === "op" && t.text === "," && next && !(next.kind === "op" && CLOSE.includes(next.text))) out += " ";
        if (t.kind === "op" && t.text === ":" && stack[stack.length - 1] === "{" && next) out += " ";
    }
    return out;
}

/** The top-level comma positions inside the bracket group that starts at `open` (an index into `toks`), plus
 *  the index of its matching close. Null when the group never closes, which means we did not understand the
 *  line and must not touch it. */
function groupSplits(toks: Tok[], open: number): { commas: number[]; close: number } | null {
    let depth = 0;
    const commas: number[] = [];
    for (let k = open; k < toks.length; k++) {
        const t = toks[k];
        if (t.kind !== "op") continue;
        if (OPEN.includes(t.text)) { depth++; continue; }
        if (CLOSE.includes(t.text)) {
            depth--;
            if (depth === 0) return { commas, close: k };
            continue;
        }
        if (t.text === "," && depth === 1) commas.push(k);
    }
    return null;
}

/** Break one logical line across several, at the top-level separators of the WIDEST bracket group it has.
 *  Recurses into an element that is still too long, so a dict of lists opens out rather than trading one
 *  over-long line for another. Returns a single line when it does not help. */
function breakLine(toks: Tok[], indent: string, width: number, depth = 0, enclosing: string[] = []): string[] {
    const oneLine = indent + joinToks(toks, enclosing);
    if (oneLine.length <= width || depth > 4) return [oneLine];
    // The group worth breaking is the OUTERMOST one with separators in it — breaking an inner group first
    // leaves the outer one just as long, with the inner one's pieces stranded on it.
    let best: { open: number; close: number; commas: number[] } | null = null;
    for (let k = 0; k < toks.length; k++) {
        const t = toks[k];
        if (t.kind !== "op" || !OPEN.includes(t.text)) continue;
        const g = groupSplits(toks, k);
        if (!g) return [oneLine];                       // unbalanced: leave it exactly as it was
        if (g.commas.length) { best = { open: k, ...g }; break; }
        // NO separators here — but there may be some INSIDE it. `pd.DataFrame({...})` is one argument, so
        // skipping past the call left the dict it wraps on a single 180-character line. Keep scanning.
    }
    if (!best) return [oneLine];
    const inner = indent + "    ";
    const open = toks[best.open].text;
    const head = indent + joinToks(toks.slice(0, best.open + 1), enclosing);
    const tail = indent + joinToks(toks.slice(best.close), enclosing);
    const out = [head];
    // Element BOUNDARIES, not comma positions: a slice that still contained its own separator got a second
    // one appended and rendered as `'Rep', ,`.
    const starts = [best.open + 1, ...best.commas.map((c) => c + 1)];
    const ends = [...best.commas, best.close];
    for (let e = 0; e < starts.length; e++) {
        const slice = toks.slice(starts[e], ends[e]);
        if (!slice.filter((t) => t.kind !== "space").length) continue;
        // The separator rides on the element it follows, the way a person writes it.
        const withComma = e < starts.length - 1 ? [...slice, { kind: "op", text: ",", line: slice[0].line } as Tok] : slice;
        // The element is INSIDE this bracket, and a dict's `:` only spaces when the join knows that.
        out.push(...breakLine(withComma, inner, width, depth + 1, [...enclosing, open]));
    }
    out.push(tail);
    return out;
}

/** Reflow Python for display, with a map back to the original line numbers.
 *
 *  `width` is where a line is considered worth breaking. Deliberately generous: this is for a panel, not a
 *  style guide, and re-breaking a line that was readable would move numbers for nothing. */
export function pyFormat(src: string, { width = 88 }: { width?: number } = {}): PyFormatted {
    // ONE-BASED, like every line number in a traceback and like the map built below. Built from a 0-indexed
    // `map()` it was off by one, so declining to format — the safe path — silently mis-mapped every line.
    const identity = (): PyFormatted => {
        const map: number[] = [];
        for (let n = 1; n <= src.split("\n").length; n++) map[n] = n;
        return { text: src, map, changed: false };
    };
    const toks = tokenizePy(src);
    if (!toks) return identity();
    // A bracket that never closes makes every following line part of one logical line, which JOINS them —
    // `b = f(1, 2` + `c = 3` came out as `b = f(1, 2c = 3`, which is not the user's program. Nothing here is
    // salvageable by guessing where the author meant to close it, so decline.
    let depth = 0;
    for (const t of toks) {
        if (t.kind !== "op") continue;
        if (OPEN.includes(t.text)) depth++;
        else if (CLOSE.includes(t.text)) depth--;
        if (depth < 0) return identity();
    }
    if (depth !== 0) return identity();
    let logicals: Logical[];
    try { logicals = logicalLines(toks); } catch { return identity(); }

    const outLines: string[] = [];
    const map: number[] = [];
    for (const lg of logicals) {
        const at = outLines.length + 1;
        if (!lg.toks.length) { outLines.push(""); continue; }
        // A comment-only line, or a line ending in one, is emitted verbatim: a comment can say anything and
        // re-wrapping around it is how a formatter changes what code means.
        const hasComment = lg.toks.some((t) => t.kind === "comment");
        const lines = hasComment
            ? [lg.indent + joinToks(lg.toks.filter((t) => t.kind !== "comment")) +
               (lg.toks.filter((t) => t.kind === "comment").map((t) => `  ${t.text}`).join(""))]
            : breakLine(lg.toks, lg.indent, width);
        // A triple-quoted string carries its own newlines, so the tokens it sits in cannot be re-joined onto
        // one line without changing the string. Leave the whole statement alone.
        if (lg.toks.some((t) => t.kind === "str" && t.text.includes("\n"))) {
            // The statement's real extent, which its TOKENS do not give: only the line a multi-line string
            // STARTS on is recorded, so slicing by the recorded lines took the first line and dropped the
            // rest of the string — silently truncating the code being displayed.
            const span = lg.toks.reduce((n, t) => n + (t.text.match(/\n/g)?.length ?? 0), 0);
            const from = lg.lines[0], to = Math.max(lg.lines[lg.lines.length - 1], from + span);
            for (let n = from; n <= to; n++) map[n] = at + (n - from);
            outLines.push(...src.split("\n").slice(from - 1, to));
            continue;
        }
        for (const n of lg.lines) map[n] = at;
        outLines.push(...lines);
    }
    // Line 0 does not exist; fill any gap so a lookup never returns undefined for a line that was in the
    // source (a blank line inside a bracketed continuation has no tokens and so no entry).
    for (let n = 1; n <= src.split("\n").length; n++) if (!map[n]) map[n] = map[n - 1] || 1;
    // A trailing newline is part of the file, not a blank statement: the last logical line of a file that
    // ends in one is empty, and joining it back produced a file with no final newline at all.
    while (outLines.length && outLines[outLines.length - 1] === "") outLines.pop();
    const text = outLines.join("\n") + (src.endsWith("\n") ? "\n" : "");
    return { text, map, changed: text !== src };
}

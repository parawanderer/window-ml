// replace-size.ts — how many characters a String `replace` will build, counted before the host builds it: the dialect's
// evaluator and the pipe's `sed` both refuse a replace over their limit before it allocates, not after.

/** A replacement's special patterns, `$$` included: `$&`, `` $` ``, `$'`, `$n`, `$nn` and `$<name>` each insert text from
 *  the receiver at every match, so a two-character replacement builds output quadratic in its receiver
 *  (`"a".repeat(n).replace(/a/g, "$'")` is n²/2 characters). */
const REPLACEMENT_REF = /\$(?:\$|[&`']|\d{1,2}|<[^>]*>)/g;

/** A replacement as the characters it always adds (a `$$` adds one `$`) and the references that insert text. */
function replacementParts(text: string): { literal: number; refs: string[] } {
    let literal = text.length;
    const refs: string[] = [];
    for (const [t] of text.matchAll(REPLACEMENT_REF)) {
        literal -= t === "$$" ? 1 : t.length;
        if (t !== "$$") refs.push(t);
    }
    return { literal, refs };
}

/** What a `$n`, `$nn` or `$<name>` inserts at match `m` (null for a string pattern, which has no groups), as the spec's
 *  GetSubstitution reads it: `$nn` names a group when there are that many, else `$n` does and the second digit is
 *  text; a number that names no group, or a `$<name>` where the pattern has no named groups, is its own text. */
function inserted(t: string, m: RegExpExecArray | null): number {
    const groups = m ? m.length - 1 : 0;
    if (t[1] === "<") return m?.groups === undefined ? t.length : (m.groups[t.slice(2, -1)]?.length ?? 0);
    const group = (i: number): number => m?.[i]?.length ?? 0;
    if (t.length === 3) {
        const nn = Number(t.slice(1));
        if (nn >= 1 && nn <= groups) return group(nn);
    }
    const d = Number(t[1]);
    if (d >= 1 && d <= groups) return group(d) + t.length - 2;
    return t.length;
}

/** The most a replace over `n` characters can build, with no search: every one of n + 1 matches (one when not global)
 *  empty, and every reference inserting the whole receiver. Cheap, and loose; {@link replaceSize} measures it. */
export function replaceWorstCase(n: number, text: string, global: boolean): number {
    const { literal, refs } = replacementParts(text);
    return n + (global ? n + 1 : 1) * (literal + refs.length * n);
}

/**
 * The size a replace builds, found match by match: the receiver, less each match, plus the replacement with each
 * reference counted at what it inserts there (`$&` the match, `` $` `` what precedes it, `$'` what follows it, a `$n`,
 * `$nn` or `$<name>` its capture, read as GetSubstitution reads it: its own text when it names no group). Exact.
 *
 * Counted as a running total, the size of what the host has built so far plus the rest of the receiver. That total
 * is NOT a lower bound of the result (a later match takes its own length out of the rest, and a `$'` that inserted the
 * tail at every match ends up smaller than it peaked: 16 `a` through `s/a/$'/g` peaked at 121 and built 120), so it
 * cannot decide the count on its own. Counting stops only when what is BUILT so far, without the rest, is over
 * `limit`: every later match adds at least nothing to that, so the result is over it too. Otherwise the count runs to
 * the last match, and `size` is the result's own length, over `limit` exactly when the host's result would be.
 * `matches` is how many were read, for the caller to charge.
 *
 * @param str the receiver
 * @param pattern the RegExp as the host would run it (its flags and, for a sticky one, its `lastIndex`), or a string
 * @param text the replacement
 * @param global every match (a `g` RegExp, `replaceAll`), or only the first
 * @param limit the size past which the replace is refused; counting stops once the result is certain to pass it
 */
export function replaceSize(str: string, pattern: RegExp | string, text: string, global: boolean, limit: number): { size: number; matches: number } {
    const { literal, refs } = replacementParts(text);
    const n = str.length;
    let size = n, matches = 0;
    const at = (index: number, len: number, m: RegExpExecArray | null): boolean => {
        matches++;
        size += literal - len;
        for (const t of refs) size += t === "$&" ? len : t === "$`" ? index : t === "$'" ? n - index - len : inserted(t, m);
        return !global || size - (n - index - len) > limit;
    };
    if (typeof pattern === "string") {
        // An empty pattern matches at every position, 0 to n. Found by indexOf it never ends: past the end,
        // `indexOf("", k)` answers n rather than -1.
        if (pattern === "") { for (let i = 0; i <= n; i++) if (at(i, 0, null)) break; return { size, matches }; }
        for (let i = str.indexOf(pattern); i !== -1; i = str.indexOf(pattern, i + pattern.length)) if (at(i, pattern.length, null)) break;
        return { size, matches };
    }
    const re = new RegExp(pattern.source, pattern.flags);
    if (re.sticky && !re.global) re.lastIndex = pattern.lastIndex;
    if (!global) {
        const m = re.exec(str);
        if (m) at(m.index, m[0].length, m);
        return { size, matches };
    }
    for (const m of str.matchAll(re)) if (at(m.index ?? 0, m[0].length, m as RegExpExecArray)) break;
    return { size, matches };
}

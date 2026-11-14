// md-fence.ts — fenced code blocks the way CommonMark reads them: opened by three or more backticks or tildes, closed by a line of the same character at least as long.

/** An opening fence line: up to three spaces of indent, then 3+ backticks (no backtick in the info string) or 3+ tildes. */
const OPEN = /^( {0,3})(`{3,}(?=[^`]*$)|~{3,})(.*)$/;

/** The fence a line opens, or null: its character, its length and the language word of its info string. */
export function openingFence(line: string): { ch: "`" | "~"; n: number; lang: string } | null {
    const m = OPEN.exec(line);
    return m ? { ch: m[2][0] as "`" | "~", n: m[2].length, lang: m[3].trim().split(/\s+/)[0] ?? "" } : null;
}

/** Does `line` close a fence of `ch` × `n`: the same character, at least as many, and nothing else on the line. */
export function closesFence(line: string, ch: string, n: number): boolean {
    const m = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
    return !!m && m[1][0] === ch && m[1].length >= n;
}

/** The fence still OPEN at the end of `lines` (a streaming reply cut mid-block): where it began and what opened it. */
export function openFenceAt(lines: string[]): { at: number; ch: "`" | "~"; n: number; lang: string } | null {
    let cur: { at: number; ch: "`" | "~"; n: number; lang: string } | null = null;
    lines.forEach((l, i) => {
        if (cur) { if (closesFence(l, cur.ch, cur.n)) cur = null; return; }
        const o = openingFence(l);
        if (o) cur = { at: i, ...o };
    });
    return cur;
}

/** `src` with each fenced block replaced by `fn(lang, code)`. A fence never closed runs to the end, as CommonMark reads it;
 *  text outside the fences is returned unchanged for the caller's own passes. */
export function replaceFences(src: string, fn: (lang: string, code: string) => string): string {
    const lines = src.split("\n");
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        const o = openingFence(lines[i]);
        if (!o) { out.push(lines[i]); continue; }
        let j = i + 1;
        while (j < lines.length && !closesFence(lines[j], o.ch, o.n)) j++;
        out.push(fn(o.lang, lines.slice(i + 1, j).join("\n")));
        i = j;
    }
    return out.join("\n");
}

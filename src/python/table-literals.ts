// table-literals.ts — the `ml.table("…")` sources a Python cell names as literals: what a card hoists and a page reads
// before the cell (docs/spec/ML_TABLE.md, "A literal scan only hoists").

import { tokenizePy } from "./py-format";

/** One `ml.table` call whose source is a string literal, with the options it gave as literals. */
export interface TableLiteral {
    src: string;
    opts: { raw?: boolean; delimiter?: string; header?: boolean };
}

/** The most literals one cell hoists: a page reads each before the cell, so a cell cannot make it read without end. */
export const TABLE_LITERALS_MAX = 32;

/**
 * A Python string literal's value, or null when it is not one this scan reads: an f-string or bytes (a source is text
 * the code fixed), or an escape other than `\\`, `\'`, `\"`, `\n` and `\t`.
 * @param text the token, prefix and quotes included
 */
function literalValue(text: string): string | null {
    const m = /^([rRuU]?)('''|"""|'|")([\s\S]*)\2$/.exec(text);
    if (!m) return null;
    if (/^[rR]$/.test(m[1])) return m[3];
    let ok = true;
    const v = m[3].replace(/\\([\s\S])/g, (_, c: string) => {
        const e = ({ "\\": "\\", "'": "'", '"': '"', n: "\n", t: "\t" } as Record<string, string>)[c];
        if (e === undefined) ok = false;
        return e ?? "";
    });
    return ok ? v : null;
}

/**
 * Every `ml.table(<literal>…)` in a cell, in source order, each once. Only the call spelled `ml.table`, with a single
 * string literal as its first argument, is read; its `raw`, `delimiter` and `header` keywords are kept when each is a
 * literal, and a call with any other argument keeps none, so its read is a default one. A call in a comment or inside a
 * string is not a call and is not read; one in a branch that never runs is read and unused. Code the tokenizer cannot
 * account for (an unterminated string) yields none.
 * @param code the cell
 * @returns the literals, at most {@link TABLE_LITERALS_MAX}
 */
export function tableLiterals(code: string): TableLiteral[] {
    const toks = tokenizePy(String(code ?? ""))?.filter((t) => t.kind !== "space" && t.kind !== "nl" && t.kind !== "comment");
    if (!toks) return [];
    const out: TableLiteral[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < toks.length && out.length < TABLE_LITERALS_MAX; i++) {
        // `ml.table` is one word token; `x.ml.table` and `ml.table.x` are other words.
        if (toks[i].kind !== "word" || toks[i].text !== "ml.table" || toks[i + 1]?.text !== "(" || toks[i + 2]?.kind !== "str") continue;
        const src = literalValue(toks[i + 2].text);
        const after = toks[i + 3]?.text;
        if (src === null || (after !== "," && after !== ")")) continue;
        const opts: TableLiteral["opts"] = {};
        let j = i + 3, plain = true;
        while (toks[j]?.text === ",") {
            const k = toks[j + 1], eq = toks[j + 2], v = toks[j + 3];
            if (k?.text === ")") { j++; break; }
            if (k?.kind !== "word" || eq?.text !== "=" || !v) { plain = false; break; }
            const lit = v.kind === "str" ? literalValue(v.text) : v.text === "True" ? true : v.text === "False" ? false : v.text === "None" ? null : undefined;
            if (lit === undefined || !(toks[j + 4]?.text === "," || toks[j + 4]?.text === ")")) { plain = false; break; }
            if (k.text === "raw" && typeof lit === "boolean") opts.raw = lit;
            else if (k.text === "delimiter" && typeof lit === "string") opts.delimiter = lit;
            else if (k.text === "header" && typeof lit === "boolean") opts.header = lit;
            else if (!((k.text === "delimiter" || k.text === "header") && lit === null)) { plain = false; break; }
            j += 4;
        }
        if (plain && toks[j]?.text !== ")") plain = false;
        const lit: TableLiteral = { src, opts: plain ? opts : {} };
        if (lit.opts.raw === false) delete lit.opts.raw;
        const key = JSON.stringify([lit.src, lit.opts]);
        if (!seen.has(key)) { seen.add(key); out.push(lit); }
    }
    return out;
}

/**
 * The sentence for a `python_exec` call that still passes `tables` or `tableRaw`, which went with ML_TABLE.md: a run
 * resumed from before it, or a model that learned the old shape. Null when the call passes neither.
 * @param args the call's arguments
 */
export function staleTableArgs(args: Record<string, unknown> | undefined): string | null {
    const given = ["tables", "tableRaw"].filter((k) => args?.[k] !== undefined);
    if (!given.length) return null;
    return `Error: python_exec has no ${given.map((k) => `\`${k}\``).join(" or ")} argument. Read each table in the code instead: \`df = ml.table("<source>")\` (add \`raw=True\` to keep every cell a string), with the same sources \`tables\` took. Nothing ran.`;
}

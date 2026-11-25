// code-diff.tsx — a diff's rows as the panel draws them: a two-column gutter (old line, new line), the +/− sign and the
// highlighted text, one `.dline` per row and an elision for a run of unchanged ones. The retry diff above a revised
// code block uses it (render-panel.tsx `CodeDiff`), and so does a page with no panel (the bench's Spec card).

import type { DiffRow } from "../diff";
import { highlight } from "./format";
import { linkifyHtml, codeLinkHandlers, type CodeLinks } from "./code-links";

/** One diff row's text as highlighted HTML, with its links cut out when the surface lends them. */
const rowHtml = (text: string, lang: string | undefined, links?: CodeLinks): string => {
    const h = highlight(text, lang);
    return (links ? linkifyHtml(h, (id) => !!links.step(id)) : h) || "&nbsp;";
};

/**
 * The rows of a diff (diff.ts `codeDiff`), highlighted as `lang`. With `numbers` the gutter carries both line numbers,
 * and a row that exists on one side only leaves the other column blank, which is exactly the claim it makes. `class`
 * is added to the `pre`, for the surface's own frame. It is a code block's `pre.code`, so it draws on the code theme's
 * surface wherever it appears, as the block beside it does.
 */
export function DiffLines({ rows, lang, numbers = true, class: cls = "", links }: { rows: DiffRow[]; lang?: string; numbers?: boolean; class?: string; links?: CodeLinks }) {
    return (
        <pre class={`code dlines${cls ? ` ${cls}` : ""}${numbers ? " numbered" : ""}`}><code class="hljs" {...(links ? codeLinkHandlers(links) : {})}>{rows.map((r, i) => r.kind === "gap"
            ? <span class="dline dline-gap" key={i}>{numbers ? <><span class="dno" /><span class="dno" /></> : null}<span class="dsign" />
                <span class="dtext">{`⋮ ${r.skipped} unchanged line${r.skipped === 1 ? "" : "s"}`}</span>{"\n"}</span>
            : <span class={`dline dline-${r.kind}`} key={i}>
                {numbers ? <>
                    <span class="dno">{r.kind === "add" ? "" : r.a}</span>
                    <span class="dno">{r.kind === "del" ? "" : r.b}</span>
                </> : null}
                <span class="dsign">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "}</span>
                <span class="dtext" dangerouslySetInnerHTML={{ __html: rowHtml(r.text, lang, links) }} />
                {"\n"}
            </span>)}</code></pre>
    );
}

/** One row of a SPLIT diff: the old side and the new side of the same row, or `null` where that side has a blank filler. A gap spans both. */
export type SplitRow =
    | { kind: "pair"; same: boolean; old: { text: string; a: number } | null; new: { text: string; b: number } | null }
    | { kind: "gap"; skipped: number };

/**
 * Turn a diff's rows into SPLIT rows, aligned the way an editor's side-by-side view is. An unchanged line sits on both
 * sides; a run of removed lines followed by added ones is paired off row for row (the replaced line is the old one
 * opposite the new one), and whichever side is shorter gets blank fillers, so the two columns always have the same
 * number of rows and a row reads straight across.
 */
export function splitRows(rows: DiffRow[]): SplitRow[] {
    const out: SplitRow[] = [];
    let dels: { text: string; a: number }[] = [], adds: { text: string; b: number }[] = [];
    const flush = (): void => {
        const n = Math.max(dels.length, adds.length);
        for (let i = 0; i < n; i++) out.push({ kind: "pair", same: false, old: dels[i] ?? null, new: adds[i] ?? null });
        dels = []; adds = [];
    };
    for (const r of rows) {
        if (r.kind === "del") dels.push({ text: r.text, a: r.a });
        else if (r.kind === "add") adds.push({ text: r.text, b: r.b });
        else {
            flush();
            out.push(r.kind === "gap" ? r : { kind: "pair", same: true, old: { text: r.text, a: r.a }, new: { text: r.text, b: r.b } });
        }
    }
    flush();
    return out;
}

/**
 * A diff drawn as TWO COLUMNS, old on the left and new on the right, aligned row for row with blank filler rows on the
 * shorter side. The same surface, gutter and highlighting as `DiffLines`; it needs the width of two code columns, so a
 * caller below that width draws `DiffLines` instead.
 */
export function SplitLines({ rows, lang, numbers = true, class: cls = "", links }: { rows: DiffRow[]; lang?: string; numbers?: boolean; class?: string; links?: CodeLinks }) {
    const cell = (side: "old" | "new", same: boolean, c: { text: string; a?: number; b?: number } | null) => c === null
        ? <span class={`scell scell-${side} scell-fill`} aria-hidden="true">{numbers ? <span class="dno" /> : null}<span class="dsign" /><span class="dtext" /></span>
        : <span class={`scell scell-${side}${same ? "" : side === "old" ? " scell-del" : " scell-add"}`}>
            {numbers ? <span class="dno">{side === "old" ? c.a : c.b}</span> : null}
            <span class="dsign">{same ? " " : side === "old" ? "−" : "+"}</span>
            <span class="dtext" dangerouslySetInnerHTML={{ __html: rowHtml(c.text, lang, links) }} />
        </span>;
    return (
        <pre class={`code dlines dsplit${cls ? ` ${cls}` : ""}${numbers ? " numbered" : ""}`}><code class="hljs" {...(links ? codeLinkHandlers(links) : {})}>{splitRows(rows).map((r, i) => r.kind === "gap"
            ? <span class="sline sline-gap" key={i}>{`⋮ ${r.skipped} unchanged line${r.skipped === 1 ? "" : "s"}`}{"\n"}</span>
            : <span class="sline" key={i}>
                {cell("old", r.same, r.old)}{cell("new", r.same, r.new)}
                {"\n"}
            </span>)}</code></pre>
    );
}

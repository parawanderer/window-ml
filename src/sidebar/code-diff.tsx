// code-diff.tsx — a diff's rows as the panel draws them: a two-column gutter (old line, new line), the +/− sign and the
// highlighted text, one `.dline` per row and an elision for a run of unchanged ones. The retry diff above a revised
// code block uses it (render-panel.tsx `CodeDiff`), and so does a page with no panel (the bench's Spec card).

import type { DiffRow } from "../diff";
import { highlight } from "./format";

/**
 * The rows of a diff (diff.ts `codeDiff`), highlighted as `lang`. With `numbers` the gutter carries both line numbers,
 * and a row that exists on one side only leaves the other column blank, which is exactly the claim it makes. `class`
 * is added to the `pre`, for the surface's own frame. It is a code block's `pre.code`, so it draws on the code theme's
 * surface wherever it appears, as the block beside it does.
 */
export function DiffLines({ rows, lang, numbers = true, class: cls = "" }: { rows: DiffRow[]; lang?: string; numbers?: boolean; class?: string }) {
    return (
        <pre class={`code dlines${cls ? ` ${cls}` : ""}${numbers ? " numbered" : ""}`}><code class="hljs">{rows.map((r, i) => r.kind === "gap"
            ? <span class="dline dline-gap" key={i}>{numbers ? <><span class="dno" /><span class="dno" /></> : null}<span class="dsign" />
                <span class="dtext">{`⋮ ${r.skipped} unchanged line${r.skipped === 1 ? "" : "s"}`}</span>{"\n"}</span>
            : <span class={`dline dline-${r.kind}`} key={i}>
                {numbers ? <>
                    <span class="dno">{r.kind === "add" ? "" : r.a}</span>
                    <span class="dno">{r.kind === "del" ? "" : r.b}</span>
                </> : null}
                <span class="dsign">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "}</span>
                <span class="dtext" dangerouslySetInnerHTML={{ __html: highlight(r.text, lang) || "&nbsp;" }} />
                {"\n"}
            </span>)}</code></pre>
    );
}

// code-block.tsx — a code block as the panel draws one: highlighted (highlight() returns safe token HTML), `format`
// beautifying JS first (exec source), numbered, marked and annotated. Apart from ui-kit so a page with no panel (the
// bench's) draws the same block; ui-kit's `Code` passes in the panel's line-number setting and cursor tooltip.

import { useMemo, useEffect } from "preact/hooks";
import { lineMapBetween } from "../line-map";
import { highlight, beautifyJs, htmlLines, mdInline } from "./format";
import { useCopy } from "./copy-hash";
import { IconCopy, IconCheck } from "./icons";

/** A span of `text` that was substituted for something the author did not write, with the original for a
 *  tooltip — `exec`'s expanded pointer macros. */
export interface CodeMark { start: number; end: number; from: string }

/**
 * Highlight `text`, wrapping each marked range so a reader can see WHICH part is not what was typed and
 * hover it for the original.
 *
 * Segment-by-segment rather than post-processing the highlighted HTML, because highlighting rewrites the
 * string and the offsets no longer index it. That is safe here for a specific reason: the macro never
 * expands inside a string or a comment, so every boundary falls at a token boundary and no segment can cut
 * a literal in half.
 *
 * Beautification is skipped when there are marks, for the same offset reason — reformatting moves
 * everything after the first change. Losing it costs a little on code a model wrote (usually already
 * formatted); guessing at shifted offsets would underline the wrong text, which is worse than plain.
 */
function markedHtml(text: string, lang: string | undefined, marks: CodeMark[]): string {
    const ordered = [...marks].filter(m => m.start >= 0 && m.end <= text.length && m.end > m.start).sort((a, b) => a.start - b.start);
    let out = "", at = 0;
    for (const m of ordered) {
        if (m.start < at) continue;   // overlapping marks: keep the first, never emit crossed spans
        out += highlight(text.slice(at, m.start), lang);
        // The panel's own tooltip, not the browser's `title`: a native tooltip cannot render the pointer as
        // code, waits half a second before appearing, and looks like an OS artefact rather than part of the
        // panel. `.tt-pop` is display:none and read into the floating layer on hover (see .tt-layer), so its
        // prose is never selected along with the code it annotates.
        out += `<span class="tt tt-code expanded">`
            // `wrap`, because a pointer is exactly the unbreakable long token the nowrap default clips: a
            // generated remote tool name reaches 40 characters, and the end of it is the part you hovered for.
            + `<span class="tt-pop wrap">Expanded from <code>${escapeAttr(m.from)}</code></span>`
            + `${highlight(text.slice(m.start, m.end), lang)}</span>`;
        at = m.end;
    }
    return out + highlight(text.slice(at), lang);
}

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The text a `Code` block will actually DRAW. Exported because the annotator has to number the same
 *  lines the reader sees: JS is beautified inside the component, so a caller reasoning about line numbers
 *  cannot get them from the text it passed in. */
export const displaySource = (text: string, lang?: string, format?: boolean, marks?: CodeMark[]): string =>
    format && !marks?.length && (lang === "javascript" || lang === "js") ? beautifyJs(text) : text;

/** The props `Code` and `CodeBlock` share: the source and how to mark it. */
export interface CodeProps { text: string; lang?: string; format?: boolean; marks?: CodeMark[]; lineIds?: string; markLine?: number | null; markTitle?: string; notes?: Map<number, string>; onMap?: (map: number[] | null) => void }

/** A CODE BLOCK — syntax-highlighted, optionally line-numbered, and the one place a line can be MARKED
 *  (a failure), ANNOTATED (a margin note from `explain`), or pointed at from elsewhere (`lineIds` makes
 *  each row addressable). Beautifies JS itself and hands back the line MAP through `onMap`, because
 *  reformatting moves line numbers and a stack trace's whole content is a line number.
 *
 *  Everything the panel's setting and tooltip decide comes in as props (`lineNumbers`, `markTip`), so a page with no
 *  panel draws the same block; `Code` is the panel's, with both filled in. */
export const CodeBlock = ({ text, lang, format, marks, lineIds, markLine, markTitle, notes, onMap, lineNumbers = false, markTip }: CodeProps & { lineNumbers?: boolean; markTip?: (text: string) => Record<string, unknown> }) => {
    const src = displaySource(text, lang, format, marks);
    // BEAUTIFYING MOVES LINE NUMBERS, and js-beautify hands back no map — so one is derived from the two
    // texts (see line-map.ts). Without it a JS stack trace read against this block names a line that has
    // since moved, which is the same silent disagreement the Python side had.
    const lineMap = useMemo(() => (src === text ? null : lineMapBetween(text, src)), [text, src]);
    useEffect(() => { onMap?.(lineMap); }, [lineMap, onMap]);
    // An expansion is a single call and never contains a newline, so a marked span cannot straddle one —
    // which is what lets the line-number path below split this HTML as it always has.
    const html = marks?.length ? markedHtml(src, lang, marks) : highlight(src, lang);
    // The per-line form is also used when a line is being POINTED AT: you cannot mark a line in a block that
    // has no lines, and a traceback saying "line 3" with nothing numbered leaves the reader counting. So a
    // `markLine` turns the gutter on for that block regardless of the preference — the preference is about
    // wanting numbers in general, not about wanting them withheld when something is referring to one.
    // Notes turn the gutter on for the same reason a `markLine` does: a margin note is keyed to a line,
    // and a line the reader cannot number is one they have to count to.
    // And ONE line is never numbered by the preference alone: the gutter is there so you can find a line that
    // something else names, and nothing names line 1 of `23`. A lone "1" beside a one-line value or snippet is
    // noise. A mark or a note still numbers it, since those do name the line.
    const oneLine = !src.replace(/\n+$/, "").includes("\n");
    if ((!lineNumbers || oneLine) && markLine == null && !notes?.size)
        return <pre class="code"><code class="hljs" dangerouslySetInnerHTML={{ __html: html }} /></pre>;
    return (
        <pre class="code numbered"><code class="hljs">
            {htmlLines(html).map((ln, i) => [
                // `lineIds` makes each row addressable, so a traceback elsewhere on the page can point AT a
                // line rather than at the block containing it.
                // The marked line carries the panel's own tooltip rather than a native `title`: the native
                // one waits about a second, which on a mark you are hovering to find out what it MEANS is
                // long enough to have given up. `.tt` makes the row the trigger; the pop is read into the
                // shared floating layer.
                <span class={`cline${markLine === i + 1 ? " cline-fail" : ""}`} key={i}
                    {...(markLine === i + 1 && markTitle && markTip ? markTip(markTitle) : {})}
                    {...(lineIds ? { "data-line": String(i + 1) } : {})}>
                    <span class="lno">{i + 1}</span>
                    <span class="lcode" dangerouslySetInnerHTML={{ __html: ln || " " }} />
                    {/* The marked line's explanation FOLLOWS THE CURSOR (see cursorTip): a code line is as
                        wide as the block, so an anchored tip can sit half a panel from the pointer that
                        summoned it. Kept in the DOM as well so it is readable without a pointer at all. */}
                    {markLine === i + 1 && markTitle ? <span class="tt-pop cline-why" role="tooltip">{markTitle}</span> : null}
                </span>,
                /* A model-written gloss, drawn UNDER its line rather than to the right of it: the panel is
                   often 400px wide and a true right margin would sit off the end of a horizontally
                   scrolled block. It is a sibling of the line, never part of it — the source keeps its
                   own numbering and the line map is untouched. */
                notes?.get(i + 1) ? <span class="lnote" key={`n${i}`}><span class="lnote-mark" aria-hidden="true">↳</span><span class="lnote-txt" dangerouslySetInnerHTML={{ __html: mdInline(notes.get(i + 1)!) }} /></span> : null,
            ])}
        </code></pre>
    );
};

/** A command or snippet to paste: the code block with a copy button in its corner (the transcript's toolbar corner), for
 *  pages that hand someone a line to run, such as the bench page's held-run menu. */
export const CopyableCode = ({ text, lang = "bash" }: { text: string; lang?: string }) => {
    const { copied, copy } = useCopy();
    return (
        <div class="code-block copyable-code">
            <CodeBlock text={text} lang={lang} />
            <div class="code-tools">
                <button class="icon-btn tt" aria-label="copy" onClick={() => copy(text)}>
                    {copied ? <IconCheck /> : <IconCopy />}
                    <span class="tt-pop" role="tooltip">{copied ? "copied!" : "copy"}</span>
                </button>
            </div>
        </div>
    );
};

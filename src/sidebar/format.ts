// Pure text/format helpers + the syntax highlighter for the debug sidebar:
// timestamps, truncation, safe markdown→HTML, hljs highlighting, JS beautify, and
// the code-gutter line splitter. Extracted from app.tsx; highlight.js language
// registration lives here so highlighting is self-contained.

import hljs from "highlight.js/lib/core";
import json from "highlight.js/lib/languages/json";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import xml from "highlight.js/lib/languages/xml";
import cssLang from "highlight.js/lib/languages/css";
import mdLang from "highlight.js/lib/languages/markdown";
import { js_beautify } from "js-beautify/js/lib/beautify.js";
import katex from "katex";
import type { NeutralMessage } from "../contract";
import type { Session, Status } from "./store";

for (const [name, lang] of [
    ["json", json], ["javascript", javascript], ["typescript", typescript], ["python", python],
    ["bash", bash], ["xml", xml], ["css", cssLang], ["markdown", mdLang],
] as const) hljs.registerLanguage(name, lang);

/** JSON, indented and capped — the raw view of anything structured. */
export const pretty = (v: unknown, max = 6000): string => {
    let s: string;
    try { s = typeof v === "string" ? v : JSON.stringify(v, null, 2); } catch { s = String(v); }
    return s.length > max ? s.slice(0, max) + `\n… (${s.length - max} more chars)` : s;
};
// Compact label that stays unambiguous past today: time-only for today, else a
// short date + time. The exact full stamp (with seconds) rides along on hover.
export const shortStamp = (ts?: number): string => {
    const d = new Date(ts || Date.now());
    if (d.toDateString() === new Date().toDateString())
        return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
/** A full date + time, for a hover where the short stamp is ambiguous. */
export const fullStamp = (ts?: number): string =>
    new Date(ts || Date.now()).toLocaleString(undefined,
        { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
/** Cut to n characters with an ellipsis. */
export const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);
// One-line preview for a collapsed assistant reply: first non-empty line,
// truncated. `more` marks that content is hidden (so we show a trailing …).
export function collapsedPreview(s: string): { text: string; more: boolean } {
    const full = (s || "").trim();
    const first = full.split("\n").map(x => x.trim()).find(Boolean) || "";
    const text = truncate(first, 100);
    return { text, more: text !== full };
}
/** Escape for HTML. Every dynamic string reaching a `dangerouslySetInnerHTML` passes through this or
 *  through `markdown()`/`highlight()`, which escape too — a hostile tool result must never inject markup
 *  into a surface rendered at the extension's origin. */
export const escapeHtml = (s: string): string =>
    s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

// Strip markdown / HTML to plain text — for a SINGLE-LINE UI (the HUD caption pill) where a model that
// wraps its between-step narration in `**bold**`, `<b>`, backticks, headings, or a link would otherwise show
// the literal syntax. Not a parser: targeted replaces, whitespace-collapsed. (The detail view keeps rendered
// markdown; this is only for the plain pill.)
export function stripFormatting(s: string): string {
    return (s || "")
        .replace(/```[\s\S]*?```/g, " ")            // fenced code blocks
        .replace(/`([^`]+)`/g, "$1")                // inline code
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")  // links / images → their text
        .replace(/<[^>]+>/g, " ")                   // HTML tags
        .replace(/^\s{0,3}#{1,6}\s+/gm, "")         // headings
        .replace(/^\s{0,3}>\s?/gm, "")              // blockquotes
        .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")    // list markers
        .replace(/(\*\*|__)(.*?)\1/g, "$2")         // bold
        .replace(/(\*|_)(.*?)\1/g, "$2")            // italic
        .replace(/~~(.*?)~~/g, "$1")                // strikethrough
        .replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" }[m] || m))
        .replace(/\s+/g, " ")
        .trim();
}

// Minimal, SAFE markdown → HTML (escape first, then a small subset; fenced code
// is protected from inline formatting). Used via dangerouslySetInnerHTML.
export function highlight(code: string, lang?: string): string {
    try {
        if (lang === "text" || lang === "plain") return escapeHtml(code);   // opt out of auto-detect
        if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
        return hljs.highlightAuto(code).value;
    } catch { return escapeHtml(code); }
}

// Reflow cramped/minified JS for display (the model's exec source, mostly).
// Best-effort: on any parse trouble, fall back to the original text unchanged.
export function beautifyJs(code: string): string {
    try {
        return js_beautify(code, { indent_size: 2, end_with_newline: false, preserve_newlines: true, max_preserve_newlines: 2 });
    } catch { return code; }
}

// Split highlight.js token HTML into one fragment per source line, reopening any
// spans that straddle a newline so every line stays valid HTML (for the gutter).
// hljs output only ever contains <span class="…">, </span>, and escaped text.
export function htmlLines(html: string): string[] {
    const lines: string[] = [];
    const open: string[] = [];   // stack of currently-open <span …> opening tags
    let cur = "";
    const startLine = () => { cur = open.join(""); };
    const pushLine = () => { lines.push(cur + "</span>".repeat(open.length)); };
    startLine();
    for (const tok of html.match(/<span [^>]*>|<\/span>|[^<]+/g) || []) {
        if (tok[0] === "<") {                                        // a tag, not text…
            if (tok[1] === "/") open.pop();                          // </span>
            else open.push(tok);                                     // <span …>
            cur += tok;
        } else {                                                     // text run (may span newlines)
            const parts = tok.split("\n");
            for (let i = 0; i < parts.length; i++) {
                if (i > 0) { pushLine(); startLine(); }
                cur += parts[i];
            }
        }
    }
    pushLine();
    return lines;
}

// `math: true` renders LaTeX ($…$, $$…$$, \(…\), \[…\]) with KaTeX. Off for the export (keeps raw
// LaTeX source — no bundled fonts in the print doc); the live sidebar turns it on.
export function markdown(src: string, opts: { math?: boolean } = {}): string {
    const codeBlocks: string[] = [];
    // Pull fenced code from the RAW source first (highlighted, not double-escaped),
    // stashed behind an ASCII placeholder restored at the end.
    const stashed = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang: string, code: string) => {
        codeBlocks.push(`<pre class="code"><code class="hljs">${highlight(code.replace(/\n$/, ""), lang || undefined)}</code></pre>`);
        return `\n@@CODE${codeBlocks.length - 1}@@\n`;
    });
    // Stash rendered math behind placeholders BEFORE escaping — KaTeX output is trusted HTML that must
    // NOT be re-escaped or mangled by the inline formatter. Display ($$…$$ / \[…\]) before inline
    // ($…$ / \(…\)). The inline-`$` guards (no space just inside, no trailing digit) skip currency.
    const mathBlocks: string[] = [];
    const renderMath = (tex: string, display: boolean): string => {
        try { return katex.renderToString(tex.trim(), { displayMode: display, throwOnError: false, output: "html" }); }
        catch { return escapeHtml(tex); }
    };
    const stashMath = (tex: string, display: boolean): string => { mathBlocks.push(renderMath(tex, display)); return `@@MATH${mathBlocks.length - 1}@@`; };
    const mathed = !opts.math ? stashed : stashed
        .replace(/\$\$([\s\S]+?)\$\$/g, (_, t: string) => stashMath(t, true))
        .replace(/\\\[([\s\S]+?)\\\]/g, (_, t: string) => stashMath(t, true))
        .replace(/\\\(([\s\S]+?)\\\)/g, (_, t: string) => stashMath(t, false))
        // Single-$ inline math — the canonical Pandoc/KaTeX-auto-render DELIMITER rule, NOT a content sniff:
        // a `$` opens math when it's not escaped (`\$`), not part of `$$`, and NOT followed by a space; it
        // closes at the next `$` that is NOT preceded by a space and NOT followed by a digit (which rules out
        // "$5 or $10" currency and "$ x $"). Real renderers don't inspect the CONTENT (no "needs a `\`/`^`")
        // — so `$r = 2$`, `$y(x) = u(t)$`, `$y(x) =$` all typeset. The only cost is a rare prose span that
        // pairs two `$` around spaced text (e.g. `…($k)". …($k)`) rendering as math — an accepted edge case.
        .replace(/(?<![\\$])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g, (_m: string, t: string) => stashMath(t, false));
    const text = escapeHtml(mathed);
    // Recursively resolve emphasis so it NESTS: `**a _b_ c**` → <strong>a <em>b</em> c</strong>. Each match
    // re-runs emph on its own inner content, so an italic inside a bold (or vice-versa) still resolves — the old
    // flat passes left the inner literal. Bold (`**`/`__`) before italic (`*`/`_`) so `**` isn't eaten as two
    // `*`. `_`/`*` italic only at a WORD BOUNDARY (lookarounds), so snake_case / 2*3 / a_b don't become emphasis.
    const emph = (s: string): string => s
        .replace(/\*\*([\s\S]+?)\*\*/g, (_m, c: string) => `<strong>${emph(c)}</strong>`)
        .replace(/(?<![A-Za-z0-9_])__([\s\S]+?)__(?![A-Za-z0-9_])/g, (_m, c: string) => `<strong>${emph(c)}</strong>`)
        .replace(/(?<![*\w])\*(?!\s)([\s\S]+?)(?<!\s)\*(?![*\w])/g, (_m, c: string) => `<em>${emph(c)}</em>`)
        .replace(/(?<![_\w])_(?!\s)([\s\S]+?)(?<!\s)_(?![_\w])/g, (_m, c: string) => `<em>${emph(c)}</em>`);
    const inline = (t: string): string => {
        // Stash inline code AND links FIRST, so the emphasis pass never mangles their contents — a `*`/`_`
        // inside `<code>` or a URL (e.g. `…/foo_bar_baz`) must stay literal. Link TEXT is still emph'd. (Content
        // is HTML-escaped upstream, so the stashed HTML is safe.)
        const spans: string[] = [];
        const stash = (html: string): string => { spans.push(html); return `@@IS${spans.length - 1}@@`; };
        const staged = t
            .replace(/`([^`]+)`/g, (_, c: string) => stash(`<code>${c}</code>`))
            .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, txt: string, url: string) =>
                stash(`<a href="${url}" target="_blank" rel="noopener">${emph(txt)}</a>`));
        return emph(staged).replace(/@@IS(\d+)@@/g, (_, i: string) => spans[+i]);
    };
    // GFM table helpers. Cells are already-escaped `text` (never raw source), so
    // inline() on a cell is as safe as anywhere else. Leading/trailing pipes optional.
    const splitRow = (l: string): string[] => {
        let s = l.trim();
        if (s.startsWith("|")) s = s.slice(1);
        if (s.endsWith("|")) s = s.slice(0, -1);
        return s.split("|").map(c => c.trim());
    };
    const alignOf = (cell: string): string | null => {          // separator cell → alignment ("" = none), else null
        const m = cell.match(/^(:?)-+(:?)$/);
        if (!m) return null;
        return m[1] && m[2] ? "center" : m[2] ? "right" : m[1] ? "left" : "";
    };
    const isSep = (l: string): boolean => { const c = splitRow(l); return c.length > 0 && c.every(x => alignOf(x) !== null); };
    const cell = (c: string, tag: string, a: string | null) =>
        `<${tag}${a ? ` style="text-align:${a}"` : ""}>${inline(c)}</${tag}>`;
    const indentOf = (l: string): number => (l.match(/^[ \t]*/)?.[0].replace(/\t/g, "  ").length ?? 0);
    // A list item: leading indent (nesting) + a `-`/`*`/`+` bullet OR an ordered `1.` / `1)` marker.
    const markerRe = /^([ \t]*)(?:[-*+]|\d+[.)])\s+(.*)$/;
    // Render a gathered list block. Each item OWNS its indented continuation lines (further paragraphs, display
    // math, nested lists) + any internal blank lines — so an item's extra content stays INSIDE its <li> instead
    // of flushing the list and restarting the numbering (the "every step shows 1." bug). Each item's content is
    // rendered RECURSIVELY (nesting falls out for free), dedented by the item's own content column. The lead
    // paragraph's <p> wrapper is stripped so a simple `1. text` stays `<li>text</li>` (and a `- a\n\n- b`
    // blank-separated list stays tight), matching how the old renderer output looked for the common case.
    const renderList = (block: string[], base: number): string => {
        type It = { ordered: boolean; offset: number; content: string[] };
        const items: It[] = [];
        for (const raw of block) {
            const m = raw.match(markerRe);
            if (m && indentOf(raw) === base) {                                  // a new sibling item at this level
                items.push({ ordered: /\d/.test(raw.trimStart()[0]), offset: raw.length - m[2].length, content: [m[2]] });
            } else if (items.length) {                                          // continuation of the current item
                const cur = items[items.length - 1];
                cur.content.push(raw.trim() === "" ? "" : raw.replace(new RegExp(`^[ \\t]{0,${cur.offset}}`), ""));
            }
        }
        const lis = items.map((it) => `<li>${renderBlocks(it.content).replace(/^<p>([\s\S]*?)<\/p>/, "$1")}</li>`).join("");
        return items[0]?.ordered ? `<ol>${lis}</ol>` : `<ul>${lis}</ul>`;
    };
    // The block-level renderer, factored out so a list item can recurse on its own content. Operates on the
    // ALREADY-escaped, math/code-STASHED lines (placeholders resolve once at the very end).
    const renderBlocks = (ls: string[]): string => {
        const out: string[] = [];
        for (let i = 0; i < ls.length; i++) {
            const line = ls[i].trimEnd();
            // Table = a pipe header row immediately followed by a separator row.
            if (line.includes("|") && i + 1 < ls.length && isSep(ls[i + 1])) {
                const aligns = splitRow(ls[i + 1]).map(alignOf);
                const head = splitRow(line).map((c, j) => cell(c, "th", aligns[j] || null)).join("");
                const body: string[] = [];
                i += 2;                                             // consume header + separator
                for (; i < ls.length && ls[i].includes("|"); i++)
                    body.push("<tr>" + splitRow(ls[i]).map((c, j) => cell(c, "td", aligns[j] || null)).join("") + "</tr>");
                i--;                                                // step back onto the last consumed row (loop re-increments)
                out.push(`<div class="md-table-wrap"><table class="md-table"><thead><tr>${head}</tr></thead><tbody>${body.join("")}</tbody></table></div>`);
                continue;
            }
            const h = line.match(/^(#{1,6})\s+(.*)$/);
            const li = line.match(markerRe);
            if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push("<hr>"); }   // thematic break
            else if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); }
            else if (li) {
                // Gather the whole list block: sibling markers, deeper (nested) markers, indented continuation
                // lines, and internal blanks (kept only when the list actually continues past them).
                const b = indentOf(line);
                const block: string[] = [];
                let j = i;
                for (; j < ls.length; j++) {
                    const r = ls[j].trimEnd();
                    if (r.trim() === "") {
                        let k = j + 1; while (k < ls.length && ls[k].trim() === "") k++;
                        if (k < ls.length && (markerRe.test(ls[k]) ? indentOf(ls[k]) >= b : indentOf(ls[k]) > b)) { block.push(""); continue; }
                        break;   // a blank followed by a dedented non-list line ends the list
                    }
                    if (markerRe.test(r) ? indentOf(r) >= b : indentOf(r) > b) { block.push(r); continue; }
                    break;       // a dedented non-list line ends the list
                }
                i = j - 1;       // step back onto the last consumed line (the loop re-increments)
                out.push(renderList(block, b));
            }
            else if (/^\s{0,3}&gt;/.test(line)) {
                // Blockquote: gather consecutive `>` lines, strip the marker, split into paragraphs on a blank
                // quoted line, and inline each. (Nested lists/quotes inside a quote are rarer — inline is enough.)
                // The block loop runs on ESCAPED text, so the `>` marker is `&gt;` here.
                const q: string[] = [];
                for (; i < ls.length && /^\s{0,3}&gt;/.test(ls[i].trimEnd()); i++) q.push(ls[i].replace(/^\s{0,3}&gt;\s?/, ""));
                i--;   // step back onto the last quote line (the loop re-increments)
                const paras: string[] = []; let cur: string[] = [];
                for (const ql of q) { if (ql.trim()) cur.push(ql); else if (cur.length) { paras.push(cur.join(" ")); cur = []; } }
                if (cur.length) paras.push(cur.join(" "));
                out.push(`<blockquote>${paras.map(p => `<p>${inline(p)}</p>`).join("")}</blockquote>`);
            }
            else if (!line.trim()) { /* blank between top-level blocks — nothing to emit */ }
            else { out.push(`<p>${inline(line)}</p>`); }
        }
        return out.join("");
    };
    return renderBlocks(text.split("\n"))
        .replace(/@@MATH(\d+)@@/g, (_, i: string) => mathBlocks[+i])
        .replace(/@@CODE(\d+)@@/g, (_, i: string) => codeBlocks[+i]);
}

// A ONE-LINE label rendered as markdown+math with the lone wrapping <p> stripped — for a caption / summary /
// header where a model may write inline `$…$` LaTeX (or `**bold**`) that must TYPESET, not show as literal
// syntax. markdown() escapes HTML, so the result is safe for dangerouslySetInnerHTML. Reused across the
// citation caption, the Show-work block header, etc. — one place so an inline-math label never regresses.
export const inlineMarkdown = (t: string): string => markdown(t || "", { math: true }).replace(/^<p>([\s\S]*)<\/p>\s*$/, "$1");

/** The most recent user message in a neutral transcript — what a session is titled and previewed by. */
export function lastUser(messages: NeutralMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") { const c = messages[i].content; return typeof c === "string" ? c : pretty(c); }
    }
    return "";
}
/** One status for a whole session — pending if anything is still going, err if anything failed. */
export const rollupStatus = (s: Session): Status =>
    s.turns.some(t => t.status === "pending") ? "pending" : s.turns.some(t => t.status === "err") ? "err" : "ok";

/** The same renderer, unwrapped for a run of text that sits INSIDE a line rather than being its own
 *  paragraph (a margin note beside a line of code). One `<p>` is peeled off; anything with real block
 *  structure keeps it, since stripping only the opening tag would leave unbalanced markup. */
export function mdInline(src: string): string {
    // MATH ON, like the answer renderer: a note about code is exactly where a formula belongs ("sums
    // $\\sum q_i$ per rep" says it once instead of in a sentence), and a `$…$` left unrendered in a
    // margin is worse than not offering it at all.
    const html = markdown(src, { math: true });
    const m = html.match(/^<p>((?:(?!<\/p>)[\s\S])*)<\/p>\s*$/);
    return m ? m[1] : html;
}

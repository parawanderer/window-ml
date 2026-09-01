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
export const fullStamp = (ts?: number): string =>
    new Date(ts || Date.now()).toLocaleString(undefined,
        { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
export const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);
// One-line preview for a collapsed assistant reply: first non-empty line,
// truncated. `more` marks that content is hidden (so we show a trailing …).
export function collapsedPreview(s: string): { text: string; more: boolean } {
    const full = (s || "").trim();
    const first = full.split("\n").map(x => x.trim()).find(Boolean) || "";
    const text = truncate(first, 100);
    return { text, more: text !== full };
}
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
        // Single-$ inline math. The regex enforces no-space-adjacency (open `$` not followed by space, close
        // `$` not preceded by space, not escaped, close not followed by a digit) — that alone rules out
        // "$5 or $10" currency and "$ x $". We render when EITHER the content carries a math signal
        // (`\`/`^`/`_` → `$6 \times 7$`, `$mc^2$`) OR it has NO internal whitespace (`$x$`, `$a+b$`, `$x_1$`) —
        // the latter is the fix for a bare `$x$` (was left literal), while a whitespace-y prose span that
        // happens to pair two `$` (the "FY sales ($k)". This …($k)" slop) still stays literal.
        .replace(/(?<![\\$])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g, (m: string, t: string) => /[\\^_]/.test(t) || !/\s/.test(t) ? stashMath(t, false) : m);
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
    // Build nested <ul>/<ol> from a flat list of items with indent depths (2 spaces / a tab per level).
    // A stack of open lists: deeper indent opens a nested list INSIDE the current <li>; a shallower one
    // closes back down. The list TYPE (ul vs ol) is decided by the first item at each level.
    type Item = { indent: number; ordered: boolean; text: string };
    const buildList = (items: Item[]): string => {
        let html = "";
        const stack: { ordered: boolean; indent: number }[] = [];
        for (const it of items) {
            if (!stack.length || it.indent > stack[stack.length - 1].indent) {
                html += it.ordered ? "<ol>" : "<ul>";
                stack.push({ ordered: it.ordered, indent: it.indent });
            } else {
                while (stack.length > 1 && it.indent < stack[stack.length - 1].indent) { const t = stack.pop()!; html += t.ordered ? "</li></ol>" : "</li></ul>"; }
                html += "</li>";   // close the previous sibling <li>
            }
            html += `<li>${inline(it.text)}`;
        }
        while (stack.length) { const t = stack.pop()!; html += t.ordered ? "</li></ol>" : "</li></ul>"; }
        return html;
    };
    const out: string[] = [];
    let items: Item[] | null = null;
    const flush = () => { if (items) { out.push(buildList(items)); items = null; } };
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trimEnd();
        // Table = a pipe header row immediately followed by a separator row.
        if (line.includes("|") && i + 1 < lines.length && isSep(lines[i + 1])) {
            flush();
            const aligns = splitRow(lines[i + 1]).map(alignOf);
            const head = splitRow(line).map((c, j) => cell(c, "th", aligns[j] || null)).join("");
            const body: string[] = [];
            i += 2;                                             // consume header + separator
            for (; i < lines.length && lines[i].includes("|"); i++)
                body.push("<tr>" + splitRow(lines[i]).map((c, j) => cell(c, "td", aligns[j] || null)).join("") + "</tr>");
            i--;                                                // step back onto the last consumed row (loop re-increments)
            out.push(`<div class="md-table-wrap"><table class="md-table"><thead><tr>${head}</tr></thead><tbody>${body.join("")}</tbody></table></div>`);
            continue;
        }
        const h = line.match(/^(#{1,6})\s+(.*)$/);
        // A list item: leading indent (nesting) + a `-`/`*`/`+` bullet OR an ordered `1.` / `1)` marker.
        const li = line.match(/^([ \t]*)(?:[-*+]|\d+[.)])\s+(.*)$/);
        if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flush(); out.push("<hr>"); }   // thematic break
        else if (h) { flush(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); }
        else if (li) { (items ??= []).push({ indent: li[1].replace(/\t/g, "  ").length, ordered: /\d/.test(line.trimStart()[0]), text: li[2] }); }
        else if (/^\s{0,3}&gt;/.test(line)) {
            // Blockquote: gather consecutive `>` lines, strip the marker, split into paragraphs on a blank
            // quoted line, and inline each. (Nested lists/quotes inside a quote are rarer — inline is enough.)
            // The block loop runs on ESCAPED text, so the `>` marker is `&gt;` here.
            flush();
            const q: string[] = [];
            for (; i < lines.length && /^\s{0,3}&gt;/.test(lines[i].trimEnd()); i++) q.push(lines[i].replace(/^\s{0,3}&gt;\s?/, ""));
            i--;   // step back onto the last quote line (the loop re-increments)
            const paras: string[] = []; let cur: string[] = [];
            for (const ql of q) { if (ql.trim()) cur.push(ql); else if (cur.length) { paras.push(cur.join(" ")); cur = []; } }
            if (cur.length) paras.push(cur.join(" "));
            out.push(`<blockquote>${paras.map(p => `<p>${inline(p)}</p>`).join("")}</blockquote>`);
        }
        else if (!line.trim()) { flush(); }
        else { flush(); out.push(`<p>${inline(line)}</p>`); }
    }
    flush();
    return out.join("")
        .replace(/@@MATH(\d+)@@/g, (_, i: string) => mathBlocks[+i])
        .replace(/@@CODE(\d+)@@/g, (_, i: string) => codeBlocks[+i]);
}

export function lastUser(messages: NeutralMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") { const c = messages[i].content; return typeof c === "string" ? c : pretty(c); }
    }
    return "";
}
export const rollupStatus = (s: Session): Status =>
    s.turns.some(t => t.status === "pending") ? "pending" : s.turns.some(t => t.status === "err") ? "err" : "ok";

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

export function markdown(src: string): string {
    const codeBlocks: string[] = [];
    // Pull fenced code from the RAW source first (highlighted, not double-escaped),
    // stashed behind an ASCII placeholder restored at the end.
    const stashed = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang: string, code: string) => {
        codeBlocks.push(`<pre class="code"><code class="hljs">${highlight(code.replace(/\n$/, ""), lang || undefined)}</code></pre>`);
        return `\n@@CODE${codeBlocks.length - 1}@@\n`;
    });
    const text = escapeHtml(stashed);
    const inline = (t: string): string => t
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    const out: string[] = [];
    let list: string[] | null = null;
    const flush = () => { if (list) { out.push("<ul>" + list.join("") + "</ul>"); list = null; } };
    for (const raw of text.split("\n")) {
        const line = raw.trimEnd();
        const h = line.match(/^(#{1,6})\s+(.*)$/);
        const li = line.match(/^[-*]\s+(.*)$/);
        if (h) { flush(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); }
        else if (li) { (list ??= []).push(`<li>${inline(li[1])}</li>`); }
        else if (!line.trim()) { flush(); }
        else { flush(); out.push(`<p>${inline(line)}</p>`); }
    }
    flush();
    return out.join("").replace(/@@CODE(\d+)@@/g, (_, i: string) => codeBlocks[+i]);
}

export function lastUser(messages: NeutralMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") { const c = messages[i].content; return typeof c === "string" ? c : pretty(c); }
    }
    return "";
}
export const rollupStatus = (s: Session): Status =>
    s.turns.some(t => t.status === "pending") ? "pending" : s.turns.some(t => t.status === "err") ? "err" : "ok";

// viewer.mjs — render a run's `run.md` as a page, for reading in the browser.
//
// The dashboard is already an index of the sweep; following a link out of it landed on raw markdown,
// which is the one artifact in the set that is WORSE unrendered — run.md is mostly `<details>` blocks,
// fenced code and tables, and a browser showing it as plain text hides exactly the structure that makes
// it readable.
//
// `marked` rather than a hand-rolled renderer. The markdown here is not a closed subset in practice: the
// sink emits GFM tables, raw HTML disclosures and fenced code, and a tool result can contain arbitrary
// markdown the MODEL wrote. A partial renderer would silently mangle the cases it did not anticipate,
// which for a debugging artifact is worse than not rendering at all. It is a devDependency: the bench is
// a development tool and nothing here ships in the extension.
//
// This is the second of two views, not a replacement for the first. `--pdf` already writes `run.html` via
// the extension's OWN export sink, which is the higher-fidelity rendering and the one to trust when they
// disagree; it is just expensive enough that a sweep does not produce it by default. So the viewer offers
// whichever exist, and says which is which.

import { Marked } from "marked";
import hljs from "highlight.js";
import { createHash } from "node:crypto";

/** Languages the run markdown actually uses; anything else is auto-detected, then falls back to plain. */
const LANGS = new Set(["js", "javascript", "ts", "typescript", "json", "python", "py", "bash", "sh", "html", "xml", "css", "md", "markdown", "diff"]);

/** A private marker, so splitting into sections cannot be confused by markup the RUN produced. */
const SPLIT = "\u0000\u0001SEC\u0001\u0000";

const escapeHtml = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/**
 * A Marked instance per call rather than a module-level `marked.use`, which is global and would leak the
 * asset rewriting of one run into the next.
 *
 * @param {string} assetBase prefix for RELATIVE urls (the run's directory, as served)
 */
function makeMarked(assetBase) {
    const abs = (href) => {
        const h = String(href ?? "");
        // Absolute, protocol-relative, anchor, or one of the sink's own `@tool:` placeholders — all left
        // exactly as written. A `@tool:` reference is not a URL at all; it is a pointer the export expands,
        // and rewriting it would turn a readable citation into a broken link.
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(h) || h.startsWith("@tool:")) return h;
        return assetBase + h;
    };
    const seenSteps = new Set();
    const m = new Marked({ gfm: true, breaks: false });
    m.use({
        renderer: {
            code({ text, lang }) {
                const l = (lang || "").split(/\s+/)[0].toLowerCase();
                let body;
                try {
                    body = l && LANGS.has(l) && hljs.getLanguage(l)
                        ? hljs.highlight(text, { language: l, ignoreIllegals: true }).value
                        : escapeHtml(text);
                } catch {
                    body = escapeHtml(text);   // a highlighter throw must never lose the code itself
                }
                return `<pre><code class="hljs">${body}</code></pre>\n`;
            },
            // Headings get ids, and every step ALSO gets a stable `#step-N` — the anchor a link from the
            // index can be built without knowing which tool the step called. The slug stays as the
            // readable one, so a link copied out of the address bar still says what it points at.
            heading({ tokens, depth }) {
                const inner = this.parser.parseInline(tokens);
                const plain = inner.replace(/<[^>]*>/g, "").trim();
                const slug = plain.toLowerCase().replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "") || "s";
                // An h2 opens a SECTION. The marker is what `sectionize` splits on afterwards; a private
                // sentinel rather than a scan for `<h2`, because the markdown carries raw HTML from tool
                // results and a model's own output, either of which may contain a heading of its own.
                // Two ids per step section, because two different links want it. The readable slug
                // (`step-4-exec`) is what the index uses to land on the exact call that failed; the bare
                // `step-4` is the fallback for "that step" when the tool is not known. The bare form goes
                // on the FIRST section of the step, which is its thought.
                const n = /^step\s+(\d+)\b/i.exec(plain);
                const bare = n && !seenSteps.has(n[1]) ? (seenSteps.add(n[1]), `step-${n[1]}`) : "";
                const mark = depth === 2 ? `${SPLIT}${slug}\u0002${bare}${SPLIT}` : "";
                return `${mark}<h${depth} id="${escapeHtml(slug)}">${inner}</h${depth}>\n`;
            },
            image({ href, title, text }) {
                const t = title ? ` title="${escapeHtml(title)}"` : "";
                return `<img src="${escapeHtml(abs(href))}" alt="${escapeHtml(text)}"${t} loading="lazy">`;
            },
            link({ href, title, tokens }) {
                const t = title ? ` title="${escapeHtml(title)}"` : "";
                const inner = this.parser.parseInline(tokens);
                return `<a href="${escapeHtml(abs(href))}"${t}>${inner}</a>`;
            },
        },
    });
    return m;
}


/**
 * Turn the flat document into collapsible sections, one per h2.
 *
 * A run is fifty screens of which you usually want one, so every step folds. The section carries the
 * step's id, which is what makes the pure-CSS focusing below work: linking to `#step-4` targets the
 * SECTION, not a heading inside it.
 *
 * Sections are emitted OPEN. The default view is the whole transcript, exactly as before; collapsing is
 * something the reader (or a focusing link) asks for, never the state they land in by surprise.
 */
function sectionize(html) {
    const parts = html.split(SPLIT);
    if (parts.length < 3) return html;
    let out = parts[0];   // whatever precedes the first h2 — the title block
    for (let i = 1; i < parts.length; i += 2) {
        const [id, bare] = parts[i].split("\u0002");
        const body = parts[i + 1] ?? "";
        const h = /^\s*(<h2\b[^>]*>[\s\S]*?<\/h2>)/.exec(body);
        if (!h) { out += body; continue; }
        const summary = h[1].replace(/^<h2\b[^>]*>/, "").replace(/<\/h2>$/, "");
        const extra = bare ? `<span class="anchor" id="${escapeHtml(bare)}"></span>` : "";
        out += `${extra}<details class="sec" open id="${escapeHtml(id)}">`
            + `<summary><h2>${summary}</h2></summary>`
            + `<div class="secbody">${body.slice(h[0].length)}</div></details>\n`;
    }
    return out;
}


/**
 * The page's only script. Folding is the NATIVE details state, so a heading click keeps working at all
 * times — the earlier pure-CSS version hid section bodies with `display:none`, which overrode that state
 * and left "collapse all" followed by a click doing visibly nothing.
 *
 * It is admitted by a CSP HASH rather than by 'unsafe-inline'. That is the whole point: this exact text
 * runs, and a <script> injected through a tool result — which reaches the document because raw HTML has
 * to pass through for the sink's own disclosures — does not match any hash and is still refused.
 */
const SCRIPT = `(function () {
  var all = function () { return Array.prototype.slice.call(document.querySelectorAll("details.sec")); };
  var setAll = function (open) { all().forEach(function (d) { d.open = open; d.classList.remove("focused", "lit"); }); };
  var byId = function (id) { try { return document.getElementById(id); } catch (e) { return null; } };
  var focus = function () {
    var id = decodeURIComponent((location.hash || "").slice(1));
    if (!id) return;
    var el = byId(id);
    if (!el) return;
    // The id is either the section itself (#step-4-exec) or the bare anchor that precedes it (#step-4).
    var sec = el.closest ? el.closest("details.sec") : null;
    if (!sec && el.nextElementSibling && el.nextElementSibling.matches("details.sec")) sec = el.nextElementSibling;
    if (!sec) return;
    setAll(false);
    sec.open = true;
    sec.classList.add("focused", "lit");
    // A call is preceded by the reasoning that produced it; showing one without the other hides the half
    // that explains it.
    var prev = sec.previousElementSibling;
    while (prev && !(prev.matches && prev.matches("details.sec"))) prev = prev.previousElementSibling;
    if (prev) prev.open = true;
    sec.scrollIntoView({ block: "start" });
  };
  var c = byId("collapse"), e = byId("expand");
  if (c) c.addEventListener("click", function () { setAll(false); });
  if (e) e.addEventListener("click", function () { setAll(true); });
  window.addEventListener("hashchange", focus);
  focus();
})();`;

/** The page chrome. Shares the dashboard's tokens so the two do not read as different tools. */
const CSS = /* css */ `
:root { color-scheme: light dark; --bg:#fff; --fg:#111; --dim:#666; --line:#e3e3e3; --run:#1a73e8; --panel:#f7f7f8; --kw:#a626a4; --str:#50a14f; --num:#986801; --cmt:#a0a1a7; }
@media (prefers-color-scheme: dark) { :root { --bg:#16171a; --fg:#e6e6e6; --dim:#9aa0a6; --line:#2c2e33; --run:#8ab4f8; --panel:#1e2024; --kw:#c678dd; --str:#98c379; --num:#d19a66; --cmt:#7f848e; } }
* { box-sizing: border-box }
body { margin:0; padding:0 0 80px; background:var(--bg); color:var(--fg);
       font:14px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif }
.wrap { max-width:900px; margin:0 auto; padding:0 22px }
header { position:sticky; top:0; z-index:5; background:var(--bg); border-bottom:1px solid var(--line);
         padding:10px 22px; display:flex; gap:14px; align-items:baseline; flex-wrap:wrap }
header .t { font-weight:600; font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace }
header a { color:var(--run); font-size:12px; text-decoration:none }
header a:hover { text-decoration:underline }
header .sp { flex:1 }
h1 { font-size:21px; margin:22px 0 6px } h2 { font-size:17px; margin:26px 0 6px }
h3 { font-size:15px; margin:22px 0 4px } h4 { font-size:13px; margin:18px 0 4px; color:var(--dim) }
.anchor { display:block; position:relative; top:-58px; visibility:hidden }
/* A section per step, folded by clicking its heading. The <h2> stays a real heading INSIDE the summary so
   the document still has an outline for find-in-page and for the browser's own heading navigation. */
details.sec { border:0; background:none; margin:0 }
details.sec > summary { list-style:none; cursor:pointer; padding:0; border:0; color:inherit;
                        display:flex; align-items:baseline; gap:8px; border-radius:5px }
details.sec > summary::-webkit-details-marker { display:none }
details.sec > summary::before { content:"▾"; color:var(--dim); font-size:11px; width:11px; flex:none }
details.sec:not([open]) > summary::before { content:"▸" }
details.sec > summary:hover { background:var(--panel) }
details.sec > summary h2 { margin:20px 0 5px; font-size:16px }
details.sec[open] { border-bottom:1px solid var(--line); padding-bottom:8px }
details.sec:not([open]) { border-bottom:0; padding-bottom:0 }
.secbody { padding-left:19px }
details.sec { scroll-margin-top:64px }

/* The focused section, lit briefly so the jump is visible rather than leaving you to work out where the
   page landed. Folding itself is the native details state, driven by the script — CSS that HID the body
   instead would override that state, and then clicking a heading did nothing at all. */
details.sec.lit { animation:flash 1.6s ease-out }
details.sec.focused > summary h2 { color:var(--run) }
details.sec.focused { background:color-mix(in srgb, var(--run) 7%, transparent); border-radius:7px;
                      padding:2px 8px 8px; margin:0 -8px }

.foldbar { margin-left:auto; display:flex; gap:10px }
.foldbar button { border:0; background:none; color:var(--run); font:12px/1.4 inherit; cursor:pointer; padding:0 }
.foldbar button:hover { text-decoration:underline }
:target, h1:target, h2:target { scroll-margin-top:58px }
/* The step a link pointed AT, briefly lit so the jump is visible rather than leaving you to work out
   where the page landed. */
@keyframes flash { from { background:color-mix(in srgb, var(--run) 26%, transparent) } to { background:transparent } }
.lit { animation:flash 1.6s ease-out; border-radius:5px }
hr { border:0; border-top:1px solid var(--line); margin:26px 0 }
a { color:var(--run) }
code { font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;
       background:var(--panel); padding:1px 4px; border-radius:3px }
pre { background:var(--panel); border:1px solid var(--line); border-radius:6px; padding:10px 12px;
      overflow:auto; max-height:520px }
pre code { background:none; padding:0; font-size:12px; line-height:1.5 }
img { max-width:100%; border:1px solid var(--line); border-radius:5px; display:block; margin:8px 0 }
table { border-collapse:collapse; margin:10px 0; font-size:13px; display:block; overflow-x:auto }
th,td { border:1px solid var(--line); padding:4px 9px; text-align:left }
th { background:var(--panel) }
blockquote { margin:10px 0; padding:2px 14px; border-left:3px solid var(--line); color:var(--dim) }
/* A disclosure is the unit this document is built from, so it gets a real affordance rather than the
   browser's bare triangle on a run of body text. */
details { border:1px solid var(--line); border-radius:6px; margin:8px 0; background:var(--panel) }
details > summary { cursor:pointer; padding:6px 11px; font-size:12.5px; color:var(--dim);
                    user-select:none; border-radius:6px }
details[open] > summary { border-bottom:1px solid var(--line); color:var(--fg) }
details > *:not(summary) { margin-left:11px; margin-right:11px }
details pre { background:var(--bg) }
.hljs-keyword,.hljs-built_in,.hljs-literal,.hljs-name { color:var(--kw) }
.hljs-string,.hljs-attr,.hljs-addition { color:var(--str) }
.hljs-number,.hljs-symbol,.hljs-attribute { color:var(--num) }
.hljs-comment,.hljs-quote,.hljs-meta { color:var(--cmt); font-style:italic }
.hljs-title,.hljs-section,.hljs-selector-tag { color:var(--run) }
`;

/**
 * Render one `run.md` into a standalone page.
 *
 * @param {string} md the markdown, as written by the export sink
 * @param {object} o
 * @param {string} o.title what this run is (shown in the header and the tab)
 * @param {string} o.assetBase prefix applied to relative urls, so image sidecars resolve
 * @param {{label:string,href:string}[]} [o.links] the run's other artifacts, offered beside it
 * @returns {string} a complete HTML document
 */
export function renderMarkdownPage(md, { title, assetBase, links = [] }) {
    // Computed from the exact bytes that ship, so the two can never drift: change the script and the hash
    // changes with it. A mismatch would silently disable the folding rather than error.
    const scriptHash = createHash("sha256").update(SCRIPT).digest("base64");
    const body = sectionize(makeMarked(assetBase).parse(md));
    const nav = links.map((l) => `<a href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a>`).join("\n");
    return `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<!-- The markdown holds whatever a tool returned and whatever the model wrote, and raw HTML has to pass
     through for the sink's own <details> disclosures — so a hostile page scraped during a run could
     otherwise put a script element in this document, which then runs when a human READS it.
     This page has no script of its own, so denying script entirely costs nothing and needs no
     sanitizer. Images stay permissive because they are the run's own screenshots and this file is
     opened both over http and straight off the disk, where the origin is opaque. -->
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src * data: blob:; style-src 'unsafe-inline'; script-src 'sha256-${scriptHash}'; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
<header><span class="t">${escapeHtml(title)}</span><span class="sp"></span>${nav}
<span class="foldbar"><button type="button" id="collapse">collapse all</button><button type="button" id="expand">expand all</button></span></header>
<div class="wrap">${body}</div>
<script>${SCRIPT}</script>
`;
}

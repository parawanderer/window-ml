// highlight-cost.mjs — what ONE update of a live call's code cell costs, by size: highlight.js on the whole text (the
// panel's `highlight()`, in Node) and the DOM swap plus layout (Chromium), plain and with the line-number gutter. Prints
// JSON rows; `notebooks/ui/live-call-reveal.ipynb` reads them through `wmlnb.extract`.
//
//   node --import tsx notebooks/ui/highlight-cost.mjs > rows.json
import fs from "node:fs";
import { chromium } from "playwright";
import { highlight, htmlLines } from "../../src/sidebar/format.ts";

const ROOT = new URL("../../", import.meta.url);
// Real sources of each language, repeated to length: what a model writes looks like this, not like random text.
const SOURCES = {
    python: fs.readFileSync(new URL("examples/searxng_search.py", ROOT), "utf8"),
    javascript: fs.readFileSync(new URL("src/sidebar/transcript/live-call.tsx", ROOT), "utf8"),
};
const SIZES = [250, 500, 1000, 2000, 5000, 10000, 20000, 40000];
const REPS = 30;
const grow = (src, n) => { let s = ""; while (s.length < n) s += src + "\n"; return s.slice(0, n); };
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
/** Median and p95 of `REPS` timed runs of `fn`, after five untimed ones. */
const time = (fn) => {
    for (let i = 0; i < 5; i++) fn();
    const t = [];
    for (let i = 0; i < REPS; i++) { const a = performance.now(); fn(); t.push(performance.now() - a); }
    return { med: q(t, 0.5), p95: q(t, 0.95) };
};

const rows = [];
for (const [lang, src] of Object.entries(SOURCES))
    for (const chars of SIZES) {
        const text = grow(src, chars);
        const hl = time(() => highlight(text, lang));
        const split = time(() => htmlLines(highlight(text, lang)));
        const html = highlight(text, lang);
        rows.push({ lang, chars, lines: text.split("\n").length, hljs_ms: hl.med, hljs_p95_ms: hl.p95,
                    gutter_split_ms: Math.max(0, split.med - hl.med), html, lineHtml: htmlLines(html) });
    }

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(`<style>pre{font:12px monospace;max-height:320px;overflow:auto;width:700px}.cline{display:block}</style>
<pre class="code" id="p"><code class="hljs" id="c"></code></pre>`);
for (const r of rows) {
    const dom = await page.evaluate(({ html, lineHtml, reps }) => {
        const pre = document.getElementById("p"), c = document.getElementById("c");
        const numbered = lineHtml.map((ln, i) => `<span class="cline"><span class="lno">${i + 1}</span><span class="lcode">${ln || " "}</span></span>`).join("");
        const run = (h) => {
            const t = [];
            for (let i = 0; i < reps; i++) {
                c.innerHTML = ""; void c.offsetHeight;
                const a = performance.now(); c.innerHTML = h; void c.offsetHeight; pre.scrollTop = 1e9; t.push(performance.now() - a);
            }
            t.sort((x, y) => x - y);
            return t[Math.floor(t.length / 2)];
        };
        return { plain: run(html), numbered: run(numbered) };
    }, { html: r.html, lineHtml: r.lineHtml, reps: REPS });
    r.dom_ms = dom.plain;
    r.dom_numbered_ms = dom.numbered;
    delete r.html; delete r.lineHtml;
}
await browser.close();
process.stdout.write(JSON.stringify({ node: process.version, chromium: browser.version?.() ?? null, reps: REPS, rows }) + "\n");

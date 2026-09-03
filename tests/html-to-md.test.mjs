// Unit tests for the fetch_url HTML→Markdown converter (html-to-md.ts), run directly against the source via
// tsx (turndown bundles its own DOM — domino — so no jsdom needed here).
import { test } from "node:test";
import assert from "node:assert";
import { htmlToMarkdown } from "../src/html-to-md.ts";

test("converts headings, links, lists, and code to clean Markdown", () => {
    const md = htmlToMarkdown(`<h1>Title</h1><p>Some <a href="https://x.test">link</a> and <strong>bold</strong>.</p><ul><li>a</li><li>b</li></ul><pre><code>x = 1</code></pre>`);
    assert.match(md, /^# Title/m, "ATX heading");
    assert.match(md, /\[link\]\(https:\/\/x\.test\)/, "inlined link");
    assert.match(md, /\*\*bold\*\*/, "bold");
    assert.match(md, /^-\s+a$/m, "bullet list");
    assert.match(md, /```/, "fenced code block");
});

test("strips scripts, styles, and page chrome (nav / header / footer / aside)", () => {
    const md = htmlToMarkdown(`<header>NAVLOGO</header><nav>Menu Home About</nav><script>evil()</script><style>.x{color:red}</style><main><p>Real content.</p></main><footer>FOOTERJUNK</footer><aside>SIDEBAR</aside>`);
    assert.match(md, /Real content\./, "keeps the main content");
    assert.doesNotMatch(md, /evil\(\)|color:red|NAVLOGO|FOOTERJUNK|SIDEBAR|Menu Home/, "drops scripts/styles/chrome");
});

test("strips STATICALLY-hidden elements — the `hidden` attribute + inline display:none/visibility:hidden", () => {
    // GitHub SSRs hidden fallback slots (`<div data-...-error hidden>Uh oh!</div>`) that pollute the reading text.
    const md = htmlToMarkdown(`<main><p>Visible content.</p>`
        + `<div data-show-on-forbidden-error hidden><h3>Uh oh!</h3><p>Sorry, something went wrong.</p></div>`
        + `<div style="display:none">DISPLAY-NONE-JUNK</div>`
        + `<span style="visibility: hidden">VIS-HIDDEN-JUNK</span></main>`);
    assert.match(md, /Visible content\./, "keeps visible content");
    assert.doesNotMatch(md, /Uh oh!|Sorry, something went wrong|DISPLAY-NONE-JUNK|VIS-HIDDEN-JUNK/, "drops statically-hidden nodes");
});

test("a full HTML document yields just the body content — head/title/meta dropped", () => {
    const md = htmlToMarkdown(`<!doctype html><html><head><title>PAGETITLE</title><meta charset="utf-8"><script>x</script></head><body><h2>Hi</h2><p>Body text.</p></body></html>`);
    assert.match(md, /## Hi/);
    assert.match(md, /Body text\./);
    assert.doesNotMatch(md, /PAGETITLE|charset/, "head content (title/meta) is stripped");
});

test("collapses blank-line runs and trims; empty input → empty string", () => {
    const md = htmlToMarkdown(`<p>a</p><p></p><p></p><p>b</p>`);
    assert.doesNotMatch(md, /\n{3,}/, "no 3+ blank-line runs");
    assert.equal(md, md.trim(), "trimmed");
    assert.equal(htmlToMarkdown(""), "");
    assert.equal(htmlToMarkdown("   "), "");
});

test("stripChrome:false (navigate verify text-all) KEEPS nav/header/footer; default strips them", () => {
    const html = `<header>SITEHEADER</header><nav>Home About</nav><main><p>Body.</p></main><footer>SITEFOOTER</footer>`;
    const stripped = htmlToMarkdown(html);                          // default → chrome removed
    assert.match(stripped, /Body\./);
    assert.doesNotMatch(stripped, /SITEHEADER|Home About|SITEFOOTER/, "default strips chrome");
    const all = htmlToMarkdown(html, { stripChrome: false });       // text-all → chrome kept
    assert.match(all, /Body\./);
    assert.match(all, /SITEHEADER/, "text-all keeps the header");
    assert.match(all, /SITEFOOTER/, "text-all keeps the footer");
    assert.match(all, /Home About/, "text-all keeps the nav");
    // Scripts/styles are stripped in BOTH modes (pure noise).
    assert.doesNotMatch(htmlToMarkdown(`<script>x()</script><nav>n</nav><p>y</p>`, { stripChrome: false }), /x\(\)/);
});

test("a table survives as a Markdown table", () => {
    const md = htmlToMarkdown(`<table><thead><tr><th>Name</th><th>Qty</th></tr></thead><tbody><tr><td>Apple</td><td>3</td></tr></tbody></table>`);
    assert.match(md, /\| Name \| Qty \|/);
    assert.match(md, /\| Apple \| 3 \|/);
});

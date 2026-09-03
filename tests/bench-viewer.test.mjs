"use strict";
// The rendered view of a run.
//
// This is a DEBUGGING artifact, so the properties worth pinning are the ones whose failure is silent: a
// disclosure that renders as literal text, an image that resolves to nothing, a `@tool:` citation turned
// into a broken link, or an anchor the index links to that does not exist. None of those throw; they just
// quietly make the page useless at the moment you need it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { renderMarkdownPage } from "../tests/e2e/viewer.mjs";

const page = (md, o = {}) => renderMarkdownPage(md, { title: "t", assetBase: "", ...o });

test("the sink's own constructs survive: disclosures, fences, tables", () => {
    const html = page([
        "# Agent run · m · abc123",
        "<details><summary>System prompt</summary>",
        "",
        "```js",
        "const x = 1;",
        "```",
        "",
        "</details>",
        "",
        "| a | b |",
        "| --- | --- |",
        "| 1 | 2 |",
    ].join("\n"));
    assert.match(html, /<details>/, "a raw HTML disclosure must pass through, not be escaped");
    assert.match(html, /<summary>System prompt<\/summary>/);
    assert.match(html, /<pre><code class="hljs">/, "fences must render as code, not paragraphs");
    assert.match(html, /<table>[\s\S]*<td>1<\/td>/, "GFM tables are used by the df render");
});

test("a relative image resolves against the run's directory, wherever the page is served from", () => {
    // The ONE property that makes a single file work both from disk and under /artifacts/: relative
    // srcs. A rewrite to an absolute path would break the file:// case, which is how a saved report
    // opens.
    assert.match(page("![s](images/step-1.png)"), /src="images\/step-1\.png"/);
    assert.match(page("![s](images/step-1.png)", { assetBase: "/artifacts/x/" }),
        /src="\/artifacts\/x\/images\/step-1\.png"/);
});

test("absolute urls and @tool: citations are left exactly as written", () => {
    // A `@tool:` reference is a POINTER the export expands, not a URL. Prefixing it would turn a readable
    // citation into a link to a file that cannot exist.
    assert.match(page("![c](@tool:abc1234:out)", { assetBase: "/artifacts/x/" }), /src="@tool:abc1234:out"/);
    assert.match(page("[x](https://example.com/a)", { assetBase: "/artifacts/x/" }), /href="https:\/\/example\.com\/a"/);
    assert.match(page("[x](#step-2)", { assetBase: "/artifacts/x/" }), /href="#step-2"/);
});

test("a step is addressable two ways: bare, and by the exact call", () => {
    // Two links want this section and they want different things. The index knows which TOOL failed, so it
    // links `#step-1-exec` and lands on the call; a link that only knows "step 1" gets the bare anchor,
    // which sits on the step's first section. The bare one must appear ONCE per step, not once per
    // heading, or a step with a thought and a call would define it twice.
    const html = page(["## Step 1 · thought", "a", "## Step 1 · exec", "b", "## Step 2 · answer", "c"].join("\n\n"));
    assert.deepEqual([...html.matchAll(/class="anchor" id="(step-\d+)"/g)].map((m) => m[1]), ["step-1", "step-2"]);
    assert.match(html, /<details class="sec" open id="step-1-exec">/, "the call is addressable on its own");
    assert.ok(html.indexOf('id="step-1"') < html.indexOf("Step 1 · thought"), "the bare anchor precedes its step");

    // The slug lives on the SECTION, not on the heading inside its summary — the focusing rule targets
    // the section, and two elements cannot share an id.
    assert.ok(!/<h2 id=/.test(html), "the heading must not keep a duplicate of the section's id");
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, `duplicate ids would make an anchor ambiguous: ${ids}`);
});

test("sections are emitted OPEN — collapsing is asked for, never the state you land in", () => {
    // The focusing is pure CSS over `:target`, so the document itself must read as the full transcript.
    // If sections shipped closed, a plain open of the file would hide everything.
    const html = page(["## Step 1 · exec", "body text here"].join("\n\n"));
    assert.match(html, /<details class="sec" open/);
    assert.ok(!/<details class="sec">/.test(html));
});

test("the page's own script is admitted by HASH, and nothing else is", () => {
    // Folding uses the native `open` attribute, which needs script — a CSS-only version had to hide
    // section bodies, and that OVERRODE the native state, so "collapse all" followed by a heading click
    // did visibly nothing. Admitting script by hash keeps the reason the CSP was there: raw HTML passes
    // through for the sink's disclosures, so a scraped hostile page could otherwise run script when a
    // human reads the transcript. Its <script> matches no hash and is still refused.
    const html = page("## Step 1 · exec\n\nx");
    const csp = /content="(default-src[^"]*)"/.exec(html);
    assert.ok(csp, "the document must carry a policy");
    assert.match(csp[1], /script-src 'sha256-[A-Za-z0-9+/=]+'/, "by hash, never 'unsafe-inline'");
    assert.ok(!/unsafe-inline[^;]*script/.test(csp[1]));

    // The hash must be of the bytes that actually ship, or a drift silently disables the folding.
    const src = /<script>([\s\S]*?)<\/script>/.exec(html);
    assert.ok(src, "the script must be present");
    const want = createHash("sha256").update(src[1]).digest("base64");
    assert.ok(csp[1].includes(`'sha256-${want}'`), "the declared hash must match the script inline");

    // And it must parse, or the page silently loses every control on it.
    new Function(src[1]);
});

test("a hostile tool result cannot inject script into the page", () => {
    // The markdown contains whatever a tool returned and whatever the model wrote. The page is opened
    // from a local server on the developer's machine, so a run that scraped a hostile site must not be
    // able to run script when the transcript is READ.
    const html = page("Result:\n\n```\n<script>alert(1)</script>\n```\n\nand <script>alert(2)</script>");
    assert.ok(!/<script>alert\(1\)/.test(html), "code content must be escaped");
    assert.match(html, /&lt;script&gt;alert\(1\)/);

    // Raw HTML deliberately passes through — that is how the sink's <details> disclosures survive — so
    // the guard is the document's own policy rather than a sanitizer. The page runs no script of its
    // own, which is what makes denying it outright free.
    assert.match(html, /http-equiv="Content-Security-Policy"/);
    assert.match(html, /default-src 'none'/);
    assert.ok(/content="[^"]*"/.exec(html)[0].indexOf("script-src") === -1,
        "no script-src override may re-admit script through default-src");
});

test("a code fence in an unknown language still renders, escaped", () => {
    const html = page("```wat\n<b>&\n```");
    assert.match(html, /<pre><code class="hljs">&lt;b&gt;&amp;/);
});

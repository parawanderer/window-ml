// code-links.test.mjs — URLs and @tool: pointers made clickable INSIDE highlighted code (src/sidebar/code-links.ts):
// where a link is cut out of hljs's token HTML, which tokens keep their colour, and what stays text. Pure: no DOM.
import { test } from "node:test";
import assert from "node:assert";

const { linkifyHtml } = await import("../src/sidebar/code-links.ts");
const { highlight } = await import("../src/sidebar/format.ts");

const known = (id) => id === "abc1234" || id === "exec";
const anchors = (html) => [...html.matchAll(/<a [^>]*>/g)].map((m) => m[0]);
const text = (html) => html.replace(/<[^>]*>/g, "");
const raws = (html) => anchors(html).map((a) => /data-raw="([^"]*)"/.exec(a)?.[1]);

// --- a link keeps the token it sits in ---

test("a URL in a string token is an anchor INSIDE the string span, so it keeps the string colour", () => {
    const out = linkifyHtml('<span class="hljs-string">"see https://a.example/x now"</span>');
    assert.match(out, /<span class="hljs-string">"see <a [^>]*class="out-link"[^>]*>https:\/\/a\.example\/x<\/a> now"<\/span>/);
});

test("a URL in a comment token stays inside the comment span", () => {
    const out = linkifyHtml('<span class="hljs-comment">// docs: https://a.example/d.</span>');
    assert.match(out, /<span class="hljs-comment">\/\/ docs: <a [^>]*>https:\/\/a\.example\/d<\/a>\.<\/span>/);
});

test("a URL broken across two spans is one link cut into one anchor per span", () => {
    const out = linkifyHtml('<span class="a">https://a.exa</span><span class="b">mple/x</span>');
    assert.deepEqual(raws(out), ["https://a.example/x", "https://a.example/x"]);
    assert.match(out, /<span class="a"><a [^>]*>https:\/\/a\.exa<\/a><\/span><span class="b"><a [^>]*>mple\/x<\/a><\/span>/);
    assert.equal(text(out), "https://a.example/x");
});

test("the visible text is exactly the source text, whatever is linked", () => {
    const html = '<span class="hljs-string">&quot;https://a.example/?q=1&amp;r=2&quot;</span> <span class="x">tail</span>';
    assert.equal(text(linkifyHtml(html)), text(html));
    assert.deepEqual(raws(linkifyHtml(html)), ["https://a.example/?q=1&amp;r=2"]);
});

test("an entity in the address is decoded for the check and the anchor opens the decoded address", () => {
    const out = linkifyHtml("https://a.example/?q=1&amp;r=2");
    assert.match(out, /href="https:\/\/a\.example\/\?q=1&amp;r=2"/);
});

// --- what stays text ---

test("refused addresses stay text: zero-width, bidi, over-long, other schemes, userinfo", () => {
    for (const bad of ["https://a.exa​mple/x", "https://a.example/‮x", "https://a.example/⁦x", "javascript:alert(1)", "data:text/html,<b>x".replace("<", "&lt;"),
        "https://good.com@evil.com/", "https://a.example/" + "x".repeat(2100), "https://exämple.com/"]) {
        const html = `<span class="hljs-string">${bad}</span>`;
        assert.equal(linkifyHtml(html), html, JSON.stringify(bad.slice(0, 30)));
    }
});

test("html with nothing to link comes back as the very string", () => {
    const html = highlight("const x = 1; // nothing here", "javascript");
    assert.equal(linkifyHtml(html), html);
});

test("real hljs output: a URL in a JS string and a comment", () => {
    const out = linkifyHtml(highlight('const u = "https://a.example/p"; // see https://b.example/q', "javascript"), known);
    assert.deepEqual(raws(out), ["https://a.example/p", "https://b.example/q"]);
    assert.match(out, /hljs-string[^>]*>[^]*<a [^>]*>https:\/\/a\.example\/p<\/a>/);
    assert.match(out, /hljs-comment[^>]*>[^]*<a [^>]*>https:\/\/b\.example\/q<\/a>/);
});

test("text inside a tooltip pop is never linked", () => {
    const html = '<span class="tt tt-code expanded"><span class="tt-pop wrap">Expanded from <code>https://a.example/x</code></span>y</span>';
    assert.equal(linkifyHtml(html), html);
});

// --- @tool: pointers ---

test("a pointer naming a step is an anchor that carries its id", () => {
    const out = linkifyHtml('<span class="hljs-string">"@tool:abc1234:out"</span>', known);
    assert.match(out, /<a [^>]*data-ptr="abc1234"[^>]*data-slot="out"[^>]*>@tool:abc1234:out<\/a>/);
});

test("a pointer naming no step stays text, and with no resolver no pointer is linked", () => {
    const html = '<span class="hljs-string">"@tool:zzzzzzz"</span>';
    assert.equal(linkifyHtml(html, known), html);
    assert.equal(linkifyHtml('@tool:abc1234'), '@tool:abc1234');
});

test("a pointer glued to a word or longer than its id is not matched", () => {
    assert.equal(linkifyHtml("x@tool:abc1234", known), "x@tool:abc1234");
    assert.equal(linkifyHtml("@tool:abc1234x", known), "@tool:abc1234x");
});

test("a pointer inside a URL is part of the URL, not a second link", () => {
    const out = linkifyHtml("https://a.example/@tool:abc1234", known);
    assert.equal(anchors(out).length, 1);
    assert.doesNotMatch(out, /data-ptr/);
});

test("a tool-name alias resolves when the run has it", () => {
    assert.match(linkifyHtml("@tool:exec", known), /data-ptr="exec"/);
});

// --- the raw view: an hljs-link token that is not a link loses its underline ---

test("markdown raw view: a qualifying link target is linked and its token stays", () => {
    const out = linkifyHtml(highlight("see [x](https://a.example/p) and ![y](@tool:abc1234:out)", "markdown"), known);
    assert.deepEqual(raws(out), ["https://a.example/p", undefined], "the address, then the pointer (which has no data-raw)");
    assert.match(out, /data-ptr="abc1234"/);
    assert.doesNotMatch(out, /hljs-link-dead/);
});

test("markdown raw view: a relative path, a data: URI, a refused URL and a missing pointer lose the underline", () => {
    for (const target of ["docs/readme.md", "data:image/png;base64,AAAA", "javascript:alert(1)", "https://good.com@evil.com/", "@tool:zzzzzzz", "https://a.exa​mple/"]) {
        const base = highlight(`[x](${target})`, "markdown");
        assert.match(base, /hljs-link/, `fixture: hljs marks ${target} as a link`);
        const out = linkifyHtml(base, known);
        assert.match(out, /hljs-link hljs-link-dead/, target);
        assert.equal(anchors(out).length, 0, target);
    }
});

test("markdown raw view: a live link token is not marked dead, a dead one beside it is", () => {
    const out = linkifyHtml(highlight("[a](https://a.example/p) [b](nope.md)", "markdown"), known);
    assert.equal((out.match(/hljs-link-dead/g) || []).length, 1);
    assert.deepEqual(raws(out), ["https://a.example/p"]);
});

test("a dead mark is added only to an hljs-link span, in any language", () => {
    const html = '<span class="hljs-string">x</span>';
    assert.equal(linkifyHtml(html), html);
});

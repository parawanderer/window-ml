"use strict";
// Standalone tests for the sidebar markdown renderer (sidebar/format.ts) — the gaps that used to render
// wrong: nested bullets, ordered lists, and `---` thematic breaks. Escapes untrusted model output first.
import { test } from "node:test";
import assert from "node:assert";
import { markdown } from "../sidebar/format.ts";

test("nested bullets build nested <ul> (2-space / tab indent)", () => {
    const html = markdown("- A\n  - A1\n  - A2\n- B");
    assert.equal(html, "<ul><li>A<ul><li>A1</li><li>A2</li></ul></li><li>B</li></ul>");
});

test("ordered list → <ol> (both `1.` and `1)` markers)", () => {
    assert.equal(markdown("1. one\n2. two"), "<ol><li>one</li><li>two</li></ol>");
    assert.equal(markdown("1) a\n2) b"), "<ol><li>a</li><li>b</li></ol>");
});

test("ordered list nested inside a bullet", () => {
    const html = markdown("- steps:\n  1. first\n  2. second\n- done");
    assert.equal(html, "<ul><li>steps:<ol><li>first</li><li>second</li></ol></li><li>done</li></ul>");
});

test("`+` is a valid bullet", () => {
    assert.equal(markdown("+ x\n+ y"), "<ul><li>x</li><li>y</li></ul>");
});

test("thematic break: ---, ***, ___", () => {
    assert.equal(markdown("a\n\n---\n\nb"), "<p>a</p><hr><p>b</p>");
    assert.equal(markdown("***"), "<hr>");
    assert.equal(markdown("___"), "<hr>");
});

test("a bullet line is NOT mistaken for a thematic break", () => {
    assert.equal(markdown("- item"), "<ul><li>item</li></ul>");
});

test("a hr flushes an open list", () => {
    assert.equal(markdown("- a\n---\n- b"), "<ul><li>a</li></ul><hr><ul><li>b</li></ul>");
});

test("deep nesting closes correctly on dedent", () => {
    const html = markdown("- 1\n  - 1a\n    - 1a-i\n- 2");
    assert.equal(html, "<ul><li>1<ul><li>1a<ul><li>1a-i</li></ul></li></ul></li><li>2</li></ul>");
});

test("ordered list with indented continuation + blank lines stays ONE <ol> (numbering doesn't reset to 1.)", () => {
    // The Solution-Steps bug: each item had indented paragraphs / display math and blank lines between items,
    // which used to FLUSH the list — so every item became a fresh <ol> restarting at 1. The item now OWNS its
    // continuation content, so a single <ol> numbers 1,2,3 correctly.
    const src = "1. **First:**\n   some text\n   $$a=b$$\n\n2. **Second:**\n   more text\n\n3. **Third:**\n   done";
    const html = markdown(src, { math: true });
    assert.equal((html.match(/<ol>/g) || []).length, 1, "exactly ONE <ol> (not one per item)");
    assert.equal((html.match(/<li>/g) || []).length, 3, "three <li> items in that one list");
    // The lead label sits inline in the <li>, its continuation paragraph inside the SAME item.
    assert.match(html, /<li><strong>First:<\/strong><p>some text<\/p>/, "item keeps its indented continuation inside the <li>");
    assert.ok(html.includes("katex"), "the indented $$…$$ inside an item still typesets");
});

test("blank-separated simple list stays tight (no <p> spacing) but a multi-line item keeps its blocks", () => {
    // A model that puts a blank line between simple one-line bullets should NOT get loose <p>-wrapped items.
    assert.equal(markdown("- a\n\n- b\n\n- c"), "<ul><li>a</li><li>b</li><li>c</li></ul>", "blank-separated one-liners stay tight");
    // But an item with its own extra paragraph keeps it (inside the <li>).
    assert.equal(markdown("- lead\n  second line\n- next"),
        "<ul><li>lead<p>second line</p></li><li>next</li></ul>", "continuation paragraph lands inside the item");
});

test("inline code protects its contents from bold/italic (the `*` bug)", () => {
    // Two `*` code spans used to look like an italic run → both asterisks eaten.
    assert.equal(markdown("`*` >>> `*`"), "<p><code>*</code> &gt;&gt;&gt; <code>*</code></p>");
    // A single `*` in code survives too.
    assert.equal(markdown("the wildcard `*` matches all"), "<p>the wildcard <code>*</code> matches all</p>");
    // Real italic OUTSIDE code still works alongside a code span.
    assert.equal(markdown("*em* and `code`"), "<p><em>em</em> and <code>code</code></p>");
    // Underscores/asterisks inside code are literal, not emphasis.
    assert.equal(markdown("`a_b_c` and `x**y**z`"), "<p><code>a_b_c</code> and <code>x**y**z</code></p>");
});

// --- inline emphasis: nesting + `_` italic (the flat passes left inner emphasis literal) ---
test("nested emphasis: an italic inside a bold resolves (both markers)", () => {
    assert.equal(markdown("This **line does not _work_, only some** of it"),
        "<p>This <strong>line does not <em>work</em>, only some</strong> of it</p>");
    assert.equal(markdown("**a _b_ c**"), "<p><strong>a <em>b</em> c</strong></p>");
    assert.equal(markdown("*a **b** c*"), "<p><em>a <strong>b</strong> c</em></p>");
});

test("`_underscores_` are italic at a word boundary, but intraword `_` is literal", () => {
    assert.equal(markdown("an _emphasised_ word"), "<p>an <em>emphasised</em> word</p>");
    assert.equal(markdown("call python_exec now"), "<p>call python_exec now</p>");   // snake_case untouched
    assert.equal(markdown("a `code_with_underscores` span").includes("<em>"), false);   // underscores in code stay literal
});

test("emphasis never mangles a URL with underscores", () => {
    assert.equal(markdown("see [docs](https://x.com/a_b_c_d) now"),
        '<p>see <a href="https://x.com/a_b_c_d" target="_blank" rel="noopener">docs</a> now</p>');
});

// --- blockquotes (`>`) ---
test("blockquote: a `>` line renders a <blockquote> with inline formatting", () => {
    assert.equal(markdown("> Insanity is doing the same thing"),
        "<blockquote><p>Insanity is doing the same thing</p></blockquote>");
    assert.equal(markdown("before\n\n> a **bold** quote\n\nafter"),
        "<p>before</p><blockquote><p>a <strong>bold</strong> quote</p></blockquote><p>after</p>");
});

test("blockquote: consecutive `>` lines join; a blank quoted line splits paragraphs", () => {
    assert.equal(markdown("> line one\n> line two"),
        "<blockquote><p>line one line two</p></blockquote>");
    assert.equal(markdown("> para one\n>\n> para two"),
        "<blockquote><p>para one</p><p>para two</p></blockquote>");
});

// --- inline single-$ math (Pandoc/KaTeX delimiter rule — space-adjacency, NOT a content sniff) ---
test("inline $…$ typesets by the delimiter rule (spaced expressions included); currency does not", () => {
    assert.ok(markdown("the variable $x$ here", { math: true }).includes("katex"), "$x$ renders as math");
    assert.ok(markdown("$a+b$ and $mc^2$", { math: true }).includes("katex"), "$a+b$ / $mc^2$ render");
    // Spaced expressions with NO backslash/caret must render too — the reason we dropped the content sniff.
    assert.ok(markdown("With the double root $r = 2$, done.", { math: true }).includes("katex"), "$r = 2$ (spaced, no signal) renders");
    assert.ok(markdown("and $y(x) = u(t)$ transforms", { math: true }).includes("katex"), "$y(x) = u(t)$ renders");
    assert.ok(markdown("the solution is $y(x) =$ next", { math: true }).includes("katex"), "$y(x) =$ (trailing =) renders");
    // Currency stays literal purely via the space-adjacency guard (closing $ is preceded by a space / no close).
    assert.ok(!markdown("It costs $5 or $10.", { math: true }).includes("katex"), "currency is not math");
});

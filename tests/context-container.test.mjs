"use strict";
// Standalone tests for resolveContextContainer (dom.ts): the right-click "ask about this" resolver that
// climbs from a clicked leaf to the semantic content unit (a tweet/comment/card), deterministically.
// jsdom has no layout, so getBoundingClientRect is all-zero → the geometry cap no-ops here (it's a
// browser-only guard); these exercise the semantic-tag, text/link-density, and feed-item paths.
import { test } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { resolveContextContainer } from "../dom.ts";

function mount(html) {
    const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    return dom.window.document;
}
const pick = (id) => resolveContextContainer(document.getElementById(id));

test("semantic: clicking the timestamp/avatar of a tweet resolves the whole <article>", () => {
    mount(`<div id="feed"><article id="post"><img id="avatar" src="a.png"><span id="ts">12.4K</span>
        <p>Vaccines cause gravity to flip upside down. What a take, honestly.</p></article></div>`);
    assert.equal(pick("ts").id, "post");
    assert.equal(pick("avatar").id, "post");
});

test("semantic: role=\"article\" is honored too", () => {
    mount(`<div role="article" id="post"><span id="x">by @john</span><p>A real sentence, with content.</p></div>`);
    assert.equal(pick("x").id, "post");
});

test("slop: no semantic tags → the text-dense block wins over nav/link junk", () => {
    mount(`<div id="page">
        <div id="nav"><a href="#">Home</a><a href="#">About</a><a href="#">Contact</a></div>
        <div id="wrap"><div id="post"><span id="who">@john</span>
            <p>Vaccines cause gravity to flip upside down, obviously. What a take, huh?</p></div></div>
    </div>`);
    // climbing from #who: #post is the innermost text-dense unit; #page is penalised by nav link-density.
    assert.equal(pick("who").id, "post");
});

test("feed: clicking inside one of N similar siblings resolves THAT item", () => {
    mount(`<div id="feed">
        <div class="item" id="i1">post one, some real text content here.</div>
        <div class="item" id="i2">post two, more real text content here.</div>
        <div class="item" id="i3"><span id="click">reply</span> the third post's actual content text.</div>
    </div>`);
    assert.equal(pick("click").id, "i3");
});

test("nav junk: clicking a link in a link-dense nav does NOT grab the nav", () => {
    mount(`<nav id="nav"><a href="#" id="lnk">Home</a><a href="#">About</a><a href="#">Contact Us Today</a></nav>`);
    const r = pick("lnk");
    assert.notEqual(r.id, "nav", "a link-dense nav is rejected as junk");
});

// -------------------------------------------------------------------- domToContext (extraction) ---
import { domToContext } from "../dom.ts";

test("domToContext: block-structured text + media + links + scope selector + anchor", () => {
    mount(`<article id="post">
        <span id="who">@john_doe</span>
        <p>Vaccines cause gravity to flip.</p>
        <p>Second paragraph here.</p>
        <img src="https://x.test/chart.png" alt="a chart">
        <img src="data:image/png;base64,AAAA" alt="tracking pixel">
        <a href="https://x.test/src">source</a>
        <a href="https://x.test/src">source dup</a>
        <a href="javascript:void(0)">js</a>
    </article>`);
    const ctx = domToContext(document.getElementById("post"), document.getElementById("who"));
    // block text keeps paragraph breaks (not one run-on line)
    assert.match(ctx.text, /Vaccines cause gravity to flip\./);
    assert.match(ctx.text, /\n/, "block boundaries become newlines");
    // media: real image kept, data: URL (tracking) skipped
    assert.deepEqual(ctx.media, [{ src: "https://x.test/chart.png", alt: "a chart" }]);
    // links: deduped by href, javascript: dropped
    assert.deepEqual(ctx.links, [{ text: "source", href: "https://x.test/src" }]);
    assert.equal(ctx.role, "article");
    assert.match(ctx.selector, /#post/);
    assert.equal(ctx.anchorText, "@john_doe");
});

test("domToContext: long text is capped with a truncation marker", () => {
    const long = "word ".repeat(600);   // ~3000 chars
    mount(`<div id="big"><p>${long}</p></div>`);
    const ctx = domToContext(document.getElementById("big"), null, 200);
    assert.ok(ctx.text.length < 260, "text capped near maxText");
    assert.match(ctx.text, /\[\+\d+ chars\]/);
});

test("domToContext: script/style content is not included in the text", () => {
    mount(`<div id="c"><style>.x{color:red}</style><script>var secret=1</script><p>Real content.</p></div>`);
    const ctx = domToContext(document.getElementById("c"), null);
    assert.match(ctx.text, /Real content\./);
    assert.doesNotMatch(ctx.text, /color:red|var secret/);
});

// ------------------------------------------------------- askAboutTask (right-click task framing) ---
import { askAboutTask } from "../prompts.ts";

test("askAboutTask frames the element content + scope selector around the user's question", () => {
    const ctx = {
        selector: "#post", role: "article", text: "Vaccines cause gravity to flip.", anchorText: "12.4K",
        media: [{ src: "chart.png", alt: "a chart" }], links: [{ text: "source", href: "http://x/s" }],
    };
    const t = askAboutTask("how dumb is this?", ctx);
    assert.match(t, /RIGHT-CLICKED/);
    assert.match(t, /selector: #post/, "container selector named");
    assert.match(t, /Vaccines cause gravity/, "clean content included");
    assert.match(t, /chart\.png/, "media listed");
    assert.match(t, /source → http:\/\/x\/s/, "links listed");
    assert.match(t, /`#post`/, "scope selector offered for the DOM tools");
    assert.match(t, /how dumb is this\?/, "user's question preserved");
    // element-only (no typed question) → a sensible default task
    assert.match(askAboutTask("", ctx), /Tell me about the selected content/);
});

// --------------------------------------------- the demo page resolves as its ANSWER KEY documents ---
import { readFileSync } from "node:fs";

test("examples/ask-about-this.html: each region resolves to the unit its answer key claims", () => {
    const html = readFileSync(new URL("../examples/ask-about-this.html", import.meta.url), "utf8");
    const dom = new JSDOM(html);
    globalThis.window = dom.window; globalThis.document = dom.window.document;
    const doc = dom.window.document;
    const R = (el) => resolveContextContainer(el);

    // §1 semantic: the timestamp AND the 👍 count both climb to the whole <article>
    assert.equal(R(doc.querySelector("#tweet-1 .tw-time")).id, "tweet-1");
    const like = [...doc.querySelectorAll("#tweet-1 .tw-actions span")].find(s => /12\.4K/.test(s.textContent));
    assert.equal(R(like).id, "tweet-1");
    // §2 div soup: a comment body → that ._c0 comment (NOT the <main> wrapper)
    assert.equal(R(doc.querySelector('._c0[data-cmt="b"] ._b')).getAttribute("data-cmt"), "b");
    // §3 product: the price → the whole <section class="product">
    assert.equal(R(doc.querySelector("#product-1 .price")).id, "product-1");
    // §4 nav junk: a footer link is NOT resolved up to the link-dense nav
    assert.notEqual(R(doc.querySelector("#footer a")).id, "footer");
});

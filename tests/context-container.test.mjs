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

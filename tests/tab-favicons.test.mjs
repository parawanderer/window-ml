// The tab picker's icons (src/tab-favicons.ts): fetched by the runtime, handed on as data URLs, and only small images
// from http(s); and tabs in the browser's strip order.
import test from "node:test";
import assert from "node:assert/strict";
import { FAVICON_MAX_BYTES, FaviconCache, stripOrder } from "../src/tab-favicons.ts";

const reply = (bytes, type = "image/png", ok = true) => ({ ok, headers: { get: (k) => (k === "content-type" ? type : null) }, arrayBuffer: async () => new Uint8Array(bytes).buffer });

test("an http(s) icon is fetched once, without cookies, and handed on as a data URL", async () => {
    const calls = [];
    const icons = new FaviconCache(async (url, init) => { calls.push([url, init?.credentials]); return reply([1, 2, 3]); });
    const a = await icons.icon("https://site.example/favicon.ico");
    assert.equal(a, "data:image/png;base64,AQID");
    await icons.icon("https://site.example/favicon.ico");
    assert.deepEqual(calls, [["https://site.example/favicon.ico", "omit"]], "once, and never with the person's cookies");
});

test("only small images from http(s): anything else is no icon, never an error", async () => {
    const icons = new FaviconCache(async (url) => (url.includes("html") ? reply([60, 104], "text/html") : url.includes("big") ? reply(new Array(FAVICON_MAX_BYTES + 1).fill(0)) : url.includes("404") ? reply([], "image/png", false) : Promise.reject(new Error("offline"))));
    assert.equal(await icons.icon("https://a.example/html"), null);
    assert.equal(await icons.icon("https://a.example/big.png"), null);
    assert.equal(await icons.icon("https://a.example/404.png"), null);
    assert.equal(await icons.icon("https://a.example/offline.png"), null);
    assert.equal(await icons.icon("chrome://favicon/x"), null, "not a web URL: nothing is fetched");
    assert.equal(await icons.icon("data:text/html,<script>"), null, "a data URL that is not an image is dropped");
    assert.equal(await icons.icon("data:image/png;base64,AQID"), "data:image/png;base64,AQID", "a small image data URL passes as is");
});

test("a slow site does not hold the list: it is left out of this answer and arrives in the next", async () => {
    let release;
    const icons = new FaviconCache(async (url) => (url.includes("slow") ? new Promise((r) => { release = () => r(reply([9])); }) : reply([1])));
    const first = await icons.many(["https://fast.example/i.png", "https://slow.example/i.png"], 30);
    assert.deepEqual(first, ["data:image/png;base64,AQ==", null]);
    release();
    const second = await icons.many(["https://slow.example/i.png"], 30);
    assert.deepEqual(second, ["data:image/png;base64,CQ=="]);
});

test("the strip order: the focused window first, then windows as met, each by index", () => {
    const tabs = [
        { id: 1, windowId: 10, index: 1 }, { id: 2, windowId: 20, index: 0 }, { id: 3, windowId: 10, index: 0 },
        { id: 4, windowId: 30, index: 0 }, { id: 5, windowId: 20, index: 1 },
    ];
    assert.deepEqual(stripOrder(tabs, 20).map((t) => t.id), [2, 5, 3, 1, 4]);
    assert.deepEqual(stripOrder(tabs).map((t) => t.id), [3, 1, 2, 5, 4], "no focused window known: the order windows were met");
});

test("the default fetch is called as the browser's own, not as a method of the cache", async () => {
    // A browser's fetch throws "Illegal invocation" when called with any `this` but the global. Stored bare and called
    // as `this.fetchImpl(url)`, every icon came back null in the real worker while every test passing its own fetch
    // was green.
    const real = globalThis.fetch;
    globalThis.fetch = function (url) {
        if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
        return Promise.resolve(reply([1, 2, 3]));
    };
    try {
        assert.equal(await new FaviconCache().icon("https://site.example/favicon.ico"), "data:image/png;base64,AQID");
    } finally { globalThis.fetch = real; }
});

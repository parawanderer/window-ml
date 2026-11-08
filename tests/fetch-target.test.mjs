// fetch-target.test.mjs — what a relative URL passed to ml.fetch becomes before the fetch gate judges it.
//
// tests/background.test.js pins the page relay's rows (resolved against the page, no page refused, another origin judged
// as its absolute form). This file calls the worker's choke point directly, for what the router never lets a page send:
// a run whose page is a local file.

import { test } from "node:test";
import assert from "node:assert";

const { fetchTarget, fetchUrlFor } = await import("../src/sw/sw-fetch-url.ts");

// --- fetchTarget: the URL the gate judges ---

test("fetchTarget passes an absolute URL on as written, resolves a relative one against the page, and refuses one with no page", () => {
    assert.deepEqual(fetchTarget("https://a.example/x?y=1#z", "https://site.example/p"), { url: "https://a.example/x?y=1#z" });
    assert.deepEqual(fetchTarget("../q", "https://site.example/p/r"), { url: "https://site.example/q" });
    assert.deepEqual(fetchTarget("//other.example/x", "https://site.example/p"), { url: "https://other.example/x" });
    assert.deepEqual(fetchTarget("data:text/plain,hi", "https://site.example/p"), { url: "data:text/plain,hi" }, "a scheme of its own is absolute: the gate refuses it as non-http(s)");
    for (const blank of ["", "  "]) assert.deepEqual(fetchTarget(blank, "https://site.example/p"), { error: `Refused: "${blank}" is not a valid URL.` }, "a blank URL is not the page itself");
    for (const base of [undefined, ""]) assert.match(fetchTarget("/x", base).error, /^Refused: "\/x" is a relative URL, and this call has no page to resolve it against\./);
});

// --- a run on a local file: a relative URL is another local file ---

test("ADVERSARIAL: from a run on a local file, a relative URL is refused as the local file it names, never read", async () => {
    const page = "file:///Users/me/notes/a.html";
    const caller = { tabId: 9, frameUrl: page, tabUrl: page, untrusted: true, disclose: false };
    const rel = await fetchUrlFor({ url: "b.html" }, caller);
    const abs = await fetchUrlFor({ url: "file:///Users/me/notes/b.html" }, caller);
    assert.equal(rel.error, abs.error);
    assert.match(rel.error, /^Refused: ml\.fetch cannot read local files \("file:\/\/\/Users\/me\/notes\/b\.html"\)/);
    // The page itself, named relatively, gets the own-page refusal its absolute form gets.
    assert.equal((await fetchUrlFor({ url: "a.html" }, caller)).error, (await fetchUrlFor({ url: page }, caller)).error);
});

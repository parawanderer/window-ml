// A session's title (src/session-title.ts): one prompt and one cleanup for the runtime and the sidebar, and the cap a
// typed name is held to.
import test from "node:test";
import assert from "node:assert/strict";
import { TITLE_MAX, capTitle, cleanTitle, titleMessages } from "../src/session-title.ts";

test("a model's reply becomes a title: first line, no quotes or trailing dot, capped", () => {
    assert.equal(cleanTitle('\n  "Buy a lamp."\nextra'), "Buy a lamp");
    assert.equal(cleanTitle(""), "");
    assert.equal(cleanTitle("x".repeat(100)).length, 60);
});

test("a typed title is collapsed and capped, and empty stays empty", () => {
    assert.equal(capTitle("  two   words \n"), "two words");
    assert.equal(capTitle("   "), "");
    const long = capTitle("y".repeat(200));
    assert.equal(long.length, TITLE_MAX);
    assert.ok(long.endsWith("…"));
});

test("the prompt is bounded", () => {
    const [, user] = titleMessages("z".repeat(2000));
    assert.ok(user.content.length < 600);
});

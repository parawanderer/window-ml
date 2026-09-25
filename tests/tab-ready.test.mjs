// tab-ready.test.mjs — the two ways opening a tab for a run fails, and saying which one it was.
//
// The wait loop cannot tell them apart on its own: `chrome.scripting.executeScript` throws identically whether the
// page never loaded or the browser will not let the extension run there. It reported the second for both, which is a
// confident wrong answer — and since a blank run now defaults to a page nobody typed, the wrong half reads as the
// extension having wandered off somewhere on its own.

import test from "node:test";
import assert from "node:assert/strict";

const { tabReadyFailure } = await import("../src/tab-ready.ts");

// --- which of the two causes it was ---

test("a navigation error is reported as the page not being reachable, and carries the browser's own reason", () => {
    const msg = tabReadyFailure("https://example.com/blank.html", "net::ERR_NAME_NOT_RESOLVED");
    assert.match(msg, /could not be reached/);
    assert.match(msg, /net::ERR_NAME_NOT_RESOLVED/, "the browser's reason is the actionable half");
    assert.doesNotMatch(msg, /site access|not let the extension/, "this one is not about permission");
});

test("no navigation error means the page loaded and the extension still could not run: site access", () => {
    const msg = tabReadyFailure("https://example.com/blank.html", null);
    assert.match(msg, /does not let the extension run on https:\/\/example\.com/);
    assert.match(msg, /site access/, "names the setting, since that is the thing to go and change");
    assert.doesNotMatch(msg, /could not be reached/, "the page loaded fine; saying otherwise sends them to the wrong place");
});

test("it names the ORIGIN, not the whole address, and falls back to the string when that is not a URL", () => {
    // The path is noise in a sentence about a per-SITE setting, which is what the browser grants by origin.
    assert.match(tabReadyFailure("https://example.com/a/b/c.html?x=1", null), /https:\/\/example\.com —/);
    assert.match(tabReadyFailure("not a url", null), /not a url/);
});

test("an error with no reason attached still reads as unreachable rather than as permission", () => {
    // `onErrorOccurred` always carries an `error`, but a missing one must not silently flip the diagnosis.
    assert.match(tabReadyFailure("https://example.com/", "the load failed"), /could not be reached/);
});

// blank-start.test.mjs — reading a runtime's answer about whether a NEW-TAB run can start, and which ways out exist.
//
// The ways out differ by runtime, which is why this is a state machine and not a boolean: a permission prompt can
// only be raised by the device that IS the runtime, so a remote one has to be offered what it already holds, or
// words to carry to it. The wrong reading here either blocks a start that works or offers a button that cannot.

import test from "node:test";
import assert from "node:assert/strict";

const { blankStartState, originPattern, originUrl, siteAccessSteps } = await import("../src/chat/blank-start.ts");

const rt = (blankStart, over = {}) => ({ id: "r1", name: "Desk PC", kind: "desktop", online: true, contractVersion: 1, grants: [], capabilities: { agent: true, ...(blankStart ? { blankStart } : {}) }, ...over });
const PAGE = "https://pages.example/agent-start.html";

// --- when there is nothing to say ---

test("a runtime that granted it, or never mentioned it, is not blocked", () => {
    assert.equal(blankStartState(rt({ url: PAGE, granted: true }), true).kind, "ok");
    // ABSENT IS NOT BLOCKED. An older runtime reports no `blankStart` at all, and refusing to start on one that
    // never claimed a problem would break every run on it.
    assert.equal(blankStartState(rt(null), true).kind, "ok");
    assert.equal(blankStartState(undefined, true).kind, "ok");
});

// --- blocked, and who can do something about it ---

test("on a runtime this device IS, the way out is the permission prompt, for that one origin", () => {
    const s = blankStartState(rt({ url: PAGE, granted: false }), true);
    assert.equal(s.kind, "grantable");
    assert.equal(s.origin, "https://pages.example/*", "the narrow grant, not <all_urls>");
});

test("on a REMOTE runtime holding other sites, those sites are the offer — nothing here can grant anything", () => {
    const s = blankStartState(rt({ url: PAGE, granted: false, origins: ["https://a.example/*", "https://b.example/*"] }), false);
    assert.equal(s.kind, "propose");
    assert.equal(s.runtime, "Desk PC");
    assert.deepEqual(s.choices.map((c) => c.url), ["https://a.example/", "https://b.example/"]);
});

test("a remote runtime holding nothing gets words for the machine it is about, in THAT machine's browser", () => {
    const s = blankStartState(rt({ url: PAGE, granted: false, browser: "Brave", extensionId: "abc123" }), false);
    assert.equal(s.kind, "elsewhere");
    assert.match(s.steps, /On Desk PC, in Brave/);
    assert.match(s.steps, /brave:\/\/extensions\/\?id=abc123/, "a direct address beats a hunt through a list");
    assert.doesNotMatch(s.steps, /chrome:\/\//, "the reader's browser is not the one that has to change");
});

test("with no browser reported the steps still say something usable, without inventing a browser", () => {
    const s = blankStartState(rt({ url: PAGE, granted: false }), false);
    assert.equal(s.kind, "elsewhere");
    assert.match(s.steps, /the browser/);
    assert.match(s.steps, /Site access/);
});

// --- the two URL shapes this passes around ---

test("an origin pattern and the page it stands for round-trip, and rubbish does not throw", () => {
    assert.equal(originPattern("https://x.example/a/b?c=1"), "https://x.example/*");
    assert.equal(originUrl("https://x.example/*"), "https://x.example/");
    assert.equal(originUrl("not a pattern"), "", "unopenable is dropped rather than offered");
    assert.equal(originPattern("not a url"), "not a url");
});

test("an origin that cannot be turned into a page is not proposed", () => {
    const s = blankStartState(rt({ url: PAGE, granted: false, origins: ["*://*/*", "https://ok.example/*"] }), false);
    assert.deepEqual(s.choices.map((c) => c.url), ["https://ok.example/"]);
});

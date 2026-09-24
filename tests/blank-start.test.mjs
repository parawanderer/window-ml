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

// --- the one-line refusal, which is what a picker's row and a chip have room for ---

test("the row's reason names the machine and the way out, and is shared by both surfaces", async () => {
    // The phone's resume sheet wrote this sentence inline, which is how two surfaces start explaining one rule in two
    // voices. It is one function now, and these are the words both of them say.
    const { blankBlockedReason } = await import("../src/chat/blank-start.ts");
    const propose = blankStartState(rt({ url: PAGE, granted: false, origins: ["https://a.example/*"] }), false);
    const elsewhere = blankStartState(rt({ url: PAGE, granted: false, browser: "Brave", extensionId: "z9" }), false);

    assert.match(blankBlockedReason(propose), /^Desk PC may not open a new page/);
    assert.match(blankBlockedReason(propose), /pick one of its tabs/, "a picker's row must say what to do instead");
    assert.match(blankBlockedReason(elsewhere), /^Desk PC may not open a new page\./);
    assert.match(blankBlockedReason(elsewhere), /brave:\/\/extensions/, "and where there is nothing to pick, where to go");
});

test("nothing is refused where nothing is wrong, or where there is a prompt to raise instead", async () => {
    const { blankBlockedReason } = await import("../src/chat/blank-start.ts");
    assert.equal(blankBlockedReason({ kind: "ok" }), undefined);
    // `grantable` is an OFFER, not a refusal: this device is the runtime, so there is a permission prompt to raise,
    // and a disabled row saying "may not" would be false. It is the dialog's business, not a row's.
    assert.equal(blankBlockedReason(blankStartState(rt({ url: PAGE, granted: false }), true)), undefined);
});

// --- every surface that can put a run on a tab asks the same question ---

test("a phone is never the runtime, so it never sees the grantable state", () => {
    // `canGrant` is false by construction there (it cannot raise a prompt on another machine), which is what leaves
    // it with exactly two shapes to draw: the sites that machine already holds, or the words to carry to it.
    for (const cap of [{ url: PAGE, granted: false }, { url: PAGE, granted: false, origins: ["https://a.example/*"] }]) {
        assert.notEqual(blankStartState(rt(cap), false).kind, "grantable");
    }
});

test("a runtime that granted it is never refused on any surface, however little else it reports", async () => {
    // The commonest runtime of all: everything permitted, nothing to say. A refusal here would block every new-tab
    // run and every resume onto one, which is the failure worth being most afraid of.
    const { blankBlockedReason } = await import("../src/chat/blank-start.ts");
    for (const cap of [{ url: PAGE, granted: true }, { url: PAGE, granted: true, browser: "Brave" }]) {
        for (const canGrant of [true, false]) {
            const st = blankStartState(rt(cap), canGrant);
            assert.equal(st.kind, "ok");
            assert.equal(blankBlockedReason(st), undefined);
        }
    }
});

// --- every surface that can put a run on a page consults the SAME module ---

test("all four places a run can be aimed at a page ask this module, rather than deciding for themselves", async () => {
    // THE FAILURE THIS CATCHES is not a wrong answer, it is a surface that never asks — which is what the phone's
    // resume sheet was: it took the tap and let the runtime fail. That cannot be seen by testing this module, only by
    // looking at who calls it, so this reads the sources. The alternative is four end-to-end tests on two platforms.
    const { readFileSync } = await import("node:fs");
    const SURFACES = {
        "src/chat/start-page.tsx": "the web's new run",
        "src/chat/new-session.tsx": "the web's resume dialog",
        "mobile/src/screens/NewChatScreen.tsx": "the phone's new run",
        "mobile/src/resume.tsx": "the phone's resume sheet",
    };
    for (const [file, what] of Object.entries(SURFACES)) {
        const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
        assert.match(src, /blankStartState\s*\(/, `${what} (${file}) must ask before offering a page`);
        // And ask the SHARED one: a local copy of the rules is the drift this is here to prevent.
        assert.match(src, /from "(\.\.\/)*(\.\.\/src\/chat\/|\.\/)blank-start"/, `${what} must import the shared module`);
    }
});

test("the phone reaches it by a path Metro can follow, which is what makes sharing it possible at all", async () => {
    // `src/chat` is in Metro's watchFolders (metro.config.js, guarded by mobile-imports.test.mjs). A value import
    // from anywhere else typechecks, runs in debug, and breaks the RELEASE bundle — so the sharing rests on that.
    const { readFileSync } = await import("node:fs");
    const metro = readFileSync(new URL("../mobile/metro.config.js", import.meta.url), "utf8");
    assert.match(metro, /watchFolders[\s\S]*"chat"/, "src/chat must stay watched, or the phone's import of it cannot ship");
});

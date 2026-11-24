// no-tab.test.mjs — rule 4b slice E, the chat half: the banner's sentence for a run with no tab (src/chat/no-tab.ts), and
// who may bring such a run to a page. Where the banner and the row's mark are DRAWN is in e2e/chat-web.spec.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { noTabText, mayBringHere } from "../src/chat/no-tab.ts";
import { resumableHere } from "../src/chat/grants.ts";
import { SESSION_CONTRACT_VERSION } from "../src/session/session-host.ts";

// --- noTabText: every shape of the background, enumerated ---

test("noTabText: null unless the worker said noTab, whatever else the background holds", () => {
    assert.equal(noTabText(undefined), null, "background absent");
    assert.equal(noTabText(null), null);
    assert.equal(noTabText({ running: 0, waiting: 0 }), null);
    assert.equal(noTabText({ running: 1, waiting: 0 }), null, "a count without noTab is the row's mark, not a banner");
    assert.equal(noTabText({ running: 2, waiting: 1, noTab: false }), null, "noTab false with counts");
    assert.equal(noTabText({ running: 0, waiting: 0, releaseAt: 1700000000000 }), null, "releaseAt alone");
});

test("noTabText: the sentence for each count, and the closing line only when a result is owed", () => {
    const T = "This run has no tab.";
    const tail = " A result is read at its next turn.";
    assert.equal(noTabText({ running: 0, waiting: 0, noTab: true }), T, "noTab alone says only that");
    assert.equal(noTabText({ running: 1, waiting: 0, noTab: true }), `${T} 1 running in background.${tail}`);
    assert.equal(noTabText({ running: 3, waiting: 0, noTab: true }), `${T} 3 running in background.${tail}`);
    assert.equal(noTabText({ running: 0, waiting: 1, noTab: true }), `${T} 1 result waiting.${tail}`);
    assert.equal(noTabText({ running: 0, waiting: 2, noTab: true }), `${T} 2 results waiting.${tail}`);
    assert.equal(noTabText({ running: 2, waiting: 1, noTab: true }), `${T} 2 running · 1 result waiting.${tail}`);
    assert.equal(noTabText({ running: 0, waiting: 0, noTab: true, releaseAt: 1700000000000 }), T, "releaseAt adds nothing");
    // The composer sentence, only when the composer is drawn under the banner.
    const C = " A message sent here starts its next turn, with no page.";
    assert.equal(noTabText({ running: 0, waiting: 0, noTab: true }, { composer: true }), T + C);
    assert.equal(noTabText({ running: 1, waiting: 0, noTab: true }, { composer: true }), `${T} 1 running in background.${tail}${C}`);
    assert.equal(noTabText({ running: 2, waiting: 1, noTab: true }, { composer: true }), `${T} 2 running · 1 result waiting.${tail}${C}`);
    assert.equal(noTabText({ running: 1, waiting: 0, noTab: true }, { composer: false }), `${T} 1 running in background.${tail}`);
    assert.equal(noTabText({ running: 1, waiting: 0 }, { composer: true }), null, "no banner without noTab, composer or not");
});

// --- mayBringHere: each condition on its own ---

const rt = (over = {}) => ({ id: "laptop", name: "laptop", kind: "browser", online: true, contractVersion: SESSION_CONTRACT_VERSION, capabilities: { agent: true }, grants: [{ scope: "view" }, { scope: "drive" }], ...over });
const sum = (over = {}) => ({ id: { runtime: "laptop", hash: "c0ffee12" }, kind: "agent", status: "running", createdTs: 1, lastTs: 1, pendingApprovals: 0, saved: true, background: { running: 1, waiting: 0, noTab: true }, ...over });
const key = "laptop:c0ffee12";
const self = { id: "me", kind: "device" };

test("mayBringHere: true only for an online runtime, a saved agent run marked noTab, and the grant", () => {
    assert.equal(mayBringHere(rt(), key, sum(), self), true);
    assert.equal(mayBringHere(rt(), key, sum({ status: "done" }), self), true, "status is not asked");
    assert.equal(mayBringHere(rt({ online: false }), key, sum(), self), false, "offline");
    assert.equal(mayBringHere(undefined, key, sum(), self), false, "no runtime");
    assert.equal(mayBringHere(rt(), key, sum({ kind: "chat" }), self), false, "a chat");
    assert.equal(mayBringHere(rt(), key, sum({ saved: false }), self), false, "unsaved");
    assert.equal(mayBringHere(rt(), key, sum({ background: { running: 1, waiting: 0 } }), self), false, "no noTab");
    assert.equal(mayBringHere(rt(), key, sum({ background: undefined }), self), false, "no background");
    assert.equal(mayBringHere(rt(), key, undefined, self), false, "no summary");
    assert.equal(mayBringHere(rt({ grants: [{ scope: "view" }] }), key, sum(), self), false, "a watcher holds no session.resume");
});

// --- upgrade: a summary as the index wrote it before the background field ---

test("upgrade: a pre-background summary draws no banner, no bring-here, and keeps today's resume rule", () => {
    const old = { id: { runtime: "laptop", hash: "c0ffee12" }, kind: "agent", status: "capped", createdTs: 1, lastTs: 1, pendingApprovals: 0, saved: true, page: { url: "https://a.example/" } };
    assert.equal("background" in old, false);
    assert.equal(noTabText(old.background), null);
    assert.equal(mayBringHere(rt(), key, old, self), false);
    assert.equal(resumableHere(rt(), key, old, self), true, "the old 'tab closed' bar is still offered");
});

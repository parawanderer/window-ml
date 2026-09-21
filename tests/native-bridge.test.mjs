// native-bridge.test.mjs — the phone app's bridge (src/native/bridge.ts) and the chrome the page computes for it
// (src/native/snapshot.ts): what crosses, what is refused, and what the header and composer are told.
import { test } from "node:test";
import assert from "node:assert/strict";

const B = await import("../src/native/bridge.ts");
const { sessionChrome } = await import("../src/native/snapshot.ts");

test("a message round-trips with its version, and each side accepts only its own direction", () => {
    const wire = B.encode({ type: "send", id: "a1", key: "laptop:7b21", text: "hi" });
    assert.deepEqual(JSON.parse(wire), { v: B.BRIDGE_VERSION, type: "send", id: "a1", key: "laptop:7b21", text: "hi" });
    assert.deepEqual(B.parseToWeb(wire), { type: "send", id: "a1", key: "laptop:7b21", text: "hi" });
    assert.equal(B.parseToNative(wire), null, "an app → page message is not a page → app one");
    assert.deepEqual(B.parseToNative(B.encode({ type: "copyText", text: "x" })), { type: "copyText", text: "x" });
});

test("anything malformed, unknown, or from another version is dropped whole", () => {
    const bad = [
        "not json", 42, null, {},
        { v: 2, type: "close" },                                          // another bridge version
        { v: 1, type: "nuke" },                                           // unknown type
        { v: 1, type: "send", id: "a", key: "k" },                        // missing text
        { v: 1, type: "send", id: "a", key: "k", text: 5 },               // wrong kind
        { v: 1, type: "send", id: "a", key: "k", text: "t", images: "x" }, // optional field of the wrong kind
        { v: 1, type: "answer", key: "k", seq: "3", decision: true },     // a number as a string
        { v: 1, type: "__proto__" },                                      // not an own key of the table
    ];
    for (const m of bad) assert.equal(B.parseToWeb(typeof m === "string" ? m : JSON.stringify(m)), null, JSON.stringify(m));
    assert.equal(B.parseToNative(JSON.stringify({ v: 1, type: "account", account: [] })), null, "an array is not an account");
    assert.deepEqual(B.parseToNative(JSON.stringify({ v: 1, type: "account", account: null })), { type: "account", account: null });
});

const rt = (over = {}) => ({ id: "laptop", name: "Work laptop", kind: "browser", online: true, contractVersion: 1, grants: [{ scope: "drive" }, { scope: "approve" }], capabilities: { chat: true, switchModel: true }, ...over });
const summary = (over = {}) => ({ id: { runtime: "laptop", hash: "7b21" }, kind: "chat", status: "done", createdTs: 0, lastTs: 0, pendingApprovals: 2, saved: true, title: "KV cache", model: "qwen3:32b", ...over });
const self = { id: "me", kind: "device" };

test("the chrome of a session this device may drive: it can send and switch, and sees what waits on it", () => {
    const c = sessionChrome("laptop:7b21", summary(), rt(), self);
    assert.equal(c.canSend, true);
    assert.equal(c.readOnly, undefined);
    assert.equal(c.canSwitchModel, true);
    assert.equal(c.pendingApprovals, 2);
    assert.equal(c.running, false);
    assert.equal(sessionChrome("laptop:7b21", summary({ status: "running" }), rt(), self).running, true);
    assert.equal(sessionChrome("laptop:7b21", summary(), rt(), self, { pending: true }).running, true, "the transcript knows first");
});

test("each reason the composer or the model pill is off says so, in the page's words", () => {
    const watch = sessionChrome("laptop:7b21", summary(), rt({ grants: [{ scope: "view" }] }), self);
    assert.equal(watch.canSend, false);
    assert.match(watch.readOnly, /may watch sessions on Work laptop, not drive them/);
    assert.equal(watch.pendingApprovals, 0, "a watcher cannot answer, so nothing waits on it");
    const off = sessionChrome("laptop:7b21", summary(), rt({ online: false }), self);
    assert.match(off.readOnly, /offline/);
    assert.match(off.switchNote, /offline/);
    assert.match(sessionChrome("laptop:7b21", summary(), rt({ capabilities: { chat: true } }), self).switchNote, /cannot switch a session's model/);
    assert.match(sessionChrome("laptop:7b21", summary(), rt(), self, undefined, true).switchNote, /page script/);
    assert.equal(sessionChrome("laptop:7b21", undefined, rt(), self), null, "not in the index: no chrome");
});

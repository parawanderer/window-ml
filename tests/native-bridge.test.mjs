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

test("every message the page can post passes the app's own check", () => {
    // Each kind of ToNative, in the shape native-embed.tsx sends it: a check stricter than the sender drops a real
    // message (the model list was dropped as "not an object" because it is an array).
    const posted = [
        { type: "ready", bundle: "abc1234" },
        { type: "account", account: { label: "This phone", hubUrl: "wss://hub", root: false } },
        { type: "status", status: { state: "online" } },
        { type: "index", runtimes: [], sessions: [] },
        { type: "session", chrome: null },
        { type: "models", runtime: "laptop", models: [{ id: "qwen3:32b" }] },
        { type: "models", runtime: "laptop", models: null, error: "unreachable" },
        { type: "sent", id: "s1", ok: true, session: "laptop:1" },
        { type: "sent", id: "s2", ok: false, error: "network down" },
        { type: "notice", text: "Failed", tone: "error" },
        { type: "saveFile", name: "a.csv", mime: "text/csv", base64: "YQ==" },
        { type: "openImage", src: "data:image/png;base64,AA==" },
        { type: "openLink", url: "https://example.com" },
        { type: "copyText", text: "x" },
    ];
    for (const m of posted) assert.deepEqual(B.parseToNative(B.encode(m)), m, m.type);
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

test("every message the app can send passes the page's own check", () => {
    // Each kind of ToWeb, in the shape mobile/src/embed.tsx builds it.
    const sent = [
        { type: "theme", theme: { scheme: "dark", fontScale: 1, insets: { top: 0, bottom: 0, left: 0, right: 0 }, reducedMotion: false } },
        { type: "open", key: "laptop:1" },
        { type: "close" },
        { type: "send", id: "n1", key: "laptop:1", text: "hi" },
        { type: "send", id: "n2", key: "laptop:1", text: "look", images: ["data:image/png;base64,AA=="] },
        { type: "start", id: "n3", runtime: "laptop", kind: "chat", text: "hello", model: "qwen3:32b" },
        { type: "cancel", key: "laptop:1" },
        { type: "continue", key: "laptop:1" },
        { type: "answer", key: "laptop:1", seq: 4, decision: true },
        { type: "switchModel", key: "laptop:1", model: "gemma3:27b" },
        { type: "models", runtime: "laptop" },
        { type: "resume" },
    ];
    for (const m of sent) assert.deepEqual(B.parseToWeb(B.encode(m)), m, m.type);
});

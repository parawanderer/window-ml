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
        { type: "chromeOf", id: "n10", chrome: null },
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
    // What the ⋮ sheet may offer follows the grants, the same questions the page's row menu asks.
    assert.equal(c.pinned, false);
    const all = sessionChrome("laptop:7b21", summary({ pinned: true }), rt(), self);
    assert.equal(all.pinned, true);
    assert.deepEqual([all.canPin, all.canRename, all.canDelete], [true, true, true], "each needs `drive`, which this device holds");
    const watch = sessionChrome("laptop:7b21", summary(), rt({ grants: [{ scope: "view" }] }), self);
    assert.deepEqual([watch.canPin, watch.canRename, watch.canDelete], [false, false, false], "a device that only watches changes nothing");
    const away = sessionChrome("laptop:7b21", summary(), rt({ online: false }), self);
    assert.deepEqual([away.canPin, away.canRename, away.canDelete], [false, false, false], "nor does anyone, on a runtime that is offline");
    // Looking at the page: a tab still open, a runtime that captures, and the `screen` grant to ask. Each missing one hides it.
    const tab = { page: { url: "https://example.com", title: "Example", tabId: 12 } };
    const cam = (over = {}) => rt({ grants: [{ scope: "drive" }, { scope: "screen" }], capabilities: { chat: true, screenshots: true }, ...over });
    assert.equal(sessionChrome("laptop:7b21", summary(tab), cam(), self).canPeek, true);
    assert.equal(c.canPeek, false, "no tab: nothing to look at");
    assert.equal(sessionChrome("laptop:7b21", summary({ page: { url: "https://example.com", title: "Example" } }), cam(), self).canPeek, false, "the run's tab has closed");
    assert.equal(sessionChrome("laptop:7b21", summary(tab), cam({ capabilities: { chat: true } }), self).canPeek, false, "a runtime that cannot capture");
    assert.equal(sessionChrome("laptop:7b21", summary(tab), cam({ grants: [{ scope: "drive" }] }), self).canPeek, false, "a device without the grant to ask");
    assert.equal(sessionChrome("laptop:7b21", summary(tab), cam({ online: false }), self).canPeek, false, "a runtime that is offline");
    // The app's bar is for an approval the reader cannot see; while the card is on screen, the card speaks for itself.
    assert.equal(c.approvalOffscreen, false);
    assert.equal(sessionChrome("laptop:7b21", summary(), rt(), self, { pending: false, gateAway: true }).approvalOffscreen, true);
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
        { type: "peek", id: "n9", key: "laptop:1" },
        { type: "chromeFor", id: "n10", key: "laptop:1" },
        { type: "resume" },
        { type: "showApproval" },
        { type: "pin", id: "p9", key: "laptop:1", on: true },
        { type: "rename", id: "r9", key: "laptop:1", title: "Fares to Lisbon" },
        { type: "delete", id: "d9", key: "laptop:1" },
        { type: "search", id: "q1", query: "fare" },
        { type: "search", id: "q1", query: "fare", more: true },
    ];
    for (const m of sent) assert.deepEqual(B.parseToWeb(B.encode(m)), m, m.type);
});

const { pairingBridge, pairingInfo } = await import("../src/native/pairing-bridge.ts");
const { fakePairing } = await import("../src/pairing/fake-pairing.ts");

/** A bridge over a fake pairing, collecting what it posts; `call` sends one message and resolves once it is answered. */
function pairingRig(fake) {
    const out = [];
    const handle = pairingBridge(fake, (m) => out.push(m));
    let n = 0;
    const call = async (call, args) => {
        const id = `p${++n}`;
        await handle({ type: "pairing", id, call, ...(args ? { args } : {}) });
        return out.find((m) => m.type === "pairingResult" && m.id === id);
    };
    return { out, call };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("pairing over the bridge: joining shows a code, and the other device's answer arrives as pairingDone", async () => {
    const fake = fakePairing({ joinsAs: "client", defaultLabel: "Phone", membership: null });
    const { out, call } = pairingRig(fake);
    assert.equal((await call("load")).value, null);
    const r = await call("beginOffer", { hubUrl: "wss://hub", label: "Phone" });
    assert.equal(r.ok, true);
    assert.match(r.value.offer, /^o\d+$/);
    assert.equal(r.value.code, fake.waiting.code, "the code the other device types");
    assert.equal(r.value.fingerprint, fake.waiting.fingerprint);
    fake.answer("Phone");
    await tick(); await tick();
    assert.deepEqual(out.filter((m) => m.type === "pairingDone"), [{ type: "pairingDone", offer: r.value.offer, ok: true }]);
    // A join that fails says why, in the page's words.
    const r2 = await call("beginOffer", { hubUrl: "wss://hub", label: "Phone" });
    fake.fail("timed-out");
    await tick(); await tick();
    assert.deepEqual(out.filter((m) => m.type === "pairingDone").at(-1), { type: "pairingDone", offer: r2.value.offer, ok: false, error: "Nobody answered the code in time. Start again for a new code." });
});

test("pairing another device: look its code up, confirm by token, and nothing library-internal crosses", async () => {
    const fake = fakePairing({ membership: { label: "Phone", role: "client", hubUrl: "wss://hub", fingerprint: "5ab0e19c44d2", root: true, mayPair: true }, grantable: null });
    fake.addOffer("7K3M Q9XD", { label: "Kitchen tablet", role: "client", fingerprint: "a41c9e07d3b2", ref: { secret: "library object" } });
    const { call } = pairingRig(fake);
    const missing = await call("lookupOffer", { code: "ZZZZ ZZZZ" });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /No device is waiting under that code/);
    const f = await call("lookupOffer", { code: "7k3m-q9xd" });
    assert.equal(f.ok, true);
    assert.equal(f.value.label, "Kitchen tablet");
    assert.equal("ref" in f.value, false, "the library's reference stays on the page");
    assert.match(f.value.token, /^f\d+$/);
    const bad = await call("confirmOffer", { token: f.value.token, grant: { scopes: "view", mayPair: false, mayRevoke: false, validityMs: 1 } });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /not one this page can give/);
    const ok = await call("confirmOffer", { token: f.value.token, grant: { ...f.value.grant, scopes: ["view"] } });
    assert.equal(ok.ok, true);
    assert.deepEqual(fake.confirmed.map((c) => [c.label, c.grant.scopes]), [["Kitchen tablet", ["view"]]]);
    const again = await call("confirmOffer", { token: f.value.token, grant: f.value.grant });
    assert.match(again.error, /no longer waiting/, "a token is used once");
});

test("what the app is told this device can do about accounts", () => {
    const info = pairingInfo(fakePairing({ joinsAs: "client", defaultLabel: "Phone", defaultHubUrl: "wss://hub", rootKeptIn: "this app", devices: [] }));
    assert.deepEqual(info, { canCreate: true, joinsAs: "client", defaultLabel: "Phone", defaultHubUrl: "wss://hub", rootKeptIn: "this app", canScan: true, devices: true });
});

test("the pairing messages pass the other side's check", () => {
    for (const m of [
        { type: "pairingInfo", info: { canCreate: true, joinsAs: "client", defaultLabel: "Phone", defaultHubUrl: "wss://hub", canScan: true, devices: true } },
        { type: "pairingResult", id: "p1", ok: true, value: { offer: "o1" } },
        { type: "pairingResult", id: "p2", ok: false, error: "No device is waiting under that code." },
        { type: "pairingDone", offer: "o1", ok: true },
        { type: "searchResult", id: "q1", rows: [], more: false },
    ]) assert.deepEqual(B.parseToNative(B.encode(m)), m, m.type);
    for (const m of [
        { type: "pairing", id: "p1", call: "load" },
        { type: "pairing", id: "p2", call: "confirmOffer", args: { token: "f1", grant: { scopes: ["view"], mayPair: false, mayRevoke: false, validityMs: 1 } } },
    ]) assert.deepEqual(B.parseToWeb(B.encode(m)), m, m.type);
});

const { bridgeVault } = await import("../src/native/vault-bridge.ts");

test("the store messages pass the other side's check, and a name it does not keep is refused page-side", async () => {
    const { bridgeStore } = await import("../src/native/store-bridge.ts");
    for (const m of [
        { type: "store", id: "t1", op: "get", name: "membership" },
        { type: "store", id: "t2", op: "set", name: "r-devices", value: "[]" },
    ]) assert.deepEqual(B.parseToNative(B.encode(m)), m, m.type);
    assert.deepEqual(B.parseToWeb(B.encode({ type: "storeResult", id: "t1", ok: true, value: "{}" })), { type: "storeResult", id: "t1", ok: true, value: "{}" });
    const posted = [];
    const b = bridgeStore((m) => posted.push(m), 20);
    await assert.rejects(b.store.get("../../etc/passwd"), /not a name this store keeps/);
    assert.equal(posted.length, 0, "nothing that shaped reaches the app");
    await assert.rejects(b.store.get("membership"), /did not answer/);
});

test("the vault messages pass the other side's check", () => {
    for (const m of [
        { type: "vault", id: "v1", op: "get", name: "self" },
        { type: "vault", id: "v2", op: "set", name: "membership", value: "{}" },
    ]) assert.deepEqual(B.parseToNative(B.encode(m)), m, m.type);
    for (const m of [
        { type: "vaultResult", id: "v1", ok: true, value: "{}" },
        { type: "vaultResult", id: "v2", ok: true },
        { type: "vaultResult", id: "v3", ok: false, error: "locked" },
    ]) assert.deepEqual(B.parseToWeb(B.encode(m)), m, m.type);
});

test("the keyring over the bridge vault: every secret crosses as a vault request, and comes back the same", async () => {
    const { IDBFactory } = (await import("node:module")).createRequire(import.meta.url)("fake-indexeddb");
    const { Keyring } = await import("../src/hub/keyring.ts");
    const store = new Map();
    const seen = [];
    // The app, answering each request on a later turn, through the same encode and parse as the real bridge.
    let b;
    b = bridgeVault((m) => {
        const req = B.parseToNative(B.encode(m));
        seen.push(`${req.op} ${req.name}`);
        setTimeout(() => {
            const r = { type: "vaultResult", id: req.id, ok: true };
            if (req.op === "get" && store.has(req.name)) r.value = store.get(req.name);
            if (req.op === "set") store.set(req.name, req.value);
            if (req.op === "delete") store.delete(req.name);
            b.settle(B.parseToWeb(B.encode(r)));
        }, 0);
    });
    const idb = new IDBFactory();
    const a = await (await Keyring.open("k", idb, b.vault)).keys();
    const again = await (await Keyring.open("k", idb, b.vault)).load();
    assert.deepEqual(again.identity.publicKey, a.identity.publicKey);
    assert.ok(seen.includes("set self"));
    assert.deepEqual([...store.keys()], ["self"]);
});

test("the bridge vault refuses a name the keyring does not use, surfaces the app's refusal, and gives up on silence", async () => {
    const posted = [];
    const b = bridgeVault((m) => posted.push(m), 20);
    await assert.rejects(b.vault.get("anything"), /no vault record/);
    assert.equal(posted.length, 0, "nothing asked of the app");
    const p = b.vault.set("self", "x");
    b.settle({ type: "vaultResult", id: posted[0].id, ok: false, error: "the keychain is locked" });
    await assert.rejects(p, /keychain is locked/);
    await assert.rejects(b.vault.get("root"), /did not answer/);
});

const { attentionForApp } = await import("../src/native/snapshot.ts");

test("the phone's inbox: the page's words, the problems counted, the suggestions not, and nothing offered as fixable here", () => {
    const runtimes = [
        rt({ id: "laptop", name: "Work laptop", capabilities: { chat: true, attention: ["no-model", "tab-groups"] } }),
        rt({ id: "box", name: "Lab box", capabilities: { agent: true, archive: { folder: "needs-grant" }, attention: ["gpu-driver-old"] } }),
    ];
    const { items, count } = attentionForApp(runtimes);
    // Most urgent first, and each names the device the fix is on.
    assert.equal(items[0].level, "blocks");
    assert.equal(items[0].runtimeName, "Work laptop");
    assert.ok(items.every((i) => typeof i.title === "string" && i.title && i.detail));
    assert.ok(items.some((i) => i.key === "box:archive-folder-lapsed"), "a lapsed archive folder is read from the runtime's own state");
    // A code this page does not know is still listed, in general words, rather than dropped.
    assert.ok(items.some((i) => i.key === "box:gpu-driver-old" && /does not know/.test(i.detail)));
    // The badge counts problems only: a suggestion never makes a number.
    assert.equal(count, items.filter((i) => i.level !== "suggests").length);
    // A phone applies no fix, so none is sent: the app has nothing to draw a button from.
    assert.ok(items.every((i) => !("fix" in i)));
    assert.deepEqual(B.parseToNative(B.encode({ type: "attention", items, count })), { type: "attention", items, count });
});

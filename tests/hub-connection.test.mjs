// The chat page's hub CONNECTION against the real hub: who is there, and a sealed command answered by its result.
//
// This is the half of a `SessionHost` that needs no decisions about channels, and it is tested against the real
// `wmlhub` binary for the same reason the client below it is: what is worth checking is that two implementations
// agree, which a fake on this side cannot tell you. It self-skips without the binary — `tests/hub-client.test.mjs`
// says how to build the pinned tag.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HUB, LIVE as T, device, hex, poll, startHub } from "./fixtures/hub-harness.mjs";

const { generateIdentity, SCOPE } = await import("../src/hub/keys.ts");
const { HubClient } = await import("../src/hub/client.ts");
const { Role } = await import("../src/hub/wire.ts");
const { HubConnection } = await import("../src/chat/hub-connection.ts");

/** A runtime that answers every command sealed to it with whatever `answer` returns for that command. */
function runtimeThatAnswers(client, answer) {
    void (async () => {
        for (;;) {
            const e = await client.next();
            if (e.kind === "closed") return;
            if (e.kind !== "command") continue;
            const body = JSON.parse(new TextDecoder().decode(e.opened.body));
            const to = { principal: e.opened.from, agreementKey: e.opened.verified.leaf.agreementKey };
            await client.result(to, e.opened.nonce, new TextEncoder().encode(JSON.stringify(answer(body))));
        }
    })();
}

test("a runtime's presence becomes a peer, verified against our own account root", T, async () => {
    const hub = await startHub();
    try {
        const root = await generateIdentity();
        const runtime = await device(root, Role.ROLE_RUNTIME, [], "Work laptop");
        const phone = await device(root, Role.ROLE_CLIENT, [SCOPE.view, SCOPE.drive]);
        const common = { url: hub.url, hubName: HUB, accountRoot: root.publicKey };

        const conn = await HubConnection.open({ ...common, ...phone, role: Role.ROLE_CLIENT });
        const rt = await HubClient.connect({ ...common, ...runtime, role: Role.ROLE_RUNTIME });

        const id = hex(runtime.principal);
        const peer = await poll("the runtime's presence", () => conn.peer(id));
        assert.equal(peer.online, true);
        // The NAME is the label on the VERIFIED leaf: its owner's words, proved to be theirs, and proof of nothing else.
        assert.equal(peer.name, "Work laptop");
        assert.deepEqual([...peer.recipient.agreementKey], [...runtime.agreement.publicKey], "what a command is sealed to");
        assert.ok(peer.lastSeen > 0);

        rt.close();
        conn.close();
    } finally { hub.stop(); }
});

// --- what a peer may do, read off its verified leaf ---

test("whether a runtime may pair is read off its verified leaf, both ways, so renewal is never sent to one that cannot sign", T, async () => {
    // A runtime paired with that permission off (the phone's default since #815) cannot renew another device, and the
    // inbox needs to know which one to send a person to. From the root's signature, never from what the frame says.
    const hub = await startHub();
    try {
        const root = await generateIdentity();
        const signer = await device(root, Role.ROLE_RUNTIME, [], "Work laptop", { mayPair: true });
        const plain = await device(root, Role.ROLE_RUNTIME, [], "Home desktop", { mayPair: false });
        const phone = await device(root, Role.ROLE_CLIENT, [SCOPE.view, SCOPE.drive]);
        const common = { url: hub.url, hubName: HUB, accountRoot: root.publicKey };
        const conn = await HubConnection.open({ ...common, ...phone, role: Role.ROLE_CLIENT });
        const a = await HubClient.connect({ ...common, ...signer, role: Role.ROLE_RUNTIME });
        const b = await HubClient.connect({ ...common, ...plain, role: Role.ROLE_RUNTIME });
        const yes = await poll("the signer's presence", () => conn.peer(hex(signer.principal)));
        const no = await poll("the other's presence", () => conn.peer(hex(plain.principal)));
        assert.equal(yes.mayPair, true);
        assert.equal(no.mayPair, false, "a definite no, not absent: absent means not known and counts as able");
        a.close(); b.close(); conn.close();
    } finally { hub.stop(); }
});

test("a command reaches the runtime and its result comes back, matched by nonce", T, async () => {
    const hub = await startHub();
    try {
        const root = await generateIdentity();
        const runtime = await device(root, Role.ROLE_RUNTIME, [], "Work laptop");
        const phone = await device(root, Role.ROLE_CLIENT, [SCOPE.view, SCOPE.drive]);
        const common = { url: hub.url, hubName: HUB, accountRoot: root.publicKey };

        const conn = await HubConnection.open({ ...common, ...phone, role: Role.ROLE_CLIENT });
        const rt = await HubClient.connect({ ...common, ...runtime, role: Role.ROLE_RUNTIME });
        runtimeThatAnswers(rt, (c) =>
            c.type === "tabs.list"
                ? { ok: true, data: { tabs: [{ tabId: 7, url: "https://a.example/", title: "A", active: true }] } }
                : { ok: false, error: { code: "unsupported", message: `no ${c.type} here` } });

        const id = hex(runtime.principal);
        await poll("the runtime's presence", () => conn.peer(id));

        const r = await conn.send({ type: "tabs.list", runtime: id });
        assert.equal(r.ok, true);
        assert.equal(r.data.tabs[0].title, "A");

        // A refusal from the RUNTIME is a result, not an exception: one answer shape all the way down. It has to be
        // a command this device may SEND, or the seal stops it here and the runtime never gets a say (below).
        const no = await conn.send({ type: "page.highlight", session: { runtime: id, hash: "aaaa0001" }, ref: null });
        assert.equal(no.ok, false);
        assert.equal(no.error.code, "unsupported");

        rt.close();
        conn.close();
    } finally { hub.stop(); }
});

test("a runtime nobody has heard of, and one that has gone, are told apart", T, async () => {
    const hub = await startHub();
    try {
        const root = await generateIdentity();
        const runtime = await device(root, Role.ROLE_RUNTIME, [], "Work laptop");
        const phone = await device(root, Role.ROLE_CLIENT, [SCOPE.view, SCOPE.drive]);
        const common = { url: hub.url, hubName: HUB, accountRoot: root.publicKey };
        const conn = await HubConnection.open({ ...common, ...phone, role: Role.ROLE_CLIENT });

        // Never seen: there is nobody to be slow, so this answers at once rather than after a timeout.
        const unknown = await conn.send({ type: "tabs.list", runtime: "f".repeat(64) });
        assert.equal(unknown.error.code, "not-found");

        const rt = await HubClient.connect({ ...common, ...runtime, role: Role.ROLE_RUNTIME });
        const id = hex(runtime.principal);
        await poll("the runtime's presence", () => conn.peer(id));
        rt.close();

        // Gone is a different sentence from never-here, and it keeps its name so a list can still show the row.
        await poll("the runtime going away", () => conn.peer(id)?.online === false);
        const gone = await conn.send({ type: "tabs.list", runtime: id });
        assert.equal(gone.error.code, "unavailable");
        assert.match(gone.error.message, /Work laptop/);

        conn.close();
    } finally { hub.stop(); }
});

test("a runtime that never answers times out as unavailable, and an abort is its own reason", T, async () => {
    const hub = await startHub();
    try {
        const root = await generateIdentity();
        const runtime = await device(root, Role.ROLE_RUNTIME, [], "Silent laptop");
        const phone = await device(root, Role.ROLE_CLIENT, [SCOPE.view, SCOPE.drive]);
        const common = { url: hub.url, hubName: HUB, accountRoot: root.publicKey };
        const conn = await HubConnection.open({ ...common, ...phone, role: Role.ROLE_CLIENT });
        const rt = await HubClient.connect({ ...common, ...runtime, role: Role.ROLE_RUNTIME });
        const id = hex(runtime.principal);
        await poll("the runtime's presence", () => conn.peer(id));

        // Connected, so this is not `unavailable` for being absent: it is a runtime that took the command and said
        // nothing, which a caller has to be told rather than left waiting on.
        const late = await conn.send({ type: "tabs.list", runtime: id }, { timeoutMs: 200 });
        assert.equal(late.error.code, "unavailable");
        assert.match(late.error.message, /did not answer/);

        // An abort is a different fact: the command WAS sent, and may still be carried out.
        const ctrl = new AbortController();
        const pending = conn.send({ type: "tabs.list", runtime: id }, { signal: ctrl.signal, timeoutMs: 10_000 });
        ctrl.abort();
        assert.equal((await pending).error.code, "aborted");

        rt.close();
        conn.close();
    } finally { hub.stop(); }
});

test("a command this device may not SEND is refused here, not waited on", T, async () => {
    // The seal refuses a scope the leaf does not grant, so the runtime never sees the command and never answers.
    // Before this was checked locally, the caller waited thirty seconds for something that was never going to
    // arrive — and then read "did not answer", about a runtime that was never asked.
    const hub = await startHub();
    try {
        const root = await generateIdentity();
        const runtime = await device(root, Role.ROLE_RUNTIME, [], "Work laptop");
        const phone = await device(root, Role.ROLE_CLIENT, [SCOPE.view, SCOPE.drive]);
        const common = { url: hub.url, hubName: HUB, accountRoot: root.publicKey };
        const conn = await HubConnection.open({ ...common, ...phone, role: Role.ROLE_CLIENT });
        const rt = await HubClient.connect({ ...common, ...runtime, role: Role.ROLE_RUNTIME });
        let asked = 0;
        runtimeThatAnswers(rt, () => { asked++; return { ok: true, data: {} }; });
        const id = hex(runtime.principal);
        await poll("the runtime's presence", () => conn.peer(id));

        // `device.list` needs `admin`, which this phone's certificate does not grant.
        const r = await conn.send({ type: "device.list", runtime: id }, { timeoutMs: 1500 });
        assert.equal(r.error.code, "forbidden");
        assert.match(r.error.message, /admin/);
        assert.equal(asked, 0, "and it never left this device");

        // What it DOES hold still goes through, so this is a scope check and not a refusal of everything.
        assert.equal((await conn.send({ type: "tabs.list", runtime: id })).ok, true);

        rt.close();
        conn.close();
    } finally { hub.stop(); }
});

// --- subscriptions: the frames the pump used to drop ---

const { ChannelKey, StreamKey, StreamReader, sealFrame, wrapKey } = await import("../src/hub/seal.ts");
const { Kind } = await import("../src/hub/wire.ts");

test("a subscription hears its stream's frames, then `backfilled` — and nothing of another stream", T, async () => {
    // The pump used to handle presence and command results and DROP every published frame. That was harmless while
    // nothing subscribed, and is everything once something does.
    const hub = await startHub();
    try {
        const root = await generateIdentity();
        const runtime = await device(root, Role.ROLE_RUNTIME, [], "laptop");
        const phone = await device(root, Role.ROLE_CLIENT, [SCOPE.view]);
        const common = { url: hub.url, hubName: HUB, accountRoot: root.publicKey };
        const conn = await HubConnection.open({ ...common, ...phone, role: Role.ROLE_CLIENT });
        const rt = await HubClient.connect({ ...common, ...runtime, role: Role.ROLE_RUNTIME });

        const ck = await ChannelKey.generate();
        const mine = await ck.channel("events", new TextEncoder().encode("one"));
        const other = await ck.channel("events", new TextEncoder().encode("two"));
        const key = await StreamKey.generate();
        // Published BEFORE anyone subscribes, so it has to come out of the ring.
        rt.publish(mine, Kind.KIND_SESSION_EVENTS, await sealFrame(rt.sender(), mine, key, 1, new TextEncoder().encode("retained")));
        rt.publish(other, Kind.KIND_SESSION_EVENTS, await sealFrame(rt.sender(), other, key, 1, new TextEncoder().encode("not yours")));

        const heard = [];
        const stop = conn.subscribe(runtime.principal, mine, (e) => heard.push(e));
        await poll("the backfill to finish", () => heard.some((e) => e.kind === "backfilled"));
        rt.publish(mine, Kind.KIND_SESSION_EVENTS, await sealFrame(rt.sender(), mine, key, 2, new TextEncoder().encode("live")));
        await poll("the live frame", () => heard.filter((e) => e.kind === "published").length === 2);

        const reader = new StreamReader({ publisher: runtime.principal, publisherKey: runtime.identity.publicKey, channel: mine, key, fromCounter: 1 });
        const texts = [];
        for (const e of heard.filter((x) => x.kind === "published")) texts.push(new TextDecoder().decode((await reader.open(e.payload)).batch));
        assert.deepEqual(texts, ["retained", "live"], "the ring first, then live — and not the other stream's frame");
        assert.deepEqual(heard.map((e) => e.kind), ["published", "backfilled", "published"], "backfilled marks the seam");

        // After unsubscribing, nothing more arrives.
        stop();
        const before = heard.length;
        rt.publish(mine, Kind.KIND_SESSION_EVENTS, await sealFrame(rt.sender(), mine, key, 3, new TextEncoder().encode("after")));
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(heard.length, before, "an unsubscribed stream is silent");

        rt.close();
        conn.close();
    } finally { hub.stop(); }
});

test("a grant opens through the connection, verified, so a key from the wrong sender never opens", T, async () => {
    const hub = await startHub();
    try {
        const root = await generateIdentity();
        const runtime = await device(root, Role.ROLE_RUNTIME, [], "laptop");
        const phone = await device(root, Role.ROLE_CLIENT, [SCOPE.view]);
        const common = { url: hub.url, hubName: HUB, accountRoot: root.publicKey };
        const conn = await HubConnection.open({ ...common, ...phone, role: Role.ROLE_CLIENT });
        const rt = await HubClient.connect({ ...common, ...runtime, role: Role.ROLE_RUNTIME });

        const ck = await ChannelKey.generate();
        const events = await ck.channel("events", new TextEncoder().encode("s"));
        const keys = await ck.channel("keys", new TextEncoder().encode("s"));
        const key = await StreamKey.generate();
        rt.publish(keys, Kind.KIND_SESSION_EVENTS, await wrapKey(rt.sender(), { principal: phone.principal, agreementKey: phone.agreement.publicKey }, events, key, 1, Date.now()));

        const heard = [];
        conn.subscribe(runtime.principal, keys, (e) => heard.push(e));
        const g = await poll("the wrapped key", () => heard.find((e) => e.kind === "published"));
        const grant = await conn.openGrant(g.sender, g.payload);
        assert.deepEqual([...grant.channel], [...events], "a grant names the one channel it opens");
        assert.deepEqual([...grant.key.id], [...key.id]);

        // The same bytes claimed as coming from someone else do not open: the sender is checked, not trusted.
        await assert.rejects(() => conn.openGrant(phone.principal, g.payload));

        rt.close();
        conn.close();
    } finally { hub.stop(); }
});

// --- a command larger than the hub takes ---

/** A phone, a runtime that answers `runtime.info` with `{}` and a connection, against a real hub; `limit` is what the hub gave. */
async function oversizeWorld() {
    const hub = await startHub();
    const root = await generateIdentity();
    const runtime = await device(root, Role.ROLE_RUNTIME, [], "Work laptop");
    const phone = await device(root, Role.ROLE_CLIENT, [SCOPE.view, SCOPE.drive]);
    const common = { url: hub.url, hubName: HUB, accountRoot: root.publicKey };
    const conn = await HubConnection.open({ ...common, ...phone, role: Role.ROLE_CLIENT });
    const rt = await HubClient.connect({ ...common, ...runtime, role: Role.ROLE_RUNTIME });
    const seen = [];
    runtimeThatAnswers(rt, (c) => { seen.push(c); return { ok: true, data: {} }; });
    const id = hex(runtime.principal);
    await poll("the runtime's presence", () => conn.peer(id));
    const closed = [];
    conn.onClose((r) => closed.push(r));
    const stop = () => { rt.close(); conn.close(); hub.stop(); };
    return { conn, id, seen, closed, limit: conn.hubClient.limits.maxPayloadBytes, stop };
}

test("a command over the hub's payload limit is refused here, in words, and the connection stays up", T, async () => {
    const w = await oversizeWorld();
    try {
        const session = { runtime: w.id, hash: "aaaa0001" };
        const r = await w.conn.send({ type: "session.send", session, text: "x".repeat(w.limit + 5_000) });
        assert.equal(r.ok, false);
        assert.equal(r.error.code, "invalid");
        assert.match(r.error.message, /too large to send through the hub: \d+(\.\d)? MB; the hub takes up to \d+(\.\d)? MB per message/);
        await new Promise((res) => setTimeout(res, 300));
        assert.deepEqual(w.closed, [], "the relay closes a connection that sends an oversize payload; this one never sent it");
        assert.equal(w.seen.length, 0, "nothing reached the runtime");
        const next = await w.conn.send({ type: "session.send", session, text: "small" });
        assert.equal(next.ok, true, "the next command works on the same connection");
    } finally { w.stop(); }
});

// --- images that would not fit are sent as smaller copies ---

/** A raster with no pixels: every image is 2400x2400, and a copy at `w`x`h` encodes to w*h/4 characters, so the
 *  longest side decides the size the way a real JPEG's does, only predictably. */
function fakeRaster({ smaller = true } = {}) {
    const calls = { decode: 0, encode: [] };
    return {
        calls,
        decode: async () => { calls.decode++; return { source: {}, width: 2400, height: 2400, close() {} }; },
        canvas: (w, h) => ({ width: w, height: h, getContext: () => ({ fillRect() {}, drawImage() {} }) }),
        encode: async (c, opts) => { calls.encode.push({ w: c.width, h: c.height, ...opts }); return `data:image/jpeg;base64,${"J".repeat(smaller ? Math.round(c.width * c.height / 4) : 5_000_000)}`; },
    };
}
const png = (n) => `data:image/png;base64,${"A".repeat(n)}`;

test("images over the limit are re-encoded smaller until the command fits, and the person is told", T, async () => {
    const w = await oversizeWorld();
    try {
        const raster = fakeRaster();
        w.conn.raster = raster;
        const small = png(30_000);
        const session = { runtime: w.id, hash: "aaaa0001" };
        const r = await w.conn.send({ type: "session.send", session, text: "look", images: [png(1_700_000), small, png(1_700_000)] });
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.match(r.note, /smaller copy/);
        const got = w.seen.at(-1).images;
        assert.equal(got.length, 3, "none dropped, order kept");
        assert.ok(got[0].startsWith("data:image/jpeg") && got[2].startsWith("data:image/jpeg"), "the large ones were re-encoded");
        assert.equal(got[1], small, "an image that was not needed to fit is never touched");
        assert.ok(got.join("").length < w.limit);
        assert.ok(raster.calls.encode.every((e) => e.type === "image/jpeg" && e.quality === 0.85));
        assert.ok(Math.max(...raster.calls.encode.map((e) => e.w)) <= 2048, "stepped down from 2048, never up");
        await new Promise((res) => setTimeout(res, 300));
        assert.deepEqual(w.closed, [], "the connection is still up");
    } finally { w.stop(); }
});

test("images that fit are never decoded, re-encoded or noted", T, async () => {
    const w = await oversizeWorld();
    try {
        const raster = fakeRaster();
        w.conn.raster = raster;
        const images = [png(400_000), png(300_000)];
        const r = await w.conn.send({ type: "session.send", session: { runtime: w.id, hash: "aaaa0001" }, text: "look", images });
        assert.equal(r.ok, true);
        assert.equal(r.note, undefined);
        assert.deepEqual(w.seen.at(-1).images, images, "byte for byte");
        assert.equal(raster.calls.decode, 0);
    } finally { w.stop(); }
});

test("images that still do not fit after shrinking are refused with the size, and nothing is sent", T, async () => {
    const w = await oversizeWorld();
    try {
        w.conn.raster = fakeRaster({ smaller: false });   // a copy is never smaller, so none is used
        const r = await w.conn.send({ type: "agent.start", runtime: w.id, task: "t", target: { kind: "new-tab" }, images: [png(2_500_000)] });
        assert.equal(r.ok, false);
        assert.equal(r.error.code, "invalid");
        assert.match(r.error.message, /^too large to send through the hub: 2\.\d MB; the hub takes up to 1\.0 MB per message$/);
        assert.equal(w.seen.length, 0);
        await new Promise((res) => setTimeout(res, 300));
        assert.deepEqual(w.closed, []);
    } finally { w.stop(); }
});

test("with nothing to draw an image with, an oversize command with images is refused rather than sent", T, async () => {
    const w = await oversizeWorld();
    try {
        w.conn.raster = null;
        const r = await w.conn.send({ type: "session.send", session: { runtime: w.id, hash: "aaaa0001" }, text: "", images: [png(1_700_000)] });
        assert.equal(r.ok, false);
        assert.equal(r.error.code, "invalid");
        assert.equal(w.seen.length, 0);
    } finally { w.stop(); }
});

test("a command just under the limit is sent as it is: the bound is the sealed size, not a rule of thumb", T, async () => {
    const w = await oversizeWorld();
    try {
        w.conn.raster = fakeRaster();
        const session = { runtime: w.id, hash: "aaaa0001" };
        const overhead = await w.conn.hubClient.commandOverhead(w.conn.peer(w.id).recipient, "drive");
        const head = JSON.stringify({ type: "session.send", session, text: "" }).length;
        const r = await w.conn.send({ type: "session.send", session, text: "x".repeat(w.limit - overhead - head - 64) });
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(w.seen.length, 1);
    } finally { w.stop(); }
});

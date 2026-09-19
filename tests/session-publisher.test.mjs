// The runtime's side of a session's stream, against the real hub: who is handed a session's key, when, and that a
// phone can read what was published — including what was published before it arrived.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HUB, LIVE, device, hex, startHub, until } from "./fixtures/hub-harness.mjs";

const { generateIdentity, SCOPE } = await import("../src/hub/keys.ts");
const { ChannelKey, StreamReader } = await import("../src/hub/seal.ts");
const { HubClient } = await import("../src/hub/client.ts");
const { Kind, Role } = await import("../src/hub/wire.ts");
const { SessionPublisher, hubPublish } = await import("../src/session-publisher.ts");
const { eventsChannel, keysChannel, decodeStreamFrame } = await import("../src/session-relay.ts");

const msg = (hash, cursor, text) => ({ type: "event", v: 1, session: { runtime: "rt", hash }, epoch: "w1.0", cursor, event: { kind: "agent-say", id: hash, text } });

/** Connect a runtime and a device on one account, sharing the channel key pairing would have handed them. */
async function world(deviceScopes = [SCOPE.view, SCOPE.drive]) {
    const hub = await startHub();
    const root = await generateIdentity();
    const runtime = await device(root, Role.ROLE_RUNTIME, [], "laptop");
    const phone = await device(root, Role.ROLE_CLIENT, deviceScopes, "phone");
    const common = { url: hub.url, hubName: HUB, accountRoot: root.publicKey };
    const rt = await HubClient.connect({ ...common, ...runtime, role: Role.ROLE_RUNTIME });
    const ph = await HubClient.connect({ ...common, ...phone, role: Role.ROLE_CLIENT });
    const channels = await ChannelKey.generate();
    const pub = new SessionPublisher(hubPublish(rt, Kind.KIND_SESSION_EVENTS), channels);
    const asDevice = { id: hex(phone.principal), scopes: deviceScopes, recipient: { principal: phone.principal, agreementKey: phone.agreement.publicKey } };
    const close = () => { rt.close(); ph.close(); hub.stop(); };
    return { hub, runtime, phone, rt, ph, channels, pub, asDevice, close };
}

/** The phone's side: subscribe to a session's two channels, open the grant addressed to it, read the frames. */
async function readAs(w, hash, count) {
    const events = await eventsChannel(w.channels, hash);
    const keys = await keysChannel(w.channels, hash);
    w.ph.subscribe(w.runtime.principal, keys);
    w.ph.subscribe(w.runtime.principal, events);
    let reader = null;
    const frames = [];
    const out = [];
    await until(w.ph, `${count} messages of ${hash}`, (e) => {
        if (e.kind !== "published") return false;
        const on = hex(e.stream.channel);
        if (on === hex(keys) && !reader) return w.ph.openGrant(e.sender, e.payload).then((g) => { reader = new StreamReader(g); }) && false;
        if (on === hex(events)) frames.push(e.payload);
        return false;
    }, 1500).catch(() => { /* ran out of events: fall through and read what arrived */ });
    for (const f of frames) if (reader) out.push(decodeStreamFrame((await reader.open(f)).batch));
    // The raw count too, so a test can tell "nothing readable" from "nothing arrived": the first is a refusal, the
    // second is a test that passed because the stream never showed up.
    out.frames = frames.length;
    out.keyed = !!reader;
    return out;
}

test("a device present when a session starts is handed its key, and reads the stream", LIVE, async () => {
    const w = await world();
    try {
        await w.pub.deviceOnline(w.asDevice);
        await w.pub.publish("aaaa0001", msg("aaaa0001", 1, "first"));
        await w.pub.publish("aaaa0001", msg("aaaa0001", 2, "second"));
        const got = await readAs(w, "aaaa0001", 2);
        assert.deepEqual(got.map((m) => m.event.text), ["first", "second"]);
        assert.equal(got[1].cursor, 2, "the contract's own cursor survived the hub, inside the seal");
    } finally { w.close(); }
});

test("a device that arrives mid-session reads what was published BEFORE it arrived", LIVE, async () => {
    // A phone opening a running session has to see its history. The grant covers the stream from its first counter
    // and is published on a RETAINED channel, so both the key and the early frames are still in the ring.
    const w = await world();
    try {
        await w.pub.publish("aaaa0002", msg("aaaa0002", 1, "before you came"));
        await w.pub.deviceOnline(w.asDevice);
        await w.pub.publish("aaaa0002", msg("aaaa0002", 2, "after"));
        const got = await readAs(w, "aaaa0002", 2);
        assert.deepEqual(got.map((m) => m.event.text), ["before you came", "after"]);
    } finally { w.close(); }
});

test("a device without `view` is handed no key, so it cannot watch even by naming the channel", LIVE, async () => {
    const w = await world([SCOPE.drive]);
    try {
        await w.pub.deviceOnline(w.asDevice);
        await w.pub.publish("aaaa0003", msg("aaaa0003", 1, "not for you"));
        // It can subscribe — the channel key came from pairing — and the frames arrive, but there is no grant to open
        // them with.
        const got = await readAs(w, "aaaa0003", 1);
        assert.ok(got.frames >= 1, "the frame DID arrive — otherwise this test would pass for the wrong reason");
        assert.equal(got.keyed, false, "but no grant was published for it");
        assert.equal(got.length, 0, "so nothing is readable");
    } finally { w.close(); }
});

test("each session has its OWN key: one session's grant does not open another's frames", LIVE, async () => {
    // The reason keys are per session. With a shared key, a device holding session A's grant could name B's channel
    // itself and decrypt it — the AEAD binds a frame to its channel against a hub, not against a key holder.
    const w = await world();
    try {
        await w.pub.deviceOnline(w.asDevice);
        await w.pub.publish("aaaa0004", msg("aaaa0004", 1, "a"));
        await w.pub.publish("aaaa0005", msg("aaaa0005", 1, "b"));
        const keysA = await keysChannel(w.channels, "aaaa0004");
        const eventsB = await eventsChannel(w.channels, "aaaa0005");
        w.ph.subscribe(w.runtime.principal, keysA);
        w.ph.subscribe(w.runtime.principal, eventsB);
        let grantA = null, frameB = null;
        await until(w.ph, "A's grant and B's frame", (e) => {
            if (e.kind !== "published") return false;
            if (hex(e.stream.channel) === hex(keysA)) grantA = e;
            if (hex(e.stream.channel) === hex(eventsB)) frameB = e;
            return !!grantA && !!frameB;
        });
        const readerA = new StreamReader(await w.ph.openGrant(grantA.sender, grantA.payload));
        await assert.rejects(() => readerA.open(frameB.payload), "A's key does not read B");
    } finally { w.close(); }
});

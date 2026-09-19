// The pairing flow (src/hub/pair-flow.ts) over the keyring (src/hub/keyring.ts): an account created on its first device,
// a runtime offering itself and being confirmed there, and that runtime, holding `may_pair`, pairing a phone as a
// delegate. Against the real hub for everything that crosses it; the keyring on fake-indexeddb.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { LIVE, startHub } from "./fixtures/hub-harness.mjs";

const { IDBFactory } = createRequire(import.meta.url)("fake-indexeddb");
const { Keyring } = await import("../src/hub/keyring.ts");
const F = await import("../src/hub/pair-flow.ts");
const { HubClient } = await import("../src/hub/client.ts");
const { verifyChain, SCOPE } = await import("../src/hub/keys.ts");
const { Role } = await import("../src/hub/wire.ts");

const keyring = () => Keyring.open("k", new IDBFactory());

/** Log in as whatever this keyring holds. */
async function connect(ring, role) {
    const me = await ring.load();
    const m = me.membership;
    return HubClient.connect({ url: m.hubUrl, hubName: m.hubName, identity: me.identity, agreement: me.agreement, chain: m.chain, accountRoot: m.accountRoot, role });
}

test("the keyring generates keys once, keeps them across a reopen, and one pair survives a race", async () => {
    const idb = new IDBFactory();
    const ring = await Keyring.open("k", idb);
    assert.equal(await ring.load(), null);
    const [a, b] = await Promise.all([ring.keys(), ring.keys()]);
    assert.deepEqual(a.identity.publicKey, b.identity.publicKey, "two first callers, one pair of keys");
    ring.close();
    const again = await (await Keyring.open("k", idb)).load();
    assert.deepEqual(again.identity.publicKey, a.identity.publicKey);
    assert.equal(again.membership, null);
    // The private halves came back as keys that still sign, never as bytes.
    assert.equal(again.identity.privateKey.extractable, false);
    const sig = await crypto.subtle.sign("Ed25519", again.identity.privateKey, new Uint8Array([1]));
    assert.equal(sig.byteLength, 64);
});

test("defaults per role, and a delegate's defaults cut to what it may pass on", () => {
    assert.deepEqual(F.defaultGrant(Role.ROLE_CLIENT).scopes, ["view", "drive"]);
    const runtime = F.defaultGrant(Role.ROLE_RUNTIME);
    assert.deepEqual([runtime.scopes, runtime.mayPair, runtime.mayRevoke], [[], true, true]);
    const fromDelegate = F.defaultGrant(Role.ROLE_RUNTIME, { scopes: ["view"] });
    assert.equal(fromDelegate.mayRevoke, false);
    assert.deepEqual(F.defaultGrant(Role.ROLE_CLIENT, { scopes: ["view", "approve"] }).scopes, ["view"]);
});

test("an account, a runtime paired to it, and a phone the runtime pairs as a delegate", LIVE, async () => {
    const hub = await startHub();
    try {
        // The first device creates the account and holds its root.
        const phone = await keyring();
        await F.createAccount(phone, { hubUrl: hub.url, label: "Shane's phone" });
        const p = await phone.load();
        assert.ok(p.root, "the root stays on the device that created the account");
        const phoneClient = await connect(phone, Role.ROLE_CLIENT);

        // The laptop's extension offers itself as a runtime; the person types its code on the phone.
        const laptop = await keyring();
        const pending = await F.beginOffer(laptop, { hubUrl: hub.url, role: Role.ROLE_RUNTIME, label: "Work laptop" });
        assert.match(pending.code, /^[0-9A-Z]{4} [0-9A-Z]{4}$/);
        // A code with nothing under it is its own reason, so the screen can say "check it, or offer again".
        await assert.rejects(F.lookupOffer(phoneClient, "ZZZZ 9999"), (e) => e.reason === "no-offer");
        const found = await F.lookupOffer(phoneClient, pending.code.toLowerCase());
        assert.equal(found.fingerprint, pending.fingerprint, "both screens show the same fingerprint");
        assert.equal(found.offer.label, "Work laptop");
        const issuer = await F.issuerOf(phone);
        await F.confirmOffer(phoneClient, issuer, found, F.defaultGrant(Role.ROLE_RUNTIME, issuer));
        const membership = await pending.done;
        assert.deepEqual(membership.accountRoot, p.membership.accountRoot);
        assert.deepEqual(membership.channelKey, p.root.channelKey, "the account's channel key came with it");
        const leaf = (await verifyChain(membership.accountRoot, membership.chain, Date.now())).leaf;
        assert.deepEqual([leaf.mayPair, leaf.mayRevoke], [true, true], "a runtime renews devices and signs revocations");
        const laptopClient = await connect(laptop, Role.ROLE_RUNTIME);

        // The runtime holds may_pair, so it can pair a second phone as a delegate: the chain it hands over is two long.
        const tablet = await keyring();
        const offered = await F.beginOffer(tablet, { hubUrl: hub.url, role: Role.ROLE_CLIENT, label: "Tablet" });
        const seen = await F.lookupOffer(laptopClient, offered.code);
        const delegate = await F.issuerOf(laptop);
        assert.deepEqual(delegate.chain.length, 1, "a delegate, not the root");
        await assert.rejects(
            F.confirmOffer(laptopClient, delegate, seen, { ...F.defaultGrant(Role.ROLE_CLIENT), scopes: [SCOPE.view, SCOPE.approve] }),
            /only the account's root device may grant approve/,
        );
        await assert.rejects(F.confirmOffer(laptopClient, delegate, seen, { ...F.defaultGrant(Role.ROLE_CLIENT), scopes: [], mayRevoke: true }), /root device/);
        // The runtime's certificate holds no scopes of its own, so its defaults for a client are empty: nothing to pass on.
        const grant = F.defaultGrant(Role.ROLE_CLIENT, delegate);
        assert.deepEqual(grant.scopes, []);
        await F.confirmOffer(laptopClient, delegate, seen, grant);
        const tabletMembership = await offered.done;
        assert.equal(tabletMembership.chain.length, 2);
        (await connect(tablet, Role.ROLE_CLIENT)).close();

        laptopClient.close();
        phoneClient.close();
    } finally { hub.stop(); }
});

test("a device already in an account cannot create another, and nobody answering times out", LIVE, async () => {
    const hub = await startHub();
    try {
        const phone = await keyring();
        await F.createAccount(phone, { hubUrl: hub.url, label: "phone" });
        await assert.rejects(F.createAccount(phone, { hubUrl: hub.url, label: "phone" }), /already belongs/);
        const lonely = await keyring();
        const pending = await F.beginOffer(lonely, { hubUrl: hub.url, role: Role.ROLE_RUNTIME, label: "x", windowMs: 200 });
        await assert.rejects(pending.done, (e) => e.reason === "timed-out");
        assert.equal((await lonely.load()).membership, null, "nothing saved");
    } finally { hub.stop(); }
});

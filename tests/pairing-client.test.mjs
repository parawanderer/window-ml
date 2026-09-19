// pairing-client.test.mjs — the CLIENT's pairing adapter (a phone, a desktop app, the web build) against a real hub: one
// device creates the account and pairs a second through the adapter's own calls, over the connection the app holds.
// The screens are tested on the fake (chat-web.spec.mjs); this is the adapter under them, on the real flow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { LIVE, startHub } from "./fixtures/hub-harness.mjs";

const { IDBFactory } = createRequire(import.meta.url)("fake-indexeddb");
const { Keyring } = await import("../src/hub/keyring.ts");
const { HubClient } = await import("../src/hub/client.ts");
const { Role } = await import("../src/hub/wire.ts");
const { clientPairing } = await import("../src/pairing/client-pairing.ts");

/** A client device: its own keyring, and the hub connection its app would hold once it has a membership. */
function device(label) {
    const idb = new IDBFactory();
    const ring = Keyring.open("k", idb);
    let client = null;
    const connect = async () => {
        const me = await (await ring).load();
        const m = me.membership;
        client = await HubClient.connect({ url: m.hubUrl, hubName: m.hubName, identity: me.identity, agreement: me.agreement, chain: m.chain, accountRoot: m.accountRoot, role: Role.ROLE_CLIENT });
    };
    let changes = 0;
    const api = clientPairing({ keyring: () => ring, client: () => client, defaultLabel: label, rootKeptIn: "this app's storage", onChanged: () => { changes++; } });
    return { api, connect, close: () => client?.close(), changes: () => changes };
}

test("a client creates the account, then pairs a second client by its code over the connection it already holds", LIVE, async () => {
    const hub = await startHub();
    const phone = device("Shane's phone"), desk = device("Desktop app");
    try {
        assert.equal(await phone.api.load(), null, "in no account yet");
        assert.equal(phone.api.canCreate, true);
        const root = await phone.api.createAccount({ hubUrl: hub.url, label: "Shane's phone" });
        assert.equal(root.root, true);
        assert.equal(root.mayPair, true);
        assert.equal(root.role, "client");
        assert.equal(phone.changes(), 1, "the app is told, so it connects with the new membership");
        await assert.rejects(phone.api.leave(), /root/, "the root device never leaves: that is losing the account");

        // Pairing others needs the app's connection; before it is up, the screen says to wait rather than failing oddly.
        await assert.rejects(phone.api.lookupOffer("ABCD1234"), /Not connected/);
        await phone.connect();

        const offer = await desk.api.beginOffer({ hubUrl: hub.url, label: "Desktop app" });
        const found = await phone.api.lookupOffer(offer.code.toLowerCase());
        assert.equal(found.fingerprint, offer.fingerprint, "the phone computes the fingerprint the desktop shows");
        assert.equal(found.label, "Desktop app");
        assert.equal(found.role, "client");
        assert.deepEqual(found.grant.scopes, ["view", "drive"], "a client's default grant");
        assert.equal(found.grantable, null, "the root may grant anything");
        await phone.api.confirmOffer(found, found.grant);

        const joined = await offer.done;
        assert.equal(joined.label, "Desktop app");
        assert.equal(joined.role, "client");
        assert.equal(joined.root, false);
        assert.equal(joined.mayPair, false, "a client paired with the defaults pairs nobody");
        assert.equal(desk.changes(), 1);
        await desk.api.leave();
        assert.equal(await desk.api.load(), null, "a paired client leaves; its keys stay for next time");
    } finally {
        phone.close();
        desk.close();
        hub.stop();
    }
});

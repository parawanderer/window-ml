// The keyring with a vault (src/hub/keyring.ts, `Keyring.keepSecretsIn`): the phone app's mode, where the secrets live
// in the platform keystore and IndexedDB holds only what is not secret. The keystore here is a Map; IndexedDB is
// fake-indexeddb, read back raw to prove nothing secret reached it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { IDBFactory } = createRequire(import.meta.url)("fake-indexeddb");
const { Keyring } = await import("../src/hub/keyring.ts");
const { sign, verify, LABEL } = await import("../src/hub/keys.ts");

/** A vault over a Map, counting what it was asked. */
function mapVault() {
    const m = new Map();
    return {
        m,
        get: async (k) => m.get(k) ?? null,
        set: async (k, v) => { assert.equal(typeof v, "string"); m.set(k, v); },
        delete: async (k) => { m.delete(k); },
    };
}

/** Every value in the keyring's IndexedDB store, raw. */
async function rawIdb(idb) {
    const db = await new Promise((res, rej) => { const r = idb.open("k", 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const s = db.transaction("k").objectStore("k");
    const [keys, values] = await Promise.all([s.getAllKeys(), s.getAll()].map((q) => new Promise((res) => { q.onsuccess = () => res(q.result); })));
    db.close();
    return Object.fromEntries(keys.map((k, i) => [k, values[i]]));
}

/** True when `needle` occurs anywhere in `hay`'s bytes, or anywhere inside a structured value. */
function holds(value, needle) {
    if (value instanceof Uint8Array) return Buffer.from(value).includes(Buffer.from(needle));
    if (value instanceof CryptoKey) return true;
    if (value && typeof value === "object") return Object.values(value).some((v) => holds(v, needle));
    return false;
}

const membership = (channelKey) => ({
    hubUrl: "wss://hub.test", hubName: "hub", accountRoot: new Uint8Array(32).fill(7),
    chain: [{ body: new Uint8Array([1, 2, 3]), signature: new Uint8Array(64).fill(9) }], channelKey, pairedAtMs: 5,
});

test("with a vault, the keys live in it as seeds and come back as non-extractable keys that still work", async () => {
    const idb = new IDBFactory();
    const vault = mapVault();
    const ring = await Keyring.open("k", idb, vault);
    assert.equal(await ring.load(), null);
    const [a, b] = await Promise.all([ring.keys(), ring.keys()]);
    assert.deepEqual(a.identity.publicKey, b.identity.publicKey, "two first callers, one pair of keys");
    ring.close();

    assert.deepEqual([...vault.m.keys()], ["self"]);
    assert.deepEqual(await rawIdb(idb), {}, "IndexedDB holds nothing of self");

    const again = await (await Keyring.open("k", idb, vault)).load();
    assert.deepEqual(again.identity.publicKey, a.identity.publicKey);
    assert.deepEqual(again.agreement.publicKey, a.agreement.publicKey);
    assert.equal(again.identity.privateKey.extractable, false);
    assert.equal(again.agreement.privateKey.extractable, false);
    const sig = await sign(again.identity, LABEL.probe, new Uint8Array([1]));
    assert.ok(await verify(a.identity.publicKey, LABEL.probe, new Uint8Array([1]), sig), "signs as the key first generated");
    // The agreement key reloaded agrees to the same secret as the one first generated.
    const peer = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
    const bits = async (k) => Buffer.from(await crypto.subtle.deriveBits({ name: "X25519", public: peer.publicKey }, k.privateKey, 256)).toString("hex");
    assert.equal(await bits(again.agreement), await bits(a.agreement));
});

test("a membership's channel key goes to the vault, the rest to IndexedDB, and leaving clears both", async () => {
    const idb = new IDBFactory();
    const vault = mapVault();
    const ring = await Keyring.open("k", idb, vault);
    await ring.keys();
    const channelKey = crypto.getRandomValues(new Uint8Array(32));
    await ring.savePaired(membership(channelKey));
    const raw = await rawIdb(idb);
    assert.equal(raw.membership.hubUrl, "wss://hub.test");
    assert.equal(holds(raw, channelKey), false, "the channel key never reaches IndexedDB");
    const me = await ring.load();
    assert.deepEqual(me.membership.channelKey, channelKey);
    assert.deepEqual(me.membership.chain[0].signature, new Uint8Array(64).fill(9));

    await ring.leave();
    assert.equal((await ring.load()).membership, null);
    assert.equal(vault.m.has("membership"), false);
    assert.ok(vault.m.has("self"), "leaving keeps the keys");
});

test("a root made by the keyring is kept as a seed in the vault and signs after a reload", async () => {
    const idb = new IDBFactory();
    const vault = mapVault();
    const ring = await Keyring.open("k", idb, vault);
    await ring.keys();
    const root = await ring.generateIdentity();
    assert.equal(root.privateKey.extractable, false);
    const channelKey = crypto.getRandomValues(new Uint8Array(32));
    await ring.saveAccount({ identity: root, channelKey, createdAtMs: 42 }, membership(channelKey));
    assert.deepEqual((await rawIdb(idb)).root, { createdAtMs: 42 });
    assert.equal(holds(await rawIdb(idb), channelKey), false);

    const me = await (await Keyring.open("k", idb, vault)).load();
    assert.equal(me.root.createdAtMs, 42);
    assert.deepEqual(me.root.channelKey, channelKey);
    const sig = await sign(me.root.identity, LABEL.probe, new Uint8Array([2]));
    assert.ok(await verify(root.publicKey, LABEL.probe, new Uint8Array([2]), sig));

    await ring.leave({ andRoot: true });
    assert.deepEqual([...vault.m.keys()], ["self"]);
});

test("a root the vault cannot keep is refused, not saved half", async () => {
    const vault = mapVault();
    const ring = await Keyring.open("k", new IDBFactory(), vault);
    await ring.keys();
    const { generateIdentity } = await import("../src/hub/keys.ts");
    const root = await generateIdentity(); // non-extractable: no seed to keep
    await assert.rejects(ring.saveAccount({ identity: root, channelKey: new Uint8Array(32), createdAtMs: 1 }, membership(new Uint8Array(32))), /cannot be kept/);
    assert.deepEqual([...vault.m.keys()], ["self"]);
});

test("a record whose secrets the vault lacks reads as absent, and new keys clear what the old ones left", async () => {
    const idb = new IDBFactory();
    // A keyring from before the vault: its own keys and a membership, in IndexedDB.
    const plain = await Keyring.open("k", idb, null);
    await plain.keys();
    await plain.savePaired(membership(new Uint8Array(32)));
    plain.close();

    const vault = mapVault();
    const ring = await Keyring.open("k", idb, vault);
    assert.equal(await ring.load(), null, "no keys in the vault: nothing, whatever IndexedDB holds");
    const me = await ring.keys();
    assert.equal(me.membership, null, "the old membership belonged to keys that are gone");
    assert.deepEqual(await rawIdb(idb), {});

    // The vault losing a membership's channel key (a keystore wiped under the app) loses the membership with it.
    await ring.savePaired(membership(new Uint8Array(32)));
    vault.m.delete("membership");
    assert.equal((await ring.load()).membership, null);
});

test("a vault record this code cannot read is treated as none", async () => {
    const vault = mapVault();
    vault.m.set("self", "{not json");
    const ring = await Keyring.open("k", new IDBFactory(), vault);
    assert.equal(await ring.load(), null);
});

test("keepSecretsIn sets the vault a plain open uses", async () => {
    const vault = mapVault();
    Keyring.keepSecretsIn(vault);
    try {
        const ring = await Keyring.open("k", new IDBFactory());
        await ring.keys();
        assert.ok(vault.m.has("self"));
    } finally {
        Keyring.keepSecretsIn(null);
    }
});

test("an unreadable self in the vault is replaced by fresh keys rather than leaving the device keyless", async () => {
    const vault = mapVault();
    vault.m.set("self", "{not json");
    const ring = await Keyring.open("k", new IDBFactory(), vault);
    const me = await ring.keys();
    assert.equal(me.identity.publicKey.length, 32);
});

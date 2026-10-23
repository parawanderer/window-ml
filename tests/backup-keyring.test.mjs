// The backup keyring at rest (src/backup/backup-keyring.ts): set-up, reading it back after a "restart", the recovery key
// shown once, changing the passphrase, and that no byte of the data key is ever readable. IndexedDB is fake-indexeddb,
// which structured-clones a CryptoKey as a browser does.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { BackupError, decryptFile, encryptFile, readHeader } from "../src/backup/backup-format.ts";
import { changePassphrase, checkSecret, idbKeyringStore, keyringState, loadKeyring, setupKeyring } from "../src/backup/backup-keyring.ts";

const { IDBFactory } = createRequire(import.meta.url)("fake-indexeddb");
const CHEAP = { argon: { m: 64, t: 1, p: 1 } };
const plain = new TextEncoder().encode("SQLite format 3\0 and some pages");

// --- set-up and reading it back ---

test("set-up stores a usable, non-extractable key and shows the recovery key once, in seven groups of four", async () => {
    const idb = new IDBFactory();
    const store = idbKeyringStore(idb);
    assert.deepEqual(await keyringState(store), { set: false });
    const shown = await setupKeyring(store, "correct horse", CHEAP);
    assert.equal(shown.groups.length, 7);
    assert.ok(shown.groups.every((g) => /^[0-9A-Z]{4}$/.test(g)));
    assert.equal(shown.groups.join("-"), shown.recoveryKey);
    const st = await keyringState(store);
    assert.equal(st.set, true);
    assert.equal(st.keyId, shown.keyId);
    const ring = await loadKeyring(idbKeyringStore(idb));   // a new connection: what a restarted worker sees
    await assert.rejects(crypto.subtle.exportKey("raw", ring.key), "the data key cannot be read back out");
    assert.equal(ring.key.extractable, false);
    assert.equal(ring.wraps.length, 2);
    // Nothing the keyring stored contains the recovery key.
    assert.ok(!JSON.stringify(ring).includes(shown.recoveryKey));
});

test("a file sealed with the stored keyring opens with the passphrase, and with the recovery key, on a fresh machine", async () => {
    const store = idbKeyringStore(new IDBFactory());
    const shown = await setupKeyring(store, "correct horse", CHEAP);
    const file = await encryptFile(plain, await loadKeyring(store), { kind: "backup" });
    assert.deepEqual(Buffer.from(await decryptFile(file, { passphrase: "correct horse" })), Buffer.from(plain));
    assert.deepEqual(Buffer.from(await decryptFile(file, { recoveryKey: shown.recoveryKey })), Buffer.from(plain));
    assert.equal(readHeader(file).keyId, shown.keyId);
});

test("a second set-up on the same install is refused and leaves the first key alone", async () => {
    const store = idbKeyringStore(new IDBFactory());
    const first = await setupKeyring(store, "one", CHEAP);
    await assert.rejects(setupKeyring(store, "two", CHEAP), /already set up/);
    assert.equal((await keyringState(store)).keyId, first.keyId);
});

test("an empty passphrase is refused and nothing is stored", async () => {
    const store = idbKeyringStore(new IDBFactory());
    await assert.rejects(setupKeyring(store, "", CHEAP), (e) => e instanceof BackupError && e.reason === "wrong-secret");
    assert.deepEqual(await keyringState(store), { set: false });
});

// --- checking and changing the passphrase ---

test("checkSecret says yes, no, and refuses a mistyped recovery key", async () => {
    const store = idbKeyringStore(new IDBFactory());
    const shown = await setupKeyring(store, "pw", CHEAP);
    assert.equal(await checkSecret(store, { passphrase: "pw" }), true);
    assert.equal(await checkSecret(store, { passphrase: "nope" }), false);
    assert.equal(await checkSecret(store, { recoveryKey: shown.recoveryKey }), true);
    await assert.rejects(checkSecret(store, { recoveryKey: "AAAA-AAAA" }), (e) => e.reason === "bad-recovery-key");
    await assert.rejects(checkSecret(idbKeyringStore(new IDBFactory()), { passphrase: "x" }), (e) => e.reason === "needs-key");
});

test("a new passphrase keeps the data key and the recovery wrap; old files still open with the old passphrase and the recovery key", async () => {
    const store = idbKeyringStore(new IDBFactory());
    const shown = await setupKeyring(store, "old pass", CHEAP);
    const before = await encryptFile(plain, await loadKeyring(store), { kind: "backup" });
    await changePassphrase(store, { passphrase: "old pass" }, "new pass", CHEAP);
    const ring = await loadKeyring(store);
    assert.equal(ring.keyId, shown.keyId, "same data key");
    const after = await encryptFile(plain, ring, { kind: "backup" });
    // New file: new passphrase and recovery key open it; the old passphrase does not.
    assert.deepEqual(Buffer.from(await decryptFile(after, { passphrase: "new pass" })), Buffer.from(plain));
    await assert.rejects(decryptFile(after, { passphrase: "old pass" }), (e) => e.reason === "wrong-secret");
    assert.deepEqual(Buffer.from(await decryptFile(after, { recoveryKey: shown.recoveryKey })), Buffer.from(plain));
    // The file written before keeps its header's wraps: the old passphrase still opens it, as does the recovery key.
    assert.deepEqual(Buffer.from(await decryptFile(before, { passphrase: "old pass" })), Buffer.from(plain));
    assert.deepEqual(Buffer.from(await decryptFile(before, { recoveryKey: shown.recoveryKey })), Buffer.from(plain));
    // And the installed keyring decrypts files from before the change.
    assert.deepEqual(Buffer.from(await decryptFile(before, ring)), Buffer.from(plain));
});

test("changing the passphrase needs a secret that opens the keyring, and the recovery key will do", async () => {
    const store = idbKeyringStore(new IDBFactory());
    const shown = await setupKeyring(store, "pw", CHEAP);
    await assert.rejects(changePassphrase(store, { passphrase: "wrong" }, "x", CHEAP), (e) => e.reason === "wrong-secret");
    assert.equal(await checkSecret(store, { passphrase: "pw" }), true, "a refused change changed nothing");
    await changePassphrase(store, { recoveryKey: shown.recoveryKey }, "via recovery", CHEAP);
    assert.equal(await checkSecret(store, { passphrase: "via recovery" }), true);
    await assert.rejects(changePassphrase(idbKeyringStore(new IDBFactory()), { passphrase: "a" }, "b", CHEAP), (e) => e.reason === "needs-key");
});

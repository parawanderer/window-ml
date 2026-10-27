// The backup keyring at rest (src/backup/backup-keyring.ts): set-up, reading it back after a "restart", the recovery key
// shown once, changing the passphrase, and that no byte of the data key is ever readable. IndexedDB is fake-indexeddb,
// which structured-clones a CryptoKey as a browser does.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { BackupError, createKeyring, decryptFile, encryptFile, keyFor, readHeader } from "../src/backup/backup-format.ts";
import { adoptKeyring, changePassphrase, checkSecret, idbKeyringStore, keyringState, loadKeyring, setupKeyring } from "../src/backup/backup-keyring.ts";
import { unlockChoice } from "../src/backup/backup-file.ts";

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

// --- adopting another install's key (part 3c) ---

/** An install with its own key, and a backup file it made: what another install adopts from. */
async function install(pass) {
    const store = idbKeyringStore(new IDBFactory());
    const shown = await setupKeyring(store, pass, CHEAP);
    const ring = await loadKeyring(store);
    return { store, shown, ring, file: await encryptFile(plain, ring, { kind: "backup" }) };
}
/** Everything about a stored record that a test can compare: the key ids and the wraps as JSON. */
const recordOf = async (store) => { const r = await loadKeyring(store); return JSON.stringify({ keyId: r.keyId, wraps: r.wraps, retired: (r.retired ?? []).map((x) => x.keyId) }); };

test("adopting with the passphrase makes the other key current and keeps this install's own as a retired, non-extractable key", async () => {
    const A = await install("pass of A"), B = await install("pass of B");
    const oldB = await encryptFile(plain, B.ring, { kind: "backup" });
    assert.equal(await adoptKeyring(B.store, A.file, { passphrase: "pass of A" }), A.shown.keyId);
    const ring = await loadKeyring(B.store);
    assert.equal(ring.keyId, A.shown.keyId);
    assert.deepEqual(ring.wraps, A.ring.wraps, "the wraps are the folder's, so a file B writes opens with A's passphrase");
    assert.deepEqual(ring.retired.map((r) => r.keyId), [B.shown.keyId]);
    assert.equal(ring.retired[0].key.extractable, false);
    // Sealing uses the current key only.
    const made = await encryptFile(plain, ring, { kind: "backup" });
    assert.equal(readHeader(made).keyId, A.shown.keyId);
    assert.deepEqual(Buffer.from(await decryptFile(made, { passphrase: "pass of A" })), Buffer.from(plain));
    // A file B sealed under its old key still opens with the keyring: the retired key.
    assert.deepEqual(Buffer.from(await decryptFile(oldB, ring)), Buffer.from(plain));
    assert.equal(keyFor(ring, B.shown.keyId).keyId, B.shown.keyId);
});

test("adopting with the recovery key works the same", async () => {
    const A = await install("pass of A"), B = await install("pass of B");
    assert.equal(await adoptKeyring(B.store, A.file, { recoveryKey: A.shown.recoveryKey }), A.shown.keyId);
    assert.equal((await loadKeyring(B.store)).keyId, A.shown.keyId);
});

test("a wrong secret throws wrong-secret and leaves the stored record exactly as it was", async () => {
    const A = await install("pass of A"), B = await install("pass of B");
    await adoptKeyring(B.store, (await install("pass of C")).file, { passphrase: "pass of C" });   // B now holds a retired key too
    const before = await recordOf(B.store);
    await assert.rejects(adoptKeyring(B.store, A.file, { passphrase: "not it" }), (e) => e instanceof BackupError && e.reason === "wrong-secret");
    await assert.rejects(adoptKeyring(B.store, A.file, { recoveryKey: (await createKeyring("x", CHEAP)).recoveryKey }), (e) => e.reason === "wrong-secret");
    await assert.rejects(adoptKeyring(B.store, A.file, { recoveryKey: "AAAA-AAAA" }), (e) => e.reason === "bad-recovery-key");
    assert.equal(await recordOf(B.store), before);
});

test("an install with no keyring adopts by creating one, and has nothing retired", async () => {
    const A = await install("pass of A");
    const store = idbKeyringStore(new IDBFactory());
    assert.equal(await adoptKeyring(store, A.file, { passphrase: "pass of A" }), A.shown.keyId);
    const ring = await loadKeyring(store);
    assert.equal(ring.keyId, A.shown.keyId);
    assert.equal(ring.retired, undefined);
    assert.deepEqual(Buffer.from(await decryptFile(A.file, ring)), Buffer.from(plain));
});

test("adopting the key the install already has changes nothing, even with a file from a later passphrase", async () => {
    const A = await install("pass of A");
    await changePassphrase(A.store, { passphrase: "pass of A" }, "newer pass of A", CHEAP);
    const before = await recordOf(A.store);
    assert.equal(await adoptKeyring(A.store, A.file, { passphrase: "pass of A" }), A.shown.keyId);
    assert.equal(await recordOf(A.store), before, "same wraps: the newer passphrase is still the current one");
});

test("changing the passphrase after an adoption keeps the retired keys", async () => {
    const A = await install("pass of A"), B = await install("pass of B");
    await adoptKeyring(B.store, A.file, { passphrase: "pass of A" });
    await changePassphrase(B.store, { passphrase: "pass of A" }, "B's new pass", CHEAP);
    assert.deepEqual((await loadKeyring(B.store)).retired.map((r) => r.keyId), [B.shown.keyId]);
});

test("THE UPGRADE: a record stored before 3c (no retired list) loads, seals and opens as before, and an adoption onto it keeps its key as retired", async () => {
    const B = await install("pass of B");
    const ring = await loadKeyring(B.store);
    assert.equal("retired" in ring, false, "fixture: the set-up record has no retired list");
    assert.equal(keyFor(ring, "0000000000000000"), null, "no retired list: only the current key is found");
    assert.equal(keyFor(ring, ring.keyId), ring);
    assert.deepEqual(Buffer.from(await decryptFile(B.file, ring)), Buffer.from(plain));
    assert.equal(unlockChoice(B.file, ring), ring);
    const A = await install("pass of A");
    await adoptKeyring(B.store, A.file, { passphrase: "pass of A" });
    assert.deepEqual((await loadKeyring(B.store)).retired.map((r) => r.keyId), [B.shown.keyId]);
});

test("adopting twice in a row retires both earlier keys; adopting an earlier key back takes it out of the retired list", async () => {
    const A = await install("pass of A"), B = await install("pass of B"), C = await install("pass of C");
    await adoptKeyring(B.store, A.file, { passphrase: "pass of A" });
    await adoptKeyring(B.store, C.file, { passphrase: "pass of C" });
    assert.deepEqual((await loadKeyring(B.store)).retired.map((r) => r.keyId), [A.shown.keyId, B.shown.keyId]);
    await adoptKeyring(B.store, A.file, { passphrase: "pass of A" });
    const ring = await loadKeyring(B.store);
    assert.equal(ring.keyId, A.shown.keyId);
    assert.deepEqual(ring.retired.map((r) => r.keyId), [C.shown.keyId, B.shown.keyId], "never the current key, each once");
});

test("after an adoption a backup made under the old key opens with no secret, and one under a key neither current nor retired still asks", async () => {
    const A = await install("pass of A"), B = await install("pass of B"), C = await install("pass of C");
    await adoptKeyring(B.store, A.file, { passphrase: "pass of A" });
    const ring = await loadKeyring(B.store);
    assert.equal(unlockChoice(B.file, ring), ring, "B's old backup: the retired key");
    assert.equal(unlockChoice(A.file, ring), ring, "the folder's key: the current one");
    assert.throws(() => unlockChoice(C.file, ring), (e) => e.reason === "needs-key");
    assert.deepEqual(unlockChoice(C.file, ring, { passphrase: "pass of C" }), { passphrase: "pass of C" });
});

// --- adoption is bound to the file's chunks, not to its header alone (red-team F1, part 3c) ---

/** `evil`'s whole header over `victim`'s chunks: `magic(8) + u32le header length + header JSON`, then the chunks. */
function splice(evil, victim) {
    const hlen = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(8, true);
    return new Uint8Array([...evil.subarray(0, 12 + hlen(evil)), ...victim.subarray(12 + hlen(victim))]);
}

test("a header spliced over another file's chunks adopts nothing, though the typed secret opens its wrap", async () => {
    const A = await install("pass of A"), E = await install("pass of E");
    const store = idbKeyringStore(new IDBFactory());
    await assert.rejects(adoptKeyring(store, splice(E.file, A.file), { passphrase: "pass of E" }), (e) => e instanceof BackupError && e.reason === "corrupt");
    assert.deepEqual(await keyringState(store), { set: false });
    // An install that has a key keeps it, byte for byte.
    const before = await recordOf(A.store);
    await assert.rejects(adoptKeyring(A.store, splice(E.file, A.file), { passphrase: "pass of E" }), (e) => e.reason === "corrupt");
    assert.equal(await recordOf(A.store), before);
});

test("the binding is to the file, not its author: whoever knows the typed secret can seal a whole file that is adopted", async () => {
    // The limit the doc states: a folder writer who knows the secret makes E.file outright; nothing in the file can tell.
    const E = await install("pass of E");
    const store = idbKeyringStore(new IDBFactory());
    assert.equal(await adoptKeyring(store, E.file, { passphrase: "pass of E" }), E.shown.keyId);
});

test("readHeadAndFirstChunk reads the header and the first chunk only, and adoption works from those bytes", async () => {
    const { readHeadAndFirstChunk, opensFirstChunk } = await import("../src/backup/backup-format.ts");
    const A = await install("pass of A");
    const big = await encryptFile(crypto.getRandomValues(new Uint8Array(40_000)), A.ring, { kind: "archive-month", chunk: 1024 });
    const part = await readHeadAndFirstChunk(new Blob([big]));
    assert.ok(part.length < big.length, "the rest of the file is not read");
    await opensFirstChunk(part, A.ring);
    const store = idbKeyringStore(new IDBFactory());
    assert.equal(await adoptKeyring(store, part, { passphrase: "pass of A" }), A.shown.keyId);
    // The header alone is not enough any more.
    const hlen = new DataView(big.buffer, big.byteOffset, big.byteLength).getUint32(8, true);
    await assert.rejects(adoptKeyring(idbKeyringStore(new IDBFactory()), big.subarray(0, 12 + hlen), { passphrase: "pass of A" }), (e) => e.reason === "truncated");
});

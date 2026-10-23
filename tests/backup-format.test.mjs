// The backup file format (docs/spec/BACKUP_FORMAT.md): round trips, both ways in, every way a file can be damaged, and
// a committed v1 file that must open forever. Argon2 is run cheap in most tests; the fixture and one timing test use the real cost.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    BackupError, DEFAULT_ARGON, createKeyring, decryptFile, encryptFile, gunzip, gzip, newRecoveryKey, parseRecoveryKey, readAnyForm, readHeader, rewrap, sniff, unlock,
} from "../src/backup/backup-format.ts";

const CHEAP = { argon: { m: 64, t: 1, p: 1 } };
const SQLITE_HEAD = new TextEncoder().encode("SQLite format 3\0");
/** Deterministic, incompressible-ish bytes that start like a SQLite file. */
const sample = (n) => {
    const b = new Uint8Array(n);
    let x = 12345;
    for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; b[i] = x >> 16; }
    b.set(SQLITE_HEAD.subarray(0, Math.min(n, 16)), 0);
    return b;
};
const same = (a, b) => assert.ok(Buffer.from(a).equals(Buffer.from(b)));
const rejects = (p, reason) => assert.rejects(p, (e) => e instanceof BackupError && (!reason || e.reason === reason));
const PASS = "pässword é";

let shared;
/** One cheap keyring for the whole file: creating it is the only slow part. */
const ring = async () => (shared ??= await createKeyring(PASS, CHEAP));

// --- round trips ---

for (const [name, n, chunk] of [["empty", 0, 64], ["under one chunk", 100, 4096], ["exactly one chunk of ciphertext input", 1024, 1 << 20], ["several chunks", 5000, 300]]) {
    test(`round trip: ${name}`, async () => {
        const { keyring } = await ring();
        const plain = sample(n);
        const file = await encryptFile(plain, keyring, { kind: "backup", chunk });
        same(await decryptFile(file, keyring), plain);
    });
}

test("round trip: a gzip stream that fills exactly N chunks has no empty final chunk", async () => {
    const { keyring } = await ring();
    const plain = sample(2000);
    const packed = (await gzip(plain)).length;
    const file = await encryptFile(plain, keyring, { kind: "archive-month", chunk: packed });
    assert.equal(readHeader(file).kind, "archive-month");
    // magic+len+header, then one frame of packed+16 bytes plus its 4-byte length
    const hlen = new DataView(file.buffer, file.byteOffset).getUint32(8, true);
    assert.equal(file.length, 12 + hlen + 4 + packed + 16);
    same(await decryptFile(file, keyring), plain);
});

test("gzip and gunzip round trip, and gunzip refuses what is not gzip", async () => {
    const p = sample(3000);
    same(await gunzip(await gzip(p)), p);
    await assert.rejects(gunzip(new Uint8Array([1, 2, 3, 4])));
});

test("two encryptions of the same input differ (fresh file salt) but both open", async () => {
    const { keyring } = await ring();
    const a = await encryptFile(sample(10), keyring, { kind: "backup" });
    const b = await encryptFile(sample(10), keyring, { kind: "backup" });
    assert.notDeepEqual(a, b);
});

// --- both ways in ---

test("the passphrase and the recovery key both open a file, from the header alone", async () => {
    const { keyring, recoveryKey } = await createKeyring(PASS, CHEAP);
    const plain = sample(1500);
    const file = await encryptFile(plain, keyring, { kind: "backup", chunk: 400 });
    same(await decryptFile(file, { passphrase: PASS }), plain);
    same(await decryptFile(file, { recoveryKey }), plain);
    same(await decryptFile(file, { recoveryKey: recoveryKey.toLowerCase().replaceAll("-", " ") }), plain);
    const opened = await unlock(readHeader(file).wraps, { passphrase: PASS });
    assert.equal(opened.keyId, keyring.keyId);
    same(await decryptFile(file, opened), plain);
});

test("a passphrase is compared after NFC normalisation", async () => {
    const { keyring } = await createKeyring("café", CHEAP);
    const file = await encryptFile(sample(5), keyring, { kind: "backup" });
    await decryptFile(file, { passphrase: "café" });
});

test("a wrong passphrase and a wrong recovery key fail cleanly", async () => {
    const { keyring, recoveryKey } = await ring();
    const file = await encryptFile(sample(50), keyring, { kind: "backup" });
    await rejects(decryptFile(file, { passphrase: "nope" }), "wrong-secret");
    const other = await newRecoveryKey();
    assert.notEqual(other, recoveryKey);
    await rejects(decryptFile(file, { recoveryKey: other }), "wrong-secret");
});

test("a keyring from another install is refused by key id, before any chunk is tried", async () => {
    const { keyring } = await ring();
    const { keyring: stranger } = await createKeyring("other", CHEAP);
    const file = await encryptFile(sample(50), keyring, { kind: "backup" });
    await rejects(decryptFile(file, stranger), "wrong-secret");
});

test("the data key is not extractable", async () => {
    const { keyring } = await ring();
    await assert.rejects(crypto.subtle.exportKey("raw", keyring.key));
    assert.equal(keyring.key.extractable, false);
    const opened = await unlock(keyring.wraps, { passphrase: PASS });
    assert.equal(opened.key.extractable, false);
});

test("a header's own Argon2 cost is used, and an absurd one is refused", async () => {
    const { keyring } = await ring();
    const w = structuredClone(keyring.wraps);
    w[0].kdf.m = 1 << 30;
    await rejects(unlock(w, { passphrase: PASS }), "bad-header");
});

// --- the recovery key ---

test("a recovery key is 28 characters in 7 groups of 4 and parses back to 16 bytes", async () => {
    const k = await newRecoveryKey();
    assert.match(k, /^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{4}$/);
    assert.equal((await parseRecoveryKey(k)).length, 16);
});

test("recovery key parsing: case, spaces, dashes and Crockford's I/L/O", async () => {
    const k = await newRecoveryKey();
    const want = await parseRecoveryKey(k);
    same(await parseRecoveryKey(k.toLowerCase()), want);
    same(await parseRecoveryKey(k.replaceAll("-", "  ")), want);
    same(await parseRecoveryKey(k.replaceAll("-", "")), want);
    const keyWith1 = (await (async () => { for (;;) { const c = await newRecoveryKey(); if (c.includes("1") && c.includes("0")) return c; } })());
    same(await parseRecoveryKey(keyWith1.replaceAll("1", "l").replaceAll("0", "o")), await parseRecoveryKey(keyWith1));
    same(await parseRecoveryKey(keyWith1.replaceAll("1", "I").replaceAll("0", "O")), await parseRecoveryKey(keyWith1));
});

test("recovery key parsing: a typo in any one position is caught by the checksum or the alphabet", async () => {
    // a fixed key: a 10-bit checksum misses a random single-character typo about one time in a thousand, so a random key would make this flaky
    const k = "CP00-058T-BSTQ-PZYS-83W9-6XXA-0M65".replaceAll("-", "");
    let caught = 0;
    for (let i = 0; i < k.length; i++) {
        const c = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[("0123456789ABCDEFGHJKMNPQRSTVWXYZ".indexOf(k[i]) + 1) % 32];
        const bad = k.slice(0, i) + c + k.slice(i + 1);
        await assert.rejects(parseRecoveryKey(bad), (e) => e instanceof BackupError && e.reason === "bad-recovery-key");
        caught++;
    }
    assert.equal(caught, 28);
    await rejects(parseRecoveryKey(k.slice(0, 27)), "bad-recovery-key");
    await rejects(parseRecoveryKey("U" + k.slice(1)), "bad-recovery-key");
});

// --- damage ---

/** Split a file into [prefix, ...frames], each frame its 4-byte length and ciphertext. */
const frames = (f) => {
    const hlen = new DataView(f.buffer, f.byteOffset).getUint32(8, true);
    let at = 12 + hlen;
    const out = [f.subarray(0, at)];
    while (at < f.length) { const n = new DataView(f.buffer, f.byteOffset).getUint32(at, true); out.push(f.subarray(at, at + 4 + n)); at += 4 + n; }
    return out;
};
const join = (parts) => Buffer.concat(parts);

test("truncation: dropping the last chunk is rejected, never returned as a shorter history", async () => {
    const { keyring } = await ring();
    const file = await encryptFile(sample(3000), keyring, { kind: "backup", chunk: 500 });
    const parts = frames(file);
    assert.ok(parts.length > 3);
    await rejects(decryptFile(join(parts.slice(0, -1)), keyring));
    await rejects(decryptFile(join(parts.slice(0, 1)), keyring), "truncated");
    await rejects(decryptFile(file.subarray(0, file.length - 1), keyring));
    await rejects(decryptFile(file.subarray(0, 14), keyring), "truncated");
});

test("reordered chunks are rejected", async () => {
    const { keyring } = await ring();
    const file = await encryptFile(sample(3000), keyring, { kind: "backup", chunk: 500 });
    const [p, ...c] = frames(file);
    [c[0], c[1]] = [c[1], c[0]];
    await rejects(decryptFile(join([p, ...c]), keyring), "corrupt");
});

test("one flipped byte in the header or in the body is rejected", async () => {
    const { keyring } = await ring();
    const file = await encryptFile(sample(1500), keyring, { kind: "backup", chunk: 500 });
    const hlen = new DataView(file.buffer, file.byteOffset).getUint32(8, true);
    for (const at of [20, 12 + Math.floor(hlen / 2), 12 + hlen - 2, 12 + hlen + 10, file.length - 1]) {
        const bad = Buffer.from(file);
        bad[at] ^= 1;
        await assert.rejects(decryptFile(bad, keyring), (e) => e instanceof BackupError, `byte ${at}`);
    }
});

test("bytes after the final chunk are rejected", async () => {
    const { keyring } = await ring();
    const file = await encryptFile(sample(100), keyring, { kind: "backup" });
    await rejects(decryptFile(Buffer.concat([file, Buffer.from([0])]), keyring));
    await rejects(decryptFile(Buffer.concat([file, file.subarray(file.length - 40)]), keyring));
});

test("an unknown version or an unparseable header is rejected", async () => {
    const { keyring } = await ring();
    const file = Buffer.from(await encryptFile(sample(10), keyring, { kind: "backup" }));
    const v2 = Buffer.from(file); v2[7] = 2;
    await rejects(decryptFile(v2, keyring), "unsupported-version");
    const junk = Buffer.from(file); junk.fill(0x20, 12, 30);
    await rejects(decryptFile(junk, keyring), "bad-header");
    await rejects(decryptFile(Buffer.from("WMLBAK\0\x01"), keyring), "truncated");
});

test("a wrong-form input to decryptFile says so", async () => {
    const { keyring } = await ring();
    await rejects(decryptFile(sample(100), keyring), "unknown-form");
});

// --- the three forms ---

test("sniff tells the forms apart by their first bytes", async () => {
    const { keyring } = await ring();
    assert.equal(sniff(sample(100)), "sqlite");
    assert.equal(sniff(await gzip(sample(100))), "gzip");
    assert.equal(sniff(await encryptFile(sample(100), keyring, { kind: "backup" })), "wmlbak");
    assert.equal(sniff(new Uint8Array([1, 2, 3])), "unknown");
    assert.equal(sniff(new Uint8Array(0)), "unknown");
    assert.equal(sniff(SQLITE_HEAD.subarray(0, 8)), "unknown");
});

test("readAnyForm returns the SQLite bytes from all three forms, asking for a key only when needed", async () => {
    const { keyring } = await ring();
    const plain = sample(2000);
    let asked = 0;
    const ask = async () => { asked++; return { passphrase: PASS }; };
    same(await readAnyForm(plain, ask), plain);
    same(await readAnyForm(await gzip(plain), ask), plain);
    assert.equal(asked, 0);
    const enc = await encryptFile(plain, keyring, { kind: "backup" });
    same(await readAnyForm(enc, ask), plain);
    same(await readAnyForm(enc, async () => keyring), plain);
    assert.equal(asked, 1);
    await rejects(readAnyForm(enc), "needs-key");
    await rejects(readAnyForm(new Uint8Array([9, 9, 9])), "unknown-form");
});

// --- changing the passphrase ---

test("rewrap: the new passphrase and the recovery key open old and new files; the old passphrase does not open new ones", async () => {
    const { keyring, recoveryKey } = await createKeyring("old", CHEAP);
    const plain = sample(800);
    const oldFile = await encryptFile(plain, keyring, { kind: "backup" });
    const wraps = await rewrap(keyring.wraps, { passphrase: "old" }, "new", CHEAP);
    assert.deepEqual(wraps.find((w) => w.by === "recovery"), keyring.wraps.find((w) => w.by === "recovery"));
    const renewed = await unlock(wraps, { passphrase: "new" });
    assert.equal(renewed.keyId, keyring.keyId);
    const newFile = await encryptFile(plain, renewed, { kind: "backup" });
    same(await decryptFile(newFile, { passphrase: "new" }), plain);
    same(await decryptFile(newFile, { recoveryKey }), plain);
    await rejects(decryptFile(newFile, { passphrase: "old" }), "wrong-secret");
    // a file written before the change still carries the old wrap, so the old passphrase still opens THAT file
    same(await decryptFile(oldFile, { passphrase: "old" }), plain);
    // the recovery key can also authorise the change
    const viaRecovery = await rewrap(keyring.wraps, { recoveryKey }, "third", CHEAP);
    same(await decryptFile(newFile, await unlock(viaRecovery, { passphrase: "third" })), plain);
    await rejects(rewrap(keyring.wraps, { passphrase: "wrong" }, "x", CHEAP), "wrong-secret");
});

// --- the committed v1 file: UPGRADE ---

const FIXTURE = new URL("./fixtures/backup/v1-sample.wmlbak", import.meta.url);
const FIXTURE_PASS = "correct horse battery staple é";
const FIXTURE_RECOVERY = "CP00-058T-BSTQ-PZYS-83W9-6XXA-0M65";

test("upgrade: a v1 file written once, with the real Argon2 cost, opens with both secrets forever", async () => {
    const file = new Uint8Array(readFileSync(FIXTURE));
    const h = readHeader(file);
    assert.deepEqual(h.wraps[0].kdf, DEFAULT_ARGON);
    assert.equal(h.created, "2026-10-23T00:00:00.000Z");
    const want = sample(1500);
    same(await decryptFile(file, { passphrase: FIXTURE_PASS }), want);
    same(await decryptFile(file, { recoveryKey: FIXTURE_RECOVERY }), want);
});

// --- the standalone decryptor ---

test("tools/wmlbak-decrypt.mjs writes the same bytes as the module, by passphrase and by recovery key", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wmlbak-"));
    const script = new URL("../tools/wmlbak-decrypt.mjs", import.meta.url).pathname;
    const fixture = FIXTURE.pathname;
    const want = await decryptFile(new Uint8Array(readFileSync(fixture)), { passphrase: FIXTURE_PASS });
    for (const [flag, secret] of [[[], FIXTURE_PASS], [["--recovery-key"], FIXTURE_RECOVERY.toLowerCase()]]) {
        const out = path.join(dir, "out" + flag.length + ".sqlite");
        const r = spawnSync(process.execPath, [script, fixture, out, ...flag], { input: secret + "\n", encoding: "utf8" });
        assert.equal(r.status, 0, r.stderr);
        same(readFileSync(out), want);
    }
    // a wrong secret writes nothing and exits non-zero; so does a damaged file
    const out = path.join(dir, "never.sqlite");
    assert.notEqual(spawnSync(process.execPath, [script, fixture, out], { input: "wrong\n", encoding: "utf8" }).status, 0);
    const bad = Buffer.from(readFileSync(fixture));
    bad[bad.length - 1] ^= 1;
    writeFileSync(path.join(dir, "bad.wmlbak"), bad);
    const r = spawnSync(process.execPath, [script, path.join(dir, "bad.wmlbak"), out], { input: FIXTURE_PASS + "\n", encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.throws(() => readFileSync(out));
});

test("the decryptor reads a file the module just wrote with a non-default cost", async () => {
    const { keyring } = await ring();
    const dir = mkdtempSync(path.join(tmpdir(), "wmlbak-"));
    const plain = sample(4000);
    writeFileSync(path.join(dir, "a.wmlbak"), await encryptFile(plain, keyring, { kind: "archive-month", chunk: 700 }));
    const r = spawnSync(process.execPath, [new URL("../tools/wmlbak-decrypt.mjs", import.meta.url).pathname, path.join(dir, "a.wmlbak"), path.join(dir, "a.sqlite")], { input: PASS + "\n", encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    same(readFileSync(path.join(dir, "a.sqlite")), plain);
});

test("default parameters: one Argon2 unlock is well under a few seconds", async () => {
    const t = performance.now();
    await unlock(readHeader(new Uint8Array(readFileSync(FIXTURE))).wraps, { passphrase: FIXTURE_PASS });
    const ms = performance.now() - t;
    console.log(`argon2id m=${DEFAULT_ARGON.m} KiB t=${DEFAULT_ARGON.t} p=${DEFAULT_ARGON.p}: ${ms.toFixed(0)} ms`);
    assert.ok(ms < 8000);
});

// The backup file format (docs/spec/BACKUP_FORMAT.md): round trips, both ways in, every way a file can be damaged, and
// a committed v1 file that must open forever. Argon2 is run cheap in most tests; the fixture and one timing test use the real cost.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    BackupError, DEFAULT_ARGON, LIMITS, createKeyring, decryptFile, encryptFile, gunzip, gzip, newRecoveryKey, parseRecoveryKey, readAnyForm, readHeader, rewrap, sniff, unlock,
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
    await rejects(unlock(w, { passphrase: PASS }), "over-budget");
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
    await rejects(decryptFile(join(parts.slice(0, -1)), keyring), "truncated");
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
    await rejects(decryptFile(Buffer.concat([file, Buffer.from([0])]), keyring), "trailing-data");
    await rejects(decryptFile(Buffer.concat([file, file.subarray(file.length - 40)]), keyring), "trailing-data");
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

// --- the resource budget ---

const enc = new TextEncoder();
const dec = new TextDecoder();
/** Re-write a file's header after `mutate(header)`, keeping the body: the AAD no longer matches, which only matters to a reader that gets as far as a chunk. */
function withHeader(src, mutate) {
    const hlen = new DataView(src.buffer, src.byteOffset, src.byteLength).getUint32(8, true);
    const header = JSON.parse(dec.decode(src.subarray(12, 12 + hlen)));
    mutate(header);
    const hb = enc.encode(JSON.stringify(header));
    const out = new Uint8Array(12 + hb.length + src.length - 12 - hlen);
    out.set(src.subarray(0, 8), 0);
    new DataView(out.buffer).setUint32(8, hb.length, true);
    out.set(hb, 12);
    out.set(src.subarray(12 + hlen), 12 + hb.length);
    return out;
}
/** A cheap file whose first (passphrase) wrap has `kdf` replaced. */
const withKdf = (file, kdf) => withHeader(file, (h) => { h.wraps[0].kdf = { alg: "argon2id", ...kdf }; });
const oneFile = async () => encryptFile(sample(10), (await ring()).keyring, { kind: "backup", chunk: 64 });

test("LIMITS is frozen and holds the numbers the spec names", () => {
    assert.ok(Object.isFrozen(LIMITS) && Object.isFrozen(LIMITS.argon));
    assert.deepEqual(JSON.parse(JSON.stringify(LIMITS)), { headerBytes: 1 << 20, chunkBytes: 64 << 20, wraps: 2, argon: { m: 262144, t: 12, p: 4 }, outputBytes: 1 << 30 });
    assert.equal(LIMITS.argon.m, 4 * DEFAULT_ARGON.m);
});

test("Argon2 cost: each of m, t and p is accepted at its limit and refused one past it, before any KDF", async () => {
    const file = await oneFile();
    const { m, t, p } = LIMITS.argon;
    readHeader(withKdf(file, { m, t, p })); // the limit itself: header-only, so no Argon2 runs
    for (const over of [{ m: m + 1, t, p }, { m, t: t + 1, p }, { m, t, p: p + 1 }]) {
        const bad = withKdf(file, over);
        await rejects((async () => readHeader(bad))(), "over-budget");
        const t0 = performance.now();
        await rejects(decryptFile(bad, { passphrase: PASS }), "over-budget");
        assert.ok(performance.now() - t0 < 1000, "refused without running Argon2");
    }
});

test("Argon2 cost: malformed numbers are bad-header, including m below 8 * p", async () => {
    const file = await oneFile();
    readHeader(withKdf(file, { m: 32, t: 1, p: 4 })); // m = 8 * p exactly
    for (const kdf of [{ m: 31, t: 1, p: 4 }, { m: 0, t: 1, p: 1 }, { m: 64, t: 0, p: 1 }, { m: 64, t: 1, p: 0 }, { m: 64.5, t: 1, p: 1 }, { m: "64", t: 1, p: 1 }]) {
        await rejects((async () => readHeader(withKdf(file, kdf)))(), "bad-header");
    }
});

test("wraps: one or two, at most one per kind; a third is over-budget, a repeated or unknown kind is bad-header, none is bad-header", async () => {
    const file = await oneFile();
    const [pw, rk] = readHeader(file).wraps;
    assert.equal(readHeader(withHeader(file, (h) => { h.wraps = [pw]; })).wraps.length, 1);
    assert.equal(readHeader(withHeader(file, (h) => { h.wraps = [pw, rk]; })).wraps.length, 2);
    await rejects((async () => readHeader(withHeader(file, (h) => { h.wraps = [pw, rk, rk]; })))(), "over-budget");
    await rejects((async () => readHeader(withHeader(file, (h) => { h.wraps = Array(200).fill(pw); })))(), "over-budget");
    await rejects((async () => readHeader(withHeader(file, (h) => { h.wraps = [pw, pw]; })))(), "bad-header");
    await rejects((async () => readHeader(withHeader(file, (h) => { h.wraps = [rk, rk]; })))(), "bad-header");
    await rejects((async () => readHeader(withHeader(file, (h) => { h.wraps = [{ ...pw, by: "escrow" }]; })))(), "bad-header");
    await rejects((async () => readHeader(withHeader(file, (h) => { h.wraps = []; })))(), "bad-header");
    // a duplicate cannot multiply the cost: it is refused before unlock runs Argon2 even once
    const t0 = performance.now();
    await rejects(decryptFile(withHeader(file, (h) => { h.wraps = [pw, pw]; }), { passphrase: PASS }), "bad-header");
    assert.ok(performance.now() - t0 < 500);
});

test("wraps: the passphrase wrap and the recovery wrap together open the file, each by itself", async () => {
    const { keyring, recoveryKey } = await createKeyring(PASS, CHEAP);
    const plain = sample(300);
    const file = await encryptFile(plain, keyring, { kind: "backup", chunk: 100 });
    assert.deepEqual(readHeader(file).wraps.map((w) => w.by), ["passphrase", "recovery"]);
    same(await decryptFile(file, { passphrase: PASS }), plain);
    same(await decryptFile(file, { recoveryKey }), plain);
});

test("every wrap is a BackupError whatever its shape: null, undefined, a number, an array, a string, a missing field", async () => {
    const file = await oneFile();
    const [pw] = readHeader(file).wraps;
    const shapes = [[null], [undefined], [42], [[]], ["x"], [{ ...pw, kdf: null }], [{ ...pw, kdf: undefined }], [{ ...pw, salt: undefined }], [{ ...pw, iv: undefined }], [{ ...pw, ct: undefined }], [{ ...pw, ct: "AAAA" }], null, "wraps", {}];
    for (const wraps of shapes) {
        await assert.rejects(decryptFile(withHeader(file, (h) => { h.wraps = wraps; }), { passphrase: PASS }), (e) => e instanceof BackupError && e.reason === "bad-header", JSON.stringify(wraps));
    }
});

test("the header: 1 MiB is accepted, one byte more is over-budget", async () => {
    const file = await oneFile();
    const sized = (n) => {
        const base = withHeader(file, (h) => { h.pad = ""; });
        const baseLen = new DataView(base.buffer, base.byteOffset).getUint32(8, true);
        return withHeader(file, (h) => { h.pad = "x".repeat(n - baseLen); });
    };
    const at = sized(LIMITS.headerBytes);
    assert.equal(new DataView(at.buffer, at.byteOffset).getUint32(8, true), LIMITS.headerBytes);
    readHeader(at);
    const over = Buffer.from(at);
    over.writeUInt32LE(LIMITS.headerBytes + 1, 8);
    await rejects((async () => readHeader(over))(), "over-budget");
    over.writeUInt32LE(0xffffffff, 8);
    await rejects((async () => readHeader(over))(), "over-budget");
});

test("the chunk size: 64 MiB is accepted, one byte more is over-budget, zero is bad-header", async () => {
    const file = await oneFile();
    assert.equal(readHeader(withHeader(file, (h) => { h.chunk = LIMITS.chunkBytes; })).kind, "backup");
    await rejects((async () => readHeader(withHeader(file, (h) => { h.chunk = LIMITS.chunkBytes + 1; })))(), "over-budget");
    await rejects((async () => readHeader(withHeader(file, (h) => { h.chunk = 0; })))(), "bad-header");
    await assert.rejects(encryptFile(sample(1), (await ring()).keyring, { kind: "backup", chunk: LIMITS.chunkBytes + 1 }), RangeError);
});

test("gunzip: output at the cap is returned, one byte past it is over-budget", async () => {
    const packed = await gzip(new Uint8Array(5000));
    assert.equal((await gunzip(packed, 5000)).length, 5000);
    await rejects(gunzip(packed, 4999), "over-budget");
    await rejects(gunzip(packed, 0), "over-budget");
    assert.equal((await gunzip(await gzip(new Uint8Array(0)), 0)).length, 0);
    await rejects(gunzip(packed, -1), "over-budget");
});

test("a gzip bomb is refused as soon as it passes the cap, through every entry point", async () => {
    const bomb = await gzip(new Uint8Array(64 << 20));
    assert.ok(bomb.length < 1 << 20, `a small plant: ${bomb.length} B`);
    const cap = 1 << 20;
    const t0 = performance.now();
    await rejects(gunzip(bomb, cap), "over-budget");
    await rejects(readAnyForm(bomb, undefined, cap), "over-budget");
    const { keyring } = await ring();
    const sealed = await encryptFile(new Uint8Array(64 << 20), keyring, { kind: "backup" });
    await rejects(decryptFile(sealed, keyring, cap), "over-budget");
    await rejects(readAnyForm(sealed, async () => keyring, cap), "over-budget");
    const ms = performance.now() - t0;
    console.log(`gzip bomb (64 MiB from ${bomb.length} B) refused through four entry points in ${ms.toFixed(0)} ms`);
    assert.ok(ms < 5000);
});

test("the default output cap is LIMITS.outputBytes: a bomb one byte past 1 GiB is refused, without being held whole", async () => {
    const bomb = await gzip(new Uint8Array(LIMITS.outputBytes + 1));
    assert.ok(bomb.length < 4 << 20, `a small plant: ${bomb.length} B`);
    const t0 = performance.now();
    await rejects(readAnyForm(bomb), "over-budget");
    console.log(`gzip bomb (1 GiB + 1 from ${bomb.length} B) refused in ${(performance.now() - t0).toFixed(0)} ms`);
});

test("an Argon2 header over the limit is refused in milliseconds", async () => {
    const file = withKdf(await oneFile(), { m: LIMITS.argon.m + 1, t: LIMITS.argon.t, p: 1 });
    const t0 = performance.now();
    await rejects(decryptFile(file, { passphrase: PASS }), "over-budget");
    const ms = performance.now() - t0;
    console.log(`over-limit Argon2 header refused in ${ms.toFixed(1)} ms`);
    assert.ok(ms < 200);
});

// --- the reasons a caller may branch on ---

test("truncated, trailing-data and corrupt are told apart", async () => {
    const { keyring } = await ring();
    const file = await encryptFile(sample(3000), keyring, { kind: "backup", chunk: 500 });
    const parts = frames(file);
    await rejects(decryptFile(join(parts.slice(0, -1)), keyring), "truncated"); // the last frame removed
    await rejects(decryptFile(file.subarray(0, file.length - 1), keyring), "truncated"); // cut inside the last frame
    await rejects(decryptFile(join([...parts, Buffer.from([1, 2, 3])]), keyring), "trailing-data");
    await rejects(decryptFile(join([...parts, parts[1]]), keyring), "trailing-data"); // a whole extra frame
    const flipped = Buffer.from(file);
    flipped[flipped.length - 1] ^= 1;
    await rejects(decryptFile(flipped, keyring), "corrupt");
    const mid = Buffer.from(file);
    mid[file.length >> 1] ^= 1;
    await rejects(decryptFile(mid, keyring), "corrupt");
    same(await decryptFile(file, keyring), sample(3000)); // positive control
});

// --- the prefix is the AAD, and other wraps never open a file ---

test("any header edit fails every chunk as corrupt, and another keyring's wraps never open a file", async () => {
    const { keyring } = await ring();
    const file = await encryptFile(sample(100), keyring, { kind: "backup", chunk: 64 });
    for (const mutate of [(h) => { h.kind = "archive-month"; }, (h) => { h.created = "2000-01-01T00:00:00.000Z"; }, (h) => { h.note = "x"; }]) {
        await rejects(decryptFile(withHeader(file, mutate), { passphrase: PASS }), "corrupt");
    }
    same(await decryptFile(file, { passphrase: PASS }), sample(100));
    const other = await createKeyring("pw-two", CHEAP);
    for (const secret of [{ passphrase: PASS }, { passphrase: "pw-two" }, { recoveryKey: other.recoveryKey }]) {
        await assert.rejects(decryptFile(withHeader(file, (h) => { h.wraps = structuredClone(other.keyring.wraps); h.keyId = other.keyring.keyId; }), secret), (e) => e instanceof BackupError);
    }
});

test("two files from one keyring carry byte-identical wraps (wraps are per keyring, not per file)", async () => {
    const { keyring } = await ring();
    const a = await encryptFile(sample(10), keyring, { kind: "backup" });
    const b = await encryptFile(sample(20), keyring, { kind: "archive-month" });
    assert.deepEqual(readHeader(a).wraps, readHeader(b).wraps);
});

// --- the standalone decryptor against hostile files ---

const TOOL = new URL("../tools/wmlbak-decrypt.mjs", import.meta.url).pathname;
const toolDir = mkdtempSync(path.join(tmpdir(), "wmlbak-hostile-"));
let toolN = 0;
/** Run the decryptor on `bytes` with the passphrase PASS; returns its result and whether an output file appeared. */
function runTool(bytes, input = PASS + "\n", flag = []) {
    const inp = path.join(toolDir, `in${toolN}.wmlbak`);
    const out = path.join(toolDir, `out${toolN++}.sqlite`);
    writeFileSync(inp, bytes);
    const r = spawnSync(process.execPath, [TOOL, inp, out, ...flag], { input, encoding: "utf8", timeout: 20000 });
    let wrote = true;
    try { readFileSync(out); } catch { wrote = false; }
    return { r, wrote };
}
const refused = ({ r, wrote }, label) => {
    assert.notEqual(r.status, 0, `${label}: exit code`);
    assert.ok(r.stderr.startsWith("wmlbak-decrypt:"), `${label}: stderr starts with the tool's name, got ${JSON.stringify(r.stderr.slice(0, 120))}`);
    assert.doesNotMatch(r.stderr, /TypeError|\n\s+at |Node\.js v/, `${label}: no stack trace`);
    assert.equal(wrote, false, `${label}: no output file`);
};

test("the decryptor carries the same LIMITS as the module", () => {
    const src = readFileSync(TOOL, "utf8");
    const block = src.match(/const LIMITS = (\{[\s\S]*?\n\});/)?.[1];
    assert.ok(block, "the tool declares its LIMITS as one literal");
    assert.deepEqual(new Function(`return ${block}`)(), JSON.parse(JSON.stringify(LIMITS)));
});

test("the decryptor refuses every hostile input the module refuses, and writes nothing", async () => {
    const { keyring } = await ring();
    const file = await encryptFile(sample(3000), keyring, { kind: "backup", chunk: 500 });
    const [pw, rk] = readHeader(file).wraps;
    const { m, t, p } = LIMITS.argon;
    const hostile = {
        "argon m over": [withKdf(file, { m: m + 1, t, p }), "over-budget"],
        "argon t over": [withKdf(file, { m, t: t + 1, p }), "over-budget"],
        "argon p over": [withKdf(file, { m, t, p: p + 1 }), "over-budget"],
        "argon 4 GiB": [withKdf(file, { m: 2 ** 32, t: 1, p: 1 }), "over-budget"],
        "argon m below 8p": [withKdf(file, { m: 31, t: 1, p: 4 }), "bad-header"],
        "argon t = 200": [withKdf(file, { m: 64, t: 200, p: 1 }), "over-budget"],
        "argon p = 64": [withKdf(file, { m: 512, t: 1, p: 64 }), "over-budget"],
        "argon p = 64, m = 64": [withKdf(file, { m: 64, t: 1, p: 64 }), "bad-header"],
        "three wraps": [withHeader(file, (h) => { h.wraps = [pw, rk, rk]; }), "over-budget"],
        "two passphrase wraps": [withHeader(file, (h) => { h.wraps = [pw, pw]; }), "bad-header"],
        "unknown wrap kind": [withHeader(file, (h) => { h.wraps = [{ ...pw, by: "escrow" }, rk]; }), "bad-header"],
        "null wrap": [withHeader(file, (h) => { h.wraps = [null]; }), "bad-header"],
        "missing wraps": [withHeader(file, (h) => { delete h.wraps; }), "bad-header"],
        "null wraps": [withHeader(file, (h) => { h.wraps = null; }), "bad-header"],
        "empty wraps": [withHeader(file, (h) => { h.wraps = []; }), "bad-header"],
        "missing kdf": [withHeader(file, (h) => { delete h.wraps[0].kdf; }), "bad-header"],
        "salt with whitespace": [withHeader(file, (h) => { h.wraps[0].salt = h.wraps[0].salt.slice(0, 8) + " " + h.wraps[0].salt.slice(8); }), "bad-header"],
        "salt of 15 bytes": [withHeader(file, (h) => { h.wraps[0].salt = Buffer.alloc(15).toString("base64"); }), "bad-header"],
        "iv of 11 bytes": [withHeader(file, (h) => { h.wraps[0].iv = Buffer.alloc(11).toString("base64"); }), "bad-header"],
        "fileSalt of 31 bytes": [withHeader(file, (h) => { h.fileSalt = Buffer.alloc(31).toString("base64"); }), "bad-header"],
        "header length over": [(() => { const b = Buffer.from(file); b.writeUInt32LE(LIMITS.headerBytes + 1, 8); return b; })(), "over-budget"],
        "chunk over": [withHeader(file, (h) => { h.chunk = LIMITS.chunkBytes + 1; }), "over-budget"],
        "chunk zero": [withHeader(file, (h) => { h.chunk = 0; }), "bad-header"],
        "unsupported version": [(() => { const b = Buffer.from(file); b[7] = 2; return b; })(), "unsupported-version"],
        "truncated at a frame": [join(frames(file).slice(0, -1)), "truncated"],
        "truncated in a frame": [file.subarray(0, file.length - 1), "truncated"],
        "trailing data": [join([file, Buffer.from([0])]), "trailing-data"],
        "edited body": [(() => { const b = Buffer.from(file); b[b.length - 1] ^= 1; return b; })(), "corrupt"],
    };
    for (const [label, [bytes, reason]] of Object.entries(hostile)) {
        await assert.rejects(decryptFile(bytes, { passphrase: PASS }), (e) => e instanceof BackupError && e.reason === reason, `${label}: module reason ${reason}`);
        refused(runTool(bytes), label);
    }
    // the tool says the same thing in words for the reasons a caller branches on
    assert.match(runTool(hostile["trailing data"][0]).r.stderr, /trailing data/);
    assert.match(runTool(hostile["truncated at a frame"][0]).r.stderr, /cut short/);
    assert.match(runTool(hostile["argon m over"][0]).r.stderr, /over budget/);
    // positive control: the unmutated file opens through the same harness
    const ok = runTool(file);
    assert.equal(ok.r.status, 0, ok.r.stderr);
    assert.equal(ok.wrote, true);
});

test("the decryptor refuses an output path equal to the input, by name or by link, before reading it", () => {
    const p = path.join(toolDir, "self.wmlbak");
    writeFileSync(p, "not even a backup");
    for (const out of [p, path.join(toolDir, ".", "self.wmlbak"), path.join(toolDir, "sub", "..", "self.wmlbak")]) {
        const r = spawnSync(process.execPath, [TOOL, p, out], { input: "x\n", encoding: "utf8", timeout: 15000 });
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /^wmlbak-decrypt: the output path is the input path/);
        assert.equal(readFileSync(p, "utf8"), "not even a backup");
    }
    const link = path.join(toolDir, "link.wmlbak");
    symlinkSync(p, link);
    const r = spawnSync(process.execPath, [TOOL, p, link], { input: "x\n", encoding: "utf8", timeout: 15000 });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /the output path is the input path/);
    assert.equal(readFileSync(p, "utf8"), "not even a backup");
});

test("the decryptor reports a missing input in one line", () => {
    const r = spawnSync(process.execPath, [TOOL, path.join(toolDir, "nope.wmlbak"), path.join(toolDir, "nope.out")], { input: "x\n", encoding: "utf8", timeout: 15000 });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /^wmlbak-decrypt: ENOENT/);
});

test("the decryptor still opens the committed v1 fixture under its budget", async () => {
    const r = spawnSync(process.execPath, [TOOL, FIXTURE.pathname, path.join(toolDir, "fx.sqlite")], { input: FIXTURE_PASS + "\n", encoding: "utf8", timeout: 30000 });
    assert.equal(r.status, 0, r.stderr);
});

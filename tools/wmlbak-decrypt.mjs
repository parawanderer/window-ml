#!/usr/bin/env node
// wmlbak-decrypt.mjs — standalone decryptor for window.ml's .wmlbak files: encrypted file in, plain SQLite file out.
//
// Usage:   node wmlbak-decrypt.mjs <file.wmlbak> <out.sqlite> [--recovery-key]
// Needs:   Node 20 or later, and one dependency:  npm install hash-wasm
// It asks for the passphrase (or, with --recovery-key, the recovery key) on the terminal and never takes either as an
// argument, which would leave it in shell history. When stdin is not a terminal it reads one line from it instead.
//
// SELF-CONTAINED ON PURPOSE: it imports nothing from the extension, so a person can copy this one file out alone. The
// byte layout it reads is docs/spec/BACKUP_FORMAT.md; src/backup/backup-format.ts is the extension's reader of the
// same layout, and tests/backup-format.test.mjs holds the two to identical output.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { webcrypto as crypto } from "node:crypto";
import { argon2id } from "hash-wasm";

const text = new TextEncoder();
/** An expected refusal: main() catches it and prints only its message. */
class Refuse extends Error {}
const fail = (msg) => {
    throw new Refuse(msg);
};

// The resource budget, the same numbers as LIMITS in src/backup/backup-format.ts (docs/spec/BACKUP_FORMAT.md, "Limits a
// reader MUST keep"); tests/backup-format.test.mjs asserts they are equal. Every bound is inclusive.
const LIMITS = {
    headerBytes: 1048576,
    chunkBytes: 67108864,
    wraps: 2,
    argon: { m: 262144, t: 12, p: 4 },
    outputBytes: 1073741824,
};

/** Read a secret from the terminal without echoing it, or one line of stdin when piped. */
async function ask(prompt) {
    if (!process.stdin.isTTY) {
        let data = "";
        for await (const c of process.stdin) {
            data += c;
            if (data.includes("\n")) break;
        }
        return data.split(/\r?\n/)[0];
    }
    process.stderr.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    return new Promise((resolve) => {
        let s = "";
        process.stdin.on("data", function onData(ch) {
            for (const c of ch) {
                if (c === "\r" || c === "\n" || c === "\u0004") {
                    process.stdin.setRawMode(false);
                    process.stdin.pause();
                    process.stdin.off("data", onData);
                    process.stderr.write("\n");
                    return resolve(s);
                }
                if (c === "\u0003") process.exit(130);
                if (c === "\u007f") s = s.slice(0, -1);
                else s += c;
            }
        });
    });
}

/** Strict base64 of an exact decoded length, as the module's `unb64`: the same regex, then the decoded length. */
const b64 = (s, len) => {
    if (typeof s !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) fail("the header holds a field that is not base64");
    const out = new Uint8Array(Buffer.from(s, "base64"));
    if (out.length !== len) fail(`the header holds a field of ${out.length} bytes where ${len} are required`);
    return out;
};
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The 16 key bytes of a typed recovery key: case, spaces, dashes and I/L/O tolerated; the 2 check characters verified. */
async function parseRecoveryKey(input) {
    const s = input.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
    if (s.length !== 28 || [...s].some((c) => !ALPHABET.includes(c))) fail("that is not a recovery key (28 characters of 0-9 and A-Z)");
    const v = [...s].map((c) => ALPHABET.indexOf(c));
    const out = new Uint8Array(16);
    let acc = 0, bits = 0, at = 0;
    for (const x of v.slice(0, 26)) {
        acc = (acc << 5) | x;
        bits += 5;
        if (bits >= 8) {
            out[at++] = (acc >> (bits - 8)) & 255;
            bits -= 8;
            acc &= (1 << bits) - 1;
        }
    }
    const h = new Uint8Array(await crypto.subtle.digest("SHA-256", out));
    const c = (h[0] << 2) | (h[1] >> 6);
    if (acc !== 0 || ALPHABET[c >> 5] + ALPHABET[c & 31] !== s.slice(26)) fail("this recovery key has a typo: its check characters do not match");
    return out;
}

async function hkdf(ikm, salt, info, bits = 256) {
    const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: text.encode(info) }, k, bits));
}

/** Every bound and shape rule on the wraps, before any KDF runs; the same rules as the module's `checkWraps`. */
function checkWraps(wraps) {
    if (!Array.isArray(wraps) || wraps.length < 1) fail("the header carries no wraps");
    if (wraps.length > LIMITS.wraps) fail(`over budget: the header carries ${wraps.length} wraps; at most ${LIMITS.wraps} are accepted`);
    const seen = new Set();
    for (const w of wraps) {
        if (typeof w !== "object" || w === null || Array.isArray(w)) fail("a wrap in the header is not an object");
        if (w.by !== "passphrase" && w.by !== "recovery") fail("a wrap names a kind this script does not know");
        if (seen.has(w.by)) fail(`the header carries two "${w.by}" wraps; a file has at most one of each`);
        seen.add(w.by);
        b64(w.salt, 16);
        b64(w.iv, 12);
        b64(w.ct, 48);
        const k = w.kdf;
        if (typeof k !== "object" || k === null) fail("a wrap names no key derivation");
        if (w.by === "recovery") {
            if (k.alg !== "hkdf-sha256") fail("the recovery wrap names a key derivation this script does not know");
            continue;
        }
        const { m, t, p } = k;
        if (k.alg !== "argon2id" || ![m, t, p].every((x) => Number.isInteger(x) && x >= 1) || m < 8 * p) fail("the passphrase wrap names an Argon2id cost that is malformed");
        if (m > LIMITS.argon.m || t > LIMITS.argon.t || p > LIMITS.argon.p) fail(`over budget: the passphrase wrap asks for Argon2id m=${m} t=${t} p=${p}; at most m=${LIMITS.argon.m} t=${LIMITS.argon.t} p=${LIMITS.argon.p} are accepted`);
    }
}

/** The output path may not be the input path, by name or through a symlink or hard link (the same device and inode):
 *  that would overwrite the only encrypted copy. */
function refuseSamePath(inPath, outPath) {
    const sameFile = () => {
        const [a, b] = [statSync(inPath), statSync(outPath)];
        return a.dev === b.dev && a.ino === b.ino;
    };
    const same = resolve(inPath) === resolve(outPath) || (existsSync(outPath) && existsSync(inPath) && sameFile());
    if (same) fail("the output path is the input path; that would overwrite the encrypted file. Nothing was read or written.");
}

async function main() {
    const args = process.argv.slice(2);
    const useRecovery = args.includes("--recovery-key");
    const [inPath, outPath] = args.filter((a) => !a.startsWith("--"));
    if (!inPath || !outPath) fail("usage: node wmlbak-decrypt.mjs <file.wmlbak> <out.sqlite> [--recovery-key]");
    refuseSamePath(inPath, outPath);

    const file = new Uint8Array(readFileSync(inPath));
    if (file.length < 12 || Buffer.from(file.subarray(0, 7)).toString("latin1") !== "WMLBAK\0") fail("not a window.ml encrypted file");
    if (file[7] !== 1) fail(`format version ${file[7]} is not one this script knows; fetch a newer wmlbak-decrypt.mjs`);
    const hlen = new DataView(file.buffer, file.byteOffset, file.byteLength).getUint32(8, true);
    if (hlen > LIMITS.headerBytes) fail(`over budget: the header claims ${hlen} bytes; at most ${LIMITS.headerBytes} are accepted`);
    if (12 + hlen > file.length) fail("the file ends inside its header");
    const prefix = file.subarray(0, 12 + hlen);
    let header;
    try {
        header = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(prefix.subarray(12)));
    } catch {
        fail("the header is not valid JSON");
    }
    if (header?.v !== 1 || header.compression !== "gzip") fail("the header names a version or compression this script does not know");
    if (!Number.isInteger(header.chunk) || header.chunk < 1) fail("the header names a bad chunk size");
    if (header.chunk > LIMITS.chunkBytes) fail(`over budget: the header names a chunk of ${header.chunk} bytes; at most ${LIMITS.chunkBytes} are accepted`);
    if (typeof header.keyId !== "string") fail("the header lacks its key id");
    checkWraps(header.wraps);
    const fileSalt = b64(header.fileSalt, 32);

    // The data key: whichever wrap the secret opens. Cost parameters come from the header, as the spec requires.
    const secret = await ask(useRecovery ? "Recovery key: " : "Passphrase: ");
    let dataKey = null;
    for (const w of header.wraps) {
        if (w.by !== (useRecovery ? "recovery" : "passphrase")) continue;
        let kek;
        if (w.by === "passphrase") {
            const { m, t, p } = w.kdf;
            kek = new Uint8Array(await argon2id({ password: text.encode(secret.normalize("NFC")), salt: b64(w.salt, 16), memorySize: m, iterations: t, parallelism: p, hashLength: 32, outputType: "binary" }));
        } else {
            const ikm = await parseRecoveryKey(secret);
            kek = await hkdf(ikm, b64(w.salt, 16), "wmlbak v1 wrap recovery");
            ikm.fill(0);
        }
        try {
            const key = await crypto.subtle.importKey("raw", kek, "AES-GCM", false, ["decrypt"]);
            dataKey = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(w.iv, 12), additionalData: text.encode("wmlbak v1 wrap " + w.by) }, key, b64(w.ct, 48)));
            break;
        } catch {} finally {
            kek.fill(0);
        }
    }
    if (!dataKey) fail(`that ${useRecovery ? "recovery key" : "passphrase"} does not open this file`);

    const fileKeyBytes = await hkdf(dataKey, fileSalt, "wmlbak v1 file");
    dataKey.fill(0);
    const fileKey = await crypto.subtle.importKey("raw", fileKeyBytes, "AES-GCM", false, ["decrypt"]);
    fileKeyBytes.fill(0);
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
    const ivFor = (i, final) => {
        const iv = new Uint8Array(12);
        const dv = new DataView(iv.buffer);
        dv.setUint32(3, Math.floor(i / 2 ** 32));
        dv.setUint32(7, i >>> 0);
        iv[11] = final ? 1 : 0;
        return iv;
    };
    const plain = [];
    let at = prefix.length;
    if (at >= file.length) fail("the file has no chunks (cut short)");
    for (let i = 0; at < file.length; i++) {
        if (file.length - at < 4) fail("the file is cut short");
        const len = view.getUint32(at, true);
        if (len < 16 || len > header.chunk + 16) fail("a chunk has an impossible length: the file is damaged");
        if (at + 4 + len > file.length) fail("the file is cut short");
        const final = at + 4 + len === file.length;
        const frame = file.subarray(at + 4, at + 4 + len);
        try {
            plain.push(new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivFor(i, final), additionalData: prefix }, fileKey, frame)));
        } catch {
            const other = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivFor(i, !final), additionalData: prefix }, fileKey, frame).then(() => true, () => false);
            if (other && final) fail("the file ends before its last chunk (cut short). Nothing was written.");
            if (other) fail("the file has bytes after its last chunk (trailing data). Nothing was written.");
            fail("a chunk failed authentication: the file is damaged or edited. Nothing was written.");
        }
        at += 4 + len;
    }
    let out;
    try {
        out = gunzipSync(Buffer.concat(plain), { maxOutputLength: LIMITS.outputBytes });
    } catch (e) {
        if (e?.code === "ERR_BUFFER_TOO_LARGE") fail(`over budget: the file decompresses to more than ${LIMITS.outputBytes} bytes`);
        fail("the decrypted data is not valid gzip: " + (e?.message ?? e));
    }
    writeFileSync(outPath, out);
    console.error(`wrote ${outPath}`);
}

main().catch((e) => {
    if (e instanceof Refuse) {
        console.error("wmlbak-decrypt: " + e.message);
        process.exit(1);
    }
    // A missing input, an unwritable output: say so in one line. Anything else is a bug and keeps its stack.
    if (typeof e?.code === "string" && /^E[A-Z]+$/.test(e.code)) {
        console.error("wmlbak-decrypt: " + e.message);
        process.exit(1);
    }
    throw e;
});

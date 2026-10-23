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
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { webcrypto as crypto } from "node:crypto";
import { argon2id } from "hash-wasm";

const text = new TextEncoder();
const fail = (msg) => {
    console.error("wmlbak-decrypt: " + msg);
    process.exit(1);
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

const b64 = (s) => new Uint8Array(Buffer.from(s, "base64"));
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

const args = process.argv.slice(2);
const useRecovery = args.includes("--recovery-key");
const [inPath, outPath] = args.filter((a) => !a.startsWith("--"));
if (!inPath || !outPath) fail("usage: node wmlbak-decrypt.mjs <file.wmlbak> <out.sqlite> [--recovery-key]");

const file = new Uint8Array(readFileSync(inPath));
if (file.length < 12 || Buffer.from(file.subarray(0, 7)).toString("latin1") !== "WMLBAK\0") fail("not a window.ml encrypted file");
if (file[7] !== 1) fail(`format version ${file[7]} is not one this script knows; fetch a newer wmlbak-decrypt.mjs`);
const hlen = new DataView(file.buffer, file.byteOffset).getUint32(8, true);
if (12 + hlen > file.length) fail("the file ends inside its header");
const prefix = file.subarray(0, 12 + hlen);
let header;
try {
    header = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(prefix.subarray(12)));
} catch {
    fail("the header is not valid JSON");
}
if (header.v !== 1 || header.compression !== "gzip") fail("the header names a version or compression this script does not know");
if (!Number.isInteger(header.chunk) || header.chunk < 1) fail("the header names a bad chunk size");

// The data key: whichever wrap the secret opens. Cost parameters come from the header, as the spec requires.
const secret = await ask(useRecovery ? "Recovery key: " : "Passphrase: ");
let dataKey = null;
for (const w of header.wraps) {
    if (w.by !== (useRecovery ? "recovery" : "passphrase")) continue;
    let kek;
    if (w.by === "passphrase") {
        const { m, t, p } = w.kdf;
        kek = new Uint8Array(await argon2id({ password: text.encode(secret.normalize("NFC")), salt: b64(w.salt), memorySize: m, iterations: t, parallelism: p, hashLength: 32, outputType: "binary" }));
    } else {
        kek = await hkdf(await parseRecoveryKey(secret), b64(w.salt), "wmlbak v1 wrap recovery");
    }
    try {
        const key = await crypto.subtle.importKey("raw", kek, "AES-GCM", false, ["decrypt"]);
        dataKey = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(w.iv), additionalData: text.encode("wmlbak v1 wrap " + w.by) }, key, b64(w.ct)));
        break;
    } catch {}
}
if (!dataKey) fail(`that ${useRecovery ? "recovery key" : "passphrase"} does not open this file`);

const fileKey = await crypto.subtle.importKey("raw", await hkdf(dataKey, b64(header.fileSalt), "wmlbak v1 file"), "AES-GCM", false, ["decrypt"]);
const view = new DataView(file.buffer, file.byteOffset);
const plain = [];
let at = prefix.length;
if (at >= file.length) fail("the file has no chunks (cut short)");
for (let i = 0; at < file.length; i++) {
    if (file.length - at < 4) fail("the file is cut short");
    const len = view.getUint32(at, true);
    if (len < 16 || len > header.chunk + 16 || at + 4 + len > file.length) fail("the file is cut short or damaged");
    const final = at + 4 + len === file.length;
    const iv = new Uint8Array(12);
    const dv = new DataView(iv.buffer);
    dv.setUint32(3, Math.floor(i / 2 ** 32));
    dv.setUint32(7, i >>> 0);
    iv[11] = final ? 1 : 0;
    try {
        plain.push(new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: prefix }, fileKey, file.subarray(at + 4, at + 4 + len))));
    } catch {
        fail("a chunk failed authentication: the file is damaged, cut short, extended or edited. Nothing was written.");
    }
    at += 4 + len;
}
writeFileSync(outPath, gunzipSync(Buffer.concat(plain)));
console.error(`wrote ${outPath}`);

// backup-format.ts — the backup and archive-folder file format: gzip, AES-GCM chunks, the wrapped data key and the recovery key.

/**
 * The byte layout is `docs/spec/BACKUP_FORMAT.md`; the design, and why the data key is wrapped twice, is
 * `docs/dev/backup.md`. Nothing here touches `chrome`, `window` or storage: it runs in a service worker, a dedicated or
 * offscreen worker, an extension page and Node, on `crypto.subtle`, `CompressionStream` and `hash-wasm` (Argon2id,
 * which WebCrypto lacks) alone. `tools/wmlbak-decrypt.mjs` is a second, standalone reader of the same layout; a test
 * holds the two to identical output.
 */
import { argon2id } from "hash-wasm";

type Bytes = Uint8Array<ArrayBuffer>;

/** Why a file or a secret was refused, precise enough to tell the person what to do next. */
export class BackupError extends Error {
    constructor(
        readonly reason:
            /** the first bytes are not any of the three forms */
            | "unknown-form"
            /** a version of the format this reader does not know */
            | "unsupported-version"
            /** the header does not parse, or names something this reader refuses (a cost beyond its bounds, a bad field) */
            | "bad-header"
            /** the file ends before its last chunk: cut short, or the last chunk was removed */
            | "truncated"
            /** bytes after the last chunk */
            | "trailing-data"
            /** a chunk or the header failed authentication: edited, reordered, or the wrong file for this key */
            | "corrupt"
            /** the passphrase or recovery key does not open any wrap in the header */
            | "wrong-secret"
            /** a recovery key that is mistyped (bad characters or checksum) */
            | "bad-recovery-key"
            /** the file is encrypted and nothing was given to open it */
            | "needs-key",
        message: string,
    ) {
        super(message);
        this.name = "BackupError";
    }
}

// --- constants of the format (the spec's numbers; a reader takes the per-file ones from the header) ---

const MAGIC = [0x57, 0x4d, 0x4c, 0x42, 0x41, 0x4b, 0x00, 0x01]; // "WMLBAK", 0x00, version 1
const PREFIX_BYTES = 12; // magic (8) + header length (u32 LE)
const TAG_BYTES = 16;
const MAX_HEADER_BYTES = 1 << 20;
const MAX_CHUNK = 64 << 20;
/** The default plaintext chunk: 1 MiB, small enough to decrypt a file in a stream, large enough that the 20 bytes of framing vanish. */
export const DEFAULT_CHUNK = 1 << 20;
const SQLITE_MAGIC = "SQLite format 3\0";
const text = new TextEncoder();
const unText = new TextDecoder("utf-8", { fatal: true });

/** The Argon2id cost stored in a passphrase wrap; `m` is in KiB. A reader uses the header's numbers, never these. */
export interface ArgonParams {
    alg: "argon2id";
    m: number;
    t: number;
    p: number;
}
/** The cost a new passphrase wrap gets: 64 MiB, three passes, one lane (about a second on a laptop). */
export const DEFAULT_ARGON: Readonly<ArgonParams> = { alg: "argon2id", m: 65536, t: 3, p: 1 };
/** What a reader will agree to run on a header's say-so: a hostile file must not be able to ask for 1 TiB. */
const ARGON_LIMITS = { m: 1 << 20, t: 64, p: 16 };

/** One copy of the data key, sealed under one secret; the header carries one per way in. */
export interface WrapRecord {
    by: "passphrase" | "recovery";
    kdf: ArgonParams | { alg: "hkdf-sha256" };
    /** base64, 16 bytes */
    salt: string;
    /** base64, 12 bytes */
    iv: string;
    /** base64, the 32-byte data key plus the 16-byte tag */
    ct: string;
}

/** The data key as the browser holds it: usable, never readable, with the wrapped copies a header needs. */
export interface Keyring {
    /** HKDF key, non-extractable: `exportKey` throws, so nothing in the profile can read the data key back out */
    key: CryptoKey;
    /** names this data key (hex of 8 bytes of HKDF output), so a reader can say "wrong key" before it tries to decrypt */
    keyId: string;
    wraps: WrapRecord[];
}

/** What opens a wrap. */
export type Secret = { passphrase: string } | { recoveryKey: string };

/** What the three forms of a file are called, told apart by their first bytes. */
export type FileForm = "sqlite" | "gzip" | "wmlbak" | "unknown";

/** Options for making a keyring or a wrap; tests lower the Argon2 cost, nothing else should. */
export interface KeyringOptions {
    argon?: Partial<Omit<ArgonParams, "alg">>;
}

// --- bytes ---

const bytes = (b: Uint8Array): Bytes => (b.buffer instanceof ArrayBuffer && b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? (b as Bytes) : new Uint8Array(b));
const random = (n: number): Bytes => crypto.getRandomValues(new Uint8Array(n));

function concat(...parts: Uint8Array[]): Bytes {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}

function b64(b: Uint8Array): string {
    let s = "";
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s);
}

function unb64(s: unknown, len?: number): Bytes {
    if (typeof s !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new BackupError("bad-header", "the header holds a field that is not base64");
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    if (len !== undefined && out.length !== len) throw new BackupError("bad-header", `the header holds a field of ${out.length} bytes where ${len} are required`);
    return out;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (b: Uint8Array): Promise<Bytes> => new Uint8Array(await crypto.subtle.digest("SHA-256", b as Bytes));

// --- the three forms ---

/** Which of the three forms these bytes are, by their first bytes and never by a file name. */
export function sniff(b: Uint8Array): FileForm {
    const starts = (sig: ArrayLike<number>) => b.length >= sig.length && Array.from({ length: sig.length }, (_, i) => i).every((i) => b[i] === sig[i]);
    if (starts(Array.from(SQLITE_MAGIC, (c) => c.charCodeAt(0)))) return "sqlite";
    if (starts([0x1f, 0x8b])) return "gzip";
    if (starts(MAGIC.slice(0, 7))) return "wmlbak";
    return "unknown";
}

async function pump(input: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Bytes> {
    return new Uint8Array(await new Response(new Blob([input as Bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

/** Compress bytes as gzip, the inside of every encrypted file and the whole of a `.sqlite.gz`. */
export function gzip(b: Uint8Array): Promise<Bytes> {
    return pump(b, new CompressionStream("gzip"));
}

/** Decompress gzip bytes; throws on a stream that is not gzip or is cut short. */
export function gunzip(b: Uint8Array): Promise<Bytes> {
    return pump(b, new DecompressionStream("gzip"));
}

// --- the recovery key ---

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 16 bytes as 26 Crockford base32 characters (130 bits; the last two are zero padding). */
function toBase32(b: Uint8Array): string {
    let out = "";
    let acc = 0;
    let bits = 0;
    for (const x of b) {
        acc = (acc << 8) | x;
        bits += 8;
        while (bits >= 5) {
            out += ALPHABET[(acc >> (bits - 5)) & 31];
            bits -= 5;
        }
        acc &= (1 << bits) - 1;
    }
    if (bits) out += ALPHABET[(acc << (5 - bits)) & 31];
    return out;
}

/** The two check characters: the first 10 bits of SHA-256 over the 16 key bytes. */
async function checkChars(key: Uint8Array): Promise<string> {
    const h = await sha256(key);
    const v = (h[0] << 2) | (h[1] >> 6);
    return ALPHABET[v >> 5] + ALPHABET[v & 31];
}

/** A fresh recovery key: 128 random bits as 28 characters in 7 groups of 4, joined by dashes, with its raw bytes. */
export async function newRecoveryKey(): Promise<string> {
    return formatRecoveryKey(random(16));
}

async function formatRecoveryKey(key: Uint8Array): Promise<string> {
    return (toBase32(key) + (await checkChars(key))).match(/.{4}/g)!.join("-");
}

/** The 16 key bytes behind what a person typed or pasted; tolerant of case, spaces, dashes and I/L/O, strict about the checksum. */
export async function parseRecoveryKey(input: string): Promise<Bytes> {
    const s = input
        .toUpperCase()
        .replace(/[\s-]/g, "")
        .replace(/[IL]/g, "1")
        .replace(/O/g, "0");
    if (s.length !== 28) throw new BackupError("bad-recovery-key", `a recovery key has 28 characters, this has ${s.length}`);
    const vals = Array.from(s, (c) => ALPHABET.indexOf(c));
    if (vals.includes(-1)) throw new BackupError("bad-recovery-key", `"${s[vals.indexOf(-1)]}" is not a character a recovery key uses`);
    const out = new Uint8Array(16);
    let acc = 0;
    let bits = 0;
    let at = 0;
    for (const v of vals.slice(0, 26)) {
        acc = (acc << 5) | v;
        bits += 5;
        if (bits >= 8) {
            out[at++] = (acc >> (bits - 8)) & 255;
            bits -= 8;
            acc &= (1 << bits) - 1;
        }
    }
    // 26 characters carry 130 bits; the 2 left over must be the zero padding `toBase32` wrote.
    const padOk = at === 16 && acc === 0;
    if (!padOk || (await checkChars(out)) !== s.slice(26)) throw new BackupError("bad-recovery-key", "this recovery key has a typo: its check characters do not match");
    return out;
}

// --- keys ---

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string, bits = 256): Promise<Bytes> {
    const k = await crypto.subtle.importKey("raw", ikm as Bytes, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt as Bytes, info: text.encode(info) }, k, bits));
}

async function hkdfBits(key: CryptoKey, salt: Uint8Array, info: string, bits: number): Promise<Bytes> {
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt as Bytes, info: text.encode(info) }, key, bits));
}

const aes = (raw: Uint8Array, use: KeyUsage[]) => crypto.subtle.importKey("raw", raw as Bytes, "AES-GCM", false, use);

async function argonKek(passphrase: string, salt: Uint8Array, p: { m: number; t: number; p: number }): Promise<Bytes> {
    return new Uint8Array(
        await argon2id({ password: text.encode(passphrase.normalize("NFC")), salt, memorySize: p.m, iterations: p.t, parallelism: p.p, hashLength: 32, outputType: "binary" }),
    );
}

async function kekFor(w: WrapRecord, secret: Secret): Promise<CryptoKey | null> {
    const salt = unb64(w.salt, 16);
    if (w.by === "passphrase" && "passphrase" in secret) {
        const k = w.kdf as ArgonParams;
        const ok = k?.alg === "argon2id" && Number.isInteger(k.m) && Number.isInteger(k.t) && Number.isInteger(k.p) && k.m >= 8 * k.p && k.m <= ARGON_LIMITS.m && k.t >= 1 && k.t <= ARGON_LIMITS.t && k.p >= 1 && k.p <= ARGON_LIMITS.p;
        if (!ok) throw new BackupError("bad-header", "the passphrase wrap names an Argon2id cost this reader refuses");
        return aes(await argonKek(secret.passphrase, salt, k), ["decrypt"]);
    }
    if (w.by === "recovery" && "recoveryKey" in secret) {
        if ((w.kdf as { alg: string })?.alg !== "hkdf-sha256") throw new BackupError("bad-header", "the recovery wrap names a key derivation this reader does not know");
        return aes(await hkdf(await parseRecoveryKey(secret.recoveryKey), salt, "wmlbak v1 wrap recovery"), ["decrypt"]);
    }
    return null;
}

/** The raw data key out of whichever wrap the secret opens; callers import it and drop it at once. */
async function unwrapRaw(wraps: WrapRecord[], secret: Secret): Promise<Bytes> {
    let tried = false;
    for (const w of wraps) {
        const kek = await kekFor(w, secret);
        if (!kek) continue;
        tried = true;
        try {
            const raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(w.iv, 12), additionalData: text.encode("wmlbak v1 wrap " + w.by) }, kek, unb64(w.ct));
            if (raw.byteLength === 32) return new Uint8Array(raw);
        } catch {
            // falls through to the refusal below
        }
    }
    const what = "passphrase" in secret ? "passphrase" : "recovery key";
    throw new BackupError("wrong-secret", tried ? `that ${what} does not open this file` : `this file has no wrap for a ${what}`);
}

async function makeWrap(raw: Uint8Array, by: "passphrase" | "recovery", secret: string | Uint8Array, o: KeyringOptions): Promise<WrapRecord> {
    const salt = random(16);
    const iv = random(12);
    let kdf: WrapRecord["kdf"];
    let kek: Bytes;
    if (by === "passphrase") {
        kdf = { ...DEFAULT_ARGON, ...o.argon, alg: "argon2id" };
        kek = await argonKek(secret as string, salt, kdf);
    } else {
        kdf = { alg: "hkdf-sha256" };
        kek = await hkdf(secret as Uint8Array, salt, "wmlbak v1 wrap recovery");
    }
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: text.encode("wmlbak v1 wrap " + by) }, await aes(kek, ["encrypt"]), raw as Bytes);
    return { by, kdf, salt: b64(salt), iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

async function toKeyring(raw: Bytes, wraps: WrapRecord[]): Promise<Keyring> {
    const key = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveBits", "deriveKey"]);
    raw.fill(0);
    const keyId = hex(await hkdfBits(key, new Uint8Array(0), "wmlbak v1 key id", 64));
    return { key, keyId, wraps };
}

/** Make the install's one data key, wrapped under the passphrase and under a new recovery key (returned once; show it, never store it). */
export async function createKeyring(passphrase: string, o: KeyringOptions = {}): Promise<{ keyring: Keyring; recoveryKey: string }> {
    if (!passphrase) throw new BackupError("wrong-secret", "an empty passphrase protects nothing");
    const raw = random(32);
    const recovery = random(16);
    const wraps = [await makeWrap(raw, "passphrase", passphrase, o), await makeWrap(raw, "recovery", recovery, o)];
    const recoveryKey = await formatRecoveryKey(recovery);
    recovery.fill(0);
    return { keyring: await toKeyring(raw, wraps), recoveryKey };
}

/** Open a keyring from the wraps in a header (or a stored keyring) with the passphrase or the recovery key. */
export async function unlock(wraps: WrapRecord[], secret: Secret): Promise<Keyring> {
    return toKeyring(await unwrapRaw(wraps, secret), wraps);
}

/** Change the passphrase: unwrap with the old secret, wrap under the new passphrase, keep the recovery wrap as it is. */
export async function rewrap(wraps: WrapRecord[], oldSecret: Secret, newPassphrase: string, o: KeyringOptions = {}): Promise<WrapRecord[]> {
    if (!newPassphrase) throw new BackupError("wrong-secret", "an empty passphrase protects nothing");
    const raw = await unwrapRaw(wraps, oldSecret);
    try {
        return [await makeWrap(raw, "passphrase", newPassphrase, o), ...wraps.filter((w) => w.by !== "passphrase")];
    } finally {
        raw.fill(0);
    }
}

// --- the file ---

/** The kind a header records: a month file of the archive folder, or a one-off backup. */
export type FileKind = "archive-month" | "backup";

interface Header {
    v: 1;
    kind: FileKind;
    created: string;
    compression: "gzip";
    chunk: number;
    fileSalt: string;
    keyId: string;
    wraps: WrapRecord[];
}

const u32 = (n: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return b;
};

/** The 12-byte nonce of chunk `i`: the index as 11 big-endian bytes, then 1 for the final chunk and 0 for the rest. */
function nonce(i: number, final: boolean): Bytes {
    const n = new Uint8Array(12);
    const dv = new DataView(n.buffer);
    dv.setUint32(3, Math.floor(i / 2 ** 32));
    dv.setUint32(7, i >>> 0);
    n[11] = final ? 1 : 0;
    return n;
}

const fileKey = async (k: Keyring, salt: Uint8Array) =>
    crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: salt as Bytes, info: text.encode("wmlbak v1 file") }, k.key, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);

/** Seal a plain SQLite file as a `.wmlbak`: gzip, cut into chunks, each chunk AES-GCM with the header as associated data. */
export async function encryptFile(plain: Uint8Array, keyring: Keyring, o: { kind: FileKind; chunk?: number; created?: Date }): Promise<Bytes> {
    const chunk = o.chunk ?? DEFAULT_CHUNK;
    if (!Number.isInteger(chunk) || chunk < 1 || chunk > MAX_CHUNK) throw new RangeError("chunk size out of range");
    const fileSalt = random(32);
    const header: Header = { v: 1, kind: o.kind, created: (o.created ?? new Date()).toISOString(), compression: "gzip", chunk, fileSalt: b64(fileSalt), keyId: keyring.keyId, wraps: keyring.wraps };
    const headerBytes = text.encode(JSON.stringify(header));
    const prefix = concat(new Uint8Array(MAGIC), u32(headerBytes.length), headerBytes);
    const key = await fileKey(keyring, fileSalt);
    const packed = await gzip(plain);
    const count = Math.max(1, Math.ceil(packed.length / chunk));
    const parts: Uint8Array[] = [prefix];
    for (let i = 0; i < count; i++) {
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce(i, i === count - 1), additionalData: prefix }, key, packed.subarray(i * chunk, (i + 1) * chunk)));
        parts.push(u32(ct.length), ct);
    }
    return concat(...parts);
}

function parseHeader(b: Uint8Array): { header: Header; prefixLen: number } {
    if (sniff(b) !== "wmlbak") throw new BackupError("unknown-form", "this is not a window.ml encrypted file");
    if (b[7] !== 1) throw new BackupError("unsupported-version", `format version ${b[7]} is newer than this reader knows`);
    if (b.length < PREFIX_BYTES) throw new BackupError("truncated", "the file ends inside its header");
    const hlen = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(8, true);
    if (hlen > MAX_HEADER_BYTES) throw new BackupError("bad-header", "the header claims an absurd length");
    if (b.length < PREFIX_BYTES + hlen) throw new BackupError("truncated", "the file ends inside its header");
    let h: Header;
    try {
        h = JSON.parse(unText.decode(b.subarray(PREFIX_BYTES, PREFIX_BYTES + hlen)));
    } catch {
        throw new BackupError("bad-header", "the header is not valid JSON");
    }
    if (h?.v !== 1) throw new BackupError("unsupported-version", `header version ${h?.v} is not one this reader knows`);
    if (h.compression !== "gzip") throw new BackupError("bad-header", `compression "${h.compression}" is not one this reader knows`);
    if (!Number.isInteger(h.chunk) || h.chunk < 1 || h.chunk > MAX_CHUNK) throw new BackupError("bad-header", "the header names a chunk size outside what this reader accepts");
    if (typeof h.keyId !== "string" || !Array.isArray(h.wraps)) throw new BackupError("bad-header", "the header lacks its key id or wraps");
    unb64(h.fileSalt, 32);
    return { header: h, prefixLen: PREFIX_BYTES + hlen };
}

/** The wraps and metadata a `.wmlbak` carries, read without any key: for asking the person for the right secret. */
export function readHeader(b: Uint8Array): { kind: FileKind; created: string; keyId: string; wraps: WrapRecord[] } {
    const { header } = parseHeader(b);
    return { kind: header.kind, created: header.created, keyId: header.keyId, wraps: header.wraps };
}

/** Open a `.wmlbak` to plain SQLite bytes, with a keyring or a secret; returns nothing at all unless every chunk authenticates and the last is present. */
export async function decryptFile(b: Uint8Array, keyOrSecret: Keyring | Secret): Promise<Bytes> {
    const { header, prefixLen } = parseHeader(b);
    const keyring = "key" in keyOrSecret ? keyOrSecret : await unlock(header.wraps, keyOrSecret);
    if (keyring.keyId !== header.keyId) throw new BackupError("wrong-secret", "this file was sealed under a different data key than the one given");
    const prefix = b.subarray(0, prefixLen) as Bytes;
    const key = await fileKey(keyring, unb64(header.fileSalt, 32));
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const out: Uint8Array[] = [];
    let at = prefixLen;
    if (at >= b.length) throw new BackupError("truncated", "the file has no chunks");
    for (let i = 0; at < b.length; i++) {
        if (b.length - at < 4) throw new BackupError("truncated", "the file ends inside a chunk header");
        const len = dv.getUint32(at, true);
        if (len < TAG_BYTES || len > header.chunk + TAG_BYTES) throw new BackupError("corrupt", "a chunk has an impossible length");
        if (b.length - at - 4 < len) throw new BackupError("truncated", "the file ends inside a chunk");
        const final = at + 4 + len === b.length;
        try {
            out.push(new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce(i, final), additionalData: prefix }, key, b.subarray(at + 4, at + 4 + len) as Bytes)));
        } catch {
            // Which of "cut short", "trailing bytes" and "edited" this is cannot be told from outside: the tag fails in all three.
            throw new BackupError("corrupt", "a chunk failed authentication: the file is damaged, cut short, extended or edited");
        }
        at += 4 + len;
        if (final) break;
    }
    return gunzip(concat(...out));
}

/** Raw SQLite bytes from any of the three forms; an encrypted one asks `unlockIfNeeded` for a keyring or a secret. */
export async function readAnyForm(b: Uint8Array, unlockIfNeeded?: () => Promise<Keyring | Secret>): Promise<Bytes> {
    switch (sniff(b)) {
        case "sqlite":
            return bytes(b);
        case "gzip":
            return gunzip(b);
        case "wmlbak":
            if (!unlockIfNeeded) throw new BackupError("needs-key", "this file is encrypted; give the passphrase or the recovery key");
            return decryptFile(b, await unlockIfNeeded());
        default:
            throw new BackupError("unknown-form", "this is not a SQLite file, a gzip file or a window.ml backup");
    }
}

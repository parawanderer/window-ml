/**
 * HPKE (RFC 9180) base mode over WebCrypto: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM.
 *
 * This is the one piece of the hub's cryptography WebCrypto does not do for us, so it is assembled here from the
 * primitives it does: X25519 key agreement, HMAC-SHA256 (which is HKDF's extract and expand), and AES-256-GCM.
 * WASM was the alternative and is not possible: a device's private key is a non-extractable `CryptoKey`, and a WASM
 * implementation would need its raw bytes, which is the property the whole design rests on.
 *
 * It is checked against the RFC's own test vector for this suite (`tests/hub-hpke.test.mjs`) before it is checked
 * against anything of ours, so a failure says whether HPKE is wrong or our use of it is.
 */

/**
 * Bytes backed by an `ArrayBuffer`, which is what WebCrypto takes. TypeScript tells these apart from bytes that might
 * be backed by a `SharedArrayBuffer`, and every byte string here is one this code allocated or copied, so saying so
 * once here is cheaper than casting at each of the two dozen calls.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/** Are these the same bytes? The one copy of this, since three files wanted it. */
export const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The same bytes, backed by an `ArrayBuffer`: a copy only when they were not already. */
export function bytes(b: Uint8Array): Bytes {
    return (b.buffer instanceof ArrayBuffer ? b : new Uint8Array(b)) as Bytes;
}

const KEM_ID = 0x0020;
const KDF_ID = 0x0001;
const AEAD_ID = 0x0002;
/** bytes of a shared secret, an HKDF output block, and an AES-256 key */
const N_SECRET = 32;
const N_KEY = 32;
/** bytes of an AES-GCM nonce */
const N_NONCE = 12;
const MODE_BASE = 0x00;

const HPKE_V1 = new TextEncoder().encode("HPKE-v1");

/** `x25519(sk, 9)` is the public key: WebCrypto has no "public key from private", but it has the base point. */
const BASE_POINT = new Uint8Array([9, ...new Array<number>(31).fill(0)]);

/** The DER prefix of a PKCS#8 X25519 private key, so a raw scalar can be imported as a `CryptoKey`. */
const PKCS8_X25519_PREFIX = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
]);

/** Everything sealed to one recipient: the ephemeral public key and the ciphertext. */
export interface Sealed {
    enc: Bytes;
    ciphertext: Bytes;
}

/** An X25519 key pair as this code uses one: the private half never leaves WebCrypto. */
export interface AgreementKey {
    privateKey: CryptoKey;
    publicKey: Bytes;
}

/** Join byte strings, which is most of what building a labelled input is. */
export function concat(...parts: Uint8Array[]): Bytes {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

/** RFC 8017's I2OSP for the two-byte lengths HPKE labels use. */
export function i2osp2(n: number): Bytes {
    return new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
}

function suiteId(kem: boolean): Bytes {
    const text = new TextEncoder();
    return kem
        ? concat(text.encode("KEM"), i2osp2(KEM_ID))
        : concat(text.encode("HPKE"), i2osp2(KEM_ID), i2osp2(KDF_ID), i2osp2(AEAD_ID));
}

/** HKDF-Extract: HMAC with the salt as the key, and a zero key when there is no salt. */
async function extract(salt: Bytes, ikm: Bytes): Promise<Bytes> {
    const keyBytes = salt.length > 0 ? salt : new Uint8Array(32);
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", key, ikm));
}

/**
 * HKDF-Expand, for the one block every output here needs (32 bytes or fewer). Longer outputs would chain blocks;
 * nothing in this protocol asks for one, and a silent truncation would be worse than this throw.
 */
async function expand(prk: Bytes, info: Bytes, length: number): Promise<Bytes> {
    if (length > 32) throw new Error(`HKDF-Expand here handles one block; asked for ${length} bytes`);
    const key = await crypto.subtle.importKey("raw", prk, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const block = new Uint8Array(await crypto.subtle.sign("HMAC", key, concat(info, new Uint8Array([1]))));
    return block.slice(0, length);
}

async function labeledExtract(kem: boolean, salt: Bytes, label: string, ikm: Bytes): Promise<Bytes> {
    const labeled = concat(HPKE_V1, suiteId(kem), new TextEncoder().encode(label), ikm);
    return extract(salt, labeled);
}

async function labeledExpand(
    kem: boolean,
    prk: Bytes,
    label: string,
    info: Bytes,
    length: number,
): Promise<Bytes> {
    const labeled = concat(i2osp2(length), HPKE_V1, suiteId(kem), new TextEncoder().encode(label), info);
    return expand(prk, labeled, length);
}

/** A fresh X25519 key pair, its private half non-extractable: it can agree, and nothing can read it. */
export async function generateAgreementKey(): Promise<AgreementKey> {
    const pair = (await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    return { privateKey: pair.privateKey, publicKey };
}

/**
 * RFC 9180 `DeriveKeyPair` for DHKEM(X25519): the key a 32-byte seed names. This is how the Rust side's
 * `AgreementKey::from_seed` and the test vectors produce theirs, so both sides derive the same key from the same
 * seed rather than shipping private keys around.
 */
export async function agreementKeyFromSeed(seed: Bytes): Promise<AgreementKey> {
    const dkpPrk = await labeledExtract(true, new Uint8Array(), "dkp_prk", seed);
    const scalar = await labeledExpand(true, dkpPrk, "sk", new Uint8Array(), N_KEY);
    return importAgreementKey(scalar);
}

/** An X25519 private key from its raw scalar, with the public key derived from it. */
export async function importAgreementKey(scalar: Bytes): Promise<AgreementKey> {
    const privateKey = await crypto.subtle.importKey(
        "pkcs8",
        concat(PKCS8_X25519_PREFIX, scalar),
        { name: "X25519" },
        false,
        ["deriveBits"],
    );
    const base = await crypto.subtle.importKey("raw", BASE_POINT, { name: "X25519" }, true, []);
    const publicKey = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: base }, privateKey, 256));
    return { privateKey, publicKey };
}

async function keySchedule(sharedSecret: Bytes, info: Bytes): Promise<{ key: CryptoKey; nonce: Bytes }> {
    const empty = new Uint8Array();
    const pskIdHash = await labeledExtract(false, empty, "psk_id_hash", empty);
    const infoHash = await labeledExtract(false, empty, "info_hash", info);
    const context = concat(new Uint8Array([MODE_BASE]), pskIdHash, infoHash);
    const secret = await labeledExtract(false, sharedSecret, "secret", empty);
    const keyBytes = await labeledExpand(false, secret, "key", context, N_KEY);
    const nonce = await labeledExpand(false, secret, "base_nonce", context, N_NONCE);
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    return { key, nonce };
}

/** The KEM half: a fresh shared secret to `recipient`, and the encapsulated key that lets it recover the same one. */
async function encap(recipient: Bytes): Promise<{ sharedSecret: Bytes; enc: Bytes }> {
    const ephemeral = await generateAgreementKey();
    const pkR = await crypto.subtle.importKey("raw", recipient, { name: "X25519" }, true, []);
    const dh = new Uint8Array(
        await crypto.subtle.deriveBits({ name: "X25519", public: pkR }, ephemeral.privateKey, 256),
    );
    const sharedSecret = await kemSecret(dh, ephemeral.publicKey, recipient);
    return { sharedSecret, enc: ephemeral.publicKey };
}

async function decap(enc: Bytes, recipient: AgreementKey): Promise<Bytes> {
    const pkE = await crypto.subtle.importKey("raw", enc, { name: "X25519" }, true, []);
    const dh = new Uint8Array(
        await crypto.subtle.deriveBits({ name: "X25519", public: pkE }, recipient.privateKey, 256),
    );
    return kemSecret(dh, enc, recipient.publicKey);
}

async function kemSecret(dh: Bytes, enc: Bytes, recipient: Bytes): Promise<Bytes> {
    const eaePrk = await labeledExtract(true, new Uint8Array(), "eae_prk", dh);
    return labeledExpand(true, eaePrk, "shared_secret", concat(enc, recipient), N_SECRET);
}

/** Seal `plaintext` to `recipient`'s X25519 public key, binding `info` (and `aad`) to the ciphertext. */
export async function seal(
    recipient: Bytes,
    info: Bytes,
    plaintext: Bytes,
    aad: Bytes = new Uint8Array(),
): Promise<Sealed> {
    const { sharedSecret, enc } = await encap(recipient);
    const { key, nonce } = await keySchedule(sharedSecret, info);
    const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, key, plaintext),
    );
    return { enc, ciphertext };
}

/** Open what was sealed to this key. Throws if it was sealed to another key, under another `info`, or altered. */
export async function open(
    recipient: AgreementKey,
    sealed: Sealed,
    info: Bytes,
    aad: Bytes = new Uint8Array(),
): Promise<Bytes> {
    const sharedSecret = await decap(sealed.enc, recipient);
    const { key, nonce } = await keySchedule(sharedSecret, info);
    return new Uint8Array(
        await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, key, sealed.ciphertext),
    );
}

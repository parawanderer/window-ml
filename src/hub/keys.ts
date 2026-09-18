/**
 * Identities, certificate chains and the signed hello, as the hub verifies them (window-ml-hub `crates/keys`).
 *
 * Every signature is over a domain-separation label followed by the exact bytes, so a signature made for one purpose
 * can never be replayed as another. The labels are the contract and are listed once, here.
 *
 * A certificate body is verified EXACTLY as transmitted and never re-encoded, so a decoder that normalises something
 * cannot make a forged body verify.
 */
import { Certificate, CertificateBody, Role } from "../proto/wmlhub/v1/identity.gen";
import { Bytes, bytes, concat, sameBytes } from "./hpke";

const text = new TextEncoder();

/** `"<label>" || 0x00`, prepended to what it signs. */
export const LABEL = {
    certificate: "wmlhub/cert/v1\0",
    hello: "wmlhub/hello/v1\0",
    command: "wmlhub/command/v1\0",
    grant: "wmlhub/grant/v1\0",
    stream: "wmlhub/stream/v1\0",
    /** Local only, and on no wire: what `identityFromSeed` signs to check a seed and a public key belong together. */
    probe: "wmlhub/probe/v1\0",
} as const;

/** The longest chain accepted: a leaf issued by the root, or by one delegate the root allowed to pair. */
export const MAX_CHAIN = 2;
/** Bounds a hello is checked against before anything in it is compared, because it arrives unauthenticated. */
export const MAX_CERT_BYTES = 1024;
export const MAX_SCOPES = 16;
/** The longest scope name, and the only statement of it: `SCOPE_NAME` is built from it. */
export const MAX_SCOPE_BYTES = 32;
export const MAX_LABEL_BYTES = 64;

/** The scope names runtimes know today. The set is open: a name that is not here still verifies. */
export const SCOPE = {
    view: "view",
    drive: "drive",
    approve: "approve",
    screen: "screen",
    desktop: "desktop",
} as const;

/** The DER prefix of a PKCS#8 Ed25519 private key, so a seed can be imported as a `CryptoKey`. */
const PKCS8_ED25519_PREFIX = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

/** An Ed25519 identity: the key that signs, and the public half everyone checks against. */
export interface Identity {
    privateKey: CryptoKey;
    publicKey: Bytes;
}

/** A chain that verified: who it says the principal is, and what its leaf grants. */
export interface Verified {
    account: Bytes;
    principal: Bytes;
    leafKey: Bytes;
    leaf: CertificateBody;
}

/** Why a chain was refused. Coarse on the wire (the hub answers "hello did not verify"), precise here. */
export class ChainError extends Error {}

/** A principal's id: SHA-256 of its identity public key. */
export async function principalId(identityPublic: Bytes): Promise<Bytes> {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", identityPublic));
}

/** An account's id: SHA-256 of its root public key. */
export async function accountId(rootPublic: Bytes): Promise<Bytes> {
    return principalId(rootPublic);
}

/** A fresh identity whose private key cannot be read, by this code or any other. */
export async function generateIdentity(): Promise<Identity> {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
    return { privateKey: pair.privateKey, publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)) };
}

/**
 * The identity a 32-byte seed names, as the Rust side's `Identity::from_seed` and the vectors produce it.
 *
 * The public key must be passed in, because WebCrypto will not give it: it derives no public key from a private one,
 * and refuses to export an Ed25519 private key in a format that carries both. That is only a limitation for seeds,
 * which is a test and vector path; a device calls `generateIdentity`, which hands back both halves. The pair is
 * checked here by signing a probe, so a seed and a public key that do not belong together fail at once rather than as
 * an unexplained bad signature later.
 */
export async function identityFromSeed(seed: Bytes, publicKey: Bytes): Promise<Identity> {
    const privateKey = await crypto.subtle.importKey(
        "pkcs8",
        concat(PKCS8_ED25519_PREFIX, seed),
        { name: "Ed25519" },
        false,
        ["sign"],
    );
    const identity = { privateKey, publicKey };
    const probe = text.encode("does this key belong to this seed");
    if (!(await verify(publicKey, LABEL.probe, probe, await sign(identity, LABEL.probe, probe))))
        throw new ChainError("that public key does not belong to that seed");
    return identity;
}

/** What a certificate says about the principal it names. */
export interface CertSpec {
    /** the subject's Ed25519 identity public key */
    subject: Bytes;
    /** the subject's X25519 agreement public key, bound to it by this certificate's signature */
    agreementKey: Bytes;
    role: Role;
    scopes: string[];
    /** may this subject issue certificates of its own (never more than it holds)? */
    mayPair?: boolean;
    notBeforeMs?: number;
    /** 0 means no expiry; a child may never outlive its issuer */
    notAfterMs?: number;
    /** what a person calls this device */
    label?: string;
}

/**
 * Issue a certificate: the account root, or a delegate the root allowed to pair, saying who a principal is and what
 * it may do. This is the browser half of pairing; the hub verifies it with public keys only and holds no secret.
 */
export async function issueCertificate(issuer: Identity, spec: CertSpec): Promise<Certificate> {
    const body = CertificateBody.encode({
        subject: spec.subject,
        agreementKey: spec.agreementKey,
        issuer: issuer.publicKey,
        role: spec.role,
        scopes: spec.scopes,
        mayPair: spec.mayPair ?? false,
        notBeforeMs: spec.notBeforeMs ?? 0,
        notAfterMs: spec.notAfterMs ?? 0,
        label: spec.label ?? "",
    }).finish();
    return { body, signature: await sign(issuer, LABEL.certificate, bytes(body)) };
}

/** Sign `bytes` under `label`. */
export async function sign(identity: Identity, label: string, bytes: Bytes): Promise<Bytes> {
    const signed = concat(text.encode(label), bytes);
    return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, identity.privateKey, signed));
}

/** Verify a signature made under `label` by `publicKey`. */
export async function verify(
    publicKey: Bytes,
    label: string,
    bytes: Bytes,
    signature: Bytes,
): Promise<boolean> {
    if (publicKey.length !== 32 || signature.length !== 64) return false;
    let key: CryptoKey;
    try {
        key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
    } catch {
        return false;
    }
    const signed = concat(text.encode(label), bytes);
    return crypto.subtle.verify({ name: "Ed25519" }, key, signature, signed);
}

const SCOPE_NAME = new RegExp(`^[a-z0-9._-]{1,${MAX_SCOPE_BYTES}}$`);

/** Decode a certificate body, refusing anything over its bounds before any of it is compared or verified. */
function decodeBody(body: Bytes): CertificateBody {
    if (body.length > MAX_CERT_BYTES) throw new ChainError(`a certificate body of ${body.length} bytes`);
    const decoded = CertificateBody.decode(body);
    if (decoded.scopes.length > MAX_SCOPES) throw new ChainError(`${decoded.scopes.length} scopes`);
    if (!decoded.scopes.every((s) => SCOPE_NAME.test(s))) throw new ChainError("a scope name outside the alphabet");
    if (text.encode(decoded.label).length > MAX_LABEL_BYTES) throw new ChainError("a label over its limit");
    return decoded;
}



/**
 * Verify `chain` (leaf first) up to `root` at `nowMs`, exactly as the hub does: every signature, the issuer links, the
 * delegation, the validity window, that a child never outlives its issuer, that scopes only narrow, and that the root
 * never appears as a subject.
 */
export async function verifyChain(root: Bytes, chain: Certificate[], nowMs: number): Promise<Verified> {
    if (chain.length === 0 || chain.length > MAX_CHAIN) throw new ChainError(`a chain of ${chain.length}`);
    const bodies = chain.map((c) => decodeBody(bytes(c.body)));

    for (const [i, body] of bodies.entries()) {
        const subject = key32(bytes(body.subject));
        const issuer = key32(bytes(body.issuer));
        key32(bytes(body.agreementKey)); // length-checked here; the sealing path is what uses it
        if (sameBytes(subject, root)) throw new ChainError("the root appears as a subject");
        const parent = bodies[i + 1];
        const expected = parent ? key32(bytes(parent.subject)) : root;
        if (!sameBytes(issuer, expected)) throw new ChainError("an issuer is not the next subject");
        if (!(await verify(issuer, LABEL.certificate, bytes(chain[i].body), bytes(chain[i].signature))))
            throw new ChainError("a certificate signature did not verify");
        if (nowMs < body.notBeforeMs || (body.notAfterMs !== 0 && nowMs > body.notAfterMs))
            throw new ChainError("a certificate is not valid now");
        if (parent) {
            if (!parent.mayPair) throw new ChainError("an intermediate may not pair");
            if (parent.notAfterMs !== 0 && (body.notAfterMs === 0 || body.notAfterMs > parent.notAfterMs))
                throw new ChainError("a certificate outlives its issuer");
            if (!body.scopes.every((s) => parent.scopes.includes(s)))
                throw new ChainError("a certificate grants a scope its issuer does not hold");
        }
    }

    const leaf = bodies[0];
    const leafKey = key32(bytes(leaf.subject));
    return { account: await accountId(root), principal: await principalId(leafKey), leafKey, leaf };
}

function key32(bytes: Bytes): Bytes {
    if (bytes.length !== 32) throw new ChainError(`a key of ${bytes.length} bytes`);
    return bytes;
}

/**
 * The bytes a principal signs to answer the hub's challenge. Binds the hub's name (so another hub's challenge cannot
 * be passed along), the nonce (so it cannot be replayed), and who is logging in as what, into which account.
 */
export function helloTranscript(
    hub: string,
    nonce: Bytes,
    principal: Bytes,
    role: Role,
    account: Bytes,
): Bytes {
    const name = text.encode(hub);
    return concat(len32(name.length), name, len32(nonce.length), nonce, len32(principal.length), principal, i32(role), account);
}

function len32(n: number): Bytes {
    return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

/** A role travels in the transcript as a four-byte big-endian signed integer, as protobuf numbers it. */
const i32 = len32;

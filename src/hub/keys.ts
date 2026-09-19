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

/**
 * The longest a certificate may be valid for. Every certificate carries a real window, so expiry is the one form of
 * revocation that needs no list, no hub and nobody online: a device that stops being renewed stops having access.
 * Revoking is then simply not renewing, and a hub that lost its list and a runtime that never came back still
 * converge on the device losing access.
 */
export const MAX_CERTIFICATE_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Scopes a box connector's certificate may never carry: it relays one machine's telemetry and answers a few commands
 * about it, which involves approving nothing and driving nothing.
 */
export const BOX_CONNECTOR_FORBIDS = ["approve", "control"] as const;

/**
 * Scopes only the account root may grant. Answering a run's gates, driving a machine, and administering the account's
 * devices are things a person decides at the root, not powers a paired device passes on: a phone that may approve a
 * click should not thereby be able to pair another phone.
 *
 * `install` is here because it is MORE persistent than `approve`, which already is. `approve` answers one gate and
 * is over; an install changes every later run on that runtime indefinitely — and REVOCATION CANNOT UNDO IT: revoking
 * a phone rotates keys and stops it commanding, but a package it caused to be installed stays. So a lost phone
 * holding `may_pair` could otherwise mint a device that puts arbitrary code from PyPI into a laptop's sandbox
 * permanently, and outlive both the delegation and its own revocation doing it.
 *
 * This list is NOT in any `.proto`, so it has to change on both sides together: a name here that the hub lacks (or
 * the other way round) means one side refuses a chain the other accepts, and the device simply fails to connect with
 * no failing test on either side. It landed here while no certificate carried `install`, which is the one moment the
 * two sides cannot disagree about anyone.
 */
export const NEVER_DELEGABLE = ["approve", "control", "admin", "install"] as const;
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
    /** grant a runtime a capability that outlives the session: see `NEVER_DELEGABLE` for why only the root may */
    install: "install",
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
    /** required: a certificate with no window is refused by every verifier */
    notBeforeMs: number;
    /** required, within `MAX_CERTIFICATE_MS` of `notBeforeMs`; a child may never outlive its issuer */
    notAfterMs: number;
    /** what a person calls this device */
    label?: string;
    /** May this subject sign a revocation list? Granted by the ROOT only — a delegate issuing it is refused, and so
     *  is a delegate RENEWING it, which is why the holder's certificate is the one row that always needs the root. */
    mayRevoke?: boolean;
    /**
     * The certificate this one RE-ISSUES, when it re-issues rather than grants.
     *
     * Carrying it exempts this certificate from exactly two checks — `NotDelegable` and scope-widening — because
     * re-issuing something the ROOT already granted, unchanged, gives the holder nothing it did not have. That is
     * what lets a runtime renew a phone holding `approve` without a person fetching the root device four times a
     * year, and it is bought strictly: see the rules in `verifyChain`.
     */
    renews?: Certificate;
}

/**
 * Issue a certificate: the account root, or a delegate the root allowed to pair, saying who a principal is and what
 * it may do. This is the browser half of pairing; the hub verifies it with public keys only and holds no secret.
 */
export async function issueCertificate(issuer: Identity, spec: CertSpec): Promise<Certificate> {
    if (spec.notBeforeMs <= 0 || spec.notAfterMs <= spec.notBeforeMs)
        throw new ChainError("a certificate needs a window that begins before it ends");
    if (spec.notAfterMs - spec.notBeforeMs > MAX_CERTIFICATE_MS)
        throw new ChainError(`a certificate may not be valid for longer than ${MAX_CERTIFICATE_MS} ms`);
    // Everything a verifier refuses that can be seen from here, so a caller learns at issuance rather than at
    // somebody else's verifier. What cannot be seen from here — that this issuer may delegate at all, that scopes
    // only narrow — `verifyChain` does.
    if (spec.role === Role.ROLE_BOX_CONNECTOR && (spec.mayPair || spec.scopes.some(isForbiddenForBox)))
        throw new ChainError("a box connector may neither pair nor approve");
    const body = CertificateBody.encode({
        subject: spec.subject,
        agreementKey: spec.agreementKey,
        issuer: issuer.publicKey,
        role: spec.role,
        scopes: spec.scopes,
        mayPair: spec.mayPair ?? false,
        notBeforeMs: spec.notBeforeMs,
        notAfterMs: spec.notAfterMs,
        label: spec.label ?? "",
        mayRevoke: spec.mayRevoke ?? false,
        renews: spec.renews,
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

const isForbiddenForBox = (s: string) => (BOX_CONNECTOR_FORBIDS as readonly string[]).includes(s);

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
        // A real window on every certificate, so expiry is the revocation that works with nobody online.
        if (body.notBeforeMs === 0 || body.notAfterMs === 0)
            throw new ChainError("a certificate without a validity window");
        if (body.notAfterMs <= body.notBeforeMs || body.notAfterMs - body.notBeforeMs > MAX_CERTIFICATE_MS)
            throw new ChainError("a certificate valid for longer than the maximum");
        if (nowMs < body.notBeforeMs || nowMs > body.notAfterMs)
            throw new ChainError("a certificate is not valid now");
        if (body.role === Role.ROLE_BOX_CONNECTOR && (body.mayPair || body.scopes.some(isForbiddenForBox)))
            throw new ChainError("a box connector that may pair or approve");
        if (parent) {
            if (!parent.mayPair) throw new ChainError("an intermediate may not pair");
            if (body.notAfterMs > parent.notAfterMs) throw new ChainError("a certificate outlives its issuer");
            // A RENEWAL re-issues, unchanged, something the ROOT already granted. That gives the holder nothing it
            // did not have, so it is exempt from exactly the two checks that stop a delegate handing out power:
            // `NEVER_DELEGABLE` and scope-widening. Everything else still applies, the window above included.
            const renews = body.renews ? await renewalOf(root, body, i, nowMs) : null;
            if (!renews) {
                // Issued by a delegate rather than by the root: the powers a person decides at the root do not travel.
                if (body.scopes.some((s) => (NEVER_DELEGABLE as readonly string[]).includes(s)))
                    throw new ChainError("a delegate issued a scope only the root may grant");
                if (!body.scopes.every((s) => parent.scopes.includes(s)))
                    throw new ChainError("a certificate grants a scope its issuer does not hold");
            }
        } else if (body.renews) {
            // A ROOT-signed renewal is MORE checked, not less, which is the opposite of what it looks like. The two
            // rules a renewal is exempt from only run when a certificate HAS A PARENT, so a root-issued one was
            // never subject to them and there is nothing to exempt; what the predecessor adds — decoded, verified
            // under the root, compared field for field — is a check that would not otherwise exist.
            //
            // And it is load-bearing: `may_revoke` may not be renewed by a delegate, by design, so the root
            // renewing its own grant is the ONLY way the account's revoker gets a new window. Refusing it would
            // fail on the one certificate whose failure is worst — the row whose lapse costs the account its
            // ability to revoke at all.
            await renewalOf(root, body, i, nowMs);
        }
    }

    const leaf = bodies[0];
    const leafKey = key32(bytes(leaf.subject));
    return { account: await accountId(root), principal: await principalId(leafKey), leafKey, leaf };
}

/**
 * Check a certificate that claims to RENEW another, and say whether it does.
 *
 * Carrying a predecessor buys an exemption from the two checks that make delegation safe, so it is bought strictly.
 * Three things have to be right, and each has its own way of passing by accident — each of those is a real
 * implementation somebody wrote:
 *
 * - **The predecessor's window is NOT checked.** An expired predecessor is the normal case and the whole reason to
 *   renew. A verifier that checks it refuses every renewal that matters and passes the vector only by luck.
 * - **The predecessor verifies under the ACCOUNT ROOT, never under the delegate.** Under a delegate, renewals
 *   CHAIN: renew something narrow, then renew that with more, and the exemption walks itself wider.
 * - **Every other field must be equal, `agreement_key` above all.** That is where sealed commands go, so a renewal
 *   free to change it redirects everything sealed to an approver into a key the renewer holds — without the
 *   renewer ever holding the approver's identity key. The whole body is compared rather than field by field, so a
 *   field added to the schema later is covered until somebody deliberately exempts it.
 *
 * A rename is NOT a renewal: `label` travels unchanged like everything else, so changing one is a fresh issuance by
 * whoever may grant those scopes.
 */
async function renewalOf(root: Bytes, body: CertificateBody, index: number, nowMs: number): Promise<CertificateBody | null> {
    const before = body.renews;
    if (!before) return null;
    if (index !== 0) throw new ChainError("only a leaf may be a renewal");
    const prior = decodeBody(bytes(before.body));
    const issuer = key32(bytes(prior.issuer));
    // Under the ROOT. A predecessor signed by a delegate is how a narrow renewal becomes a wide one.
    if (!sameBytes(issuer, root)) throw new ChainError("a renewal's predecessor was not issued by the account root");
    if (!(await verify(issuer, LABEL.certificate, bytes(before.body), bytes(before.signature))))
        throw new ChainError("a renewal's predecessor did not verify");
    // Its window is deliberately NOT checked. `nowMs` is taken so the signature reads like every other check here
    // and a reader asks why it is unused, which is the question worth asking.
    void nowMs;
    // Equal everywhere except who issued it and how long it lasts. Comparing the encoded bodies with those three
    // fields blanked covers a field added later, which naming the fields one by one would not.
    if (!sameBytes(comparable(body), comparable(prior)))
        throw new ChainError("a renewal changed something other than its issuer and its window");
    return prior;
}

/** A certificate body with the three fields a renewal is allowed to change removed, for comparing the rest. */
function comparable(body: CertificateBody): Bytes {
    return bytes(CertificateBody.encode({
        ...body, issuer: new Uint8Array(), notBeforeMs: 0, notAfterMs: 0, renews: undefined,
    }).finish());
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

/**
 * Revocation lists: what an account has revoked, signed by the one principal allowed to say so (window-ml-hub
 * `docs/design/revocation.md`). The browser twin of `crates/keys/src/revocation.rs`, held to it by the vector in
 * `vectors/seal-v1.json`: signing the vector's body with the vector's key reproduces its list byte for byte.
 *
 * The runtime's own allowlist is the authoritative revocation and needs none of this. A list exists for the
 * PUBLISHERS the runtime cannot reach any other way (a box connector), which verify it themselves, rotate their key and
 * refuse to grant the new one to anything it names. The runtime signs it because it holds `may_revoke`, which only the
 * root grants.
 */
import { Certificate, CertificateBody, RevocationBody, RevocationList } from "../proto/wmlhub/v1/identity.gen";
import { Bytes, bytes, sameBytes } from "./hpke";
import { Identity, accountId, principalId, sign, verify, verifyChain } from "./keys";

const LABEL = "wmlhub/revocation/v1\0";
/** The most entries one list may carry. A list that needs more is a device inventory, not a revocation. */
export const MAX_REVOKED = 256;
/** The largest encoded body accepted, checked before anything in it is decoded. */
export const MAX_REVOCATION_BYTES = 16 << 10;
/** How far ahead of the holder's clock a `version` may be: a fast signer clock costs a minute, not a lockout. */
export const MAX_FUTURE_MS = 60_000;

/** Why a list was refused, the same reasons the Rust verifier gives. */
export class RevocationError extends Error {
    constructor(readonly reason: "malformed" | "wrong-account" | "chain" | "not-revoker" | "signer-revoked" | "signature" | "from-the-future" | "stale", message: string = reason) {
        super(message);
    }
}

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (b: Uint8Array): Promise<Bytes> => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(b)));

/** What a certificate is revoked BY: SHA-256 of its body exactly as transmitted, which is what was signed. */
export function certificateHash(cert: Certificate): Promise<Bytes> {
    return sha256(cert.body);
}

/** A list that verified (or that this principal signed): what it names, by hex. */
export class Revoked {
    constructor(
        readonly version: number,
        /** principal id of whoever signed it, hex */
        readonly signer: string,
        readonly principals: ReadonlySet<string>,
        readonly certificates: ReadonlySet<string>,
    ) {}

    /**
     * Does this list revoke anything in `chain`? Any certificate named revokes the chain (a revoked delegate vouches for
     * nothing), a renewal falls with what it renews, and a certificate that does not decode counts as revoked: the
     * question is whether to hand something over, and "could not tell" is not a yes.
     */
    async revokes(chain: Certificate[]): Promise<boolean> {
        for (const cert of chain) {
            let body: CertificateBody;
            try { body = CertificateBody.decode(cert.body); } catch { return true; }
            if (body.subject.length !== 32) return true;
            if (this.principals.has(hex(await principalId(bytes(body.subject))))) return true;
            if (this.certificates.has(hex(await certificateHash(cert)))) return true;
            if (body.renews && this.certificates.has(hex(await certificateHash(body.renews)))) return true;
        }
        return false;
    }

    /** Does it name anything `older` did not? Only then does a publisher rotate: a re-sign keeps a list fresh. */
    addsTo(older: Revoked | null): boolean {
        if (!older) return this.principals.size + this.certificates.size > 0;
        for (const p of this.principals) if (!older.principals.has(p)) return true;
        for (const c of this.certificates) if (!older.certificates.has(c)) return true;
        return false;
    }
}

/** Sign a list as `signer`, whose chain (leaf first) must carry `may_revoke`. Entries are 32-byte ids. */
export async function signRevocations(
    signer: Identity,
    chain: Certificate[],
    accountRoot: Bytes,
    version: number,
    principals: Bytes[],
    certificates: Bytes[],
): Promise<RevocationList> {
    if (principals.length + certificates.length > MAX_REVOKED) throw new RevocationError("malformed", `a list holds at most ${MAX_REVOKED} entries`);
    const body = bytes(RevocationBody.encode({ account: await accountId(accountRoot), version, principals, certificates }).finish());
    return { body, signature: await sign(signer, LABEL, body), chain };
}

/**
 * Verify a list for the account whose root is `root`, at `nowMs`, against the list already `held`. Cheap checks first
 * and the chain and signature last, in the Rust verifier's order, so a list refused for its shape costs nothing.
 */
export async function verifyRevocations(root: Bytes, list: RevocationList, nowMs: number, held: Revoked | null): Promise<Revoked> {
    if (list.body.length > MAX_REVOCATION_BYTES) throw new RevocationError("malformed");
    let body: RevocationBody;
    try { body = RevocationBody.decode(list.body); } catch { throw new RevocationError("malformed"); }
    if (body.principals.length + body.certificates.length > MAX_REVOKED) throw new RevocationError("malformed");
    if ([...body.principals, ...body.certificates].some((e) => e.length !== 32)) throw new RevocationError("malformed");
    if (!sameBytes(bytes(body.account), await accountId(root))) throw new RevocationError("wrong-account");
    const version = Number(body.version);
    if (version > nowMs + MAX_FUTURE_MS) throw new RevocationError("from-the-future");
    if (held && version <= held.version) throw new RevocationError("stale");
    let verified;
    try { verified = await verifyChain(root, list.chain, nowMs); } catch (e) { throw new RevocationError("chain", (e as Error).message); }
    if (!verified.leaf.mayRevoke) throw new RevocationError("not-revoker");
    if (held && (await held.revokes(list.chain))) throw new RevocationError("signer-revoked");
    if (!(await verify(verified.leafKey, LABEL, bytes(list.body), bytes(list.signature)))) throw new RevocationError("signature");
    return new Revoked(version, hex(verified.principal), new Set(body.principals.map(hex)), new Set(body.certificates.map(hex)));
}

/** The encoded list, as it travels on the revoker's channel (signed, not sealed). */
export const encodeRevocations = (list: RevocationList): Bytes => bytes(RevocationList.encode(list).finish());

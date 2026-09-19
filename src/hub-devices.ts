// hub-devices.ts — the devices this runtime has seen on its account, and what it has revoked: the runtime's
// ALLOWLIST, which is the authoritative revocation (window-ml-hub docs/design/revocation.md). A revoked device stops
// being answered and granted the moment it is revoked here; the signed list this also produces is for the publishers
// the runtime cannot reach any other way (box connectors), which verify it and rotate.
//
// A device is on the list because it was SEEN: presence with a chain that verified to the account root. Pairing happens
// on the root device, so the runtime learns of a device when it first comes online, and `lastSeenMs` is what makes a
// forgotten one visible (a runtime renews what it lists, so nothing leaves by expiring).
//
// chrome-free; persistence is injected (the keyring's records, in the worker).
import type { Certificate } from "./proto/wmlhub/v1/identity.gen";
import { CertificateBody } from "./proto/wmlhub/v1/identity.gen";
import type { DeviceInfo } from "./session-host";
import { principalId, type Identity, type Verified } from "./hub/keys";
import { bytes, type Bytes } from "./hub/hpke";
import { Revoked, certificateHash, signRevocations } from "./hub/revocation";
import { Role } from "./hub/wire";

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h: string): Bytes => new Uint8Array(h.match(/../g)!.map((b) => parseInt(b, 16))) as Bytes;

/** One device as the runtime last saw it. */
interface Seen {
    principal: string;
    label: string;
    role: DeviceInfo["role"];
    scopes: string[];
    mayPair: boolean;
    mayRevoke: boolean;
    notAfterMs: number;
    lastSeenMs: number;
    /** hex principal of the issuer, when a delegate issued it */
    grantedBy?: string;
}

/** What is persisted. */
export interface DeviceState {
    devices: Record<string, Seen>;
    revoked: { principals: string[]; certificates: string[] };
    /** the version of the last list signed, epoch ms: each new one is later, however fast the clock moves */
    version: number;
    /** when a list was last signed, so it is re-signed at least daily (the publishers' freshness floor is 7 days) */
    signedAtMs: number;
}

/** How often a list is re-signed with the same entries, so the publishers' freshness floor never bites. */
export const RESIGN_EVERY_MS = 24 * 60 * 60 * 1000;

const ROLE: Record<number, DeviceInfo["role"]> = { [Role.ROLE_CLIENT]: "client", [Role.ROLE_RUNTIME]: "runtime", [Role.ROLE_BOX_CONNECTOR]: "box-connector" };

/** The runtime's allowlist and revocations, persisted through `load` / `save`. */
export class DeviceRegistry {
    private state: DeviceState = { devices: {}, revoked: { principals: [], certificates: [] }, version: 0, signedAtMs: 0 };
    private writing: Promise<void> = Promise.resolve();

    private constructor(private readonly save: (s: DeviceState) => Promise<void>) {}

    static async open(load: () => Promise<DeviceState | null>, save: (s: DeviceState) => Promise<void>): Promise<DeviceRegistry> {
        const r = new DeviceRegistry(save);
        const had = await load().catch(() => null);
        if (had) r.state = had;
        return r;
    }

    private persist(): Promise<void> {
        const snapshot = structuredClone(this.state);
        this.writing = this.writing.then(() => this.save(snapshot)).catch(() => { /* kept in memory; written next time */ });
        return this.writing;
    }

    /** The revocations as a `Revoked`, which is what knows how to test a chain (ANY certificate named, renewals, undecodable). */
    private held(): Revoked {
        return new Revoked(this.state.version, "", new Set(this.state.revoked.principals), new Set(this.state.revoked.certificates));
    }

    /** Is anything in this chain revoked here? */
    revokes(chain: Certificate[]): Promise<boolean> {
        return this.held().revokes(chain);
    }

    /** Is this principal revoked outright? */
    isRevoked(principal: string): boolean {
        return this.state.revoked.principals.includes(principal.toLowerCase());
    }

    /** A device came online with a chain that verified. Recorded (or refreshed) unless it is revoked. */
    async seen(chain: Certificate[], verified: Verified, nowMs: number): Promise<void> {
        const principal = hex(verified.principal);
        if (this.isRevoked(principal) || (await this.revokes(chain))) return;
        const leaf = verified.leaf;
        const issuer = chain.length > 1 ? CertificateBody.decode(chain[1].body).subject : null;
        this.state.devices[principal] = {
            principal, label: leaf.label, role: ROLE[leaf.role] ?? "client", scopes: [...leaf.scopes],
            mayPair: leaf.mayPair, mayRevoke: leaf.mayRevoke, notAfterMs: Number(leaf.notAfterMs), lastSeenMs: nowMs,
            ...(issuer ? { grantedBy: hex(await principalId(bytes(issuer))) } : {}),
        };
        await this.persist();
    }

    /** The devices this runtime lists: seen and not revoked, most recently seen first. */
    list(): DeviceInfo[] {
        return Object.values(this.state.devices)
            .filter((d) => !this.isRevoked(d.principal))
            .sort((a, b) => b.lastSeenMs - a.lastSeenMs)
            .map((d) => ({
                principal: d.principal, label: d.label, role: d.role,
                kind: d.role === "runtime" ? "browser" : d.role === "box-connector" ? "headless" : "phone",
                scopes: d.scopes as DeviceInfo["scopes"], notAfterMs: d.notAfterMs, lastSeenMs: d.lastSeenMs,
                ...(d.mayPair ? { mayPair: true } : {}), ...(d.mayRevoke ? { mayRevoke: true } : {}),
                ...(d.grantedBy ? { grantedBy: d.grantedBy } : {}),
            }));
    }

    /**
     * Revoke a device entirely, by principal: from this moment it is neither answered nor granted, and neither is
     * anything whose chain passes through it. Returns false when it was revoked already. The caller signs and
     * publishes a new list, and rotates.
     */
    async revoke(principal: string): Promise<boolean> {
        const p = principal.toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(p)) throw new Error("a principal is 64 hex characters");
        if (this.state.revoked.principals.includes(p)) return false;
        this.state.revoked.principals.push(p);
        await this.persist();
        return true;
    }

    /** Revoke one certificate (not the device): a fresh certificate for the same device is untouched. */
    async revokeCertificate(cert: Certificate): Promise<void> {
        const h = hex(await certificateHash(cert));
        if (!this.state.revoked.certificates.includes(h)) this.state.revoked.certificates.push(h);
        await this.persist();
    }

    /** Is a list due: never signed, or last signed more than `RESIGN_EVERY_MS` ago? */
    due(nowMs: number): boolean {
        return !this.state.signedAtMs || nowMs - this.state.signedAtMs >= RESIGN_EVERY_MS;
    }

    /**
     * Sign the whole current list as `signer`, at a version later than any before it. Published whenever it changes,
     * whenever this runtime reconnects, and at least daily, so a publisher's freshness floor never bites while this
     * runtime is up.
     */
    async sign(signer: Identity, chain: Certificate[], accountRoot: Bytes, nowMs: number) {
        const version = Math.max(nowMs, this.state.version + 1);
        const list = await signRevocations(signer, chain, accountRoot, version, this.state.revoked.principals.map(unhex), this.state.revoked.certificates.map(unhex));
        this.state.version = version;
        this.state.signedAtMs = nowMs;
        await this.persist();
        return list;
    }
}

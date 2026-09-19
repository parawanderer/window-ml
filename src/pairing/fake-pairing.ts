// fake-pairing.ts — A SCRIPTABLE STAND-IN for the hub library's pairing calls, for the chat page's web build and the
// specs, until the real adapter over `pair-flow.ts` is wired. It keeps the real flow's shape and its refusals (an
// unknown code, a scope a delegate may not pass on, a hub that is not a URL), and hands the test the moments a person
// cannot fake from one screen: the other device answering a join, or the hub giving up on it.

import type { DeviceInfo } from "../session-host";
import type { FoundOffer, Grant, HubLogLine, Membership, OfferHandle, PairingApi, PairRole, RevokeOutcome } from "./api";

/** The error shape the library's `PairingError` has: a reason the screens turn into words. */
class FakePairingError extends Error {
    constructor(readonly reason: string, message: string) { super(message); }
}

/** What a spec (or a person at the console) drives: the other half of the flow, and what was confirmed. */
export interface FakePairingControls {
    /** replace this device's membership; the Devices tab reads it when it next mounts */
    setMembership(m: Membership | null): void;
    /** leave an offer under a code, as a new device would */
    addOffer(code: string, offer: Omit<FoundOffer, "grant" | "grantable"> & Partial<Pick<FoundOffer, "grant" | "grantable">>): void;
    /** the join waiting on this device, if any: its code and fingerprint */
    readonly waiting: { code: string; fingerprint: string } | null;
    /** a device that may pair answered the waiting join */
    answer(asLabel?: string): void;
    /** the waiting join failed, with one of the library's reasons */
    fail(reason: string): void;
    /** every confirmation made from this device, in order */
    readonly confirmed: { label: string; grant: Grant }[];
}

const norm = (typed: string) => typed.toUpperCase().replace(/[\s-]/g, "");

/** The grant a role gets by default, cut to what `grantable` allows, as `defaultGrant` does. */
function defaultGrant(role: PairRole, grantable: string[] | null, root: boolean): Grant {
    const want = role === "client" ? ["view", "drive"] : [];
    return {
        scopes: grantable ? want.filter((s) => grantable.includes(s)) : want,
        mayPair: role === "runtime",
        mayRevoke: role === "runtime" && root,
        validityMs: 90 * 86_400_000,
    };
}

/** A fake pairing API. `membership` is where this device starts; `grantable` is what it may pass on (null: root). */
export function fakePairing(o: {
    joinsAs?: PairRole; defaultLabel?: string; defaultHubUrl?: string;
    membership?: Membership | null; grantable?: string[] | null; latencyMs?: number;
    /** the account's devices, as a runtime's allowlist or the root's `device.list` would give them */
    devices?: DeviceInfo[];
} = {}): PairingApi & FakePairingControls {
    let devices = [...(o.devices ?? [])];
    const history: HubLogLine[] = [{ atMs: Date.now() - 60_000, event: "connecting" }, { atMs: Date.now() - 59_000, event: `online (${devices.length} devices)` }];
    let membership = o.membership ?? null;
    const grantable = o.grantable === undefined ? null : o.grantable;
    const offers = new Map<string, Omit<FoundOffer, "grant" | "grantable"> & Partial<Pick<FoundOffer, "grant" | "grantable">>>();
    const confirmed: { label: string; grant: Grant }[] = [];
    let join: { code: string; fingerprint: string; label: string; hubUrl: string; resolve: (m: Membership) => void; reject: (e: Error) => void } | null = null;
    const wait = () => new Promise((r) => setTimeout(r, o.latencyMs ?? 120));
    const joinsAs = o.joinsAs ?? "client";
    return {
        joinsAs,
        defaultLabel: o.defaultLabel ?? "This phone",
        defaultHubUrl: o.defaultHubUrl ?? "wss://hub.example",
        async load() { await wait(); return membership; },
        async createAccount({ hubUrl, label }) {
            await wait();
            if (!/^wss?:\/\//.test(hubUrl)) throw new FakePairingError("hub", `not a hub address: ${hubUrl}`);
            membership = { label, role: joinsAs, hubUrl, fingerprint: "c0ffee12ab34", root: true, mayPair: true };
            return membership;
        },
        async beginOffer({ hubUrl, label }): Promise<OfferHandle> {
            await wait();
            if (!/^wss?:\/\//.test(hubUrl)) throw new FakePairingError("hub", `not a hub address: ${hubUrl}`);
            const code = "7K3MQ9XD", fingerprint = "3f9a0c21b7e4";
            let resolve!: (m: Membership) => void, reject!: (e: Error) => void;
            const done = new Promise<Membership>((res, rej) => { resolve = res; reject = rej; });
            join = { code, fingerprint, label, hubUrl, resolve, reject };
            return {
                code, fingerprint, qr: `WMLPAIR:1:${code}:${fingerprint.toUpperCase()}${"0".repeat(52)}`, expiresAt: Date.now() + 10 * 60_000, done,
                cancel() { if (join?.code === code) { join = null; reject(new FakePairingError("cancelled", "cancelled")); } },
            };
        },
        async lookupOffer(typed) {
            await wait();
            const f = offers.get(norm(typed));
            if (!f) throw new FakePairingError("no-offer", "no offer under that code");
            return { ...f, grant: f.grant ?? defaultGrant(f.role, grantable, !!membership?.root), grantable: f.grantable ?? grantable };
        },
        async confirmOffer(found, grant) {
            await wait();
            const over = grantable ? grant.scopes.filter((s) => !grantable.includes(s)) : [];
            if (over.length) throw new Error(`This device cannot pass on ${over.join(", ")}: it does not hold ${over.length === 1 ? "it" : "them"}.`);
            confirmed.push({ label: found.label, grant });
            for (const [code, f] of offers) if (f.label === found.label) offers.delete(code);
        },
        ...(o.devices ? {
            async devices() { await wait(); return devices; },
            async history() { await wait(); return history; },
            async revoke(principal: string): Promise<RevokeOutcome> {
                await wait();
                if (!membership) return "unpaired";
                if (principal === membership.principal) return "self";
                if (!devices.some((d) => d.principal === principal)) return "already";
                devices = devices.filter((d) => d.principal !== principal);
                history.push({ atMs: Date.now(), event: `revoked ${principal.slice(0, 8)}` });
                return "revoked";
            },
        } : {}),
        setMembership(m) { membership = m; },
        addOffer(code, offer) { offers.set(norm(code), offer); },
        get waiting() { return join ? { code: join.code, fingerprint: join.fingerprint } : null; },
        answer(asLabel) {
            if (!join) return;
            const j = join;
            join = null;
            membership = { label: asLabel ?? j.label, role: joinsAs, hubUrl: j.hubUrl, fingerprint: j.fingerprint, root: false, mayPair: joinsAs === "runtime" };
            j.resolve(membership);
        },
        fail(reason) { const j = join; join = null; j?.reject(new FakePairingError(reason, reason)); },
        get confirmed() { return confirmed; },
    };
}

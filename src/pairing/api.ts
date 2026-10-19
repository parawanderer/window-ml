// pairing/api.ts — WHAT THE PAIRING SCREENS ASK OF THE DEVICE they are drawn on: the hub client library's pairing calls
// (`src/hub/pair-flow.ts` over `Keyring`), seen as the screens need them. The screens take this as a prop, so any
// surface that can supply one renders them (docs/spec/CHAT_PAGE.md § Pairing and grants), and a fake stands in for
// development and the specs. The cryptography is the hub library's; the words and the order of the steps are here.
//
// The flow (window-ml-hub docs/design/pairing.md, option C): the NEW principal shows a code and the fingerprint of its
// own keys; the person types the code on a device that may pair, which shows the fingerprint IT computes; they compare
// the two and confirm there, choosing what the new one may do.

import type { DeviceInfo } from "../session/session-host";

/** What a principal is on the account. Open on the wire: an unknown role is shown as a generic device. */
export type PairRole = "runtime" | "client" | "box-connector";

/** This device's place in an account, once it has one. */
export interface Membership {
    /** what this device is called on the account (its own word, chosen when it joined) */
    label: string;
    role: PairRole;
    hubUrl: string;
    /** the fingerprint of this device's own keys, the one it showed when it joined */
    fingerprint: string;
    /** holds the account root: it created the account */
    root: boolean;
    /** may pair other devices (the root always may) */
    mayPair: boolean;
    /** this device's own principal (hex), so a list of devices can say which row is this one */
    principal?: string;
    /** when this device's own certificate stops being valid, for the inbox's renewal item (`certItems`) */
    notAfterMs?: number;
    /** it signs the account's revocations, which only the ROOT device may renew */
    mayRevoke?: boolean;
    /** its certificate was issued by the root, so a runtime holding `may_pair` can re-sign it. False for one paired BY
     *  another device: it has no root-signed predecessor and never will, so it can only be paired again. */
    renewable?: boolean;
}

/** What a new principal is given, chosen on the device that pairs it. `scopes` are names, open-ended. */
export interface Grant {
    scopes: string[];
    mayPair: boolean;
    mayRevoke: boolean;
    validityMs: number;
}

/** An offer in progress on the new principal: show `code` and `fingerprint`, and wait on `done`. */
export interface OfferHandle {
    /** as the library gives it, e.g. "ABCD1234"; shown grouped (`groupCode`) */
    code: string;
    /** 12 hex characters */
    fingerprint: string;
    /** the text to draw as a QR code (`WMLPAIR:1:<code>:<64 hex>`), where the library gives one: scanning it checks the
     *  WHOLE fingerprint, where typing checks the 12 characters a person compares */
    qr?: string;
    /** epoch ms when the hub stops holding the offer */
    expiresAt: number;
    /** resolves once a device that may pair has answered it; rejects with a `PairingError`-shaped error */
    done: Promise<Membership>;
    cancel(): void;
}

/** An offer found by its code, on the device that may pair. `label` is the offering device's own word: untrusted. */
export interface FoundOffer {
    label: string;
    role: PairRole;
    /** what THIS device computed from the offered keys: the thing the person compares */
    fingerprint: string;
    /** the default grant for this role from this device, already cut to what it may pass on */
    grant: Grant;
    /** the scopes this device may grant at all (a delegate passes on only what it holds); null: any */
    grantable: string[] | null;
    /** the library's own found offer, handed back to `confirmOffer` untouched; opaque to the screens */
    ref?: unknown;
    /** found by a SCANNED QR code whose full fingerprint already matched the offer's keys: nothing to compare by eye */
    checked?: boolean;
    /** the device already signing this account's revocations, by label: why that grant is not offered here. Absent
     *  means none is known, in which case a runtime paired here becomes the signer and the screen says so. */
    signer?: string;
}

/** One line of this device's connection history, as the worker kept it ("online (2 devices)", "offline: <reason>"). */
export interface HubLogLine { atMs: number; event: string }

/** What removing a device came to: done, done before, refused (it is this device), or there is no account. */
export type RevokeOutcome = "revoked" | "already" | "self" | "unpaired";

/** Where this device's own connection to the hub stands, for a surface that keeps one (the extension, as a runtime). */
export type HubConnectionView =
    | { state: "unpaired" }
    | { state: "connecting"; hubName?: string }
    | { state: "online"; hubName?: string; devices: number }
    | { state: "offline"; hubName?: string; reason: string; retryInMs: number }
    | { state: "stopped"; hubName?: string };

/** The pairing calls a surface supplies. Every call may reject; `.reason` (see `pairingProblem`) says why. */
export interface PairingApi {
    /**
     * May this device CREATE an account (and so hold its root)? False for a runtime: the root lives on the device people
     * pair others from, and no runtime holds it (window-ml-hub end-to-end-crypto decision 4). Absent means yes.
     */
    readonly canCreate?: boolean;
    /**
     * Where an account's root key would be kept on this device, in words ("this app's storage", "this site's data"):
     * losing it loses the root for good, which the Create screen says before anyone relies on it.
     */
    readonly rootKeptIn?: string;
    /** this device's connection to the hub, where it keeps one; absent where the surface does not */
    connection?(): Promise<HubConnectionView>;
    /** leave the account: forget the membership (never a root) and stop connecting. Absent where it cannot */
    leave?(): Promise<void>;
    /** the connection's history, oldest first, where this device keeps one */
    history?(): Promise<HubLogLine[]>;
    /** the devices on the account this device can see and answer for (a runtime: its allowlist) */
    devices?(): Promise<DeviceInfo[]>;
    /** remove a device from the account, by its principal (hex) */
    revoke?(principal: string): Promise<RevokeOutcome>;
    /**
     * Install a renewed certificate chain for THIS device, as `device.renew` answered with (base64, leaf first).
     * Checked here before it is kept, however the runtime behaved: it must verify to the account root this device
     * already holds, and its leaf must be this device's own key. A runtime that answered with somebody else's chain,
     * or one under another account, would otherwise take this device off its account with a single reply.
     *
     * Absent where a surface keeps no keyring of its own.
     */
    install?(chain: readonly string[]): Promise<Membership>;
    /** the role this device takes when it joins: a browser runtime, or a client (a phone, a web page) */
    readonly joinsAs: PairRole;
    /** what to call this device if the person does not say ("This browser", "Pixel 8") */
    readonly defaultLabel: string;
    /** the hub a new account or a join goes to unless the person says otherwise */
    readonly defaultHubUrl: string;
    /** this device's membership, or null when it is in no account yet */
    load(): Promise<Membership | null>;
    /** make a new account with this device as its root */
    createAccount(o: { hubUrl: string; label: string; invite?: string }): Promise<Membership>;
    /** offer this device to an account: resolves once the hub holds the offer */
    beginOffer(o: { hubUrl: string; label: string }): Promise<OfferHandle>;
    /** find an offer by the code a person typed (any case, spaces and hyphens fine) */
    lookupOffer(typed: string): Promise<FoundOffer>;
    /**
     * find an offer by a scanned QR code's text, checking its keys against the full fingerprint the code carried. Rejects
     * `bad-offer` (not a pairing code), `no-offer`, or `mismatch` (the keys are not the ones the code named). Absent where
     * this device cannot scan.
     */
    lookupScanned?(text: string): Promise<FoundOffer>;
    /** pair it. ONLY after the person said the fingerprints match. Rejects with a sentence when a delegate may not grant it */
    confirmOffer(found: FoundOffer, grant: Grant): Promise<void>;
}

/** A code or fingerprint in groups of four, as `wmlbox pair` prints them, so every screen reads the same. */
export function groupFour(s: string): string {
    return (s.replace(/[\s-]/g, "").match(/.{1,4}/g) ?? []).join(" ");
}

/** Each scope a grant can carry, in words, and whether it is given by default. Unknown names are shown as they are. */
export const SCOPES: { id: string; label: string; detail: string }[] = [
    { id: "view", label: "See sessions", detail: "Read its sessions and follow them as they run." },
    { id: "drive", label: "Start and steer", detail: "Start chats and agent runs, send messages, stop them." },
    { id: "approve", label: "Answer approvals", detail: "Allow what a run asks to do: clicks, fetches, code." },
    { id: "screen", label: "See its screen", detail: "Screenshots of its tabs, as they are now." },
    { id: "desktop", label: "Use its desktop", detail: "Input on the machine itself, beyond the browser." },
    { id: "install", label: "Install packages", detail: "Add Python packages a later run can use." },
];

/**
 * A NAMED STARTING POINT for what a new device may do, so the choice a person actually makes is "how much do I trust
 * this thing" rather than six independent switches. The switches stay, under `custom`: this is what sits above them.
 *
 * It names SCOPES and nothing else, deliberately. Pairing rights are a separate question (a device that may pair is a
 * device that can grow the account without asking here), and signing revocations is not a choice at all: exactly one
 * principal may hold it, the list's `version` is monotonic per account, so two signers race and the loser's revocation
 * is refused as stale (window-ml-hub docs/design/revocation.md). A checkbox that could be ticked twice would
 * manufacture the worst way a revocation can fail, so placing it is its own act and never a profile.
 */
export interface GrantProfile {
    id: string;
    label: string;
    detail: string;
    /** the scopes it grants; `null` for `custom`, which grants whatever the editor is showing */
    scopes: string[] | null;
}

/** The profiles, widest-trust last so the list reads as an increasing amount of trust rather than a menu. */
export const GRANT_PROFILES: readonly GrantProfile[] = [
    { id: "watch", label: "Watch only", detail: "Read its sessions and follow them as they run. It cannot start or steer anything.", scopes: ["view"] },
    { id: "use", label: "Use it", detail: "Read its sessions, and start, steer and stop them. What most devices need.", scopes: ["view", "drive"] },
    { id: "custom", label: "Custom", detail: "Choose each one.", scopes: null },
];

/** The default a screen starts on, which is the same choice `defaultGrant` makes for a client. */
export const DEFAULT_PROFILE = "use";

/**
 * Which profile a set of scopes IS, so a screen can open on the one that matches instead of always on `custom`, and so
 * a grant that came from somewhere else (a delegate's narrowed default, a device paired by an older build) is still
 * named rather than shown as a bare list. Order-independent, since a grant's scopes are a set.
 */
export function profileOf(scopes: readonly string[]): string {
    const have = [...new Set(scopes)].sort().join(",");
    return GRANT_PROFILES.find((p) => p.scopes && [...p.scopes].sort().join(",") === have)?.id ?? "custom";
}

/**
 * The profiles this device can actually offer. A delegate may pass on only what it holds, so a profile it cannot
 * grant in full is dropped rather than shown and then refused by the hub, which would arrive as an error about a
 * certificate long after the tick. `custom` always survives: whatever is left, the editor can still express.
 */
export function profilesFor(grantable?: readonly string[] | null): GrantProfile[] {
    if (!grantable) return [...GRANT_PROFILES];
    return GRANT_PROFILES.filter((p) => !p.scopes || p.scopes.every((s) => grantable.includes(s)));
}

/**
 * WHAT REMOVING A DEVICE COSTS, as the one sentence every surface says. It is the last thing a person reads before an
 * act that cannot be undone from here, so the two screens saying it differently is the two screens disagreeing about
 * what is about to happen.
 *
 * The holder of `may_revoke` is its own answer, and not for tidiness: it is the device that SIGNS removals, so taking
 * it out leaves the account unable to remove anything until the root grants that power elsewhere (window-ml-hub
 * docs/design/revocation.md, where exactly one principal holds it at a time). Removing the ordinary device is
 * recoverable by pairing it again; removing this one needs the root key out of its drawer.
 */
export function removalWarning(d: { label?: string; mayRevoke?: boolean }): string {
    if (d.mayRevoke) {
        return "This device signs the account's revocations. Removing it leaves the account unable to remove ANY device "
            + "until the root device grants that power to another. Remove it only if it is lost.";
    }
    return `“${d.label || "That device"}” stops reaching everything on this account at once. Adding it back takes a new code, confirmed on the root device.`;
}

/**
 * The grant the PHONE starts a found offer from. A runtime offer is narrowed: `mayPair` is OFF whatever the library's
 * default says, because a runtime that may pair can add devices to the account on its own, and the wire has one role
 * for a browser and for a desktop host (docs/spec/RUNTIME_HUB.md, the lane 8 ruling). A person pairing a browser
 * runtime turns it on, knowingly. Every other role keeps the library's default.
 */
export function phoneGrant(found: { role: string; grant: Grant }): Grant {
    return found.role === "runtime" ? { ...found.grant, mayPair: false } : { ...found.grant };
}

/**
 * What a RUNTIME receives, as the lines the card shows, derived from the grant that will be sent and never typed
 * beside it. `mayRevoke` is told, not offered: exactly one device signs removals and placing it is not a switch.
 */
export function receivesLines(found: Pick<FoundOffer, "signer">, grant: Pick<Grant, "scopes" | "mayPair" | "mayRevoke">): string[] {
    const lines: string[] = [];
    lines.push(grant.scopes.length ? `It can pass on: ${grant.scopes.map((s) => SCOPES.find((x) => x.id === s)?.label ?? s).join(", ")}.` : "It receives no scopes to pass on.");
    lines.push(grant.mayPair
        ? "It can add devices to this account by itself, without asking here."
        : "It cannot add devices. A browser runtime without this cannot re-sign other devices' certificates when they renew.");
    // `mayRevoke` with a known signer is never offered (the hub refuses a second holder), so only the first-runtime case is told.
    if (grant.mayRevoke) lines.push("It will be the device that signs removals for this account. Exactly one does, and without it a removal reaches nothing.");
    else if (found.signer) lines.push(`“${found.signer}” (the name that device gave itself, unchecked) signs removals for this account, and only one device can, so this one will not.`);
    return lines;
}

/** What a role is called on screen. */
export function roleName(role: PairRole | string): string {
    return role === "runtime" ? "a browser runtime" : role === "client" ? "a device" : role === "box-connector" ? "a box" : "a device";
}

/**
 * Why a pairing did not complete, as a sentence with what to do next. Reads `.reason` off the library's
 * `PairingError`; anything else says its own message, which for a refused grant is the library's sentence.
 * RULE: an error that can carry text a hub relayed MUST carry a `reason`, or its message reaches the screen as if it were fact.
 */
export function pairingProblem(err: unknown): string {
    const reason = (err as { reason?: unknown } | null)?.reason;
    switch (reason) {
        case "timed-out": return "Nobody answered the code in time. Start again for a new code.";
        case "hub": return "The hub refused it or could not be reached. Check its address and try again.";
        case "malformed": return "What came back was not a pairing answer. Start again for a new code.";
        case "chain": return "The certificate in the answer does not lead back to this account's root, so nothing was paired. Cancel on the new device and start again; if it repeats, the hub is not one to trust.";
        case "not-mine": return "The answer named a different device than the one waiting under the code, so nothing was paired. Cancel on the new device and start again; if it repeats, the hub is not one to trust.";
        case "not-my-agreement-key": return "The answer was sealed to other keys than the ones that were offered, so nothing was paired. Cancel on the new device and start again; if it repeats, the hub is not one to trust.";
        case "wrong-role": return "The answer gave the device another role than the one it asked for, so nothing was paired. Cancel on the new device and start again; if it repeats, the hub is not one to trust.";
        case "bad-offer": return "That is not a pairing code. On the new device, choose Join an account for one.";
        case "mismatch": return "The QR code named other keys than the ones waiting under it: something between the two devices swapped them. Nothing was paired. On the new device, cancel and start again; if it happens again, the hub is not one to trust.";
        case "no-offer": return "No device is waiting under that code. Check it, or ask for a new one: a code lasts ten minutes.";
    }
    const msg = err instanceof Error ? err.message : String(err ?? "");
    return msg || "It did not complete. Try again.";
}

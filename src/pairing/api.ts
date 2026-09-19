// pairing/api.ts — WHAT THE PAIRING SCREENS ASK OF THE DEVICE they are drawn on: the hub client library's pairing calls
// (`src/hub/pair-flow.ts` over `Keyring`), seen as the screens need them. The screens take this as a prop, so any
// surface that can supply one renders them (docs/spec/CHAT_PAGE.md § Pairing and grants), and a fake stands in for
// development and the specs. The cryptography is the hub library's; the words and the order of the steps are here.
//
// The flow (window-ml-hub docs/design/pairing.md, option C): the NEW principal shows a code and the fingerprint of its
// own keys; the person types the code on a device that may pair, which shows the fingerprint IT computes; they compare
// the two and confirm there, choosing what the new one may do.

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
}

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
    /** this device's connection to the hub, where it keeps one; absent where the surface does not */
    connection?(): Promise<HubConnectionView>;
    /** leave the account: forget the membership (never a root) and stop connecting. Absent where it cannot */
    leave?(): Promise<void>;
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

/** What a role is called on screen. */
export function roleName(role: PairRole | string): string {
    return role === "runtime" ? "a browser runtime" : role === "client" ? "a device" : role === "box-connector" ? "a box" : "a device";
}

/**
 * Why a pairing did not complete, as a sentence with what to do next. Reads `.reason` off the library's
 * `PairingError`; anything else says its own message, which for a refused grant is the library's sentence.
 */
export function pairingProblem(err: unknown): string {
    const reason = (err as { reason?: unknown } | null)?.reason;
    switch (reason) {
        case "timed-out": return "Nobody answered the code in time. Start again for a new code.";
        case "hub": return "The hub refused it or could not be reached. Check its address and try again.";
        case "malformed": return "What came back was not a pairing answer. Start again for a new code.";
        case "chain":
        case "not-mine":
        case "not-my-agreement-key":
        case "wrong-role":
            return "The answer did not check out, so nothing was paired. Start again, and compare the fingerprints closely.";
        case "bad-offer": return "That code holds something that is not a pairing offer.";
        case "no-offer": return "No device is waiting under that code. Check it, or ask for a new one: a code lasts ten minutes.";
    }
    const msg = err instanceof Error ? err.message : String(err ?? "");
    return msg || "It did not complete. Try again.";
}

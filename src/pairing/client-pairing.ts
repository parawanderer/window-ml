// client-pairing.ts — PAIRING ON A CLIENT: the phone app, a desktop app wrapping the web build, or the web build in a
// browser tab. They draw the same chat page, so they share this adapter; what differs is the platform around it (the
// storage the keyring lives in, a camera), which the caller passes in.
//
// A client may CREATE the account (and so hold its root, the one device that pairs every other: window-ml-hub
// end-to-end-crypto decision 4), JOIN one by showing a code, and PAIR devices once it holds the root or `may_pair`.
// Pairing goes over the hub connection the app already holds (`client()`): the hub refuses a second connection from a
// principal that is connected, so opening one here would knock the app's own off.

import type { HubClient } from "../hub/client";
import { Keyring } from "../hub/keyring";
import * as flow from "../hub/pair-flow";
import { PAIRING_WINDOW_MS } from "../hub/pairing";
import { Role } from "../hub/wire";
import type { FoundOffer, Grant, Membership, PairingApi } from "./api";
import { membershipOf, roleOf } from "./keyring-view";

/** What a client's platform supplies: its keyring, its live hub connection, and how to describe where keys live. */
export interface ClientPairingOptions {
    /** this origin's keyring; the default opens the standard one */
    keyring?: () => Promise<Keyring>;
    /** the app's connected hub client, or null while it is not connected (pairing others needs it) */
    client: () => HubClient | null;
    defaultLabel: string;
    defaultHubUrl?: string;
    /** where the root key would live, in words, for the Create screen's warning ("this app's storage") */
    rootKeptIn: string;
    /** the membership changed (created, joined, left): the app reconnects with it */
    onChanged?: () => void;
}

/** Ask the browser to keep this origin's storage through pressure: the root key is in it. False where it will not say. */
async function keepStorage(): Promise<boolean> {
    try { return (await navigator.storage?.persist?.()) ?? false; } catch { return false; }
}

/** The pairing API for a client. */
export function clientPairing(o: ClientPairingOptions): PairingApi {
    let ring: Promise<Keyring> | null = null;
    const keyring = o.keyring ?? (() => (ring ??= Keyring.open()));
    const view = async () => membershipOf(await (await keyring()).load(), o.defaultLabel);
    const changed = async (): Promise<Membership> => { o.onChanged?.(); return (await view())!; };
    const connected = (): HubClient => {
        const c = o.client();
        if (!c) throw new Error("Not connected to the hub yet. Wait a moment, then try again.");
        return c;
    };
    const issuer = async (): Promise<flow.Issuer> => {
        const i = await flow.issuerOf(await keyring());
        if (!i) throw new Error("This device may not pair others. Pair new devices on the one that holds the account's root.");
        return i;
    };
    return {
        joinsAs: "client",
        canCreate: true,
        rootKeptIn: o.rootKeptIn,
        defaultLabel: o.defaultLabel,
        defaultHubUrl: o.defaultHubUrl ?? "",
        load: view,
        async createAccount({ hubUrl, label, invite }) {
            // Asked first: a browser that grants it will not evict this origin's storage, the root key included.
            await keepStorage();
            await flow.createAccount(await keyring(), { hubUrl, label, invite: invite ? new TextEncoder().encode(invite) : undefined });
            return changed();
        },
        async beginOffer({ hubUrl, label }) {
            const offer = await flow.beginOffer(await keyring(), { hubUrl, role: Role.ROLE_CLIENT, label });
            return {
                code: offer.code,
                fingerprint: offer.fingerprint,
                qr: (offer as { qr?: string }).qr,
                expiresAt: Date.now() + PAIRING_WINDOW_MS,
                done: offer.done.then(changed),
                cancel: offer.cancel,
            };
        },
        async lookupOffer(typed): Promise<FoundOffer> {
            const found = await flow.lookupOffer(connected(), typed);
            const from = await issuer();
            return {
                label: found.offer.label,
                role: roleOf(found.offer.role),
                fingerprint: found.fingerprint,
                grant: flow.defaultGrant(found.offer.role, from),
                grantable: from.scopes ?? null,
                ref: found,
            };
        },
        async confirmOffer(found: FoundOffer, grant: Grant) {
            await flow.confirmOffer(connected(), await issuer(), found.ref as flow.FoundOffer, grant);
        },
        async leave() {
            // Never a root: forgetting it is final, and the account view does not offer it on the root device.
            const me = await (await keyring()).load();
            if (me?.root) throw new Error("This device holds the account's root: leaving would lose the account.");
            await (await keyring()).leave();
            o.onChanged?.();
        },
    };
}

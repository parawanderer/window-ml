// extension-pairing.ts — THE EXTENSION'S PAIRING, for the screens: this browser joins an account as a RUNTIME, over the
// hub library's real flow (`pair-flow.ts`, the `Keyring` in this origin's IndexedDB), and tells the worker once it has,
// which reads the same keyring and connects (`HUB_RUNTIME`, sw-hub.ts).
//
// What it does NOT offer, on purpose: creating an account (the root lives on the device people pair others from, and
// no runtime holds it: window-ml-hub end-to-end-crypto decision 4), and pairing others (a runtime holds no scopes, so
// it could give a phone nothing; phones are paired at the root device). The screens read that off `canCreate` and
// `mayPair` and say where to go instead.

import { CertificateBody } from "../proto/wmlhub/v1/identity.gen";
import { Keyring } from "../hub/keyring";
import { beginOffer } from "../hub/pair-flow";
import { PAIRING_WINDOW_MS, pairingFingerprintHex } from "../hub/pairing";
import { Role } from "../hub/wire";
import type { HubConnectionView, Membership, PairingApi, PairRole } from "./api";

/** The certificate's role, as the screens name it. */
function roleOf(role: Role | undefined): PairRole {
    return role === Role.ROLE_RUNTIME ? "runtime" : role === Role.ROLE_BOX_CONNECTOR ? "box-connector" : "client";
}

/** What this browser is called by default: its brand and platform ("Brave on macOS"), which a phone's list can tell apart. */
function browserLabel(): string {
    const ua = (navigator as Navigator & { userAgentData?: { brands?: { brand: string }[]; platform?: string } }).userAgentData;
    const brand = ua?.brands?.map((b) => b.brand).find((b) => !/not.*brand|chromium/i.test(b));
    const platform = ua?.platform;
    return brand && platform ? `${brand} on ${platform}` : brand ?? "This browser";
}

/** Ask the worker about, or tell it of, this browser's hub connection. Null when the worker does not answer. */
async function hubRuntime(payload: Record<string, unknown>): Promise<unknown> {
    const r = await chrome.runtime.sendMessage({ type: "HUB_RUNTIME", payload }).catch(() => null) as { data?: unknown } | null;
    return r?.data ?? null;
}

/** The pairing API for the extension's pages: join as a runtime, see the connection, leave. */
export function extensionPairing(): PairingApi {
    let ring: Promise<Keyring> | null = null;
    const keyring = () => (ring ??= Keyring.open());
    /** The keyring's membership as the screens show it: the certificate's own label and role, the keys' fingerprint. */
    const membershipView = async (): Promise<Membership | null> => {
        const me = await (await keyring()).load();
        if (!me?.membership) return null;
        const leaf = me.membership.chain[0];
        const body = leaf ? CertificateBody.decode(leaf.body) : null;
        return {
            label: body?.label || browserLabel(),
            role: roleOf(body?.role),
            hubUrl: me.membership.hubUrl,
            fingerprint: await pairingFingerprintHex(me.identity.publicKey, me.agreement.publicKey),
            root: !!me.root,
            mayPair: false,
        };
    };
    const notHere = () => Promise.reject(new Error("Pair devices on the device that holds the account's root."));
    return {
        joinsAs: "runtime",
        canCreate: false,
        defaultLabel: browserLabel(),
        defaultHubUrl: "",
        load: membershipView,
        createAccount: () => Promise.reject(new Error("This browser joins an account; create it on the device you pair others from.")),
        async beginOffer({ hubUrl, label }) {
            const offer = await beginOffer(await keyring(), { hubUrl, role: Role.ROLE_RUNTIME, label });
            return {
                code: offer.code,
                fingerprint: offer.fingerprint,
                expiresAt: Date.now() + PAIRING_WINDOW_MS,
                // Saved to the keyring before this resolves; the worker then reads it and connects.
                done: offer.done.then(async () => {
                    await hubRuntime({ action: "paired" });
                    return (await membershipView())!;
                }),
                cancel: offer.cancel,
            };
        },
        lookupOffer: notHere,
        confirmOffer: notHere,
        async connection(): Promise<HubConnectionView> {
            const s = await hubRuntime({}) as ({ state: string; hubName?: string; devices?: number; reason?: string; retryInMs?: number }) | null;
            if (!s) return { state: "stopped" };
            switch (s.state) {
                case "online": return { state: "online", hubName: s.hubName, devices: s.devices ?? 0 };
                case "connecting": return { state: "connecting", hubName: s.hubName };
                case "offline": return { state: "offline", hubName: s.hubName, reason: s.reason ?? "unreachable", retryInMs: s.retryInMs ?? 0 };
                case "unpaired": return { state: "unpaired" };
                default: return { state: "stopped", hubName: s.hubName };
            }
        },
        async leave() {
            // The membership only: this browser never holds a root, and its keys stay, so joining again is the same principal.
            await (await keyring()).leave();
            await hubRuntime({ action: "left" });
        },
    };
}

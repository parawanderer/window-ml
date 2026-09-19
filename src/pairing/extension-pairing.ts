// extension-pairing.ts — THE EXTENSION'S PAIRING, for the screens: this browser joins an account as a RUNTIME, over the
// hub library's real flow (`pair-flow.ts`, the `Keyring` in this origin's IndexedDB), and tells the worker once it has,
// which reads the same keyring and connects (`HUB_RUNTIME`, sw-hub.ts).
//
// What it does NOT offer, on purpose: creating an account (the root lives on the device people pair others from, and
// no runtime holds it: window-ml-hub end-to-end-crypto decision 4), and pairing others (a runtime holds no scopes, so
// it could give a phone nothing; phones are paired at the root device). The screens read that off `canCreate` and
// `mayPair` and say where to go instead.

import { Keyring } from "../hub/keyring";
import { beginOffer } from "../hub/pair-flow";
import { PAIRING_WINDOW_MS } from "../hub/pairing";
import { Role } from "../hub/wire";
import type { DeviceInfo } from "../session-host";
import type { HubConnectionView, HubLogLine, Membership, PairingApi, RevokeOutcome } from "./api";
import { membershipOf } from "./keyring-view";

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
    // A runtime pairs nobody from here (see the header), whatever its certificate allows.
    const membershipView = async (): Promise<Membership | null> => {
        const m = await membershipOf(await (await keyring()).load(), browserLabel());
        return m && { ...m, mayPair: false };
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
                // The library adds the QR text with #218; until then the screen shows the code alone.
                qr: (offer as { qr?: string }).qr,
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
        async history(): Promise<HubLogLine[]> {
            const log = await hubRuntime({ action: "log" });
            return Array.isArray(log) ? log as HubLogLine[] : [];
        },
        async devices(): Promise<DeviceInfo[]> {
            const list = await hubRuntime({ action: "devices" });
            return Array.isArray(list) ? list as DeviceInfo[] : [];
        },
        async revoke(principal: string): Promise<RevokeOutcome> {
            const r = await hubRuntime({ action: "revoke", principal });
            if (r === "revoked" || r === "already" || r === "self" || r === "unpaired") return r;
            throw new Error("The worker did not answer; nothing was removed.");
        },
        async leave() {
            // The membership only: this browser never holds a root, and its keys stay, so joining again is the same principal.
            await (await keyring()).leave();
            await hubRuntime({ action: "left" });
        },
    };
}

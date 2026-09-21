// native-embed-app.tsx — the phone app's page over THIS DEVICE'S account: the keyring (its secrets in the phone's
// keystore, over the bridge) and a reconnecting hub host (client-host.ts), then `runEmbed`. Before an account there is
// no host, and the app shows its own first-run screens.

import { clientPairing } from "../pairing/client-pairing";
import { FakeHost } from "./fake-host";
import { openClientHost } from "./client-host";
import { keepKeysInApp, reportStartFailure, runEmbed } from "./native-embed";

declare const __BUNDLE__: string;

/** Open the keyring and the hub, then the page. No account yet: an EMPTY host (no runtimes, nothing to show), because the
 *  app draws the first-run screens itself and the page only has to say `account: null`. */
async function main(): Promise<void> {
    // The keys live in the phone's keystore, not the WebView's storage (WebKit cannot even store an X25519 key there).
    keepKeysInApp();
    const { ring, me, host } = await openClientHost("Phone");
    const m = me?.membership;
    // Joining, creating or leaving changes who this device is: the page starts over as the new identity. After a moment,
    // so the answer that caused it reaches the app first.
    const pairing = clientPairing({
        keyring: async () => ring,
        // Pairing goes over the host's connection: the hub refuses a second one from this principal.
        client: () => host?.connection?.hubClient ?? null,
        defaultLabel: "Phone",
        rootKeptIn: "this phone's keystore",
        onChanged: () => { setTimeout(() => location.reload(), 400); },
    });
    runEmbed(host ?? new FakeHost({ runtimes: [] }), {
        account: m ? { label: "This phone", hubUrl: m.hubUrl, root: !!me?.root } : null,
        bundle: typeof __BUNDLE__ === "string" ? __BUNDLE__ : "dev",
        ...(host ? { reconnect: () => host.reconnect() } : {}),
        pairing,
    });
}

main().catch(reportStartFailure);

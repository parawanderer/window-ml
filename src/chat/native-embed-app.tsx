// native-embed-app.tsx — the phone app's page over THIS DEVICE'S account: the keyring and a reconnecting hub host
// (client-host.ts), then `runEmbed`. Before an account there is no host, and the app shows its own first-run screens.

import { FakeHost } from "./fake-host";
import { openClientHost } from "./client-host";
import { runEmbed } from "./native-embed";

declare const __BUNDLE__: string;

/** Open the keyring and the hub, then the page. No account yet: an EMPTY host (no runtimes, nothing to show), because the
 *  app draws the first-run screens itself and the page only has to say `account: null`. */
async function main(): Promise<void> {
    const { me, host } = await openClientHost("Phone");
    const m = me?.membership;
    runEmbed(host ?? new FakeHost({ runtimes: [] }), {
        account: m ? { label: "This phone", hubUrl: m.hubUrl, root: !!me?.root } : null,
        bundle: typeof __BUNDLE__ === "string" ? __BUNDLE__ : "dev",
        ...(host ? { reconnect: () => host.reconnect() } : {}),
    });
}

void main();

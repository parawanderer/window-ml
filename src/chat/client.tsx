// client.tsx — THE STANDALONE CLIENT: the chat page with nothing behind it but a hub. It is not a browser runtime and
// never becomes one: no agents, no tabs, no worker. It lists the runtimes on its account and drives them through the
// hub, exactly as the phone app does, which runs this same entry inside Capacitor.
//
// Its state is its keyring (this origin's IndexedDB). In no account yet, it shows only the account panel: create one
// (this device then holds the root) or join one. In an account, it connects with the keys the keyring holds and draws
// the chat page over `HubHost`. Creating, joining or leaving reloads the page, which is the simplest honest way to
// start over with a different identity.
//
// RECONNECTING is the host's own (`HubHost.reconnecting`): it reopens the connection whenever it drops and keeps every
// subscription the page holds, so a phone that slept or a hub that restarted comes back to the same open session. The
// page's status chip says `connecting…` or `offline` meanwhile, and waking or coming back online tries at once.

import { render } from "preact";
import { clientPairing } from "../pairing/client-pairing";
import { AccountPanel } from "../pairing/pairing-ui";
import { installServices } from "../sidebar/services";
import { installTooltipLayer } from "../sidebar/tooltip-layer";
import { applyCodePrefs, initThemeStyle } from "../sidebar/prefs";
import { ChatApp } from "./chat-app";
import { ChatStore } from "./chat-store";
import type { HubHost } from "./hub-host";
import { openClientHost } from "./client-host";
import { hostServices } from "./host-services";
import { installPageTheme } from "./page-theme";
import { webPlatform, type ClientPlatform } from "./platform";
import { installViewPrefs } from "./view-mode";

/** Is this the phone app (Capacitor's native shell) rather than a page in a browser? */
const native = !!(globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();

/** What this device is called by default on the account: its browser and platform, or just "Phone" in the app. */
function deviceLabel(): string {
    if (native) return "Phone";
    const ua = (navigator as Navigator & { userAgentData?: { brands?: { brand: string }[]; platform?: string } }).userAgentData;
    const brand = ua?.brands?.map((b) => b.brand).find((b) => !/not.*brand|chromium/i.test(b));
    return brand && ua?.platform ? `${brand} on ${ua.platform}` : "Web client";
}

/** The page's settings that belong to the device, whichever screen is drawn. */
function installDevice(): void {
    initThemeStyle();
    applyCodePrefs();
    installViewPrefs(webPlatform.prefs);
    installPageTheme();
    try { installTooltipLayer(document); } catch { /* no DOM */ }
}

/** Before an account: the account panel alone, full page. */
function FirstRun({ platform }: { platform: ClientPlatform }) {
    return (
        <main class="client-first" aria-label="Account">
            <h1 class="client-title">window.ml</h1>
            <p class="client-lede">A remote for your browsers: their sessions, their runs, their approvals, from here. Nothing runs on this device.</p>
            <AccountPanel api={platform.pairing!} />
        </main>
    );
}

/** Start: read the keyring, then draw the account panel, or the chat page over a host that keeps itself connected. */
async function main(): Promise<void> {
    installDevice();
    const root = document.getElementById("root") || document.body;
    const opened = await openClientHost(deviceLabel());
    const { ring, me } = opened;
    const host: HubHost | null = opened.host;
    const platform: ClientPlatform = {
        ...webPlatform,
        kind: native ? "native" : "web",
        pairing: clientPairing({
            keyring: async () => ring,
            // Pairing goes over the host's connection: the hub refuses a second one from this principal.
            client: () => host?.connection?.hubClient ?? null,
            defaultLabel: deviceLabel(),
            rootKeptIn: native ? "this app's storage on this phone" : "this site's data in this browser",
            onChanged: () => location.reload(),
        }),
    };
    if (!me?.membership || !host) { render(<FirstRun platform={platform} />, root); return; }
    const store = new ChatStore(host);
    installServices(hostServices(store, platform));
    store.start();
    render(<ChatApp store={store} platform={platform} />, root);
}

void main();

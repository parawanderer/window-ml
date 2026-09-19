// client.tsx — THE STANDALONE CLIENT: the chat page with nothing behind it but a hub. It is not a browser runtime and
// never becomes one: no agents, no tabs, no worker. It lists the runtimes on its account and drives them through the
// hub, exactly as the phone app does, which runs this same entry inside Capacitor.
//
// Its state is its keyring (this origin's IndexedDB). In no account yet, it shows only the account panel: create one
// (this device then holds the root) or join one. In an account, it connects with the keys the keyring holds and draws
// the chat page over `HubHost`. Creating, joining or leaving reloads the page, which is the simplest honest way to
// start over with a different identity.
//
// RECONNECTING is a reload with a growing delay for now: `HubHost` is built over one connection and has no way to be
// handed another. A connection that can be resumed in place belongs to the hub transport, and is asked for.

import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Keyring } from "../hub/keyring";
import { principalId } from "../hub/keys";
import { ChannelKey } from "../hub/seal";
import { Role } from "../hub/wire";
import { clientPairing } from "../pairing/client-pairing";
import { AccountPanel } from "../pairing/pairing-ui";
import { installServices } from "../sidebar/services";
import { installTooltipLayer } from "../sidebar/tooltip-layer";
import { applyCodePrefs, initThemeStyle } from "../sidebar/prefs";
import { ChatApp } from "./chat-app";
import { ChatStore } from "./chat-store";
import { HubConnection } from "./hub-connection";
import { HubHost } from "./hub-host";
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

/** How long to wait before the Nth reconnect: 2 s, doubling, at most a minute. Kept across the reload in the session. */
function retryDelayMs(): number {
    let n = 0;
    try { n = Number(sessionStorage.getItem("wml-client-retry")) || 0; sessionStorage.setItem("wml-client-retry", String(n + 1)); } catch { /* unavailable */ }
    return Math.min(60_000, 2000 * 2 ** n);
}
/** A connection that came up resets the delay. */
function connectedOnce(): void {
    try { sessionStorage.removeItem("wml-client-retry"); } catch { /* unavailable */ }
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

/** The hub could not be reached (or the connection dropped): where it is, and when it is tried again. */
function Unreachable({ hubUrl, reason, retryMs }: { hubUrl: string; reason: string; retryMs: number }) {
    const [left, setLeft] = useState(Math.round(retryMs / 1000));
    useEffect(() => {
        const t = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
        const go = setTimeout(() => location.reload(), retryMs);
        return () => { clearInterval(t); clearTimeout(go); };
    }, [retryMs]);
    return (
        <main class="client-first" aria-label="Not connected">
            <h1 class="client-title">Not connected</h1>
            <p class="client-lede">The hub at <code>{hubUrl}</code> did not answer: {reason}. Trying again in {left} s.</p>
            <div class="pair-actions client-actions"><button class="btn primary" onClick={() => location.reload()}>Try now</button></div>
        </main>
    );
}

/** Start: read the keyring, then draw the account panel, the chat page over the hub, or why it could not connect. */
async function main(): Promise<void> {
    installDevice();
    const root = document.getElementById("root") || document.body;
    const ring = await Keyring.open();
    const me = await ring.load();
    let conn: HubConnection | null = null;
    const platform: ClientPlatform = {
        ...webPlatform,
        kind: native ? "native" : "web",
        pairing: clientPairing({
            keyring: async () => ring,
            client: () => conn?.hubClient ?? null,
            defaultLabel: deviceLabel(),
            rootKeptIn: native ? "this app's storage on this phone" : "this site's data in this browser",
            onChanged: () => location.reload(),
        }),
    };
    const m = me?.membership;
    if (!me || !m) { render(<FirstRun platform={platform} />, root); return; }
    try {
        conn = await HubConnection.open({
            url: m.hubUrl, hubName: m.hubName, identity: me.identity, agreement: me.agreement, chain: m.chain,
            accountRoot: m.accountRoot, role: Role.ROLE_CLIENT,
        });
    } catch (err) {
        render(<Unreachable hubUrl={m.hubUrl} reason={err instanceof Error ? err.message : String(err)} retryMs={retryDelayMs()} />, root);
        return;
    }
    connectedOnce();
    const id = [...await principalId(me.identity.publicKey)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const host = new HubHost(conn, await ChannelKey.fromBytes(m.channelKey), { id, kind: "device", name: deviceLabel() });
    const store = new ChatStore(host);
    installServices(hostServices(store, platform));
    // A dropped connection: say so and come back, rather than leave a page that quietly stopped updating.
    conn.onClose((reason) => render(<Unreachable hubUrl={m.hubUrl} reason={reason || "the connection closed"} retryMs={retryDelayMs()} />, root));
    store.start();
    render(<ChatApp store={store} platform={platform} />, root);
}

void main();

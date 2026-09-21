// client-host.ts — THE STANDALONE CLIENT'S CONNECTION: this device's keyring, and, when it is in an account, a hub host
// over it that keeps itself connected. Shared by the web client (client.tsx) and the page inside the phone app
// (native-embed.tsx), so both open the hub the same way and neither is ever a runtime.

import { Keyring } from "../hub/keyring";
import { principalId } from "../hub/keys";
import { ChannelKey } from "../hub/seal";
import { Role } from "../hub/wire";
import { HubConnection } from "./hub-connection";
import { HubHost } from "./hub-host";

/** What the keyring holds for this device, as `Keyring.load` answers it. */
export type KeyringEntry = Awaited<ReturnType<Keyring["load"]>>;

/**
 * Open the keyring and, when this device is in an account, a reconnecting hub host named `name`. Waking (a phone
 * unlocked, a tab brought back) and the network returning try at once rather than waiting out the backoff.
 */
export async function openClientHost(name: string): Promise<{ ring: Keyring; me: KeyringEntry; host: HubHost | null }> {
    const ring = await Keyring.open();
    const me = await ring.load();
    const m = me?.membership;
    if (!me || !m) return { ring, me, host: null };
    const id = [...await principalId(me.identity.publicKey)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const open = () => HubConnection.open({
        url: m.hubUrl, hubName: m.hubName, identity: me.identity, agreement: me.agreement, chain: m.chain,
        accountRoot: m.accountRoot, role: Role.ROLE_CLIENT,
    });
    const host = HubHost.reconnecting(open, await ChannelKey.fromBytes(m.channelKey), { id, kind: "device", name });
    const now = () => host.reconnect();
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") now(); });
    addEventListener("online", now);
    return { ring, me, host };
}

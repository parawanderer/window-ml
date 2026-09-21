// vault-bridge.ts — THE KEYRING'S VAULT IN THE PHONE APP: a `SecretVault` (src/hub/keyring.ts) whose every read and write
// is a `vault` request to the app, answered by `vaultResult` from the platform keystore (the iOS Keychain, Android's
// Keystore-backed storage). The page holds no secret at rest; the app holds nothing it could use without the page.

import type { SecretVault } from "../hub/keyring";
import type { ToNative, ToWeb } from "./bridge";

/** The names the keyring uses. The app accepts these and nothing else, so the page cannot use the keystore as a store. */
export const VAULT_NAMES = ["self", "membership", "root"] as const;

/**
 * A vault over the bridge. `settle` takes each `vaultResult` the app sends back. A request the app does not answer in
 * `timeoutMs` fails, so a page is never left waiting for its keys with nothing on screen to say why.
 */
export function bridgeVault(post: (m: ToNative) => void, timeoutMs = 15_000): { vault: SecretVault; settle(m: Extract<ToWeb, { type: "vaultResult" }>): void } {
    const pending = new Map<string, (m: Extract<ToWeb, { type: "vaultResult" }>) => void>();
    let n = 0;
    const ask = (op: "get" | "set" | "delete", name: string, value?: string) => new Promise<string | null>((resolve, reject) => {
        if (!(VAULT_NAMES as readonly string[]).includes(name)) { reject(new Error(`no vault record called ${name}`)); return; }
        const id = `v${++n}`;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("the app's keystore did not answer")); }, timeoutMs);
        pending.set(id, (m) => {
            clearTimeout(timer);
            if (m.ok) resolve(m.value ?? null);
            else reject(new Error(m.error ?? "the app's keystore refused"));
        });
        post({ type: "vault", id, op, name, ...(value !== undefined ? { value } : {}) });
    });
    return {
        vault: {
            get: (name) => ask("get", name),
            set: async (name, value) => { await ask("set", name, value); },
            delete: async (name) => { await ask("delete", name); },
        },
        settle(m) {
            const r = pending.get(m.id);
            pending.delete(m.id);
            r?.(m);
        },
    };
}

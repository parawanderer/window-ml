// vault.ts — THE KEYRING'S SECRETS ON THIS PHONE: the page's `vault` requests (src/native/vault-bridge.ts) answered from
// expo-secure-store, which is the Keychain on iOS and Keystore-encrypted storage on Android. Kept "this device only"
// and after the first unlock: a device key is never restored onto another phone from a backup, and the app can still
// reconnect in the background once the phone has been unlocked since it started.

import * as SecureStore from "expo-secure-store";
import type { ToNative, ToWeb } from "../../src/native/bridge";
import { VAULT_NAMES } from "../../src/native/vault-bridge";

const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

/** Answer one `vault` request. Only the keyring's own record names are served, so the page cannot keep anything else here. */
export async function answerVault(m: Extract<ToNative, { type: "vault" }>): Promise<Extract<ToWeb, { type: "vaultResult" }>> {
    if (!(VAULT_NAMES as readonly string[]).includes(m.name)) return { type: "vaultResult", id: m.id, ok: false, error: `no vault record called ${m.name}` };
    const key = `keyring.${m.name}`;
    try {
        switch (m.op) {
            case "get": {
                const value = await SecureStore.getItemAsync(key, OPTIONS);
                return { type: "vaultResult", id: m.id, ok: true, ...(value !== null ? { value } : {}) };
            }
            case "set":
                if (typeof m.value !== "string") return { type: "vaultResult", id: m.id, ok: false, error: "nothing to keep" };
                await SecureStore.setItemAsync(key, m.value, OPTIONS);
                return { type: "vaultResult", id: m.id, ok: true };
            case "delete":
                await SecureStore.deleteItemAsync(key, OPTIONS);
                return { type: "vaultResult", id: m.id, ok: true };
            default:
                return { type: "vaultResult", id: m.id, ok: false, error: "unknown vault operation" };
        }
    } catch (e) {
        return { type: "vaultResult", id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

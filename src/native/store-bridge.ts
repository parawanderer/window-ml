// store-bridge.ts — WHAT THE PHONE KEEPS FOR THE PAGE, outside the WebView. The keystore (vault-bridge.ts) holds the
// secrets; this holds everything else the page would otherwise put in IndexedDB: which hub this device is paired to,
// the certificate chain, the device list. The app writes it to its own files, so the WebView persists nothing.
//
// Why it is not the vault: a keystore is for small secrets, and these are neither. Same shape, different drawer.

import type { ToNative, ToWeb } from "./bridge";

/** A place the page can keep something that is not secret, by name. The keyring takes one of these (`PlainStore`). */
export interface PlainStore {
    get(name: string): Promise<string | null>;
    set(name: string, value: string): Promise<void>;
    delete(name: string): Promise<void>;
}

/** The names the app will serve. A name outside this shape is refused on both sides rather than becoming a file. */
export const STORE_NAME = /^[a-z][a-z0-9-]{0,63}(:[a-z0-9-]{1,64})?$/;

/**
 * A store over the bridge. `settle` takes each `storeResult` the app sends back. A request the app does not answer in
 * `timeoutMs` fails rather than leaving the page waiting on its own bookkeeping.
 */
export function bridgeStore(post: (m: ToNative) => void, timeoutMs = 15_000): { store: PlainStore; settle(m: Extract<ToWeb, { type: "storeResult" }>): void } {
    const pending = new Map<string, (m: Extract<ToWeb, { type: "storeResult" }>) => void>();
    let n = 0;
    const ask = (op: "get" | "set" | "delete", name: string, value?: string) => new Promise<string | null>((resolve, reject) => {
        if (!STORE_NAME.test(name)) { reject(new Error(`that is not a name this store keeps: ${name}`)); return; }
        const id = `s${++n}`;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("the app's store did not answer")); }, timeoutMs);
        pending.set(id, (m) => {
            clearTimeout(timer);
            if (m.ok) resolve(m.value ?? null);
            else reject(new Error(m.error ?? "the app's store refused"));
        });
        post({ type: "store", id, op, name, ...(value !== undefined ? { value } : {}) });
    });
    return {
        store: {
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

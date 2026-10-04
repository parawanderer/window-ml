// store.ts — WHAT THIS APP KEEPS FOR THE PAGE that is not secret: which hub this device is paired to, the certificate
// chain pairing produced, the device list. The page's `store` requests (src/native/store-bridge.ts) answered from the
// app's own files, so the WebView persists nothing and uninstalling the app takes it all with it.
//
// Files rather than the keystore (vault.ts): a keystore is for small secrets, and a certificate chain is neither. One
// file per name under `documents/store/`, named by the page and checked here before it becomes a path.

import { Directory, File, Paths } from "expo-file-system";
import type { ToNative, ToWeb } from "../../src/native/bridge";
import { STORE_NAME } from "../../src/native/store-bridge";

/** The folder a record lives in. BOTH are now documents, and the sessions moving there is a promise rather than a
 *  tidy-up: history you have already pulled should still be readable on a plane, and in the cache directory the OS
 *  could take it whenever it liked. What makes that affordable is that the copies BOUND THEMSELVES — a session over
 *  the cap is trimmed to its newest events (event-cache.ts), and past `CACHE_SESSIONS` the least recently opened
 *  goes — so this is a bounded archive and not a folder that grows until the phone is full.
 *
 *  Anything already written under the cache directory is simply not found and refetched once; it was a cache, and
 *  nothing promised it would still be there. */
const dirFor = (name: string): Directory => {
    const d = new Directory(Paths.document, name.startsWith("ev") ? "events" : "store");
    if (!d.exists) d.create({ intermediates: true });
    return d;
};

/** One record's file. `:` is not a path character everywhere, so a name's colon becomes a dash on disk. */
const fileFor = (name: string): File => new File(dirFor(name), `${name.replace(/:/g, "-")}.json`);

/** Answer one `store` request. A name the page has no business writing is refused rather than turned into a path. */
export async function answerStore(m: Extract<ToNative, { type: "store" }>): Promise<Extract<ToWeb, { type: "storeResult" }>> {
    if (!STORE_NAME.test(m.name)) return { type: "storeResult", id: m.id, ok: false, error: `that is not a name this store keeps: ${m.name}` };
    try {
        const f = fileFor(m.name);
        switch (m.op) {
            case "get":
                return { type: "storeResult", id: m.id, ok: true, ...(f.exists ? { value: f.textSync() } : {}) };
            case "set":
                if (typeof m.value !== "string") return { type: "storeResult", id: m.id, ok: false, error: "nothing to keep" };
                if (f.exists) f.delete();
                f.create();
                f.write(m.value);
                return { type: "storeResult", id: m.id, ok: true };
            case "delete":
                if (f.exists) f.delete();
                return { type: "storeResult", id: m.id, ok: true };
            default:
                return { type: "storeResult", id: m.id, ok: false, error: "unknown store operation" };
        }
    } catch (e) {
        return { type: "storeResult", id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

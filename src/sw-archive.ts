// sw-archive.ts — the service worker's side of the session archive: one call, relayed through the offscreen document
// to the archive worker (archive-worker.ts), which holds the SQLite. The worker cannot run WASM, so everything the
// archive does happens there; this is the messenger.
import { ensureOffscreen, forgetOffscreen } from "./sw-offscreen";
import type { ArchiveOp } from "./archive-worker";

/** Run one archive operation. Rejects with the archive's own message when it fails (no OPFS, a newer schema). */
export async function archiveCall<T>(op: ArchiveOp["op"], args?: ArchiveOp["args"]): Promise<T> {
    const send = () => ensureOffscreen().then(() => chrome.runtime.sendMessage({ type: "ARCHIVE_OP", op, args }) as Promise<{ ok: boolean; result?: unknown; error?: string } | undefined>);
    let r: { ok: boolean; result?: unknown; error?: string } | undefined;
    try { r = await send(); }
    catch (err) {
        // The offscreen document was torn down while the worker slept: recreate it, once.
        if (!/Receiving end does not exist|Could not establish connection/.test(String((err as Error)?.message || err))) throw err;
        forgetOffscreen();
        r = await send();
    }
    if (!r?.ok) throw new Error(r?.error || "the archive did not answer");
    return r.result as T;
}

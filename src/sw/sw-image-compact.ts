// sw-image-compact.ts — shrinks saved sessions in the background: once the writes stop, each session's PNG screenshots
// are re-encoded as lossless WebP (about 42% of the bytes, every pixel the same) and its stored events rewritten. A
// session is written as it happens, PNG and all, and compacted later; nothing waits on an encode.
//
// The encoding is image-worker.ts, in the offscreen document (libwebp is WASM, and a large screenshot takes a second);
// the rewrite is `SessionStore.compactImages`. This is the clock and the messenger.
import type { SessionStore } from "../session/session-store";
import type { HousekeepingReport } from "../log/housekeeping";
import { ensureOffscreen, forgetOffscreen } from "./sw-offscreen";

/** How long the store must be quiet before a pass starts: a streaming run writes every 400 ms, and each write
 *  pushes the pass back. Under the ~30 s a service worker idles for, so the timer is still alive when it fires. */
export const COMPACT_QUIET_MS = 15_000;

/** One PNG data URL as a lossless WebP data URL from the offscreen image worker, or null to keep it. Throws when the
 *  worker cannot answer at all. */
export async function webpFromWorker(url: string): Promise<string | null> {
    const send = () => ensureOffscreen().then(() => chrome.runtime.sendMessage({ type: "IMAGE_COMPACT", url }) as Promise<{ url: string | null; error?: string } | undefined>);
    let r: { url: string | null; error?: string } | undefined;
    try { r = await send(); }
    catch (err) {
        // The offscreen document was torn down while the worker slept: recreate it, once.
        if (!/Receiving end does not exist|Could not establish connection/.test(String((err as Error)?.message || err))) throw err;
        forgetOffscreen();
        r = await send();
    }
    if (!r) throw new Error("the image worker did not answer");
    if (r.error) throw new Error(r.error);
    return r.url;
}

/**
 * The background pass over one store. `kick()` (re)starts the quiet timer; when it fires, every compactable session
 * is compacted, biggest first, one at a time. A pass that fails stops, and the next write or alarm tries again: a
 * broken encoder costs one attempt per kick, never a loop.
 *
 * Every pass with work to do is in the housekeeping log: `compact-pass` when it starts, `compact-images` per session
 * (with `from` above 0 when it carried on from an earlier pass), and `compact-pass-done` with the totals. A pass the
 * browser stopped has no `compact-pass-done`; the store keeps what each chunk committed, so the next one resumes.
 */
export function imageCompactor(store: SessionStore, o: {
    encode?: (url: string) => Promise<string | null>;
    record?: (r: HousekeepingReport) => void;
    quietMs?: number;
    now?: () => number;
} = {}): { kick(): void; pass(): Promise<void> } {
    const encode = o.encode ?? webpFromWorker, now = o.now ?? Date.now;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let running: Promise<void> | null = null;
    const run = async (): Promise<void> => {
        const todo = store.compactable();
        if (!todo.length) return;
        const t0 = now();
        let sessions = 0, images = 0, saved = 0;
        o.record?.({ subsystem: "sessions", kind: "compact-pass", reason: "idle", detail: { sessions: todo.length } });
        for (const hash of todo) {
            const t1 = now();
            let r;
            try { r = await store.compactImages(hash, encode); }
            catch (err) {
                o.record?.({ level: "warn", subsystem: "sessions", kind: "compact-images-failed", key: hash, detail: { error: String((err as Error)?.message || err).slice(0, 200) } });
                return;
            }
            if (!r) continue;
            sessions++; images += r.compacted; saved += r.bytesBefore - r.bytesAfter;
            if (r.found) o.record?.({ subsystem: "sessions", kind: "compact-images", reason: "idle", key: hash, bytes: r.bytesBefore - r.bytesAfter, ms: now() - t1, detail: { found: r.found, compacted: r.compacted, from: r.from } });
        }
        o.record?.({ subsystem: "sessions", kind: "compact-pass-done", bytes: saved, ms: now() - t0, detail: { sessions, images } });
    };
    // Assigned BEFORE it can be cleared: a pass with nothing to do finishes synchronously, and clearing inside it
    // ran before the assignment, which left a settled promise in `running` and turned every later pass into a no-op.
    const pass = (): Promise<void> => {
        if (running) return running;
        const p = run().finally(() => { if (running === p) running = null; });
        running = p;
        return p;
    };
    return {
        kick() {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => { timer = null; void pass(); }, o.quietMs ?? COMPACT_QUIET_MS);
        },
        pass,
    };
}

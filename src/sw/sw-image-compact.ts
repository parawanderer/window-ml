// sw-image-compact.ts — shrinks saved sessions in the background: once the writes stop, each session's PNG screenshots
// are re-encoded as lossless WebP (about 42% of the bytes, every pixel the same) and its stored events rewritten. A
// session is written as it happens, PNG and all, and compacted later; nothing waits on an encode.
//
// The encoding is image-worker.ts, in the offscreen document (libwebp is WASM, and a large screenshot takes a second);
// the rewrite is `SessionStore.compactImages`. This is the clock and the messenger.
import type { SessionStore } from "../session/session-store";
import type { HousekeepingReport } from "../log/housekeeping";
import type { JobDecl, JobLive } from "../job-registry";
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
} = {}): { kick(): void; pass(): Promise<void>; status(): JobLive } {
    const encode = o.encode ?? webpFromWorker, now = o.now ?? Date.now;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let dueAt: number | null = null;
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
            const ms = o.quietMs ?? COMPACT_QUIET_MS;
            dueAt = now() + ms;
            timer = setTimeout(() => { timer = null; dueAt = null; void pass(); }, ms);
        },
        pass,
        /** Whether a pass is running, how many sessions wait, and when the quiet timer fires (none set: no time). */
        status: (): JobLive => ({
            running: running != null,
            pending: store.compactable().length,
            pendingLabel: "sessions with PNG screenshots",
            ...(dueAt != null ? { nextDue: dueAt } : {}),
        }),
    };
}

/** The compaction pass as a background job (job-registry.ts): its live status from the compactor, its history from the
 *  `sessions/compact-*` records. */
export const compactionJob = (c: { status(): JobLive }): JobDecl => ({
    id: "sessions.compact-images",
    title: "Screenshot compaction",
    trigger: "15 s after saved sessions stop changing, when the browser starts, and every 6 hours",
    log: { subsystem: "sessions", start: "compact-pass", done: ["compact-pass-done"], failed: ["compact-images-failed"], also: ["compact-images"] },
    live: () => c.status(),
});

/** How many archived images one commit holds: a pass the worker is stopped in keeps every batch before it. */
export const ARCHIVE_COMPACT_BATCH = 8;

/**
 * The BACKFILL: the same lossless re-encode, over the screenshots already in the session archive, which were moved
 * there as PNG before compaction existed (or before a pass reached them). Batch by batch, each batch one archive
 * transaction (`replacePngs`, db.ts), until no PNG waits. Logged as a pass (`archive/image-compact`, then
 * `image-compact-done` or `image-compact-failed`); a pass the worker was stopped in resumes from what was committed.
 * Only the archive's images: a chat's `ml_session_` record is what a resume sends the MODEL, which stays PNG for the
 * reason the live store's history does.
 */
export function archiveImageCompactor(o: {
    /** One archive operation (`archiveCall`). */
    call: <T>(op: "pngs" | "replacePngs", args: unknown) => Promise<T>;
    encode?: (url: string) => Promise<string | null>;
    record?: (r: HousekeepingReport) => void;
    /** A pass replaced images: the months holding them are dirty, so the folder's files are worth rewriting. */
    onReplaced?: () => void;
    quietMs?: number;
    now?: () => number;
}): { kick(): void; pass(): Promise<void>; status(): JobLive } {
    const encode = o.encode ?? webpFromWorker, now = o.now ?? Date.now;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let dueAt: number | null = null;
    let running: Promise<void> | null = null;
    let pending: number | undefined;
    const run = async (): Promise<void> => {
        let first = await o.call<{ batch: { sha: string; url: string }[]; pending: number }>("pngs", { limit: ARCHIVE_COMPACT_BATCH });
        pending = first.pending;
        if (!first.batch.length) return;
        const t0 = now();
        let replaced = 0, kept = 0, saved = 0;
        o.record?.({ subsystem: "archive", kind: "image-compact", detail: { pending: first.pending } });
        try {
            for (let b: typeof first | null = first; b && b.batch.length; ) {
                const items: { sha: string; url: string | null }[] = [];
                for (const { sha, url } of b.batch) items.push({ sha, url: await encode(url) });
                const r = await o.call<{ replaced: number; kept: number; bytesBefore: number; bytesAfter: number; pending: number }>("replacePngs", { items });
                replaced += r.replaced; kept += r.kept; saved += r.bytesBefore - r.bytesAfter; pending = r.pending;
                b = r.pending ? await o.call<typeof first>("pngs", { limit: ARCHIVE_COMPACT_BATCH }) : null;
            }
        } catch (err) {
            if (replaced) o.onReplaced?.();
            o.record?.({ level: "warn", subsystem: "archive", kind: "image-compact-failed", ms: now() - t0, detail: { replaced, error: String((err as Error)?.message || err).slice(0, 200) } });
            return;
        }
        if (replaced) o.onReplaced?.();
        o.record?.({ subsystem: "archive", kind: "image-compact-done", bytes: saved, ms: now() - t0, detail: { replaced, kept } });
    };
    const pass = (): Promise<void> => {
        if (running) return running;
        const p = run().finally(() => { if (running === p) running = null; });
        running = p;
        return p;
    };
    return {
        kick() {
            if (timer) clearTimeout(timer);
            const ms = o.quietMs ?? COMPACT_QUIET_MS;
            dueAt = now() + ms;
            timer = setTimeout(() => { timer = null; dueAt = null; void pass(); }, ms);
        },
        pass,
        status: (): JobLive => ({
            running: running != null,
            ...(pending != null ? { pending, pendingLabel: pending === 1 ? "archived screenshot in PNG" : "archived screenshots in PNG" } : {}),
            ...(dueAt != null ? { nextDue: dueAt } : {}),
        }),
    };
}

/** The archive backfill as a background job (job-registry.ts). */
export const archiveCompactionJob = (c: { status(): JobLive }): JobDecl => ({
    id: "archive.compact-images",
    title: "Archive screenshot compaction",
    trigger: "when the browser starts with the archive on, and every 6 hours, until no archived screenshot is PNG",
    log: { subsystem: "archive", start: "image-compact", done: ["image-compact-done"], failed: ["image-compact-failed"] },
    live: () => c.status(),
});

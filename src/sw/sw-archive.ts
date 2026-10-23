// sw-archive.ts — the service worker's side of the session archive: one call, relayed through the offscreen document
// to the archive worker (archive-worker.ts), which holds the SQLite. The worker cannot run WASM, so everything the
// archive does happens there; this is the messenger.
import { ensureOffscreen, forgetOffscreen } from "./sw-offscreen";
import type { ArchiveOp, FolderReport } from "../archive/archive-worker";
import { recordHousekeeping } from "./sw-housekeeping";
import { defineJob } from "../job-registry";

/** Run one archive operation. Rejects with the archive's own message when it fails (no OPFS, a newer schema). */
export async function archiveCall<T>(op: ArchiveOp["op"], args?: ArchiveOp["args"]): Promise<T> {
    const send = () => ensureOffscreen().then(() => chrome.runtime.sendMessage({ type: "ARCHIVE_OP", op, args }) as Promise<{ ok: boolean; result?: unknown; error?: string; reason?: string } | undefined>);
    let r: { ok: boolean; result?: unknown; error?: string; reason?: string } | undefined;
    try { r = await send(); }
    catch (err) {
        // The offscreen document was torn down while the worker slept: recreate it, once.
        if (!/Receiving end does not exist|Could not establish connection/.test(String((err as Error)?.message || err))) throw err;
        forgetOffscreen();
        r = await send();
    }
    // `reason` is a BackupError's, kept so a caller can tell a missing key from a wrong one.
    if (!r?.ok) throw Object.assign(new Error(r?.error || "the archive did not answer"), r?.reason ? { reason: r.reason } : {});
    if (FOLDER_OPS.has(op)) noteFolder(r.result as FolderReport);
    return r.result as T;
}

/** The operations that answer with a `FolderReport`, so every one of them keeps `lastFolder` current. */
const FOLDER_OPS = new Set<string>(["folder", "sync", "resync", "import"]);

/** The folder's state as last reported, for the runtime's capabilities; null until the archive first answered. */
let lastFolder: FolderReport | null = null;
let folderListener: (() => void) | null = null;

function noteFolder(r: FolderReport | undefined): void {
    if (!r?.state) return;
    const was = lastFolder;
    lastFolder = r;
    if (!was || was.state !== r.state || was.pending !== r.pending || was.lastSync !== r.lastSync) folderListener?.();
}

/** The folder's last reported state, or null before the archive answered once. */
export function lastFolderReport(): FolderReport | null {
    return lastFolder;
}

/** Called when the folder's state, its pending months or its last sync change (one listener: the session server). */
export function onFolderChange(listener: () => void): void {
    folderListener = listener;
}

/** How long after an archive write the folder is synced: a burst of evictions then writes each month once. */
const SYNC_DEBOUNCE_MS = 30_000;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let syncDue: number | null = null; // state: plumbing (the job status's due time, lost with the timer it times)
let syncing = 0; // state: plumbing (syncs in flight, for the job status)

/**
 * Write the archive's month files to the folder (`sync`), or all of them after a new pick (`resync`), logged as a pass:
 * `folder-sync` when it starts, then `folder-sync-done` or `folder-sync-failed`. Only while a folder is connected:
 * with none picked, or its grant lapsed, a sync writes nothing and a record of it every 30 s would be noise. A sync
 * that wrote something is still recorded when the state was not known yet (the worker's first one).
 * @param op `sync` or `resync`
 * @param reason what started it: `write`, `alarm`, `settings` or `picked`
 */
export async function syncFolder(op: "sync" | "resync", reason: "write" | "alarm" | "settings" | "picked"): Promise<FolderReport> {
    const logged = lastFolder?.state === "connected";
    const t0 = Date.now();
    if (logged) recordHousekeeping({ subsystem: "archive", kind: "folder-sync", reason });
    syncing++;
    try {
        const r = await archiveCall<FolderReport>(op);
        const written = r.written?.length ?? 0, removed = r.removed?.length ?? 0;
        if (logged || written || removed) {
            recordHousekeeping({ subsystem: "archive", kind: "folder-sync-done", reason, ms: Date.now() - t0, detail: { written, removed, pending: r.pending, state: r.state } });
        }
        return r;
    } catch (e) {
        if (logged) recordHousekeeping({ level: "warn", subsystem: "archive", kind: "folder-sync-failed", reason, ms: Date.now() - t0, detail: { error: String((e as Error)?.message || e).slice(0, 200) } });
        throw e;
    } finally { syncing--; }
}

/** Sync the folder soon. Harmless when no folder is picked or its grant lapsed: the worker then writes nothing. */
export function scheduleFolderSync(): void {
    if (syncTimer) return;
    syncDue = Date.now() + SYNC_DEBOUNCE_MS;
    syncTimer = setTimeout(() => { syncTimer = null; syncDue = null; void syncFolder("sync", "write").catch(() => { /* retried at the next write or alarm */ }); }, SYNC_DEBOUNCE_MS);
}

defineJob({
    id: "archive.folder-sync",
    title: "Archive folder sync",
    trigger: "30 s after a session moves to the archive, every 6 hours, and from Settings",
    log: { subsystem: "archive", start: "folder-sync", done: ["folder-sync-done"], failed: ["folder-sync-failed"] },
    live: () => {
        const f = lastFolder;
        // No folder picked, or a browser that cannot have one: nothing waits for it, whatever the archive holds.
        if (!f || f.state === "none" || f.state === "unsupported") return { running: syncing > 0 };
        return {
            running: syncing > 0,
            pending: f.pending,
            pendingLabel: f.pending === 1 ? "month file to write" : "month files to write",
            ...(syncDue != null ? { nextDue: syncDue } : {}),
            ...(f.state === "needs-grant" && f.pending ? { blocked: "the archive folder needs its access granted again, in Settings" } : {}),
        };
    },
});

/** What Settings asks about the folder: its state, or an action taken after a click (a pick, a re-grant, an import),
 *  or what a just-picked folder already holds (`survey`) and starting fresh in it (`fresh`). */
export async function folderAction(action: unknown): Promise<FolderReport> {
    switch (action) {
        case "picked": return syncFolder("resync", "picked");
        case "sync": return syncFolder("sync", "settings");
        case "import": return archiveCall<FolderReport>("import");
        case "survey": return archiveCall<FolderReport>("survey");
        // "Start fresh" after a pick: the folder's old month files moved aside, then written as after any pick.
        case "fresh": return archiveCall<FolderReport>("fresh");
        default: return archiveCall<FolderReport>("folder");
    }
}

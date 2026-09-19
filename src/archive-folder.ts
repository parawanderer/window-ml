// archive-folder.ts — the folder a person picked for the session archive: where its handle is kept, what state its
// permission is in, and reading and writing the monthly files in it. Shared by the Settings page, which PICKS and
// RE-GRANTS (both need a click), and the archive worker, which writes and reads (no page has to be open for that, the
// probe showed, once the grant is live). chrome-free, so it runs in either.
//
// The folder holds one `YYYY-MM.sqlite` per month of activity: a standalone SQLite file anything can open, and the copy
// that survives a wiped browser profile. A file is rewritten only when its month changed (archive-db.ts dirty months),
// and `createWritable` replaces a file only on `close()`, so something syncing the folder never reads half a write.

/** Where the folder stands, as Settings draws it. */
export type FolderState =
    /** no folder picked */
    | "none"
    /** picked, and writable now */
    | "connected"
    /** picked, but the permission lapsed (a restart after "Allow this time"): one click re-grants it */
    | "needs-grant"
    /** this browser cannot pick a folder at all (Brave with its flag off, a managed policy, another browser) */
    | "unsupported";

const DB = "ml-archive-folder", STORE = "h", KEY = "dir";

function idb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const r = indexedDB.open(DB, 1);
        r.onupgradeneeded = () => r.result.createObjectStore(STORE);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
    });
}

/** Keep (or with null, forget) the picked folder's handle, where the page and the worker both find it. */
export async function saveFolder(handle: FileSystemDirectoryHandle | null): Promise<void> {
    const db = await idb();
    await new Promise<void>((resolve, reject) => {
        const t = db.transaction(STORE, "readwrite");
        if (handle) t.objectStore(STORE).put(handle, KEY); else t.objectStore(STORE).delete(KEY);
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
    });
    db.close();
}

/** The picked folder's handle, or null. */
export async function loadFolder(): Promise<FileSystemDirectoryHandle | null> {
    const db = await idb();
    const handle = await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
        const q = db.transaction(STORE).objectStore(STORE).get(KEY);
        q.onsuccess = () => resolve((q.result as FileSystemDirectoryHandle | undefined) ?? null);
        q.onerror = () => reject(q.error);
    });
    db.close();
    return handle;
}

/** A handle's permission, in the methods Chrome adds to it (the DOM typings do not have them yet). */
type Permissioned = FileSystemDirectoryHandle & {
    queryPermission(o: { mode: "readwrite" }): Promise<PermissionState>;
    requestPermission(o: { mode: "readwrite" }): Promise<PermissionState>;
};

/** Can this context pick a folder at all? Only a page can, and only where the browser offers the API. */
export function canPickFolder(): boolean {
    return typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";
}

/** The folder's state, from this context. `unsupported` only from a page, since no worker can ever pick. */
export async function folderState(): Promise<{ state: FolderState; name?: string }> {
    const handle = await loadFolder().catch(() => null);
    if (!handle) return { state: typeof window !== "undefined" && !canPickFolder() ? "unsupported" : "none" };
    const perm = await (handle as Permissioned).queryPermission({ mode: "readwrite" }).catch(() => "prompt" as PermissionState);
    return { state: perm === "granted" ? "connected" : "needs-grant", name: handle.name };
}

/** Ask the person to pick the folder (a page, inside a click). Resolves with its name, or null when they cancelled. */
export async function pickFolder(): Promise<string | null> {
    const pick = (globalThis as unknown as { showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
    try {
        const handle = await pick({ mode: "readwrite", id: "wml-archive" });
        await saveFolder(handle);
        return handle.name;
    } catch (err) {
        if ((err as Error)?.name === "AbortError") return null;
        throw err;
    }
}

/** Re-grant a lapsed permission (a page, inside a click). True when it is granted now. */
export async function regrantFolder(): Promise<boolean> {
    const handle = await loadFolder();
    if (!handle) return false;
    return (await (handle as Permissioned).requestPermission({ mode: "readwrite" })) === "granted";
}

/** The folder, when it is writable from here; null otherwise. */
export async function writableFolder(): Promise<FileSystemDirectoryHandle | null> {
    const { state } = await folderState();
    return state === "connected" ? loadFolder() : null;
}

const MONTH_FILE = /^(\d{4}-\d{2})\.sqlite$/;

/** Write one month's file. It replaces the old one only when the write completes. */
export async function writeMonthFile(dir: FileSystemDirectoryHandle, month: string, bytes: Uint8Array): Promise<void> {
    const file = await dir.getFileHandle(`${month}.sqlite`, { create: true });
    const w = await file.createWritable();
    try { await w.write(bytes as Uint8Array<ArrayBuffer>); await w.close(); }
    catch (err) { await w.abort().catch(() => {}); throw err; }
}

/** Every month file in the folder, oldest first, with its bytes read when asked. */
export async function monthFiles(dir: FileSystemDirectoryHandle): Promise<{ month: string; read: () => Promise<Uint8Array> }[]> {
    const out: { month: string; read: () => Promise<Uint8Array> }[] = [];
    for await (const [name, h] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
        const m = MONTH_FILE.exec(name);
        if (!m || h.kind !== "file") continue;
        out.push({ month: m[1], read: async () => new Uint8Array(await (await (h as FileSystemFileHandle).getFile()).arrayBuffer()) });
    }
    return out.sort((a, b) => a.month.localeCompare(b.month));
}

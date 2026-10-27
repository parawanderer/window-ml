// archive-folder.ts — the folder a person picked for the session archive: where its handle is kept, what state its
// permission is in, and reading and writing the monthly files in it. Shared by the Settings page, which PICKS and
// RE-GRANTS (both need a click), and the archive worker, which writes and reads (no page has to be open for that, the
// probe showed, once the grant is live). chrome-free, so it runs in either.
//
// The folder holds one file per month of activity, in the form the archive is set to (`YYYY-MM.wmlbak` encrypted,
// `.sqlite.gz` compressed, `.sqlite` plain; a month may briefly hold several): the copy that survives a wiped
// browser profile. A file is rewritten only when its month changed (archive-db.ts dirty months), and `createWritable` replaces a file only on `close()`, so
// something syncing the folder never reads half a write.

import { BACKUP_EXTENSION, type BackupForm } from "../backup/backup-file";

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
        // Opens in Documents the first time (a page cannot create or preselect a path such as ~/.windowml, and the
        // browser refuses the home folder itself); `id` makes it open where it was last used after that.
        const handle = await pick({ mode: "readwrite", id: "wml-archive", startIn: "documents" });
        await saveFolder(handle);
        return handle.name;
    } catch (err) {
        if ((err as Error)?.name === "AbortError") return null;
        throw err;
    }
}

/** Where a page remembers HOW MANY TIMES the folder has been reconnected. Page-side (extension pages share the
 *  origin), because only a page can re-grant, and the question is only ever asked by one.
 *
 *  A count rather than a flag, because one re-grant and two mean different things. After one, the likely story is
 *  that the browser's "allow this time" was chosen and the lasting option is worth naming. After two, that advice
 *  has been followed and the grant lapsed anyway: this browser does not keep it, whatever is chosen, and saying so
 *  is the only honest thing left. (Earlier builds stored a timestamp here; it reads back as one.) */
const REGRANTED_KEY = "wml-archive-regranted";

/** Re-grant a lapsed permission (a page, inside a click). True when it is granted now. */
export async function regrantFolder(): Promise<boolean> {
    const handle = await loadFolder();
    if (!handle) return false;
    const ok = (await (handle as Permissioned).requestPermission({ mode: "readwrite" })) === "granted";
    // Counted, because the browser never says which answer was given: "Allow this time" and "Allow on every visit"
    // both come back `granted`. What the count buys is in REGRANTED_KEY.
    if (ok) try { localStorage.setItem(REGRANTED_KEY, String(regrantCount() + 1)); } catch { /* storage unavailable */ }
    return ok;
}

/** How many times this browser's folder has been reconnected. Each one that lapsed again says something more. */
export function regrantCount(): number {
    try {
        const raw = localStorage.getItem(REGRANTED_KEY);
        if (!raw) return 0;
        // An earlier build wrote a timestamp. It means "once", and a count never reaches those numbers honestly.
        const n = Number(raw);
        return !Number.isFinite(n) || n > 1e6 ? 1 : Math.max(1, Math.round(n));
    } catch { return 0; }
}

/** The folder, when it is writable from here; null otherwise. */
export async function writableFolder(): Promise<FileSystemDirectoryHandle | null> {
    const { state } = await folderState();
    return state === "connected" ? loadFolder() : null;
}

/** A month file's name: `YYYY-MM.sqlite`, `.sqlite.gz` or `.wmlbak` by form (`BACKUP_EXTENSION`). */
const MONTH_FILE = /^(\d{4}-\d{2})\.(sqlite\.gz|sqlite|wmlbak)$/;
const FORM_OF_EXTENSION = Object.fromEntries(Object.entries(BACKUP_EXTENSION).map(([form, ext]) => [ext, form])) as Record<string, BackupForm>;
const fileName = (month: string, form: BackupForm) => `${month}.${BACKUP_EXTENSION[form]}`;

/** Write one month's file in one form. It replaces the old one only when the write completes. */
export async function writeMonthFile(dir: FileSystemDirectoryHandle, month: string, form: BackupForm, bytes: Uint8Array): Promise<void> {
    const file = await dir.getFileHandle(fileName(month, form), { create: true });
    const w = await file.createWritable();
    try { await w.write(bytes as Uint8Array<ArrayBuffer>); await w.close(); }
    catch (err) { await w.abort().catch(() => {}); throw err; }
}

/** Every month file in the folder, oldest first (a month's forms together), with its bytes read when asked. */
export async function monthFiles(dir: FileSystemDirectoryHandle): Promise<{ month: string; form: BackupForm; read: () => Promise<Uint8Array> }[]> {
    const out: { month: string; form: BackupForm; read: () => Promise<Uint8Array> }[] = [];
    for await (const [name, h] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
        const m = MONTH_FILE.exec(name);
        if (!m || h.kind !== "file") continue;
        out.push({ month: m[1], form: FORM_OF_EXTENSION[m[2]], read: async () => new Uint8Array(await (await (h as FileSystemFileHandle).getFile()).arrayBuffer()) });
    }
    return out.sort((a, b) => a.month.localeCompare(b.month) || a.form.localeCompare(b.form));
}

/** The picked directory as a sync sees it (folder-sync.ts): its month files by `YYYY-MM` and form. */
export function monthFolder(dir: FileSystemDirectoryHandle): import("./folder-sync").MonthFolder {
    return {
        months: async () => [...new Set((await monthFiles(dir)).map((f) => f.month))],
        forms: async (month) => (await monthFiles(dir)).filter((f) => f.month === month).map((f) => f.form),
        read: async (month, form) => {
            const file = await dir.getFileHandle(fileName(month, form)).catch(() => null);
            return file ? new Uint8Array(await (await file.getFile()).arrayBuffer()) : null;
        },
        write: (month, form, bytes) => writeMonthFile(dir, month, form, bytes),
        remove: (month, form) => dir.removeEntry(fileName(month, form)).catch(() => { /* never written */ }),
    };
}

/**
 * "Start fresh" in a folder that already holds month files: move them into a subfolder (`earlier-YYYY-MM-DD`, with a
 * number added when that exists) rather than delete or overwrite anything. A copy, then the original removed only
 * once its copy is completely written; a file of every form moves. Returns the subfolder's name and how many files went into it.
 */
export async function moveMonthFilesAside(dir: FileSystemDirectoryHandle, now = new Date()): Promise<{ folder: string; files: number }> {
    const files = await monthFiles(dir);
    const base = `earlier-${now.toISOString().slice(0, 10)}`;
    let name = base;
    for (let n = 2; await dir.getDirectoryHandle(name).then(() => true, () => false); n++) name = `${base}-${n}`;
    if (!files.length) return { folder: name, files: 0 };
    const aside = await dir.getDirectoryHandle(name, { create: true });
    for (const f of files) {
        await writeMonthFile(aside, f.month, f.form, await f.read());
        await dir.removeEntry(fileName(f.month, f.form));
    }
    return { folder: name, files: files.length };
}

// folder-sync.ts — what a sync of the archive folder DOES, over any folder of month files: merge each month's files into
// the archive before rewriting it, so a sync never drops a session the folder held (docs/dev/backup.md, "merge before
// write"), and write the month in the form the archive is set to (`folder_form`), removing the other forms' files of it.
// The folder is an interface, so the rule is tested in Node against a Map (tests/folder-sync.test.mjs); the worker hands
// it the picked directory (archive-folder.ts `monthFolder`).
//
// Without the merge, a new browser pointed at an old machine's folder replaced every month the two shared with its
// own sessions alone, at the first sync after anything was archived into that month.
import type { Database, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { allMonths, dirtyMonths, expireRemoved, exportMonth, folderFilesGet, folderFilesMonths, folderFilesSet, markAllDirty, markClean, metaGet, markMonthDirty, mergeBytes, metaSet, wasmDb, type ArchiveDb, type FileStat } from "./db";
import { sealBackup, type BackupForm } from "../backup/backup-file";
import { BackupError, keyFor, readAnyForm, readHeader, sniff, type Keyring } from "../backup/backup-format";

/** A folder of month files, as a sync reads and writes it: a month may have one file in each `BackupForm`. */
export interface MonthFolder {
    /** every month that has at least one file, oldest first, each once */
    months(): Promise<string[]>;
    /** the forms a month has a file in */
    forms(month: string): Promise<BackupForm[]>;
    /** a month's file in one form, or null when it has none */
    read(month: string, form: BackupForm): Promise<Uint8Array | null>;
    /** replace a month's file in one form, only once the whole of it is written */
    write(month: string, form: BackupForm, bytes: Uint8Array): Promise<void>;
    /** a month's file in one form: its size and modification time, read without its bytes; null when there is none */
    stat(month: string, form: BackupForm): Promise<FileStat | null>;
    /** remove a month's file in one form; nothing when there is none */
    remove(month: string, form: BackupForm): Promise<void>;
}

/** Why a month's file could not be taken in: the section acts on this, not on the message. */
export type SkipReason =
    /** encrypted, and this install has no keyring */
    | "needs-key"
    /** encrypted under a different data key than this install's */
    | "other-key"
    /** anything else: damaged, truncated, not an archive */
    | "unreadable";

/** What a sync or an import did. */
export interface SyncOutcome {
    written: string[];
    removed: string[];
    /** sessions taken INTO the archive from the folder's files: a merge, or an import */
    merged: number;
    /** sessions REMOVED from the archive because a folder file carries a newer delete of them (part 3b) */
    deleted: number;
    /** months with a file that could not be read, left as they were and still dirty, with why; `keyId` names the key of an encrypted file (part 3c) */
    skipped: { month: string; reason: SkipReason; error: string; keyId?: string }[];
}

/** The SQLite handles the import and export need. */
export interface ArchiveHandles { sqlite3: Sqlite3Static; raw: Database }

/** What a sync writes and reads with: the form to write, and the install's keyring for encrypted files. */
export interface FolderOptions {
    /** null while unchosen: a sync then writes nothing (`folderFormOf`) */
    form: BackupForm | null;
    keyring: Keyring | null;
    /** the clock, for the 180-day expiry of `removed` entries (`REMOVED_TTL_MS`); tests inject it */
    now?: number;
}

const PLAIN: FolderOptions = { form: "plain", keyring: null };
const FORMS: readonly BackupForm[] = ["plain", "gzip", "encrypted"];

/** `meta` key of the form the archive folder is written in. */
const FORM_KEY = "folder_form";

/**
 * The form the archive folder is written in, or null while it is UNCHOSEN: no `folder_form` and no `last_sync`. An
 * archive that never synced never had a folder, so nothing was written plain on its owner's say, and a new folder
 * writes nothing until its form is chosen. An archive from before the setting that had a folder synced at its pick, so
 * it reads as `plain`, which is what it was writing: nothing changes on someone's machine until they choose.
 */
export function folderFormOf(db: ArchiveDb): BackupForm | null {
    const v = metaGet(db, FORM_KEY);
    if (FORMS.includes(v as BackupForm)) return v as BackupForm;
    return metaGet(db, "last_sync") ? "plain" : null;
}

/**
 * Set the form the folder is written in, and mark every month dirty so the next sync rewrites the folder in it.
 * @throws `needs-key` for `encrypted` with no keyring; nothing is changed then
 */
export function setFolderForm(db: ArchiveDb, form: BackupForm, keyring: Keyring | null): void {
    if (!FORMS.includes(form)) throw new BackupError("unknown-form", `"${form}" is not a form the folder can be written in`);
    if (form === "encrypted" && !keyring) throw new BackupError("needs-key", "set a backup passphrase first: an encrypted folder needs this install's key");
    metaSet(db, FORM_KEY, form);
    markAllDirty(db);
}

/** A month file's plain SQLite bytes, or why it cannot be had. */
async function openFile(bytes: Uint8Array, keyring: Keyring | null): Promise<{ plain: Uint8Array } | { reason: SkipReason; error: string; keyId?: string }> {
    try {
        if (sniff(bytes) === "wmlbak") {
            const keyId = readHeader(bytes).keyId;
            if (!keyring) return { reason: "needs-key", error: "this month is encrypted and this install has no backup key", keyId };
            if (!keyFor(keyring, keyId)) return { reason: "other-key", error: "this month is encrypted with another install's key", keyId };
        }
        return { plain: await readAnyForm(bytes, async () => keyring!) };
    } catch (e) { return { reason: "unreadable", error: String((e as Error)?.message || e).slice(0, 200) }; }
}

/**
 * Take every file of one month into the archive with its deletes (`mergeBytes`), whatever its form, or say why not. Every file is opened before any is
 * imported; one that cannot be read means the month is skipped and none of its files is touched.
 * @returns `forms`: the forms whose files were read, which a write may replace
 */
async function mergeMonth(h: ArchiveHandles, folder: MonthFolder, month: string, keyring: Keyring | null): Promise<{ merged: number; deleted: number; entries: number; forms: BackupForm[]; skip?: { reason: SkipReason; error: string; keyId?: string } }> {
    const opened: { form: BackupForm; plain: Uint8Array }[] = [];
    for (const form of await folder.forms(month)) {
        const bytes = await folder.read(month, form);
        if (!bytes) continue;
        const o = await openFile(bytes, keyring);
        if ("reason" in o) return { merged: 0, deleted: 0, entries: 0, forms: [], skip: o };
        opened.push({ form, plain: o.plain });
    }
    let merged = 0, deleted = 0, entries = 0;
    for (const o of opened) {
        try { const r = mergeBytes(h.sqlite3, h.raw, o.plain); merged += r.added; deleted += r.deleted; entries += r.entries; }
        catch (e) { return { merged, deleted, entries, forms: [], skip: { reason: "unreadable", error: String((e as Error)?.message || e).slice(0, 200) } }; }
    }
    return { merged, deleted, entries, forms: opened.map((o) => o.form) };
}

/** The forms a month has files in, with what the folder reports of each. */
async function statsOf(folder: MonthFolder, month: string): Promise<{ forms: BackupForm[]; stats: Record<string, FileStat> }> {
    const forms: BackupForm[] = [], stats: Record<string, FileStat> = {};
    for (const f of await folder.forms(month)) {
        const st = await folder.stat(month, f);
        if (st) { forms.push(f); stats[f] = st; }
    }
    return { forms, stats };
}

const sameStats = (a: Record<string, FileStat>, b: Record<string, FileStat>): boolean => {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => b[k] && b[k].size === a[k].size && b[k].lastModified === a[k].lastModified);
};

/**
 * Merge every month whose files differ from what the archive last saw of them (a new file, a changed one, a removed
 * one; none remembered counts as changed), and mark it dirty only when the merge changed the archive (sessions added
 * or removed, an entry added or dropped) or the folder lost the month's
 * file while the archive still has something for it. A merge that changed nothing only records the stats: a month is
 * never rewritten just because it was touched, or two machines would rewrite each other's files for ever. A month
 * that cannot be read is skipped, as a dirty one is, and its stats are not recorded.
 */
async function mergeChanged(h: ArchiveHandles, folder: MonthFolder, o: FolderOptions, out: SyncOutcome): Promise<void> {
    const db = wasmDb(h.raw);
    const dirty = new Set(dirtyMonths(db));
    const held = new Set(allMonths(db));
    for (const month of [...new Set([...await folder.months(), ...folderFilesMonths(db)])].sort()) {
        if (dirty.has(month)) continue;   // its own pass merges it
        const cur = await statsOf(folder, month);
        if (sameStats(cur.stats, folderFilesGet(db, month))) continue;
        const m = await mergeMonth(h, folder, month, o.keyring);
        if (m.skip) { out.skipped.push({ month, ...m.skip }); continue; }
        out.merged += m.merged;
        out.deleted += m.deleted;
        const rewrite = m.merged || m.deleted || m.entries || (!cur.forms.length && held.has(month));
        if (rewrite) markMonthDirty(db, month);
        else folderFilesSet(db, month, cur.stats);
    }
}

/**
 * Write every dirty month into the folder in `o.form`, each MERGED first: sessions its files hold (in any form) and the
 * archive does not (and did not remove on purpose) are imported, then the month is written from the archive, and only
 * then are the month's files in the other forms removed. A month left with neither sessions nor `removed` entries has
 * every form's file removed; one with only entries keeps a file holding just those, so the delete reaches the other
 * machine (part 3b). Entries older than `REMOVED_TTL_MS` are dropped first and are never written. A month with
 * a file that cannot be read is left alone and stays dirty, so a sync can never destroy what it could not read.
 * @throws `needs-key` for `encrypted` with no keyring, before anything is written
 */
export async function syncMonths(h: ArchiveHandles, folder: MonthFolder, o: FolderOptions = PLAIN): Promise<SyncOutcome> {
    if (o.form === "encrypted" && !o.keyring) throw new BackupError("needs-key", "set a backup passphrase first: an encrypted folder needs this install's key");
    const db = wasmDb(h.raw);
    const out: SyncOutcome = { written: [], removed: [], merged: 0, deleted: 0, skipped: [] };
    // Unchosen: nothing is written or removed, and every dirty month stays pending until `setFolderForm`.
    if (!o.form) return out;
    const now = o.now ?? Date.now();
    expireRemoved(db, now);   // before the list is read: the months it dirties are rewritten in this sync
    await mergeChanged(h, folder, o, out);
    for (const month of dirtyMonths(db)) {
        const m = await mergeMonth(h, folder, month, o.keyring);
        out.merged += m.merged;
        out.deleted += m.deleted;
        if (m.skip) { out.skipped.push({ month, ...m.skip }); continue; }
        expireRemoved(db, now);   // a file may have carried an entry that is already old
        const { bytes, sessions, removed } = exportMonth(h.sqlite3, h.raw, month, now);
        if (sessions || removed) {
            await folder.write(month, o.form, await sealBackup(bytes, o.form, o.keyring, new Date(), "archive-month"));
            for (const f of m.forms) if (f !== o.form) await folder.remove(month, f);
            const st = await folder.stat(month, o.form);
            folderFilesSet(db, month, st ? { [o.form]: st } : {});
            out.written.push(month);
        } else {
            for (const f of m.forms) await folder.remove(month, f);
            folderFilesSet(db, month, {});
            out.removed.push(month);
        }
        markClean(db, month);
    }
    return out;
}

/** Import every month file in the folder: an explicit Import, and the first step after a folder is picked. */
export async function importMonths(h: ArchiveHandles, folder: MonthFolder, keyring: Keyring | null = null): Promise<{ files: number; sessions: number; deleted: number; skipped: SyncOutcome["skipped"] }> {
    let files = 0, sessions = 0, deleted = 0;
    const skipped: SyncOutcome["skipped"] = [];
    for (const month of await folder.months()) {
        const m = await mergeMonth(h, folder, month, keyring);
        sessions += m.merged;
        deleted += m.deleted;
        if (m.skip) { skipped.push({ month, ...m.skip }); continue; }
        folderFilesSet(wasmDb(h.raw), month, (await statsOf(folder, month)).stats);
        files++;
    }
    return { files, sessions, deleted, skipped };
}

/**
 * A folder was just picked: take in what it already holds, then write every month the archive has. Importing first
 * is what makes picking an old machine's folder safe even where nobody was asked (a fix started from an attention
 * card, a remote runtime's Settings).
 */
export async function adoptFolder(h: ArchiveHandles, folder: MonthFolder, o: FolderOptions = PLAIN): Promise<SyncOutcome & { imported: { files: number; sessions: number; deleted: number } }> {
    const imp = await importMonths(h, folder, o.keyring);
    markAllDirty(wasmDb(h.raw));
    const out = await syncMonths(h, folder, o);
    return { ...out, deleted: out.deleted + imp.deleted, skipped: [...imp.skipped, ...out.skipped.filter((s) => !imp.skipped.some((i) => i.month === s.month))], imported: { files: imp.files, sessions: imp.sessions, deleted: imp.deleted } };
}

/** What a folder already holds, before anything is written to it: asked right after a pick. */
export async function surveyFolder(folder: MonthFolder): Promise<{ files: number; first?: string; last?: string }> {
    const months = await folder.months();
    return months.length ? { files: months.length, first: months[0], last: months[months.length - 1] } : { files: 0 };
}


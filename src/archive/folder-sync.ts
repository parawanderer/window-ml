// folder-sync.ts — what a sync of the archive folder DOES, over any folder of month files: merge each month's files into
// the archive before rewriting it, so a sync never drops a session the folder held (docs/dev/backup.md, "merge before
// write"), and write the month in the form the archive is set to (`folder_form`), removing the other forms' files of it.
// The folder is an interface, so the rule is tested in Node against a Map (tests/folder-sync.test.mjs); the worker hands
// it the picked directory (archive-folder.ts `monthFolder`).
//
// Without the merge, a new browser pointed at an old machine's folder replaced every month the two shared with its
// own sessions alone, at the first sync after anything was archived into that month.
import type { Database, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { dirtyMonths, exportMonth, importBytes, markAllDirty, markClean, metaGet, metaSet, wasmDb, type ArchiveDb } from "./db";
import { sealBackup, type BackupForm } from "../backup/backup-file";
import { BackupError, readAnyForm, readHeader, sniff, type Keyring } from "../backup/backup-format";

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
    /** months with a file that could not be read, left as they were and still dirty, with why */
    skipped: { month: string; reason: SkipReason; error: string }[];
}

/** The SQLite handles the import and export need. */
export interface ArchiveHandles { sqlite3: Sqlite3Static; raw: Database }

/** What a sync writes and reads with: the form to write, and the install's keyring for encrypted files. */
export interface FolderOptions {
    form: BackupForm;
    keyring: Keyring | null;
}

const PLAIN: FolderOptions = { form: "plain", keyring: null };
const FORMS: readonly BackupForm[] = ["plain", "gzip", "encrypted"];

/** `meta` key of the form the archive folder is written in. */
const FORM_KEY = "folder_form";

/** The form the archive folder is written in: `plain` when unset, which is what an archive from before the setting wrote. */
export function folderFormOf(db: ArchiveDb): BackupForm {
    const v = metaGet(db, FORM_KEY);
    return FORMS.includes(v as BackupForm) ? (v as BackupForm) : "plain";
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
async function openFile(bytes: Uint8Array, keyring: Keyring | null): Promise<{ plain: Uint8Array } | { reason: SkipReason; error: string }> {
    try {
        if (sniff(bytes) === "wmlbak") {
            const keyId = readHeader(bytes).keyId;
            if (!keyring) return { reason: "needs-key", error: "this month is encrypted and this install has no backup key" };
            if (keyId !== keyring.keyId) return { reason: "other-key", error: "this month is encrypted with another install's key" };
        }
        return { plain: await readAnyForm(bytes, async () => keyring!) };
    } catch (e) { return { reason: "unreadable", error: String((e as Error)?.message || e).slice(0, 200) }; }
}

/**
 * Take every file of one month into the archive, whatever its form, or say why not. Every file is opened before any is
 * imported; one that cannot be read means the month is skipped and none of its files is touched.
 * @returns `forms`: the forms whose files were read, which a write may replace
 */
async function mergeMonth(h: ArchiveHandles, folder: MonthFolder, month: string, keyring: Keyring | null): Promise<{ merged: number; forms: BackupForm[]; skip?: { reason: SkipReason; error: string } }> {
    const opened: { form: BackupForm; plain: Uint8Array }[] = [];
    for (const form of await folder.forms(month)) {
        const bytes = await folder.read(month, form);
        if (!bytes) continue;
        const o = await openFile(bytes, keyring);
        if ("reason" in o) return { merged: 0, forms: [], skip: o };
        opened.push({ form, plain: o.plain });
    }
    let merged = 0;
    for (const o of opened) {
        try { merged += importBytes(h.sqlite3, h.raw, o.plain); }
        catch (e) { return { merged, forms: [], skip: { reason: "unreadable", error: String((e as Error)?.message || e).slice(0, 200) } }; }
    }
    return { merged, forms: opened.map((o) => o.form) };
}

/**
 * Write every dirty month into the folder in `o.form`, each MERGED first: sessions its files hold (in any form) and the
 * archive does not (and did not remove on purpose) are imported, then the month is written from the archive, and only
 * then are the month's files in the other forms removed. A month left empty has every form's file removed. A month with
 * a file that cannot be read is left alone and stays dirty, so a sync can never destroy what it could not read.
 * @throws `needs-key` for `encrypted` with no keyring, before anything is written
 */
export async function syncMonths(h: ArchiveHandles, folder: MonthFolder, o: FolderOptions = PLAIN): Promise<SyncOutcome> {
    if (o.form === "encrypted" && !o.keyring) throw new BackupError("needs-key", "set a backup passphrase first: an encrypted folder needs this install's key");
    const db = wasmDb(h.raw);
    const out: SyncOutcome = { written: [], removed: [], merged: 0, skipped: [] };
    for (const month of dirtyMonths(db)) {
        const m = await mergeMonth(h, folder, month, o.keyring);
        out.merged += m.merged;
        if (m.skip) { out.skipped.push({ month, ...m.skip }); continue; }
        const { bytes, sessions } = exportMonth(h.sqlite3, h.raw, month);
        if (sessions) {
            await folder.write(month, o.form, await sealBackup(bytes, o.form, o.keyring, new Date(), "archive-month"));
            for (const f of m.forms) if (f !== o.form) await folder.remove(month, f);
            out.written.push(month);
        } else {
            for (const f of m.forms) await folder.remove(month, f);
            out.removed.push(month);
        }
        markClean(db, month);
    }
    return out;
}

/** Import every month file in the folder: an explicit Import, and the first step after a folder is picked. */
export async function importMonths(h: ArchiveHandles, folder: MonthFolder, keyring: Keyring | null = null): Promise<{ files: number; sessions: number; skipped: SyncOutcome["skipped"] }> {
    let files = 0, sessions = 0;
    const skipped: SyncOutcome["skipped"] = [];
    for (const month of await folder.months()) {
        const m = await mergeMonth(h, folder, month, keyring);
        sessions += m.merged;
        if (m.skip) { skipped.push({ month, ...m.skip }); continue; }
        files++;
    }
    return { files, sessions, skipped };
}

/**
 * A folder was just picked: take in what it already holds, then write every month the archive has. Importing first
 * is what makes picking an old machine's folder safe even where nobody was asked (a fix started from an attention
 * card, a remote runtime's Settings).
 */
export async function adoptFolder(h: ArchiveHandles, folder: MonthFolder, o: FolderOptions = PLAIN): Promise<SyncOutcome & { imported: { files: number; sessions: number } }> {
    const imp = await importMonths(h, folder, o.keyring);
    markAllDirty(wasmDb(h.raw));
    const out = await syncMonths(h, folder, o);
    return { ...out, skipped: [...imp.skipped, ...out.skipped.filter((s) => !imp.skipped.some((i) => i.month === s.month))], imported: { files: imp.files, sessions: imp.sessions } };
}

/** What a folder already holds, before anything is written to it: asked right after a pick. */
export async function surveyFolder(folder: MonthFolder): Promise<{ files: number; first?: string; last?: string }> {
    const months = await folder.months();
    return months.length ? { files: months.length, first: months[0], last: months[months.length - 1] } : { files: 0 };
}


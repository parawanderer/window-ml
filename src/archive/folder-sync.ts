// folder-sync.ts — what a sync of the archive folder DOES, over any folder of month files: merge each month's file into
// the archive before rewriting it, so a sync never drops a session the folder held (docs/dev/backup.md, "merge before
// write"). The folder is an interface, so the rule is tested in Node against a Map (tests/folder-sync.test.mjs); the
// worker hands it the picked directory (archive-folder.ts `monthFolder`).
//
// Without the merge, a new browser pointed at an old machine's folder replaced every month the two shared with its
// own sessions alone, at the first sync after anything was archived into that month.
import type { Database, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { dirtyMonths, exportMonth, importBytes, markAllDirty, markClean, wasmDb } from "./db";

/** A folder of `YYYY-MM` month files, as a sync reads and writes it. */
export interface MonthFolder {
    /** every month that has a file, oldest first */
    months(): Promise<string[]>;
    /** a month file's bytes, or null when it has none */
    read(month: string): Promise<Uint8Array | null>;
    /** replace a month's file, only once the whole of it is written */
    write(month: string, bytes: Uint8Array): Promise<void>;
    /** remove a month's file; nothing when there is none */
    remove(month: string): Promise<void>;
}

/** What a sync or an import did. */
export interface SyncOutcome {
    written: string[];
    removed: string[];
    /** sessions taken INTO the archive from the folder's files: a merge, or an import */
    merged: number;
    /** months whose file could not be read as an archive, left as they were and still dirty, with why */
    skipped: { month: string; error: string }[];
}

/** The SQLite handles the import and export need. */
export interface ArchiveHandles { sqlite3: Sqlite3Static; raw: Database }

/** Take one month file into the archive, or say why not. A file that cannot be read is never overwritten. */
async function mergeMonth(h: ArchiveHandles, folder: MonthFolder, month: string): Promise<{ merged: number } | { error: string }> {
    const bytes = await folder.read(month);
    if (!bytes) return { merged: 0 };
    try { return { merged: importBytes(h.sqlite3, h.raw, bytes) }; }
    catch (e) { return { error: String((e as Error)?.message || e).slice(0, 200) }; }
}

/**
 * Write every dirty month into the folder, each MERGED first: sessions its file holds and the archive does not (and
 * did not remove on purpose) are imported, then the month is written from the archive. A month left empty has its
 * file removed. A file that is not a readable archive is left alone and its month stays dirty, so a sync can never
 * destroy what it could not read.
 */
export async function syncMonths(h: ArchiveHandles, folder: MonthFolder): Promise<SyncOutcome> {
    const db = wasmDb(h.raw);
    const out: SyncOutcome = { written: [], removed: [], merged: 0, skipped: [] };
    for (const month of dirtyMonths(db)) {
        const m = await mergeMonth(h, folder, month);
        if ("error" in m) { out.skipped.push({ month, error: m.error }); continue; }
        out.merged += m.merged;
        const { bytes, sessions } = exportMonth(h.sqlite3, h.raw, month);
        if (sessions) { await folder.write(month, bytes); out.written.push(month); }
        else { await folder.remove(month); out.removed.push(month); }
        markClean(db, month);
    }
    return out;
}

/** Import every month file in the folder: an explicit Import, and the first step after a folder is picked. */
export async function importMonths(h: ArchiveHandles, folder: MonthFolder): Promise<{ files: number; sessions: number; skipped: SyncOutcome["skipped"] }> {
    let files = 0, sessions = 0;
    const skipped: SyncOutcome["skipped"] = [];
    for (const month of await folder.months()) {
        const m = await mergeMonth(h, folder, month);
        if ("error" in m) { skipped.push({ month, error: m.error }); continue; }
        files++; sessions += m.merged;
    }
    return { files, sessions, skipped };
}

/**
 * A folder was just picked: take in what it already holds, then write every month the archive has. Importing first
 * is what makes picking an old machine's folder safe even where nobody was asked (a fix started from an attention
 * card, a remote runtime's Settings).
 */
export async function adoptFolder(h: ArchiveHandles, folder: MonthFolder): Promise<SyncOutcome & { imported: { files: number; sessions: number } }> {
    const imp = await importMonths(h, folder);
    markAllDirty(wasmDb(h.raw));
    const out = await syncMonths(h, folder);
    return { ...out, skipped: [...imp.skipped, ...out.skipped.filter((s) => !imp.skipped.some((i) => i.month === s.month))], imported: { files: imp.files, sessions: imp.sessions } };
}

/** What a folder already holds, before anything is written to it: asked right after a pick. */
export async function surveyFolder(folder: MonthFolder): Promise<{ files: number; first?: string; last?: string }> {
    const months = await folder.months();
    return months.length ? { files: months.length, first: months[0], last: months[months.length - 1] } : { files: 0 };
}


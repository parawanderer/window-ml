// archive-worker.ts — the session archive's SQLite, in a DEDICATED WORKER the offscreen document starts
// (offscreen.ts). The database lives in the origin-private file system through the `opfs-sahpool` VFS: its fast file
// handles exist only in a dedicated worker and only on OPFS (a folder a person picked has none), and unlike the plain
// `opfs` VFS it needs no cross-origin isolation, which an extension page cannot easily have.
//
// One connection, held for the worker's life: the pool VFS allows one per origin, and this worker is the only thing
// that opens it. Requests arrive as `{ id, op, args }` and are answered in order, so a write and the read after it can
// never race. The SQL is archive-db.ts, tested in Node; this file is the plumbing around it.
//
// chrome-free, like python-worker.ts: the wasm is found next to this script's own URL.
import sqlite3InitModule, { type Database, type Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { archiveStats, dirtyMonths, listArchived, markAllDirty, metaGet, metaSet, migrate, pngBatch, pngPending, prepareSession, readArchived, removeArchived, replacePngs, wasmDb, writeSession, type ArchiveDb, type ArchiveInput } from "./db";
import { folderState, monthFolder, moveMonthFilesAside, writableFolder, type FolderState } from "./archive-folder";
import { adoptFolder, importMonths, surveyFolder, syncMonths, type SyncOutcome } from "./folder-sync";
import { abandonBackup, addSession, beginBackup, finishBackup, inspectRestore, openBackupBytes, restoreNewSessions, sealBackup, type BackupBuild, type BackupForm, type RestoreInspection } from "../backup/backup-file";
import { idbKeyringStore, loadKeyring } from "../backup/backup-keyring";
import { readBackupSlot, removeBackupSlot, writeBackupSlot, type BackupSlot } from "../backup/backup-opfs";
import type { BackupError, Secret } from "../backup/backup-format";

/** The operations this worker answers, and what each takes. */
export type ArchiveOp =
    | { op: "put"; args: { input: ArchiveInput; archivedTs: number } }
    | { op: "list"; args: { before?: number; limit?: number; query?: string } }
    | { op: "read"; args: { hash: string } }
    | { op: "remove"; args: { hash: string } }
    | { op: "stats"; args?: undefined }
    | { op: "export"; args?: undefined }
    /** the folder's state, how many month files wait to be written, and when it was last written */
    | { op: "folder"; args?: undefined }
    /** write every dirty month into the folder, when it is writable */
    | { op: "sync"; args?: undefined }
    /** a folder was just picked: import what it holds, then every month is dirty, then sync */
    | { op: "resync"; args?: undefined }
    /** a folder was just picked and the person chose to start fresh: its month files moved aside, then as `resync` */
    | { op: "fresh"; args?: undefined }
    /** what the folder already holds, before anything is written to it */
    | { op: "survey"; args?: undefined }
    /** copy every month file in the folder into the archive (a restore into a fresh profile) */
    | { op: "import"; args?: undefined }
    /** up to `limit` PNG images still to re-encode as WebP, as data URLs, and how many wait in all */
    | { op: "pngs"; args: { limit: number } }
    /** put re-encoded images in place of their PNGs (`url: null` keeps one): the backfill's commit */
    | { op: "replacePngs"; args: { items: { sha: string; url: string | null }[] } }
    /** start a backup: a copy of the archive's sessions to add the live ones to (docs/dev/backup.md, "Backup and restore") */
    | { op: "backupBegin"; args?: undefined }
    /** add one live session to the backup being built */
    | { op: "backupPut"; args: { input: ArchiveInput } }
    /** finish it: settings in, sealed in the chosen form, written to the `out` file (backup-opfs.ts) */
    | { op: "backupFinish"; args: { settings: string | null; form: BackupForm } }
    /** drop the backup being built */
    | { op: "backupAbort"; args?: undefined }
    /** open the `in` file (decrypting it with the install's key or the secret) and say what it holds, changing nothing */
    | { op: "restoreInspect"; args: { secret?: Secret } }
    /** import the sessions `restoreInspect` named, and only those, from the `in` file if it is still the file it digested; mark their months for the folder */
    | { op: "restoreSessions"; args: { secret?: Secret; digest: string; hashes: string[] } }
    /** delete a backup file left in the origin-private file system */
    | { op: "backupFileRemove"; args: { slot: BackupSlot } };

/** What the folder operations answer, for Settings. */
export interface FolderReport {
    state: FolderState;
    name?: string;
    /** month files that do not yet match the archive: written at the next sync while the folder is connected */
    pending: number;
    /** epoch ms of the last completed sync, or null */
    lastSync: number | null;
    /** what a sync or an import just did */
    written?: string[];
    removed?: string[];
    imported?: { files: number; sessions: number };
    /** sessions a sync took into the archive from the folder's files before rewriting them */
    merged?: number;
    /** month files that could not be read as an archive: left as they were, and still waiting */
    skipped?: SyncOutcome["skipped"];
    /** what the folder held when it was surveyed: how many month files, and their range */
    found?: { files: number; first?: string; last?: string };
    /** where "start fresh" moved the files the folder held */
    movedAside?: { folder: string; files: number };
}

/** `raw` is sqlite-wasm's own handle, which `exportMonth`/`importBytes` need for its pointer; `db` is the neutral
 *  surface the shared SQL runs over (archive-db.ts), so the phone's archive can be the same database. */
type Opened = { raw: Database; db: ArchiveDb; sqlite3: Sqlite3Static; exportBytes: () => Uint8Array };
let opened: Promise<Opened> | null = null;

/** The backup being built, if one is; one at a time, dropped by `backupFinish` and `backupAbort`. */
let backupBuild: BackupBuild | null = null;   // state: plumbing

/** Open (once) the archive database, creating or upgrading its schema. */
function open(): Promise<Opened> {
    opened ??= (async () => {
        // The runtime reads `locateFile` from its argument (its types omit it): this bundle is a classic script with
        // no `import.meta.url` to find the wasm from.
        const init = sqlite3InitModule as unknown as (o: { locateFile: (file: string) => string }) => ReturnType<typeof sqlite3InitModule>;
        const sqlite3 = await init({ locateFile: (file) => new URL(file, self.location.href).href });
        const pool = await sqlite3.installOpfsSAHPoolVfs({ name: "wml-archive" });
        const raw = new pool.OpfsSAHPoolDb("/archive.sqlite");
        const db = wasmDb(raw);
        migrate(db);
        return { raw, db, sqlite3, exportBytes: () => sqlite3.capi.sqlite3_js_db_export(raw.pointer!) };
    })();
    // A failed open (no OPFS, a newer schema) is answered to every caller, then retried by the next request.
    opened.catch(() => { opened = null; });
    return opened;
}

/** One request, answered. */
async function run(req: ArchiveOp): Promise<unknown> {
    const { raw, db, sqlite3, exportBytes } = await open();
    switch (req.op) {
        case "put": writeSession(db, await prepareSession(req.args.input), req.args.archivedTs); return true;
        case "list": return listArchived(db, req.args);
        case "read": return readArchived(db, req.args.hash);
        case "remove": return removeArchived(db, req.args.hash);
        case "stats": return archiveStats(db);
        case "pngs": return { batch: pngBatch(db, req.args.limit), pending: pngPending(db) };
        case "replacePngs": return replacePngs(db, req.args.items);
        case "export": return exportBytes();
        case "backupBegin": {
            if (backupBuild) abandonBackup(backupBuild);
            backupBuild = null;
            backupBuild = beginBackup(sqlite3, exportBytes());
            return { fromArchive: backupBuild.fromArchive };
        }
        case "backupPut": {
            if (!backupBuild) throw new Error("no backup is being built");
            await addSession(backupBuild, req.args.input);
            return true;
        }
        case "backupAbort": if (backupBuild) abandonBackup(backupBuild); backupBuild = null; return true;
        case "backupFinish": {
            if (!backupBuild) throw new Error("no backup is being built");
            // Asked before the build is consumed: a missing passphrase must not cost the work of reading every session.
            const keyring = req.args.form === "encrypted" ? await loadKeyring(idbKeyringStore()) : null;
            if (req.args.form === "encrypted" && !keyring) await sealBackup(new Uint8Array(0), "encrypted", null);
            const build = backupBuild;
            backupBuild = null;
            const made = finishBackup(sqlite3, build, req.args.settings);
            const sealed = await sealBackup(made.bytes, req.args.form, keyring);
            await writeBackupSlot("out", sealed as Uint8Array<ArrayBuffer>);
            return { size: sealed.byteLength, sessions: made.sessions, form: req.args.form };
        }
        case "restoreInspect": {
            const { file, plain } = await backupPlain(req.args.secret);
            return await inspectRestore(sqlite3, raw, file, plain) satisfies RestoreInspection;
        }
        case "restoreSessions": {
            const { file, plain } = await backupPlain(req.args.secret);
            const imported = await restoreNewSessions(sqlite3, raw, file, plain, req.args);
            // The folder does not hold these yet (an import from a folder is the only one that already matches it).
            if (imported) markAllDirty(db);
            return { imported };
        }
        case "backupFileRemove": await removeBackupSlot(req.args.slot); return true;
        case "folder": return folderReport(db);
        case "resync": return sync(db, raw, sqlite3, "adopt");
        case "fresh": {
            const dir = await writableFolder();
            if (!dir) return folderReport(db);
            const movedAside = await moveMonthFilesAside(dir);
            markAllDirty(db);
            return { ...(await sync(db, raw, sqlite3)), movedAside };
        }
        case "sync": return sync(db, raw, sqlite3);
        case "survey": {
            const dir = await writableFolder();
            return { ...(await folderReport(db)), ...(dir ? { found: await surveyFolder(monthFolder(dir)) } : {}) };
        }
        case "import": {
            const dir = await writableFolder();
            if (!dir) return folderReport(db);
            const { files, sessions, skipped } = await importMonths({ sqlite3, raw }, monthFolder(dir));
            return { ...(await folderReport(db)), imported: { files, sessions }, ...(skipped.length ? { skipped } : {}) };
        }
    }
}

/** The `in` file as it sits in the slot, and as plain SQLite bytes: opened with this install's key when it sealed the file, else with `secret`. */
async function backupPlain(secret?: Secret): Promise<{ file: Uint8Array; plain: Uint8Array }> {
    const file = await readBackupSlot("in");
    if (!file) throw new Error("no backup file was handed over");
    return { file, plain: await openBackupBytes(file, await loadKeyring(idbKeyringStore()), secret) };
}

async function folderReport(db: ArchiveDb): Promise<FolderReport> {
    const last = metaGet(db, "last_sync");
    return { ...(await folderState()), pending: dirtyMonths(db).length, lastSync: last ? Number(last) : null };
}

/**
 * Write every dirty month into the folder, each merged with the file it replaces (folder-sync.ts), when the folder is
 * writable; otherwise nothing, and the months stay dirty until it is. `adopt` (a folder just picked) imports every file
 * the folder holds first and then writes every month.
 */
async function sync(db: ArchiveDb, raw: Database, sqlite3: Sqlite3Static, mode: "sync" | "adopt" = "sync"): Promise<FolderReport> {
    const dir = await writableFolder();
    if (!dir) return folderReport(db);
    const h = { sqlite3, raw }, folder = monthFolder(dir);
    const r = mode === "adopt" ? await adoptFolder(h, folder) : await syncMonths(h, folder);
    metaSet(db, "last_sync", String(Date.now()));
    return {
        ...(await folderReport(db)), written: r.written, removed: r.removed, merged: r.merged,
        ...(r.skipped.length ? { skipped: r.skipped } : {}),
        ...(mode === "adopt" && "imported" in r ? { imported: (r as { imported: { files: number; sessions: number } }).imported } : {}),
    };
}

// In order: each request waits for the one before it.
let chain: Promise<unknown> = Promise.resolve();
self.onmessage = (e: MessageEvent<{ id: number } & ArchiveOp>) => {
    const { id, ...req } = e.data;
    chain = chain.then(() => run(req as ArchiveOp)).then(
        (result) => self.postMessage({ id, ok: true, result }),
        // `reason` is a BackupError's, so the caller can tell "ask for the passphrase" from "that is the wrong one".
        (err) => self.postMessage({ id, ok: false, error: String((err as Error)?.message || err), ...((err as BackupError)?.reason ? { reason: (err as BackupError).reason } : {}) }),
    );
};

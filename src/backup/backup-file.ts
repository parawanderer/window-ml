// backup-file.ts — building a backup file (every session plus the settings) and reading one, over the archive's own SQLite.

/**
 * A backup is the archive's database (`migrate`, archive/db.ts) holding EVERY session, live and archived, plus one extra
 * table, `backup_settings`, carrying the settings payload. So a decrypted backup opens in any SQLite tool like a month
 * file does, and restoring its sessions is the archive's own import (`importFrom`: new sessions only).
 *
 * Nothing here touches `chrome`: the caller hands in the sqlite-wasm handles, the archive's bytes and the keyring. The
 * worker op that drives it is `archive-worker.ts` (`backupBegin`, `backupPut`, `backupFinish`); the orchestration across
 * the live store and the archive is `backup-run.ts`.
 *
 * Built in memory, never as a temporary file, like `exportMonth`: the memory it costs is the whole archive plus the live
 * sessions, once for the copy of the archive taken at the start and once for the file at the end.
 */
import type { Database, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { ARCHIVE_SCHEMA, importBytes, migrate, prepareSession, wasmDb, withAttachedBytes, writeSession, type ArchiveDb, type ArchiveInput } from "../archive/db";
import { BackupError, encryptFile, gzip, readHeader, readAnyForm, sniff, type Keyring, type Secret } from "./backup-format";

/** The three forms a backup can be written in (`docs/dev/backup.md`, "The three forms of a file"). */
export type BackupForm = "plain" | "gzip" | "encrypted";

/** The file name extension of each form. */
export const BACKUP_EXTENSION: Readonly<Record<BackupForm, string>> = Object.freeze({ plain: "sqlite", gzip: "sqlite.gz", encrypted: "wmlbak" });

/** A backup being built: an in-memory archive database that sessions are written into. */
export interface BackupBuild {
    raw: Database;
    db: ArchiveDb;
    /** sessions that came from the archive */
    fromArchive: number;
}

/**
 * Start a backup: an empty in-memory archive, with the archive's sessions imported into it.
 * @param archiveBytes the archive as a SQLite file (the worker's `export`), or null for an install with no archive
 */
export function beginBackup(sqlite3: Sqlite3Static, archiveBytes: Uint8Array | null): BackupBuild {
    const raw = new sqlite3.oo1.DB(":memory:");
    try {
        const db = wasmDb(raw);
        migrate(db);
        return { raw, db, fromArchive: archiveBytes ? importBytes(sqlite3, raw, archiveBytes) : 0 };
    } catch (e) { raw.close(); throw e; }
}

/**
 * Add a live session. One that is also in the archive (an un-archive that did not finish removing it) is replaced by the
 * live copy, which is the one the session list shows.
 */
export async function addSession(build: BackupBuild, input: ArchiveInput, now = Date.now()): Promise<void> {
    writeSession(build.db, await prepareSession(input), now);
}

/** The table a backup adds to the archive's schema: `key`/`value` rows, one of them the settings payload. */
const SETTINGS_TABLE = "backup_settings";

/**
 * Finish a backup: the settings payload in, the folder bookkeeping out (a backup has no folder), the database serialized
 * and closed.
 * @param settings the settings payload as JSON (`SettingsPayload`), or null for a sessions-only backup
 * @returns the plain SQLite bytes and how many sessions they hold
 */
export function finishBackup(sqlite3: Sqlite3Static, build: BackupBuild, settings: string | null, now = new Date()): { bytes: Uint8Array; sessions: number } {
    const { raw, db } = build;
    try {
        db.exec(`CREATE TABLE ${SETTINGS_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`);
        const put = (key: string, value: string) => db.exec({ sql: `INSERT OR REPLACE INTO ${SETTINGS_TABLE}(key, value) VALUES (?, ?)`, bind: [key, value] });
        put("created", now.toISOString());
        put("layout", "1");
        if (settings != null) put("payload", settings);
        db.exec("DELETE FROM dirty_months");
        db.exec("DELETE FROM removed");
        const sessions = Number(db.selectValue("SELECT count(*) FROM sessions"));
        return { bytes: sqlite3.capi.sqlite3_js_db_export(raw.pointer!), sessions };
    } finally { raw.close(); }
}

/** Abandon a backup in progress. */
export function abandonBackup(build: BackupBuild): void {
    try { build.raw.close(); } catch { /* already closed */ }
}

/**
 * The bytes of the file to write, in the chosen form. Compression comes before encryption (`encryptFile`).
 * @param keyring required for `encrypted`; the install's keyring from `backup-keyring.ts`
 */
export async function sealBackup(plain: Uint8Array, form: BackupForm, keyring: Keyring | null, now = new Date()): Promise<Uint8Array> {
    if (form === "plain") return plain;
    if (form === "gzip") return gzip(plain);
    if (!keyring) throw new BackupError("needs-key", "set a backup passphrase first: an encrypted backup needs this install's key");
    return encryptFile(plain, keyring, { kind: "backup", created: now });
}

// --- reading ---

/**
 * What opening an encrypted file needs: this install's keyring when it sealed the file (same data key, same `keyId`), else
 * the secret the caller was given. A plain or gzip file needs nothing.
 * @throws `needs-key` when the file is encrypted by another install and no secret was given
 */
export function unlockChoice(file: Uint8Array, installKeyring: Keyring | null, secret?: Secret): Keyring | Secret {
    if (sniff(file) !== "wmlbak") throw new BackupError("unknown-form", "this is not an encrypted backup");
    if (secret) return secret;
    if (installKeyring && readHeader(file).keyId === installKeyring.keyId) return installKeyring;
    throw new BackupError("needs-key", "this backup was made on another install: give its passphrase or recovery key");
}

/** Plain SQLite bytes out of a backup file in any of the three forms, within the format's size budget. */
export function openBackupBytes(file: Uint8Array, installKeyring: Keyring | null, secret?: Secret, maxOutput?: number): Promise<Uint8Array> {
    return readAnyForm(file, async () => unlockChoice(file, installKeyring, secret), maxOutput);
}

/** What a backup file holds, found without restoring anything. */
export interface BackupContents {
    /** sessions in the file */
    sessions: number;
    /** of those, the ones this archive does not have and did not remove on purpose: what a restore would add */
    newSessions: number;
    /** the settings payload JSON, or null when the file carries none (a month file, or a sessions-only backup) */
    settings: string | null;
    created: string | null;
}

/**
 * Look inside a backup (plain SQLite bytes) against the live archive `raw`, without changing either.
 * @throws when the file is not an archive, or is from a newer schema
 */
export function inspectBackup(sqlite3: Sqlite3Static, raw: Database, plain: Uint8Array): BackupContents {
    return withAttachedBytes(sqlite3, raw, plain, (db, s) => {
        const theirs = Number(db.selectValue(`SELECT value FROM ${s}.meta WHERE key = 'schema'`) ?? 0);
        if (theirs > ARCHIVE_SCHEMA) throw new Error(`that backup was written by a newer version (archive schema ${theirs}); update the extension to read it`);
        const has = Number(db.selectValue(`SELECT count(*) FROM ${s}.sqlite_master WHERE type = 'table' AND name = '${SETTINGS_TABLE}'`)) > 0;
        const get = (key: string): string | null => (has ? (db.selectValue(`SELECT value FROM ${s}.${SETTINGS_TABLE} WHERE key = ?`, [key]) as string | undefined) ?? null : null);
        return {
            sessions: Number(db.selectValue(`SELECT count(*) FROM ${s}.sessions`)),
            newSessions: Number(db.selectValue(`SELECT count(*) FROM ${s}.sessions WHERE hash NOT IN (SELECT hash FROM main.sessions) AND hash NOT IN (SELECT hash FROM main.removed)`)),
            settings: get("payload"),
            created: get("created"),
        };
    });
}

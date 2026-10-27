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
import { BackupError, encryptFile, gzip, readHeader, readAnyForm, sniff, type FileKind, type Keyring, type Secret } from "./backup-format";
import { PAYLOAD_LIMITS } from "./backup-settings";

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
 * @param kind what an encrypted header records: a one-off `backup`, or an `archive-month` file of the folder
 */
export async function sealBackup(plain: Uint8Array, form: BackupForm, keyring: Keyring | null, now = new Date(), kind: FileKind = "backup"): Promise<Uint8Array> {
    if (form === "plain") return plain;
    if (form === "gzip") return gzip(plain);
    if (!keyring) throw new BackupError("needs-key", "set a backup passphrase first: an encrypted backup needs this install's key");
    return encryptFile(plain, keyring, { kind, created: now });
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

/** One session a restore would add, as much as a screen needs to name it. */
export interface AddingSession { hash: string; title: string; createdTs: number; bytes: number }

/** The most sessions `BackupContents.adding` names; the rest are counted in `more`. */
export const ADDING_CAP = 500;

/** What a backup file holds, found without restoring anything. */
export interface BackupContents {
    /** sessions in the file */
    sessions: number;
    /** of those, the ones this archive does not have and did not remove on purpose: what a restore would add */
    newSessions: number;
    /** the first `ADDING_CAP` of them, newest first, by title, start time and size */
    adding: AddingSession[];
    /** how many more than `adding` names */
    more: number;
    /** the hash of EVERY session a restore would add (not capped): what `restoreNewSessions` is pinned to */
    hashes: string[];
    /** the settings payload JSON, or null when the file carries none (a month file, a sessions-only backup, or `settingsError`) */
    settings: string | null;
    /** why the payload was not handed over: it is longer than `PAYLOAD_LIMITS.bytes` */
    settingsError?: string;
    created: string | null;
}

/** `BackupContents` of a file in the slot, plus the digest of that file. */
export interface RestoreInspection extends BackupContents {
    /** SHA-256 of the file as it sat in the slot (hex): a restore refuses a file whose digest differs */
    digest: string;
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
        // The payload's length is asked of SQLite first: a string past the budget is never produced, let alone handed on.
        const payloadLength = has ? Number(db.selectValue(`SELECT length(value) FROM ${s}.${SETTINGS_TABLE} WHERE key = 'payload'`) ?? 0) : 0;
        const tooLarge = payloadLength > PAYLOAD_LIMITS.bytes;
        const fresh = `FROM ${s}.sessions WHERE hash NOT IN (SELECT hash FROM main.sessions) AND hash NOT IN (SELECT hash FROM main.removed)`;
        const newSessions = Number(db.selectValue(`SELECT count(*) ${fresh}`));
        return {
            sessions: Number(db.selectValue(`SELECT count(*) FROM ${s}.sessions`)),
            newSessions,
            adding: db.selectObjects(`SELECT hash, COALESCE(title, task, '') AS title, created_ts AS createdTs, bytes ${fresh} ORDER BY last_ts DESC, hash LIMIT ${ADDING_CAP}`)
                .map((r) => ({ hash: String(r.hash), title: String(r.title), createdTs: Number(r.createdTs), bytes: Number(r.bytes) })),
            more: Math.max(0, newSessions - ADDING_CAP),
            hashes: db.selectValues(`SELECT hash ${fresh} ORDER BY last_ts DESC, hash`).map(String),
            settings: tooLarge ? null : get("payload"),
            ...(tooLarge ? { settingsError: "the settings in this backup are larger than any real backup holds" } : {}),
            created: get("created"),
        };
    });
}

/** SHA-256 of some bytes, as lowercase hex. */
export async function digestOf(bytes: Uint8Array): Promise<string> {
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
    return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The restore's look at a file: what `inspectBackup` finds in `plain`, with the digest of `file` (the bytes as they sat in
 * the `in` slot, whatever form) to pin the restore to.
 */
export async function inspectRestore(sqlite3: Sqlite3Static, raw: Database, file: Uint8Array, plain: Uint8Array): Promise<RestoreInspection> {
    return { ...inspectBackup(sqlite3, raw, plain), digest: await digestOf(file) };
}

/**
 * Import the sessions a restore was previewed with, and only those, from the file now in the slot.
 * @param pin the digest and hashes `inspectRestore` returned
 * @returns how many sessions were added (a hash the archive gained or removed since is not imported)
 * @throws `changed` when `file` is not the file that was inspected
 */
export async function restoreNewSessions(sqlite3: Sqlite3Static, raw: Database, file: Uint8Array, plain: Uint8Array, pin: { digest: string; hashes: readonly string[] }): Promise<number> {
    if (await digestOf(file) !== pin.digest) throw new BackupError("changed", "the backup file changed after it was previewed: choose it again");
    return importBytes(sqlite3, raw, plain, pin.hashes);
}

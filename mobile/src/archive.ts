// archive.ts — THE PHONE'S COPY OF THE SESSION ARCHIVE: expo-sqlite presented as the surface the shared SQL runs
// over (src/archive/db.ts), so this database is the one the extension writes rather than a second format that
// happens to agree.
//
// The schema, the write path, the FTS5 index and the read-back are all that module's, unchanged. Only the handle is
// different, and this is the whole of the difference: a dozen lines mapping six calls. That is the point of naming
// the surface — a copy of the SQL here would be two schemas drifting from the day it was written, and an export or
// a sync between the two would have to translate rather than move.
//
// SYNCHRONOUS throughout, because the shared module runs every statement inside `transaction` and a driver returning
// promises could not be sequenced in one. expo-sqlite's sync variants exist for exactly this.
//
// ENCRYPTED AT REST, and what that does and does not buy:
//
// The file is SQLCipher (`useSQLCipher` in app.json) with a 32-byte key made once and kept in the platform keystore
// under `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` — the terms the keyring's own secrets are kept on, and the pattern
// WhatsApp uses for its message store. The point of those terms is that the key is never restored onto another
// phone, so a copy of this file is inert wherever it lands: a backup, a forensic image, a stolen disk.
//
// It is NOT protection from code running inside this app, or from someone holding the unlocked phone. The sandbox
// and the platform's own full-disk encryption are what answer those, exactly as they did when this was a JSON file.
//
// ON BACKUPS. The copies moved from the app's cache directory to its documents so history survives, and documents
// are backed up — a property the cache directory had for free and that move took away. Android gives it back
// already: expo-secure-store's rules include only `sharedpref`, and an Auto Backup config with any `<include>`
// backs up ONLY what it names, so the database and file domains are excluded on both auto-backup and device
// transfer. iOS has no equivalent and neither expo-file-system nor expo-sqlite exposes
// `NSURLIsExcludedFromBackupKey`, so the file does reach iCloud there — as ciphertext whose key is marked never to
// leave this device. What is left is the size of it in someone's backup, not its contents.

import { deleteDatabaseSync, openDatabaseSync, type SQLiteDatabase } from "expo-sqlite";
import * as SecureStore from "expo-secure-store";
import { getRandomBytes } from "expo-crypto";
import { appendEvents, metaGet, metaSet, migrate, prepareSession, readArchived, removeArchived, writeSession, type ArchiveDb, type SqlValue } from "../../src/archive/db";
import { CACHE_MAX_BYTES, CACHE_SESSIONS, type EventCache } from "../../src/chat/event-cache";
import type { FeedSnapshot } from "../../src/chat/session-feed";
import type { SessionKey } from "../../src/session-host";
import type { CachedSession } from "../../src/chat/event-cache";
import type { ToNative, ToWeb } from "../../src/native/bridge";

/** The file the archive lives in, beside the app's other documents. */
export const ARCHIVE_FILE = "archive.sqlite";

/** Where the archive's key lives: the platform keystore, as every other secret on this phone does (vault.ts). */
const KEY_NAME = "archive.key";
/** Kept after the first unlock and NEVER restored onto another phone, which is what makes a backup of the database
 *  inert: the file may travel, the key does not. Same terms the keyring's own secrets are kept on. */
const KEY_OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

/**
 * The archive's encryption key, made once and kept in the keystore.
 *
 * The database is SQLCipher (`useSQLCipher` in app.json), so what is on disk is ciphertext. This is the pattern
 * WhatsApp uses for its own message store and the one this app already uses for the keyring: the key sits where the
 * OS guards it, not beside what it protects.
 *
 * It is hex rather than a passphrase because `PRAGMA key` treats a quoted string as a passphrase to derive from, and
 * deriving from 32 random bytes is work for nothing — the bytes ARE the key.
 */
async function archiveKey(): Promise<string> {
    const found = await SecureStore.getItemAsync(KEY_NAME, KEY_OPTIONS);
    if (found) return found;
    const made = [...getRandomBytes(32)].map((b) => b.toString(16).padStart(2, "0")).join("");
    await SecureStore.setItemAsync(KEY_NAME, made, KEY_OPTIONS);
    return made;
}

/** `expo-sqlite` as the shared surface. Written out rather than cast: the two disagree about shapes (a select here
 *  returns rows as objects, a value is the first column of the first row), and stating the mapping once is what
 *  makes a change on either side a compile error instead of a wrong answer in the archive. */
export function expoDb(raw: SQLiteDatabase): ArchiveDb {
    const first = (r: Record<string, SqlValue> | null): SqlValue | undefined =>
        (r == null ? undefined : (Object.values(r)[0] as SqlValue));
    const db: ArchiveDb = {
        // `execSync` takes no parameters, so the bound form has to go through `runSync` — which is also the one that
        // reports what it changed, and the only one that escapes anything.
        exec: (sql) => (typeof sql === "string" ? raw.execSync(sql) : raw.runSync(sql.sql, (sql.bind ?? []) as never)),
        selectValue: (sql, bind) => first(raw.getFirstSync(sql, (bind ?? []) as never)),
        selectValues: (sql, bind) => raw.getAllSync<Record<string, SqlValue>>(sql, (bind ?? []) as never).map((r) => Object.values(r)[0] as SqlValue),
        selectObjects: (sql, bind) => raw.getAllSync<Record<string, SqlValue>>(sql, (bind ?? []) as never),
        transaction: (fn) => raw.withTransactionSync(() => { fn(db as never); }) as never,
        prepare: (sql) => {
            const st = raw.prepareSync(sql);
            let bound: SqlValue[] = [];
            const s = {
                bind(v: SqlValue[]) { bound = v; return s; },
                // A prepared statement is RESET after each row rather than finalized: the write path binds and steps
                // the same statement once per event, which is the only reason it prepares one at all.
                stepReset() { st.executeSync(bound as never).resetSync(); return s; },
                finalize() { st.finalizeSync(); },
            };
            return s;
        },
    };
    return db;
}

/** The one open handle, or null before the first use. */
let open: { raw: SQLiteDatabase; db: ArchiveDb } | null = null;

/**
 * Open the phone's archive, decrypted, migrated and ready. One handle for the app's lifetime: SQLite serialises
 * writers itself, and a second connection to the same file would only add a lock to contend for.
 *
 * ASYNC only because the key is: everything after it is synchronous, which is what the shared SQL requires. The
 * `PRAGMA key` is the first statement on the connection and has to be — SQLCipher cannot read so much as the schema
 * before it, so a missed one fails as "file is not a database" rather than as anything about encryption.
 */
export async function archive(): Promise<ArchiveDb> {
    if (!open) {
        const key = await archiveKey();
        try {
            open = unlock(key);
        } catch (e) {
            // A FILE THIS KEY CANNOT OPEN, which is not a disaster here: the copy is a copy, and everything in it
            // can be fetched again. It happens for two reasons worth telling apart in the log and treating the same
            // — a database written before encryption was turned on (SQLCipher cannot read a plaintext file), and a
            // key that is gone (reinstalled app, cleared keystore). Both leave bytes nothing can read, so they are
            // discarded rather than left to fail every save forever.
            console.warn(`[archive] could not open with this key, starting a new one: ${e instanceof Error ? e.message : String(e)}`);
            deleteDatabaseSync(ARCHIVE_FILE);
            open = unlock(key);
        }
    }
    return open.db;
}

/**
 * Open the file, decrypt it and bring the schema up to date. Throws where the key does not fit the bytes.
 *
 * It CLOSES THE HANDLE on its way out of a failure, which is not tidiness: SQLite will not delete a database that is
 * still open, so a failed open that held on to its handle made the recovery below fail too — and the archive then
 * failed every save for the life of the app, each one logged, none of them fixable.
 */
function unlock(key: string): { raw: SQLiteDatabase; db: ArchiveDb } {
    const raw = openDatabaseSync(ARCHIVE_FILE);
    try {
        raw.execSync(`PRAGMA key = "x'${key}'"`);
        // The first READ is what proves the key: `PRAGMA key` itself succeeds whatever you give it, and the failure
        // surfaces on the first page SQLCipher has to decrypt. Reading the schema is the cheapest such read.
        raw.execSync("SELECT count(*) FROM sqlite_master");
        const db = expoDb(raw);
        migrate(db);
        return { raw, db };
    } catch (e) {
        try { raw.closeSync(); } catch { /* already gone: the delete is what matters */ }
        throw e;
    }
}

/** Forget the archive — joining or leaving an account, where a device must not replay the last one's sessions. */
export function closeArchive(): void {
    open?.raw.closeSync();
    open = null;
}

// ===================== THE PAGE'S COPY OF A SESSION, KEPT IN THIS ARCHIVE =====================
// What `event-cache.ts` described as a cache of JSON files, over the same database the extension archives into. The
// events, the summary and the history are ordinary archive rows read by the shared reader; what has no place there
// is the client's own state — where this device's subscription got to, and whether the runtime has thrown the rest
// away. Those are not archive facts (the extension has no notion of either), so they live in `meta` under keys this
// side owns rather than being added to a schema both sides share.

/** `meta` keys belonging to the CLIENT: the extension writes neither and reads neither. */
const feedKey = (hash: string) => `client.feed:${hash}`;
const truncKey = (hash: string) => `client.truncated:${hash}`;

/** The hash half of a `runtime:hash` key. Split on the LAST colon: a runtime id may contain one. */
const hashOf = (key: SessionKey): string => key.slice(key.lastIndexOf(":") + 1);

/**
 * The phone's session copies, in its archive.
 *
 * Bounded as the JSON version was and for the same reason — a phone is not an unbounded archive — but the trimming
 * is now a DELETE of the oldest event rows rather than a rewrite of the whole session, which is what made this worth
 * moving. Only events that carry a history position are kept: one that cannot say where it sits could not be paged
 * back from, and guessing an index for it is how a copy comes to claim a history it does not have.
 */
export function archiveCache(db: ArchiveDb): EventCache {
    return {
        async load(key) {
            const hash = hashOf(key);
            const got = readArchived(db, hash);
            const feed = metaGet(db, feedKey(hash));
            if (!got || !feed) return null;
            return {
                v: 1,
                key,
                feed: JSON.parse(feed) as FeedSnapshot,
                events: got.events.map((event, i) => ({ pos: got.positions[i], event })),
                earlier: got.positions.length && got.positions[0] > 0 ? { from: got.positions[0] } : null,
                truncated: metaGet(db, truncKey(hash)) === "1",
                summary: got.summary,
            };
        },
        async save(session) {
            const hash = hashOf(session.key);
            // No summary means nothing to list it by and no `sessions` row to hang the events on, so there is
            // nothing honest to keep. The JSON copy had the same floor, for want of the row rather than by choice.
            if (!session.summary) return;
            const held = Number(db.selectValue("SELECT MAX(pos) FROM events WHERE hash = ?", [hash]) ?? -1);
            const fresh = session.events.filter((e) => typeof e.pos === "number" && e.pos > held);
            const input = {
                summary: session.summary,
                events: fresh.map((e) => e.event),
                positions: fresh.map((e) => e.pos),
                history: null,
                bytes: 0,
            };
            const prepared = await prepareSession(input);
            if (held < 0) writeSession(db, prepared, Date.now());
            else if (fresh.length) appendEvents(db, prepared);
            else db.exec({ sql: "UPDATE sessions SET summary = ?, last_ts = MAX(last_ts, ?) WHERE hash = ?", bind: [JSON.stringify(session.summary), session.summary.lastTs, hash] });
            metaSet(db, feedKey(hash), JSON.stringify(session.feed));
            metaSet(db, truncKey(hash), session.truncated ? "1" : "0");
            trim(hash);
            evict();
        },
        async drop(key) { forget(hashOf(key)); },
        async clear() {
            for (const r of db.selectObjects("SELECT hash FROM sessions")) forget(String(r.hash));
        },
    };

    /** One session gone, client state included. */
    function forget(hash: string): void {
        removeArchived(db, hash);
        db.exec({ sql: "DELETE FROM meta WHERE key IN (?, ?)", bind: [feedKey(hash), truncKey(hash)] });
    }

    /** Cut a session back to the newest events that fit. The oldest rows go, and `earlier` follows them: it is read
     *  from the lowest position still held, so nothing has to be written to say the copy now begins later. */
    function trim(hash: string): void {
        const size = () => Number(db.selectValue("SELECT COALESCE(SUM(LENGTH(body)), 0) FROM events WHERE hash = ?", [hash]) ?? 0);
        while (size() > CACHE_MAX_BYTES) {
            const oldest = db.selectValue("SELECT MIN(pos) FROM events WHERE hash = ?", [hash]);
            if (oldest == null) return;
            db.exec({ sql: "DELETE FROM events WHERE hash = ? AND pos = ?", bind: [hash, Number(oldest)] });
            db.exec({ sql: "DELETE FROM event_text WHERE hash = ? AND pos = ?", bind: [hash, Number(oldest)] });
        }
    }

    /** Past the limit, the least recently active session goes. */
    function evict(): void {
        const extra = db.selectValues(`SELECT hash FROM sessions ORDER BY last_ts DESC LIMIT -1 OFFSET ${CACHE_SESSIONS}`);
        for (const h of extra) forget(String(h));
    }
}

/** Answer one `archive` request from the page (src/native/archive-bridge.ts). The page sends only the events past
 *  what the last answer said was held, so a live session's save stays small however long the session is. */
export async function answerArchive(m: Extract<ToNative, { type: "archive" }>): Promise<Extract<ToWeb, { type: "archiveResult" }>> {
    try {
        const cache = archiveCache(await archive());
        if (m.op === "clear") { await cache.clear(); return { type: "archiveResult", id: m.id, ok: true }; }
        if (!m.key) return { type: "archiveResult", id: m.id, ok: false, error: "that request needs a session" };
        const key = m.key as SessionKey;
        if (m.op === "drop") { await cache.drop(key); return { type: "archiveResult", id: m.id, ok: true }; }
        if (m.op === "load") return { type: "archiveResult", id: m.id, ok: true, session: (await cache.load(key)) ?? undefined };
        await cache.save(m.session as CachedSession);
        return { type: "archiveResult", id: m.id, ok: true, held: await heldFor(key) };
    } catch (e) {
        // SAID OUT LOUD, because nothing downstream will. The store discards a failed save (`.catch(() => undefined)`),
        // so an archive that cannot write looks exactly like one that is working: sessions simply stop being kept and
        // every reopen goes to the hub. This is the only place it is visible.
        const why = e instanceof Error ? e.message : String(e);
        console.warn(`[archive] ${m.op} failed: ${why}`);
        return { type: "archiveResult", id: m.id, ok: false, error: why };
    }
}

/** The highest history position the archive now holds for a session, or -1 when it holds none. */
async function heldFor(key: SessionKey): Promise<number> {
    const db = await archive();
    return Number(db.selectValue("SELECT MAX(pos) FROM events WHERE hash = ?", [hash(key)]) ?? -1);
}
const hash = hashOf;

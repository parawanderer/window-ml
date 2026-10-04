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

import { openDatabaseSync, type SQLiteDatabase } from "expo-sqlite";
import { migrate, type ArchiveDb, type SqlValue } from "../../src/archive/db";

/** The file the archive lives in, beside the app's other documents. */
export const ARCHIVE_FILE = "archive.sqlite";

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

/** Open the phone's archive, migrated and ready. One handle for the app's lifetime: SQLite serialises writers
 *  itself, and a second connection to the same file would only add a lock to contend for. */
export function archive(): ArchiveDb {
    if (!open) {
        const raw = openDatabaseSync(ARCHIVE_FILE);
        const db = expoDb(raw);
        migrate(db);
        open = { raw, db };
    }
    return open.db;
}

/** Forget the archive — joining or leaving an account, where a device must not replay the last one's sessions. */
export function closeArchive(): void {
    open?.raw.closeSync();
    open = null;
}

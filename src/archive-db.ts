// archive-db.ts — the long-term session archive's database: the schema, writing a session into it, listing, reading
// back and searching. Pure over a sqlite-wasm `Database`, so the SQL is tested in Node against an in-memory database
// and runs unchanged in the archive worker over OPFS (archive-worker.ts).
//
// What is kept is the session's DEBUG EVENTS, as the live store keeps them, because that is what every surface already
// renders: an archived session reads back into the same events a stored one replays. Two things are changed on the way
// in, and changed back on the way out:
// - an image (`data:image/*` anywhere in an event) is stored ONCE, decoded, keyed by the SHA-256 of its data URL, and
//   the event holds a marker in its place. The same screenshot in a hundred steps costs one blob;
// - each event's text is copied into an FTS5 table, so a search over years of history is one query.
import type { Database, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import type { MlDebugEvent } from "./contract-debug";
import type { SessionSummary } from "./session-host";
import type { SessionHistory } from "./session-store";
import type { SessionBytes } from "./session-storage-stats";

/** The schema this module writes. A newer one is migrated to in `migrate`; an older build refuses a newer file. */
export const ARCHIVE_SCHEMA = 1;

/** What an image is replaced by inside an archived event. Not a data URL, so nothing renders it by accident. */
const IMG_MARK = "wml-archive-img:";

/** How much of one event's text is indexed for search. Enough for any prompt or answer; a tool's megabyte of output
 *  is searchable by its start, which is where a person's memory of it usually is. */
const TEXT_PER_EVENT = 8_000;

/** Create or upgrade the schema in `schema` (the main database, or an attached month file). Safe to call on every
 *  open. */
export function migrate(db: Database, schema = "main"): void {
    const S = schema;
    db.exec(`
        CREATE TABLE IF NOT EXISTS ${S}.meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ${S}.sessions (
            hash TEXT PRIMARY KEY, runtime TEXT NOT NULL, kind TEXT NOT NULL,
            title TEXT, task TEXT, model TEXT,
            created_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL, archived_ts INTEGER NOT NULL,
            events INTEGER NOT NULL, bytes INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
            summary TEXT NOT NULL, history TEXT, split TEXT
        );
        CREATE INDEX IF NOT EXISTS ${S}.sessions_last_ts ON sessions(last_ts DESC);
        CREATE TABLE IF NOT EXISTS ${S}.events (
            hash TEXT NOT NULL, pos INTEGER NOT NULL, kind TEXT NOT NULL, ts INTEGER, body TEXT NOT NULL,
            PRIMARY KEY (hash, pos)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS ${S}.images (sha TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS ${S}.image_refs (hash TEXT NOT NULL, sha TEXT NOT NULL, PRIMARY KEY (hash, sha)) WITHOUT ROWID;
        CREATE VIRTUAL TABLE IF NOT EXISTS ${S}.event_text USING fts5(hash UNINDEXED, pos UNINDEXED, text);
        CREATE TABLE IF NOT EXISTS ${S}.dirty_months (month TEXT PRIMARY KEY) WITHOUT ROWID;
    `);
    const have = Number(db.selectValue(`SELECT value FROM ${S}.meta WHERE key = 'schema'`) ?? 0);
    if (have > ARCHIVE_SCHEMA) throw new Error(`this archive was written by a newer version (schema ${have}); update the extension to read it`);
    db.exec({ sql: `INSERT OR REPLACE INTO ${S}.meta(key, value) VALUES ('schema', ?)`, bind: [String(ARCHIVE_SCHEMA)] });
}

/** A session on its way into the archive: what the live store holds for it. */
export interface ArchiveInput {
    summary: SessionSummary;
    events: MlDebugEvent[];
    history?: SessionHistory | null;
    split?: SessionBytes;
    bytes: number;
}

/** A session prepared for writing: images pulled out, events rewritten, text extracted. */
export interface PreparedSession {
    input: ArchiveInput;
    bodies: string[];
    texts: string[];
    images: Map<string, { mime: string; data: Uint8Array }>;
}

/** SHA-256 of a string, as lowercase hex. */
async function sha256(s: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A data URL's bytes, or null when it is not a base64 image. */
function decodeImage(url: string): { mime: string; data: Uint8Array } | null {
    const m = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(url);
    if (!m) return null;
    const bin = atob(url.slice(m[0].length));
    const data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    return { mime: m[1].toLowerCase(), data };
}

/**
 * Pull images out of the events and extract their text. Asynchronous only for the hashing, so the write that follows
 * can be one synchronous transaction.
 */
export async function prepareSession(input: ArchiveInput): Promise<PreparedSession> {
    const images = new Map<string, { mime: string; data: Uint8Array }>();
    const bodies: string[] = [];
    const texts: string[] = [];
    for (const ev of input.events) {
        const found: string[] = [];
        const text: string[] = [];
        let textLen = 0;
        // Collect first (hashing is async), then rewrite with the hashes known.
        const collect = (v: unknown, depth: number): void => {
            if (depth > 16 || v == null) return;
            if (typeof v === "string") {
                if (v.startsWith("data:image/")) found.push(v);
                else if (textLen < TEXT_PER_EVENT && v.length > 1) { text.push(v); textLen += v.length; }
                return;
            }
            if (typeof v !== "object") return;
            for (const x of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)) collect(x, depth + 1);
        };
        collect(ev, 0);
        const shas = new Map<string, string>();
        for (const url of found) {
            if (shas.has(url)) continue;
            const decoded = decodeImage(url);
            if (!decoded) continue;
            const sha = await sha256(url);
            shas.set(url, sha);
            if (!images.has(sha)) images.set(sha, decoded);
        }
        bodies.push(JSON.stringify(ev, (_k, v) => (typeof v === "string" && shas.has(v) ? IMG_MARK + shas.get(v) : v)));
        texts.push(text.join(" ").slice(0, TEXT_PER_EVENT));
    }
    return { input, bodies, texts, images };
}

/**
 * Write a prepared session, replacing whatever the archive held for it. One transaction: a session is in the archive
 * whole or not at all, which is what lets the live store forget it only after this returns.
 */
export function writeSession(db: Database, p: PreparedSession, archivedTs: number): void {
    const s = p.input.summary;
    const hash = s.id.hash;
    db.transaction(() => {
        // The month it was in, if it moved (a resumed session re-archived later), is dirty too: its file still has it.
        const was = db.selectValue("SELECT last_ts FROM sessions WHERE hash = ?", [hash]);
        if (was != null) markDirty(db, Number(was));
        markDirty(db, s.lastTs);
        db.exec({ sql: "DELETE FROM events WHERE hash = ?", bind: [hash] });
        db.exec({ sql: "DELETE FROM event_text WHERE hash = ?", bind: [hash] });
        db.exec({ sql: "DELETE FROM image_refs WHERE hash = ?", bind: [hash] });
        db.exec({
            sql: `INSERT OR REPLACE INTO sessions(hash, runtime, kind, title, task, model, created_ts, last_ts, archived_ts, events, bytes, pinned, summary, history, split)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            bind: [hash, s.id.runtime, s.kind, s.title ?? null, s.task ?? null, s.model ?? null, s.createdTs, s.lastTs, archivedTs,
                p.bodies.length, p.input.bytes, s.pinned ? 1 : 0, JSON.stringify(s),
                p.input.history ? JSON.stringify(p.input.history) : null, p.input.split ? JSON.stringify(p.input.split) : null],
        });
        const ev = db.prepare("INSERT INTO events(hash, pos, kind, ts, body) VALUES (?, ?, ?, ?, ?)");
        const tx = db.prepare("INSERT INTO event_text(hash, pos, text) VALUES (?, ?, ?)");
        try {
            p.bodies.forEach((body, pos) => {
                const e = p.input.events[pos];
                ev.bind([hash, pos, e.kind, typeof e.ts === "number" ? e.ts : null, body]).stepReset();
                if (p.texts[pos]) tx.bind([hash, pos, p.texts[pos]]).stepReset();
            });
        } finally { ev.finalize(); tx.finalize(); }
        for (const [sha, img] of p.images) {
            db.exec({ sql: "INSERT OR IGNORE INTO images(sha, mime, data) VALUES (?, ?, ?)", bind: [sha, img.mime, img.data] });
            db.exec({ sql: "INSERT OR IGNORE INTO image_refs(hash, sha) VALUES (?, ?)", bind: [hash, sha] });
        }
    });
}

/** One archived session's row, as a list shows it. */
export interface ArchivedRow {
    summary: SessionSummary;
    archivedTs: number;
    bytes: number;
    events: number;
    /** on a search: the matched text with the match in «guillemets», plain text */
    snippet?: string;
}

/**
 * Archived sessions, newest activity first, a page at a time: those whose last activity is before `before` (exclusive),
 * so a client pages by handing back the last row's `lastTs`. `query` searches every event's text with FTS5 syntax
 * quoted into a phrase, so a person's words are never parsed as operators.
 */
export function listArchived(db: Database, o: { before?: number; limit?: number; query?: string } = {}): ArchivedRow[] {
    const limit = Math.min(Math.max(1, o.limit ?? 40), 200);
    const before = o.before ?? Number.MAX_SAFE_INTEGER;
    const q = o.query?.trim();
    const phrase = q ? `"${q.replace(/"/g, '""')}"` : "";
    const rows = q
        ? db.selectObjects(
            // The snippet is the first matching event's, the match marked; one per session, so a session that says
            // the phrase fifty times is one row, not fifty.
            `SELECT summary, archived_ts, bytes, events,
                    (SELECT snippet(event_text, 2, '«', '»', '…', 12) FROM event_text WHERE event_text MATCH ? AND hash = sessions.hash LIMIT 1) AS snip
             FROM sessions
             WHERE last_ts < ? AND hash IN (SELECT hash FROM event_text WHERE event_text MATCH ?)
             ORDER BY last_ts DESC LIMIT ?`, [phrase, before, phrase, limit])
        : db.selectObjects("SELECT summary, archived_ts, bytes, events FROM sessions WHERE last_ts < ? ORDER BY last_ts DESC LIMIT ?", [before, limit]);
    return rows.map((r) => ({
        summary: JSON.parse(String(r.summary)), archivedTs: Number(r.archived_ts), bytes: Number(r.bytes), events: Number(r.events),
        ...(r.snip ? { snippet: String(r.snip) } : {}),
    }));
}

/** Base64 of bytes, in chunks: a screenshot is too large for one spread into `String.fromCharCode`. */
function toBase64(data: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
    return btoa(bin);
}

/** An archived session read back: its row, its events with images restored, and what it would be continued from. */
export function readArchived(db: Database, hash: string): { summary: SessionSummary; events: MlDebugEvent[]; history: SessionHistory | null } | null {
    const row = db.selectObjects("SELECT summary, history FROM sessions WHERE hash = ?", [hash])[0];
    if (!row) return null;
    const images = new Map<string, string>();
    for (const img of db.selectObjects("SELECT i.sha, i.mime, i.data FROM image_refs r JOIN images i ON i.sha = r.sha WHERE r.hash = ?", [hash])) {
        images.set(String(img.sha), `data:${img.mime};base64,${toBase64(img.data as Uint8Array)}`);
    }
    const events = db.selectObjects("SELECT body FROM events WHERE hash = ? ORDER BY pos", [hash]).map((r) =>
        JSON.parse(String(r.body), (_k, v) => (typeof v === "string" && v.startsWith(IMG_MARK) ? images.get(v.slice(IMG_MARK.length)) ?? v : v)) as MlDebugEvent);
    return { summary: JSON.parse(String(row.summary)), events, history: row.history ? JSON.parse(String(row.history)) : null };
}

/** Remove a session from the archive, and any image no other session still references. Its month's folder file is then
 *  dirty, so the next sync rewrites it without the session: a delete reaches the folder too. */
export function removeArchived(db: Database, hash: string): boolean {
    let removed = false;
    db.transaction(() => {
        const was = db.selectValue("SELECT last_ts FROM sessions WHERE hash = ?", [hash]);
        removed = was != null;
        if (removed) markDirty(db, Number(was));
        for (const t of ["sessions", "events", "event_text", "image_refs"]) db.exec({ sql: `DELETE FROM ${t} WHERE hash = ?`, bind: [hash] });
        db.exec("DELETE FROM images WHERE sha NOT IN (SELECT sha FROM image_refs)");
    });
    return removed;
}

/** How big the archive is, for the Storage page. */
export function archiveStats(db: Database): { sessions: number; events: number; bytes: number; images: number; imageBytes: number } {
    const s = db.selectObjects("SELECT count(*) AS n, coalesce(sum(events), 0) AS e, coalesce(sum(bytes), 0) AS b FROM sessions")[0];
    const i = db.selectObjects("SELECT count(*) AS n, coalesce(sum(length(data)), 0) AS b FROM images")[0];
    return { sessions: Number(s.n), events: Number(s.e), bytes: Number(s.b), images: Number(i.n), imageBytes: Number(i.b) };
}

/** The folder file a session belongs to: the UTC month of its last activity, `YYYY-MM`. */
export function monthOf(ts: number): string {
    return new Date(ts).toISOString().slice(0, 7);
}

/** The first and one-past-last epoch ms of a `YYYY-MM` month, UTC. */
export function monthRange(month: string): [number, number] {
    const [y, m] = month.split("-").map(Number);
    return [Date.UTC(y, m - 1, 1), Date.UTC(y, m, 1)];
}

function markDirty(db: Database, ts: number): void {
    db.exec({ sql: "INSERT OR IGNORE INTO dirty_months(month) VALUES (?)", bind: [monthOf(ts)] });
}

/** Months whose folder file no longer matches the archive, oldest first. */
export function dirtyMonths(db: Database): string[] {
    return db.selectValues("SELECT month FROM dirty_months ORDER BY month").map(String);
}

/** A month's file was written: it matches again. */
export function markClean(db: Database, month: string): void {
    db.exec({ sql: "DELETE FROM dirty_months WHERE month = ?", bind: [month] });
}

/** Every month that has sessions, for a first sync to a newly picked folder. */
export function allMonths(db: Database): string[] {
    return [...new Set(db.selectValues("SELECT last_ts FROM sessions").map((t) => monthOf(Number(t))))].sort();
}

/**
 * Fill the database attached as `into` (empty, already migrated) with one month's sessions: their rows, events, text
 * and the images they reference. What the folder's `YYYY-MM.sqlite` holds, so the file opens on its own in any
 * SQLite tool and can be imported back.
 */
export function copyMonth(db: Database, into: string, month: string): number {
    const [from, to] = monthRange(month);
    db.transaction(() => {
        db.exec({ sql: `INSERT INTO ${into}.sessions SELECT * FROM main.sessions WHERE last_ts >= ? AND last_ts < ?`, bind: [from, to] });
        db.exec(`INSERT INTO ${into}.events SELECT e.* FROM main.events e JOIN ${into}.sessions s ON s.hash = e.hash`);
        db.exec(`INSERT INTO ${into}.event_text(hash, pos, text) SELECT t.hash, t.pos, t.text FROM main.event_text t JOIN ${into}.sessions s ON s.hash = t.hash`);
        db.exec(`INSERT INTO ${into}.image_refs SELECT r.* FROM main.image_refs r JOIN ${into}.sessions s ON s.hash = r.hash`);
        db.exec(`INSERT OR IGNORE INTO ${into}.images SELECT i.* FROM main.images i WHERE i.sha IN (SELECT sha FROM ${into}.image_refs)`);
    });
    return Number(db.selectValue(`SELECT count(*) FROM ${into}.sessions`));
}

/**
 * Copy what the database attached as `from` (a folder month file) holds into the live archive, skipping any session it
 * already has: a restore into a fresh profile, and harmless to run twice. Imported months are not marked dirty, since
 * the folder already matches them. Refuses a file from a newer schema.
 */
export function importFrom(db: Database, from: string): number {
    const theirs = Number(db.selectValue(`SELECT value FROM ${from}.meta WHERE key = 'schema'`) ?? 0);
    if (theirs > ARCHIVE_SCHEMA) throw new Error(`that archive file was written by a newer version (schema ${theirs})`);
    let added = 0;
    db.transaction(() => {
        const fresh = `SELECT hash FROM ${from}.sessions WHERE hash NOT IN (SELECT hash FROM main.sessions)`;
        db.exec(`CREATE TEMP TABLE import_new AS ${fresh}`);
        added = Number(db.selectValue("SELECT count(*) FROM temp.import_new"));
        db.exec(`INSERT INTO main.sessions SELECT * FROM ${from}.sessions WHERE hash IN (SELECT hash FROM temp.import_new)`);
        db.exec(`INSERT INTO main.events SELECT * FROM ${from}.events WHERE hash IN (SELECT hash FROM temp.import_new)`);
        db.exec(`INSERT INTO main.event_text(hash, pos, text) SELECT hash, pos, text FROM ${from}.event_text WHERE hash IN (SELECT hash FROM temp.import_new)`);
        db.exec(`INSERT OR IGNORE INTO main.image_refs SELECT * FROM ${from}.image_refs WHERE hash IN (SELECT hash FROM temp.import_new)`);
        db.exec(`INSERT OR IGNORE INTO main.images SELECT * FROM ${from}.images`);
        db.exec("DROP TABLE temp.import_new");
    });
    return added;
}

/** "SQLite format 3\0", the first 16 bytes of every SQLite database file. */
const SQLITE_MAGIC = [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00];

/** One month as a standalone SQLite file's bytes: built in an attached in-memory database and serialized, so no
 *  temporary file is involved. The memory it costs is one month's archive. */
export function exportMonth(sqlite3: Sqlite3Static, db: Database, month: string): { bytes: Uint8Array; sessions: number } {
    db.exec("ATTACH DATABASE ':memory:' AS snap");
    try {
        migrate(db, "snap");
        db.exec("DELETE FROM snap.dirty_months");
        const sessions = copyMonth(db, "snap", month);
        return { bytes: sqlite3.capi.sqlite3_js_db_export(db.pointer!, "snap"), sessions };
    } finally { db.exec("DETACH DATABASE snap"); }
}

/** Import a month file's bytes (a folder snapshot) into the live archive; returns how many sessions were new. */
export function importBytes(sqlite3: Sqlite3Static, db: Database, bytes: Uint8Array): number {
    // Checked before anything is attached: SQLite accepts any bytes into `deserialize` and fails only at the first
    // read, which then leaves an attachment it will not detach.
    if (bytes.byteLength < 100 || !SQLITE_MAGIC.every((b, i) => bytes[i] === b)) throw new Error("not an archive file");
    db.exec("ATTACH DATABASE ':memory:' AS imp");
    try {
        const p = sqlite3.wasm.allocFromTypedArray(bytes);
        const rc = sqlite3.capi.sqlite3_deserialize(db.pointer!, "imp", p, bytes.byteLength, bytes.byteLength,
            sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_READONLY);
        if (rc !== 0) { sqlite3.wasm.dealloc(p); throw new Error(`not an archive file (sqlite error ${rc})`); }
        return importFrom(db, "imp");
    } finally { db.exec("DETACH DATABASE imp"); }
}

/** Every month with sessions is dirty: a folder was just picked (or re-picked), and holds none of them yet. */
export function markAllDirty(db: Database): void {
    for (const m of allMonths(db)) db.exec({ sql: "INSERT OR IGNORE INTO dirty_months(month) VALUES (?)", bind: [m] });
}

/** A value kept in `meta` (the last sync, for Settings). */
export function metaGet(db: Database, key: string): string | null {
    const v = db.selectValue("SELECT value FROM meta WHERE key = ?", [key]);
    return v == null ? null : String(v);
}

/** Keep a value in `meta`, replacing the old one. */
export function metaSet(db: Database, key: string, value: string): void {
    db.exec({ sql: "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", bind: [key, value] });
}

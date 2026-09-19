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
import type { Database } from "@sqlite.org/sqlite-wasm";
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

/** Create or upgrade the schema. Safe to call on every open. */
export function migrate(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (
            hash TEXT PRIMARY KEY, runtime TEXT NOT NULL, kind TEXT NOT NULL,
            title TEXT, task TEXT, model TEXT,
            created_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL, archived_ts INTEGER NOT NULL,
            events INTEGER NOT NULL, bytes INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
            summary TEXT NOT NULL, history TEXT, split TEXT
        );
        CREATE INDEX IF NOT EXISTS sessions_last_ts ON sessions(last_ts DESC);
        CREATE TABLE IF NOT EXISTS events (
            hash TEXT NOT NULL, pos INTEGER NOT NULL, kind TEXT NOT NULL, ts INTEGER, body TEXT NOT NULL,
            PRIMARY KEY (hash, pos)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS images (sha TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS image_refs (hash TEXT NOT NULL, sha TEXT NOT NULL, PRIMARY KEY (hash, sha)) WITHOUT ROWID;
        CREATE VIRTUAL TABLE IF NOT EXISTS event_text USING fts5(hash UNINDEXED, pos UNINDEXED, text);
    `);
    const have = Number(db.selectValue("SELECT value FROM meta WHERE key = 'schema'") ?? 0);
    if (have > ARCHIVE_SCHEMA) throw new Error(`this archive was written by a newer version (schema ${have}); update the extension to read it`);
    db.exec({ sql: "INSERT OR REPLACE INTO meta(key, value) VALUES ('schema', ?)", bind: [String(ARCHIVE_SCHEMA)] });
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
    const rows = q
        ? db.selectObjects(
            `SELECT summary, archived_ts, bytes, events FROM sessions
             WHERE last_ts < ? AND hash IN (SELECT hash FROM event_text WHERE event_text MATCH ?)
             ORDER BY last_ts DESC LIMIT ?`, [before, `"${q.replace(/"/g, '""')}"`, limit])
        : db.selectObjects("SELECT summary, archived_ts, bytes, events FROM sessions WHERE last_ts < ? ORDER BY last_ts DESC LIMIT ?", [before, limit]);
    return rows.map((r) => ({ summary: JSON.parse(String(r.summary)), archivedTs: Number(r.archived_ts), bytes: Number(r.bytes), events: Number(r.events) }));
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

/** Remove a session from the archive, and any image no other session still references. */
export function removeArchived(db: Database, hash: string): boolean {
    let removed = false;
    db.transaction(() => {
        removed = Number(db.selectValue("SELECT count(*) FROM sessions WHERE hash = ?", [hash])) > 0;
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

// SAVED SESSIONS: the events a session is made of, in IndexedDB, so a list survives an evicted service worker and a
// transcript can be read back tomorrow (docs/spec/CHAT_PAGE.md slice 4).
//
// It stores the DEBUG EVENTS, not a transcript rebuilt from them, because that is what the sidebar, the chat page and
// both exports already render: a saved run reads exactly like a live one, and there is no second rendering path to
// keep in step. The cost is size — a run with twenty screenshots is most of a megabyte — so size is handled where it
// belongs, in a budget and an eviction policy, rather than by storing less of each session.
//
// `planEviction` in `value-store.ts` is the same shape of decision for stored VALUES and deliberately not shared:
// a value is idle when nothing has READ it and leaves a tombstone so a later dereference can say why it is gone,
// while a session is evicted whole, by age, and simply stops being listed. The common part is four lines.
import type { MlDebugEvent, SubcallUsage } from "../contract/contract-debug";
import type { NeutralMessage } from "../contract/contract-chat";
import type { StartRunPayload, StoredSession } from "../contract/contract-messages";
import type { SessionSummary } from "./session-host";
import { addBytes, emptyBytes, measureEvents, snapshotRows, type SessionBytes, type StorageSnapshot } from "./session-storage-stats";
import { collectPngs, replaceImages } from "./image-compact";

/** How much of a person's disk the saved sessions may use before the oldest are dropped. */
export const STORE_BUDGET_BYTES = 256 * 1024 * 1024;
/** How many sessions are kept, whatever their size: a list nobody can scroll is not worth the disk either. */
export const STORE_MAX_SESSIONS = 500;
/** Streamed deltas are written in batches this often, rather than one transaction per event: a streaming run emits one
 *  every ~100 ms, and a transaction each would spend more time in IndexedDB than in the model. Anything else is
 *  written on the next tick (`schedule`). */
export const FLUSH_MS = 400;
/** How long a session whose move to the archive failed is left alone before the next attempt. */
export const ARCHIVE_RETRY_MS = 60 * 60 * 1000;

const DB_NAME = "ml-saved-sessions";
/** 2: a session's history is records in `history` and `runmeta`, not a field of its row
 *  (docs/spec/SESSION_HISTORY_STORE.md, §3). */
const DB_VERSION = 2;
const SESSIONS = "sessions", EVENTS = "events";
/** `[hash, pos]` → one `NeutralMessage`; `[hash]` → {@link RunMeta}. `marks` and `views` are created now, empty, so
 *  slice 5 of the spec writes them without another version. */
const HISTORY = "history", RUNMETA = "runmeta", MARKS = "marks", VIEWS = "views";

/**
 * What a session would be CONTINUED from, as opposed to what it would be READ from.
 *
 * The events are the transcript; this is the model's own history, and the two are not interchangeable — a reader
 * needs the steps and their outputs, a loop needs the message array. A chat's is the same record `ml.resumeChat`
 * reads, written from one place, so the two can never disagree about what a chat is.
 */
export type SessionHistory =
    | { kind: "chat"; session: StoredSession }
    /**
     * A run: what it said, and the payload it was started with. The payload is what makes it CONTINUABLE rather
     * than merely readable — it carries the system prompt, the tool descriptors and the `RebuildConfig` a fresh
     * page rebuilds the toolset from, which is the whole of what `RESUME_RUN` needs and none of which can be
     * reconstructed from the transcript. `sub` is the session's cumulative sub-call spend, so a resumed turn
     * keeps reporting the session total rather than restarting the tally.
     */
    | { kind: "agent"; messages: NeutralMessage[]; payload?: StartRunPayload; sub?: SubcallUsage };

/**
 * Everything a {@link SessionHistory} is besides its messages: the record in `runmeta`. Written when it changes (a new
 * turn's payload, a chat's settings), not at every step. A field added here later needs no new database version.
 */
export type RunMeta =
    | { kind: "chat"; session: Omit<StoredSession, "messages"> }
    | { kind: "agent"; payload?: StartRunPayload; sub?: SubcallUsage };

/** What one write does to a session's history: positions put, the positions from `cut` on deleted, and the
 *  `runmeta` record when it changed. Part of the same transaction as the session's events and row. */
export interface HistoryWrite {
    puts: [pos: number, message: NeutralMessage][];
    /** delete every position at or past this one: a history that came back shorter than the one stored */
    cut?: number;
    meta?: RunMeta;
}

/** One saved session's row: its summary, and what it costs. */
export interface StoredSessionRow {
    hash: string;
    summary: SessionSummary;
    /** epoch ms of the newest event written */
    lastTs: number;
    createdTs: number;
    /** approximate, the serialized length of every event */
    bytes: number;
    /** how many events are stored, so the next `seq` continues rather than colliding */
    count: number;
    /**
     * What this session would be continued from, on a row written before version 2 only: the upgrade
     * ({@link SessionStore.migrate}) moves it to `history` and `runmeta` and rewrites the row without it. Until then,
     * this is what a resume reads.
     */
    history?: SessionHistory;
    /** 2: the history, when there is one, is in the `history` and `runmeta` stores */
    form?: 2;
    /** how many `history` positions are stored */
    historyCount?: number;
    /** the serialized length of those positions: counted toward the budget beside `bytes` */
    historyBytes?: number;
    /**
     * Where this session's bytes go, kept current as its events are written, so the Storage page sums rows instead
     * of reading every event. Absent on a session saved before this existed: its bytes count as unmeasured.
     */
    split?: SessionBytes;
    /**
     * How many of its events the image compaction has been over (`compactImages`): those before it hold no PNG it
     * could still shrink. Absent on a session written before compaction existed, which makes all of it a candidate.
     */
    compacted?: number;
}

/** What one session's image compaction did. */
export interface CompactResult {
    /** distinct PNG images found in the events it went over */
    found: number;
    /** how many of them are now WebP: the rest stay PNG (not opaque, not smaller, or not pixel-identical) */
    compacted: number;
    /** the serialized size of those events before and after */
    bytesBefore: number;
    bytesAfter: number;
    /** the event it started at: above 0, a session gone over before (new events, or a pass that was interrupted) */
    from: number;
}

/** How many new images one commit of the image compaction holds at most: what a browser closed mid-session loses. */
export const COMPACT_CHUNK_IMAGES = 8;

/** Approximate retained size, the same measure the in-memory index uses: a screenshot dominates, and its data URL is
 *  its length. */
export function sizeOf(ev: MlDebugEvent): number {
    try { return JSON.stringify(ev).length; } catch { return 1024; }
}

/**
 * WHICH SAVED SESSIONS TO DROP: oldest activity first, until both the byte budget and the count fit. Pure, so the
 * policy is tested without a database.
 *
 * `protect` is never dropped — the session a page has open, and any session still running, whose events are still
 * arriving and whose row would come straight back. Neither is a pinned session.
 */
export function planEviction(rows: readonly StoredSessionRow[], o: { budgetBytes?: number; maxSessions?: number; incoming?: number; protect?: readonly string[] }): string[] {
    const budget = o.budgetBytes ?? STORE_BUDGET_BYTES, max = o.maxSessions ?? STORE_MAX_SESSIONS;
    // A pinned session counts toward the budget and is never what pays for it. The number of pins is bounded by the
    // runtime, so the budget can be exceeded by at most what the pinned sessions hold.
    const protect = new Set([...(o.protect ?? []), ...rows.filter((r) => r.summary.pinned).map((r) => r.hash)]);
    const order = [...rows].sort((a, b) => a.lastTs - b.lastTs || a.createdTs - b.createdTs);
    let total = rows.reduce((n, r) => n + storedBytes(r), 0) + (o.incoming ?? 0);
    let count = rows.length;
    const out: string[] = [];
    for (const r of order) {
        if (total <= budget && count <= max) break;
        if (protect.has(r.hash)) continue;
        out.push(r.hash);
        total -= storedBytes(r);
        count -= 1;
    }
    return out;
}

/** What a session holds on disk, for the budget: its events and its history. */
export function storedBytes(r: StoredSessionRow): number {
    return r.bytes + (r.historyBytes ?? 0);
}

/** Why a saved session left the store. `"archived"` is reserved for when an archive folder exists: expiring a
 *  session will then move it there rather than delete it, and the record already has the word for it. */
export type StoreEviction = { hash: string; reason: "budget" | "retention"; outcome: "deleted" | "archived" | "kept"; bytes: number; idleMs: number; error?: string };

/**
 * WHICH SAVED SESSIONS HAVE EXPIRED: idle for longer than `retainMs`, measured from the last thing they did. Pure.
 *
 * Retention is a rule about a person's history, not about space, so it ignores the budget entirely: a store that is
 * nearly empty still forgets a session past its time. A pinned session never expires, and neither does a protected
 * one (open on a page, or still running). `retainMs` of 0 or less keeps everything.
 */
export function planExpiry(rows: readonly StoredSessionRow[], o: { now: number; retainMs: number; protect?: readonly string[] }): string[] {
    if (!(o.retainMs > 0)) return [];
    const protect = new Set(o.protect ?? []);
    return rows.filter((r) => !r.summary.pinned && !protect.has(r.hash) && o.now - r.lastTs > o.retainMs).map((r) => r.hash);
}

/** A place to put saved sessions. The worker's is IndexedDB; the tests' is a map. */
export interface SessionStoreBackend {
    rows(): Promise<StoredSessionRow[]>;
    /** append `events` to `hash`, from `seq`, apply `history`, and write its row: one transaction */
    append(row: StoredSessionRow, from: number, events: MlDebugEvent[], history?: HistoryWrite): Promise<void>;
    events(hash: string): Promise<MlDebugEvent[]>;
    /** the `history` positions `[from, to)` of one session, in order */
    historyRange(hash: string, from: number, to: number): Promise<NeutralMessage[]>;
    runMeta(hash: string): Promise<RunMeta | null>;
    /** a session's row, events, history and `runmeta`, all of it */
    remove(hashes: string[]): Promise<void>;
}

/** What one failed write did not save, for the housekeeping log and the line on the session. */
export interface WriteFailure { hash: string; events: number; positions: number; error: string }

/** One session moved to the version-2 form by {@link SessionStore.migrate}, or one that failed to move. */
export interface Migrated { hash: string; positions: number; bytes: number; error?: string }

/** A message's serialized length and a 32-bit FNV-1a of its JSON: how a position is compared when its object is not
 *  the one last written, and what its size counts as. */
function measureMessage(m: NeutralMessage): { len: number; print: number } {
    let json: string;
    try { json = JSON.stringify(m) ?? ""; } catch { json = ""; }
    let h = 0x811c9dc5;
    for (let i = 0; i < json.length; i++) { h ^= json.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return { len: json.length, print: h >>> 0 };
}

/** A history split into what goes to `history` and what goes to `runmeta`. */
function splitHistory(h: SessionHistory): { messages: NeutralMessage[]; meta: RunMeta } {
    if (h.kind === "chat") {
        const { messages, ...rest } = h.session;
        return { messages: messages ?? [], meta: { kind: "chat", session: rest } };
    }
    return { messages: h.messages, meta: { kind: "agent", ...(h.payload ? { payload: h.payload } : {}), ...(h.sub ? { sub: h.sub } : {}) } };
}

/** The history a resume reads, put back together from its `runmeta` and its positions. */
function joinHistory(meta: RunMeta, messages: NeutralMessage[]): SessionHistory {
    return meta.kind === "chat" ? { kind: "chat", session: { ...meta.session, messages } as StoredSession } : { kind: "agent", messages, ...(meta.payload ? { payload: meta.payload } : {}), ...(meta.sub ? { sub: meta.sub } : {}) };
}

/** What the writer last wrote for a live session: the message objects (references; the loop already holds them),
 *  each position's length and print, and the `runmeta` record's print. */
interface Written { refs: NeutralMessage[]; lens: number[]; prints: number[]; metaPrint: number }

/**
 * The saved sessions, as the worker uses them: rows in memory, writes batched, eviction applied as it writes.
 *
 * Every write is fire-and-forget from the caller's side — an event reaching the index must never wait on a disk — so
 * failures are reported through `onError` rather than thrown at whoever emitted the event.
 */
export class SessionStore {
    private readonly rows = new Map<string, StoredSessionRow>();
    private readonly pending = new Map<string, MlDebugEvent[]>();
    /** rows whose own fields changed with no events to carry them: a history written between turns */
    private readonly dirty = new Set<string>();
    /** the newest history of each session, until it is written */
    private readonly queuedHistory = new Map<string, SessionHistory>(); // state: plumbing
    /** what the writer last wrote, per session still running or waiting: dropped when it settles, so the next write
     *  of its history is a whole one */
    private readonly written = new Map<string, Written>(); // state: cache
    private timer: ReturnType<typeof setTimeout> | null = null;
    /** the pending timer is the next-tick one, not the batch one */
    private urgent = false;
    /** sessions whose move to the archive failed, and when: kept, and not tried again for a while */
    private readonly archiveFailed = new Map<string, number>();
    private flushing: Promise<void> = Promise.resolve();
    private ready: Promise<void> | null = null;
    /** the rows on disk have been read, so a row's `count` is its real length */
    private loaded = false;

    constructor(
        private readonly backend: SessionStoreBackend,
        private readonly opts: {
            budgetBytes?: number; maxSessions?: number; flushMs?: number;
            /** The size and count caps, read at every eviction so a changed setting applies without a restart. Wins
             *  over `budgetBytes`/`maxSessions`. `Infinity` for either means no cap of that kind. */
            limits?: () => { budgetBytes: number; maxSessions: number };
            now?: () => number;
            /** hashes that must survive an eviction: what a page has open */
            protect?: () => readonly string[];
            /**
             * Sessions this store has just thrown away to stay inside its budget. The store is the one authority on
             * whether a SAVED session exists, so whatever else lists sessions has to hear about it — or a session
             * stays in the list after its history has left the disk.
             */
            onEvict?: (hashes: string[]) => void;
            /** One record per session the store dropped on its own, for the housekeeping log. */
            onEvicted?: (e: StoreEviction) => void;
            /** How long an unpinned session is kept after it last did something; 0 or absent keeps it. Read at every
             *  sweep, so a changed setting applies without a restart. */
            retainMs?: () => number;
            /**
             * Move a session to the long-term archive instead of deleting it: resolves once it is safely there. Absent,
             * or `enabled()` false, and an eviction deletes as before. A move that fails KEEPS the session: deleting
             * what someone asked to have archived is the one outcome here that cannot be undone.
             */
            archive?: { enabled(): boolean; move(row: StoredSessionRow, events: MlDebugEvent[], history: SessionHistory | null): Promise<void> };
            /** Something was written: what schedules the image compaction, which waits for the writes to stop. */
            onWrite?: () => void;
            onError?: (err: unknown) => void;
            /** One session's write failed: what was not saved. The run goes on; the next write starts over. */
            onWriteFailed?: (f: WriteFailure) => void;
            /** One record per session the upgrade moved, or failed to move. */
            onMigrated?: (m: Migrated) => void;
            /**
             * The test build's check of the RULE the writer depends on: a message object is never mutated after it
             * enters `messages`. At each write, every position whose object is unchanged is measured again, and one
             * whose content moved under the same object is reported through `onError`, naming the position.
             */
            checkImmutable?: boolean;
        } = {},
    ) {}

    /** Read the rows once, so a restarted worker can list what it saved before. */
    async open(): Promise<StoredSessionRow[]> {
        this.ready ??= (async () => {
            for (const row of await this.backend.rows()) this.rows.set(row.hash, row);
            this.loaded = true;
        })();
        await this.ready;
        return [...this.rows.values()].sort((a, b) => b.lastTs - a.lastTs);
    }

    /**
     * Apply retention and the caps now. A worker that starts and finds sessions past their time forgets them before
     * listing them, one that has been idle for a week does the same on its next write, and a lowered setting takes
     * effect while the person who lowered it watches. Returns what it dropped.
     */
    async sweep(): Promise<string[]> {
        await this.open();
        return this.evict();
    }

    /** Retention first: what has expired should not survive because the budget happened to have room, and what it
     *  frees is room the budget no longer has to find. */
    private async evict(): Promise<string[]> {
        const expired = await this.drop(planExpiry([...this.rows.values()], { now: this.now(), retainMs: this.opts.retainMs?.() ?? 0, protect: this.protected() }), "retention");
        const limits = this.opts.limits?.() ?? { budgetBytes: this.opts.budgetBytes ?? STORE_BUDGET_BYTES, maxSessions: this.opts.maxSessions ?? STORE_MAX_SESSIONS };
        const over = await this.drop(planEviction([...this.rows.values()], { ...limits, protect: this.protected() }), "budget");
        return [...expired, ...over];
    }

    private now(): number {
        return this.opts.now?.() ?? Date.now();
    }

    private protected(): string[] {
        return [...(this.opts.protect?.() ?? []), ...this.running()];
    }

    private async drop(hashes: string[], reason: StoreEviction["reason"]): Promise<string[]> {
        if (!hashes.length) return [];
        const now = this.now();
        const rows = hashes.map((h) => this.rows.get(h)).filter((r): r is StoredSessionRow => !!r);
        const archive = this.opts.archive?.enabled() ? this.opts.archive : null;
        const gone: { row: StoredSessionRow; outcome: StoreEviction["outcome"] }[] = [];
        for (const row of rows) {
            if (!archive) { gone.push({ row, outcome: "deleted" }); continue; }
            // A move that failed recently is not retried on every write, which would log the same failure each time.
            if (now - (this.archiveFailed.get(row.hash) ?? -Infinity) < ARCHIVE_RETRY_MS) continue;
            try {
                await archive.move(row, await this.read(row.hash), await this.readHistory(row));
                this.archiveFailed.delete(row.hash);
                gone.push({ row, outcome: "archived" });
            } catch (err) {
                this.archiveFailed.set(row.hash, now);
                this.opts.onEvicted?.({ hash: row.hash, reason, outcome: "kept", bytes: row.bytes, idleMs: Math.max(0, now - row.lastTs), error: String((err as Error)?.message || err).slice(0, 200) });
            }
        }
        const dropped = gone.map((g) => g.row.hash);
        await this.forget(dropped);
        if (dropped.length) this.opts.onEvict?.(dropped);
        for (const { row, outcome } of gone) this.opts.onEvicted?.({ hash: row.hash, reason, outcome, bytes: row.bytes, idleMs: Math.max(0, now - row.lastTs) });
        return dropped;
    }

    /** The largest saved sessions, by the size their rows record. */
    async largest(n = 10): Promise<{ hash: string; title?: string; bytes: number; pinned?: true }[]> {
        await this.open();
        return [...this.rows.values()].sort((a, b) => b.bytes - a.bytes).slice(0, n)
            .map((r) => ({ hash: r.hash, ...(r.summary.title ? { title: r.summary.title } : {}), bytes: r.bytes, ...(r.summary.pinned ? { pinned: true as const } : {}) }));
    }

    /** Where the store's bytes go right now, from the rows' running breakdowns. No event is read. */
    async snapshot(): Promise<StorageSnapshot> {
        await this.open();
        return snapshotRows([...this.rows.values()], this.now());
    }

    /**
     * How a session's history is stored, for the state inspector: the form, how many positions and bytes, whether a
     * newer one waits to be written, and whether the writer remembers the last write (so the next writes only what
     * changed). Undefined when the store does not hold the session.
     */
    historyForm(hash: string): { form: 1 | 2; positions: number; bytes: number; queued: boolean; remembered: boolean } | undefined {
        const row = this.rows.get(hash);
        if (!row) return undefined;
        const positions = row.history ? splitHistory(row.history).messages.length : row.historyCount ?? 0;
        return { form: row.form ?? 1, positions, bytes: row.historyBytes ?? 0, queued: this.queuedHistory.has(hash), remembered: this.written.has(hash) };
    }

    /** Is this session saved here? */
    has(hash: string): boolean {
        return this.rows.has(hash);
    }

    /** Queue one event. Returns at once; the write happens on the next flush. */
    put(summary: SessionSummary, event: MlDebugEvent): void {
        const hash = summary.id.hash;
        const now = this.opts.now?.() ?? Date.now();
        const row = this.rows.get(hash) ?? { hash, summary, lastTs: 0, createdTs: summary.createdTs ?? now, bytes: 0, count: 0 };
        row.summary = summary;
        // The INDEX's notion of when this session last did something, not the event's own stamp and NOT the wall
        // clock: the index already maintains it (and coalesces a streaming run's deltas into it), and two answers to
        // "how old is this" put the eviction order and the list order out of step. Seeding a new row with `now`
        // instead is the version of this that looks right and is not — every row then reads as "just now", so the
        // oldest session evicted is whichever the worker happened to see first.
        row.lastTs = Math.max(row.lastTs, summary.lastTs ?? 0, event.ts ?? 0) || now;
        this.rows.set(hash, row);
        const queue = this.pending.get(hash) ?? [];
        queue.push(event);
        this.pending.set(hash, queue);
        this.schedule(event.kind !== "agent-stream" && event.kind !== "chat-stream");   // a live preview is batched, never flushed eagerly
    }

    /**
     * What this session would be continued from. It OVERWRITES: a history is the whole of it rather than an append,
     * and the newest is the only one worth keeping.
     *
     * A session this store does not keep is ignored rather than created — an ephemeral session does not become
     * saved by having a history.
     */
    putHistory(hash: string, history: SessionHistory): void {
        const row = this.rows.get(hash);
        if (!row) return;
        this.queuedHistory.set(hash, history);
        this.dirty.add(hash);
        this.schedule(true);
    }

    /**
     * A saved session's row changed with no event behind it: a pin. The row is created when the session has none yet,
     * because a session pinned before it emitted anything worth writing still has to come back pinned.
     */
    putSummary(summary: SessionSummary): void {
        if (!summary.saved) return;
        const hash = summary.id.hash;
        const now = this.opts.now?.() ?? Date.now();
        const row = this.rows.get(hash) ?? { hash, summary, lastTs: summary.lastTs || now, createdTs: summary.createdTs ?? now, bytes: 0, count: 0 };
        row.summary = summary;
        this.rows.set(hash, row);
        this.dirty.add(hash);
        this.schedule(true);
    }

    /**
     * Put a whole session back: an archived one brought back to be opened. Its row, every event and its history, as
     * one write. Retention and the budget measure it from `touchedTs`, not its last activity: a session someone just
     * brought back must not be archived again by the next sweep. Nothing happens when the store already holds it.
     */
    async restoreSession(summary: SessionSummary, events: MlDebugEvent[], history: SessionHistory | null, touchedTs: number): Promise<void> {
        await this.open();
        const hash = summary.id.hash;
        if (this.rows.has(hash)) return;
        this.rows.set(hash, { hash, summary: { ...summary, saved: true }, lastTs: touchedTs, createdTs: summary.createdTs ?? touchedTs, bytes: 0, count: 0 });
        this.pending.set(hash, [...events]);
        if (history) { this.queuedHistory.set(hash, history); this.dirty.add(hash); }
        await this.flush();
    }

    /**
     * What a session would be continued from, or null when this store does not hold it. The newest queued one, else
     * the row's own (a row not yet upgraded), else read from `runmeta` and `history`.
     */
    async history(hash: string): Promise<SessionHistory | null> {
        await this.open();
        if (!this.rows.has(hash)) return null;
        // After the write lock, so a write half-way through is not read as the history.
        await this.flushing;
        const row = this.rows.get(hash);
        return row ? this.readHistory(row) : null;
    }

    /** {@link history} without the lock, for what already runs inside it (an eviction moving a session to the archive). */
    private async readHistory(row: StoredSessionRow): Promise<SessionHistory | null> {
        const queued = this.queuedHistory.get(row.hash);
        if (queued) return queued;
        if (row.history) return row.history;
        if (!row.form) return null;
        const meta = await this.backend.runMeta(row.hash);
        if (!meta) return null;
        return joinHistory(meta, await this.backend.historyRange(row.hash, 0, row.historyCount ?? 0));
    }

    /** Everything a saved session holds, oldest first. Empty when it is not saved here. */
    async read(hash: string): Promise<MlDebugEvent[]> {
        await this.open();
        const stored = this.rows.has(hash) ? await this.backend.events(hash) : [];
        return [...stored, ...(this.pending.get(hash) ?? [])];
    }

    /** Forget a session: a delete, or an eviction. */
    async forget(hashes: string[]): Promise<void> {
        if (!hashes.length) return;
        for (const hash of hashes) { this.rows.delete(hash); this.pending.delete(hash); this.queuedHistory.delete(hash); this.written.delete(hash); }
        await this.backend.remove(hashes);
    }

    /** Write everything queued. Awaited by tests and by `session.delete`, so a delete cannot race a pending write. */
    async flush(): Promise<void> {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; this.urgent = false; }
        // One at a time: two flushes writing the same session would both read `count` before either wrote it.
        this.flushing = this.flushing.then(() => this.write()).catch((err) => this.opts.onError?.(err));
        return this.flushing;
    }

    /**
     * Write soon. Only a streamed delta waits `FLUSH_MS` for company; everything else (a start, a step, a result, a
     * history, a pin) goes on the next tick. The browser stops a worker without warning, and whatever is still queued
     * then is lost: with every event batched, a short chat that finished inside one window lost its whole session
     * to a stop a moment later, row included. A lost delta costs nothing, since the step or result after it carries
     * the whole text.
     */
    private schedule(urgent = false): void {
        if (this.timer && !(urgent && !this.urgent)) return;
        if (this.timer) clearTimeout(this.timer);
        this.urgent = urgent;
        this.timer = setTimeout(() => { this.timer = null; this.urgent = false; void this.flush(); }, urgent ? 0 : this.opts.flushMs ?? FLUSH_MS);
        // In Node (tests, scripts), a pending flush timer holds the process open; the browser kills a worker's timers
        // regardless. A background flush must never be why a process stays alive.
        (this.timer as unknown as { unref?: () => void }).unref?.();
    }

    private async write(): Promise<void> {
        await this.open();
        const batches = [...this.pending.entries()];
        this.pending.clear();
        // A row whose history changed with no events behind it still has to reach the disk, or a session's newest
        // turn is readable and not continuable until something else happens to it.
        for (const hash of this.dirty) if (!batches.some(([h]) => h === hash)) batches.push([hash, []]);
        this.dirty.clear();
        // Counted for every batch BEFORE any is written: `pending` is already empty, so a batch not yet counted would
        // be in neither, and a reader asking how much is stored would miss it for the length of the write.
        const writes: { row: StoredSessionRow; before: StoredSessionRow; from: number; events: MlDebugEvent[]; queued?: SessionHistory; hist?: { write: HistoryWrite; next: Written } }[] = [];
        for (const [hash, events] of batches) {
            const row = this.rows.get(hash);
            // `forget` clears a session's queue as well as its row, so this is the second line of defence rather
            // than the first: no test can reach it, and it is here so that a future change to `forget` cannot turn
            // a delete into a session that quietly writes itself back. A batch with no events is a row whose own
            // fields changed — a history written between turns — and still has to reach the disk.
            if (!row) continue;
            const before = { ...row };
            const from = row.count;
            row.count += events.length;
            // One serialization per event, shared with the budget: the breakdown's total IS the size added.
            const m = measureEvents(events);
            row.bytes += m.total;
            // Only a session measured from its first event has a breakdown that means anything; an older one stays
            // unmeasured rather than claiming its newest events are all of it.
            if (row.split || from === 0) row.split = addBytes(row.split ?? emptyBytes(), m);
            const queued = this.queuedHistory.get(hash);
            this.queuedHistory.delete(hash);
            // A row written before version 2 that is written now for any reason moves its history in the same
            // transaction: the row on disk never loses `history` without the records that replace it.
            const source = queued ?? row.history;
            const hist = source ? this.planHistory(hash, source) : undefined;
            if (hist) {
                delete row.history;
                row.historyCount = hist.next.refs.length;
                row.historyBytes = hist.next.lens.reduce((a, n) => a + n, 0);
            }
            row.form = 2;
            writes.push({ row, before, from, events, ...(queued ? { queued } : {}), ...(hist ? { hist } : {}) });
        }
        for (const w of writes) {
            const { history: _old, ...stored } = w.row;
            try {
                await this.backend.append(stored, w.from, w.events, w.hist?.write);
                if (w.hist && this.isLive(w.row)) this.written.set(w.row.hash, w.hist.next); else this.written.delete(w.row.hash);
            } catch (err) {
                // What was not saved is said, and the session goes on: the row is put back as it was, so the next
                // write continues at the right position, and its history is written whole next time.
                // Only what this write changed is put back; a summary or a stamp that arrived meanwhile stays.
                if (this.rows.get(w.row.hash) === w.row) {
                    const b = w.before;
                    Object.assign(w.row, { count: b.count, bytes: b.bytes, split: b.split, form: b.form, historyCount: b.historyCount, historyBytes: b.historyBytes });
                    if (b.history) w.row.history = b.history;
                    if (w.queued && !this.queuedHistory.has(w.row.hash)) this.queuedHistory.set(w.row.hash, w.queued);
                }
                this.written.delete(w.row.hash);
                this.opts.onWriteFailed?.({ hash: w.row.hash, events: w.events.length, positions: w.hist?.write.puts.length ?? 0, error: String((err as Error)?.message || err).slice(0, 200) });
            }
        }
        await this.evict();
        if (writes.length) this.opts.onWrite?.();
    }

    /** A session whose history is still being added to: the writer keeps what it wrote, to write only what changed. */
    private isLive(row: StoredSessionRow): boolean {
        return row.summary.status === "running" || row.summary.status === "waiting";
    }

    /**
     * WHAT TO WRITE of a session's history: positions past the last write are appended; a position whose object is
     * not the one last written is put again unless its content is the same; nothing else. With nothing kept from a
     * last write (the first since the worker started, a session that had settled, a write that failed), every
     * position is put and any stored past the end is deleted.
     *
     * Correct only under the RULE that a message object is never mutated after it enters `messages` (a change
     * replaces it): `checkImmutable` is the test build's check of it.
     */
    private planHistory(hash: string, h: SessionHistory): { write: HistoryWrite; next: Written } {
        const { messages, meta } = splitHistory(h);
        const last = this.written.get(hash);
        const refs = messages.slice(), lens: number[] = [], prints: number[] = [];
        const puts: [number, NeutralMessage][] = [];
        for (let i = 0; i < messages.length; i++) {
            const m = messages[i];
            if (last && i < last.refs.length && last.refs[i] === m) {
                lens.push(last.lens[i]); prints.push(last.prints[i]);
                if (this.opts.checkImmutable && measureMessage(m).print !== last.prints[i]) this.opts.onError?.(new Error(`session ${hash}: history position ${i} changed under the same object; a message is replaced, never mutated`));
                continue;
            }
            const got = measureMessage(m);
            lens.push(got.len); prints.push(got.print);
            if (last && i < last.refs.length && last.prints[i] === got.print && last.lens[i] === got.len) continue;
            puts.push([i, m]);
        }
        const metaPrint = measureMessage(meta as unknown as NeutralMessage).print;
        const write: HistoryWrite = { puts };
        if (!last || messages.length < last.refs.length) write.cut = messages.length;
        if (!last || last.metaPrint !== metaPrint) write.meta = meta;
        return { write, next: { refs, lens, prints, metaPrint } };
    }

    /**
     * THE UPGRADE's background pass: every row still carrying its `history` (written by version 1) is moved to the
     * `history` and `runmeta` stores and rewritten without it, one transaction per session, so a worker stopped in the
     * middle leaves each session in one form or the other and the next start carries on. Until a row is moved, a
     * resume reads the history from the row. Returns how many sessions moved.
     */
    async migrate(): Promise<number> {
        await this.open();
        let moved = 0;
        for (const row of [...this.rows.values()]) {
            if (!row.history || row.form) continue;
            const ok = await new Promise<boolean>((resolve) => {
                this.flushing = this.flushing.then(async () => {
                    if (this.rows.get(row.hash) !== row || !row.history) { resolve(false); return; }
                    // A newer history queued meanwhile wins, and is written by the next flush.
                    const plan = this.planHistory(row.hash, this.queuedHistory.get(row.hash) ?? row.history);
                    const { history: _old, ...stored } = row;
                    const next: StoredSessionRow = { ...stored, form: 2, historyCount: plan.next.refs.length, historyBytes: plan.next.lens.reduce((a, n) => a + n, 0) };
                    try {
                        await this.backend.append(next, row.count, [], plan.write);
                        delete row.history;
                        Object.assign(row, { form: 2, historyCount: next.historyCount, historyBytes: next.historyBytes });
                        this.opts.onMigrated?.({ hash: row.hash, positions: next.historyCount ?? 0, bytes: next.historyBytes ?? 0 });
                        resolve(true);
                    } catch (err) {
                        this.opts.onMigrated?.({ hash: row.hash, positions: 0, bytes: 0, error: String((err as Error)?.message || err).slice(0, 200) });
                        resolve(false);
                    }
                }).catch((err) => { this.opts.onError?.(err); resolve(false); });
            });
            if (ok) moved++;
        }
        return moved;
    }

    /**
     * Sessions holding stored events the image compaction has not been over, biggest first. A running session waits
     * until it settles: its events are still arriving.
     */
    compactable(): string[] {
        return [...this.rows.values()]
            .filter((r) => (r.compacted ?? 0) < r.count && r.summary.status !== "running" && r.summary.status !== "waiting")
            .sort((a, b) => b.bytes - a.bytes)
            .map((r) => r.hash);
    }

    /**
     * Re-encode the PNG screenshots in a session's stored events as lossless WebP, and rewrite those events in place.
     * `encode` answers null to keep an image as it is, and throws when it cannot encode at all, which stops the pass
     * with what was already committed kept.
     *
     * Only the EVENTS: they are what a transcript and the exports show. The row's `history` is what a resume sends the
     * model, and it is the running loop's own array, so it is never touched.
     *
     * COMMITTED IN CHUNKS of at most `chunkImages` new images, each one write that also advances `row.compacted`: a
     * browser closed in the middle of a large session loses one chunk's encoding, and the next pass starts where that
     * one stopped. The encoding happens outside the write lock, since it takes seconds; each commit happens inside it,
     * and only if the session is still the one that was read, so a session deleted or evicted meanwhile is not written
     * back. Null when there was nothing to go over, or the session went away before anything was committed.
     */
    async compactImages(hash: string, encode: (url: string) => Promise<string | null>, o: { chunkImages?: number } = {}): Promise<CompactResult | null> {
        await this.open();
        await this.flushing;
        const row = this.rows.get(hash);
        if (!row) return null;
        const from = row.compacted ?? 0, to = row.count;
        if (from >= to) return null;
        const events = (await this.backend.events(hash)).slice(from, to);
        const max = Math.max(1, o.chunkImages ?? COMPACT_CHUNK_IMAGES);
        const swap = new Map<string, string>(), kept = new Set<string>();
        let result = null as CompactResult | null;
        for (let i = 0; i < events.length;) {
            // The chunk: events up to the one that would bring more than `max` images not yet decided. At least one
            // event, so an event holding more than `max` images is a chunk of its own.
            const fresh = new Set<string>();
            let j = i;
            for (; j < events.length; j++) {
                const add = collectPngs([events[j]]).filter((u) => !swap.has(u) && !kept.has(u) && !fresh.has(u));
                if (j > i && fresh.size + add.length > max) break;
                for (const u of add) fresh.add(u);
            }
            for (const url of fresh) {
                const webp = await encode(url);
                if (webp) swap.set(url, webp); else kept.add(url);
            }
            const before = events.slice(i, j);
            const after = replaceImages(before, swap);
            const changed = after.some((e, k) => e !== before[k]);
            const was = measureEvents(before), now = changed ? measureEvents(after) : was;
            const at = from + i, end = from + j;
            let committed = false as boolean;   // set inside the lock, which TypeScript cannot see
            this.flushing = this.flushing.then(async () => {
                if (this.rows.get(hash) !== row) return;
                row.bytes += now.total - was.total;
                // Only the image bytes move: the rest of each event is unchanged, and so is the number of images.
                if (row.split) row.split = { ...row.split, total: row.split.total + now.total - was.total, images: row.split.images + now.images - was.images };
                row.compacted = Math.max(row.compacted ?? 0, end);
                await this.backend.append({ ...row }, at, changed ? after : []);
                committed = true;
            }).catch((err) => this.opts.onError?.(err));
            await this.flushing;
            if (!committed) return result;
            result = {
                found: (result?.found ?? 0) + fresh.size,
                compacted: (result?.compacted ?? 0) + [...fresh].filter((u) => swap.has(u)).length,
                bytesBefore: (result?.bytesBefore ?? 0) + was.total,
                bytesAfter: (result?.bytesAfter ?? 0) + now.total,
                from,
            };
            i = j;
        }
        return result;
    }

    /** A session whose events are still arriving would be evicted and immediately written again. */
    private running(): string[] {
        return [...this.rows.values()].filter((r) => r.summary.status === "running" || r.summary.status === "waiting").map((r) => r.hash);
    }
}

/** The worker's backend: two object stores, so appending an event does not rewrite the session. */
export function indexedDbBackend(factory: IDBFactory = indexedDB): SessionStoreBackend {
    let db: Promise<IDBDatabase> | null = null;
    const open = (): Promise<IDBDatabase> => (db ??= new Promise((resolve, reject) => {
        const req = factory.open(DB_NAME, DB_VERSION);
        // Version 1 to 2 creates the new stores and touches no existing record: the rows are moved by
        // `SessionStore.migrate`, after open, one session at a time.
        req.onupgradeneeded = () => {
            const d = req.result;
            if (!d.objectStoreNames.contains(SESSIONS)) d.createObjectStore(SESSIONS, { keyPath: "hash" });
            // [hash, seq]: one session's events are a contiguous range, read in the order they were written.
            if (!d.objectStoreNames.contains(EVENTS)) d.createObjectStore(EVENTS);
            // [hash, pos] and [hash]; `marks` [hash, seq] and `views` [hash] wait for slice 5.
            for (const name of [HISTORY, RUNMETA, MARKS, VIEWS]) if (!d.objectStoreNames.contains(name)) d.createObjectStore(name);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    }));
    const done = <T>(req: IDBRequest<T>): Promise<T> => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
    const committed = (tx: IDBTransaction): Promise<void> => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
    return {
        async rows() {
            const d = await open();
            return await done((d.transaction(SESSIONS, "readonly").objectStore(SESSIONS).getAll()) as IDBRequest<StoredSessionRow[]>);
        },
        async append(row, from, events, history) {
            const d = await open();
            const tx = d.transaction(history ? [SESSIONS, EVENTS, HISTORY, RUNMETA] : [SESSIONS, EVENTS], "readwrite");
            const done = committed(tx);
            // A put that throws (a value that cannot be cloned) does not end the transaction: left alone it COMMITS
            // what was queued before it, a row claiming history records that were never written. Abort it instead.
            try {
                tx.objectStore(SESSIONS).put(row);
                const store = tx.objectStore(EVENTS);
                events.forEach((event, i) => store.put(event, [row.hash, from + i]));
                if (history) {
                    const h = tx.objectStore(HISTORY);
                    if (history.cut != null) h.delete(IDBKeyRange.bound([row.hash, history.cut], [row.hash, Number.MAX_SAFE_INTEGER]));
                    for (const [pos, m] of history.puts) h.put(m, [row.hash, pos]);
                    if (history.meta) tx.objectStore(RUNMETA).put(history.meta, row.hash);
                }
            } catch (err) {
                try { tx.abort(); } catch { /* already finished */ }
                done.catch(() => { /* the abort's own rejection: the error worth reporting is this one */ });
                throw err;
            }
            await done;
        },
        async historyRange(hash, from, to) {
            if (to <= from) return [];
            const d = await open();
            const range = IDBKeyRange.bound([hash, from], [hash, to - 1]);
            return await done((d.transaction(HISTORY, "readonly").objectStore(HISTORY).getAll(range)) as IDBRequest<NeutralMessage[]>);
        },
        async runMeta(hash) {
            const d = await open();
            return (await done(d.transaction(RUNMETA, "readonly").objectStore(RUNMETA).get(hash) as IDBRequest<RunMeta | undefined>)) ?? null;
        },
        async events(hash) {
            const d = await open();
            const range = IDBKeyRange.bound([hash, 0], [hash, Number.MAX_SAFE_INTEGER]);
            return await done((d.transaction(EVENTS, "readonly").objectStore(EVENTS).getAll(range)) as IDBRequest<MlDebugEvent[]>);
        },
        async remove(hashes) {
            const d = await open();
            const tx = d.transaction([SESSIONS, EVENTS, HISTORY, RUNMETA], "readwrite");
            for (const hash of hashes) {
                tx.objectStore(SESSIONS).delete(hash);
                tx.objectStore(EVENTS).delete(IDBKeyRange.bound([hash, 0], [hash, Number.MAX_SAFE_INTEGER]));
                tx.objectStore(HISTORY).delete(IDBKeyRange.bound([hash, 0], [hash, Number.MAX_SAFE_INTEGER]));
                tx.objectStore(RUNMETA).delete(hash);
            }
            await committed(tx);
        },
    };
}

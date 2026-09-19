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
import type { MlDebugEvent, SubcallUsage } from "./contract-debug";
import type { NeutralMessage } from "./contract-chat";
import type { StartRunPayload, StoredSession } from "./contract-messages";
import type { SessionSummary } from "./session-host";

/** How much of a person's disk the saved sessions may use before the oldest are dropped. */
export const STORE_BUDGET_BYTES = 256 * 1024 * 1024;
/** How many sessions are kept, whatever their size: a list nobody can scroll is not worth the disk either. */
export const STORE_MAX_SESSIONS = 500;
/** Events are written in batches this often, rather than one transaction per event: a streaming run emits one every
 *  ~100 ms, and a transaction each would spend more time in IndexedDB than in the model. */
export const FLUSH_MS = 400;

const DB_NAME = "ml-saved-sessions";
const DB_VERSION = 1;
const SESSIONS = "sessions", EVENTS = "events";

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
    /** what this session would be continued from, when it is the kind of session that can be */
    history?: SessionHistory;
}

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
    let total = rows.reduce((n, r) => n + r.bytes, 0) + (o.incoming ?? 0);
    let count = rows.length;
    const out: string[] = [];
    for (const r of order) {
        if (total <= budget && count <= max) break;
        if (protect.has(r.hash)) continue;
        out.push(r.hash);
        total -= r.bytes;
        count -= 1;
    }
    return out;
}

/** Why a saved session left the store. `"archived"` is reserved for when an archive folder exists: expiring a
 *  session will then move it there rather than delete it, and the record already has the word for it. */
export type StoreEviction = { hash: string; reason: "budget" | "retention"; outcome: "deleted"; bytes: number; idleMs: number };

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
    /** append `events` to `hash`, from `seq`, and write its row */
    append(row: StoredSessionRow, from: number, events: MlDebugEvent[]): Promise<void>;
    events(hash: string): Promise<MlDebugEvent[]>;
    remove(hashes: string[]): Promise<void>;
}

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
    private timer: ReturnType<typeof setTimeout> | null = null;
    private flushing: Promise<void> = Promise.resolve();
    private ready: Promise<void> | null = null;

    constructor(
        private readonly backend: SessionStoreBackend,
        private readonly opts: {
            budgetBytes?: number; maxSessions?: number; flushMs?: number;
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
            onError?: (err: unknown) => void;
        } = {},
    ) {}

    /** Read the rows once, so a restarted worker can list what it saved before. */
    async open(): Promise<StoredSessionRow[]> {
        this.ready ??= (async () => {
            for (const row of await this.backend.rows()) this.rows.set(row.hash, row);
        })();
        await this.ready;
        return [...this.rows.values()].sort((a, b) => b.lastTs - a.lastTs);
    }

    /**
     * Apply retention now. A worker that starts and finds sessions past their time forgets them before listing them,
     * and one that has been idle for a week does the same on its next write. Returns what it dropped.
     */
    async sweep(): Promise<string[]> {
        await this.open();
        return this.drop(planExpiry([...this.rows.values()], { now: this.now(), retainMs: this.opts.retainMs?.() ?? 0, protect: this.protected() }), "retention");
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
        const gone = hashes.map((h) => this.rows.get(h)).filter((r): r is StoredSessionRow => !!r);
        await this.forget(hashes);
        this.opts.onEvict?.(hashes);
        for (const r of gone) this.opts.onEvicted?.({ hash: r.hash, reason, outcome: "deleted", bytes: r.bytes, idleMs: Math.max(0, now - r.lastTs) });
        return hashes;
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
        this.schedule();
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
        row.history = history;
        this.dirty.add(hash);
        this.schedule();
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
        this.schedule();
    }

    /** What a session would be continued from, or null when this store does not hold it. */
    async history(hash: string): Promise<SessionHistory | null> {
        await this.open();
        return this.rows.get(hash)?.history ?? null;
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
        for (const hash of hashes) { this.rows.delete(hash); this.pending.delete(hash); }
        await this.backend.remove(hashes);
    }

    /** Write everything queued. Awaited by tests and by `session.delete`, so a delete cannot race a pending write. */
    async flush(): Promise<void> {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        // One at a time: two flushes writing the same session would both read `count` before either wrote it.
        this.flushing = this.flushing.then(() => this.write()).catch((err) => this.opts.onError?.(err));
        return this.flushing;
    }

    private schedule(): void {
        if (this.timer) return;
        this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.opts.flushMs ?? FLUSH_MS);
    }

    private async write(): Promise<void> {
        await this.open();
        const batches = [...this.pending.entries()];
        this.pending.clear();
        // A row whose history changed with no events behind it still has to reach the disk, or a session's newest
        // turn is readable and not continuable until something else happens to it.
        for (const hash of this.dirty) if (!batches.some(([h]) => h === hash)) batches.push([hash, []]);
        this.dirty.clear();
        for (const [hash, events] of batches) {
            const row = this.rows.get(hash);
            // `forget` clears a session's queue as well as its row, so this is the second line of defence rather
            // than the first: no test can reach it, and it is here so that a future change to `forget` cannot turn
            // a delete into a session that quietly writes itself back. A batch with no events is a row whose own
            // fields changed — a history written between turns — and still has to reach the disk.
            if (!row) continue;
            const from = row.count;
            row.count += events.length;
            row.bytes += events.reduce((n, e) => n + sizeOf(e), 0);
            await this.backend.append({ ...row }, from, events);
        }
        // Retention first: what has expired should not survive because the budget happened to have room, and what it
        // frees is room the budget no longer has to find.
        await this.drop(planExpiry([...this.rows.values()], { now: this.now(), retainMs: this.opts.retainMs?.() ?? 0, protect: this.protected() }), "retention");
        await this.drop(planEviction([...this.rows.values()], {
            budgetBytes: this.opts.budgetBytes, maxSessions: this.opts.maxSessions, protect: this.protected(),
        }), "budget");
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
        req.onupgradeneeded = () => {
            const d = req.result;
            if (!d.objectStoreNames.contains(SESSIONS)) d.createObjectStore(SESSIONS, { keyPath: "hash" });
            // [hash, seq]: one session's events are a contiguous range, read in the order they were written.
            if (!d.objectStoreNames.contains(EVENTS)) d.createObjectStore(EVENTS);
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
        async append(row, from, events) {
            const d = await open();
            const tx = d.transaction([SESSIONS, EVENTS], "readwrite");
            tx.objectStore(SESSIONS).put(row);
            const store = tx.objectStore(EVENTS);
            events.forEach((event, i) => store.put(event, [row.hash, from + i]));
            await committed(tx);
        },
        async events(hash) {
            const d = await open();
            const range = IDBKeyRange.bound([hash, 0], [hash, Number.MAX_SAFE_INTEGER]);
            return await done((d.transaction(EVENTS, "readonly").objectStore(EVENTS).getAll(range)) as IDBRequest<MlDebugEvent[]>);
        },
        async remove(hashes) {
            const d = await open();
            const tx = d.transaction([SESSIONS, EVENTS], "readwrite");
            for (const hash of hashes) {
                tx.objectStore(SESSIONS).delete(hash);
                tx.objectStore(EVENTS).delete(IDBKeyRange.bound([hash, 0], [hash, Number.MAX_SAFE_INTEGER]));
            }
            await committed(tx);
        },
    };
}

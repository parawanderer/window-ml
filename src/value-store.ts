// value-store.ts — where a pointer's VALUE lives, once, when it is larger than its preview (docs/spec/POINTER_VALUES.md,
// slice 4).
//
// An extension-origin IndexedDB database of its own, holding a `Blob` per value and a metadata ROW per value. A Blob in
// IndexedDB is disk, not heap, until someone reads it, so holding a large table costs nothing while nobody uses it. The
// service worker and the offscreen document can open it; a page cannot, and every read goes through the run that owns
// the pointer.
//
// Eviction cannot depend on anything held in memory: the service worker is evicted without warning, taking any
// in-memory idea of which session owns what with it. So every value has its row IN the database, and every sweep works
// from those rows. The policy is layered because each mechanism alone fails (the spec's "Eviction" section): a global
// byte budget, least recently READ first, on every write; explicit release when a session ends; an idle sweep for
// orphans. Each eviction is reported (the housekeeping log), and an evicted key leaves a TOMBSTONE so a later read can
// say what happened to it instead of "not found".

/** How the bytes are encoded. Tables become Arrow IPC in a later slice; until then a value keeps the format it arrived in. */
export type ValueFormat = "arrow-file" | "arrow-stream" | "parquet" | "csv" | "tsv" | "text";

/** One stored value's metadata, kept beside its Blob. */
export interface ValueRow {
    key: string;
    /** The session that claimed it (a run hash), or null while nobody has: an unclaimed value is only ever idle-swept or budget-evicted. */
    session: string | null;
    bytes: number;
    format: ValueFormat;
    /** Where it came from, for the housekeeping log and an error message: a URL, a tool name. */
    source?: string;
    createdAt: number;
    lastReadAt: number;
}

/** Why a value left the store. */
export type EvictReason = "budget" | "idle" | "session-end";

/** What an evicted key leaves behind, so a read can say why it failed. */
export interface Tombstone { key: string; reason: EvictReason; at: number; bytes: number; source?: string }

/** One planned eviction. */
export interface Eviction { key: string; reason: EvictReason; bytes: number; session: string | null; source?: string }

/** Default for the idle sweep: a value nobody has read for this long is an orphan. */
export const IDLE_MS = 24 * 60 * 60 * 1000;
/** How long a tombstone is kept. Past it, a read of that key says "not in the store" without saying why. */
export const TOMBSTONE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * WHICH VALUES TO EVICT, and why: idle ones first, then least-recently-read until the budget holds `incoming` more bytes.
 * Pure, so the policy is tested without a database.
 *
 * - A value is idle when it has not been READ for `idleMs` (`lastReadAt`, not `createdAt`: a table an active session keeps
 *   reading survives however old it is).
 * - The budget is ONE pool across every session. A per-session budget lets fifty sessions each fill their own.
 * - `protect` is never evicted: a value being read at the moment a write needs room.
 *
 * Returns the evictions in the order to apply them. If the budget still cannot hold `incoming` (it alone is larger, or
 * everything left is protected), the plan evicts what it can and the caller refuses the write.
 */
export function planEviction(rows: readonly ValueRow[], o: { budgetBytes: number; now: number; idleMs?: number; incoming?: number; protect?: readonly string[] }): Eviction[] {
    const idleMs = o.idleMs ?? IDLE_MS, incoming = o.incoming ?? 0, protect = new Set(o.protect ?? []);
    const out: Eviction[] = [];
    const evict = (r: ValueRow, reason: EvictReason) => out.push({ key: r.key, reason, bytes: r.bytes, session: r.session, ...(r.source ? { source: r.source } : {}) });
    const kept: ValueRow[] = [];
    for (const r of rows) {
        if (!protect.has(r.key) && o.now - r.lastReadAt >= idleMs) evict(r, "idle");
        else kept.push(r);
    }
    let total = kept.reduce((n, r) => n + r.bytes, 0) + incoming;
    for (const r of [...kept].sort((a, b) => a.lastReadAt - b.lastReadAt || a.createdAt - b.createdAt)) {
        if (total <= o.budgetBytes) break;
        if (protect.has(r.key)) continue;
        evict(r, "budget");
        total -= r.bytes;
    }
    return out;
}

/** A read of a key the store does not hold. The message is what a model or a person reads, so it says why when it knows. */
export class ValueMissing extends Error {
    readonly key: string;
    readonly tombstone: Tombstone | null;
    constructor(key: string, tombstone: Tombstone | null) {
        super(tombstone
            ? `the stored value ${key}${tombstone.source ? ` (${tombstone.source})` : ""} was evicted ${WHY[tombstone.reason]}, so only its preview is left. Re-run the step that produced it to get the whole value again.`
            : `the stored value ${key} is not in the store (never stored, or evicted long enough ago that the record of it is gone). Re-run the step that produced it.`);
        this.name = "ValueMissing";
        this.key = key;
        this.tombstone = tombstone;
    }
}
const WHY: Record<EvictReason, string> = {
    budget: "to keep the value store within its storage budget",
    idle: "after going unread for a day",
    "session-end": "when its session ended",
};

/** A write the budget cannot hold even after evicting everything it may. */
export class ValueTooLarge extends Error {
    constructor(bytes: number, budget: number) {
        super(`a ${bytes.toLocaleString("en-US")}-byte value does not fit the value store's ${budget.toLocaleString("en-US")}-byte budget, so it was not stored.`);
        this.name = "ValueTooLarge";
    }
}

const DB_NAME = "ml-values";
const ROWS = "rows", BLOBS = "blobs", TOMBS = "tombstones";

/** Settle an IDBRequest as a promise. */
const done = <T>(req: IDBRequest<T>): Promise<T> => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
/** Settle a transaction as a promise. */
const committed = (tx: IDBTransaction): Promise<void> => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });

/** A short random key, hex. */
const mintKey = (): string => {
    const b = new Uint8Array(8);
    crypto.getRandomValues(b);
    return "v" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
};

/**
 * THE STORE. One instance per extension context (the service worker, the offscreen document); they share the database.
 * Every method opens its own transaction, so two contexts interleave safely at the row level.
 */
export class ValueStore {
    private db: Promise<IDBDatabase> | null = null;
    private readonly idb: IDBFactory;
    private readonly dbName: string;
    private readonly budgetBytes: () => number | Promise<number>;
    private readonly idleMs: number;
    private readonly now: () => number;
    private readonly onEvict: (e: Eviction) => void;

    constructor(o: { budgetBytes: () => number | Promise<number>; idb?: IDBFactory; dbName?: string; idleMs?: number; now?: () => number; onEvict?: (e: Eviction) => void }) {
        this.idb = o.idb ?? indexedDB;
        this.dbName = o.dbName ?? DB_NAME;
        this.budgetBytes = o.budgetBytes;
        this.idleMs = o.idleMs ?? IDLE_MS;
        this.now = o.now ?? Date.now;
        this.onEvict = o.onEvict ?? (() => {});
    }

    private open(): Promise<IDBDatabase> {
        if (!this.db) this.db = new Promise((res, rej) => {
            const req = this.idb.open(this.dbName, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                db.createObjectStore(ROWS, { keyPath: "key" }).createIndex("session", "session");
                db.createObjectStore(BLOBS);
                db.createObjectStore(TOMBS, { keyPath: "key" });
            };
            req.onsuccess = () => res(req.result);
            req.onerror = () => { this.db = null; rej(req.error); };
        });
        return this.db;
    }

    /** Every row, for a sweep, a test or the housekeeping view. */
    async rows(): Promise<ValueRow[]> {
        const db = await this.open();
        return done(db.transaction(ROWS).objectStore(ROWS).getAll()) as Promise<ValueRow[]>;
    }

    /** Remove the planned values, leave their tombstones, and report each one. */
    private async apply(plan: readonly Eviction[]): Promise<void> {
        if (!plan.length) return;
        const db = await this.open();
        const tx = db.transaction([ROWS, BLOBS, TOMBS], "readwrite");
        const at = this.now();
        for (const e of plan) {
            tx.objectStore(ROWS).delete(e.key);
            tx.objectStore(BLOBS).delete(e.key);
            tx.objectStore(TOMBS).put({ key: e.key, reason: e.reason, at, bytes: e.bytes, ...(e.source ? { source: e.source } : {}) } satisfies Tombstone);
        }
        await committed(tx);
        for (const e of plan) this.onEvict(e);
    }

    /**
     * Store a value and return its row. Makes room first (idle values, then least recently read), and refuses a value the
     * budget cannot hold at all, rather than evicting everything for a write that still would not fit.
     */
    async put(blob: Blob, meta: { format: ValueFormat; source?: string; session?: string | null; protect?: readonly string[] }): Promise<ValueRow> {
        const budget = await this.budgetBytes();
        if (blob.size > budget) throw new ValueTooLarge(blob.size, budget);
        const plan = planEviction(await this.rows(), { budgetBytes: budget, now: this.now(), idleMs: this.idleMs, incoming: blob.size, protect: meta.protect });
        await this.apply(plan);
        const now = this.now();
        const row: ValueRow = { key: mintKey(), session: meta.session ?? null, bytes: blob.size, format: meta.format, ...(meta.source ? { source: meta.source } : {}), createdAt: now, lastReadAt: now };
        const db = await this.open();
        const tx = db.transaction([ROWS, BLOBS], "readwrite");
        tx.objectStore(BLOBS).put(blob, row.key);
        tx.objectStore(ROWS).put(row);
        await committed(tx);
        return row;
    }

    /** Read a value. Marks it read (it is now the last thing evicted for budget). Throws {@link ValueMissing}, never a preview. */
    async get(key: string): Promise<{ row: ValueRow; blob: Blob }> {
        const db = await this.open();
        const tx = db.transaction([ROWS, BLOBS, TOMBS], "readwrite");
        const row = await done(tx.objectStore(ROWS).get(key)) as ValueRow | undefined;
        const blob = row ? await done(tx.objectStore(BLOBS).get(key)) as Blob | undefined : undefined;
        if (!row || !blob) {
            const tomb = await done(tx.objectStore(TOMBS).get(key)) as Tombstone | undefined;
            await committed(tx).catch(() => {});
            throw new ValueMissing(key, tomb ?? null);
        }
        const touched = { ...row, lastReadAt: this.now() };
        tx.objectStore(ROWS).put(touched);
        await committed(tx);
        return { row: touched, blob };
    }

    /** Give an unclaimed value to a session, so ending that session releases it. A value already claimed keeps its owner. */
    async claim(key: string, session: string): Promise<boolean> {
        const db = await this.open();
        const tx = db.transaction(ROWS, "readwrite");
        const row = await done(tx.objectStore(ROWS).get(key)) as ValueRow | undefined;
        if (!row || (row.session && row.session !== session)) { await committed(tx); return false; }
        tx.objectStore(ROWS).put({ ...row, session });
        await committed(tx);
        return true;
    }

    /** A session ended: evict every value it claimed. */
    async releaseSession(session: string): Promise<Eviction[]> {
        const db = await this.open();
        const rows = await done(db.transaction(ROWS).objectStore(ROWS).index("session").getAll(session)) as ValueRow[];
        const plan = rows.map((r): Eviction => ({ key: r.key, reason: "session-end", bytes: r.bytes, session: r.session, ...(r.source ? { source: r.source } : {}) }));
        await this.apply(plan);
        return plan;
    }

    /** The periodic sweep (worker start, the alarm): idle values, anything over the budget, and expired tombstones. */
    async sweep(): Promise<Eviction[]> {
        const plan = planEviction(await this.rows(), { budgetBytes: await this.budgetBytes(), now: this.now(), idleMs: this.idleMs });
        await this.apply(plan);
        const db = await this.open();
        const cutoff = this.now() - TOMBSTONE_MS;
        const tombs = await done(db.transaction(TOMBS).objectStore(TOMBS).getAll()) as Tombstone[];
        const stale = tombs.filter((t) => t.at < cutoff);
        if (stale.length) {
            const tx = db.transaction(TOMBS, "readwrite");
            for (const t of stale) tx.objectStore(TOMBS).delete(t.key);
            await committed(tx);
        }
        return plan;
    }
}

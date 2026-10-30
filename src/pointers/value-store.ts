// value-store.ts — where a pointer's VALUE lives, once, when it is larger than its preview (docs/spec/POINTER_VALUES.md,
// slice 4).
//
// An extension-origin IndexedDB database of its own, holding a `Blob` per distinct body and a metadata ROW per value. A
// Blob in IndexedDB is disk, not heap, until someone reads it, so holding a large table costs nothing while nobody uses
// it. The service worker and the offscreen document can open it; a page cannot, and every read goes through the run that
// owns the pointer.
//
// ROWS OVER BLOBS (docs/spec/FILE_ATTACHMENTS.md, "One copy of the same bytes"). A blob is kept ONCE under the SHA-256
// (hex) of its bytes. Every `put` is still its own row with its own freshly minted key, because a pointer names one fetch
// from one source at one time; claims, releases and tombstones are per row. The budget charges a blob once however many
// rows share it, a put of bytes already stored is hashed BEFORE the budget check and so charges nothing and is never
// refused as too large, and a blob is deleted in the same transaction that deletes its last row. Rows written before
// this (no `blob` field) own a blob under their own key and are read and deleted through `row.blob ?? row.key`.
//
// Eviction cannot depend on anything held in memory: the service worker is evicted without warning, taking any
// in-memory idea of which session owns what with it. So every value has its row IN the database, and every sweep works
// from those rows. The policy is layered because each mechanism alone fails (the spec's "Eviction" section): a global
// byte budget, least recently READ first, on every write; explicit release when a session ends; an idle sweep for
// orphans. Each eviction is reported (the housekeeping log), and an evicted key leaves a TOMBSTONE so a later read can
// say what happened to it instead of "not found".

/** How the bytes are encoded. Tables become Arrow IPC in a later slice; until then a value keeps the format it arrived in. */
export type ValueFormat = "arrow-file" | "arrow-stream" | "parquet" | "csv" | "tsv" | "text"
    /** A paged document: a list of pages, each with its text and an optional render recipe. Nothing produces one yet. */
    | "paged"
    /** Raw bytes with no table or text meaning (an attached file kept whole). */
    | "bytes";

/** One stored value's metadata, kept beside its Blob. */
export interface ValueRow {
    key: string;
    /** The sessions (run hashes) holding a pointer to it. Empty while nobody has claimed it: an unclaimed value is only ever
     *  idle-swept or budget-evicted. More than one when two sessions fetched the same URL from one tab's fetch cache, which
     *  hands both the same key, so ending one of them must not delete what the other still points at. */
    sessions: string[];
    /** The value's size in bytes (the blob's size; a blob shared by several rows is charged to the budget once). */
    bytes: number;
    /** The SHA-256 (hex) of the bytes, which names the blob this row reads. Absent on a row written before blobs were
     *  shared: that row's blob is keyed by the row's own key. */
    blob?: string;
    format: ValueFormat;
    /** Where it came from, for the housekeeping log and an error message: a URL, a tool name. */
    source?: string;
    /** A file the person attached (docs/spec/FILE_ATTACHMENTS.md, "Eviction differs by producer"): it cannot be fetched
     *  again, so while a session holds it it is never evicted for idleness or for the budget, and goes only when its last
     *  session ends. Charged to the budget when it is stored, so one the store cannot hold is refused then. An unheld
     *  row (absent on every row written before this) is evicted as before. */
    held?: true;
    createdAt: number;
    lastReadAt: number;
}

/** Why a value left the store. */
export type EvictReason = "budget" | "idle" | "session-end";

/** What an evicted key leaves behind, so a read can say why it failed. */
export interface Tombstone { key: string; reason: EvictReason; at: number; bytes: number; source?: string }

/** One planned eviction. */
export interface Eviction {
    key: string; reason: EvictReason; bytes: number; sessions: string[]; source?: string;
    /** True when the row went but its blob stayed for other rows, so evicting it freed no bytes (`bytes` is still the
     *  value's size, for the tombstone). The housekeeping log must not claim bytes freed for it. */
    shared?: true;
}

/** Default for the idle sweep: a value nobody has read for this long is an orphan. */
export const IDLE_MS = 24 * 60 * 60 * 1000;
/** How long a tombstone is kept. Past it, a read of that key says "not in the store" without saying why. */
export const TOMBSTONE_MS = 7 * 24 * 60 * 60 * 1000;

/** The id of the blob a row reads: its hash, or its own key for a row written before blobs were shared. */
const blobOf = (r: ValueRow): string => r.blob ?? r.key;

/**
 * Mark `shared` on the evictions whose blob outlives them. A blob goes with the LAST of its rows to be evicted, so within
 * a group fully evicted by the plan only that last entry frees bytes; a group with a surviving row frees none.
 * @param plan evictions in apply order
 * @param all every row of the store, evicted or not
 */
function markShared(plan: Eviction[], all: readonly ValueRow[]): Eviction[] {
    const blobById = new Map(all.map((r) => [r.key, blobOf(r)]));
    const members = new Map<string, number>();
    for (const r of all) members.set(blobOf(r), (members.get(blobOf(r)) ?? 0) + 1);
    const seen = new Map<string, number>();
    for (const e of plan) { const b = blobById.get(e.key); if (b != null) seen.set(b, (seen.get(b) ?? 0) + 1); }
    const left = new Map(seen);
    for (const e of plan) {
        const b = blobById.get(e.key);
        if (b == null) continue;
        const remaining = (left.get(b) ?? 1) - 1;
        left.set(b, remaining);
        if (remaining > 0 || (seen.get(b) ?? 0) < (members.get(b) ?? 0)) e.shared = true;
    }
    return plan;
}

/**
 * WHICH VALUES TO EVICT, and why: idle ones first, then least-recently-read until the budget holds `incoming` more bytes.
 * Pure, so the policy is tested without a database.
 *
 * - A value is idle when it has not been READ for `idleMs` (`lastReadAt`, not `createdAt`: a table an active session keeps
 *   reading survives however old it is). Idle eviction is per ROW.
 * - The budget is ONE pool across every session, and charges each BLOB once however many rows share it. Budget eviction
 *   works per blob: the rows sharing one are a group, read as recently as the most recently read of them, evicted whole,
 *   and skipped whole when any row of it is protected. A per-session budget lets fifty sessions each fill their own.
 * - `protect` (row keys) is never evicted: a value being read at the moment a write needs room.
 * - A `held` row a session holds is never evicted here, and its blob's group is skipped whole like a protected one; only
 *   its session's end takes it. A held row nobody holds (its claim never landed) is evicted like any other.
 * - A row evicted while its blob stays for other rows is marked `shared`: it frees no bytes.
 *
 * Returns the evictions in the order to apply them. If the budget still cannot hold `incoming` (it alone is larger, or
 * everything left is protected), the plan evicts what it can and the caller refuses the write.
 */
export function planEviction(rows: readonly ValueRow[], o: { budgetBytes: number; now: number; idleMs?: number; incoming?: number; protect?: readonly string[] }): Eviction[] {
    const idleMs = o.idleMs ?? IDLE_MS, incoming = o.incoming ?? 0, protect = new Set(o.protect ?? []);
    for (const r of rows) if (r.held && r.sessions.length) protect.add(r.key);
    const out: Eviction[] = [];
    const evict = (r: ValueRow, reason: EvictReason) => out.push({ key: r.key, reason, bytes: r.bytes, sessions: r.sessions, ...(r.source ? { source: r.source } : {}) });
    const kept: ValueRow[] = [];
    for (const r of rows) {
        if (!protect.has(r.key) && o.now - r.lastReadAt >= idleMs) evict(r, "idle");
        else kept.push(r);
    }
    const groups = new Map<string, ValueRow[]>();
    for (const r of kept) { const g = groups.get(blobOf(r)); if (g) g.push(r); else groups.set(blobOf(r), [r]); }
    const size = (g: readonly ValueRow[]) => Math.max(...g.map((r) => r.bytes));
    const lastRead = (g: readonly ValueRow[]) => Math.max(...g.map((r) => r.lastReadAt));
    const created = (g: readonly ValueRow[]) => Math.min(...g.map((r) => r.createdAt));
    let total = [...groups.values()].reduce((n, g) => n + size(g), 0) + incoming;
    for (const g of [...groups.values()].sort((a, b) => lastRead(a) - lastRead(b) || created(a) - created(b))) {
        if (total <= o.budgetBytes) break;
        if (g.some((r) => protect.has(r.key))) continue;
        for (const r of g) evict(r, "budget");
        total -= size(g);
    }
    return markShared(out, rows);
}

/** The bytes the store holds once `plan` is applied, each blob charged once. */
function heldAfter(rows: readonly ValueRow[], plan: readonly Eviction[]): number {
    const gone = new Set(plan.map((e) => e.key));
    const size = new Map<string, number>();
    for (const r of rows) if (!gone.has(r.key)) size.set(blobOf(r), Math.max(size.get(blobOf(r)) ?? 0, r.bytes));
    return [...size.values()].reduce((n, b) => n + b, 0);
}

/** The bytes of held rows a session still holds, each blob charged once: what no eviction can free. */
function heldBytes(rows: readonly ValueRow[]): number {
    return heldAfter(rows.filter((r) => r.held && r.sessions.length), []);
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
    /** @param held bytes of attached files the store keeps for their sessions, when they are why the value does not fit */
    constructor(bytes: number, budget: number, held = 0) {
        const beside = held > 0 ? ` beside the ${held.toLocaleString("en-US")} bytes of attached files it keeps for their sessions` : "";
        super(`a ${bytes.toLocaleString("en-US")}-byte value does not fit the value store's ${budget.toLocaleString("en-US")}-byte budget${beside}, so it was not stored.`);
        this.name = "ValueTooLarge";
    }
}

const DB_NAME = "ml-values";
const ROWS = "rows", BLOBS = "blobs", TOMBS = "tombstones";
/** Version 2 adds the `blob` index on rows. Version 1 kept a blob per row key and rows without `blob`. */
const DB_VERSION = 2;

/** The SHA-256 of a blob's bytes, hex. */
async function sha256Hex(blob: Blob): Promise<string> {
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
    return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
}

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
            const req = this.idb.open(this.dbName, DB_VERSION);
            req.onupgradeneeded = (ev) => {
                const db = req.result;
                // Old blobs are NOT rehashed: async crypto cannot run inside an upgrade transaction. A v1 row has no
                // `blob`, is absent from the new index, and reads its blob under its own key.
                if (ev.oldVersion < 1) {
                    const rows = db.createObjectStore(ROWS, { keyPath: "key" });
                    rows.createIndex("session", "sessions", { multiEntry: true });
                    rows.createIndex("blob", "blob");
                    db.createObjectStore(BLOBS);
                    db.createObjectStore(TOMBS, { keyPath: "key" });
                } else if (ev.oldVersion < 2) {
                    req.transaction!.objectStore(ROWS).createIndex("blob", "blob");
                }
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

    /** Remove the planned rows, leave their tombstones, delete each blob whose last row this was (checked in the same
     *  transaction, so a put that committed a row onto it first keeps it), and report each eviction. */
    private async apply(plan: readonly Eviction[]): Promise<void> {
        if (!plan.length) return;
        const db = await this.open();
        const tx = db.transaction([ROWS, BLOBS, TOMBS], "readwrite");
        const at = this.now();
        const rows = tx.objectStore(ROWS), blobs = tx.objectStore(BLOBS);
        const gone = new Set<string>();
        const work = (async () => {
            for (const e of plan) {
                const r = await done(rows.get(e.key)) as ValueRow | undefined;
                if (r) { rows.delete(e.key); gone.add(blobOf(r)); }
                tx.objectStore(TOMBS).put({ key: e.key, reason: e.reason, at, bytes: e.bytes, ...(e.source ? { source: e.source } : {}) } satisfies Tombstone);
            }
            for (const id of gone) {
                // A legacy blob (keyed by its row's key) has no index entry; its one row is the one just deleted.
                const n = await done(rows.index("blob").count(id));
                if (n === 0) blobs.delete(id);
            }
        })();
        await Promise.all([work, committed(tx)]);
        for (const e of plan) this.onEvict(e);
    }

    /**
     * Store a value and return its row. The bytes are hashed FIRST: when that blob is already stored the put charges the
     * budget nothing, evicts nothing and is never refused as too large; it only adds a row. Otherwise it makes room (idle
     * values, then least recently read blobs) and refuses a value the budget cannot hold at all, rather than evicting
     * everything for a write that still would not fit.
     */
    async put(blob: Blob, meta: { format: ValueFormat; source?: string; session?: string; protect?: readonly string[]; held?: true }): Promise<ValueRow> {
        const hash = await sha256Hex(blob);
        for (let attempt = 0; ; attempt++) {
            const db = await this.open();
            const stored = attempt < 8 && await done(db.transaction(BLOBS).objectStore(BLOBS).count(hash)) > 0;
            if (!stored) {
                const budget = await this.budgetBytes();
                if (blob.size > budget) throw new ValueTooLarge(blob.size, budget);
                const rows = await this.rows();
                const plan = planEviction(rows, { budgetBytes: budget, now: this.now(), idleMs: this.idleMs, incoming: blob.size, protect: meta.protect });
                // What the plan leaves must hold the write, or nothing is evicted for it: with held (attached) rows the
                // budget can be full of values that may not go.
                if (heldAfter(rows, plan) + blob.size > budget) throw new ValueTooLarge(blob.size, budget, heldBytes(rows));
                await this.apply(plan);
            }
            const now = this.now();
            const row: ValueRow = { key: mintKey(), sessions: meta.session ? [meta.session] : [], bytes: blob.size, blob: hash, format: meta.format, ...(meta.source ? { source: meta.source } : {}), ...(meta.held ? { held: true as const } : {}), createdAt: now, lastReadAt: now };
            const tx = db.transaction([ROWS, BLOBS], "readwrite");
            const blobs = tx.objectStore(BLOBS);
            const present = await done(blobs.count(hash)) > 0;
            if (stored && !present) {
                // Evicted between the check and this transaction: the budget was not made for these bytes. Start over.
                tx.abort();
                await committed(tx).catch(() => {});
                continue;
            }
            if (!present) blobs.put(blob, hash);
            tx.objectStore(ROWS).put(row);
            await committed(tx);
            return row;
        }
    }

    /** Read a value. Marks it read (it is now the last thing evicted for budget). Throws {@link ValueMissing}, never a preview. */
    async get(key: string): Promise<{ row: ValueRow; blob: Blob }> {
        const db = await this.open();
        const tx = db.transaction([ROWS, BLOBS, TOMBS], "readwrite");
        const row = await done(tx.objectStore(ROWS).get(key)) as ValueRow | undefined;
        const blob = row ? await done(tx.objectStore(BLOBS).get(blobOf(row))) as Blob | undefined : undefined;
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

    /** Add a session to the value's holders, so the value lives until every holder has ended. False when the key is not
     *  stored, or `may` (asked with the holders as they are, in the same transaction) refuses the claim. */
    async claim(key: string, session: string, may?: (holders: readonly string[]) => boolean): Promise<boolean> {
        const db = await this.open();
        const tx = db.transaction(ROWS, "readwrite");
        const row = await done(tx.objectStore(ROWS).get(key)) as ValueRow | undefined;
        const ok = !!row && (!may || row.sessions.includes(session) || may(row.sessions));
        if (row && ok && !row.sessions.includes(session)) tx.objectStore(ROWS).put({ ...row, sessions: [...row.sessions, session] });
        await committed(tx);
        return ok;
    }

    /** A session ended: drop it from every value it held, and evict the values nobody else holds. */
    async releaseSession(session: string): Promise<Eviction[]> {
        const db = await this.open();
        const rows = await done(db.transaction(ROWS).objectStore(ROWS).index("session").getAll(session)) as ValueRow[];
        const shared = rows.filter((r) => r.sessions.length > 1);
        if (shared.length) {
            const tx = db.transaction(ROWS, "readwrite");
            for (const r of shared) tx.objectStore(ROWS).put({ ...r, sessions: r.sessions.filter((s) => s !== session) });
            await committed(tx);
        }
        const plan = markShared(rows.filter((r) => r.sessions.length === 1)
            .map((r): Eviction => ({ key: r.key, reason: "session-end", bytes: r.bytes, sessions: r.sessions, ...(r.source ? { source: r.source } : {}) })), await this.rows());
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

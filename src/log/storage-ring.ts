// storage-ring.ts — a BUFFERED RING OF RECORDS kept in chrome.storage.session, owned by the service worker.
//
// Extracted from `HousekeepingLog` (housekeeping.ts) when the per-run execution log (run-log.ts) needed the same
// thing: records arrive one at a time from all over the worker, go to storage in batches, and the ring is trimmed
// to a cap on the way in. storage.session is what makes a log survive the worker being evicted (its memory does
// not) and clear when the browser restarts.
//
// The part worth sharing is the SERIALIZED write: two flushes must never read the same stored ring and drop each
// other's records, which is one `chain` and easy to get subtly wrong twice. What the records ARE, how they are
// trimmed, and anything else written in the same batch belong to the subclass.

/** How long records sit in memory before a write, so a burst costs one storage round-trip rather than twenty. */
export const FLUSH_DELAY_MS = 1_000;

/**
 * Records buffered in memory and written to one `chrome.storage.session` key in batches, trimmed by the rule the
 * subclass passes. Nothing here reads the ring to decide anything: it is a record, which is what makes a bounded,
 * lossy write acceptable — a dropped batch costs one line of history, never correctness.
 */
export class StorageRing<T> {
    private pending: T[] = [];
    private timer: ReturnType<typeof setTimeout> | null = null;
    private chain: Promise<void> = Promise.resolve();

    constructor(protected area: SessionArea, private key: string, private trim: (records: T[]) => T[], protected now: () => number = Date.now) {}

    /** Every stored record plus the unflushed ones, oldest first. */
    async all(): Promise<T[]> {
        await this.flush();
        const got = await this.area.get([this.key]);
        return Array.isArray(got[this.key]) ? (got[this.key] as T[]) : [];
    }

    /** Writes buffered records now. Serialized, so two flushes never read the same ring and drop each other's. */
    flush(): Promise<void> {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        const batch = this.pending;
        this.pending = [];
        // Read before the chain, so what a subclass contributes is the state at the moment flush was ASKED for.
        const extra = this.extras();
        this.chain = this.chain.then(async () => {
            const items: Record<string, unknown> = { ...extra };
            if (batch.length) {
                const got = await this.area.get([this.key]);
                const ring = Array.isArray(got[this.key]) ? (got[this.key] as T[]) : [];
                items[this.key] = this.trim(ring.concat(batch));
            }
            if (Object.keys(items).length) await this.area.set(items);
        }).catch(() => { /* a lost batch costs history, never correctness — see the header */ });
        return this.chain;
    }

    /** Buffers one record and schedules the write. */
    protected push(record: T): void {
        this.pending.push(record);
        this.schedule();
    }

    /** Replaces the stored ring, dropping anything buffered — how a log is emptied. */
    protected replace(records: T[]): Promise<void> {
        this.pending = [];
        this.chain = this.chain.then(() => this.area.set({ [this.key]: records })).catch(() => {});
        return this.chain;
    }

    /** Anything else to write in the same batch: a subclass's own keys, read when `flush` is called. */
    protected extras(): Record<string, unknown> {
        return {};
    }

    /** Asks for a write a moment from now, if one is not already pending. */
    protected schedule(): void {
        if (!this.timer) this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, FLUSH_DELAY_MS);
    }
}

/** The slice of chrome.storage.session this needs — injectable so the log is testable with no browser. */
export interface SessionArea {
    get(keys: string[]): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
}

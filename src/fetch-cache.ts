// The page's `ml.fetch` cache, with a memory budget.
//
// It used to be a bare Map that grew for the life of the tab: every successful fetch kept its whole body — and,
// since fetched CSVs parse page-side, the parsed rows as well — in the user's page, and nothing ever left. A long
// session that fetched a handful of large tables held all of them.
//
// Two rules beyond "least recently used goes first":
//
//   · THE MOST RECENT ENTRY IS ALWAYS KEPT, even when it alone exceeds the budget. The commonest use of this
//     cache is the very next step reading what was just fetched (`python_exec` naming the URL, a survey
//     re-reading it), and evicting that on arrival would break the one handoff the cache exists for.
//   · AN EVICTED KEY IS REMEMBERED, for a while. A miss that was never fetched and a miss that was evicted need
//     different messages: telling a model "that URL was never fetched" about one it fetched two steps ago sends
//     it looking for a mistake it did not make.
//
// The size is an ESTIMATE (see `estimateFetchResultBytes`). This is a budget that stops unbounded growth, not
// accounting, and an estimate within a small factor does that job.

/** A least-recently-used map bounded by an estimated byte size, that remembers recently evicted keys. */
export class FetchCache<V> {
    private readonly entries = new Map<string, { value: V; bytes: number }>();
    private readonly evicted = new Set<string>();
    private total = 0;

    /**
     * @param budgetBytes The estimated size above which older entries are evicted.
     * @param sizeOf How to estimate one value's size.
     * @param rememberEvicted How many evicted keys to remember, so a later miss can say it WAS fetched.
     */
    constructor(private readonly budgetBytes: number, private readonly sizeOf: (v: V) => number, private readonly rememberEvicted = 64) {}

    /** The cached value, refreshing its recency — or undefined. */
    get(key: string): V | undefined {
        const hit = this.entries.get(key);
        if (!hit) return undefined;
        this.entries.delete(key);
        this.entries.set(key, hit);   // re-insert: Map order is recency order
        return hit.value;
    }

    /** Store a value as the most recent entry, then evict the oldest others until the rest fits the budget. */
    set(key: string, value: V): void {
        const prev = this.entries.get(key);
        if (prev) { this.total -= prev.bytes; this.entries.delete(key); }
        const bytes = Math.max(0, this.sizeOf(value) || 0);
        this.entries.set(key, { value, bytes });
        this.total += bytes;
        this.evicted.delete(key);
        // Oldest first — but never the entry just stored, which is the one the next step is about to read.
        for (const [k, e] of this.entries) {
            if (this.total <= this.budgetBytes || k === key) break;
            this.entries.delete(k);
            this.total -= e.bytes;
            this.remember(k);
        }
    }

    /** Was this key cached and then evicted (recently enough to be remembered)? */
    wasEvicted(key: string): boolean { return this.evicted.has(key); }

    /** The estimated bytes currently held — for tests and for anyone asking why something went. */
    get estimatedBytes(): number { return this.total; }

    get size(): number { return this.entries.size; }

    private remember(key: string): void {
        this.evicted.delete(key);
        this.evicted.add(key);
        while (this.evicted.size > this.rememberEvicted) this.evicted.delete(this.evicted.values().next().value as string);
    }
}

/** Roughly how much memory a fetch result holds in a JavaScript heap. Strings count two bytes a character
 *  (they are UTF-16 in V8 unless all Latin-1, so this over-estimates ASCII by up to 2× — the safe direction for a
 *  budget). A parsed table counts per CELL, since that is where a parsed CSV's weight is; a parsed JSON value is
 *  charged its source text again, as a stand-in for the object graph it became. */
export function estimateFetchResultBytes(r: { text?: string; markdown?: string; json?: unknown; table?: { rows: unknown[][]; columns: string[] } }): number {
    const chars = (r.text?.length ?? 0) + (r.markdown?.length ?? 0);
    const json = r.json !== undefined ? (r.text?.length ?? 0) * 2 : 0;
    const cells = r.table ? r.table.rows.length * Math.max(1, r.table.columns.length) : 0;
    return chars * 2 + json + cells * 32;
}

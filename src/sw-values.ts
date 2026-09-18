// sw-values.ts — the service worker's side of the value store (docs/spec/POINTER_VALUES.md, slice 4): what gets stored,
// who holds it, when it goes, and how large the store may grow.
//
// `value-store.ts` is the mechanism and knows nothing about the extension. This module binds it: the budget comes from
// the `valueStoreBudgetMB` setting, capped under the browser's own quota; every eviction is written to the housekeeping
// log; a background run claims the values its pointers name and releases them when its session is dropped; and the idle
// sweep runs when the worker starts and on an alarm, because nothing else is awake to run it.

import { ValueStore, ValueTooLarge } from "./value-store";
import { storedColumns } from "./table-data";
import type { FetchedBody } from "./sw-fetch";
import { recordHousekeeping } from "./sw-housekeeping";
import { DEFAULT_CONFIG } from "./contract-config";

/** At most this share of the browser's quota for this origin, whatever the setting says. */
const QUOTA_SHARE = 0.5;
const SWEEP_ALARM = "value-store-sweep";
const SWEEP_EVERY_MIN = 60;

/** The budget in bytes: the setting, lowered to half the origin's quota when the browser reports a smaller one. Also sent
 *  with a Python run, since the offscreen document that stores a returned frame cannot read the settings. */
export async function budgetBytes(): Promise<number> {
    const { valueStoreBudgetMB } = await chrome.storage.sync.get({ valueStoreBudgetMB: DEFAULT_CONFIG.valueStoreBudgetMB }) as { valueStoreBudgetMB: number };
    const set = Math.max(0, Number(valueStoreBudgetMB) || 0) * 1024 * 1024;
    const quota = await navigator.storage?.estimate?.().then((e) => e.quota).catch(() => undefined);
    return quota ? Math.min(set, Math.floor(quota * QUOTA_SHARE)) : set;
}

let store: ValueStore | null = null;
/** The worker's store, or null where there is no IndexedDB (the unit tests' vm realm). */
function values(): ValueStore | null {
    if (!store && typeof indexedDB !== "undefined") store = new ValueStore({
        budgetBytes,
        onEvict: (e) => recordHousekeeping({ subsystem: "value-store", kind: "evict", reason: e.reason, key: e.key, bytes: e.bytes, ...(e.source ? { detail: { source: e.source } } : {}) }),
    });
    return store;
}

/**
 * Store a fetched table's whole body, unclaimed, and return its key. Undefined when there is no store, or the body does not
 * fit the budget at all (logged): the fetch still succeeds with its preview, and a later read by pointer fails loudly.
 */
export async function storeFetchedBody(body: FetchedBody, source: string): Promise<string | undefined> {
    const s = values();
    if (!s) return undefined;
    try {
        return (await s.put(new Blob([body.bytes]), { format: body.format, source })).key;
    } catch (e) {
        recordHousekeeping({ subsystem: "value-store", kind: "refuse", reason: e instanceof ValueTooLarge ? "budget" : "error", key: source, detail: { message: String((e as Error)?.message ?? e).slice(0, 200) } });
        return undefined;
    }
}

/** A run's pointer names a stored value: hold it for that session. */
export function claimValue(key: string, session: string): void {
    void values()?.claim(key, session).catch(() => {});
}

/** The sessions holding a stored value, or null when the key is not stored (or there is no store). */
export async function valueHolders(key: string): Promise<string[] | null> {
    const row = (await values()?.rows().catch(() => []))?.find((r) => r.key === key);
    return row ? row.sessions : null;
}

/** Named columns of a stored table, every row, decoded here from the bytes as stored. Throws the store's ValueMissing
 *  (with its reason) for a value that is gone, and the decoder's error for an unknown column or an oversized read. */
export async function readStoredColumns(key: string, names: string[], opts: { delimiter?: string; headerless?: boolean }): Promise<{ rowCount: number; columns: Record<string, unknown[]> }> {
    const s = values();
    if (!s) throw new Error("there is no value store in this context");
    const { row, blob } = await s.get(key);
    return storedColumns(await blob.arrayBuffer(), row.format, names, opts);
}

/** A session is gone: release what it held. */
export function releaseSessionValues(session: string): void {
    void values()?.releaseSession(session).catch(() => {});
}

/**
 * The idle sweep, now and every hour. The alarm is what catches orphans when nothing else runs: a worker evicted mid-run
 * never releases its session, and its values would otherwise wait for the next write. Call once, at the worker's top
 * level, so the alarm listener is registered on every start.
 */
export function startValueSweeps(): void {
    if (!values()) return;
    const sweep = () => { void values()?.sweep().catch(() => {}); };
    sweep();
    if (!chrome.alarms) return;
    chrome.alarms.onAlarm.addListener((a) => { if (a.name === SWEEP_ALARM) sweep(); });
    void chrome.alarms.get(SWEEP_ALARM).then((a) => { if (!a) void chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: SWEEP_EVERY_MIN }); }).catch(() => {});
}

// TEST-ONLY (reachable only from the service worker's realm via serviceWorker.evaluate, like __mlEvictForTest; no page can
// reach it, and nothing in the product calls it): the "explicit test path" the spec names for slice 4, before any tool
// reads a stored value. `read` answers with the row and size, or the error a real reader would get, since a Blob does not
// cross `evaluate`.
(globalThis as unknown as { __mlValues?: unknown }).__mlValues = {
    rows: async () => (await values()?.rows()) ?? [],
    read: async (key: string) => {
        const s = values();
        if (!s) return { error: "no value store in this realm" };
        try { const { row, blob } = await s.get(key); return { row, bytes: blob.size }; }
        catch (e) { return { name: (e as Error).name, error: (e as Error).message }; }
    },
};

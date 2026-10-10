// sw-prices.ts — price snapshots for spend: fetched from the box's price service when `priceSnapshotUrl` is set, kept
// once per source body by its sha256, and named on every model call's usage so a run says which prices it ran under.
//
// Off by default: with the setting empty the extension makes no request here. The service (on the box, next to
// OpenWebUI) refreshes hourly and serves `/latest` (each source's hash) and `/raw/<sha256>` (its exact bytes). A body is
// stored only after its hash is checked, so `__mlPriceBody` hands the bench the bytes the hash names. The bodies hold the
// box's raw model list, which `modelFilter` would hide, so they are read from the worker realm only, never through `ml`.

import { recordHousekeeping } from "./sw-housekeeping";
import type { PriceRef, TokenUsage } from "../contract/contract-chat";

/** How old the snapshot may get before a call asks the service again (it refreshes hourly). */
const STALE_MS = 60 * 60 * 1000;
/** How long the first call of a worker waits for a snapshot it does not have yet. */
const FIRST_WAIT_MS = 15_000;
/** A body no snapshot has named for this long is deleted. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

const DB_NAME = "ml-prices";
const BODIES = "bodies", META = "meta";

/** A stored source body, by its sha256. */
interface BodyRow { sha256: string; source: string; contentType: string; bytes: ArrayBuffer; lastSeen: number }

/** Settle an IDBRequest as a promise. */
const done = <T>(req: IDBRequest<T>): Promise<T> => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

// state: cache (a handle to the database)
let dbp: Promise<IDBDatabase> | null = null;
/** The price database, or null where there is no IndexedDB (the unit tests' vm realm). */
function db(): Promise<IDBDatabase> | null {
    if (typeof indexedDB === "undefined") return null;
    dbp ??= new Promise((res, rej) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => { req.result.createObjectStore(BODIES, { keyPath: "sha256" }); req.result.createObjectStore(META); };
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
    });
    return dbp;
}

/** One store, in a transaction of its own. */
async function store(name: string, mode: IDBTransactionMode): Promise<IDBObjectStore | null> {
    const d = await db()?.catch(() => null);
    return d ? d.transaction(name, mode).objectStore(name) : null;
}

/** Lowercase hex sha256 of some bytes. */
async function sha256(bytes: ArrayBuffer): Promise<string> {
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// state: cache (the newest snapshot and when it was checked; persisted in META so a restarted worker keeps it)
let current: { ref: PriceRef; checkedAt: number } | null = null;
// state: plumbing (the refresh in flight, so concurrent calls share it)
let refreshing: Promise<void> | null = null;

/** The service's base URL from the setting, or null when spend tracking is off. */
function baseUrl(setting: unknown): string | null {
    const url = String(setting || "").trim();
    return /^https?:\/\//.test(url) ? url.replace(/\/+(latest)?\/*$/, "") : null;
}

/** Ask the service for its newest snapshot, store any body not held yet, and make it current. */
async function refresh(base: string): Promise<void> {
    const res = await fetch(`${base}/latest`, { credentials: "omit", cache: "no-store" });
    if (!res.ok) throw new Error(`price service answered ${res.status}`);
    const latest = await res.json() as { fetched_at?: string; sources?: Record<string, { sha256?: string; content_type?: string }> };
    const sources: Record<string, string> = {};
    const now = Date.now();
    for (const [name, s] of Object.entries(latest.sources ?? {})) {
        const sha = String(s?.sha256 || "").toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(sha)) continue;
        const have = await store(BODIES, "readonly").then((st) => st ? done(st.get(sha)) as Promise<BodyRow | undefined> : undefined);
        if (have) {
            await store(BODIES, "readwrite").then((st) => st && done(st.put({ ...have, lastSeen: now })));
            sources[name] = sha;
            continue;
        }
        const raw = await fetch(`${base}/raw/${sha}`, { credentials: "omit" });
        if (!raw.ok) continue;
        const bytes = await raw.arrayBuffer();
        if (await sha256(bytes) !== sha) {
            recordHousekeeping({ subsystem: "prices", kind: "hash-mismatch", reason: "a source body did not match the hash the price service gave for it, so it was not stored", key: name });
            continue;
        }
        const row: BodyRow = { sha256: sha, source: name, contentType: String(s?.content_type || raw.headers.get("content-type") || ""), bytes, lastSeen: now };
        // Named only once held: a hash the bench cannot read the body of is no use to it.
        const st = await store(BODIES, "readwrite");
        if (!st) continue;
        await done(st.put(row));
        sources[name] = sha;
    }
    current = { ref: { fetchedAt: String(latest.fetched_at || new Date(now).toISOString()), sources }, checkedAt: now };
    await store(META, "readwrite").then((st) => st && done(st.put(current, "current")));
    await sweep(now);
}

/** Delete the bodies no snapshot has named for {@link KEEP_MS}. */
async function sweep(now: number): Promise<void> {
    const st = await store(BODIES, "readwrite");
    if (!st) return;
    for (const row of await done(st.getAll()) as BodyRow[]) {
        if (now - row.lastSeen > KEEP_MS) {
            await done(st.delete(row.sha256));
            recordHousekeeping({ subsystem: "prices", kind: "evict", reason: "no price snapshot has named it in 30 days", key: row.source, bytes: row.bytes.byteLength });
        }
    }
}

/** Start a refresh unless one is running; failures are logged, never thrown at a model call. */
function startRefresh(base: string): Promise<void> {
    refreshing ??= refresh(base)
        .catch((e) => recordHousekeeping({ subsystem: "prices", kind: "refresh-failed", reason: String((e as Error)?.message || e) }))
        .finally(() => { refreshing = null; });
    return refreshing;
}

/**
 * The prices a model call starting now runs under, or null when spend tracking is off or nothing could be fetched yet.
 * A stale snapshot is refreshed in the background; only a worker that has none waits for one, and not for long.
 * @param setting the `priceSnapshotUrl` setting
 */
export async function pricesForCall(setting: unknown): Promise<PriceRef | null> {
    const base = baseUrl(setting);
    if (!base) return null;
    if (!current) current = await store(META, "readonly").then((st) => st ? done(st.get("current")) : null).catch(() => null) ?? null;
    if (!current || Date.now() - current.checkedAt > STALE_MS) {
        const pending = startRefresh(base);
        if (!current) await Promise.race([pending, new Promise((r) => setTimeout(r, FIRST_WAIT_MS))]);
    }
    return current?.ref ?? null;
}

/**
 * What a model call records for spend: the price snapshot (when the service is set) and the electricity price (when
 * one is set). Never rejects: a call does not fail over its bookkeeping.
 * @param config the two settings it reads
 */
export async function spendForCall(config: { priceSnapshotUrl?: unknown; electricityPerKwh?: unknown; electricityCurrency?: unknown }): Promise<Pick<TokenUsage, "prices" | "electricity">> {
    const out: Pick<TokenUsage, "prices" | "electricity"> = {};
    const prices = await pricesForCall(config.priceSnapshotUrl).catch(() => null);
    if (prices) out.prices = prices;
    const perKwh = Number(config.electricityPerKwh);
    if (Number.isFinite(perKwh) && perKwh > 0) out.electricity = { perKwh, currency: String(config.electricityCurrency || "").trim().toUpperCase() };
    return out;
}

/**
 * A stored source body's exact bytes, base64, or null for a hash this browser does not hold. For the bench harness,
 * which evaluates in the worker; never reachable from a page.
 * @param hash the sha256 a call's `usage.prices.sources` named
 */
export async function priceBody(hash: unknown): Promise<{ source: string; contentType: string; base64: string } | null> {
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/i.test(hash)) return null;
    const row = await store(BODIES, "readonly").then((st) => st ? done(st.get(hash.toLowerCase())) as Promise<BodyRow | undefined> : undefined).catch(() => undefined);
    if (!row) return null;
    const u8 = new Uint8Array(row.bytes);
    let bin = "";
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return { source: row.source, contentType: row.contentType, base64: btoa(bin) };
}

(globalThis as { __mlPriceBody?: typeof priceBody }).__mlPriceBody = priceBody;

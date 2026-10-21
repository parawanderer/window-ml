// sw-prices.ts — price snapshots for spend: fetched from the box's price service when `priceSnapshotUrl` is set, kept
// once per source body by its sha256, and named on every model call's usage so a run says which prices it ran under.
//
// Off by default: with the setting empty the extension makes no request here. The service (on the box, next to
// OpenWebUI) refreshes hourly and serves `/latest` (each source's hash) and `/raw/<sha256>` (its exact bytes). A body is
// stored only after its hash is checked, so `__mlPriceBody` hands the bench the bytes the hash names. The bodies hold the
// box's raw model list, which `modelFilter` would hide, so they are read from the worker realm only, never through `ml`.

import { recordHousekeeping } from "./sw-housekeeping";
import { defineJob } from "../job-registry";
import type { PriceRef, TokenUsage } from "../contract/contract-chat";
import { priceBook, callCost, type PriceOf, type CallCost, type CallToPrice, isOffPeak } from "../spend/price-book";

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

/** Ask the service for its newest snapshot, store any body not held yet, and make it current. Answers how many sources
 *  the snapshot names and how many bodies had to be fetched. */
async function refresh(base: string): Promise<{ sources: number; fetched: number }> {
    const res = await fetch(`${base}/latest`, { credentials: "omit", cache: "no-store" });
    if (!res.ok) throw new Error(`price service answered ${res.status}`);
    const latest = await res.json() as { fetched_at?: string; sources?: Record<string, { sha256?: string; content_type?: string }> };
    const sources: Record<string, string> = {};
    const now = Date.now();
    let fetched = 0;
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
            recordHousekeeping({ level: "warn", subsystem: "prices", kind: "hash-mismatch", key: name, detail: { why: "the body did not match the hash the price service gave for it, so it was not stored" } });
            continue;
        }
        const row: BodyRow = { sha256: sha, source: name, contentType: String(s?.content_type || raw.headers.get("content-type") || ""), bytes, lastSeen: now };
        // Named only once held: a hash the bench cannot read the body of is no use to it.
        const st = await store(BODIES, "readwrite");
        if (!st) continue;
        await done(st.put(row));
        sources[name] = sha;
        fetched++;
    }
    current = { ref: { fetchedAt: String(latest.fetched_at || new Date(now).toISOString()), sources }, checkedAt: now };
    await store(META, "readwrite").then((st) => st && done(st.put(current, "current")));
    await sweep(now);
    return { sources: Object.keys(sources).length, fetched };
}

/** Delete the bodies no snapshot has named for {@link KEEP_MS}. */
async function sweep(now: number): Promise<void> {
    const st = await store(BODIES, "readwrite");
    if (!st) return;
    for (const row of await done(st.getAll()) as BodyRow[]) {
        if (now - row.lastSeen > KEEP_MS) {
            await done(st.delete(row.sha256));
            recordHousekeeping({ subsystem: "prices", kind: "evict", reason: "unnamed", key: row.source, bytes: row.bytes.byteLength, detail: { why: "no price snapshot has named it in 30 days" } });
        }
    }
}

/** Start a refresh unless one is running; failures are logged, never thrown at a model call. Logged as a pass
 *  (`refresh`, then `refresh-done` or `refresh-failed`), so one the worker was stopped in shows as interrupted. The
 *  error rides `detail`: a `reason` must be a slug, and a message in it was dropped by the log. */
function startRefresh(base: string): Promise<void> {
    if (refreshing) return refreshing;
    const t0 = Date.now();
    recordHousekeeping({ subsystem: "prices", kind: "refresh" });
    refreshing = refresh(base)
        .then((r) => recordHousekeeping({ subsystem: "prices", kind: "refresh-done", ms: Date.now() - t0, detail: r }))
        .catch((e) => recordHousekeeping({ level: "warn", subsystem: "prices", kind: "refresh-failed", ms: Date.now() - t0, detail: { error: String((e as Error)?.message || e) } }))
        .finally(() => { refreshing = null; });
    return refreshing;
}

defineJob({
    id: "prices.refresh",
    title: "Price snapshot refresh",
    trigger: "on a model call while spend tracking is on and the price snapshot is over an hour old",
    log: { subsystem: "prices", start: "refresh", done: ["refresh-done"], failed: ["refresh-failed"], also: ["hash-mismatch", "evict"] },
    live: () => ({ running: refreshing != null }),
});

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
 * The prices a call would run under, waiting for a missing or stale snapshot however long its refresh takes; null when
 * spend tracking is off or the service could not be reached. For the bench harness, before a cell's first turn: a fresh
 * profile holds no snapshot, and its first calls gave up after {@link FIRST_WAIT_MS} while the refresh was still running,
 * so they ran unpriced (panel-policy-sh, 2026-10-21: two of every four calls). Never reachable from a page.
 * @param setting the `priceSnapshotUrl` setting
 */
export async function pricesReady(setting: unknown): Promise<PriceRef | null> {
    const base = baseUrl(setting);
    if (!base) return null;
    if (!current) current = await store(META, "readonly").then((st) => st ? done(st.get("current")) : null).catch(() => null) ?? null;
    if (!current || Date.now() - current.checkedAt > STALE_MS) await startRefresh(base);
    return current?.ref ?? null;
}

/**
 * What a model call records for spend: the price snapshot (when the service is set) and the electricity price (when
 * one is set). Never rejects: a call does not fail over its bookkeeping.
 * @param config the two settings it reads
 */
export async function spendForCall(config: { priceSnapshotUrl?: unknown; electricityPerKwh?: unknown; electricityCurrency?: unknown; electricityOffPeakPerKwh?: unknown; electricityOffPeakHours?: unknown; electricityOffPeakWeekends?: unknown }, now: Date = new Date()): Promise<Pick<TokenUsage, "prices" | "electricity">> {
    const out: Pick<TokenUsage, "prices" | "electricity"> = {};
    const prices = await pricesForCall(config.priceSnapshotUrl).catch(() => null);
    if (prices) out.prices = prices;
    const perKwh = Number(config.electricityPerKwh);
    if (Number.isFinite(perKwh) && perKwh > 0) {
        const currency = String(config.electricityCurrency || "").trim().toUpperCase();
        const offPeak = Number(config.electricityOffPeakPerKwh);
        if (Number.isFinite(offPeak) && offPeak > 0) {
            const offPeakHours = String(config.electricityOffPeakHours ?? ""), offPeakWeekends = config.electricityOffPeakWeekends !== false;
            const off = isOffPeak(now, offPeakHours, offPeakWeekends);
            const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; } })();
            out.electricity = { perKwh: off ? offPeak : perKwh, currency, rate: off ? "off-peak" : "normal",
                tariff: { normalPerKwh: perKwh, offPeakPerKwh: offPeak, offPeakHours, offPeakWeekends, tz } };
        } else out.electricity = { perKwh, currency };
    }
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

/** How many price books stay parsed at once. Each holds a few megabytes of parsed price lists, and a session's calls
 *  usually ran under one or two snapshots. */
const BOOKS_MAX = 4;
// state: cache (price books parsed from stored bodies, by the hashes they were built from; rebuilt from IndexedDB on a miss)
const books = new Map<string, Promise<PriceOf | null>>();

/** The price book for one snapshot's sources, or null when this browser holds none of their bodies. */
function bookFor(sources: Record<string, string>): Promise<PriceOf | null> {
    const key = JSON.stringify(Object.entries(sources).sort());
    let book = books.get(key);
    if (!book) {
        book = (async () => {
            const bodies: Record<string, Uint8Array> = {};
            for (const [name, hash] of Object.entries(sources)) {
                const row = await store(BODIES, "readonly").then((st) => st ? done(st.get(String(hash).toLowerCase())) as Promise<BodyRow | undefined> : undefined).catch(() => undefined);
                if (row) bodies[name] = new Uint8Array(row.bytes);
            }
            return Object.keys(bodies).length ? priceBook(bodies) : null;
        })();
        books.set(key, book);
        while (books.size > BOOKS_MAX) books.delete(books.keys().next().value!);
    }
    return book;
}

/** At most this many calls are priced per request. */
const PRICE_CALLS_MAX = 5000;

/**
 * What each call cost, priced on READ against the snapshot it ran under (`src/spend/price-book.ts`), for the panel's
 * spend view. A call whose snapshot this browser no longer holds is priced as having none, so it says why.
 * @param calls the calls, in any order; the answer is in the same order
 */
export async function costCalls(calls: unknown): Promise<CallCost[]> {
    if (!Array.isArray(calls)) return [];
    const out: CallCost[] = [];
    for (const c of calls.slice(0, PRICE_CALLS_MAX) as CallToPrice[]) {
        const usage = c?.usage && typeof c.usage === "object" ? c.usage : { promptTokens: 0, completionTokens: 0 };
        const sources = usage.prices?.sources;
        const book = sources && typeof sources === "object" ? await bookFor(sources) : null;
        out.push(callCost(usage, typeof c?.model === "string" ? c.model : null, book));
    }
    return out;
}

(globalThis as { __mlPriceBody?: typeof priceBody }).__mlPriceBody = priceBody;
(globalThis as { __mlPricesReady?: typeof pricesReady }).__mlPricesReady = pricesReady;

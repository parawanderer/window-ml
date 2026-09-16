// housekeeping.ts — the log of what the system decided ON ITS OWN: evictions, sweeps, worker restarts, cold
// starts. Spec: docs/spec/HOUSEKEEPING_LOG.md; how it works: docs/dev/housekeeping.md.
//
// A ring buffer in chrome.storage.session, owned by the service worker. storage.session survives the worker
// being evicted (its memory does not) and clears when the extension reloads or the browser restarts — which is
// also what makes eviction INFERABLE: a heartbeat still present when the worker starts means this extension
// session already had a worker, and it was stopped without ever getting to say so.
//
// Nothing reads this log to decide anything. It is a record, not an input — which is why page-reported events
// may sit in it at all.

/** Who reported an event. Set by the WORKER from the message's sender, never by the reporter. */
export type HousekeepingOrigin = "worker" | "offscreen" | "extension" | "page";

/** One thing the system decided without being asked. Structured, so a test asserts the decision, not only
 *  that a value disappeared. `subsystem` and `kind` are open by intent: a new mechanism adds its own. */
export interface HousekeepingEvent {
    /** Epoch ms. */
    t: number;
    /** `"sw"`, `"offscreen"`, `"pyodide"`, `"fetch-cache"`, `"value-store"`, `"grants"`, `"quota"`, `"log"`, … */
    subsystem: string;
    /** `"start"`, `"evicted-inferred"`, `"evict"`, `"sweep"`, `"prewarm"`, `"cold-start"`, `"kill"`, `"clear"`, … */
    kind: string;
    /** Why: `"budget"`, `"idle"`, `"timeout"`, `"session-end"`, … — what tells a budget eviction from an idle one. */
    reason?: string;
    /** What it acted on: a URL, a pointer id, a session hash. Withheld from a page reading events it did not report. */
    key?: string;
    /** What it freed or cost. */
    bytes?: number;
    /** How long it took. */
    ms?: number;
    origin: HousekeepingOrigin;
    /** The reporting tab, for `origin: "page"` — how a page's own events are told from another tab's. */
    tab?: number;
    /** Anything else, small and flat. Withheld from a page reading events it did not report. */
    detail?: Record<string, string | number | boolean>;
}

/** What a reporter may say. `t`, `origin` and `tab` are the worker's to set. */
export type HousekeepingReport = Omit<HousekeepingEvent, "t" | "origin" | "tab">;

export const LOG_KEY = "ml_hk_log";
export const SEEN_KEY = "ml_hk_seen";
/** Events kept, oldest dropped. A few hundred bytes each, so ~200 KB of a 10 MB quota. */
export const LOG_CAP = 1000;
/** Page-reported events kept, oldest page event dropped first — so a page spamming reports cannot push the
 *  worker's own events out of the ring. */
export const PAGE_CAP = 200;
/** Chrome stops an idle MV3 worker after 30 s. A longer gap reads as that; a shorter one as something else. */
export const IDLE_EVICT_MS = 30_000;
/** Heartbeats are written at most this often, so the gap an inference reports can be this much too long. */
export const HEARTBEAT_EVERY_MS = 5_000;
const FLUSH_DELAY_MS = 1_000;

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_KEY = 512;
const MAX_DETAIL_ENTRIES = 16;
const MAX_DETAIL_STRING = 200;

/** The slice of chrome.storage.session this needs — injectable so the log is testable with no browser. */
export interface SessionArea {
    get(keys: string[]): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
}

/**
 * A reported event made safe to store, or null when it is not one. Names are lowercase slugs, numbers finite
 * and non-negative, strings capped, `detail` flat — a hostile page reaches this through the relay, so nothing
 * it sends is kept verbatim.
 */
export function sanitizeReport(raw: unknown): HousekeepingReport | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.subsystem !== "string" || !NAME.test(r.subsystem)) return null;
    if (typeof r.kind !== "string" || !NAME.test(r.kind)) return null;
    const out: HousekeepingReport = { subsystem: r.subsystem, kind: r.kind };
    if (typeof r.reason === "string" && NAME.test(r.reason)) out.reason = r.reason;
    if (typeof r.key === "string" && r.key) out.key = r.key.slice(0, MAX_KEY);
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
    if (num(r.bytes) != null) out.bytes = num(r.bytes);
    if (num(r.ms) != null) out.ms = num(r.ms);
    if (r.detail && typeof r.detail === "object" && !Array.isArray(r.detail)) {
        const detail: Record<string, string | number | boolean> = {};
        for (const [k, v] of Object.entries(r.detail as Record<string, unknown>).slice(0, MAX_DETAIL_ENTRIES)) {
            if (!/^[A-Za-z0-9_]{1,32}$/.test(k)) continue;
            if (typeof v === "string") detail[k] = v.slice(0, MAX_DETAIL_STRING);
            else if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) detail[k] = v;
        }
        if (Object.keys(detail).length) out.detail = detail;
    }
    return out;
}

/** Trims a ring to `LOG_CAP` events and `PAGE_CAP` page-reported ones, dropping the oldest of each. */
export function trimRing(events: HousekeepingEvent[]): HousekeepingEvent[] {
    let pageExcess = events.filter((e) => e.origin === "page").length - PAGE_CAP;
    const kept = pageExcess > 0 ? events.filter((e) => !(e.origin === "page" && pageExcess-- > 0)) : events;
    return kept.length > LOG_CAP ? kept.slice(kept.length - LOG_CAP) : kept;
}

/**
 * The events as a given reader may see them. An extension surface sees everything. A page sees every event,
 * but `key` and the STRING values of `detail` only on the ones its own tab reported: a key can be another tab's
 * fetched URL or a session hash (enough to resume that session), and a string detail can carry the same. Numbers
 * and booleans — a size, a flag — identify nothing and stay.
 */
export function eventsForReader(events: HousekeepingEvent[], readerTab: number | null): HousekeepingEvent[] {
    if (readerTab == null) return events;
    return events.map((e) => {
        if (e.origin === "page" && e.tab === readerTab) return e;
        const { key: _k, detail, ...rest } = e;
        const kept = detail ? Object.fromEntries(Object.entries(detail).filter(([, v]) => typeof v !== "string")) : {};
        return Object.keys(kept).length ? { ...rest, detail: kept } : rest;
    });
}

/** The service worker's housekeeping log: buffers events in memory and writes them to storage in batches. */
export class HousekeepingLog {
    private pending: HousekeepingEvent[] = [];
    private timer: ReturnType<typeof setTimeout> | null = null;
    private chain: Promise<void> = Promise.resolve();
    private lastBeat = 0;
    /** Settles once `start` has written its events, so a read racing the worker's first moments — a dump is
     *  often the very message that woke it — still sees them. */
    private started: Promise<void> = Promise.resolve();

    constructor(private area: SessionArea, private now: () => number = Date.now) {}

    /**
     * Records the worker starting, and — when this extension session already had a worker — that the previous
     * one was stopped. Call once, at the top of the worker. `reason` is `"idle"` when the gap is past Chrome's
     * idle window and `"unknown"` otherwise (a crash, a stop from chrome://serviceworker-internals).
     */
    start(): Promise<void> {
        this.started = this.logStart();
        return this.started;
    }

    private async logStart(): Promise<void> {
        const got = await this.area.get([SEEN_KEY]).catch(() => ({} as Record<string, unknown>));
        const seen = got[SEEN_KEY];
        const t = this.now();
        if (typeof seen === "number") {
            const gap = Math.max(0, t - seen);
            this.push({ t, origin: "worker", subsystem: "sw", kind: "evicted-inferred", reason: gap >= IDLE_EVICT_MS ? "idle" : "unknown", ms: gap, detail: { lastSeenAgoMs: gap, heartbeatEveryMs: HEARTBEAT_EVERY_MS } });
        }
        this.push({ t, origin: "worker", subsystem: "sw", kind: "start", detail: { previousWorker: typeof seen === "number" } });
        await this.flush();
    }

    /** Records an event the worker itself observed. */
    record(report: HousekeepingReport): void {
        const clean = sanitizeReport(report);
        if (clean) this.push({ ...clean, t: this.now(), origin: "worker" });
    }

    /** Records an event another context reported. `origin` and `tab` come from the message's SENDER. */
    report(raw: unknown, origin: HousekeepingOrigin, tab?: number): boolean {
        const clean = sanitizeReport(raw);
        if (!clean) return false;
        this.push({ ...clean, t: this.now(), origin, ...(origin === "page" && tab != null ? { tab } : {}) });
        return true;
    }

    /** Marks the worker alive, at a natural activity point. Throttled; never on a timer, since a timer is what
     *  would keep the worker alive and change what is being measured. */
    beat(): void {
        const t = this.now();
        if (t - this.lastBeat < HEARTBEAT_EVERY_MS) return;
        this.lastBeat = t;
        this.schedule();
    }

    /** Every stored event plus the unflushed ones, oldest first. */
    async all(): Promise<HousekeepingEvent[]> {
        await this.started;
        await this.flush();
        const got = await this.area.get([LOG_KEY]);
        return Array.isArray(got[LOG_KEY]) ? (got[LOG_KEY] as HousekeepingEvent[]) : [];
    }

    /** Empties the log, leaving one `log/clear` event so a cleared log reads differently from an empty one. */
    async clear(): Promise<void> {
        await this.started;
        this.pending = [];
        this.chain = this.chain.then(() => this.area.set({ [LOG_KEY]: [{ t: this.now(), origin: "worker", subsystem: "log", kind: "clear" }] })).catch(() => {});
        await this.chain;
    }

    /** Writes buffered events now. Serialized, so two flushes never read the same ring and drop each other's. */
    flush(): Promise<void> {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        const batch = this.pending;
        this.pending = [];
        const beat = this.lastBeat;
        this.chain = this.chain.then(async () => {
            const items: Record<string, unknown> = beat ? { [SEEN_KEY]: beat } : {};
            if (batch.length) {
                const got = await this.area.get([LOG_KEY]);
                const ring = Array.isArray(got[LOG_KEY]) ? (got[LOG_KEY] as HousekeepingEvent[]) : [];
                items[LOG_KEY] = trimRing(ring.concat(batch));
            }
            if (Object.keys(items).length) await this.area.set(items);
        }).catch(() => { /* a lost batch costs one inference, which the next start records anyway */ });
        return this.chain;
    }

    private push(e: HousekeepingEvent): void {
        this.pending.push(e);
        this.lastBeat = Math.max(this.lastBeat, e.t);
        this.schedule();
    }

    private schedule(): void {
        if (!this.timer) this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, FLUSH_DELAY_MS);
    }
}

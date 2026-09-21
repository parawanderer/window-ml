// THE CHAT CORE'S CLIENT STORE: everything the chat page knows, fed by exactly one `SessionHost`.
//
// - The runtimes and the host's own connection status, as the host reports them.
// - The session INDEX (one `SessionSummary` per session, keyed `runtime:hash`), which is what the list renders. A
//   snapshot replaces everything held for its runtime; upserts and removes change one row.
// - The OPEN session's events, applied by the stream rules (session-feed.ts) and reduced by the one reducer every
//   surface uses (`onDebug`, keyed by runtime), into the same `sessionMap` the shared session views render. There is
//   no second event format and no second reducer: the chat page's transcript is the panel's transcript.
//
// No `chrome` and no DOM: the local host, the hub host and the fake host all come through here unchanged.
import { signal, type ReadonlySignal } from "@preact/signals";
import type { Command, CommandError, CommandResult, HostStatus, RuntimeId, RuntimeInfo, SessionHost, SessionId, SessionIndexUpdate, SessionKey, SessionSummary, Unsubscribe } from "../session-host";
import { parseSessionKey, sessionKey } from "../session-host";
import { awaitingStart, forgetSessionReduced, onDebug, titleTried } from "../sidebar/debug-reducer";
import { rev, sessionMap, view } from "../sidebar/store";
import { SessionFeed } from "./session-feed";
import type { CachedSession, EventCache } from "./event-cache";

/** How long an open waits for the phone's copy of a session before opening it the ordinary way. */
const CACHE_LOAD_MS = 1500;
import { speaksOurContract } from "./grants";
import type { MlDebugEvent } from "../contract-debug";

/** A short message the page shows and then lets go of: a command that failed, a session that was deleted. The text
 *  may carry a runtime's message, so it renders as text. */
export interface Notice { id: number; text: string; tone: "error" | "info" }

/** What a failed command's code means to the person who pressed the button. */
const FAILURE: Record<CommandError["code"], string> = {
    unsupported: "Not offered by this runtime",
    forbidden: "Not allowed from this device",
    "not-found": "No longer there",
    invalid: "Not accepted",
    conflict: "Not possible right now",
    unavailable: "The runtime is unreachable",
    aborted: "Cancelled",
    failed: "Failed",
};

let noticeSeq = 0;
/** How many pages the store fetches on its own to find a session's start, before leaving it to the reader. */
const AUTO_PAGES = 5;

/** Where an open session's transcript begins in its history, and whether an older page can be asked for. */
export interface EarlierState {
    /** the history position of the oldest event held; what `session.backfill` is asked to page back from */
    from: number;
    /** an older page exists on the runtime */
    more: boolean;
    /** older events no longer exist on the runtime: a different sentence from `more`, never drawn like it */
    truncated: boolean;
    loading: boolean;
    /** the runtime's message when the last page failed; shown where the page would have been, not as a notice */
    error?: string;
}

/** The client store over one host. Create it, then `start()`; `open(key)` subscribes to one session's events. */
export class ChatStore {
    private readonly _status = signal<HostStatus>({ state: "connecting" });
    private readonly _runtimes = signal<RuntimeInfo[]>([]);
    private readonly _index = signal<ReadonlyMap<SessionKey, SessionSummary>>(new Map());
    private readonly _truncated = signal<ReadonlySet<SessionKey>>(new Set());
    private readonly _earlier = signal<ReadonlyMap<SessionKey, EarlierState>>(new Map());
    /**
     * The raw events applied for a session that can still page back, oldest first. Paging REPLAYS rather than
     * prepending: the reduced session is cleared and the older page and these are applied again in history order, so
     * the transcript is the one the runtime's own order produces, whatever the reducer assumes about order. Held only
     * while there is something to page to; the strings are the same objects the reducer keeps, not copies.
     */
    private readonly applied = new Map<SessionKey, { pos?: number; event: MlDebugEvent }[]>();
    /** notices to show, oldest first */
    readonly notices = signal<Notice[]>([]);
    /** the session whose events are subscribed, if any */
    readonly openKey = signal<SessionKey | null>(null);

    private feeds = new Map<SessionKey, SessionFeed>();
    private offs: Unsubscribe[] = [];
    private eventsOff: Unsubscribe | null = null;

    /**
     * What the phone keeps of a session past this launch (event-cache.ts), and, per session, the events the SUBSCRIPTION
     * delivered in history order with where that history began. Kept apart from `applied`, which a page of older events
     * rewrites: a copy saved from it would claim a history the saved position does not start at. Only with a cache.
     */
    private readonly cache: EventCache | null;
    private readonly seen = new Map<SessionKey, { events: { pos?: number; event: MlDebugEvent }[]; earlier: { from: number } | null; truncated: boolean }>();
    private readonly saving = new Map<SessionKey, ReturnType<typeof setTimeout>>();

    constructor(readonly host: SessionHost, opts: { cache?: EventCache } = {}) {
        this.cache = opts.cache ?? null;
    }

    get status(): ReadonlySignal<HostStatus> { return this._status; }
    get runtimes(): ReadonlySignal<RuntimeInfo[]> { return this._runtimes; }
    get index(): ReadonlySignal<ReadonlyMap<SessionKey, SessionSummary>> { return this._index; }
    /** sessions whose runtime no longer holds their oldest events */
    get truncated(): ReadonlySignal<ReadonlySet<SessionKey>> { return this._truncated; }
    /** Where each open session's transcript begins, for one that could page back. Absent: nothing to page. */
    get earlier(): ReadonlySignal<ReadonlyMap<SessionKey, EarlierState>> { return this._earlier; }

    /** Subscribe to the host's status, runtimes and index. */
    start(): void {
        this.offs.push(
            this.host.status((s) => { this._status.value = s; }),
            this.host.runtimes((list) => { this._runtimes.value = list; }),
            this.host.sessions((u) => this.applyIndex(u)),
        );
    }

    dispose(): void {
        this.close();
        for (const off of this.offs.splice(0)) off();
    }

    /** A runtime by id. */
    runtime(id: RuntimeId): RuntimeInfo | undefined {
        return this._runtimes.value.find((r) => r.id === id);
    }

    /** Subscribe to one session's events (and stop following the previous one). Resumes from what this store already
     *  applied for it, so reopening a session sends only what is new. */
    open(key: SessionKey): void {
        if (this.openKey.value === key && this.eventsOff) return;
        this.close();
        const id = parseSessionKey(key);
        if (!id) return;
        this.openKey.value = key;
        const feed = this.feeds.get(key);
        // Not seen this launch, and there is a cache: replay what the phone kept, THEN subscribe from where it left off.
        if (!feed && this.cache) { void this.openFromCache(key, id); return; }
        this.subscribe(key, id, feed ?? this.newFeed(key, id));
    }

    /** A fresh feed for a session, remembered so a reopen this launch resumes from it. */
    private newFeed(key: SessionKey, id: SessionId): SessionFeed {
        const f = new SessionFeed(id);
        this.feeds.set(key, f);
        return f;
    }

    /**
     * Open a session from the phone's copy of it, then subscribe from the copy's position. With no copy, or one that
     * does not read, it is an ordinary open. A different session opened while the copy loads wins: the copy is dropped
     * unread rather than drawn under the wrong session.
     */
    private async openFromCache(key: SessionKey, id: SessionId): Promise<void> {
        // A cache is an optimisation: one that does not answer promptly is treated as empty rather than holding the
        // session on "Loading…" (the page outside the app, where nothing answers the store, waited 15 s for its timeout).
        let c: CachedSession | null = null;
        try {
            c = await Promise.race([this.cache!.load(key), new Promise<null>((r) => setTimeout(() => r(null), CACHE_LOAD_MS))]);
        } catch { c = null; }
        if (this.openKey.value !== key || this.eventsOff || this.feeds.has(key)) return;
        if (!c) { this.subscribe(key, id, this.newFeed(key, id)); return; }
        const f = SessionFeed.restore(id, c.feed);
        this.feeds.set(key, f);
        for (const e of c.events) this.reduce(id.runtime, e.event);
        this.seen.set(key, { events: [...c.events], earlier: c.earlier, truncated: c.truncated });
        if (c.earlier) {
            this.applied.set(key, [...c.events]);
            this.setEarlier(key, { from: c.earlier.from, more: true, truncated: false, loading: false });
        }
        this.setTruncated(key, c.truncated);
        this.subscribe(key, id, f);
    }

    /** Keep a session's copy a moment after it last changed, rather than on every event of a streaming run. */
    private saveSoon(key: SessionKey): void {
        if (!this.cache) return;
        clearTimeout(this.saving.get(key));
        this.saving.set(key, setTimeout(() => {
            this.saving.delete(key);
            const feed = this.feeds.get(key)?.snapshot();
            const s = this.seen.get(key);
            if (!feed || !s) return;
            void this.cache!.save({ v: 1, key, feed, events: s.events, earlier: s.earlier, truncated: s.truncated }).catch(() => undefined);
        }, 800));
    }

    /** Subscribe to a session's events through its feed, resuming from the feed's position when it has one. */
    private subscribe(key: SessionKey, id: SessionId, f: SessionFeed): void {
        const since = f.position;
        if (this.cache && !this.seen.has(key)) this.seen.set(key, { events: [], earlier: null, truncated: false });
        // A fresh subscription collects from its first event: `backfilled`, which says whether paging is possible,
        // arrives after the events it would have to replay. A resume adds to what is already held, if anything.
        if (!since) this.applied.set(key, []);
        this.eventsOff = this.host.events(id, (msg) => {
            const act = f.handle(msg);
            switch (act.type) {
                case "apply":
                    this.reduce(id.runtime, act.event);
                    this.applied.get(key)?.push({ pos: act.pos, event: act.event });
                    this.seen.get(key)?.events.push({ pos: act.pos, event: act.event });
                    this.saveSoon(key);
                    break;
                case "reset":
                    this.forgetReduced(key);
                    this.applied.set(key, []);
                    this.setEarlier(key, null);
                    // The history the copy held is not this one any more: start the copy over with what follows.
                    if (this.seen.has(key)) this.seen.set(key, { events: [], earlier: null, truncated: false });
                    break;
                case "backfilled": {
                    this.setTruncated(key, act.truncated);
                    const s = this.seen.get(key);
                    if (s) {
                        s.truncated = act.truncated;
                        // Where the SUBSCRIPTION's history began: never moved by a later page of older events.
                        if (act.from != null) s.earlier = act.from > 0 ? { from: act.from } : null;
                        this.saveSoon(key);
                    }
                    // A position greater than 0 is something to page to; 0 or none is not, and the events kept for a
                    // replay would only cost memory.
                    if (act.from != null && act.from > 0) {
                        if (!this.applied.has(key)) this.applied.set(key, []);
                        this.setEarlier(key, { from: act.from, more: true, truncated: false, loading: false });
                        void this.untilStart(key);
                    } else if (act.from === 0 || !this._earlier.value.has(key)) {
                        // A resume carries no position and keeps what an earlier page established.
                        this.applied.delete(key);
                        this.setEarlier(key, null);
                    }
                    break;
                }
                case "gone":
                    this.removeSession(key, true);
                    this.seen.delete(key);
                    void this.cache?.drop(key).catch(() => undefined);
                    break;
                case "drop":
                    break;
            }
        }, since ? { since } : undefined);
    }

    /** Forget every session the phone kept: joining or leaving an account must not replay the last one's sessions. */
    async forgetCache(): Promise<void> {
        this.seen.clear();
        for (const t of this.saving.values()) clearTimeout(t);
        this.saving.clear();
        await this.cache?.clear();
    }

    /**
     * Load the page of events before the oldest one held, for a session whose transcript does not reach its start.
     * One at a time: a second call while one loads does nothing. A failure is recorded on the session's
     * {@link EarlierState} rather than raised as a notice, since it is shown where the page would have been.
     */
    async loadEarlier(key: SessionKey): Promise<void> {
        const at = this._earlier.value.get(key);
        const feed = this.feeds.get(key);
        const id = parseSessionKey(key);
        if (!at || at.loading || !at.more || !feed || !id) return;
        this.setEarlier(key, { ...at, loading: true, error: undefined });
        const epoch = feed.currentEpoch;
        const r = await this.send({ type: "session.backfill", session: id, before: at.from }, { quiet: true });
        const now = this._earlier.value.get(key);
        // Closed, reset or deleted while the page was on its way: it belongs to a transcript no longer shown.
        if (!now || this.feeds.get(key) !== feed || feed.currentEpoch !== epoch) return;
        if (!r.ok) { this.setEarlier(key, { ...now, loading: false, error: r.error.message || "Could not load earlier events" }); return; }
        // A page from another epoch is another history: discard it, and let the stream's own reset say what happened.
        if (r.data.epoch !== epoch) { this.setEarlier(key, { ...now, loading: false }); return; }
        // The page covers [from, at.from). A held event inside that range is one the stream sent ahead of the tail
        // (the session's start, kept in a short ring), and the page has it in its proper place.
        const page = r.data.events.filter((e) => e?.session?.hash === id.hash).map((event, i) => ({ pos: r.data.from + i, event }));
        const held = (this.applied.get(key) ?? []).filter((e) => e.pos == null || e.pos >= at.from);
        const all = [...page, ...held];
        // Replay: the reduced session goes, and everything comes back in history order.
        forgetSessionReduced(key);
        for (const e of all) this.reduce(id.runtime, e.event);
        rev.value++;
        if (r.data.more) this.applied.set(key, all);
        else this.applied.delete(key);
        if (r.data.truncated) this.setTruncated(key, true);
        this.setEarlier(key, { from: r.data.from, more: r.data.more, truncated: r.data.truncated, loading: false });
    }

    /**
     * A ring that no longer holds the session's START shows nothing: the reducer parks every step until the start
     * arrives, rather than inventing a session around them. Page back until it does, a bounded number of times. The
     * runtime is meant to keep the start in the ring, so this is the fallback, not the path.
     */
    private async untilStart(key: SessionKey): Promise<void> {
        for (let i = 0; i < AUTO_PAGES && awaitingStart(key) && this._earlier.value.get(key)?.more; i++) {
            const before = this._earlier.value.get(key)?.from;
            await this.loadEarlier(key);
            if (this._earlier.value.get(key)?.from === before) return;   // failed, or discarded: stop, and say so above
        }
    }

    /** One event into the shared reducer, its timestamp on this client's clock, so a remote run's durations and the
     *  lane line up with ours. */
    private reduce(runtime: RuntimeId, event: MlDebugEvent): void {
        const offset = this.runtime(runtime)?.clockOffsetMs ?? 0;
        onDebug(offset ? { ...event, ts: event.ts - offset } : event, runtime);
    }

    private setTruncated(key: SessionKey, truncated: boolean): void {
        if (truncated === this._truncated.value.has(key)) return;
        const next = new Set(this._truncated.value);
        if (truncated) next.add(key); else next.delete(key);
        this._truncated.value = next;
    }

    private setEarlier(key: SessionKey, state: EarlierState | null): void {
        if (!state && !this._earlier.value.has(key)) return;
        const next = new Map(this._earlier.value);
        if (state) next.set(key, state); else next.delete(key);
        this._earlier.value = next;
    }

    /** Stop following the open session. What it showed stays reduced, for a quick return. */
    close(): void {
        this.eventsOff?.();
        this.eventsOff = null;
        this.openKey.value = null;
    }

    /** Send a command. A failure becomes a notice as well as the result, so a button needs no error handling of its
     *  own to be honest about what happened. */
    async send<C extends Command>(command: C, opts?: { signal?: AbortSignal; quiet?: boolean }): Promise<CommandResult<C["type"]>> {
        const r = await this.host.send(command, opts);
        if (!r.ok && !opts?.quiet && r.error.code !== "aborted") {
            this.notify(`${FAILURE[r.error.code] ?? "Failed"}${r.error.message ? `: ${r.error.message}` : ""}`, "error");
        }
        return r;
    }

    /** Show a notice. */
    notify(text: string, tone: Notice["tone"] = "info"): void {
        this.notices.value = [...this.notices.value, { id: ++noticeSeq, text, tone }].slice(-4);
    }

    /** Dismiss a notice. */
    dismiss(id: number): void {
        this.notices.value = this.notices.value.filter((n) => n.id !== id);
    }

    private applyIndex(u: SessionIndexUpdate): void {
        const next = new Map(this._index.value);
        if (u.type === "snapshot") {
            const prefix = `${u.runtime}:`;
            for (const k of [...next.keys()]) if (k.startsWith(prefix) && parseSessionKey(k)?.runtime === u.runtime) next.delete(k);
            for (const s of u.sessions) if (s.id.runtime === u.runtime) next.set(sessionKey(s.id), s);
        } else if (u.type === "upsert") {
            next.set(sessionKey(u.session.id), u.session);
        } else if (u.type === "remove") {
            this._index.value = next;
            this.removeSession(sessionKey(u.id), false);
            return;
        } else {
            return;   // an update type from a newer contract
        }
        this._index.value = next;
    }

    /** Sessions to list: those of runtimes this client can render, newest activity first. */
    listed(): SessionSummary[] {
        const ok = new Set(this._runtimes.value.filter(speaksOurContract).map((r) => r.id));
        return [...this._index.value.values()].filter((s) => ok.has(s.id.runtime)).sort((a, b) => b.lastTs - a.lastTs);
    }

    private forgetReduced(key: SessionKey): void {
        forgetSessionReduced(key);
        titleTried.delete(key);
        rev.value++;
    }

    private removeSession(key: SessionKey, announce: boolean): void {
        const had = this._index.value.has(key) || sessionMap.has(key);
        if (this._index.value.has(key)) {
            const next = new Map(this._index.value);
            next.delete(key);
            this._index.value = next;
        }
        if (this.openKey.value === key) this.close();
        this.feeds.delete(key);
        this.applied.delete(key);
        this.setEarlier(key, null);
        this.forgetReduced(key);
        const v = view.value;
        if (v.name === "detail" && v.hash === key) view.value = { name: "list" };
        if (announce && had) this.notify("That session was deleted.");
    }
}

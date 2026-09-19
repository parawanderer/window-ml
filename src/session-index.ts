// THE LOCAL RUNTIME'S SESSION INDEX: every session this browser can see, across tabs, with each session's recent
// events held in a ring under the epoch and cursor the session contract asks for (docs/spec/SESSION_CONTRACT.md,
// docs/dev/chat-page.md §The local index). Pure: no `chrome.*`, no timers. The background feeds it (sw-sessions.ts)
// and serves it over the `ml-sessions` port; the tests drive it directly.
//
// Where events come from, and what each source may do:
// - TRUSTED: the background's own runs (a background-hosted agent's steps, stream deltas and lifecycle). The worker
//   produced them, so they are believed, and they bind the session to the tab the run is on.
// - UNTRUSTED: events a tab's content script forwarded from its page (a page-hosted run, a chat, a console call). The
//   page's main world is hostile, so such an event is accepted only for a session that tab owns, or that nobody
//   owns yet. A page cannot write into another tab's session, and a page that squats a hash before the background
//   run using it starts loses the session to that run.
//
// The same run can still be reported twice. The background feeds this only where it feeds the DevTools panel, which
// the surfaces keep free of doubles, but off mode with `listPageSessions` wakes the page's bus while the background
// also fans the run's start and result. So the index de-duplicates by meaning (a second start, a repeated result, a
// repeated "seen", a chat turn's id), which holds whichever copy arrives first.
import type { MlDebugEvent } from "./contract-debug";
import { SESSION_CONTRACT_VERSION, type RuntimeId, type SessionId, type SessionKind, type SessionStatus, type SessionStreamMessage, type SessionSummary, type StreamPosition } from "./session-host";

/** Where one event came from. */
export interface IngestSource {
    /** the tab the event belongs to; absent for a session with no page */
    tabId?: number;
    /** produced by the background itself, rather than forwarded from a page */
    trusted: boolean;
    /** the sender tab's own URL and title as the browser reports them, never the event's claim */
    page?: { url: string; title?: string };
}

/** What happened to one event. `summary` is set when the session's index row changed; `reset` when the session was
 *  replaced (its subscribers need a fresh backfill); `evicted` lists sessions dropped to stay under the caps. */
export type IngestOutcome =
    | { accepted: false; reason: "invalid" | "not-owner" | "duplicate" }
    | { accepted: true; session: SessionId; cursor: number; epoch: string; event: MlDebugEvent; summary: SessionSummary | null; reset: boolean; evicted: SessionId[] };

export interface SessionIndexOptions {
    runtime: RuntimeId;
    /** this worker's life, so a cursor from a previous one never resumes */
    spawn: string;
    now?: () => number;
    /** events kept per session */
    perSessionEvents?: number;
    /** approximate bytes (serialized length) kept per session */
    perSessionBytes?: number;
    /** approximate bytes kept across all sessions */
    totalBytes?: number;
    /** how many UNSAVED sessions are kept whole. Saved ones are bounded by the store, which decides whether they exist */
    maxSessions?: number;
}

const KNOWN_KINDS = new Set(["chat", "chat-result", "chat-error", "agent", "agent-step", "agent-result", "agent-cap", "agent-say", "agent-say-seen", "agent-stream", "agent-turn", "session-resumed"]);
/** Kinds that describe a SESSION rather than a chat or a run. They never create one: a note about a session this
 *  index does not hold is not a session, and the kind-from-prefix rule below would have to guess what it was. */
const SESSION_KINDS = new Set(["session-resumed"]);
/** A session hash as runtimes mint them. No `:`, so it composes into a SessionKey. */
const HASH_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TASK_CAP = 280;
/** A row whose only change is `lastTs` is reported at most this often: a streaming run would otherwise upsert its row
 *  on every delta, and a list needs recency, not the millisecond. */
const LAST_TS_REPORT_MS = 5000;

interface Entry { cursor: number; event: MlDebugEvent; bytes: number }

interface Indexed {
    id: SessionId;
    kind: SessionKind;
    /** bumped when the session is replaced, so its cursors stop meaning anything */
    gen: number;
    ring: Entry[];
    bytes: number;
    /** the newest cursor evicted by a cap; -1 when nothing was lost */
    lostThrough: number;
    lastCursor: number;
    owner?: number;
    hostedBy: "background" | "page";
    hasStart: boolean;
    /** agent: the run finished its latest turn, and the step it finished at */
    ended: boolean;
    endedStep: number;
    endStatus: SessionStatus;
    /** agent: the seqs of steps blocked on an approval gate */
    gates: Set<number>;
    /** chat: turn ids started and not yet answered */
    openTurns: Set<string>;
    lastResultKey: string | null;
    seenSays: Set<string>;
    /** resume notes already recorded, by event id: the page's bus and the background can both report one */
    seenResumes: Set<string>;
    interrupted: boolean;
    summary: SessionSummary;
    summaryJson: string;
    /** when the row was last reported, so `lastTs` alone reports at most every {@link LAST_TS_REPORT_MS} */
    reportedTs: number;
}

/** The text of the last user message in a chat request, for a list row. */
function chatTask(ev: Extract<MlDebugEvent, { kind: "chat" }>): string | undefined {
    const msgs = ev.request?.messages;
    if (!Array.isArray(msgs)) return undefined;
    for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i] as { role?: string; content?: unknown };
        if (m?.role !== "user") continue;
        if (typeof m.content === "string") return m.content;
        if (Array.isArray(m.content)) {
            const text = m.content.map((p: { type?: string; text?: string }) => (p?.type === "text" && typeof p.text === "string" ? p.text : "")).join(" ").trim();
            if (text) return text;
        }
    }
    return undefined;
}

/** Approximate retained size: the serialized length. A screenshot dominates, and its data URL is its length. */
function sizeOf(ev: MlDebugEvent): number {
    try { return JSON.stringify(ev).length; } catch { return 1024; }
}

/** Every session this runtime can see, with its recent events. */
export class SessionIndex {
    private readonly runtime: RuntimeId;
    private readonly spawn: string;
    private readonly now: () => number;
    private readonly perSessionEvents: number;
    private readonly perSessionBytes: number;
    private readonly totalBytesCap: number;
    private readonly maxSessions: number;
    private sessions = new Map<string, Indexed>();
    /** The generation each hash reached, kept after a session is dropped so a replacement's epoch differs. */
    private gens = new Map<string, number>();
    private cursor = 0;
    private totalBytes = 0;

    constructor(opts: SessionIndexOptions) {
        this.runtime = opts.runtime;
        this.spawn = opts.spawn;
        this.now = opts.now ?? Date.now;
        this.perSessionEvents = opts.perSessionEvents ?? 500;
        this.perSessionBytes = opts.perSessionBytes ?? 16 * 1024 * 1024;
        this.totalBytesCap = opts.totalBytes ?? 64 * 1024 * 1024;
        this.maxSessions = opts.maxSessions ?? 300;
    }

    /** Every session's index row, newest first. */
    list(): SessionSummary[] {
        return [...this.sessions.values()].map((s) => s.summary).sort((a, b) => b.lastTs - a.lastTs);
    }

    /** One session's row, or null. */
    get(hash: string): SessionSummary | null {
        return this.sessions.get(hash)?.summary ?? null;
    }

    /** The tab a session is bound to, and who hosts its loop. */
    binding(hash: string): { tabId?: number; hostedBy: "background" | "page" } | null {
        const s = this.sessions.get(hash);
        return s ? { tabId: s.owner, hostedBy: s.hostedBy } : null;
    }

    /** The epoch a session has, or will have when it first appears. */
    epochOf(hash: string): string {
        return `${this.spawn}.${this.sessions.get(hash)?.gen ?? this.gens.get(hash) ?? 0}`;
    }

    /** Fold one event in. */
    ingest(ev: MlDebugEvent, src: IngestSource): IngestOutcome {
        if (!ev || typeof ev !== "object" || typeof ev.kind !== "string" || !KNOWN_KINDS.has(ev.kind)) return { accepted: false, reason: "invalid" };
        const hash = ev.session?.hash;
        if (typeof hash !== "string" || !HASH_RE.test(hash)) return { accepted: false, reason: "invalid" };

        // A resume note whose `dropped` is not what it says it is never enters the stream. The source is untrusted by
        // this module's own rules (a page-forwarded event, accepted for a session its tab owns), and the divider that
        // reads it would meet `undefined` where the contract promises a non-empty list.
        if (ev.kind === "session-resumed") {
            const note = ev as { url?: unknown; dropped?: unknown };
            if (typeof note.url !== "string" || !note.url
                || !Array.isArray(note.dropped) || !note.dropped.length
                || !note.dropped.every((d: unknown) => typeof d === "string")) return { accepted: false, reason: "invalid" };
        }

        let s = this.sessions.get(hash);
        let reset = false;
        if (s) {
            if (src.trusted) {
                // A background run on a different tab than the page that created this record: the page squatted the
                // hash (or reported a session it does not host). The run's record replaces it.
                if (s.hostedBy === "page" && s.owner != null && src.tabId != null && s.owner !== src.tabId) {
                    this.drop(s);
                    s = undefined;
                    reset = true;
                } else {
                    s.hostedBy = "background";
                    if (src.tabId != null) s.owner = src.tabId;
                }
            } else if (s.owner != null ? s.owner !== src.tabId : s.hostedBy === "background") {
                return { accepted: false, reason: "not-owner" };
            } else if (s.owner == null && src.tabId != null) {
                s.owner = src.tabId;
            }
        }
        if (!s) {
            if (SESSION_KINDS.has(ev.kind)) return { accepted: false, reason: "invalid" };
            // A session starts on its first event, whatever kind it is: the index must not lose a run whose start it
            // missed (an off-mode tab whose page bus woke mid-run). The row fills in as more arrives. A hash seen
            // before continues its generation, so a replacement's epoch differs from the one it replaced.
            s = this.create(ev, hash, src, this.gens.get(hash) ?? 0);
        }
        if (src.page && !s.summary.page) s.summary.page = { ...src.page, ...(s.owner != null ? { tabId: s.owner } : {}) };

        if (this.isDuplicate(s, ev)) return { accepted: false, reason: "duplicate" };
        this.fold(s, ev);
        this.coalesce(s, ev);

        const cursor = ++this.cursor;
        const bytes = sizeOf(ev);
        s.ring.push({ cursor, event: ev, bytes });
        s.bytes += bytes;
        this.totalBytes += bytes;
        s.lastCursor = cursor;
        s.summary.lastTs = this.now();
        const evicted = this.enforceCaps(s);
        return { accepted: true, session: s.id, cursor, epoch: this.epochOf(hash), event: ev, summary: this.refreshSummary(s), reset, evicted };
    }

    private create(ev: MlDebugEvent, hash: string, src: IngestSource, gen: number): Indexed {
        const kind: SessionKind = ev.kind.startsWith("chat") ? ((ev as { sessionKind?: string }).sessionKind === "embed" ? "embed" : "chat") : "agent";
        const now = this.now();
        const s: Indexed = {
            id: { runtime: this.runtime, hash }, kind, gen, ring: [], bytes: 0, lostThrough: -1, lastCursor: 0,
            owner: src.tabId, hostedBy: src.trusted ? "background" : "page", hasStart: false,
            ended: false, endedStep: -1, endStatus: "done", gates: new Set(), openTurns: new Set(), lastResultKey: null, seenSays: new Set(), seenResumes: new Set(), interrupted: false,
            summary: { id: { runtime: this.runtime, hash }, kind, status: "running", createdTs: now, lastTs: now, pendingApprovals: 0, saved: false },
            summaryJson: "", reportedTs: 0,
        };
        this.gens.set(hash, gen);
        this.sessions.set(hash, s);
        return s;
    }

    private isDuplicate(s: Indexed, ev: MlDebugEvent): boolean {
        switch (ev.kind) {
            case "agent":
                // A resurrected run re-announces on purpose (`resumed`); any other second start is the other copy.
                return s.hasStart && !ev.resumed;
            case "agent-result": {
                const key = resultKey(ev);
                return s.lastResultKey === key;
            }
            case "agent-say-seen":
                return s.seenSays.has(ev.sayId);
            case "session-resumed":
                // Both sides can report one resume (off mode with `listPageSessions` wakes the page's bus while the
                // background fans the same run), and two notes are two dividers for one resume, in the log and in
                // every replay of the ring.
                return s.seenResumes.has(ev.id);
            case "chat":
                return s.ring.some((e) => e.event.kind === "chat" && e.event.id === ev.id);
            case "chat-result":
            case "chat-error":
                return s.ring.some((e) => (e.event.kind === "chat-result" || e.event.kind === "chat-error") && e.event.id === ev.id);
            default:
                return false;
        }
    }

    /** Update the session's derived state (status, gates, row fields) from one event. */
    private fold(s: Indexed, ev: MlDebugEvent): void {
        if (ev.save) s.summary.saved = true;
        switch (ev.kind) {
            case "agent":
                s.hasStart = true;
                s.lastResultKey = null;
                if (ev.task && !s.summary.task) s.summary.task = ev.task.slice(0, TASK_CAP);
                if (ev.model !== undefined) s.summary.model = ev.model;
                if (!s.summary.page && ev.pageUrl) s.summary.page = { url: ev.pageUrl, ...(ev.pageTitle ? { title: ev.pageTitle } : {}), ...(s.owner != null ? { tabId: s.owner } : {}) };
                if (ev.resumed) { s.ended = false; s.interrupted = false; }
                break;
            case "agent-step": {
                if (ev.streamOutput != null && ev.tool == null) break;   // a live output delta: nothing about the session changed
                s.lastResultKey = null;
                if (ev.seq != null) {
                    if (ev.pending && ev.awaitingApproval) s.gates.add(ev.seq);
                    else s.gates.delete(ev.seq);
                }
                // The reducer's seal (debug-reducer.ts): a straggler from a finished turn does not reopen it.
                if (!s.ended || (!ev.pending && (ev.step || 0) > s.endedStep)) { s.ended = false; s.interrupted = false; }
                break;
            }
            case "agent-result":
                s.lastResultKey = resultKey(ev);
                s.gates.clear();
                s.ended = true;
                s.interrupted = false;
                s.endedStep = Math.max(s.endedStep, ev.steps || 0, ...s.ring.map((e) => (e.event.kind === "agent-step" ? e.event.step || 0 : 0)));
                s.endStatus = ev.error ? "error" : ev.cancelled ? "cancelled" : ev.hitCap ? "capped" : "done";
                break;
            case "agent-say":
                s.lastResultKey = null;
                s.ended = false;
                s.interrupted = false;
                if (!s.summary.task && ev.text) s.summary.task = ev.text.slice(0, TASK_CAP);
                break;
            case "agent-say-seen":
                s.seenSays.add(ev.sayId);
                break;
            case "session-resumed":
                s.seenResumes.add(ev.id);
                break;
            case "chat":
                s.openTurns.add(ev.id);
                s.interrupted = false;
                if (!s.summary.task) { const t = chatTask(ev); if (t) s.summary.task = t.slice(0, TASK_CAP); }
                if (ev.request?.model) s.summary.model = ev.request.model;
                break;
            case "chat-result":
                s.openTurns.delete(ev.id);
                s.endStatus = "done";
                if (ev.model) s.summary.model = ev.model;
                break;
            case "chat-error":
                s.openTurns.delete(ev.id);
                s.endStatus = "error";
                break;
        }
    }

    /** Drop ring entries a newer event supersedes. Each carries accumulated state, so nothing is lost. */
    private coalesce(s: Indexed, ev: MlDebugEvent): void {
        let superseded: ((e: MlDebugEvent) => boolean) | null = null;
        if (ev.kind === "agent-stream" || ev.kind === "agent-turn") {
            superseded = (e) => e.kind === ev.kind && e.step === ev.step;
        } else if (ev.kind === "agent-step" && ev.seq != null) {
            const seq = ev.seq;
            if (ev.streamOutput != null && ev.tool == null) superseded = (e) => e.kind === "agent-step" && e.seq === seq && e.streamOutput != null && e.tool == null;
            // A finished step replaces its live output, and its step's live model output.
            else if (!ev.pending) superseded = (e) => (e.kind === "agent-step" && e.seq === seq && e.streamOutput != null && e.tool == null) || (e.kind === "agent-stream" && e.step === ev.step);
        } else if (ev.kind === "agent-result") {
            superseded = (e) => e.kind === "agent-stream";
        }
        if (!superseded) return;
        const keep: Entry[] = [];
        for (const e of s.ring) {
            if (superseded(e.event)) { s.bytes -= e.bytes; this.totalBytes -= e.bytes; } else keep.push(e);
        }
        s.ring = keep;
    }

    private enforceCaps(current: Indexed): SessionId[] {
        const trimFront = (s: Indexed): void => {
            const e = s.ring.shift();
            if (!e) return;
            s.bytes -= e.bytes;
            this.totalBytes -= e.bytes;
            s.lostThrough = Math.max(s.lostThrough, e.cursor);
        };
        // Keep the newest event even when it alone is over the cap: dropping what just arrived loses the live state.
        while (current.ring.length > 1 && (current.ring.length > this.perSessionEvents || current.bytes > this.perSessionBytes)) trimFront(current);
        if (this.totalBytes > this.totalBytesCap) {
            // Take from the sessions that changed least recently, the one being written last.
            const byAge = [...this.sessions.values()].sort((a, b) => (a === current ? 1 : b === current ? -1 : a.summary.lastTs - b.summary.lastTs));
            for (const s of byAge) {
                while (this.totalBytes > this.totalBytesCap && s.ring.length > (s === current ? 1 : 0)) trimFront(s);
                if (this.totalBytes <= this.totalBytesCap) break;
            }
        }
        const evicted: SessionId[] = [];
        // Whole-session eviction applies to sessions that exist ONLY here. A SAVED session's existence is the store's
        // to decide: its row is small, its events are on disk (the ring above is trimmed freely and served from there),
        // and the store bounds it with its own cap and byte budget. Evicting one here as well gave the two different
        // answers about whether it existed — every client was told `remove`, and the next worker's `restore` put it
        // straight back, so a saved session flickered out of the list and in again. The old sessions somebody pins
        // are exactly the saved ones this used to drop first.
        const unsaved = [...this.sessions.values()].filter((s) => !s.summary.saved);
        if (unsaved.length > this.maxSessions) {
            // Forget whole sessions, finished ones first, oldest first. Never the one being written.
            const rank = (s: Indexed): number => (s.summary.status === "running" || s.summary.status === "waiting" ? 1 : 0);
            const victims = unsaved.filter((s) => s !== current).sort((a, b) => rank(a) - rank(b) || a.summary.lastTs - b.summary.lastTs);
            let over = unsaved.length - this.maxSessions;
            for (const v of victims) {
                if (over <= 0) break;
                this.drop(v);
                evicted.push(v.id);
                over--;
            }
        }
        return evicted;
    }

    private drop(s: Indexed): void {
        this.totalBytes -= s.bytes;
        this.sessions.delete(s.id.hash);
        this.gens.set(s.id.hash, s.gen + 1);
    }

    private status(s: Indexed): SessionStatus {
        if (s.interrupted) return "interrupted";
        if (s.kind !== "agent") return s.openTurns.size ? "running" : s.endStatus;
        if (!s.ended) return s.gates.size ? "waiting" : "running";
        return s.endStatus;
    }

    /** Recompute the row; return it when it changed. */
    private refreshSummary(s: Indexed): SessionSummary | null {
        s.summary.status = this.status(s);
        s.summary.pendingApprovals = s.ended ? 0 : s.gates.size;
        const { lastTs: _ignored, ...stable } = s.summary;
        const json = JSON.stringify(stable);
        if (json === s.summaryJson && s.summary.lastTs - s.reportedTs < LAST_TS_REPORT_MS) return null;
        s.summaryJson = json;
        s.reportedTs = s.summary.lastTs;
        return s.summary;
    }

    /** The subscription opening sequence for one session: an optional `reset`, the backfill, then `backfilled`. */
    backfill(hash: string, since?: StreamPosition): SessionStreamMessage[] {
        const session: SessionId = { runtime: this.runtime, hash };
        const epoch = this.epochOf(hash);
        const s = this.sessions.get(hash);
        const event = (e: Entry): SessionStreamMessage => ({ type: "event", v: SESSION_CONTRACT_VERSION, session, epoch, cursor: e.cursor, event: e.event });
        // Not held: never seen, or lost with a previous worker. The client keeps what it shows.
        if (!s) return [{ type: "backfilled", session, epoch, cursor: since?.epoch === epoch ? since.cursor : 0, truncated: !!since }];
        if (since && since.epoch === epoch && since.cursor >= s.lostThrough) {
            return [...s.ring.filter((e) => e.cursor > since.cursor).map(event), { type: "backfilled", session, epoch, cursor: Math.max(since.cursor, s.lastCursor), truncated: false }];
        }
        if (!s.ring.length) return [{ type: "backfilled", session, epoch, cursor: s.lastCursor, truncated: true }];
        // Nothing lost: the ring starts at the session's first event, so paging back has nowhere to go. Something lost
        // and served from here anyway: an unsaved session, which has no history to page through, so no position.
        const lost = s.lostThrough >= 0;
        return [{ type: "reset", session, epoch }, ...s.ring.map(event), { type: "backfilled", session, epoch, cursor: s.lastCursor, truncated: lost, ...(lost ? {} : { from: 0 }) }];
    }

    /**
     * Seed the index from what a previous worker saved (session-store.ts), so an evicted service worker comes back
     * with its list rather than with nothing.
     *
     * A restored session holds NO events in memory: its ring is empty and everything it has is on disk, which is what
     * `lostThrough` says. Live cursors continue after the stored ones, so a client that reconnects with an old
     * position is told the truth about what it has missed rather than being handed cursor 1 twice.
     *
     * A session that was RUNNING when the worker died is restored as `interrupted`: the loop died with the worker,
     * and a list that still showed it as running would be waiting for an event that cannot arrive.
     */
    restore(entries: readonly { summary: SessionSummary; count: number }[]): SessionSummary[] {
        const out: SessionSummary[] = [];
        for (const { summary, count } of entries) {
            const hash = summary.id?.hash;
            if (typeof hash !== "string" || !HASH_RE.test(hash) || this.sessions.has(hash)) continue;
            const status: SessionStatus = summary.status === "running" || summary.status === "waiting" ? "interrupted" : summary.status;
            const restored: SessionSummary = { ...summary, id: { runtime: this.runtime, hash }, status, saved: true };
            const s: Indexed = {
                id: restored.id, kind: restored.kind, gen: 0, ring: [], bytes: 0,
                lostThrough: count, lastCursor: count,
                owner: undefined, hostedBy: "background", hasStart: true,
                ended: true, endedStep: -1, endStatus: status === "interrupted" ? "error" : "done",
                gates: new Set(), openTurns: new Set(), lastResultKey: null, seenSays: new Set(), seenResumes: new Set(),
                interrupted: status === "interrupted",
                summary: restored, summaryJson: "", reportedTs: restored.lastTs,
            };
            this.gens.set(hash, 0);
            this.sessions.set(hash, s);
            // The cursor is ONE counter across every session, not a count per session, so a restored session whose
            // saved events occupy 1..count must push it past them. Without this the next live event on that session
            // is handed cursor 1 — below events the client has already been sent, which breaks the one thing a
            // cursor promises.
            this.cursor = Math.max(this.cursor, count);
            out.push(restored);
        }
        return out;
    }

    /**
     * Mark a session as one to keep, which is what `ephemeral: false` means on the command that started it.
     *
     * Returns the events already in the ring when nothing had marked it before, and nothing at all otherwise: a
     * session is marked a moment AFTER its first events have been ingested (the hash does not exist until the run
     * mints it), so the caller writes those to the store itself rather than losing the start of every session it
     * was asked to keep. Marking twice writes nothing twice.
     */
    markSaved(hash: string): { summary: SessionSummary; events: MlDebugEvent[] } | null {
        const s = this.sessions.get(hash);
        if (!s || s.summary.saved) return null;
        s.summary.saved = true;
        // `refreshSummary` answers null when the row has not changed enough to be worth reporting; `saved` flipping
        // always is, so the row itself is what goes back.
        this.refreshSummary(s);
        return { summary: s.summary, events: s.ring.map((e) => e.event) };
    }

    /**
     * Pin a session, or unpin it. Returns the changed row, or null when the session is not held or nothing changed.
     *
     * Pinning does not save: the caller does that first, through the same path as any other session asked to be
     * kept, because the events already in the ring have to reach the store with it. A pinned session is saved, and
     * the whole-session eviction here never touches a saved one, so this needs no rule of its own in `enforceCaps`.
     */
    setPinned(hash: string, pinned: boolean): SessionSummary | null {
        const s = this.sessions.get(hash);
        if (!s || !!s.summary.pinned === pinned) return null;
        if (pinned) s.summary.pinned = true;
        else delete s.summary.pinned;
        this.refreshSummary(s);
        return s.summary;
    }

    /**
     * Set a session's title. `renamed` marks it as one a person chose; `title: null` clears both, so the session can
     * be titled again. Returns the changed row, or null when the session is not held or nothing changed.
     */
    setTitle(hash: string, title: string | null, renamed = false): SessionSummary | null {
        const s = this.sessions.get(hash);
        if (!s) return null;
        const before = `${s.summary.title ?? ""}\u0000${s.summary.renamed ? 1 : 0}`;
        if (title) s.summary.title = title; else delete s.summary.title;
        if (title && renamed) s.summary.renamed = true; else delete s.summary.renamed;
        if (`${s.summary.title ?? ""}\u0000${s.summary.renamed ? 1 : 0}` === before) return null;
        this.refreshSummary(s);
        return s.summary;
    }

    /** Set the model a session uses from now on (`session.model`). Returns the changed row, or null when the session
     *  is not held or already uses it. */
    setModel(hash: string, model: string): SessionSummary | null {
        const s = this.sessions.get(hash);
        if (!s || s.summary.model === model) return null;
        s.summary.model = model;
        this.refreshSummary(s);
        return s.summary;
    }

    /** How many sessions are pinned, which the runtime bounds. */
    pinnedCount(): number {
        let n = 0;
        for (const s of this.sessions.values()) if (s.summary.pinned) n++;
        return n;
    }

    /**
     * Would `backfill` have to read the saved events to answer this subscription? True when what the client needs is
     * older than anything the ring still holds — after a restart, that is every subscription.
     *
     * The server asks before subscribing, because reading from disk is asynchronous and the stream's order is not:
     * a live event that arrived during the read has to wait for the backfill it belongs after.
     */
    needsStored(hash: string, since?: StreamPosition): boolean {
        const s = this.sessions.get(hash);
        if (!s || s.lostThrough <= 0) return false;
        return !(since && since.epoch === this.epochOf(hash) && since.cursor >= s.lostThrough);
    }

    /** What a restored or evicted session has on disk but not in memory, so a caller can splice the two together. */
    storedThrough(hash: string): number {
        return Math.max(0, this.sessions.get(hash)?.lostThrough ?? 0);
    }

    /** Forget a session. Returns false when it was not held. */
    remove(hash: string): boolean {
        const s = this.sessions.get(hash);
        if (!s) return false;
        this.drop(s);
        return true;
    }

    /** The tab's document went away (closed, or replaced by a new page). A run hosted by that document cannot finish,
     *  so it reads as interrupted; a background-hosted run carries on and reports its own end. Returns changed rows. */
    pageGone(tabId: number, opts: { closed: boolean }): SessionSummary[] {
        const changed: SessionSummary[] = [];
        for (const s of this.sessions.values()) {
            if (s.owner !== tabId) continue;
            if (opts.closed) {
                s.owner = undefined;
                if (s.summary.page) delete s.summary.page.tabId;
            }
            if (s.hostedBy === "page" && !s.interrupted && (s.kind === "agent" ? !s.ended : s.openTurns.size > 0)) {
                s.interrupted = true;
                s.gates.clear();
                s.openTurns.clear();
            }
            const row = this.refreshSummary(s);
            if (row) changed.push(row);
        }
        return changed;
    }
}

/** What makes two results the same result: the other copy of one turn's end, not the next turn's. */
function resultKey(ev: Extract<MlDebugEvent, { kind: "agent-result" }>): string {
    return JSON.stringify([ev.session?.turn, ev.steps, !!ev.hitCap, !!ev.cancelled, ev.error || "", ev.summary]);
}

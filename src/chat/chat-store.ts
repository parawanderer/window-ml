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
import type { Command, CommandError, CommandResult, HostStatus, RuntimeId, RuntimeInfo, SessionHost, SessionIndexUpdate, SessionKey, SessionSummary, Unsubscribe } from "../session-host";
import { parseSessionKey, sessionKey } from "../session-host";
import { onDebug, titleTried } from "../sidebar/debug-reducer";
import { rev, sessionMap, view } from "../sidebar/store";
import { SessionFeed } from "./session-feed";
import { speaksOurContract } from "./grants";

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

/** The client store over one host. Create it, then `start()`; `open(key)` subscribes to one session's events. */
export class ChatStore {
    private readonly _status = signal<HostStatus>({ state: "connecting" });
    private readonly _runtimes = signal<RuntimeInfo[]>([]);
    private readonly _index = signal<ReadonlyMap<SessionKey, SessionSummary>>(new Map());
    private readonly _truncated = signal<ReadonlySet<SessionKey>>(new Set());
    /** notices to show, oldest first */
    readonly notices = signal<Notice[]>([]);
    /** the session whose events are subscribed, if any */
    readonly openKey = signal<SessionKey | null>(null);

    private feeds = new Map<SessionKey, SessionFeed>();
    private offs: Unsubscribe[] = [];
    private eventsOff: Unsubscribe | null = null;

    constructor(readonly host: SessionHost) {}

    get status(): ReadonlySignal<HostStatus> { return this._status; }
    get runtimes(): ReadonlySignal<RuntimeInfo[]> { return this._runtimes; }
    get index(): ReadonlySignal<ReadonlyMap<SessionKey, SessionSummary>> { return this._index; }
    /** sessions whose runtime no longer holds their oldest events */
    get truncated(): ReadonlySignal<ReadonlySet<SessionKey>> { return this._truncated; }

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
        let feed = this.feeds.get(key);
        if (!feed) { feed = new SessionFeed(id); this.feeds.set(key, feed); }
        const f = feed;
        this.openKey.value = key;
        const since = f.position;
        this.eventsOff = this.host.events(id, (msg) => {
            const act = f.handle(msg);
            switch (act.type) {
                case "apply": {
                    // Timestamps onto this client's clock, so a remote run's durations and the lane line up with ours.
                    const offset = this.runtime(id.runtime)?.clockOffsetMs ?? 0;
                    onDebug(offset ? { ...act.event, ts: act.event.ts - offset } : act.event, id.runtime);
                    break;
                }
                case "reset":
                    this.forgetReduced(key);
                    break;
                case "backfilled":
                    if (act.truncated !== this._truncated.value.has(key)) {
                        const next = new Set(this._truncated.value);
                        if (act.truncated) next.add(key); else next.delete(key);
                        this._truncated.value = next;
                    }
                    break;
                case "gone":
                    this.removeSession(key, true);
                    break;
                case "drop":
                    break;
            }
        }, since ? { since } : undefined);
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
        sessionMap.delete(key);
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
        this.forgetReduced(key);
        const v = view.value;
        if (v.name === "detail" && v.hash === key) view.value = { name: "list" };
        if (announce && had) this.notify("That session was deleted.");
    }
}

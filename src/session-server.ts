// THE LOCAL HOST'S WIRE: the background side of the `ml-sessions` port that the chat page's `LocalHost`
// (src/chat/local-host.ts) connects to. It serves the session index and each session's event stream in the shapes
// the session contract defines, and hands commands to a handler. Pure over a port-like object, so the protocol is
// tested end to end in Node with the real client on the other side; sw-sessions.ts plugs it into `chrome.runtime`.
//
// Only extension pages may connect (the background checks the port's sender URL before `attach`): a content script
// never reaches this, because a page's main world is hostile and the index spans every tab.
import type { MlDebugEvent } from "./contract-debug";
import { COMMAND_SCOPE, SESSION_CONTRACT_VERSION, type Command, type CommandResult, type CommandType, type RuntimeInfo, type SessionId, type SessionIndexUpdate, type SessionStreamMessage, type SessionSummary, type StreamPosition } from "./session-host";
import type { IngestOutcome, IngestSource, SessionIndex } from "./session-index";

/** The port name the chat page connects on. */
export const SESSIONS_PORT = "ml-sessions";

/** The subset of `chrome.runtime.Port` both ends use. */
export interface PortLike {
    postMessage(message: unknown): void;
    onMessage: { addListener(fn: (message: any) => void): void };
    onDisconnect: { addListener(fn: () => void): void };
    disconnect(): void;
}

/** Client → background. */
export type SessionsClientMessage =
    /** subscribe to the index: a snapshot, then changes */
    | { type: "sessions" }
    /** subscribe to one session's events; `sub` is the client's id for the subscription */
    | { type: "events"; sub: number; hash: string; since?: StreamPosition }
    | { type: "unsub"; sub: number }
    | { type: "cmd"; id: number; command: Command };

/** Background → client. `runtime` is sent first on every connection. */
export type SessionsServerMessage =
    | { type: "runtime"; runtime: RuntimeInfo }
    | { type: "index"; update: SessionIndexUpdate }
    | { type: "stream"; sub: number; message: SessionStreamMessage }
    | { type: "result"; id: number; result: CommandResult<CommandType> };

/** Runs one command. Throwing is reported as `failed`. */
export type CommandHandler = (command: Command) => Promise<CommandResult<CommandType>>;

/** One subscription. While `loading` is set, the saved events are being read and live ones wait in it, so a client
 *  never sees an event before the backfill it belongs after. */
interface Sub {
    hash: string;
    loading: SessionStreamMessage[] | null;
}

interface Client {
    port: PortLike;
    index: boolean;
    /** sub id → subscription */
    subs: Map<number, Sub>;
}

/**
 * Every command the contract defines, read from `COMMAND_SCOPE` rather than listed here. A hand-kept copy went stale
 * the day it was written: `session.resume`, `session.backfill`, `runtime.info` and `tab.focus` were built in the
 * handler and answered `unsupported` from this port, because the unit tests call the handler directly. The handler
 * answers `unsupported` for a contract command it does not implement, so this only has to reject what is not one.
 */
const KNOWN_COMMANDS: ReadonlySet<string> = new Set(Object.keys(COMMAND_SCOPE));

/** Something fed the whole index's changes and every session's stream, beside the connected pages. */
export interface SessionSink {
    index(update: SessionIndexUpdate): void;
    stream(hash: string, message: SessionStreamMessage): void;
}

/** Serves a {@link SessionIndex} to connected extension pages. */
export class SessionServer {
    private clients = new Set<Client>();
    private sinks = new Set<SessionSink>();

    constructor(
        readonly index: SessionIndex,
        private readonly opts: {
            runtime: () => RuntimeInfo;
            command: CommandHandler;
            /** every event a saved session holds, oldest first; absent when nothing is saved (session-store.ts) */
            stored?: (hash: string) => Promise<MlDebugEvent[]>;
        },
    ) {}

    /**
     * Feed every index change and every session's stream from now on to `sink`, whether or not a page is watching: the
     * hub connection (hub-runtime.ts), which publishes a session while it happens because the hub never says who is
     * subscribed. Returns the stop.
     */
    watch(sink: SessionSink): () => void {
        this.sinks.add(sink);
        return () => this.sinks.delete(sink);
    }

    /** How many pages are connected. */
    get connections(): number {
        return this.clients.size;
    }

    /** Serve one connected port. */
    attach(port: PortLike): void {
        const client: Client = { port, index: false, subs: new Map() };
        this.clients.add(client);
        port.onDisconnect.addListener(() => this.clients.delete(client));
        port.onMessage.addListener((msg: SessionsClientMessage) => this.onMessage(client, msg));
        this.post(client, { type: "runtime", runtime: this.opts.runtime() });
    }

    private post(client: Client, message: SessionsServerMessage): void {
        try { client.port.postMessage(message); } catch { this.clients.delete(client); }
    }

    private onMessage(client: Client, msg: SessionsClientMessage): void {
        if (!msg || typeof msg !== "object") return;
        switch (msg.type) {
            case "sessions":
                client.index = true;
                this.post(client, { type: "index", update: { type: "snapshot", runtime: this.opts.runtime().id, sessions: this.index.list() } });
                return;
            case "events": {
                if (typeof msg.sub !== "number" || typeof msg.hash !== "string") return;
                const since = msg.since && typeof msg.since.epoch === "string" && typeof msg.since.cursor === "number" ? msg.since : undefined;
                if (this.opts.stored && this.index.needsStored(msg.hash, since)) {
                    const sub: Sub = { hash: msg.hash, loading: [] };
                    client.subs.set(msg.sub, sub);
                    void this.fromDisk(client, msg.sub, sub);
                    return;
                }
                client.subs.set(msg.sub, { hash: msg.hash, loading: null });
                for (const message of this.index.backfill(msg.hash, since)) this.post(client, { type: "stream", sub: msg.sub, message });
                return;
            }
            case "unsub":
                client.subs.delete(msg.sub);
                return;
            case "cmd":
                if (typeof msg.id !== "number") return;
                void this.run(msg.command).then((result) => this.post(client, { type: "result", id: msg.id, result }));
                return;
        }
    }

    /**
     * Serve a subscription whose events are on disk: the saved ones, then whatever arrived while they were read.
     *
     * The stored events ARE the session from cursor 1, so they are sent as one `reset` and a run of events, and the
     * ring's own events are spliced on after the ones the disk already covered — in a worker that has both, they
     * overlap, and sending an event twice would show a turn twice.
     */
    private async fromDisk(client: Client, sub: number, held: Sub): Promise<void> {
        const hash = held.hash;
        const session: SessionId = { runtime: this.index.list().find((s) => s.id.hash === hash)?.id.runtime ?? this.opts.runtime().id, hash };
        const epoch = this.index.epochOf(hash);
        let events: MlDebugEvent[] = [];
        try { events = (await this.opts.stored?.(hash)) ?? []; } catch { events = []; }
        // Dropped, deleted or unsubscribed while the disk was read: there is nothing to send it to.
        if (!client.subs.has(sub) || !this.clients.has(client)) return;
        const messages: SessionStreamMessage[] = [{ type: "reset", session, epoch }];
        // Read from disk, an event's position is simply where it sits: the store is what `session.backfill` counts.
        events.forEach((event, i) => messages.push({ type: "event", v: SESSION_CONTRACT_VERSION, session, epoch, cursor: i + 1, pos: i, event }));
        // What the ring holds beyond what disk covered. A restored session has no ring and this is empty.
        for (const message of this.index.backfill(hash)) {
            if (message.type === "event" && message.cursor > events.length) messages.push(message);
            // The disk's events are the session from its first one, so nothing precedes what was sent.
            if (message.type === "backfilled") messages.push({ ...message, cursor: Math.max(message.cursor, events.length), truncated: message.truncated && !events.length, ...(events.length ? { from: 0 } : {}) });
        }
        for (const message of messages) this.post(client, { type: "stream", sub, message });
        // Then whatever arrived while we read — except what the backfill has just covered. An event ingested during
        // the read is in the ring by now, so it went out with the backfill above AND is sitting in this queue, and
        // sending it twice would show the same step twice.
        let sent = 0;
        for (const message of messages) if (message.type === "event") sent = Math.max(sent, message.cursor);
        const waiting = held.loading ?? [];
        held.loading = null;
        for (const message of waiting) {
            if (message.type === "event" && message.cursor <= sent) continue;
            this.post(client, { type: "stream", sub, message });
        }
    }

    private async run(command: Command): Promise<CommandResult<CommandType>> {
        if (!command || typeof command !== "object" || !KNOWN_COMMANDS.has(command.type)) {
            return { ok: false, error: { code: "unsupported", message: "this runtime does not know that command" } };
        }
        try {
            return await this.opts.command(command);
        } catch (err) {
            return { ok: false, error: { code: "failed", message: (err as Error)?.message || String(err) } };
        }
    }

    /** Fold an event into the index and send what changed to every connected page. */
    ingest(event: MlDebugEvent, source: IngestSource): IngestOutcome {
        const out = this.index.ingest(event, source);
        if (!out.accepted) return out;
        const hash = out.session.hash;
        if (this.sinks.size) {
            const messages: SessionStreamMessage[] = out.reset
                ? this.index.backfill(hash)
                : [{ type: "event", v: SESSION_CONTRACT_VERSION, session: out.session, epoch: out.epoch, cursor: out.cursor, event: out.event }];
            for (const sink of this.sinks) {
                for (const id of out.evicted) sink.index({ type: "remove", id });
                if (out.summary) sink.index({ type: "upsert", session: out.summary });
                for (const message of messages) sink.stream(hash, message);
            }
        }
        if (!this.clients.size) return out;
        for (const client of this.clients) {
            if (client.index) {
                for (const id of out.evicted) this.post(client, { type: "index", update: { type: "remove", id } });
                if (out.summary) this.post(client, { type: "index", update: { type: "upsert", session: out.summary } });
            }
            for (const [sub, s] of client.subs) {
                if (s.hash !== hash) continue;
                const messages: SessionStreamMessage[] = out.reset
                    ? this.index.backfill(hash)
                    : [{ type: "event", v: SESSION_CONTRACT_VERSION, session: out.session, epoch: out.epoch, cursor: out.cursor, event: out.event }];
                // Still reading this session from disk: hold it, or the client would see an event before the
                // backfill it comes after, and its reducer trusts that order.
                if (s.loading) s.loading.push(...messages);
                else for (const message of messages) this.post(client, { type: "stream", sub, message });
            }
        }
        return out;
    }

    /** The runtime's description changed (a capability came or went): tell every connected page. */
    runtimeChanged(): void {
        for (const client of this.clients) this.post(client, { type: "runtime", runtime: this.opts.runtime() });
    }

    /** A tab's document went away; send the rows that changed. */
    pageGone(tabId: number, opts: { closed: boolean }): void {
        const rows = this.index.pageGone(tabId, opts);
        for (const session of rows) this.broadcastIndex({ type: "upsert", session });
    }

    /** A session the client asked to keep (`ephemeral` absent on the command that started it). Returns the events it
     *  had already emitted before it could be marked, which the caller saves; nothing when it was already marked. */
    markSaved(hash: string): MlDebugEvent[] {
        const marked = this.index.markSaved(hash);
        if (!marked) return [];
        this.broadcastIndex({ type: "upsert", session: marked.summary });
        return marked.events;
    }

    /** Title a session and tell every client. Returns the new row, or null when nothing changed. */
    retitle(hash: string, title: string | null, renamed = false): SessionSummary | null {
        const row = this.index.setTitle(hash, title, renamed);
        if (row) this.broadcastIndex({ type: "upsert", session: row });
        return row;
    }

    /** Pin or unpin a session and tell every client. Returns the new row, or null when nothing changed. */
    pin(hash: string, pinned: boolean): SessionSummary | null {
        const row = this.index.setPinned(hash, pinned);
        if (row) this.broadcastIndex({ type: "upsert", session: row });
        return row;
    }

    /** Every session a connected page is subscribed to: what someone is looking at right now, which the saved-session
     *  store never evicts from under them. */
    subscribed(): string[] {
        const out = new Set<string>();
        for (const client of this.clients) for (const sub of client.subs.values()) out.add(sub.hash);
        return [...out];
    }

    /** Rows that appeared without an event of their own: what a previous worker saved, restored at startup. */
    restored(rows: readonly SessionSummary[]): void {
        for (const session of rows) this.broadcastIndex({ type: "upsert", session });
    }

    /** Forget a session: removed from every page's index, and every subscription to it ends with `gone`. */
    remove(id: SessionId): boolean {
        if (!this.index.remove(id.hash)) return false;
        // `gone` before the index row goes: a page looking at the session learns it was deleted, rather than seeing it
        // vanish from the list and its subscription close before the reason arrives.
        for (const client of this.clients) {
            for (const [sub, held] of client.subs) {
                if (held.hash !== id.hash) continue;
                this.post(client, { type: "stream", sub, message: { type: "gone", session: id } });
                client.subs.delete(sub);
            }
        }
        this.broadcastIndex({ type: "remove", id });
        return true;
    }

    private broadcastIndex(update: SessionIndexUpdate): void {
        for (const sink of this.sinks) sink.index(update);
        for (const client of this.clients) if (client.index) this.post(client, { type: "index", update });
    }
}

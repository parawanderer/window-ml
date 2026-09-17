// THE LOCAL HOST'S WIRE: the background side of the `ml-sessions` port that the chat page's `LocalHost`
// (src/chat/local-host.ts) connects to. It serves the session index and each session's event stream in the shapes
// the session contract defines, and hands commands to a handler. Pure over a port-like object, so the protocol is
// tested end to end in Node with the real client on the other side; sw-sessions.ts plugs it into `chrome.runtime`.
//
// Only extension pages may connect (the background checks the port's sender URL before `attach`): a content script
// never reaches this, because a page's main world is hostile and the index spans every tab.
import type { MlDebugEvent } from "./contract";
import { SESSION_CONTRACT_VERSION, type Command, type CommandResult, type CommandType, type RuntimeInfo, type SessionId, type SessionIndexUpdate, type SessionStreamMessage, type StreamPosition } from "./session-host";
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

interface Client {
    port: PortLike;
    index: boolean;
    /** sub id → session hash */
    subs: Map<number, string>;
}

const KNOWN_COMMANDS: ReadonlySet<string> = new Set<CommandType>(["session.send", "session.cancel", "session.continue", "session.delete", "approval.answer", "chat.start", "agent.start", "tabs.list", "tab.screenshot", "page.highlight", "side.call"]);

/** Serves a {@link SessionIndex} to connected extension pages. */
export class SessionServer {
    private clients = new Set<Client>();

    constructor(
        readonly index: SessionIndex,
        private readonly opts: { runtime: () => RuntimeInfo; command: CommandHandler },
    ) {}

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
                client.subs.set(msg.sub, msg.hash);
                const since = msg.since && typeof msg.since.epoch === "string" && typeof msg.since.cursor === "number" ? msg.since : undefined;
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
        if (!out.accepted || !this.clients.size) return out;
        const hash = out.session.hash;
        for (const client of this.clients) {
            if (client.index) {
                for (const id of out.evicted) this.post(client, { type: "index", update: { type: "remove", id } });
                if (out.summary) this.post(client, { type: "index", update: { type: "upsert", session: out.summary } });
            }
            for (const [sub, h] of client.subs) {
                if (h !== hash) continue;
                if (out.reset) {
                    for (const message of this.index.backfill(hash)) this.post(client, { type: "stream", sub, message });
                } else {
                    this.post(client, { type: "stream", sub, message: { type: "event", v: SESSION_CONTRACT_VERSION, session: out.session, epoch: out.epoch, cursor: out.cursor, event: out.event } });
                }
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

    /** Forget a session: removed from every page's index, and every subscription to it ends with `gone`. */
    remove(id: SessionId): boolean {
        if (!this.index.remove(id.hash)) return false;
        // `gone` before the index row goes: a page looking at the session learns it was deleted, rather than seeing it
        // vanish from the list and its subscription close before the reason arrives.
        for (const client of this.clients) {
            for (const [sub, h] of client.subs) {
                if (h !== id.hash) continue;
                this.post(client, { type: "stream", sub, message: { type: "gone", session: id } });
                client.subs.delete(sub);
            }
        }
        this.broadcastIndex({ type: "remove", id });
        return true;
    }

    private broadcastIndex(update: SessionIndexUpdate): void {
        for (const client of this.clients) if (client.index) this.post(client, { type: "index", update });
    }
}

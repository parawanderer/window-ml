// hub-runtime.ts — THIS runtime on a hub: log in with what pairing gave it, publish the session index and every
// session's events as they happen, hand each stream's key to the account's devices that may view, and answer the sealed
// commands they send through the same handler the extension's own pages use (window-ml-hub docs/PROTOCOL.md §How the
// session contract maps onto it).
//
// What it trusts is the seal, never the hub: a device is a device because its chain verifies to the account root; a
// command is answered because its signature, its sender's leaf and its declared scope all check out, and the declared
// scope is the one the command NEEDS (`COMMAND_SCOPE`). The seal proves the sender holds the scope it declared; only
// this side knows which scope a command type requires, so a device holding `view` that declares `view` on a
// `session.delete` is refused here.
//
// chrome-free, over its inputs, so it is tested against the real hub; `sw-hub.ts` plugs it into the worker.
import { COMMAND_SCOPE, type Command, type CommandResult, type CommandType, type SessionIndexUpdate, type SessionStreamMessage, type SessionSummary } from "./session-host";
import { SessionPublisher, hubPublish } from "./session-publisher";
import { IndexPublisher } from "./session-relay";
import type { HubClient, HubEvent } from "./hub/client";
import { bytes, type Bytes } from "./hub/hpke";
import { verifyChain } from "./hub/keys";
import type { Membership } from "./hub/keyring";
import { ChannelKey, replyTo, type Opened } from "./hub/seal";
import { Kind, Role } from "./hub/wire";

/** Where the runtime's sessions come from: the worker's session server, or a test's stand-in. */
export interface RuntimeSide {
    /** the id this runtime's rows carry locally, rewritten to its principal on the way out */
    localIds: readonly string[];
    /** the index as it stands, for the snapshot a connection starts with */
    list(): SessionSummary[];
    /** every index change and every session's stream message from now on, until the returned stop is called */
    watch(sink: { index(update: SessionIndexUpdate): void; stream(hash: string, message: SessionStreamMessage): void }): () => void;
    /** run one contract command, addressed to this runtime by its LOCAL id */
    command(command: Command): Promise<CommandResult<CommandType>>;
}

/** Where the connection stands, for Settings to show. */
export type HubRuntimeStatus =
    | { state: "connecting" }
    | { state: "online"; devices: number }
    | { state: "offline"; reason: string; retryInMs: number }
    | { state: "stopped" };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** Reconnect backoff: quick for a blip, capped so a hub down for the night is retried twice a minute. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/**
 * Replace this runtime's local ids with its principal wherever a `runtime` key holds one, in a copy. The index and the
 * streams are keyed by runtime locally as `"local"` (or whatever this browser reported before it was paired), while a
 * device knows it as the principal it verified in presence. Rewritten at the boundary rather than renaming the index,
 * so the extension's own pages, bookmarks and stored keys keep the id they have.
 */
export function rehome<T>(value: T, from: ReadonlySet<string>, to: string): T {
    if (Array.isArray(value)) return value.map((v) => rehome(v, from, to)) as T;
    if (!value || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = k === "runtime" && typeof v === "string" && from.has(v) ? to : rehome(v, from, to);
    }
    return out as T;
}

/**
 * This runtime's connection to its hub, kept up for as long as it runs. Each connection starts fresh: a new stream key
 * per stream, a fresh index snapshot, and every device present granted again, so a reconnect never depends on what the
 * last connection had managed to say.
 */
export class HubRuntime {
    private stopped = false;
    private client: HubClient | null = null;
    private attempt = 0;
    private wake: (() => void) | null = null;

    constructor(
        private readonly opts: {
            membership: Membership;
            side: RuntimeSide;
            /** log in; throws when the hub cannot be reached or refuses */
            connect: () => Promise<HubClient>;
            onStatus?: (status: HubRuntimeStatus) => void;
            now?: () => number;
        },
    ) {}

    /** Connect, and keep reconnecting until `stop`. Resolves when stopped. */
    async run(): Promise<void> {
        while (!this.stopped) {
            this.opts.onStatus?.({ state: "connecting" });
            let reason: string;
            try {
                this.client = await this.opts.connect();
                this.attempt = 0;
                reason = await this.serve(this.client);
            } catch (e) {
                reason = (e as Error)?.message || String(e);
            }
            this.client = null;
            if (this.stopped) break;
            const wait = BACKOFF_MS[Math.min(this.attempt++, BACKOFF_MS.length - 1)];
            this.opts.onStatus?.({ state: "offline", reason, retryInMs: wait });
            await new Promise<void>((resolve) => { const t = setTimeout(resolve, wait); this.wake = () => { clearTimeout(t); resolve(); }; });
            this.wake = null;
        }
        this.opts.onStatus?.({ state: "stopped" });
    }

    /** Stop, closing the connection. */
    stop(): void {
        this.stopped = true;
        this.client?.close();
        this.wake?.();
    }

    /** Serve one connection until it closes; resolves with why. */
    private async serve(client: HubClient): Promise<string> {
        const now = this.opts.now ?? Date.now;
        const principal = hex(client.principal);
        const local = new Set(this.opts.side.localIds);
        const out = <T>(v: T): T => rehome(v, local, principal);

        const channels = await ChannelKey.fromBytes(bytes(this.opts.membership.channelKey));
        const publisher = new SessionPublisher(hubPublish(client, Kind.KIND_SESSION_EVENTS), channels, client.principal, now);
        const index = new IndexPublisher(principal, (batch) => publisher.publishIndex(batch));
        const devices = new Set<string>();

        // Watch first, then snapshot: a change landing between the two is in the snapshot or after it, never lost. A
        // failed publish (the socket closed under it) ends this connection through `next()`, so it is only logged.
        const stop = this.opts.side.watch({
            index: (u) => { void index.update(out(u)).catch(() => {}); },
            stream: (hash, m) => { void publisher.publish(hash, out(m)).catch(() => {}); },
        });
        try {
            await index.snapshot(out(this.opts.side.list()));
            this.opts.onStatus?.({ state: "online", devices: 0 });
            for (;;) {
                const event: HubEvent = await client.next();
                if (event.kind === "closed") return event.reason;
                if (event.kind === "presence") {
                    await this.presence(event, publisher, devices, now());
                    this.opts.onStatus?.({ state: "online", devices: devices.size });
                } else if (event.kind === "command") {
                    void this.answer(client, event.opened, local, principal);
                }
                // results (this runtime sends no commands yet), published frames, gaps: nothing to do
            }
        } finally {
            stop();
        }
    }

    /**
     * A principal came or went. Only a CLIENT whose chain verifies to this account's root is a device; its key grants
     * follow its verified leaf, never what presence claims.
     */
    private async presence(
        e: Extract<HubEvent, { kind: "presence" }>,
        publisher: SessionPublisher,
        devices: Set<string>,
        nowMs: number,
    ): Promise<void> {
        const id = hex(e.principal);
        if (!e.online || e.role !== Role.ROLE_CLIENT) {
            publisher.deviceOffline(id);
            devices.delete(id);
            return;
        }
        let verified;
        try { verified = await verifyChain(bytes(this.opts.membership.accountRoot), e.chain, nowMs); } catch { return; }
        if (hex(verified.principal) !== id) return;
        devices.add(id);
        await publisher.deviceOnline({
            id, scopes: verified.leaf.scopes,
            recipient: { principal: e.principal, agreementKey: bytes(verified.leaf.agreementKey) },
        });
    }

    /** Answer one command: its declared scope must be the one its type needs, then the local handler runs it. */
    private async answer(client: HubClient, opened: Opened, local: ReadonlySet<string>, principal: string): Promise<void> {
        let result: CommandResult<CommandType>;
        let command: Command | null = null;
        try { command = JSON.parse(decoder.decode(opened.body)) as Command; } catch { /* below */ }
        if (!command || typeof command !== "object" || typeof command.type !== "string") {
            result = { ok: false, error: { code: "invalid", message: "not a command" } };
        } else if (!(command.type in COMMAND_SCOPE)) {
            result = { ok: false, error: { code: "unsupported", message: "this runtime does not know that command" } };
        } else if (opened.scope !== COMMAND_SCOPE[command.type as CommandType]) {
            result = { ok: false, error: { code: "forbidden", message: `${command.type} needs \`${COMMAND_SCOPE[command.type as CommandType]}\`` } };
        } else {
            const [localId] = local;
            try {
                result = await this.opts.side.command(rehome(command, new Set([principal]), localId));
            } catch (e) {
                result = { ok: false, error: { code: "failed", message: (e as Error)?.message || String(e) } };
            }
            if (result.ok && command.type === "runtime.info") result = remoteDescription(result);
            result = rehome(result, local, principal);
        }
        try { await client.result(replyTo(opened), opened.nonce, encoder.encode(JSON.stringify(result)) as Bytes); } catch { /* closed */ }
    }
}

/** What a remote device is told about this runtime: never that its settings are editable from there. */
function remoteDescription(result: CommandResult<CommandType>): CommandResult<CommandType> {
    if (!result.ok) return result;
    const data = result.data as { capabilities?: Record<string, unknown> };
    if (!data?.capabilities) return result;
    const { localSettings: _local, ...capabilities } = data.capabilities;
    return { ok: true, data: { ...data, capabilities } as never };
}

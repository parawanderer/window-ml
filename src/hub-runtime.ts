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
import { CertificateBody } from "./proto/wmlhub/v1/identity.gen";
import { ChannelKey, replyTo, type Opened } from "./hub/seal";
import { encodeRevocations } from "./hub/revocation";
import type { Identity } from "./hub/keys";
import type { DeviceRegistry } from "./hub-devices";
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
            /** the allowlist: devices seen, and what is revoked. Absent: no `device.*`, and nothing is refused as revoked */
            devices?: DeviceRegistry;
            /** this runtime's own keys, to sign the revocation list with when its leaf carries `may_revoke` */
            signer?: Identity;
            /** how often to check whether the list is due for its daily re-sign */
            resignCheckMs?: number;
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

    /**
     * Revoke a device from this runtime's own Settings (`device.revoke` is the same act over the hub). The allowlist
     * changes at once; when connected, the new list goes out and the connection restarts, which rotates every key.
     * Offline, the rotation happens on the next connection, which starts under fresh keys anyway.
     */
    async revoke(principal: string): Promise<"revoked" | "already" | "self"> {
        const reg = this.opts.devices;
        if (!reg) throw new Error("this runtime keeps no device list");
        const target = principal.toLowerCase();
        if (this.client && target === hex(this.client.principal)) return "self";
        if (!(await reg.revoke(target))) return "already";
        const client = this.client;
        if (client && this.publishList) { await this.publishList().catch(() => {}); client.close(); }
        return "revoked";
    }

    /** The current connection's list publisher, for `revoke` from outside a command. */
    private publishList: (() => Promise<void>) | null = null;

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
        // The revocation list: on every connection (the ring then holds it for publishers reading while this runtime
        // is away), and re-signed daily so a publisher's 7-day freshness floor never bites while it is up.
        const revocations = await channels.channel("revocations", client.principal);
        const publishList = async (): Promise<void> => {
            if (!this.opts.devices || !this.opts.signer || !this.mayRevoke) return;
            const list = await this.opts.devices.sign(this.opts.signer, this.opts.membership.chain, bytes(this.opts.membership.accountRoot), now());
            client.publish(revocations, Kind.KIND_SESSION_EVENTS, encodeRevocations(list));
        };
        this.publishList = publishList;
        const resign = setInterval(() => { if (this.opts.devices?.due(now())) void publishList().catch(() => {}); }, this.opts.resignCheckMs ?? 60 * 60_000);
        try {
            await index.snapshot(out(this.opts.side.list()));
            await publishList();
            this.opts.onStatus?.({ state: "online", devices: 0 });
            for (;;) {
                const event: HubEvent = await client.next();
                if (event.kind === "closed") return event.reason;
                if (event.kind === "presence") {
                    await this.presence(event, publisher, devices, now(), client.principal);
                    this.opts.onStatus?.({ state: "online", devices: devices.size });
                } else if (event.kind === "command") {
                    void this.answer(client, event.opened, local, principal, publishList);
                }
                // results (this runtime sends no commands yet), published frames, gaps: nothing to do
            }
        } finally {
            clearInterval(resign);
            this.publishList = null;
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
        self: Bytes,
    ): Promise<void> {
        const id = hex(e.principal);
        if (!e.online) {
            publisher.deviceOffline(id);
            devices.delete(id);
            return;
        }
        if (id === hex(self)) return;
        let verified;
        try { verified = await verifyChain(bytes(this.opts.membership.accountRoot), e.chain, nowMs); } catch { return; }
        if (hex(verified.principal) !== id) return;
        // Revoked here is revoked everywhere this runtime decides: never listed again, never handed a key.
        const reg = this.opts.devices;
        if (reg && (reg.isRevoked(id) || (await reg.revokes(e.chain)))) return;
        await reg?.seen(e.chain, verified, nowMs);
        if (e.role !== Role.ROLE_CLIENT) return;
        devices.add(id);
        await publisher.deviceOnline({
            id, scopes: verified.leaf.scopes,
            recipient: { principal: e.principal, agreementKey: bytes(verified.leaf.agreementKey) },
        });
    }

    /** Answer one command: its declared scope must be the one its type needs, then the local handler runs it. */
    private async answer(client: HubClient, opened: Opened, local: ReadonlySet<string>, principal: string, publishList: () => Promise<void>): Promise<void> {
        let result: CommandResult<CommandType>;
        let command: Command | null = null;
        let rotate = false;
        const reg = this.opts.devices;
        try { command = JSON.parse(decoder.decode(opened.body)) as Command; } catch { /* below */ }
        if (!command || typeof command !== "object" || typeof command.type !== "string") {
            result = { ok: false, error: { code: "invalid", message: "not a command" } };
        } else if (!(command.type in COMMAND_SCOPE)) {
            result = { ok: false, error: { code: "unsupported", message: "this runtime does not know that command" } };
        } else if (opened.scope !== COMMAND_SCOPE[command.type as CommandType]) {
            result = { ok: false, error: { code: "forbidden", message: `${command.type} needs \`${COMMAND_SCOPE[command.type as CommandType]}\`` } };
        } else if (reg && (reg.isRevoked(hex(opened.from)) || (await reg.revokes(opened.chain)))) {
            // The allowlist is the authoritative revocation: immediate, and needing nothing from the hub.
            result = { ok: false, error: { code: "forbidden", message: "this device was revoked" } };
        } else if (command.type.startsWith("device.")) {
            ({ result, rotate } = await this.device(command, principal));
        } else {
            const [localId] = local;
            try {
                result = await this.opts.side.command(rehome(command, new Set([principal]), localId));
            } catch (e) {
                result = { ok: false, error: { code: "failed", message: (e as Error)?.message || String(e) } };
            }
            if (result.ok && command.type === "runtime.info") result = remoteDescription(result, !!reg);
            result = rehome(result, local, principal);
        }
        try { await client.result(replyTo(opened), opened.nonce, encoder.encode(JSON.stringify(result)) as Bytes); } catch { /* closed */ }
        // After the answer, never before it: `device.revoke` returns once the allowlist says so. Then the new list goes
        // out, and the connection is dropped so the next starts every stream under a fresh key, granted only to the
        // devices that remain. That IS the rotation: nothing is re-encrypted, and a revoked device holds only old keys.
        if (rotate) {
            await publishList().catch(() => {});
            client.close();
        }
    }

    /** `device.list` and `device.revoke`, the allowlist's side. Renewal and re-scoping are not built yet. */
    private async device(command: Command, principal: string): Promise<{ result: CommandResult<CommandType>; rotate: boolean }> {
        const reg = this.opts.devices;
        const fail = (code: "unsupported" | "invalid" | "conflict", message: string) => ({ result: { ok: false, error: { code, message } } as CommandResult<CommandType>, rotate: false });
        if (!reg) return fail("unsupported", "this runtime keeps no device list");
        if (command.type === "device.list") return { result: { ok: true, data: { devices: reg.list() } } as CommandResult<CommandType>, rotate: false };
        if (command.type === "device.revoke") {
            const target = String((command as { principal?: unknown }).principal ?? "").toLowerCase();
            if (!/^[0-9a-f]{64}$/.test(target)) return fail("invalid", "a principal is 64 hex characters");
            // This runtime signs the list; revoking itself would leave the account unable to revoke anything.
            if (target === principal) return fail("conflict", "a runtime does not revoke itself; revoke it from another device");
            const changed = await reg.revoke(target);
            return { result: { ok: true, data: {} } as CommandResult<CommandType>, rotate: changed };
        }
        return fail("unsupported", `${command.type} is not built yet`);
    }

    /** Does this runtime's own certificate carry `may_revoke`? Only then does it sign a list. */
    private get mayRevoke(): boolean {
        try { return CertificateBody.decode(this.opts.membership.chain[0].body).mayRevoke; } catch { return false; }
    }
}

/** What a remote device is told about this runtime: never that its settings are editable from there, and that it
 *  manages the account's devices when it keeps the allowlist. */
function remoteDescription(result: CommandResult<CommandType>, devices: boolean): CommandResult<CommandType> {
    if (!result.ok) return result;
    const data = result.data as { capabilities?: Record<string, unknown> };
    if (!data?.capabilities) return result;
    const { localSettings: _local, ...capabilities } = data.capabilities;
    return { ok: true, data: { ...data, capabilities: { ...capabilities, ...(devices ? { devices: true } : {}) } } as never };
}

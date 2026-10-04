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
import { IndexPublisher, LivePreview } from "./session-relay";
import type { HubClient, HubEvent } from "./hub/client";
import { bytes, type Bytes } from "./hub/hpke";
import { encodeChain, issueCertificate, renewalPredecessor, verifyChain, MAX_CERTIFICATE_MS, RENEW_WITHIN_MS } from "./hub/keys";
import type { Membership } from "./hub/keyring";
import { Certificate, CertificateBody } from "./proto/wmlhub/v1/identity.gen";
import { ChannelKey, replyTo, type Opened } from "./hub/seal";
import { encodeRevocations } from "./hub/revocation";
import type { Identity } from "./hub/keys";
import type { DeviceRegistry } from "./hub-devices";
import { Kind, Role } from "./hub/wire";

/** How far back a freshly issued window reaches, so a device whose clock runs a little behind is not refused. */
const CLOCK_SKEW_MS = 5 * 60_000;
/**
 * How long a renewal's answer is kept and re-given instead of signing a second one. It is what `idempotencyKey`
 * means here, and it is a CACHE rather than a refusal on purpose: a device whose answer was lost to a dropped
 * connection has to be able to ask again, or the renewal happened and the device expires anyway.
 *
 * Judging dueness from the certificate the device PRESENTS cannot do this job, which is what the test caught: a live
 * connection keeps presenting the chain it opened with, so every ask looks like the first one.
 */
const RENEW_COOLDOWN_MS = 60_000;

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
        // What a streamed run costs over a hub, bounded here rather than at the loop that emits it: a reader in this
        // browser pays a function call per preview and a remote one pays a sealed frame, a ring slot and a queue
        // entry on every subscriber (session-relay.ts `LivePreview`).
        const previews = new LivePreview();
        const devices = new Set<string>();

        // Watch first, then snapshot: a change landing between the two is in the snapshot or after it, never lost. A
        // failed publish (the socket closed under it) ends this connection through `next()`, so it is only logged.
        const stop = this.opts.side.watch({
            index: (u) => { void index.update(out(u)).catch(() => {}); },
            stream: (hash, m) => {
                const wire = previews.forWire(hash, out(m));
                if (wire) void publisher.publish(hash, wire).catch(() => {});
            },
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
            // The narrowed set, not the certificate's: a device that lost `view` must stop being handed stream keys,
            // and this is where they are handed out. (A box connector grants on the certificate alone and would not
            // know — the same gap revocation has, which the signed list closes and this does not.)
            id, scopes: reg ? reg.allowed(id, verified.leaf.scopes) : verified.leaf.scopes,
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
        } else if (reg && !reg.allowed(hex(opened.from), CertificateBody.decode(opened.chain[0].body).scopes).includes(opened.scope)) {
            // NARROWED since its certificate was issued. The certificate still carries the wider set and this runtime
            // cannot change that, so the allowlist is what enforces it — the same place, and the same immediacy, as a
            // revocation. Worded as the account's decision rather than as a broken certificate.
            result = { ok: false, error: { code: "forbidden", message: `this device is no longer allowed \`${opened.scope}\` on this account` } };
        } else if (command.type.startsWith("device.")) {
            ({ result, rotate } = await this.device(command, principal, opened.chain, hex(opened.from)));
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

    /** `device.list`, `device.revoke` and `device.renew`. Re-scoping is not built yet. */
    private async device(command: Command, principal: string, chain: readonly Certificate[], from: string): Promise<{ result: CommandResult<CommandType>; rotate: boolean }> {
        const reg = this.opts.devices;
        const fail = (code: "unsupported" | "invalid" | "conflict" | "forbidden" | "not-found", message: string) => ({ result: { ok: false, error: { code, message } } as CommandResult<CommandType>, rotate: false });
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
        if (command.type === "device.renew") return { result: await this.renew(command, from, chain), rotate: false };
        if (command.type === "device.scopes") {
            const target = String((command as { principal?: unknown }).principal ?? "").toLowerCase();
            if (!/^[0-9a-f]{64}$/.test(target)) return fail("invalid", "a principal is 64 hex characters");
            const want = (command as { scopes?: unknown }).scopes;
            if (!Array.isArray(want) || want.some((x) => typeof x !== "string")) return fail("invalid", "scopes is a list of scope names");
            // This runtime signs the account's list and answers every command; narrowing itself would be a runtime
            // quietly removing its own ability to serve, with nothing left to widen it back.
            if (target === principal) return fail("conflict", "a runtime does not narrow itself");
            let scopes: string[] | null;
            try { scopes = await reg.narrow(target, want as string[]); }
            catch (e) { return fail("forbidden", (e as Error)?.message || "those scopes cannot be granted here"); }
            if (!scopes) return fail("not-found", "no such device on this account");
            // `view` gone means it must stop READING, and what it holds is a stream key. Rotating is how that is taken
            // back — the same act a revocation performs, for the same reason.
            return { result: { ok: true, data: { scopes } } as CommandResult<CommandType>, rotate: !scopes.includes("view") };
        }
        return fail("unsupported", `${command.type} is not built yet`);
    }

    /**
     * A DEVICE RENEWS ITSELF. The answer carries the new chain, which is why it can only be the asker's: nothing can
     * push a certificate at a device, so the asker has to be the one that installs it.
     *
     * It grants nothing. `verifyChain` holds a renewal to the same subject, agreement key, role, scopes and
     * `may_pair` as the certificate it renews, so this re-signs a window and nothing else — and the predecessor it
     * embeds is the ROOT-issued original, which the device is already carrying (`renewalPredecessor`).
     */
    private async renew(command: Command, from: string, chain: readonly Certificate[]): Promise<CommandResult<CommandType>> {
        const fail = (code: "forbidden" | "invalid" | "conflict" | "unsupported", message: string) =>
            ({ ok: false, error: { code, message } }) as CommandResult<CommandType>;
        const target = String((command as { principal?: unknown }).principal ?? "").toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(target)) return fail("invalid", "a principal is 64 hex characters");
        // `from` is the SENDER, not this runtime: the two are different principals and confusing them here would have
        // let any device renew any other, which is the one thing this command must not do.
        if (target !== from) return fail("forbidden", "a device renews only its own certificate");
        const leaf = chain[0];
        if (!leaf) return fail("invalid", "no certificate to renew");
        const body = CertificateBody.decode(leaf.body);
        // A delegate may neither issue nor renew `may_revoke`, so the device that signs this account's revocations is
        // renewed by the root alone. Said as what to do, since nothing here can do it.
        if (body.mayRevoke) return fail("forbidden", "this device signs the account's revocations, which only the root device may renew");
        const root = bytes(this.opts.membership.accountRoot);
        const predecessor = renewalPredecessor(leaf, root);
        if (!predecessor) return fail("unsupported", "this device was paired by another device rather than by the root, so its certificate cannot be renewed; pair it again");

        // This runtime signs it, so a runtime that holds no signing key cannot answer at all.
        const signer = this.opts.signer;
        if (!signer) return fail("unsupported", "this runtime cannot issue certificates");
        const t = (this.opts.now ?? Date.now)();
        if (body.notAfterMs <= t) return fail("conflict", "this certificate has already expired; pair the device again");
        // Not due: answered with what it has rather than signed again.
        if (body.notAfterMs - t > RENEW_WITHIN_MS) return { ok: true, data: { notAfterMs: body.notAfterMs } } as CommandResult<CommandType>;
        // Asked again within the cooldown: the SAME answer, so a loop cannot make this runtime sign in a loop and a
        // device that lost the first answer still gets its certificate.
        const cached = this.renewals.get(from);
        if (cached && t - cached.at < RENEW_COOLDOWN_MS) return { ok: true, data: cached.data } as CommandResult<CommandType>;

        // `OutlivesIssuer`: a renewal may not outlast the runtime that signed it, so a runtime near its own expiry
        // hands out shorter windows until the root renews IT. Visible to nobody, which is the point.
        const mine = CertificateBody.decode(this.opts.membership.chain[0].body).notAfterMs;
        const notAfterMs = Math.min(t - CLOCK_SKEW_MS + MAX_CERTIFICATE_MS, mine);
        if (notAfterMs <= t) return fail("conflict", "this runtime's own certificate is expiring; renew it from the root device first");
        let renewed: Certificate[];
        try {
            const cert = await issueCertificate(signer, {
                subject: bytes(body.subject), agreementKey: bytes(body.agreementKey), role: body.role,
                scopes: body.scopes, mayPair: body.mayPair, label: body.label,
                notBeforeMs: t - CLOCK_SKEW_MS, notAfterMs, renews: predecessor,
            });
            renewed = [cert, ...this.opts.membership.chain];
            // Checked HERE rather than discovered at the device: this runtime is the only thing that can tell a
            // mistake in what it just signed from a device that cannot read it, and the device has no way back.
            await verifyChain(root, renewed, t);
        } catch (e) {
            return fail("conflict", (e as Error)?.message || "the certificate could not be renewed");
        }
        await this.opts.devices?.seen(renewed, await verifyChain(root, renewed, t), t);
        const data = { notAfterMs, chain: encodeChain(renewed) };
        // One entry per device, and devices are few; the stale ones go whenever this is read for somebody else.
        for (const [who, e] of this.renewals) if (t - e.at >= RENEW_COOLDOWN_MS) this.renewals.delete(who);
        this.renewals.set(from, { at: t, data });
        return { ok: true, data } as CommandResult<CommandType>;
    }

    /** The last renewal answered to each device, for {@link RENEW_COOLDOWN_MS}. */
    private readonly renewals = new Map<string, { at: number; data: { notAfterMs: number; chain: string[] } }>();

    /** Does this runtime's own certificate carry `may_revoke`? Only then does it sign a list. */
    private get mayRevoke(): boolean {
        try { return CertificateBody.decode(this.opts.membership.chain[0].body).mayRevoke; } catch { return false; }
    }
}

/** What a remote device is told about this runtime: never that its settings are editable from there, and that it
 *  manages the account's devices when it keeps the allowlist.
 *
 *  Everything else crosses whole, deliberately — `blankStart` above all, which is the one capability that exists FOR
 *  the remote reader. A client cannot grant a permission on another machine, so the sites that machine already holds
 *  and the browser to word the fix in are the only things that make a blocked new-tab run actionable from here.
 *  Stripping it would not break anything loudly; it would just leave the remote case with nothing to offer. */
function remoteDescription(result: CommandResult<CommandType>, devices: boolean): CommandResult<CommandType> {
    if (!result.ok) return result;
    const data = result.data as { capabilities?: Record<string, unknown> };
    if (!data?.capabilities) return result;
    const { localSettings: _local, ...capabilities } = data.capabilities;
    return { ok: true, data: { ...data, capabilities: { ...capabilities, ...(devices ? { devices: true } : {}) } } as never };
}

// hub-connection.ts — one authenticated connection to a hub, as the chat page's host layer uses it: who is there,
// and a sealed command answered by its result (docs/spec/CHAT_PAGE.md slice 6, window-ml-hub docs/PROTOCOL.md).
//
// It is NOT a `SessionHost`. It is the half of one that needs no decisions about channels: presence into runtime
// identity, and `send` into a sealed COMMAND whose COMMAND_RESULT comes back by nonce. The index and per-session
// event streams sit on top of this once their channel derivation is settled, and keeping them apart is what lets
// this be finished and tested while that is still being argued about.
//
// NOTHING HERE TRUSTS THE HUB. `Envelope.sender` is the hub's word and is never acted on; a chain that arrives with
// a presence is verified against the account root this client already holds before its label or its key is used,
// because the hub relaying a certificate is a convenience and not a claim. What a runtime is allowed to do is
// decided by the runtime from the signature inside the seal, never here.
import { verifyChain } from "../hub/keys";
import type { Bytes } from "../hub/hpke";
import type { Grant, Recipient } from "../hub/seal";
import type { Position } from "../hub/wire";
import { CommandTooLarge, HubClient, type HubEvent } from "../hub/client";
import { pageRaster, workerRaster, type Raster } from "../raster";
import { fitImages } from "./fit-images";
import { Role } from "../hub/wire";
import { COMMAND_SCOPE, type AttachedFileRef, type Command, type CommandResult, type CommandType, type WireFile } from "../session/session-host";
import { PDF_ATTACH_MAX } from "../attached-files";
import { b64ToBytes } from "../pdf/pdf-wire";
import { FILE_PUT_WINDOW, chunkSize, fileCap, frameChunk, sha256Hex } from "../hub/file-frame";

/** How long a sealed command waits for its result before the caller is told the runtime did not answer. */
export const COMMAND_TIMEOUT_MS = 30_000;

/** One runtime this connection can see, as presence and its verified chain describe it. */
export interface HubPeer {
    /** the principal id, lowercase hex: `RuntimeInfo.id` for a hub-fronted runtime */
    id: string;
    /** the label on the leaf certificate — its owner's words, verified to be theirs, never proof of anything */
    name: string;
    online: boolean;
    /** epoch ms on THIS client's clock, of the last traffic seen from it */
    lastSeen: number;
    /** who to seal to: the principal, and the agreement key from its verified leaf */
    recipient: Recipient;
    /** what it IS, from its verified leaf: only a runtime is listed as one. A phone's own presence arrives the same way,
     *  and without this it would appear in a runtime list as a runtime. */
    role: Role;
    /** it signs the account's revocations, from its verified leaf. Absent is "not that, or not seen". */
    mayRevoke?: true;
    /** whether it may pair devices, and so sign another device's renewal, from its verified leaf. Always set once a
     *  presence verified: a runtime paired with that permission switched off (the phone's default since #815) cannot
     *  renew anyone, and a client must not send people to it. */
    mayPair?: boolean;
}

/** What one subscription hears about its stream. The payload is still SEALED: opening it needs a grant, which is the
 *  caller's business, since which grant opens a stream is exactly the decision that must not be made here. */
export type StreamEvent =
    | { kind: "published"; sender: Bytes; seq: number; epoch: number; payload: Bytes }
    /** the hub has finished sending what it retained; `truncated` means the ring no longer holds the start */
    | { kind: "backfilled"; epoch: number; seq: number; truncated: boolean }
    /** frames the hub dropped for this subscriber (a slow consumer): what is missing has to be read another way */
    | { kind: "gap"; dropped: number };

const hex = (b: Bytes): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
/** A stream's identity: whose it is AND which channel, since two publishers may use the same channel name. */
const streamKey = (publisher: Uint8Array, channel: Uint8Array): string => `${hex(publisher as Bytes)}:${hex(channel as Bytes)}`;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Bytes WebCrypto and the seal take: what this module allocates is always its own. */
const bytes = (s: string): Bytes => encoder.encode(s) as Bytes;

/** Room left under the hub's limit for what a measurement cannot see (a length prefix that grew a byte or two). */
const SIZE_MARGIN = 512;

/** The hub's payload limit when it announces none (`(1<<20)-1024`, the relay's own default). */
const HUB_PAYLOAD_DEFAULT = (1 << 20) - 1024;

/** `Error.Code.CODE_LIMIT` (hub.proto): a frame over a limit, which sending it again will not fix. */
const HUB_CODE_LIMIT = 5;

/** A size as the person reads it: megabytes to one decimal. */
const mb = (n: number): string => `${(n / 1048576).toFixed(1)} MB`;

/** The refusal for a command over the hub's limit, in the sentence the composer shows. */
const tooLarge = <T extends CommandType>(e: CommandTooLarge): CommandResult<T> =>
    fail("invalid", `too large to send through the hub: ${mb(e.size)}; the hub takes up to ${mb(e.limit)} per message`);

/** The raster a smaller copy of an image is drawn with, where this runs: a page's, a worker's, or none (node). */
function defaultRaster(): Raster | null {
    if (typeof document !== "undefined") return pageRaster;
    if (typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap !== "undefined") return workerRaster;
    return null;
}

/**
 * A connection to a hub, pumping its events into peers and command answers.
 *
 * One pump rather than a listener per concern: `next()` is a single queue, so two readers would race for each
 * event and each would see half of them.
 */
export class HubConnection {
    private readonly peers = new Map<string, HubPeer>();
    /** by command nonce, in hex. The resolver is typed at the command it belongs to, which only its own `send`
     *  knows, so the map holds the widest shape and each `send` narrows its own. */
    private readonly waiting = new Map<string, (r: CommandResult<CommandType>) => void>();
    /** by command nonce, in hex: the peer each waiting command was sealed to, so a peer going offline settles them. The
     *  hub discards what it had queued to a runtime whose connection dropped, so nothing would ever answer them. */
    private readonly waitingOn = new Map<string, string>();
    private readonly peerListeners = new Set<(peers: HubPeer[]) => void>();
    private readonly closeListeners = new Set<(reason: string) => void>();
    private closedWith: string | null = null;
    /** by `<publisher hex>:<channel hex>`: every stream this connection is subscribed to, and who hears it */
    private readonly streams = new Map<string, (e: StreamEvent) => void>();
    private stopped = false;
    /** What re-encodes an image smaller when a command would not fit the hub; null shrinks nothing (the refusal applies). */
    raster: Raster | null = defaultRaster();

    private constructor(
        private readonly client: HubClient,
        private readonly accountRoot: Bytes,
        private readonly now: () => number,
        /** what OUR OWN leaf certificate grants: the scopes a command may be sealed under */
        private readonly scopes: ReadonlySet<string>,
    ) {}

    /** Connect, then start reading. The connection is live when this resolves. */
    static async open(config: Parameters<typeof HubClient.connect>[0], now: () => number = Date.now): Promise<HubConnection> {
        const client = await HubClient.connect(config);
        // Our own scopes, read from our own chain. Not for display: a command sealed under a scope the leaf does
        // not grant is refused INSIDE THE SEAL, so the runtime never sees it and never answers — and a caller that
        // is not told waits for a timeout for a command that was never going to arrive.
        const mine = await verifyChain(config.accountRoot, config.chain, now());
        const conn = new HubConnection(client, config.accountRoot, now, new Set(mine.leaf.scopes));
        void conn.pump();
        return conn;
    }

    /** Every runtime this connection can see, as a whole list on each change. */
    onPeers(listener: (peers: HubPeer[]) => void): () => void {
        this.peerListeners.add(listener);
        listener([...this.peers.values()]);
        return () => this.peerListeners.delete(listener);
    }

    /** One peer by its principal id, or undefined when presence has not named it. */
    peer(id: string): HubPeer | undefined {
        return this.peers.get(id);
    }

    /**
     * Seal a command to a runtime and wait for the result it answers.
     *
     * Never rejects: every failure is a `CommandResult`, because a caller that has to tell `not-found` from a thrown
     * error has two error paths for one question. A runtime that is not in presence is `not-found` rather than a
     * timeout — there is nobody to be slow.
     */
    async send<C extends Command>(command: C, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<CommandResult<C["type"]>> {
        const runtime = "runtime" in command ? command.runtime : command.session.runtime;
        const peer = this.peers.get(runtime);
        if (!peer) return fail("not-found", "no such runtime on this hub");
        if (!peer.online) return fail("unavailable", `${peer.name} is not connected`);
        if (opts?.signal?.aborted) return fail("aborted", "cancelled before it was sent");
        // The seal refuses a scope our leaf does not grant, so this would be sent, silently dropped and waited on.
        // `forbidden` is the true answer and the runtime would have given the same one.
        const scope = COMMAND_SCOPE[command.type];
        if (!this.scopes.has(scope)) return fail("forbidden", `this device does not hold \`${scope}\` on this account`);

        // A PDF goes ahead in `file.put` chunks and the command names it by hash: inline it is usually past the limit.
        const ahead = await this.filesAhead(command, peer, runtime, opts);
        if ("ok" in ahead) return ahead;
        return await this.deliver(ahead, peer, scope, null, opts);
    }

    /** Seal one command (with `raw` bytes after its JSON, for a `file.put`) and wait for its answer. */
    private async deliver<C extends Command>(command: C, peer: HubPeer, scope: string, raw: Uint8Array | null, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<CommandResult<C["type"]>> {
        let nonce: Bytes;
        let note: string | undefined;
        try {
            try {
                const json = bytes(JSON.stringify(command));
                nonce = await this.client.command(peer.recipient, scope, raw ? frameChunk(json, raw) as Bytes : json);
            } catch (e) {
                // The relay closes the WHOLE connection on a payload over its limit, so an oversize command is never
                // sent: its images are re-encoded smaller if that can make it fit, and it is refused if not.
                if (!(e instanceof CommandTooLarge) || raw) throw e;
                const fitted = await this.fitImagesOf(command, peer.recipient, scope, e);
                if (!fitted) return tooLarge(e);
                note = `Sent as a smaller copy to fit the hub's limit of ${mb(e.limit)} per message`;
                nonce = await this.client.command(peer.recipient, scope, bytes(JSON.stringify(fitted)));
            }
        } catch (e) {
            if (e instanceof CommandTooLarge) return tooLarge(e);
            return fail("unavailable", `could not reach ${peer.name}: ${(e as Error)?.message || e}`);
        }
        const key = hex(nonce);

        const result = await new Promise<CommandResult<C["type"]>>((resolve) => {
            let done = false;
            const settle = (r: CommandResult<C["type"]>): void => {
                if (done) return;
                done = true;
                this.waiting.delete(key);
                this.waitingOn.delete(key);
                clearTimeout(timer);
                opts?.signal?.removeEventListener("abort", onAbort);
                resolve(r);
            };
            // A command that was SENT and then abandoned still has a nonce the runtime will answer. Forgetting the
            // waiter is right; pretending it was never sent is not, which is why this is `aborted` and not an error
            // about the runtime.
            const onAbort = () => settle(fail("aborted", "cancelled while waiting for an answer"));
            const timer = setTimeout(
                () => settle(fail("unavailable", `${peer.name} did not answer`)),
                opts?.timeoutMs ?? COMMAND_TIMEOUT_MS,
            );
            opts?.signal?.addEventListener("abort", onAbort, { once: true });
            this.waiting.set(key, settle as (r: CommandResult<CommandType>) => void);
            this.waitingOn.set(key, peer.id);
            // Sealing and sending is asynchronous, so an abort can land BETWEEN the check at the top and this
            // listener existing — in which case the listener is attached to a signal that has already fired and
            // will never fire again. Asking once more, after everything `settle` needs is in place, is what makes
            // an abort straight after a send an abort rather than a wait for the timeout.
            if (opts?.signal?.aborted) settle(fail("aborted", "cancelled while it was being sent"));
        });
        return note && result.ok ? { ...result, note } : result;
    }

    /**
     * The command with each inline PDF sent ahead in `file.put` chunks and named by hash in its place, or the command
     * as it is when it carries none or the runtime does not take chunks (an older one answers `file.have` with
     * `unsupported`, and the PDF goes inline, which fits only when it is small). A failure of any chunk is the answer.
     */
    private async filesAhead<C extends Command>(command: C, peer: HubPeer, runtime: string, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<C | CommandResult<C["type"]>> {
        if (command.type !== "chat.start" && command.type !== "session.send") return command;
        const files = (command as { files?: WireFile[] }).files ?? [];
        if (!files.some((f) => typeof (f as { data?: unknown }).data === "string")) return command;
        const out: WireFile[] = [];
        for (const f of files) {
            const data = typeof (f as { data?: unknown }).data === "string" ? (f as { data: string }).data : null;
            if (data === null) { out.push(f); continue; }
            const r = await this.putFile(runtime, peer, f.name, data, opts);
            if (r === "inline") return command;
            if ("ok" in r) return r as CommandResult<C["type"]>;
            out.push(r);
        }
        return { ...command, files: out };
    }

    /**
     * Send one file in chunks of what the hub takes, at most {@link FILE_PUT_WINDOW} unanswered, after asking which the
     * runtime already holds; done is the runtime's word (`complete`), never "all sent".
     * @returns the reference to send in the file's place, `inline` when the runtime does not take chunks, or the failure
     */
    private async putFile(runtime: string, peer: HubPeer, name: string, b64: string, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<AttachedFileRef | "inline" | CommandResult<CommandType>> {
        const data = b64ToBytes(b64);
        if (!data) return fail("invalid", `${name} is not valid base64`);
        const cap = fileCap(PDF_ATTACH_MAX, this.client.limits.accountBurstBytes);
        if (data.length > cap) return fail("invalid", `${name} is too large to send through this hub: ${mb(data.length)}; it takes files up to ${mb(cap)}`);
        const sha256 = await sha256Hex(data);
        const ref: AttachedFileRef = { name, type: "application/pdf", sha256, bytes: data.length };
        const scope = COMMAND_SCOPE["file.put"];
        const have = await this.deliver({ type: "file.have", runtime, sha256 }, peer, scope, null, opts);
        if (!have.ok) return have.error.code === "unsupported" ? "inline" : have;
        if (have.data.complete) return ref;
        const header = (index: number, count: number): Bytes => bytes(JSON.stringify({ type: "file.put", runtime, sha256, index, count, bytes: data.length }));
        const limit = this.client.limits.maxPayloadBytes > 0 ? this.client.limits.maxPayloadBytes : HUB_PAYLOAD_DEFAULT;
        const overhead = await this.client.commandOverhead(peer.recipient, scope);
        // Sized for the longest header this file's chunks can carry: every index and count written at full width.
        const widest = header(data.length, data.length).length;
        const size = chunkSize(limit, overhead, widest, SIZE_MARGIN);
        if (size < 1) return fail("invalid", "this hub's limit leaves no room for a file chunk");
        const count = Math.ceil(data.length / size);
        const held = have.data.count === count ? new Set(have.data.held) : new Set<number>();
        const todo = Array.from({ length: count }, (_, i) => i).filter((i) => !held.has(i));
        let next = 0, complete = false;
        let failed: CommandResult<CommandType> | null = null;
        const lane = async (): Promise<void> => {
            while (!failed && next < todo.length) {
                const i = todo[next++];
                const put = { type: "file.put" as const, runtime, sha256, index: i, count, bytes: data.length };
                const r = await this.deliver(put, peer, scope, data.subarray(i * size, (i + 1) * size), opts);
                if (!r.ok) { failed ??= r; return; }
                if (r.data.complete) complete = true;
            }
        };
        await Promise.all(Array.from({ length: Math.min(FILE_PUT_WINDOW, todo.length) }, lane));
        if (failed) return failed;
        if (complete) return ref;
        // Every chunk was answered and none said complete (the last ones were already held): ask, rather than assume.
        const after = await this.deliver({ type: "file.have", runtime, sha256 }, peer, scope, null, opts);
        if (!after.ok) return after;
        return after.data.complete ? ref : fail("unavailable", `${peer.name} did not confirm it holds all of ${name}; send it again`);
    }

    /**
     * The command with its images re-encoded smaller so that it fits the hub, or null when it carries none, nothing
     * here can draw them, or the smallest copies still do not fit. Only called for a command already known to be over.
     */
    private async fitImagesOf<C extends Command>(command: C, to: Recipient, scope: string, over: CommandTooLarge): Promise<C | null> {
        const images = "images" in command && Array.isArray(command.images) ? (command.images as string[]) : [];
        if (!images.length || !this.raster) return null;
        const overhead = await this.client.commandOverhead(to, scope);
        // What the images may add up to: the limit, less the seal, the rest of the command and each image's quotes and comma.
        const rest = bytes(JSON.stringify({ ...command, images: [] })).length;
        const budget = over.limit - overhead - rest - 3 * images.length - SIZE_MARGIN;
        const fitted = await fitImages(images, budget, this.raster);
        return fitted && fitted.shrunk > 0 ? { ...command, images: fitted.images } : null;
    }

    /**
     * Subscribe to one stream and hear everything it carries: the retained frames first, then `backfilled`, then
     * live frames as they are published.
     *
     * One listener per stream. A stream is named by its publisher AND its channel, because two runtimes may publish on
     * channels with the same name and they are two streams. Unsubscribing tells the hub, which matters beyond tidiness:
     * a subscription holds one of `max_subscriptions_per_connection` (256) and subscribing CREATES the stream, so a
     * client that never let go of what it stopped showing would run the account out of streams.
     */
    subscribe(publisher: Bytes, channel: Bytes, listener: (e: StreamEvent) => void, since?: Position): () => void {
        const key = streamKey(publisher, channel);
        this.streams.set(key, listener);
        this.client.subscribe(publisher, channel, since);
        return () => {
            if (this.streams.get(key) !== listener) return;   // replaced by a later subscribe to the same stream
            this.streams.delete(key);
            // A connection that has ended has nothing to tell the hub, which dropped the subscription with it.
            if (this.stopped || this.closedWith !== null) return;
            try { this.client.unsubscribe(publisher, channel); } catch { /* closed between the check and the send */ }
        };
    }

    /** What THIS device's own verified leaf grants: `RuntimeInfo.grants` for every runtime on this account, since
     *  scopes are granted per account rather than per runtime. */
    ownScopes(): readonly string[] {
        return [...this.scopes];
    }

    /** Called once when the connection ends, with why — at once if it already has. */
    onClose(listener: (reason: string) => void): () => void {
        if (this.closedWith !== null) { const r = this.closedWith; queueMicrotask(() => listener(r)); return () => {}; }
        this.closeListeners.add(listener);
        return () => this.closeListeners.delete(listener);
    }

    /** Open a stream key granted to this principal. It verifies the grant, so a key from anyone else never opens. */
    openGrant(sender: Bytes, payload: Bytes): Promise<Grant> {
        return this.client.openGrant(sender, payload);
    }

    /**
     * The hub client under this connection, for pairing (`lookupOffer` / `confirmOffer` in pair-flow.ts): the hub refuses
     * a second connection from a principal that is connected, so pairing has to go over this one.
     */
    get hubClient(): HubClient {
        return this.client;
    }

    close(): void {
        this.stopped = true;
        this.client.close();
    }

    /** The one reader. Every consumer is fed from here, because `next()` is a single queue. */
    private async pump(): Promise<void> {
        for (;;) {
            const event = await this.client.next();
            if (this.stopped) return;
            if (event.kind === "closed") {
                // Everything still waiting was waiting on a socket that is gone. Telling each one is what stops a
                // caller holding a promise that can no longer settle.
                for (const settle of [...this.waiting.values()]) settle(fail("unavailable", `the hub closed: ${event.reason}`));
                this.waiting.clear();
                for (const peer of this.peers.values()) peer.online = false;
                this.announce();
                this.closedWith = event.reason;
                for (const l of this.closeListeners) l(event.reason);
                this.closeListeners.clear();
                return;
            }
            await this.handle(event);
        }
    }

    private async handle(event: HubEvent): Promise<void> {
        // A subscription's frames. Dropped before this, which was fine while nothing subscribed and is everything once
        // something does. A frame for a stream nobody here listens to is ignored rather than an error: it can arrive in
        // the moment between an unsubscribe and the hub hearing about it.
        if (event.kind === "published") {
            this.streams.get(streamKey(event.stream.publisher, event.stream.channel))?.({ kind: "published", sender: event.sender, seq: event.seq, epoch: event.epoch, payload: event.payload });
            return;
        }
        if (event.kind === "backfilled" || event.kind === "gap") {
            if (!event.stream) return;
            const listener = this.streams.get(streamKey(event.stream.publisher, event.stream.channel));
            if (event.kind === "backfilled") listener?.({ kind: "backfilled", epoch: event.epoch, seq: event.seq, truncated: event.truncated });
            else listener?.({ kind: "gap", dropped: event.dropped });
            return;
        }
        if (event.kind === "presence") {
            await this.onPresence(event);
            return;
        }
        // The hub refusing a command we sent (its runtime offline or behind): its waiter hears it now, not at the timeout.
        if (event.kind === "error" && event.nonce) {
            this.waiting.get(hex(event.nonce))?.(fail(event.code === HUB_CODE_LIMIT ? "invalid" : "unavailable", `the hub did not deliver it: ${event.message}`));
            return;
        }
        if (event.kind === "result") {
            const answers = event.opened.answers;
            if (!answers) return;
            const settle = this.waiting.get(hex(answers));
            if (!settle) return;   // a result for a command nobody is waiting on: abandoned, or already answered
            settle(parseResult(event.opened.body));
            return;
        }
    }

    /**
     * A principal came online or went away.
     *
     * The chain is VERIFIED here and not trusted: the hub relaying it is a convenience, so a chain that does not
     * verify under the account root this client holds is a presence for a principal this client will not seal to.
     * That is a silence rather than an error — there is nobody to report it to, and a hub that could make a client
     * throw by sending rubbish would have a way to break a page.
     */
    private async onPresence(event: Extract<HubEvent, { kind: "presence" }>): Promise<void> {
        const id = hex(event.principal);
        const held = this.peers.get(id);
        if (!event.online) {
            if (!held) return;
            held.online = false;
            held.lastSeen = this.now();
            for (const [key, peerId] of [...this.waitingOn]) {
                if (peerId === id) this.waiting.get(key)?.(fail("unavailable", `${held.name} went offline before it answered`));
            }
            this.announce();
            return;
        }
        // A principal coming online presents its chain; one that is already known and says nothing new keeps what it
        // had, because a presence with no chain is not a reason to forget a key that still works.
        if (!event.chain.length) {
            if (!held) return;
            held.online = true;
            held.lastSeen = this.now();
            this.announce();
            return;
        }
        try {
            const verified = await verifyChain(this.accountRoot, event.chain, this.now());
            this.peers.set(id, {
                id,
                name: verified.leaf.label || id.slice(0, 8),
                online: true,
                lastSeen: this.now(),
                recipient: { principal: event.principal, agreementKey: verified.leaf.agreementKey as Bytes },
                // From the VERIFIED leaf, not the presence frame's own `role`: the frame is the hub's word, the leaf
                // is the account root's. Same for `mayRevoke`, which decides whether a pairing screen offers that
                // grant to another device, so taking it from anything but the root's signature would be a way to
                // talk a person into minting a second signer.
                role: verified.leaf.role,
                ...(verified.leaf.mayRevoke ? { mayRevoke: true as const } : {}),
                mayPair: !!verified.leaf.mayPair,
            });
            this.announce();
        } catch {
            /* a chain that does not verify under our own account root: not a peer, and not an error to raise */
        }
    }

    private announce(): void {
        const list = [...this.peers.values()];
        for (const l of this.peerListeners) l(list);
    }
}

/** A refusal, at whatever command type the caller is waiting on: the `ok: false` branch names no data, so one
 *  function answers every command and nothing has to be cast at the call site. */
const fail = <T extends CommandType>(code: "not-found" | "invalid" | "unavailable" | "aborted" | "failed" | "forbidden", message: string): CommandResult<T> =>
    ({ ok: false, error: { code, message } });

/**
 * A result's body, which is whatever the runtime sealed. It is UNTRUSTED text: a runtime is not the hub, but it is
 * still another machine, and a malformed answer is a runtime that is broken or lying rather than a reason to throw
 * inside a page's event pump.
 */
function parseResult(body: Bytes): CommandResult<CommandType> {
    let parsed: unknown;
    try { parsed = JSON.parse(decoder.decode(body)); }
    catch { return fail("failed", "the runtime's answer was not readable"); }
    if (!parsed || typeof parsed !== "object") return fail("failed", "the runtime's answer was not a result");
    const r = parsed as { ok?: unknown; data?: unknown; error?: { code?: unknown; message?: unknown } };
    if (r.ok === true) return { ok: true, data: (r.data ?? {}) as never };
    if (r.ok === false && r.error && typeof r.error.code === "string") {
        return { ok: false, error: { code: r.error.code as "failed", message: typeof r.error.message === "string" ? r.error.message : "" } };
    }
    return fail("failed", "the runtime's answer was not a result");
}

/**
 * A client for the hub: the authenticated handshake, subscriptions, publishing, and sealed commands
 * (window-ml-hub `docs/PROTOCOL.md`). The browser twin of that repository's `crates/client`, tested against the
 * same hub binary.
 *
 * Nothing here touches `chrome`: the extension's background worker and the chat page both use it. The socket is
 * `WebSocket`, which a service worker, a page and Node all have.
 *
 * One reader owns the socket: `next()` hands back events in order, answers the hub's pings itself, and opens sealed
 * commands and results on the way through. A hub is trusted with routing and nothing else — `Envelope.sender` is its
 * word, bound into the seal, so a command attributed to anyone else does not open.
 */
import { Certificate } from "../proto/wmlhub/v1/identity.gen";
import { createFrameReader } from "../protostream";
import { AgreementKey, Bytes, bytes } from "./hpke";
import { Identity, accountId, helloTranscript, principalId, sign, LABEL } from "./keys";
import { Grant, Opened, Receiver, Recipient, Sender, sealCommand, sealResult } from "./seal";
import { hubCryptoReason, hubCryptoSupported } from "./support";
import { Envelope, Frame, HubErrorFrame, Kind, Limits, Role, encodeFrames } from "./wire";
import type { Position, StreamRef } from "./wire";

/** The protocol major this client speaks. */
export const PROTOCOL = 1;

/** Everything a principal needs to log in: who it is, what proves it, and which hub it expects. */
export interface HubConfig {
    /** `ws://` or `wss://` */
    url: string;
    /** The name this hub must give in its challenge. A hub that gives another name is refused. */
    hubName: string;
    identity: Identity;
    agreement: AgreementKey;
    /** leaf first, up to the account root */
    chain: Certificate[];
    accountRoot: Bytes;
    role: Role;
    /** an operator invite, on a hub that needs one to register this account */
    invite?: Bytes;
    /** the clock sealed commands are stamped and checked against; for tests */
    now?: () => number;
}

/** What a client reads from the hub. */
export type HubEvent =
    /** a published envelope of a stream this client subscribes to; the payload is still sealed (`seal.ts`) */
    | { kind: "published"; stream: StreamRef; envelopeKind: Kind; sender: Bytes; seq: number; epoch: number; payload: Bytes }
    /** a sealed command, opened and verified */
    | { kind: "command"; opened: Opened }
    /** a sealed result, opened and verified, naming the command it answers */
    | { kind: "result"; opened: Opened }
    /** a direct envelope this client could not open as a command: the bytes, so a caller can try another opener */
    | { kind: "unopened"; sender: Bytes; envelopeKind: Kind; payload: Bytes; reason: string }
    /**
     * A principal came online or went away. `chain` is what it presented, leaf first, and is present only on a
     * principal coming ONLINE — it is empty when one goes away.
     *
     * It is carried because without it a peer knows another is there and has no way to seal anything to it: the
     * leaf's agreement key is what a command is sealed to and what a stream key is wrapped to. Certificates are
     * public, and the hub passing them along is a convenience and not a claim — a consumer verifies the chain
     * against the account root it already holds before trusting anything in it, the label included.
     */
    | { kind: "presence"; principal: Bytes; role: Role; online: boolean; chain: Certificate[] }
    | { kind: "backfilled"; stream: StreamRef | undefined; epoch: number; seq: number; truncated: boolean }
    | { kind: "gap"; stream: StreamRef | undefined; dropped: number }
    /** the hub reporting something about this connection; THROTTLED leaves it open, the rest close it */
    | { kind: "error"; code: number; message: string; ref: number }
    /** the socket closed: nothing more will arrive, and every later `next()` resolves with this again */
    | { kind: "closed"; reason: string }
    /** events dropped because the consumer stopped reading: a full queue is reported, never silent */
    | { kind: "dropped"; count: number };

/** Why connecting failed. `unsupported` is the only one that is about THIS BROWSER rather than about the hub. */
export class ConnectError extends Error {
    constructor(
        readonly reason: "transport" | "protocol" | "wrong-hub" | "refused" | "unsupported",
        message: string,
    ) {
        super(message);
    }
}

const WELCOME_TIMEOUT_MS = 15_000;

/**
 * Events held for a consumer that is not reading. A stream can publish faster than a slow consumer drains, and an
 * unbounded queue turns that into a tab's memory; past this the oldest are dropped and the loss is reported.
 */
export const MAX_QUEUED_EVENTS = 4_096;

/** A connected, authenticated client. */
export class HubClient {
    private readonly queue: HubEvent[] = [];
    private readonly waiting: Array<(event: HubEvent) => void> = [];
    private readonly reader = createFrameReader();
    private closed = false;
    /**
     * The close, kept so every later `next()` resolves with it again. A promise that never settles is how a reconnect
     * loop hangs, and a hang there reads like a service worker eviction for an hour before it reads like this.
     */
    private ended: HubEvent | null = null;
    /** events dropped since the consumer last heard about it */
    private dropped = 0;

    private constructor(
        private readonly socket: WebSocket,
        private readonly config: HubConfig,
        readonly principal: Bytes,
        readonly account: Bytes,
        readonly limits: Limits,
        private readonly receiver: Receiver,
    ) {}

    /** Connect, check the hub's name, answer its challenge, and wait for the welcome. */
    static async connect(config: HubConfig): Promise<HubClient> {
        // Before the socket, because a browser without Ed25519 or X25519 cannot answer the challenge and would
        // otherwise learn that as "the hub refused you" (see docs/dev/hub-client.md).
        const support = await hubCryptoSupported();
        if (!support.ok) throw new ConnectError("unsupported", hubCryptoReason(support));
        const socket = new WebSocket(config.url);
        socket.binaryType = "arraybuffer";
        const reader = createFrameReader();
        const incoming: Frame[] = [];
        let failure: ConnectError | null = null;
        let wake = () => {};
        const bump = () => {
            const it = wake;
            wake = () => {};
            it();
        };

        socket.onmessage = (event) => {
            const data = event.data;
            if (!(data instanceof ArrayBuffer)) return;
            try {
                for (const frame of reader.push(new Uint8Array(data))) incoming.push(Frame.decode(frame));
            } catch (e) {
                failure = new ConnectError("protocol", `the hub sent a malformed frame: ${(e as Error).message}`);
            }
            bump();
        };
        socket.onerror = () => {
            failure ??= new ConnectError("transport", "the socket failed");
            bump();
        };
        socket.onclose = () => {
            failure ??= new ConnectError("transport", "the hub closed the connection");
            bump();
        };

        /** The next frame the hub sends, or the failure that arrived instead. */
        const nextFrame = async (): Promise<Frame> => {
            for (;;) {
                if (incoming.length > 0) return incoming.shift()!;
                if (failure) throw failure;
                await new Promise<void>((resolve) => {
                    const timer = setTimeout(() => {
                        failure ??= new ConnectError("transport", "the hub went quiet during the handshake");
                        resolve();
                    }, WELCOME_TIMEOUT_MS);
                    wake = () => {
                        clearTimeout(timer);
                        resolve();
                    };
                });
            }
        };

        if (socket.readyState !== WebSocket.OPEN) {
            await new Promise<void>((resolve) => {
                socket.onopen = () => resolve();
                const was = wake;
                wake = () => {
                    was();
                    resolve();
                };
            });
        }
        if (failure) throw failure;

        const challenge = (await nextFrame()).challenge;
        if (!challenge) throw new ConnectError("protocol", "the hub's first frame must be a challenge");
        if (challenge.hub !== config.hubName)
            throw new ConnectError("wrong-hub", `this hub calls itself ${challenge.hub}, not ${config.hubName}`);

        const principal = await principalId(config.identity.publicKey);
        const account = await accountId(config.accountRoot);
        const transcript = helloTranscript(config.hubName, bytes(challenge.nonce), principal, config.role, account);
        const hello: Frame = {
            hello: {
                protocol: PROTOCOL,
                principal,
                role: config.role,
                chain: config.chain,
                accountRoot: config.accountRoot,
                signature: await sign(config.identity, LABEL.hello, transcript),
                invite: config.invite ?? new Uint8Array(),
                accountCredential: new Uint8Array(),
            },
        };
        socket.send(encodeFrames([hello]));

        const answer = await nextFrame();
        if (answer.error) throw new ConnectError("refused", `${answer.error.message} (code ${answer.error.code})`);
        if (!answer.welcome) throw new ConnectError("protocol", "the hub must answer a hello with a welcome");

        const receiver = await Receiver.create(config.identity, config.agreement, config.accountRoot);
        const limits = answer.welcome.limits;
        if (!limits) throw new ConnectError("protocol", "the hub's welcome carried no limits");
        const client = new HubClient(socket, config, principal, account, limits, receiver);
        client.adopt(reader, incoming);
        return client;
    }

    /** Take over the socket the handshake used, with anything that arrived while it finished. */
    private adopt(reader: ReturnType<typeof createFrameReader>, pending: Frame[]): void {
        this.socket.onmessage = (event) => {
            const data = event.data;
            if (!(data instanceof ArrayBuffer)) return;
            try {
                for (const frame of reader.push(new Uint8Array(data))) void this.onFrame(frame);
            } catch (e) {
                this.push({ kind: "closed", reason: `malformed frame: ${(e as Error).message}` });
                this.socket.close();
            }
        };
        this.socket.onclose = () => {
            this.closed = true;
            this.push({ kind: "closed", reason: "the hub closed the connection" });
        };
        this.socket.onerror = () => {
            this.closed = true;
            this.push({ kind: "closed", reason: "the socket failed" });
        };
        for (const frame of pending) void this.handle(frame);
    }

    private async onFrame(frame: Uint8Array): Promise<void> {
        await this.handle(Frame.decode(frame));
    }

    private async handle(frame: Frame): Promise<void> {
        if (frame.ping) {
            this.send([{ pong: { nonce: frame.ping.nonce } }]);
            return;
        }
        if (frame.presence) {
            const p = frame.presence;
            this.push({ kind: "presence", principal: bytes(p.principal), role: p.role, online: p.online, chain: p.chain ?? [] });
            return;
        }
        if (frame.backfilled) {
            const b = frame.backfilled;
            this.push({ kind: "backfilled", stream: b.stream, epoch: b.epoch, seq: b.seq, truncated: b.truncated });
            return;
        }
        if (frame.gap) {
            this.push({ kind: "gap", stream: frame.gap.stream, dropped: frame.gap.dropped });
            return;
        }
        if (frame.error) {
            const e: HubErrorFrame = frame.error;
            this.push({ kind: "error", code: e.code, message: e.message, ref: e.ref });
            return;
        }
        if (frame.envelope) await this.onEnvelope(frame.envelope);
        // a pong answers our own ping; welcome and challenge belong to a handshake that is over
    }

    private async onEnvelope(envelope: Envelope): Promise<void> {
        const sender = bytes(envelope.sender);
        const payload = bytes(envelope.payload);
        if (envelope.kind === Kind.KIND_COMMAND || envelope.kind === Kind.KIND_COMMAND_RESULT) {
            try {
                const opened = await this.receiver.open(sender, payload, this.now());
                this.push({ kind: opened.answers ? "result" : "command", opened });
            } catch (e) {
                const reason = (e as { reason?: string }).reason ?? (e as Error).message;
                this.push({ kind: "unopened", sender, envelopeKind: envelope.kind, payload, reason });
            }
            return;
        }
        const stream: StreamRef = { publisher: sender, channel: bytes(envelope.channel ?? new Uint8Array()) };
        this.push({
            kind: "published",
            stream,
            envelopeKind: envelope.kind,
            sender,
            seq: envelope.seq,
            epoch: envelope.epoch,
            payload,
        });
    }

    private push(event: HubEvent): void {
        if (event.kind === "closed") {
            this.ended ??= event;
            // everyone waiting hears it, not just the first
            while (this.waiting.length > 0) this.waiting.shift()!(event);
            return;
        }
        const waiter = this.waiting.shift();
        if (waiter) {
            waiter(event);
            return;
        }
        this.queue.push(event);
        if (this.queue.length > MAX_QUEUED_EVENTS) {
            this.queue.shift();
            this.dropped += 1;
        }
    }

    private now(): number {
        return this.config.now?.() ?? Date.now();
    }

    private send(frames: Frame[]): void {
        if (this.closed) throw new Error("the connection is closed");
        this.socket.send(encodeFrames(frames));
    }

    /**
     * The next event. Pings are answered before this ever sees them, a full queue reports what it dropped, and once
     * the socket has closed every call resolves with that same `closed` event rather than waiting forever.
     */
    next(): Promise<HubEvent> {
        if (this.dropped > 0) {
            const count = this.dropped;
            this.dropped = 0;
            return Promise.resolve({ kind: "dropped", count });
        }
        const queued = this.queue.shift();
        if (queued) return Promise.resolve(queued);
        if (this.ended) return Promise.resolve(this.ended);
        return new Promise((resolve) => this.waiting.push(resolve));
    }

    /** Publish on a channel of this principal's. `coalesce` marks telemetry a newer one may supersede. */
    publish(channel: Bytes, kind: Kind, payload: Bytes, coalesce: Bytes = new Uint8Array()): void {
        this.send([{ envelope: { channel, kind, payload, coalesce, sender: new Uint8Array(), seq: 0, epoch: 0, ref: 0 } }]);
    }

    /** Ask for a stream, from `since` if this client already holds part of it. */
    subscribe(publisher: Bytes, channel: Bytes, since?: Position): void {
        this.send([{ subscribe: { stream: { publisher, channel }, since } }]);
    }

    /** Stop receiving a stream. */
    unsubscribe(publisher: Bytes, channel: Bytes): void {
        this.send([{ unsubscribe: { stream: { publisher, channel } } }]);
    }

    /** Seal a command to `to` and send it. Resolves with the nonce its result will answer. */
    async command(to: Recipient, scope: string, body: Bytes): Promise<Bytes> {
        const { sealed, nonce } = await sealCommand(this.sender(), to, scope, body, this.now());
        this.direct(to.principal, Kind.KIND_COMMAND, sealed);
        return nonce;
    }

    /** Seal the result of a command back to whoever sent it. */
    async result(to: Recipient, answers: Bytes, body: Bytes): Promise<void> {
        const sealed = await sealResult(this.sender(), to, answers, body, this.now());
        this.direct(to.principal, Kind.KIND_COMMAND_RESULT, sealed);
    }

    /** Send already-sealed bytes to a principal, for kinds this client does not build itself (`BULK`, a grant). */
    direct(to: Bytes, kind: Kind, payload: Bytes): void {
        this.send([{ envelope: { principal: to, kind, payload, sender: new Uint8Array(), seq: 0, epoch: 0, ref: 0, coalesce: new Uint8Array() } }]);
    }

    /** Open a stream key granted to this principal, wherever it arrived (a key channel, or direct). */
    openGrant(sender: Bytes, payload: Bytes): Promise<Grant> {
        return this.receiver.openGrant(sender, payload, this.now());
    }

    /** Who this client signs as. */
    sender(): Sender {
        return { identity: this.config.identity, chain: this.config.chain };
    }

    close(): void {
        this.closed = true;
        this.socket.close();
    }
}

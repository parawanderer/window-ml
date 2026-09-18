/**
 * Sealed commands and results, wrapped stream keys, published frames and keyed channel names: the browser side of
 * window-ml-hub's `crates/seal`, checked against the same vectors (`tests/hub-seal.test.mjs`).
 *
 * What the hub could do to any of this — drop it, delay it, replay it, deliver it to the wrong principal, claim
 * another sender, move a frame to another channel, renumber it — each ends in a refusal here. The order of the checks
 * is the Rust side's: sizes, decryption, the chain, the sender, the signature, the addressing, the clock, the scope,
 * and last the nonce, so only an authenticated command inside its window takes a place in the replay window.
 */
import { CommandBody, GrantBody, Sealed as SealedMessage, SignedCommand, SignedGrant, StreamFrame } from "../proto/wmlhub/v1/seal.gen";
import { Certificate } from "../proto/wmlhub/v1/identity.gen";
import { AgreementKey, Bytes, bytes, concat, open as hpkeOpen, sameBytes, seal as hpkeSeal } from "./hpke";
import { Identity, LABEL, principalId, sign, verify, verifyChain, Verified } from "./keys";

export const NONCE_BYTES = 16;
export const CLOCK_WINDOW_MS = 60_000;
export const MAX_SEALED_BYTES = 1 << 20;
export const MAX_STREAM_FRAME_BYTES = 1 << 20;
export const MAX_REPLAY_ENTRIES = 65_536;
/**
 * Nonces one recipient remembers from ONE sender. The window is shared by every device of an account, so without a
 * per-sender share a single noisy or hostile device could fill it and refuse every other device for two windows.
 */
export const MAX_REPLAY_PER_SENDER = 4_096;
const KEY_ID_BYTES = 8;
/** The longest channel name a grant may carry, matching the relay's `max_id_bytes`. */
export const MAX_CHANNEL_BYTES = 64;
const FRAME_NONCE_BYTES = 12;
export const CHANNEL_BYTES = 16;

const SEAL_INFO = "wmlhub/seal/v1\0";
const GRANT_INFO = "wmlhub/keygrant/v1\0";
const KEY_ID_LABEL = "wmlhub/streamkey-id/v1\0";
const CHANNEL_LABEL = "wmlhub/channel/v1\0";

/** Why something did not open. The reason is for logs and tests; what a runtime tells a sender is its own business. */
export class OpenError extends Error {
    constructor(readonly reason: string) {
        super(reason);
    }
}

/** Why a published frame was refused. */
export class StreamError extends Error {
    constructor(readonly reason: string) {
        super(reason);
    }
}

/** Who is sending: the leaf identity that signs, and the chain that proves it belongs to the account. */
export interface Sender {
    identity: Identity;
    /** leaf first, up to the account root */
    chain: Certificate[];
}

/** Where a command goes: the recipient's principal id and the agreement key its certificate binds. */
export interface Recipient {
    principal: Bytes;
    agreementKey: Bytes;
}

/** An opened, verified command or result. */
export interface Opened {
    from: Bytes;
    /** empty on a result */
    scope: string;
    nonce: Bytes;
    timeMs: number;
    body: Bytes;
    /** the nonce of the command this answers; null on a command */
    answers: Bytes | null;
    verified: Verified;
}

const text = new TextEncoder();

function info(label: string, from: Bytes, to: Bytes): Bytes {
    return concat(text.encode(label), from, to);
}

function randomBytes(n: number): Bytes {
    return crypto.getRandomValues(new Uint8Array(n));
}

async function sealBody(
    label: string,
    sender: Sender,
    to: Recipient,
    signLabel: string,
    body: Bytes,
    wrap: (body: Bytes, signature: Bytes, chain: Certificate[]) => Uint8Array,
): Promise<Bytes> {
    const from = await principalId(sender.identity.publicKey);
    const signature = await sign(sender.identity, signLabel, body);
    const signed = wrap(body, signature, sender.chain);
    const sealed = await hpkeSeal(to.agreementKey, info(label, from, to.principal), bytes(signed));
    return SealedMessage.encode({ enc: sealed.enc, ciphertext: sealed.ciphertext }).finish();
}

/** Seal a command needing `scope`. Returns the sealed bytes and the nonce its result will answer. */
export async function sealCommand(
    sender: Sender,
    to: Recipient,
    scope: string,
    body: Bytes,
    nowMs: number,
): Promise<{ sealed: Bytes; nonce: Bytes }> {
    const nonce = randomBytes(NONCE_BYTES);
    const sealed = await sealCommandBody(sender, to, scope, body, nonce, new Uint8Array(), nowMs);
    return { sealed, nonce };
}

/** Seal the result of the command whose nonce is `answers`. */
export async function sealResult(
    sender: Sender,
    to: Recipient,
    answers: Bytes,
    body: Bytes,
    nowMs: number,
): Promise<Bytes> {
    return sealCommandBody(sender, to, "", body, randomBytes(NONCE_BYTES), answers, nowMs);
}

async function sealCommandBody(
    sender: Sender,
    to: Recipient,
    scope: string,
    body: Bytes,
    nonce: Bytes,
    answers: Bytes,
    nowMs: number,
): Promise<Bytes> {
    const from = await principalId(sender.identity.publicKey);
    const encoded = CommandBody.encode({
        from,
        to: to.principal,
        scope,
        nonce,
        timeMs: nowMs,
        body,
        answers,
    }).finish();
    return sealBody(SEAL_INFO, sender, to, LABEL.command, encoded, (b, signature, chain) =>
        SignedCommand.encode({ body: b, signature, chain }).finish(),
    );
}

/**
 * Where to send the answer to an opened command: the sender, and the agreement key its own certificate bound. Saves a
 * consumer reassembling this by hand, which is how a reply ends up sealed to the wrong key.
 */
export function replyTo(opened: Opened): Recipient {
    return { principal: opened.from, agreementKey: bytes(opened.verified.leaf.agreementKey) };
}

/** A principal receiving commands: its keys, the account it belongs to, and the nonces it has accepted. */
export class Receiver {
    private readonly replay = new ReplayWindow();

    constructor(
        readonly principal: Bytes,
        private readonly agreement: AgreementKey,
        private readonly accountRoot: Bytes,
    ) {}

    static async create(identity: Identity, agreement: AgreementKey, accountRoot: Bytes): Promise<Receiver> {
        return new Receiver(await principalId(identity.publicKey), agreement, accountRoot);
    }

    /** Open what was sealed to this principal under `label` by `sender`, the sender being the hub's stamp. */
    async unseal(label: string, sender: Bytes, sealed: Bytes): Promise<Bytes> {
        if (sealed.length > MAX_SEALED_BYTES) throw new OpenError("too large");
        let message;
        try {
            message = SealedMessage.decode(sealed);
        } catch {
            throw new OpenError("malformed");
        }
        if (message.enc.length !== 32) throw new OpenError("malformed");
        try {
            return await hpkeOpen(
                this.agreement,
                { enc: bytes(message.enc), ciphertext: bytes(message.ciphertext) },
                info(label, sender, this.principal),
            );
        } catch {
            throw new OpenError("decrypt");
        }
    }

    /** The chain reaches this account's root and its leaf is the principal the hub says sent this. */
    async checkChain(sender: Bytes, chain: Certificate[], nowMs: number): Promise<Verified> {
        let verified;
        try {
            verified = await verifyChain(this.accountRoot, chain, nowMs);
        } catch (e) {
            throw new OpenError(`chain: ${(e as Error).message}`);
        }
        if (!sameBytes(verified.principal, sender)) throw new OpenError("not the sender");
        return verified;
    }

    /** From that sender, to me, inside the clock window, and not seen before. */
    checkAddressing(
        sender: Bytes,
        from: Bytes,
        to: Bytes,
        nonce: Bytes,
        timeMs: number,
        nowMs: number,
    ): void {
        if (!sameBytes(from, sender)) throw new OpenError("not the sender");
        if (!sameBytes(to, this.principal)) throw new OpenError("not for me");
        if (nonce.length !== NONCE_BYTES) throw new OpenError("malformed");
        if (Math.abs(timeMs - nowMs) > CLOCK_WINDOW_MS) throw new OpenError("clock");
        this.replay.admit(sender, nonce, nowMs);
    }

    /** Open a sealed command or result the hub delivered from `sender`. Accepted at most once. */
    async open(sender: Bytes, sealed: Bytes, nowMs: number): Promise<Opened> {
        if (sender.length !== 32) throw new OpenError("not the sender");
        const plaintext = await this.unseal(SEAL_INFO, sender, sealed);
        let signed;
        try {
            signed = SignedCommand.decode(plaintext);
        } catch {
            throw new OpenError("malformed");
        }
        const verified = await this.checkChain(sender, signed.chain, nowMs);
        if (!(await verify(verified.leafKey, LABEL.command, bytes(signed.body), bytes(signed.signature))))
            throw new OpenError("signature");

        let body;
        try {
            body = CommandBody.decode(signed.body);
        } catch {
            throw new OpenError("malformed");
        }
        const isResult = body.answers.length > 0;
        const hasScope = body.scope.length > 0;
        if (isResult === hasScope) throw new OpenError("malformed");
        if (!isResult && !verified.leaf.scopes.includes(body.scope)) throw new OpenError("scope");
        if (isResult && body.answers.length !== NONCE_BYTES) throw new OpenError("malformed");
        this.checkAddressing(sender, bytes(body.from), bytes(body.to), bytes(body.nonce), body.timeMs, nowMs);
        return {
            from: sender,
            scope: body.scope,
            nonce: bytes(body.nonce),
            timeMs: body.timeMs,
            body: bytes(body.body),
            answers: isResult ? bytes(body.answers) : null,
            verified,
        };
    }

    /** Open a stream key granted to this principal, wherever it arrived. */
    async openGrant(sender: Bytes, sealed: Bytes, nowMs: number): Promise<Grant> {
        if (sender.length !== 32) throw new OpenError("not the sender");
        const plaintext = await this.unseal(GRANT_INFO, sender, sealed);
        let signed;
        try {
            signed = SignedGrant.decode(plaintext);
        } catch {
            throw new OpenError("malformed");
        }
        const verified = await this.checkChain(sender, signed.chain, nowMs);
        if (!(await verify(verified.leafKey, LABEL.grant, bytes(signed.body), bytes(signed.signature))))
            throw new OpenError("signature");
        let body;
        try {
            body = GrantBody.decode(signed.body);
        } catch {
            throw new OpenError("malformed");
        }
        if (body.key.length !== 32 || body.keyId.length !== KEY_ID_BYTES) throw new OpenError("malformed");
        if (body.channel.length === 0 || body.channel.length > MAX_CHANNEL_BYTES) throw new OpenError("malformed");
        const key = await StreamKey.fromBytes(bytes(body.key));
        if (!sameBytes(key.id, bytes(body.keyId))) throw new OpenError("malformed");
        this.checkAddressing(sender, bytes(body.from), bytes(body.to), bytes(body.nonce), body.timeMs, nowMs);
        return {
            publisher: sender,
            publisherKey: verified.leafKey,
            channel: bytes(body.channel),
            key,
            fromCounter: body.fromCounter,
        };
    }
}

/**
 * The nonces accepted recently, per sender. Exported so its budget can be tested without sealing thousands of
 * commands; nothing outside this file constructs one. A nonce is kept until its command could no longer pass the clock check,
 * and the window refuses when it is full rather than forgetting a live one.
 */
export class ReplayWindow {
    private readonly seen = new Set<string>();
    private readonly held = new Map<string, number>();
    private readonly order: Array<{ forgetAt: number; key: string; from: string }> = [];

    constructor(
        private readonly capacity = MAX_REPLAY_ENTRIES,
        private readonly perSender = MAX_REPLAY_PER_SENDER,
    ) {}

    admit(from: Bytes, nonce: Bytes, nowMs: number): void {
        while (this.order.length > 0 && this.order[0].forgetAt <= nowMs) {
            const gone = this.order.shift()!;
            if (this.seen.delete(gone.key)) this.release(gone.from);
        }
        const sender = hex(from);
        const key = `${sender}:${hex(nonce)}`;
        if (this.seen.has(key)) throw new OpenError("replay");
        // This sender's own share first: a sender that has filled it is refused while everyone else is served.
        if ((this.held.get(sender) ?? 0) >= this.perSender || this.seen.size >= this.capacity)
            throw new OpenError("busy");
        this.seen.add(key);
        this.held.set(sender, (this.held.get(sender) ?? 0) + 1);
        this.order.push({ forgetAt: nowMs + 2 * CLOCK_WINDOW_MS + 1, key, from: sender });
    }

    /** A sender is forgotten when its last nonce is, so the map is bounded by senders with live nonces. */
    private release(sender: string): void {
        const held = (this.held.get(sender) ?? 0) - 1;
        if (held > 0) this.held.set(sender, held);
        else this.held.delete(sender);
    }
}

const hex = (b: Bytes) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** A stream's symmetric key. The publisher chooses it, rotates it, and wraps it to every device allowed to read. */
export class StreamKey {
    private constructor(
        readonly bytes: Bytes,
        readonly id: Bytes,
        readonly aes: CryptoKey,
    ) {}

    static async generate(): Promise<StreamKey> {
        return StreamKey.fromBytes(randomBytes(32));
    }

    /** The id is derived from the key, so a publisher and a subscriber agree on it with no extra state. */
    static async fromBytes(bytes: Bytes): Promise<StreamKey> {
        if (bytes.length !== 32) throw new StreamError("a stream key is 32 bytes");
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", concat(text.encode(KEY_ID_LABEL), bytes)));
        const aes = await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
        return new StreamKey(bytes, digest.slice(0, KEY_ID_BYTES), aes);
    }
}

/** A stream key handed to one device, opened and verified. */
export interface Grant {
    publisher: Bytes;
    /** the publisher's identity key: what its frames are verified with */
    publisherKey: Bytes;
    channel: Bytes;
    key: StreamKey;
    fromCounter: number;
}

/** Wrap a stream key for one device. The publisher signs and seals it. */
export async function wrapKey(
    publisher: Sender,
    to: Recipient,
    channel: Bytes,
    key: StreamKey,
    fromCounter: number,
    nowMs: number,
): Promise<Bytes> {
    const from = await principalId(publisher.identity.publicKey);
    const body = GrantBody.encode({
        from,
        to: to.principal,
        nonce: randomBytes(NONCE_BYTES),
        timeMs: nowMs,
        channel,
        keyId: key.id,
        key: key.bytes,
        fromCounter,
    }).finish();
    return sealBody(GRANT_INFO, publisher, to, LABEL.grant, body, (b, signature, chain) =>
        SignedGrant.encode({ body: b, signature, chain }).finish(),
    );
}

/** What the publisher signs and the AEAD binds: the frame's place in the world. */
function header(
    publisher: Bytes,
    channel: Bytes,
    keyId: Bytes,
    counter: number,
    nonce: Bytes,
): Bytes {
    const length = new Uint8Array([(channel.length >> 8) & 0xff, channel.length & 0xff]);
    return concat(publisher, length, channel, keyId, u64be(counter), nonce);
}

function u64be(n: number): Bytes {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, BigInt(n));
    return out;
}

/** Encrypt and sign one batch for `channel`. `counter` is the publisher's own count for it, from 1. */
export async function sealFrame(
    publisher: Sender,
    channel: Bytes,
    key: StreamKey,
    counter: number,
    batch: Bytes,
): Promise<Bytes> {
    const me = await principalId(publisher.identity.publicKey);
    const nonce = randomBytes(FRAME_NONCE_BYTES);
    const aad = header(me, channel, key.id, counter, nonce);
    const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, key.aes, batch),
    );
    const signature = await sign(publisher.identity, LABEL.stream, concat(aad, ciphertext));
    return StreamFrame.encode({ keyId: key.id, counter, nonce, ciphertext, signature }).finish();
}

/** One batch, opened. */
export interface Published {
    counter: number;
    /** counters between the last frame and this one that never arrived */
    skipped: number;
    batch: Bytes;
}

/** One subscriber's view of one stream: whose it is, which channel, the keys granted, and how far it has read. */
export class StreamReader {
    /** each granted key, with the first counter that grant covers */
    private readonly keys = new Map<string, { key: StreamKey; fromCounter: number }>();
    private last = 0;

    constructor(grant: Grant) {
        this.publisher = grant.publisher;
        this.publisherKey = grant.publisherKey;
        this.channel = grant.channel;
        this.addKey(grant);
    }

    readonly publisher: Bytes;
    readonly publisherKey: Bytes;
    readonly channel: Bytes;

    /** Take another key for this stream: a rotation, or the previous key for reading further back in the ring. */
    addKey(grant: Grant): boolean {
        if (!sameBytes(grant.publisher, this.publisher) || !sameBytes(grant.channel, this.channel)) return false;
        this.keys.set(hex(grant.key.id), { key: grant.key, fromCounter: grant.fromCounter });
        return true;
    }

    /** Where this reader has read to. */
    counter(): number {
        return this.last;
    }

    /**
     * Start again from `counter`, after a backfill that begins further back than this reader has read.
     *
     * The number must come from what THIS consumer has processed, never from a hub frame: a hub that named the rewind
     * point could replay a stream at a subscriber, which is the one thing the counter exists to prevent.
     */
    rewindTo(counter: number): void {
        this.last = counter;
    }

    /** Verify and decrypt one published frame. */
    async open(frame: Bytes): Promise<Published> {
        if (frame.length > MAX_STREAM_FRAME_BYTES) throw new StreamError("too large");
        let decoded;
        try {
            decoded = StreamFrame.decode(frame);
        } catch {
            throw new StreamError("malformed");
        }
        if (decoded.keyId.length !== KEY_ID_BYTES || decoded.nonce.length !== FRAME_NONCE_BYTES)
            throw new StreamError("malformed");
        const [keyId, frameNonce, ciphertext] = [bytes(decoded.keyId), bytes(decoded.nonce), bytes(decoded.ciphertext)];
        const granted = this.keys.get(hex(keyId));
        if (!granted) throw new StreamError("unknown key");

        const aad = header(this.publisher, this.channel, keyId, decoded.counter, frameNonce);
        if (!(await verify(this.publisherKey, LABEL.stream, concat(aad, ciphertext), bytes(decoded.signature))))
            throw new StreamError("signature");
        // Authentic, and under a key this reader holds; but a grant covers a stream from a counter, and the ring
        // still holds what came before it.
        if (decoded.counter < granted.fromCounter)
            throw new StreamError(`before grant: ${decoded.counter} under a key granted from ${granted.fromCounter}`);
        if (decoded.counter <= this.last) throw new StreamError(`out of order: ${decoded.counter} after ${this.last}`);

        let batch: Bytes;
        try {
            batch = new Uint8Array(
                await crypto.subtle.decrypt(
                    { name: "AES-GCM", iv: frameNonce, additionalData: aad },
                    granted.key.aes,
                    ciphertext,
                ),
            );
        } catch {
            throw new StreamError("decrypt");
        }
        const skipped = decoded.counter - this.last - 1;
        this.last = decoded.counter;
        return { counter: decoded.counter, skipped, batch };
    }
}

/** An account-wide key for naming channels. Kept with the account's other secrets and never sent to the hub. */
export class ChannelKey {
    private constructor(private readonly key: CryptoKey) {}

    static async fromBytes(bytes: Bytes): Promise<ChannelKey> {
        return new ChannelKey(
            await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
        );
    }

    static async generate(): Promise<ChannelKey> {
        return ChannelKey.fromBytes(randomBytes(32));
    }

    /**
     * The channel a stream of `what` (a session hash, a box id) travels on. The hub routes by this and learns nothing
     * from it: which session a channel belongs to, or that two accounts watch the same box.
     */
    async channel(purpose: string, what: Bytes): Promise<Bytes> {
        const message = concat(text.encode(CHANNEL_LABEL), text.encode(purpose), new Uint8Array([0]), what);
        const tag = new Uint8Array(await crypto.subtle.sign("HMAC", this.key, message));
        return tag.slice(0, CHANNEL_BYTES);
    }
}

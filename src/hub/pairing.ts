/**
 * Pairing a principal with an account (window-ml-hub `docs/design/pairing.md`, option C): the code a person carries,
 * the fingerprint they compare on two screens, the offer a principal with no certificate leaves with the hub, and the
 * sealed answer a device that may pair leaves back. The browser twin of that repository's `crates/keys/src/pairing.rs`
 * and `crates/seal/src/pairing.rs`, and of the offering half of `crates/client`.
 *
 * The whole of pairing's security is the person comparing ONE fingerprint on both screens. A hub cannot mint a
 * certificate (it never sees a signing key) but it can swap the keys in the slot it holds, and then it is the hub
 * that is paired. Everything here keeps that comparison honest: the fingerprint covers exactly the offered keys, the
 * answer is sealed to the key the offer carried, and an answer is refused unless it names this principal's own keys.
 *
 * Nothing here touches `chrome`: the extension's worker, the chat page and a phone all pair through it.
 */
import { Certificate, PairedWith, PairingAnswer, PairingOffer } from "../proto/wmlhub/v1/identity.gen";
import { Sealed as SealedMessage } from "../proto/wmlhub/v1/seal.gen";
import { createFrameReader } from "../protostream";
import { AgreementKey, Bytes, bytes, concat, open, seal } from "./hpke";
import { MAX_CHAIN, MAX_LABEL_BYTES, principalId, verifyChain } from "./keys";
import type { Verified } from "./keys";
import { Frame, Role, encodeFrames } from "./wire";

/** Characters in a pairing code: 40 bits, not worth grinding inside a slot's ten minutes against a rate-limiting hub. */
export const PAIRING_CODE_CHARS = 8;
/** Characters of the hex fingerprint, 48 bits: what a person will actually compare character by character. */
export const FINGERPRINT_CHARS = 12;
/** How long the hub holds an offer. Waiting longer is waiting for a slot that no longer exists. */
export const PAIRING_WINDOW_MS = 10 * 60_000;

/** Crockford's base32: no I, L, O or U, so nothing reads as something else aloud or off a screen. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LABEL = "wmlhub/pairing-code/v1\0";
const FINGERPRINT_LABEL = "wmlhub/pairing/v1\0";
const ANSWER_INFO = "wmlhub/pairing-answer/v1\0";
const KEY_BYTES = 32;
/** What the hub's first answer to an offer may take before this gives up: the offer is refused or held quickly. */
const OFFER_TIMEOUT_MS = 15_000;

const text = new TextEncoder();
const sha256 = async (data: Bytes): Promise<Bytes> => new Uint8Array(await crypto.subtle.digest("SHA-256", data));

/** Why a pairing did not complete, precise enough to tell the person what to do next. */
export class PairingError extends Error {
    constructor(
        readonly reason:
            /** the hub refused the offer (a code already in use, too many open slots) or the socket failed */
            | "hub"
            /** nobody answered inside the window */
            | "timed-out"
            /** what came back is not an answer, or does not open with the key the offer carried */
            | "malformed"
            /** the chain does not verify to the account root that came with it */
            | "chain"
            /** the certificate names another principal: this was not what got paired */
            | "not-mine"
            /** the certificate names another agreement key, so nothing sealed to this principal would open */
            | "not-my-agreement-key"
            /** the certificate was issued for another role */
            | "wrong-role"
            /** an offer that is not one: wrong key sizes, a label too long, an unknown role */
            | "bad-offer"
            /** no offer waits under the code typed: mistyped, already answered, or its window closed */
            | "no-offer",
        message: string,
    ) {
        super(message);
    }
}

/** A fresh pairing code from the platform's random source. 256 is a multiple of 32, so `b % 32` is unbiased. */
export function generatePairingCode(): string {
    const random = crypto.getRandomValues(new Uint8Array(PAIRING_CODE_CHARS));
    return [...random].map((b) => ALPHABET[b % 32]).join("");
}

/**
 * A code read back however a person typed it: lower case, spaces or hyphens between groups, and the confusions the
 * alphabet exists for (O as 0, I and L as 1). Null when it is not a code, so a typo is caught before the hub is asked.
 */
export function parsePairingCode(typed: string): string | null {
    const code = [...typed]
        .filter((c) => !/\s/.test(c) && c !== "-")
        .map((c) => {
            const u = c.toUpperCase();
            return u === "I" || u === "L" ? "1" : u === "O" ? "0" : u;
        })
        .join("");
    return code.length === PAIRING_CODE_CHARS && [...code].every((c) => ALPHABET.includes(c)) ? code : null;
}

/** What the hub is told instead of the code, so slots it leaks are of no use to anyone. */
export function pairingCodeHash(code: string): Promise<Bytes> {
    return sha256(concat(text.encode(CODE_LABEL), text.encode(code)));
}

/** The digest a person compares on both screens: the offered keys and nothing else. Rendering is the UI's. */
export function pairingFingerprint(identityKey: Bytes, agreementKey: Bytes): Promise<Bytes> {
    return sha256(concat(text.encode(FINGERPRINT_LABEL), identityKey, agreementKey));
}

/** The fingerprint as twelve hex characters, identical to what `wmlbox pair` prints for the same keys. */
export async function pairingFingerprintHex(identityKey: Bytes, agreementKey: Bytes): Promise<string> {
    const digest = await pairingFingerprint(identityKey, agreementKey);
    return [...digest.slice(0, FINGERPRINT_CHARS / 2)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What a principal with no certificate offers: its public keys, the role it asks for, and what to call it. */
export interface Offer {
    identityKey: Bytes;
    agreementKey: Bytes;
    role: Role;
    label: string;
    offeredAtMs: number;
}

const ROLES = new Set([Role.ROLE_RUNTIME, Role.ROLE_CLIENT, Role.ROLE_BOX_CONNECTOR]);

function checkOffer(o: Offer): void {
    if (o.identityKey.length !== KEY_BYTES || o.agreementKey.length !== KEY_BYTES)
        throw new PairingError("bad-offer", "an offer's keys are 32 bytes each");
    if (text.encode(o.label).length > MAX_LABEL_BYTES)
        throw new PairingError("bad-offer", `a label is at most ${MAX_LABEL_BYTES} bytes`);
    if (!ROLES.has(o.role)) throw new PairingError("bad-offer", "an offer names a role this client does not know");
}

/** The offer as the hub holds it (and never reads). */
export function encodeOffer(o: Offer): Bytes {
    checkOffer(o);
    return bytes(
        PairingOffer.encode({
            identityKey: o.identityKey,
            agreementKey: o.agreementKey,
            role: o.role,
            label: o.label,
            offeredAtMs: o.offeredAtMs,
        }).finish(),
    );
}

/**
 * An offer fetched from the hub, checked for shape. Its label is the offering principal's word and untrusted text;
 * its keys are what the fingerprint is computed from, and only the person's comparison vouches for them.
 */
export function decodeOffer(encoded: Bytes): Offer {
    let o: PairingOffer;
    try { o = PairingOffer.decode(encoded); } catch { throw new PairingError("malformed", "the hub's slot does not hold an offer"); }
    const offer: Offer = {
        identityKey: bytes(o.identityKey),
        agreementKey: bytes(o.agreementKey),
        role: o.role,
        label: o.label,
        offeredAtMs: o.offeredAtMs,
    };
    checkOffer(offer);
    return offer;
}

/** What a newly paired principal is given: its chain (leaf first), the account root, and the account's channel key. */
export interface Paired {
    chain: Certificate[];
    accountRoot: Bytes;
    channelKey: Bytes;
}

/**
 * The answer a device that may pair leaves in the slot: `Paired`, sealed to the agreement key the offer carried. Sealed
 * because it hands over the channel key, which names every stream the account has.
 */
export async function sealPairingAnswer(offeredAgreementKey: Bytes, paired: Paired): Promise<Bytes> {
    if (paired.accountRoot.length !== KEY_BYTES || paired.channelKey.length !== KEY_BYTES)
        throw new PairingError("malformed", "an account root and a channel key are 32 bytes each");
    if (!paired.chain.length || paired.chain.length > MAX_CHAIN)
        throw new PairingError("malformed", `a chain is one or ${MAX_CHAIN} certificates`);
    const plaintext = bytes(PairedWith.encode({ chain: paired.chain, accountRoot: paired.accountRoot, channelKey: paired.channelKey }).finish());
    const sealed = await seal(offeredAgreementKey, text.encode(ANSWER_INFO), plaintext);
    const encoded = bytes(SealedMessage.encode({ enc: sealed.enc, ciphertext: sealed.ciphertext }).finish());
    return bytes(PairingAnswer.encode({ sealed: encoded }).finish());
}

/**
 * Open an answer with the keys the offer was made with, and refuse anything this principal could not then log in with:
 * a chain that does not verify to the root inside, a certificate for somebody else's keys, or for another role. The
 * last three are not what protects the account (a hub that swapped the keys would simply keep the certificate), but
 * they turn a quiet failure at login into a loud one here.
 */
export async function openPairingAnswer(
    mine: { identityKey: Bytes; agreement: AgreementKey; role: Role },
    answer: Bytes,
    nowMs: number,
): Promise<Paired & { verified: Verified }> {
    let paired: PairedWith;
    try {
        const outer = PairingAnswer.decode(answer);
        const s = SealedMessage.decode(outer.sealed);
        const plaintext = await open(mine.agreement, { enc: bytes(s.enc), ciphertext: bytes(s.ciphertext) }, text.encode(ANSWER_INFO));
        paired = PairedWith.decode(plaintext);
    } catch {
        throw new PairingError("malformed", "the answer does not open with the key this offer carried");
    }
    if (paired.accountRoot.length !== KEY_BYTES || paired.channelKey.length !== KEY_BYTES || !paired.chain.length || paired.chain.length > MAX_CHAIN)
        throw new PairingError("malformed", "the answer is not the shape of one");
    const accountRoot = bytes(paired.accountRoot);
    let verified: Verified;
    try { verified = await verifyChain(accountRoot, paired.chain, nowMs); } catch (e) {
        throw new PairingError("chain", `the certificate does not verify to its account: ${(e as Error).message}`);
    }
    const me = await principalId(mine.identityKey);
    if (!verified.principal.every((b, i) => b === me[i])) throw new PairingError("not-mine", "the certificate is for another principal");
    const leafAgreement = verified.leaf.agreementKey;
    const myAgreement = mine.agreement.publicKey;
    if (leafAgreement.length !== myAgreement.length || !leafAgreement.every((b, i) => b === myAgreement[i]))
        throw new PairingError("not-my-agreement-key", "the certificate names another agreement key");
    if (verified.leaf.role !== mine.role) throw new PairingError("wrong-role", "the certificate is for another role");
    return { chain: paired.chain, accountRoot, channelKey: bytes(paired.channelKey), verified };
}

/** An offer the hub is holding: wait for the answer somebody leaves in it, or give up. */
export interface PairingSlot {
    /**
     * The name the hub gave in its challenge, which a later `Hello` must name back. Taken on the hub's word, and that
     * is enough: the name only stops a hello signed for one hub being replayed at another, and a hub lying about its
     * own name refuses the hellos it provoked.
     */
    hubName: string;
    /** The answer, as left in the slot (open it with `openPairingAnswer`). Rejects on timeout, a refusal or a close. */
    answer(timeoutMs?: number): Promise<Bytes>;
    close(): void;
}

/**
 * Leave an offer with the hub under `codeHash`, on a socket that does nothing else: it never authenticates and never
 * joins the relay. Resolves once the hub has taken the offer, which is before anybody is told to carry the code
 * anywhere, so an unreachable hub or a code already in use is an error while the person is still looking at this
 * screen.
 */
export async function offerPairing(url: string, codeHash: Bytes, offer: Bytes): Promise<PairingSlot> {
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    const reader = createFrameReader();
    const incoming: Frame[] = [];
    let failure: PairingError | null = null;
    let wake = () => {};
    const bump = () => { const it = wake; wake = () => {}; it(); };
    socket.onmessage = (event) => {
        if (!(event.data instanceof ArrayBuffer)) return;
        try { for (const frame of reader.push(new Uint8Array(event.data))) incoming.push(Frame.decode(frame)); }
        catch (e) { failure ??= new PairingError("hub", `the hub sent a malformed frame: ${(e as Error).message}`); }
        bump();
    };
    socket.onerror = () => { failure ??= new PairingError("hub", "the socket failed"); bump(); };
    socket.onclose = () => { failure ??= new PairingError("hub", "the hub closed the connection"); bump(); };

    const nextFrame = async (timeoutMs: number, onTimeout: () => PairingError): Promise<Frame> => {
        const until = Date.now() + timeoutMs;
        for (;;) {
            if (incoming.length) return incoming.shift()!;
            if (failure) throw failure;
            const left = until - Date.now();
            if (left <= 0) throw onTimeout();
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, left);
                wake = () => { clearTimeout(timer); resolve(); };
            });
        }
    };
    const quiet = () => new PairingError("hub", "the hub did not answer the offer");
    let first: Frame = {} as Frame;

    try {
        if (socket.readyState !== WebSocket.OPEN) {
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(quiet()), OFFER_TIMEOUT_MS);
                socket.onopen = () => { clearTimeout(timer); resolve(); };
                wake = () => { clearTimeout(timer); if (failure) reject(failure); };
            });
        }
        // The hub's challenge comes first even here, and a pairing socket has nothing to answer it with.
        first = await nextFrame(OFFER_TIMEOUT_MS, quiet);
        if (first.error) throw new PairingError("hub", `${first.error.message} (code ${first.error.code})`);
        if (!first.challenge) throw new PairingError("hub", "the hub's first frame must be a challenge");
        socket.send(encodeFrames([{ pairOffer: { codeHash, offer } }]));
        const held = await nextFrame(OFFER_TIMEOUT_MS, quiet);
        if (held.error) throw new PairingError("hub", `the hub refused the offer: ${held.error.message} (code ${held.error.code})`);
        if (!held.paired) throw new PairingError("hub", "the hub must answer an offer");
    } catch (e) {
        socket.close();
        throw e;
    }

    const hubName = first.challenge!.hub;
    return {
        hubName,
        async answer(timeoutMs = PAIRING_WINDOW_MS) {
            // One deadline for the whole wait: the hub's empty "still holding" frames do not restart it.
            const until = Date.now() + timeoutMs;
            try {
                for (;;) {
                    const frame = await nextFrame(until - Date.now(), () => new PairingError("timed-out", "nobody answered this offer in time"));
                    if (frame.error) throw new PairingError("hub", `${frame.error.message} (code ${frame.error.code})`);
                    if (frame.paired && frame.paired.answer.length) return bytes(frame.paired.answer);
                    if (!frame.paired) throw new PairingError("hub", "the hub sent something else while pairing");
                }
            } finally {
                socket.close();
            }
        },
        close: () => socket.close(),
    };
}

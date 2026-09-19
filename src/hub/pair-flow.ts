/**
 * Pairing as the screens drive it, over `pairing.ts` and the `Keyring`: creating an account on its first device,
 * offering this principal to an account, and — on a device that may pair — looking an offer up by the code a person
 * typed and confirming it with the scopes they chose. The pairing components take these as props, so the extension's
 * pages, the chat page's web build and a phone all pair through the same four calls.
 *
 * The person's fingerprint comparison is the security, and nothing here can make it for them: `lookupOffer` hands back
 * the fingerprint to SHOW, and `confirmOffer` is only ever called after they said it matched.
 *
 * chrome-free, like the rest of `src/hub/`.
 */
import { Certificate, CertificateBody } from "../proto/wmlhub/v1/identity.gen";
import { createFrameReader } from "../protostream";
import { Bytes, bytes } from "./hpke";
import { HubClient, PairingRefused } from "./client";
import { ChainError, Identity, MAX_CERTIFICATE_MS, NEVER_DELEGABLE, SCOPE, generateIdentity, issueCertificate } from "./keys";
import { Keyring, Membership } from "./keyring";
import {
    Offer, PAIRING_WINDOW_MS, PairingError, decodeOffer, encodeOffer, generatePairingCode, offerPairing, openPairingAnswer,
    pairingCodeHash, pairingFingerprint, pairingFingerprintHex, pairingQrText, parsePairingCode, parsePairingQr, sealPairingAnswer,
} from "./pairing";
import { Frame, Role } from "./wire";

/** What a person is offered to grant, per role, before they change anything. The screen may narrow or widen it. */
export interface GrantChoice {
    scopes: string[];
    /** may issue certificates of its own: a runtime renews the devices on its allowlist, so it needs this */
    mayPair: boolean;
    /** may sign the account's revocation list; one principal at a time, and only the root may grant it */
    mayRevoke: boolean;
    /** how long the certificate is valid for, at most `MAX_CERTIFICATE_MS` */
    validityMs: number;
}

/**
 * The defaults the screen starts from. A RUNTIME is paired to be driven and to keep the account's devices current: it
 * holds no scopes of its own (scopes are what a client may do TO a runtime), may pair so it can renew, and signs the
 * revocation list (window-ml-hub `docs/design/revocation.md`: the runtime holds `may_revoke`, never the root). A CLIENT
 * gets `view` and `drive`; `approve`, `screen` and the rest are opt-in, each a line the screen explains. A BOX
 * CONNECTOR relays telemetry and may hold neither. From a delegate (`issuer` with scopes), the defaults are cut to what it
 * may pass on.
 */
export function defaultGrant(role: Role, issuer?: Issuer): GrantChoice {
    const validityMs = MAX_CERTIFICATE_MS;
    const choice: GrantChoice =
        role === Role.ROLE_RUNTIME ? { scopes: [], mayPair: true, mayRevoke: true, validityMs }
        : role === Role.ROLE_CLIENT ? { scopes: [SCOPE.view, SCOPE.drive], mayPair: false, mayRevoke: false, validityMs }
        : { scopes: [], mayPair: false, mayRevoke: false, validityMs };
    // A delegate passes on only what it holds, never `may_revoke`: the defaults start inside what it may give.
    if (issuer?.scopes) {
        choice.scopes = choice.scopes.filter((s) => issuer.scopes!.includes(s) && !(NEVER_DELEGABLE as readonly string[]).includes(s));
        choice.mayRevoke = false;
    }
    return choice;
}

/** How long a certificate's window reaches back, so a device whose clock runs a little behind is not refused. */
const CLOCK_SKEW_MS = 5 * 60_000;

/**
 * Read the name a hub gives itself, from its challenge, without authenticating. What a new account's first `Hello`
 * must name back.
 */
export async function readHubName(url: string): Promise<string> {
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    const reader = createFrameReader();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.close(); reject(new PairingError("hub", "the hub did not say who it is")); }, 15_000);
        socket.onmessage = (event) => {
            if (!(event.data instanceof ArrayBuffer)) return;
            for (const frame of reader.push(new Uint8Array(event.data))) {
                const challenge = Frame.decode(frame).challenge;
                clearTimeout(timer);
                socket.close();
                if (challenge) resolve(challenge.hub); else reject(new PairingError("hub", "the hub's first frame must be a challenge"));
                return;
            }
        };
        socket.onerror = () => { clearTimeout(timer); reject(new PairingError("hub", "could not reach the hub")); };
    });
}

/**
 * Create an account on THIS device: a new root key, the account's channel key, and a certificate for this device's
 * own keys, issued by that root. Connects once with it before saving anything, so a hub that refuses the account (an
 * invite-only hub and no invite) is an error rather than a saved account nobody can use.
 */
export async function createAccount(
    keyring: Keyring,
    opts: {
        hubUrl: string; label: string; invite?: Bytes; now?: () => number;
        /** the root to use instead of a fresh non-extractable one: `scripts/hub-root.mjs` keeps its root in a file */
        root?: Identity;
    },
): Promise<Membership> {
    const now = opts.now ?? Date.now;
    const me = await keyring.keys();
    if (me.membership) throw new Error("this device already belongs to an account; leave it first");
    const root = opts.root ?? await generateIdentity();
    const channelKey = crypto.getRandomValues(new Uint8Array(32));
    const t = now();
    // This device holds the root, so its own certificate says what it is (a client) and that it may pair; the root
    // itself is what grants approve, admin and the rest, and it is right here.
    const cert = await issueCertificate(root, {
        subject: me.identity.publicKey, agreementKey: me.agreement.publicKey, role: Role.ROLE_CLIENT,
        scopes: Object.values(SCOPE), mayPair: true, label: opts.label,
        notBeforeMs: t - CLOCK_SKEW_MS, notAfterMs: t - CLOCK_SKEW_MS + MAX_CERTIFICATE_MS,
    });
    const hubName = await readHubName(opts.hubUrl);
    const membership: Membership = { hubUrl: opts.hubUrl, hubName, accountRoot: root.publicKey, chain: [cert], channelKey, pairedAtMs: t };
    const client = await HubClient.connect({
        url: opts.hubUrl, hubName, identity: me.identity, agreement: me.agreement, chain: [cert], accountRoot: root.publicKey,
        role: Role.ROLE_CLIENT, invite: opts.invite,
    });
    client.close();
    await keyring.saveAccount({ identity: root, channelKey, createdAtMs: t }, membership);
    return membership;
}

/** An offer this principal has left with a hub: what to show, and the wait for somebody to answer it. */
export interface PendingOffer {
    /** the code the person carries, grouped for reading ("ABCD 1234") */
    code: string;
    /** twelve hex characters; the screen may render them however it likes, as long as both screens agree */
    fingerprint: string;
    /** the text to draw as a QR code, for a device that scans instead of typing (`lookupScanned`) */
    qr: string;
    hubName: string;
    /** Resolves with the membership once answered and saved. Rejects on timeout, a refusal, or a bad answer. */
    done: Promise<Membership>;
    cancel(): void;
}

/**
 * Offer THIS principal to an account through `hubUrl`, as `role`, called `label`. Resolves once the hub holds the
 * offer, so the code is only shown when it can be answered. The answer is checked (`openPairingAnswer`) before it is
 * saved, and saved before `done` resolves.
 */
export async function beginOffer(
    keyring: Keyring,
    opts: { hubUrl: string; role: Role; label: string; windowMs?: number; now?: () => number },
): Promise<PendingOffer> {
    const now = opts.now ?? Date.now;
    const me = await keyring.keys();
    const offer: Offer = { identityKey: me.identity.publicKey, agreementKey: me.agreement.publicKey, role: opts.role, label: opts.label, offeredAtMs: now() };
    const code = generatePairingCode();
    const slot = await offerPairing(opts.hubUrl, await pairingCodeHash(code), encodeOffer(offer));
    const done = slot.answer(opts.windowMs ?? PAIRING_WINDOW_MS).then(async (answer) => {
        const paired = await openPairingAnswer({ identityKey: me.identity.publicKey, agreement: me.agreement, role: opts.role }, answer, now());
        const membership: Membership = {
            hubUrl: opts.hubUrl, hubName: slot.hubName, accountRoot: paired.accountRoot, chain: paired.chain,
            channelKey: paired.channelKey, pairedAtMs: now(),
        };
        await keyring.savePaired(membership);
        return membership;
    });
    return {
        code: `${code.slice(0, 4)} ${code.slice(4)}`,
        fingerprint: await pairingFingerprintHex(me.identity.publicKey, me.agreement.publicKey),
        qr: await pairingQrText(code, me.identity.publicKey, me.agreement.publicKey),
        hubName: slot.hubName,
        done,
        cancel: () => slot.close(),
    };
}

/** An offer fetched by the code a person typed: what to show them, and what `confirmOffer` needs. */
export interface FoundOffer {
    codeHash: Bytes;
    offer: Offer;
    /** compare with what the offering screen shows; the screen confirms only on a match the PERSON saw */
    fingerprint: string;
    /** true when a scanned QR code's full fingerprint already matched the offer's keys (`lookupScanned`) */
    checked?: boolean;
}

/** Look an offer up by the code a person typed. Rejects on something that is not a code, or no offer under it. */
export async function lookupOffer(client: HubClient, typed: string): Promise<FoundOffer> {
    const code = parsePairingCode(typed);
    if (!code) throw new PairingError("bad-offer", "that is not a pairing code: eight letters and digits");
    const codeHash = await pairingCodeHash(code);
    const offered = await client.pairingOffered(codeHash).catch((e) => {
        // The hub's only refusal of a fetch is "nothing waiting under that code"; a timeout or a dropped socket is not that.
        throw e instanceof PairingRefused ? new PairingError("no-offer", "no pairing is waiting under that code: check it, or offer again") : e;
    });
    const offer = decodeOffer(offered);
    return { codeHash, offer, fingerprint: await pairingFingerprintHex(offer.identityKey, offer.agreementKey) };
}

/**
 * Look an offer up by a scanned QR code (`PendingOffer.qr`), and check its keys against the full fingerprint the code
 * carried. A match needs no comparing by eye, so `FoundOffer.checked` is true and the screen may go straight to the
 * grant; a mismatch rejects (`"mismatch"`) before anything about the offer is shown.
 */
export async function lookupScanned(client: HubClient, scanned: string): Promise<FoundOffer> {
    const qr = parsePairingQr(scanned);
    if (!qr) throw new PairingError("bad-offer", "that QR code is not a window.ml pairing code");
    const found = await lookupOffer(client, qr.code);
    const digest = await pairingFingerprint(found.offer.identityKey, found.offer.agreementKey);
    const hex = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (hex !== qr.fingerprint) {
        throw new PairingError("mismatch", "the offer's keys are not the ones the QR code named, so it was refused: something between the two devices swapped them");
    }
    return { ...found, checked: true };
}

/** Who issues a certificate from this device: the root, or this device's own certificate if it holds `may_pair`. */
export interface Issuer {
    identity: Identity;
    /** empty for the root; this device's own chain (its leaf) for a delegate */
    chain: Certificate[];
    accountRoot: Bytes;
    channelKey: Bytes;
    /** a delegate's certificate may not outlive its own, so a child's window is cut to it */
    notAfterMs?: number;
    /** a delegate's own scopes, the most it may pass on; absent for the root */
    scopes?: string[];
}

/** This device's issuer, or null when it may not pair: the root if it holds it, else its own `may_pair` certificate. */
export async function issuerOf(keyring: Keyring): Promise<Issuer | null> {
    const me = await keyring.load();
    if (!me?.membership) return null;
    if (me.root) return { identity: me.root.identity, chain: [], accountRoot: me.membership.accountRoot, channelKey: me.root.channelKey };
    const leaf = me.membership.chain[0];
    const body = leaf ? CertificateBody.decode(leaf.body) : null;
    if (!body?.mayPair) return null;
    return {
        identity: me.identity, chain: [leaf], accountRoot: me.membership.accountRoot, channelKey: me.membership.channelKey,
        notAfterMs: Number(body.notAfterMs), scopes: body.scopes,
    };
}

/**
 * Answer an offer the person has CONFIRMED (the fingerprints matched): issue its certificate with the grant they chose,
 * seal it with the account's channel key to the offered agreement key, and leave it in the slot. A delegate hands its
 * own certificate along, because a principal given only a leaf could verify nothing above the key that signed it.
 */
export async function confirmOffer(
    client: HubClient,
    issuer: Issuer,
    found: FoundOffer,
    grant: GrantChoice & { label?: string; now?: () => number },
): Promise<void> {
    // What every verifier would refuse of a delegate, refused here while the person is still looking at the screen
    // rather than as a hello that "did not verify" on the new device later.
    if (issuer.scopes) {
        const never = grant.scopes.filter((s) => (NEVER_DELEGABLE as readonly string[]).includes(s));
        if (never.length) throw new ChainError(`only the account's root device may grant ${never.join(", ")}`);
        const wider = grant.scopes.filter((s) => !issuer.scopes!.includes(s));
        if (wider.length) throw new ChainError(`this device cannot grant what it does not hold: ${wider.join(", ")}`);
        if (grant.mayRevoke) throw new ChainError("only the account's root device may grant signing revocations");
    }
    const t = (grant.now ?? Date.now)();
    const notBeforeMs = t - CLOCK_SKEW_MS;
    let notAfterMs = notBeforeMs + Math.min(grant.validityMs, MAX_CERTIFICATE_MS);
    if (issuer.notAfterMs !== undefined) notAfterMs = Math.min(notAfterMs, issuer.notAfterMs);
    const cert = await issueCertificate(issuer.identity, {
        subject: found.offer.identityKey, agreementKey: found.offer.agreementKey, role: found.offer.role,
        scopes: grant.scopes, mayPair: grant.mayPair, mayRevoke: grant.mayRevoke,
        label: grant.label ?? found.offer.label, notBeforeMs, notAfterMs,
    });
    const answer = await sealPairingAnswer(found.offer.agreementKey, {
        chain: [cert, ...issuer.chain], accountRoot: issuer.accountRoot, channelKey: bytes(issuer.channelKey),
    });
    await client.pairingAnswer(found.codeHash, answer);
}

// support.ts — whether this browser can do the hub's cryptography at all, asked once and answered honestly.
//
// The hub's design rests on two WebCrypto curves that arrived late and not everywhere: Ed25519 (identity, every
// certificate in a chain) and X25519 (HPKE's key agreement, so every sealed command). Chrome shipped both at 137 and
// Safari at 17. A browser without them cannot pair, cannot verify a chain and cannot open a seal, and there is no
// fallback: a WASM implementation would need the raw private key, which is the one thing the design refuses to have.
//
// So the answer belongs at the TOP of the UI, not at the bottom of a stack trace. `verify()` deliberately swallows an
// import failure into `false` — right for a bad key, indistinguishable from a browser that has never heard of the
// algorithm — and a person on an old browser would otherwise meet that as "this certificate did not verify", which is
// a sentence about their hub rather than about their browser.

/** Why this browser cannot speak to a hub. Two curves, asked separately, because a browser can have one and not the other. */
export interface HubCryptoSupport {
    /** can it do all of it? the only field a caller that just wants to render a gate needs */
    ok: boolean;
    /** Ed25519: identities, certificates, every signature in a chain */
    signing: boolean;
    /** X25519: HPKE's key agreement, so every sealed command and every encrypted stream */
    agreement: boolean;
}

let asked: Promise<HubCryptoSupport> | null = null;

/** Does this algorithm work, end to end? A `generateKey` that resolves is not enough on its own — an implementation
 *  can produce a key it then refuses to use — so each curve is exercised the way the hub exercises it. */
async function works(probe: () => Promise<unknown>): Promise<boolean> {
    try { await probe(); return true; } catch { return false; }
}

/**
 * Can this browser do the hub's cryptography? Ed25519 and X25519 over WebCrypto, each exercised rather than
 * advertised: generated, then actually used, because an implementation that generates a key it will not sign with
 * fails later and further from the cause.
 *
 * Asked once per document and cached, including a negative: the answer cannot change while a page is open, and a UI
 * that gates on it asks on every render.
 */
export function hubCryptoSupported(): Promise<HubCryptoSupport> {
    if (asked) return asked;
    asked = (async () => {
        const message = new Uint8Array([0x68, 0x75, 0x62]);
        const signing = await works(async () => {
            const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
            const sig = await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, message);
            if (!(await crypto.subtle.verify({ name: "Ed25519" }, pair.publicKey, sig, message)))
                throw new Error("Ed25519 signed something it then would not verify");
        });
        const agreement = await works(async () => {
            const a = (await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
            const b = (await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
            const shared = await crypto.subtle.deriveBits({ name: "X25519", public: b.publicKey }, a.privateKey, 256);
            if (shared.byteLength !== 32) throw new Error("X25519 agreed on the wrong number of bytes");
        });
        return { ok: signing && agreement, signing, agreement };
    })();
    return asked;
}

/** Forget the cached answer. For tests, which swap `crypto.subtle` between cases. */
export function _resetHubCryptoSupport(): void { asked = null; }

/** What to tell a person whose browser cannot, naming the browser rather than the hub. Empty when it can. */
export function hubCryptoReason(support: HubCryptoSupport): string {
    if (support.ok) return "";
    const missing = [!support.signing && "Ed25519", !support.agreement && "X25519"].filter(Boolean).join(" and ");
    return `This browser has no ${missing}, which a hub connection is built on. Chrome 137 and Safari 17 were the first with both.`;
}

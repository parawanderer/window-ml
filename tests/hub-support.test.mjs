// What a browser that cannot do the hub's cryptography is told, and where it is told it.
//
// `verify()` swallows an unsupported-algorithm error into `false`, which is right for a bad key and wrong as the only
// signal a browser has never heard of Ed25519. This is the probe that tells those apart, so the UI can say so at the
// top rather than report "that certificate did not verify" to someone whose certificates are fine.
import { test } from "node:test";
import assert from "node:assert/strict";

const { hubCryptoSupported, hubCryptoReason, _resetHubCryptoSupport } = await import("../src/hub/support.ts");

/** A `crypto.subtle` that refuses the named algorithms the way a browser without them does. */
function subtleWithout(...missing) {
    const real = globalThis.crypto.subtle;
    const refuse = (algo) => {
        const name = typeof algo === "string" ? algo : algo?.name;
        if (missing.includes(name)) throw new DOMException(`Unrecognized name: ${name}`, "NotSupportedError");
    };
    return {
        generateKey: async (algo, ...rest) => { refuse(algo); return real.generateKey(algo, ...rest); },
        importKey: async (fmt, keyData, algo, ...rest) => { refuse(algo); return real.importKey(fmt, keyData, algo, ...rest); },
        sign: async (algo, ...rest) => { refuse(algo); return real.sign(algo, ...rest); },
        verify: async (algo, ...rest) => { refuse(algo); return real.verify(algo, ...rest); },
        deriveBits: async (algo, ...rest) => { refuse(algo); return real.deriveBits(algo, ...rest); },
    };
}

/** Run one case against a swapped `crypto.subtle`, with the cached answer cleared either side of it.
 *  `subtle` is a getter on the PROTOTYPE, so the swap is an own property and restoring it is a delete. */
async function withSubtle(subtle, fn) {
    _resetHubCryptoSupport();
    Object.defineProperty(globalThis.crypto, "subtle", { value: subtle, configurable: true });
    try { return await fn(); } finally {
        delete globalThis.crypto.subtle;
        _resetHubCryptoSupport();
    }
}

test("a browser with both curves can do all of it", async () => {
    _resetHubCryptoSupport();
    const support = await hubCryptoSupported();
    assert.deepEqual(support, { ok: true, signing: true, agreement: true });
    assert.equal(hubCryptoReason(support), "", "and is told nothing");
    _resetHubCryptoSupport();
});

test("each curve is asked separately, because a browser can have one and not the other", async () => {
    const noSigning = await withSubtle(subtleWithout("Ed25519"), () => hubCryptoSupported());
    assert.deepEqual(noSigning, { ok: false, signing: false, agreement: true });
    assert.match(hubCryptoReason(noSigning), /Ed25519/);
    assert.doesNotMatch(hubCryptoReason(noSigning), /X25519/, "and is not told about the one it has");

    const noAgreement = await withSubtle(subtleWithout("X25519"), () => hubCryptoSupported());
    assert.deepEqual(noAgreement, { ok: false, signing: true, agreement: false });
    assert.match(hubCryptoReason(noAgreement), /X25519/);

    const neither = await withSubtle(subtleWithout("Ed25519", "X25519"), () => hubCryptoSupported());
    assert.deepEqual(neither, { ok: false, signing: false, agreement: false });
    assert.match(hubCryptoReason(neither), /Ed25519 and X25519/);
});

test("the reason names the BROWSER, and a version a person can act on", async () => {
    const support = await withSubtle(subtleWithout("Ed25519", "X25519"), () => hubCryptoSupported());
    const reason = hubCryptoReason(support);
    assert.match(reason, /This browser/, "not 'the hub refused' — nothing is wrong with the hub");
    assert.match(reason, /Chrome 137/);
    assert.match(reason, /Safari 17/);
});

test("a curve that generates a key it will not then USE counts as missing", async () => {
    const real = globalThis.crypto.subtle;
    // The failure an advertised-but-broken implementation produces: generateKey resolves, sign does not.
    const halfway = {
        generateKey: (...a) => real.generateKey(...a),
        importKey: (...a) => real.importKey(...a),
        deriveBits: (...a) => real.deriveBits(...a),
        verify: (...a) => real.verify(...a),
        sign: async () => { throw new DOMException("not implemented", "OperationError"); },
    };
    const support = await withSubtle(halfway, () => hubCryptoSupported());
    assert.equal(support.signing, false, "exercised, not advertised");
    assert.equal(support.agreement, true);
});

test("the answer is cached, including a negative: a gate asks on every render", async () => {
    let generated = 0;
    const real = globalThis.crypto.subtle;
    const counting = {
        generateKey: (...a) => { generated++; return real.generateKey(...a); },
        importKey: (...a) => real.importKey(...a),
        deriveBits: (...a) => real.deriveBits(...a),
        sign: (...a) => real.sign(...a),
        verify: (...a) => real.verify(...a),
    };
    await withSubtle(counting, async () => {
        await Promise.all([hubCryptoSupported(), hubCryptoSupported()]);
        await hubCryptoSupported();
    });
    assert.equal(generated, 3, "one Ed25519 pair and two X25519 pairs, once");
});

test("connecting refuses BEFORE the socket, so the browser is what gets named", async () => {
    const { HubClient, ConnectError } = await import("../src/hub/client.ts");
    let sockets = 0;
    const realWs = globalThis.WebSocket;
    globalThis.WebSocket = class { constructor() { sockets++; } };
    try {
        const err = await withSubtle(subtleWithout("X25519"), () =>
            HubClient.connect({ url: "wss://hub.example/", hub: new Uint8Array(32) }).then(
                () => null,
                (e) => e,
            ));
        assert.ok(err instanceof ConnectError);
        assert.equal(err.reason, "unsupported", "not 'refused' — the hub never heard from us");
        assert.match(err.message, /This browser/);
        assert.equal(sockets, 0, "and nothing was dialled");
    } finally {
        globalThis.WebSocket = realWs;
    }
});

// Pairing (src/hub/pairing.ts): the code, the fingerprint, the offer and the sealed answer, then the same flow against
// the REAL hub, and against the OTHER implementation of the offering side: window-ml-hub's own `wmlbox pair`, which
// prints its code and fingerprint and opens the answer this client seals. A disagreement about a label, a hash or the
// seal fails here rather than when somebody stands in front of two screens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOX_BIN, HAVE_BOX, HUB, LIVE, device, startHub } from "./fixtures/hub-harness.mjs";

const { generateAgreementKey } = await import("../src/hub/hpke.ts");
const { generateIdentity, issueCertificate, principalId } = await import("../src/hub/keys.ts");
const { HubClient } = await import("../src/hub/client.ts");
const { Role } = await import("../src/hub/wire.ts");
const P = await import("../src/hub/pairing.ts");

const HOUR = 3_600_000;
const window = () => ({ notBeforeMs: Date.now() - HOUR, notAfterMs: Date.now() + HOUR });

/** A principal with keys and nothing else: what makes an offer. */
async function newcomer(role = Role.ROLE_RUNTIME, label = "the laptop") {
    const identity = await generateIdentity();
    const agreement = await generateAgreementKey();
    const offer = { identityKey: identity.publicKey, agreementKey: agreement.publicKey, role, label, offeredAtMs: Date.now() };
    return { identity, agreement, offer, mine: { identityKey: identity.publicKey, agreement, role } };
}

/** What a device that may pair gives the offer: a certificate for exactly its keys, sealed to its agreement key. */
async function answerFor(root, offer, over = {}) {
    const cert = await issueCertificate(root, {
        subject: offer.identityKey, agreementKey: offer.agreementKey, role: offer.role, scopes: [], label: offer.label, ...window(), ...over,
    });
    return P.sealPairingAnswer(offer.agreementKey, { chain: [cert], accountRoot: root.publicKey, channelKey: crypto.getRandomValues(new Uint8Array(32)) });
}

test("a code is eight readable characters, read back however a person typed it", () => {
    const code = P.generatePairingCode();
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{8}$/);
    assert.notEqual(P.generatePairingCode(), code);
    for (const typed of ["0123abcd", "0123 ABCD", "0123-abcd", " 0123abcd ", "o123abcd", "O123ABCD", "0I23abcd", "0l23ABCD"])
        assert.equal(P.parsePairingCode(typed), "0123ABCD", typed);
    for (const typed of ["0123ABC", "0123ABCDE", "0123ABCU", "", "0123 AB!D"]) assert.equal(P.parsePairingCode(typed), null, typed);
});

test("the hub is told a hash of the code, and the fingerprint covers exactly the offered keys", async () => {
    const h = await P.pairingCodeHash("0123ABCD");
    assert.equal(h.length, 32);
    assert.deepEqual(h, await P.pairingCodeHash(P.parsePairingCode("0123abcd")));
    const { offer } = await newcomer();
    const fp = await P.pairingFingerprintHex(offer.identityKey, offer.agreementKey);
    assert.match(fp, /^[0-9a-f]{12}$/);
    const other = await generateAgreementKey();
    assert.notEqual(await P.pairingFingerprintHex(offer.identityKey, other.publicKey), fp, "a swapped agreement key changes it");
});

test("an offer round-trips, and one that is not an offer is refused", async () => {
    const { offer } = await newcomer(Role.ROLE_CLIENT, "Shane's phone");
    const back = P.decodeOffer(P.encodeOffer(offer));
    assert.deepEqual({ ...back, offeredAtMs: Number(back.offeredAtMs) }, offer);
    assert.throws(() => P.encodeOffer({ ...offer, label: "x".repeat(65) }), (e) => e.reason === "bad-offer");
    assert.throws(() => P.encodeOffer({ ...offer, identityKey: offer.identityKey.slice(0, 31) }), (e) => e.reason === "bad-offer");
    assert.throws(() => P.encodeOffer({ ...offer, role: Role.ROLE_UNSPECIFIED }), (e) => e.reason === "bad-offer");
    assert.throws(() => P.decodeOffer(new Uint8Array([0xff, 0xff])), (e) => e.reason === "malformed" || e.reason === "bad-offer");
});

test("an answer opens only for the offer it was made for, and is refused unless it names this principal's own keys", async () => {
    const root = await generateIdentity();
    const me = await newcomer();
    const opened = await P.openPairingAnswer(me.mine, await answerFor(root, me.offer), Date.now());
    assert.deepEqual(opened.accountRoot, root.publicKey);
    assert.equal(opened.channelKey.length, 32);
    assert.deepEqual(opened.verified.principal, await principalId(me.identity.publicKey));

    const reason = async (answer, mine = me.mine) => P.openPairingAnswer(mine, await answer, Date.now()).then(() => "opened", (e) => e.reason);
    // Sealed to somebody else's agreement key: it does not open at all.
    const other = await newcomer();
    assert.equal(await reason(answerFor(root, other.offer)), "malformed");
    // A certificate for another identity, sealed to MY key: the hub swapped the identity and kept my agreement key.
    assert.equal(await reason(answerFor(root, { ...me.offer, identityKey: other.offer.identityKey })), "not-mine");
    // For my identity, but naming another agreement key: nothing sealed to me would ever open.
    const sealedToMeForOtherKey = issueCertificate(root, { subject: me.offer.identityKey, agreementKey: other.offer.agreementKey, role: me.offer.role, scopes: [], label: "", ...window() })
        .then((cert) => P.sealPairingAnswer(me.offer.agreementKey, { chain: [cert], accountRoot: root.publicKey, channelKey: new Uint8Array(32) }));
    assert.equal(await reason(sealedToMeForOtherKey), "not-my-agreement-key");
    assert.equal(await reason(answerFor(root, me.offer, { role: Role.ROLE_CLIENT })), "wrong-role");
    // Issued by a key that is not the root it names.
    const stranger = await generateIdentity();
    const forged = issueCertificate(stranger, { subject: me.offer.identityKey, agreementKey: me.offer.agreementKey, role: me.offer.role, scopes: [], label: "", ...window() })
        .then((cert) => P.sealPairingAnswer(me.offer.agreementKey, { chain: [cert], accountRoot: root.publicKey, channelKey: new Uint8Array(32) }));
    assert.equal(await reason(forged), "chain");
    assert.equal(await reason(Promise.resolve(new Uint8Array([1, 2, 3]))), "malformed");
});

/** The account's first device: holds the root, and logs in with a certificate the root issued itself. */
async function rootDevice(url) {
    const root = await generateIdentity();
    const phone = await device(root, Role.ROLE_CLIENT, [], "the phone");
    const client = await HubClient.connect({ url, hubName: HUB, identity: phone.identity, agreement: phone.agreement, chain: phone.chain, accountRoot: root.publicKey, role: Role.ROLE_CLIENT });
    return { root, client };
}

test("pairing through the real hub: offer, fetch, compare, answer, then log in with what came back", LIVE, async () => {
    const hub = await startHub();
    try {
        const { root, client } = await rootDevice(hub.url);
        const me = await newcomer();
        const code = P.generatePairingCode();
        const slot = await P.offerPairing(hub.url, await P.pairingCodeHash(code), P.encodeOffer(me.offer));

        // The person types the code on the phone, lower case: the phone fetches the offer and shows its fingerprint.
        const typed = P.parsePairingCode(code.toLowerCase());
        const fetched = P.decodeOffer(await client.pairingOffered(await P.pairingCodeHash(typed)));
        assert.equal(fetched.label, "the laptop");
        assert.equal(
            await P.pairingFingerprintHex(fetched.identityKey, fetched.agreementKey),
            await P.pairingFingerprintHex(me.identity.publicKey, me.agreement.publicKey),
            "what the phone shows is what the new principal shows",
        );
        await client.pairingAnswer(await P.pairingCodeHash(typed), await answerFor(root, fetched));
        // Only the first answer is taken.
        await assert.rejects(client.pairingAnswer(await P.pairingCodeHash(typed), await answerFor(root, fetched)));

        const paired = await P.openPairingAnswer(me.mine, await slot.answer(5_000), Date.now());
        const laptop = await HubClient.connect({ url: hub.url, hubName: HUB, identity: me.identity, agreement: me.agreement, chain: paired.chain, accountRoot: paired.accountRoot, role: Role.ROLE_RUNTIME });
        assert.deepEqual(laptop.account, client.account, "the same account");
        laptop.close();
        client.close();
    } finally { hub.stop(); }
});

test("the hub's refusals reach the caller: no slot under a code, a code already offered, and nobody answering", LIVE, async () => {
    const hub = await startHub();
    try {
        const { client } = await rootDevice(hub.url);
        await assert.rejects(client.pairingOffered(await P.pairingCodeHash(P.generatePairingCode())));
        // The connection survives a refused fetch.
        const me = await newcomer();
        const hash = await P.pairingCodeHash(P.generatePairingCode());
        const slot = await P.offerPairing(hub.url, hash, P.encodeOffer(me.offer));
        await assert.rejects(P.offerPairing(hub.url, hash, P.encodeOffer((await newcomer()).offer)), (e) => e.reason === "hub");
        assert.ok(P.decodeOffer(await client.pairingOffered(hash)), "the first offer is the one held");
        await assert.rejects(slot.answer(300), (e) => e.reason === "timed-out");
        client.close();
    } finally { hub.stop(); }
});

/** Run `wmlbox pair`, and hand back its code and fingerprint as it printed them, and its exit. */
function wmlboxPair(url, stateDir) {
    const child = spawn(BOX_BIN, ["pair", "--hub", url, "--label", "lab box", "--state-dir", stateDir], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const exited = new Promise((resolve) => child.on("exit", (code) => resolve({ code, out, err })));
    const printed = (async () => {
        for (let i = 0; i < 200; i++) {
            const code = /Pairing code\s+([0-9A-Z ]+)\n/.exec(out)?.[1];
            const fp = /Fingerprint\s+([0-9a-f ]+)\n/.exec(out)?.[1];
            if (code && fp) return { code: code.replace(/ /g, ""), fingerprint: fp.replace(/ /g, "") };
            await new Promise((r) => setTimeout(r, 25));
        }
        child.kill();
        throw new Error(`wmlbox printed no code: ${out}${err}`);
    })();
    return { printed, exited, kill: () => child.kill() };
}

test("the other implementation: this client answers `wmlbox pair`, whose fingerprint it computes and whose answer it seals", { ...LIVE, skip: LIVE.skip || (!HAVE_BOX && "no wmlbox beside the wmlhub binary: `cargo build --release -p wmlhub-connector` in the same tag") }, async () => {
    const hub = await startHub();
    const state = mkdtempSync(join(tmpdir(), "wmlbox-pair-"));
    const box = wmlboxPair(hub.url, state);
    try {
        const { root, client } = await rootDevice(hub.url);
        const { code, fingerprint } = await box.printed;
        const hash = await P.pairingCodeHash(P.parsePairingCode(code));
        const offer = P.decodeOffer(await client.pairingOffered(hash));
        assert.equal(offer.role, Role.ROLE_BOX_CONNECTOR);
        assert.equal(offer.label, "lab box");
        assert.equal(await P.pairingFingerprintHex(offer.identityKey, offer.agreementKey), fingerprint, "the fingerprint the box printed");
        await client.pairingAnswer(hash, await answerFor(root, offer));
        const { code: exit, out, err } = await box.exited;
        assert.equal(exit, 0, `wmlbox refused what this client sealed: ${out}${err}`);
        assert.match(out, /Paired\./);
        client.close();
    } finally { box.kill(); hub.stop(); rmSync(state, { recursive: true, force: true }); }
});

test("a pairing QR code: the code and the whole fingerprint, in QR alphanumeric characters, read back leniently", async () => {
    const identity = await generateIdentity();
    const agreement = await generateAgreementKey();
    const code = P.generatePairingCode();
    const qr = await P.pairingQrText(code, identity.publicKey, agreement.publicKey);
    assert.match(qr, /^[0-9A-Z:]+$/);
    const back = P.parsePairingQr(` ${qr.toLowerCase()} `);
    assert.equal(back.code, code);
    assert.equal(back.fingerprint.slice(0, 12), await P.pairingFingerprintHex(identity.publicKey, agreement.publicKey), "the screen's fingerprint is its prefix");
    assert.equal(back.fingerprint.length, 64);
    for (const bad of ["", "WMLPAIR:2:" + qr.slice(10), qr.slice(0, -1), qr + "0", `WMLPAIR:1:ABCDEFGU:${"0".repeat(64)}`]) {
        assert.equal(P.parsePairingQr(bad), null, bad);
    }
});

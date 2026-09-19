// Revocation lists (src/hub/revocation.ts) against window-ml-hub's vector and its four rules: the vector verifies and
// re-signs byte for byte (Ed25519 is deterministic), a chain falls if ANY certificate in it is named, a renewal falls
// with what it renews, and a list is refused when the held list names its signer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { generateAgreementKey } = await import("../src/hub/hpke.ts");
const { generateIdentity, identityFromSeed, issueCertificate, principalId } = await import("../src/hub/keys.ts");
const { RevocationList, CertificateBody, Role } = await import("../src/proto/wmlhub/v1/identity.gen.ts");
const R = await import("../src/hub/revocation.ts");

const V = JSON.parse(readFileSync(new URL("./fixtures/hub/seal-v1.json", import.meta.url), "utf8"));
const fromHex = (h) => new Uint8Array(h.match(/../g).map((b) => parseInt(b, 16)));
const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

test("the hub's vector verifies, names what it says, and re-signs byte for byte", async () => {
    const root = fromHex(V.account.root_public);
    const list = RevocationList.decode(fromHex(V.revocation.list));
    const got = await R.verifyRevocations(root, list, V.revocation.verify_at_ms, null);
    assert.deepEqual([...got.principals], V.revocation.principals);
    assert.deepEqual([...got.certificates], V.revocation.certificates);
    const leaf = CertificateBody.decode(list.chain[0].body);
    const revoker = await identityFromSeed(fromHex(V.revocation.revoker_seed), leaf.subject);
    const again = await R.signRevocations(revoker, list.chain, root, got.version, V.revocation.principals.map(fromHex), V.revocation.certificates.map(fromHex));
    assert.equal(toHex(R.encodeRevocations(again)), V.revocation.list);
    // Held, the same version is stale; a list for another account is refused before its signature is looked at.
    await assert.rejects(R.verifyRevocations(root, list, V.revocation.verify_at_ms, got), (e) => e.reason === "stale");
    await assert.rejects(R.verifyRevocations((await generateIdentity()).publicKey, list, V.revocation.verify_at_ms, null), (e) => e.reason === "wrong-account");
});

const HOUR = 3_600_000;
async function account() {
    const root = await generateIdentity();
    const t = Date.now();
    const cert = async (issuer, subject, over = {}) => issueCertificate(issuer, {
        subject: subject.publicKey, agreementKey: (await generateAgreementKey()).publicKey, role: Role.ROLE_CLIENT, scopes: ["view"],
        notBeforeMs: t - HOUR, notAfterMs: t + HOUR, ...over,
    });
    const laptop = await generateIdentity();
    const laptopChain = [await cert(root, laptop, { role: Role.ROLE_RUNTIME, scopes: [], mayPair: true, mayRevoke: true })];
    return { root, t, cert, laptop, laptopChain };
}

test("a chain falls if any certificate in it is named, a renewal with what it renews, and a revoked revoker signs nothing", async () => {
    const a = await account();
    const phone = await generateIdentity();
    const phoneChain = [await a.cert(a.root, phone, { mayPair: true })];
    const tablet = await generateIdentity();
    const tabletChain = [await a.cert(phone, tablet), phoneChain[0]];   // paired BY the phone
    const list = await R.signRevocations(a.laptop, a.laptopChain, a.root.publicKey, a.t, [await principalId(phone.publicKey)], []);
    const held = await R.verifyRevocations(a.root.publicKey, list, a.t, null);
    assert.equal(await held.revokes(phoneChain), true);
    assert.equal(await held.revokes(tabletChain), true, "what a revoked delegate paired falls with it");
    assert.equal(await held.revokes(a.laptopChain), false);

    // Revoking one certificate revokes its renewal, and not a fresh certificate for the same device.
    const renewed = await a.cert(a.root, tablet, { renews: phoneChain[0] });
    const byCert = await R.signRevocations(a.laptop, a.laptopChain, a.root.publicKey, a.t + 1, [], [await R.certificateHash(phoneChain[0])]);
    const certHeld = await R.verifyRevocations(a.root.publicKey, byCert, a.t + 1, null);
    assert.equal(await certHeld.revokes([renewed]), true);
    assert.equal(await certHeld.revokes([await a.cert(a.root, phone)]), false);
    assert.equal(await certHeld.revokes([{ body: new Uint8Array([0xff]), signature: new Uint8Array(64) }]), true, "undecodable counts as revoked");

    // The root moves may_revoke to a second runtime, whose first list names the first: the first then signs nothing.
    const spare = await generateIdentity();
    const spareChain = [await a.cert(a.root, spare, { role: Role.ROLE_RUNTIME, scopes: [], mayRevoke: true })];
    const handover = await R.verifyRevocations(a.root.publicKey, await R.signRevocations(spare, spareChain, a.root.publicKey, a.t + 2, [await principalId(a.laptop.publicKey)], []), a.t + 2, held);
    await assert.rejects(
        R.verifyRevocations(a.root.publicKey, await R.signRevocations(a.laptop, a.laptopChain, a.root.publicKey, a.t + 3, [], []), a.t + 3, handover),
        (e) => e.reason === "signer-revoked",
    );
    assert.equal(handover.addsTo(held), true);
    assert.equal(held.addsTo(held), false, "a re-sign of the same entries adds nothing, so nobody rotates for it");
});

test("a list from a principal without may_revoke, from the future, or over the bounds is refused", async () => {
    const a = await account();
    const phone = await generateIdentity();
    const phoneChain = [await a.cert(a.root, phone)];
    await assert.rejects(R.verifyRevocations(a.root.publicKey, await R.signRevocations(phone, phoneChain, a.root.publicKey, a.t, [], []), a.t, null), (e) => e.reason === "not-revoker");
    await assert.rejects(R.verifyRevocations(a.root.publicKey, await R.signRevocations(a.laptop, a.laptopChain, a.root.publicKey, a.t + 120_000, [], []), a.t, null), (e) => e.reason === "from-the-future");
    const tampered = await R.signRevocations(a.laptop, a.laptopChain, a.root.publicKey, a.t, [], []);
    tampered.signature = new Uint8Array(64);
    await assert.rejects(R.verifyRevocations(a.root.publicKey, tampered, a.t, null), (e) => e.reason === "signature");
    await assert.rejects(R.signRevocations(a.laptop, a.laptopChain, a.root.publicKey, a.t, Array.from({ length: 257 }, () => new Uint8Array(32)), []), (e) => e.reason === "malformed");
});

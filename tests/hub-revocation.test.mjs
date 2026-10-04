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

test("the hub's revoker record is VERIFIED, not believed: a forged or absent one reads as unknown", async () => {
    // The field carries the signer's CERTIFICATE rather than its principal id, and the asymmetry is the reason. A hub
    // HIDING a signer is safe — the grant gets offered elsewhere and that device is refused at its own login. A hub
    // CLAIMING one that does not exist would make a client default the grant off forever, so no list would ever be
    // published and nothing would say so. `may_revoke` is never delegable, so this certificate is root-signed and a
    // hub that invents a signer has to forge a root signature.
    const root = await generateIdentity();
    const other = await generateIdentity();
    const device = await generateIdentity();
    const agreement = await generateAgreementKey();
    const now = Date.parse("2026-10-04T12:00:00Z");
    const certFrom = async (issuer, extra = {}) => issueCertificate(issuer, {
        subject: device.publicKey, agreementKey: agreement.publicKey, role: Role.ROLE_RUNTIME, scopes: [],
        label: "Work laptop", mayRevoke: true, notBeforeMs: now - 86_400_000, notAfterMs: now + 30 * 86_400_000, ...extra,
    });
    const FEAT = [R.REVOKER_FEATURE];

    // The real thing, signed by the account root, from a hub that announces the record.
    const good = await R.readRevoker(root.publicKey, await certFrom(root), now, FEAT);
    assert.equal(good.state, "signer");
    assert.equal(good.label, "Work laptop");
    assert.equal(good.principal, toHex(await principalId(device.publicKey)));

    // Signed by SOMETHING ELSE: a hub naming a device of its own choosing. Refused, and refused silently.
    assert.deepEqual(await R.readRevoker(root.publicKey, await certFrom(other), now, FEAT), { state: "unknown" });

    // Root-signed but WITHOUT the grant: a record of nothing, so it records nothing.
    assert.deepEqual(await R.readRevoker(root.publicKey, await certFrom(root, { mayRevoke: false }), now, FEAT), { state: "unknown" });

    // Expired: the hub session made a record spend with its grant, so a dead certificate is not a live signer.
    const dead = await issueCertificate(root, {
        subject: device.publicKey, agreementKey: agreement.publicKey, role: Role.ROLE_RUNTIME, scopes: [],
        label: "Old laptop", mayRevoke: true, notBeforeMs: now - 95 * 86_400_000, notAfterMs: now - 10 * 86_400_000,
    });
    assert.deepEqual(await R.readRevoker(root.publicKey, dead, now, FEAT), { state: "unknown" });

    // AND NONE OF THOSE THREE IS "none", though every one of them came from a hub that announces the record. A
    // present certificate that does not verify is a lying or broken hub, which is unknown; reading it as "the
    // account has none" would let a hub manufacture the warning by sending forty bad bytes.
});

test("absent `revoker` means NONE only from a hub that says it keeps the record, and UNKNOWN from one that does not", async () => {
    // THE UPGRADE CASE, and the whole reason `Welcome.features` exists. An absent `revoker` is the same bytes from a
    // hub holding no signer and from one too old to keep one, so before v0.4.3 a "nothing signs here" warning could
    // not be built: it would have fired against every older hub, and a warning that is usually wrong is one people
    // learn to dismiss. The NAME is what makes the silence mean something.
    //
    // The reading rule is a pure function of (features, revoker), so every row is asserted here with no hub at all
    // (tests/hub-runtime.test.mjs runs the two v0.4.3 rows against the real binary, where the certificate must
    // actually verify). Rows are the hub session's table in window-ml-hub `tmp/hub-revoker-reading-rule.md`.
    const root = await generateIdentity();
    const device = await generateIdentity();
    const agreement = await generateAgreementKey();
    const now = Date.parse("2026-10-04T12:00:00Z");
    const cert = await issueCertificate(root, {
        subject: device.publicKey, agreementKey: agreement.publicKey, role: Role.ROLE_RUNTIME, scopes: [],
        label: "Work laptop", mayRevoke: true, notBeforeMs: now - 86_400_000, notAfterMs: now + 30 * 86_400_000,
    });
    const read = (c, features) => R.readRevoker(root.publicKey, c, now, features);

    // A hub before v0.4.2: no record and no claim about whether it keeps one.
    assert.deepEqual(await read(undefined, []), { state: "unknown" }, "an older hub says nothing by sending nothing");
    // v0.4.2: the certificate is still good where there is one, and the SILENCE is what carries no information.
    assert.equal((await read(cert, [])).state, "signer", "v0.4.2 still names a signer usefully");
    assert.deepEqual(await read(undefined, []), { state: "unknown" }, "but its silence is not proof of none");
    // v0.4.3 with a signer, and v0.4.3 with none: the one row anything is allowed to warn on.
    assert.equal((await read(cert, [R.REVOKER_FEATURE])).state, "signer");
    assert.deepEqual(await read(undefined, [R.REVOKER_FEATURE]), { state: "none" }, "the name is what makes absence mean none");

    // The list is the SERVER'S OWN and additive: test for the name you need, ignore every other, and a name you do
    // not know is not an error. A fork may add its own and a hub may drop one it no longer implements.
    assert.deepEqual(await read(undefined, ["sessions", "revoker", "whatever-comes-next"]), { state: "none" });
    assert.deepEqual(await read(undefined, ["sessions", "whatever-comes-next"]), { state: "unknown" });
    // Defaulted, because ts-proto gives `[]` rather than `undefined` and a caller that has not been taught the field
    // must not start warning: absent argument reads exactly as an older hub.
    assert.deepEqual(await R.readRevoker(root.publicKey, undefined, now), { state: "unknown" });
});

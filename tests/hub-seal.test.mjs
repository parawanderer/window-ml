// This implementation against the Rust one, through the vectors they share.
//
// `tests/fixtures/hub/seal-v1.json` is window-ml-hub's `vectors/seal-v1.json`, vendored and pinned by blob id. It was
// produced by the Rust implementation; everything below is opened by this one. That is the whole point of writing both
// sides: the two are checked against each other here rather than against a prose description of the format.
//
// HPKE itself is checked first, in `hub-hpke.test.mjs`, against the RFC's vector, so a failure here is about our use of
// it rather than about HPKE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const { agreementKeyFromSeed } = await import("../src/hub/hpke.ts");
const { identityFromSeed, principalId, accountId, verifyChain, helloTranscript, verify, LABEL, SCOPE } = await import(
    "../src/hub/keys.ts"
);
const { Receiver, StreamKey, StreamReader, ChannelKey, sealCommand, sealResult, wrapKey, sealFrame } = await import(
    "../src/hub/seal.ts"
);
const { Certificate, CertificateBody, Role } = await import("../src/proto/wmlhub/v1/identity.gen.ts");

const hex = (s) => new Uint8Array(s.match(/../g)?.map((b) => parseInt(b, 16)) ?? []);
const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const raw = readFileSync(new URL("./fixtures/hub/seal-v1.json", import.meta.url));
const V = JSON.parse(raw.toString("utf8"));
const PIN = JSON.parse(readFileSync(new URL("./fixtures/hub/seal-v1.json.pin.json", import.meta.url), "utf8"));
const NOW = V.suite.time_ms;

/** The parties the vectors describe, rebuilt from the seeds they give. */
async function cast() {
    const root = await identityFromSeed(hex(V.account.root_seed), hex(V.account.root_public));
    const who = async (name) => {
        const d = V.principals[name];
        return {
            identity: await identityFromSeed(hex(d.identity_seed), hex(d.identity_public)),
            agreement: await agreementKeyFromSeed(hex(d.agreement_seed)),
            chain: [Certificate.decode(hex(d.certificate))],
            described: d,
        };
    };
    return { root, runtime: await who("runtime"), phone: await who("phone") };
}

const receiverFor = async (party, root) =>
    Receiver.create(party.identity, party.agreement, root.publicKey).then((r) => r);

test("the vendored vectors are the pinned file", () => {
    const blob = createHash("sha1").update(`blob ${raw.length}\0`).update(raw).digest("hex");
    assert.equal(blob, PIN.blob, `re-vendor from ${PIN.repo}:${PIN.path} and update the pin`);
    assert.equal(V.version, 4, "version 4: a revocation list (version 3 was the renewal case, which the verifier is exempt from two checks for)");
});

test("the keys the seeds name are the keys the vectors record", async () => {
    const { root, runtime, phone } = await cast();
    assert.equal(toHex(root.publicKey), V.account.root_public);
    assert.equal(toHex(await accountId(root.publicKey)), V.account.account_id);
    for (const party of [runtime, phone]) {
        assert.equal(toHex(party.identity.publicKey), party.described.identity_public);
        assert.equal(toHex(await principalId(party.identity.publicKey)), party.described.principal_id);
        assert.equal(toHex(party.agreement.publicKey), party.described.agreement_public);
    }
});

test("each certificate verifies to the account root", async () => {
    const { root, runtime, phone } = await cast();
    for (const party of [runtime, phone]) {
        const verified = await verifyChain(root.publicKey, party.chain, NOW);
        assert.equal(toHex(verified.principal), party.described.principal_id);
        assert.equal(toHex(verified.leaf.agreementKey), party.described.agreement_public);
    }
    const phoneLeaf = (await verifyChain(root.publicKey, phone.chain, NOW)).leaf;
    assert.deepEqual(phoneLeaf.scopes, [SCOPE.view, SCOPE.drive]);
    assert.equal(phoneLeaf.role, Role.ROLE_CLIENT);
});

test("the hello transcript is built byte for byte as the hub builds it", async () => {
    const { phone } = await cast();
    const transcript = helloTranscript(
        V.hello.hub,
        hex(V.hello.challenge_nonce),
        await principalId(phone.identity.publicKey),
        Role.ROLE_CLIENT,
        hex(V.hello.account_id),
    );
    assert.equal(toHex(transcript), V.hello.transcript);
    assert.ok(await verify(phone.identity.publicKey, LABEL.hello, transcript, hex(V.hello.signature)));
});

test("the sealed command opens for the runtime", async () => {
    const { root, runtime, phone } = await cast();
    const receiver = await receiverFor(runtime, root);
    const opened = await receiver.open(hex(phone.described.principal_id), hex(V.command.sealed), NOW);
    assert.equal(toHex(opened.body), V.command.body);
    assert.equal(opened.scope, V.command.scope);
    assert.equal(toHex(opened.nonce), V.command.nonce);
    assert.equal(opened.answers, null);
    assert.equal(opened.timeMs, V.command.time_ms);
});

test("the HPKE info is built as the vectors record it", async () => {
    const { runtime, phone } = await cast();
    const info = new Uint8Array([
        ...new TextEncoder().encode("wmlhub/seal/v1\0"),
        ...hex(phone.described.principal_id),
        ...hex(runtime.described.principal_id),
    ]);
    assert.equal(toHex(info), V.command.info);
});

test("the sealed result opens for the phone and names its command", async () => {
    const { root, runtime, phone } = await cast();
    const receiver = await receiverFor(phone, root);
    const opened = await receiver.open(hex(runtime.described.principal_id), hex(V.result.sealed), NOW);
    assert.equal(toHex(opened.body), V.result.body);
    assert.equal(toHex(opened.answers), V.command.nonce);
    assert.equal(opened.scope, "");
});

test("the grant opens, and the frame opens under the key it carried", async () => {
    const { root, runtime, phone } = await cast();
    const receiver = await receiverFor(phone, root);
    const grant = await receiver.openGrant(hex(runtime.described.principal_id), hex(V.grant.sealed), NOW);
    assert.equal(toHex(grant.key.bytes), V.grant.key);
    assert.equal(toHex(grant.key.id), V.grant.key_id);
    assert.equal(toHex(grant.channel), V.grant.channel);
    assert.equal(grant.fromCounter, V.grant.from_counter);
    assert.equal(toHex(grant.publisherKey), runtime.described.identity_public);

    const reader = new StreamReader(grant);
    const published = await reader.open(hex(V.frame.frame));
    assert.equal(toHex(published.batch), V.frame.batch);
    assert.equal(published.counter, V.frame.counter);
    assert.equal(published.skipped, 0);
});

test("a stream key id is derived from the key", async () => {
    const key = await StreamKey.fromBytes(hex(V.grant.key));
    assert.equal(toHex(key.id), V.grant.key_id);
});

test("channel names match, for every purpose and subject the vectors give", async () => {
    const key = await ChannelKey.fromBytes(hex(V.channel_key));
    for (const entry of V.channels) {
        assert.equal(toHex(await key.channel(entry.purpose, hex(entry.subject))), entry.channel, entry.purpose);
    }
});

test("a replayed command is refused, and one outside the clock window too", async () => {
    const { root, runtime, phone } = await cast();
    const receiver = await receiverFor(runtime, root);
    const from = hex(phone.described.principal_id);
    await receiver.open(from, hex(V.command.sealed), NOW);
    await assert.rejects(() => receiver.open(from, hex(V.command.sealed), NOW), /replay/);
    const fresh = await receiverFor(runtime, root);
    await assert.rejects(() => fresh.open(from, hex(V.command.sealed), NOW + 60_001), /clock/);
});

test("what this implementation seals, it opens, for every shape the protocol has", async () => {
    const { root, runtime, phone } = await cast();
    const phoneId = await principalId(phone.identity.publicKey);
    const runtimeId = await principalId(runtime.identity.publicKey);
    const sender = { identity: phone.identity, chain: phone.chain };
    const publisher = { identity: runtime.identity, chain: runtime.chain };
    const toRuntime = { principal: runtimeId, agreementKey: runtime.agreement.publicKey };
    const toPhone = { principal: phoneId, agreementKey: phone.agreement.publicKey };

    const { sealed, nonce } = await sealCommand(sender, toRuntime, SCOPE.drive, new TextEncoder().encode("go"), NOW);
    const runtimeReceiver = await receiverFor(runtime, root);
    const command = await runtimeReceiver.open(phoneId, sealed, NOW);
    assert.equal(new TextDecoder().decode(command.body), "go");

    const result = await sealResult(publisher, toPhone, nonce, new TextEncoder().encode("done"), NOW);
    const phoneReceiver = await receiverFor(phone, root);
    const answered = await phoneReceiver.open(runtimeId, result, NOW);
    assert.equal(toHex(answered.answers), toHex(nonce));

    const channel = await (await ChannelKey.generate()).channel("events", new Uint8Array([1, 2, 3]));
    const key = await StreamKey.generate();
    const grant = await wrapKey(publisher, toPhone, channel, key, 1, NOW);
    const opened = await phoneReceiver.openGrant(runtimeId, grant, NOW);
    const reader = new StreamReader(opened);
    const frame = await sealFrame(publisher, channel, key, 1, new TextEncoder().encode("events"));
    assert.equal(new TextDecoder().decode((await reader.open(frame)).batch), "events");
});

test("a frame is refused when it is moved, renumbered or forged", async () => {
    const { root, runtime, phone } = await cast();
    const receiver = await receiverFor(phone, root);
    const grant = await receiver.openGrant(hex(runtime.described.principal_id), hex(V.grant.sealed), NOW);
    const key = grant.key;
    const publisher = { identity: runtime.identity, chain: runtime.chain };
    const forger = { identity: phone.identity, chain: phone.chain };

    const elsewhere = await sealFrame(publisher, new Uint8Array(grant.channel.length).fill(7), key, 1, new Uint8Array([1]));
    await assert.rejects(() => new StreamReader(grant).open(elsewhere), /signature/, "moved to another channel");

    const forged = await sealFrame(forger, grant.channel, key, 1, new Uint8Array([1]));
    await assert.rejects(() => new StreamReader(grant).open(forged), /signature/, "signed by another device");

    const reader = new StreamReader(grant);
    await reader.open(hex(V.frame.frame));
    await assert.rejects(() => reader.open(hex(V.frame.frame)), /out of order/, "replayed");

    const flipped = hex(V.frame.frame);
    flipped[flipped.length - 1] ^= 1;
    await assert.rejects(() => new StreamReader(grant).open(flipped), /signature|malformed/, "a flipped bit");
});

// ------------------------------ the budgets, after the UI session's review of #129 ------------------------------

test("one sender's flood cannot refuse another sender's commands", async () => {
    const { ReplayWindow } = await import("../src/hub/seal.ts");
    const w = new ReplayWindow(8, 2);
    const [noisy, quiet] = [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)];
    const nonce = (n) => new Uint8Array(16).fill(n);
    w.admit(noisy, nonce(1), NOW);
    w.admit(noisy, nonce(2), NOW);
    assert.throws(() => w.admit(noisy, nonce(3), NOW), /busy/, "it filled its own share");
    w.admit(quiet, nonce(1), NOW);
    w.admit(quiet, nonce(2), NOW);
    assert.throws(() => w.admit(quiet, nonce(9), NOW), /busy/, "and only its own");
});

test("a sender's share comes back when its nonces age out, and the ceiling still holds", async () => {
    const { ReplayWindow, CLOCK_WINDOW_MS } = await import("../src/hub/seal.ts");
    const nonce = (n) => new Uint8Array(16).fill(n);
    const one = new ReplayWindow(8, 1);
    one.admit(new Uint8Array(32).fill(1), nonce(1), NOW);
    assert.throws(() => one.admit(new Uint8Array(32).fill(1), nonce(2), NOW), /busy/);
    one.admit(new Uint8Array(32).fill(1), nonce(2), NOW + 2 * CLOCK_WINDOW_MS + 1);

    const ceiling = new ReplayWindow(2, 8);
    ceiling.admit(new Uint8Array(32).fill(1), nonce(1), NOW);
    ceiling.admit(new Uint8Array(32).fill(2), nonce(1), NOW);
    assert.throws(() => ceiling.admit(new Uint8Array(32).fill(3), nonce(1), NOW), /busy/);
});

test("a frame before the counter its grant covers is refused", async () => {
    // A device paired this morning is granted the stream from where it joined; the ring still holds last night.
    const { root, runtime, phone } = await cast();
    const key = await StreamKey.generate();
    const channel = await (await ChannelKey.generate()).channel("events", new Uint8Array([1]));
    const publisher = { identity: runtime.identity, chain: runtime.chain };
    const to = { principal: hex(phone.described.principal_id), agreementKey: phone.agreement.publicKey };
    const wrapped = await wrapKey(publisher, to, channel, key, 5, NOW);
    const grant = await (await receiverFor(phone, root)).openGrant(hex(runtime.described.principal_id), wrapped, NOW);
    const reader = new StreamReader(grant);

    const tooEarly = await sealFrame(publisher, channel, key, 4, new TextEncoder().encode("last night"));
    await assert.rejects(() => reader.open(tooEarly), /before grant/);
    const granted = await sealFrame(publisher, channel, key, 5, new TextEncoder().encode("since"));
    const opened = await reader.open(granted);
    assert.equal(opened.counter, 5, "the edge is inside");
});

test("a grant naming a channel the hub would not route is refused", async () => {
    const { MAX_CHANNEL_BYTES } = await import("../src/hub/seal.ts");
    const { root, runtime, phone } = await cast();
    const key = await StreamKey.generate();
    const publisher = { identity: runtime.identity, chain: runtime.chain };
    const to = { principal: hex(phone.described.principal_id), agreementKey: phone.agreement.publicKey };
    for (const channel of [new Uint8Array(), new Uint8Array(MAX_CHANNEL_BYTES + 1).fill(7)]) {
        const wrapped = await wrapKey(publisher, to, channel, key, 1, NOW);
        const receiver = await receiverFor(phone, root);
        await assert.rejects(() => receiver.openGrant(hex(runtime.described.principal_id), wrapped, NOW), /malformed/,
            `${channel.length} bytes`);
    }
});

test("the probe that checks a seed signs under its own label, not under hello's", async () => {
    const { LABEL, identityFromSeed, verify } = await import("../src/hub/keys.ts");
    assert.notEqual(LABEL.probe, LABEL.hello);
    const d = V.principals.phone;
    const identity = await identityFromSeed(hex(d.identity_seed), hex(d.identity_public));
    const probe = new TextEncoder().encode("does this key belong to this seed");
    const { sign } = await import("../src/hub/keys.ts");
    const signature = await sign(identity, LABEL.probe, probe);
    assert.ok(await verify(identity.publicKey, LABEL.probe, probe, signature));
    assert.ok(!(await verify(identity.publicKey, LABEL.hello, probe, signature)), "and it is not a hello signature");
});

test("a mismatched seed and public key are caught at once", async () => {
    const { identityFromSeed } = await import("../src/hub/keys.ts");
    const [a, b] = [V.principals.phone, V.principals.runtime];
    await assert.rejects(() => identityFromSeed(hex(a.identity_seed), hex(b.identity_public)), /does not belong/);
});

test("replyTo answers a command with the key the sender's own certificate bound", async () => {
    const { replyTo } = await import("../src/hub/seal.ts");
    const { root, runtime, phone } = await cast();
    const receiver = await receiverFor(runtime, root);
    const opened = await receiver.open(hex(phone.described.principal_id), hex(V.command.sealed), NOW);
    const back = replyTo(opened);
    assert.equal(toHex(back.principal), phone.described.principal_id);
    assert.equal(toHex(back.agreementKey), phone.described.agreement_public);
});

// ------------------------------ expiry, which is the revocation that needs nobody online ------------------------

test("a certificate without a window, or with too long a one, is refused", async () => {
    const { MAX_CERTIFICATE_MS, issueCertificate, verifyChain, generateIdentity } = await import("../src/hub/keys.ts");
    const { generateAgreementKey } = await import("../src/hub/hpke.ts");
    const root = await generateIdentity();
    const device = await generateIdentity();
    const agreement = await generateAgreementKey();
    const base = {
        subject: device.publicKey,
        agreementKey: agreement.publicKey,
        role: Role.ROLE_CLIENT,
        scopes: [SCOPE.view],
        notBeforeMs: NOW,
        notAfterMs: NOW + 1000,
    };
    // the issuer refuses to make one, so a caller learns at issuance rather than at somebody else's verifier
    await assert.rejects(() => issueCertificate(root, { ...base, notAfterMs: 0 }), /window/);
    await assert.rejects(() => issueCertificate(root, { ...base, notBeforeMs: 0 }), /window/);
    await assert.rejects(
        () => issueCertificate(root, { ...base, notAfterMs: NOW + MAX_CERTIFICATE_MS + 1 }),
        /longer than/,
    );
    // and a verifier refuses one that was made anyway
    const longest = await issueCertificate(root, { ...base, notAfterMs: NOW + MAX_CERTIFICATE_MS });
    assert.ok(await verifyChain(root.publicKey, [longest], NOW), "the longest window there is, at its edge");
    await assert.rejects(() => verifyChain(root.publicKey, [longest], NOW + MAX_CERTIFICATE_MS + 1), /not valid now/);
});

test("a box connector may neither pair nor approve", async () => {
    const { BOX_CONNECTOR_FORBIDS, issueCertificate, verifyChain, generateIdentity } = await import("../src/hub/keys.ts");
    const { generateAgreementKey } = await import("../src/hub/hpke.ts");
    const root = await generateIdentity();
    const box = await generateIdentity();
    const agreement = await generateAgreementKey();
    const spec = (extra) => ({
        subject: box.publicKey,
        agreementKey: agreement.publicKey,
        role: Role.ROLE_BOX_CONNECTOR,
        scopes: [SCOPE.view],
        notBeforeMs: NOW,
        notAfterMs: NOW + 1000,
        ...extra,
    });
    // signed around the issuer, which refuses these too: what is under test here is the VERIFIER
    const { CertificateBody } = await import("../src/proto/wmlhub/v1/identity.gen.ts");
    const { sign, LABEL } = await import("../src/hub/keys.ts");
    const signed = async (extra) => {
        const body = CertificateBody.encode({
            subject: spec(extra).subject,
            agreementKey: spec(extra).agreementKey,
            issuer: root.publicKey,
            role: spec(extra).role,
            scopes: spec(extra).scopes,
            mayPair: spec(extra).mayPair ?? false,
            notBeforeMs: spec(extra).notBeforeMs,
            notAfterMs: spec(extra).notAfterMs,
            label: "",
        }).finish();
        return { body, signature: await sign(root, LABEL.certificate, body) };
    };
    const chain = async (extra) => verifyChain(root.publicKey, [await signed(extra)], NOW);
    await assert.rejects(() => chain({ mayPair: true }), /may pair or approve/);
    for (const forbidden of BOX_CONNECTOR_FORBIDS) {
        await assert.rejects(() => chain({ scopes: [SCOPE.view, forbidden] }), /may pair or approve/, forbidden);
    }
    assert.ok(await chain({}), "what it may hold");
    // the same scope on a client is fine: the rule is about the role, not the names
    assert.ok(await chain({ role: Role.ROLE_CLIENT, scopes: [SCOPE.approve] }));
    assert.ok(await verifyChain(root.publicKey, [await issueCertificate(root, spec({}))], NOW), "and it issues");
});

test("the issuer refuses a box connector that may pair or approve, not only the verifier", async () => {
    // Reported by the UI session against #135: verifyChain refused these and issueCertificate did not, so an issuer
    // would happily mint a certificate every verifier then rejects.
    const { issueCertificate, generateIdentity, BOX_CONNECTOR_FORBIDS } = await import("../src/hub/keys.ts");
    const { generateAgreementKey } = await import("../src/hub/hpke.ts");
    const root = await generateIdentity();
    const box = await generateIdentity();
    const agreement = await generateAgreementKey();
    const spec = (extra) => ({
        subject: box.publicKey,
        agreementKey: agreement.publicKey,
        role: Role.ROLE_BOX_CONNECTOR,
        scopes: [SCOPE.view],
        notBeforeMs: NOW,
        notAfterMs: NOW + 1000,
        ...extra,
    });
    await assert.rejects(() => issueCertificate(root, spec({ mayPair: true })), /neither pair nor approve/);
    for (const forbidden of BOX_CONNECTOR_FORBIDS) {
        await assert.rejects(
            () => issueCertificate(root, spec({ scopes: [SCOPE.view, forbidden] })),
            /neither pair nor approve/,
            forbidden,
        );
    }
    assert.ok(await issueCertificate(root, spec({})), "what it may hold is still issued");
});

test("what only the root may grant does not travel through a delegate", async () => {
    const { NEVER_DELEGABLE, issueCertificate, verifyChain, generateIdentity } = await import("../src/hub/keys.ts");
    const { generateAgreementKey } = await import("../src/hub/hpke.ts");
    const root = await generateIdentity();
    const [laptop, phone] = [await generateIdentity(), await generateIdentity()];
    const agreement = await generateAgreementKey();
    const spec = (subject, extra) => ({
        subject,
        agreementKey: agreement.publicKey,
        role: Role.ROLE_CLIENT,
        scopes: [SCOPE.view],
        notBeforeMs: NOW,
        notAfterMs: NOW + 1000,
        ...extra,
    });
    for (const never of NEVER_DELEGABLE) {
        const held = [SCOPE.view, never];
        const delegate = await issueCertificate(root, spec(laptop.publicKey, { mayPair: true, scopes: held }));
        const leaf = await issueCertificate(laptop, spec(phone.publicKey, { scopes: held }));
        await assert.rejects(
            () => verifyChain(root.publicKey, [leaf, delegate], NOW),
            /only the root may grant/,
            `${never}, even from a delegate that holds it`,
        );
        // and straight from the root it is fine, which is the point
        const direct = await issueCertificate(root, spec(phone.publicKey, { scopes: held }));
        assert.ok(await verifyChain(root.publicKey, [direct], NOW), `${never} from the root`);
    }
});

// --- renewal: the case a verifier that does not know it REFUSES, on its own surface only ---

test("a renewal by a delegate verifies, and grants a scope only the root may give", async () => {
    // The failure this prevents: a runtime renews a phone holding `approve`, and a verifier enforcing the ordinary
    // rules reads it as "a delegate issued a scope only the root may grant" and refuses. Correctly, by those rules.
    // The device just stops working, on this surface only, and it looks like a pairing bug.
    const { root } = await cast();
    const renewed = Certificate.decode(hex(V.renewal.renewed));
    const delegate = Certificate.decode(hex(V.renewal.delegate));

    const verified = await verifyChain(root.publicKey, [renewed, delegate], V.renewal.verify_at_ms);
    for (const scope of V.renewal.scopes) {
        assert.ok(verified.leaf.scopes.includes(scope), `the renewed leaf holds ${scope}`);
    }
});

test("the three ways to pass the renewal check by accident", async () => {
    const { root } = await cast();
    const renewed = Certificate.decode(hex(V.renewal.renewed));
    const delegate = Certificate.decode(hex(V.renewal.delegate));
    const before = Certificate.decode(hex(V.renewal.before));

    // 1. The predecessor is EXPIRED at that time, and its window must not be checked — which is what makes the
    //    exemption worth anything, since an expired predecessor is the whole reason to renew.
    await assert.rejects(
        () => verifyChain(root.publicKey, [before], V.renewal.verify_at_ms),
        /not valid now/,
        "the predecessor on its own fails at that time, so not checking its window is a real decision",
    );

    // 2. The predecessor must verify under the ACCOUNT ROOT. Under a delegate, renewals chain: renew something
    //    narrow, then renew THAT with more, and the exemption walks itself wider.
    const underDelegate = CertificateBody.decode(renewed.body);
    assert.ok(underDelegate.renews, "the renewal carries its predecessor");
    const priorBody = CertificateBody.decode(underDelegate.renews.body);
    assert.deepEqual([...priorBody.issuer], [...root.publicKey], "and that predecessor was issued by the root");

    // 3. Every other field equal, `agreement_key` above all: it is where sealed commands go, so a renewal free to
    //    change it redirects everything sealed to an approver into a key the renewer holds.
    assert.deepEqual([...CertificateBody.decode(renewed.body).agreementKey], [...priorBody.agreementKey]);
    assert.deepEqual([...CertificateBody.decode(renewed.body).subject], [...priorBody.subject]);
    assert.deepEqual(CertificateBody.decode(renewed.body).scopes, priorBody.scopes);

    // A renewal that changed the agreement key is refused. Forged here rather than asserted about, because this is
    // the one whose absence would be silent: everything would keep verifying and the seals would go elsewhere.
    const tampered = CertificateBody.decode(renewed.body);
    tampered.agreementKey = new Uint8Array(32).fill(9);
    await assert.rejects(
        () => verifyChain(root.publicKey, [{ body: CertificateBody.encode(tampered).finish(), signature: renewed.signature }, delegate], V.renewal.verify_at_ms),
        /did not verify|changed something other than/,
        "a renewal may not move where sealed commands go",
    );
});

test("the ROOT may renew its own grant, which is the only way `may_revoke` gets a new window", async () => {
    // Refusing this was my own addition and it was wrong in the worst place. The two rules a renewal is exempt from
    // only run when a certificate HAS A PARENT, so a root-issued one was never subject to them — there is nothing
    // to exempt, and the predecessor is a check that would not otherwise exist.
    //
    // It is load-bearing because `may_revoke` may not be renewed by a DELEGATE, by design. So the root renewing its
    // own grant is the only way the account's revoker gets a new window, and refusing it fails on exactly the row
    // whose lapse costs the account its ability to revoke.
    const { root } = await cast();
    const subject = await identityFromSeed(hex(V.principals.phone.identity_seed), hex(V.principals.phone.identity_public));
    const agreement = await agreementKeyFromSeed(hex(V.principals.phone.agreement_seed));
    const spec = {
        subject: subject.publicKey, agreementKey: agreement.publicKey,
        role: Role.ROLE_CLIENT, scopes: [SCOPE.approve], mayRevoke: true, label: "the revoker",
    };
    const { issueCertificate } = await import("../src/hub/keys.ts");
    const lapsed = await issueCertificate(root, { ...spec, notBeforeMs: 1_000_000, notAfterMs: 2_000_000 });
    const renewed = await issueCertificate(root, { ...spec, notBeforeMs: 5_000_000, notAfterMs: 6_000_000, renews: lapsed });

    const verified = await verifyChain(root.publicKey, [renewed], 5_500_000);
    assert.equal(verified.leaf.mayRevoke, true, "the revoker keeps what only the root can give it");

    // The predecessor is still CHECKED, which is the point: a root renewal that changed something is refused.
    const widened = await issueCertificate(root, { ...spec, scopes: [SCOPE.approve, SCOPE.drive], notBeforeMs: 5_000_000, notAfterMs: 6_000_000, renews: lapsed });
    await assert.rejects(() => verifyChain(root.publicKey, [widened], 5_500_000), /changed something other than/);
});

test("`install` is root-only: a delegate that may pair still cannot hand it out", async () => {
    // It is more persistent than `approve`, and REVOCATION CANNOT UNDO IT — revoking a phone stops it commanding but
    // leaves what it caused to be installed. So a delegate minting `install` would create effects that outlive both
    // the delegation and its own revocation.
    const { NEVER_DELEGABLE, issueCertificate, generateIdentity } = await import("../src/hub/keys.ts");
    assert.ok(NEVER_DELEGABLE.includes("install"));

    const { root } = await cast();
    const laptop = await generateIdentity();
    const phone = await generateIdentity();
    const agree = (await agreementKeyFromSeed(hex(V.principals.phone.agreement_seed))).publicKey;
    const window = { notBeforeMs: 1_000_000, notAfterMs: 2_000_000 };

    // The root makes the laptop a delegate that may pair, and gives it `install` for itself.
    const delegate = await issueCertificate(root, { subject: laptop.publicKey, agreementKey: agree, role: Role.ROLE_CLIENT, scopes: [SCOPE.view, SCOPE.install], mayPair: true, ...window });
    // The laptop then tries to pass `install` on.
    const minted = await issueCertificate(laptop, { subject: phone.publicKey, agreementKey: agree, role: Role.ROLE_CLIENT, scopes: [SCOPE.install], ...window });

    await assert.rejects(
        () => verifyChain(root.publicKey, [minted, delegate], 1_500_000),
        /a delegate issued a scope only the root may grant/,
    );
    // The root granting it directly is fine: that is the person deciding, at the root.
    const direct = await issueCertificate(root, { subject: phone.publicKey, agreementKey: agree, role: Role.ROLE_CLIENT, scopes: [SCOPE.install], ...window });
    assert.ok((await verifyChain(root.publicKey, [direct], 1_500_000)).leaf.scopes.includes("install"));
});

test("`may_revoke` is the one power a delegate may neither ISSUE nor RENEW — and `install` it may renew", async () => {
    // `may_revoke` is a boolean, not a scope, so `NEVER_DELEGABLE` never covered it and this verifier used to accept a
    // delegate minting one while the hub refused it. Once revocation lists exist, that is a forged revoker accepted.
    const { issueCertificate, generateIdentity } = await import("../src/hub/keys.ts");
    const { root } = await cast();
    const laptop = await generateIdentity();
    const phone = await generateIdentity();
    const agree = (await agreementKeyFromSeed(hex(V.principals.phone.agreement_seed))).publicKey;
    const win = (a, b) => ({ notBeforeMs: a, notAfterMs: b });
    const delegate = await issueCertificate(root, { subject: laptop.publicKey, agreementKey: agree, role: Role.ROLE_CLIENT, scopes: [SCOPE.view, SCOPE.approve, SCOPE.install], mayPair: true, ...win(1_000_000, 9_000_000) });

    // 1. A delegate ISSUING it.
    const minted = await issueCertificate(laptop, { subject: phone.publicKey, agreementKey: agree, role: Role.ROLE_CLIENT, scopes: [SCOPE.view], mayRevoke: true, ...win(1_000_000, 2_000_000) });
    await assert.rejects(() => verifyChain(root.publicKey, [minted, delegate], 1_500_000), /may_revoke/);

    // 2. A delegate RENEWING the root's own grant of it. The renewal exemption must not wave this through: exclusivity
    //    is the whole value of a revoker, and a delegate able to keep one alive would be a second way to hold it.
    const rootGrant = await issueCertificate(root, { subject: phone.publicKey, agreementKey: agree, role: Role.ROLE_CLIENT, scopes: [SCOPE.view], mayRevoke: true, ...win(1_000_000, 2_000_000) });
    const renewedByDelegate = await issueCertificate(laptop, { subject: phone.publicKey, agreementKey: agree, role: Role.ROLE_CLIENT, scopes: [SCOPE.view], mayRevoke: true, renews: rootGrant, ...win(3_000_000, 4_000_000) });
    await assert.rejects(() => verifyChain(root.publicKey, [renewedByDelegate, delegate], 3_500_000), /may_revoke/);

    // 3. The case to MATCH the hub on, not to over-correct: a delegate may renew a grant carrying `install`. Renewal
    //    re-issues what the root already granted and creates nothing, so the reason `install` is never delegable — a
    //    new, irreversible grant — does not apply to keeping an existing one alive. Refusing it here would make a
    //    runtime's renewal of a phone holding `install` a chain the hub accepts and this refuses.
    const installGrant = await issueCertificate(root, { subject: phone.publicKey, agreementKey: agree, role: Role.ROLE_CLIENT, scopes: [SCOPE.view, SCOPE.install], ...win(1_000_000, 2_000_000) });
    const renewedInstall = await issueCertificate(laptop, { subject: phone.publicKey, agreementKey: agree, role: Role.ROLE_CLIENT, scopes: [SCOPE.view, SCOPE.install], renews: installGrant, ...win(3_000_000, 4_000_000) });
    const v = await verifyChain(root.publicKey, [renewedInstall, delegate], 3_500_000);
    assert.ok(v.leaf.scopes.includes("install"), "a delegate keeps an existing `install` grant alive");
});

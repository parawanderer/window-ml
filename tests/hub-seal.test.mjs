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
const { Certificate, Role } = await import("../src/proto/wmlhub/v1/identity.gen.ts");

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
    assert.equal(V.version, 1);
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

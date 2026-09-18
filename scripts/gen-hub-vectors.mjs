#!/usr/bin/env node
// Vectors produced by THIS implementation, for window-ml-hub's Rust one to open.
//
// `tests/hub-seal.test.mjs` proves this side opens what Rust produced. That is half of interoperating: the other half
// is Rust opening what this side produces, and neither HPKE nor Ed25519 lets you replay the randomness, so it needs
// vectors generated here. This writes them.
//
//   node scripts/gen-hub-vectors.mjs > ../window-ml-hub/vectors/seal-ts-v1.json
//
// The parties are the ones window-ml-hub's own `vectors/seal-v1.json` describes, from the same seeds, so the Rust test
// rebuilds the cast from its own constants and only has to open what is here.
import { readFileSync } from "node:fs";

const { agreementKeyFromSeed } = await import("../src/hub/hpke.ts");
const { identityFromSeed, principalId, SCOPE } = await import("../src/hub/keys.ts");
const { StreamKey, ChannelKey, sealCommand, sealResult, wrapKey, sealFrame } = await import("../src/hub/seal.ts");
const { Certificate } = await import("../src/proto/wmlhub/v1/identity.gen.ts");

const V = JSON.parse(readFileSync(new URL("../tests/fixtures/hub/seal-v1.json", import.meta.url), "utf8"));
const hex = (s) => new Uint8Array(s.match(/../g)?.map((b) => parseInt(b, 16)) ?? []);
const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const NOW = V.suite.time_ms;

async function party(name) {
    const d = V.principals[name];
    return {
        identity: await identityFromSeed(hex(d.identity_seed), hex(d.identity_public)),
        agreement: await agreementKeyFromSeed(hex(d.agreement_seed)),
        chain: [Certificate.decode(hex(d.certificate))],
        principal: hex(d.principal_id),
    };
}

const runtime = await party("runtime");
const phone = await party("phone");
const sender = (p) => ({ identity: p.identity, chain: p.chain });
const recipient = (p) => ({ principal: p.principal, agreementKey: p.agreement.publicKey });

const body = new TextEncoder().encode("session.send from the browser");
const { sealed: command, nonce } = await sealCommand(sender(phone), recipient(runtime), SCOPE.drive, body, NOW);
const resultBody = new TextEncoder().encode("sent");
const result = await sealResult(sender(runtime), recipient(phone), nonce, resultBody, NOW);

const channelKey = await ChannelKey.fromBytes(hex(V.channel_key));
const channel = await channelKey.channel("events", new TextEncoder().encode("5f3a9c21"));
const key = await StreamKey.fromBytes(hex(V.grant.key));
const grant = await wrapKey(sender(runtime), recipient(phone), channel, key, 1, NOW);
const batch = new TextEncoder().encode("events from the browser");
const frame = await sealFrame(sender(runtime), channel, key, 1, batch);

const vectors = {
    version: 1,
    what: "Vectors produced by window-ml's TypeScript implementation (src/hub), for the Rust side to open. Hex throughout.",
    produced_by: "window-ml scripts/gen-hub-vectors.mjs",
    parties: "the runtime and phone of window-ml-hub vectors/seal-v1.json, from the same seeds",
    time_ms: NOW,
    command: {
        from: "phone",
        to: "runtime",
        scope: SCOPE.drive,
        body: toHex(body),
        nonce: toHex(nonce),
        sealed: toHex(command),
    },
    result: { from: "runtime", to: "phone", answers: toHex(nonce), body: toHex(resultBody), sealed: toHex(result) },
    grant: { from: "runtime", to: "phone", channel: toHex(channel), key: V.grant.key, from_counter: 1, sealed: toHex(grant) },
    frame: { publisher: "runtime", channel: toHex(channel), counter: 1, batch: toHex(batch), frame: toHex(frame) },
    channels: V.channels.map((c) => ({ ...c })),
};
process.stdout.write(`${JSON.stringify(vectors, null, 2)}\n`);

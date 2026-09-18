// HPKE against the RFC's own vector, before anything of ours is in the way.
//
// `src/hub/hpke.ts` assembles RFC 9180 base mode out of what WebCrypto has, because WebCrypto has no HPKE. That is the
// piece most likely to be subtly wrong, and the failure it produces everywhere else is "the ciphertext did not open",
// which says nothing about why. So it is checked here first, against the vector for this exact suite
// (DHKEM(X25519, HKDF-SHA256) 0x0020, HKDF-SHA256 0x0001, AES-256-GCM 0x0002, mode base) from the CFRG draft's
// `test-vectors.json` — the same vector the Rust implementation is checked against
// (window-ml-hub `crates/seal/src/rfc9180_vector.rs`).
import { test } from "node:test";
import assert from "node:assert/strict";

const { agreementKeyFromSeed, importAgreementKey, seal, open, generateAgreementKey } = await import(
    "../src/hub/hpke.ts"
);

const hex = (s) => new Uint8Array(s.match(/../g).map((b) => parseInt(b, 16)));
const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

const VECTOR = {
    info: "4f6465206f6e2061204772656369616e2055726e",
    ikmR: "dac33b0e9db1b59dbbea58d59a14e7b5896e9bdf98fad6891e99d1686492b9ee",
    skRm: "497b4502664cfea5d5af0b39934dac72242a74f8480451e1aee7d6a53320333d",
    pkRm: "430f4b9859665145a6b1ba274024487bd66f03a2dd577d7753c68d7d7d00c00c",
    enc: "6c93e09869df3402d7bf231bf540fadd35cd56be14f97178f0954db94b7fc256",
    aad: "436f756e742d30",
    ct: "e5d84cd531cfb583096e7cfa9641bd3079cf3a91cda813c52deb5f512be9931980a41de125a925cdad859d5b7a",
    pt: "4265617574792069732074727574682c20747275746820626561757479",
};

test("DeriveKeyPair gives the RFC's key pair from the RFC's seed", async () => {
    const key = await agreementKeyFromSeed(hex(VECTOR.ikmR));
    assert.equal(toHex(key.publicKey), VECTOR.pkRm);
});

test("a private key imported from its scalar has the matching public key", async () => {
    const key = await importAgreementKey(hex(VECTOR.skRm));
    assert.equal(toHex(key.publicKey), VECTOR.pkRm);
});

test("the RFC's ciphertext opens to the RFC's plaintext", async () => {
    const key = await importAgreementKey(hex(VECTOR.skRm));
    const plaintext = await open(
        key,
        { enc: hex(VECTOR.enc), ciphertext: hex(VECTOR.ct) },
        hex(VECTOR.info),
        hex(VECTOR.aad),
    );
    assert.equal(toHex(plaintext), VECTOR.pt);
});

test("what this implementation seals, it opens", async () => {
    const recipient = await generateAgreementKey();
    const info = new TextEncoder().encode("wmlhub/test/v1\0");
    const aad = new Uint8Array([1, 2, 3]);
    const sealed = await seal(recipient.publicKey, info, hex(VECTOR.pt), aad);
    assert.equal(toHex(await open(recipient, sealed, info, aad)), VECTOR.pt);
});

test("it does not open for another key, another info, or another aad", async () => {
    const recipient = await generateAgreementKey();
    const other = await generateAgreementKey();
    const info = new TextEncoder().encode("wmlhub/test/v1\0");
    const sealed = await seal(recipient.publicKey, info, hex(VECTOR.pt));
    await assert.rejects(() => open(other, sealed, info), "another key");
    await assert.rejects(() => open(recipient, sealed, new TextEncoder().encode("other")), "another info");
    await assert.rejects(() => open(recipient, sealed, info, new Uint8Array([9])), "another aad");
});

test("every sealing of the same plaintext differs", async () => {
    const recipient = await generateAgreementKey();
    const info = new Uint8Array();
    const one = await seal(recipient.publicKey, info, hex(VECTOR.pt));
    const two = await seal(recipient.publicKey, info, hex(VECTOR.pt));
    assert.notEqual(toHex(one.enc), toHex(two.enc));
    assert.notEqual(toHex(one.ciphertext), toHex(two.ciphertext));
});

// secret-mask.test.mjs — the byte mask of Python's `/files` mount (src/secret-mask.ts): every match of a secret's form
// becomes as many `*` bytes, so the length and every offset stay. Spec: docs/spec/FILE_ATTACHMENTS.md, "Python's view:
// two mounts". The reader's use of it (the widened window, a match across reads) is in ranged-reader.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { maskSecretBytes, maskOverlap, MASK_BYTE } from "../src/secret-mask.ts";

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
const masked = (s, forms) => { const b = enc(s); const n = maskSecretBytes(b, forms); return { text: dec(b), n, len: b.length }; };

// --- what is masked ---

test("a form's every byte becomes `*`, the length unchanged, the rest untouched", () => {
    const { text, n, len } = masked("key=s3cr3t-value; next", [{ find: "s3cr3t-value" }]);
    assert.equal(text, "key=************; next");
    assert.equal(len, "key=s3cr3t-value; next".length);
    assert.equal(n, 1);
    assert.equal(MASK_BYTE, "*".charCodeAt(0));
});

test("every occurrence is masked, overlapping ones included, and a form of nothing is skipped", () => {
    assert.equal(masked("ab-s3cr3t-s3cr3t-cd", [{ find: "s3cr3t" }]).text, "ab-******-******-cd");
    assert.equal(masked("aaaaa", [{ find: "aaaa" }]).text, "*****", "two overlapping matches mask their union");
    assert.deepEqual(masked("plain", [{ find: "" }]), { text: "plain", n: 0, len: 5 });
    assert.deepEqual(masked("plain", []), { text: "plain", n: 0, len: 5 });
});

test("a ci form matches ASCII letters in any case and folds nothing else; a form without ci is exact", () => {
    assert.equal(masked("GET HTTP://HOST.example/x", [{ find: "http://host.EXAMPLE", ci: true }]).text, "GET *******************/x");
    assert.equal(masked("HUNTER2-horse", [{ find: "hunter2-horse" }]).text, "HUNTER2-horse");
    // É (C3 89) and é (C3 A9) are different bytes: folding only ASCII keeps every byte's offset.
    assert.equal(masked("pÉss-word-x", [{ find: "péss-word", ci: true }]).text, "pÉss-word-x");
});

test("a form with non-ASCII characters is matched as its UTF-8 bytes, each byte masked", () => {
    const { text, len } = masked("[pässwörd-ü]", [{ find: "pässwörd-ü" }]);
    assert.equal(len, enc("[pässwörd-ü]").length);
    assert.equal(text, `[${"*".repeat(enc("pässwörd-ü").length)}]`);
});

test("a GitHub token is masked with no form given", () => {
    const tok = `ghp_${"A".repeat(36)}`;
    assert.equal(masked(`token: ${tok} end`, []).text, `token: ${"*".repeat(tok.length)} end`);
});

test("binary bytes around a match are left exactly as they were", () => {
    const b = Uint8Array.from([0, 255, 128, ...enc("s3cr3t-value"), 7, 0x80, 0xff]);
    maskSecretBytes(b, [{ find: "s3cr3t-value" }]);
    assert.deepEqual([...b], [0, 255, 128, ...new Array(12).fill(0x2a), 7, 0x80, 0xff]);
});

// --- the overlap ---

test("the overlap is the longest form's UTF-8 length less one, at least the GitHub token's 266 less one", () => {
    assert.equal(maskOverlap([]), 265);
    assert.equal(maskOverlap([{ find: "short" }]), 265);
    assert.equal(maskOverlap([{ find: "x".repeat(400) }, { find: "y" }]), 399);
    assert.equal(maskOverlap([{ find: "é".repeat(200) }]), 399, "counted in bytes, not characters");
});

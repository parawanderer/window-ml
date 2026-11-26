// secret-mask.test.mjs — the byte mask of Python's `/files` mount (src/secret-mask.ts): every match of a secret's form
// becomes as many `*` bytes, so the length and every offset stay. Spec: docs/spec/FILE_ATTACHMENTS.md, "Python's view:
// two mounts". The reader's use of it (the widened window, a match across reads) is in ranged-reader.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { maskSecretBytes, maskOverlap, maskName, MASK_BYTE } from "../src/secret-mask.ts";

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

// --- maskName: a file name as /files shows it ---

test("a form in a name becomes its put", () => {
    assert.equal(maskName("dump-hunter2.txt", [{ find: "hunter2", put: "[REDACTED:DB_PASS]" }]), "dump-[REDACTED:DB_PASS].txt");
});

test("two forms in one name are each replaced by their own put", () => {
    const forms = [{ find: "alpha-secret", put: "[REDACTED:A]" }, { find: "beta-secret", put: "[REDACTED:B]" }];
    assert.equal(maskName("alpha-secret_beta-secret", forms), "[REDACTED:A]_[REDACTED:B]");
});

test("the longest form at a position wins over a shorter one that is its prefix", () => {
    const forms = [{ find: "abc", put: "[S]" }, { find: "abcdef", put: "[L]" }];
    assert.equal(maskName("x-abcdef-y", forms), "x-[L]-y");
    assert.equal(maskName("x-abcdef-y", [...forms].reverse()), "x-[L]-y", "the order of the forms does not matter");
});

test("a ci form matches in any ASCII case, a case-sensitive one does not", () => {
    assert.equal(maskName("a-HuNtEr2-b", [{ find: "hunter2", ci: true, put: "[P]" }]), "a-[P]-b");
    assert.equal(maskName("a-HuNtEr2-b", [{ find: "hunter2", put: "[P]" }]), "a-HuNtEr2-b");
});

test("a form with no put shows [REDACTED]", () => {
    assert.equal(maskName("k-secretval.txt", [{ find: "secretval" }]), "k-[REDACTED].txt");
});

test("a GitHub token in a name shows [a GitHub token]", () => {
    assert.equal(maskName(`t-ghp_${"a1B2".repeat(9)}.txt`, []), "t-[a GitHub token].txt");
});

test("a name with no match is returned unchanged", () => {
    assert.equal(maskName("plain.txt", [{ find: "nothere", put: "[X]" }]), "plain.txt");
    assert.equal(maskName("plain.txt", []), "plain.txt");
});

test("an empty find is ignored", () => {
    assert.equal(maskName("plain.txt", [{ find: "", put: "[X]" }]), "plain.txt");
    assert.equal(maskName("a-s3-b", [{ find: "", put: "[X]" }, { find: "s3", put: "[Y]" }]), "a-[Y]-b");
});

// SECRET SCRUB OF A TEXT RANGE (src/secret-scrub-range.ts): a ranged read of a file scrubs over a widened window and
// never returns a secret split across two reads.
import test from "node:test";
import assert from "node:assert/strict";
import { scrubRange, ScrubWindowTooLong, SCRUB_WHOLE_MAX } from "../src/secret-scrub-range.ts";
import { secretsOf, scrubSecrets } from "../src/secret-scrub.ts";

const T = { timeout: 20000 };

const KEY = "sk-abcdef1234567890XYZ";
const CONFIG = { chatUrl: "https://Chat.Example.com:8443/api/", apiKey: KEY, modelFilter: "^qwen3(:.*)?$" };
const SECRETS = secretsOf(CONFIG);
const TOKEN = "ghp_" + "a1B2c3D4e5".repeat(4);
const W = Math.max(...SECRETS.map((s) => s.find.length), 266);

/** A source over a string. */
const source = (s) => ({ length: s.length, slice: async (a, b) => s.slice(a, b) });

/** Deterministic pseudo-random numbers. */
function rng(seed) { return () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32; }

/** Reads `text` in consecutive ranges of the given sizes (cycled), each from the previous `consumed`. */
async function readAll(text, sizes, secrets = SECRETS) {
    let pos = 0, out = "", i = 0;
    while (pos < text.length) {
        const r = await scrubRange(source(text), pos, pos + sizes[i++ % sizes.length], secrets);
        assert.ok(r.consumed > pos, "a read always advances");
        out += r.text;
        pos = r.consumed;
    }
    return out;
}

/** A text with every secret form, at every offset against a chunk boundary. */
function haystack() {
    const forms = [
        "https://chat.example.com:8443/api/", "HTTPS://CHAT.EXAMPLE.COM:8443/api", "Chat.Example.com", "chat.example.com:8443",
        KEY, JSON.stringify(KEY).slice(1, -1), encodeURIComponent("https://chat.example.com:8443/api/"), "(/^qwen3(:.*)?$/)", TOKEN,
        "github_pat_" + "Z9_".repeat(20),
    ];
    let s = "";
    const r = rng(7);
    for (let n = 0; n < 60; n++) s += "x".repeat(Math.floor(r() * 40)) + forms[n % forms.length] + " ";
    return s;
}

// --- the whole text ---

test("the whole range equals scrubSecrets of the whole", T, async () => {
    const text = haystack();
    const r = await scrubRange(source(text), 0, text.length, SECRETS);
    assert.equal(r.text, scrubSecrets(text, SECRETS));
    assert.equal(r.consumed, text.length);
});

test("empty secrets return the range unchanged, clamped to the length", T, async () => {
    const r = await scrubRange(source("hello world"), 2, 500, []);
    assert.deepEqual(r, { text: "llo world", consumed: 11 });
});

// --- consecutive reads ---

test("consecutive reads of any size concatenate to the whole scrub", T, async () => {
    const text = haystack();
    const want = scrubSecrets(text, SECRETS);
    for (const n of [1, 2, 3, 7, 50, W - 1, W, W + 1, 2 * W, 1000, 5000, text.length])
        assert.equal(await readAll(text, [n]), want, `chunk ${n}`);
    const r = rng(42);
    for (let k = 0; k < 20; k++) {
        const sizes = Array.from({ length: 9 }, () => 1 + Math.floor(r() * 3 * W));
        assert.equal(await readAll(text, sizes), want, `sizes ${sizes}`);
    }
});

test("a secret placed at every offset against a chunk boundary is replaced once, whole", T, async () => {
    for (const secret of [KEY, "https://chat.example.com:8443/api/", TOKEN]) {
        for (let off = 0; off < 40; off++) {
            const text = "a".repeat(100 - off) + secret + "b".repeat(80);
            const got = await readAll(text, [100, 64]);
            assert.equal(got, scrubSecrets(text, SECRETS), `${secret.slice(0, 8)} at ${off}`);
        }
    }
});

test("a read starting mid-secret returns no fragment of it", T, async () => {
    const text = "head " + KEY + " tail";
    const mid = 5 + 8;
    const r = await scrubRange(source(text), mid, text.length, SECRETS);
    assert.equal(r.text, " tail");
    assert.ok(!r.text.includes(KEY.slice(8, 12)));
    const t = await scrubRange(source("x " + TOKEN + " y"), 6, 100, SECRETS);
    assert.equal(t.text, " y");
});

test("a secret running past the end extends consumed to its end", T, async () => {
    const text = "ab " + KEY + " cd";
    const r = await scrubRange(source(text), 0, 8, SECRETS);
    assert.equal(r.text, "ab [API key]");
    assert.equal(r.consumed, 3 + KEY.length);
    const next = await scrubRange(source(text), r.consumed, text.length, SECRETS);
    assert.equal(next.text, " cd");
});

test("a range wholly inside a secret is empty and consumes the secret", T, async () => {
    const text = "ab " + KEY + " cd";
    const r = await scrubRange(source(text), 6, 10, SECRETS);
    assert.deepEqual(r, { text: "", consumed: 3 + KEY.length });
});

// --- too long a form ---

test("a form past the ceiling: a large source is refused naming only the key", T, async () => {
    const key = "k".repeat(5000);
    const secrets = secretsOf({ apiKey: key });
    const big = { length: SCRUB_WHOLE_MAX + 1, slice: async () => assert.fail("must not read") };
    await assert.rejects(scrubRange(big, 0, 10, secrets), (e) => {
        assert.ok(e instanceof ScrubWindowTooLong);
        assert.equal(e.key, "apiKey");
        assert.ok(!e.message.includes(key) && !e.message.includes("5000") && !e.message.includes("kkkk"));
        assert.ok(e.message.includes("apiKey"));
        return true;
    });
});

test("a form past the ceiling: a source within the whole bound is scrubbed whole then cut", T, async () => {
    const key = "k".repeat(5000);
    const secrets = secretsOf({ apiKey: key });
    const text = "start " + key + " end " + key + " fin";
    const want = scrubSecrets(text, secrets);
    const r = await scrubRange(source(text), 3, 20, secrets);
    assert.equal(r.text, "rt [API key]");
    assert.equal(r.consumed, 6 + 5000);
    assert.equal(await readAll(text, [1000, 3000], secrets), want);
});

test("each setting's placeholder maps to its key", T, async () => {
    const big = { length: SCRUB_WHOLE_MAX + 1, slice: async () => "" };
    for (const [secrets, key] of [
        [[{ find: "u".repeat(5000), put: "[server]", ci: true }], "chatUrl"],
        [[{ find: "u".repeat(5000), put: "[price service]", ci: true }], "priceSnapshotUrl"],
        [[{ find: "u".repeat(5000), put: "([model filter])" }], "modelFilter"],
        [[{ find: "u".repeat(5000), put: "[model filter]" }], "modelFilter"],
    ]) await assert.rejects(scrubRange(big, 0, 1, secrets), (e) => e.key === key);
});

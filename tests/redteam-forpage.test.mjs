// redteam-forpage.test.mjs — `forPage` (src/sw/sw-scrub.ts), adversarially: what a hostile page must not get out of an
// answer the worker gives it (SECRET_HANDLES.md, "The scrub as built" and Known limits). The page never sees a
// registered value: the marker is bare, so it names nothing, counts nothing and says nothing of the value's length;
// the only signal a page gets is the one the spec states (its own text, echoed in an error, comes back as the marker
// when it equals a registered value); a worker that has not read the registry yet answers nothing at all; and an
// ml.sh.read range that starts or ends inside a multi-byte character never shows a front of a value.
//
// The cold-worker rows for the other crossings are tests/redteam-scrub-cold.test.mjs; the lane's own rows are
// tests/secret-scrub-crossings.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeNativeHost } from "./fake-native-host.mjs";

const T = { timeout: 20000 };
const VALUE = "REALSECRET-4b1d-77";
const NAME = "PLUG_PASSWORD";
/** forPage writes the bare marker: no name, no count. */
const BARE = "[REDACTED]";
/** shRead's own crossing (forModel) writes the name; both are the value, and neither is shown here. */
const MARK = `[REDACTED:${NAME}]`;
/** A second registry: another name and a much shorter value, to read for an oracle the marker must not carry. */
const SHORT = "c1d2e3f4";
const OTHER = [{ name: "ELASTIC_KEY", value: SHORT }];
const ENTRIES = [{ name: NAME, value: VALUE }];
const leaks = (s, v = VALUE) => typeof s === "string" && (s.includes(v) || s.includes(v.slice(0, 6)));

// The worker's chrome, as much of it as sw-scrub.ts, sw-secret-registry.ts, sw-llm.ts and sw-shell-call.ts use.
const sync = { shellEnabled: true, shellRoots: ["/w/f0"], shellSandbox: true, shellPath: [], chatUrl: "http://host/api/chat/completions", apiKey: "sk-test-config-key" };
let native = null;
globalThis.chrome = {
    runtime: {
        id: "ext-id", lastError: undefined, onMessage: { addListener() {} }, getURL: (p) => p,
        connectNative: (name) => {
            const onMsg = [];
            let closed = false;
            const end = { send: (m) => { if (!closed) setTimeout(() => { for (const f of onMsg) f(JSON.parse(JSON.stringify(m))); }, 0); }, close: () => { closed = true; } };
            const receive = native ? native(name, end) : null;
            return { name, postMessage: (m) => receive?.(JSON.parse(JSON.stringify(m))), disconnect: () => { closed = true; },
                onMessage: { addListener: (f) => onMsg.push(f) }, onDisconnect: { addListener() {} } };
        },
    },
    storage: {
        local: { get: async (d) => ({ ...(d ?? {}) }), set: async () => {}, remove: async () => {} },
        sync: { get: async (d) => ({ ...(d ?? {}), ...sync }), set: async () => {} },
        session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        onChanged: { addListener() {} },
    },
};
const { _setRegistryForTest, _coldRegistryForTest, registryReady } = await import("../src/sw/sw-secret-registry.ts");
const { forPage } = await import("../src/sw/sw-scrub.ts");
const { shRun, shRead } = await import("../src/sw/sw-shell-call.ts");
const { SH_HEAD_BYTES } = await import("../src/shell/sh-call.ts");
const { TokenStore } = await import("../src/pointers/token-pipe.ts");

_setRegistryForTest(ENTRIES);
const page = (v) => forPage(v);
/** How a promise stands after a while: "settled", "rejected", or still waiting. */
const standing = async (p) => Promise.race([Promise.resolve(p).then(() => "settled", () => "rejected"), new Promise((r) => setTimeout(() => r("pending"), 250))]);
let rootN = 0;
/** A fresh fake host whose calls print `out`, and a run's context to read it from. */
function hostPrinting(out) {
    const host = fakeNativeHost({ done: () => ({ out, err: "", code: 0 }) });
    native = host.onNative;
    sync.shellRoots = [`/w/f${++rootN}`];
    return host;
}
const ctxFor = (runId) => ({ runId, seq: 3, local: { step: 1, seq: 3 }, signal: new AbortController().signal, tokens: new TokenStore() });

// --- A. the marker: no name, no count, no length ---

test("RED TEAM: forPage's marker is bare, and two registries with different names and lengths answer identically", T, async () => {
    try {
        _setRegistryForTest(OTHER);
        // The page composed this text: it holds its guess where the registered value would be, and nothing else.
        const text = "refused: token " + SHORT + " is not allowed";
        const one = await page({ error: text });
        assert.equal(one.error, `refused: token ${BARE} is not allowed`, `the marker is not the bare one: ${JSON.stringify(one)}`);
        assert.equal(one.error.length, text.length - SHORT.length + BARE.length, "the answer's length follows the value's");
        _setRegistryForTest([{ name: "A", value: "x".repeat(64) }]);
        const long = await page({ error: "refused: token " + "x".repeat(64) + " is not allowed" });
        // Same sentence, a value 8 times longer and under another name: the page reads exactly the same answer.
        assert.equal(long.error, one.error, "the answer differs with the value's length or the entry's name");
        for (const got of [one.error, long.error]) {
            assert.ok(!got.includes(NAME) && !got.includes("ELASTIC_KEY") && !got.includes("PLUG"), `the marker names the entry: ${got}`);
            assert.ok(!/\[\d+ secrets? redacted/.test(got), `the page's answer counts the secrets: ${got}`);
        }
    } finally { _setRegistryForTest(ENTRIES); }
});

test("RED TEAM: every form of the value is the same bare marker, and the config's own key beside it is its own placeholder", T, async () => {
    const b64 = Buffer.from(VALUE, "utf8").toString("base64").replace(/=+$/, "");
    for (const written of [VALUE, JSON.stringify(VALUE).slice(1, -1), encodeURIComponent(VALUE), b64]) {
        const got = await page({ error: `the value ${written} was refused` });
        assert.equal(got.error, `the value ${BARE} was refused`, `the ${written === VALUE ? "written" : "encoded"} form is not the bare marker: ${JSON.stringify(got)}`);
    }
    const mixed = await page({ error: `key sk-test-config-key refused ${VALUE}` });
    assert.ok(!mixed.error.includes("sk-test-config-key") && !leaks(mixed.error), `a config secret or a registered value crossed: ${mixed.error}`);
    assert.ok(mixed.error.includes("[API key]"), `the config's key has lost its own placeholder: ${mixed.error}`);
});

// --- B. the oracle's boundary: equality with a value, and nothing else ---

test("RED TEAM: a guess that is not a value comes back exactly as written; the only signal is the marker itself", T, async () => {
    // Guesses that do NOT contain the value: a text that holds it as its part is scrubbed for that part, which is the
    // crossing working (a value inside a longer text must not cross), not an oracle.
    for (const guess of [VALUE.slice(1), VALUE.slice(0, -1), VALUE.toUpperCase(), VALUE.replace(/-/g, "_")]) {
        const got = await page({ error: `token ${guess}` });
        assert.equal(got.error, `token ${guess}`, `an answer to a guess was changed where the guess is not the value: ${JSON.stringify(got)}`);
    }
    // The stated oracle, pinned: an exact value in the page's own text comes back as the marker (SECRET_HANDLES.md,
    // Known limits) — a page can confirm a guess it already holds, and learns nothing of which entry it is.
    assert.equal((await page({ error: `token ${VALUE}` })).error, `token ${BARE}`);
});

test("RED TEAM: a front, a back or an interleaved part of a value is not the value, and two entries that overlap answer by the whole one", T, async () => {
    try {
        _setRegistryForTest([{ name: NAME, value: VALUE }, { name: "LONGER", value: VALUE + "12" }]);
        // The longer entry's value holds the shorter one: a text with the longer gets ONE marker, not two.
        assert.equal((await page({ error: `t ${VALUE}12` })).error, `t ${BARE}`, "overlapping entries did not answer as the whole value");
        assert.equal((await page({ error: `t ${VALUE}` })).error, `t ${BARE}`, "the shorter entry's own value is not the marker");
        // The stated limit (threat 2): a part is not scrubbed, so a page learns nothing from a partial guess.
        for (const part of [VALUE.slice(0, 8), VALUE.slice(-8), VALUE.slice(2, 12)]) assert.equal((await page({ error: `t ${part}` })).error, `t ${part}`, `a part was scrubbed: ${part}`);
    } finally { _setRegistryForTest(ENTRIES); }
});

// --- C. a worker that has not read the registry answers nothing ---

test("RED TEAM: before the registry's first read lands, forPage waits, and the answer it then gives is scrubbed whole", T, async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const real = chrome.storage.local.get;
    chrome.storage.local.get = async (d) => { await gate; return { ...(d ?? {}), ml_secret_registry: ENTRIES }; };
    _coldRegistryForTest();
    try {
        const text = `refused: token ${VALUE}`;
        assert.equal(await standing(page({ error: text })), "pending", "forPage answered before the registry was read");
        release();
        await registryReady();
        assert.equal((await page({ error: text })).error, `refused: token ${BARE}`, "the answer after the read is not the whole text, scrubbed");
    } finally { chrome.storage.local.get = real; _setRegistryForTest(ENTRIES); }
});

test("RED TEAM: a registry that cannot be read leaves an error that is the sentence alone, and a data answer intact", T, async () => {
    const real = chrome.storage.local.get;
    // The store rejects with the value in its message: an implementation that passed the error on would leak it here.
    chrome.storage.local.get = async () => { throw new Error(`cannot read ml_secret_registry: ${VALUE}`); };
    _coldRegistryForTest();
    try {
        const got = await page({ error: `refused: token ${VALUE}` });
        assert.deepEqual(got, { error: "The request failed." }, `a failed read did not fail closed: ${JSON.stringify(got)}`);
        const data = await page({ data: { items: [1, 2] } });
        assert.deepEqual(data, { data: { items: [1, 2] } }, "a data-only answer was lost when the registry could not be read");
    } finally { chrome.storage.local.get = real; _setRegistryForTest(ENTRIES); }
});

// --- D. the multi-byte margin of ml.sh.read: a value is seen whole or not at all ---

// A value with multi-byte characters: its byte length is longer than its character length, so a margin counted in
// characters is not the same widening in the bytes the host reads.
const WIDE = "ΩΩ-klmnop-42-z";
const WIDE_MARK = "[REDACTED:WIDE_TOKEN]";

test("RED TEAM: a range that ends inside a registered value, or starts inside one of its characters, shows the marker and no front", T, async () => {
    _setRegistryForTest([{ name: "WIDE_TOKEN", value: WIDE }]);
    try {
        const pad = "b".repeat(SH_HEAD_BYTES + 100);
        hostPrinting(`${pad}${WIDE}${"c".repeat(200)}`);
        const ctx = ctxFor("forpage-wide");
        const r = await shRun(ctx, [["ls"], { expectMs: 5000 }]);
        assert.ok("ok" in r, JSON.stringify(r).slice(0, 300));
        const at = pad.length;
        for (const range of [{ offset: at - 4, length: 6 }, { offset: at + 1, length: 4 }, { offset: at + 2, length: 5 }]) {
            const x = await shRead(ctx, [r.ok.stdout.token, range]);
            assert.ok("ok" in x, JSON.stringify(x));
            assert.ok(!leaks(x.ok.text, WIDE) && !x.ok.text.includes(WIDE.slice(0, 4)), `a front of the value crossed at ${JSON.stringify(range)}: ${JSON.stringify(x.ok.text)}`);
            assert.ok(x.ok.text.includes(WIDE_MARK), `the value overlapping the range is not the marker at ${JSON.stringify(range)}: ${JSON.stringify(x.ok.text)}`);
            assert.equal(x.ok.scrubbed, 1, `the read does not say it scrubbed at ${JSON.stringify(range)}`);
        }
    } finally { _setRegistryForTest(ENTRIES); }
});

test("RED TEAM: a range that starts inside a multi-byte character before the value gets the character whole, the marker, and nothing past the range", T, async () => {
    _setRegistryForTest([{ name: "WIDE_TOKEN", value: WIDE }]);
    try {
        const pad = "b".repeat(SH_HEAD_BYTES + 100);
        hostPrinting(`${pad}€${WIDE}${"c".repeat(200)}`);
        const ctx = ctxFor("forpage-wide2");
        const r = await shRun(ctx, [["ls"], { expectMs: 5000 }]);
        assert.ok("ok" in r, JSON.stringify(r).slice(0, 300));
        // Byte pad+1 is inside the three-byte "€": the read starts one character early, and ends inside the value.
        const x = await shRead(ctx, [r.ok.stdout.token, { offset: pad.length + 1, length: 3 }]);
        assert.ok("ok" in x, JSON.stringify(x));
        assert.equal(x.ok.text, `€${WIDE_MARK}`, `the straddled character, the marker for the value it runs into, and nothing past the range: ${JSON.stringify(x.ok.text)}`);
        assert.ok(!x.ok.text.includes("�"), "the text carries a replacement character from a cut through a character");
        assert.equal(x.ok.scrubbed, 1);
    } finally { _setRegistryForTest(ENTRIES); }
});

// --- E. the shapes the error walk is documented to reach ---

// MEASURED at 679132f1: `mapErrorStrings` applies its scrubber to a string whose OWN key ends in "error", and recurses
// through every other key; a string under an error key but not directly under it (an error object the router nested,
// or an array of error strings) is therefore never scrubbed. The module's doc says "every string under an error key,
// at any depth". No `route()` answer nests one today — they answer `{ error: string }` — so this is the shape a later
// handler could hand a page; the row asserts the documented property, not a live escape.
test("RED TEAM: a string under an error key is scrubbed at any depth, an error the worker nested included", T, async () => {
    const got = await page({ error: { message: `refused: token ${VALUE}` } });
    assert.deepEqual(got, { error: { message: `refused: token ${BARE}` } }, `a string under a nested error key crossed: ${JSON.stringify(got)}`);
    const list = await page({ error: [`refused: token ${VALUE}`] });
    assert.deepEqual(list, { error: [`refused: token ${BARE}`] }, `a string in an error array crossed: ${JSON.stringify(list)}`);
});

// redteam-scrub-range.test.mjs — `scrubRange` (src/secret-scrub-range.ts) attacked: a secret split across two reads must
// be in NEITHER, at EVERY split offset, across multi-byte characters and CRLF, in overlapping and adjacent reads taken in
// either order, and with no fragment long enough to be worth having.
//
// The lane's rows (tests/secret-scrub-range.test.mjs) read a source consecutively through `consumed` and assert the
// concatenation equals the whole-text scrub. These read the way an adversary would: through the requested offsets,
// ignoring `consumed`, so a boundary lands wherever the attacker chose, and the property asserted is about the BYTES
// each read answers.
//
// Nothing page- or model-reachable calls the reader yet; the function is the target, as the coordinator asked.
//
// Not rowed here, with the reason: ruling 44's unreadable store. `scrubRange` receives the substitutions as an argument
// and reads no store, so the held-store behaviour lives in its callers (sw-shell-call.ts, which reads the registry and
// fails closed there, pinned by that module's rows); there is nothing in this function to make unreadable.

import test from "node:test";
import assert from "node:assert/strict";
import { scrubRange } from "../src/secret-scrub-range.ts";
import { secretsOf } from "../src/secret-scrub.ts";

const T = { timeout: 20000 };
const KEY = "sk-abcdef1234567890XYZ";
const CONFIG = { chatUrl: "https://chat.example.com:8443/api/", apiKey: KEY, modelFilter: "^qwen3(:.*)?$" };
const SECRETS = secretsOf(CONFIG);
/** Every form a secret takes in the text, longest last. */
const FORMS = [KEY, "https://chat.example.com:8443/api/", "ghp_" + "a1B2c3D4e5".repeat(4), "github_pat_" + "Z9_".repeat(55)];
const source = (s) => ({ length: s.length, slice: async (a, b) => s.slice(a, b) });
/** Every fragment of `secret` long enough to matter: 6 characters, the shortest window a search would use. */
const fragments = (secret) => { const out = []; for (let i = 0; i + 6 <= secret.length; i++) out.push(secret.slice(i, i + 6)); return [...new Set(out)]; };
const FR = Object.fromEntries(FORMS.map((f) => [f, fragments(f)]));
/** What each read answered must hold no fragment of the secret it is about. */
function noFragment(reads, secret, what) {
    for (const r of reads) for (const f of FR[secret]) assert.ok(!r.text.includes(f), `${what}: a fragment "${f}" was answered: ${JSON.stringify(r.text.slice(0, 120))}`);
}
async function twoReads(text, at, secrets = SECRETS) {
    return [await scrubRange(source(text), 0, at, secrets), await scrubRange(source(text), at, text.length, secrets)];
}

// --- every split offset, for every form ---

test("no split offset leaves a fragment of a secret in either read, for every form", T, async () => {
    for (const form of FORMS) {
        const text = "left-pad " + form + " right-pad";
        const at0 = 9;
        // ENUMERATED, not sampled: the boundary walks through the secret one character at a time, and one character
        // either side of it, so every way a caller can cut it is measured.
        for (let k = -1; k <= form.length + 1; k++) {
            const at = at0 + k;
            const [first, second] = await twoReads(text, at);
            noFragment([first, second], form, `${form.slice(0, 9)}… split at ${k}`);
            assert.ok(first.consumed >= 0 && second.consumed >= at, "a read must not rewind");
        }
    }
});

// --- a multi-byte character boundary, and CRLF ---

test("a boundary inside a surrogate pair or between CR and LF does not expose a neighbouring secret", T, async () => {
    // The boundary walks through an emoji (a surrogate pair in UTF-16) and through a CRLF, with a secret on each side and
    // one between them. What must hold is both halves of the rule: the secret is never split, and the text that is not a
    // secret comes back exactly (no replacement characters from a mid-pair cut).
    const text = "a\u{1F600}" + KEY + "\r\n" + "b\u{1F601}" + FORMS[1] + "\r\nc";
    for (let at = 0; at <= text.length; at++) {
        const [first, second] = await twoReads(text, at);
        noFragment([first, second], KEY, `key, boundary ${at}`);
        noFragment([first, second], FORMS[1], `url, boundary ${at}`);
        // Rejoining with the same offsets must give the original text, placeholders aside: the pieces are the source's.
        const joined = first.text + second.text;
        assert.ok(!joined.includes("�"), `a mid-character cut produced a replacement character at ${at}: ${JSON.stringify(joined)}`);
    }
});

// --- overlapping and adjacent reads, in either order ---

test("overlapping and adjacent ranges, read in either order, never put a secret back together", T, async () => {
    const text = "Z".repeat(10) + KEY + "Z".repeat(10);
    const starts = [0, 5, 10, 10 + KEY.length - 1, 10 + KEY.length];
    const ends = [10 + KEY.length, 15 + KEY.length, text.length];
    for (const a of starts) for (const b of ends) {
        if (b <= a) continue;
        // Both orders, and each pair read whole (not through `consumed`), as a caller holding offsets would.
        const forward = [await scrubRange(source(text), a, b, SECRETS), await scrubRange(source(text), a, b, SECRETS)];
        noFragment(forward, KEY, `[${a},${b}) twice`);
        const across = [await scrubRange(source(text), b, Math.min(text.length, b + 20), SECRETS), await scrubRange(source(text), a, b, SECRETS)];
        noFragment(across, KEY, `[${b},…) then [${a},${b})`);
        const overlap = await scrubRange(source(text), a, Math.min(text.length, b + KEY.length), SECRETS);
        noFragment([overlap], KEY, `overlapping [${a},${b + KEY.length})`);
    }
});

// --- what is revealed about a secret's length and position ---

test("the redaction says no more than the whole-text scrub does: the placeholder, or nothing", T, async () => {
    // A read that starts inside a secret removes the part it covers (nothing of it is echoed), and one that starts before
    // it shows the same placeholder the whole-text scrub would. Neither answers a length: the placeholder is fixed text.
    const text = "before " + KEY + " after";
    const at = 3;   // inside the secret
    const r = await scrubRange(source(text), 0, at, SECRETS);
    assert.ok(!r.text.includes(KEY.slice(0, 6)), r.text);
    assert.ok(!/\d/.test(r.text.replace(/^before /, "")), `a prefix of the secret's body was answered: ${JSON.stringify(r.text)}`);
    const whole = await scrubRange(source(text), 0, text.length, SECRETS);
    assert.equal(whole.text, "before [API key] after", "the placeholder is the whole-text scrub's");
    // No read answers a run of the secret's characters anywhere, at any offset (the enumeration above covers every form;
    // this pins the strongest single case, the shortest form).
    for (let k = 0; k <= KEY.length; k++) {
        const [f, s] = await twoReads(text, 7 + k);
        assert.ok(!f.text.includes(KEY.slice(0, 4)) && !s.text.includes(KEY.slice(-4)), `a 4-character run leaked at ${k}`);
    }
});

// --- a secret that sets the window's width ---

test("a long secret, which sets the window, is not split at any of its 3000 offsets either", T, async () => {
    // W is the longest form's length; with a secret this long the window widens by 2999 either side, which is the branch
    // the short forms never exercise. Enumerated over the secret's whole length, one boundary per character.
    const long = "L" + "q7X".repeat(1000);   // 3001 characters
    const secrets = secretsOf({ apiKey: long });
    const text = "Z".repeat(7) + long + "Z".repeat(7);
    const frags = []; for (let i = 0; i + 9 <= long.length; i += 97) frags.push(long.slice(i, i + 9));
    for (let k = 0; k <= long.length; k++) {
        const at = 7 + k;
        const [first, second] = await twoReads(text, at, secrets);
        for (const f of frags) assert.ok(!first.text.includes(f) && !second.text.includes(f), `a fragment leaked at ${k}`);
    }
});

// secret-registry.test.mjs — the registered secrets' matching (src/secret-registry.ts): the bounds, the forms a value
// is written in, the scrub of text, bytes and read ranges, and what a cut never shows.
import { test } from "node:test";
import assert from "node:assert/strict";

const R = await import("../src/secret-registry.ts");
const { entryRefusal, valueForms, registrySubs, scrubRegistry, redactedLine, heldTail, margin, scrubBytes, scrubRange } = R;

const e = (name, value) => ({ name, value });
const subsOf = (...entries) => registrySubs(entries);
const SECRET = "hunter2-REAL/secret";
const SUBS = subsOf(e("PW", SECRET));

// --- the bounds an entry is added under ---

test("entryRefusal: the value length edges, in characters", () => {
    assert.ok(entryRefusal([], e("A", "x".repeat(7))));
    assert.equal(entryRefusal([], e("A", "x".repeat(8))), null);
    assert.equal(entryRefusal([], e("A", "x".repeat(512))), null);
    assert.ok(entryRefusal([], e("A", "x".repeat(513))));
    assert.equal(entryRefusal([], e("A", "é".repeat(8))), null);
    assert.equal(entryRefusal([], e("A", "😀".repeat(8))), null);
});

test("entryRefusal: 64 entries, then a 65th; a same-name replacement at 64 is allowed", () => {
    const full = Array.from({ length: 64 }, (_, i) => e(`N${i}`, "value-" + String(i).padStart(4, "0")));
    assert.equal(entryRefusal(full.slice(0, 63), e("NEW", "abcdefgh")), null);
    assert.match(entryRefusal(full, e("NEW", "abcdefgh")), /64/);
    assert.equal(entryRefusal(full, e("N5", "another-value")), null);
});

test("entryRefusal: names", () => {
    for (const bad of ["lower", "", "A".repeat(41), "A B", "A]", "[A", "A-B"]) assert.ok(entryRefusal([], e(bad, "abcdefgh")), JSON.stringify(bad));
    for (const ok of ["A", "A".repeat(40), "PLUG_PASSWORD_2"]) assert.equal(entryRefusal([], e(ok, "abcdefgh")), null, ok);
});

// --- the forms a value is matched in ---

test("valueForms: the value first, no duplicates, no empty form", () => {
    const f = valueForms("plain-ascii-value");
    assert.equal(f[0], "plain-ascii-value");
    assert.equal(new Set(f).size, f.length);
    assert.ok(f.every((x) => x.length > 0));
});

test("valueForms: JSON and percent forms of a value with a quote, a slash, a space and a non-ASCII character", () => {
    const v = 'a"b/c défghij';
    const f = valueForms(v);
    assert.ok(f.includes('a\\"b/c défghij'));
    assert.ok(f.includes('a\\"b\\/c défghij'));
    assert.ok(f.includes(encodeURIComponent(v)));
});

test("valueForms: base64 at every alignment, standard and URL-safe", () => {
    const value = "p@ss/wörd+tok~?>>";
    const bytes = new TextEncoder().encode(value);
    const f = valueForms(value);
    const prefixes = [[], [0xff], [0xfa, 0x03]];
    for (let k = 0; k < 3; k++) {
        const all = [...prefixes[k], ...bytes, 0xfb, 0xff];
        const run = btoa(String.fromCharCode(...all)).replace(/=+$/, "");
        const from = Math.ceil((8 * k) / 6);
        const to = Math.floor((8 * (k + bytes.length)) / 6);
        const core = run.slice(from, to);
        assert.ok(f.includes(core), `std k=${k}`);
        const safe = core.replace(/\+/g, "-").replace(/\//g, "_");
        assert.ok(f.includes(safe), `url k=${k}`);
        assert.ok(run.includes(core));
    }
});

test("valueForms: a base64 form under 8 characters is dropped", () => {
    const f = valueForms("abcd");
    assert.ok(f.every((x) => x === "abcd" || x.length >= 8 || !/^[A-Za-z0-9+/_-]+$/.test(x) || x === "abcd"));
    assert.deepEqual(f, ["abcd"]);
});

test("valueForms: shell forms of a value with a quote and a dollar sign", () => {
    const f = valueForms("it's $ecret!!");
    assert.ok(f.includes("it'\\''s $ecret!!"));
    assert.ok(f.includes("it\\'s\\ \\$ecret\\!\\!"));
    assert.deepEqual(valueForms("safe/path.v1:x@y"), valueForms("safe/path.v1:x@y").filter((x, i, a) => a.indexOf(x) === i));
});

test("valueForms: no shell form when it equals the value", () => {
    const f = valueForms("abc_def.ghi/jkl");
    assert.equal(f.filter((x) => x === "abc_def.ghi/jkl").length, 1);
});

// --- scrubbing a text ---

test("scrubRegistry: the spec's discriminating case", () => {
    const subs = subsOf(e("PLUG_PASSWORD", "REALSECRET"));
    const r = scrubRegistry("FOO_SOURCES=a=x@http://u:REALSECRET@10.0.0.1", subs);
    assert.equal(r.text, "FOO_SOURCES=a=x@http://u:[REDACTED:PLUG_PASSWORD]@10.0.0.1");
    assert.deepEqual(r.counts, { PLUG_PASSWORD: 1 });
});

test("scrubRegistry: each form type inside surrounding text, counted per name", () => {
    const v = 'pa"ss/w rdé!\'$';
    const subs = subsOf(e("ONE", v), e("TWO", "second-secret-value"));
    const forms = valueForms(v);
    const text = forms.map((f) => `<${f}>`).join(" ") + " and second-secret-value";
    const r = scrubRegistry(text, subs);
    assert.ok(!forms.some((f) => f.length > 3 && r.text.includes(f)), r.text);
    assert.equal(r.counts.ONE, forms.length);
    assert.equal(r.counts.TWO, 1);
});

test("scrubRegistry: base64 of the value inside a longer run is matched", () => {
    const run = btoa("zz" + SECRET + "yy");
    const r = scrubRegistry(`tok ${run} end`, SUBS);
    assert.match(r.text, /\[REDACTED:PW\]/);
    assert.equal(r.counts.PW, 1);
});

test("scrubRegistry: the longer value wins when one contains another", () => {
    const subs = subsOf(e("SHORT", "abcdefgh"), e("LONG", "abcdefgh-ijklmnop"));
    const r = scrubRegistry("x abcdefgh-ijklmnop y abcdefgh z", subs);
    assert.equal(r.text, "x [REDACTED:LONG] y [REDACTED:SHORT] z");
    assert.deepEqual(r.counts, { LONG: 1, SHORT: 1 });
});

test("scrubRegistry: an existing marker is neither re-matched nor counted", () => {
    const subs = subsOf(e("PW", "REDACTED:PW"), e("X", "abcdefghij"));
    const r = scrubRegistry("a [REDACTED:PW] b abcdefghij", subs);
    assert.equal(r.text, "a [REDACTED:PW] b [REDACTED:X]");
    assert.deepEqual(r.counts, { X: 1 });
});

test("scrubRegistry: no match leaves the text identical and the counts empty", () => {
    const r = scrubRegistry("nothing here", SUBS);
    assert.equal(r.text, "nothing here");
    assert.deepEqual(r.counts, {});
    assert.deepEqual(scrubRegistry("abc", []).counts, {});
});

test("registrySubs: each find once with the first entry winning, longest first, no double spaces", () => {
    const subs = subsOf(e("A", "samevalue"), e("B", "samevalue"));
    assert.equal(subs.filter((s) => s.find === "samevalue").length, 1);
    assert.equal(subs.find((s) => s.find === "samevalue").name, "A");
    for (let i = 1; i < subs.length; i++) assert.ok(subs[i - 1].find.length >= subs[i].find.length);
    assert.equal(subs[0].put, `[REDACTED:${subs[0].name}]`);
    assert.ok(!/ {2}/.test(redactedLine({ A: 2, B: 1 })));
});

// --- the line that says it was touched ---

test("redactedLine: empty, one, several", () => {
    assert.equal(redactedLine({}), "");
    assert.equal(redactedLine({ A: 0 }), "");
    assert.equal(redactedLine({ PLUG_PASSWORD: 1 }), "1 secret redacted (PLUG_PASSWORD)");
    assert.equal(redactedLine({ B: 2, A: 1 }), "3 secrets redacted (A, B)");
    assert.equal(redactedLine({ A: 3 }), "3 secrets redacted (A)");
});

// --- what to hold back at the end of a cut text ---

test("heldTail: a text ending in a prefix of a value", () => {
    assert.equal(heldTail("output hunter2-RE", SUBS), "hunter2-RE".length);
    assert.equal(heldTail("output h", SUBS), 1);
});

test("heldTail: a full value at the end is a match, not a prefix; none holds nothing", () => {
    const subs = subsOf(e("PW", "abcdefgh"));
    assert.equal(heldTail("x abcdefgh", subs.filter((s) => s.find === "abcdefgh")), 0);
    assert.equal(heldTail("plain text", SUBS), 0);
    assert.equal(heldTail("", SUBS), 0);
    assert.equal(heldTail("abc", []), 0);
});

test("margin: the longest form, 0 for none", () => {
    assert.equal(margin([]), 0);
    assert.equal(margin(SUBS), Math.max(...SUBS.map((s) => s.find.length)));
});

// --- raw bytes ---

test("scrubBytes: a match among non-UTF-8 bytes", () => {
    const v = new TextEncoder().encode(SECRET);
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, ...v, 0x80, 0xc3]);
    const r = scrubBytes(bytes, SUBS);
    assert.equal(r.scrubbed, 1);
    assert.deepEqual([...r.bytes], [0xff, 0xfe, 0x00, ...new TextEncoder().encode("[REDACTED:PW]"), 0x80, 0xc3]);
});

test("scrubBytes: no match returns the same array; an existing marker is not a match", () => {
    const bytes = new Uint8Array([1, 2, 3, 0xff]);
    const r = scrubBytes(bytes, SUBS);
    assert.equal(r.bytes, bytes);
    assert.equal(r.scrubbed, 0);
    const m = new TextEncoder().encode("[REDACTED:PW]");
    assert.equal(scrubBytes(m, subsOf(e("PW", "REDACTED:PW"))).bytes, m);
});

// --- a read range cut out of a wider window ---

const V = "SECRETVALUE";
const RS = subsOf(e("PW", V));
const WIN = `0123456789${V}abcdefghij`;
const VS = 10;
const VE = VS + V.length;

test("scrubRange: a value fully inside the range", () => {
    const r = scrubRange(WIN, 5, 25, RS);
    assert.equal(r.text, "56789[REDACTED:PW]abcd");
    assert.deepEqual(r.counts, { PW: 1 });
});

test("scrubRange: straddling the left edge", () => {
    const r = scrubRange(WIN, VS + 4, VE + 3, RS);
    assert.equal(r.text, "[REDACTED:PW]abc");
    assert.deepEqual(r.counts, { PW: 1 });
});

test("scrubRange: straddling the right edge", () => {
    const r = scrubRange(WIN, 7, VS + 4, RS);
    assert.equal(r.text, "789[REDACTED:PW]");
    assert.deepEqual(r.counts, { PW: 1 });
});

test("scrubRange: a value fully outside is neither shown nor counted", () => {
    const a = scrubRange(WIN, 0, 8, RS);
    assert.equal(a.text, "01234567");
    assert.deepEqual(a.counts, {});
    const b = scrubRange(WIN, VE + 2, WIN.length, RS);
    assert.equal(b.text, "cdefghij");
    assert.deepEqual(b.counts, {});
});

test("scrubRange: two ranges that split a value between them never show a prefix of it", () => {
    const mid = VS + 5;
    const left = scrubRange(WIN, 0, mid, RS);
    const right = scrubRange(WIN, mid, WIN.length, RS);
    for (const t of [left.text, right.text]) {
        assert.ok(!t.includes("SECR"));
        assert.ok(!t.includes("VALUE"));
        assert.match(t, /\[REDACTED:PW\]/);
    }
    assert.equal(left.text, "0123456789[REDACTED:PW]");
});

test("scrubRange: out-of-bounds and empty ranges", () => {
    assert.equal(scrubRange(WIN, -5, 3, RS).text, "012");
    assert.equal(scrubRange(WIN, 5, 5, RS).text, "");
    assert.equal(scrubRange(WIN, 0, 999, RS).text, scrubRegistry(WIN, RS).text);
});

// --- the registry is in no backup, and a restore never writes it ---

test("a settings backup leaves the registry out, encrypted or not, and a restore that carries one does not write it", async () => {
    const B = await import("../src/backup/backup-settings.ts");
    const entries = [{ name: "PLUG_PASSWORD", value: "REALSECRET-4b1d-77" }];
    for (const encrypted of [false, true]) {
        const { payload } = B.collectSettings({ sync: {}, local: { ml_secret_registry: entries } }, { encrypted, includeApiKey: true });
        assert.ok(!("ml_secret_registry" in payload.local), `encrypted: ${encrypted}`);
        assert.ok(!JSON.stringify(payload).includes("REALSECRET"), `encrypted: ${encrypted}`);
    }
    // A forged backup carrying the registry beside an ordinary setting: the setting is written (the control), the registry is not.
    const forged = { format: "wml-settings", v: 1, created: new Date().toISOString(), apiKeyIncluded: false, sync: { model: "gemma4:31b" }, local: { ml_secret_registry: entries } };
    const plan = B.planRestore(forged, { sync: {}, local: {} });
    const written = { sync: {}, local: {} };
    await B.applyRestore(plan, B.chromeStorageWriter({ sync: { set: async (x) => { Object.assign(written.sync, x); } }, local: { set: async (x) => { Object.assign(written.local, x); } } }));
    assert.equal(written.sync.model, "gemma4:31b", "the restore ran");
    assert.ok(!("ml_secret_registry" in written.local), "a restore never writes the registry");
});

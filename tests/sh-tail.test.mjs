// sh-tail.test.mjs — the pure half of an ml.sh task's live `tail` (src/shell/sh-tail.ts): a host `peek` answer, which
// is the last bytes of a running call's output cut at a byte, turned into the lines the model reads.

import { test } from "node:test";
import assert from "node:assert/strict";
import { peekText, peekBytesFor, PEEK_MAX_BYTES } from "../src/shell/sh-tail.ts";

const enc = (s) => Buffer.from(s, "utf8");
/** A peek stream: `data` is the last bytes of a stream whose size is `size` (default: all of it). */
const stream = (data, size = data.length, truncated = false) => ({ size, truncated, data: { $bytes: Buffer.from(data).toString("base64") } });
const peek = (stdout, stderr = stream(Buffer.alloc(0))) => ({ id: "c1", stdout, stderr });
const out = (s, lines = 20, cap) => peekText(peek(stream(enc(s))), lines, cap);

// --- a cut inside a UTF-8 sequence is never shown as U+FFFD ---

for (const [name, ch, width] of [["2-byte", "é", 2], ["3-byte", "€", 3], ["4-byte", "😀", 4]]) {
    for (let drop = 1; drop < width; drop++) {
        test(`${name} character cut after ${drop} byte(s) at the front: the half is dropped with its line, no U+FFFD`, () => {
            const whole = enc(`${ch}tail of line\nsecond\nthird\n`);
            const data = whole.subarray(drop);
            const t = peekText(peek(stream(data, 5000)), 20);
            assert.ok(!t.includes("�"), t);
            assert.ok(!t.includes("tail of line"), `the partial first line was kept: ${t}`);
            assert.match(t, /second\nthird/);
        });
    }
    for (let keep = 1; keep < width; keep++) {
        test(`${name} character cut after ${keep} byte(s) at the END (the program is mid-write): the half is held back`, () => {
            const data = Buffer.concat([enc("one\ntwo "), enc(ch).subarray(0, keep)]);
            const t = peekText(peek(stream(data)), 20);
            assert.ok(!t.includes("�"), t);
            assert.match(t, /two $/m);
        });
    }
    test(`${name} character whole at both ends survives`, () => {
        assert.match(out(`${ch}\n${ch}\n`), new RegExp(`${ch}\\n${ch}\\nstderr`));
    });
}

// --- a cut inside a line ---

test("data that does not start the stream loses its first, partial line", () => {
    const t = peekText(peek(stream(enc("rtial\nfull one\nfull two\n"), 9000)), 20);
    assert.ok(!t.includes("rtial"), t);
    assert.match(t, /full one\nfull two/);
});

test("data from offset 0 keeps its first line, even though it is the same bytes", () => {
    const t = out("first\nsecond\n");
    assert.match(t, /first\nsecond/);
});

test("a fragment with no newline, not from the start, is kept and marked rather than dropped to nothing", () => {
    const t = peekText(peek(stream(enc("middle of a very long line"), 99999)), 20);
    assert.match(t, /middle of a very long line/);
    assert.match(t, /start of the line cut/);
});

test("a fragment with no newline that starts mid-character: the half character is dropped, no U+FFFD", () => {
    const t = peekText(peek(stream(enc("€ rest of a long line").subarray(1), 99999)), 20);
    assert.ok(!t.includes("\uFFFD"), t);
    assert.match(t, /rest of a long line/);
});

test("data not from the start whose only newline ends the fragment has no complete line yet", () => {
    assert.match(peekText(peek(stream(enc("rest of a line\n"), 99999)), 20), /no complete line yet/);
});

test("a leading continuation byte at offset 0 is the program's own bytes: decoded, not silently dropped", () => {
    const t = peekText(peek(stream(Buffer.from([0x80, 0x41, 0x0a]))), 20);
    assert.match(t, /A/);
    assert.ok(t.includes("�"), "the program's invalid byte is shown as the decoder shows it");
});

// --- line counts ---

test("N lines: the last N, in order, and the count said", () => {
    const t = out("a\nb\nc\nd\ne\n", 2);
    assert.match(t, /last 2 lines\):\nd\ne$/m);
    assert.ok(!/\bc\b/.test(t.split("stderr")[0].split("\n").slice(1).join("\n")), t);
});

test("N larger than the lines there are: all of them, with no 'last N' claim", () => {
    const t = out("a\nb\n", 50);
    assert.match(t, /stdout \(4 B so far\):\na\nb/);
    assert.ok(!/last \d+ lines/.test(t), t);
});

test("a final line with no newline yet counts as a line", () => {
    assert.match(out("a\nb\npartial", 2), /b\npartial/);
});

test("CRLF line endings are split and the carriage returns removed", () => {
    const t = out("a\r\nb\r\nc\r\n", 2);
    assert.ok(!t.includes("\r"), JSON.stringify(t));
    assert.match(t, /b\nc/);
});

test("blank lines in the middle are lines", () => {
    assert.match(out("a\n\nb\n", 3), /a\n\nb/);
});

// --- the streams: empty, null, truncated, both labelled ---

test("an empty stream says empty, for stdout and for stderr", () => {
    const t = peekText(peek(stream(Buffer.alloc(0)), stream(Buffer.alloc(0))), 5);
    assert.equal(t, "stdout: empty\nstderr: empty");
});

test("a null stdout (it feeds the next pipeline stage) is said, and stderr still shows", () => {
    const t = peekText(peek(null, stream(enc("warn\n"))), 5);
    assert.match(t, /^stdout: feeds the next pipeline stage, not readable\nstderr \(5 B so far\):\nwarn$/);
});

test("a stream with bytes counted but none returned says nothing readable, never empty", () => {
    assert.match(peekText(peek({ size: 100, truncated: false, data: { $bytes: "" } }), 5), /stdout \(100 B so far\): nothing readable/);
});

test("a stream past the host's output cap says so, and that later output is not kept", () => {
    const t = peekText(peek(stream(enc("x\ny\n"), 4, true)), 5);
    assert.match(t, /passed the host's output cap, later output is not kept/);
});

test("stdout and stderr are labelled separately and in that order", () => {
    const t = peekText(peek(stream(enc("o\n")), stream(enc("e\n"))), 5);
    assert.match(t, /^stdout \(2 B so far\):\no\nstderr \(2 B so far\):\ne$/);
});

// --- the cap and the bytes asked for ---

test("each stream is cut to the output cap from the END, marked with an ellipsis", () => {
    const body = `${"a".repeat(300)}\n${"z".repeat(300)}\n`;
    const t = out(body, 5, 100);
    const lines = t.split("\n");
    assert.equal(lines[1], `…${"z".repeat(100)}`.slice(0, 1) + "z".repeat(100));
    assert.ok(lines[1].startsWith("…") && !lines[1].includes("a"), t);
});

test("the default cap is exec's output cap", () => {
    const t = out(`${"q".repeat(2000)}\n`);
    assert.equal(t.split("\n")[1].length, 501);
});

test("the text never has two spaces in a row of OUR making", () => {
    const t = peekText(peek(stream(enc("a\nb\n")), stream(Buffer.alloc(0))), 5);
    assert.ok(!/ {2}/.test(t), t);
    assert.ok(!/ {2}/.test(peekText(peek(null, stream(enc("x\n"), 99999, true)), 5)));
});

test("bytes asked: scaled from the line count, never under the host's default, never over its ceiling", () => {
    assert.equal(peekBytesFor(1), 4096);
    assert.equal(peekBytesFor(20), 21 * 240);
    assert.equal(peekBytesFor(200), 201 * 240);
    assert.equal(peekBytesFor(1e9), PEEK_MAX_BYTES);
    for (const bad of [0, -3, NaN, 0.4]) assert.ok(peekBytesFor(bad) >= 4096 && Number.isInteger(peekBytesFor(bad)));
});

// Mapping line numbers across a whitespace-only reformat, for ANY formatter.
//
// Every pretty-printer we show code through moves line numbers, and a stack trace's entire content is a line
// number. The Python formatter builds its own map as it goes; js-beautify gives nothing back. Deriving the
// map from the two TEXTS covers both — and refuses when they are not the same code, because a map derived
// from a mismatch points confidently at the wrong line, which is worse than an un-mapped number the reader
// could at least distrust.
import test from "node:test";
import assert from "node:assert/strict";
import { lineMapBetween } from "../src/line-map.ts";

test("a line that moved down maps to where it went", () => {
    const before = "a = 1\nb = f(x, y)\nc = 3";
    const after = "a = 1\nb = f(\n    x,\n    y\n)\nc = 3";
    const map = lineMapBetween(before, after);
    assert.deepEqual([map[1], map[2], map[3]], [1, 2, 6]);
});

test("identical text maps to itself", () => {
    const src = "one\ntwo\nthree";
    assert.deepEqual(lineMapBetween(src, src).slice(1), [1, 2, 3]);
});

test("a line JOINED onto the one above maps to it", () => {
    // The other direction: a formatter that pulls a wrapped call back onto one line.
    const map = lineMapBetween("f(\n  a,\n  b\n)", "f(a, b)");
    assert.deepEqual([map[1], map[2], map[3], map[4]], [1, 1, 1, 1]);
});

test("blank lines take the mapping of the next line with code on it", () => {
    // They have no character to anchor on, and the next real line is where a reader looking for them lands.
    const map = lineMapBetween("a\n\n\nb", "a\nb");
    assert.equal(map[1], 1);
    assert.equal(map[4], 2);
    assert.equal(map[2], 2, "a blank line points forward, not at nothing");
    assert.equal(map[3], 2);
});

test("a trailing blank run takes the last real line rather than falling off the end", () => {
    const map = lineMapBetween("a\nb\n\n\n", "a\nb\n");
    for (let n = 1; n <= 5; n++) assert.equal(typeof map[n], "number", `line ${n} has no mapping`);
    assert.equal(map[3], 2);
});

test("indentation alone is not a change", () => {
    const map = lineMapBetween("if x:\nreturn 1", "if x:\n    return 1");
    assert.deepEqual([map[1], map[2]], [1, 2]);
});

test("it REFUSES when the two are not the same code", () => {
    // The whole safety property. A formatter that renamed, dropped or reordered anything cannot be mapped,
    // and guessing would put the marker on an innocent line.
    assert.equal(lineMapBetween("a = 1\nb = 2", "a = 1\nb = 3"), null, "a changed token");
    assert.equal(lineMapBetween("a = 1\nb = 2", "a = 1"), null, "a dropped line");
    assert.equal(lineMapBetween("a = 1", "a = 1\nb = 2"), null, "an added one");
});

test("what it CANNOT see: whitespace inside a string literal", () => {
    // Said plainly rather than pretended away. `'a  b'` and `'a b'` strip to the same characters, so a
    // formatter that re-spaced a string would be mapped as though nothing happened. Telling them apart needs
    // a tokenizer per language — the thing this exists to avoid — and both formatters using it copy strings
    // byte-for-byte (py-format asserts exactly that). This test exists so the gap is a known one.
    assert.notEqual(lineMapBetween("s = 'a  b'", "s = 'a b'"), null, "not caught — by design, see line-map.ts");
});

test("every line has an answer, so a lookup can never return undefined", () => {
    const map = lineMapBetween("\n\na = 1\n\nb = 2\n\n", "a = 1\nb = 2\n");
    for (let n = 1; n <= 7; n++) assert.equal(typeof map[n], "number", `line ${n}`);
});

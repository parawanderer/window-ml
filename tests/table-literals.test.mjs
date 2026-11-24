// The `ml.table("…")` literal scan (src/python/table-literals.ts): what a page reads before a page-started cell, what a
// card discloses as a Sheet, and what the agent loop resolves as an `@tool:` pointer.
//
// The scan decides what a page READS on a cell's behalf before the cell runs, so it is adversarial input: only a call
// spelled `ml.table` with a plain string literal is read, never a computed source, never one inside a comment or a
// string, and never more than TABLE_LITERALS_MAX of them.
import test from "node:test";
import assert from "node:assert/strict";
import { tableLiterals, TABLE_LITERALS_MAX } from "../src/python/table-literals.ts";

const srcs = (code) => tableLiterals(code).map((l) => l.src);

// --- what is read ---

test("a call with a string literal is read, in source order, each once", () => {
    assert.deepEqual(srcs(`a = ml.table("https://x/a.csv")\nb = ml.table('@tool:abc1234')\nc = ml.table("https://x/a.csv")`),
        ["https://x/a.csv", "@tool:abc1234"]);
});

test("each string form the scan admits: single, double, triple quotes, a raw string, the five escapes", () => {
    assert.deepEqual(srcs(`ml.table('a')\nml.table("b")\nml.table("""c""")\nml.table(r"d\\e")\nml.table("f\\tg\\n\\\\\\"\\'")`),
        ["a", "b", "c", "d\\e", "f\tg\n\\\"'"]);
});

test("literal keywords are kept; raw=False is the default and dropped", () => {
    assert.deepEqual(tableLiterals(`ml.table("s", raw=True, delimiter=";", header=False)`),
        [{ src: "s", opts: { raw: true, delimiter: ";", header: false } }]);
    assert.deepEqual(tableLiterals(`ml.table("s", raw=False, delimiter=None, header=None)`), [{ src: "s", opts: {} }]);
    assert.deepEqual(tableLiterals(`ml.table("s",)`), [{ src: "s", opts: {} }]);
});

test("the same source with other options is a second read", () => {
    assert.equal(tableLiterals(`ml.table("s")\nml.table("s", raw=True)`).length, 2);
});

test("a call in a branch that never runs is read (and unused)", () => {
    assert.deepEqual(srcs(`if False:\n    ml.table("dead")`), ["dead"]);
});

// --- what is not read (adversarial) ---

test("a computed source is never read: a name, a concatenation, an f-string, bytes, a call", () => {
    for (const code of [`ml.table(src)`, `ml.table("a" + b)`, `ml.table("a" "b")`, `ml.table(f"{x}")`, `ml.table(b"x")`,
        `ml.table(str("x"))`, `ml.table(("x"))`, `ml.table(*["x"])`, `ml.table(src="x")`])
        assert.deepEqual(srcs(code), [], code);
});

test("an escape outside the five makes the literal unread, not misread", () => {
    for (const code of [`ml.table("\\x41")`, `ml.table("\\u0041")`, `ml.table("a\\\nb")`, `ml.table("\\0")`])
        assert.deepEqual(srcs(code), [], code);
});

test("a call inside a comment or a string is not a call", () => {
    assert.deepEqual(srcs(`# ml.table("in-comment")\nx = "ml.table('in-string')"\ny = '''\nml.table("in-doc")\n'''`), []);
});

test("only the word ml.table: another object's table, an attribute of it, or a rebinding is not read", () => {
    for (const code of [`x.ml.table("a")`, `ml.table.x("a")`, `mml.table("a")`, `ml.tables("a")`, `t = ml.table\nt("a")`, `getattr(ml, "table")("a")`])
        assert.deepEqual(srcs(code), [], code);
});

test("a non-literal or unknown keyword keeps the read but drops every option", () => {
    assert.deepEqual(tableLiterals(`ml.table("s", raw=flag)`), [{ src: "s", opts: {} }]);
    assert.deepEqual(tableLiterals(`ml.table("s", delimiter=";", sep=",")`), [{ src: "s", opts: {} }]);
    assert.deepEqual(tableLiterals(`ml.table("s", raw="yes")`), [{ src: "s", opts: {} }]);
    assert.deepEqual(tableLiterals(`ml.table("s", **kw)`), [{ src: "s", opts: {} }]);
});

test("code the tokenizer cannot account for reads nothing", () => {
    assert.deepEqual(srcs(`ml.table("ok")\nx = "unterminated`), []);
});

test(`a cell names at most ${TABLE_LITERALS_MAX} reads, however many calls it writes`, () => {
    const code = Array.from({ length: TABLE_LITERALS_MAX + 10 }, (_, i) => `ml.table("s${i}")`).join("\n");
    const got = srcs(code);
    assert.equal(got.length, TABLE_LITERALS_MAX);
    assert.equal(got[0], "s0");
});

test("non-string input is no code", () => {
    assert.deepEqual(tableLiterals(undefined), []);
    assert.deepEqual(tableLiterals(null), []);
});

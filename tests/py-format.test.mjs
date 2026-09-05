// The Python pretty-printer for the RENDERED view.
//
// A model writes dense one-liners on purpose — that is the right trade for the thing paying per token, and
// the wrong one for the person reading the step. So the rendered view reflows and the model's own text is
// left exactly as it was.
//
// Two invariants make that safe rather than a second source of truth, and most of this file is about them:
// the TOKENS never change (so the displayed code always runs the same as the code that ran), and the line
// MAP says where each original line went (so a traceback still points somewhere true).
import test from "node:test";
import assert from "node:assert/strict";
import { pyFormat, tokenizePy } from "../src/py-format.ts";

/** Every token, in order, with all whitespace gone. Two sources with the same signature are the same code. */
const sig = (src) => (tokenizePy(src) || []).filter((t) => t.kind !== "space" && t.kind !== "nl").map((t) => t.text).join(" ");

test("the tokens are never changed — only the whitespace between them", () => {
    const src = [
        "df = tables['df']",
        "out = pd.DataFrame({'metric':['Grand total','Per quarter']+['Top rep: '+rep.index[0]],'value':[grand, dict(per_q), int(rep.iloc[0])]})",
        "print(rep.to_string()); print(region.to_string())",
        "return out",
    ].join("\n");
    const r = pyFormat(src);
    assert.ok(r.changed, "this is exactly the shape that needed reflowing");
    // THE invariant. Anything that renames, reorders, drops or merges a token would show up here, and it is
    // what lets the rendered code be trusted as the code that ran.
    assert.equal(sig(r.text), sig(src));
});

test("a long call opens out at its arguments, and short lines are left alone", () => {
    const src = "qs = ['Q1','Q2','Q3','Q4']\nout = f(aaaaaaaaaaaaaaaaaaaaaaaa, bbbbbbbbbbbbbbbbbbbbbbbbbb, cccccccccccccccccccccccccc, dddddddddddddddddddddd)";
    const lines = pyFormat(src).text.split("\n");
    assert.equal(lines[0], "qs = ['Q1', 'Q2', 'Q3', 'Q4']", "short: spacing only, still one line");
    assert.equal(lines[1], "out = f(");
    assert.match(lines[2], /^ {4}aaaaaaaaaaaaaaaaaaaaaaaa,$/, "one argument per line, indented, comma trailing");
    assert.equal(lines.at(-1), ")");
});

test("a single-argument call still breaks the thing INSIDE it", () => {
    // `pd.DataFrame({...})` has no top-level comma, and skipping past a group with no separators left the
    // dict it wraps on one 180-character line — the exact case this was written for.
    const src = "out = pd.DataFrame({'a': [1, 2, 3], 'b': [4, 5, 6], 'ccccccccccccccc': [7, 8, 9], 'ddddddddddddddd': [10, 11, 12]})";
    const text = pyFormat(src).text;
    assert.match(text, /^out = pd\.DataFrame\(\{$/m);
    assert.match(text, /^ {4}'a': \[1, 2, 3\],$/m);
    assert.equal(sig(text), sig(src));
});

test("PEP8 spacing: after a comma and after a dict colon — but never inside a subscript", () => {
    const r = pyFormat("x = {'a':1,'b':2}\ny = z[1:2]\nw = df[qs].sum(axis=1)");
    const lines = r.text.split("\n");
    assert.equal(lines[0], "x = {'a': 1, 'b': 2}");
    // A slice and an annotation are indistinguishable without a parser and PEP8 wants them spaced
    // differently, so leaving it is always right and spacing it sometimes is not.
    assert.equal(lines[1], "y = z[1:2]", "a slice colon is untouched");
    assert.equal(lines[2], "w = df[qs].sum(axis=1)", "a keyword = stays tight, as PEP8 asks");
});

test("strings and comments are copied byte for byte", () => {
    const src = "s = 'a,b:c'   # a comment, with: punctuation\nt = \"keep  the   spaces\"";
    const r = pyFormat(src);
    assert.match(r.text, /'a,b:c'/, "no spacing applied inside a string");
    assert.match(r.text, /# a comment, with: punctuation/);
    assert.match(r.text, /"keep {2}the {3}spaces"/);
});

test("a triple-quoted string is left entirely alone", () => {
    // It carries its own newlines, so re-joining the statement would change the string VALUE.
    const src = 'doc = """line one\n  line two\n"""\nx = 1';
    const r = pyFormat(src);
    assert.match(r.text, /"""line one\n {2}line two\n"""/);
    assert.equal(sig(r.text), sig(src));
});

test("blank lines and indentation survive", () => {
    const src = "def f():\n    a = 1\n\n    return a\n";
    const r = pyFormat(src);
    assert.equal(r.text.replace(/\n$/, ""), "def f():\n    a = 1\n\n    return a");
    assert.equal(r.changed, false, "nothing here was worth moving");
});

// The line map. Reflowing moves line numbers, and a traceback's entire content is a line number. A renderer
// showing reformatted code beside an unmapped traceback is worse than one that never reformats.

test("the map says where each original line went", () => {
    const src = [
        "a = 1",
        "out = f(aaaaaaaaaaaaaaaaaaaaaa, bbbbbbbbbbbbbbbbbbbbbb, cccccccccccccccccccccc, dddddddddddddddddddd)",
        "b = 2",
    ].join("\n");
    const r = pyFormat(src);
    const shown = r.text.split("\n");
    assert.equal(r.map[1], 1);
    assert.equal(shown[r.map[2] - 1], "out = f(", "line 2 starts where its statement starts");
    assert.equal(shown[r.map[3] - 1], "b = 2", "and the line after it followed the shift");
});

test("a statement that spanned several original lines maps them all to where it starts", () => {
    // Python reports the statement line for a multi-line statement, so this is the honest answer rather
    // than a convenience.
    const src = "out = f({'a': 1,\n         'b': 2})\nz = 3";
    const r = pyFormat(src);
    assert.equal(r.map[1], r.map[2], "both original lines belong to one statement");
    assert.equal(r.text.split("\n")[r.map[3] - 1], "z = 3");
});

test("the map is total: every original line has an answer", () => {
    const src = "a = 1\n\n\nb = {'x': 1,\n\n     'y': 2}\nc = 3\n";
    const r = pyFormat(src);
    for (let n = 1; n <= src.split("\n").length; n++) {
        assert.equal(typeof r.map[n], "number", `line ${n} has no mapping`);
        assert.ok(r.map[n] >= 1);
    }
});

// Declining is a feature. A formatter that is WRONG is worse than one that does nothing: the reader would be
// looking at code that is not what ran, with no way to tell.

test("code it cannot account for comes back untouched, with an identity map", () => {
    for (const bad of ["x = 'unterminated", "y = (1, 2", "z = 'no\nclose'"]) {
        const r = pyFormat(bad);
        assert.equal(r.text, bad, `should have declined: ${JSON.stringify(bad)}`);
        assert.equal(r.changed, false);
        assert.equal(r.map[1], 1);
    }
});

test("an unbalanced bracket inside an otherwise fine file does not mangle the file", () => {
    const r = pyFormat("a = 1\nb = f(1, 2\nc = 3");
    assert.equal(r.text, "a = 1\nb = f(1, 2\nc = 3");
});

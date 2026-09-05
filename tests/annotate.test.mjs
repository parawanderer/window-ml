// The pure half of the code-block "Explain" affordance (src/sidebar/annotate.ts): what the utility model
// is asked, and — the part that matters — what is done with whatever it answers. A line number from a
// model is a CLAIM, and a note drawn beside the wrong line is worse than no note at all, so most of this
// is about refusing to draw one.
import { test } from "node:test";
import assert from "node:assert";
import { numberLines, notesMessages, parseNotes, notesByLine, MAX_NOTES, MAX_NOTE_CHARS, NOTES_SCHEMA } from "../src/sidebar/annotate.ts";

const wrap = (notes) => JSON.stringify({ notes });

test("the model is numbered against the lines the reader sees", () => {
    assert.equal(numberLines("a\nb\nc"), "1|a\n2|b\n3|c");
    // An empty trailing line still gets a number: the block draws one, so the model must be able to name it.
    assert.equal(numberLines("a\n"), "1|a\n2|");
});

test("the prompt carries the output when there is one, and omits it when there is not", () => {
    const withOut = notesMessages("python", "x = 1", "42\n");
    assert.match(withOut[1].content, /It produced:\n42/);
    assert.match(withOut[1].content, /1\|x = 1/);
    const noOut = notesMessages("python", "x = 1", "   ");
    assert.doesNotMatch(noOut[1].content, /It produced/);
    // The language is named for the model, not inferred by it.
    assert.match(notesMessages("javascript", "x", "")[0].content, /JavaScript/);
});

test("the reply schema is closed, so a backend in strict mode accepts it", () => {
    assert.equal(NOTES_SCHEMA.additionalProperties, false);
    assert.deepEqual(NOTES_SCHEMA.required, ["notes"]);
    const item = NOTES_SCHEMA.properties.notes.items;
    assert.equal(item.additionalProperties, false);
    assert.deepEqual(item.required, ["line", "note"]);
});

test("a line outside the block is DROPPED, never clamped", () => {
    // Clamping would invent a claim about a line the model never looked at — and it would land on the
    // block's first or last line, which is exactly where a reader would believe it.
    const notes = parseNotes(wrap([{ line: 0, note: "before" }, { line: 9, note: "after" }, { line: 2, note: "real" }]), 3);
    assert.deepEqual(notes, [{ line: 2, note: "real" }]);
});

test("repeats, blanks and non-numbers are dropped; the rest come back in line order", () => {
    const notes = parseNotes(wrap([
        { line: 3, note: "third" },
        { line: 1, note: "first" },
        { line: 3, note: "third again" },
        { line: 2, note: "   " },
        { line: "x", note: "not a line" },
        null,
    ]), 3);
    assert.deepEqual(notes, [{ line: 1, note: "first" }, { line: 3, note: "third" }]);
});

test("notes are capped in count and in length", () => {
    const many = parseNotes(wrap(Array.from({ length: 20 }, (_, i) => ({ line: i + 1, note: `n${i}` }))), 20);
    assert.equal(many.length, MAX_NOTES);
    const long = parseNotes(wrap([{ line: 1, note: "x".repeat(400) }]), 1);
    assert.equal(long[0].note.length, MAX_NOTE_CHARS);
    assert.ok(long[0].note.endsWith("…"));
});

test("a float line number is truncated, and whitespace in a note is collapsed", () => {
    assert.deepEqual(parseNotes(wrap([{ line: 2.7, note: "a\n  b" }]), 3), [{ line: 2, note: "a b" }]);
});

test("anything unparseable degrades to NO notes, never to a wrong one", () => {
    for (const raw of ["", "not json", "null", "42", '{"notes":"nope"}', '{"other":[]}'])
        assert.deepEqual(parseNotes(raw, 5), [], `for ${JSON.stringify(raw)}`);
});

test("a bare array, or an array-wrapped object, is still read", () => {
    // Backends differ on whether a schema'd reply arrives wrapped; the reader accommodates rather than
    // discarding a perfectly good answer over its envelope.
    assert.deepEqual(parseNotes('[{"line":1,"note":"a"}]', 2), [{ line: 1, note: "a" }]);
});

test("notesByLine indexes for the renderer", () => {
    const m = notesByLine([{ line: 2, note: "b" }, { line: 5, note: "e" }]);
    assert.equal(m.get(2), "b");
    assert.equal(m.get(3), undefined);
});

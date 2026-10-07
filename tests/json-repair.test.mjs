// parseLooseJson (src/json-repair.ts): a tool value clipped mid-JSON still parses to the part that arrived whole.
import { test } from "node:test";
import assert from "node:assert";
import { parseLooseJson } from "../src/json-repair.ts";

test("whole JSON parses unchanged; a scalar, prose or a Python repr has no tree", () => {
    assert.deepEqual(parseLooseJson(`{"a":[1,2],"b":null}`), { value: { a: [1, 2], b: null }, droppedChars: null, repaired: false, cutPath: null });
    for (const t of [`42`, `"text"`, `hello world`, `{'a': True}`, ``, `   `, `null`]) assert.equal(parseLooseJson(t), null, t);
});

test("the clip note is stripped and its count reported", () => {
    const r = parseLooseJson(`[1,2,3]… [+120 chars truncated]`);
    assert.deepEqual(r, { value: [1, 2, 3], droppedChars: 120, repaired: false, cutPath: null });
});

test("the clip note says what was SEEN of how much, and the old note a saved session holds still parses", () => {
    // The note now states both numbers (models misjudged how much they had read when it gave only the dropped count).
    assert.deepEqual(parseLooseJson(`[1,2,3]… [first 7 of 127 chars]`), { value: [1, 2, 3], droppedChars: 120, repaired: false, cutPath: null });
    // The UPGRADE: every session and export written before the change carries the old form, and the panel still has to
    // draw its tree. Same value, same dropped count, from either note.
    assert.deepEqual(parseLooseJson(`[1,2,3]… [+120 chars truncated]`), parseLooseJson(`[1,2,3]… [first 7 of 127 chars]`));
});

test("whatever clipOut writes, parseLooseJson reads: the producer and the parser cannot drift apart", async () => {
    const { clipOut } = await import("../src/dom.ts");
    const whole = JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ id: i, name: `row ${i}` })));
    const r = parseLooseJson(clipOut(whole, 200));
    assert.ok(r, "the clipped value still parses");
    assert.equal(r.droppedChars, whole.length - 200);
    assert.equal(r.repaired, true);
    assert.equal(r.value[0].id, 0);
});

test("a cut value is dropped whole and the open containers are closed", () => {
    const cases = [
        [`{"a":1,"b":"hal`, { a: 1 }, []],                       // mid-string value
        [`{"a":1,"b`, { a: 1 }, []],                              // mid-key
        [`{"a":1,"b":`, { a: 1 }, []],                            // key with no value yet
        [`[1,2,3`, [1, 2], []],                                  // a trailing number may be missing digits
        [`[1,2,3,`, [1, 2, 3], []],
        [`[true,fal`, [true], []],
        [`{"rows":[{"id":1},{"id":2,"name":"x`, { rows: [{ id: 1 }, { id: 2 }] }, ["rows", 1]],
        [`{"a":{"b":{"c":[`, { a: { b: { c: [] } } }, ["a", "b", "c"]],
        [`[`, [], []],
        [`{"k\\"q":"v\\"w","n":"x\\"`, { "k\"q": "v\"w" }, []],       // escaped quotes are not the end of a string
    ];
    for (const [text, value, cutPath] of cases) {
        const r = parseLooseJson(text);
        assert.ok(r, text);
        assert.deepEqual(r.value, value, text);
        assert.deepEqual(r.cutPath, cutPath, `${text} → the innermost open container`);
        assert.equal(r.repaired, true, text);
    }
});

test("the user's shape: a pretty-printed array of objects cut mid-row, with the clip note", () => {
    const whole = JSON.stringify({ models: Array.from({ length: 40 }, (_, i) => ({ name: `m${i}`, size: i * 1e9, details: { family: "qwen" } })) }, null, 2);
    const text = `${whole.slice(0, 1500)}… [+${whole.length - 1500} chars truncated]`;
    const r = parseLooseJson(text);
    assert.ok(r);
    assert.equal(r.droppedChars, whole.length - 1500);
    const got = r.value.models;
    assert.ok(got.length > 5 && got.length < 40, `a prefix of the rows (${got.length})`);
    for (const [i, m] of got.slice(0, -1).entries()) assert.deepEqual(m, { name: `m${i}`, size: i * 1e9, details: { family: "qwen" } }, "every row before the cut is intact");
    assert.equal(r.cutPath[0], "models");
});

test("text that is not JSON after all is refused rather than half-drawn", () => {
    for (const t of [`{"a":1]`, `[1,2] trailing`, `{"a": NaN, "b": 1`, `[1, undefined`, `{a: 1}`]) assert.equal(parseLooseJson(t), null, t);
});

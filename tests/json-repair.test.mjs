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
    const { clipOut } = await import("../src/dom/dom.ts");
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

// --- keepOpenString: arguments still being WRITTEN keep the string the model is in the middle of ---

test("keepOpenString: every prefix of a streamed call's arguments shows its code so far, never anything it did not write", () => {
    // Escapes of every kind, so a cut lands inside `\n`, `\"`, `\\` and `\u00e9` as well as between them.
    const code = 'import json\nprint("héllo \\"x\\"", {"a": 1})\npath = "C:\\\\tmp"\nprint("\u00e9t\u00e9")\n';
    const text = JSON.stringify({ title: "plot", code, mode: "script" });
    for (let n = 1; n <= text.length; n++) {
        const r = parseLooseJson(text.slice(0, n), { keepOpenString: true });
        assert.ok(r, `a prefix of ${n} chars still parses`);
        const got = r.value.code;
        if (got != null) assert.ok(code.startsWith(got), `the code at ${n} chars is a prefix of what was written: ${JSON.stringify(got)}`);
        for (const [k, v] of Object.entries(r.value)) if (k !== "code") assert.ok(typeof v !== "string" || ["plot", "script"].some(w => w.startsWith(v)), `${k} at ${n} chars`);
    }
    assert.deepEqual(parseLooseJson(text, { keepOpenString: true }).value, { title: "plot", code, mode: "script" }, "whole, it is the value");
});

test("keepOpenString: the open string is marked, sits at cutPath, and a half-written escape is held back", () => {
    const r = parseLooseJson('{"js": "a\\', { keepOpenString: true });
    assert.deepEqual(r.value, { js: "a" }, "the lone backslash waits for its next character");
    assert.equal(r.openString, true);
    assert.deepEqual(r.cutPath, [], "the open string is a member of the root");
    assert.deepEqual(parseLooseJson('{"js": "a\\u00', { keepOpenString: true }).value, { js: "a" }, "a half \\u escape is held back");
    assert.deepEqual(parseLooseJson('{"js": "a\\\\', { keepOpenString: true }).value, { js: "a\\" }, "an escaped backslash is complete");
    const nested = parseLooseJson('{"rows": [{"t": "ab', { keepOpenString: true });
    assert.deepEqual(nested.value, { rows: [{ t: "ab" }] });
    assert.deepEqual(nested.cutPath, ["rows", 0]);
    assert.deepEqual(parseLooseJson('["x", "y', { keepOpenString: true }).value, ["x", "y"], "inside an array too");
});

test("keepOpenString: a half-written KEY is still dropped, and without the option a cut string is dropped as before", () => {
    const key = parseLooseJson('{"a": 1, "co', { keepOpenString: true });
    assert.deepEqual(key.value, { a: 1 });
    assert.equal(key.openString, undefined);
    const clipped = parseLooseJson('{"a": 1, "b": "hal');
    assert.deepEqual(clipped.value, { a: 1 }, "a clipped value keeps the old reading");
    assert.equal(clipped.openString, undefined);
});

// --- a parameter the model wrote twice, streamed as a duplicate key (the patched Ollama, 1b68cec4) ---

test("a duplicate key reads as the server's whole call does: the first position, the last value, also while cut", () => {
    const whole = parseLooseJson('{"a":"1","b":"2","a":"3"}').value;
    assert.deepEqual(whole, { a: "3", b: "2" });
    assert.deepEqual(Object.keys(whole), ["a", "b"], "the key keeps its first position");
    const cut = parseLooseJson('{"a":"1","b":"2","a":"3 and mo', { keepOpenString: true }).value;
    assert.deepEqual(cut, { a: "3 and mo", b: "2" }, "the repeat being written replaces the first value in the preview");
});

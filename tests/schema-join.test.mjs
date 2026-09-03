"use strict";
// jsonShape's type lattice (shapes MERGE at every depth), joinShapes (the type covering SEVERAL
// documents), and the DerefText wrapper ml.dereference resolves to.
import { test } from "node:test";
import assert from "node:assert";
const { jsonShape, joinShapes, jsonValue } = await import("../dom.ts");
const { DerefText } = await import("../ml-agent.ts");

// --- the merge is recursive, which is what the string-union version could not do ---

test("nested objects MERGE rather than becoming alternatives", () => {
    // The old shape-to-string-then-union produced `{ a: number } | { a: number, b: number }` here: merging
    // only worked at the top level, and the divergence compounded with depth.
    assert.equal(jsonShape([{ u: { a: 1 } }, { u: { a: 1, b: 2 } }]),
        "{ u: { a: number, b?: number } }[] /* 2 items */");
});

test("three-way divergence collapses into one object with two optionals", () => {
    assert.equal(jsonShape([{ u: { a: 1, b: 2 } }, { u: { a: 1 } }, { u: { a: 1, c: 3 } }]),
        "{ u: { a: number, b?: number, c?: number } }[] /* 3 items */");
});

test("arrays nested inside merged objects merge their elements too", () => {
    assert.equal(jsonShape([{ rows: [{ x: 1 }] }, { rows: [{ x: 1, y: 2 }] }]),
        "{ rows: { x: number, y?: number }[] /* 2 items */ }[] /* 2 items */");
});

test("a differing leaf type unions, and the alternatives keep the order they were seen in", () => {
    assert.equal(jsonShape([1, "a", true]), "(number | string | boolean)[] /* 3 items */");
    // Folding on kind alone put `boolean` inside `number` (both primitives), nesting a union and
    // reordering the alternatives.
    assert.equal(jsonShape([{ v: 1 }, { v: "s" }, { v: true }]),
        "{ v: number | string | boolean }[] /* 3 items */");
});

test("unlike kinds stay alternatives instead of being forced together", () => {
    assert.equal(joinShapes([{ a: 1 }, "text", 42, [1]]),
        "{ a: number } | string | number | number[] /* 1 item */");
});

// --- joinShapes: several documents, not one list ---

test("joinShapes: instances of the same thing become one object with optional keys", () => {
    assert.equal(joinShapes([{ a: 1 }, { a: 1, b: 2 }]), "{ a: number, b?: number }");
    // NOT `{ a: number, b?: number }[]` — these are separate documents, not a list.
    assert.doesNotMatch(joinShapes([{ a: 1 }, { a: 1 }]), /\[\]/);
});

test("joinShapes: a key present in every document is NOT optional", () => {
    const s = joinShapes([{ id: 1, x: "a" }, { id: 2 }, { id: 3, x: "c" }]);
    assert.match(s, /id: number/);
    assert.match(s, /x\?: string/, "present in 2 of 3 → optional");
    assert.doesNotMatch(s, /id\?/);
});

test("joinShapes: deep merging works across documents, not just within one", () => {
    assert.equal(joinShapes([{ meta: { page: 1 } }, { meta: { page: 2, next: "u" } }]),
        "{ meta: { page: number, next?: string } }");
});

test("joinShapes: an empty list is unknown, and one document is just its shape", () => {
    assert.equal(joinShapes([]), "unknown");
    assert.equal(joinShapes([{ a: 1 }]), jsonShape({ a: 1 }));
});

test("joinShapes: the caps still bound the output", () => {
    const wide = i => Object.fromEntries(Array.from({ length: 5 }, (_, k) => [`k${k}`, i]));
    assert.match(joinShapes([wide(1), wide(2)], { maxKeys: 2 }), /^\{ k0: number, k1: number, …\+3 \}$/);
    assert.equal(joinShapes([{ a: { b: { c: 1 } } }], { maxDepth: 2 }), "{ a: { b: object } }");
});

// --- jsonValue: what a caller actually has to hand ---

test("jsonValue accepts a parsed value, a JSON string, and a fetch result", () => {
    assert.deepEqual(jsonValue({ a: 1 }, "arg"), { a: 1 });
    assert.deepEqual(jsonValue('{"a":1}', "arg"), { a: 1 });
    assert.deepEqual(jsonValue({ json: { a: 1 }, text: "{}" }, "arg"), { a: 1 }, "the parsed body wins over the text");
    assert.deepEqual(jsonValue({ text: '{"a":1}' }, "arg"), { a: 1 }, "a fetch result that didn't parse still has its text");
    assert.equal(jsonValue(42, "arg"), 42, "a bare number is a valid JSON document");
});

test("jsonValue REFUSES prose rather than inventing a type for it", () => {
    assert.throws(() => jsonValue("Hello there, this is a page.", "argument 2"),
        /argument 2 is plain text \(28 chars\), not JSON/);
    assert.throws(() => jsonValue("{ not json", "arg"), /looks like JSON but doesn't parse/);
    assert.throws(() => jsonValue(undefined, "argument 1"), /argument 1 is undefined/);
});

// --- DerefText: a pointer read that is still a string ---

const derefText = (text, meta) => new DerefText(text, meta, async () => { throw new Error("no repipe in this test"); });

test("DerefText behaves as the string it replaced", () => {
    const v = derefText('{"rows":[1,2]}', { id: "a1b2c3f", tool: "python_exec", kind: "json", step: 3 });

    // every spelling that worked when this returned a bare string
    assert.deepEqual(JSON.parse(v), { rows: [1, 2] });
    assert.equal(`${v}`, '{"rows":[1,2]}');
    assert.equal(v.length, 14);
    assert.equal(String(v), '{"rows":[1,2]}');
    assert.ok(v.startsWith("{"));
    assert.equal(v.split(":")[0], '{"rows"');
    assert.equal(v + "", '{"rows":[1,2]}');
});

test("DerefText carries what the loop knows about the pointer", () => {
    const v = derefText("a,b\n1,2", {
        id: "a1b2c3f", tool: "python_exec", kind: "table", step: 3, label: "the pricing table",
        table: { columns: ["a", "b"], rows: [[1, 2]] },
    });

    assert.equal(v.type, "table", "the type comes from the capturing step, not from sniffing the text");
    assert.equal(v.id, "a1b2c3f");
    assert.equal(v.tool, "python_exec");
    assert.equal(v.step, 3);
    assert.equal(v.label, "the pricing table");
    assert.deepEqual(v.table, { columns: ["a", "b"], rows: [[1, 2]] });
    assert.equal(v.text, "a,b\n1,2");
});

test("DerefText.json parses lazily, and stays undefined for non-JSON", () => {
    assert.deepEqual(derefText('{"a":1}', { kind: "json" }).json, { a: 1 });
    assert.equal(derefText("just prose", { kind: "text" }).json, undefined,
        "asking is how a caller finds out — it must not throw");
    // repeated reads are the same parse, not a re-parse
    const v = derefText('{"a":1}', { kind: "json" });
    assert.strictEqual(v.json, v.json);
});

test("DerefText.schema() gives the shape, and refuses prose", () => {
    assert.equal(derefText('{"a":1,"b":[1,2]}', { kind: "json" }).schema(),
        "{ a: number, b: number[] /* 2 items */ }");
    assert.throws(() => derefText("prose", { kind: "text", id: "a1b2c3f" }).schema(), /not JSON/);
});

test("DerefText defaults are honest when no metadata arrived", () => {
    const v = derefText("text", undefined);
    assert.equal(v.type, "text");
    assert.equal(v.step, -1, "not 0 — that would read as 'captured at step 0'");
    assert.equal(v.id, "");
});

// The documented casualty of the change: it is an object, so a typeof check no longer says "string".
test("DerefText is an object to typeof — the one behaviour that changed", () => {
    const v = derefText("x", { kind: "text" });
    assert.equal(typeof v, "object");
    assert.notStrictEqual(v, "x", "=== against a literal fails, as for any object");
    assert.equal(v.text, "x", "compare .text (or String(v)) instead");
});

// --- jsonValue over a DerefText: what makes ml.schema(ml.dereference(a), …) work ---

test("a pointer read feeds straight into the schema path", () => {
    const a = derefText('{"id":1,"name":"a"}', { kind: "json" });
    const b = derefText('{"id":2}', { kind: "json" });
    assert.equal(joinShapes([jsonValue(a, "argument 1"), jsonValue(b, "argument 2")]),
        "{ id: number, name?: string }");
});

test("jsonValue refuses a host object or class instance — there is no JSON type for one", () => {
    class Thing { constructor() { this.a = 1; } }
    assert.throws(() => jsonValue(new Thing(), "argument 1"), /argument 1 is a Thing, not JSON/);
    assert.throws(() => jsonValue(new Map([["a", 1]]), "arg"), /is a Map, not JSON/);
    // …but a null-prototype bag of data IS json-ish, and an array always is
    assert.deepEqual(jsonValue(Object.assign(Object.create(null), { a: 1 }), "arg"), { a: 1 });
    assert.deepEqual(jsonValue([1, 2], "arg"), [1, 2]);
});

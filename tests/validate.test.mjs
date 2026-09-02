// The minimal JSON-Schema check behind a tool step's `argIssues` (the red strip in the debug view).
// Not a full validator by design — but what it DOES cover must not silently skip a property.
import { test } from "node:test";
import assert from "node:assert";
import { validateArgs } from "../validate.ts";

const schema = {
    type: "object",
    properties: {
        code: { type: "string" },
        n: { type: "integer" },
        flag: { type: "boolean" },
        mode: { type: "string", enum: ["readonly", "full"] },
        items: { type: "array" },
        opts: { type: "object" },
    },
    required: ["code"],
};

test("validateArgs: required, plain types, enum and unknown properties", () => {
    assert.deepEqual(validateArgs(schema, { code: "x" }), []);
    assert.deepEqual(validateArgs(schema, {}), ['missing required "code"']);
    assert.deepEqual(validateArgs(schema, { code: 42 }), ['"code" should be string (got number)']);
    assert.deepEqual(validateArgs(schema, { code: "x", n: 1.5 }), ['"n" should be integer (got number)']);
    assert.deepEqual(validateArgs(schema, { code: "x", mode: "sandbox" }), ['"mode" not in [readonly, full]']);
    assert.deepEqual(validateArgs(schema, { code: "x", nope: 1 }), ['unknown property "nope"']);
    // An array is not an object and vice versa — the distinction JS's `typeof` loses.
    assert.deepEqual(validateArgs(schema, { code: "x", opts: [] }), ['"opts" should be object (got array)']);
    assert.deepEqual(validateArgs(schema, { code: "x", items: {} }), ['"items" should be array (got object)']);
    assert.deepEqual(validateArgs(schema, { code: "x", opts: null }), ['"opts" should be object (got null)']);
    // A schema-less tool can't have "unknown" properties.
    assert.deepEqual(validateArgs(undefined, { anything: 1 }), []);
    assert.deepEqual(validateArgs({ type: "object", properties: {} }, { anything: 1 }), []);
});

// REGRESSION. A property declared as a UNION (`oneOf`/`anyOf`) has no `spec.type`, and the checker only read
// `spec.type` — so a union property was validated as NOTHING AT ALL. python_exec's `tables` is
// "a source string OR a { name: source } map", so `tables: ["current"]` passed clean, reached the tool, and
// came back as `"0" isn't a valid Python variable name` — Object.keys(["current"]) is ["0"]. The model had
// never written "0", could not act on the message, and retried the same call in a loop.
test("validateArgs: a oneOf/anyOf union is type-checked against its branches", () => {
    const union = {
        type: "object",
        properties: {
            tables: { oneOf: [{ type: "string" }, { type: "object", additionalProperties: { type: "string" } }] },
            either: { anyOf: [{ type: "string" }, { type: "number" }] },
        },
    };
    // Both documented forms still pass.
    assert.deepEqual(validateArgs(union, { tables: "current" }), []);
    assert.deepEqual(validateArgs(union, { tables: { sales: "#sales" } }), []);
    // The shape that actually shipped a broken run.
    assert.deepEqual(validateArgs(union, { tables: ["current"] }), ['"tables" should be string or object (got array)']);
    assert.deepEqual(validateArgs(union, { tables: 42 }), ['"tables" should be string or object (got number)']);
    assert.deepEqual(validateArgs(union, { tables: null }), ['"tables" should be string or object (got null)']);
    assert.deepEqual(validateArgs(union, { either: "a" }), []);
    assert.deepEqual(validateArgs(union, { either: 1 }), []);
    assert.deepEqual(validateArgs(union, { either: true }), ['"either" should be string or number (got boolean)']);
});

// A branch with no `type` means "anything", so there is nothing to assert — stay quiet rather than guess.
test("validateArgs: a union it cannot interpret is skipped, not guessed at", () => {
    const loose = { type: "object", properties: { x: { oneOf: [{ type: "string" }, { properties: {} }] } } };
    assert.deepEqual(validateArgs(loose, { x: 42 }), []);
    assert.deepEqual(validateArgs({ type: "object", properties: { x: { oneOf: [] } } }, { x: 42 }), []);
    // An explicit `type` still wins over any union alongside it.
    const both = { type: "object", properties: { x: { type: "string", oneOf: [{ type: "number" }] } } };
    assert.deepEqual(both.properties.x.type && validateArgs(both, { x: 42 }), ['"x" should be string (got number)']);
});

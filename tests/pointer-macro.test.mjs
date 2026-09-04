"use strict";
// The `@tool:` pointer macro — fantasy syntax models already write, made real by a LEXICAL pass.
//
// The tests that matter are the ones about what it must NOT touch. A macro that expands inside a string is
// worse than no macro at all: it turns a working program into a syntax error, and the single most likely
// place a model writes a pointer is inside a line it is logging.
import { test } from "node:test";
import assert from "node:assert";

const { expandPointers } = await import("../src/pointer-macro.ts");
const acorn = await import("acorn");

const x = (src) => expandPointers(src).code;
const ID = "a39f599";   // 7 chars: 6 of payload plus the check character

test("a bare pointer in code position becomes a dereference call", () => {
    assert.equal(x(`const v = @tool:${ID};`), `const v = ml.dereference("@tool:${ID}");`);
});

test("all three reference forms expand — id, bare tool name, quoted label", () => {
    assert.equal(x(`@tool:${ID}`), `ml.dereference("@tool:${ID}")`);
    assert.equal(x("@tool:python_exec"), 'ml.dereference("@tool:python_exec")');
    assert.equal(x('@tool:"the pricing table"'), 'ml.dereference("@tool:\\"the pricing table\\"")');
});

test("no `await` is inserted — the read is SYNCHRONOUS by the time the code runs", () => {
    // Every handle is resolved before the script starts (exec pre-resolves what this scanner found), so
    // `ml.dereference` is an ordinary call here. Inserting `await` would also break inside a non-async
    // callback, e.g. `list.map(x => @tool:a)`.
    assert.ok(!x(`@tool:${ID}`).includes("await"));
    assert.equal(x(`@tool:${ID}.split("\\n")`), `ml.dereference("@tool:${ID}").split("\\n")`);
});

/* ------------------------- what it must NOT touch ------------------------- */

test("a pointer inside a STRING is left alone — the C preprocessor rule", () => {
    // The failure this exists to prevent: expanding here produces `console.log("see ml.dereference("…")")`,
    // which is a syntax error, from a program that was fine.
    const src = `console.log("cited @tool:${ID} here");`;
    assert.equal(x(src), src);
    assert.equal(x(`const s = 'see @tool:${ID}';`), `const s = 'see @tool:${ID}';`);
});

test("…and inside a COMMENT, both kinds", () => {
    assert.equal(x(`// read @tool:${ID}\nconst a = 1;`), `// read @tool:${ID}\nconst a = 1;`);
    assert.equal(x(`/* @tool:${ID} */ const a = 1;`), `/* @tool:${ID} */ const a = 1;`);
});

test("…and inside a regex literal", () => {
    const src = `const re = /@tool:[a-f0-9]+/g;`;
    assert.equal(x(src), src);
});

test("a template literal is text, but ${…} is CODE", () => {
    // Both halves in one string, because getting one right and the other wrong is the likely bug.
    assert.equal(
        x("`literal @tool:python_exec and ${@tool:python_exec}`"),
        '`literal @tool:python_exec and ${ml.dereference("@tool:python_exec")}`');
});

test("nested template interpolation still comes back to the template", () => {
    assert.equal(
        x("`a ${`b ${@tool:python_exec} c`} d @tool:python_exec`"),
        '`a ${`b ${ml.dereference("@tool:python_exec")} c`} d @tool:python_exec`');
});

test("an escaped quote does not end the string it is in", () => {
    const src = `const s = "he said \\" @tool:${ID}";`;
    assert.equal(x(src), src, "the pointer is still inside the string");
});

test("division is not mistaken for a regex", () => {
    // `/` after a value is division; treating it as a regex would swallow the rest of the line and hide a
    // pointer that should have expanded.
    assert.equal(x(`const r = a / b; const v = @tool:python_exec;`),
        `const r = a / b; const v = ml.dereference("@tool:python_exec");`);
});

/* ------------------------- the bookkeeping ------------------------- */

test("source with no pointer is returned UNCHANGED and untouched", () => {
    // exec already works; a pass that rewrote pointer-free code would be pure downside.
    const src = `const s = "no pointers"; /* none */ const r = /x/g;`;
    const out = expandPointers(src);
    assert.equal(out.code, src);
    assert.deepEqual(out.expansions, []);
});

test("each expansion reports where it landed and what it came from", () => {
    // What a renderer marks, so a reader can hover the call and see the text the model wrote.
    const out = expandPointers(`f(@tool:${ID});`);
    assert.equal(out.expansions.length, 1);
    const e = out.expansions[0];
    assert.equal(e.from, `@tool:${ID}`);
    assert.equal(out.code.slice(e.start, e.end), `ml.dereference("@tool:${ID}")`);
});

test("a bare @ that is not a pointer is left alone", () => {
    assert.equal(x("const email = a@b;"), "const email = a@b;");
    assert.equal(x("@decorator\nclass X {}"), "@decorator\nclass X {}");
});

test("what it produces PARSES — the check the unexpanded source could never have", () => {
    for (const src of [
        `const v = await @tool:${ID}; console.log("@tool:${ID}", v);`,
        "`t ${@tool:python_exec}`",
        `[@tool:${ID}, @tool:python_exec].length`,
    ]) {
        const { code } = expandPointers(src);
        assert.doesNotThrow(() => acorn.parse(code, { ecmaVersion: "latest", allowAwaitOutsideFunction: true }),
            `should parse: ${code}`);
    }
});

/* ------------------------- adversarial: can the macro inject? ------------------------- */
// The expansion builds a string literal out of matched text, which is the one place a crafted payload could
// try to break out. Per the dialect rule, a new pattern that reaches an allowed method has to be probed for
// whether it can reach anything else.

test("a quoted label cannot break out of the generated string literal", () => {
    // The obvious attempt: close the argument and append a call.
    const evil = String.raw`@tool:"a\") + evil() + (\""`;
    const { code } = expandPointers(`const v = ${evil};`);
    // Whatever it produced must PARSE and must contain exactly one call to dereference — not a second call.
    assert.doesNotThrow(() => acorn.parse(code, { ecmaVersion: "latest" }), code);
    assert.equal((code.match(/ml\.dereference\(/g) || []).length, 1, code);
    assert.ok(!/evil\(\)/.test(code.replace(/"(?:[^"\\]|\\.)*"/g, '""')), "any `evil()` survives only INSIDE the string literal");
});

test("the expansion is always a literal — no interpolation reaches the emitted code", () => {
    for (const payload of [
        String.raw`@tool:"x\\"`,
        '@tool:"${process}"',
        String.raw`@tool:"a\nb"`,
    ]) {
        const { code } = expandPointers(`f(${payload})`);
        assert.doesNotThrow(() => acorn.parse(code, { ecmaVersion: "latest" }), code);
        assert.equal((code.match(/ml\.dereference\(/g) || []).length, 1, code);
    }
});

test("a backtick payload cannot introduce a template literal", () => {
    // A template would make the argument executable rather than inert.
    const { code } = expandPointers('@tool:"`${1+1}`"');
    assert.doesNotThrow(() => acorn.parse(code, { ecmaVersion: "latest" }), code);
    assert.ok(!/`/.test(code.replace(/"(?:[^"\\]|\\.)*"/g, '""')), "the backtick stays inside the string");
});

// test-index.test.mjs — the TEST INDEX itself (scripts/test-index.mjs): what it counts as a test, which section it
// files one under, and the shapes a regex over `test("` gets wrong.
//
// It is parsed rather than grepped, and these are the cases that made that worth the parser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { testsIn } = await import("../scripts/test-index.mjs");

/** Write one throwaway test file and index it. */
function index(source) {
    const dir = mkdtempSync(join(tmpdir(), "tidx-"));
    const file = join(dir, "sample.test.mjs");
    writeFileSync(file, source);
    try { return testsIn(file); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// --- what counts as a test, and what a regex over `test("` would get wrong ---

test("it finds every shape a test is declared in, and nothing that only looks like one", () => {
    const { tests } = index(`// sample.test.mjs — a file.
test("a plain one", () => {});
test.skip("a skipped one", () => {});
it(\`a template-literal name\`, () => {});
test(
    "a name on its own line",
    () => {},
);
const note = 'test("not a test, just a string")';
// test("not a test, just a comment")
`);
    assert.deepEqual(tests.map((t) => t.name), [
        "a plain one", "a skipped one", "a template-literal name", "a name on its own line",
    ]);
});

test("a regex literal containing a quote does not swallow the rest of the file", () => {
    // THE BUG THIS EXISTS FOR. `/doesn't report vision/` reads as the start of a single-quoted string to anything
    // that only tracks quotes, and everything up to the next apostrophe disappears with it — ninety-five tests, in
    // the file where it happened. A regex is consumed whole, and a `/` is only a regex where one can begin.
    const { tests } = index(`// sample.test.mjs — a file.
test("before the regex", () => {
    assert.match(x, /doesn't report vision capability/);
});
test("after the regex", () => {});
const ratio = a / b / c;   // division, not a regex
test("after a division", () => {});
`);
    assert.deepEqual(tests.map((t) => t.name), ["before the regex", "after the regex", "after a division"]);
});

test("a name built from a variable is skipped rather than guessed at", () => {
    // Nothing useful can be printed for it, and printing the expression would be worse than printing nothing.
    const { tests } = index(`// sample.test.mjs — a file.\nconst n = "x";\ntest(\`a \${n} name\`, () => {});\n`);
    assert.deepEqual(tests, []);
});

// --- which section a test is filed under ---

test("a test belongs to the nearest section above it, and to none before the first", () => {
    const { tests, sectioned } = index(`// sample.test.mjs — a file.
test("before any section", () => {});
// --- the first group ---
test("under the first", () => {});
// ==== the second group ====
test("under the second", () => {});
`);
    assert.equal(sectioned, true);
    assert.deepEqual(tests.map((t) => [t.name, t.section]), [
        ["before any section", ""],
        ["under the first", "the first group"],
        ["under the second", "the second group"],
    ]);
});

test("a file with no section markers says so, which is what keeps the ratchet off it", () => {
    // The ratchet only asks about files that already group their tests: demanding a section in a file nobody has
    // sorted out yet would block an unrelated fix, which is how a check stops being run.
    const { sectioned } = index(`// sample.test.mjs — a file.\ntest("alone", () => {});\n`);
    assert.equal(sectioned, false);
});

test("a rule of dashes with no words is a divider, not a section", () => {
    const { tests } = index(`// sample.test.mjs — a file.\n// ------------------------------\ntest("after a rule", () => {});\n`);
    assert.equal(tests[0].section, "");
});

// --- the file's own summary, which is what a search matches on ---

test("the summary is the header's first sentence, without the filename that opens it", () => {
    const { summary } = index(`// sample.test.mjs — what this file covers. A second sentence that is not the summary.
// A second line of the same block.

import { test } from "node:test";
test("one", () => {});
`);
    assert.equal(summary, "what this file covers.");
});

test("a file that opens with code rather than a comment has no summary", () => {
    const { summary } = index(`import { test } from "node:test";\ntest("one", () => {});\n`);
    assert.equal(summary, "");
});

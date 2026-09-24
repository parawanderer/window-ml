// test-cover.test.mjs — how `scripts/test-cover.mjs` reads a file's imports: which specifier shapes it follows,
// which it refuses to guess at, and the two ways a test names a BUILD rather than a module.
//
// The specifier reader is the whole of the tool's correctness — everything after it is a graph walk — so this is
// where the cases that a regex over `import` gets wrong are pinned.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { specifiersOf } = await import("../scripts/test-cover.mjs");

/** Read the specifiers out of one throwaway file. */
function specs(source, name = "sample.test.mjs") {
    const dir = mkdtempSync(join(tmpdir(), "tcov-"));
    const file = join(dir, name);
    writeFileSync(file, source);
    try { return specifiersOf(file).sort(); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// --- the specifier shapes the tests actually use ---

test("it follows static imports, re-exports, require, and dynamic import of a literal", () => {
    assert.deepEqual(specs(`
import a from "./a.js";
export { b } from "./b.js";
const c = require("./c.js");
const d = await import("../src/d.ts");
`), ["../src/d.ts", "./a.js", "./b.js", "./c.js"]);
});

test("a dynamic import is followed from inside a call, which is how these tests load source", () => {
    // `const { x } = await import("../src/chat/attention.ts")` in a `test(…)` body is THE pattern here, and it is
    // nested several nodes deep — a reader that only looks at top-level statements finds none of it.
    assert.deepEqual(specs(`
test("something", async () => {
    const { attentionItems } = await import("../src/chat/attention.ts");
    assert.ok(attentionItems);
});
`), ["../src/chat/attention.ts"]);
});

test("a specifier built from a variable is skipped rather than guessed at", () => {
    // Guessing would be worse than missing: a wrong edge sends you to run the wrong suite with confidence.
    assert.deepEqual(specs('const n = "a"; const m = await import(`../src/${n}.ts`);'), []);
});

test("a package is not ours, and does not become an edge", () => {
    assert.deepEqual(specs('import { test } from "node:test";\nimport x from "preact";'), ["node:test", "preact"]);
    // …they are returned, and dropped at resolution: nothing under the repo resolves them.
});

// --- the two ways a test names a BUILD instead of a module ---

test("a bundle FILE is named as itself, so it can be traced to the entry it was built from", () => {
    // `tests/helpers.js` loads this into a node:vm sandbox; there is no import edge to follow.
    assert.ok(specs('const code = read("dist/sidebar-app.js");').includes("dist/sidebar-app.js"));
});

test("a build DIRECTORY is marked as a build, not mistaken for a module", () => {
    // A harness hands this to a browser. Both spellings appear: the plain name and a resolved relative path.
    for (const dir of ["dist", "dist-web", "../../dist"]) {
        const found = specs(`const ROOT = path.resolve("${dir}");`);
        assert.ok(found.some((s) => s.startsWith("\0build:")), `${dir} should read as a build`);
    }
});

test("a string that merely contains the word dist is not a build", () => {
    const found = specs('const note = "the distance between two points";');
    assert.ok(!found.some((s) => s.startsWith("\0build:")), "prose is not a build directory");
});

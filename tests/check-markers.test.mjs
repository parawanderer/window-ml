// check-markers.test.mjs — a merge-conflict marker left in a tracked file is refused (scripts/check-markers.mjs), whatever
// the file's type, and a heading underline in Markdown is not one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { markerLines, exempt } from "../scripts/check-markers.mjs";

// --- what counts as a marker ---

test("each of git's three marker lines is found, with its 1-based line, in any file type", () => {
    const text = "a {}\n<<<<<<< HEAD\nb {}\n=======\nc {}\n>>>>>>> origin/main\n";
    for (const path of ["src/sidebar/sidebar.css", "src/x.ts", "src/x.html", "manifest.json", "scripts/x.sh"]) {
        assert.deepEqual(markerLines(path, text).map((m) => m.line), [2, 4, 6], path);
    }
});

test("the bare ======= that #1952 left in sidebar.css is found on its own, with no opening marker", () => {
    assert.deepEqual(markerLines("src/sidebar/sidebar.css", ".x {}\n=======\n/* c */\npre.code.morphing { position: relative; }\n"), [{ line: 2, text: "=======" }]);
});

test("a run of eight, a marker inside a line, an indented one and a JS strict-equals are not markers", () => {
    const text = "========\n  =======\nconst s = '=======';\nif (a === b) {}\n<<<<<<<<\nx >>>>>>> y\n<<<<<<<x\n";
    assert.deepEqual(markerLines("src/x.ts", text), []);
});

test("CRLF line endings do not hide a marker", () => {
    assert.deepEqual(markerLines("src/x.ts", "a\r\n=======\r\nb\r\n").map((m) => m.line), [2]);
});

// --- the exemptions ---

test("in Markdown and reStructuredText only the = line is skipped, as a heading underline; < and > markers are still found", () => {
    for (const path of ["docs/x.md", "README.MD", "x.markdown", "docs/x.rst"]) {
        assert.equal(exempt(path), false, path);
        assert.deepEqual(markerLines(path, "Title\n=======\n"), [], path);
        assert.deepEqual(markerLines(path, "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> origin/main\n").map((m) => m.line), [1, 5], path);
    }
});

test("diff and patch files are exempt whole, since they may quote a conflict", () => {
    for (const path of ["tests/fixtures/x.diff", "x.patch"]) {
        assert.equal(exempt(path), true, path);
        assert.deepEqual(markerLines(path, "<<<<<<< HEAD\n=======\n>>>>>>> b\n"), [], path);
    }
    assert.equal(exempt("src/sidebar/sidebar.css"), false);
});

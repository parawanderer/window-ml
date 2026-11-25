// cell-labels.test.mjs — the offline cell classifier (notebooks/cell-labels/, docs/spec/CELL_FACTS.md, Half 2): nothing
// the extension ships reaches it, and its fixture corpus passes.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every file under a directory, recursively. */
function files(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

// --- never an input to the extension ---

test("nothing under src/ imports or names the classifier", () => {
    // src/ does import other notebooks' data (the Python dialect's whitelist); this folder's files, never. Only an import
    // specifier counts: the generated build-diff/build-info files list changed paths, which is not reaching the tool.
    const rx = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|require\(\s*)["'][^"']*(cell-labels|classify-js)/;
    const hits = files(path.join(ROOT, "src")).filter(f => rx.test(fs.readFileSync(f, "utf8")));
    assert.deepEqual(hits.map(f => path.relative(ROOT, f)), []);
});

test("build.mjs names no file of the classifier", () => {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, "build.mjs"), "utf8"), /cell-labels/);
});

// --- the fixture corpus ---

test("the classifier's fixture corpus and export reader pass (test_classify.py)", () => {
    // stdlib unittest, so no environment is needed; it shells out to classify-js.mjs for the JS cells.
    execFileSync("python3", ["-m", "unittest", "discover", "-s", "notebooks/cell-labels", "-p", "test_*.py"], { cwd: ROOT, stdio: "pipe" });
});

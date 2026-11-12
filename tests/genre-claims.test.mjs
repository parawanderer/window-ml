// tests/genre-claims.test.mjs — the GENRES table's claims in scripts/test.mjs: a new redteam-* row lands under
// `redteam` with no edit, a row the CPython gate names is not claimed twice, and the redteam-*python* nudge fires.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TESTS = path.join(ROOT, "tests");

/**
 * `node scripts/test.mjs --list` parsed into genre name -> the set of files it claims. The flag exits before the
 * test-slot acquire, so this is queue-free and cheap — and it runs the redteam getter exactly as the suite does.
 */
function listedGenres() {
    const out = execFileSync(process.execPath, [path.join(ROOT, "scripts", "test.mjs"), "--list"], { cwd: ROOT, encoding: "utf8" });
    const genres = new Map();
    let name = null;
    for (const line of out.split("\n")) {
        const header = line.match(/^(\S+) — .* \((\d+) files\)$/);
        if (header) {
            name = header[1];
            genres.set(name, new Set());
            continue;
        }
        if (name && line.startsWith("  ")) {
            for (const f of line.trim().split(/\s+/)) if (f) genres.get(name).add(f);
        }
    }
    return genres;
}

/** Write a trivially passing probe row into tests/; the caller removes it in `finally`. */
function probe(name) {
    const p = path.join(TESTS, name);
    fs.writeFileSync(p, 'import test from "node:test";\ntest("genre probe: trivially true", () => {});\n');
    return p;
}

/** Run `--check-genres`, return its exit error (null when it passes). */
function checkGenres() {
    try {
        execFileSync(process.execPath, [path.join(ROOT, "scripts", "test.mjs"), "--check-genres"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        return null;
    } catch (e) {
        return e;
    }
}

// --- a new redteam row is claimed with no edit to the table ---
test("a new tests/redteam-*.test.mjs file is claimed by `redteam` and by no other genre", () => {
    const p = probe("redteam-zz-genre-probe.test.mjs");
    try {
        const genres = listedGenres();
        assert.ok(genres.get("redteam")?.has("redteam-zz-genre-probe.test.mjs"), "redteam claims the new row with no edit to test.mjs");
        for (const [name, files] of genres) {
            if (name === "redteam") continue;
            assert.ok(!files.has("redteam-zz-genre-probe.test.mjs"), `${name} claims it too`);
        }
    } finally {
        fs.rmSync(p, { force: true });
    }
});

// --- a row the CPython gate names runs once, in the python genre ---
test("redteam-hard-python-cancel.test.mjs is claimed by `python` and not also by `redteam`", () => {
    const genres = listedGenres();
    assert.ok(genres.get("python")?.has("redteam-hard-python-cancel.test.mjs"), "python claims it (the row needs real CPython)");
    assert.ok(!genres.get("redteam")?.has("redteam-hard-python-cancel.test.mjs"), "redteam does not claim it too");
});

// --- the redteam-*python* nudge beside the cluster check ---
test("--check-genres refuses a redteam-*python* row no python genre names", () => {
    const p = probe("redteam-zz-python-probe.test.mjs");
    try {
        const failed = checkGenres();
        assert.ok(failed, "--check-genres exits nonzero");
        assert.match(`${failed.stdout}${failed.stderr}`, /redteam-zz-python-probe\.test\.mjs/, "the refusal names the stray file");
    } finally {
        fs.rmSync(p, { force: true });
    }
});

test("--check-genres passes on the tree as it stands", () => {
    assert.equal(checkGenres(), null, "the tree as it stands passes both checks");
});

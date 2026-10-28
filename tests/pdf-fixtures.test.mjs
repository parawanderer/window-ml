// The synthetic PDF fixtures (tests/fixtures/pdf/) against the script that writes them (scripts/make-pdf-fixtures.mjs):
// the committed bytes are exactly what the generator produces, so "the answer is known by construction" stays true.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES, FIXTURE_DIR } from "../scripts/make-pdf-fixtures.mjs";

// --- the generator and the committed files agree ---

test("every committed fixture is what the generator writes now, and no other file is there", () => {
    for (const [name, bytes] of Object.entries(FIXTURES)) {
        assert.ok(readFileSync(join(FIXTURE_DIR, name)).equals(bytes), `${name} differs: run node scripts/make-pdf-fixtures.mjs`);
    }
    assert.deepEqual(readdirSync(FIXTURE_DIR).sort(), Object.keys(FIXTURES).sort());
});

test("the fixtures stay small: each under 64 KB", () => {
    for (const [name, bytes] of Object.entries(FIXTURES)) assert.ok(bytes.length < 64 * 1024, `${name} is ${bytes.length} bytes`);
});

test("the generator is deterministic: two builds are byte for byte the same", async () => {
    const again = (await import(`../scripts/make-pdf-fixtures.mjs?again`)).FIXTURES;
    for (const name of Object.keys(FIXTURES)) assert.ok(FIXTURES[name].equals(again[name]), name);
});

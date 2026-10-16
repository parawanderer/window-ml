// dialect-vectors.test.mjs — the shared dialect vectors are well-formed, and every one with a `js` program is run by a test file.

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { GENRES, ENVS, loadVectors, validateVector, vectors } from "./dialect-vectors.mjs";

// --- every genre file loads and validates ---

test("every genre file loads, and every vector in it is well-formed", () => {
    for (const genre of GENRES) {
        const all = loadVectors(genre);
        assert.ok(Array.isArray(all), genre);
        for (const v of all) assert.ok(ENVS.includes(v.env), `${genre}/${v.name}: env`);
    }
});

test("each genre asserts what its file promises", () => {
    for (const v of loadVectors("abuse")) assert.equal(v.expect, "refused", `abuse/${v.name}`);
    for (const v of loadVectors("failure")) {
        assert.equal(v.leaves_nothing, true, `failure/${v.name}`);
        // The JS dialect's state to roll back is the answer set; Python's is the namespace, which every world has.
        if (v.js !== undefined) assert.equal(v.env, "answer", `failure/${v.name}`);
        assert.equal(v.expect, "refused", `failure/${v.name}`);
    }
});

test("the lifted counts do not shrink silently", () => {
    const count = (genre) => loadVectors(genre).filter((v) => v.js !== undefined).length;
    assert.deepEqual(Object.fromEntries(GENRES.map((g) => [g, count(g)])), { abuse: 51, halting: 118, failure: 5, ownership: 66, print: 0 });
});

// --- the Python-only vectors, which wait for the patched interpreter ---

test("the Python vectors do not shrink silently either", () => {
    // Run by nothing yet: they are the acceptance test for the CPython restricted mode (docs/plan/repl/, root H).
    const count = (genre) => loadVectors(genre).filter((v) => v.py !== undefined).length;
    assert.deepEqual(Object.fromEntries(GENRES.map((g) => [g, count(g)])), { abuse: 43, halting: 20, failure: 5, ownership: 19, print: 0 });
});

// --- the loader refuses a malformed vector ---

test("the loader throws on a malformed vector", () => {
    const good = { name: "n", js: "1", env: "none", expect: "refused", reason: "r" };
    validateVector(good, "good");
    validateVector({ ...good, js: undefined, py: "1", expect: { value: null }, budget: 5, leaves_nothing: true, pre: { js: "1" } }, "good py");
    for (const [why, bad] of [
        ["no name", { ...good, name: "" }],
        ["no program", { ...good, js: undefined }],
        ["unknown env", { ...good, env: "browser" }],
        ["unknown expect", { ...good, expect: "passes" }],
        ["a value with a second key", { ...good, expect: { value: 1, extra: 2 } }],
        ["no reason", { ...good, reason: undefined }],
        ["a non-numeric budget", { ...good, budget: "9" }],
        ["leaves_nothing false", { ...good, leaves_nothing: false }],
        ["an unknown field", { ...good, group: "x" }],
    ]) assert.throws(() => validateVector(bad, why), /dialect vector/, why);
});

// --- every vector with a js program is read by a test file ---

test("every vector with a js program is read by a test through vectors() or lifted()", () => {
    const sources = new Map();
    const src = (file) => { if (!sources.has(file)) sources.set(file, readFileSync(new URL(`../${file}`, import.meta.url), "utf8")); return sources.get(file); };
    for (const genre of GENRES) {
        const froms = new Set(loadVectors(genre).filter((v) => v.js !== undefined).map((v) => v.from));
        for (const from of froms) {
            assert.ok(from, `${genre}: a vector with js has no \`from\``);
            const [file, ...rest] = from.split(" ");
            const label = rest.join(" ");
            const text = src(file);
            const read = text.includes(`vectors("${genre}", "${from}")`) || text.includes(`lifted("${genre}", "${label}")`);
            assert.ok(read, `${genre}: nothing in ${file} reads "${label}"`);
            assert.ok(vectors(genre, from).length > 0);
        }
    }
});

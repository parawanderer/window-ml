// pkg-pep.test.mjs — the PEP 440 and PEP 508 parsers of the install verdict (src/python/pkg-pep440.ts, pkg-pep508.ts) held to what Python's `packaging` says about the same strings. Run: node --import tsx --test tests/pkg-pep.test.mjs
//
// tests/fixtures/pkg-pep/cases.json is written by make-cases.py beside it, from `packaging` itself: hand-written edges
// plus every version and specifier in the pinned index snapshot. Where the port is stricter on purpose (non-ASCII, a
// backslash in a quoted string, the length caps) the case is listed in STRICTER with why; every other case must agree.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const { parseVersion, cmpVersion, parseSpecifierSet, specifierSetContains } = await import("../src/python/pkg-pep440.ts");
const { parseRequirement, evaluateMarker } = await import("../src/python/pkg-pep508.ts");

const CASES = JSON.parse(fs.readFileSync(new URL("./fixtures/pkg-pep/cases.json", import.meta.url), "utf8"));

/** Requirements the port refuses and `packaging` reads, each with why. */
const STRICTER = {
    "a; os_name == 'po\\\\six'": "a quoted string holding a backslash: packaging reads it with ast.literal_eval, not ported",
};

// --- the fixture ---

test("fixture: made by packaging 26.3, against the core's marker environment", () => {
    assert.equal(CASES.packaging, "26.3", "cases.json was made by another packaging: check the port against its changes, then rerun make-cases.py");
    const env = JSON.parse(fs.readFileSync(new URL("../notebooks/python-packages/data/pypi-compat/env.json", import.meta.url), "utf8")).rows[0].env;
    assert.deepEqual(CASES.env, env);
    assert.ok(CASES.versions.length > 2900 && CASES.specs.length > 4400 && CASES.requirements.length > 80);
});

// --- PEP 440: which strings are versions, and their order ---

test("pep440: the same strings are versions, in the same order, equal where packaging says equal", () => {
    const valid = CASES.versions.filter(([, rank]) => rank !== null);
    const wrong = CASES.versions.filter(([v, rank]) => (parseVersion(v) !== null) !== (rank !== null)).map(([v]) => v);
    assert.deepEqual(wrong, []);
    const sorted = [...valid].sort((a, b) => cmpVersion(parseVersion(a[0]), parseVersion(b[0])));
    const out = [];
    for (let i = 1; i < sorted.length; i++) {
        const c = cmpVersion(parseVersion(sorted[i - 1][0]), parseVersion(sorted[i][0]));
        const want = Math.sign(sorted[i - 1][1] - sorted[i][1]);
        if (c !== want) out.push(`${sorted[i - 1][0]} vs ${sorted[i][0]}: ${c}, packaging ${want}`);
    }
    assert.deepEqual(out, []);
});

// --- PEP 440: what each specifier set admits ---

test("pep440: every specifier set parses where packaging's does, and admits exactly the versions it admits", () => {
    const wrong = [];
    for (const [spec, admits] of CASES.specs) {
        const set = parseSpecifierSet(spec);
        if ((set === null) !== (admits === null)) { wrong.push(`${JSON.stringify(spec)}: parses ${set !== null}, packaging ${admits !== null}`); continue; }
        if (!set) continue;
        const got = CASES.probes.map((v) => specifierSetContains(set, v) ? "1" : "0").join("");
        if (got !== admits) {
            const at = [...got].flatMap((c, i) => c === admits[i] ? [] : [`${CASES.probes[i]}=${c}`]);
            wrong.push(`${spec}: ${at.slice(0, 6).join(" ")}`);
        }
    }
    assert.deepEqual(wrong.slice(0, 20), [], `${wrong.length} of ${CASES.specs.length} differ`);
});

// --- PEP 508: requirements and markers ---

test("pep508: every requirement parses where packaging's does, to the same name, extras, ranges and marker value", () => {
    const wrong = [];
    for (const [s, want] of CASES.requirements) {
        const r = parseRequirement(s);
        if (STRICTER[s]) { assert.equal(r, null, s); continue; }
        if (!want) { if (r) wrong.push(`${JSON.stringify(s)}: parses, packaging refuses`); continue; }
        if (!r) { wrong.push(`${JSON.stringify(s)}: refused, packaging reads it`); continue; }
        const marker = r.marker ? evaluateMarker(r.marker, CASES.env) : null;
        const got = { name: r.name, extras: [...r.extras].sort(), url: r.url, marker: marker === undefined ? "undefined" : marker };
        const w = { name: want.name, extras: want.extras, url: want.url, marker: want.marker };
        if (JSON.stringify(got) !== JSON.stringify(w)) wrong.push(`${JSON.stringify(s)}: ${JSON.stringify(got)} vs ${JSON.stringify(w)}`);
        // The ranges: the same set as packaging's normalized string, by what each admits.
        const theirs = parseSpecifierSet(want.specifier);
        const differs = CASES.probes.filter((v) => specifierSetContains(r.specifier, v) !== specifierSetContains(theirs, v));
        if (differs.length) wrong.push(`${JSON.stringify(s)}: ranges differ on ${differs.join(" ")}`);
    }
    assert.deepEqual(wrong, []);
});

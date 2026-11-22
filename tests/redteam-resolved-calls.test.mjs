// redteam-resolved-calls.test.mjs — what the describePre/resolvePre split must not give a call: a description that differs from the one the corpus recorded before the split, a resolver that fails and leaves a weaker description behind instead, or an unresolved path that stops counting.
//
// The corpus under tests/fixtures/program-calls/ predates the split (its last change is 0fd67ebd, #1951; 175d0aef
// added only tests/fixtures/program-calls-resolved/), so its recorded `described` and `effects` are what the
// unsplit describeCall said. The split is describeCall = describePre then resolvePre (program-manifest.ts:435), and
// the rows below hold that composition to the old answer, to the failure of a resolver, and to the undescribed call.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { describeCall, describePre, resolvePre } = await import("../src/shell/program-manifest.ts");
const { effectKey, free, boundFor } = await import("../src/effects.ts");

const MANIFESTS = new URL("../src/shell/manifests/", import.meta.url);
const FIXTURES = new URL("./fixtures/program-calls/", import.meta.url);
const manifests = Object.fromEntries(fs.readdirSync(MANIFESTS).filter((f) => f.endsWith(".json")).map((f) =>
    [path.basename(f, ".json"), JSON.parse(fs.readFileSync(new URL(f, MANIFESTS), "utf8"))]));
const fixtures = Object.fromEntries(fs.readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).map((f) =>
    [path.basename(f, ".json"), JSON.parse(fs.readFileSync(new URL(f, FIXTURES), "utf8"))]));
const keys = (e) => e === "unknown" ? "unknown" : e.map(effectKey).sort();
/** The resolver the split used before it took one: a path is the text the caller wrote. */
const asGiven = (p) => ({ kind: "fs", path: p.given });
/** One described fixture call of `program` that has effects, for the failure rows to resolve. */
function withEffects(program) {
    const fx = fixtures[program];
    const c = fx.calls.find((x) => x.described && Array.isArray(x.effects) && x.effects.length);
    assert.ok(c, `positive control: ${program}'s corpus has no described call with effects`);
    const { description, terms } = describePre(c.argv, manifests[program], { version: fx.version });
    assert.ok(terms.some((t) => t.targets.length), `positive control: ${c.argv.join(" ")} has no target to resolve`);
    return { c, m: manifests[program], version: fx.version, description, terms };
}

// --- A. the pre-split answer, held through the split ---

test("RED TEAM: every call the corpus recorded BEFORE the split still describes to that record through describePre and resolvePre", () => {
    let calls = 0, asking = 0;
    for (const [name, fx] of Object.entries(fixtures)) {
        const m = manifests[name];
        for (const c of fx.calls) {
            const label = `${name}: ${c.argv.join(" ")}`;
            const { description, terms } = describePre(c.argv, m, { version: fx.version });
            const split = description.described ? keys(resolvePre(terms, asGiven)) : "unknown";
            assert.equal(description.described, c.described, `${label} describes differently through describePre`);
            assert.deepEqual(split, c.effects, `${label} resolves to other effects than the corpus recorded before the split`);
            const together = describeCall(c.argv, m, { version: fx.version });
            assert.deepEqual({ described: together.described, effects: keys(together.effects) }, { described: c.described, effects: c.effects }, `${label} differs as describeCall`);
            calls++;
            if (!c.described || c.effects === "unknown") asking++;
        }
    }
    assert.ok(calls > 100, `the corpus holds only ${calls} calls, too few to be the pre-split record`);
    assert.ok(asking > 0, "the corpus holds no call that asks, so 'nothing that asked became allowed' proves nothing");
});

// --- B. a resolver that fails ---

test("RED TEAM: a resolver that throws, or answers nothing at all, leaves no description: the call fails instead of being judged on fewer effects", () => {
    const { c, m, version, terms } = withEffects("cat");
    const control = describeCall(c.argv, m, { version, resolve: asGiven });
    assert.equal(control.described, true, "positive control: the call describes with a working resolver");
    assert.deepEqual(keys(control.effects), c.effects, "positive control: the working resolver reproduces the record");
    const targets = terms.reduce((n, t) => n + t.targets.length, 0);
    const booms = [
        ["at the first target", () => { throw new Error("the host did not answer"); }],
        ["at the second", (() => { let n = 0; return (p) => { if (n++ >= 1) throw new Error("the second resolve failed"); return asGiven(p); }; })()],
    ];
    for (const [where, resolve] of booms) {
        if (where === "at the second" && targets < 2) continue;
        assert.throws(() => describeCall(c.argv, m, { version, resolve }), /host did not answer|second resolve failed/, `a resolver failing ${where} was swallowed into a description`);
        assert.throws(() => resolvePre(terms, resolve), /host did not answer|second resolve failed/, `resolvePre swallowed a resolver failing ${where}`);
    }
    for (const [what, resolve] of [["undefined", () => undefined], ["null", () => null]]) {
        assert.throws(() => describeCall(c.argv, m, { version, resolve }), `a resolver answering ${what} yielded a description instead of failing`);
    }
});

test("ADVERSARIAL: a resolver answer that is not an fs resource must not vanish from the effects", { todo: "open: resolvePre hands every answer to fromProgramEffect, which keeps only `kind === \"fs\"` (effects.ts:193), so a resolver returning `{}`, a string or an unknown kind yields [] — a described call with no effects to judge, where the terms had paths. A throw and null fail closed; a malformed object does not. Pre-existing (the unsplit code filtered the same way), but the split makes `resolve` a contract the host side is meant to feed, so a wrong answer should end in an error, never in a weaker description" }, () => {
    const { c, m, version, terms } = withEffects("cat");
    for (const bad of [{}, { path: "/r/README.md" }, { kind: "nonsense" }, "x"]) {
        const answer = () => bad;
        let got;
        try { got = keys(resolvePre(terms, answer)); } catch { continue; }   // an error is the answer this row wants
        assert.notDeepEqual(got, [], `${JSON.stringify(bad)} as a resolver answer left the call described with no effects`);
        assert.equal(describeCall(c.argv, m, { version, resolve: answer }).described, false, `${JSON.stringify(bad)} left the call described`);
    }
});

// --- C. an unresolved path, and an undescribed call ---

test("RED TEAM: a path no resolver resolved is judged as the text given, and that is never free on the plain host", () => {
    const { c, m, version, terms } = withEffects("cat");
    const given = resolvePre(terms, asGiven);
    assert.deepEqual(keys(given), c.effects, "the as-given answer is the corpus's own row, so this is that path");
    assert.equal(free(given, boundFor("host-plain")), false, "an unresolved path was free: nothing was resolved, so nothing covers it");
    // The same call with the paths the truth would hold is free, so the refusal above is the missing resolution.
    const resolved = describeCall(c.argv, m, { version, resolve: (p) => ({ ...asGiven(p), path: `/r/${p.given}`, inRoot: true }) });
    assert.equal(free(resolved.effects, boundFor("host-plain")), true, "positive control: the same call resolved inside a root is free");
});

test("RED TEAM: a call the manifest does not describe has no terms, so no resolver can be asked about it or make it described", () => {
    const name = "cat", m = manifests[name], fx = fixtures[name];
    const bad = fx.calls.find((x) => !x.described);
    assert.ok(bad, "positive control: cat's corpus has a call its manifest does not describe");
    const { description, terms } = describePre(bad.argv, m, { version: fx.version });
    assert.equal(description.described, false, `${bad.argv.join(" ")} describes as known`);
    assert.equal(description.effects, "unknown", "an undescribed call's effects are not unknown");
    assert.deepEqual(terms, [], "an undescribed call gave the resolver something to resolve");
    let asked = 0;
    const d = describeCall(bad.argv, m, { version: fx.version, resolve: () => { asked++; return { kind: "fs", path: "/r" }; } });
    assert.equal(asked, 0, "an undescribed call asked the resolver");
    assert.equal(d.described, false, "an undescribed call described with a resolver present");
    assert.equal(d.effects, "unknown", "an undescribed call's effects changed with a resolver present");
    assert.deepEqual(resolvePre([], () => { throw new Error("no"); }), [], "resolving no terms is not free of asking, it is nothing to resolve");
});

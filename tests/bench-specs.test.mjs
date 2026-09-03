"use strict";
// A bench spec's `succeeded` predicate is CODE, and a wrong one is expensive in a way a wrong assertion is
// not: it does not fail, it silently scores every run in every arm the same way, and the result reads like
// a finding ("this task is too hard for both models") instead of a bug. That is only discovered after the
// GPU time is spent.
//
// This caught a real one before it ran: pointer-ids' read-back predicate looked for a total of 502981 when
// the columns sum to 502980.90, so no correct answer could ever have matched.

import { test } from "node:test";
import assert from "node:assert/strict";

const load = async (name) => (await import(`../tests/e2e/bench/specs/${name}.bench.ts`)).default;
const task = (spec, id) => {
    const t = spec.tasks.find((x) => x.id === id);
    assert.ok(t, `no task ${id} in ${spec.name}`);
    return t;
};
/** Score an answer the way the runner does. */
const scores = (t, answer) => t.succeeded({ answer, steps: [], events: [], result: null });

test("every spec is well formed, and every task id is unique", async () => {
    for (const name of ["smoke", "pointer-ids"]) {
        const spec = await load(name);
        assert.ok(spec.name && spec.tasks.length, `${name} must declare a name and tasks`);
        const ids = spec.tasks.map((t) => t.id);
        assert.equal(new Set(ids).size, ids.length, `${name} has duplicate task ids — they name artifact directories`);
        for (const t of spec.tasks) assert.ok(t.task, `${name}/${t.id} has no task text`);
    }
});

test("pointer-ids/read-back accepts the real total, in the shapes a model writes it", async () => {
    const t = task(await load("pointer-ids"), "read-back");
    for (const ok of [
        "502980.90", "502980.9", "502,980.90", "The total revenue is 502,980.90.",
        "502981", "≈ 502,981", "Total: 502 980.90",
    ]) assert.ok(scores(t, ok), `should accept ${JSON.stringify(ok)}`);
});

test("pointer-ids/read-back rejects a plausible WRONG total", async () => {
    // Without this the predicate could be `() => true` and every test above would pass.
    const t = task(await load("pointer-ids"), "read-back");
    for (const bad of [
        "502,000", "The total is 425330.90", "182340.55", "I could not compute it", "",
    ]) assert.equal(scores(t, bad), false, `should reject ${bad}`);
});

test("pointer-ids/cite-or-retype scores the region, not the number", async () => {
    const t = task(await load("pointer-ids"), "cite-or-retype");
    assert.ok(scores(t, "North had the highest revenue."));
    assert.ok(scores(t, "north"));
    assert.equal(scores(t, "South, at 99,120.10"), false);
});

test("smoke/read-code accepts only a real page code", async () => {
    const t = task(await load("smoke"), "read-code");
    assert.ok(scores(t, "The code is CROSSPAGE-9471."));
    assert.equal(scores(t, "I could not find a code."), false);
});

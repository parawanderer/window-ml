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
import { readFile } from "node:fs/promises";

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

test("pointer-ids/cite-or-retype scores the region the PAGE says wins", async () => {
    // The ground truth is read out of the example page, not restated here. A predicate test can only ever
    // catch internal inconsistency — the read-back total was caught that way, because 502981 contradicts
    // its own arithmetic — and is blind to a predicate that is coherent but describes the wrong DATA.
    // This one was: it looked for North, which is the top region in the SEEDED table (CAPTURED), while
    // this task loads /spreadsheet, where East wins. Both arms would have scored 0 and it would have read
    // as a task too hard rather than a broken bench. Restating the answer here would have re-encoded
    // exactly the same assumption, so the page is asked instead.
    //
    // The page no longer CARRIES an answer (a key in an HTML comment was one `outerHTML` away from the runs
    // that were supposed to compute it), so the winner is computed from the table's own cells — ground truth
    // from the data rather than from a key — and the answers file beside the page has to agree with it.
    const html = await readFile(new URL("../examples/spreadsheet.html", import.meta.url), "utf8");
    const table = /<table id="sales">([\s\S]*?)<\/table>/.exec(html)?.[1] ?? "";
    const totals = {};
    for (const [, region, cells] of table.matchAll(/<tr><td>\w+<\/td><td>(\w+)<\/td>((?:<td class="num">\d+<\/td>)+)<\/tr>/g))
        totals[region] = (totals[region] ?? 0) + [...cells.matchAll(/>(\d+)</g)].reduce((s, m) => s + Number(m[1]), 0);
    assert.equal(Object.keys(totals).length, 4, `parsed the four regions out of #sales (${JSON.stringify(totals)})`);
    const winner = Object.entries(totals).sort((a, b) => b[1] - a[1])[0][0];
    const answers = await readFile(new URL("../examples/spreadsheet.answers.md", import.meta.url), "utf8");
    assert.match(answers, new RegExp(`Highest-grossing region \\| ${winner} \\(${totals[winner]}\\)`), "the answers file agrees with the table");

    const t = task(await load("pointer-ids"), "cite-or-retype");
    assert.ok(scores(t, `${winner} had the highest revenue.`), `must accept the page's own winner (${winner})`);
    assert.ok(scores(t, winner.toLowerCase()), "case must not matter — a model writes it either way");

    // And must reject every OTHER region on the page, or the predicate is not measuring the answer.
    const others = [...new Set([...html.matchAll(/<td>(North|South|East|West)<\/td>/g)].map((m) => m[1]))]
        .filter((r) => r !== winner);
    assert.ok(others.length >= 2, "expected several regions to distinguish between");
    for (const r of others) assert.equal(scores(t, `${r} had the highest revenue.`), false, `must reject ${r}`);
});

test("examples/spreadsheet.html carries no answers — not in its text, its source or its comments", async () => {
    // Everything on the page is reachable by the model it is testing: a read-only `exec` gets `outerHTML`
    // for free, `fetch_url` returns the markup, and a local copy's own URL reads the live DOM. A key hidden
    // in a comment therefore contaminates every run on the page, the bench's included.
    const html = await readFile(new URL("../examples/spreadsheet.html", import.meta.url), "utf8");
    for (const leak of ["6260", "116153", "2440", "24069", "521.67"]) assert.ok(!html.includes(leak), `the page contains the answer ${leak}`);
    assert.doesNotMatch(html, /answer key/i);
    assert.doesNotMatch(html, /spreadsheet\.answers/, "the page must not name the file an agent could go and read");
});

test("smoke/read-code accepts only a real page code", async () => {
    const t = task(await load("smoke"), "read-code");
    assert.ok(scores(t, "The code is CROSSPAGE-9471."));
    assert.equal(scores(t, "I could not find a code."), false);
});

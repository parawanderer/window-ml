"use strict";
// A bench spec's `succeeded` predicate is CODE, and a wrong one is expensive in a way a wrong assertion is
// not: it does not fail, it silently scores every run in every arm the same way, and the result reads like
// a finding ("this task is too hard for both models") instead of a bug. That is only discovered after the
// GPU time is spent.
//
// This caught a real one before it ran: pointer-ids' read-back predicate (on the table its seed used to type in)
// looked for a total of 502981 when the columns summed to 502980.90, so no correct answer could ever have matched.

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

test("pointer-ids/read-back accepts the page's grand total, in the shapes a model writes it", async () => {
    const t = task(await load("pointer-ids"), "read-back");
    for (const ok of [
        "6260", "6,260", "The total is 6,260.", "Total: 6 260 ($k)", "$6,260k", "about $6.26 million", "6.26M",
    ]) assert.ok(scores(t, ok), `should accept ${JSON.stringify(ok)}`);
});

test("pointer-ids/read-back rejects a plausible WRONG total", async () => {
    // Without this the predicate could be `() => true` and every test above would pass. 1455 is the Q1 column alone,
    // 2440 East alone, 62600 a slipped digit, 502980.90 the total of the table the seed used to type in.
    const t = task(await load("pointer-ids"), "read-back");
    for (const bad of [
        "1455", "The total is 2440", "62600", "502,980.90", "I could not compute it", "",
    ]) assert.equal(scores(t, bad), false, `should reject ${bad}`);
});

test("pointer-ids/read-back's total is the page's own: the seed reads #sales, and the predicate's figure is its cells summed", async () => {
    // Ground truth from the page, not restated: the seed's code reads the live table, so the answer is what its cells add
    // up to, and the answers file beside the page has to agree.
    const html = await readFile(new URL("../examples/spreadsheet.html", import.meta.url), "utf8");
    const table = /<table id="sales">([\s\S]*?)<\/table>/.exec(html)?.[1] ?? "";
    const total = [...table.matchAll(/<td class="num">(\d+)<\/td>/g)].reduce((n, m) => n + Number(m[1]), 0);
    assert.equal(total, 6260);
    const answers = await readFile(new URL("../examples/spreadsheet.answers.md", import.meta.url), "utf8");
    assert.match(answers, new RegExp(`Grand total of Q1–Q4 across all reps \\| ${total}`));
    const t = task(await load("pointer-ids"), "read-back");
    assert.ok(scores(t, String(total)));
    // The seed reads the page (no figure from the table typed into its code), and keeps only part of the output.
    const call = t.seed.script[0];
    assert.match(call.args.js, /document\.querySelector\("#sales"\)/);
    for (const n of ["6260", "850", "215"]) assert.ok(!call.args.js.includes(n), `the seed's code types in ${n}`);
    assert.ok(call.args.maxChars > 0 && call.args.maxChars < 200, "cut, so the rest is behind a pointer");
});

test("pointer-ids/cite-or-retype scores the region the PAGE says wins", async () => {
    // The ground truth is read out of the example page, not restated here. A predicate test can only ever
    // catch internal inconsistency — the read-back total was caught that way, because 502981 contradicts
    // its own arithmetic — and is blind to a predicate that is coherent but describes the wrong DATA.
    // This one was: it looked for North, the top region in the table read-back's seed used to type in, while
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

// --- tools-into-js: the reduced toolsets score the shapes each arm plausibly writes ---

test("tools-into-js/sales-total accepts the exact total however it is grouped, float noise included, and rejects a rounded one", async () => {
    const t = task(await load("tools-into-js"), "sales-total");
    for (const a of ["The total is 2562507.54.", "$2,562,507.54", "2 562 507.54", "Sum of amount: 2562507.5400000005 (≈ 2,562,507.54)"])
        assert.ok(scores(t, a), a);
    for (const a of ["About $2.56 million.", "2562507.5", "2,562,508", "I can only see a preview of the first rows; their total is 41,233.10."])
        assert.equal(scores(t, a), false, a);
});

test("tools-into-js/find-out accepts 2.4.0 with no navigate, and rejects an older version or a navigated run", async () => {
    const t = task(await load("tools-into-js"), "find-out");
    const run = (answer, steps = []) => t.succeeded({ answer, steps, events: [], result: null });
    assert.ok(run("The newest version in the changelog is 2.4.0."));
    assert.ok(run("2.4.0", [{ tool: "exec" }]), "the exec arm's run, which cannot navigate");
    assert.equal(run("The newest version is 2.3.1."), false);
    assert.equal(run("It is 2.4.0.", [{ tool: "navigate" }]), false);
});

test("tools-into-js's arms are fetch_url, exec and both, each with answer and no navigate, and a cell's tools are its arm's", async () => {
    const spec = await load("tools-into-js");
    const { ARMS } = await import("../tests/e2e/bench/specs/tools-into-js.bench.ts");
    assert.deepEqual(spec.dimensions.arm, ["tool", "exec", "both"]);
    assert.deepEqual(ARMS, { tool: ["fetch_url", "answer"], exec: ["exec", "answer"], both: ["fetch_url", "exec", "answer"] });
    for (const arm of spec.dimensions.arm) {
        const e = spec.apply({ model: "m", arm });
        assert.deepEqual(e.tools, ARMS[arm]);
        assert.equal(e.agentOptions.navigate, false, `${arm}: no navigate, which every run gets unless it is turned off`);
    }
    for (const t of spec.tasks) assert.equal(t.regression.included, false, `${t.id} measures a reduced toolset`);
});


// --- prompt-budget-cuts: the panel's agreed cuts, and the pages its tasks read ---

test("prompt-budget-cuts/pipe-log accepts the FATAL line's code with no navigation, and rejects an ERROR line's code or a navigated run", async () => {
    const t = task(await load("prompt-budget-cuts"), "pipe-log");
    for (const ok of ["E-4471", "The FATAL line gives **E-4471**.", "error code: E-4471 (ledger write lost its lease)"]) assert.ok(scores(t, ok), ok);
    for (const bad of ["E-2017", "E-44710", "There is no FATAL line."]) assert.ok(!scores(t, bad), bad);
    assert.ok(!t.succeeded({ answer: "E-4471", steps: [{ tool: "navigate" }], events: [], result: null }), "a navigated run");
    const { startPageServer } = await import("../examples/cross-page/serve.mjs");
    const site = await startPageServer();
    try {
        const lines = (await fetch(`${site.url}/logs/app.log`).then((r) => r.text())).trimEnd().split("\n");
        const fatal = lines.flatMap((l, i) => (/FATAL/.test(l) ? [i] : []));
        assert.equal(fatal.length, 1, "one FATAL line");
        assert.match(lines[fatal[0]], /\bE-4471\b/);
        assert.ok(fatal[0] > 3000 && lines.length - fatal[0] > 100, "near the end, and not the last line");
        assert.equal(lines.filter((l) => /E-4471/.test(l)).length, 1, "no other line carries the code");
    } finally { await site.stop(); }
});

test("prompt-budget-cuts/disabled-controls accepts every disabled button, an enabled one only when called enabled, and the page's buttons are the predicate's", async () => {
    const t = task(await load("prompt-budget-cuts"), "disabled-controls");
    assert.ok(scores(t, "Archive, Export, Merge, Rebase, Transfer, Lock and Purge are disabled."));
    // The shapes rep2's runs wrote, every one right: the old predicate failed each for naming the enabled four.
    assert.ok(scores(t, "Archive, Export, Merge, Rebase, Transfer, Lock, Purge; Save is enabled."), "an enabled one called enabled");
    assert.ok(scores(t, "Seven buttons are disabled: **Archive, Export, Merge, Rebase, Transfer, Lock, Purge** (the enabled ones are Save, Share, Rename, Duplicate)."));
    assert.ok(scores(t, "Disabled: **Archive, Export, Merge, Rebase, Transfer, Lock, Purge** (7 of 11 buttons; the other four — Save, Share, Rename, Duplicate — are enabled)."));
    assert.ok(scores(t, "Disabled (7): Archive, Export, Merge, Rebase, Transfer, Lock, Purge.\nEnabled (4): Save, Share, Rename, Duplicate."));
    assert.ok(!scores(t, "Archive, Export, Merge, Rebase, Transfer and Lock."), "one missing");
    assert.ok(!scores(t, "Disabled: Save, Archive, Export, Merge, Rebase, Transfer, Lock, Purge."), "an enabled one called disabled");
    assert.ok(!scores(t, "Disabled: Archive, Export, Merge, Rebase, Transfer, Lock. Enabled: Save, Share, Rename, Duplicate, Purge."), "a disabled one called enabled");
    assert.ok(!scores(t, "All of them are disabled: Save, Archive, Export, Share, Merge, Rebase, Rename, Transfer, Lock, Duplicate, Purge."), "all of them");
    const { startPageServer } = await import("../examples/cross-page/serve.mjs");
    const site = await startPageServer();
    try {
        const html = await fetch(`${site.url}/controls`).then((r) => r.text());
        const buttons = [...html.matchAll(/<button type="button" class="tb"( disabled)?>(\w+)<\/button>/g)].map((m) => [m[2], !!m[1]]);
        const { CONTROLS } = await import("../examples/cross-page/prompt-cuts.mjs");
        assert.deepEqual(buttons, CONTROLS);
        assert.equal(buttons.filter(([, off]) => off).length, 7);
        assert.doesNotMatch(html.replace(/ disabled>/g, ">").replace(/:disabled/g, ""), /disabled/i, "nothing but the state says which");
    } finally { await site.stop(); }
});

test("prompt-budget-cuts/shared-watch accepts a step that climbs, and rejects one called stuck", async () => {
    const t = task(await load("prompt-budget-cuts"), "shared-watch");
    for (const ok of ["It's climbing: 1, then 2, then 3.", "It increases between my steps, so it is not stuck.", "Climbing, not stuck."]) assert.ok(scores(t, ok), ok);
    for (const bad of ["It is stuck at 1.", "The step looks frozen.", "It stays stuck, it never increases."]) assert.ok(!scores(t, bad), bad);
});

test("prompt-budget-cuts/md-after-nav needs the navigation and the page's own Markdown URL, which pageInfo reports", async () => {
    const t = task(await load("prompt-budget-cuts"), "md-after-nav");
    const nav = [{ tool: "navigate" }];
    assert.ok(t.succeeded({ answer: "It publishes http://127.0.0.1:8080/docs/guide.md", steps: nav, events: [], result: null }));
    assert.ok(!t.succeeded({ answer: "/docs/guide.md", steps: [], events: [], result: null }), "no navigation");
    assert.ok(!t.succeeded({ answer: "/docs/guide.html", steps: nav, events: [], result: null }));
    const { startPageServer } = await import("../examples/cross-page/serve.mjs");
    const site = await startPageServer();
    try {
        const html = await fetch(`${site.url}/docs/guide`).then((r) => r.text());
        assert.match(html, /<link rel="alternate" type="text\/markdown" href="\/docs\/guide\.md">/);
        assert.doesNotMatch(html.replace(/<link[^>]*>/, ""), /guide\.md/, "the body does not give the URL away");
        const md = await fetch(`${site.url}/docs/guide.md`);
        assert.equal(md.status, 200);
        assert.match(md.headers.get("content-type"), /^text\/markdown/);
    } finally { await site.stop(); }
});

test("prompt-budget-cuts-vision/red-circles accepts exactly the red-circle tiles, and the page's source does not name them", async () => {
    const t = task(await load("prompt-budget-cuts-vision"), "red-circles");
    for (const ok of ["Tiles 2, 5 and 9.", "#2, #5, #9", "Tile 2, tile 5, tile 9 show a red circle."]) assert.ok(scores(t, ok), ok);
    for (const bad of ["Tiles 2, 3, 5 and 9.", "Tiles 2 and 5.", "None of them."]) assert.ok(!scores(t, bad), bad);
    const { startPageServer } = await import("../examples/cross-page/serve.mjs");
    const site = await startPageServer();
    try {
        assert.doesNotMatch(await fetch(`${site.url}/tiles`).then((r) => r.text()), /red|circle|square|triangle/i);
    } finally { await site.stop(); }
});

test("prompt-budget-cuts's arms build what ships and the `cuts` variant, and the cut pipe clause still names every verb", async () => {
    const spec = await load("prompt-budget-cuts");
    assert.deepEqual(spec.dimensions.prompt, ["current", "cuts"]);
    assert.deepEqual(spec.apply({ prompt: "current", model: "m" }).defines, {}, "`current` reuses dist/");
    assert.deepEqual(spec.apply({ prompt: "cuts", model: "m" }).defines, { __ML_PROMPT_VARIANT__: "\"cuts\"" });
    for (const t of spec.tasks) assert.equal(t.regression.included, false, `${t.id} measures a prompt variant`);
    // The variant is read once, at load: a fresh process, so the arm under test is the only one loaded.
    const { execFileSync } = await import("node:child_process");
    const read = (variant) => JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
        `${variant ? `globalThis.__ML_PROMPT_VARIANT__ = ${JSON.stringify(variant)};` : ""}
         const P = await import("./src/agent/prompts.ts"); const T = await import("./src/pointers/text-pipe.ts");
         console.log(JSON.stringify({ pipe: P.PIPE_CLAUSE, deref: P.DEREF_CLAUSE, cmds: T.PIPE_CMDS }));`], { encoding: "utf8" }));
    const cut = read("cuts"), cur = read(null);
    assert.ok(cut.pipe.length < cur.pipe.length * 0.6, `the pipe clause is cut: ${cut.pipe.length} of ${cur.pipe.length}`);
    for (const c of cut.cmds) assert.match(cut.pipe, new RegExp(`\\b${c}\\b`), `the cut clause names ${c}`);
    assert.equal(cut.deref, "");
    assert.ok(cur.deref.length > 0, "what ships keeps READING AN OUTPUT AGAIN");
});

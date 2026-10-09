// The bench's metric extractors, against REAL debug streams from a real browser.
//
// tests/bench-metrics.test.mjs already checks the extractors on synthetic streams, which is where their
// logic is tested. This spec answers the different question those cannot: does a real `__mlDebug` stream
// actually carry the fields they read — `seq`, `modelResult`, `usage` — in the shape they assume? An
// extractor that is correct about a stream the product does not emit reports a confident zero forever.
//
// Deterministic: the fake-LLM is scripted to re-emit, to cite, and to put a re-emission in a seeded turn,
// so every expected reading is known before the run starts.

import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOnce } from "./run-once.mjs";
import { measureRun } from "./bench/metrics.mjs";

const FIND = { tool: "findByText", args: { text: "CROSSPAGE" } };

/** Echo the last tool result verbatim — a model retyping data it was already handed. */
const echo = (req) => {
    const tools = (req.messages || []).filter((m) => m.role === "tool");
    const last = tools.length ? String(tools[tools.length - 1].content ?? "") : "";
    return { content: `Here is what I found: ${last}` };
};

const base = { start: "/step3", tools: ["findByText", "answer"], focusSidebar: false, timeoutMs: 60000, log: () => {} };

test("a run that RETYPES its tool output reads as a re-emission", async () => {
    const run = await runOnce({ ...base, task: "Find the code and report it.", script: [FIND, echo] });
    const m = measureRun(run, {});
    expect(m.ok, `run failed: ${m.error}`).toBe(true);
    expect(m.reEmission.outputs).toBeGreaterThan(0);
    expect(m.reEmission.rate).toBe(1);
});

test("a run that RETYPES IN A DIFFERENT SHAPE reads as a re-emission too", async () => {
    // The verbatim test above is the easy half, and passing it is what let `reEmission` ship blind to
    // every real retype. A model computing over a captured table rewrites it into a literal for `exec`:
    // `Ada,North,120,150` becomes `["Ada", "North", 120, 150],`. Same values, not one 40-character window
    // left. Measured 0.00 on a gemma4:31b run that retyped twelve rows.
    //
    // `verbatim: false` is the assertion that matters: it pins that the VALUE-coverage path caught this,
    // not the substring scan. Drop `sharesValues` and this reads 0.00 again, which is the regression.
    const dump = `const rows = [...document.querySelectorAll('#sales tr')]
  .map(r => [...r.querySelectorAll('td,th')].map(c => c.innerText.trim()).join(','));
console.log(rows.join('\\n'));
return rows.length;`;
    const reformat = (req) => {
        const tools = (req.messages || []).filter((m) => m.role === "tool");
        const last = tools.length ? String(tools[tools.length - 1].content ?? "") : "";
        const rows = last.split("\n").map((l) => l.trim()).filter((l) => l.includes(","))
            .map((l) => l.split(",").map((c) => c.trim()));
        const lit = rows
            .map((r) => "  [" + r.map((c) => (/^-?\d+(\.\d+)?$/.test(c) ? c : JSON.stringify(c))).join(", ") + "],")
            .join("\n");
        return { tool: "exec", args: { js: `const rows = [\n${lit}\n];\nreturn rows.length;` } };
    };

    const run = await runOnce({
        ...base, start: "/spreadsheet", tools: ["exec", "answer"],
        task: "Read the sales table, then compute over the rows.",
        script: [{ tool: "exec", args: { js: dump } }, reformat, { content: "Counted the rows." }],
    });
    const m = measureRun(run, {});
    expect(m.ok, `run failed: ${m.error}`).toBe(true);
    expect(m.reEmission.outputs, "the CSV dump must be captured as a citable output").toBeGreaterThan(0);
    expect(m.reEmission.rate, "a reformatted retype is still a retype").toBe(1);
    expect(m.reEmission.instances.map((i) => i.verbatim),
        "caught by value coverage, NOT by the substring scan").toEqual([false]);
});

test("a run that CITES instead of retyping reads as zero, holding the same data", async () => {
    const run = await runOnce({
        ...base, task: "Find the code and cite it.", toolTokens: true,
        script: [FIND, { content: "The code is in the element I located above." }],
    });
    const m = measureRun(run, {});
    expect(m.ok, `run failed: ${m.error}`).toBe(true);
    expect(m.reEmission.outputs, "the same long output was captured").toBeGreaterThan(0);
    expect(m.reEmission.rate, "…but nothing was retyped").toBe(0);
});

test("usage really reaches the stream, so token cost is measured and not silently zero", async () => {
    const run = await runOnce({ ...base, task: "Find the code and report it.", script: [FIND, { content: "done" }] });
    const m = measureRun(run, {});
    expect(m.tokens.total, "a zero here means the extractor is reading a field the product never sends").toBeGreaterThan(0);
    expect(m.tokens.prompt).toBeGreaterThan(0);
});

test("a SEEDED history is installed, and its behaviour is not charged to the measured turn", async () => {
    const run = await runOnce({
        ...base,
        seed: { task: "Find the code and report it.", script: [FIND, echo] },   // the SEED re-emits
        task: "Now summarise, without repeating the raw output.",
        script: [{ content: "Done — the code was located above." }],
    });
    expect(run.error, `run failed: ${run.error}`).toBeFalsy();
    expect(run.seedBoundaryStep, "the seed turn must have produced steps to divide on").toBeGreaterThanOrEqual(0);

    const measured = measureRun(run, {});
    expect(measured.seeded).toBe(true);
    expect(measured.reEmission.rate, "the seeded turn's re-emission belongs to the script, not the model").toBe(0);

    // Scored WITHOUT the boundary, the same stream shows the seed's re-emission — proving the seed really
    // installed that history rather than the run simply never producing one.
    const unscoped = measureRun({ ...run, seedBoundaryStep: -1 }, {});
    expect(unscoped.reEmission.rate).toBe(1);
});

test("a REAL backend needs no fake — the seed path must not dereference it", async () => {
    // This crashed every real-model run: `seedCfg` was built unconditionally from `fake.url`, and `fake`
    // is null whenever a real backend is configured without a seed. It went unnoticed because the seed
    // feature was only exercised against the fake — the one configuration that hides it. A dead port is
    // enough to prove the harness gets as far as the browser and reports a MODEL failure, not a TypeError.
    const run = await runOnce({
        ...base, task: "anything",
        backend: { chatUrl: "http://127.0.0.1:9/v1/chat/completions", model: "nope", key: "" },
        timeoutMs: 6000,
    });
    expect(String(run.error || "")).not.toMatch(/Cannot read properties of null/);
    expect(run.error, "a dead backend must surface as a run error").toBeTruthy();
});

test("capture: a failed run snapshots the BROWSER; a clean one does not", async () => {
    // The log says what the agent did, not what it was looking at — and for a stuck run that is the
    // question. Captures every open page, since a run can navigate or open a background tab.
    const failed = await runOnce({
        ...base, task: "anything",
        backend: { chatUrl: "http://127.0.0.1:9/v1/chat/completions", model: "nope", key: "" },
        timeoutMs: 6000, artDir: mkdtempSync(join(tmpdir(), "cap-fail-")),
    });
    expect(failed.captured.some((f) => f.endsWith(".png")), "a screenshot of the page it died on").toBe(true);
    expect(failed.captured.some((f) => f.endsWith(".html")), "and the DOM, for the text a screenshot cannot show").toBe(true);

    const clean = await runOnce({
        ...base, task: "Find the code and report it.", script: [FIND, { content: "done" }],
        artDir: mkdtempSync(join(tmpdir(), "cap-clean-")),
    });
    expect(clean.error).toBeFalsy();
    expect(clean.captured, "nothing went wrong, so nothing is captured").toEqual([]);
});

// --- a follow-up after the first turn navigated ---

test("a follow-up turn still runs when the first turn navigated, and the run is scored on both answers", async () => {
    // A navigation reloads the page, taking the agent handle the harness kept on its `window`; the follow-up used to
    // throw on the missing handle and wait out the whole deadline for an answer that could never come.
    const t0 = Date.now();
    const run = await runOnce({
        ...base, tools: null, timeoutMs: 90000,
        task: "Open step 3 and say what is there.", followup: "Now say it again.",
        script: [{ tool: "navigate", args: { url: "/step3" } }, { content: "first answer" }, { content: "second answer" }],
    });
    expect(run.error, `run failed: ${run.error}`).toBeFalsy();
    const m = measureRun(run, { followup: "Now say it again.", succeeded: ({ finalAnswer }) => finalAnswer === "second answer" });
    expect(m.succeeded).toBe(true);
    expect(Date.now() - t0, "it did not wait out the deadline").toBeLessThan(80000);
});


// --- pointer-ids' read-back seed ---

test("read-back's seed reads the real table and leaves the measured turn only its head and a pointer to the rest", async () => {
    // The seed is the spec's own, so this guards the task as it runs: with the whole table in context no model needed
    // `dereference`, and a seed whose code was the data itself read as fabricated to a careful model.
    // Playwright's TypeScript transform can hand the default export back one level down.
    const mod = await import("./bench/specs/pointer-ids.bench.ts");
    const spec = mod.default?.tasks ? mod.default : mod.default?.default;
    const t = spec.tasks.find((x) => x.id === "read-back");
    let sent = null;
    const run = await runOnce({
        ...base, start: t.start, tools: t.tools, toolTokens: true, seed: t.seed, task: t.task,
        script: [(req) => { sent = req.messages; return { content: "6260" }; }],
    });
    expect(run.error, `run failed: ${run.error}`).toBeFalsy();
    const toolMsg = (sent ?? []).filter((m) => m.role === "tool").map((m) => String(m.content)).join("\n");
    expect(toolMsg).toContain("Rep,Region,Q1,Q2,Q3,Q4");
    expect(toolMsg).toContain("Ada,North,120,150,130,160");
    expect(toolMsg, "the last row is behind the cut").not.toContain("Leo,West");
    expect(toolMsg, "the cut note names the pointer to the rest").toMatch(/@tool:/);
});

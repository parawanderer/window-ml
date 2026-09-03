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
        timeoutMs: 20000,
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
        timeoutMs: 20000, artDir: mkdtempSync(join(tmpdir(), "cap-fail-")),
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

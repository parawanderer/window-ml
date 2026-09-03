// Unit tests for the whole-run token accounting (contract.ts runStats) + the per-call timing capture
// (sw-llm.ts normalizeUsage reading Ollama's eval_duration). These feed the DevTools bottom bar, the
// chat_metadata tool, and the exports — one pure computation so all three agree.
import { test } from "node:test";
import assert from "node:assert";
import { runStats, fmtTokPerSec, runStatsProvenance } from "../src/contract.ts";
import { normalizeUsage } from "../src/sw-llm.ts";

const u = (promptTokens, completionTokens, extra = {}) => ({ promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, ...extra });

test("runStats: cumulative in/out are SUMS across calls (billed spend, not live occupancy)", () => {
    const s = runStats([u(100, 20), u(140, 30), u(180, 25)]);
    assert.equal(s.inTokens, 420);      // input re-sent each turn → a real sum (what you're billed)
    assert.equal(s.outTokens, 75);
    assert.equal(s.totalTokens, 495);
    assert.equal(s.calls, 3);
});

test("runStats: tok/s from Ollama eval timing → 'eval' basis (generation-only)", () => {
    // 60 completion tokens over 2s of eval time = 30 tok/s.
    const s = runStats([u(100, 30, { evalMs: 1000 }), u(120, 30, { evalMs: 1000 })]);
    assert.equal(s.genBasis, "eval");
    assert.ok(Math.abs(s.tokPerSec - 30) < 1e-9);
    assert.equal(fmtTokPerSec(s), "30.0 tok/s");
});

test("runStats: falls back to wall-clock genMs → 'wall' basis (includes network)", () => {
    const s = runStats([u(100, 50, { genMs: 2000 })]);   // 50 tok / 2s = 25 tok/s
    assert.equal(s.genBasis, "wall");
    assert.ok(Math.abs(s.tokPerSec - 25) < 1e-9);
    assert.match(runStatsProvenance(s), /wall-clock/);
});

test("runStats: prefers eval over genMs on the SAME call; mixed calls → 'mixed'", () => {
    // Call 1 has both — eval wins (1000ms); call 2 has only wall (1000ms). 20 rated tokens / 2s = 10 tok/s.
    const s = runStats([u(100, 10, { evalMs: 1000, genMs: 9999 }), u(120, 10, { genMs: 1000 })]);
    assert.equal(s.genBasis, "mixed");
    assert.ok(Math.abs(s.tokPerSec - 10) < 1e-9);
    assert.match(runStatsProvenance(s), /Ollama generation time where reported, else wall-clock/);
});

test("runStats: no timing on any call → tok/s null; provenance says so", () => {
    const s = runStats([u(100, 20), u(140, 30)]);
    assert.equal(s.tokPerSec, null);
    assert.equal(s.genBasis, null);
    assert.equal(fmtTokPerSec(s), null);
    assert.match(runStatsProvenance(s), /no per-call timing/);
});

test("runStats: skips null/undefined samples (a call with no server-reported usage)", () => {
    const s = runStats([u(100, 20), null, undefined, u(50, 10, { genMs: 500 })]);
    assert.equal(s.calls, 2);
    assert.equal(s.inTokens, 150);
    assert.equal(s.outTokens, 30);
});

test("fmtTokPerSec: rounds a fast rate to an integer, keeps one decimal when slow", () => {
    assert.equal(fmtTokPerSec(runStats([u(0, 250, { evalMs: 1000 })])), "250 tok/s");   // ≥100 → integer
    assert.equal(fmtTokPerSec(runStats([u(0, 6, { evalMs: 1000 })])), "6.0 tok/s");
});

test("normalizeUsage: reads Ollama eval_duration (ns) → evalMs (ms)", () => {
    const nu = normalizeUsage({ prompt_eval_count: 100, eval_count: 40, eval_duration: 2_000_000_000 });   // 2e9 ns = 2000ms
    assert.equal(nu.promptTokens, 100);
    assert.equal(nu.completionTokens, 40);
    assert.equal(nu.evalMs, 2000);
});

test("normalizeUsage: no eval_duration → no evalMs (cloud / OpenWebUI-OpenAI shape)", () => {
    const nu = normalizeUsage({ prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 });
    assert.equal(nu.evalMs, undefined);
    assert.equal(nu.genMs, undefined);   // genMs is stamped later at the call site, not by normalizeUsage
});

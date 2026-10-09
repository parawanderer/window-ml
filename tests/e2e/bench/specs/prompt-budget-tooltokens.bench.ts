// prompt-budget-tooltokens.bench.ts — does the condensed tool-output-tokens cluster keep models citing and reading back?
//
//   npm run build
//   PROMPT_MODELS=gemma4:31b,gemma4:26b,qwen3.5:9b USE_ENV=1 node --import tsx tests/e2e/bench/run.mjs \
//       tests/e2e/bench/specs/prompt-budget-tooltokens.bench.ts --jobs 1 --serve
//   PROMPT_MODELS=deepseek.deepseek-v4-pro,deepseek.deepseek-flash USE_ENV=1 node --import tsx tests/e2e/bench/run.mjs \
//       tests/e2e/bench/specs/prompt-budget-tooltokens.bench.ts --jobs 4
//
// Step 3 of docs/spec/PROMPT_BUDGET.md: the clause and DEREF_CLAUSE are ~3.7k characters on every call of a run with
// tool tokens; the condensed pair (src/agent/prompts.ts, `__ML_PROMPT_VARIANT__`) is ~1.4k. The cut ships only if
// neither task's pass rate nor re-emission gets worse on any model. Local models share one GPU, so they run one at a
// time (`--jobs 1`) and API models in a second invocation; the cache is per cell, so the two add up.
//
// The tasks are the pointer A/B's (pointer-ids.bench.ts), whose predicates tests/bench-specs.test.mjs already holds
// to the page: cite-or-retype measures re-emission, read-back measures `dereference`.

import { defineBench } from "../spec";
import pointerIds from "./pointer-ids.bench";

/** The panel models, overridden by PROMPT_MODELS (comma-separated) so local and API models run separately. */
const MODELS = (process.env.PROMPT_MODELS || "gemma4:31b,gemma4:26b,qwen3.5:9b").split(",").map(s => s.trim()).filter(Boolean);

export default defineBench({
    name: "prompt-budget-tooltokens",
    description: "Current vs condensed tool-output-tokens clause: do models still cite instead of retyping, and read back?",
    repeats: 3,
    timeoutMs: 300000,
    approve: "auto",

    dimensions: {
        prompt: ["current", "condensed"],
        model: MODELS,
    },

    // `current` needs no define, so it reuses dist/ and measures exactly what ships.
    apply: (combo) => {
        const defines: Record<string, string> = {};
        if (combo.prompt !== "current") defines.__ML_PROMPT_VARIANT__ = JSON.stringify(combo.prompt);
        return { toolTokens: true, defines, backend: { model: combo.model } };
    },

    tasks: pointerIds.tasks,
});

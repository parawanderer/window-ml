// prompt-budget-pycut.bench.ts — with the table fixes of #650 in, do models still load tables when python_exec's
// `tables`/`cast`/`mode` texts are cut to their triggers?
//
//   npm run build
//   PROMPT_MODELS=<ids> PROMPT_SWEEP=<name> USE_ENV=1 node --import tsx \
//       tests/e2e/bench/run.mjs tests/e2e/bench/specs/prompt-budget-pycut.bench.ts --lanes --serve
//
// Round 3 of step 3 (docs/spec/PROMPT_BUDGET.md). Round 2 measured this cut and did not ship it: glm-4.7-flash lost
// csv-total under it. Most of that loss was the tool (#650), so the cut is measured again on the same two table tasks.
// The `pycut` variant (src/tools/tool-details.ts) shows round 2's short texts, as its runs recorded them. Ships only if
// no model's pass rate drops.

import { defineBench } from "../spec";
import { SALES_TOTAL } from "../../../../examples/cross-page/sales.mjs";

/** The models, overridden by PROMPT_MODELS (comma-separated): round 2's three that dropped, and two cheap cloud ones. */
const MODELS = (process.env.PROMPT_MODELS || "glm-4.7-flash:latest,qwen3.6:35b,openrouter.minimax/minimax-m3,deepseek.deepseek-flash,litellm.google/gemini-flash-latest")
    .split(",").map((s) => s.trim()).filter(Boolean);

/** An answer with its digit grouping and currency marks taken out, for matching an exact number. */
const digits = (answer: string): string => answer.replace(/[\s,$]/g, "");

/** Why neither task is in the regression suite: they measure a prompt variant. */
const NOT_YET = { included: false, reason: "a prompt-variant comparison" } as const;

export default defineBench({
    name: process.env.PROMPT_SWEEP || "prompt-budget-pycut",
    description: "Full vs cut python_exec option texts, after the table fixes: do models still load a fetched CSV and a page table?",
    repeats: 8,
    timeoutMs: 300000,
    approve: "auto",

    dimensions: {
        prompt: ["current", "pycut"],
        model: MODELS,
    },

    // `current` needs no define, so it reuses dist/ and measures exactly what ships.
    apply: (combo) => {
        const defines: Record<string, string> = {};
        if (combo.prompt !== "current") defines.__ML_PROMPT_VARIANT__ = JSON.stringify(combo.prompt);
        return { defines, backend: { model: combo.model } };
    },

    tasks: [
        {
            // python_exec `tables` with a URL: the 3,000-row CSV cannot be summed from a preview.
            id: "csv-total",
            task: "The file /sales.csv on this site lists sales, one per row. What is the exact total of its `amount` column?",
            python: true,
            regression: NOT_YET,
            succeeded: ({ answer }) => digits(answer).includes(SALES_TOTAL),
        },
        {
            // python_exec `tables` with a page selector: North's Q3 is Ada 130 + Eve 155.
            id: "table-north-q3",
            start: "/table",
            task: "Using the sales table on this page, what is the total Q3 sales for the North region?",
            python: true,
            regression: NOT_YET,
            succeeded: ({ answer }) => /\b285\b/.test(answer),
        },
    ],
});

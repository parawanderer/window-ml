// prompt-budget-cuts2.bench.ts — do models still use `locate` and `python_exec` when their option texts are cut to the triggers, and recover from a private-rendering error?
//
//   npm run build
//   PROMPT_MODELS=<ids> PROMPT_SWEEP=<name> USE_ENV=1 node --import tsx \
//       tests/e2e/bench/run.mjs tests/e2e/bench/specs/prompt-budget-cuts2.bench.ts --lanes --serve
//
// Step 3, second round (docs/spec/PROMPT_BUDGET.md). The `cuts2` variant (src/tools/tool-details.ts) keeps `locate`'s
// and `python_exec`'s triggers in the schema and serves their mechanics from `agent_api_docs({ tool })`, and makes the
// "Incognito is off" rendering error lead with the retry that works. Ships only if no model's pass rate drops. Each task
// needs something that moved, and is scored from the run (its answer and steps), never from what the model says it did.
// No canvas task: the bench has no grounding model and its vision reader answered the grid with "", on both texts.

import { defineBench } from "../spec";
import { SALES_TOTAL } from "../../../../examples/cross-page/sales.mjs";

/** The panel models, overridden by PROMPT_MODELS (comma-separated). */
const MODELS = (process.env.PROMPT_MODELS || "litellm.anthropic/claude-sonnet-5-5").split(",").map((s) => s.trim()).filter(Boolean);

/** Whether the run used a tool. */
const used = (steps: { tool?: string }[], name: string): boolean => steps.some((s) => s.tool === name);

/** An answer with its digit grouping and currency marks taken out, for matching an exact number. */
const digits = (answer: string): string => answer.replace(/[\s,$]/g, "");

/** Why none of these is in the regression suite yet: they measure a prompt variant, and two need a vision model. */
const NOT_YET = { included: false, reason: "a prompt-variant comparison; locate's tasks also need a vision model the suite's model list may lack" } as const;

export default defineBench({
    name: process.env.PROMPT_SWEEP || "prompt-budget-cuts2",
    description: "Full vs cut locate/python_exec option texts and the private-rendering error: do models still click an unlabelled icon, load tables, and recover?",
    repeats: 3,
    timeoutMs: 300000,
    approve: "auto",

    dimensions: {
        prompt: ["current", "cuts2"],
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
            // The DOM case: five unlabelled <svg> icons with no role or name; only their shape tells them apart.
            id: "icon-heart",
            start: "/inaccessible-icons",
            task: "Click the heart icon in the toolbar, then tell me exactly what the status line under it says.",
            regression: NOT_YET,
            succeeded: ({ answer, steps }) => /Clicked:\s*heart/i.test(answer) && used(steps, "click"),
        },
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
        {
            // The bench's browser has Incognito off, so a private rendered fetch fails first: the error text decides recovery.
            id: "spa-rendered",
            task: "What does the page at /spa on this site show once its script has run? Don't change the page I'm on.",
            regression: NOT_YET,
            succeeded: ({ answer, steps }) => /SPA-RENDERED-9931/.test(answer) && !used(steps, "navigate"),
        },
    ],
});

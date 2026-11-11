// prompt-budget-pagectx.bench.ts — do models still use the page context (the page's URL, the time) when it leads the
// first user message under PAGE_CONTEXT_HEAD instead of closing the system prompt?
//
//   npm run build
//   PROMPT_MODELS=<ids> PROMPT_SWEEP=<name> USE_ENV=1 node --import tsx \
//       tests/e2e/bench/run.mjs tests/e2e/bench/specs/prompt-budget-pagectx.bench.ts --lanes --serve
//
// docs/spec/PROMPT_BUDGET.md, "the page context leaves the system prompt". `current` is what ships (the context in the
// first user message); `pagectx-system` is the old placement (src/agent/run-assembly.ts). Each task needs one fact the
// context carries: the page's URL to resolve a relative path, and the date. Ships only if no model's pass rate drops.

import { defineBench } from "../spec";

/** The models, overridden by PROMPT_MODELS (comma-separated): the cheap and local ones a move costs first. */
const MODELS = (process.env.PROMPT_MODELS || "glm-4.7-flash:latest,qwen3.6:35b,openrouter.minimax/minimax-m3,deepseek.deepseek-flash,litellm.google/gemini-flash-latest")
    .split(",").map((s) => s.trim()).filter(Boolean);

/** Why no task is in the regression suite: they measure a prompt variant. */
const NOT_YET = { included: false, reason: "a prompt-variant comparison" } as const;

/** The date as YYYY-MM-DD, local and UTC: a run near midnight may read either from the context's `Now:` line. */
const todays = (): string[] => {
    const d = new Date(), pad = (n: number) => String(n).padStart(2, "0");
    return [`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, d.toISOString().slice(0, 10)];
};

export default defineBench({
    name: process.env.PROMPT_SWEEP || "prompt-budget-pagectx",
    description: "Page context at the front of the first user message vs at the end of the system prompt: do models still resolve a page-relative URL and know today's date?",
    repeats: 4,
    timeoutMs: 300000,
    approve: "auto",

    dimensions: {
        prompt: ["current", "pagectx-system"],
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
            // The URL: stock.json exists only beside /shop/aisle-4/, so a path taken from the site root 404s.
            id: "relative-fetch",
            start: "/shop/aisle-4/",
            task: "The file stock.json sits in the same folder as this page. Fetch it and tell me how many pears are in stock.",
            regression: NOT_YET,
            succeeded: ({ answer }) => /\b23\b/.test(answer),
        },
        {
            // The time: nothing on the page or in the task states the date.
            id: "todays-date",
            start: "/shop/aisle-4/",
            task: "What is today's date? Answer with the date only, as YYYY-MM-DD.",
            regression: NOT_YET,
            succeeded: ({ answer }) => todays().some((d) => answer.includes(d)),
        },
    ],
});

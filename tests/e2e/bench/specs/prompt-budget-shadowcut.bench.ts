// prompt-budget-shadowcut.bench.ts — do models still reach into shadow roots and iframes when the prompt's shadow and
// iframe clauses keep the `>>>` notation but drop the edge cases (uncapturable closed roots, cross-origin iframes)?
//
//   npm run build
//   PROMPT_MODELS=<ids> PROMPT_SWEEP=<name> USE_ENV=1 node --import tsx \
//       tests/e2e/bench/run.mjs tests/e2e/bench/specs/prompt-budget-shadowcut.bench.ts --lanes --serve
//
// Step 3 of docs/spec/PROMPT_BUDGET.md. The cut text is the `shadowcut` variant (src/agent/prompts.ts); the edge cases
// it drops are still stated by the tools where a model meets one (the scan note on a sealed root, the page orientation
// and describeElement on a cross-origin iframe). Ships only if no model's pass rate drops.

import { defineBench } from "../spec";

/** The models, overridden by PROMPT_MODELS (comma-separated): the cheap and local ones a cut costs first. */
const MODELS = (process.env.PROMPT_MODELS || "glm-4.7-flash:latest,qwen3.6:35b,openrouter.minimax/minimax-m3,deepseek.deepseek-flash,litellm.google/gemini-flash-latest")
    .split(",").map((s) => s.trim()).filter(Boolean);

/** Why no task is in the regression suite: they measure a prompt variant. */
const NOT_YET = { included: false, reason: "a prompt-variant comparison" } as const;

export default defineBench({
    name: process.env.PROMPT_SWEEP || "prompt-budget-shadowcut",
    description: "Full vs cut shadow/iframe clauses: do models still reach controls in open, closed and sealed shadow roots and in iframes?",
    repeats: 4,
    timeoutMs: 300000,
    approve: "auto",

    dimensions: {
        prompt: ["current", "shadowcut"],
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
            // The notation itself: nested OPEN roots, the code appears only after a click inside them.
            id: "shadow-open",
            start: "/shadow-dom",
            task: "Reveal and read the access code in the first panel on this page.",
            regression: NOT_YET,
            succeeded: ({ answer }) => /SHDW-7788/.test(answer),
        },
        {
            // A CLOSED root the extension captured at attachShadow: the clause's "open and closed".
            id: "shadow-closed",
            start: "/shadow-dom?mode=closed",
            task: "Reveal and read the access code in the first panel on this page.",
            regression: NOT_YET,
            succeeded: ({ answer }) => /SHDW-7788/.test(answer),
        },
        {
            // The edge case the cut drops: a declarative closed root no capture reaches. The scan note flags it; the
            // way in is locate → a CDP click on the @pt.
            id: "shadow-sealed",
            start: "/shadow-dom",
            task: "Reveal and read the backup access code in the second panel on this page.",
            regression: NOT_YET,
            succeeded: ({ answer }) => /SEAL-9931/.test(answer),
        },
        {
            // `iframe >>> inner`: the order number is not in any DOM until the button inside the frame is pressed.
            id: "iframe-same",
            start: "/frames",
            task: "Reveal and read the order number in the checkout widget on this page.",
            regression: NOT_YET,
            succeeded: ({ answer }) => /ORDER-5521/.test(answer),
        },
        {
            // The other edge case the cut drops: a CROSS-ORIGIN frame no selector enters (fetching its src, or looking, works).
            id: "iframe-cross",
            start: "/frames",
            task: "What code does the partner widget on this page show?",
            regression: NOT_YET,
            succeeded: ({ answer }) => /XDOMAIN-2025/.test(answer),
        },
    ],
});

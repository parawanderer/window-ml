// prompt-budget-cuts.bench.ts — do models still do what the cut text was for, once the panel's agreed cuts are made?
//
//   npm run build
//   PROMPT_MODELS=<ids> PROMPT_SWEEP=<name> USE_ENV=1 node --import tsx \
//       tests/e2e/bench/run.mjs tests/e2e/bench/specs/prompt-budget-cuts.bench.ts --lanes --serve
//
// docs/spec/PROMPT_BUDGET.md, "seven stronger models read the agent prompt (panel-bloat)". `current` is what ships;
// `cuts` is the shorter prompt and schemas (src/agent/prompt-variant.ts). Each task needs one piece of the text that
// moves: the pipe dialect, the python clause, READING AN OUTPUT AGAIN, the self and `ml.current` paragraphs, the
// `token` text, `pageInfo` after a navigation, the exec wording and the compose hint. Ships only if no model's pass
// rate drops. The vision paragraph is measured apart, on vision models only (prompt-budget-cuts-vision.bench.ts).

import { defineBench } from "../spec";
import { SALES_TOTAL } from "../../../../examples/cross-page/sales.mjs";
import { FATAL_CODE, CONTROLS, GUIDE_MD } from "../../../../examples/cross-page/prompt-cuts.mjs";
import { READ_SALES, SEED_KEEPS } from "./pointer-ids.bench";

/** The models, overridden by PROMPT_MODELS (comma-separated): the cheap and local ones a cut costs first. */
const MODELS = (process.env.PROMPT_MODELS || "glm-4.7-flash:latest,qwen3.6:35b,openrouter.minimax/minimax-m3,deepseek.deepseek-flash,deepseek.deepseek-v4-pro,litellm.google/gemini-flash-latest")
    .split(",").map((s) => s.trim()).filter(Boolean);

/** Why no task is in the regression suite: they measure a prompt variant. */
const NOT_YET = { included: false, reason: "a prompt-variant comparison" } as const;

/** Whether the run moved the user's tab. */
const navigated = (steps: { tool?: string }[]): boolean => steps.some((s) => s.tool === "navigate");

/** An answer with its digit grouping and currency marks taken out, for matching an exact number. */
const digits = (answer: string): string => answer.replace(/[\s,$]/g, "");

export default defineBench({
    name: process.env.PROMPT_SWEEP || "prompt-budget-cuts",
    description: "The panel's agreed cuts to the system prompt and tool schemas: do models still pipe, compute, read back, find themselves and their watches, and pick the right tool?",
    repeats: 3,
    timeoutMs: 300000,
    approve: "auto",

    dimensions: {
        prompt: ["current", "cuts"],
        model: MODELS,
    },

    // `current` needs no define, so it reuses dist/ and measures exactly what ships.
    apply: (combo) => {
        const defines: Record<string, string> = {};
        if (combo.prompt !== "current") defines.__ML_PROMPT_VARIANT__ = JSON.stringify(combo.prompt);
        return { toolTokens: true, defines, backend: { model: combo.model } };
    },

    tasks: [
        {
            // THE PIPE DIALECT: the log is far longer than any result a tool returns whole, and the line is near its end.
            id: "pipe-log",
            regression: NOT_YET,
            task: "Without changing what I'm looking at: the log at /logs/app.log on this site has one FATAL line. What error code does it give?",
            succeeded: ({ answer, steps }) => new RegExp(`\\b${FATAL_CODE}\\b`).test(answer) && !navigated(steps),
        },
        {
            // The pipe again, on a page rather than a file (tool-use's task).
            id: "find-out",
            regression: NOT_YET,
            task: "Without changing what I'm looking at, find the newest version in the changelog at /pipe-playground on this site.",
            succeeded: ({ answer, steps }) => /2\.4\.0/.test(answer) && !navigated(steps),
        },
        {
            // The python clause: compute, never guess, and RETURN the value (tool-use's task).
            id: "csv-total",
            regression: NOT_YET,
            task: "The file /sales.csv on this site lists sales, one per row. What is the exact total of its `amount` column?",
            python: true,
            succeeded: ({ answer }) => digits(answer).includes(SALES_TOTAL),
        },
        {
            // READING AN OUTPUT AGAIN: the seed's output was cut, and its note names the pointer (pointer-ids' task).
            id: "read-back",
            regression: NOT_YET,
            start: "/spreadsheet",
            seed: {
                task: "Capture the sales table.",
                script: [
                    { tool: "exec", args: { js: READ_SALES, maxChars: SEED_KEEPS } },
                    { content: "Captured the sales table." },
                ],
            },
            task: "Using the data you already captured — do not read the page again — what is the total of Q1 to Q4 across all reps?",
            tools: ["exec", "dereference", "answer"],
            succeeded: ({ answer }) => {
                const a = answer.replace(/[\s,]/g, "");
                return /(^|[^\d.])6260(?![\d])/.test(a) || /\$?6\.26(0)*(m|million)/i.test(a);
            },
        },
        {
            // TOOL OUTPUT TOKENS and the shorter `token` text: shown rows are embedded, not retyped (pointer-ids' task).
            // The answer is scored; the cost is reEmission.
            id: "cite-or-retype",
            regression: NOT_YET,
            start: "/spreadsheet",
            task: "Read the sales table and tell me which region had the highest revenue.",
            followup: "Now show me the underlying rows you used.",
            tools: ["findByText", "sampleText", "exec", "answer"],
            succeeded: ({ answer }) => /east/i.test(answer),
        },
        {
            // The self paragraph: what this run is and how a person starts one.
            id: "self-console",
            regression: NOT_YET,
            task: "How do I start you from this page's devtools console? Give me the exact call to type.",
            succeeded: ({ answer }) => /ml\.agent\s*\(/.test(answer),
        },
        {
            // The `ml.current` paragraph's one measured fact: a shared watch is read NOW, not frozen when it was shared.
            id: "shared-watch",
            regression: NOT_YET,
            task: "I've shared a watch with you. Answer the note I left on it.",
            sharedWatches: ["ml.current.run.step"],
            watchNotes: { "ml.current.run.step": "is it climbing between your steps, or stuck?" },
            // "Climbing, not stuck" passes; "it is stuck" does not.
            succeeded: ({ answer }) => /climb|increas|goes up|rising|advanc/i.test(answer) && !/\b(is|it's|seems|appears|looks|stays|remains)\s+(stuck|frozen)\b/i.test(answer),
        },
        {
            // The compose hint, now in the schema, and the exec wording: a filter `interactives` does not offer.
            id: "disabled-controls",
            regression: NOT_YET,
            start: "/controls",
            task: "Which buttons on this page are disabled? Name every one.",
            // A model that also lists the enabled ones ("Enabled: Save, Share, ...") is right: an enabled button counts
            // against the answer only in a sentence that never says "enabled", and a disabled one counts only where
            // it comes before any "enabled" in its sentence. Naming the enabled ones failed 21 of 38 correct runs.
            succeeded: ({ answer }) => {
                const sentences = answer.split(/[.;\n]/);
                const named = (n: string | boolean, s: string) => new RegExp(`\\b${n}\\b`).test(s);
                return CONTROLS.every(([n, off]) => off
                    ? sentences.some((s) => named(n, s.split(/\benabled\b/i)[0]))
                    : sentences.every((s) => !named(n, s) || /\benabled\b/i.test(s)));
            },
        },
        {
            // `pageInfo` after a navigation: the first turn's context is the START page's.
            id: "md-after-nav",
            regression: NOT_YET,
            task: "Open /docs/guide on this site for me, then tell me the URL of the Markdown version that page publishes of itself.",
            succeeded: ({ answer, steps }) => navigated(steps) && answer.includes(GUIDE_MD),
        },
        {
            // The exec wording, the other way: a dedicated path exists (ml.queryAll / `>>>`), so exec is not needed to
            // find it. Scored on the answer; steps and the exec share are the cost (tool-use's task).
            id: "shadow-reveal",
            regression: NOT_YET,
            start: "/shadow-dom",
            task: "Reveal and read the access code in the first panel on this page.",
            succeeded: ({ answer }) => /SHDW-7788/.test(answer),
        },
    ],
});

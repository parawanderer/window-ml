// tool-use.bench.ts — can a model still do the everyday things the tools are for: total a big CSV, pierce a shadow root,
// read a page that renders in script, and navigate only when asked? The regression suite's first tasks.
//
//   npm run build
//   TOOL_USE_MODELS=openrouter.anthropic/claude-sonnet-5.5,deepseek.deepseek-v4-pro USE_ENV=1 node --import tsx \
//       tests/e2e/bench/run.mjs tests/e2e/bench/specs/tool-use.bench.ts --lanes --serve
//
// From the tool-details measurement (#544, its spec at 5e62b306), without its `prompt` dimension: the split descriptions
// shipped. Each task needs something a tool's description has to convey, and is scored from the run itself (its answer
// and its steps), never from what the model says it did. All five are in the regression suite (`run.mjs --regression`).

import { defineBench } from "../spec";
import { SALES_TOTAL } from "../../../../examples/cross-page/sales.mjs";

/** The models, overridden by TOOL_USE_MODELS (comma-separated). */
const MODELS = (process.env.TOOL_USE_MODELS || "openrouter.anthropic/claude-sonnet-5.5").split(",").map((s) => s.trim()).filter(Boolean);

/** Whether the run moved the user's tab: a `navigate` step, the one tool that does. */
const navigated = (steps: { tool?: string }[]): boolean => steps.some((s) => s.tool === "navigate");

/** An answer with its digit grouping and currency marks taken out, for matching an exact number. */
const digits = (answer: string): string => answer.replace(/[\s,$]/g, "");

/** Why each task is in the regression suite: scored from the run, on a local fixture, with an answer that is fixed. */
const SUITE = { included: true, reason: "scored from the run itself, on a local fixture whose answer is fixed" };

export default defineBench({
    name: "tool-use",
    description: "Do models total a big CSV, pierce a shadow root, render a SPA, and navigate only when asked?",
    repeats: 3,
    timeoutMs: 300000,
    approve: "auto",

    dimensions: {
        model: MODELS,
    },

    apply: (combo) => ({ backend: { model: combo.model } }),

    tasks: [
        {
            // The table trigger: a 3,000-row CSV comes back parsed with its true row count; the preview cannot be
            // summed, so a model has to carry the URL into python_exec's `tables` (or ml.fetch it in exec).
            id: "csv-total",
            regression: SUITE,
            task: "The file /sales.csv on this site lists sales, one per row. What is the exact total of its `amount` column?",
            python: true,
            succeeded: ({ answer }) => digits(answer).includes(SALES_TOTAL),
        },
        {
            // ml.queryAll / `>>>`: the code sits behind a click inside nested open shadow roots.
            id: "shadow-reveal",
            regression: SUITE,
            start: "/shadow-dom",
            task: "Reveal and read the access code in the first panel on this page.",
            succeeded: ({ answer }) => /SHDW-7788/.test(answer),
        },
        {
            // The rendered trigger: a raw GET of /spa is an empty shell. Not navigating keeps it a fetch.
            id: "spa-rendered",
            regression: SUITE,
            task: "What does the page at /spa on this site show once its script has run? Don't change the page I'm on.",
            succeeded: ({ answer, steps }) => /SPA-RENDERED-9931/.test(answer) && !navigated(steps),
        },
        {
            // The showing-vs-fetching note, one way: asked to SEE a page, the user is navigated there.
            id: "show-me",
            regression: SUITE,
            task: "Show me the pipe playground page on this site (/pipe-playground).",
            succeeded: ({ steps }) => steps.some((s) => s.tool === "navigate" && /pipe-playground/.test(String(s.arguments?.url ?? ""))),
        },
        {
            // ...and the other: a lookup the user does not want to watch stays a fetch.
            id: "find-out",
            regression: SUITE,
            task: "Without changing what I'm looking at, find the newest version in the changelog at /pipe-playground on this site.",
            succeeded: ({ answer, steps }) => /2\.4\.0/.test(answer) && !navigated(steps),
        },
    ],
});

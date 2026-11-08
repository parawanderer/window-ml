// tools-into-js.bench.ts — what a run loses or gains if `fetch_url` stopped being a tool and lived on only as
// `ml.fetch` inside exec, and whether a model finds the member when fetch_url's own description is absent (the first
// tools-into-JS candidate; design accepted by the coordinator 2026-11-08, mail 20261108-0911Z).
//
//   TOOLS_JS_MODELS=a,b USE_ENV=1 node --import tsx tests/e2e/bench/run.mjs tests/e2e/bench/specs/tools-into-js.bench.ts --dry
//
// The arms are the toolset, each with `answer`:
//   tool  fetch_url alone;
//   exec  exec alone, its description as shipped (one EXEC_SHORT clause and a TOOL_DETAILS paragraph name ml.fetch);
//   both  fetch_url and exec: which does a model reach for when it may choose?
// Two tasks on the fixture site, each tool-use.bench.ts's own task and predicate: `sales-total` (sum a 3,000-row CSV:
// JS's ground, the pipe dialect cannot sum and the preview is cut) and `find-out` (one fact from another page: the
// tool's ground). The fixture is same-origin, so a page-world `fetch(` in exec works too: the notebook records which
// reader each run used, and that third path is an answer, not a confound.
//
// Not removed: `agent_api_docs` joins any run with exec (run-assembly.ts), so the exec and both arms have it as shipped;
// the notebook records whether a run read it before its first ml.fetch.
//
// Every gate is approved (`approve: "auto"`); both tasks read only the local fixture. Local models only (the box)
// unless Shane says otherwise.

import { defineBench } from "../spec";
import { SALES_TOTAL } from "../../../../examples/cross-page/sales.mjs";

/** The local models, overridden by TOOLS_JS_MODELS (comma-separated): sh-lease's two larger ones and gemma4:12b, a mid-size step below gemma4:31b in its family (Shane, 2026-11-08: smaller than the 30B ones, not tiny). */
const MODELS = (process.env.TOOLS_JS_MODELS || "gemma4:31b,gemma4:12b,qwen3.8-flash-next:vision").split(",").map((s) => s.trim()).filter(Boolean);

/** Each arm's toolset. */
export const ARMS: Record<string, string[]> = {
    tool: ["fetch_url", "answer"],
    exec: ["exec", "answer"],
    both: ["fetch_url", "exec", "answer"],
};

/** An answer with its digit grouping and currency marks taken out, for matching an exact number. */
const digits = (answer: string): string => answer.replace(/[\s,$]/g, "");

/** Whether the run moved the user's tab: a `navigate` step, the one tool that does (none of the arms offers it). */
const navigated = (steps: { tool?: string }[]): boolean => steps.some((s) => s.tool === "navigate");

/** Not in the regression suite: the arms take tools away, so a pass here is not the shipped run's. */
const NOT_SUITE = { included: false, reason: "measures reduced toolsets (fetch_url or exec alone), not the shipped run" };

export default defineBench({
    name: "tools-into-js",
    description: "fetch_url as a tool against ml.fetch from exec (and both), over a CSV total and a one-fact read.",
    repeats: 5,
    timeoutMs: 300000,
    approve: "auto",

    dimensions: {
        model: MODELS,
        arm: Object.keys(ARMS),
    },

    // navigate is wired into every run unless turned off, whatever the subset says; off, so no arm has a third reader.
    apply: (combo) => ({ backend: { model: combo.model }, tools: ARMS[combo.arm], agentOptions: { navigate: false } }),

    tasks: [
        {
            id: "sales-total",
            regression: NOT_SUITE,
            task: "The file /sales.csv on this site lists sales, one per row. What is the exact total of its `amount` column?",
            succeeded: ({ answer }) => digits(answer).includes(SALES_TOTAL),
        },
        {
            id: "find-out",
            regression: NOT_SUITE,
            task: "Without changing what I'm looking at, find the newest version in the changelog at /pipe-playground on this site.",
            succeeded: ({ answer, steps }) => /2\.4\.0/.test(answer) && !navigated(steps),
        },
    ],
});

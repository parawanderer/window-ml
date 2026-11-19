// reshape.bench.ts — a multi-cell reshaping task, run so that every python_exec cell is tried INSIDE the read-only
// dialect: how often a model's cells finish without a card, and which refusals remain, when the work spans several cells
// that reuse each other's values (notebooks/python-dialect/cell-replay.ipynb, the replay of csv-total's one-cell runs,
// is the question this measures live).
//
//   RESHAPE_MODELS=a,b RESHAPE_REPEATS=3 USE_ENV=1 node --import tsx tests/e2e/bench/run.mjs tests/e2e/bench/specs/reshape.bench.ts --dry
//
// Each run starts from the HUD (`surface: "hud"`), so the run is the worker's and its Python is worker-hosted: a cell
// runs unasked when it finishes inside the dialect (its step's approval is "sandbox"), and one that leaves it asks with
// the fork's own refusal (`askWhy`). A console `ml.agent` run is the page's, which never tries the dialect. Every gate is
// approved (`approve: "auto"`), so an asked cell reruns on the full path and later cells see what it left.
//
// The fixture site's four tables (examples/cross-page/reshape.mjs): /sales.csv, /returns.csv, /targets.csv and
// /regions.csv. The answer is the pair that missed its target furthest relative to it, its manager, and the amount in
// cents; the planted pair leads the next by about ten points of target, and every figure is whole cents, so the answer
// does not move with how a model sums. Three arms: the two WORDINGS of the same question, each with one sentence that
// routes the files through python_exec's `tables` (`neutral` leaves the number of cells to the model; `staged` names four
// stages, which invites one cell per stage, each reusing what the last made), and `neutral` without that sentence, which
// counts how often a model finds the route unprompted. Without it most first cells read_csv a URL, which asks, and that
// first refusal hides the edits the task is for. A real-model sweep needs Shane's yes.

import { defineBench } from "../spec";
import { reshapeAnswer } from "../../../../examples/cross-page/reshape.mjs";

/** The models, overridden by RESHAPE_MODELS (comma-separated). */
const MODELS = (process.env.RESHAPE_MODELS || "qwen3.6:35b,gemma4:31b").split(",").map((s) => s.trim()).filter(Boolean);

/** Repeats per arm and model, overridden by RESHAPE_REPEATS (a positive integer). */
const REPEATS = Math.max(1, Number.parseInt(process.env.RESHAPE_REPEATS ?? "", 10) || 3);

const ANSWER = reshapeAnswer();

/** An answer with its digit grouping and currency marks taken out, for matching an exact number. */
const digits = (answer: string): string => answer.replace(/[\s,$€]|EUR/g, "");

/** Right when it names the manager and the amount to the cent. The manager fixes only the region, not the product; the
 *  exact amount is what singles out the pair. */
export const reshapeRight = (answer: string): boolean => digits(answer).includes(ANSWER.amount) && answer.toLowerCase().includes(ANSWER.manager.toLowerCase());

/** The two wordings of the one question. */
export const WORDINGS = {
    neutral: "On this site, /sales.csv lists sales, /returns.csv the units returned against some of them, /targets.csv each region's target per product, and /regions.csv who manages each region. After returns, which region-and-product pair fell furthest short of its target relative to that target, who manages it, and by exactly how much did it miss?",
    staged: "Using /sales.csv, /returns.csv, /targets.csv and /regions.csv on this site: first work out each sale's net amount after its returns; then total it per region and product; then compare each total with its target; finally tell me which pair fell furthest short relative to its target, by exactly how much, and who manages that region.",
};

/** The hint that routes the files through `tables` (python_exec's injected frames, which run inside the dialect), so the
 *  first cell is not refused for a `read_csv` before any edit is reached. The same sentence, appended, in both hinted arms. */
export const HINT = "Fetch each file with fetch_url and pass the four URLs to python_exec's `tables`.";

/** The arms (the coordinator's ruling under Shane's 62): each wording with the hint, and the neutral wording without it,
 *  which counts how often a model finds the `tables` route unprompted. */
export const ARMS: Record<string, string> = {
    "neutral-hint": `${WORDINGS.neutral} ${HINT}`,
    "staged-hint": `${WORDINGS.staged} ${HINT}`,
    neutral: WORDINGS.neutral,
};

/** Not in the regression suite: it measures where cells leave the dialect, not whether a shipped run passes. */
const NOT_SUITE = { included: false, reason: "measures dialect refusals over a multi-cell task, not the shipped run" };

export default defineBench({
    name: "reshape",
    description: "A four-table reshaping task from the HUD, so each python_exec cell is tried inside the read-only dialect; three arms (two wordings with the tables hint, one without).",
    repeats: REPEATS,
    timeoutMs: 600000,
    approve: "auto",

    dimensions: {
        model: MODELS,
    },

    apply: (combo) => ({ backend: { model: combo.model } }),

    tasks: Object.entries(ARMS).map(([arm, task]) => ({
        id: `reshape-${arm}`,
        regression: NOT_SUITE,
        task,
        python: true,
        surface: "hud",
        succeeded: ({ answer }: { answer: string }) => reshapeRight(answer),
    })),
});

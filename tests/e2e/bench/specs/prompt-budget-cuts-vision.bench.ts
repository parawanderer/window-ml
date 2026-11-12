// prompt-budget-cuts-vision.bench.ts — does a vision model still judge items one by one, once the vision paragraph is cut?
//
//   npm run build
//   PROMPT_VISION_MODELS=<ids> USE_ENV=1 node --import tsx \
//       tests/e2e/bench/run.mjs tests/e2e/bench/specs/prompt-budget-cuts-vision.bench.ts --lanes --serve
//
// prompt-budget-cuts.bench.ts's vision half, on models that see: the paragraph is in the prompt only when `look` is
// wired. The one rule it keeps is that items are judged one look each, never off a grid screenshot; /tiles draws its
// shapes on canvases, so the DOM does not say which tile is which.

import { defineBench } from "../spec";
import { TILES } from "../../../../examples/cross-page/prompt-cuts.mjs";

/** The models, overridden by PROMPT_VISION_MODELS (comma-separated). A cloud id gets native vision forced; a local
 *  one is probed, so a model that turns out not to see gets no `look` and its runs show none. */
const MODELS = (process.env.PROMPT_VISION_MODELS || "litellm.google/gemini-flash-latest,qwen3.6:35b")
    .split(",").map((s) => s.trim()).filter(Boolean);

/** The tile numbers (from 1) that show a red circle. */
const RED_CIRCLES = TILES.flatMap((t, i) => (t === "red circle" ? [i + 1] : []));

/**
 * Whether an answer names exactly the red-circle tiles: each of them, and no other tile number.
 * @param answer the run's answer
 * @returns whether it does
 */
export function namesRedCircles(answer: string): boolean {
    const named = new Set([...answer.matchAll(/\b(?:tiles?\s*)?#?(\d)\b/gi)].map((m) => Number(m[1])).filter((n) => n >= 1 && n <= TILES.length));
    return RED_CIRCLES.every((n) => named.has(n)) && named.size === RED_CIRCLES.length;
}

export default defineBench({
    name: process.env.PROMPT_SWEEP || "prompt-budget-cuts-vision",
    description: "The cut vision paragraph: does a vision model still look at each item rather than classify off one screenshot?",
    repeats: 3,
    timeoutMs: 300000,
    approve: "auto",

    dimensions: {
        prompt: ["current", "cuts"],
        model: MODELS,
    },

    apply: (combo) => {
        const defines: Record<string, string> = {};
        if (combo.prompt !== "current") defines.__ML_PROMPT_VARIANT__ = JSON.stringify(combo.prompt);
        const local = !combo.model.includes(".");
        return { defines, backend: { model: combo.model }, agentOptions: { vision: local ? null : true } };
    },

    tasks: [
        {
            id: "red-circles",
            regression: { included: false, reason: "a prompt-variant comparison" },
            start: "/tiles",
            task: "Which tiles on this page show a red circle? Give their numbers.",
            succeeded: ({ answer }) => namesRedCircles(answer),
        },
    ],
});

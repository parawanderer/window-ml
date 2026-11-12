// prompt-variant.ts — which prompt a bench build carries: what ships, or the panel's agreed cuts.

declare const __ML_PROMPT_VARIANT__: string | undefined;

/** The `cuts` experiment (docs/spec/PROMPT_BUDGET.md, "seven stronger models read the agent prompt"): the shorter
 *  system prompt and tool schemas, for the bench's new arm. Off unless the build defines it; deleted, with every
 *  {@link cutOr}, once measured. */
const CUTS = typeof __ML_PROMPT_VARIANT__ === "string" && __ML_PROMPT_VARIANT__ === "cuts";   // state: fixed

/**
 * One model-facing text, by the build's variant.
 * @param cut the text under the `cuts` experiment
 * @param current the text that ships
 * @returns the text this build carries
 */
export const cutOr = <T>(cut: T, current: T): T => (CUTS ? cut : current);

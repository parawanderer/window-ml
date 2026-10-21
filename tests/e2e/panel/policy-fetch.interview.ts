// policy-fetch.interview.ts — models write fetch_url policies as text for described needs; the policy tree's lifter measures how many fit.

import { defineInterview } from "../bench/spec";
import { policyInterview } from "./policy-proposals.prompt";

/**
 * The first coverage figure over MODEL-written policies (ruled #924): four needs, one per turn, each answered with one
 * `(c) => …` block and scored by `policy-proposals.score.ts` (extracted, lifted, right on hand-labelled calls). Nothing
 * runs and no tool is called: it measures what models WRITE when asked for a policy, before any tree exists to steer them.
 */
export default defineInterview(policyInterview("fetch"));

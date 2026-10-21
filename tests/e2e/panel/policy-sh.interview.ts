// policy-sh.interview.ts — models write ml.sh policies as text for described needs; the policy tree's lifter measures how many fit.

import { defineInterview } from "../bench/spec";
import { policyInterview } from "./policy-proposals.prompt";

/**
 * The shell half of policy-fetch.interview.ts: the same measurement over `ml.sh` calls, whose facts are richer (argv,
 * resolved paths, the manifest's effects, `repoConfigRunsCode`). `propose_policy` stays fetch-only (#924): this asks for
 * text, and nothing a model writes here reaches a store.
 */
export default defineInterview(policyInterview("sh"));

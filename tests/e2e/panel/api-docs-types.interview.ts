// api-docs-types.interview.ts — does a model look up the exact type of an `ml` member in agent_api_docs, or guess it?

import { defineInterview } from "../bench/spec";

/** The fields of `CurrentEnv` (src/agent/current-context.ts), each of which a right answer to (1) names. */
const ENV_FIELDS = ["page", "isolation", "exec", "readonlyAutoApprove"];

export default defineInterview({
    about: "Whether a model reaches for agent_api_docs to get the exact type of an `ml` member, and gets it right, with and without a sentence in SELF_CLAUSE saying the docs are the whole `ml` surface as TypeScript with JSDoc (2026-10-12).",
    surface: "hud",
    task: {
        ask: "Without changing anything on this page, answer exactly: (1) What is the TypeScript type of `ml.current.env`: every field and its type? (2) What does `ml.fetch(url)` resolve to (the type's name), and in which field does a parsed CSV or table end up? For each answer say how you know it: READ (where), INFERRED (from what), TRIED, or GUESSED.",
        expect: (t) => t.tools.includes("agent_api_docs") && ENV_FIELDS.every((f) => t.answer.includes(f)) && /FetchResult/.test(t.answer) && /\btable\b/.test(t.answer),
        why: "looked it up in agent_api_docs, named all four env fields, FetchResult and its `table` field",
    },
    asks: [
        "Where, in what form, is the full `ml` API documented for you, and how did you know that before you looked (quote the text that told you)?",
    ],
});

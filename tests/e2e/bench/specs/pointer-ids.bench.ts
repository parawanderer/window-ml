// pointer-ids.bench.ts — does the FORM of a pointer id change whether a model uses it?
//
//   npm run build
//   USE_ENV=1 node --import tsx tests/e2e/bench/run.mjs tests/e2e/bench/specs/pointer-ids.bench.ts --repeats 2 --dry
//   USE_ENV=1 node --import tsx tests/e2e/bench/run.mjs tests/e2e/bench/specs/pointer-ids.bench.ts --repeats 2
//
// The question is behavioural and cannot be settled by argument: docs/POINTER-IDENTIFIERS.md §3 establishes
// that a corrupted id is SAFE, and says nothing about whether a model reaches for the pointer at all
// instead of retyping the data. That is the number the whole mechanism exists to move.
//
// The two arms are a CONTROLLED comparison, which is the reason `syllable` is a transcoding of `hex` (one
// syllable per hex character) rather than a word-pair. Payload, check character and collision space are
// bit-identical; only what the model reads differs. A word-pair form would have changed the error model at
// the same time — a misremembered `brisk-otter` becomes `quick-otter`, a plausible OTHER id, where a
// misremembered syllable is far more likely to be nothing at all — so a difference could not be
// attributed to the form alone.
//
// RUN THE PILOT FIRST (`--repeats 2`, and read the spread). If two arms are indistinguishable on a task,
// that task is not measuring anything and should be dropped rather than repeated five times.
//
// The MODEL comes from `.env` via `USE_ENV=1`. To sweep several, add a `model` dimension and return
// `backend: { model: combo.model }` from `apply` — left out here because the ids are machine-specific.

import { defineBench } from "../spec";

/** A tool result the model has just been handed, verbatim — what it would have to retype. */
const CAPTURED = "Region,Revenue,Units\nNorth,182340.55,4821\nSouth,99120.10,2610\nEast,143870.25,3902\nWest,77650.00,1904";

export default defineBench({
    name: "pointer-ids",
    description: "Does a pointer's surface form change whether the model cites it instead of retyping the data?",
    repeats: 5,
    timeoutMs: 300000,
    approve: "auto",

    dimensions: {
        idFormat: ["hex", "syllable"],
    },

    // An experimental dimension is a BUILD, not a config flag: `hex` is what ships, so it needs no define
    // and reuses dist/; `syllable` gets its own compiled variant. The product carries nothing either way.
    apply: (combo) => {
        // No defines for `hex`: an empty set means "reuse dist/", so the baseline arm measures exactly the
        // shipped build rather than a rebuild of it.
        const defines: Record<string, string> = {};
        if (combo.idFormat !== "hex") defines.__ML_TOKEN_FORMAT__ = JSON.stringify(combo.idFormat);
        return { toolTokens: true, defines };
    },

    tasks: [
        {
            // The primary measurement. Turn 1 captures a table; the follow-up asks for it back. A model
            // that uses the pointer cites it; one that does not retypes the rows, which is exactly what
            // `reEmission` counts.
            id: "cite-or-retype",
            start: "/spreadsheet",
            task: "Read the sales table and tell me which region had the highest revenue.",
            followup: "Now show me the underlying rows you used.",
            tools: ["findByText", "sampleText", "exec", "answer"],
            succeeded: ({ answer }) => /north/i.test(answer),
        },
        {
            // RECOVERY, measured directly rather than waited for. The seeded turn ends holding a pointer;
            // the measured turn has to read it back. Without a seed this behaviour appears only when a
            // model happens to mistype an id, which takes hundreds of runs to collect.
            id: "read-back",
            start: "/spreadsheet",
            seed: {
                task: "Capture the sales table.",
                script: [
                    { tool: "exec", args: { js: `(${JSON.stringify(CAPTURED)})` } },
                    { content: "Captured the table." },
                ],
            },
            task: "Using the data you already captured — do not read the page again — what is the total revenue?",
            tools: ["exec", "dereference", "answer"],
            // 182340.55 + 99120.10 + 143870.25 + 77650.00 = 502980.90. Accepts the rounded 502981 too: the
            // task asks for a total, and rounding it is not a wrong answer. Commas and spaces are stripped
            // first, since a model formats large numbers however it likes.
            //
            // This predicate was WRONG on its first writing — it looked for 502981 only, which no exact
            // answer matches — and would have scored every run in both arms as incorrect, reading like a
            // task that is too hard rather than a broken bench. Predicates are code; they are tested in
            // tests/bench-specs.test.mjs for exactly this reason.
            succeeded: ({ answer }) => /502980(\.9\d?)?|502981/.test(answer.replace(/[\s,]/g, "")),
        },
    ],
});

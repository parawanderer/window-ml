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

/**
 * The seed's read of the page's `#sales` table as CSV: the page really read, by the code the model's history shows. A
 * seed whose code was the literal data read as made up to a careful model ("the captured numbers were fabricated"),
 * which then declined to use them, and that honest suspicion scored as a failure.
 */
const READ_SALES = `(() => { const t = document.querySelector("#sales"); return [...t.rows].map((r) => [...r.cells].map((c) => c.textContent.trim()).join(",")).join("\\n"); })()`;
/** How much of that output the seeded turn KEEPS in context: the header and about two rows. The rest is behind the cut
 *  note's pointer, so the measured turn cannot total it from what it already holds and has to read it back. */
const SEED_KEEPS = 120;

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
            // EAST, not North. The page's own answer key says East=2440 is the top region; North won in the table
            // the read-back seed used to type in, which this task never loads. Writing the predicate against the
            // wrong dataset would have scored every run in both arms incorrect — the same silent failure the old
            // read-back total had. tests/bench-specs.test.mjs reads the region out of examples/spreadsheet.html
            // rather than restating it, so the page is the source of truth.
            succeeded: ({ answer }) => /east/i.test(answer),
        },
        {
            // RECOVERY, measured directly rather than waited for. The seeded turn ends holding a pointer;
            // the measured turn has to read it back. Without a seed this behaviour appears only when a
            // model happens to mistype an id, which takes hundreds of runs to collect.
            //
            // The seed reads the page's table (READ_SALES) with its output CUT to SEED_KEEPS characters, as a
            // long output is cut: the history shows real code reading the page, a couple of rows, and the cut
            // note naming the pointer to the rest. With the whole table in context every model answered in one
            // step without `dereference` (deref 0 across six models and both arms, window-ml-3a's step 3 sweep).
            id: "read-back",
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
            // 6260: the page's grand total (examples/spreadsheet.answers.md; tests/bench-specs.test.mjs sums the
            // table's own cells). The table is in $k, so 6.26 million is the same answer. Commas and spaces are
            // stripped first, since a model formats large numbers however it likes.
            succeeded: ({ answer }) => {
                const a = answer.replace(/[\s,]/g, "");
                return /(^|[^\d.])6260(?![\d])/.test(a) || /\$?6\.26(0)*(m|million)/i.test(a);
            },
        },
    ],
});

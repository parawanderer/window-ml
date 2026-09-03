// Assert the bench's calibration readings from a completed smoke sweep.
//
//   node --import tsx tests/e2e/bench/run.mjs tests/e2e/bench/specs/smoke.bench.ts --repeats 1 --no-cache
//   node tests/e2e/bench/check-calibration.mjs
//
// `smoke.bench.ts` scripts three runs whose correct measurement is known BEFORE they execute: one that
// retypes its tool output (re-emission must read 1.00), one that cites instead while holding the same data
// (0.00), and one that hides a re-emission inside a seeded turn that must not be charged to the measured
// one (0.00). If those three are not exactly that, every other number the bench prints is wrong too.
//
// This exists as a separate check rather than as assertions inside the runner because it verifies the CLI
// END TO END — spec loading, matrix expansion, the cache, the metric extractors, the sinks and the written
// report — which the unit tests and the e2e spec each cover only a slice of. It is the gate for the
// `bench` CI job.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const ROWS = join(ROOT, "tests/e2e/artifacts/bench/smoke/rows.json");

/** [task id, expected re-emission rate, why]. */
const EXPECTED = [
    ["read-code", 0, "answers with a short code it did not take from a long output"],
    ["re-emitter", 1, "retypes the whole tool result into its answer"],
    ["citer", 0, "references the output instead of retyping it, holding the same data"],
    ["seeded", 0, "the re-emission is in the SEEDED turn and must not be charged to the measured one"],
];

let sweep;
try {
    sweep = JSON.parse(readFileSync(ROWS, "utf8"));
} catch {
    console.error(`check-calibration: no sweep at ${ROWS}\n  run the smoke spec first (see the header of this file)`);
    process.exit(2);
}

const problems = [];
for (const [taskId, expected, why] of EXPECTED) {
    const rows = sweep.rows.filter((r) => r.taskId === taskId);
    if (!rows.length) { problems.push(`${taskId}: no rows — did the spec's tasks change?`); continue; }
    for (const row of rows) {
        const arm = Object.entries(row.combo).map(([k, v]) => `${k}=${v}`).join(" ") || "(single)";
        if (row.agg.errors) { problems.push(`${taskId} [${arm}]: ${row.agg.errors} of ${row.agg.runs} runs did not complete`); continue; }
        const got = row.agg.reEmitRate?.mean;
        if (got !== expected) problems.push(`${taskId} [${arm}]: re-emission ${got}, expected ${expected} — it ${why}`);
    }
}

// A sweep where every run failed would otherwise satisfy every check above vacuously.
const ran = sweep.runs?.length ?? 0;
if (ran < EXPECTED.length) problems.push(`only ${ran} runs in the sweep — expected at least one per task`);

if (problems.length) {
    console.error("check-calibration: the bench is not measuring what it should.\n");
    for (const p of problems) console.error(`  ✖ ${p}`);
    console.error("\nEvery other number this tool reports is suspect until these read correctly.");
    process.exit(1);
}
console.log(`check-calibration: ok — ${ran} runs, ${EXPECTED.length} calibration readings as expected.`);

// check-notebooks.test.mjs — a committed notebook must carry nbclient's evidence that it was run as committed
// (scripts/check-notebooks.mjs), and its folder's README must name it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { executionIssues, readmeIssues } from "../scripts/check-notebooks.mjs";

/** A code cell as nbclient leaves it after running: a count and both timestamps. */
const ran = (n, at, extra = {}) => ({ cell_type: "code", source: `x = ${n}`, execution_count: n, outputs: [],
    metadata: { execution: { "iopub.execute_input": `2026-10-10T15:00:0${at}.000Z`, "shell.execute_reply": `2026-10-10T15:00:0${at}.500Z` } }, ...extra });
const md = { cell_type: "markdown", source: "# Notes", metadata: {} };

// --- the evidence a run leaves ---

test("a notebook nbclient ran top to bottom has nothing to report, markdown and empty cells aside", () => {
    const empty = { cell_type: "code", source: "  ", execution_count: null, outputs: [], metadata: {} };
    assert.deepEqual(executionIssues({ cells: [md, ran(1, 1), empty, ran(2, 2), ran(3, 3)] }), []);
});

test("outputs with no timestamps (typed in, or kept by a generator that dropped the metadata) are reported", () => {
    const typed = { cell_type: "code", source: "print(1)", execution_count: 2, metadata: {}, outputs: [{ output_type: "stream", name: "stdout", text: "1\n" }] };
    const issues = executionIssues({ cells: [ran(1, 1), typed] });
    assert.equal(issues.length, 1);
    assert.match(issues[0], /cell 1: no execution timestamps/);
});

test("execution counts must run 1..N: a gap, a restart or a cell never run each say which cell", () => {
    assert.match(executionIssues({ cells: [ran(1, 1), ran(3, 2)] }).join("\n"), /cell 1: execution_count 3, expected 2/);
    assert.match(executionIssues({ cells: [ran(2, 1)] }).join("\n"), /cell 0: execution_count 2, expected 1/);
    const never = { ...ran(2, 2), execution_count: null };
    assert.match(executionIssues({ cells: [ran(1, 1), never] }).join("\n"), /cell 1: execution_count none, expected 2/);
});

test("a cell that ran before the one above it (cells from two runs stitched together) is reported", () => {
    assert.match(executionIssues({ cells: [ran(1, 5), ran(2, 1)] }).join("\n"), /cell 1: ran before the cell above it/);
});

test("an error output fails the notebook even with the evidence intact", () => {
    const boom = ran(1, 1, { outputs: [{ output_type: "error", ename: "KeyError", evalue: "'x'", traceback: [] }] });
    assert.match(executionIssues({ cells: [boom] }).join("\n"), /cell 0: raised an error/);
});

test("a notebook with no code is not evidence of anything", () => {
    assert.deepEqual(executionIssues({ cells: [md] }), ["no code cells"]);
});

// --- the folder's README names each notebook ---

test("the README beside a notebook must name it; a missing README says so", () => {
    assert.deepEqual(readmeIssues("notebooks/bench/prompt-cuts2.ipynb", "- [prompt-cuts2.ipynb](prompt-cuts2.ipynb): round 2"), []);
    assert.deepEqual(readmeIssues("notebooks/bench/prompt-cuts2.ipynb", "nothing here"), ["notebooks/bench/README.md does not name prompt-cuts2.ipynb"]);
    assert.deepEqual(readmeIssues("notebooks/bench/x.ipynb", null), ["no README.md beside it in notebooks/bench"]);
});

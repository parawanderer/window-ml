#!/usr/bin/env node
// check-notebooks.mjs — a committed notebook carries the evidence that it was RUN, and its folder's README names it
// (docs/dev/notebooks.md).
//
//   node scripts/check-notebooks.mjs            every notebook under notebooks/
//   node scripts/check-notebooks.mjs --staged   the ones this commit stages (the pre-commit hook)
//
// The evidence is what nbclient writes when it executes a cell: `metadata.execution` timestamps on every code cell,
// execution counts 1..N with no gap, and no error output. Outputs typed into the JSON, or kept from an earlier run
// while the cells changed, have none of that. It stops a stale or hand-edited notebook, not a forged one: anything
// with a shell can write the timestamps too (docs/spec/NOTEBOOK_TOOLING.md is the signed version).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A cell's source as one string (nbformat allows a string or a list of lines). */
const text = (src) => (Array.isArray(src) ? src.join("") : String(src ?? ""));

/**
 * What says a notebook was not run as committed: a code cell with no execution timestamps or no count, counts that
 * do not run 1..N, timestamps that go backwards, or an error output. Empty when the evidence is all there.
 * @param {object} nb a parsed .ipynb
 */
export function executionIssues(nb) {
    const issues = [];
    const code = (nb.cells || []).map((c, i) => ({ c, i })).filter(({ c }) => c.cell_type === "code" && text(c.source).trim());
    let expected = 1, last = "";
    for (const { c, i } of code) {
        const ex = c.metadata?.execution;
        const started = ex?.["iopub.execute_input"], replied = ex?.["shell.execute_reply"];
        if (!started || !replied) issues.push(`cell ${i}: no execution timestamps (not run by nbclient, or its metadata was dropped)`);
        if (c.execution_count !== expected) issues.push(`cell ${i}: execution_count ${c.execution_count ?? "none"}, expected ${expected}`);
        expected = (c.execution_count ?? expected) + 1;
        if (started && last && started < last) issues.push(`cell ${i}: ran before the cell above it`);
        if (replied) last = replied;
        if ((c.outputs || []).some((o) => o.output_type === "error")) issues.push(`cell ${i}: raised an error`);
    }
    if (!code.length) issues.push("no code cells");
    return issues;
}

/**
 * Whether the README beside a notebook names it, as a link or a backticked name.
 * @param {string} nbPath the notebook's path
 * @param {string | null} readme that folder's README.md, or null when there is none
 */
export function readmeIssues(nbPath, readme) {
    const name = path.basename(nbPath);
    if (readme == null) return [`no README.md beside it in ${path.dirname(nbPath)}`];
    return readme.includes(name) ? [] : [`${path.dirname(nbPath)}/README.md does not name ${name}`];
}

/** The notebooks to check: staged ones, or every tracked one under notebooks/. */
function targets(staged) {
    const out = staged
        ? execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], { cwd: ROOT, encoding: "utf8" })
        : execFileSync("git", ["ls-files", "notebooks"], { cwd: ROOT, encoding: "utf8" });
    return out.split("\n").filter((f) => f.endsWith(".ipynb") && !path.basename(f).startsWith("."));
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const files = targets(process.argv.includes("--staged"));
    let bad = 0;
    for (const f of files) {
        const abs = path.join(ROOT, f);
        const readmePath = path.join(path.dirname(abs), "README.md");
        let nb;
        try { nb = JSON.parse(readFileSync(abs, "utf8")); } catch (e) { console.log(`✖ ${f}: not a notebook (${e.message})`); bad++; continue; }
        const issues = [...executionIssues(nb), ...readmeIssues(f, existsSync(readmePath) ? readFileSync(readmePath, "utf8") : null)];
        if (issues.length) { bad++; console.log(`✖ ${f}`); for (const s of issues) console.log(`    ${s}`); }
    }
    if (bad) {
        console.log(`\ncheck-notebooks: ${bad} notebook(s) without the evidence they were run as committed. Run it: node scripts/nb.mjs run <path>`);
        process.exit(1);
    }
    if (files.length) console.log(`check-notebooks: ${files.length} notebook(s) ran as committed.`);
}

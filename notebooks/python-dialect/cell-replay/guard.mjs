// guard.mjs — replay.mjs's default modes, unchanged by a change to it: each mode run by the working copy and by a git
// ref's replay.mjs (default origin/main) over the same run exports, and the rows compared key for key and in order
// (`ms` aside, a timing). Against the ref, not the committed extracts in data/cell-replay/: those are taken at one
// commit's core and manifests and are refreshed at a pin bump, so a manifest change since moves them with no change to
// replay.mjs at all.
//
//   node --import tsx notebooks/python-dialect/cell-replay/guard.mjs [--ref <git ref>] <run.json>...
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = import.meta.dirname;
const args = process.argv.slice(2);
const at = args.indexOf("--ref");
const ref = at < 0 ? "origin/main" : args.splice(at, 2)[1];
const runs = args;
if (!runs.length) { console.error("usage: node --import tsx guard.mjs [--ref <git ref>] <run.json>..."); process.exit(2); }
// the ref's file beside the working copy's, so its relative imports resolve to the same tree
const theirs = path.join(HERE, `.guard-replay-${process.pid}.mjs`);
fs.writeFileSync(theirs, execFileSync("git", ["show", `${ref}:notebooks/python-dialect/cell-replay/replay.mjs`], { cwd: HERE }));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "replay-guard-"));
// a row as its sorted entries, `ms` aside
const strip = (rows) => rows.map(({ ms, ...r }) => JSON.stringify(Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : 1)))));
let bad = 0;
try {
    for (const mode of ["", "--owned-plain", "--read-csv-served"]) {
        const rows = (script, tag) => {
            const out = path.join(tmp, `${tag}${mode || "-plain"}.json`);
            execFileSync(process.execPath, ["--import", "tsx", script, ...(mode ? [mode] : []), out, ...runs], { stdio: ["ignore", "ignore", "inherit"] });
            return strip(JSON.parse(fs.readFileSync(out, "utf8")).rows);
        };
        const want = rows(theirs, "ref"), got = rows(path.join(HERE, "replay.mjs"), "work");
        const first = got.length === want.length ? got.findIndex((r, i) => r !== want[i]) : Math.min(got.length, want.length);
        console.log(`${mode || "as recorded"}: ${got.length} rows, ${ref} ${want.length}: ${first < 0 ? "identical" : `DIFFERS from row ${first}`}`);
        if (first >= 0) { bad++; console.log(`  ${ref}: ${want[first]}\n  work: ${got[first]}`); }
    }
} finally {
    fs.rmSync(theirs, { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(bad ? 1 : 0);

// drive.mjs [--one=<script> --arg=<a>] <rounds> <reps> <out.json> <label>=<coreDir>... — interleaved rounds, one fresh
// process per core per round, the order rotated each round so no core always runs first (lane 3's
// wrapper-bench/drive.mjs, for any number of cores). Two labels may name the same core: that pair is the A/A control. Writes every rep, not a summary. `--one` picks
// the per-process script (one.mjs, the shapes, by default; one-cells.mjs for the real cells), `--arg` is passed after
// <reps>.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const opts = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=")));
const [rounds, reps, outFile, ...cores] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const one = path.join(import.meta.dirname, opts.one ?? "one.mjs");
const all = [];
for (let r = 0; r < Number(rounds); r++) {
    const order = cores.map((_, i) => cores[(i + r) % cores.length]);
    for (const c of order) {
        const [label, dir] = c.split("=");
        const res = JSON.parse(execFileSync(process.execPath, [one, dir, reps, ...(opts.arg ? [opts.arg] : [])], { encoding: "utf8", maxBuffer: 1 << 28 }).trim());
        all.push({ round: r, label, core: path.basename(path.resolve(dir)), ns: res });
        console.error(r, label, opts.one ? `${Object.keys(res).length} cells` : Object.entries(res).map(([k, v]) => `${k} ${Math.min(...v).toFixed(1)}`).join("  "));
    }
}
// The shapes keep one indented file; the cells (1,700 per process) one line per process, or the file is several MB.
fs.writeFileSync(outFile, opts.one ? "[\n" + all.map((x) => JSON.stringify(x)).join(",\n") + "\n]\n" : JSON.stringify(all, null, 1) + "\n");

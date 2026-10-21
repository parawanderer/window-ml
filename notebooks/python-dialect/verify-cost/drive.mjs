// drive.mjs <rounds> <reps> <out.json> <label>=<coreDir>... — interleaved rounds, one fresh process per core per round,
// the order rotated each round so no core always runs first (lane 3's wrapper-bench/drive.mjs, for any number of
// cores). Two labels may name the same core: that pair is the A/A control. Writes every rep, not a summary.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const [rounds, reps, outFile, ...cores] = process.argv.slice(2);
const all = [];
for (let r = 0; r < Number(rounds); r++) {
    const order = cores.map((_, i) => cores[(i + r) % cores.length]);
    for (const c of order) {
        const [label, dir] = c.split("=");
        const res = JSON.parse(execFileSync(process.execPath, [path.join(import.meta.dirname, "one.mjs"), dir, reps], { encoding: "utf8" }).trim());
        all.push({ round: r, label, core: path.basename(path.resolve(dir)), ns: res });
        console.error(r, label, Object.entries(res).map(([k, v]) => `${k} ${Math.min(...v).toFixed(1)}`).join("  "));
    }
}
fs.writeFileSync(outFile, JSON.stringify(all, null, 1) + "\n");

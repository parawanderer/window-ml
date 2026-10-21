// drive.mjs <rounds> <reps> <out.json> <label=coreDir>... — interleaved rounds, one fresh process per core per round,
// the order rotated each round so neither core always runs first.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const [rounds, reps, outFile, ...cores] = process.argv.slice(2);
const data = path.resolve(import.meta.dirname, "../data"); // whitelist.json and manifest-*.json
const all = [];
for (let r = 0; r < Number(rounds); r++) {
    const order = r % 2 ? [...cores].reverse() : cores;
    for (const c of order) {
        const [label, dir] = c.split("=");
        const res = JSON.parse(execFileSync("node", [path.join(import.meta.dirname, "one.mjs"), dir, data, reps], { encoding: "utf8" }));
        all.push({ round: r, label, ...res });
        console.error(r, label, ["before", "after", "metered", "after2"].map((k) => `${k} ${Math.min(...res[k]).toFixed(3)}`).join("  "));
    }
}
fs.writeFileSync(outFile, JSON.stringify(all, null, 2) + "\n");

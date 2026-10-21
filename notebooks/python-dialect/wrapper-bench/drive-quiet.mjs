// drive-quiet.mjs <rounds> <out.json> <label=coreDir>... — probe3 rounds with the load average and a spinner check
// (`pgrep` for the shell loops a repro once left running) stamped beside every row and in the meta, so a run says
// what the box was doing. Two labels on the same core are the A/A pair. The janitor's (flaky-ci), 2026-10-21.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const [rounds, outFile, ...cores] = process.argv.slice(2);
const data = path.join(import.meta.dirname, "..", "data");
const load = () => {
    const s = execFileSync("sysctl", ["-n", "vm.loadavg"], { encoding: "utf8" }).trim();
    return s;
};
const spinners = () => {
    try {
        return execFileSync("pgrep", ["-af", "while :; do :; done"], { encoding: "utf8" }).trim();
    } catch {
        return "";
    }
};
const meta = {
    driver: "drive-quiet.mjs",
    started: new Date().toISOString(),
    load_before: load(),
    spinners_before: spinners(),
    note: "quiet re-take after orphan load shells 52206-52211 were killed 2026-10-21 15:22 local",
};
const all = [];
for (let r = 0; r < Number(rounds); r++) {
    const order = r % 2 ? [...cores].reverse() : cores;
    for (const c of order) {
        const [label, dir] = c.split("=");
        const res = JSON.parse(execFileSync("node", [path.join(import.meta.dirname, "probe3.mjs"), dir, data], { encoding: "utf8" }));
        all.push({ round: r, label, dir, load: load(), ...res });
        const bh = Math.min(...res.after.held), ph = Math.min(...res.before.held);
        console.error(r, label, `held before ${ph.toFixed(4)} after ${bh.toFixed(4)}  spray32 after ${Math.min(...res.after["32"]).toFixed(4)}  load ${load()}`);
    }
}
meta.finished = new Date().toISOString();
meta.load_after = load();
meta.spinners_after = spinners();
fs.writeFileSync(outFile, JSON.stringify({ meta, rounds: all }, null, 2) + "\n");
console.error("wrote", outFile);

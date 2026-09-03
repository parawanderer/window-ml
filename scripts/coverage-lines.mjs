// Read an lcov report and print, for one or more source files, the lines that were never executed —
// WITH THEIR SOURCE TEXT. The built-in table gives percentages and bare line numbers, which is enough to
// know a file is thin but not enough to answer "is THIS branch covered", which is the question that
// actually comes up. Prints code, so the answer is checkable without opening the file.
//
//   npm run coverage                     # writes coverage/lcov.info
//   node scripts/coverage-lines.mjs sw-fetch.ts token-pipe.ts
//   node scripts/coverage-lines.mjs --all --min 1      # every file with >= 1 uncovered line
//
// Requires --enable-source-maps on the coverage run: without it the line numbers describe tsx's transformed
// output, not the TypeScript, and every answer is quietly wrong.
import { readFileSync, existsSync } from "node:fs";

const LCOV = "coverage/lcov.info";
if (!existsSync(LCOV)) {
    console.error(`No ${LCOV}. Run: npm run coverage`);
    process.exit(2);
}
const args = process.argv.slice(2);
const all = args.includes("--all");
const minIdx = args.indexOf("--min");
const min = minIdx >= 0 ? Number(args[minIdx + 1]) : 1;
const wanted = args.filter((a) => !a.startsWith("--") && a !== String(min));

/** lcov -> { file: { unhitLines[], unhitBranches[], lineTotal, lineHit, brTotal, brHit } } */
function parseLcov(text) {
    const files = {};
    let cur = null;
    for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (line.startsWith("SF:")) {
            cur = files[line.slice(3)] ??= { unhit: [], unhitBr: [], lineTotal: 0, lineHit: 0, brTotal: 0, brHit: 0 };
        } else if (!cur) continue;
        else if (line.startsWith("DA:")) {
            const [n, hits] = line.slice(3).split(",").map(Number);
            cur.lineTotal++; if (hits > 0) cur.lineHit++; else cur.unhit.push(n);
        } else if (line.startsWith("BRDA:")) {
            const [n, , , taken] = line.slice(5).split(",");
            cur.brTotal++;
            if (taken === "-" || Number(taken) === 0) cur.unhitBr.push(Number(n)); else cur.brHit++;
        } else if (line === "end_of_record") cur = null;
    }
    return files;
}

/** Contiguous line numbers collapse into ranges, so a long dead block reads as one entry. */
function ranges(nums) {
    const out = [];
    for (const n of [...new Set(nums)].sort((a, b) => a - b)) {
        const last = out[out.length - 1];
        if (last && n === last[1] + 1) last[1] = n; else out.push([n, n]);
    }
    return out;
}

const files = parseLcov(readFileSync(LCOV, "utf8"));
const names = wanted.length ? wanted : Object.keys(files).filter((f) => files[f].unhit.length >= min || files[f].unhitBr.length >= min);
if (!names.length) { console.log("Nothing uncovered above the threshold."); process.exit(0); }

let missing = 0;
for (const name of names.sort()) {
    const f = files[name];
    if (!f) { console.log(`\n${name}: not in the report (never imported by any test?)`); missing++; continue; }
    const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) : "100.0");
    console.log(`\n${name}  lines ${pct(f.lineHit, f.lineTotal)}% (${f.lineTotal - f.lineHit} unhit)  branches ${pct(f.brHit, f.brTotal)}% (${f.brTotal - f.brHit} untaken)`);
    if (!f.unhit.length && !f.unhitBr.length) { console.log("  fully covered"); continue; }
    const src = existsSync(name) ? readFileSync(name, "utf8").split("\n") : null;
    const brOnly = new Set(f.unhitBr.filter((n) => !f.unhit.includes(n)));
    for (const [a, b] of ranges(f.unhit)) {
        console.log(`  NEVER RUN ${a === b ? `line ${a}` : `lines ${a}-${b}`}`);
        if (src) for (let n = a; n <= Math.min(b, a + 14); n++) console.log(`    ${String(n).padStart(4)} | ${src[n - 1] ?? ""}`);
        if (src && b - a > 14) console.log(`    ... ${b - a - 14} more`);
    }
    // A line that RAN but whose branch never went both ways — the "the else was never taken" case, which is
    // exactly what a percentage hides and what an audit of resolution paths needs.
    for (const [a, b] of ranges([...brOnly])) {
        console.log(`  BRANCH NOT TAKEN ${a === b ? `line ${a}` : `lines ${a}-${b}`}`);
        if (src) for (let n = a; n <= Math.min(b, a + 6); n++) console.log(`    ${String(n).padStart(4)} | ${src[n - 1] ?? ""}`);
    }
}
process.exit(missing ? 1 : 0);

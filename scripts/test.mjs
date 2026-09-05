#!/usr/bin/env node
// RUN A GENRE OF TESTS, not all of them. The suite is ~2 minutes and three files are 80% of that
// (sidebar 53s, background 22s, cdp-stream 20s) — which is the right cost in CI, where everything runs
// anyway, and the wrong one in a loop where you just changed one pure module.
//
//   node scripts/test.mjs                # everything (what `npm test` does)
//   node scripts/test.mjs core           # the fast majority: pure logic, no jsdom, no node:vm world
//   node scripts/test.mjs panel ext      # more than one genre
//   node scripts/test.mjs --list         # what the genres hold
//   node scripts/test.mjs --timings      # per-file durations, slowest first
//
// GENRES ARE EXPLICIT, and `core` is DERIVED — everything no other genre claims. That direction matters:
// a new test file lands in `core` and runs by default rather than falling out of every bucket and being
// silently skipped, which is the failure mode a hand-kept list of ALL the genres would have. The cost is
// that a new SLOW file lands in `core` and makes it less fast, which `--timings` is for.
import { readdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALL = readdirSync(path.join(ROOT, "tests"))
    .filter((f) => /\.test\.(js|mjs)$/.test(f)).sort();

// The named genres. Membership is by FILE because the thing that makes a file slow (a jsdom document, a
// node:vm extension world, a real CPython) is not visible in what it imports — cdp-stream is 20 seconds
// with no marker at all, it simply awaits a lot.
const GENRES = {
    panel: {
        about: "the sidebar UI, against a real jsdom document",
        files: ["sidebar.test.js", "output-cell.test.mjs", "code-tools.test.mjs", "legend.test.mjs",
            "context-container.test.mjs", "tooltip-layer.test.mjs", "tip.test.mjs", "views.test.mjs"],
    },
    ext: {
        about: "the extension's own worlds — background, relay, CDP, the page loop",
        files: ["background.test.js", "relay.test.js", "agent.test.js", "cdp-stream.test.mjs",
            "delegation.test.mjs", "redteam.test.js", "trusted-input.test.mjs", "dom-query.test.mjs",
            "tools-shadow.test.mjs", "bgrun.test.mjs", "replay.test.mjs"],
    },
    python: { about: "real CPython in Pyodide (self-skips without dist/pyodide)", files: ["python.test.mjs"] },
    live: { about: "opt-in, hits the backend in .env", files: ["live.test.js"] },
};
const claimed = new Set(Object.values(GENRES).flatMap((g) => g.files));
GENRES.core = {
    about: "everything else: pure modules, fast",
    get files() { return ALL.filter((f) => !claimed.has(f)); },
};

// A genre naming a file that no longer exists is a silent hole — it stops running and nothing says so.
const missing = [...claimed].filter((f) => !ALL.includes(f));
if (missing.length) {
    console.error(`scripts/test.mjs: genre lists name ${missing.length} file(s) that do not exist: ${missing.join(", ")}`);
    console.error("Rename them in the GENRES table or delete the entries — as it stands they run in no genre at all.");
    process.exit(1);
}

const args = process.argv.slice(2);
if (args.includes("--list")) {
    for (const [name, g] of Object.entries(GENRES)) {
        console.log(`\n${name} — ${g.about}  (${g.files.length} files)`);
        console.log("  " + g.files.join(" "));
    }
    process.exit(0);
}

const NODE_ARGS = ["--import", "tsx", "--test", "--test-concurrency=1"];

if (args.includes("--timings")) {
    // One process per file, so the numbers are per file. Costs a node start each (~0.3s), which is why this
    // is a deliberate command and not how the suite normally runs.
    const rows = [];
    for (const f of ALL) {
        const t = Date.now();
        const r = spawnSync(process.execPath, [...NODE_ARGS, `tests/${f}`], { cwd: ROOT, stdio: "ignore" });
        rows.push({ f, ms: Date.now() - t, ok: r.status === 0 });
    }
    rows.sort((a, b) => b.ms - a.ms);
    const total = rows.reduce((s, r) => s + r.ms, 0);
    for (const r of rows) console.log(`${String(r.ms).padStart(6)}ms ${r.ok ? " " : "✖"} ${r.f}`);
    console.log(`\n${(total / 1000).toFixed(1)}s total across ${rows.length} files (minus ~0.3s of node start each).`);
    process.exit(0);
}

const names = args.filter((a) => !a.startsWith("-"));
for (const n of names) {
    if (!GENRES[n]) {
        console.error(`scripts/test.mjs: no genre "${n}". Known: ${Object.keys(GENRES).join(", ")} (or no argument for all).`);
        process.exit(1);
    }
}
const files = names.length
    ? [...new Set(names.flatMap((n) => GENRES[n].files))].sort()
    : ALL;
console.log(`${names.length ? names.join(" + ") : "all"} — ${files.length} file(s)\n`);
spawn(process.execPath, [...NODE_ARGS, ...files.map((f) => `tests/${f}`)],
    { cwd: ROOT, stdio: "inherit" }).on("exit", (c) => process.exit(c ?? 1));

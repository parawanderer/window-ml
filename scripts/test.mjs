#!/usr/bin/env node
// RUN A GENRE OF TESTS, not all of them. The suite is minutes in parallel and its floor is its slowest FILE
// — which is the right cost in CI, where everything runs anyway, and the wrong one in a loop where you just
// changed one pure module.
//
//   node scripts/test.mjs                # everything (what `npm test` does)
//   node scripts/test.mjs core           # the fast majority: pure logic, no jsdom, no node:vm world
//   node scripts/test.mjs panel ext      # more than one genre
//   npm run test:chat                    # the chat page: this runner's `chat` genre, then its two Playwright specs
//   node scripts/test.mjs --list         # what the genres hold
//   node scripts/test.mjs --timings      # per-file durations, slowest first
//   node scripts/test.mjs --jobs 1       # one file at a time, for when a failure might be interference
//
// GENRES ARE EXPLICIT, and `core` is DERIVED — everything no other genre claims. That direction matters:
// a new test file lands in `core` and runs by default rather than falling out of every bucket and being
// silently skipped, which is the failure mode a hand-kept list of ALL the genres would have. The cost is
// that a new SLOW file lands in `core` and makes it less fast, which `--timings` is for.
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stalenessReport } from "./check-dist-fresh.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// THE NODE THE REPO PINS (.nvmrc, `engines`): CI runs it, and a suite that passes on another major is not the one CI
// runs. Refused up front with the fix, rather than failing later in a way that looks like a test's fault.
const PINNED = Number(readFileSync(path.join(ROOT, ".nvmrc"), "utf8").trim());
if (Number(process.versions.node.split(".")[0]) < PINNED) {
    console.error(`test.mjs: Node ${process.versions.node} is older than the pinned ${PINNED} (.nvmrc). On macOS: \`brew install node\`, and drop any PATH entry for an older keg (\`/opt/homebrew/opt/node@22/bin\`, often in ~/.zshrc); with nvm: \`nvm use\`.`);
    process.exit(1);
}
const ALL = readdirSync(path.join(ROOT, "tests"))
    .filter((f) => /\.test\.(js|mjs)$/.test(f)).sort();

// The named genres. Membership is by FILE because the thing that makes a file slow (a jsdom document, a
// node:vm extension world, a real CPython) is not visible in what it imports — cdp-stream is 20 seconds
// with no marker at all, it simply awaits a lot.
const GENRES = {
    panel: {
        about: "the sidebar UI, against a real jsdom document",
        files: ["sidebar-agent-run.test.js", "sidebar-agent-step.test.js", "sidebar-live-call.test.js", "sidebar-answer.test.js",
            "sidebar-approval.test.js", "sidebar-card.test.js", "sidebar-event-lane.test.js",
            "sidebar-export.test.js", "sidebar-output.test.js", "sidebar-resource.test.js",
            "sidebar-session.test.js", "sidebar-settings.test.js", "sidebar-vram.test.js",
            "output-cell.test.mjs", "pointer-gone.test.mjs", "code-tools.test.mjs", "legend.test.mjs",
            "context-container.test.mjs", "sidebar-prompt-display.test.js", "fold-badges.test.mjs", "tooltip-layer.test.mjs", "tip.test.mjs", "code-diff.test.mjs", "views.test.mjs",
            "json-tree.test.mjs", "run-state-view.test.mjs", "run-log-view.test.mjs", "chart-gestures.test.mjs", "stacked-area.test.mjs"],
    },
    // The repo's own checks (scripts/check-*.mjs): broken doc links, JSDoc that contradicts its code, the prompt
    // review's age, and notebooks committed without the evidence they were run.
    checks: {
        about: "the repo's own checks: doc links, JSDoc, the prompt review's age, notebooks run as committed, the build's pin refusal",
        files: ["check-doc-links.test.mjs", "check-jsdoc.test.mjs", "check-notebooks.test.mjs", "check-prompt-review.test.mjs", "build-pin.test.mjs"],
    },
    // The session archive: the SQL both surfaces run (src/archive/db.ts), the same statements proven under a second
    // SQLite build, the bridge the phone keeps its copy over, and the Settings section that manages the folder.
    archive: {
        about: "the session archive: its SQL under two SQLite builds, the phone's bridge to it, and the folder section",
        files: ["archive-db.test.mjs", "archive-portable.test.mjs", "archive-bridge.test.mjs", "archive-section.test.mjs"],
    },
    // Backup and restore (docs/dev/backup.md): the file format and the keys, the storage-key inventory held to the sources,
    // the settings collect/preview/apply, the backup file over the archive's SQLite, and the sequence that drives them.
    backup: {
        about: "backup and restore: the file format, the key inventory against the sources, settings preview and apply, the file, the keyring",
        files: ["backup-format.test.mjs", "backup-inventory.test.mjs", "backup-settings.test.mjs", "backup-file.test.mjs", "backup-keyring.test.mjs", "backup-run.test.mjs", "chat-record.test.mjs"],
    },
    // The read-only exec dialect: the parser and mediated evaluator, and each member a survey may call for free
    // (`ml.pipe`, `ml.jsonPath`, `ml.current`). Four files, so a change to the dialect has its own suite; its rule
    // (adversarial + halting + failure tests on every extension) is in AGENTS.md.
    readonly: {
        about: "the read-only exec dialect (src/readonly-exec.ts) and the free members a survey calls",
        files: ["readonly-exec.test.mjs", "readonly-pipe.test.mjs", "readonly-jsonpath.test.mjs", "readonly-current.test.mjs",
            "readonly-stream.test.mjs", "readonly-globals.test.mjs", "readonly-dates.test.mjs", "readonly-soundness.test.mjs"],
    },
    // The run's curated answer: the set and its tool's core, the pointers it designates and their dedup against the
    // prose, and the worker-held set's page-side view (`AnswerLog`) with the replay of what a page-side script reports.
    answer: {
        about: "the run's curated answer (answer-set.ts): the set, its designated outputs, and the worker-held set's page-side log",
        files: ["answer-set.test.mjs", "answer-tokens.test.mjs", "answer-dedup.test.mjs", "answer-log.test.mjs"],
    },
    // The worker's half of a run's vision (site-access part 3): its masked capture, the geometry-only host look and
    // locate run over, the verify after an action, and the answer's media and python's image cropped there.
    "worker-vision": {
        about: "the worker's vision: its capture, its geometry-only host, the verify, and the answer's media and python's image",
        files: ["worker-vision.test.mjs", "worker-vision-host.test.mjs", "worker-verify.test.mjs", "worker-media.test.mjs", "review-media.test.mjs"],
    },
    // The resource panel's pure model: /api/info and /api/ps into bands, the events the lane draws, whose each model
    // was, and what a plot keeps of a run at the width it is drawn. The UI over it is `panel`'s.
    resource: {
        about: "the resource panel's pure model: bands, events, ownership, and thinning a run to the plot's width",
        files: ["resource-model.test.mjs", "resource-events.test.mjs", "resource-ownership.test.mjs", "resource-decimate.test.mjs"],
    },
    ext: {
        about: "the extension's own worlds — background, relay, CDP, the page loop",
        files: ["background.test.js", "relay.test.js", "agent.test.js", "cdp-stream.test.mjs",
            "delegation.test.mjs", "isolated-pointer.test.mjs", "ml-wire.test.mjs", "pipe-backtracking.test.mjs", "trusted-input.test.mjs", "dom-query.test.mjs",
            "tools-shadow.test.mjs", "bgrun.test.mjs", "replay.test.mjs", "vision-characterize.test.mjs", "vision-host.test.mjs"],
    },
    // What a hostile page must NOT get: the red-team pass for every tool, member and page-started message. Each
    // property is a test with a positive control, and the suite is the one to run after any security-relevant change.
    redteam: {
        about: "what a hostile page must NOT get: every tool, member and page-started message, each property a test",
        files: ["redteam.test.js", "lapsed-ask-redteam.test.mjs", "redteam-agent-level-3.test.mjs", "redteam-agent-level-2.test.mjs", "redteam-agent-level.test.mjs", "redteam-answer.test.mjs", "redteam-capture.test.mjs", "redteam-current-client.test.mjs",
            "redteam-current-env.test.mjs", "redteam-current-runtime.test.mjs", "redteam-exec-console.test.mjs",
            "redteam-exec-shared-world.test.mjs", "redteam-exec-world.test.mjs", "redteam-geometry.test.mjs",
            "redteam-image-fetch.test.mjs", "redteam-isolated-channel.test.mjs", "redteam-mermaid.test.mjs", "redteam-isolated.test.mjs", "redteam-presence.test.mjs",
            "redteam-ml-wire.test.mjs", "redteam-page-run-builtby.test.mjs", "redteam-render-values.test.mjs",
            "redteam-run-payload.test.mjs", "redteam-text-captures.test.mjs", "redteam-tool-throw.test.mjs",
            "redteam-worker-shot.test.mjs"],
    },
    // The chat page's own logic (the client store, the view prefs, the local host) and the check that its web build
    // never reaches `chrome`. Its browser half is Playwright: `npm run test:chat` runs both.
    chat: {
        about: "the chat page (src/chat/): store, hosts, view prefs, and the web bundle's no-chrome check",
        files: ["chat-core.test.mjs", "chat-web-bundle.test.mjs", "dock-layout.test.mjs", "local-host.test.mjs", "drafts.test.mjs", "native-bridge.test.mjs"],
    },
    // The hub is its own world — HPKE, certificates, sealed commands, the replay window — and thirteen files of it
    // sat in `core`, where "run the hub tests" meant running a hundred and twenty-three. Named for the same reason
    // panel and ext are: a subsystem you can change on its own is one you should be able to test on its own.
    hub: {
        about: "the hub client (src/hub/): HPKE, seals, keyring, pairing, revocation, streams",
        files: ["hub-client.test.mjs", "hub-connection.test.mjs", "hub-host.test.mjs", "hub-hpke.test.mjs",
            "hub-keyring-vault.test.mjs", "hub-pair-flow.test.mjs", "hub-pairing.test.mjs", "hub-revocation.test.mjs",
            "hub-runtime.test.mjs", "hub-seal.test.mjs", "hub-stream.test.mjs", "hub-support.test.mjs",
            "pairing-client.test.mjs"],
    },
    // The phone app's own logic and the bridge it speaks. Its SCREENS are Maestro's (tests/mobile/), which this
    // runner never sees; what is here is what runs without a device.
    mobile: {
        about: "the phone app (mobile/): its list, its attachments, the native bridge and search, its update check",
        files: ["app-update.test.mjs", "mobile-attach.test.mjs", "mobile-imports.test.mjs", "mobile-list.test.mjs",
            "native-bridge.test.mjs", "native-search.test.mjs", "tap-feedback.test.mjs"],
    },
    // THE SESSION CONTRACT and the worker's side of it: what a runtime answers, what the index records, what a
    // relay forwards. Nine files that are one subject, and they were spread through `core` where nothing said so.
    session: {
        about: "the session contract (src/session-*.ts, sw-sessions): commands, index, relay, store, titles",
        files: ["session-commands.test.mjs", "session-host.test.mjs", "session-index.test.mjs",
            "session-publisher.test.mjs", "session-relay.test.mjs", "session-storage-stats.test.mjs",
            "session-store.test.mjs", "session-title.test.mjs", "shell-session-relay.test.mjs",
            "background-sessions.test.js", "sw-chat.test.mjs", "reducer-runtime-key.test.mjs"],
    },
    bench: {
        about: "the benchmark harness (tests/e2e/bench/): its spec matrix, metrics, viewer, server, page, sweep log, scoreboard, memory readings, the box's event stream and the held runs' screens",
        files: ["bench-descriptor.test.mjs", "bench-metrics.test.mjs", "bench-serve.test.mjs",
            "bench-specs.test.mjs", "bench-viewer.test.mjs", "bench-files.test.mjs", "bench-page.test.mjs",
            "bench-scores.test.mjs", "bench-sweeps.test.mjs", "bench-memory.test.mjs", "bench-box.test.mjs", "bench-lanes.test.mjs", "bench-sync.test.mjs", "bench-stream.test.mjs", "bench-regress.test.mjs", "bench-spend.test.mjs", "bench-cost.test.mjs", "bench-live-spend.test.mjs", "bench-memory-budget.test.mjs", "bench-memory-card.test.mjs", "bench-status.test.mjs", "bench-memory-limit.test.mjs", "bench-spend-predict.test.mjs", "bench-cli-help.test.mjs", "bench-electricity.test.mjs"],
    },
    python: { about: "real CPython in Pyodide (self-skips without dist/pyodide)", files: ["python.test.mjs", "redteam-python-sandbox.test.mjs", "python-lockdown.test.mjs", "python-run-namespace-py.test.mjs", "python-dialect-vectors-wasm.test.mjs", "python-matplotlib.test.mjs", "python-dialect-inside.test.mjs", "redteam-python-inside.test.mjs"] },
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

// HOW MANY FILES AT ONCE. `node --test` already gives each file its own process, so the only thing that was
// stopping them overlapping was this being pinned to 1 — and the suite is dominated by its slowest files,
// so overlapping them takes the wall clock down to roughly the slowest one. That is also why a 400-test file
// is worth splitting: it is the floor, and while it is resident it contends for memory with every file beside
// it (see the trap in AGENTS.md).
//
// NOT unbounded, and not `cores` LOCALLY: about ten files here drive real timers (a debounce, an easing,
// "stays quiet for the first half second"), and those are exactly the assertions that go wrong when every core
// is busy. Leaving headroom is the difference between a suite that is fast and one that is fast and flaky.
// `--jobs 1` puts it back to serial, which is what you want when a failure might be interference.
//
// ON CI there is no "leave a core for the desktop": the runner is a 4-core VM whose only job is this suite,
// and `cores - 2` threw half of it away (JOBS=2 on ubuntu-24.04). `CI` / `GITHUB_ACTIONS` (GitHub sets both)
// buys the full core count back. If a timer assertion starts flaking on CI only, this is the knob that got
// turned — pull it to `CORES - 1` before touching the assertion.
const CORES = (() => { try { return require("node:os").cpus().length; } catch { return 4; } })();
const ON_CI = !!(process.env.CI || process.env.GITHUB_ACTIONS);
const jobsArg = process.argv.find((a) => a.startsWith("--jobs"));
const JOBS = Math.max(1, Number(jobsArg?.split("=")[1] ?? process.argv[process.argv.indexOf("--jobs") + 1])
    || Math.min(8, ON_CI ? CORES : Math.max(1, CORES - 2)));
const NODE_ARGS = ["--import", "tsx", "--test", `--test-concurrency=${JOBS}`];

// SLOWEST FIRST. `node --test --test-concurrency=N` starts the files in the order they are listed, and a
// long file that starts last is the one that decides the wall clock while every other slot has gone idle.
// Alphabetical order does the opposite of what we want: `run-start` and `redteam-agent-level` were queued
// behind dozens of 200ms files. This list is a hand-kept head of the slow files (the jsdom / node:vm /
// real-CPython ones), refreshed with `--timings` when one moves — it is an ordering heuristic, not a
// measurement, so being a place or two out costs nothing. Files not listed keep alphabetical order after
// the listed ones, so a new slow file is not dropped — it just does not jump the queue until someone runs
// `--timings` again.
const SLOWEST_FIRST = [
    "session-store.test.mjs",
    "redteam.test.js",
    "worker-page-read.test.mjs",
    "python-dialect-inside.test.mjs",
    "python.test.mjs",
    "background.test.js",
    "cdp-stream.test.mjs",
    "agent.test.js",
    "worker-vision.test.mjs",
    "readonly-soundness.test.mjs",
    "python-matplotlib.test.mjs",
    "redteam-python-sandbox.test.mjs",
    "redteam-agent-level-2.test.mjs",
    "worker-vision-host.test.mjs",
    "run-start.test.mjs",
    "redteam-agent-level.test.mjs",
];
const slowRank = new Map(SLOWEST_FIRST.map((f, i) => [f, i]));
/** Listed files first (slowest first), everything else alphabetical after them. */
function orderSlowestFirst(files) {
    return [...files].sort((a, b) => {
        const ra = slowRank.has(a) ? slowRank.get(a) : SLOWEST_FIRST.length;
        const rb = slowRank.has(b) ? slowRank.get(b) : SLOWEST_FIRST.length;
        return ra !== rb ? ra - rb : a < b ? -1 : a > b ? 1 : 0;
    });
}

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

// A SUBSYSTEM QUIETLY ACCUMULATING IN `core`. Genres are explicit and `core` is derived — everything unclaimed —
// which is the right direction (a new file runs by default rather than falling out of every bucket) and has one
// failure: a subsystem grows file by file, each one reasonably unclaimed, until "run the hub tests" means running a
// hundred and twenty-three. That is not hypothetical; it is how thirteen `hub-*` files and nine `session-*` ones
// came to live there. The rule is mechanical so it cannot be argued with: several files sharing a name prefix are a
// subject, and a subject gets a genre.
if (args.includes("--check-genres")) {
    const MIN = 4;
    const claimed = new Set(Object.entries(GENRES).filter(([n]) => n !== "core").flatMap(([, g]) => g.files));
    const clusters = new Map();
    for (const f of GENRES.core.files) {
        const prefix = f.split("-")[0];
        if (!f.includes("-") || prefix.length < 3) continue;
        (clusters.get(prefix) ?? clusters.set(prefix, []).get(prefix)).push(f);
    }
    const found = [...clusters].filter(([, fs]) => fs.length >= MIN).sort((a, b) => b[1].length - a[1].length);
    for (const [prefix, fs] of found) console.log(`${prefix}\t${fs.length} files in core\t${fs.join(" ")}`);
    if (found.length) {
        console.error(`\ntest.mjs: ${found.length} subsystem(s) with ${MIN}+ test files sitting in \`core\`, so there is no way to run`);
        console.error("          just that subsystem — and `core` stops being the fast majority it is named for.");
        console.error("          Give each a genre in the GENRES table, with a sentence saying what it covers.");
        process.exit(1);
    }
    console.log(`test.mjs: no unnamed subsystem in core (${claimed.size} files across ${Object.keys(GENRES).length - 1} genres).`);
    process.exit(0);
}

/**
 * Run exactly these test files, refusing first if any of them would boot a STALE bundle.
 *
 * Most of this suite loads the real sources into a `node:vm` and needs no build at all — but `loadSidebarWorld`
 * boots `dist/sidebar-app.js` and `loadBackground` boots `dist/background.js`, so those files test whatever was built
 * last (a stale background made a fixed `grep -A` read as the old quadratic loop, #1007). That is the same silent failure the
 * Playwright suite guards (`check-dist-fresh.mjs`), one layer down, and it cost a session the day the Playwright
 * guard was written. Scoped to the files in THIS run, and to `dist/` alone, so a run of pure-module tests is never
 * stopped over a bundle nothing is about to open.
 */
/** Whether a test file, or a test helper it imports by a relative path (`./ml-wire-harness.mjs`), boots a bundle. */
function bootsBundle(file, seen = new Set()) {
    if (seen.has(file)) return false;
    seen.add(file);
    let text;
    try { text = readFileSync(file, "utf8"); } catch { return false; }
    if (/loadSidebarWorld|loadBackground/.test(text)) return true;
    const local = [...text.matchAll(/(?:from\s+|require\(\s*|import\(\s*)["'](\.\/[^"']+)["']/g)].map((m) => path.join(path.dirname(file), m[1]));
    return local.some((f) => bootsBundle(f, seen));
}

function runFiles(list) {
    // Slowest first: a long file that starts last decides the wall clock while every other slot has gone idle.
    const ordered = orderSlowestFirst(list);
    const needsBundle = ordered.filter((f) => bootsBundle(path.join(ROOT, "tests", f)));
    if (needsBundle.length) {
        const report = stalenessReport(["dist"]);
        if (report) {
            console.error(`${report}\n\n  ${needsBundle.length} file(s) in this run boot a bundle from dist/.`);
            process.exit(1);
        }
    }
    spawn(process.execPath, [...NODE_ARGS, ...ordered.map((f) => `tests/${f}`)],
        { cwd: ROOT, stdio: "inherit" }).on("exit", (c) => process.exit(c ?? 1));
}

// `--files a.test.mjs tests/b.test.mjs` runs exactly those, whatever genre they fall in. It exists because
// `scripts/test-cover.mjs` can name the handful of files a change can reach, and the honest command for that set is
// the set — not the genre that happens to contain them, which for anything in `core` is a hundred and twenty-three.
const fileArg = args.indexOf("--files");
if (fileArg >= 0) {
    const wanted = args.slice(fileArg + 1).filter((a) => !a.startsWith("-")).map((f) => f.replace(/^tests\//, ""));
    const missing = wanted.filter((f) => !ALL.includes(f));
    if (!wanted.length) { console.error("scripts/test.mjs: --files needs at least one test file."); process.exit(1); }
    if (missing.length) { console.error(`scripts/test.mjs: no such test file(s): ${missing.join(", ")}`); process.exit(1); }
    console.log(`${wanted.length} file(s), ${JOBS} at a time\n`);
    runFiles(wanted);
} else {

const names = args.filter((a) => !a.startsWith("-") && !/^\d+$/.test(a));   // a bare number is --jobs' value
for (const n of names) {
    if (!GENRES[n]) {
        console.error(`scripts/test.mjs: no genre "${n}". Known: ${Object.keys(GENRES).join(", ")} (or no argument for all).`);
        process.exit(1);
    }
}
const files = names.length
    ? [...new Set(names.flatMap((n) => GENRES[n].files))].sort()
    : ALL;
console.log(`${names.length ? names.join(" + ") : "all"} — ${files.length} file(s), ${JOBS} at a time\n`);
runFiles(files);
}

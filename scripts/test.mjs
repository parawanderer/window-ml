#!/usr/bin/env node
// RUN A GENRE OF TESTS, not all of them. The suite is ~2 minutes and three files are 80% of that
// (sidebar 53s, background 22s, cdp-stream 20s) — which is the right cost in CI, where everything runs
// anyway, and the wrong one in a loop where you just changed one pure module.
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
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
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
    // The chat page's own logic (the client store, the view prefs, the local host) and the check that its web build
    // never reaches `chrome`. Its browser half is Playwright: `npm run test:chat` runs both.
    chat: {
        about: "the chat page (src/chat/): store, hosts, view prefs, and the web bundle's no-chrome check",
        files: ["chat-core.test.mjs", "chat-web-bundle.test.mjs", "local-host.test.mjs", "drafts.test.mjs", "native-bridge.test.mjs"],
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
        about: "the phone app (mobile/): its list, its attachments, the native bridge and search",
        files: ["mobile-attach.test.mjs", "mobile-imports.test.mjs", "mobile-list.test.mjs",
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
        about: "the benchmark harness (tests/e2e/bench/): its spec matrix, metrics, viewer and server",
        files: ["bench-descriptor.test.mjs", "bench-metrics.test.mjs", "bench-serve.test.mjs",
            "bench-specs.test.mjs", "bench-viewer.test.mjs"],
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

// HOW MANY FILES AT ONCE. `node --test` already gives each file its own process, so the only thing that was
// stopping them overlapping was this being pinned to 1 — and the suite is dominated by three files
// (sidebar 53s, background 22s, cdp-stream 20s of 130s), so overlapping them takes the wall clock down to
// roughly the slowest one.
//
// NOT unbounded, and not `cores`: about ten files here drive real timers (a debounce, an easing, "stays
// quiet for the first half second"), and those are exactly the assertions that go wrong when every core is
// busy. Leaving headroom is the difference between a suite that is fast and one that is fast and flaky.
// `--jobs 1` puts it back to serial, which is what you want when a failure might be interference.
const CORES = (() => { try { return require("node:os").cpus().length; } catch { return 4; } })();
const jobsArg = process.argv.find((a) => a.startsWith("--jobs"));
const JOBS = Math.max(1, Number(jobsArg?.split("=")[1] ?? process.argv[process.argv.indexOf("--jobs") + 1])
    || Math.min(8, Math.max(1, CORES - 2)));
const NODE_ARGS = ["--import", "tsx", "--test", `--test-concurrency=${JOBS}`];

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
    spawn(process.execPath, [...NODE_ARGS, ...wanted.map((f) => `tests/${f}`)],
        { cwd: ROOT, stdio: "inherit" }).on("exit", (c) => process.exit(c ?? 1));
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
spawn(process.execPath, [...NODE_ARGS, ...files.map((f) => `tests/${f}`)],
    { cwd: ROOT, stdio: "inherit" }).on("exit", (c) => process.exit(c ?? 1));
}

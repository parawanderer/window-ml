// vitals.mjs — a monthly record of how the codebase grows and how often it breaks, kept for one long-running
// question: can agents keep a codebase nobody reads working as it grows?
//
//   node scripts/vitals.mjs              # recompute every month, merge into docs/vitals/history.json, print a summary
//   node scripts/vitals.mjs --dry-run    # print only, write nothing
//   node scripts/vitals.mjs --no-ci      # skip the GitHub API (git figures only)
//
// WHAT IT RECORDS, per month. For each repository it has a checkout of (this one, and window-ml-hub as a sibling
// directory or `VITALS_HUB_DIR`): lines at the month's last commit on main, split by path into code, test, docs, data
// and generated; how many code files are over 800 lines; and the commits that landed on main that month, by their
// conventional-commit kind. From the GitHub API: CI runs that month, pushes to main and pull requests apart, with
// how many failed. For each fork: its commits ahead of upstream by month, and a snapshot of its diff against
// upstream as it stands today.
//
// WHY IT MERGES INSTEAD OF OVERWRITING. Git history is permanent, so every git figure is recomputed from scratch
// on each run. CI history is not: GitHub ages old runs out, so a month whose run count FELL keeps the figure
// recorded when there were more. A fork's diff snapshot exists only for the months the script was run in, which
// is why it should be run about once a month. The current month is marked `partial` until a later run sees it
// finished.
//
// WHAT THE NUMBERS DO NOT SAY, so they are not over-read:
//   - "test" vs "code" is decided by PATH. Rust tests written inline in a source file count as code.
//   - Commit kinds come from the subject's prefix (`feat:`, `fix(ui):`). A fix that was never labelled one is
//     invisible, and a squash-merged PR is one commit however much it held.
//   - A failed CI run is not a broken main. Most failures are on pull requests and are the point of having CI;
//     the failure rate on pushes to main is the closer reading of "something landed broken".
//   - A fork's line count is what it ADDS over the upstream it was compared against, not its size.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const OUT = join(ROOT, "docs", "vitals", "history.json");

/** A code file over this many lines is counted as big, matching `check-file-size.mjs`. */
const BIG_FILE = 800;

/** The repositories measured from a local checkout. `dir` may be missing; the git half is then skipped. */
const REPOS = [
    { name: "window-ml", dir: ROOT, ref: "origin/main", gh: "parawanderer/window-ml" },
    {
        name: "window-ml-hub",
        dir: process.env.VITALS_HUB_DIR || join(ROOT, "..", "window-ml-hub"),
        ref: "origin/main",
        gh: "parawanderer/window-ml-hub",
    },
];

/** The forks, measured through GitHub's compare API against the upstream branch each one diverged from. */
const FORKS = [
    { name: "ollama", repo: "parawanderer/ollama", branch: "slop", upstream: "ollama:main" },
    { name: "llama.cpp", repo: "parawanderer/llama.cpp", branch: "slop", upstream: "ggml-org:master" },
    { name: "open-webui", repo: "parawanderer/open-webui", branch: "ml/tool-execute-api", upstream: "open-webui:main" },
];

const LOCKFILES = new Set(["package-lock.json", "Cargo.lock", "yarn.lock", "pnpm-lock.yaml", "uv.lock", "poetry.lock"]);
const TEST_DIR = /(^|\/)(tests?|__tests__|e2e|fuzz)\//;
const TEST_NAME = /\.(test|spec)\.[cm]?[jt]sx?$|_test\.(rs|go|py)$/;
const CODE_EXT = /\.([cm]?[jt]sx?|rs|go|py|css|html|proto|sh|kt|swift|java|c|cc|cpp|h|hpp|cu|metal)$/;
const GENERATED = /\.gen\.[a-z]+$|_pb2\.py$/;
const DATA = /\.(json|jsonl|ndjson|csv|tsv|parquet|arrow|bin|txt)$|(^|\/)fixtures\//;
const KINDS = new Set(["feat", "fix", "refactor", "docs", "test", "ci", "tools", "chore", "perf", "build", "style"]);

/**
 * Which of code, test, docs, data, generated or other a tracked path counts as, by its path alone. Data (JSON,
 * CSV, recorded fixtures) and generated files are kept apart so the test-to-code ratio compares written code.
 */
export function pathKind(path) {
    if (GENERATED.test(path)) return "generated";
    if (DATA.test(path)) return "data";
    if (TEST_DIR.test(path) || TEST_NAME.test(path)) return "test";
    if (path.endsWith(".md") || /(^|\/)docs\//.test(path)) return "docs";
    if (CODE_EXT.test(path)) return "code";
    return "other";
}

/** The conventional-commit kind of a commit subject: `feat`, `fix`, …, or `revert`, `merge` and `other`. */
export function commitKind(subject) {
    if (/^Revert\b/.test(subject)) return "revert";
    if (/^Merge\b/.test(subject)) return "merge";
    const m = /^([a-z]+)(\([^)]*\))?!?:/.exec(subject);
    if (!m) return "other";
    const kind = m[1] === "tests" ? "test" : m[1];
    return KINDS.has(kind) ? kind : "other";
}

/** The `YYYY-MM` month an ISO timestamp falls in, in UTC. */
export function monthOf(iso) {
    return new Date(iso).toISOString().slice(0, 7);
}

/** Every month from the one containing `fromIso` to the one containing `toIso`, inclusive. */
export function monthsBetween(fromIso, toIso) {
    const out = [];
    let [y, m] = monthOf(fromIso).split("-").map(Number);
    const last = monthOf(toIso);
    for (;;) {
        const month = `${y}-${String(m).padStart(2, "0")}`;
        out.push(month);
        if (month >= last) return out;
        if (++m > 12) { m = 1; y++; }
    }
}

/** The first instant after a month, as an ISO string: what "the month's last commit" is measured before. */
export function monthEnd(month) {
    const [y, m] = month.split("-").map(Number);
    return new Date(Date.UTC(y, m, 1)).toISOString();
}

/** Tally commits by month and kind. `commits` is `{ date, subject }[]`. */
export function commitsByMonth(commits) {
    const out = {};
    for (const { date, subject } of commits) {
        const tally = (out[monthOf(date)] ??= { total: 0 });
        tally.total++;
        const kind = commitKind(subject);
        tally[kind] = (tally[kind] ?? 0) + 1;
    }
    return out;
}

/**
 * Tally CI runs by month into pushes to main and pull requests, each with success, failure and cancelled counts.
 * A run still in progress is left out; `timed_out` and `startup_failure` count as failures.
 */
export function ciByMonth(runs, mainBranch = "main") {
    const out = {};
    for (const run of runs) {
        if (!run.conclusion) continue;
        const lane = run.event === "pull_request" ? "pr" : run.event === "push" && run.branch === mainBranch ? "main" : null;
        if (!lane) continue;
        const month = (out[monthOf(run.created)] ??= {});
        const t = (month[lane] ??= { runs: 0, success: 0, failure: 0, cancelled: 0 });
        t.runs++;
        if (run.conclusion === "success") t.success++;
        else if (["failure", "timed_out", "startup_failure"].includes(run.conclusion)) t.failure++;
        else if (run.conclusion === "cancelled") t.cancelled++;
    }
    return out;
}

/**
 * Merge a fresh computation into the recorded history. Fresh values win, except a CI lane whose run count fell,
 * which keeps the recorded figure because GitHub has aged runs out, and fields the fresh run did not compute
 * (a fork's diff snapshot from an earlier month), which are kept as they were.
 */
export function mergeHistory(old, fresh) {
    const out = structuredClone(old ?? {});
    for (const [group, entries] of Object.entries(fresh)) {
        if (typeof entries !== "object" || entries === null) { out[group] = entries; continue; }
        out[group] ??= {};
        for (const [name, entry] of Object.entries(entries)) {
            const months = ((out[group][name] ??= {}).months ??= {});
            for (const [month, figures] of Object.entries(entry.months ?? {})) {
                const prev = months[month] ?? {};
                const next = { ...prev, ...figures };
                if (prev.ci && figures.ci) {
                    next.ci = { ...prev.ci };
                    for (const [lane, t] of Object.entries(figures.ci)) {
                        if (!prev.ci[lane] || t.runs >= prev.ci[lane].runs) next.ci[lane] = t;
                    }
                }
                if (!figures.partial) delete next.partial;
                months[month] = next;
            }
        }
    }
    return out;
}

// --- git ---

/** Run git in a directory and return stdout as a string. */
function git(dir, args) {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 1 << 30 });
}

/** Lines in each blob, counted once per blob id across every month; `null` for a binary blob. */
function blobLines(dir, ids, cache) {
    const missing = [...new Set(ids)].filter((id) => !cache.has(id));
    if (missing.length) {
        const res = spawnSync("git", ["-C", dir, "cat-file", "--batch"], { input: missing.join("\n") + "\n", maxBuffer: 2 ** 31 });
        const buf = res.stdout;
        let at = 0;
        while (at < buf.length) {
            const nl = buf.indexOf(10, at);
            const [id, , size] = buf.toString("utf8", at, nl).split(" ");
            const start = nl + 1, end = start + Number(size);
            const body = buf.subarray(start, end);
            let lines = null;
            if (!body.subarray(0, 8000).includes(0)) {
                lines = 0;
                for (let i = 0; i < body.length; i++) if (body[i] === 10) lines++;
                if (body.length && body[body.length - 1] !== 10) lines++;
            }
            cache.set(id, lines);
            at = end + 1;
        }
    }
    return cache;
}

/** Lines at one commit, split by `pathKind`, and how many code files are over `BIG_FILE` lines. */
function linesAt(dir, sha, cache) {
    const entries = git(dir, ["ls-tree", "-r", "-z", "--full-tree", sha]).split("\0").filter(Boolean).map((row) => {
        const [meta, path] = row.split("\t");
        const [mode, type, id] = meta.split(" ");
        return { mode, type, id, path };
    }).filter((e) => e.type === "blob" && e.mode !== "120000" && !LOCKFILES.has(basename(e.path)));
    blobLines(dir, entries.map((e) => e.id), cache);
    const lines = { total: 0, code: 0, test: 0, docs: 0, data: 0, generated: 0, other: 0 };
    let bigFiles = 0;
    for (const e of entries) {
        const n = cache.get(e.id);
        if (n == null) continue;
        const kind = pathKind(e.path);
        lines[kind] += n;
        lines.total += n;
        if (kind === "code" && n > BIG_FILE) bigFiles++;
    }
    return { lines, bigFiles };
}

/** Every git figure for one repository, one entry per month since its first commit. */
function gitVitals(repo, nowIso) {
    try { git(repo.dir, ["fetch", "-q", "origin"]); } catch { console.error(`${repo.name}: fetch failed, using the local ${repo.ref}`); }
    const log = git(repo.dir, ["log", "--format=%cI%x09%s", repo.ref]).trim().split("\n").map((row) => {
        const [date, ...rest] = row.split("\t");
        return { date, subject: rest.join("\t") };
    });
    const commits = commitsByMonth(log);
    const first = log[log.length - 1].date;
    const cache = new Map();
    const months = {};
    for (const month of monthsBetween(first, nowIso)) {
        const end = monthEnd(month);
        const partial = end > nowIso;
        const sha = git(repo.dir, ["rev-list", "-1", `--before=${partial ? nowIso : end}`, repo.ref]).trim();
        if (!sha) continue;
        months[month] = { ...linesAt(repo.dir, sha, cache), commits: commits[month] ?? { total: 0 }, ...(partial ? { partial: true } : {}) };
    }
    return months;
}

// --- GitHub ---

/** Every Actions run of a repository, as `{ created, event, branch, conclusion }`. */
function ciRuns(gh) {
    const out = execFileSync("gh", ["api", "--paginate", `repos/${gh}/actions/runs?per_page=100`,
        "--jq", ".workflow_runs[] | [.created_at, .event, .head_branch, (.conclusion // \"\")] | @tsv"],
    { encoding: "utf8", maxBuffer: 1 << 28 });
    return out.trim().split("\n").filter(Boolean).map((row) => {
        const [created, event, branch, conclusion] = row.split("\t");
        return { created, event, branch, conclusion: conclusion || null };
    });
}

/** A fork's commits ahead of upstream by month, and today's diff against upstream in the current month. */
function forkVitals(fork, nowIso) {
    const owner = fork.repo.split("/")[0];
    const res = JSON.parse(execFileSync("gh", ["api", `repos/${fork.repo}/compare/${fork.upstream}...${owner}:${fork.branch}`,
        "--jq", "{ahead: .ahead_by, behind: .behind_by, files: (.files | length), additions: ([.files[].additions] | add), deletions: ([.files[].deletions] | add), commits: [.commits[] | {date: .commit.committer.date, subject: (.commit.message | split(\"\\n\")[0])}]}"],
    { encoding: "utf8", maxBuffer: 1 << 28 }));
    const months = {};
    for (const [month, tally] of Object.entries(commitsByMonth(res.commits))) months[month] = { commits: tally };
    const now = monthOf(nowIso);
    months[now] = {
        ...months[now],
        diff: {
            branch: fork.branch, upstream: fork.upstream, measured: nowIso.slice(0, 10),
            aheadBy: res.ahead, behindBy: res.behind, files: res.files, additions: res.additions ?? 0, deletions: res.deletions ?? 0,
            // the compare API lists at most 300 files and 250 commits; past either, these figures are a floor
            ...(res.files >= 300 || res.ahead > res.commits.length ? { truncated: true } : {}),
        },
    };
    return months;
}

// --- report ---

/** A percentage of `part` in `whole`, or a dash when there is nothing to divide. */
function pct(part, whole) {
    return whole ? `${Math.round((100 * part) / whole)}%` : "-";
}

/** One printed table per repository, newest month last. */
function summarize(history) {
    const rows = [];
    for (const [name, { months }] of Object.entries(history.repos ?? {})) {
        rows.push(`\n${name}`);
        rows.push(["month", "lines", "test/code", "big", "commits", "fix share", "main CI fail", "PR CI fail"].map((h) => h.padEnd(14)).join(""));
        for (const [month, f] of Object.entries(months).sort()) {
            const c = f.commits ?? {};
            const cells = [
                month + (f.partial ? "*" : ""),
                f.lines ? f.lines.total.toLocaleString("en") : "-",
                f.lines?.code ? (f.lines.test / f.lines.code).toFixed(2) : "-",
                f.bigFiles ?? "-",
                c.total ?? "-",
                pct(c.fix ?? 0, (c.fix ?? 0) + (c.feat ?? 0)),
                f.ci?.main ? `${pct(f.ci.main.failure, f.ci.main.runs)} of ${f.ci.main.runs}` : "-",
                f.ci?.pr ? `${pct(f.ci.pr.failure, f.ci.pr.runs)} of ${f.ci.pr.runs}` : "-",
            ];
            rows.push(cells.map((x) => String(x).padEnd(14)).join(""));
        }
    }
    for (const [name, { months }] of Object.entries(history.forks ?? {})) {
        const latest = Object.entries(months).sort().reverse().find(([, f]) => f.diff);
        if (latest) {
            const d = latest[1].diff;
            rows.push(`\n${name} fork: +${d.additions} -${d.deletions} in ${d.files} files, ${d.aheadBy} commits ahead of ${d.upstream} (${d.measured})${d.truncated ? ", truncated" : ""}`);
        }
    }
    rows.push("\n* the month is not over yet");
    return rows.join("\n");
}

function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes("--dry-run");
    const withCi = !args.includes("--no-ci");
    const nowIso = new Date().toISOString();
    const fresh = { repos: {}, forks: {} };

    for (const repo of REPOS) {
        const months = existsSync(repo.dir) ? gitVitals(repo, nowIso) : (console.error(`${repo.name}: no checkout at ${repo.dir}, git figures skipped`), {});
        if (withCi) {
            try {
                for (const [month, ci] of Object.entries(ciByMonth(ciRuns(repo.gh)))) months[month] = { ...months[month], ci };
            } catch (e) { console.error(`${repo.name}: CI history unavailable (${e.message.split("\n")[0]})`); }
        }
        fresh.repos[repo.name] = { months };
    }
    if (withCi) {
        for (const fork of FORKS) {
            try { fresh.forks[fork.name] = { months: forkVitals(fork, nowIso) }; } catch (e) { console.error(`${fork.name}: compare failed (${e.message.split("\n")[0]})`); }
        }
    }

    const old = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
    const history = { schema: 1, ...mergeHistory(old, fresh), updated: nowIso };
    console.log(summarize(history));
    if (dryRun) return;
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(history, null, 2) + "\n");
    console.error(`\nwrote ${OUT.slice(ROOT.length + 1)}`);
}

if (process.argv[1] && process.argv[1].endsWith("vitals.mjs")) main();

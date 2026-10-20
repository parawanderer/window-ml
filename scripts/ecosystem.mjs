// ecosystem.mjs — one command that answers "how much of this was written by agents, and how much of what they wrote is
// still alive", across window-ml, window-ml-hub, window-ml-host and the forks.
//
//   node scripts/ecosystem.mjs               # table + headline: lines, commits, PRs, tests, authorship, churn
//   node scripts/ecosystem.mjs --blame       # adds SURVIVAL: of the lines alive today, who wrote them and when (about a minute)
//   node scripts/ecosystem.mjs --no-gh       # git only: no PR counts, no live fork diffs (falls back to docs/vitals/history.json)
//   node scripts/ecosystem.mjs --json        # the same figures as JSON on stdout, for a notebook or the README
//
// It reuses `vitals.mjs` (same repo list, same path classification, same line counter) and does not write
// `history.json`: vitals is the monthly TREND, this is the point-in-time TOTAL and the authorship question.
//
// WHAT "WRITTEN BY AN AGENT" MEANS HERE. Every commit is authored under the owner's git identity, so the only
// attribution is the `Co-Authored-By: Claude …` trailer the agent adds. A commit with one counts as agent-written, a
// non-merge commit without one as unattributed (the owner, or an agent that did not add it). Trailer coverage is printed
// so the claim carries its own error bar. Under `--blame`, a surviving line is attributed to the commit that last
// touched it, so a mechanical rewrite (a formatter pass, a bulk rename) moves lines to the rewriting commit.
//
// WHAT THE NUMBERS DO NOT SAY.
//   - "Maintained successfully" is not measurable from git. Survival says the lines were not thrown away, not that they are
//     right. The closest proxies printed here: survival of lines by age, and `vitals.mjs`' fix share and main-CI failure rate.
//   - Lines added counts every line of every commit, so a file moved between folders is added again and deleted once.
//     "Survival" (alive ÷ ever added) is therefore a floor.
//   - Test counts are a regex over test files (`test(`, `it(`, `#[test]`, `func Test`): an upper bound for generated
//     tables, a lower bound for a loop that registers cases.
//   - Forks are counted as what they ADD over upstream, never their size, and are not in the authorship split (their
//     commits are not read here).
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { FORKS, LOCKFILES, REPOS, forkVitals, git, linesAt, monthOf, pathKind } from "./vitals.mjs";
import { basename } from "node:path";

const run = promisify(execFile);
const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** Kinds that count as WRITTEN code for authorship and churn: not data, generated files or docs. */
/** Extended projects measured from a local clone, because GitHub's compare against a moved-on upstream `main` is noise. */
const LOCAL_FORKS = [
    { name: "cpython", upstream: "python/cpython (3.14.x)", dir: process.env.CPYTHON_DIR || join(ROOT, "..", "cpython-restricted"), remote: "fork" },
];

const WRITTEN = new Set(["code", "test"]);

/** The Claude model named by a `Co-Authored-By: Claude …` trailer in a commit message, or null if there is none. */
export function claudeTrailer(message) {
    const m = /^co-authored-by:\s*(claude[^<\n]*?)\s*(?:<|$)/im.exec(message);
    return m ? m[1].trim() : null;
}

/** The path a `git log --numstat` row names, with a rename (`a/{b => c}/d`, `a => b`) resolved to its new name. */
export function resolveRenamed(path) {
    if (!path.includes("=>")) return path;
    const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(path);
    if (braced) return (braced[1] + braced[3] + braced[4]).replace(/\/\//g, "/");
    return path.split(" => ")[1];
}

/** Test cases in one test file's text, by regex; see the header for what that is worth. */
export function countTests(path, text) {
    if (/\.rs$/.test(path)) return (text.match(/#\[(?:tokio::|rstest::)?test(?:\([^)]*\))?\]/g) ?? []).length;
    if (/_test\.go$/.test(path)) return (text.match(/^func Test\w*\(/gm) ?? []).length;
    if (/_test\.py$|(^|\/)test_\w+\.py$/.test(path)) return (text.match(/^\s*(?:async )?def test_\w*\(/gm) ?? []).length;
    return (text.match(/^\s*(?:test|it)(?:\.(?:only|skip|fixme|fail|slow))?\(/gm) ?? []).length;
}

/** Fold `git log --numstat` rows into `{ added, deleted }` for written files, split by whether `agent(sha)` is true. */
export function churnFrom(commits) {
    const out = { agent: { added: 0, deleted: 0 }, other: { added: 0, deleted: 0 } };
    for (const { agent, files } of commits) {
        const side = out[agent ? "agent" : "other"];
        for (const { path, added, deleted } of files) {
            if (!WRITTEN.has(pathKind(path)) || LOCKFILES.has(basename(path))) continue;
            side.added += added;
            side.deleted += deleted;
        }
    }
    return out;
}

/** The number of lines each commit owns in `git blame --porcelain` output: every group header is `<sha> <orig> <final>`. */
export function blameOwners(porcelain) {
    const owned = new Map();
    for (const line of porcelain.split("\n")) {
        const m = /^([0-9a-f]{40}) \d+ \d+/.exec(line);
        if (m) owned.set(m[1], (owned.get(m[1]) ?? 0) + 1);
    }
    return owned;
}

// --- per repository ---

/** Every non-merge commit on the ref, as `{ sha, date, agent, model, files[] }`; `files` only when `numstat` is set. */
function readCommits(dir, revs, numstat, extra = []) {
    const fmt = "%x01%H%x02%aI%x02%P%x02%B%x03";
    const raw = git(dir, ["log", `--format=${fmt}`, ...(numstat ? ["--numstat"] : []), ...extra, ...revs]);
    const out = [];
    for (const chunk of raw.split("\x01").slice(1)) {
        const [sha, date, parents, rest] = chunk.split("\x02");
        if (parents.trim().split(" ").length > 1) continue;
        const [body, tail = ""] = rest.split("\x03");
        const model = claudeTrailer(body);
        const files = numstat
            ? tail.split("\n").filter((r) => /^(\d+|-)\t(\d+|-)\t/.test(r)).map((r) => {
                const [a, d, ...p] = r.split("\t");
                return { path: resolveRenamed(p.join("\t")), added: a === "-" ? 0 : +a, deleted: d === "-" ? 0 : +d };
            })
            : [];
        out.push({ sha, date, agent: !!model, model, files });
    }
    return out;
}

/**
 * What a local clone of an extended project adds over upstream: the owner's non-merge commits on the fork's branches that
 * no upstream ref or tag reaches, deduplicated across branches by author date and subject (a rebase keeps both), with
 * their added and deleted lines and how many carry a Claude trailer. By AUTHOR, not by ancestry alone, because a clone's
 * upstream refs can lag and would otherwise count upstream's own newest commits as the fork's.
 */
function localFork(f) {
    const raw = readCommits(f.dir, [`--remotes=${f.remote}`, "--not", "--remotes=origin", "--tags"], true, ["--no-merges", "--author=Shane B", "--author=parawanderer"]);
    const seen = new Set();
    const commits = raw.filter((c) => {
        const key = c.date + c.sha.slice(0, 0) + c.files.map((x) => `${x.path}:${x.added}:${x.deleted}`).join(",");
        return seen.has(key) ? false : (seen.add(key), true);
    });
    const paths = new Set();
    let additions = 0, deletions = 0;
    for (const c of commits) for (const x of c.files) { additions += x.added; deletions += x.deleted; paths.add(x.path); }
    return { name: f.name, upstream: f.upstream, source: "local clone", commits: commits.length, agentCommits: commits.filter((c) => c.agent).length, additions, deletions, files: paths.size };
}

/** Test cases at the ref, by regex over the tracked test files. */
function testsAt(dir, ref) {
    const paths = git(dir, ["ls-tree", "-r", "--name-only", ref]).split("\n").filter((p) => p && pathKind(p) === "test");
    let n = 0;
    for (const p of paths) {
        let text;
        try { text = git(dir, ["show", `${ref}:${p}`]); } catch { continue; }
        n += countTests(p, text);
    }
    return n;
}

/** Merged pull requests of a GitHub repository, or null without `gh`. */
function mergedPrs(gh) {
    try {
        return Number(execFileSync("gh", ["api", `search/issues?q=repo:${gh}+is:pr+is:merged&per_page=1`, "--jq", ".total_count"], { encoding: "utf8" }).trim());
    } catch { return null; }
}

/** Who wrote the lines alive in written files at the ref, by agent-or-not and by month, through `git blame`. */
async function survival(dir, ref, agentShas, dateOf) {
    const tree = git(dir, ["ls-tree", "-r", "--name-only", ref]).split("\n").filter((p) => p && WRITTEN.has(pathKind(p)) && !LOCKFILES.has(basename(p)));
    const byMonth = {};
    let agent = 0, other = 0, next = 0;
    const worker = async () => {
        while (next < tree.length) {
            const path = tree[next++];
            let out;
            try { out = (await run("git", ["-C", dir, "blame", "--porcelain", "-w", ref, "--", path], { maxBuffer: 1 << 30 })).stdout; } catch { continue; }
            for (const [sha, n] of blameOwners(out)) {
                const side = agentShas.has(sha) ? "agent" : "other";
                if (side === "agent") agent += n; else other += n;
                const month = monthOf(dateOf.get(sha) ?? new Date().toISOString());
                const m = (byMonth[month] ??= { agent: 0, other: 0 });
                m[side] += n;
            }
        }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    return { agent, other, byMonth };
}

/** All figures for one repository checkout. */
async function measure(repo, { blame, gh }) {
    try { git(repo.dir, ["fetch", "-q", "origin"]); } catch { /* offline: use the local ref */ }
    const commits = readCommits(repo.dir, [repo.ref], true);
    const agentCommits = commits.filter((c) => c.agent);
    const models = {};
    for (const c of agentCommits) models[c.model] = (models[c.model] ?? 0) + 1;
    const sha = git(repo.dir, ["rev-parse", repo.ref]).trim();
    const { lines, bigFiles } = linesAt(repo.dir, sha, new Map());
    const churn = churnFrom(commits);
    const res = {
        name: repo.name, head: sha.slice(0, 8), lines, bigFiles,
        commits: { nonMerge: commits.length, agent: agentCommits.length, models },
        firstCommit: commits[commits.length - 1]?.date.slice(0, 10), lastCommit: commits[0]?.date.slice(0, 10),
        churn, tests: testsAt(repo.dir, repo.ref),
        prs: gh ? mergedPrs(repo.gh) : null,
    };
    if (blame) {
        res.survival = await survival(repo.dir, repo.ref, new Set(agentCommits.map((c) => c.sha)), new Map(commits.map((c) => [c.sha, c.date])));
    }
    return res;
}

// --- report ---

const n = (x) => (x == null ? "-" : x.toLocaleString("en"));
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "-");

/** The fork diffs: live from GitHub, or the newest snapshot in history.json when `gh` is off or fails. */
function forkFigures(gh) {
    const now = new Date().toISOString();
    let history = {};
    try { history = JSON.parse(readFileSync(join(ROOT, "docs", "vitals", "history.json"), "utf8")); } catch { /* none yet */ }
    const local = LOCAL_FORKS.filter((f) => existsSync(f.dir)).map(localFork);
    return [...local, ...FORKS.map((fork) => {
        let diff = null, source = "live";
        if (gh) { try { diff = forkVitals(fork, now)[monthOf(now)].diff; } catch { /* fall through */ } }
        if (!diff) {
            source = "history.json";
            const months = history.forks?.[fork.name]?.months ?? {};
            diff = Object.entries(months).sort().reverse().map(([, f]) => f.diff).find(Boolean) ?? null;
        }
        return { name: fork.name, upstream: fork.upstream, source, ...(diff ?? {}) };
    })];
}

function print(results, forks) {
    const w = (s, k = 16) => String(s).padStart(k);
    const rows = [["", "code", "test", "docs", "commits", "agent %", "PRs", "tests", "added", "alive %"]];
    const total = { code: 0, test: 0, docs: 0, commits: 0, agent: 0, prs: 0, tests: 0, added: 0, alive: 0 };
    for (const r of results) {
        const added = r.churn.agent.added + r.churn.other.added;
        const alive = r.lines.code + r.lines.test;
        rows.push([r.name, n(r.lines.code), n(r.lines.test), n(r.lines.docs), n(r.commits.nonMerge), pct(r.commits.agent, r.commits.nonMerge), n(r.prs), n(r.tests), n(added), pct(alive, added)]);
        total.code += r.lines.code; total.test += r.lines.test; total.docs += r.lines.docs;
        total.commits += r.commits.nonMerge; total.agent += r.commits.agent; total.prs += r.prs ?? 0; total.tests += r.tests;
        total.added += added; total.alive += alive;
    }
    rows.push(["TOTAL", n(total.code), n(total.test), n(total.docs), n(total.commits), pct(total.agent, total.commits), n(total.prs || null), n(total.tests), n(total.added), pct(total.alive, total.added)]);
    for (const row of rows) console.log(row.map((c, i) => (i ? w(c, 11) : String(c).padEnd(16))).join(""));
    console.log("\ncode/test/docs: lines at origin/main. added: every line ever added to code+test (moves count again). alive %: current code+test ÷ added, a floor.");

    const fAdd = forks.reduce((s, f) => s + (f.additions ?? 0), 0);
    console.log("\nforks, what they add over upstream:");
    for (const f of forks) console.log(`  ${f.name.padEnd(11)} ${f.additions != null ? `+${n(f.additions)} -${n(f.deletions)} in ${f.files} files, ${f.aheadBy ?? f.commits} commits${f.agentCommits != null ? ` (${f.agentCommits} with a Claude trailer)` : ""} ahead of ${f.upstream} (${f.measured ?? "now"}, ${f.source})${f.truncated ? ", truncated: a floor" : ""}` : "no figure"}`);

    console.log("\nagent-attributed commits by model:");
    const models = {};
    for (const r of results) for (const [m, c] of Object.entries(r.commits.models)) models[m] = (models[m] ?? 0) + c;
    for (const [m, c] of Object.entries(models).sort((a, b) => b[1] - a[1])) console.log(`  ${String(c).padStart(5)}  ${m}`);

    const withSurvival = results.filter((r) => r.survival);
    if (withSurvival.length) {
        console.log("\nlines alive today in code+test, by whether the last commit to touch them carries a Claude trailer:");
        let a = 0, o = 0;
        const byMonth = {};
        for (const r of withSurvival) {
            console.log(`  ${r.name.padEnd(16)} agent ${n(r.survival.agent)} (${pct(r.survival.agent, r.survival.agent + r.survival.other)}), other ${n(r.survival.other)}`);
            a += r.survival.agent; o += r.survival.other;
            for (const [m, v] of Object.entries(r.survival.byMonth)) { const t = (byMonth[m] ??= { agent: 0, other: 0 }); t.agent += v.agent; t.other += v.other; }
        }
        console.log(`  ${"all".padEnd(16)} agent ${n(a)} (${pct(a, a + o)}), other ${n(o)}`);
        console.log("\nthe same lines by month they were last touched (older rows shrinking is churn doing its work):");
        for (const [m, v] of Object.entries(byMonth).sort()) console.log(`  ${m}  ${n(v.agent + v.other).padStart(9)}  agent ${pct(v.agent, v.agent + v.other)}`);
    }

    const allWritten = total.code + total.test;
    console.log("\nHEADLINE");
    console.log(`  ${n(allWritten)} lines of code and tests (${n(allWritten + total.docs)} with docs) across ${results.length} repositories, plus +${n(fAdd)} lines added to the forks,`);
    console.log(`  in ${n(total.commits)} commits${total.prs ? ` and ${n(total.prs)} merged PRs` : ""}; ${pct(total.agent, total.commits)} of the commits carry a Claude trailer.`);
    console.log(`  ${n(total.tests)} test cases. Of ${n(total.added)} code+test lines ever added, ${pct(total.alive, total.added)} are still there.`);
}

async function main() {
    const args = process.argv.slice(2);
    const gh = !args.includes("--no-gh");
    const blame = args.includes("--blame");
    const results = [];
    for (const repo of REPOS) {
        if (!existsSync(repo.dir)) { console.error(`${repo.name}: no checkout at ${repo.dir}, skipped (VITALS_HUB_DIR / VITALS_HOST_DIR)`); continue; }
        console.error(`measuring ${repo.name}…`);
        results.push(await measure(repo, { blame, gh }));
    }
    const forks = forkFigures(gh);
    if (args.includes("--json")) { console.log(JSON.stringify({ measured: new Date().toISOString(), repos: results, forks }, null, 2)); return; }
    print(results, forks);
}

if (process.argv[1] && process.argv[1].endsWith("ecosystem.mjs")) await main();

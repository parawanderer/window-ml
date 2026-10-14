#!/usr/bin/env node
// merge-when-green.mjs — MERGE YOUR OWN PR ONLY WHEN THE STANDING RULE HOLDS, AND SAY WHAT A MERGE WOULD LEAVE BEHIND. The
// owner's rule for a session's own PR: the whole pipeline is green, no test was removed, and nobody has reviewed or
// commented (an unread review is a reason to stop, not to merge). This checks exactly that, waits while CI is still
// running, and squash-merges when asked.
//
//   node scripts/merge-when-green.mjs 501             # check once: prints OK, or why not (exit 0 / 1)
//   node scripts/merge-when-green.mjs 501 --wait      # poll every 30 s while CI runs (up to an hour), then check
//   node scripts/merge-when-green.mjs 501 --wait --merge   # …and squash-merge when it says OK
//   … --session <id>  # your harness's session id: comments YOU posted (their agent-post marker) do not count as unread
//   … --keep-bench    # first move a worktree's bench results into the main clone (see below)
//   … --discard       # merge even though a worktree holds work in no commit: it stays there, and goes with the worktree
//
// WHAT A MERGE WOULD LEAVE BEHIND. Before the verdict it looks at each local checkout of the PR's branch and names what
// lives only on that disk: bench sweeps and the scoreboard database under tests/e2e/artifacts/bench/ (git ignores them),
// and uncommitted or untracked files. Both have been lost this way: a sweep's runs went with a worktree cleaned up after
// its merge, and an interview file sat untracked on a throwaway branch. A LINKED WORKTREE holding any of it REFUSES the
// merge and prints how to keep it: `--keep-bench` moves its sweeps into the main clone's bench directory and merges its
// scoreboard rows into the main clone's (rows are keyed by run, so nothing is counted twice); uncommitted files are
// committed or stashed by hand; `--discard` merges anyway, moving nothing (what is there goes when the worktree is
// removed). On EVERY merge, with or without either flag, every page server (its server.json's and each the memory ledger
// lists for it) and held run a linked worktree left running is stopped, since the worktree is about to go; each stopped server prints the `serve.mjs` line that serves its sweep
// again. The main clone is only reminded: nothing removes it. A checkout on the branch also keeps its LOCAL branch, and
// only the remote one is deleted.

import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const REPO = "parawanderer/window-ml";
const POLL_MS = 60_000, POLL_LIMIT = 90;
/** Below this many GitHub API calls left in the hour, a waiter sleeps until the budget resets: every session on the
 *  account shares the 5,000 an hour, and a few waiters polling at once once ran it out (2026-10-09). */
const API_RESERVE = 300;

/** Run a command in the repo, returning trimmed stdout ("" on failure). */
function sh(cmd, args, cwd = ROOT) {
    const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : "";
}
const gh = (...args) => sh("gh", args);
const git = (...args) => sh("git", args);

/** How many `test(` declarations a unified diff of tests/ removes and adds: the "no test removed" half of the rule. */
export function testLineCounts(diff) {
    const decl = /(^|[^A-Za-z_.])test\(/;
    let removed = 0, added = 0;
    for (const line of diff.split("\n")) {
        if (line.startsWith("---") || line.startsWith("+++")) continue;
        if (line.startsWith("-") && decl.test(line.slice(1))) removed++;
        else if (line.startsWith("+") && decl.test(line.slice(1))) added++;
    }
    return { removed, added };
}

/**
 * The TESTS a diff deletes, from `git diff --name-status` over tests/: a `*.test.*` or `*.spec.*` file, or a fixture
 * under tests/fixtures/. Not every file under tests/: it also holds the harness and the bench's own code (its page, the
 * e2e drivers), and moving one of those out to src/ is not removing a test. A test whose lines go is caught apart, by
 * the count of `test(` lines.
 */
export function deletedTests(nameStatus) {
    return nameStatus.split("\n").filter((l) => l.startsWith("D")).map((l) => l.split("\t").pop())
        .filter((f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) || f.startsWith("tests/fixtures/"));
}

/**
 * The AGENT-POST MARKER at the end of a comment an agent posted (AGENTS.md, "GitHub posts say which session"):
 * `<!-- agent-post: harness=… work=… session=… model=… -->`, as an object, or null when there is none. Everything an
 * agent posts through `gh` carries the owner's name, so this marker is the only way to tell a session's own note from
 * a review.
 */
export function agentMarker(body) {
    const m = /<!--\s*agent-post:([^>]*?)-->/.exec(String(body ?? ""));
    if (!m) return null;
    return Object.fromEntries([...m[1].matchAll(/(\w+)=(\S+)/g)].map((x) => [x[1], x[2]]));
}

/**
 * Is this post the merging session's OWN? Only when its marker names that session (the full id, or a prefix of at
 * least 8 characters either way, since a footer may show the short form). Another session's marked post still counts:
 * an agent's review is a review. An unmarked post counts as a person's, so a forgotten marker fails safe.
 */
export function isOwnPost(body, session) {
    const theirs = agentMarker(body)?.session;
    if (!session || !theirs || session.length < 8 || theirs.length < 8) return false;
    return session.startsWith(theirs) || theirs.startsWith(session);
}

/** The verdict from the facts gathered about a PR: `{ ok, pending, reason }`. Pure, so the rule is testable. */
export function judge(f) {
    if (!f.runId) return { ok: false, pending: true, reason: `no tests run for ${f.sha.slice(0, 8)} yet (or the PR conflicts with main: a conflicting PR runs no checks)` };
    if (f.runStatus !== "completed") return { ok: false, pending: true, reason: `run ${f.runId} ${f.runStatus}` };
    if (f.badJobs.length) return { ok: false, reason: `not green: ${f.badJobs.join(" ")} (a cancelled job prints as failed: check before blaming the change)` };
    if (f.deletedTestFiles) return { ok: false, reason: "deletes a test file" };
    if (f.tests.removed > f.tests.added) return { ok: false, reason: `removes tests (${f.tests.removed} removed, ${f.tests.added} added lines)` };
    if (f.reviews || f.inlineComments) return { ok: false, reason: `has ${f.reviews} reviews/comments and ${f.inlineComments} inline comments: read them` };
    if (f.stacked) return { ok: false, reason: "has PRs stacked on it: retarget them first" };
    if (f.mergeable === "UNKNOWN") return { ok: false, pending: true, reason: "GitHub has not computed mergeability yet" };
    if (f.mergeable !== "MERGEABLE") return { ok: false, reason: `not mergeable (${f.mergeable})` };
    return { ok: true, reason: `OK (run ${f.runId} green, tests -${f.tests.removed}/+${f.tests.added} lines)` };
}

/** Everything the rule needs about PR `pr`, from GitHub and the fetched remote. */
/**
 * The ONE call a waiter makes while CI runs: the tests run for the branch's head, as `{ sha, runId, status }`. The full
 * {@link facts} (about five calls) are read once, when this says the run completed, instead of on every poll.
 * @param {string} head the PR's branch
 * @returns {{ sha: string, runId: string | null, status: string | null }}
 */
export function runState(head) {
    git("fetch", "-q", "origin");
    const sha = git("rev-parse", `origin/${head}`);
    const [runId = null, status = null] = (gh("api", `repos/${REPO}/actions/runs?head_sha=${sha}`, "-q",
        '.workflow_runs[] | select(.name=="tests" and .event=="pull_request") | "\\(.id) \\(.status)"').split("\n")[0] || "").split(" ").filter(Boolean);
    return { sha, runId, status };
}

/** Sleep until the hour's API budget resets when fewer than {@link API_RESERVE} calls are left. Reading the budget is free. */
async function spareTheBudget() {
    const [left, reset] = gh("api", "rate_limit", "-q", '.resources.core | "\\(.remaining) \\(.reset)"').split(" ").map(Number);
    if (!(left < API_RESERVE)) return;
    const ms = Math.max(0, reset * 1000 - Date.now()) + 5_000;
    console.log(`  GitHub API budget low (${left} left): waiting ${Math.round(ms / 60_000)} min for it to reset`);
    await new Promise((r) => setTimeout(r, ms));
}

function facts(pr, session) {
    git("fetch", "-q", "origin");
    const view = JSON.parse(gh("pr", "view", String(pr), "--json", "headRefName,mergeable,reviews,comments") || "{}");
    const head = view.headRefName;
    if (!head) throw new Error(`PR #${pr} not found`);
    const sha = git("rev-parse", `origin/${head}`);
    const runId = gh("api", `repos/${REPO}/actions/runs?head_sha=${sha}`, "-q",
        '.workflow_runs[] | select(.name=="tests" and .event=="pull_request") | .id').split("\n")[0] || null;
    const runStatus = runId ? gh("api", `repos/${REPO}/actions/runs/${runId}`, "-q", ".status") : null;
    const badJobs = runId && runStatus === "completed"
        ? gh("api", `repos/${REPO}/actions/runs/${runId}/jobs?per_page=100`, "-q",
            '.jobs[] | select(.conclusion!="success" and .conclusion!="skipped") | "\\(.name)=\\(.conclusion)"').split("\n").filter(Boolean)
        : [];
    const range = `origin/main...origin/${head}`;
    // The conflicts workflow's own notice is about CI, which the run settles; it is not a review.
    // A post the merging session made itself (its agent-post marker) is not something it has to read.
    const comments = (view.comments || []).filter((c) => !String(c.body).includes("<!-- pr-conflicts -->") && !isOwnPost(c.body, session));
    const reviews = (view.reviews || []).filter((r) => !isOwnPost(r.body, session));
    const inline = JSON.parse(gh("api", `repos/${REPO}/pulls/${pr}/comments`) || "[]").filter((c) => !isOwnPost(c.body, session));
    return {
        head, sha, runId, runStatus, badJobs,
        tests: testLineCounts(git("diff", range, "--", "tests")),
        deletedTestFiles: deletedTests(git("diff", "--name-status", range, "--", "tests")).length,
        reviews: reviews.length + comments.length,
        inlineComments: inline.length,
        stacked: Number(gh("pr", "list", "--base", head, "--json", "number", "-q", "length")) || 0,
        mergeable: view.mergeable,
    };
}

/** The main clone's directory and every checkout of `branch`, each marked as the main clone or a linked worktree. */
function checkoutsOf(branch) {
    const out = [];
    let dir = null, main = null;
    for (const line of git("worktree", "list", "--porcelain").split("\n")) {
        if (line.startsWith("worktree ")) { dir = line.slice(9); main ??= dir; }   // the porcelain lists the main clone first
        else if (line === `branch refs/heads/${branch}`) out.push({ dir, linked: dir !== main });
    }
    return { main, checkouts: out };
}

/** What lives only on this checkout's disk: bench sweeps and the scoreboard (git-ignored), and uncommitted files. */
export function diskOnly(dir, status = sh("git", ["status", "--porcelain"], dir), { ledger = LEDGER_FILE } = {}) {
    const bench = path.join(dir, "tests/e2e/artifacts/bench");
    const sweeps = [], scoreDbs = [];
    if (existsSync(bench)) for (const name of readdirSync(bench)) {
        const p = path.join(bench, name);
        if (name.endsWith(".sqlite")) scoreDbs.push(name);
        else if (statSync(p).isDirectory() && ["sweeps.jsonl", "done.json", "page.json"].some((f) => existsSync(path.join(p, f))))
            sweeps.push(name);
    }
    const files = status.split("\n").filter(Boolean);
    return { sweeps, scoreDbs, files, servers: liveServers(dir, path.join(bench, "server.json"), ledger), held: liveHeld(path.join(bench, "held.json")) };
}

/** The bench runs a sweep left HELD open for someone to keep talking to (`held.json`, a list written by the bench
 *  while each lives), keeping only entries whose process is still alive. A worktree removed under one leaves a
 *  browser and a model slot held for nothing. */
function liveHeld(file) {
    try {
        return JSON.parse(readFileSync(file, "utf8")).filter((h) => { try { process.kill(h.pid, 0); return true; } catch { return false; } });
    } catch { return []; }
}

/** The bench's memory ledger (tests/e2e/bench/memory-budget.mjs `LEDGER_FILE`): every bench process on this machine, page servers included. */
const LEDGER_FILE = process.env.BENCH_LEDGER_FILE || path.join(os.homedir(), ".cache", "window-ml-bench", "ledger.json");

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * Every bench page server still running from this checkout: the one in `server.json` (written by
 * tests/e2e/bench/serve.mjs while it lives, but ONE file per checkout, which each `--serve` overwrites), and every
 * `page` entry the memory ledger holds for this checkout, so a second or third sweep's server is not missed. A
 * worktree removed under one leaves it serving nothing, and holding memory the budget counts.
 */
function liveServers(dir, file, ledger) {
    const out = new Map();
    try {
        const s = JSON.parse(readFileSync(file, "utf8"));
        if (alive(s.pid)) out.set(s.pid, s);
    } catch { /* none, or unreadable */ }
    try {
        for (const e of JSON.parse(readFileSync(ledger, "utf8"))) {
            if (e.kind === "page" && e.repo && path.resolve(e.repo) === path.resolve(dir) && !out.has(e.pid) && alive(e.pid))
                out.set(e.pid, { pid: e.pid, url: null, dir: path.join(dir, BENCH, e.sweep ?? "") });
        }
    } catch { /* no ledger */ }
    return [...out.values()];
}

const BENCH = "tests/e2e/artifacts/bench";

/** Move a worktree's sweeps into the main clone and merge its scoreboard rows there. Returns what it could not move. */
export async function keepBench(from, to, { sweeps, scoreDbs }) {
    const src = path.join(from, BENCH), dst = path.join(to, BENCH);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dst, { recursive: true });
    const clashes = [];
    for (const name of sweeps) {
        if (existsSync(path.join(dst, name))) { clashes.push(`${BENCH}/${name}/ (the main clone has one by that name: rename one, then run again)`); continue; }
        renameSync(path.join(src, name), path.join(dst, name));
    }
    for (const name of scoreDbs) {
        if (!existsSync(path.join(dst, name))) { renameSync(path.join(src, name), path.join(dst, name)); continue; }
        // Both have one: copy the rows across. `run` is UNIQUE, so a row already there is skipped, never doubled.
        const { DatabaseSync } = await import("node:sqlite");
        const db = new DatabaseSync(path.join(dst, name));
        db.exec(`ATTACH DATABASE '${path.join(src, name).replaceAll("'", "''")}' AS wt`);
        for (const { name: table } of db.prepare("SELECT name FROM wt.sqlite_master WHERE type = 'table'").all()) {
            const info = db.prepare(`PRAGMA wt.table_info(${table})`).all();
            const cols = info.map((c) => c.name).filter((c) => c !== "id");
            db.exec(`CREATE TABLE IF NOT EXISTS main.${table} AS SELECT * FROM wt.${table} WHERE 0`);
            // The main clone's scoreboard may predate a column the worktree's has (a newer bench added it): add it,
            // empty for the old rows, rather than fail the merge or drop the new rows' value.
            const have = new Set(db.prepare(`PRAGMA main.table_info(${table})`).all().map((c) => c.name));
            for (const c of info) if (!have.has(c.name)) db.exec(`ALTER TABLE main.${table} ADD COLUMN "${c.name}" ${c.type || ""}`);
            db.exec(`INSERT OR IGNORE INTO main.${table} (${cols.join(",")}) SELECT ${cols.join(",")} FROM wt.${table}`);
        }
        db.exec("DETACH DATABASE wt");
        db.close();
        // Its rows are in the main clone's now; left here, the worktree would still hold "work in no commit".
        rmSync(path.join(src, name), { force: true });
    }
    return clashes;
}

/**
 * Check every checkout of `branch` for work in no commit. A linked worktree holding any REFUSES the merge (returns
 * `blocked`) unless `keep` moved its bench results and nothing else is left, or `discard` says to merge anyway.
 */
export async function leftovers(branch, { keep, discard }) {
    const { main, checkouts } = checkoutsOf(branch);
    let blocked = false;
    for (const { dir, linked } of checkouts) {
        let found = diskOnly(dir);
        let clashes = [];
        if (linked && keep && (found.sweeps.length || found.scoreDbs.length)) {
            clashes = await keepBench(dir, main, found);
            console.log(`  kept: moved ${dir}'s bench results into ${path.join(main, BENCH)}`);
            found = diskOnly(dir);
        }
        const { sweeps, scoreDbs, files } = found;
        if (!sweeps.length && !scoreDbs.length && !files.length && !found.servers.length && !found.held.length) continue;
        const stop = linked && !discard;
        blocked ||= stop;
        console.log(`\n${stop ? "✖" : "⚠"} ${dir} (${linked ? "a worktree" : "the main clone"} on ${branch}) holds work that is in no commit:`);
        for (const n of sweeps) console.log(`    bench sweep:  ${BENCH}/${n}/`);
        for (const n of scoreDbs) console.log(`    scoreboard:   ${BENCH}/${n}`);
        for (const c of clashes) console.log(`    not moved:    ${c}`);
        for (const s of found.servers) console.log(`    page server:  pid ${s.pid}${s.url ? ` at ${s.url}` : ""}, serving ${s.dir}`);
        for (const h of found.held) console.log(`    held run:     pid ${h.pid}, ${h.cell} of ${h.sweep}, attach: ${h.attach}`);
        for (const f of files.slice(0, 20)) console.log(`    git:          ${f}`);
        if (files.length > 20) console.log(`    git:          …and ${files.length - 20} more`);
        if (!stop) continue;
        console.log("  A worktree is removed once its work is done, and this would go with it. To keep it:");
        if (sweeps.length || scoreDbs.length) console.log(`    bench results: run again with --keep-bench, which moves the sweeps into ${path.join(main, BENCH)} and merges the scoreboard's rows into the main clone's`);
        if (files.length) console.log(`    files: commit them (here, or on a new branch from main) or stash them (git -C ${dir} stash -u)`);
        console.log("  To merge without keeping them (they stay in the worktree, and go with it), run again with --discard.");
    }
    const linked = checkouts.filter((c) => c.linked).map((c) => diskOnly(c.dir));
    return { blocked, held: checkouts.length > 0, servers: linked.flatMap((d) => d.servers), heldRuns: linked.flatMap((d) => d.held) };
}

/** Stop the page servers linked worktrees left running: the PR is merged, and a worktree removed under one leaves it
 *  serving a directory that is gone. Says how to serve each sweep again from the main clone. */
function stopServers(servers, main) {
    for (const s of servers) {
        try { process.kill(s.pid, "SIGTERM"); } catch { continue; }
        const moved = path.join(main, BENCH, path.basename(s.dir));
        const again = existsSync(moved) ? moved : s.dir;
        console.log(`  stopped the page server (pid ${s.pid}) a worktree left running; to serve that sweep again: node --import tsx tests/e2e/bench/serve.mjs ${again}`);
    }
}

/** Release the runs linked worktrees left held open: the PR is merged, and the worktree they ran from is about to go. */
function releaseHeld(runs) {
    for (const h of runs) {
        try { process.kill(h.pid, "SIGTERM"); } catch { continue; }
        console.log(`  released the held run ${h.cell} of ${h.sweep} (pid ${h.pid}) a worktree left open`);
    }
}

async function main() {
    const argv = process.argv.slice(2);
    const pr = argv.find((a) => /^\d+$/.test(a));
    if (!pr) { console.error("usage: node scripts/merge-when-green.mjs <pr> [--wait] [--merge] [--session <your session id>]"); process.exit(2); }
    const wait = argv.includes("--wait"), merge = argv.includes("--merge");
    const keep = argv.includes("--keep-bench"), discard = argv.includes("--discard");
    const si = argv.indexOf("--session"), session = si >= 0 ? argv[si + 1] : null;
    let f, v;
    for (let i = 0; ; i++) {
        f = facts(pr, session);
        v = judge(f);
        if (!v.pending || !wait || i >= POLL_LIMIT) break;
        // While the run is still going, one call a minute says so; the full facts wait until it is done.
        for (; i < POLL_LIMIT; i++) {
            await spareTheBudget();
            await new Promise((r) => setTimeout(r, POLL_MS));
            const r = runState(f.head);
            if (r.sha !== f.sha || r.runId !== f.runId || r.status === "completed") break;
        }
    }
    const { blocked, held, servers, heldRuns } = await leftovers(f.head, { keep, discard });
    console.log(`${pr}: ${v.reason}`);
    if (!v.ok) process.exit(1);
    if (blocked) { console.log(`${pr}: ${merge ? "NOT MERGED" : "would not merge"}: a worktree holds work that is in no commit (above)`); process.exit(1); }
    if (!merge) return;
    // A checkout on the branch keeps its local branch: only the remote one goes.
    // Pinned to the commit the rule was checked on: a push during the wait must never be merged untested.
    const args = ["pr", "merge", pr, "--squash", "--match-head-commit", f.sha, ...(held ? [] : ["--delete-branch"])];
    if (spawnSync("gh", args, { cwd: ROOT, stdio: "inherit" }).status !== 0) { console.log(`${pr}: merge FAILED`); process.exit(1); }
    if (held) gh("api", "-X", "DELETE", `repos/${REPO}/git/refs/heads/${f.head}`);
    stopServers(servers, checkoutsOf(f.head).main);
    releaseHeld(heldRuns);
    console.log(`${pr}: MERGED ${gh("pr", "view", pr, "--json", "mergeCommit", "-q", ".mergeCommit.oid").slice(0, 8)}${held ? ` (local branch ${f.head} kept: a checkout holds it)` : ""}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

#!/usr/bin/env node
// merge-when-green.mjs — MERGE YOUR OWN PR ONLY WHEN THE STANDING RULE HOLDS, AND SAY WHAT A MERGE WOULD LEAVE BEHIND. The
// owner's rule for a session's own PR: the whole pipeline is green, no test was removed, and nobody has reviewed or
// commented (an unread review is a reason to stop, not to merge). This checks exactly that, waits while CI is still
// running, and squash-merges when asked.
//
//   node scripts/merge-when-green.mjs 501             # check once: prints OK, or why not (exit 0 / 1)
//   node scripts/merge-when-green.mjs 501 --wait      # poll every 30 s while CI runs (up to an hour), then check
//   node scripts/merge-when-green.mjs 501 --wait --merge   # …and squash-merge when it says OK
//   … --keep-bench    # first move a worktree's bench results into the main clone (see below)
//   … --discard       # merge even though a worktree holds work that is in no commit
//
// WHAT A MERGE WOULD LEAVE BEHIND. Before the verdict it looks at each local checkout of the PR's branch and names what
// lives only on that disk: bench sweeps and the scoreboard database under tests/e2e/artifacts/bench/ (git ignores them),
// and uncommitted or untracked files. Both have been lost this way: a sweep's runs went with a worktree cleaned up after
// its merge, and an interview file sat untracked on a throwaway branch. A LINKED WORKTREE holding any of it REFUSES the
// merge and prints how to keep it: `--keep-bench` moves its sweeps into the main clone's bench directory and merges its
// scoreboard rows into the main clone's (rows are keyed by run, so nothing is counted twice); uncommitted files are
// committed or stashed by hand; `--discard` merges anyway. The main clone is only reminded: nothing removes it. A
// checkout on the branch also keeps its LOCAL branch, and only the remote one is deleted.

import { existsSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const REPO = "parawanderer/window-ml";
const POLL_MS = 30_000, POLL_LIMIT = 120;

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
function facts(pr) {
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
    const comments = (view.comments || []).filter((c) => !String(c.body).includes("<!-- pr-conflicts -->"));
    return {
        head, sha, runId, runStatus, badJobs,
        tests: testLineCounts(git("diff", range, "--", "tests")),
        deletedTestFiles: git("diff", "--name-status", range, "--", "tests").split("\n").filter((l) => l.startsWith("D")).length,
        reviews: (view.reviews || []).length + comments.length,
        inlineComments: Number(gh("api", `repos/${REPO}/pulls/${pr}/comments`, "-q", "length")) || 0,
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
export function diskOnly(dir, status = sh("git", ["status", "--porcelain"], dir)) {
    const bench = path.join(dir, "tests/e2e/artifacts/bench");
    const sweeps = [], scoreDbs = [];
    if (existsSync(bench)) for (const name of readdirSync(bench)) {
        const p = path.join(bench, name);
        if (name.endsWith(".sqlite")) scoreDbs.push(name);
        else if (statSync(p).isDirectory() && ["sweeps.jsonl", "done.json", "page.json"].some((f) => existsSync(path.join(p, f))))
            sweeps.push(name);
    }
    const files = status.split("\n").filter(Boolean);
    return { sweeps, scoreDbs, files, server: liveServer(path.join(bench, "server.json")), held: liveHeld(path.join(bench, "held.json")) };
}

/** The bench runs a sweep left HELD open for someone to keep talking to (`held.json`, a list written by the bench
 *  while each lives), keeping only entries whose process is still alive. A worktree removed under one leaves a
 *  browser and a model slot held for nothing. */
function liveHeld(file) {
    try {
        return JSON.parse(readFileSync(file, "utf8")).filter((h) => { try { process.kill(h.pid, 0); return true; } catch { return false; } });
    } catch { return []; }
}

/** The detached bench page server a finished sweep left running from this checkout (`server.json`, written by
 *  tests/e2e/bench/serve.mjs only while it is alive), or null. A worktree removed under it leaves it serving nothing. */
function liveServer(file) {
    try {
        const s = JSON.parse(readFileSync(file, "utf8"));
        process.kill(s.pid, 0);   // throws when no such process
        return s;
    } catch { return null; }
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
            const cols = db.prepare(`PRAGMA wt.table_info(${table})`).all().map((c) => c.name).filter((c) => c !== "id");
            db.exec(`CREATE TABLE IF NOT EXISTS main.${table} AS SELECT * FROM wt.${table} WHERE 0`);
            db.exec(`INSERT OR IGNORE INTO main.${table} (${cols.join(",")}) SELECT ${cols.join(",")} FROM wt.${table}`);
        }
        db.exec("DETACH DATABASE wt");
        db.close();
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
        if (!sweeps.length && !scoreDbs.length && !files.length && !found.server && !found.held.length) continue;
        const stop = linked && !discard;
        blocked ||= stop;
        console.log(`\n${stop ? "✖" : "⚠"} ${dir} (${linked ? "a worktree" : "the main clone"} on ${branch}) holds work that is in no commit:`);
        for (const n of sweeps) console.log(`    bench sweep:  ${BENCH}/${n}/`);
        for (const n of scoreDbs) console.log(`    scoreboard:   ${BENCH}/${n}`);
        for (const c of clashes) console.log(`    not moved:    ${c}`);
        if (found.server) console.log(`    page server:  pid ${found.server.pid} at ${found.server.url}, serving ${found.server.dir}`);
        for (const h of found.held) console.log(`    held run:     pid ${h.pid}, ${h.cell} of ${h.sweep}, attach: ${h.attach}`);
        for (const f of files.slice(0, 20)) console.log(`    git:          ${f}`);
        if (files.length > 20) console.log(`    git:          …and ${files.length - 20} more`);
        if (!stop) continue;
        console.log("  A worktree is removed once its work is done, and this would go with it. To keep it:");
        if (sweeps.length || scoreDbs.length) console.log(`    bench results: run again with --keep-bench, which moves the sweeps into ${path.join(main, BENCH)} and merges the scoreboard's rows into the main clone's`);
        if (files.length) console.log(`    files: commit them (here, or on a new branch from main) or stash them (git -C ${dir} stash -u)`);
        console.log("  To merge without keeping them, run again with --discard.");
    }
    const linked = checkouts.filter((c) => c.linked).map((c) => diskOnly(c.dir));
    return { blocked, held: checkouts.length > 0, servers: linked.map((d) => d.server).filter(Boolean), heldRuns: linked.flatMap((d) => d.held) };
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
    if (!pr) { console.error("usage: node scripts/merge-when-green.mjs <pr> [--wait] [--merge]"); process.exit(2); }
    const wait = argv.includes("--wait"), merge = argv.includes("--merge");
    const keep = argv.includes("--keep-bench"), discard = argv.includes("--discard");
    let f, v;
    for (let i = 0; ; i++) {
        f = facts(pr);
        v = judge(f);
        if (!v.pending || !wait || i >= POLL_LIMIT) break;
        await new Promise((r) => setTimeout(r, POLL_MS));
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

#!/usr/bin/env node
// merge-when-green.mjs — MERGE YOUR OWN PR ONLY WHEN THE STANDING RULE HOLDS, AND SAY WHAT A MERGE WOULD LEAVE BEHIND. The
// owner's rule for a session's own PR: the whole pipeline is green, no test was removed, and nobody has reviewed or
// commented (an unread review is a reason to stop, not to merge). This checks exactly that, waits while CI is still
// running, and squash-merges when asked.
//
//   node scripts/merge-when-green.mjs 501             # check once: prints OK, or why not (exit 0 / 1)
//   node scripts/merge-when-green.mjs 501 --wait      # poll every 30 s while CI runs (up to an hour), then check
//   node scripts/merge-when-green.mjs 501 --wait --merge   # …and squash-merge when it says OK
//   … --session <id>  # your harness's session id: a post whose agent-post marker names it is LABELLED yours in the
//                     # refusal. It still blocks: a marker is text anyone can write, so it can only block, never allow.
//   … --read <id>     # a post you have read that asks nothing further (repeatable): it stops blocking, and the refusal
//                     # prints the ids to name. The tool never parses a body: YOU are saying it asks nothing.
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
//
// MAIN'S COPY JUDGES. Before anything else it fetches origin/main and writes main's copy of this file and every local
// file it imports to a temp directory, and runs that, with the same arguments and this repo as its root. It always does,
// even when the local copy is identical: the local file is a trampoline with no path of its own to a verdict. When main's
// copy cannot run from there (it predates this, imports a package, or imports a computed name), it refuses and says why.
//
// A PR THAT TOUCHES THE TOOL IS MERGED BY HAND. A script on a branch can never prove it ran main's copy: a PR that edits
// this file could replace the trampoline. So main's copy REFUSES any PR whose diff touches this file or one it imports,
// and names Shane's merge by hand, after reading it, as the route. The tool enforces that only for PRs that do not also
// disable it; the PR that could lie is the one it never merges and the person reads.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

/** The variable a pinned copy of main's script is handed the repo root in. Main's copy must name it to be runnable. */
export const PIN_SUPPORT = "MERGE_WHEN_GREEN_ROOT";
const ROOT = process.env[PIN_SUPPORT] || path.resolve(import.meta.dirname, "..");
const SELF = path.relative(path.resolve(import.meta.dirname, ".."), import.meta.filename).split(path.sep).join("/");
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
 * Does this post's marker CLAIM to be the merging session's? Only a label for the refusal, never a pass: anyone can
 * write the marker. It claims so only when the marker names that session (the full id, or a prefix of at
 * least 8 characters either way, since a footer may show the short form). Another session's marked post still counts:
 * an agent's review is a review. An unmarked post counts as a person's, so a forgotten marker fails safe.
 */
export function isOwnPost(body, session) {
    const theirs = agentMarker(body)?.session;
    if (!session || !theirs || session.length < 8 || theirs.length < 8) return false;
    return session.startsWith(theirs) || theirs.startsWith(session);
}

/**
 * The id form `--read` and a post's id are compared in: GitHub's URL fragments (`pullrequestreview-12`,
 * `issuecomment-34`, `discussion_r56`) collapse to the bare number a REST list returns, and anything else (a GraphQL
 * node id) stays as written. So one flag value names a post however it was written down.
 */
export function postKey(id) {
    const s = String(id ?? "").trim();
    const m = /^(?:pullrequestreview-|issuecomment-|discussion_r)?(\d+)$/.exec(s);
    return m ? m[1] : s;
}

/**
 * The posts a merge still has to wait for: everything that is not the conflicts workflow's notice (`<!-- pr-conflicts -->`, about CI, which the run settles), and not one `--read`
 * named as read and asking nothing further. A post answers to its numeric id and its GraphQL node id alike. Returns
 * `{ kind, id, author, preview, own }` for each, in review, comment, inline order. Pure, so the rule is testable. The tool
 * never parses a body to decide whether it asks: only `--read` does that, and only for what it names. `own` says the
 * post's marker names `session`; it only labels the refusal, since anyone can write a marker, so text can block a merge
 * but never let one through.
 */
export function pickUnread({ reviews = [], comments = [], inline = [] }, { session = null, read = [] } = {}) {
    const said = new Set(read.flatMap((r) => {
        const s = String(r ?? "").trim();
        return s ? [s, postKey(s)] : [];
    }));
    const out = [];
    const take = (kind, xs, who) => {
        for (const x of xs) {
            const body = String(x.body ?? "");
            if (body.includes("<!-- pr-conflicts -->")) continue;
            const keys = new Set([x.id, x.node_id].filter((v) => v != null).flatMap((v) => [String(v), postKey(v)]));
            if ([...keys].some((k) => said.has(k))) continue;
            out.push({
                kind,
                id: String(x.id ?? x.node_id ?? "?"),
                author: who(x),
                own: isOwnPost(body, session),
                preview: body.replace(/\s+/g, " ").trim().slice(0, 60) || "(no body)",
            });
        }
    };
    const who = (x) => x.user?.login ?? x.author?.login ?? x.author?.name ?? "?";
    take("review", reviews, who);
    take("comment", comments, who);
    take("inline", inline, who);
    return out;
}

/**
 * The imports in a module's source a pinned copy has to bring along: `local` (relative specifiers, static, re-exported
 * or a literal dynamic import), `bare` (packages, which a temp directory cannot resolve; `node:` builtins are neither),
 * and `dynamic`, the count of dynamic imports whose argument is not a string literal and so cannot be followed.
 */
export function localImports(src) {
    const local = new Set(), bare = new Set();
    const add = (spec) => {
        if (spec.startsWith("./") || spec.startsWith("../")) local.add(spec);
        else if (!spec.startsWith("node:")) bare.add(spec);
    };
    for (const m of src.matchAll(/^\s*(?:import\s*["']([^"']+)["']|(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["'])/gm)) add(m[1] ?? m[2]);
    for (const m of src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*[,)]/g)) add(m[1]);
    const dynamic = [...src.matchAll(/\bimport\(\s*(?!["'][^"']*["']\s*[,)])/g)].length;
    return { local: [...local], bare: [...bare], dynamic };
}

/**
 * Main's copy of this script to run in place of this one. `readMain(p)` and `readLocal(p)` return a repo-relative
 * file's text (null when absent). Walks main's import closure from `entry`, never the local one, so an import a branch
 * added is not brought along. Returns `{ action: "pin", files, same }` (path to text; `same` when every file matches the
 * local one, which changes only the message: main's copy runs either way), or `{ action: "refuse", reason }` when main's
 * copy cannot run from a temp directory. Pure, so the rule is testable.
 */
export function pinPlan(entry, readMain, readLocal) {
    const files = {}, todo = [entry];
    while (todo.length) {
        const p = todo.pop();
        if (p in files) continue;
        const src = readMain(p);
        if (src == null) return { action: "refuse", reason: p === entry ? `main has no ${p}` : `main's ${entry} imports ${p}, which main does not have` };
        if (p === entry && !src.includes(PIN_SUPPORT)) return { action: "refuse", reason: `main's ${entry} predates running main's copy (it does not read ${PIN_SUPPORT}): run it from a checkout of main` };
        const { local, bare, dynamic } = localImports(src);
        if (bare.length) return { action: "refuse", reason: `main's ${p} imports the package ${bare[0]}, which a temp directory cannot resolve` };
        if (dynamic) return { action: "refuse", reason: `main's ${p} has a dynamic import of a computed name, so its files cannot be listed` };
        files[p] = src;
        for (const spec of local) todo.push(path.posix.normalize(path.posix.join(path.posix.dirname(p), spec)));
    }
    return { action: "pin", files, same: Object.entries(files).every(([p, src]) => readLocal(p) === src) };
}

/**
 * Run main's copy instead of this one ({@link pinPlan}), always. Returns only inside that copy; otherwise exits with
 * its status, or 1 with the reason when main's copy cannot be run.
 */
function runMainsCopy(argv) {
    if (process.env[PIN_SUPPORT]) return;
    const refuse = (why) => { console.error(`merge-when-green: REFUSED: ${why}`); process.exit(1); };
    if (spawnSync("git", ["fetch", "-q", "origin", "main"], { cwd: ROOT }).status !== 0) refuse("cannot fetch origin/main, so cannot tell whether this copy is main's");
    const readMain = (p) => {
        const r = spawnSync("git", ["show", `origin/main:${p}`], { cwd: ROOT, encoding: "utf8" });
        return r.status === 0 ? r.stdout : null;
    };
    const readLocal = (p) => { try { return readFileSync(path.join(ROOT, p), "utf8"); } catch { return null; } };
    const plan = pinPlan(SELF, readMain, readLocal);
    if (plan.action === "refuse") refuse(plan.reason);
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merge-when-green-")));
    try {
        for (const [p, src] of Object.entries(plan.files)) {
            mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
            writeFileSync(path.join(dir, p), src);
        }
        console.error(`merge-when-green: running main's copy${plan.same ? "" : " (this one differs from it)"}`);
        const r = spawnSync(process.execPath, [path.join(dir, SELF), ...argv], { stdio: "inherit", env: { ...process.env, [PIN_SUPPORT]: ROOT } });
        process.exitCode = r.status ?? 1;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
    process.exit();
}

/**
 * The files of the merge tool a PR's diff touches: `changed` (the diff's paths) that are in `tool` (this script and
 * its local imports). A PR that touches one is merged by hand ({@link judge}). Pure, so the rule is testable.
 */
export function touchesTool(changed, tool) {
    const t = new Set(tool);
    return changed.filter((p) => t.has(p));
}

/** The verdict from the facts gathered about a PR: `{ ok, pending, reason }`. Pure, so the rule is testable. */
export function judge(f) {
    // First, and never pending: no amount of waiting lets the tool judge a change to itself.
    if (f.touchesTool?.length) return { ok: false, reason: `changes the merge tool itself (${f.touchesTool.join(", ")}): Shane merges it by hand, after reading it` };
    if (!f.runId) return { ok: false, pending: true, reason: `no tests run for ${f.sha.slice(0, 8)} yet (or the PR conflicts with main: a conflicting PR runs no checks)` };
    if (f.runStatus !== "completed") return { ok: false, pending: true, reason: `run ${f.runId} ${f.runStatus}` };
    if (f.badJobs.length) return { ok: false, reason: `not green: ${f.badJobs.join(" ")} (a cancelled job prints as failed: check before blaming the change)` };
    if (f.deletedTestFiles) return { ok: false, reason: "deletes a test file" };
    if (f.tests.removed > f.tests.added) return { ok: false, reason: `removes tests (${f.tests.removed} removed, ${f.tests.added} added lines)` };
    if (f.reviews || f.inlineComments) {
        // The ids to name once they have been read and found to ask nothing: `--read` is the only way past one.
        const flags = (f.unread || []).map((u) => `--read ${u.id}`).join(" ");
        // An own post blocks too: its marker is text, which only blocks. Naming it read is the way past.
        return { ok: false, reason: `has ${f.reviews} reviews/comments and ${f.inlineComments} inline comments: read them${flags ? ` (${flags})` : ""}` };
    }
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

/** Every page of a REST list endpoint, flattened: `gh api --paginate --slurp` wraps the pages in an outer array. */
function restList(path) {
    try {
        return JSON.parse(gh("api", "--paginate", "--slurp", path) || "[]").flat();
    } catch {
        return [];
    }
}

function facts(pr, session, read = []) {
    git("fetch", "-q", "origin");
    const view = JSON.parse(gh("pr", "view", String(pr), "--json", "headRefName,mergeable") || "{}");
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
    // REST, so every post carries the numeric id its URL fragment names and `--read` can take either form. The
    // conflicts notice, a session's own post and a post `--read` named are all filtered in pickUnread.
    const unread = pickUnread({
        reviews: restList(`repos/${REPO}/pulls/${pr}/reviews`),
        comments: restList(`repos/${REPO}/issues/${pr}/comments`),
        inline: restList(`repos/${REPO}/pulls/${pr}/comments`),
    }, { session, read });
    // This copy's own files: main's, since the trampoline always hands over.
    const own = path.resolve(import.meta.dirname, "..");
    const readOwn = (p) => { try { return readFileSync(path.join(own, p), "utf8"); } catch { return null; } };
    const plan = pinPlan(SELF, readOwn, readOwn);
    const tool = plan.action === "pin" ? Object.keys(plan.files) : [SELF];
    return {
        head, sha, runId, runStatus, badJobs,
        touchesTool: touchesTool(git("diff", "--name-only", range).split("\n").filter(Boolean), tool),
        tests: testLineCounts(git("diff", range, "--", "tests")),
        deletedTestFiles: deletedTests(git("diff", "--name-status", range, "--", "tests")).length,
        reviews: unread.filter((u) => u.kind !== "inline").length,
        inlineComments: unread.filter((u) => u.kind === "inline").length,
        unread,
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
    runMainsCopy(argv);
    // The PR number is the first bare number that is not a valued flag's argument: `--read 123` names a comment, not a PR.
    const wait = argv.includes("--wait"), merge = argv.includes("--merge");
    const keep = argv.includes("--keep-bench"), discard = argv.includes("--discard");
    const read = [];
    let pr = null, session = null;
    const take = (flag, value) => {
        if (value == null || value === "" || value.startsWith("--")) { console.error(`${flag} needs a value`); process.exit(2); }
        return value;
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--read") read.push(...take(a, argv[++i]).split(",").map((s) => s.trim()).filter(Boolean));
        else if (a.startsWith("--read=")) read.push(...take("--read", a.slice(7)).split(",").map((s) => s.trim()).filter(Boolean));
        else if (a === "--session") session = take(a, argv[++i]);
        else if (a.startsWith("--session=")) session = take("--session", a.slice(10));
        else if (/^\d+$/.test(a)) {
            if (pr) { console.error("one PR number only"); process.exit(2); }
            pr = a;
        }
    }
    if (!pr) { console.error("usage: node scripts/merge-when-green.mjs <pr> [--wait] [--merge] [--session <your session id>] [--read <comment id>]"); process.exit(2); }
    let f, v;
    for (let i = 0; ; i++) {
        f = facts(pr, session, read);
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
    for (const u of f.unread || []) console.log(`  ${u.kind} ${u.id} ${u.author}${u.own ? " (marked yours: still --read it)" : ""}: ${u.preview}`);
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

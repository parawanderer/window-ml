#!/usr/bin/env node
// pr-conflicts.mjs — WHICH OPEN PULL REQUESTS CANNOT BE MERGED, and saying so where someone will see it.
//
// It exists for a failure that is SILENT in the worst way. GitHub builds a `pull_request` workflow run against the
// PR's MERGE COMMIT, so when a PR conflicts with its base there is no merge commit and no run at all: the checks do
// not go red, they stop existing. On 2026-10-04 that cost this repo two commits — three PRs landed on main, #313 went
// `CONFLICTING` without anyone touching it, and its next two pushes were never tested, with nothing red anywhere to
// say so.
//
// A job inside `tests.yml` cannot catch it, because a workflow cannot detect its own absence. So this rides `push`,
// which fires whatever the mergeability, and asks two different questions depending on where the push landed:
//
//   --branch <ref>   the PR for THIS branch, if there is one: did I just push something that conflicts?
//   --all            every open PR: did what just landed on the base break somebody else's?
//
// The second is the one that matters, and it is the one a branch-side check alone would miss entirely — the PR that
// broke had not been pushed to.
//
// MERGEABILITY IS COMPUTED ASYNCHRONOUSLY. GitHub answers `null` until it has worked it out, for a short window after
// any push, and after a push to the base for every PR at once. So `null` is polled and then treated as UNKNOWN, never
// as conflicting: a guard that cries wolf while the answer is still being computed is one people turn off.

import { execFileSync } from "node:child_process";

/** How long to wait for GitHub to work out mergeability, and how often to ask. */
export const POLL_MS = 5000, POLL_TRIES = 12;

/** A pull request as this script needs it. `mergeable` is GitHub's: MERGEABLE, CONFLICTING or UNKNOWN/null. */
/** @typedef {{ number: number, title: string, mergeable?: string|null, headRefName?: string, isDraft?: boolean }} Pr */

/**
 * Sort answered pull requests into the three things there are to do about them.
 *
 * `unknown` is deliberately its own bucket rather than folded into either side: it means GitHub has not finished, and
 * the only honest thing to do with it is say so. Drafts are left out of `conflicting` — a draft that does not merge
 * is not news — but still reported as `drafts`, so a run never silently drops one.
 *
 * @param {Pr[]} prs
 */
export function sortByMergeable(prs) {
    const out = { conflicting: [], unknown: [], ok: [], drafts: [] };
    for (const pr of prs) {
        const m = pr.mergeable ?? "UNKNOWN";
        if (m === "CONFLICTING") (pr.isDraft ? out.drafts : out.conflicting).push(pr);
        else if (m === "MERGEABLE") out.ok.push(pr);
        else out.unknown.push(pr);
    }
    return out;
}

/** The marker that lets a later run find its own comment and edit it, rather than adding a second one each time the
 *  base moves. Invisible in the rendered comment. */
export const MARKER = "<!-- pr-conflicts -->";

/**
 * What to say on a pull request that has stopped being mergeable. It names the consequence rather than the state,
 * because "CONFLICTING" is a word someone can read without understanding that their checks have stopped running.
 *
 * @param {string} base The branch it conflicts with.
 * @param {string} by The commit on that branch that this run was triggered by, or "" when unknown.
 */
export function conflictComment(base, by) {
    return [
        MARKER,
        `This branch conflicts with \`${base}\`${by ? ` as of ${by}` : ""}, so **CI is no longer running on it**.`,
        "",
        "That is not a red check, it is the absence of one: GitHub builds a `pull_request` run against the merge commit,",
        "and while there is no merge commit there is no run. Pushes to this branch will look untested rather than failing.",
        "",
        `Merge \`${base}\` in (or rebase) and the checks come back.`,
    ].join("\n");
}

/** `gh` with its output parsed, or null when the call failed (a repo with no PRs, no token, rate limits). */
function gh(args) {
    try { return JSON.parse(execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })); }
    catch { return null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ask until GitHub has an answer for everything, or the tries run out. Returns whatever it last said. */
async function settled(list) {
    let prs = list();
    for (let i = 0; i < POLL_TRIES && sortByMergeable(prs).unknown.length; i++) {
        await sleep(POLL_MS);
        prs = list();
    }
    return prs;
}

/** Put the comment on a PR, replacing this script's own previous one rather than stacking another beneath it. */
function say(number, body) {
    const mine = (gh(["pr", "view", String(number), "--json", "comments", "--jq", ".comments"]) ?? [])
        .filter((c) => typeof c.body === "string" && c.body.includes(MARKER));
    if (mine.length) {
        // Editing needs the comment's own id, which `gh pr comment` cannot take; the API can.
        const id = mine.at(-1).id ?? mine.at(-1).databaseId;
        if (id) { gh(["api", "-X", "PATCH", `repos/{owner}/{repo}/issues/comments/${id}`, "-f", `body=${body}`]); return; }
    }
    execFileSync("gh", ["pr", "comment", String(number), "--body", body], { stdio: "inherit" });
}

async function main() {
    const args = process.argv.slice(2);
    const branch = args.includes("--branch") ? args[args.indexOf("--branch") + 1] : null;
    const all = args.includes("--all");
    const by = (process.env.GITHUB_SHA || "").slice(0, 8);
    const base = process.env.PR_CONFLICTS_BASE || "main";
    const fields = "number,title,mergeable,headRefName,isDraft";

    if (branch) {
        const list = () => gh(["pr", "list", "--head", branch, "--state", "open", "--json", fields]) ?? [];
        const prs = await settled(list);
        // NO OPEN PR IS A PASS. Every first push of a new branch happens before its PR exists, and failing those
        // would teach everyone to ignore this.
        if (!prs.length) { console.log(`pr-conflicts: no open PR for ${branch} yet.`); return 0; }
        const { conflicting, unknown } = sortByMergeable(prs);
        for (const pr of unknown) console.log(`pr-conflicts: #${pr.number} — GitHub has not worked out mergeability; not treating that as a conflict.`);
        if (!conflicting.length) { console.log(`pr-conflicts: #${prs.map((p) => p.number).join(", #")} merges cleanly into ${base}.`); return 0; }
        for (const pr of conflicting) console.error(`pr-conflicts: #${pr.number} conflicts with ${base}. While it does, no pull_request run is created for it: pushes look untested rather than failing.`);
        return 1;
    }

    if (all) {
        const list = () => gh(["pr", "list", "--state", "open", "--base", base, "--limit", "100", "--json", fields]) ?? [];
        const { conflicting, unknown, ok, drafts } = sortByMergeable(await settled(list));
        console.log(`pr-conflicts: ${ok.length} mergeable, ${conflicting.length} conflicting, ${drafts.length} draft, ${unknown.length} unknown.`);
        for (const pr of conflicting) {
            console.log(`pr-conflicts: #${pr.number} (${pr.title}) now conflicts with ${base}; commenting.`);
            say(pr.number, conflictComment(base, by));
        }
        // NEVER FAILS. This runs on the base's own push, so failing it would redden a commit that is fine for a
        // consequence that belongs to someone else's branch. The comment is the signal, and it reaches the person
        // who can act on it.
        return 0;
    }

    console.error("usage: pr-conflicts.mjs --branch <ref> | --all");
    return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await main());

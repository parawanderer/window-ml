// check-prompt-review.mjs — a REMINDER, never a gate: the prompt the model reads has not been reviewed for a while.
//
//   node scripts/check-prompt-review.mjs             # print a reminder when the last review is old
//   node scripts/check-prompt-review.mjs --staged    # the pre-commit hook: only when this commit touches model-facing text
//
// AGENTS.md asks for a prompt review (docs/dev/prompt-review.md) after a stretch of agent-loop work and at least monthly,
// and records the date ("Last review: **YYYY-MM-DD**"); a review commit carries a `Prompt-Review: <date>` trailer. The
// newer of the two is the last review. This speaks when it is more than MAX_DAYS old, or when MAX_COMMITS commits have
// changed model-facing text since. It exits 0 ALWAYS; in CI the line is a GitHub `::warning` annotation.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_DAYS = 30;
const MAX_COMMITS = 25;

/** What the model reads: the system prompt, the tools' schemas, and the contract whose JSDoc becomes agent_api_docs. */
export const MODEL_FACING = ["src/agent/prompts.ts", "src/tools", "src/ml/ml-tool-factories.ts", "src/contract"];

const git = (args) => {
    try { return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return ""; }
};

/**
 * The date of the last review: the newer of AGENTS.md's record and the newest `Prompt-Review:` trailer, or null.
 * @param agentsMd AGENTS.md's text
 * @param trailers the trailer values found in history, newest first
 */
export function lastReview(agentsMd, trailers) {
    const dates = [agentsMd.match(/Last review: \*\*(\d{4}-\d{2}-\d{2})\*\*/)?.[1], ...trailers]
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d || ""));
    return dates.length ? dates.sort().at(-1) : null;
}

/**
 * The reminder to print, or null when the review is recent enough.
 * @param last the last review's date (YYYY-MM-DD) or null
 * @param commitsSince commits that changed model-facing text since then
 * @param today the date to measure from
 */
export function reminder(last, commitsSince, today = new Date()) {
    if (!last) return "No prompt review is recorded in AGENTS.md (\"Last review: **YYYY-MM-DD**\"). See docs/dev/prompt-review.md.";
    const days = Math.floor((today.getTime() - Date.parse(`${last}T00:00:00Z`)) / 86_400_000);
    if (days <= MAX_DAYS && commitsSince < MAX_COMMITS) return null;
    return `The last prompt review was ${last} (${days} days ago; ${commitsSince} commits have changed what the model reads since). ` +
        "Worth a review when this work settles: docs/dev/prompt-review.md, then update the date in AGENTS.md.";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    if (process.argv.includes("--staged")) {
        const staged = git(["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
        if (!staged.some((f) => MODEL_FACING.some((p) => f === p || f.startsWith(`${p}/`)))) process.exit(0);
    }
    let agents = "";
    try { agents = readFileSync(join(ROOT, "AGENTS.md"), "utf8"); } catch { process.exit(0); }
    const trailers = git(["log", "--format=%(trailers:key=Prompt-Review,valueonly)", "--grep=^Prompt-Review:"]).split("\n").map((s) => s.trim()).filter(Boolean);
    const last = lastReview(agents, trailers);
    const since = last ? git(["log", "--oneline", `--since=${last}T23:59:59Z`, "--", ...MODEL_FACING]).split("\n").filter(Boolean).length : 0;
    const msg = reminder(last, since);
    if (msg) console.log(process.env.GITHUB_ACTIONS ? `::warning file=AGENTS.md,line=1::${msg}` : `  ⚠ ${msg}`);
}

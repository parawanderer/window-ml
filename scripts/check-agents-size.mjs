// check-agents-size.mjs — a REMINDER, never a gate: AGENTS.md is growing past what belongs in every session's context.
//
//   node scripts/check-agents-size.mjs            # the working tree's AGENTS.md
//   node scripts/check-agents-size.mjs --staged   # the copy about to be committed (the pre-commit hook)
//
// AGENTS.md is loaded into EVERY agent session on this repo, whatever it is working on, and Claude Code warns once
// it passes 40k characters. It reached 94.8k one "trap" paragraph at a time, each one reasonable on its own, and
// was cut to ~25k on 2026-10-07 by moving every explanation into the `docs/dev/` file it belongs to. This exists so
// it does not regrow the same way: it speaks at LIMIT, below the harness's own warning, while there is still room
// to move a paragraph instead of having to restructure the file again.
//
// It exits 0 ALWAYS, like check-file-size.mjs: a rule worth one more sentence should get it. In CI the line is a
// GitHub `::warning` annotation on the file.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Characters, since that is what the harness measures. 5k under its 40k warning.
const LIMIT = 35_000;

const staged = process.argv.includes("--staged");
let text;
try {
    text = staged
        ? execFileSync("git", ["show", ":AGENTS.md"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
        : readFileSync(join(ROOT, "AGENTS.md"), "utf8");
} catch {
    process.exit(0);
}

const size = [...text].length;
if (size > LIMIT) {
    const msg = `AGENTS.md is ${size.toLocaleString("en")} characters (reminder at ${LIMIT.toLocaleString("en")}; Claude Code warns at 40,000). ` +
        "It is loaded into every session: keep each rule to a sentence or two and a trap to one line, and move the explanation into its docs/dev/ file.";
    console.log(process.env.GITHUB_ACTIONS ? `::warning file=AGENTS.md,line=1::${msg}` : `  ⚠ ${msg}`);
}

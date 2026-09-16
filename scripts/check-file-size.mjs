// A REMINDER, never a gate: which source files have grown past the size where one file stops being one idea.
//
//   node scripts/check-file-size.mjs [base]     # ratcheted against origin/main (CI, and the default)
//   node scripts/check-file-size.mjs --all      # every oversized file, ignoring the ratchet
//
// It exits 0 ALWAYS. Size is a judgement, not a rule — `contract.ts` is long because it is one contract, and
// splitting it to satisfy a number would make it worse. So this cannot block anything; it can only make the
// growth visible at the moment someone is causing it.
//
// WHY IT RATCHETS. Fifteen of this repo's files are already over the line, so a check that listed them all
// would print the same fifteen names on every run and be scrolled past within a week — which is how a warning
// becomes noise and then becomes invisible. It reports only files this change actually GREW (and any new file
// that arrives oversized), for the same reason the CSS-comment check reads the diff rather than the
// stylesheet: the failure worth catching is "I am making this worse right now", not "this was already big".
//
// In CI the lines are emitted as GitHub `::warning` annotations, so they land on the diff itself rather than
// at the bottom of a log nobody opens.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Where one file stops plausibly being one idea. Deliberately generous: the point is to catch a file on its
// way to three thousand lines, not to police a well-organised eight hundred.
const LIMIT = 800;

// TESTS ARE EXEMPT, as asked. A test file is a LIST — of cases, of fixtures — and a long list is not the same
// failure as a long module: nothing is tangled, and splitting it by size alone scatters related cases. The
// advice below does mention moving tests when the module they cover is split, which is the case where it
// helps.
const SKIP = [/(^|\/)tests?\//, /\.test\.[tj]sx?$/, /\.spec\.m?js$/, /\.gen\.ts$/, /\/node_modules\//, /^dist/];

const inScope = (p) => /^src\/.*\.(ts|tsx)$/.test(p) && !SKIP.some((re) => re.test(p));
const lines = (p) => { try { return readFileSync(join(ROOT, p), "utf8").split("\n").length; } catch { return 0; } };

const git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/** Every in-scope source file, for `--all`. */
function allFiles() {
    return git(["ls-files", "src"]).split("\n").filter(inScope);
}

/** The files this change TOUCHED, with their size before it, so growth can be told from inheritance. A base
 *  that cannot be resolved (a shallow clone, a fork with no origin/main) SKIPS the ratchet rather than
 *  failing: a reminder that breaks a build because it could not find a baseline is one people route around. */
function grownFiles(base, staged) {
    const range = staged ? ["diff", "--cached", "--name-only", base] : ["diff", "--name-only", `${base}...HEAD`];
    let touched;
    try { touched = git(range).split("\n").filter(inScope); }
    catch { return null; }
    return touched.map((p) => {
        let before = 0;
        // Absent in the base = a NEW file. It has no inherited size to be forgiven, so any oversized new file
        // is reported however it arrived.
        try { before = git(["show", `${base}:${p}`]).split("\n").length; } catch { before = 0; }
        return { path: p, before, now: lines(p) };
    }).filter((f) => f.now > LIMIT && f.now > f.before);
}

const ADVICE = "consider refactoring this into separate logical modules, and moving the tests that cover them "
    + "into per-module files where that follows";

function report(items) {
    const ci = !!process.env.GITHUB_ACTIONS;
    for (const { path, before, now } of items) {
        const grew = before ? ` (+${now - before} in this change, was ${before})` : " (new file)";
        const text = `${path} is ${now} lines${grew} — over ${LIMIT}. ${ADVICE}.`;
        // `::warning` puts it on the changed line in the PR's Files view; `file=` alone lands it on the file.
        console.log(ci ? `::warning file=${path},line=1::${text}` : `  ⚠ ${text}`);
    }
    if (!items.length) console.log(`file sizes: nothing over ${LIMIT} lines grew in this change.`);
    else if (!process.env.GITHUB_ACTIONS) console.log(`\n  (A reminder, not a gate — this never fails a build.)`);
}

const args = process.argv.slice(2);
if (args.includes("--all")) {
    const over = allFiles().map((p) => ({ path: p, before: 0, now: lines(p) })).filter((f) => f.now > LIMIT)
        .sort((a, b) => b.now - a.now);
    console.log(`file sizes: ${over.length} file(s) over ${LIMIT} lines.`);
    for (const { path, now } of over) console.log(`  ${String(now).padStart(5)}  ${path}`);
} else {
    const base = args.find((a) => !a.startsWith("--")) || "origin/main";
    const grown = grownFiles(base, args.includes("--staged"));
    if (grown === null) console.log(`file sizes: cannot diff against ${base} — skipping the ratchet.`);
    else report(grown);
}
process.exit(0);   // ALWAYS. See the header: this is a reminder.

// A REMINDER, never a gate: which source files have grown past the size where one file stops being one idea.
//
//   node scripts/check-file-size.mjs [base]     # ratcheted against origin/main (CI, and the default)
//   node scripts/check-file-size.mjs --all      # every oversized file, ignoring the ratchet
//   node scripts/check-file-size.mjs --cost     # every file ranked by what it COSTS to keep working in
//
// WHY THERE ARE TWO SURVEYS. `--all` sorts by length, which answers "what is big". That is the wrong question
// for deciding where to spend a day: a long file nobody opens costs nothing, and a file of half the length
// edited every week costs more. `--cost` ranks by lines x commits-that-touched-it, which is roughly what a
// reader actually pays, since a file is only read when someone works on it. Ranked that way this repo's three
// resource-panel files were 52% of the total while being 15% of the lines, and `dom.ts` — fourth by length —
// was 1.6%. Sorting by size alone sends you to the wrong file.
//
// `--cost` deliberately ignores LIMIT, because cost has no threshold: a 430-line file edited 42 times outranks
// several oversized ones, and the size gate cannot see it by construction.
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
// WHAT COST DOES NOT MEASURE, so it is not mistaken for a verdict:
//   - Commits are WRITES. A file is also read to understand a call site or check a type, and a heavily imported
//     type module can be read constantly and edited rarely. That is why fan-in is printed beside the score
//     instead of folded into it: a high-fan-in, low-churn file is read more than its churn admits, and there is
//     no honest weight to combine the two with.
//   - It is backward-looking. A subsystem that churned while being built and is now finished scores high and
//     deserves nothing. Check whether the work is still live before believing the ranking.
//   - Churn resets on a split. New modules carry none of the parent's history, so the next run will overstate
//     how much a split helped.
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
        // STAGED reads the INDEX, not the disk. A hook that measured the working tree would be answering
        // about a state nobody is committing — the same distinction the CSS ratchet draws for its diff.
        let now = 0;
        if (staged) { try { now = git(["show", `:${p}`]).split("\n").length; } catch { now = 0; } }
        else now = lines(p);
        return { path: p, before, now };
    }).filter((f) => f.now > LIMIT && f.now > f.before);
}

const ADVICE = "consider refactoring this into separate logical modules (`node scripts/move-symbols.mjs` does the move), "
    + "and moving the tests that cover them into per-module files where that follows";

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

/** How many commits in the window touched each file — the proxy for how often anyone has to open it. */
function churn(since) {
    const counts = new Map();
    let out;
    try { out = git(["log", `--since=${since}`, "--format=", "--name-only", "--", "src"]); }
    catch { return counts; }
    for (const line of out.split("\n")) {
        const p = line.trim();
        if (p && inScope(p)) counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    return counts;
}

/** How many other source files import each one. Printed, never scored — see the header. Both spellings count:
 *  a static `from "./x"` and the inline type query `import("./x")`, which is a string no tool rewrites. */
function fanIn(files) {
    const counts = new Map(files.map((f) => [f, 0]));
    for (const f of files) {
        let src;
        try { src = readFileSync(join(ROOT, f), "utf8"); } catch { continue; }
        const dir = dirname(f);
        for (const m of src.matchAll(/(?:from\s*|import\()\s*"(\.[^"]+)"/g)) {
            const base = join(dir, m[1]);
            for (const cand of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
                if (counts.has(cand) && cand !== f) { counts.set(cand, counts.get(cand) + 1); break; }
            }
        }
    }
    return counts;
}

const args = process.argv.slice(2);
const flagValue = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};

if (args.includes("--cost")) {
    // Six months by default: long enough that one busy fortnight does not decide the ranking, short enough to
    // still describe what people are working on now.
    const since = flagValue("--since", "6 months ago");
    const top = Number(flagValue("--top", "20"));
    const files = allFiles();
    const edits = churn(since), fan = fanIn(files);
    const rows = files.map((p) => {
        const n = lines(p), c = edits.get(p) ?? 0;
        return { path: p, now: n, edits: c, fan: fan.get(p) ?? 0, cost: n * c };
    }).filter((r) => r.cost > 0).sort((a, b) => b.cost - a.cost);
    const total = rows.reduce((t, r) => t + r.cost, 0) || 1;
    console.log(`file cost: lines x commits since "${since}", across ${rows.length} touched file(s).`);
    console.log(`  ${"cost".padStart(9)} ${"lines".padStart(6)} ${"edits".padStart(6)} ${"in".padStart(4)}  share  file`);
    for (const r of rows.slice(0, top)) {
        console.log(`  ${String(r.cost).padStart(9)} ${String(r.now).padStart(6)} ${String(r.edits).padStart(6)}`
            + ` ${String(r.fan).padStart(4)}  ${(100 * r.cost / total).toFixed(1).padStart(4)}%  ${r.path}`);
    }
    const shown = rows.slice(0, top).reduce((t, r) => t + r.cost, 0);
    console.log(`\n  top ${Math.min(top, rows.length)} are ${(100 * shown / total).toFixed(0)}% of the total.`);
    console.log(`  'in' is how many source files import this one — read the header before treating cost as a verdict.`);
} else if (args.includes("--all")) {
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

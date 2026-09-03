// Check the whitespace invariants .editorconfig declares. Reports; never rewrites.
//
//   node scripts/check-format.mjs            # everything git tracks
//   node scripts/check-format.mjs --staged   # only what is staged (what the pre-commit hook runs)
//   node scripts/check-format.mjs --fix      # fix ONLY the two unambiguous ones (see below)
//
// A CHECKER, deliberately, rather than a formatter. Prettier or dprint would reflow this codebase: the
// long single-line paragraphs in comments are intentional (that is also how they render correctly on
// GitHub, where a single newline inside a paragraph becomes a visible break), and the aligned literals
// are hand-maintained. No formatter config preserves either, so running one would produce an enormous
// diff that improves nothing and loses information. What CAN be checked mechanically is the small set of
// things with exactly one right answer, which is what .editorconfig already declares.
//
// `--fix` is limited to the two where the correct output is not a judgement call: a missing final
// newline, and trailing whitespace outside markdown. Indentation is NOT auto-fixed — reindenting a line
// requires knowing what it meant.
//
// No dependency (the repo's other guards are the same shape: scripts/coverage-lines.mjs, the drift
// guard). Zero devDeps for a whitespace check is the right trade.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const STAGED = args.includes("--staged");
const FIX = args.includes("--fix");

/** Files this check applies to, and the indent width each expects. Anything else is skipped. */
const RULES = [
    // Ordered — first match wins. These two predate the rest at 2-space, and .editorconfig records the
    // same exception; reindenting them was explicitly not wanted.
    { re: /^tools\/preview-.*\.mjs$/, indent: 2, trimTrailing: true },
    { re: /\.(ts|tsx|mjs|cjs|js|py)$/, indent: 4, trimTrailing: true },
    { re: /\.(json|jsonc|ya?ml)$/, indent: 2, trimTrailing: true },
    // Markdown: trailing whitespace is SIGNIFICANT (two spaces is a hard break), so it is not checked.
    { re: /\.md$/, indent: null, trimTrailing: false },
];

/** Generated or vendored — not ours to format, and .editorconfig opts them out too. */
const SKIP = [/^package-lock\.json$/, /\.gen\.ts$/, /^node_modules\//, /^dist\//, /^pyodide-wheels\//,
    /^tests\/e2e\/artifacts\//, /^coverage\//];

const git = (a) => execFileSync("git", a, { encoding: "utf8" }).split("\n").filter(Boolean);
const files = (STAGED ? git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]) : git(["ls-files"]))
    .filter((f) => !SKIP.some((s) => s.test(f)))
    .filter((f) => RULES.some((r) => r.re.test(f)));

const problems = [];
let fixed = 0;

for (const f of files) {
    const rule = RULES.find((r) => r.re.test(f));
    let text;
    try { text = readFileSync(f, "utf8"); } catch { continue; }   // staged-but-deleted, a symlink, …
    let out = text;

    if (text.includes("\r\n")) problems.push(`${f}: CRLF line endings`);
    if (text.length && !text.endsWith("\n")) {
        problems.push(`${f}: no final newline`);
        if (FIX) out += "\n";
    }

    const lines = text.split("\n");
    if (rule.trimTrailing) {
        const bad = lines.map((l, i) => (/[ \t]+$/.test(l) ? i + 1 : 0)).filter(Boolean);
        if (bad.length) {
            problems.push(`${f}: trailing whitespace on line${bad.length > 1 ? "s" : ""} ${bad.slice(0, 5).join(", ")}${bad.length > 5 ? ` (+${bad.length - 5})` : ""}`);
            if (FIX) out = out.split("\n").map((l) => l.replace(/[ \t]+$/, "")).join("\n");
        }
    }
    if (rule.indent) {
        // Tabs, and indents that are not a multiple of the width. Reported, never fixed: changing a
        // line's indentation needs to know what block it belongs to.
        const tabs = lines.map((l, i) => (/^\t/.test(l) ? i + 1 : 0)).filter(Boolean);
        if (tabs.length) problems.push(`${f}: tab indentation on line${tabs.length > 1 ? "s" : ""} ${tabs.slice(0, 5).join(", ")}`);
        const odd = lines.map((l, i) => {
            // A block-comment continuation is ONE space then an asterisk by convention, so it is never on
            // the grid and never should be. Skipping it is not a concession: without this the check
            // reported 571 "problems" in contract.ts, every one of them a correctly formatted JSDoc line —
            // a checker that cries wolf at the house style trains you to ignore it.
            if (/^\s*\*/.test(l)) return 0;
            const m = l.match(/^( +)\S/);
            // A continuation line inside a multi-line expression legitimately sits at any column, so only
            // flag indents that are not a multiple of the width AND look like block structure.
            return m && m[1].length % rule.indent !== 0 ? i + 1 : 0;
        }).filter(Boolean);
        if (odd.length > lines.length * 0.2 && odd.length > 10) {
            problems.push(`${f}: ${odd.length} lines indented off the ${rule.indent}-space grid (e.g. ${odd.slice(0, 3).join(", ")})`);
        }
    }

    if (FIX && out !== text) { writeFileSync(f, out); fixed++; }
}

if (FIX) console.log(`check-format: fixed ${fixed} file(s); re-run without --fix to see what remains.`);
const remaining = FIX ? [] : problems;
if (remaining.length) {
    console.error(`check-format: ${remaining.length} problem(s) across ${files.length} file(s)\n`);
    for (const p of remaining.slice(0, 40)) console.error(`  ✖ ${p}`);
    if (remaining.length > 40) console.error(`  … and ${remaining.length - 40} more`);
    console.error(`\nMost are fixable with: node scripts/check-format.mjs${STAGED ? " --staged" : ""} --fix`);
    process.exit(1);
}
if (!FIX) console.log(`check-format: ${files.length} file(s) clean.`);

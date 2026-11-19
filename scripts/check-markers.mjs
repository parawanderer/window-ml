// check-markers.mjs — refuse a merge-conflict marker left in a tracked file.
//
//   node scripts/check-markers.mjs            # every tracked file (what CI runs)
//   node scripts/check-markers.mjs --staged   # only what is staged (what the pre-commit hook runs)
//
// A conflict resolved by hand can leave one marker line behind and still build: #1952 left a bare `=======` in
// sidebar.css, which CSS read as part of the next rule's selector, so `pre.code.morphing` silently lost its
// `position: relative` (#1994). No other check read .css, so nothing said so. This reads every tracked text file,
// whatever its type.
//
// A marker is a line that is exactly seven `<`, `=` or `>`, alone or followed by a space (git writes `<<<<<<< HEAD`,
// `=======`, `>>>>>>> branch`). In Markdown and reStructuredText a line of `=` underlines a heading, so there only the
// `<` and `>` markers count; diff and patch files, which may quote a conflict on purpose, are exempt whole.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** A merge-conflict marker line: seven `<`, `=` or `>`, then the end of the line or a space. */
export const MARKER = /^(<{7}|={7}|>{7})( |$)/;

/** Files where any marker-shaped line may be content: a diff or patch quoting a conflict. */
const EXEMPT = [/\.(diff|patch)$/i];

/** Doc files where a line of seven `=` underlines a heading: only the `<` and `>` markers count there. */
const HEADINGS = /\.(md|markdown|rst)$/i;

/** Whether a path is exempt from the check as a whole. */
export function exempt(path) {
    return EXEMPT.some((re) => re.test(path));
}

/**
 * The marker lines in one file's text, 1-based, or none for an exempt path. In a doc file the `=======` line is
 * skipped as a heading underline; its `<<<<<<<` and `>>>>>>>` lines still count.
 * @param {string} path the file's path, for the exemptions
 * @param {string} text its contents
 * @returns {{ line: number, text: string }[]}
 */
export function markerLines(path, text) {
    if (exempt(path)) return [];
    const docs = HEADINGS.test(path);
    const out = [];
    text.split(/\r?\n/).forEach((l, i) => { if (MARKER.test(l) && !(docs && l.startsWith("="))) out.push({ line: i + 1, text: l }); });
    return out;
}

/** Whether a buffer looks like text: no NUL in its first 8 KB, as git's own test for binary. */
const isText = (buf) => !buf.subarray(0, 8192).includes(0);

function main() {
    const staged = process.argv.includes("--staged");
    const git = (a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter(Boolean);
    const files = (staged ? git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]) : git(["ls-files"])).filter((f) => !exempt(f));
    const found = [];
    for (const f of files) {
        let buf;
        // The staged copy is what is being committed, which is not always what is on disk.
        try { buf = staged ? execFileSync("git", ["show", `:${f}`], { maxBuffer: 64 * 1024 * 1024 }) : readFileSync(f); } catch { continue; }   // a symlink to a folder, a deleted file
        if (!isText(buf)) continue;
        for (const m of markerLines(f, buf.toString("utf8"))) found.push(`${f}:${m.line}: ${m.text}`);
    }
    if (found.length) {
        console.error(`check-markers: ${found.length} merge-conflict marker line(s):\n`);
        for (const x of found.slice(0, 40)) console.error(`  ✖ ${x}`);
        console.error("\nA conflict was left half-resolved: keep the side you meant and delete the marker lines.");
        process.exit(1);
    }
    console.log(`check-markers: ${files.length} file(s), no conflict markers.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

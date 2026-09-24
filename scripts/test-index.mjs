#!/usr/bin/env node
// THE TEST INDEX — one TAB-separated line per test in this repo, searchable by what it is ABOUT.
//
//   node scripts/test-index.mjs                       # every test
//   node scripts/test-index.mjs 'approval|consent'    # a REGEX over name + section + file summary
//   node scripts/test-index.mjs approve --word        # …anchored, so it does not also match "approved"
//   node scripts/test-index.mjs '' --file sidebar     # one file's tests
//   node scripts/test-index.mjs --sections            # the sections, with how many tests each holds
//   node scripts/test-index.mjs --stats               # how many tests, by file
//
// The checks (each exits 1 on a finding). Only the RATCHET runs in the pre-commit hook and CI's `tools` job; the
// other two are surveys, and ship red — 1,826 tests predate this and a check that fails on arrival is one people
// learn to scroll past:
//   node scripts/test-index.mjs --new [ref] [--staged]   # THE RATCHET: a test this change ADDS, under no section
//   node scripts/test-index.mjs --headerless             # a test file with no header comment (survey)
//   node scripts/test-index.mjs --unsectioned            # every test under no section, repo-wide (survey)
//
// WHY IT EXISTS. `scripts/index.mjs` made the SOURCE searchable and left the tests opaque, and the tests are where
// the knowledge about behaviour actually lives. `tests/sidebar.test.js` holds 407 of them in 9,300 lines behind ten
// section comments: grep finds a test whose name you can already guess, and answers neither of the questions you
// actually have — "is this covered already?" and "where does a new one go?". Reading the file to find out costs
// about 150,000 tokens, which is not a thing anyone or anything can spend per question.
//
// So the structure is made explicit and kept that way. A test belongs to a SECTION, a section is a comment line
// (`// --- what this group is about ---`), and the ratchet asks for one whenever a change adds a test to a file
// that has them. That is deliberately weaker than "every test, everywhere": 407 unsectioned tests already exist,
// and a check that ships red is one people learn to scroll past.
//
// WHAT IT CANNOT CHECK, said plainly: that a test is under the RIGHT section. A section runs until the next one, so
// a test appended to the end of a file inherits the last one whatever it is about, and the ratchet sees a section
// and is satisfied. The guarantee is "every test is under a NAMED group", which is checkable; "under the group it
// belongs to" is a judgement, and the place it shows up is this tool's own output — the section prints beside the
// name, so a test filed under the wrong one reads wrong the moment anyone searches for it.
//
// SCANNED, NOT GREPPED. A regex over `test("` misses a name in backticks, a `test.skip`, and a call spread over
// two lines, and it finds the word inside a string or a comment. `scripts/js-scan.mjs` blanks the comments and
// lifts every string out, so the pattern runs over something a regex cannot misread. It is a scanner rather than
// TypeScript's parser because CI's `tools` job runs with NO node_modules — "plain node reading files" is what
// keeps it a ten-second job, and a tool that cannot run there is a check that does not run.
//
// OUTPUT IS TAB-SEPARATED, one record per line, so it chains: `grep`, `cut -f3`, `awk -F'\t'`. Nothing is
// column-padded. Fields: PATH:LINE, SECTION, NAME.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { scan, MARKED, lineAt } from "./js-scan.mjs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** A comment line that opens a section: `// --- name ---`, `// ==== name ====`, any run of two or more. */
const SECTION = /^\s*\/\/\s*[-=]{2,}\s*(.*?)\s*[-=]*\s*$/;

/** The names that declare a test. `describe` is included: a file may group with it instead of a comment. */
const DECLARES = new Set(["test", "it", "describe", "suite"]);

/** Every test file: the fast suite's `tests/*.test.*` and the Playwright specs under `tests/e2e/`. */
function testFiles() {
    const out = [];
    const walk = (dir) => {
        for (const name of readdirSync(dir)) {
            const p = join(dir, name);
            if (statSync(p).isDirectory()) { if (name !== "node_modules" && name !== "fixtures" && name !== "artifacts") walk(p); }
            else if (/\.(test|spec)\.(m?js|ts)$/.test(name)) out.push(p);
        }
    };
    walk(join(ROOT, "tests"));
    return out.sort();
}

/** The first sentence of a file's opening comment, which is what says what the file is FOR. */
function summaryOf(lines) {
    if (!lines[0]?.trimStart().startsWith("//")) return "";
    const prose = [];
    for (const line of lines) {
        const m = line.match(/^\s*\/\/\s?(.*)$/);
        if (!m) break;
        if (!m[1].trim() && prose.length) break;
        prose.push(m[1].trim());
    }
    const text = prose.join(" ").replace(/^[A-Za-z0-9_.-]+\.(m?js|ts) — /, "");
    return (text.split(/(?<=[.:])\s/)[0] ?? "").trim();
}

/** Every test in one file: its line, its section, and its name. */
export function testsIn(file) {
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    // Sections come from the raw lines, not the AST: they are comments, and a comment is not a node.
    const marks = [];
    lines.forEach((line, i) => {
        const m = line.match(SECTION);
        if (m && m[1]) marks.push({ line: i + 1, name: m[1] });
    });
    const sectionAt = (line) => {
        let found = "";
        for (const m of marks) { if (m.line <= line) found = m.name; else break; }
        return found;
    };

    // `test(`, `it.skip(`, `describe (` — the declaring name, any `.member` chain after it, then the lifted name.
    const { code, strings } = scan(text);
    // NOT preceded by a dot: `rx.test("foo")` is a regular expression being used, not a test being declared, and
    // there are fourteen of those in this repo. `test.skip(…)` still matches, because the dot comes after.
    const rx = new RegExp(`(?<![.\\w$])(${[...DECLARES].join("|")})\\b(?:\\s*\\.\\s*\\w+)*\\s*\\(\\s*${MARKED}`, "g");
    const out = [];
    for (const m of code.matchAll(rx)) {
        const name = strings[Number(m[2])]?.value;
        if (name == null) continue;   // a name built at runtime: skipped, never guessed at
        const line = lineAt(code, m.index);
        out.push({ file: relative(ROOT, file), line, section: sectionAt(line), name });
    }
    return { summary: summaryOf(lines), tests: out, sectioned: marks.length > 0 };
}

/** The whole index, one entry per test. */
function build() {
    const files = [];
    for (const f of testFiles()) files.push({ path: relative(ROOT, f), ...testsIn(f) });
    return files;
}

// The CLI runs only when this file IS the command. `testsIn` is imported by its own test, and a module that indexes
// the whole repo and prints 3,400 lines the moment it is required is not importable.
if (process.argv[1] && process.argv[1].endsWith("test-index.mjs")) main();

function main() {
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => { const i = args.indexOf(`--${name}`); return i < 0 ? null : args[i + 1]; };
const pattern = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--file") ?? "";

const files = build();
const all = files.flatMap((f) => f.tests.map((t) => ({ ...t, summary: f.summary })));

if (flag("stats")) {
    for (const f of files.filter((x) => x.tests.length).sort((a, b) => b.tests.length - a.tests.length)) {
        const marks = new Set(f.tests.map((t) => t.section).filter(Boolean)).size;
        console.log(`${f.tests.length}\t${marks} section${marks === 1 ? "" : "s"}\t${f.path}`);
    }
    console.log(`${all.length}\ttotal`);
} else if (flag("sections")) {
    const by = new Map();
    for (const t of all) {
        const key = `${t.file}\t${t.section || "(none)"}`;
        by.set(key, (by.get(key) ?? 0) + 1);
    }
    for (const [key, n] of by) console.log(`${n}\t${key}`);
} else if (flag("headerless")) {
    const bad = files.filter((f) => f.tests.length && !f.summary);
    for (const f of bad) console.log(`${f.path}\tno header comment saying what this file covers`);
    if (bad.length) { console.error(`\ntest-index: ${bad.length} test file(s) with no header.`); process.exit(1); }
    console.log("test-index: every test file has a header.");
} else if (flag("unsectioned")) {
    const bad = all.filter((t) => !t.section);
    for (const t of bad) console.log(`${t.file}:${t.line}\t${t.name}`);
    console.error(`\ntest-index: ${bad.length} test(s) under no section, in ${new Set(bad.map((t) => t.file)).size} file(s).`);
    if (bad.length) process.exit(1);
} else if (flag("new")) {
    // THE RATCHET. Only what this change ADDS, and only in a file that already groups its tests — a file with no
    // sections at all is a file nobody has sorted out yet, and demanding one here would block an unrelated fix.
    const base = value("new") && !value("new").startsWith("--") ? value("new") : "main";
    const range = flag("staged") ? ["diff", "--cached", "-U0"] : ["diff", "-U0", `${base}...HEAD`];
    let diff = "";
    try { diff = execFileSync("git", [...range, "--", "tests"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64e6 }); }
    catch { diff = ""; }
    const added = new Map();   // file -> set of added line numbers
    let file = null, line = 0;
    for (const l of diff.split("\n")) {
        if (l.startsWith("+++ b/")) { file = l.slice(6); added.set(file, new Set()); continue; }
        const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
        if (h) { line = Number(h[1]); continue; }
        if (l.startsWith("+") && file) { added.get(file).add(line); line++; }
    }
    const bad = all.filter((t) => added.get(t.file)?.has(t.line) && !t.section
        && files.find((f) => f.path === t.file)?.sectioned);
    for (const t of bad) console.log(`${t.file}:${t.line}\t${t.name}\tunder no section`);
    if (bad.length) {
        console.error(`\ntest-index: ${bad.length} new test(s) under no section. Put each under a \`// --- what this group is about ---\``);
        console.error("            line, so the next person can find it without reading the file. See AGENTS.md.");
        process.exit(1);
    }
    console.log(`test-index: every test added since ${flag("staged") ? "the index" : base} is under a section.`);
} else {
    const file = value("file");
    const rx = pattern ? new RegExp(flag("word") ? `\\b(?:${pattern})\\b` : pattern, "i") : null;
    for (const t of all) {
        if (file && !t.file.includes(file)) continue;
        if (rx && !rx.test(t.name) && !rx.test(t.section) && !rx.test(t.summary)) continue;
        console.log(`${t.file}:${t.line}\t${t.section}\t${t.name}`);
    }
}
}

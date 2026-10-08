#!/usr/bin/env node
// check-state.mjs — asks every module-level store a change ADDS where its state belongs: declared to the state
// registry (`defineState`, src/state-registry.ts), or marked as not a run's state.
//
//   node scripts/check-state.mjs                  # every undeclared store, repo-wide (a report, exits 0)
//   node scripts/check-state.mjs --new [ref]      # only what this branch ADDS (the ratchet the hook + CI run)
//   node scripts/check-state.mjs --new [ref] --staged
//
// WHY. A survey of the code (docs/dev/state.md) found state nobody had placed: grants that two runs on one tab clobber,
// pointers that dangle after a worker eviction, five copies of the event stream with five caps. Each store was a
// reasonable line when it was added; the question "which scope is this, and what loses it?" was never asked at the one
// moment it is cheap to answer. This asks it then.
//
// WHAT COUNTS AS A STORE: a declaration at column 0 (module scope, by this repo's indentation) that is a `let`, or a
// `const` holding a `new Map|Set|WeakMap|WeakSet(…)`, a `signal(…)`, or an empty `[]`/`{}`. Comments and strings are
// stripped first (js-scan.mjs), so commented-out code and a template literal's text are never read as declarations.
// A SCREAMING_CASE `const` is left out: by this repo's convention it is a lookup table, filled once.
//
// HOW IT IS ANSWERED, either:
//   - the store's name appears inside a `defineState({ … })` call in the same file, usually in its `read`; or
//   - a `state: <kind>` marker (in a `//` or JSDoc comment) on the declaration's line or in the comment block directly
//     above it, where kind is
//       ui        what is open, hovered or scrolled
//       cache     derived and refetchable: losing it costs time, never correctness
//       plumbing  in-flight bookkeeping (pending requests, timers, handles) that ends with its operation
//       fixed     written once at load: a lookup table, a registry of handlers
//       test      a test hook
//     or a declared id (`// state: run.pointers`) when another file's `defineState` reads it.
//
// WHERE: the worker, page and offscreen code, which is everything under src/ except the UI realms (sidebar/, chat/,
// native/) whose state is presentation or a mirror of the worker's (counted in state.md, not listed).
//
// A RATCHET: the 400-odd stores that predate it are listed by a plain run and never fail it. A store whose NAME was
// already declared at module scope somewhere under src/ at the base is a move, not an addition, and is not asked about.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { scan } from "./js-scan.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
/** The UI realms, and generated or declaration-only files: not where a run's state lives. */
const SKIP = /^src\/(sidebar|chat|native)\/|\.gen\.ts$|\.d\.ts$/;
/** The kinds a `// state:` marker may name instead of a declared id. */
export const KINDS = new Set(["ui", "cache", "plumbing", "fixed", "test"]);
/** A module-level store, matched on comment- and string-stripped code. Group 1 is `let`, 2 the name. */
const STORE = /^(?:export\s+)?(?:(let)\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:new\s+(?:Map|Set|WeakMap|WeakSet)\b|signal\s*[<(]|\[\s*\]|\{\s*\}\s*;?\s*$))/;
/** A SCREAMING_CASE const is a lookup table by this repo's convention: written once, never a run's state. */
const CONSTANT = /^[A-Z][A-Z0-9_]*$/;
const MARK = /(?:\/\/|\*)\s*state:\s*([a-z][\w.-]*)/;

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined; };

function sources() {
    const out = [];
    const walk = (dir) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { walk(full); continue; }
            const rel = path.relative(ROOT, full).split(path.sep).join("/");
            if (/\.tsx?$/.test(e.name) && !SKIP.test(rel)) out.push(rel);
        }
    };
    walk(path.join(ROOT, "src"));
    return out.sort();
}

/**
 * The module-level stores in one file's text.
 * @param {string} text the source
 * @returns {{ name: string, line: number }[]}
 */
export function storesIn(text) {
    // Cheap first: most files have no candidate line at all, and the scan is the slow part.
    if (!text.split("\n").some((l) => STORE.test(l))) return [];
    const { code } = scan(text);
    const out = [];
    code.split("\n").forEach((l, i) => {
        const m = STORE.exec(l);
        const name = m?.[2] ?? m?.[3];
        if (name && !(m[3] && CONSTANT.test(name))) out.push({ name, line: i + 1 });
    });
    return out;
}

/**
 * The text of every `defineState(…)` call's arguments, the ids they declare, and each id's realm (parallel to `ids`).
 * @param {string} text the source
 * @returns {{ bodies: string[], ids: string[], realms: (string|null)[] }}
 */
export function declarationsIn(text) {
    if (!text.includes("defineState")) return { bodies: [], ids: [], realms: [] };
    const { code, strings } = scan(text);
    const bodies = [], ids = [], realms = [];
    for (const m of code.matchAll(/\bdefineState\s*\(/g)) {
        let depth = 1, i = m.index + m[0].length;
        while (i < code.length && depth) { const c = code[i++]; if (c === "(") depth++; else if (c === ")") depth--; }
        const body = code.slice(m.index + m[0].length, i - 1);
        bodies.push(body);
        const id = /\bid\s*:\s*\0(\d+)\0/.exec(body);
        if (id && strings[+id[1]]?.value) {
            ids.push(strings[+id[1]].value);
            const realm = /\brealm\s*:\s*\0(\d+)\0/.exec(body);
            realms.push(realm ? strings[+realm[1]]?.value ?? null : null);
        }
    }
    return { bodies, ids, realms };
}

/**
 * The marker answering a store, from the declaration's own line or the comment block directly above it.
 * @param {string[]} lines the raw source lines
 * @param {number} line the declaration's 1-based line
 * @returns {string|null}
 */
export function markerFor(lines, line) {
    const own = MARK.exec(lines[line - 1] ?? "");
    if (own) return own[1];
    for (let i = line - 2; i >= 0; i--) {
        const t = lines[i].trim();
        if (!(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"))) break;
        const m = MARK.exec(t);
        if (m) return m[1];
    }
    return null;
}

/**
 * Every store in the given files that nothing answers.
 * @param {{ rel: string, text: string }[]} files
 * @returns {{ rel: string, line: number, name: string, why: string }[]}
 */
export function undeclared(files) {
    const ids = new Set(files.flatMap((f) => declarationsIn(f.text).ids));
    const out = [];
    for (const { rel, text } of files) {
        const stores = storesIn(text);
        if (!stores.length) continue;
        const lines = text.split("\n");
        const bodies = declarationsIn(text).bodies.join("\n");
        for (const s of stores) {
            if (new RegExp(`(^|[^\\w$])${s.name.replace(/\$/g, "\\$")}([^\\w$]|$)`).test(bodies)) continue;
            const mark = markerFor(lines, s.line);
            if (mark && (KINDS.has(mark) || ids.has(mark))) continue;
            const why = !mark ? "neither declared nor marked"
                : mark.includes(".") ? `marked ${mark}, which no defineState declares` : `unknown kind "${mark}"`;
            out.push({ rel, line: s.line, name: s.name, why });
        }
    }
    return out;
}

const git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });

if (import.meta.url === `file://${process.argv[1]}`) {
    const staged = flag("staged");
    const read = (rel) => staged ? git(["show", `:${rel}`]) : readFileSync(path.join(ROOT, rel), "utf8");
    const files = sources().map((rel) => { try { return { rel, text: read(rel) }; } catch { return null; } }).filter(Boolean);
    const all = undeclared(files);

    if (!flag("new")) {
        for (const h of all) console.log(`${h.rel}:${h.line}\t${h.name}\t${h.why}`);
        console.log(`\n${all.length} module-level store(s) with no answer across ${files.length} files. `
            + "Only what a change ADDS is asked about (--new).");
        process.exit(0);
    }

    const base = opt("new") || "origin/main";
    let diff;
    try { diff = git(staged ? ["diff", "--cached", "--unified=0", base, "--", "src"] : ["diff", "--unified=0", `${base}...HEAD`, "--", "src"]); }
    catch { console.log(`check-state: cannot diff against ${base}, skipping.`); process.exit(0); }
    // Line numbers the change ADDS, per file, from the hunk headers.
    const added = new Map();
    let file = "", at = 0;
    for (const l of diff.split("\n")) {
        const f = /^\+\+\+ b\/(.+)$/.exec(l);
        if (f) { file = f[1]; added.set(file, new Set()); continue; }
        const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
        if (h) { at = +h[1]; continue; }
        if (l.startsWith("+") && !l.startsWith("+++")) added.get(file)?.add(at++);
    }
    // Names already at module scope somewhere at the base: a moved store is not a new one.
    const before = new Set();
    try {
        const ls = git(["ls-tree", "-r", "--name-only", base, "--", "src"]).split("\n").filter((r) => /\.tsx?$/.test(r) && !SKIP.test(r));
        const changed = new Set(added.keys());
        // Unchanged files are the same at the base, so only the changed ones need reading there.
        for (const r of ls) {
            const text = changed.has(r) ? git(["show", `${base}:${r}`]) : files.find((f) => f.rel === r)?.text;
            if (text) for (const s of storesIn(text)) before.add(s.name);
        }
    } catch { /* no base tree: every added store is new */ }
    const hits = all.filter((h) => added.get(h.rel)?.has(h.line) && !before.has(h.name));
    if (hits.length) {
        for (const h of hits) console.log(`${h.rel}:${h.line}\t${h.name}\t${h.why}`);
        console.error(`\n${hits.length} new module-level store(s) with no answer to "where does this state belong?".`
            + " Declare it with defineState (src/state-registry.ts) if it is a run's state, or mark it"
            + ` \`// state: ${[...KINDS].join("|")}\`. docs/dev/state.md says which scope fits.`);
        process.exit(1);
    }
    console.log("check-state: every store this change adds says where its state belongs.");
}

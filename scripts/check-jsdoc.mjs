#!/usr/bin/env node
// IS THE JSDOC STILL TRUE? — the one thing TypeScript will not tell you about a `.ts` file.
//
//   node scripts/check-jsdoc.mjs                 # every finding, repo-wide
//   node scripts/check-jsdoc.mjs --new [ref]     # only what this branch ADDS (the ratchet the hook + CI run)
//   node scripts/check-jsdoc.mjs --new [ref] --staged
//
// WHY IT EXISTS. In a `.ts` file, JSDoc types and `@param` names are PROSE: the compiler ignores them entirely
// (they are only authoritative under `checkJs`, in `.js`). So a comment can document an argument the function
// does not take, or a type it contradicts, and every check in this repo stays green. That matters more here
// than in most repos, because contract.ts's JSDoc is lifted verbatim into what the MODEL reads
// (`gen-api-docs.mjs`) — drift there does not just mislead a reader, it ships a wrong API reference.
//
// It found this on main the day it was written: `__loads`'s doc block sat ABOVE `__housekeeping`'s, so two
// blocks were stacked with no declaration between them. `__loads` had no documentation at all, and the block
// a reader would attribute to `__housekeeping` advertised an `opts.clear` it does not accept.
//
// WHAT IT CHECKS, and deliberately not more:
//
//   - ORPHANED  a doc block immediately followed by another doc block. Nothing can be documenting nothing.
//   - UNKNOWN   `@param foo` where `foo` appears nowhere in the declaration below it.
//   - TYPE      `@param {string} x` where `x: number` — only when BOTH are concrete primitives that disagree.
//
// MISSING `@param`s are FINE and never reported. AGENTS.md asks for `@param`/`@returns` "where useful", so a
// doc that covers two of three arguments is a choice, not a defect. What is never a choice is a doc that is
// WRONG: a subset misleads nobody, a contradiction misleads everybody.
//
// The type check is narrow on purpose. `{Object}` for a `Record<…>` and `{Function}` for a function type are
// JSDoc's own vaguer spellings, not drift, and flagging them is how a check gets suppressed. Only
// string/number/boolean disagreeing with a different concrete primitive is reported.
//
// So is the @param check. A block above `range: mlRange,` documents a function declared in ANOTHER file, at the
// point it joins the API rather than where it is written — this repo does that for about forty members of the
// `window.ml` literal. Nothing in this file can contradict those parameters, so the block is skipped. Reporting
// it was worse than useless: the scan for the declaration ran past the one-line property into the members that
// FOLLOW, so `@param step` was reported and `@param a` was not, on nothing more than which of those words
// happened to appear in the next thirty lines. A finding that cannot be fixed at the line it names teaches
// people to pass the check rather than read it.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src");
const SKIP = /\.gen\.ts$|\.d\.ts$/;
/** Concrete primitives. A JSDoc type outside this set is never compared — see the header. */
const PRIMS = new Set(["string", "number", "boolean"]);
/** `name: otherFunction,` on an object literal — documented here, declared elsewhere. See `declarationBelow`. */
const ALIAS = /^\s*[A-Za-z_$][\w$]*\s*:\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*,\s*$/;

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined; };

function sources() {
    const out = [];
    const walk = (dir) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { walk(full); continue; }
            if (/\.tsx?$/.test(e.name) && !SKIP.test(e.name)) out.push(path.relative(ROOT, full));
        }
    };
    walk(SRC);
    return out.sort();
}

/**
 * The declaration a doc block documents: the lines from it to the one closing its parameter list.
 *
 * Blank and `//` lines between the block and the declaration are skipped — a trailing aside above a function
 * is common here and is not a reason to give up on the check.
 *
 * `alias` says the thing below is `name: someFunction,` — a property whose value is declared in another
 * file. There is no parameter list here to compare against; see `check`.
 */
function declarationBelow(lines, i) {
    while (i < lines.length && (!lines[i].trim() || lines[i].trimStart().startsWith("//"))) i++;
    if (i >= lines.length) return { text: "", orphaned: false, alias: false };
    // A doc block directly under a doc block documents NOTHING. That is a finding, not a parse failure.
    if (lines[i].trimStart().startsWith("/**")) return { text: "", orphaned: true, alias: false };
    if (ALIAS.test(lines[i])) return { text: lines[i], orphaned: false, alias: true };
    const out = [];
    let depth = 0, opened = false;
    for (let j = i; j < lines.length && j < i + 30; j++) {
        out.push(lines[j]);
        for (const ch of lines[j]) {
            if (ch === "(") { depth++; opened = true; }
            else if (ch === ")") depth--;
        }
        if (opened && depth <= 0) break;
    }
    return { text: out.join("\n"), orphaned: false, alias: false };
}

/** Each `/** … *\/` block in a file, with the line it starts on and the declaration under it. */
function blocks(rel) {
    const lines = readFileSync(path.join(ROOT, rel), "utf8").split("\n");
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes("/**")) continue;
        const start = i;
        while (i < lines.length && !lines[i].includes("*/")) i++;
        out.push({ line: start + 1, doc: lines.slice(start, i + 1).join("\n"), ...declarationBelow(lines, i + 1) });
    }
    return out;
}

/** The findings in one file. */
function check(rel) {
    const found = [];
    for (const b of blocks(rel)) {
        const params = [...b.doc.matchAll(/@param\s+(?:\{([^}]*)\}\s*)?\[?([A-Za-z_$][\w$.]*)/g)]
            .map((m) => ({ type: (m[1] || "").trim(), name: m[2] }));
        if (!params.length) continue;
        if (b.orphaned) {
            found.push({ rel, line: b.line, kind: "ORPHANED", detail: "documents nothing — the next thing is another doc block" });
            continue;
        }
        if (!b.text) continue;
        // `range: mlRange,` — a property whose value is a function declared in ANOTHER file, documented where
        // it joins the API rather than where it is written. Its parameters are real; they are just not in this
        // file, so nothing here can contradict them. Without this the 30-line window runs past the property and
        // collects the members that FOLLOW, and whether `@param step` is reported comes down to whether that
        // word happens to appear in them — which it did for `ml.range`, giving two findings that are unfixable
        // at the line they name. An arbitrary finding is worse than no finding: it teaches people to pass the
        // check rather than read it.
        if (b.alias) continue;
        // A destructured parameter has no name of its own, so `@param options` cannot be matched against the
        // declaration. Its PROPERTIES can be, and `@param options.think` is the form that actually rots.
        const destructured = /\(\s*\{|,\s*\{/.test(b.text);
        for (const p of params) {
            const parts = p.name.split(".");
            const probe = parts.length > 1 ? parts[parts.length - 1] : parts[0];
            const present = new RegExp(`\\b${probe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(b.text);
            if (!present) {
                if (parts.length === 1 && destructured) continue;   // the unnamed options object itself
                found.push({ rel, line: b.line, kind: "UNKNOWN", detail: `@param ${p.name} — no such parameter` });
                continue;
            }
            if (!PRIMS.has(p.type.toLowerCase())) continue;
            const m = new RegExp(`\\b${probe}\\s*\\??\\s*:\\s*([^,)=;]+)`).exec(b.text);
            if (!m) continue;
            const declared = m[1].toLowerCase();
            const others = [...PRIMS].filter((x) => x !== p.type.toLowerCase());
            if (!declared.includes(p.type.toLowerCase()) && others.some((x) => new RegExp(`\\b${x}\\b`).test(declared)))
                found.push({ rel, line: b.line, kind: "TYPE", detail: `@param {${p.type}} ${p.name} — declared ${m[1].trim()}` });
        }
    }
    return found;
}

const all = sources().flatMap(check);

if (flag("new")) {
    const { execFileSync } = await import("node:child_process");
    const base = opt("new") || "origin/main";
    const range = flag("staged") ? ["diff", "--cached", "--unified=0", base] : ["diff", "--unified=0", `${base}...HEAD`];
    let diff;
    try { diff = execFileSync("git", [...range, "--", "src"], { cwd: ROOT, encoding: "utf8" }); }
    catch { console.log(`check-jsdoc: cannot diff against ${base} — skipping.`); process.exit(0); }
    // Same staleness warning as the code index: `base...HEAD` cannot see staged work, and a falsely clean
    // answer is the worst thing a check can produce.
    if (!flag("staged")) {
        let pending = "";
        try { pending = execFileSync("git", ["status", "--porcelain", "--", "src"], { cwd: ROOT, encoding: "utf8" }); } catch { /* not a work tree */ }
        const n = pending.split("\n").filter(Boolean).length;
        if (n) console.error(`check-jsdoc: ${n} uncommitted file(s) under src/ are NOT in this range. Pass --staged.`);
    }
    // Which FILES this change touches, and which @param lines it ADDS. A finding counts when the change either
    // introduced the line or edited the file the finding is in — a ratchet, so the backlog is nobody's problem.
    const touched = new Set();
    const addedDocs = new Set();
    let file = "";
    for (const line of diff.split("\n")) {
        const f = /^\+\+\+ b\/(.+)$/.exec(line);
        if (f) { file = f[1]; touched.add(file); continue; }
        if (line.startsWith("+") && !line.startsWith("+++") && /@param|\/\*\*/.test(line)) addedDocs.add(file);
    }
    const hits = all.filter((h) => touched.has(h.rel) && addedDocs.has(h.rel));
    if (hits.length) {
        for (const h of hits) console.log(`${h.rel}:${h.line}\t${h.kind}\t${h.detail}`);
        console.error(`\n${hits.length} JSDoc finding(s) in documentation this change touches. TypeScript does not`
            + ` check these in a .ts file, and contract.ts's JSDoc is lifted verbatim into what the MODEL reads —`
            + ` a wrong @param there ships a wrong API reference. A MISSING @param is fine; a wrong one is not.`);
        process.exit(1);
    }
    console.log(`check-jsdoc: the documentation this change touches matches its declarations.`);
    process.exit(0);
}

for (const h of all) console.log(`${h.rel}:${h.line}\t${h.kind}\t${h.detail}`);
console.log(`\n${all.length} finding(s) across ${sources().length} files.`);
process.exit(flag("strict") && all.length ? 1 : 0);

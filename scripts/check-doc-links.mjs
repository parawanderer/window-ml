#!/usr/bin/env node
// check-doc-links.mjs — every file a Markdown doc points at exists: links always, backticked paths on what a change adds.
//
//   node scripts/check-doc-links.mjs                       # links: fail on any broken; paths: list every dead one
//   node scripts/check-doc-links.mjs --new <base>          # links as above; paths: fail on lines added since <base>
//   node scripts/check-doc-links.mjs --new <base> --staged # the same over the staged tree (the pre-commit hook)
//
// TWO KINDS OF REFERENCE, TWO RULES. A Markdown LINK (`[text](../src/x.ts)`) is a claim a reader clicks, and there were
// only 79 of them with one broken when this was written, so a broken one anywhere fails. A BACKTICKED PATH
// (`` `src/x.ts` ``) is how these docs mostly name files: about 400 of them, and some are deliberately historical ("it
// replaced `scripts/components.mjs`") or name a file in the sibling window-ml-hub repo. So those are a RATCHET: a path
// on a line this change adds must exist, and the old ones are listed, never failed on. Same reason as the code index's
// `--new`: a check that ships red is one people learn to scroll past.
//
// Paths are resolved the way a reader would: a link relative to the doc's own directory (or the repo root for `/x`),
// a backticked path from the repo root, and also from `mobile/` for a doc under mobile/, whose `src/` is its own.
// Code is not prose: fenced blocks are skipped, and a link inside inline code (`[label](url)` as an example) is not
// a link. An EXAMPLE path is written with a placeholder (`src/<name>.ts`) and never checked. Exit 0 = clean, 1 = something broken, 2 = bad arguments.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = [/^node_modules\//, /^dist/, /^tests\/fixtures\//, /\/node_modules\//];
// The directories a backticked root path may start with. Anything else in backticks is a name, not a path.
const PATH = /^(?:src|scripts|tests|docs|tools|mobile|examples|\.claude|\.github|\.githooks)\/[\w./@-]+\.(?:ts|tsx|mjs|cjs|js|md|json|html|css|ya?ml|proto|sh|py)$/;

/** Prose only: fenced code blocks blanked (line numbers kept), so neither a link nor a path inside one counts.
 *  @param {string} text */
export function prose(text) {
    let fenced = false;
    return text.split("\n").map((line) => {
        if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return ""; }
        return fenced ? "" : line;
    });
}

/** Markdown link targets on one prose line, inline code removed first. Web, mail and same-page anchors are not files.
 *  @param {string} line @returns {string[]} */
export function linkTargets(line) {
    const bare = line.replace(/`[^`]*`/g, "");
    const out = [];
    for (const m of bare.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
        const t = m[1];
        if (/^(?:[a-z][a-z+.-]*:|#)/i.test(t)) continue;
        out.push(decodeURIComponent(t.replace(/#.*$/, "")));
    }
    return out;
}

/** Backticked repo paths on one prose line. A glob, a placeholder or a template is a pattern, not a path.
 *  @param {string} line @returns {string[]} */
export function codePaths(line) {
    const out = [];
    for (const m of line.matchAll(/`([^`\s]+)`/g)) {
        const p = m[1].replace(/:\d+(?:-\d+)?$/, "");          // `src/x.ts:42` names the file
        if (/[*<>{}$]/.test(p) || !PATH.test(p)) continue;
        out.push(p);
    }
    return out;
}

/**
 * Every broken reference in one doc.
 * @param {string} doc root-relative path of the .md file
 * @param {string} text its contents
 * @param {(rel: string) => boolean} exists does a root-relative file or directory exist
 * @returns {{ line: number, kind: "link" | "path", target: string }[]}
 */
export function brokenIn(doc, text, exists) {
    const dir = path.posix.dirname(doc);
    const out = [];
    prose(text).forEach((line, i) => {
        for (const t of linkTargets(line)) {
            if (!t) continue;
            const rel = t.startsWith("/") ? path.posix.normalize(t.slice(1)) : path.posix.normalize(path.posix.join(dir, t));
            if (rel.startsWith("..") || !exists(rel.replace(/\/$/, ""))) out.push({ line: i + 1, kind: "link", target: t });
        }
        for (const p of codePaths(line)) {
            const tries = [p, ...(doc.startsWith("mobile/") ? [`mobile/${p}`] : [])];
            if (!tries.some(exists)) out.push({ line: i + 1, kind: "path", target: p });
        }
    });
    return out;
}

const git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });

/** Line numbers each doc ADDS since `base` (in the staged tree, or the working tree), keyed by path.
 *  @param {string} base @param {boolean} staged */
function addedLines(base, staged) {
    const diff = git(["diff", "-U0", "--no-color", ...(staged ? ["--cached"] : []), base, "--", "*.md"]);
    const out = new Map();
    let file = null;
    for (const l of diff.split("\n")) {
        if (l.startsWith("+++ ")) { file = l.startsWith("+++ b/") ? l.slice(6) : null; if (file) out.set(file, new Set()); continue; }
        const m = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(l);
        if (m && file) for (let n = 0; n < Number(m[2] ?? 1); n++) out.get(file).add(Number(m[1]) + n);
    }
    return out;
}

function main() {
    const argv = process.argv.slice(2);
    let base = null, staged = false;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--new") base = argv[++i];
        else if (argv[i] === "--staged") staged = true;
        else { console.error(`check-doc-links: unknown argument ${argv[i]}`); process.exit(2); }
    }
    if (argv.includes("--new") && !base) { console.error("check-doc-links: --new needs a base ref"); process.exit(2); }

    // What exists is the tree being committed: the index when --staged, else the working tree.
    const files = git(staged ? ["ls-files", "--cached"] : ["ls-files", "--cached", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
    const known = new Set(files);
    for (const f of files) for (let d = path.posix.dirname(f); d !== "."; d = path.posix.dirname(d)) known.add(d);
    const exists = (rel) => known.has(rel) || (!staged && fs.existsSync(path.join(ROOT, rel)));
    const read = (rel) => staged ? git(["show", `:${rel}`]) : fs.readFileSync(path.join(ROOT, rel), "utf8");

    const added = base ? addedLines(base, staged) : null;
    const links = [], newPaths = [], oldPaths = [];
    for (const doc of files) {
        if (!doc.endsWith(".md") || SKIP.some((re) => re.test(doc))) continue;
        let text;
        try { text = read(doc); } catch { continue; }
        for (const b of brokenIn(doc, text, exists)) {
            const at = `${doc}:${b.line}\t${b.target}`;
            if (b.kind === "link") links.push(at);
            else if (added?.get(doc)?.has(b.line)) newPaths.push(at);
            else oldPaths.push(at);
        }
    }
    if (links.length) {
        console.log(`check-doc-links: ${links.length} Markdown link(s) to nothing:`);
        for (const l of links) console.log(`  ${l}`);
    }
    if (newPaths.length) {
        console.log(`check-doc-links: ${newPaths.length} backticked path(s) this change adds name nothing:`);
        for (const l of newPaths) console.log(`  ${l}`);
    }
    if (!base && oldPaths.length) {
        console.log(`check-doc-links: ${oldPaths.length} backticked path(s) name nothing (a report, not a failure; some are historical or name the hub repo):`);
        for (const l of oldPaths) console.log(`  ${l}`);
    }
    if (links.length || newPaths.length) {
        console.log("  Fix the path. A path that is deliberately gone (\"replaced `x`\"): name it without the directory.");
        console.log("  An EXAMPLE path: write it with a placeholder (`src/<name>.ts`), which is never checked.");
        process.exit(1);
    }
    if (!links.length && !(!base && oldPaths.length)) console.log("check-doc-links: every link resolves.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

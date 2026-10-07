#!/usr/bin/env node
// move-files.mjs — MOVE whole files to another directory and rewrite every path that names them, instead of `git mv`
// and chasing the import errors. See .claude/skills/move-files/SKILL.md.
//
//   node scripts/move-files.mjs --to src/sw src/sw-*.ts --dry-run --diff
//   node scripts/move-files.mjs --to src/sw src/sw-*.ts
//
// A file move changes no code, only paths, so this is PATH ARITHMETIC rather than a refactor: every string literal
// in a tracked source, test, script or page that resolves to a moved file is rewritten to the file's new place, and
// every relative path INSIDE a moved file is rewritten for its new directory, and a doc follows too: its exact old
// paths, and its relative Markdown links (`[x](../src/y.ts)`), including every link of a doc that itself moved. That covers what TypeScript's own
// rename does not see, which in this repo is most of it: tests' `await import("../src/x.ts")`, a `readFileSync`
// of "src/x.ts", build.mjs's entry points, a `<script src>`. What it cannot rewrite it REPORTS: a path assembled
// from pieces (`join(ROOT, "src", "x.ts")`, a list of basenames), for a person to read.
//
// Then it checks: no relative specifier in the tree resolves to a file that is not there (before vs after), and,
// unless --no-typecheck, the repo's own `tsc --noEmit` reports no NEW error. Nothing is written unless both pass.
// Exit 0 = moved (or a clean dry run), 1 = blocked, 2 = bad arguments.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `usage: node scripts/move-files.mjs --to <dir> <file>... [options]

  --to <dir>        destination directory (created if missing); every file keeps its name
  --dry-run         plan and check, write nothing
  --diff            print the unified diff of every rewritten file
  --no-typecheck    skip the repo's own \`tsc --noEmit\` before and after
  --root <dir>      repo root (default: the repo this script is in)`;

// Files whose string literals may name a source path, and docs, whose exact old paths are rewritten.
const CODE = /\.(m?[jt]sx?|cjs|html|json|ya?ml|sh)$/;
const DOC = /\.md$/;
// What a specifier may omit: `./x` names `x.ts`, `x.tsx`, `x/index.ts`, … under bundler resolution.
const EXTS = ["", ".ts", ".tsx", ".js", ".mjs", ".d.ts", "/index.ts", "/index.tsx"];
const LITERAL = /(["'`])([^"'`\n$]*?)\1/g;

/** @param {string[]} argv */
export function parseArgs(argv) {
    const opts = { files: [], dryRun: false, diff: false, typecheck: true, root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => { const v = argv[++i]; if (v == null) throw new Error(`${a} needs a value`); return v; };
        if (a === "--to") opts.to = next();
        else if (a === "--root") opts.root = path.resolve(next());
        else if (a === "--dry-run") opts.dryRun = true;
        else if (a === "--diff") opts.diff = true;
        else if (a === "--no-typecheck") opts.typecheck = false;
        else if (a === "-h" || a === "--help") { console.log(USAGE); process.exit(0); }
        else if (a.startsWith("--")) throw new Error(`unknown argument ${a}`);
        else opts.files.push(a);
    }
    if (!opts.to || !opts.files.length) throw new Error("--to and at least one file are required");
    return opts;
}

/** Tracked files, root-relative. @param {string} root */
function tracked(root) {
    return execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
}

const posix = (p) => p.split(path.sep).join("/");

/** The tracked file a specifier names from `fromDir`, and the suffix it left off; null when it names none.
 *  @param {Set<string>} files @param {string} fromDir root-relative @param {string} spec */
function resolveSpec(files, fromDir, spec) {
    const base = posix(path.normalize(path.join(fromDir, spec)));
    for (const ext of EXTS) if (files.has(base + ext)) return { file: base + ext, ext };
    return null;
}

/** A relative specifier from `fromDir` to `file`, written the way the old one was: same omitted suffix, and a
 *  leading `./` where the old one had one. @param {string} fromDir @param {string} file @param {string} ext */
function specFor(fromDir, file, ext) {
    let rel = posix(path.relative(fromDir, file));
    if (ext) rel = rel.slice(0, rel.length - ext.length);
    return rel.startsWith(".") ? rel : `./${rel}`;
}

/**
 * Plan a move: the new text of every file whose literals change, the moves themselves, and what could only be
 * reported. Pure over the files it is handed, so the tests drive it on a fixture tree.
 * @param {{ files: string[], read: (rel: string) => string, moves: Map<string, string> }} input
 *   `files` every tracked file, `moves` old root-relative path → new.
 */
export function planMove({ files, read, moves }) {
    const before = new Set(files);
    const after = new Set(files.map((f) => moves.get(f) ?? f));
    const newPath = (f) => moves.get(f) ?? f;
    /** @type {Map<string, string>} keyed by the file's NEW path */
    const rewritten = new Map();
    const reports = [];
    for (const rel of files) {
        if (!CODE.test(rel) && !DOC.test(rel)) continue;
        let text;
        try { text = read(rel); } catch { continue; }
        const oldDir = posix(path.dirname(rel)), newDir = posix(path.dirname(newPath(rel)));
        if (DOC.test(rel)) {
            // A doc names a file in prose. The exact old PATH is unambiguous and is rewritten; a bare name
            // (`sw-llm.ts`) stays true after a move that keeps names, so it is left alone.
            let out = text;
            for (const [from, to] of moves) out = out.split(from).join(to);
            // A Markdown LINK resolves against the doc's own directory: retarget one whose file moved, and rebase
            // every link of a doc that itself moved. Fenced code is not a link.
            let fenced = false;
            out = out.split("\n").map((line) => {
                if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return line; }
                if (fenced) return line;
                return line.replace(/\]\(([^)\s#:]+)(#[^)\s]*)?\)/g, (whole, target, anchor = "") => {
                    if (target.startsWith("/")) return whole;
                    const hit = resolveSpec(before, oldDir, target);
                    const file = hit?.file ?? posix(path.normalize(path.join(oldDir, target)));
                    const dest = newPath(file);
                    if (dest === file && newDir === oldDir) return whole;
                    if (!hit && !before.has(file) && ![...before].some((f) => f.startsWith(file + "/"))) return whole;
                    let spec = posix(path.relative(newDir, dest)) || ".";
                    if (hit?.ext) spec = spec.slice(0, spec.length - hit.ext.length);
                    return `](${spec}${anchor})`;
                });
            }).join("\n");
            if (out !== text || newDir !== oldDir) rewritten.set(newPath(rel), out);
            continue;
        }
        const out = text.replace(LITERAL, (whole, q, spec) => {
            // A RELATIVE specifier resolves against the file's own directory, which moves with it.
            if (spec.startsWith("./") || spec.startsWith("../")) {
                const hit = resolveSpec(before, oldDir, spec);
                if (!hit) return whole;
                const target = newPath(hit.file);
                if (target === hit.file && newDir === oldDir) return whole;
                return q + specFor(newDir, target, hit.ext) + q;
            }
            // A ROOT-relative path (`"src/x.ts"` in build.mjs, a script's readFileSync) names one file exactly.
            if (moves.has(spec)) {
                // Usually a path; occasionally DATA that happens to equal one (a sample path in a test). Rewritten,
                // and listed, so a person reads each.
                reports.push({ file: rel, line: text.slice(0, text.indexOf(whole)).split("\n").length, kind: "rooted", text: spec });
                return q + moves.get(spec) + q;
            }
            return whole;
        });
        if (out !== text || newDir !== oldDir) rewritten.set(newPath(rel), out);
        // A path assembled from pieces: `join(ROOT, "src", "x.ts")`. The basename is in a literal on its own.
        text.split("\n").forEach((line, i) => {
            const bases = [...moves.keys()].map((f) => path.posix.basename(f));
            if (bases.some((b) => line.includes(`"${b}"`) || line.includes(`'${b}'`))) reports.push({ file: rel, line: i + 1, kind: "pieces", text: line.trim() });
        });
    }
    return { rewritten, moves, before, after, reports };
}

/** Relative specifiers in code files that resolve to nothing. Compared before vs after, so a specifier that was
 *  already dangling (a generated file, a comment's example) is not blamed on the move.
 *  @param {Set<string>} files @param {(rel: string) => string | null} read */
export function dangling(files, read) {
    const out = [];
    for (const rel of files) {
        if (!/\.(m?[jt]sx?|cjs)$/.test(rel)) continue;
        const text = read(rel);
        if (text == null) continue;
        const dir = posix(path.dirname(rel));
        for (const m of text.matchAll(LITERAL)) {
            const spec = m[2];
            if (!(spec.startsWith("./") || spec.startsWith("../"))) continue;
            if (!/\.(m?[jt]sx?|css|html|json)$/.test(spec) && !/^\.\.?\/[\w./-]+$/.test(spec)) continue;
            if (!resolveSpec(files, dir, spec)) out.push(`${rel}: ${spec}`);
        }
    }
    return out;
}

function typecheck(root) {
    const r = spawnSync("npx", ["tsc", "--noEmit", "-p", "."], { cwd: root, encoding: "utf8" });
    return (r.stdout + r.stderr).split("\n").filter((l) => /error TS\d+/.test(l)).map((l) => l.replace(/\(\d+,\d+\)/, ""));
}

function main() {
    let opts;
    try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`move-files: ${e.message}\n\n${USAGE}`); process.exit(2); }
    const root = opts.root;
    const files = tracked(root);
    const known = new Set(files);
    const toDir = posix(path.relative(root, path.resolve(root, opts.to)));
    const moves = new Map();
    for (const f of opts.files) {
        const rel = posix(path.relative(root, path.resolve(f)));
        if (!known.has(rel)) { console.error(`move-files: ${rel} is not a tracked file`); process.exit(2); }
        const dest = `${toDir}/${path.posix.basename(rel)}`;
        if (known.has(dest)) { console.error(`move-files: ${dest} already exists`); process.exit(2); }
        if (dest !== rel) moves.set(rel, dest);
    }
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
    if (dirty && !opts.dryRun) { console.error("move-files: the working tree has uncommitted changes; commit or stash them first, so the move can be undone with a checkout"); process.exit(1); }

    const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
    const plan = planMove({ files, read, moves });
    const readAfter = (rel) => {
        if (plan.rewritten.has(rel)) return plan.rewritten.get(rel);
        const old = [...moves].find(([, to]) => to === rel)?.[0] ?? rel;
        try { return read(old); } catch { return null; }
    };
    const wasDangling = new Set(dangling(plan.before, (r) => { try { return read(r); } catch { return null; } }).map((s) => s.replace(/^[^:]+/, (f) => moves.get(f) ?? f)));
    const nowDangling = dangling(plan.after, readAfter).filter((s) => !wasDangling.has(s));

    console.log(`move-files: ${moves.size} file(s) → ${toDir}/, ${[...plan.rewritten.keys()].filter((f) => ![...moves.values()].includes(f)).length} other file(s) rewritten`);
    for (const r of plan.reports) console.log(`  report  ${r.kind.padEnd(6)} ${r.file}:${r.line}  ${r.text.slice(0, 140)}`);
    if (opts.diff) {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "move-files-"));
        for (const [rel, text] of plan.rewritten) {
            const old = [...moves].find(([, to]) => to === rel)?.[0] ?? rel;
            const a = path.join(tmp, "a"), b = path.join(tmp, "b");
            fs.writeFileSync(a, read(old)); fs.writeFileSync(b, text);
            const d = spawnSync("diff", ["-u", "--label", `a/${old}`, "--label", `b/${rel}`, a, b], { encoding: "utf8" }).stdout;
            if (d) process.stdout.write(d);
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    if (nowDangling.length) {
        console.log(`  BLOCKED dangling: ${nowDangling.length} specifier(s) would resolve to nothing:`);
        for (const d of nowDangling) console.log(`    ${d}`);
        process.exit(1);
    }
    if (opts.dryRun) { console.log("  dry run: nothing written"); return; }

    const tcBefore = opts.typecheck ? typecheck(root) : [];
    fs.mkdirSync(path.join(root, toDir), { recursive: true });
    for (const [from, to] of moves) execFileSync("git", ["mv", from, to], { cwd: root });
    for (const [rel, text] of plan.rewritten) fs.writeFileSync(path.join(root, rel), text);
    if (opts.typecheck) {
        const seen = new Map();
        for (const l of tcBefore) seen.set(l, (seen.get(l) ?? 0) + 1);
        const fresh = typecheck(root).filter((l) => { const n = seen.get(l) ?? 0; if (n) { seen.set(l, n - 1); return false; } return true; });
        if (fresh.length) {
            console.log(`  NEW type errors (${fresh.length}); undo with: git reset --hard HEAD`);
            for (const l of fresh.slice(0, 30)) console.log(`    ${l}`);
            process.exit(1);
        }
    }
    console.log("  moved. Undo with: git reset --hard HEAD");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

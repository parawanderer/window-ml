#!/usr/bin/env node
// MOVE top-level declarations to another file with the compiler doing the bookkeeping — instead of copying code by
// hand and chasing the type errors. See .claude/skills/move-symbols/SKILL.md.
//
//   node scripts/move-symbols.mjs --from src/background.ts --symbols a,b --to src/bg-runs.ts --dry-run --diff
//   node scripts/move-symbols.mjs --from src/background.ts --symbols a,b --to src/bg-runs.ts
//
// It plans and checks the whole move in memory and writes NOTHING unless every check passes (or the ones that did
// not are named in --allow). Exit 0 = moved (or a clean dry run), 1 = blocked, 2 = bad arguments.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Project } from "./refactor/project.mjs";
import { moveSymbols } from "./refactor/move.mjs";

const USAGE = `usage: node scripts/move-symbols.mjs --from <file> --symbols <a,b,…> --to <file> [options]

  --dry-run            plan and check, write nothing
  --diff               print the unified diff of every file the move changes
  --no-pull            do not bring along helpers that only the moved code uses
  --allow <kinds>      proceed despite these checks (comma-separated): cycle, text-ref, dynamic-import,
                       typecheck, dirty, verbatim
  --no-typecheck       skip the repo's own \`tsc --noEmit\` before and after writing
  --root <dir>         project root (default: the repo this script is in)
  --project <file>     tsconfig, relative to the root (default: tsconfig.json)
  --json               print the report as JSON`;

const OVERRIDABLE = new Set(["cycle", "text-ref", "dynamic-import", "typecheck", "dirty", "verbatim"]);

/** @param {string[]} argv */
function parseArgs(argv) {
    const opts = { allow: new Set(), pull: true, typecheck: true, dryRun: false, diff: false, json: false, root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), project: "tsconfig.json" };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => { const v = argv[++i]; if (v == null) throw new Error(`${a} needs a value`); return v; };
        if (a === "--from") opts.from = next();
        else if (a === "--to") opts.to = next();
        else if (a === "--symbols") opts.symbols = next().split(",").map((s) => s.trim()).filter(Boolean);
        else if (a === "--allow") for (const k of next().split(",")) { if (!OVERRIDABLE.has(k)) throw new Error(`--allow: unknown check "${k}"`); opts.allow.add(k); }
        else if (a === "--root") opts.root = path.resolve(next());
        else if (a === "--project") opts.project = next();
        else if (a === "--no-pull") opts.pull = false;
        else if (a === "--no-typecheck") opts.typecheck = false;
        else if (a === "--dry-run") opts.dryRun = true;
        else if (a === "--diff") opts.diff = true;
        else if (a === "--json") opts.json = true;
        else if (a === "-h" || a === "--help") { console.log(USAGE); process.exit(0); }
        else throw new Error(`unknown argument ${a}`);
    }
    if (!opts.from || !opts.to || !opts.symbols?.length) throw new Error("--from, --symbols and --to are required");
    return opts;
}

/** Changed files that git says have uncommitted edits — a move over those could not be undone with a checkout. @param {string} root @param {string[]} files */
function dirtyFiles(root, files) {
    if (!files.length) return [];
    try {
        const out = execFileSync("git", ["status", "--porcelain", "--", ...files], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        return out.split("\n").filter(Boolean).map((l) => l.slice(3));
    } catch { return []; }
}

/**
 * The repo's OWN compiler over the whole project, as a multiset of position-free error lines — or null when there is
 * no local `tsc`. The in-memory check runs the TypeScript the tool bundles (6.x) over the files around the move; this
 * is the 7.x the repo builds with, over everything, so it has the last word.
 * @param {string} root @param {string} tsconfig
 */
function projectErrors(root, tsconfig) {
    const tsc = path.join(root, "node_modules", ".bin", "tsc");
    if (!fs.existsSync(tsc)) return null;
    const r = spawnSync(tsc, ["--noEmit", "-p", tsconfig], { cwd: root, encoding: "utf8" });
    return (r.stdout + r.stderr).split("\n").filter((l) => /error TS\d+/.test(l));
}

/** Errors in `after` beyond those in `before`, ignoring line and column. @param {string[]} before @param {string[]} after */
function newErrors(before, after) {
    const key = (l) => l.replace(/\(\d+,\d+\)/, "");
    const left = new Map();
    for (const l of before) left.set(key(l), (left.get(key(l)) ?? 0) + 1);
    return after.filter((l) => { const n = left.get(key(l)) ?? 0; if (n) { left.set(key(l), n - 1); return false; } return true; });
}

/** @param {string} rel @param {string | null} before @param {string} after */
function unifiedDiff(rel, before, after) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "move-symbols-"));
    const a = path.join(dir, "a"), b = path.join(dir, "b");
    fs.writeFileSync(a, before ?? ""); fs.writeFileSync(b, after);
    const r = spawnSync("git", ["diff", "--no-index", "--no-color", "--", a, b], { encoding: "utf8" });
    fs.rmSync(dir, { recursive: true, force: true });
    return (r.stdout || "").replace(/^diff --git .*\n(index .*\n)?/m, "")
        .replace(/^--- .*$/m, `--- ${before == null ? "/dev/null" : `a/${rel}`}`).replace(/^\+\+\+ .*$/m, `+++ b/${rel}`)
        .replace(/^new file mode .*\n/m, "");
}

/** Lines added and removed, by multiset — enough for a summary. @param {string | null} before @param {string} after */
function lineDelta(before, after) {
    const count = new Map();
    for (const l of (before ?? "").split("\n")) count.set(l, (count.get(l) ?? 0) + 1);
    let added = 0;
    for (const l of after.split("\n")) { const n = count.get(l) ?? 0; if (n) count.set(l, n - 1); else added++; }
    const removed = [...count.values()].reduce((s, n) => s + n, 0);
    return { added, removed: before == null ? 0 : removed };
}

function main() {
    let opts;
    try { opts = parseArgs(process.argv.slice(2)); }
    catch (e) { console.error(`move-symbols: ${/** @type {Error} */ (e).message}\n\n${USAGE}`); process.exit(2); }

    const project = new Project(opts.root, opts.project);
    const report = moveSymbols(project, { from: opts.from, symbols: opts.symbols, to: opts.to, pull: opts.pull });
    const changed = report.blocks.some((b) => b.kind === "input" || b.kind === "conflict" || b.kind === "mutable" || b.kind === "refactor") ? [] : project.changed();
    const rels = changed.map((c) => project.rel(c.file));
    for (const f of dirtyFiles(project.root, rels)) report.blocks.push({ kind: /** @type {any} */ ("dirty"), message: `${f} has uncommitted changes; commit or stash first so the move can be undone with a checkout` });
    const blocking = report.blocks.filter((b) => !opts.allow.has(b.kind));

    if (opts.json) {
        console.log(JSON.stringify({ ...report, files: rels, blocking: blocking.length > 0, written: !opts.dryRun && !blocking.length }, null, 2));
    } else {
        const out = [];
        out.push(`move-symbols: ${report.from} → ${report.to}${report.newFile ? " (new file)" : ""}`, "");
        for (const m of report.moved) out.push(`  move      ${m.name} (${m.exported ? "exported " : ""}${m.kind})`);
        for (const m of report.pulled) out.push(`  pull      ${m.name} (${m.kind}) — only ${m.usedBy.join(", ")} use${m.usedBy.length > 1 ? "" : "s"} it`);
        for (const m of report.staying) out.push(`  stays     ${m.name} (${m.kind}) — ${report.to} will import it${m.value ? "" : " as a type"} for ${m.usedBy.join(", ")}`);
        if (changed.length) {
            out.push("");
            for (const c of changed) {
                const d = lineDelta(c.before, c.after);
                out.push(`  file      ${project.rel(c.file)}${c.before == null ? " (new)" : ""}  +${d.added} −${d.removed}  (${c.after.split("\n").length - 1} lines)`);
            }
        }
        if (report.alsoRewritten.length) out.push(`  also      rewrote ${report.alsoRewritten.map((r) => `${r.file}:${r.line}`).join(", ")}`);
        out.push("");
        if (changed.length) {
            out.push(`  verbatim  ${report.verbatim ? "✓ moved code is byte-identical to the original" : "✗ moved code differs from the original"}`);
            out.push(`  typecheck ${report.newDiagnostics.length ? `✗ ${report.newDiagnostics.length} new error(s)` : "✓ no new errors"} in ${report.diagnosticsChecked} file(s)`);
            out.push(`  cycles    ${report.cycles.length ? `✗ ${report.cycles.length} new` : "✓ none new"}`);
            for (const b of report.bundles) out.push(`  bundle    ${b.entry} now also contains ${b.gains.join(", ")}`);
        }
        for (const r of report.textRefs.filter((t) => t.kind !== "code")) out.push(`  ${r.kind === "doc" ? "doc      " : "entry    "} ${r.file}:${r.line} ${r.text.slice(0, 120)}`);
        for (const n of report.notes) out.push(`  note      ${n}`);
        if (report.blocks.length) out.push("");
        for (const b of report.blocks) out.push(`  ${opts.allow.has(b.kind) ? "allowed" : "BLOCKED"}   [${b.kind}] ${b.message}`);
        console.log(out.join("\n"));
        if (opts.diff) for (const c of changed) console.log(`\n${unifiedDiff(project.rel(c.file), c.before, c.after)}`);
    }

    if (blocking.length) {
        if (!opts.json) {
            const kinds = [...new Set(blocking.map((b) => b.kind))].filter((k) => OVERRIDABLE.has(k));
            console.log(`\nnothing written.${kinds.length ? ` To proceed anyway: --allow ${kinds.join(",")}` : ""}`);
        }
        process.exit(1);
    }
    if (opts.dryRun) { if (!opts.json) console.log("\ndry run: nothing written."); return; }
    const baseline = opts.typecheck ? projectErrors(project.root, opts.project) : null;
    project.flush();
    const existing = changed.filter((c) => c.before != null).map((c) => project.rel(c.file));
    const created = changed.filter((c) => c.before == null).map((c) => project.rel(c.file));
    const undo = [existing.length ? `git checkout -- ${existing.join(" ")}` : "", created.length ? `rm ${created.join(" ")}` : ""].filter(Boolean).join(" && ");
    const fresh = baseline ? newErrors(baseline, projectErrors(project.root, opts.project) ?? []) : null;
    if (opts.json) return;
    console.log(`\nwritten. Undo: ${undo}`);
    if (fresh == null) console.log("Then: npm run typecheck && npm run test:core");
    else if (!fresh.length) console.log("tsc (whole project): ✓ no new errors. Then: npm run test:core, or the genre covering these files");
    else {
        console.log(`tsc (whole project): ✗ ${fresh.length} new error(s):`);
        for (const l of fresh.slice(0, 15)) console.log(`  ${l}`);
        process.exit(1);
    }
}

main();

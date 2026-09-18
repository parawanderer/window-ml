// extract-function.mjs — lift a RANGE OF STATEMENTS inside one file into its own named function, without
// retyping any of it.
//
//   node scripts/extract-function.mjs --file src/sidebar/vram.tsx --lines 1840-1902 --name modelRows --dry-run --diff
//   node scripts/extract-function.mjs --file src/x.ts --lines 40-58 --name step --scope inner
//
// WHY A TOOL. move-symbols moves whole top-level declarations between FILES; it cannot touch what is inside one.
// That leaves the operation a 3,600-line component file actually needs — cut a body into pieces — as hand
// editing, where the closure is worked out by eye: which locals the range reads (they become parameters), which
// it assigns that someone later reads (they have to come back), and whether it uses `this` or an outer generic.
// Getting that wrong compiles fine and changes behaviour.
//
// It is a WRAPPER, not an implementation. TypeScript's own `Extract Symbol` refactor does the closure analysis,
// the same language service `move-symbols` drives for `Move to file`, so the two cannot disagree about scope.
// What this adds is the parts a CLI needs: choosing the module-scope target rather than an inner one, naming the
// result (the refactor always emits `newFunction`), and refusing on a new type error.
import path from "node:path";
import { Project, FORMAT, PREFS } from "./refactor/project.mjs";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d; };
const has = (n) => args.includes(n);
// `--root` exists so the tool can be pointed at a fixture project; everything else defaults to this repo.
const ROOT = path.resolve(flag("--root", path.join(path.dirname(new URL(import.meta.url).pathname), "..")));

const file = flag("--file"), lines = flag("--lines"), name = flag("--name");
if (!file || !lines || !name) {
    console.error("usage: extract-function.mjs --file <f> --lines <a-b> --name <fn> [--scope module|inner] [--root <dir>] [--dry-run] [--diff]");
    process.exit(2);
}
if (!/^[A-Za-z_$][\w$]*$/.test(name)) { console.error(`"${name}" is not a valid identifier`); process.exit(2); }
const m = /^(\d+)-(\d+)$/.exec(lines);
if (!m) { console.error("--lines wants a 1-based inclusive range, e.g. 120-168"); process.exit(2); }

const project = new Project(ROOT);
const abs = project.abs(file);
const text = project.read(abs);
if (text == null) { console.error(`cannot read ${file}`); process.exit(2); }

// Offsets from 1-based inclusive lines. The end is the END of the last line, so a caller can name the lines they
// see in an editor rather than computing a character offset nobody can verify by eye.
const starts = [0];
for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
const from = Number(m[1]) - 1, to = Number(m[2]) - 1;
if (from < 0 || to >= starts.length || from > to) { console.error(`--lines ${lines} is outside ${file} (${starts.length} lines)`); process.exit(2); }
const pos = starts[from] + (/^[ \t]*/.exec(text.slice(starts[from]))?.[0].length ?? 0);
const end = to + 1 < starts.length ? starts[to + 1] - 1 : text.length;

const before = project.diagnostics([abs]);
const offered = project.ls.getApplicableRefactors(abs, { pos, end }, undefined, undefined)
    .find((r) => r.name === "Extract Symbol");
if (!offered) {
    console.error(`TypeScript will not extract lines ${lines} of ${file}.`);
    console.error("A range must be whole statements or one expression, and must not jump out of its block");
    console.error("(a `return`, `break` or `await` that leaves the range takes the meaning with it).");
    process.exit(1);
}
const wantInner = flag("--scope", "module") === "inner";
// `function_scope_N` counts outward: 0 is the innermost enclosing function, the last is module scope. Splitting a
// big file wants module scope, so that is the default; --scope inner keeps it nested.
const scopes = offered.actions.filter((a) => a.name.startsWith("function_scope_"));
if (!scopes.length) { console.error(`only these are offered: ${offered.actions.map((a) => a.name).join(", ")}`); process.exit(1); }
const action = wantInner ? scopes[0] : scopes[scopes.length - 1];

const edits = project.ls.getEditsForRefactor(abs, FORMAT, { pos, end }, "Extract Symbol", action.name, PREFS);
if (!edits?.edits.length) { console.error("the refactor produced no edits"); process.exit(1); }
project.apply(edits.edits);

// The refactor always calls it `newFunction`, and tells us where it put the name so it can be renamed in place.
let renamed = 0;
if (edits.renameFilename != null && edits.renameLocation != null) {
    const locs = project.ls.findRenameLocations(path.resolve(edits.renameFilename), edits.renameLocation, false, false, {}) ?? [];
    const byFile = new Map();
    for (const l of locs) {
        const f = path.resolve(l.fileName);
        if (!byFile.has(f)) byFile.set(f, []);
        byFile.get(f).push({ span: l.textSpan, newText: name });
    }
    project.apply([...byFile].map(([fileName, textChanges]) => ({ fileName, textChanges, isNewFile: false })));
    renamed = locs.length;
}

const after = project.diagnostics([abs]);
const key = (d) => `${d.code}|${d.message}`;
const had = new Map();
for (const d of before) had.set(key(d), (had.get(key(d)) ?? 0) + 1);
const fresh = after.filter((d) => { const k = key(d); if (had.get(k)) { had.set(k, had.get(k) - 1); return false; } return true; });

const changed = project.changed();
for (const c of changed) {
    const gained = c.after.split("\n").length - (c.before?.split("\n").length ?? 0);
    console.log(`  file      ${project.rel(c.file)}  ${gained >= 0 ? "+" : ""}${gained} line(s)`);
}
console.log(`  scope     ${action.description}`);
console.log(`  renamed   newFunction -> ${name} (${renamed} reference${renamed === 1 ? "" : "s"})`);

if (has("--diff")) {
    for (const c of changed) {
        const a = (c.before ?? "").split("\n"), b = c.after.split("\n");
        let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++;
        let e = 0; while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
        console.log(`\n--- ${project.rel(c.file)} @@ around line ${s + 1}`);
        for (const l of a.slice(s, a.length - e)) console.log(`-${l}`);
        for (const l of b.slice(s, b.length - e)) console.log(`+${l}`);
    }
}

if (fresh.length) {
    console.log(`\n  BLOCKED   [typecheck] ${fresh.length} new error(s):`);
    for (const d of fresh.slice(0, 5)) console.log(`    ${d.file}:${d.line} ${d.message}`);
    console.log("\nnothing written.");
    process.exit(1);
}
if (has("--dry-run")) { console.log("\ndry run: nothing written."); process.exit(0); }
project.flush();
console.log(`\nwritten. Undo: git checkout -- ${changed.map((c) => project.rel(c.file)).join(" ")}`);
console.log("Then: the genre covering this file (node scripts/test.mjs --list), and check the new function's NAME reads right.");

// MOVE top-level declarations from one module to another, updating every import — the engine behind
// scripts/move-symbols.mjs. Everything happens in memory on a Project; the caller decides whether to flush.
//
// The steps, and why each one is not left to TypeScript's own "Move to file":
//   1. Resolve the names to statements and pull along any helper ONLY the moved code uses. The refactor leaves such
//      a helper behind and imports it back, which is an import cycle by construction.
//   2. Relocate the moved statements, in memory, to the END of the source file as one block. The refactor takes a
//      single range, and a second call crashes ("Changes overlap") once the target already imports what it moves;
//      at the end of the file the block also cannot inherit the file's header comment as leading trivia.
//   3. Run the refactor, then put the moved code back BYTE FOR BYTE: it reprints what it moves (re-spacing trailing
//      comments, for one), and a move should be a move. The only edit kept is an added `export`.
//   4. Rewrite the `import()`/`require()` uses and the re-exports it does not touch, then check: no new diagnostics, no new import
//      cycle, what each bundle gains, and who names the file as a string.
import path from "node:path";
import { ts, FORMAT, PREFS } from "./project.mjs";
import {
    findStatements, localDependencies, referencesTo, referenceInside, declaredNames, kindOf, isExported,
    attachedStart, attachedEnd,
} from "./declarations.mjs";
import { projectGraph, newCycles, bundleEntries, reach } from "./graph.mjs";
import { rewriteDynamicImports, rewriteReExports, removeEmptyDestructuring } from "./missed-imports.mjs";
import { textReferences } from "./text-refs.mjs";

/**
 * @typedef {"input"|"conflict"|"mutable"|"refactor"|"verbatim"|"typecheck"|"cycle"|"dynamic-import"|"text-ref"} BlockKind
 * @typedef {{ kind: BlockKind, message: string }} Block
 */

/** Constructors whose call at module load has no effect worth warning about. */
const INERT_NEW = new Set(["Map", "Set", "WeakMap", "WeakSet", "RegExp", "Array", "Object"]);

/**
 * @param {import("./project.mjs").Project} project
 * @param {{ from: string, symbols: string[], to: string, pull?: boolean }} req paths root-relative or absolute
 */
export function moveSymbols(project, { from, symbols, to, pull = true }) {
    const fromAbs = project.abs(from), toAbs = project.abs(to);
    const report = {
        from: project.rel(fromAbs), to: project.rel(toAbs), newFile: project.read(toAbs) == null,
        /** @type {{ name: string, kind: string, exported: boolean }[]} */ moved: [],
        /** @type {{ name: string, kind: string, usedBy: string[] }[]} */ pulled: [],
        /** @type {{ name: string, kind: string, usedBy: string[], value: boolean }[]} */ staying: [],
        /** @type {Block[]} */ blocks: [],
        /** @type {string[]} */ notes: [],
        /** @type {{ file: string, line: number, message: string }[]} */ newDiagnostics: [],
        diagnosticsChecked: 0,
        /** @type {string[][]} */ cycles: [],
        /** @type {{ entry: string, gains: string[] }[]} */ bundles: [],
        /** @type {ReturnType<typeof textReferences>} */ textRefs: [],
        /** @type {{ file: string, line: number }[]} */ alsoRewritten: [],
        verbatim: false,
    };
    const block = (kind, message) => report.blocks.push({ kind, message });

    if (fromAbs === toAbs) { block("input", "--from and --to are the same file"); return report; }
    if (!/\.(ts|tsx|mts)$/.test(toAbs)) { block("input", `--to must be a TypeScript file, got ${report.to}`); return report; }
    const program0 = project.program();
    const sf = program0.getSourceFile(fromAbs);
    if (!sf) { block("input", `${report.from} is not part of the program`); return report; }
    if (!report.newFile && !program0.getSourceFile(toAbs)) { block("input", `${report.to} exists but is not part of the program`); return report; }
    const checker = program0.getTypeChecker();

    // 1. What moves.
    const found = findStatements(sf, symbols);
    for (const e of found.errors) block("input", e);
    if (report.blocks.length) return report;
    const moving = new Set(found.statements);
    for (;;) {
        const deps = localDependencies(checker, sf, moving);
        let grew = false;
        if (pull) {
            for (const [st, info] of deps) {
                const refs = referencesTo(project.ls, sf, st);
                if (refs.length && refs.every((r) => referenceInside(sf, r, moving))) {
                    moving.add(st);
                    report.pulled.push({ name: declaredNames(st).join(", "), kind: kindOf(st), usedBy: [...info.usedBy] });
                    grew = true;
                }
            }
        }
        if (grew) continue;
        for (const [st, info] of deps) report.staying.push({ name: declaredNames(st).join(", "), kind: kindOf(st), usedBy: [...info.usedBy], value: info.value });
        break;
    }
    const ordered = sf.statements.filter((st) => moving.has(st));
    const movedNames = new Set(ordered.flatMap(declaredNames));
    for (const st of found.statements) for (const name of declaredNames(st)) report.moved.push({ name, kind: kindOf(st), exported: isExported(st) });

    // Names the target already binds.
    if (!report.newFile) {
        const tsf = /** @type {ts.SourceFile} */ (program0.getSourceFile(toAbs));
        for (const st of tsf.statements) {
            const bound = [...declaredNames(st)];
            if (ts.isImportDeclaration(st) && st.importClause) {
                const target = program0.getResolvedModuleFromModuleSpecifier(/** @type {ts.StringLiteral} */ (st.moduleSpecifier), tsf)?.resolvedModule?.resolvedFileName;
                if (!target || path.resolve(target) !== fromAbs) {
                    if (st.importClause.name) bound.push(st.importClause.name.text);
                    const nb = st.importClause.namedBindings;
                    if (nb && ts.isNamespaceImport(nb)) bound.push(nb.name.text);
                    if (nb && ts.isNamedImports(nb)) bound.push(...nb.elements.map((e) => e.name.text));
                }
            }
            for (const n of bound) if (movedNames.has(n)) block("conflict", `${report.to} already binds \`${n}\` (line ${tsf.getLineAndCharacterOfPosition(st.getStart(tsf)).line + 1})`);
        }
    }

    // An imported binding is read-only: state that is ASSIGNED across the new module boundary cannot move.
    for (const st of ordered) {
        if (!ts.isVariableStatement(st) || st.declarationList.flags & ts.NodeFlags.Const) continue;
        for (const r of referencesTo(project.ls, sf, st)) {
            if (r.isWrite && !referenceInside(sf, r, moving)) {
                const rsf = program0.getSourceFile(r.fileName);
                block("mutable", `\`${declaredNames(st).join(", ")}\` is assigned at ${project.rel(r.fileName)}:${rsf ? rsf.getLineAndCharacterOfPosition(r.start).line + 1 : "?"}, which would import it — an imported binding is read-only`);
                break;
            }
        }
    }
    for (const dep of localDependencies(checker, sf, moving).keys()) {
        if (!ts.isVariableStatement(dep) || dep.declarationList.flags & ts.NodeFlags.Const) continue;
        const write = referencesTo(project.ls, sf, dep).find((r) => r.isWrite && referenceInside(sf, r, moving));
        if (write) block("mutable", `the moved code assigns \`${declaredNames(dep).join(", ")}\` (line ${sf.getLineAndCharacterOfPosition(write.start).line + 1}), which stays in ${report.from} — an imported binding is read-only`);
    }
    if (report.blocks.length) return report;

    for (const st of ordered) {
        if (!ts.isVariableStatement(st)) continue;
        let effect = false;
        const visit = (n) => {
            if (ts.isFunctionLike(n) || ts.isClassLike(n)) return;
            if (ts.isCallExpression(n) || ts.isTaggedTemplateExpression(n)) effect = true;
            if (ts.isNewExpression(n) && !(ts.isIdentifier(n.expression) && INERT_NEW.has(n.expression.text))) effect = true;
            if (!effect) ts.forEachChild(n, visit);
        };
        st.declarationList.declarations.forEach((d) => d.initializer && visit(d.initializer));
        if (effect) report.notes.push(`\`${declaredNames(st).join(", ")}\` runs code when the module loads; it will now run when ${report.to} is first imported, before the rest of ${report.from}`);
    }

    // The state to compare against.
    const graphBefore = projectGraph(project);
    const neighbours = new Set([fromAbs, ...(report.newFile ? [] : [toAbs])]);
    for (const [f, edges] of graphBefore) if (edges.has(fromAbs) || edges.has(toAbs)) neighbours.add(f);
    const diagKey = (d) => `${d.code} ${d.message}`;
    const before = project.diagnostics(neighbours);
    report.textRefs = textReferences(project.root, report.from, movedNames);
    for (const r of report.textRefs) if (r.kind === "code") block("text-ref", `${r.file}:${r.line} names ${report.from} as a string: ${r.text}`);

    // 2. Relocate the block to the end of the file.
    const text = sf.text;
    const units = ordered.map((st) => {
        const start = lineStartIfClear(text, attachedStart(sf, st));
        return { names: declaredNames(st), kind: kindOf(st), start, end: attachedEnd(sf, st), exported: isExported(st), exportAt: st.getStart(sf) - start };
    });
    let rest = "", cursor = 0;
    for (const u of units) {
        rest = joinCut(rest, text.slice(cursor, u.start));
        cursor = text[u.end] === "\n" ? u.end + 1 : u.end;
    }
    rest = joinCut(rest, text.slice(cursor));
    const blockText = units.map((u) => text.slice(u.start, u.end)).join("\n\n");
    project.write(fromAbs, `${rest.replace(/\s+$/, "")}\n\n${blockText}\n`);

    // 3. The refactor, then the original bytes back.
    const sf2 = project.sourceFile(fromAbs);
    const tail = sf2.statements.slice(-units.length);
    let edits;
    try {
        edits = project.ls.getEditsForRefactor(fromAbs, FORMAT, { pos: tail[0].getStart(sf2), end: tail[tail.length - 1].getEnd() },
            "Move to file", "Move to file", PREFS, { targetFile: toAbs });
    } catch (e) {
        block("refactor", `TypeScript's move refactor failed: ${String(/** @type {Error} */ (e).message).split("\n")[0]}`);
        return report;
    }
    if (!edits?.edits.length) { block("refactor", "TypeScript's move refactor produced no edits"); return report; }
    // Captured BEFORE the edits: removing an import that the move made redundant takes that statement's LEADING
    // TRIVIA with it, and when the import is the file's first statement the trivia is its module header. That is
    // silent documentation loss, and `--headerless` does not see it because whatever lands next reads as a header.
    const headers = headersOf(project, edits.edits.filter((e) => !e.isNewFile).map((e) => e.fileName));
    project.apply(edits.edits);
    const touched = new Set(edits.edits.map((e) => path.resolve(e.fileName)));
    touched.add(toAbs);
    // The refactor re-prints the source file's tail; give it back the ending it had.
    const fromAfter = project.read(fromAbs) ?? "";
    project.write(fromAbs, fromAfter.replace(/\s+$/, "") + (/\n$/.test(text) ? "\n" : ""));
    // In a NEW file every import is the refactor's copy of one in the source, and it copies the leading trivia
    // too — for the source's first import that is the source's file header. The header describes the old file.
    if (report.newFile) stripImportLeadingComments(project, toAbs);

    if (!restoreVerbatim(project, toAbs, units, text)) block("verbatim", `the moved code in ${report.to} could not be matched back to the original; inspect it with --diff`);
    else report.verbatim = true;

    // 4. What the refactor leaves alone, then the checks.
    const dyn = rewriteDynamicImports(project, fromAbs, toAbs, movedNames);
    report.alsoRewritten = dyn.rewritten;
    for (const m of dyn.manual) block("dynamic-import", `${m.file}:${m.line} loads ${report.from} dynamically and ${m.text}; fix it by hand`);
    const reexports = rewriteReExports(project, fromAbs, toAbs, movedNames);
    report.alsoRewritten.push(...reexports);
    for (const r of [...dyn.rewritten, ...reexports]) touched.add(project.abs(r.file));
    removeEmptyDestructuring(project, touched);
    for (const f of touched) mergeDuplicateImports(project, f);
    restoreHeaders(project, headers);

    const checkSet = new Set([...neighbours, ...touched]);
    const after = project.diagnostics(checkSet);
    report.diagnosticsChecked = checkSet.size;
    const seen = new Map();
    for (const d of before) seen.set(diagKey(d), (seen.get(diagKey(d)) ?? 0) + 1);
    for (const d of after) {
        const n = seen.get(diagKey(d)) ?? 0;
        if (n) seen.set(diagKey(d), n - 1);
        else report.newDiagnostics.push({ file: d.file, line: d.line, message: d.message });
    }
    for (const d of report.newDiagnostics) block("typecheck", `${d.file}:${d.line} ${d.message}`);

    const graphAfter = projectGraph(project);
    report.cycles = newCycles(project, graphBefore, graphAfter, touched).map((loop) => loop.map((f) => project.rel(f)));
    for (const loop of report.cycles) block("cycle", `new import cycle: ${loop.join(" → ")}`);

    for (const [entry, file] of bundleEntries(project.root)) {
        const rb = reach(graphBefore, file), ra = reach(graphAfter, file);
        // A NEW target is the moved code under another name; an existing one brings its own top-level code along.
        const gains = [...ra].filter((f) => !rb.has(f) && !(report.newFile && f === toAbs && rb.has(fromAbs))).map((f) => project.rel(f));
        if (gains.length) report.bundles.push({ entry, gains });
    }
    return report;
}

/**
 * Fold a second named import from the same module into the first: the refactor adds `import { load } from "./b"`
 * beside an existing `import { keep } from "./b"` rather than extending it. Only plain named imports of the same
 * kind are merged, and never one carrying its own trailing comment, which would have nowhere to go.
 * @param {import("./project.mjs").Project} project @param {string} file
 */
function mergeDuplicateImports(project, file) {
    const sf = project.program().getSourceFile(file);
    if (!sf) return;
    const first = new Map();
    const changes = [];
    for (const st of sf.statements) {
        if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
        const clause = st.importClause;
        if (!clause || clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;
        const key = `${clause.isTypeOnly ? "type " : ""}${st.moduleSpecifier.text}`;
        const head = first.get(key);
        if (!head) { first.set(key, { st, extra: [] }); continue; }
        if ((ts.getTrailingCommentRanges(sf.text, st.getEnd()) ?? []).length) continue;
        head.extra.push(...clause.namedBindings.elements.map((e) => e.getText(sf)));
        const start = sf.text.lastIndexOf("\n", st.getStart(sf)) + 1;
        const end = sf.text[st.getEnd()] === "\n" ? st.getEnd() + 1 : st.getEnd();
        changes.push({ span: { start, length: end - start }, newText: "" });
    }
    for (const { st, extra } of first.values()) {
        if (!extra.length) continue;
        const named = /** @type {ts.NamedImports} */ (/** @type {ts.ImportClause} */ (st.importClause).namedBindings);
        const last = named.elements[named.elements.length - 1];
        changes.push({ span: { start: last.getEnd(), length: 0 }, newText: `, ${extra.join(", ")}` });
    }
    if (changes.length) project.apply([{ fileName: sf.fileName, textChanges: changes, isNewFile: false }]);
}

/** Each file's leading comment block, by absolute path — its module header, as it stands before the refactor.
 *  @param {import("./project.mjs").Project} project @param {string[]} files @returns {Map<string, string>} */
function headersOf(project, files) {
    const out = new Map();
    for (const f of files) {
        const abs = path.resolve(f);
        if (out.has(abs)) continue;
        const text = project.read(abs);
        if (text == null) continue;
        let sf;
        try { sf = project.sourceFile(abs); } catch { continue; }
        const first = sf.statements[0];
        if (!first) continue;
        const head = text.slice(0, first.getStart(sf));
        if (/^\s*(\/\/|\/\*)/.test(head)) out.set(abs, head);
    }
    return out;
}

/** Put back a module header the refactor deleted along with the import it was sitting on. A header that merely
 *  moved, or whose trailing blank lines changed, is left alone: only a header that is GONE is restored.
 *  @param {import("./project.mjs").Project} project @param {Map<string, string>} headers */
function restoreHeaders(project, headers) {
    for (const [f, head] of headers) {
        const text = project.read(f);
        if (text == null) continue;
        const body = head.replace(/\s+$/, "");
        if (!body || text.includes(body)) continue;
        project.write(f, head + text.replace(/^\s+/, ""));
    }
}

/** Remove the comments above a new file's leading imports (copied trivia, not documentation of the new file). @param {import("./project.mjs").Project} project @param {string} file */
function stripImportLeadingComments(project, file) {
    const sf = project.sourceFile(file);
    const imports = [];
    for (const st of sf.statements) { if (!ts.isImportDeclaration(st)) break; imports.push(st); }
    const changes = imports.filter((st) => st.getStart(sf) > st.getFullStart())
        .map((st) => {
            const start = st.getFullStart() === 0 ? 0 : st.getFullStart();
            const gap = sf.text.slice(start, st.getStart(sf));
            return { span: { start, length: gap.length }, newText: start === 0 ? "" : "\n" };
        })
        .filter((c) => /\S/.test(sf.text.substr(c.span.start, c.span.length)));
    if (changes.length) project.apply([{ fileName: file, textChanges: changes, isNewFile: false }]);
}

/** Back up to the start of the line when only indentation precedes. @param {string} text @param {number} pos */
function lineStartIfClear(text, pos) {
    const ls = text.lastIndexOf("\n", pos - 1) + 1;
    return /^[ \t]*$/.test(text.slice(ls, pos)) ? ls : pos;
}

/** Concatenate the text either side of a removed block without leaving more than one blank line. @param {string} left @param {string} right */
function joinCut(left, right) {
    if (!left) return right;
    if (/\n\n$/.test(left)) return left + right.replace(/^\n+/, "");
    return left + right;
}

/**
 * Replace the refactor's reprint of each moved statement in the target with the original text, keeping an `export`
 * the refactor added. Everything from the end of the previous statement up to a moved one's end is the refactor's
 * copy of it and its comments, so that whole region is replaced. Returns false when a statement cannot be found or
 * the result does not read back identical.
 * @param {import("./project.mjs").Project} project @param {string} toAbs
 * @param {{ names: string[], kind: string, start: number, end: number, exported: boolean, exportAt: number }[]} units
 * @param {string} original the source file's text the units index into
 */
function restoreVerbatim(project, toAbs, units, original) {
    const tsf = project.sourceFile(toAbs);
    const used = new Set();
    const plan = [];
    for (const u of units) {
        const idx = tsf.statements.findIndex((st, i) => !used.has(i) && kindOf(st) === u.kind && declaredNames(st).join() === u.names.join());
        if (idx < 0) return false;
        used.add(idx);
        const st = tsf.statements[idx];
        let body = original.slice(u.start, u.end);
        if (isExported(st) && !u.exported) body = `${body.slice(0, u.exportAt)}export ${body.slice(u.exportAt)}`;
        const prev = idx > 0 ? attachedEnd(tsf, tsf.statements[idx - 1]) : 0;
        plan.push({ start: prev, end: attachedEnd(tsf, st), newText: `${idx > 0 ? "\n\n" : ""}${body}`, body });
    }
    let out = tsf.text;
    for (const p of [...plan].sort((a, b) => b.start - a.start)) out = out.slice(0, p.start) + p.newText + out.slice(p.end);
    project.write(toAbs, `${out.replace(/\s+$/, "")}\n`);
    const check = project.read(toAbs) ?? "";
    return plan.every((p) => check.includes(p.body));
}

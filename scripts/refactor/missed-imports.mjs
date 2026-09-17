// The imports TypeScript's move refactor does NOT update: `await import("../src/x.ts")` and `require(...)` whose
// result is destructured or read by member, and re-exports (`export { a } from "./x"`). The tests here load modules
// by dynamic import hundreds of times, so a move that left them alone would hand a test `undefined` — and a test that
// ends its import in `.catch(() => null)` would then skip itself instead of failing.
import path from "node:path";
import { ts } from "./project.mjs";

/** The specifier a file should use for `target`, in the style of the one it used before (extension or none). @param {string} importer @param {string} target @param {string} oldSpec */
export function specifierFor(importer, target, oldSpec) {
    let rel = path.relative(path.dirname(importer), target).split(path.sep).join("/");
    if (!rel.startsWith(".")) rel = `./${rel}`;
    const oldExt = /\.(m?[jt]sx?)$/.exec(oldSpec)?.[1];
    if (!oldExt) return rel.replace(/\.(m?[jt]sx?)$/, "");
    if (oldExt === "js" || oldExt === "mjs") return rel.replace(/\.(m?[jt]sx?)$/, `.${oldExt}`);
    return rel;
}

/** The outermost expression that still evaluates to the module: through `await`, parentheses and `.then/.catch/.finally`. @param {ts.Node} call */
function moduleExpression(call) {
    let node = call;
    for (;;) {
        const p = node.parent;
        if (ts.isAwaitExpression(p) || ts.isParenthesizedExpression(p)) { node = p; continue; }
        if (ts.isPropertyAccessExpression(p) && p.expression === node && ["catch", "finally"].includes(p.name.text)
            && ts.isCallExpression(p.parent) && p.parent.expression === p) { node = p.parent; continue; }
        return node;
    }
}

/** @param {ts.SourceFile} sf @param {number} pos */
const lineOf = (sf, pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;

/**
 * Rewrite the dynamic imports and requires of `fromAbs` that read any of `moved`, so they read them from `toAbs`.
 * @param {import("./project.mjs").Project} project
 * @param {string} fromAbs @param {string} toAbs @param {Set<string>} moved
 * @returns {{ rewritten: { file: string, line: number }[], manual: { file: string, line: number, text: string }[] }}
 */
export function rewriteDynamicImports(project, fromAbs, toAbs, moved) {
    const program = project.program();
    const checker = program.getTypeChecker();
    const rewritten = [], manual = [];
    for (const sf of program.getSourceFiles()) {
        const file = path.resolve(sf.fileName);
        if (!file.startsWith(project.root + path.sep) || file.includes(`${path.sep}node_modules${path.sep}`)) continue;
        /** @type {ts.TextChange[]} */
        const changes = [];
        for (const lit of /** @type {any} */ (sf).imports ?? []) {
            const call = lit.parent;
            if (!ts.isCallExpression(call) || ts.isImportDeclaration(call)) continue;
            const resolved = program.getResolvedModuleFromModuleSpecifier(lit, sf)?.resolvedModule?.resolvedFileName;
            if (!resolved || path.resolve(resolved) !== fromAbs) continue;
            const spec = specifierFor(file, toAbs, lit.text);
            const quote = sf.text[lit.getStart(sf)];
            const retarget = { span: { start: lit.getStart(sf), length: lit.getWidth(sf) }, newText: `${quote}${spec}${quote}` };
            const expr = moduleExpression(call);
            const site = expr.parent;
            const note = (why) => manual.push({ file: project.rel(file), line: lineOf(sf, lit.getStart(sf)), text: why });

            // const { a, b: c } = await import("…")
            if (ts.isVariableDeclaration(site) && site.initializer === expr && ts.isObjectBindingPattern(site.name)) {
                const els = site.name.elements;
                const key = (e) => (e.propertyName && (ts.isIdentifier(e.propertyName) || ts.isStringLiteral(e.propertyName)) ? e.propertyName.text : ts.isIdentifier(e.name) ? e.name.text : null);
                const hit = els.filter((e) => moved.has(key(e)));
                if (!hit.length) continue;
                if (els.some((e) => e.dotDotDotToken)) { note("a rest element takes the module's other members"); continue; }
                if (hit.length === els.length) { changes.push(retarget); rewritten.push({ file: project.rel(file), line: lineOf(sf, lit.getStart(sf)) }); continue; }
                const list = site.parent;
                const stmt = list.parent;
                if (!ts.isVariableDeclarationList(list) || list.declarations.length !== 1 || !ts.isVariableStatement(stmt)) {
                    note("the destructuring shares its statement with other declarations"); continue;
                }
                // Split: the moved members get their own statement right after this one, loading the new file.
                const keep = els.filter((e) => !hit.includes(e));
                changes.push({ span: { start: site.name.getStart(sf), length: site.name.getWidth(sf) }, newText: `{ ${keep.map((e) => e.getText(sf)).join(", ")} }` });
                const keyword = list.flags & ts.NodeFlags.Const ? "const" : list.flags & ts.NodeFlags.Let ? "let" : "var";
                const exprText = expr.getText(sf);
                const litOffset = lit.getStart(sf) - expr.getStart(sf);
                const newExpr = exprText.slice(0, litOffset) + retarget.newText + exprText.slice(litOffset + lit.getWidth(sf));
                const lineStart = sf.text.lastIndexOf("\n", stmt.getStart(sf)) + 1;
                const indent = /^[ \t]*/.exec(sf.text.slice(lineStart))[0];
                const end = (ts.getTrailingCommentRanges(sf.text, stmt.getEnd()) ?? []).reduce((e, c) => Math.max(e, c.end), stmt.getEnd());
                changes.push({ span: { start: end, length: 0 }, newText: `\n${indent}${keyword} { ${hit.map((e) => e.getText(sf)).join(", ")} } = ${newExpr};` });
                rewritten.push({ file: project.rel(file), line: lineOf(sf, lit.getStart(sf)) });
                continue;
            }

            // ({ a, b: c } = await import("…"));   — assigning to variables declared elsewhere, e.g. in a `before` hook
            if (ts.isBinaryExpression(site) && site.operatorToken.kind === ts.SyntaxKind.EqualsToken && site.right === expr
                && ts.isObjectLiteralExpression(site.left)) {
                const props = site.left.properties;
                const key = (p) => ((ts.isShorthandPropertyAssignment(p) || ts.isPropertyAssignment(p)) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null);
                const hit = props.filter((p) => moved.has(key(p)));
                if (!hit.length) continue;
                if (props.some((p) => ts.isSpreadAssignment(p))) { note("a rest element takes the module's other members"); continue; }
                if (hit.length === props.length) { changes.push(retarget); rewritten.push({ file: project.rel(file), line: lineOf(sf, lit.getStart(sf)) }); continue; }
                let stmt = site.parent;
                while (ts.isParenthesizedExpression(stmt)) stmt = stmt.parent;
                if (!ts.isExpressionStatement(stmt)) { note("the destructuring assignment is part of a larger expression"); continue; }
                const keep = props.filter((p) => !hit.includes(p));
                changes.push({ span: { start: site.left.getStart(sf), length: site.left.getWidth(sf) }, newText: `{ ${keep.map((p) => p.getText(sf)).join(", ")} }` });
                const exprText = expr.getText(sf);
                const litOffset = lit.getStart(sf) - expr.getStart(sf);
                const newExpr = exprText.slice(0, litOffset) + retarget.newText + exprText.slice(litOffset + lit.getWidth(sf));
                const lineStart = sf.text.lastIndexOf("\n", stmt.getStart(sf)) + 1;
                const indent = /^[ \t]*/.exec(sf.text.slice(lineStart))[0];
                const end = (ts.getTrailingCommentRanges(sf.text, stmt.getEnd()) ?? []).reduce((e, c) => Math.max(e, c.end), stmt.getEnd());
                changes.push({ span: { start: end, length: 0 }, newText: `\n${indent}({ ${hit.map((p) => p.getText(sf)).join(", ")} } = ${newExpr});` });
                rewritten.push({ file: project.rel(file), line: lineOf(sf, lit.getStart(sf)) });
                continue;
            }

            // (await import("…")).name
            if (ts.isPropertyAccessExpression(site) && site.expression === expr) {
                if (moved.has(site.name.text)) { changes.push(retarget); rewritten.push({ file: project.rel(file), line: lineOf(sf, lit.getStart(sf)) }); }
                continue;
            }

            // const M = await import("…"); … M.name …
            if (ts.isVariableDeclaration(site) && site.initializer === expr && ts.isIdentifier(site.name)) {
                const sym = checker.getSymbolAtLocation(site.name);
                const used = new Set();
                let opaque = false;
                const visit = (n) => {
                    if (ts.isIdentifier(n) && n !== site.name && checker.getSymbolAtLocation(n) === sym) {
                        if (ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n) used.add(n.parent.name.text);
                        else opaque = true;
                    }
                    ts.forEachChild(n, visit);
                };
                visit(sf);
                const movedUsed = [...used].filter((u) => moved.has(u));
                if (!movedUsed.length) continue;
                if (!opaque && movedUsed.length === used.size) { changes.push(retarget); rewritten.push({ file: project.rel(file), line: lineOf(sf, lit.getStart(sf)) }); }
                else note(`\`${site.name.text}\` reads ${movedUsed.join(", ")} (moved) and other members of the module`);
                continue;
            }

            // Anything else — `.then((m) => m.x)`, an assignment, an argument. Only worth a look when the file names
            // something that moved at all.
            if ([...moved].some((m) => new RegExp(`\\b${m}\\b`).test(sf.text))) note("the module is used in a way this tool cannot follow");
        }
        if (changes.length) project.apply([{ fileName: file, textChanges: changes, isNewFile: false }]);
    }
    return { rewritten, manual };
}

/**
 * Rewrite `export { a, b } from "<from>"` (and `export * from "<from>"`) so moved names are re-exported from `toAbs`.
 * @param {import("./project.mjs").Project} project
 * @param {string} fromAbs @param {string} toAbs @param {Set<string>} moved
 * @returns {{ file: string, line: number }[]}
 */
export function rewriteReExports(project, fromAbs, toAbs, moved) {
    const program = project.program();
    const out = [];
    for (const sf of program.getSourceFiles()) {
        const file = path.resolve(sf.fileName);
        if (!file.startsWith(project.root + path.sep) || file.includes(`${path.sep}node_modules${path.sep}`) || file === toAbs) continue;
        /** @type {ts.TextChange[]} */
        const changes = [];
        for (const st of sf.statements) {
            if (!ts.isExportDeclaration(st) || !st.moduleSpecifier || !ts.isStringLiteral(st.moduleSpecifier)) continue;
            const resolved = program.getResolvedModuleFromModuleSpecifier(st.moduleSpecifier, sf)?.resolvedModule?.resolvedFileName;
            if (!resolved || path.resolve(resolved) !== fromAbs) continue;
            const lit = st.moduleSpecifier;
            const quote = sf.text[lit.getStart(sf)];
            const spec = `${quote}${specifierFor(file, toAbs, lit.text)}${quote}`;
            const end = (ts.getTrailingCommentRanges(sf.text, st.getEnd()) ?? []).reduce((e, c) => Math.max(e, c.end), st.getEnd());
            const line = { file: project.rel(file), line: lineOf(sf, st.getStart(sf)) };
            if (!st.exportClause) {
                changes.push({ span: { start: end, length: 0 }, newText: `\nexport ${st.isTypeOnly ? "type " : ""}* from ${spec};` });
                out.push(line);
                continue;
            }
            if (!ts.isNamedExports(st.exportClause)) continue;
            const els = st.exportClause.elements;
            const hit = els.filter((e) => moved.has((e.propertyName ?? e.name).text));
            if (!hit.length) continue;
            const typeKw = st.isTypeOnly ? "type " : "";
            if (hit.length === els.length) {
                changes.push({ span: { start: lit.getStart(sf), length: lit.getWidth(sf) }, newText: spec });
            } else {
                changes.push({ span: { start: st.exportClause.getStart(sf), length: st.exportClause.getWidth(sf) }, newText: `{ ${els.filter((e) => !hit.includes(e)).map((e) => e.getText(sf)).join(", ")} }` });
                changes.push({ span: { start: end, length: 0 }, newText: `\nexport ${typeKw}{ ${hit.map((e) => e.getText(sf)).join(", ")} } from ${spec};` });
            }
            out.push(line);
        }
        if (changes.length) project.apply([{ fileName: file, textChanges: changes, isNewFile: false }]);
    }
    return out;
}

/**
 * Delete `const { } = require("…")` / `const {} = await import("…")` — what the refactor leaves behind when it
 * takes every member out of a destructured require.
 * @param {import("./project.mjs").Project} project @param {Iterable<string>} files
 */
export function removeEmptyDestructuring(project, files) {
    for (const f of files) {
        const sf = project.program().getSourceFile(path.resolve(f));
        if (!sf) continue;
        /** @type {ts.TextChange[]} */
        const changes = [];
        const visit = (n) => {
            if (ts.isVariableStatement(n) && n.declarationList.declarations.length === 1) {
                const d = n.declarationList.declarations[0];
                if (ts.isObjectBindingPattern(d.name) && d.name.elements.length === 0 && d.initializer) {
                    let init = d.initializer;
                    while (ts.isAwaitExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
                    const isLoad = ts.isCallExpression(init) && (init.expression.kind === ts.SyntaxKind.ImportKeyword
                        || (ts.isIdentifier(init.expression) && init.expression.text === "require"));
                    if (isLoad) {
                        const start = sf.text.lastIndexOf("\n", n.getStart(sf)) + 1;
                        const lineEnd = sf.text.indexOf("\n", n.getEnd());
                        const onlyThis = sf.text.slice(start, n.getStart(sf)).trim() === "" && sf.text.slice(n.getEnd(), lineEnd < 0 ? undefined : lineEnd).trim() === "";
                        changes.push(onlyThis
                            ? { span: { start, length: (lineEnd < 0 ? sf.text.length : lineEnd + 1) - start }, newText: "" }
                            : { span: { start: n.getStart(sf), length: n.getWidth(sf) }, newText: "" });
                        return;
                    }
                }
            }
            ts.forEachChild(n, visit);
        };
        visit(sf);
        if (changes.length) project.apply([{ fileName: sf.fileName, textChanges: changes, isNewFile: false }]);
    }
}

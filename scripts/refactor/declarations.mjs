// What a set of top-level declarations IS, what it needs, and who else needs it — the analysis half of a move.
//
// Every answer here comes from the checker, never from reading names: a local that shadows a top-level helper is
// not a dependency on it, and `obj.helper` is not a reference to `helper`. That is the whole reason the move tool
// exists instead of a careful copy and paste.
import { ts } from "./project.mjs";

/** A statement that declares nothing movable: an import, an expression, `export default`, an `export {}` list. */
const UNMOVABLE = "unmovable";

/** The names a top-level statement declares, or [] for one that declares none. @param {ts.Statement} st @returns {string[]} */
export function declaredNames(st) {
    if (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st)
        || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) return st.name ? [st.name.text] : [];
    if (ts.isModuleDeclaration(st) && ts.isIdentifier(st.name)) return [st.name.text];
    if (ts.isVariableStatement(st)) return st.declarationList.declarations.flatMap((d) => bindingNames(d.name));
    return [];
}

/** @param {ts.BindingName} name @returns {string[]} */
function bindingNames(name) {
    if (ts.isIdentifier(name)) return [name.text];
    return name.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : bindingNames(e.name)));
}

/** The identifier nodes that declare a statement's names — where find-references starts. @param {ts.Statement} st */
export function nameNodes(st) {
    if (ts.isVariableStatement(st)) {
        const out = [];
        const walk = (n) => { if (ts.isIdentifier(n)) out.push(n); else n.elements.forEach((e) => { if (!ts.isOmittedExpression(e)) walk(e.name); }); };
        st.declarationList.declarations.forEach((d) => walk(d.name));
        return out;
    }
    return st.name && ts.isIdentifier(st.name) ? [st.name] : [];
}

/** A short word for what a statement is, for the plan. @param {ts.Statement} st */
export function kindOf(st) {
    if (ts.isFunctionDeclaration(st)) return "function";
    if (ts.isClassDeclaration(st)) return "class";
    if (ts.isInterfaceDeclaration(st)) return "interface";
    if (ts.isTypeAliasDeclaration(st)) return "type";
    if (ts.isEnumDeclaration(st)) return "enum";
    if (ts.isModuleDeclaration(st)) return "namespace";
    if (ts.isVariableStatement(st)) {
        const f = st.declarationList.flags;
        return f & ts.NodeFlags.Const ? "const" : f & ts.NodeFlags.Let ? "let" : "var";
    }
    return UNMOVABLE;
}

/** Declarations that only exist at type level, so importing them never creates a runtime edge. @param {ts.Statement} st */
export const isTypeOnly = (st) => ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st);

/** @param {ts.Statement} st */
export const isExported = (st) => hasModifier(st, ts.SyntaxKind.ExportKeyword);

/** @param {ts.Node} n @param {ts.SyntaxKind} kind */
export const hasModifier = (n, kind) => !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === kind));

/**
 * Where a statement's text starts once the comments that BELONG to it are included: the JSDoc and any comment lines
 * directly above it. A comment separated from it by a blank line is detached — a file header or a section banner —
 * and stays where it is. (TypeScript's own move takes the whole leading trivia, which is how a file loses its header
 * to whatever happened to be declared first.)
 * @param {ts.SourceFile} sf @param {ts.Statement} st
 */
export function attachedStart(sf, st) {
    const text = sf.text;
    const comments = ts.getLeadingCommentRanges(text, st.getFullStart()) ?? [];
    let start = st.getStart(sf);
    for (let i = comments.length - 1; i >= 0; i--) {
        const c = comments[i];
        if ((text.slice(c.end, start).match(/\n/g) ?? []).length > 1) break;
        start = c.pos;
    }
    return start;
}

/** The end of a statement including a trailing comment on its last line. @param {ts.SourceFile} sf @param {ts.Statement} st */
export function attachedEnd(sf, st) {
    const trailing = ts.getTrailingCommentRanges(sf.text, st.getEnd()) ?? [];
    return trailing.length ? trailing[trailing.length - 1].end : st.getEnd();
}

/**
 * The top-level statements in a file that declare the given names. Overloads, and declarations that merge under one
 * name (an interface and a namespace, a function and a namespace), all come along together — moving one half of a
 * merge would split the declaration.
 * @param {ts.SourceFile} sf @param {string[]} names
 * @returns {{ statements: ts.Statement[], errors: string[] }}
 */
export function findStatements(sf, names) {
    const errors = [];
    const picked = new Set();
    for (const name of names) {
        const hits = sf.statements.filter((st) => declaredNames(st).includes(name));
        if (!hits.length) {
            const imp = sf.statements.find((st) => ts.isImportDeclaration(st) && st.importClause
                && (st.importClause.name?.text === name || (st.importClause.namedBindings && ts.isNamedImports(st.importClause.namedBindings)
                    && st.importClause.namedBindings.elements.some((e) => e.name.text === name))));
            const base = sf.fileName.split("/").pop();
            errors.push(imp ? `\`${name}\` is imported by ${base} from ${/** @type {ts.StringLiteral} */ (/** @type {ts.ImportDeclaration} */ (imp).moduleSpecifier).text}, not declared there — move it from that file`
                : `\`${name}\` is not a top-level declaration in ${base}`);
            continue;
        }
        for (const st of hits) {
            if (hasModifier(st, ts.SyntaxKind.DefaultKeyword)) errors.push(`\`${name}\` is a default export; moving one is not supported`);
            picked.add(st);
        }
    }
    // A statement declaring several names moves as a unit, so every name in it must have been asked for — silently
    // taking a neighbour along is exactly the kind of surprise this tool is meant to remove.
    for (const st of picked) {
        const missing = declaredNames(st).filter((n) => !names.includes(n));
        if (missing.length) errors.push(`\`${declaredNames(st).join(", ")}\` are declared by one statement; name ${missing.map((m) => `\`${m}\``).join(", ")} too`);
    }
    return { statements: sf.statements.filter((st) => picked.has(st)), errors };
}

/**
 * Is this identifier used as a TYPE? A type-position use compiles to nothing, so it never makes an import a
 * runtime edge (esbuild drops an import whose bindings are only used as types).
 * @param {ts.Node} id
 */
export function isTypePosition(id) {
    for (let n = id; n.parent; n = n.parent) {
        const p = n.parent;
        if (ts.isTypeQueryNode(p)) return true;
        if (ts.isHeritageClause(p)) return p.token === ts.SyntaxKind.ImplementsKeyword || ts.isInterfaceDeclaration(p.parent);
        if (ts.isExpressionWithTypeArguments(p)) continue;
        if (ts.isTypeNode(p)) return true;
        if (ts.isStatement(p) || ts.isSourceFile(p)) return false;
    }
    return false;
}

/** The top-level statement a node sits in. @param {ts.Node} n @returns {ts.Statement | undefined} */
export function topLevelStatement(n) {
    let cur = n;
    while (cur.parent && !ts.isSourceFile(cur.parent)) cur = cur.parent;
    return cur.parent ? /** @type {ts.Statement} */ (cur) : undefined;
}

/**
 * The top-level declarations in the SAME file that a set of statements uses, and how: `value` when any use is a
 * value use. Imports are not reported — the refactor carries those over itself.
 * @param {ts.TypeChecker} checker @param {ts.SourceFile} sf @param {Set<ts.Statement>} moving
 * @returns {Map<ts.Statement, { value: boolean, usedBy: Set<string> }>}
 */
export function localDependencies(checker, sf, moving) {
    /** @type {Map<ts.Statement, { value: boolean, usedBy: Set<string> }>} */
    const deps = new Map();
    for (const st of moving) {
        const owner = declaredNames(st)[0];
        const visit = (node) => {
            if (ts.isIdentifier(node)) {
                const sym = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
                    ? checker.getShorthandAssignmentValueSymbol(node.parent)
                    : checker.getSymbolAtLocation(node);
                for (const decl of sym?.declarations ?? []) {
                    if (decl.getSourceFile() !== sf) continue;
                    const top = topLevelStatement(decl);
                    if (!top || moving.has(top) || kindOf(top) === UNMOVABLE) continue;
                    // A declaration's own name is not a use of it.
                    if (nameNodes(top).includes(node)) continue;
                    const entry = deps.get(top) ?? { value: false, usedBy: new Set() };
                    entry.usedBy.add(owner);
                    if (!isTypePosition(node) && !isTypeOnly(top)) entry.value = true;
                    deps.set(top, entry);
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(st);
    }
    return deps;
}

/**
 * Every reference to a statement's names, project-wide, excluding the declarations themselves.
 * @param {ts.LanguageService} ls @param {ts.SourceFile} sf @param {ts.Statement} st
 * @returns {{ fileName: string, start: number, isWrite: boolean }[]}
 */
export function referencesTo(ls, sf, st) {
    const out = [];
    for (const id of nameNodes(st)) {
        for (const group of ls.findReferences(sf.fileName, id.getStart(sf)) ?? []) {
            for (const r of group.references) {
                if (r.isDefinition && r.fileName === sf.fileName && r.textSpan.start === id.getStart(sf)) continue;
                out.push({ fileName: r.fileName, start: r.textSpan.start, isWrite: !!r.isWriteAccess });
            }
        }
    }
    return out;
}

/** Is a reference inside one of these statements? @param {ts.SourceFile} sf @param {{fileName: string, start: number}} ref @param {Set<ts.Statement>} set */
export const referenceInside = (sf, ref, set) => ref.fileName === sf.fileName
    && [...set].some((st) => ref.start >= st.getFullStart() && ref.start < st.getEnd());

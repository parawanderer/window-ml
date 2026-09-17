// The module graph as the BUNDLER sees it: which imports survive compilation, so which ones can form a cycle or
// pull a module into a bundle. A type-only import compiles to nothing and is neither.
import path from "node:path";
import fs from "node:fs";
import { ts } from "./project.mjs";
import { isTypePosition } from "./declarations.mjs";

/** Edge strength, strongest wins when a file imports another more than one way. */
const RANK = { type: 0, dynamic: 1, static: 2 };

/**
 * The resolved project-local imports of one file. `static` survives compilation and is evaluated before the
 * importer; `dynamic` is an `import()`, bundled but lazy, so it cannot form an evaluation cycle; `type` compiles away.
 * With `precise`, a named import counts as `static` only when one of its bindings is used as a VALUE in the file —
 * slower, so it is only asked of the few files a suspected cycle runs through.
 * @param {import("./project.mjs").Project} project @param {ts.SourceFile} sf @param {boolean} [precise]
 * @returns {Map<string, "static"|"dynamic"|"type">}
 */
export function edgesOf(project, sf, precise = false) {
    const program = project.program();
    const checker = program.getTypeChecker();
    const valueUsed = precise ? valueUsedImports(checker, sf) : null;
    /** @type {Map<string, "static"|"dynamic"|"type">} */
    const out = new Map();
    for (const lit of /** @type {any} */ (sf).imports ?? []) {
        const resolved = program.getResolvedModuleFromModuleSpecifier(lit, sf)?.resolvedModule;
        if (!resolved || resolved.isExternalLibraryImport || !resolved.resolvedFileName.startsWith(project.root + path.sep)) continue;
        const target = path.resolve(resolved.resolvedFileName);
        const kind = edgeKind(checker, lit, valueUsed);
        if (!kind) continue;
        if (!out.has(target) || RANK[kind] > RANK[out.get(target)]) out.set(target, kind);
    }
    return out;
}

/** @param {ts.TypeChecker} checker @param {ts.StringLiteralLike} lit @param {Set<ts.Symbol> | null} valueUsed */
function edgeKind(checker, lit, valueUsed) {
    const p = lit.parent;
    if (ts.isImportDeclaration(p)) {
        const clause = p.importClause;
        if (!clause) return "static";                         // `import "./x"` runs it for its side effects
        if (clause.isTypeOnly) return "type";
        const bindings = [];
        if (clause.name) bindings.push(clause.name);
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) bindings.push(clause.namedBindings.name);
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
            for (const el of clause.namedBindings.elements) if (!el.isTypeOnly) bindings.push(el.name);
        }
        const isValue = (id) => {
            const sym = checker.getSymbolAtLocation(id);
            if (!sym) return true;
            if (valueUsed) return valueUsed.has(sym);
            const target = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
            return !!(target.flags & ts.SymbolFlags.Value) || target.flags === 0;
        };
        return bindings.some(isValue) ? "static" : "type";
    }
    if (ts.isExportDeclaration(p)) return p.isTypeOnly ? "type" : "static";
    if (ts.isExternalModuleReference(p)) return "static";
    if (ts.isCallExpression(p)) return p.expression.kind === ts.SyntaxKind.ImportKeyword ? "dynamic" : "static";
    if (ts.isLiteralTypeNode(p)) return "type";              // `import("./x").T`
    return null;
}

/** The import-binding symbols a file uses in a VALUE position. @param {ts.TypeChecker} checker @param {ts.SourceFile} sf */
function valueUsedImports(checker, sf) {
    const used = new Set();
    const visit = (node) => {
        if (ts.isImportDeclaration(node)) return;
        if (ts.isIdentifier(node) && !isTypePosition(node)) {
            const sym = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
                ? checker.getShorthandAssignmentValueSymbol(node.parent)
                : checker.getSymbolAtLocation(node);
            if (sym && sym.flags & ts.SymbolFlags.Alias) used.add(sym);
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return used;
}

/** The whole project's graph. @param {import("./project.mjs").Project} project @returns {Map<string, Map<string, string>>} */
export function projectGraph(project) {
    const graph = new Map();
    for (const sf of project.program().getSourceFiles()) {
        const f = path.resolve(sf.fileName);
        if (!f.startsWith(project.root + path.sep) || f.includes(`${path.sep}node_modules${path.sep}`)) continue;
        graph.set(f, edgesOf(project, sf));
    }
    return graph;
}

/** Strongly connected components over `static` edges (Tarjan). @param {Map<string, Map<string, string>>} graph @returns {string[][]} */
export function cycles(graph) {
    let index = 0;
    const idx = new Map(), low = new Map(), onStack = new Set(), stack = [], out = [];
    const strong = (v) => {
        idx.set(v, index); low.set(v, index); index++;
        stack.push(v); onStack.add(v);
        for (const [w, kind] of graph.get(v) ?? []) {
            if (kind !== "static" || !graph.has(w)) continue;
            if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
            else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
        }
        if (low.get(v) === idx.get(v)) {
            const comp = [];
            let w;
            do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
            if (comp.length > 1) out.push(comp);
        }
    };
    for (const v of graph.keys()) if (!idx.has(v)) strong(v);
    return out;
}

/** One concrete loop through a component, starting and ending at `start`. @param {Map<string, Map<string, string>>} graph @param {string[]} comp @param {string} start */
export function loopThrough(graph, comp, start) {
    const members = new Set(comp);
    const prev = new Map([[start, null]]);
    const queue = [start];
    while (queue.length) {
        const v = queue.shift();
        for (const [w, kind] of graph.get(v) ?? []) {
            if (kind !== "static" || !members.has(w)) continue;
            if (w === start) {
                const pathOut = [start];
                for (let u = v; u !== start; u = prev.get(u)) pathOut.splice(1, 0, u);
                return [...pathOut, start];
            }
            if (!prev.has(w)) { prev.set(w, v); queue.push(w); }
        }
    }
    return [start];
}

/**
 * Import cycles that exist after a change and did not before, confirmed with precise (value-use) edges so that a
 * type-only use of a class cannot report a cycle the bundle would never have.
 * @param {import("./project.mjs").Project} project the project AFTER the change
 * @param {Map<string, Map<string, string>>} before @param {Map<string, Map<string, string>>} after
 * @param {Set<string>} touched absolute paths of files the change edited or created
 * @returns {string[][]} each a loop of absolute paths
 */
export function newCycles(project, before, after, touched) {
    const beforeComp = new Map();
    for (const comp of cycles(before)) for (const f of comp) beforeComp.set(f, comp);
    // A component existed before when every member was already in one and the same component.
    const existed = (comp) => beforeComp.has(comp[0]) && comp.every((f) => beforeComp.get(f) === beforeComp.get(comp[0]));
    const found = [];
    for (const comp of cycles(after)) {
        if (!comp.some((f) => touched.has(f)) || existed(comp)) continue;
        // Re-derive the component's edges precisely and look again.
        const precise = new Map(comp.map((f) => [f, edgesOf(project, project.sourceFile(f), true)]));
        for (const sub of cycles(precise)) {
            if (existed(sub)) continue;
            const start = sub.find((f) => touched.has(f)) ?? sub[0];
            found.push(loopThrough(precise, sub, start));
        }
    }
    return found;
}

/** Files reachable from an entry over static and dynamic edges — what a bundle of it contains. @param {Map<string, Map<string, string>>} graph @param {string} entry */
export function reach(graph, entry) {
    const seen = new Set([entry]);
    const queue = [entry];
    while (queue.length) {
        for (const [w, kind] of graph.get(queue.shift()) ?? []) {
            if (kind === "type" || seen.has(w)) continue;
            seen.add(w); queue.push(w);
        }
    }
    return seen;
}

/** The bundle entry points `build.mjs` declares, as absolute paths keyed by bundle name; empty when there is none. @param {string} root */
export function bundleEntries(root) {
    let text;
    try { text = fs.readFileSync(path.join(root, "build.mjs"), "utf8"); } catch { return new Map(); }
    const block = /const ENTRIES = \{([\s\S]*?)\n\};/.exec(text)?.[1] ?? "";
    const out = new Map();
    for (const m of block.matchAll(/^\s*"?([\w-]+)"?:\s*"([^"]+)"/gm)) out.set(m[1], path.join(root, m[2]));
    return out;
}

// imports.mjs — what a file imports, who imports it, and exactly what crosses between two files.
//
//   node scripts/imports.mjs src/sidebar/vram.tsx          # out-edges and in-edges, with the names on each
//   node scripts/imports.mjs src/sidebar/vram.tsx src/sidebar/resource-chart.tsx   # the coupling, both ways
//   node scripts/imports.mjs --cycles                      # every import cycle in the project
//
// WHY NOT GREP. `grep 'from "./vram"'` answers a different question and gets three things wrong that decide
// whether a refactor is possible. It cannot resolve a specifier, so `./vram` from sidebar/ and `../sidebar/vram`
// from elsewhere look like different modules. It cannot see the inline type query `import("./contract").X`,
// which is a string, and there are roughly a hundred of those here. And it cannot tell a TYPE-only import from a
// value one — the distinction that decides everything, because a type import compiles to nothing and therefore
// cannot form a cycle. This reads the same resolved program the compiler does, through `scripts/refactor/`,
// which move-symbols already uses to refuse a move that would make a cycle.
//
// It exists because splitting a file is blocked by its EDGES, not by its size: three attempts on vram.tsx died
// on cycles, and the question each time was "which names cross, in which direction, and do any of them survive
// compilation". That is the two-file mode.
import path from "node:path";
import { Project, ts } from "./refactor/project.mjs";
import { edgesOf, projectGraph, cycles, loopThrough } from "./refactor/graph.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/** The bindings each project-local import of `sf` brings in, keyed by resolved file. Named separately from
 *  `edgesOf`, which answers only WHICH file and how strongly; a refactor needs the names. */
function bindingsOf(project, sf) {
    const program = project.program();
    const out = new Map();
    for (const lit of sf.imports ?? []) {
        const resolved = program.getResolvedModuleFromModuleSpecifier(lit, sf)?.resolvedModule;
        if (!resolved || resolved.isExternalLibraryImport || !resolved.resolvedFileName.startsWith(project.root + path.sep)) continue;
        const target = path.resolve(resolved.resolvedFileName);
        const rec = out.get(target) ?? { names: new Set(), forms: new Set() };
        const p = lit.parent;
        if (ts.isImportDeclaration(p)) {
            const c = p.importClause;
            if (!c) rec.forms.add("side-effect");
            else {
                if (c.name) rec.names.add(`${c.name.text}(default)`);
                const nb = c.namedBindings;
                if (nb && ts.isNamespaceImport(nb)) rec.names.add(`*as ${nb.name.text}`);
                if (nb && ts.isNamedImports(nb)) {
                    for (const el of nb.elements) rec.names.add((el.isTypeOnly || c.isTypeOnly ? "type:" : "") + el.name.text);
                }
            }
        } else if (ts.isCallExpression(p)) rec.forms.add("import()");
        else if (ts.isLiteralTypeNode(p)) rec.forms.add("import().T");
        else if (ts.isExportDeclaration(p)) rec.forms.add("re-export");
        out.set(target, rec);
    }
    return out;
}

const show = (rec) => [...rec.names].sort().concat([...rec.forms].map((f) => `<${f}>`)).join(" ") || "<none>";

const args = process.argv.slice(2);
const project = new Project(ROOT);
const rel = (f) => project.rel(f);

if (args.includes("--cycles")) {
    // Only STATIC edges can cycle at runtime, which is what `cycles` walks; a type-only loop is not a loop.
    const graph = projectGraph(project);
    const found = cycles(graph);
    if (!found.length) { console.log("no import cycles."); process.exit(0); }
    console.log(`${found.length} cycle(s), over value imports only:`);
    for (const comp of found) {
        const loop = loopThrough(graph, comp, comp[0]) ?? comp;
        console.log(`  ${loop.map(rel).join(" -> ")}`);
    }
    process.exit(0);
}

const files = args.filter((a) => !a.startsWith("--"));
if (!files.length) { console.error("usage: imports.mjs <file> [other-file] | --cycles"); process.exit(2); }

const A = project.abs(files[0]);
const sfA = project.sourceFile(A);

if (files.length >= 2) {
    const B = project.abs(files[1]);
    const sfB = project.sourceFile(B);
    const ab = bindingsOf(project, sfA).get(B), ba = bindingsOf(project, sfB).get(A);
    const kindAB = edgesOf(project, sfA).get(B), kindBA = edgesOf(project, sfB).get(A);
    console.log(`${rel(A)} -> ${rel(B)}\t${kindAB ?? "none"}\t${ab ? show(ab) : "<nothing>"}`);
    console.log(`${rel(B)} -> ${rel(A)}\t${kindBA ?? "none"}\t${ba ? show(ba) : "<nothing>"}`);
    // A pair is only stuck when BOTH directions survive compilation. One type-only side erases, so a cluster can
    // still move; that is the difference between "refactor blocked" and "refactor fine".
    if (kindAB === "static" && kindBA === "static") {
        console.log(`\nMUTUAL, both value imports: one module in two files. A cluster that the other imports AND`);
        console.log(`that itself imports the other cannot move out. Give the shared names a third module first.`);
    } else if (kindAB && kindBA) {
        console.log(`\nMutual, but not both static — the ${kindAB === "static" ? rel(B) : rel(A)} direction erases at build, so this is not a runtime cycle.`);
    }
    process.exit(0);
}

const out = bindingsOf(project, sfA), kinds = edgesOf(project, sfA);
console.log(`# ${rel(A)} imports ${out.size} project file(s)`);
for (const [f, rec] of [...out].sort((x, y) => rel(x[0]).localeCompare(rel(y[0])))) {
    console.log(`out\t${kinds.get(f) ?? "type"}\t${rel(f)}\t${show(rec)}`);
}

// In-edges need the whole program, so this is the slow half; it is also the half that answers "is this safe to
// change", which grep answers only by scanning every file with a guessed path spelling.
const graph = projectGraph(project);
const importers = [...graph].filter(([, e]) => e.has(A)).map(([f]) => f);
console.log(`# ${rel(A)} is imported by ${importers.length} file(s)`);
for (const f of importers.sort((x, y) => rel(x).localeCompare(rel(y)))) {
    const rec = bindingsOf(project, project.sourceFile(f)).get(A);
    console.log(`in\t${graph.get(f).get(A)}\t${rel(f)}\t${rec ? show(rec) : "<none>"}`);
}

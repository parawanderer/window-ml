// gallery-gen.mjs — WHAT THE COMPONENT GALLERY LISTS, derived from the repo rather than kept by hand
// (docs/spec/COMPONENT_GALLERY.md): every exported PascalCase function in a `.tsx` under src/ that the code index
// lists, its props read from the TypeScript checker (aliases, imports and enum-like unions resolved to their members),
// its `@group` and `@gallery` JSDoc tags, and every `*.gallery.ts(x)` custom entry module.
//
//   import { galleryManifest } from "./gallery-gen.mjs";   // scripts/gallery.mjs is the only caller
//
// The props come from the compiler, not the index: the index is a column-0 scan that cannot follow a type through an
// import, and the refactor tools' language service (scripts/refactor/project.mjs) already can.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Project, ts } from "./refactor/project.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

/** How deep an object prop is expanded before it is left as `unknown`: enough for a step or a row, not a whole store. */
const MAX_DEPTH = 3;
/** A union with at most this many members becomes one variant per member, when a component has no examples. */
const MAX_ENUM_VARIANTS = 6;

/** Every component the code index lists: [name, root-relative file, line, summary]. */
function indexedComponents() {
    const out = execFileSync(process.execPath, [path.join(ROOT, "scripts/index.mjs"), "", "--kind", "function", "--exported"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
    const rows = [];
    for (const line of out.split("\n")) {
        const [, name, where, summary] = line.split("\t");
        if (!name || !/^[A-Z]/.test(name) || !/\.tsx:\d+$/.test(where ?? "") || where.startsWith("src/gallery/")) continue;
        const [file, ln] = where.split(":");
        rows.push({ name, file, line: Number(ln), summary: summary === "(undocumented)" ? "" : summary ?? "" });
    }
    return rows;
}

/** Every `*.gallery.ts` / `*.gallery.tsx` under src/, root-relative. */
export function customEntryFiles(dir = path.join(ROOT, "src")) {
    const out = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...customEntryFiles(p));
        else if (/\.gallery\.tsx?$/.test(e.name)) out.push(path.relative(ROOT, p).split(path.sep).join("/"));
    }
    return out.sort();
}

/** A JSDoc block's text with the comment markers and each line's leading `*` removed. */
function jsdocText(node, sf) {
    const ranges = ts.getLeadingCommentRanges(sf.text, node.getFullStart()) ?? [];
    const doc = ranges.map((r) => sf.text.slice(r.pos, r.end)).filter((t) => t.startsWith("/**")).pop();
    if (!doc) return "";
    return doc.slice(3, -2).split("\n").map((l) => l.replace(/^\s*\*\s?/, "")).join("\n");
}

/** The `@tag` blocks of a JSDoc text: [tag, text up to the next tag]. */
function tagsOf(doc) {
    const out = [];
    const re = /(?:^|\n)\s*@(\w+)([\s\S]*?)(?=\n\s*@\w|$)/g;
    for (const m of doc.matchAll(re)) out.push([m[1], m[2].trim()]);
    return out;
}

/**
 * `@group a, b` and `@gallery [name] {json}` from a JSDoc text. A malformed example is kept as an ERROR, not dropped:
 * an example someone wrote that cannot be read is the same broken claim as one that does not render.
 */
export function parseTags(doc) {
    const groups = [], examples = [];
    for (const [tag, text] of tagsOf(doc)) {
        if (tag === "group") groups.push(...text.split(",").map((g) => g.trim()).filter(Boolean));
        if (tag === "gallery") {
            // The name is everything before the first `{` (it may have spaces: "at the bottom"); the JSON is the rest.
            const brace = text.indexOf("{");
            const name = brace > 0 ? text.slice(0, brace).trim() : "";
            const json = brace >= 0 ? text.slice(brace) : text;
            try { examples.push({ name: name || `example ${examples.length + 1}`, props: JSON.parse(json) }); }
            catch (e) { examples.push({ name: name || `example ${examples.length + 1}`, error: `@gallery is not JSON: ${e.message}` }); }
        }
    }
    return { groups, examples };
}

/** Describe a type as a small schema: what the sidebar shows and what the default props are built from. */
export function describe(checker, type, at, depth = 0, seen = new Set()) {
    const text = checker.typeToString(type);
    if (type.aliasSymbol?.name === "ComponentChildren" || /^(ComponentChildren|VNode(<.*>)?|JSX\.Element)$/.test(text)) return { kind: "node", text };
    if (type.isUnion()) {
        const parts = type.types.filter((t) => !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)));
        if (parts.length && parts.every((t) => t.flags & (ts.TypeFlags.BooleanLiteral))) return { kind: "boolean", text };
        if (parts.length && parts.every((t) => t.isLiteral() || t.flags & ts.TypeFlags.BooleanLiteral)) {
            return { kind: "enum", text, members: parts.map((t) => t.isLiteral() ? t.value : t.intrinsicName === "true") };
        }
        if (parts.length === 1) return describe(checker, parts[0], at, depth, seen);
        return { ...describe(checker, parts[0], at, depth, seen), text };
    }
    if (type.flags & ts.TypeFlags.EnumLike && type.isLiteral()) return { kind: "enum", text, members: [type.value] };
    if (type.isLiteral()) return { kind: "enum", text, members: [type.value] };
    if (type.flags & ts.TypeFlags.StringLike) return { kind: "string", text };
    if (type.flags & ts.TypeFlags.NumberLike) return { kind: "number", text };
    if (type.flags & ts.TypeFlags.BooleanLike) return { kind: "boolean", text };
    if (type.getCallSignatures().length) return { kind: "function", text };
    if (checker.isArrayType(type) || checker.isTupleType(type)) {
        const [elem] = checker.getTypeArguments(type);
        return { kind: "array", text, of: elem ? describe(checker, elem, at, depth + 1, seen) : { kind: "unknown", text: "unknown" } };
    }
    if (/^(ReadonlySignal|Signal)</.test(text)) {
        const v = type.getProperty("value");
        return { kind: "signal", text, of: v ? describe(checker, checker.getTypeOfSymbolAtLocation(v, at), at, depth + 1, seen) : { kind: "unknown", text } };
    }
    // A Set or a Map cannot be JSON: the page builds one from an array (a Set) or an object (a Map).
    if (/^(ReadonlySet|Set)</.test(text)) return { kind: "set", text };
    if (/^(ReadonlyMap|Map)</.test(text)) return { kind: "map", text };
    if (type.flags & ts.TypeFlags.Object && depth < MAX_DEPTH && !seen.has(type) && !/^(Map|Set|Date|Promise|HTMLElement|Element|Node|Event|RegExp|Uint8Array|Float\d+Array)\b/.test(text)) {
        const props = checker.getPropertiesOfType(type);
        if (!props.length) return { kind: "object", text, fields: [] };
        const next = new Set(seen).add(type);
        return {
            kind: "object", text,
            fields: props.map((p) => ({
                name: p.name,
                optional: !!(p.flags & ts.SymbolFlags.Optional),
                doc: ts.displayPartsToString(p.getDocumentationComment(checker)).split(/(?<=\.)\s/)[0],
                schema: describe(checker, checker.getTypeOfSymbolAtLocation(p, at), at, depth + 1, next),
            })),
        };
    }
    return { kind: "unknown", text };
}

/** The placeholder value a schema starts from. Functions and signals are left to the page, which builds them. */
export function placeholder(schema, name = "value") {
    switch (schema.kind) {
        case "string": return name;
        case "number": return 1;
        case "boolean": return false;
        case "enum": return schema.members[0];
        case "node": return name;
        case "array": return [placeholder(schema.of, name)];
        case "signal": return placeholder(schema.of, name);
        case "set": return [];
        case "map": return {};
        case "object": {
            const o = {};
            for (const f of schema.fields) if (!f.optional && f.schema.kind !== "function") o[f.name] = placeholder(f.schema, f.name);
            return o;
        }
        default: return null;
    }
}

/** The props a component is first shown with, and its variants: the examples, else one per member of its first
 *  small union, else the inferred placeholder alone. */
function variantsOf(props, examples) {
    const inferred = props.kind === "object" ? placeholder(props) : {};
    if (examples.length) return { inferred, variants: examples.map((e) => ({ name: e.name, props: e.props, error: e.error, source: "example" })) };
    const en = props.kind === "object" && props.fields.find((f) => f.schema.kind === "enum" && f.schema.members.length > 1 && f.schema.members.length <= MAX_ENUM_VARIANTS);
    if (en) return { inferred, variants: en.schema.members.map((m) => ({ name: `${en.name}: ${m}`, props: { ...inferred, [en.name]: m }, source: "inferred" })) };
    return { inferred, variants: [{ name: "inferred", props: inferred, source: "inferred" }] };
}

/** Does a module RUN something at import: a top-level `render(…)`, i.e. a build entry point? Importing one into the
 *  gallery would replace the gallery's own page, so its components are listed but not rendered. */
function rendersAtImport(sf, file) {
    if (entryPoints().has(file)) return true;
    // A backstop for an entry the builds do not name: a top-level statement (not a declaration) that renders or mounts.
    return sf.statements.some((st) => (ts.isExpressionStatement(st) || ts.isIfStatement(st)) && /\b(render|mount)\(|getElementById\(/.test(st.getText(sf)));
}

let entries = null;
/** Every source file a build bundles as an ENTRY (build.mjs, scripts/build-web.mjs): each one runs a page at import. */
function entryPoints() {
    if (entries) return entries;
    entries = new Set();
    for (const f of ["build.mjs", "scripts/build-web.mjs"]) {
        let text = "";
        try { text = readFileSync(path.join(ROOT, f), "utf8"); } catch { continue; }
        for (const m of text.matchAll(/["'](src\/[\w./-]+\.tsx?)["']/g)) entries.add(m[1]);
    }
    return entries;
}

/** The folder a file is in, relative to src/: the group a component falls back to. */
const folderGroup = (file) => path.dirname(file).replace(/^src\/?/, "") || "src";

/**
 * THE MANIFEST: every component and custom entry module. Each component carries its props schema, its variants and
 * its groups; a custom module is only named (its entries are read at run time, in the page or by `gallery.mjs`).
 */
export function galleryManifest({ only } = {}) {
    const project = new Project(ROOT);
    const checker = project.program().getTypeChecker();
    const rows = indexedComponents().filter((r) => !only || only.test(r.name));
    const counts = new Map();
    for (const r of rows) counts.set(r.name, (counts.get(r.name) ?? 0) + 1);
    const components = [];
    for (const r of rows) {
        let sf;
        try { sf = project.sourceFile(r.file); } catch { continue; }
        const decl = sf.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === r.name);
        if (!decl) continue;
        const param = decl.parameters[0];
        const props = param ? describe(checker, checker.getTypeAtLocation(param), param) : { kind: "object", text: "{}", fields: [] };
        const { groups, examples } = parseTags(jsdocText(decl, sf));
        let { inferred, variants } = variantsOf(props, examples);
        if (rendersAtImport(sf, r.file)) {
            const why = `${r.file} renders a page at import (an entry point), so the gallery cannot load it: move ${r.name} into a module of its own to render it here`;
            variants = variants.map((v) => ({ ...v, error: why, source: "inferred" }));
        }
        components.push({
            id: counts.get(r.name) > 1 ? `${r.name}@${path.basename(r.file, ".tsx")}` : r.name,
            kind: "component", name: r.name, file: r.file, line: r.line, summary: r.summary,
            groups: groups.length ? groups : [folderGroup(r.file)],
            tagged: groups.length > 0, props, inferred, variants,
        });
    }
    return { components, custom: customEntryFiles() };
}

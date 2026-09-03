// Generate a language-neutral JSON Schema FROM export-schema.ts.
//
// The TypeScript file is the normative shape of a `.json` run export, but TypeScript is only readable by
// TypeScript. A consumer writing a Python parser (or Go, or a validator in CI) needs the same contract in
// a form their tooling understands, and hand-maintaining a second copy guarantees the two drift. So the
// interfaces are the source and this lifts them.
//
// Output: `docs/spec/export.schema.json`, JSON Schema draft 2020-12. CHECKED IN, unlike `api-docs.gen.ts`
// — a published contract that people link to and generate from cannot be a build artifact that only
// exists on someone's disk. `tests/export-schema.test.mjs` regenerates and diffs it, so an edit to
// export-schema.ts cannot leave the published spec stale.
//
// It's a line scanner, not a real parser, for the same reason gen-api-docs.mjs is: `typescript@7` is the
// Go port and ships no JS compiler API, so a real parse means a second TypeScript in the tree. It leans on
// the house style (top-level `export interface X {`, one member per line, JSDoc above) and THROWS rather
// than silently emitting a partial schema.
//
// EVERY borrowed type is resolved. export-schema.ts references types that live in contract.ts, and those
// reference more; the scanner chases them LAZILY and transitively rather than working from a hand-kept
// list, because such a list goes stale silently — the schema would simply start describing less than it
// claims while still looking complete.
//
// Some of those types are internal and WILL change (a render descriptor gains a variant, an agent option
// is added). They say so themselves, with `@unstable` in the JSDoc above the declaration, which this
// picks up: the shape is still resolved in full — a consumer wants real types for the most interesting
// payload in the document — but it is described as unstable, marked `x-unstable`, and an unstable UNION
// gets a trailing branch that accepts anything, so a variant added tomorrow does not start failing an old
// consumer's validator today. Tagging beats a list here for the same reason: the knowledge lives with the
// type, in the file someone edits when they change it.
//
//   node scripts/gen-export-schema.mjs

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs/spec/export.schema.json");

/** Types borrowed from contract.ts that ARE part of the version promise: resolved and inlined. */
const RESOLVE_FROM_CONTRACT = [
    "TokenUsage", "SubcallUsage", "SubcallUsageByModel", "ToolFeedback", "PersistGrant", "ReusedGrant",
    // Resolved too, though they are OPEN registries (see OPEN_UNIONS). Nobody hand-maintains a second
    // copy of these — the generator reads contract.ts — so leaving them opaque bought nothing and cost a
    // consumer the ability to generate real types for the most interesting payload in the document.
    "DebugAgentConfig", "DebugSessionConfig",
];

/** Appended to an `@unstable` type's description, and to the permissive branch of an unstable union. */
const UNSTABLE_NOTE = "This shape is UNSTABLE: it grows as the extension does and is NOT covered by the schema version. The members here are the ones known when this file was generated — read the ones you recognise and tolerate others.";

/** Strip a JSDoc block to a single-line description. */
function jsdocText(lines) {
    return lines
        .map((l) => l.replace(/^\s*\/\*\*+/, "").replace(/\*+\/\s*$/, "").replace(/^\s*\*ary?/, "").replace(/^\s*\*\s?/, ""))
        .join(" ")
        .replace(/\{@link\s+([^}]+)\}/g, (_, r) => r.split(".").pop())
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Collect `export interface X { … }` blocks from a source file, with each member's JSDoc.
 * Returns a Map of name → { doc, members: [{ name, optional, type, doc }] }.
 */
function scanInterfaces(src, file) {
    const out = new Map();
    const lines = src.split("\n");
    let pending = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Gather a JSDoc block so the member/interface below it can claim it.
        if (/^\s*\/\*\*/.test(line)) {
            pending = [line];
            while (!/\*\//.test(lines[i]) && i < lines.length - 1) pending.push(lines[++i]);
            continue;
        }
        const m = line.match(/^export interface (\w+)(?:<[^>]*>)?\s*(?:extends [\w\s,<>]+)?\{/);
        if (!m) { if (line.trim()) pending = []; continue; }
        const name = m[1];
        const doc = jsdocText(pending);
        pending = [];
        const members = [];

        // A one-line interface — `export interface SubcallUsage { prompt: number; calls: number; }` — is
        // house style too, and several of the borrowed types use it. Its closing brace is on the header
        // line, so the brace-counting walk below would run to EOF looking for it.
        const after = line.slice(line.indexOf("{") + 1);
        if (after.includes("}")) {
            for (const part of after.slice(0, after.lastIndexOf("}")).split(";")) {
                const mm = part.trim().match(/^(\w+)(\?)?:\s*(.+)$/);
                if (mm) members.push({ name: mm[1], optional: !!mm[2], type: mm[3].trim(), doc: "" });
            }
            out.set(name, { doc, members });
            continue;
        }

        let depth = 1, j = i;
        while (depth > 0) {
            if (++j >= lines.length) throw new Error(`${file}: unterminated interface ${name} — the house style (one member per line, closing brace in column 0) must hold for this scanner`);
            const l = lines[j];
            depth += (l.match(/\{/g) || []).length - (l.match(/\}/g) || []).length;
            if (depth <= 0) break;
            if (/^\s*\/\*\*/.test(l)) {
                pending = [l];
                while (!/\*\//.test(lines[j]) && j < lines.length - 1) pending.push(lines[++j]);
                continue;
            }
            if (/^\s*(\/\/|\*)/.test(l) || !l.trim()) continue;
            const mm = l.match(/^\s*([\w$]+)(\?)?:\s*(.+?);\s*(?:\/\/.*)?$/);
            if (!mm) { pending = []; continue; }
            members.push({ name: mm[1], optional: !!mm[2], type: mm[3].trim(), doc: jsdocText(pending) });
            pending = [];
        }
        out.set(name, { doc, members });
        i = j;
    }
    return out;
}

/**
 * Collect `export type X = …;` aliases (single-line only, which is the house style for them).
 * A literal-union alias like `ExportStatus` is where most of the schema's enums come from.
 */
function scanAliases(src) {
    const out = new Map();
    for (const m of src.matchAll(/^export type (\w+)\s*=\s*/gm)) {
        // Scan to the `;` at depth 0. A union of object literals spans many lines and contains `;` inside
        // its members, so stopping at the first one captures a fragment — which then fails as a bad type
        // rather than being read as the union it is.
        let depth = 0, end = -1;
        for (let i = m.index + m[0].length; i < src.length; i++) {
            const ch = src[i];
            // Skip over string literals and comments before counting anything: a bracket inside either is
            // text, not structure, and one stray `)` in a trailing comment sends the depth negative so the
            // terminating `;` is never recognised at depth 0.
            if (ch === '"' || ch === "'" || ch === "`") {
                const quote = ch;
                while (++i < src.length && src[i] !== quote) if (src[i] === "\\") i++;
                continue;
            }
            if (ch === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
            if (ch === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i) + 1; continue; }
            if ("({[".includes(ch)) depth++;
            else if (")}]".includes(ch)) depth--;
            else if (ch === ";" && depth === 0) { end = i; break; }
        }
        if (end < 0) throw new Error(`gen-export-schema: unterminated type alias ${m[1]}`);
        // Strip line comments: a `//` note inside a union variant is documentation, not syntax.
        const body = src.slice(m.index + m[0].length, end).replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ").trim();
        out.set(m[1], body);
    }
    return out;
}

/**
 * Types the source itself marks as UNSTABLE, by carrying `@unstable` in the JSDoc above the declaration.
 *
 * The knowledge that a shape will grow belongs with the shape, not in a list inside this generator: a
 * denylist here goes stale the moment someone adds an open registry, and silently — the schema would
 * simply start claiming a closed shape. Tagging is self-declaring, and greppable from the type's own file.
 */
function scanUnstable(src) {
    const out = new Set();
    for (const m of src.matchAll(/\/\*\*[\s\S]*?\*\/\s*\nexport (?:interface|type) (\w+)/g)) {
        if (/@unstable/.test(m[0])) out.add(m[1]);
    }
    return out;
}

/**
 * Split on a top-level delimiter, ignoring anything nested in (), {}, [] or <>.
 * `t.split("|")` tears `(string | number)[][]` in half and produces nonsense.
 */
function splitTop(t, delim) {
    const parts = [];
    let depth = 0, cur = "";
    for (const ch of t) {
        // `<`/`>` deliberately excluded: `=>` in a function type would unbalance them, and a generic
        // never contains a top-level `|` or `;` that matters here.
        if ("({[".includes(ch)) depth++;
        else if (")}]".includes(ch)) depth--;
        if (ch === delim && depth === 0) { parts.push(cur); cur = ""; continue; }
        cur += ch;
    }
    parts.push(cur);
    return parts.map((x) => x.trim()).filter(Boolean);
}

/** Parse an inline object literal body — `a: string; b?: number` — into members. */
function inlineMembers(body) {
    return splitTop(body, ";").map((part) => {
        const m = part.match(/^(\w+)(\?)?:\s*([\s\S]+)$/);
        if (!m) throw new Error(`gen-export-schema: cannot read inline member \`${part}\``);
        return { name: m[1], optional: !!m[2], type: m[3].trim(), doc: "" };
    });
}

/** Map one TypeScript type expression to a JSON Schema node. */
function typeToSchema(type, ctx) {
    const t = type.trim();

    // A parenthesised group is just grouping: `(string | number)[]` is an array of that union.
    if (/^\(.*\)$/.test(t) && splitTop(t.slice(1, -1), ")").length >= 1 && depthBalanced(t.slice(1, -1))) {
        return typeToSchema(t.slice(1, -1), ctx);
    }

    // An inline object literal — a union variant, or a `tools: { name: string }[]` member.
    if (/^\{[\s\S]*\}$/.test(t)) {
        return interfaceToSchema("(inline)", { doc: "", members: inlineMembers(t.slice(1, -1).trim().replace(/;\s*$/, "")) }, ctx);
    }

    // A union of string literals is an enum — the most useful thing the scanner can recognise.
    const literals = splitTop(t, "|");
    if (literals.length > 1 && literals.every((x) => /^"[^"]*"$/.test(x))) {
        return { type: "string", enum: literals.map((x) => x.slice(1, -1)) };
    }
    // `X | undefined` / `X | null`: unwrap, but keep null as a permitted value.
    const nullable = literals.includes("null");
    const bare = literals.filter((x) => x !== "null" && x !== "undefined");
    if (nullable && bare.length === 1) {
        const inner = typeToSchema(bare[0], ctx);
        return inner.type ? { ...inner, type: [inner.type, "null"] } : inner;
    }
    if (literals.length > 1 && bare.length > 1) {
        const branches = bare.map((x) => typeToSchema(x, ctx));
        // An UNSTABLE union gets one more branch that accepts anything. Without it, `anyOf` over the
        // variants known today REJECTS a variant added tomorrow — so an old consumer's validator would
        // start failing on new exports, which is the opposite of what a published schema should do.
        //
        // A union is only as pinned as its members, so an inline union of unstable types counts too, not
        // just a tagged alias: `DebugSessionConfig | DebugAgentConfig` names two shapes that both grow.
        const anyUnstable = ctx.unstableUnion || bare.some((x) => ctx.unstable.has(x.trim()));
        if (anyUnstable) branches.push({ type: "object", description: UNSTABLE_NOTE });
        return { anyOf: branches };
    }

    // ARRAY before TUPLE: `[number, number][]` is an array OF tuples, and a tuple pattern anchored on the
    // outer brackets matches it too — capturing the nonsense `number][` as the element type.
    const arr = t.match(/^(?:readonly\s+)?(.+?)\[\]$/);
    if (arr) return { type: "array", items: typeToSchema(arr[1], ctx) };
    const tuple = t.match(/^\[(.+)\]$/);
    if (tuple) {
        const parts = tuple[1].split(",").map((x) => x.trim());
        return { type: "array", prefixItems: parts.map((x) => typeToSchema(x, ctx)), minItems: parts.length, maxItems: parts.length };
    }

    // A lone string literal is a discriminator (`kind: "fetch-url"`), so it becomes a const.
    if (/^"[^"]*"$/.test(t)) return { type: "string", const: t.slice(1, -1) };
    if (t === "string") return { type: "string" };
    if (t === "number") return { type: "number" };
    if (t === "boolean") return { type: "boolean" };
    if (t === "unknown" || t === "unknown[]" || t === "any") return {};
    if (/^Record<string,\s*unknown>$/.test(t)) return { type: "object", additionalProperties: true };
    if (t === "IsoTimestamp") return { type: "string", format: "date-time" };

    // An indexed access — `FetchAttempt["strategy"]` — is that member's own type.
    const indexed = t.match(/^(\w+)\[\s*"([^"]+)"\s*\]$/);
    if (indexed) {
        const owner = ctx.ifaces.get(indexed[1]);
        const member = owner?.members.find((x) => x.name === indexed[2]);
        if (!member) throw new Error(`gen-export-schema: \`${t}\` names no such member`);
        return typeToSchema(member.type, ctx);
    }

    // A named type resolves LAZILY and transitively: emit a $ref, and generate the definition the first
    // time it is asked for. A hand-kept list of "types to resolve" would go stale silently — the schema
    // would just start describing less than it claims — and every borrowed type drags in its own.
    if (ctx.ifaces.has(t)) {
        if (!(t in ctx.defs)) {
            ctx.defs[t] = {};   // placeholder first, so a self-referential type terminates
            ctx.defs[t] = interfaceToSchema(t, ctx.ifaces.get(t), ctx);
        }
        return { $ref: `#/$defs/${t}` };
    }
    // A type alias resolves to whatever it names. Guarded against a cycle, which would otherwise be a
    // stack overflow rather than a message.
    if (ctx.aliases.has(t)) {
        if (ctx.resolving.has(t)) throw new Error(`gen-export-schema: type alias \`${t}\` is cyclic`);
        ctx.resolving.add(t);
        const wasUnstable = ctx.unstableUnion;
        ctx.unstableUnion = ctx.unstable.has(t);
        try {
            const node = typeToSchema(ctx.aliases.get(t), ctx);
            return ctx.unstable.has(t) ? { description: UNSTABLE_NOTE, ...node } : node;
        } finally { ctx.resolving.delete(t); ctx.unstableUnion = wasUnstable; }
    }

    // An unrecognised named type would silently become "anything", which is how a generated schema stops
    // describing the thing it claims to. Refuse instead.
    throw new Error(`gen-export-schema: unhandled type \`${t}\` — teach typeToSchema() to map it, or simplify the declaration`);
}

/** Are all brackets balanced across this string? (A `)` closing an outer group would go negative.) */
function depthBalanced(t) {
    let depth = 0;
    for (const ch of t) {
        if ("({[".includes(ch)) depth++;
        else if (")}]".includes(ch)) depth--;
        if (depth < 0) return false;
    }
    return depth === 0;
}

/** One interface → a JSON Schema object node. */
function interfaceToSchema(name, iface, ctx) {
    const properties = {};
    const required = [];
    for (const m of iface.members) {
        const node = typeToSchema(m.type, ctx);
        properties[m.name] = m.doc ? { description: m.doc, ...node } : node;
        if (!m.optional) required.push(m.name);
    }
    const unstable = ctx.unstable.has(name);
    const doc = [iface.doc, unstable ? UNSTABLE_NOTE : ""].filter(Boolean).join(" ");
    return {
        type: "object",
        ...(doc ? { description: doc } : {}),
        ...(unstable ? { "x-unstable": true } : {}),
        properties,
        ...(required.length ? { required } : {}),
        // Additive changes are free by the version rule, so an older consumer must tolerate new fields.
        additionalProperties: true,
    };
}

/** Build the whole document. Exported so the test can regenerate without shelling out. */
export function buildSchema() {
    const schemaSrc = readFileSync(join(ROOT, "export-schema.ts"), "utf8");
    const contractSrc = readFileSync(join(ROOT, "contract.ts"), "utf8");

    const own = scanInterfaces(schemaSrc, "export-schema.ts");
    if (!own.has("ExportDocument")) throw new Error("gen-export-schema: export-schema.ts no longer declares ExportDocument");
    const contract = scanInterfaces(contractSrc, "contract.ts");

    const version = (schemaSrc.match(/EXPORT_SCHEMA_VERSION\s*=\s*(\d+)/) || [])[1];
    if (!version) throw new Error("gen-export-schema: EXPORT_SCHEMA_VERSION not found");

    const ctx = {
        // export-schema.ts wins a name clash: it is the normative file.
        ifaces: new Map([...contract, ...own]),
        aliases: new Map([...scanAliases(contractSrc), ...scanAliases(schemaSrc)]),
        unstable: new Set([...scanUnstable(contractSrc), ...scanUnstable(schemaSrc)]),
        resolving: new Set(),
        defs: {},
    };
    const root = interfaceToSchema("ExportDocument", own.get("ExportDocument"), ctx);
    const $defs = ctx.defs;
    delete $defs.ExportDocument;
    return {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "https://raw.githubusercontent.com/parawanderer/window-ml/main/docs/spec/export.schema.json",
        title: "window.ml run export",
        description: `A window.ml session export, schema version ${version}. GENERATED from export-schema.ts by scripts/gen-export-schema.mjs — do not edit by hand. The TypeScript file is normative; this is its language-neutral twin, for writing a parser or generating models in another language.`,
        "x-schemaVersion": Number(version),
        ...root,
        $defs,
    };
}

export function writeSchema() {
    const doc = buildSchema();
    const text = JSON.stringify(doc, null, 2) + "\n";
    mkdirSync(dirname(OUT), { recursive: true });
    let prev = "";
    try { prev = readFileSync(OUT, "utf8"); } catch { /* first run */ }
    if (prev !== text) writeFileSync(OUT, text);   // rewrite only on change, so --watch doesn't self-trigger
    return text;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    writeSchema();
    console.log(`wrote ${OUT.replace(ROOT + "/", "")}`);
}

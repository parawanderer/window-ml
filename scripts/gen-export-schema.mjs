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
// THE CONTRACT BOUNDARY IS ENCODED HERE. export-schema.ts borrows types from contract.ts, which carries no
// versioning promise of its own. Those inside the promise (TokenUsage, SubcallUsage, ToolFeedback, the
// grants) are resolved from contract.ts and inlined, so a consumer gets their real shape. The three that
// are deliberately OPEN — renderIn, renderOut, config — are emitted as permissive objects with a
// description saying so, because pinning them would either freeze the debug UI or force a version bump
// for a change no consumer cares about.
//
//   node scripts/gen-export-schema.mjs

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs/spec/export.schema.json");

/** Types borrowed from contract.ts that ARE part of the version promise: resolved and inlined. */
const RESOLVE_FROM_CONTRACT = ["TokenUsage", "SubcallUsage", "SubcallUsageByModel", "ToolFeedback", "PersistGrant", "ReusedGrant"];

/**
 * Fields whose type is deliberately open. Emitted as a permissive object rather than a resolved shape —
 * see the boundary note above. The value is the description a consumer reads.
 */
const OPEN_TYPES = {
    RenderDescriptor: "A visualisation payload, keyed by its `type` field. This is an OPEN registry that grows whenever the debug UI learns to draw something new, so it is NOT covered by the schema version. Switch on `type` and ignore what you do not recognise.",
    DebugAgentConfig: "The options the agent run was created with. Grows whenever `ml.agent` gains an option, so it is NOT covered by the schema version. Read the keys you know.",
    DebugSessionConfig: "The options the chat session was created with. Not covered by the schema version.",
};

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
            const mm = l.match(/^\s*(\w+)(\?)?:\s*(.+?);\s*(?:\/\/.*)?$/);
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
    for (const m of src.matchAll(/^export type (\w+)\s*=\s*([^;]+);/gm)) out.set(m[1], m[2].trim());
    return out;
}

/** Map one TypeScript type expression to a JSON Schema node. */
function typeToSchema(type, ctx) {
    const t = type.trim();

    // A union of string literals is an enum — the most useful thing the scanner can recognise.
    const literals = t.split("|").map((x) => x.trim());
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
        return { anyOf: bare.map((x) => typeToSchema(x, ctx)) };
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

    if (OPEN_TYPES[t]) return { type: "object", additionalProperties: true, description: OPEN_TYPES[t] };
    if (ctx.known.has(t)) return { $ref: `#/$defs/${t}` };
    // A type alias resolves to whatever it names. Guarded against a cycle, which would otherwise be a
    // stack overflow rather than a message.
    if (ctx.aliases.has(t)) {
        if (ctx.resolving.has(t)) throw new Error(`gen-export-schema: type alias \`${t}\` is cyclic`);
        ctx.resolving.add(t);
        try { return typeToSchema(ctx.aliases.get(t), ctx); } finally { ctx.resolving.delete(t); }
    }

    // An unrecognised named type would silently become "anything", which is how a generated schema stops
    // describing the thing it claims to. Refuse instead.
    throw new Error(`gen-export-schema: unhandled type \`${t}\` — add it to RESOLVE_FROM_CONTRACT, OPEN_TYPES, or typeToSchema()`);
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
    return {
        type: "object",
        ...(iface.doc ? { description: iface.doc } : {}),
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

    const defs = new Map(own);
    for (const n of RESOLVE_FROM_CONTRACT) {
        const iface = contract.get(n);
        if (!iface) throw new Error(`gen-export-schema: ${n} is in RESOLVE_FROM_CONTRACT but contract.ts no longer declares it`);
        defs.set(n, iface);
    }

    const version = (schemaSrc.match(/EXPORT_SCHEMA_VERSION\s*=\s*(\d+)/) || [])[1];
    if (!version) throw new Error("gen-export-schema: EXPORT_SCHEMA_VERSION not found");

    const aliases = new Map([...scanAliases(contractSrc), ...scanAliases(schemaSrc)]);
    const ctx = { known: new Set(defs.keys()), aliases, resolving: new Set() };
    const $defs = {};
    for (const [n, iface] of defs) if (n !== "ExportDocument") $defs[n] = interfaceToSchema(n, iface, ctx);

    const root = interfaceToSchema("ExportDocument", defs.get("ExportDocument"), ctx);
    return {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "https://github.com/parawanderer/window-ml/blob/main/docs/spec/export.schema.json",
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

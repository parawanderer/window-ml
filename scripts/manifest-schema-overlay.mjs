// manifest-schema-overlay.mjs — the rules of `validateManifest` that program-manifest.ts's TYPES cannot state, laid over the schema scripts/gen-export-schema.mjs generates from them.

// The types give the fields, their JSDoc, the enums and which keys exist. They cannot say "a flag name starts with
// -", "a script's sha256 is 64 hex digits" or "a runner's effects include runs-code", which `validateManifest`
// enforces. Each is restated here as JSON Schema where JSON Schema can say it. The validator stays the AUTHORITY: this
// is the editor's view of it, and tests/manifest-schemas.test.mjs holds the two to each other and names every rule
// that has no schema form.
//
// Every patch THROWS when the node it patches is not where it expects, so a renamed field in the types fails the
// generator instead of silently dropping its rule from the schema.

const RUNS_OTHER_CODE = ["runs-code", "unknown"];
const COMPARATOR = String.raw`(?:>=|<=|>|<|=)?\d+(?:\.\d+)*`;
const SEGMENT = String.raw`(?!\.\.?(?:/|$))[^/]+`;

/** The node at `path` (dotted, `$defs.X.properties.y`), or a throw naming the step that is missing. */
function at(doc, path) {
    let n = doc;
    for (const step of path.split(".")) {
        if (n === null || typeof n !== "object" || !(step in n)) throw new Error(`manifest-schema-overlay: ${path} is not in the generated schema (stopped at ${step}) — the types changed, update the overlay`);
        n = n[step];
    }
    return n;
}

/** Merge `extra` into the node at `path`. */
function patch(doc, path, extra) { Object.assign(at(doc, path), extra); }

/** Every `anyOf` whose branches include several lone string consts gets them as one `enum`: a pick list, not five alternatives. */
function collapseConsts(n) {
    if (Array.isArray(n)) return n.map(collapseConsts);
    if (n === null || typeof n !== "object") return n;
    const out = Object.fromEntries(Object.entries(n).map(([k, v]) => [k, collapseConsts(v)]));
    if (Array.isArray(out.anyOf)) {
        const isConst = (b) => b.type === "string" && "const" in b && Object.keys(b).length === 2;
        const consts = out.anyOf.filter(isConst);
        if (consts.length > 1) out.anyOf = [{ type: "string", enum: consts.map((b) => b.const) }, ...out.anyOf.filter((b) => !isConst(b))];
    }
    return out;
}

/** Every subtree deep-equal to `shape` becomes a `$ref` (a type alias is inlined at each use by the generator). */
function hoist(n, shape, ref) {
    const key = JSON.stringify(shape);
    const walk = (x) => {
        if (JSON.stringify(x) === key) return { $ref: ref };
        if (Array.isArray(x)) return x.map(walk);
        if (x === null || typeof x !== "object") return x;
        return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v)]));
    };
    return walk(n);
}

const exitCodes = { type: "integer", minimum: 0, maximum: 255 };

/**
 * The finished program-manifest schema from the generated one (`ManifestBase & (version-variant | entrypoint-variant)`,
 * the types' members, closed).
 */
export function refineProgramManifest(gen) {
    let doc = structuredClone(gen);

    // Flatten the intersection: closed objects in an allOf reject each other's members, so ManifestBase and the two
    // variants become ONE closed object with exactly one of version/entrypoint.
    const [baseRef, variants] = doc.allOf ?? [];
    if (baseRef?.$ref !== "#/$defs/ManifestBase" || variants?.anyOf?.length !== 2) throw new Error("manifest-schema-overlay: ProgramManifest is no longer ManifestBase & (version | entrypoint) — update the overlay");
    const base = at(doc, "$defs.ManifestBase");
    const [withVersion, withEntry] = variants.anyOf;
    const { allOf: _a, $defs: defs, ...head } = doc;
    delete defs.ManifestBase;
    doc = {
        ...head,
        type: "object",
        properties: {
            ...base.properties,
            // The variants are inline in the type and carry no JSDoc of their own, so these two say it here.
            version: { description: "A standalone binary's pin: the version range the manifest was written against, and how the host reads the program's version. Exclusive with `entrypoint`.", ...withVersion.properties.version },
            entrypoint: { description: "An interpreted script's pin: its path under a workspace root and the sha256 of the resolved file; `program` is then the interpreter. Exclusive with `version`.", ...withEntry.properties.entrypoint },
        },
        required: base.required,
        additionalProperties: false,
        // A binary is pinned by `version`, a script by `entrypoint`: never both, never neither.
        oneOf: [{ required: ["version"], not: { required: ["entrypoint"] } }, { required: ["entrypoint"], not: { required: ["version"] } }],
        $defs: defs,
    };

    // The effect vocabulary becomes one definition.
    doc = collapseConsts(doc);
    const effect = at(doc, "$defs.FlagSpec.properties.effects.items");
    doc = hoist(doc, effect, "#/$defs/ProgramEffect");
    doc.$defs.ProgramEffect = { description: "A program manifest's effect term: what a command, flag or primary does to its path targets (docs/spec/PROGRAM_MANIFEST.md).", ...effect };

    patch(doc, "properties.program", { pattern: "^[A-Za-z0-9._+-]+$" });
    patch(doc, "properties.okCodes", { items: exitCodes });
    patch(doc, "$defs.CommandSpec.properties.okCodes", { items: exitCodes });
    patch(doc, "$defs.FlagSpec.properties.okCodes", { items: exitCodes });
    patch(doc, "$defs.CommandSpec.properties.maxOperands", { type: "integer", minimum: 0 });
    patch(doc, "$defs.CommandSpec.properties.paths.anyOf.1.properties.operandsFrom", { type: "integer" });
    patch(doc, "$defs.FlagSpec.properties.pathsFrom", { type: "integer", minimum: 0 });
    patch(doc, "$defs.PrimarySpec.properties.args", { type: "integer", minimum: 0 });

    // A flag's name starts with - or --.
    patch(doc, "$defs.CommandSpec.properties.flags", { propertyNames: { pattern: "^-{1,2}[A-Za-z0-9][A-Za-z0-9-]*$" } });

    // `syntax: "find"` needs its primaries, and primaries need `syntax: "find"`.
    patch(doc, "$defs.CommandSpec", {
        allOf: [{ if: { required: ["syntax"] }, then: { required: ["primaries"] }, else: { not: { required: ["primaries"] } } }],
    });

    patch(doc, "$defs.FlagSpec", {
        allOf: [
            { not: { required: ["value", "optionalValue"], properties: { value: { const: true }, optionalValue: { const: true } } } },
            // A path or directory value needs `value: true`.
            { if: { anyOf: [{ required: ["valueIsPath"] }, { required: ["valueIsDir"], properties: { valueIsDir: { const: true } } }] },
              then: { required: ["value"], properties: { value: { const: true } } } },
            // A runner starts another program, so its effects say so.
            { if: { required: ["runner"], properties: { runner: { const: true } } },
              then: { required: ["effects"], properties: { effects: { contains: { enum: RUNS_OTHER_CODE } } } } },
        ],
    });

    patch(doc, "$defs.PrimarySpec", {
        allOf: [
            { if: { required: ["argIsPath"] }, then: { required: ["args"], properties: { args: { minimum: 1 } } } },
            { if: { required: ["runner"], properties: { runner: { const: true } } },
              then: { required: ["effects"], properties: { effects: { contains: { enum: RUNS_OTHER_CODE } } } } },
        ],
    });

    // The version: a range of comparators with the args and pattern that read it, or `"*"` which reads nothing.
    patch(doc, "$defs.ManifestVersion.properties.pattern", { format: "regex" });
    patch(doc, "$defs.ManifestVersion", {
        allOf: [
            { if: { required: ["range"], properties: { range: { const: "*" } } },
              then: { properties: { args: { maxItems: 0 }, pattern: { maxLength: 0 } } },
              else: { properties: { range: { pattern: `^\\s*${COMPARATOR}(?:\\s+${COMPARATOR})*\\s*$` }, args: { minItems: 1 }, pattern: { minLength: 1 } } } },
        ],
    });

    // The entrypoint: a relative path with no `.`, `..` or empty segment and no leading `-`; a sha256 in lowercase hex.
    patch(doc, "$defs.ManifestEntrypoint.properties.path", { pattern: `^(?![/-])${SEGMENT}(?:/${SEGMENT})*$` });
    patch(doc, "$defs.ManifestEntrypoint.properties.sha256", { pattern: "^[0-9a-f]{64}$" });
    return doc;
}

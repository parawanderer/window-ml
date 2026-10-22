// manifest-schemas.test.mjs — the two JSON Schemas for hand-edited manifests (docs/spec/program-manifest.schema.json, generated; docs/spec/library-manifest.schema.json, hand-maintained): fresh, every shipped manifest conforms, and the schema agrees with `validateManifest`, the authority, on an enumerated set of invalid manifests, with every rule it cannot state named.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildSchema } from "../scripts/gen-export-schema.mjs";
import { validateSchema } from "./helpers-jsonschema.mjs";

const { describeCall, hardenArgv, validateManifest } = await import("../src/shell/program-manifest.ts");

const here = (p) => new URL(`../${p}`, import.meta.url);
const readJson = (u) => JSON.parse(fs.readFileSync(u, "utf8"));
const PROGRAM_SCHEMA = readJson(here("docs/spec/program-manifest.schema.json"));
const LIBRARY_SCHEMA = readJson(here("docs/spec/library-manifest.schema.json"));
const MANIFESTS = here("src/shell/manifests/");
const programs = Object.fromEntries(fs.readdirSync(MANIFESTS).filter((f) => f.endsWith(".json")).map((f) => [path.basename(f, ".json"), readJson(new URL(f, MANIFESTS))]));
const FIXTURES = here("tests/fixtures/program-calls/");
const LIB_DIR = here("notebooks/python-dialect/data/");
const libraries = Object.fromEntries(["stdlib", "numpy", "pandas", "pil"].map((n) => [n, readJson(new URL(`manifest-${n}.json`, LIB_DIR))]));

const bySchema = (m) => validateSchema(m, PROGRAM_SCHEMA);

// --- the schema is generated, and fresh ---

test("docs/spec/program-manifest.schema.json is what the generator produces from program-manifest.ts", () => {
    assert.deepEqual(PROGRAM_SCHEMA, buildSchema("program-manifest"), "stale: run `node scripts/gen-export-schema.mjs`");
});

test("the generated schema carries each field's JSDoc as its description", () => {
    const { $defs: d } = PROGRAM_SCHEMA;
    assert.match(d.FlagSpec.properties.runner.description, /starts another program/);
    assert.match(d.CommandSpec.properties.repoWide.description, /anything in its repository/);
    for (const k of ["optionsFirst", "dashIsPath", "repoWide", "pathspecs"]) assert.ok(d.CommandSpec.properties[k], `${k} is described`);
    assert.match(PROGRAM_SCHEMA.properties.program.description, /basename/);
    // Every member of a declared type says what it is for: a field added without a JSDoc line shows up here. (Inline
    // object types in effects.ts, and the keywords the overlay adds, are not declared members.)
    const bare = [];
    for (const [name, def] of Object.entries(d)) if (name !== "ProgramEffect") for (const [k, v] of Object.entries(def.properties ?? {})) if (!v.description) bare.push(`${name}.${k}`);
    for (const [k, v] of Object.entries(PROGRAM_SCHEMA.properties)) if (!v.description) bare.push(`$.${k}`);
    assert.deepEqual(bare, [], "undocumented fields (add the JSDoc line in program-manifest.ts)");
});

// --- every shipped manifest conforms, under both ---

test("every shipped program manifest validates under the schema AND under validateManifest", () => {
    assert.ok(Object.keys(programs).length >= 13);
    for (const [name, m] of Object.entries(programs)) {
        assert.deepEqual(bySchema(m), [], `${name} under the schema`);
        assert.deepEqual(validateManifest(m), [], `${name} under validateManifest`);
    }
});

test("every shipped library manifest validates under the library schema", () => {
    for (const [name, m] of Object.entries(libraries)) assert.deepEqual(validateSchema(m, LIBRARY_SCHEMA), [], name);
});

test("a library manifest admits a name only with its row, and carries no row nobody lists", () => {
    for (const [name, m] of Object.entries(libraries)) {
        const listed = new Set();
        for (const f of m.functions ?? []) listed.add(`${m.module}.${f}`);
        for (const [mod, fns] of Object.entries(m.modules ?? {})) for (const f of fns) listed.add(`${mod}.${f}`);
        for (const [kind, ms] of Object.entries(m.kinds)) for (const f of ms) listed.add(`${kind}.${f}`);
        const rows = new Set(Object.keys(m.leaves));
        // The stdlib file lists `PIL: [Image.open]` on purpose: the fork's `load_manifests` admits PIL's names from the
        // stdlib file's `modules` and never reads manifest-pil.json, whose row is the evidence for it (ruled 2026-10-22).
        if (name === "stdlib") for (const x of ["PIL.Image.open"]) { listed.delete(x); assert.ok(libraries.pil.leaves[x], `${x} has its row in manifest-pil.json`); }
        // PIL's Image functions are listed as `Image.open` and keyed `PIL.Image.open`; its kinds as `Image.save`.
        assert.deepEqual([...listed].filter((x) => !rows.has(x)), [], `${name}: listed without a row`);
        // A row nobody lists is evidence for nothing, and reads as if the name were admitted (the `csv.writer` row, removed
        // 2026-10-22, said `pure` of a writer).
        assert.deepEqual([...rows].filter((x) => !listed.has(x)), [], `${name}: a row nobody lists`);
    }
});

// --- the library schema rejects what its consumer would (enumerated) ---

test("the library schema rejects a malformed library manifest, one rule each", () => {
    const base = () => structuredClone(libraries.numpy);
    const bad = {
        "unknown top-level key": (m) => { m.extra = 1; },
        "no leaves": (m) => { delete m.leaves; },
        "no kinds": (m) => { delete m.kinds; },
        "neither module nor modules": (m) => { delete m.module; },
        "module and modules": (m) => { m.modules = {}; },
        "a library layout without functions": (m) => { delete m.functions; },
        "a library layout without a version": (m) => { delete m.version_counted_against; },
        "a row without its cost": (m) => { delete m.leaves["numpy.sum"].cost; },
        "a row without effects": (m) => { delete m.leaves["numpy.sum"].effects; },
        "an effect no term leads": (m) => { m.leaves["numpy.sum"].effects = "harmless"; },
        "a return no marking leads": (m) => { m.leaves["numpy.sum"].returns = "a number"; },
        "a row key nobody could import": (m) => { m.leaves["numpy sum"] = m.leaves["numpy.sum"]; },
        "an unknown row key": (m) => { m.leaves["numpy.sum"].pure = true; },
        "functions that are not names": (m) => { m.functions = [1]; },
        "min_cells not an integer": (m) => { m.min_cells = 1.5; },
        "a $schema that is not a string": (m) => { m.$schema = 1; },
    };
    assert.deepEqual(validateSchema(base(), LIBRARY_SCHEMA), []);
    for (const [name, mut] of Object.entries(bad)) { const m = base(); mut(m); assert.notDeepEqual(validateSchema(m, LIBRARY_SCHEMA), [], name); }
    const ok = base(); ok.$schema = "../../../docs/spec/library-manifest.schema.json";
    assert.deepEqual(validateSchema(ok, LIBRARY_SCHEMA), [], "a $schema hint is accepted");
    const std = structuredClone(libraries.stdlib); delete std.modules;
    assert.notDeepEqual(validateSchema(std, LIBRARY_SCHEMA), [], "the stdlib layout needs modules");
});

// --- agreement: invalid manifests both reject ---

const BIN = () => ({
    program: "x", version: { range: ">=1 <2", args: ["--version"], pattern: "(\\d+)" },
    command: {
        effects: ["read"], paths: "operands", flags: { "-v": {}, "--out": { value: true, valueIsPath: "write", effects: ["write"] } },
        subcommands: { sub: { effects: ["read"], paths: "repo", flags: { "-x": {} } } },
    },
});
const FIND = () => ({
    program: "find", version: { range: "*", args: [], pattern: "" },
    command: { effects: ["read"], paths: "operands", syntax: "find", flags: { "-L": {} }, primaries: { "-name": { args: 1 }, "-exec": { until: [";", "+"], effects: ["runs-code"], runner: true }, "-newer": { args: 1, argIsPath: "read" } } },
});
const SCRIPT = () => ({ program: "node", entrypoint: { path: "scripts/t.mjs", sha256: "a".repeat(64) }, command: { effects: ["read"], paths: "operands", flags: {} } });
const flag = (m, f) => { m.command.flags["-v"] = f; };
const cmd = (m, c) => { Object.assign(m.command, c); };
const prim = (m, p) => { m.command.primaries["-name"] = p; };

/** One entry per rule validateManifest enforces: [name, base, mutate]. Both the schema and the validator must reject it. */
const INVALID = [
    // unknown keys, at every level
    ["unknown top-level key", BIN, (m) => { m.extra = 1; }],
    ["unknown command key", BIN, (m) => { m.command.extra = 1; }],
    ["unknown subcommand key", BIN, (m) => { m.command.subcommands.sub.extra = 1; }],
    ["unknown flag key (the misspelt `runer`)", BIN, (m) => flag(m, { runer: true })],
    ["unknown primary key", FIND, (m) => prim(m, { args: 1, extra: 1 })],
    ["unknown entrypoint key", SCRIPT, (m) => { m.entrypoint.extra = 1; }],
    // required fields
    ["no program", BIN, (m) => { delete m.program; }],
    ["no command", BIN, (m) => { delete m.command; }],
    ["no version and no entrypoint", BIN, (m) => { delete m.version; }],
    ["a command without effects", BIN, (m) => { delete m.command.effects; }],
    ["a command without paths", BIN, (m) => { delete m.command.paths; }],
    ["a command without flags", BIN, (m) => { delete m.command.flags; }],
    ["a version without range", BIN, (m) => { delete m.version.range; }],
    ["a version without args", BIN, (m) => { delete m.version.args; }],
    ["a version without pattern", BIN, (m) => { delete m.version.pattern; }],
    ["an entrypoint without path", SCRIPT, (m) => { delete m.entrypoint.path; }],
    ["an entrypoint without sha256", SCRIPT, (m) => { delete m.entrypoint.sha256; }],
    ["find syntax without primaries", FIND, (m) => { delete m.command.primaries; }],
    // wrong types
    ["program not a string", BIN, (m) => { m.program = 1; }],
    ["$schema not a string", BIN, (m) => { m.$schema = 1; }],
    ["manifest-level okCodes not an array", BIN, (m) => { m.okCodes = 1; }],
    ["manifest-level echoes not a boolean", BIN, (m) => { m.echoes = "yes"; }],
    ["env not an array of names", BIN, (m) => { m.env = [1]; }],
    ["env not an array", BIN, (m) => { m.env = "LD_PRELOAD"; }],
    ["command not an object", BIN, (m) => { m.command = []; }],
    ["flags not an object", BIN, (m) => { m.command.flags = []; }],
    ["a flag not an object", BIN, (m) => flag(m, true)],
    ["subcommands not an object", BIN, (m) => { m.command.subcommands = []; }],
    ["a primary not an object", FIND, (m) => prim(m, 1)],
    ["effects not an array", BIN, (m) => { m.command.effects = "read"; }],
    ["a flag's effects not an array", BIN, (m) => flag(m, { effects: "read" })],
    ["a primary's effects not an array", FIND, (m) => prim(m, { args: 1, effects: "read" })],
    ["version not an object", BIN, (m) => { m.version = ">=1"; }],
    ["version.args not an array", BIN, (m) => { m.version.args = "--version"; }],
    ["entrypoint not an object", SCRIPT, (m) => { m.entrypoint = "scripts/t.mjs"; }],
    ["maxOperands a string", BIN, (m) => cmd(m, { maxOperands: "1" })],
    ["a primary's args a string", FIND, (m) => prim(m, { args: "1" })],
    ...["numericFlag", "clusters", "echoes", "recursive", "optionsFirst", "dashIsPath", "repoWide", "pathspecs"].map((k) => [`command.${k} not a boolean`, BIN, (m) => cmd(m, { [k]: "yes" })]),
    // enumerations and value rules
    ["an effect word outside the vocabulary", BIN, (m) => cmd(m, { effects: ["delete"] })],
    ["the underscore spelling of write-names", BIN, (m) => cmd(m, { effects: ["write_names"] })],
    ["a flag effect outside the vocabulary", BIN, (m) => flag(m, { effects: ["delete"] })],
    ["a primary effect outside the vocabulary", FIND, (m) => prim(m, { args: 1, effects: ["delete"] })],
    ["a network direction outside read/write/both", BIN, (m) => cmd(m, { effects: [{ network: { direction: "out" } }] })],
    ["a network effect with a second key", BIN, (m) => cmd(m, { effects: [{ network: {}, other: 1 }] })],
    ["a network effect with an unknown member", BIN, (m) => cmd(m, { effects: [{ network: { host: "x" } }] })],
    ["an effect object that is not network", BIN, (m) => cmd(m, { effects: [{ read: {} }] })],
    ["paths outside none/operands/repo/{operandsFrom}", BIN, (m) => cmd(m, { paths: "all" })],
    ["paths {operandsFrom} not an integer", BIN, (m) => cmd(m, { paths: { operandsFrom: "1" } })],
    ["paths {operandsFrom} with a second key", BIN, (m) => cmd(m, { paths: { operandsFrom: 1, extra: 1 } })],
    ["noPaths outside cwd/nothing", BIN, (m) => cmd(m, { noPaths: "home" })],
    ["a terminator outside --/--end-of-options/null", BIN, (m) => cmd(m, { terminator: "-" })],
    ["syntax outside find", BIN, (m) => cmd(m, { syntax: "awk" })],
    ["valueIsPath outside read/write", BIN, (m) => flag(m, { value: true, valueIsPath: "execute" })],
    ["harden not an array", BIN, (m) => cmd(m, { harden: "-v" })],
    ["maxOperands negative", BIN, (m) => cmd(m, { maxOperands: -1 })],
    ["maxOperands fractional", BIN, (m) => cmd(m, { maxOperands: 1.5 })],
    ["a primary's args negative", FIND, (m) => prim(m, { args: -1 })],
    ["okCodes 256", BIN, (m) => { m.okCodes = [256]; }],
    ["okCodes -1", BIN, (m) => { m.okCodes = [-1]; }],
    ["okCodes fractional", BIN, (m) => { m.okCodes = [1.5]; }],
    ["a command's okCodes not integers", BIN, (m) => cmd(m, { okCodes: ["1"] })],
    ["a flag's okCodes out of range", BIN, (m) => flag(m, { okCodes: [300] })],
    // names and patterns
    ["a program name with a slash", BIN, (m) => { m.program = "bin/x"; }],
    ["an empty program name", BIN, (m) => { m.program = ""; }],
    ["a flag name without a dash", BIN, (m) => { m.command.flags.v = {}; }],
    ["a flag name with three dashes", BIN, (m) => { m.command.flags["---v"] = {}; }],
    ["a bare dash as a flag name", BIN, (m) => { m.command.flags["-"] = {}; }],
    ["a flag name with a space", BIN, (m) => { m.command.flags["--a b"] = {}; }],
    ["a version range that is not comparators", BIN, (m) => { m.version.range = "latest"; }],
    ["an empty version range", BIN, (m) => { m.version.range = ""; }],
    ["a comparator with no number", BIN, (m) => { m.version.range = ">="; }],
    ["a comparator that is not one", BIN, (m) => { m.version.range = "~1.2"; }],
    ["a range with no args to read it", BIN, (m) => { m.version.args = []; }],
    ["a range with no pattern to read it", BIN, (m) => { m.version.pattern = ""; }],
    ["a star range with args", FIND, (m) => { m.version.args = ["--version"]; }],
    ["a star range with a pattern", FIND, (m) => { m.version.pattern = "(\\d+)"; }],
    ...["/abs/t.mjs", "../t.mjs", "scripts/../t.mjs", "./t.mjs", "scripts/./t.mjs", "-t.mjs", "scripts//t.mjs", "scripts/", ""].map((p) => [`entrypoint path ${JSON.stringify(p)}`, SCRIPT, (m) => { m.entrypoint.path = p; }]),
    ["a sha256 in uppercase", SCRIPT, (m) => { m.entrypoint.sha256 = "A".repeat(64); }],
    ["a sha256 of 63 digits", SCRIPT, (m) => { m.entrypoint.sha256 = "a".repeat(63); }],
    ["a sha256 that is not hex", SCRIPT, (m) => { m.entrypoint.sha256 = "g".repeat(64); }],
    // structural rules
    ["a script that also has a version", SCRIPT, (m) => { m.version = { range: "*", args: [], pattern: "" }; }],
    ["value and optionalValue together", BIN, (m) => flag(m, { value: true, optionalValue: true })],
    ["valueIsPath without value", BIN, (m) => flag(m, { valueIsPath: "write" })],
    ["valueIsDir without value", BIN, (m) => flag(m, { valueIsDir: true })],
    ["a runner whose effects do not run code", BIN, (m) => flag(m, { runner: true })],
    ["a runner with other effects", BIN, (m) => flag(m, { runner: true, effects: ["read"] })],
    ["a primary runner without runs-code", FIND, (m) => prim(m, { args: 1, runner: true })],
    ["argIsPath without args", FIND, (m) => prim(m, { argIsPath: "read" })],
    ["argIsPath with args 0", FIND, (m) => prim(m, { args: 0, argIsPath: "read" })],
    ["primaries without find syntax", BIN, (m) => cmd(m, { primaries: {} })],
    ["a bad flag in a subcommand", BIN, (m) => { m.command.subcommands.sub.flags.x = {}; }],
    ["a bad effect in a subcommand", BIN, (m) => { m.command.subcommands.sub.effects = ["delete"]; }],
    ["a subcommand without paths", BIN, (m) => { delete m.command.subcommands.sub.paths; }],
];

test("the schema and validateManifest both accept every base, and both reject each enumerated invalid manifest", () => {
    for (const base of [BIN, FIND, SCRIPT]) {
        assert.deepEqual(validateManifest(base()), [], `${base.name} under validateManifest`);
        assert.deepEqual(bySchema(base()), [], `${base.name} under the schema`);
    }
    const disagree = [];
    for (const [name, base, mut] of INVALID) {
        const m = base(); mut(m);
        const v = validateManifest(m).length > 0, s = bySchema(m).length > 0;
        if (!v || !s) disagree.push(`${name}: validateManifest ${v ? "rejects" : "ACCEPTS"}, schema ${s ? "rejects" : "ACCEPTS"}`);
    }
    assert.deepEqual(disagree, []);
});

test("a rule enumerated per key: every key of every level is covered by an unknown-key case, a type case or a rule case", () => {
    // Enumerate, do not sample: the validator's key sets are read from its source, and each must appear in INVALID.
    const src = fs.readFileSync(here("src/shell/program-manifest.ts"), "utf8");
    const sets = Object.fromEntries([...src.matchAll(/const (\w+_KEYS) = new Set\(\[([^\]]*)\]/g)].map((m) => [m[1], [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1])]));
    assert.deepEqual(Object.keys(sets).sort(), ["COMMAND_KEYS", "FLAG_KEYS", "MANIFEST_KEYS", "PRIMARY_KEYS"]);
    const props = { COMMAND_KEYS: PROGRAM_SCHEMA.$defs.CommandSpec.properties, FLAG_KEYS: PROGRAM_SCHEMA.$defs.FlagSpec.properties, PRIMARY_KEYS: PROGRAM_SCHEMA.$defs.PrimarySpec.properties, MANIFEST_KEYS: PROGRAM_SCHEMA.properties };
    for (const [set, keys] of Object.entries(sets)) assert.deepEqual(Object.keys(props[set]).sort(), [...keys].sort(), `${set}: the schema lists exactly the validator's keys`);
});

// --- the named gaps ---

/** Rules validateManifest enforces that this schema CANNOT state. Each must be rejected by the validator and ACCEPTED by the schema: when the schema learns one, move it to INVALID. */
const SCHEMA_GAPS = [
    ["$.version.pattern is a regex the engine compiles (JSON Schema's `format: regex` is an annotation, and not the same dialect: the host reads it as a Rust regex, this validator as an ECMAScript one)", BIN, (m) => { m.version.pattern = "("; }],
    ["every `harden` argument is a flag THIS command lists (a cross-reference between a value and the keys of a sibling object)", BIN, (m) => cmd(m, { harden: ["--not-listed"] })],
    ["every `harden` argument is a flag this command lists, so it is not the empty list's element either (the same cross-reference, a subcommand)", BIN, (m) => { m.command.subcommands.sub.harden = ["-v"]; }],
];

test("the rules the schema cannot express are named, and are real", () => {
    for (const [name, base, mut] of SCHEMA_GAPS) {
        const m = base(); mut(m);
        assert.notDeepEqual(validateManifest(m), [], `${name}: the validator rejects it`);
        assert.deepEqual(bySchema(m), [], `${name}: the schema cannot say so; if it can now, move this case to INVALID`);
    }
});

/** The other direction: the schema is STRICTER than the validator here (the validator checks the truthiness of a flag's booleans and not its type). A hand-edited file gets the underline; the validator still loads it. */
const SCHEMA_STRICTER = [
    ["a flag's value is not a boolean", BIN, (m) => flag(m, { value: "yes" })],
    ["a flag's optionalValue is not a boolean", BIN, (m) => flag(m, { optionalValue: 1 })],
    ["a flag's echoes is not a boolean", BIN, (m) => flag(m, { echoes: "x" })],
    ["a flag's recursive is not a boolean", BIN, (m) => flag(m, { recursive: "x" })],
    ["a flag's runner is not a boolean", BIN, (m) => flag(m, { runner: "yes", effects: ["runs-code"] })],
    ["a flag's valueIsDir is not a boolean", BIN, (m) => flag(m, { value: true, valueIsDir: "yes" })],
    ["a flag's pathsFrom is negative", BIN, (m) => flag(m, { pathsFrom: -1 })],
    ["a flag's pathsFrom is not a number", BIN, (m) => flag(m, { pathsFrom: "1" })],
    ["a primary's until is not an array", FIND, (m) => prim(m, { args: 1, until: ";" })],
    ["a primary's argIsPath is outside read/write", FIND, (m) => prim(m, { args: 1, argIsPath: "execute" })],
    ["a primary's runner is not a boolean", FIND, (m) => prim(m, { args: 1, runner: "yes", effects: ["runs-code"] })],
    ["a command's harden has a non-string", BIN, (m) => cmd(m, { harden: [1] })],
];

test("where the schema is stricter than validateManifest it says so: the validator loads it, the editor underlines it", () => {
    for (const [name, base, mut] of SCHEMA_STRICTER) {
        const m = base(); mut(m);
        assert.notDeepEqual(bySchema(m), [], `${name}: the schema rejects it`);
        const v = validateManifest(m);
        // `harden: [1]` is rejected by the validator too (not a listed flag); every other case is accepted by it.
        if (name !== "a command's harden has a non-string") assert.deepEqual(v, [], `${name}: the validator accepts it (if it learned the rule, move this case to INVALID)`);
    }
});

// --- the $schema key ---

test("an optional top-level $schema string validates under both and changes nothing about how a call is described", () => {
    let calls = 0;
    for (const [name, m] of Object.entries(programs)) {
        const hinted = { $schema: "../../../docs/spec/program-manifest.schema.json", ...structuredClone(m) };
        assert.deepEqual(validateManifest(hinted), [], `${name} with $schema under validateManifest`);
        assert.deepEqual(bySchema(hinted), [], `${name} with $schema under the schema`);
        const fx = readJson(new URL(`${name}.json`, FIXTURES));
        for (const c of fx.calls) {
            const a = describeCall(c.argv, m, { version: fx.version }), b = describeCall(c.argv, hinted, { version: fx.version });
            assert.deepEqual(b, a, `${c.argv.join(" ")}`);
            assert.deepEqual(hardenArgv(c.argv, b), hardenArgv(c.argv, a));
            calls++;
        }
    }
    assert.ok(calls > 100, `described ${calls} recorded calls`);
});

test("$schema is the only key either validator gained: another $-prefixed key is still an unknown key", () => {
    const m = BIN(); m.$comment = "x";
    assert.match(validateManifest(m).join(), /unknown key \$comment/);
    assert.notDeepEqual(bySchema(m), []);
});

test("the repository's own manifests carry no $schema (their bytes are pinned and copied to window-ml-host, whose reader refuses unknown fields)", () => {
    for (const [name, m] of Object.entries(programs)) assert.ok(!("$schema" in m), name);
});

// --- the validator used here can fail ---

test("helpers-jsonschema refuses a keyword it does not implement, and rejects what a closed, conditional schema rejects", () => {
    assert.throws(() => validateSchema(1, { dependentRequired: {} }), /not implemented/);
    const s = { type: "object", properties: { a: { type: "integer" } }, additionalProperties: false, if: { required: ["a"] }, then: { required: ["b"] } };
    assert.notDeepEqual(validateSchema({ a: 1 }, s), [], "then applies");
    assert.notDeepEqual(validateSchema({ c: 1 }, s), [], "closed");
    assert.deepEqual(validateSchema({}, s), []);
});

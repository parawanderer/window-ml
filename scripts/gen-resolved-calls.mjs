// gen-resolved-calls.mjs — writes the shared resolved-call vectors (tests/fixtures/program-calls-resolved/): every described call of tests/fixtures/program-calls/ as the description BEFORE resolution (`pre`), a fixed fake resolver recorded per row, and the effects after resolution, for window-ml-host's describer to be held to as well (docs/plan/repl/ONE_DESCRIBER_BUILD.md, section 1).
//
// The fake resolver is a rule, applied here and recorded per row as data (`resolve` holds an entry for every placeholder
// the row's `pre` uses, so a reader needs no rule): the workspace root is /w; a relative path is normalised against it
// (`a`, `./a` and `b/../a` are all /w/a); an absolute path stays as given. `inRoot`: the path is /w or under it.
// `secret`: the basename starts with `.env` or `id_`. `exists`: false when the basename starts with `new`. `topLevel`: a
// direct child of /w. `isRoot`: the path is /w. The cwd and the repo are /w.
//
// A row is { argv, resolve: { "<argv index>" | "cwd" | "repo": Resource }, pre: PreTerm[], effects: sorted effectKey strings | "unknown" }.
// shapes.json rows carry their own `manifest` (shapes window-ml's validateManifest accepts that the host does not parse yet).
// The script refuses to write unless the rows together cover the cases the vectors exist for (COVERAGE below).
//
//   node --import tsx scripts/gen-resolved-calls.mjs
import fs from "node:fs";
import path from "node:path";

const { describePre, resolvePre, describeCall, validateManifest } = await import("../src/shell/program-manifest.ts");
const { effectKey } = await import("../src/effects.ts");

const CALLS = new URL("../tests/fixtures/program-calls/", import.meta.url);
const MANIFESTS = new URL("../src/shell/manifests/", import.meta.url);
const OUT = new URL("../tests/fixtures/program-calls-resolved/", import.meta.url);
const ROOT = "/w";

/** The fake resolver's rule: the resource a path given as `given` resolves to. */
export function fake(given) {
    const p = given.startsWith("/") ? path.posix.normalize(given) : path.posix.normalize(`${ROOT}/${given}`);
    const base = path.posix.basename(p);
    return {
        kind: "fs", path: p, inRoot: p === ROOT || p.startsWith(`${ROOT}/`), secret: base.startsWith(".env") || base.startsWith("id_"),
        exists: !base.startsWith("new"), topLevel: path.posix.dirname(p) === ROOT, isRoot: p === ROOT,
    };
}

/** Hand-written rows (described ones, on shipped manifests) for what the call fixtures do not produce: the call rows
 *  have no two arguments on one path, no `exists: false` and no secret. */
const HAND = process.env.NO_HAND ? {} : {
    // the same path twice (a and ./a), and a secret beside a path that normalises to it
    cat: [["cat", "a", "./a"], ["cat", ".env", "b/../a"]],
    // a destination that does not exist
    cp: [["cp", "a", "new1"]],
};

const keys = (e) => (e === "unknown" ? "unknown" : e.map(effectKey).sort());

/** One resolved row: the call's pre-resolution terms, the resolver's entry for each placeholder, and the effects. */
function row(argv, m, version) {
    const { description, terms } = describePre(argv, m, { version });
    const resolve = {};
    for (const t of terms) for (const p of t.targets) {
        const r = fake(p.given);
        const was = resolve[p.arg];
        if (was && JSON.stringify(was) !== JSON.stringify(r)) throw new Error(`${argv.join(" ")}: placeholder ${p.arg} is given two paths`);
        resolve[p.arg] = r;
    }
    const ordered = Object.fromEntries(Object.keys(resolve).sort((a, b) => (isNaN(a) - isNaN(b)) || (isNaN(a) ? a.localeCompare(b) : a - b)).map((k) => [k, resolve[k]]));
    const lookup = (p) => ordered[p.arg];
    const effects = description.described ? keys(resolvePre(terms, lookup)) : "unknown";
    const whole = keys(describeCall(argv, m, { version, resolve: lookup }).effects);
    if (JSON.stringify(whole) !== JSON.stringify(effects)) throw new Error(`${argv.join(" ")}: describeCall and describePre+resolvePre disagree`);
    return { description, row: { argv, resolve: ordered, pre: terms, effects } };
}

/** The shapes: manifests window-ml accepts that the host does not parse yet, each with calls. */
const SHA = "0123456789abcdef".repeat(4);
const SHAPES = [
    { name: "entrypoint script tool", manifest: { program: "node", entrypoint: { path: "scripts/tool.mjs", sha256: SHA }, okCodes: [0], echoes: false, command: { effects: ["read"], paths: "operands", flags: { "-v": {} } } },
        calls: [["node", "scripts/tool.mjs", "a"], ["node", "scripts/tool.mjs", "-v", "./a", "new2"], ["node", "--import", "./x.mjs", "scripts/tool.mjs", "a"], ["node", "-u", "scripts/tool.mjs", "a"], ["node", "scripts/tool.mjs", "-z"]] },
    { name: "reveals processes", manifest: { program: "ps", version: { range: "*", args: [], pattern: "" }, reveals: "processes", okCodes: [0], echoes: false, command: { effects: ["read"], paths: "operands", flags: { "-e": {} } } },
        calls: [["ps", "-e"], ["ps", "x"]] },
    { name: "$schema", manifest: { $schema: "../../../docs/program-manifest.schema.json", program: "wc", version: { range: "*", args: [], pattern: "" }, okCodes: [0], echoes: false, command: { effects: ["read"], paths: "operands", flags: { "-l": {} } } },
        calls: [["wc", "-l", "a", "/w/b"]] },
];

fs.mkdirSync(OUT, { recursive: true });
const write = (name, data) => fs.writeFileSync(new URL(name, OUT), JSON.stringify(data, null, 2) + "\n");
const all = [];
for (const f of fs.readdirSync(CALLS).filter((f) => f.endsWith(".json")).sort()) {
    const fx = JSON.parse(fs.readFileSync(new URL(f, CALLS), "utf8"));
    const m = JSON.parse(fs.readFileSync(new URL(f, MANIFESTS), "utf8"));
    const argvs = fx.calls.filter((c) => c.described).map((c) => c.argv);
    for (const a of HAND[fx.program] ?? []) if (!argvs.some((b) => JSON.stringify(b) === JSON.stringify(a))) argvs.push(a);
    const calls = argvs.map((a) => {
        const r = row(a, m, fx.version);
        if (!r.description.described) throw new Error(`${a.join(" ")} is not described: ${r.description.why}`);
        return r.row;
    });
    all.push(...calls);
    write(f, { program: fx.program, version: fx.version, calls });
}

const shapeRows = [];
for (const s of SHAPES) {
    const errs = validateManifest(s.manifest);
    if (errs.length) throw new Error(`${s.name}: ${errs.join("; ")}`);
    for (const a of s.calls) {
        const version = s.manifest.version ? s.manifest.version.range : undefined;
        const r = row(a, s.manifest, version);
        const d = r.description;
        shapeRows.push({ shape: s.name, manifest: s.manifest, ...(version !== undefined ? { version } : {}), argv: a, described: d.described, why: d.why, resolve: r.row.resolve, pre: r.row.pre, effects: r.row.effects });
    }
}
write("shapes.json", { calls: shapeRows });

/** What the rows together must hold: the cases the vectors exist for. */
const resolvedOf = (r) => Object.values(r.resolve);
const COVERAGE = {
    "two placeholders resolving to the same path": (r) => { const a = Object.keys(r.resolve).filter((k) => !isNaN(k)); return new Set(a.map((k) => r.resolve[k].path)).size < a.length; },
    "a path outside the roots": (r) => resolvedOf(r).some((x) => !x.inRoot),
    "exists: false": (r) => resolvedOf(r).some((x) => x.exists === false),
    "secret: true": (r) => resolvedOf(r).some((x) => x.secret === true),
    "a cwd placeholder": (r) => "cwd" in r.resolve,
    "a repo placeholder": (r) => "repo" in r.resolve,
};
const missing = Object.entries(COVERAGE).filter(([, has]) => !all.some(has)).map(([what]) => what);
if (missing.length) throw new Error(`no row has: ${missing.join("; ")}: add a hand-written call to HAND`);
console.log(`wrote ${all.length} rows and ${shapeRows.length} shape rows`);

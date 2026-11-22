// fuzz-resolved.mjs — the differential run WITH resolution (docs/plan/repl/ONE_DESCRIBER_BUILD.md section 5, last paragraph):
// the TS describer with a `resolve` against the host's wasm describer's `pre` put through the TS resolution step, on the
// resolved effects, `described` and (reported apart, not in the bar) `why` and `pre`.
//
//   node --import tsx fuzz-resolved.mjs <describe.wasm> <window-ml-host checkout> [perProgram=2000] [seeds=1,2,3,7]
//
// The wasm is the host's `tools/build-describer.sh <out-dir>` output (describe.wasm + describe.json beside it); the host
// checkout is read only for its HEAD and `rustc --version`. Calls: every vector row unmutated (kind "vectors"), then per
// seed `perProgram` mutations per program drawn from lib.mjs's makeFuzzer (the same generator, and the same seeds, as
// fuzz.mjs). Writes out/fuzz-resolved-<seed>.json (one per seed), out/fuzz-resolved-vectors.json and out/fuzz-resolved-meta.json.
//
// THE FAKE RESOLVER (deterministic per argv index; both sides call this one function, so it is not what is compared):
//   the placeholder "cwd" and "repo"      -> /w (the workspace root: inRoot, isRoot, not top level)
//   argv index i, by i mod 7:
//     0, 1  the rule of scripts/gen-resolved-calls.mjs's `fake`: relative to /w (or absolute as given), normalised;
//           inRoot iff under /w; secret iff the basename starts `.env` or `id_`; exists false iff it starts `new`
//     2     OUTSIDE the roots: /o/<i>/<basename of given>, inRoot false
//     3     SECRET: /w/.env, secret true
//     4, 5  the SAME path: /w/shared (two different indices resolve to one path)
//     6     does not exist: /w/new<i>, exists false
// A call with any argument at index 4 and 5, or 11 and 12 (...), is therefore a call with two arguments on one path.
// CONTROL=1 makes the wasm side's resolver report every resource as in-root and not secret: a run that must then DISAGREE,
// to show the harness can see an effects difference at all (record it, do not pin it as the result).
// Section 4 of the plan: an argv entry, envSet name or the flavour that is not isWellFormed() is not described on the
// worker side (the call asks): counted as "asks, lone surrogate", compared on neither side.
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { OUT, TS, vectorRows, loadWasm, makeFuzzer, manifests, PROGRAMS, canon } from "./lib.mjs";

const [WASM_FILE, HOST, PER_ARG, SEEDS_ARG] = process.argv.slice(2);
if (!WASM_FILE || !HOST) { console.error("usage: fuzz-resolved.mjs <describe.wasm> <window-ml-host checkout> [perProgram=2000] [seeds=1,2,3,7]"); process.exit(2); }
const PER = +(PER_ARG ?? 2000), SEEDS = (SEEDS_ARG ?? "1,2,3,7").split(",").map(Number);
const { describePre, resolvePre, describeCall } = await import(`${TS}/src/shell/program-manifest.ts`);
const { effectKey } = await import(`${TS}/src/effects.ts`);

const ROOT = "/w";
const res = (p, o = {}) => ({ kind: "fs", path: p, inRoot: p === ROOT || p.startsWith(`${ROOT}/`), secret: false, exists: true, topLevel: path.posix.dirname(p) === ROOT, isRoot: p === ROOT, ...o });
const rule = (given) => {
    const p = given.startsWith("/") ? path.posix.normalize(given) : path.posix.normalize(`${ROOT}/${given}`);
    const base = path.posix.basename(p);
    return res(p, { secret: base.startsWith(".env") || base.startsWith("id_"), exists: !base.startsWith("new") });
};
const CLASSES = ["rule", "rule", "outside", "secret", "shared", "shared", "missing"];
/** the resolver: a placeholder -> the resource it resolves to; `seen`, when given, records what each call used */
const resolver = (seen, control) => (p) => {
    let cls, r;
    if (p.arg === "cwd" || p.arg === "repo") { cls = p.arg; r = res(ROOT); }
    else {
        cls = CLASSES[p.arg % 7];
        r = cls === "rule" ? rule(p.given)
            : cls === "outside" ? res(`/o/${p.arg}/${path.posix.basename(p.given) || "x"}`)
            : cls === "secret" ? res(`${ROOT}/.env`, { secret: true })
            : cls === "shared" ? res(`${ROOT}/shared`)
            : res(`${ROOT}/new${p.arg}`, { exists: false });
    }
    if (control) r = { ...r, secret: false, inRoot: true };
    if (seen) { seen.cls[cls] = (seen.cls[cls] ?? 0) + 1; if (typeof p.arg === "number") seen.paths.push(r.path); if (r.inRoot === false) seen.cls.outsideRoots = (seen.cls.outsideRoots ?? 0) + 1; if (r.secret) seen.cls.secretResources = (seen.cls.secretResources ?? 0) + 1; }
    return r;
};
const keys = (e) => e === "unknown" ? "unknown" : e.map(effectKey).sort();

let w = await loadWasm(WASM_FILE);
const wasmCall = (c) => {
    const req = { argv: c.argv, manifest: manifests[c.program], version: c.version, envSet: c.envSet ?? [], flavour: c.flavour };
    try { return w.describe(req); } catch (e) { w = null; return { trap: String(e).slice(0, 120) }; }
};

/** One call through both sides: null when they agree, else {fields, ts, wasm}; or a string tag for a call that asks. */
async function compare(c, tally) {
    if (c.argv.some((x) => !x.isWellFormed()) || (c.envSet ?? []).some((x) => !x.isWellFormed()) || (c.flavour !== undefined && !c.flavour.isWellFormed())) { tally.asks++; return null; }
    tally.compared++;
    const opts = { version: c.version, flavour: c.flavour, envSet: c.envSet ?? [] };
    const seen = { cls: {}, paths: [] };
    let tsOut, tsPre, err;
    try {
        const d = describeCall(c.argv, manifests[c.program], { ...opts, resolve: resolver(seen) });
        tsOut = { described: d.described, why: d.why, effects: keys(d.effects) };
        tsPre = describePre(c.argv, manifests[c.program], opts).terms;
    } catch (e) { err = e; }
    let a = wasmCall(c);
    if (!w) { w = await loadWasm(WASM_FILE); return { fields: ["WASM-TRAP"], note: a.trap }; }
    if (err) return { fields: ["TS-THROW"], note: String(err).slice(0, 120) };
    if (a.error) return { fields: ["WASM-ERROR"], note: a.error };
    let wasmOut;
    try { wasmOut = { described: a.described, why: a.why, effects: a.described ? keys(resolvePre(a.pre, resolver(undefined, !!process.env.CONTROL))) : "unknown" }; }
    catch (e) { return { fields: ["RESOLVE-THROW"], note: String(e).slice(0, 120), wasm: a.pre }; }
    (tsOut.described ? tally.described++ : tally.notDescribed++);
    if (tsOut.described) {
        tally.withTargets += tsPre.some((t) => t.targets.length) ? 1 : 0;
        for (const [k, v] of Object.entries(seen.cls)) tally.resolverUse[k] = (tally.resolverUse[k] ?? 0) + v;
        if (new Set(seen.paths).size < seen.paths.length) tally.twoArgsOnePath++;
        const hit = (k) => Object.keys(seen.cls).includes(k);
        if (hit("outsideRoots")) tally.callsOutsideRoots++;
        if (hit("secretResources")) tally.callsWithSecret++;
    }
    const f = [];
    if (tsOut.described !== wasmOut.described) f.push("described");
    if (JSON.stringify(tsOut.effects) !== JSON.stringify(wasmOut.effects)) f.push("effects");
    if (JSON.stringify(tsOut.why) !== JSON.stringify(wasmOut.why)) f.push("why");
    if (JSON.stringify(canon({ p: tsPre })) !== JSON.stringify(canon({ p: a.pre }))) f.push("pre");
    return f.length ? { fields: f.sort(), ts: tsOut, wasm: wasmOut, tsPre: f.includes("pre") ? tsPre : undefined, wasmPre: f.includes("pre") ? a.pre : undefined } : null;
}
const newTally = () => ({ compared: 0, asks: 0, described: 0, notDescribed: 0, withTargets: 0, twoArgsOnePath: 0, callsOutsideRoots: 0, callsWithSecret: 0, resolverUse: {} });

// a bar field is `described` or `effects`; why and pre are reported apart
const BAR = new Set(["described", "effects", "WASM-ERROR", "WASM-TRAP", "TS-THROW", "RESOLVE-THROW"]);
const causeOf = (c, fields) => {
    const f = fields.join("+");
    if (f.startsWith("why") || f === "pre") return f + (c.argv.some((x) => /[\u{10000}-\u{10FFFF}]/u.test(x)) ? " / astral" : c.argv.some((x) => /[^\x00-\x7f]/.test(x)) ? " / non-ascii" : " / control-char");
    return f;
};
async function minimise(c, fields) {
    const same = async (t) => { const r = await compare(t, newTally()); return r && JSON.stringify(r.fields) === JSON.stringify(fields); };
    let cur = { ...c, argv: [...c.argv] }, changed = true, guard = 0;
    while (changed && guard++ < 100) {
        changed = false;
        for (let i = cur.argv.length - 1; i >= 1; i--) { const t = { ...cur, argv: cur.argv.filter((_, j) => j !== i) }; if (await same(t)) { cur = t; changed = true; } }
        for (let i = 1; i < cur.argv.length; i++) { const s = [...cur.argv[i]]; if (s.length > 1) for (const cut of [s.slice(0, s.length >> 1).join(""), s.slice(s.length >> 1).join("")]) { const t = { ...cur, argv: cur.argv.map((x, j) => j === i ? cut : x) }; if (await same(t)) { cur = t; changed = true; break; } } }
        for (const k of ["version", "flavour"]) if (cur[k] !== undefined) { const t = { ...cur, [k]: undefined }; if (await same(t)) { cur = t; changed = true; } }
        if (cur.envSet?.length) { const t = { ...cur, envSet: [] }; if (await same(t)) { cur = t; changed = true; } }
    }
    return cur;
}
/** the report of one list of calls: counts, disagreements by field, minimised examples */
async function runCalls(label, calls) {
    const t0 = Date.now(), tally = newTally(), dis = [];
    for (const c of calls) { const r = await compare(c, tally); if (r) dis.push({ c, r }); }
    const byField = {}, groups = new Map();
    for (const d of dis) {
        for (const f of d.r.fields) byField[f] = (byField[f] ?? 0) + 1;
        const k = causeOf(d.c, d.r.fields); (groups.get(k) ?? groups.set(k, []).get(k)).push(d);
    }
    const barDisagreements = dis.filter((d) => d.r.fields.some((f) => BAR.has(f))).length;
    const out = { label, calls: calls.length, ...tally, disagreements: dis.length, barDisagreements, byField, whyOnDescribedCalls: dis.filter((d) => d.r.fields.includes("why") && d.r.ts?.described).length, groups: [], seconds: (Date.now() - t0) / 1000 };
    for (const [cause, list] of groups) {
        const byProgram = {}; for (const d of list) byProgram[d.c.program] = (byProgram[d.c.program] ?? 0) + 1;
        const examples = [], seen = new Set();
        for (const d of list) {
            if (examples.length >= (cause.startsWith("why") || cause === "pre" ? 3 : 10)) break;
            const m = await minimise(d.c, d.r.fields); const key = JSON.stringify([m.program, m.argv, m.flavour]);
            if (seen.has(key)) continue; seen.add(key);
            const r = await compare(m, newTally());
            examples.push({ program: m.program, argv: m.argv, version: m.version, flavour: m.flavour, envSet: m.envSet ?? [], repro: r ?? undefined });
        }
        out.groups.push({ cause, bar: list.some((d) => d.r.fields.some((f) => BAR.has(f))), count: list.length, byProgram, examples });
    }
    out.groups.sort((a, b) => b.count - a.count);
    return out;
}

const t00 = Date.now();
const meta = {
    wasmSha256: JSON.parse(fs.readFileSync(path.join(path.dirname(WASM_FILE), "describe.json"), "utf8")).sha256,
    wasmBytes: fs.statSync(WASM_FILE).size,
    hostCommit: execSync("git rev-parse HEAD", { cwd: HOST }).toString().trim(),
    describeJson: JSON.parse(fs.readFileSync(path.join(path.dirname(WASM_FILE), "describe.json"), "utf8")),
    rustc: execSync("rustc --version", { cwd: HOST }).toString().trim(),
    windowMlCommit: execSync("git rev-parse HEAD", { cwd: TS }).toString().trim(),
    perProgram: PER, seeds: SEEDS, node: process.version,
    resolver: { classes: CLASSES, cwdRepo: ROOT, root: ROOT },
};
const rows = vectorRows();
const vec = await runCalls("vectors", rows.map((r) => ({ program: r.program, argv: r.argv, version: r.version, flavour: r.flavour, envSet: [] })));
fs.writeFileSync(path.join(OUT, "fuzz-resolved-vectors.json"), JSON.stringify(vec, null, 1));
console.log("vectors", JSON.stringify({ ...vec, groups: vec.groups.map((g) => [g.cause, g.count]) }));
for (const seed of SEEDS) {
    const { R, ri, pick, mutate, VERS, FLV } = makeFuzzer(seed);
    const calls = [];
    for (const p of PROGRAMS) {
        const pool = rows.filter((r) => r.program === p);
        for (let i = 0; i < PER; i++) {
            const base = pick(pool);
            const flavour = (p === "sed" || p === "awk") ? pick(FLV) : (R() < .1 ? pick(FLV) : base.flavour);
            const env = manifests[p].env?.length && R() < .2 ? [pick(manifests[p].env)] : [];
            calls.push({ program: p, argv: mutate(base.argv, p), version: VERS(base.version), flavour, envSet: env });
        }
    }
    const r = await runCalls(`seed ${seed}`, calls);
    fs.writeFileSync(path.join(OUT, `fuzz-resolved-${seed}.json`), JSON.stringify({ seed, ...r }, null, 1));
    console.log(`seed ${seed}`, JSON.stringify({ ...r, groups: r.groups.map((g) => [g.cause, g.count, g.bar]) }));
}
meta.totalSeconds = (Date.now() - t00) / 1000;
fs.writeFileSync(path.join(OUT, "fuzz-resolved-meta.json"), JSON.stringify(meta, null, 1));

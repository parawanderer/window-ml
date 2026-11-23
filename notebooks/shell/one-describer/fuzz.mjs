// fuzz.mjs — differential fuzz: mutate vector argvs, compare wasm vs TS. usage: fuzz.mjs [perProgram=2000] [seed=1] [opt=z]
import fs from "node:fs";
import path from "node:path";
import { OUT, makeFuzzer, vectorRows, loadWasm, wasmDescribe, tsDescribe, diffFields, canon, manifests, PROGRAMS, WASM, VECTOR_FIELDS } from "./lib.mjs";
const PER = +(process.argv[2] ?? 2000), SEED = +(process.argv[3] ?? 1), OPT = process.argv[4] ?? "z";
let w = await loadWasm(WASM(OPT));
const { R, ri, pick, mutate, VERS, FLV } = makeFuzzer(SEED);
const rows = vectorRows();
function one(c) {
    let a, b, ea, eb;
    try { a = wasmDescribe(w, c.program, c.argv, c.version, c.flavour, c.envSet); } catch (e) { ea = e; w = null; }
    if (!w) return recover(c, ea);
    try { b = tsDescribe(c.program, c.argv, c.version, c.flavour, c.envSet); } catch (e) { eb = e; }
    if (b) { DESC[b.described ? 1 : 0]++; }
    if (eb) return { fields: ["TS-THROW"], note: String(eb).slice(0, 120) };
    if (a.error) return { fields: ["WASM-ERROR"], note: a.error };
    const f = diffFields(a, b); return f.length ? { fields: f, wasm: canon(a), ts: canon(b) } : null;
}
async function recover(c, e) { w = await loadWasm(WASM(OPT)); return { fields: ["WASM-TRAP"], note: String(e).slice(0, 120) }; }
const DESC = [0, 0];
let total = 0, dis = [], trapsFix = 0;
const t0 = Date.now();
for (const p of PROGRAMS) {
    const pool = rows.filter((r) => r.program === p);
    for (let i = 0; i < PER; i++) {
        const base = pick(pool);
        const flavour = (p === "sed" || p === "awk") ? pick(FLV) : (R() < .1 ? pick(FLV) : base.flavour);
        const env = manifests[p].env?.length && R() < .2 ? [pick(manifests[p].env)] : [];
        const c = { program: p, argv: mutate(base.argv, p), version: VERS(base.version), flavour, envSet: env };
        total++;
        let r = one(c); if (r instanceof Promise) r = await r;
        if (r) dis.push({ c, r });
    }
}
// minimise: drop args, then halve strings, keeping the SAME differing-field set
async function disagrees(c, fields) { let r = one(c); if (r instanceof Promise) r = await r; return r && JSON.stringify(r.fields) === JSON.stringify(fields) ? r : null; }
async function minimise(c, fields) {
    let cur = { ...c, argv: [...c.argv] }, changed = true, guard = 0;
    while (changed && guard++ < 200) {
        changed = false;
        for (let i = cur.argv.length - 1; i >= 1; i--) { const t = { ...cur, argv: cur.argv.filter((_, j) => j !== i) }; if (await disagrees(t, fields)) { cur = t; changed = true; } }
        for (let i = 1; i < cur.argv.length; i++) { const s = [...cur.argv[i]]; if (s.length > 1) for (const cut of [s.slice(0, s.length >> 1).join(""), s.slice(s.length >> 1).join("")]) { const t = { ...cur, argv: cur.argv.map((x, j) => j === i ? cut : x) }; if (await disagrees(t, fields)) { cur = t; changed = true; break; } } }
        if (cur.version !== undefined) { const t = { ...cur, version: undefined }; if (await disagrees(t, fields)) { cur = t; changed = true; } }
        if (cur.flavour !== undefined) { const t = { ...cur, flavour: undefined }; if (await disagrees(t, fields)) { cur = t; changed = true; } }
        if (cur.envSet.length) { const t = { ...cur, envSet: [] }; if (await disagrees(t, fields)) { cur = t; changed = true; } }
    }
    return cur;
}
const sub = (d) => { const f = d.r.fields.join('+'); const argsS = JSON.stringify(d.c.argv);
    if (f === 'WASM-ERROR') return d.c.argv.some((x) => !x.isWellFormed()) ? 'lone-surrogate-in-argv' : 'other';
    if (f === 'why') return d.c.argv.some((x) => /[\u{10000}-\u{10FFFF}]/u.test(x)) ? 'why:astral-char-split-in-cluster' : d.c.argv.some((x) => /[^\x00-\x7f]/.test(x)) ? 'why:non-ascii-quoting' : 'why:ascii-only'; return ''; };
const groups = new Map();
for (const d of dis) { const k = d.r.fields.join("+") + (sub(d) ? " / " + sub(d) : ""); (groups.get(k) ?? groups.set(k, []).get(k)).push(d); }
const report = { opt: OPT, seed: SEED, perProgram: PER, total, disagreements: dis.length, seconds: (Date.now() - t0) / 1000, tsNotDescribed: DESC[0], tsDescribed: DESC[1], groups: [] };
for (const [k, list] of groups) {
    const byProg = {}; for (const d of list) byProg[d.c.program] = (byProg[d.c.program] ?? 0) + 1;
    const ex = []; const seen = new Set();
    for (const d of list) {
        if (ex.length >= 10) break;
        const m = await minimise(d.c, d.r.fields); const key = JSON.stringify([m.program, m.argv, m.flavour]);
        if (seen.has(key)) continue; seen.add(key);
        let r = one(m); if (r instanceof Promise) r = await r;
        ex.push({ program: m.program, argv: m.argv, version: m.version, flavour: m.flavour, envSet: m.envSet, wasm: r?.wasm ? pickF(r.wasm, d.r.fields) : r?.note, ts: r?.ts ? pickF(r.ts, d.r.fields) : undefined });
    }
    report.groups.push({ cause: k, count: list.length, byProgram: byProg, examples: ex });
}
function pickF(o, fs) { return Object.fromEntries(fs.filter((f) => f in o).map((f) => [f, o[f]])); }
report.groups.sort((a, b) => b.count - a.count);
fs.writeFileSync(path.join(OUT, `fuzz-${OPT}-${SEED}.json`), JSON.stringify(report, null, 1));
console.log(JSON.stringify({ ...report, groups: report.groups.map((g) => ({ cause: g.cause, count: g.count, byProgram: g.byProgram, nEx: g.examples.length })) }, null, 1));

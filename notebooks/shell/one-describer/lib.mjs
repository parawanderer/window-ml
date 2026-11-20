// lib.mjs — shared by the one-describer harness: the wasm describer, window-ml's TS describer, the vectors.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const DIR = path.dirname(fileURLToPath(import.meta.url));
export const TS = path.resolve(DIR, "../../.."); // the window-ml checkout this folder sits in
export const OUT = path.join(DIR, "out"); // raw results (gitignored); the notebook pins what it reads into data/
fs.mkdirSync(OUT, { recursive: true });
export const { describeCall, hardenArgv } = await import(`${TS}/src/shell/program-manifest.ts`);
const { effectKey } = await import(`${TS}/src/effects.ts`);
export const PROGRAMS = ["awk","cat","cp","find","gh","git","head","jq","ls","mv","rg","rm","rmdir","sed","tail","unlink","wc"];
const rd = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
// manifests: window-ml's src/shell/manifests (byte-identical to the host's copy, checked in RESULTS.md)
export const manifests = Object.fromEntries(PROGRAMS.map((p) => [p, rd(`${TS}/src/shell/manifests/${p}.json`)]));
export const calls = Object.fromEntries(PROGRAMS.map((p) => [p, rd(`${TS}/tests/fixtures/program-calls/${p}.json`)]));
export const flavoured = Object.fromEntries(["awk","sed"].map((p) => [p, rd(`${TS}/tests/fixtures/program-calls-flavoured/${p}.json`)]));
/** every vector row as {program, argv, version, flavour|undefined, note, kind, want} */
export function vectorRows() {
    const rows = [];
    for (const p of PROGRAMS) for (const c of calls[p].calls) rows.push({ program: p, argv: c.argv, version: calls[p].version, flavour: undefined, note: c.note, kind: "plain", want: c });
    for (const p of ["awk","sed"]) for (const c of flavoured[p].calls) rows.push({ program: p, argv: c.argv, version: flavoured[p].version, flavour: c.flavour, note: c.note, kind: "flavoured", want: c });
    return rows;
}

export async function loadWasm(file) {
    const bytes = fs.readFileSync(file);
    const mod = await WebAssembly.compile(bytes);
    return makeDescriber(await WebAssembly.instantiate(mod, {}), mod);
}
export function makeDescriber(inst, mod) {
    const ex = inst.exports; const enc = new TextEncoder(), dec = new TextDecoder();
    function wasmDescribe(req) {
        const b = enc.encode(JSON.stringify(req));
        const p = ex.alloc(b.length);
        new Uint8Array(ex.memory.buffer, p, b.length).set(b);
        const o = ex.describe(p, b.length);
        const len = new DataView(ex.memory.buffer).getUint32(o, true);
        const s = dec.decode(new Uint8Array(ex.memory.buffer, o + 4, len));
        ex.dealloc(p, b.length); ex.dealloc(o, 4 + len);
        return JSON.parse(s);
    }
    return { describe: wasmDescribe, mod };
}

/** TS side, normalised to one canonical shape. */
export function tsDescribe(program, argv, version, flavour, envSet) {
    const d = describeCall(argv, manifests[program], { version, flavour, envSet });
    return {
        described: d.described, why: d.why, program: d.program, subcommand: d.subcommand,
        effects: d.effects === "unknown" ? "unknown" : d.effects.map(effectKey), // NORMALISED: effectKey strings, as the vector test does
        pathArgs: d.pathArgs, actsOnDir: d.actsOnDir, dirArg: d.dirArg, recursive: d.recursive, harden: d.harden,
        operandStart: d.operandStart, terminator: d.terminator, runner: d.runner, echoes: d.echoes, okCodes: d.okCodes,
        hardened: hardenArgv(argv, d),
    };
}
export function wasmDescribe(w, program, argv, version, flavour, envSet) {
    return w.describe({ argv, manifest: manifests[program], version, envSet: envSet ?? [], flavour });
}
const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
/** NORMALISE both: effects keys sorted with JS default order (Rust sorts bytewise, JS by UTF-16 unit), object keys sorted. */
export function canon(d) {
    const o = { ...d };
    if (Array.isArray(o.effects)) o.effects = [...o.effects].sort();
    return sortKeys(o);
}
// "semantic" = the nine fields the vector tests compare; the rest are the other CallDescription fields
export const VECTOR_FIELDS = ["described","effects","pathArgs","actsOnDir","runner","okCodes","echoes","recursive","hardened"];
export const OTHER_FIELDS = ["subcommand","dirArg","harden","operandStart","terminator","program"];
export function diffFields(a, b) {
    const ca = canon(a), cb = canon(b), out = [];
    for (const k of new Set([...Object.keys(ca), ...Object.keys(cb)])) if (JSON.stringify(ca[k]) !== JSON.stringify(cb[k])) out.push(k);
    return out.sort();
}
export const WASM = (o) => path.join(DIR, "build", `describe-${o}.wasm`);

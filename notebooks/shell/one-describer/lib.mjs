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

/** The spike's mutation generator, seeded: mutate(argv, program), VERS(version), FLV, and the random helpers R, ri, pick. fuzz.mjs and fuzz-resolved.mjs both draw from it, so one seed makes the same calls in both. */
export function makeFuzzer(SEED) {
    function rng(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
    const R = rng(SEED);
    const ri = (n) => Math.floor(R() * n), pick = (a) => a[ri(a.length)];
    const flagsOf = (cmd, out = []) => { out.push(...Object.keys(cmd.flags ?? {}), ...Object.keys(cmd.primaries ?? {})); for (const s of Object.values(cmd.subcommands ?? {})) flagsOf(s, out); out.push(...Object.keys(cmd.subcommands ?? {})); return out; };
    const FLAGS = Object.fromEntries(PROGRAMS.map((p) => [p, [...new Set(flagsOf(manifests[p].command)), "-x", "--wml-x"]]));
    const WEIRD = ["", "--", "-", "=", "-=", "--=", "\\\n", "a\\\nb", "\r\n", "x\r\ny", "\n", "\t", " ", "é", "日本語", "🙂", "\u0000", "‮", "-é", "--é", "-\\\n", "p;w /etc/passwd", "s/a/b/w x", "{print}", "BEGIN{system(\"x\")}", "x=1", "a=b", "$(x)", "*", "~", "../x", "/", "-n", "-i", "-e", "-f", "--help", "-V", "'", "\"", "\\", "\\\\", "\\n", "a\\", "}", "{", "/", "s", "y/a/b/", "r f", "e", "w", "W f", "-1", "-0", "--version", "-- --", "-\r\n", "\\\r\n"];
    const mutate = (argv, p) => {
        let a = [...argv]; const k = 1 + ri(3);
        for (let i = 0; i < k; i++) {
            const t = ri(14); if (a.some((x) => typeof x !== 'string')) throw new Error('pre t='+t+' '+JSON.stringify(a));
            if (t === 0 && a.length > 1) { const x = 1 + ri(a.length - 1), y = 1 + ri(a.length - 1); [a[x], a[y]] = [a[y], a[x]]; }
            else if (t === 1 && a.length > 1) { const x = 1 + ri(a.length - 1); a.splice(x, 0, a[x]); }
            else if (t === 2 && a.length > 1) a.splice(1 + ri(a.length - 1), 1);
            else if (t === 3) a.splice(1 + ri(a.length), 0, pick(FLAGS[p] ?? ["-x"]));
            else if (t === 4) a.splice(1 + ri(a.length), 0, "--");
            else if (t === 5) a.splice(1 + ri(a.length), 0, "-");
            else if (t === 6 && a.length > 1) { const x = 1 + ri(a.length - 1); a[x] = a[x] + "="; }
            else if (t === 7 && a.length > 1) { const x = 1 + ri(a.length - 1); const s = a[x]; const c = ri(s.length + 1); a[x] = s.slice(0, c) + pick(["\\\n", "\r\n", "\n", "\\\r\n"]) + s.slice(c); }
            else if (t === 8) a.splice(1 + ri(a.length), 0, pick(WEIRD));
            else if (t === 9 && a.length > 1) a[1 + ri(a.length - 1)] = pick(WEIRD);
            else if (t === 10 && a.length > 1) { const x = 1 + ri(a.length - 1); a[x] = a[x].repeat(1 + ri(50)) + "x".repeat(ri(5000)); }
            else if (t === 11 && a.length > 1) { const x = 1 + ri(a.length - 1); const f = pick(FLAGS[p] ?? ["-x"]); a[x] = f + (R() < .5 ? "=" + a[x] : ""); }
            else if (t === 12 && a.length > 1) { const x = 1 + ri(a.length - 1); const s = [...a[x]]; if (s.length) { s.splice(ri(s.length), 1); a[x] = s.join(""); } }
            else if (t === 13 && a.length > 1) { const x = 1 + ri(a.length - 1); a[x] = a[x] + pick(["é", "日", "🙂", "́", "\\", "\n"]); }
        }
        if (a.length > 40) a.length = 40; return a;
    };
    const VERS = (v) => R() < .85 ? v : pick([undefined, "", "0.0.1", "99.0.0", "garbage", "1.7.1", "2.55.0", "14.1.1"]);
    const FLV = ["gnu", "bsd", "other", undefined, undefined];

    return { R, ri, pick, mutate, VERS, FLV };
}

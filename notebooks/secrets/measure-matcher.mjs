// measure-matcher.mjs — ruling 32's hash-only matcher, measured before its widths are fixed (docs/spec/SECRET_HANDLES.md,
// "A secret the model never uses is stored hash-only"): the rolling filter pass over a 1 MiB text, the false candidates
// it raises, the slow confirm's cost, the per-crossing total at 64 entries, the plaintext scrub as the baseline, and how
// one filter hit compares with the pass's own spread (the timing oracle).
//
//     node --import tsx notebooks/secrets/measure-matcher.mjs     (writes data/mask-matcher/matcher.json)
//
// Seeded, so a rerun on the same machine measures the same inputs. Run it alone: timings share the CPU.

import { webcrypto as crypto } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registrySubs, scrubRegistry, valueForms } from "../../src/secret-registry.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const N = 1 << 20;              // the text, in UTF-16 code units
const K = 8;                    // the filter window, the 8-character floor
const P = 16777213;             // the filter's modulus, the largest prime under 2^24: w is about 24 bits
const REPEATS = 15;
const ITERS = [1000, 5000, 20000];

/** A seeded generator (mulberry32). */
function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const R = rng(32);
const pick = (s) => s[Math.floor(R() * s.length)];
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const TOKEN = ALNUM + "/+_-";

/** `n` secrets, 16 to 40 characters, the shapes of API tokens and generated passwords. */
const secrets = (n) => Array.from({ length: n }, () => Array.from({ length: 16 + Math.floor(R() * 25) }, () => pick(TOKEN)).join(""));

/** A tool output of `N` units: log lines with words, numbers, hex ids and a base64 blob now and then. */
function corpus() {
    const words = Array.from({ length: 400 }, () => Array.from({ length: 2 + Math.floor(R() * 8) }, () => pick("abcdefghijklmnopqrstuvwxyz")).join(""));
    const parts = [];
    let len = 0;
    while (len < N) {
        const r = R();
        const line = r < 0.7 ? Array.from({ length: 6 + Math.floor(R() * 10) }, () => pick(words)).join(" ")
            : r < 0.85 ? `id=${Array.from({ length: 32 }, () => pick("0123456789abcdef")).join("")} n=${Math.floor(R() * 1e6)}`
                : Array.from({ length: 76 }, () => pick(ALNUM + "+/")).join("");
        parts.push(line, "\n");
        len += line.length + 1;
    }
    return parts.join("").slice(0, N);
}

/** The keyed rolling hash's parameters: a random base mod P, and B^(K-1) to take the leaving unit out. */
const B = 2 + Math.floor(R() * (P - 3));
let BK = 1;
for (let i = 0; i < K - 1; i++) BK = (BK * B) % P;
const filterOf = (s, at = 0) => { let h = 0; for (let i = 0; i < K; i++) h = (h * B + s.charCodeAt(at + i)) % P; return h; };

const enc = new TextEncoder();
/** The slow confirm: PBKDF2-SHA256 over a form, 256 bits. */
async function confirmHash(form, salt, iterations) {
    const key = await crypto.subtle.importKey("raw", enc.encode(form), "PBKDF2", false, ["deriveBits"]);
    return Buffer.from(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256)).toString("hex");
}

/** The table a crossing looks up: filter -> the forms whose first K units give it. Forms under K are refused. */
function tableOf(values) {
    const table = new Map();
    let forms = 0, refused = 0, maxL = 0;
    for (const v of values) for (const f of valueForms(v)) {
        if (f.length < K) { refused++; continue; }
        forms++; maxL = Math.max(maxL, f.length);
        const F = filterOf(f);
        (table.get(F) ?? table.set(F, []).get(F)).push(f);
    }
    return { table, forms, refused, maxL };
}

/** One crossing's filter pass: every position's filter looked up; returns the candidates (position, form). */
function pass(text, table) {
    const cands = [];
    let h = filterOf(text);
    for (let i = 0; ; i++) {
        const hit = table.get(h);
        if (hit) for (const f of hit) if (i + f.length <= text.length) cands.push([i, f]);
        if (i + K >= text.length) break;
        h = ((h - (text.charCodeAt(i) * BK) % P + P) % P * B + text.charCodeAt(i + K)) % P;
    }
    return cands;
}

/** The same pass with the filter checked in a bitset of all P values first (2 MiB), the Map only on a set bit. */
function bitsetOf(table) {
    const bits = new Uint8Array((P >>> 3) + 1);
    for (const F of table.keys()) bits[F >>> 3] |= 1 << (F & 7);
    return bits;
}
function passBits(text, table, bits) {
    const cands = [];
    let h = filterOf(text);
    const n = text.length;
    for (let i = 0; ; i++) {
        if (bits[h >>> 3] & (1 << (h & 7))) for (const f of table.get(h)) if (i + f.length <= n) cands.push([i, f]);
        if (i + K >= n) break;
        h = h - (text.charCodeAt(i) * BK) % P;
        if (h < 0) h += P;
        h = (h * B + text.charCodeAt(i + K)) % P;
    }
    return cands;
}

const ms = (f) => { const t = process.hrtime.bigint(); const r = f(); return [Number(process.hrtime.bigint() - t) / 1e6, r]; };
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

const out = { node: process.version, cpu: cpus()[0]?.model, N, K, P, repeats: REPEATS, configs: [], confirm: [], baseline: [] };
const text0 = corpus();
for (const entries of [1, 8, 64]) {
    const values = secrets(entries);
    const { table, forms, refused, maxL } = tableOf(values);
    // Three true occurrences, as written, as a base64 form and JSON-escaped, so the pass is shown to find them.
    const planted = [values[0], valueForms(values[entries - 1])[4] ?? values[entries - 1], JSON.stringify(values[Math.floor(entries / 2)]).slice(1, -1)];
    let text = text0;
    planted.forEach((p, k) => { const at = Math.floor(((k + 1) * N) / 4); text = text.slice(0, at) + p + text.slice(at + p.length); });
    const times = [];
    let cands = [];
    for (let r = 0; r < REPEATS; r++) { const [t, c] = ms(() => pass(text, table)); times.push(t); cands = c; }
    const bits = bitsetOf(table);
    const btimes = [];
    let bc = [];
    for (let r = 0; r < REPEATS; r++) { const [t, c] = ms(() => passBits(text, table, bits)); btimes.push(t); bc = c; }
    if (bc.length !== cands.length) throw new Error("the bitset pass disagrees with the Map pass");
    const truePos = cands.filter(([i, f]) => text.startsWith(f, i)).length;
    out.configs.push({ entries, forms, refused, maxL, passMedianMs: q(times, 0.5), passP10Ms: q(times, 0.1), passP90Ms: q(times, 0.9),
        bitsMedianMs: q(btimes, 0.5), bitsP10Ms: q(btimes, 0.1), bitsP90Ms: q(btimes, 0.9),
        candidates: cands.length, truePositives: truePos, falseCandidates: cands.length - truePos, expectedFalse: (N * forms) / P, planted: planted.length });
    const subs = registrySubs(values.map((v, k) => ({ name: `S${k}`, value: v })));
    const bt = [];
    for (let r = 0; r < 5; r++) bt.push(ms(() => scrubRegistry(text, subs))[0]);
    out.baseline.push({ entries, subs: subs.length, plaintextMedianMs: q(bt, 0.5) });
}
// --- the false-candidate count over fresh keys: 30 trials per kind of text, each with new secrets, a new base and a new
// text. A candidate is a (position, form) pair whose filter matches and whose form is not there; `hitPositions` counts
// positions; `T` is the number of distinct filters in the table, `D` the number of distinct K-unit windows in the text.
const TRIALS = 30;
/** A text of one kind, from the generator `g`. */
function textOf(kind, g) {
    const pk = (s) => s[Math.floor(g() * s.length)];
    const parts = []; let len = 0;
    const words = Array.from({ length: 400 }, () => Array.from({ length: 2 + Math.floor(g() * 8) }, () => pk("abcdefghijklmnopqrstuvwxyz")).join(""));
    while (len < N) {
        let line;
        if (kind === "random") line = Array.from({ length: 100 }, () => pk(ALNUM)).join("");
        else if (kind === "base64") line = Array.from({ length: 76 }, () => pk(ALNUM + "+/")).join("");
        else if (kind === "json") line = JSON.stringify({ id: Math.floor(g() * 1e9), name: pk(words) + " " + pk(words), tags: [pk(words), pk(words)], score: +(g() * 100).toFixed(3), ok: g() < 0.5 });
        else line = g() < 0.7 ? Array.from({ length: 6 + Math.floor(g() * 10) }, () => pk(words)).join(" ") : `id=${Array.from({ length: 32 }, () => pk("0123456789abcdef")).join("")} n=${Math.floor(g() * 1e6)}`;
        parts.push(line, "\n"); len += line.length + 1;
    }
    return parts.join("").slice(0, N);
}
out.trials = [];
for (const kind of ["random", "base64", "json", "log"]) {
    for (let t = 0; t < TRIALS; t++) {
        const g = rng(1000 * (["random", "base64", "json", "log"].indexOf(kind) + 1) + t);
        const base = 2 + Math.floor(g() * (P - 3));
        let bk = 1; for (let i = 0; i < K - 1; i++) bk = (bk * base) % P;
        const fil = (s, at = 0) => { let h = 0; for (let i = 0; i < K; i++) h = (h * base + s.charCodeAt(at + i)) % P; return h; };
        const vals = Array.from({ length: 64 }, () => Array.from({ length: 16 + Math.floor(g() * 25) }, () => TOKEN[Math.floor(g() * TOKEN.length)]).join(""));
        const table = new Map(); let E = 0;
        for (const v of vals) for (const f of valueForms(v)) { if (f.length < K) continue; E++; const F = fil(f); (table.get(F) ?? table.set(F, []).get(F)).push(f); }
        const text = textOf(kind, g);
        let h = fil(text), pairs = 0, positions = 0;
        const windows = new Set();
        for (let i = 0; ; i++) {
            const hit = table.get(h);
            if (hit) { let any = false; for (const f of hit) if (i + f.length <= text.length && !text.startsWith(f, i)) { pairs++; any = true; } if (any) positions++; }
            if (t < 3) windows.add(text.substr(i, K));
            if (i + K >= text.length) break;
            h = h - (text.charCodeAt(i) * bk) % P; if (h < 0) h += P;
            h = (h * base + text.charCodeAt(i + K)) % P;
        }
        out.trials.push({ kind, trial: t, E, T: table.size, positions: N - K + 1, falsePairs: pairs, hitPositions: positions, distinctWindows: t < 3 ? windows.size : null });
    }
}

const salt = crypto.getRandomValues(new Uint8Array(16));
for (const iterations of ITERS) {
    const ts = [];
    for (let r = 0; r < 30; r++) { const t = process.hrtime.bigint(); await confirmHash("x".repeat(24), salt, iterations); ts.push(Number(process.hrtime.bigint() - t) / 1e6); }
    out.confirm.push({ iterations, medianMs: q(ts, 0.5), p90Ms: q(ts, 0.9) });
}
mkdirSync(join(HERE, "data", "mask-matcher"), { recursive: true });
writeFileSync(join(HERE, "data", "mask-matcher", "matcher.json"), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));

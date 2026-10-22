// regex-bench.mjs — times native V8 regex searches against regexWork's bound, for regex-cost.ipynb.
//
//     node --import tsx notebooks/readonly/regex-bench.mjs > out.json
//
// Prints ONE JSON object { meta, rows } to stdout. Groups: worst (twenty worst-case shapes), counted (counted repeats at
// up to 2M characters), ordinary (what a real survey runs), fuzz (seeded random patterns that pass riskyRegex, on six
// adversarial inputs; a search whose bound predicts over ~2 s is skipped, and only rows of 1 ms or more are kept).

import os from "node:os";
import { regexWork, REGEX_UNITS_PER_STEP } from "../../src/readonly-exec/regex-cost.ts";
import { riskyRegex } from "../../src/readonly-exec/limits.ts";

const meta = {
    node: process.version, v8: process.versions.v8, platform: `${process.platform}-${process.arch}`,
    cpus: os.cpus()[0]?.model ?? "?", cpu_count: os.cpus().length, loadavg_start: os.loadavg(), date: new Date().toISOString(),
};
const rows = [];
const A = (n, c = "a") => c.repeat(n);

const run = (re, inp, how) => {
    re.lastIndex = 0;
    return how === "split" ? inp.split(re) : how === "replace" ? inp.replace(re, "") : how === "matchAll" ? [...inp.matchAll(re)] : inp.match(re);
};
/** Median-of-3 wall time (ms) of one search; one run when the first takes over 500 ms. */
function timeIt(re, inp, how) {
    run(re, inp.slice(0, 50), how);
    const times = [];
    for (let i = 0; i < 3; i++) {
        const t = process.hrtime.bigint();
        run(re, inp, how);
        times.push(Number(process.hrtime.bigint() - t) / 1e6);
        if (times[0] > 500) break;
    }
    times.sort((a, b) => a - b);
    return times[Math.floor(times.length / 2)];
}
function measure(group, src, flags, inp, how, keep = () => true) {
    try {
        const units = regexWork(src, flags, inp);
        if (!Number.isFinite(units)) { rows.push({ group, pattern: src, flags, method: how, n: inp.length, ms: null, units: null, ns_per_unit: null, steps: null, note: "non-finite bound" }); return; }
        if (group === "fuzz" && units > 2e9) return;
        const ms = timeIt(new RegExp(src, flags), inp, how);
        if (!keep(ms)) return;
        rows.push({ group, pattern: src, flags, method: how, n: inp.length, ms, units, ns_per_unit: (ms * 1e6) / units, steps: Math.ceil(units / REGEX_UNITS_PER_STEP) });
    } catch (e) {
        rows.push({ group, pattern: src, flags, method: how, n: inp.length, ms: null, units: null, ns_per_unit: null, steps: null, note: String(e).slice(0, 120) });
    }
}

// --- worst: twenty worst-case shapes ---
const worst = [
    ["a+b", "", A(30000), "match"], ["a*a*b", "", A(1500), "match"], [".*b.*c", "", A(1500, "b"), "match"],
    ["a?".repeat(18) + "a".repeat(18), "", A(17), "match"], ["a{1,5000}b", "", A(30000), "match"], ["(?=a+b)", "", A(30000), "match"],
    ["(a*)\\1b", "", A(1500), "match"], ["(?:a+b|a+c)", "", A(20000), "match"], ["A+b", "i", A(30000), "match"],
    ["\\s*x", "g", A(30000, " "), "split"], ["a+b", "g", A(30000), "replace"], ["\\p{L}+1", "u", A(30000), "match"],
    ["^.*b.*c$", "gm", (A(300, "b") + "\n").repeat(50), "matchAll"], ["\\w+@", "g", "word ".repeat(200000), "match"],
    ["[a-z]+\\d", "", A(30000), "match"], ["(?<=a+)b", "", A(3000) + "c", "match"],
    ["\\b\\w+\\s+\\w+\\s+x", "", "aa ".repeat(20000), "match"], ["(?:ab)+c", "", "ab".repeat(15000), "match"],
    ["a+" + "a".repeat(200) + "x", "", A(5000), "match"], ["[^\"]*\"[^\"]*x", "", A(1500), "match"],
];
for (const [s, f, i, h] of worst) measure("worst", s, f, i, h);

// --- counted: counted repeats at up to 2M characters (replace) ---
const counted = [
    ["\\w{0,50}b", "g", A(2_000_000)], ["(?:\\d{0,50}|[ab]{3})?\\s*b+", "u", "1".repeat(2_000_000)], ["\\s{0,50}\\w+?(a)?", "m", " ".repeat(2_000_000)],
    ["a{1,5000}b", "", A(60000)], ["a{0,500}a{0,500}b", "", A(20000)], ["[ab]{2,300}c", "gi", "ab".repeat(500000)],
];
for (const [s, f, i] of counted) measure("counted", s, f, i, "replace");

// --- ordinary: what a real survey runs (match) ---
const log = Array.from({ length: 10000 }, (_, i) => `2026-10-22T10:${String(i % 60).padStart(2, "0")} INFO worker ${i} handled request /api/v1/items/${i} in ${i % 97}ms status=200 ${"x".repeat(i % 120)}`).join("\n");
const prose = "The quick brown fox jumps over the lazy dog, 42 times; e-mail me at a.b@c.de. ".repeat(13000);
const ord = [
    ["^.*error.*$", "gm", log], ["error.*$", "m", log], ["\\w+@\\w+\\.\\w+", "g", prose], ["\\d+", "g", prose], ["\\s*,\\s*", "g", prose],
    ["(\\w+)\\s+\\1", "g", prose.slice(0, 50000)], ["status=(\\d+)", "g", log], ["[A-Z][a-z]+", "g", prose], ["^\\s+|\\s+$", "g", prose],
    ["\"([^\"]*)\"", "g", JSON.stringify(log.split("\n"))],
];
for (const [s, f, i] of ord) measure("ordinary", s, f, i, "match");

// --- fuzz: seeded random patterns passing riskyRegex, six adversarial inputs, replace ---
const atoms = ["a", "b", ".", "\\w", "\\s", "[ab]", "[^b]", "\\d", "(?:ab)", "(a)", "\\b", "(?=a)", "(?!b)", "\\1"];
const quants = ["", "", "*", "+", "?", "{2,}", "{0,50}", "{3}", "*?", "+?"];
for (const seedStart of [1, 2, 3]) {
    let seed = seedStart;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const gen = (d = 0) => { let s = ""; const k = 1 + Math.floor(rnd() * 4); for (let i = 0; i < k; i++) s += (d < 1 && rnd() < 0.15 ? `(?:${gen(d + 1)}|${gen(d + 1)})` : pick(atoms)) + pick(quants); return s; };
    const n = 3000;
    const inputs = [A(n), "ab".repeat(n / 2), A(n, " "), A(n - 1) + "c", (A(50) + " ").repeat(n / 51), A(n, "1")];
    for (let t = 0; t < 400; t++) {
        const src = gen(); const flags = pick(["", "i", "g", "m", "u"]);
        try { new RegExp(src, flags); } catch { continue; }
        if (riskyRegex(src)) continue;
        for (const inp of inputs) measure("fuzz", src, flags, inp, "replace", (ms) => ms >= 1);
    }
}

meta.loadavg_end = os.loadavg();
meta.seconds = Math.round((Date.now() - Date.parse(meta.date)) / 1000);
process.stdout.write(JSON.stringify({ meta, rows }));

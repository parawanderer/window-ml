// regex-cost.test.mjs — the bound on a regex search's backtracking (src/readonly-exec/regex-cost.ts): it grows with the
// shape of the INPUT the way the engine's work does, it reads every pattern syntax the repo uses, and its own scans are
// billed before they run. The halting cases through the dialect are tests/readonly-soundness.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { regexWork, regexSteps, REGEX_UNITS_PER_STEP } from "../src/readonly-exec/regex-cost.ts";
import { riskyRegex, STEP_BUDGET } from "../src/readonly-exec/limits.ts";

const A = (n) => "a".repeat(n);

// --- the bound follows the input -----------------------------------------------------------------------------------

test("one quantifier before a failing atom is quadratic in the run it repeats, two are cubic", () => {
    const ratio = (src, n) => regexWork(src, "", A(2 * n)) / regexWork(src, "", A(n));
    assert.ok(Math.abs(ratio("a+b", 10000) - 4) < 0.1, `a+b doubles to ${ratio("a+b", 10000)}x`);
    assert.ok(Math.abs(ratio("a*a*b", 1000) - 8) < 0.2, `a*a*b doubles to ${ratio("a*a*b", 1000)}x`);
    assert.ok(regexSteps("a+b", "", A(300000)) > STEP_BUDGET, "the todo's case is over the whole budget");
});

test("the same pattern on text whose runs are short is linear", () => {
    const words = "word ".repeat(200000);
    for (const src of ["\\w+@", "\\s*,\\s*", "[A-Z][a-z]+", "\\d+"]) {
        const w = regexWork(src, "g", words);
        assert.ok(w < 20 * words.length, `${src}: ${w} units for ${words.length} characters`);
    }
});

test("starts: a leading ^ starts once, or once per line with m; a sticky search starts once; a first literal starts where it matches", () => {
    const n = 100000, s = A(n);
    assert.ok(regexWork("^a+b", "", s) < 5 * n, "anchored: linear");
    assert.ok(regexWork("a+b", "y", s) < 5 * n, "sticky: linear");
    const lines = (A(100) + "\n").repeat(1000);
    assert.ok(regexWork("^a+b", "m", lines) < 4 * 101 * 1001 + lines.length, "one start per line, each about three times the line");
    assert.ok(regexWork("ba+c", "", s) <= n + 1, "a first atom that never matches leaves only the cheap starts");
});

test("a lookaround is atomic; an alternation adds its branches; a backreference compares the widest capture", () => {
    const s = A(10000);
    assert.ok(regexWork("(?:a+b|a+c)", "", s) > 1.9 * regexWork("a+b", "", s), "two quadratic branches add");
    assert.ok(regexWork("(?=a+)b", "", s) < 3 * regexWork("a+", "", s), "the lookahead is one path");
    const prose = "the the cat sat ".repeat(1000);
    assert.ok(regexWork("\\b(\\w+)\\s+\\1\\b", "g", prose) < 50 * prose.length, "a word-long capture, a word-long compare");
});

test("a bounded quantifier is capped by its maximum and a chain of optionals by its paths", () => {
    assert.ok(regexWork("a{1,10}b", "", A(100000)) < 100 * 100000, "a small maximum is linear");
    assert.ok(regexSteps("a{1,60000}b", "", A(300000)) > STEP_BUDGET, "a large maximum is not");
    assert.ok(regexSteps("a?".repeat(30) + "a".repeat(30), "", A(30)) > STEP_BUDGET, "2^30 paths on a 30-character input");
});

test("flags are carried into the run scan: i, u and s change what a unit's run is", () => {
    assert.ok(regexWork("A+b", "i", A(10000)) > 1e7, "case-insensitive A runs over a");
    assert.ok(regexWork("A+b", "", A(10000)) < 5e4, "case-sensitive A has no run");
    assert.ok(regexWork(".+b", "s", "\n".repeat(10000)) > 1e7, "s: dot runs over newlines");
    assert.ok(regexWork(".+b", "", "\n".repeat(10000)) < 5e4, "no s: dot stops at each");
    assert.ok(regexWork("\\p{L}+1", "u", A(10000)) > 1e7, "u: a property class runs");
});

test("a ] that opens a class is read as JavaScript reads it, not as PCRE does", () => {
    // In JavaScript `[]` is the empty class and `[^]` any character; a `]` straight after either is a literal outside the
    // class. PCRE and Python read `[]]` and `[^]]` as classes of `]` and of not-`]`. Read the PCRE way, `[^]]+b` over a run
    // of `]` would be priced linear while V8 backtracks through the run from every start (half a minute at 300k).
    const s = "]".repeat(300000);
    assert.equal(new RegExp("[]]+b").exec("]]b"), null, "the engine: [] never matches, so [] ]+ b cannot");
    assert.ok(regexSteps("[]]+b", "", s) < 5000, "[]]+b fails at its first atom everywhere: linear, and priced so");
    assert.ok(regexSteps("[^]]+b", "", s) > STEP_BUDGET, "[^]]+b is any character then ]+ then b: quadratic, refused");
    assert.ok(regexSteps("[^\\]]+b", "", s) < 5000, "an escaped ] stays inside the class: no run of not-] to backtrack over");
});

// --- what the bound refuses to price -------------------------------------------------------------------------------

test("syntax the reader does not know, and a repeated unit the input lets branch, are unbounded", () => {
    assert.equal(regexWork("(?i:a)+b", "", "ab"), Infinity, "a modifier group is not read");
    assert.equal(regexWork("(a+)+b", "", A(30)), Infinity, "riskyRegex's shape, on an input where it branches");
    assert.ok(regexWork("(a+)+b", "", "ab") < 100, "on an input with no run to split, it cannot branch");
});

test("every regex literal in the repository that riskyRegex admits has a finite bound", () => {
    // The parser must read the syntax people actually write; anything it cannot read sends a survey to the human.
    const files = execSync("git ls-files 'src/*.ts' 'src/*.tsx' 'tests/*.mjs' 'scripts/*.mjs'", { encoding: "utf8" }).trim().split("\n");
    const sample = "The quick brown fox, 42 jumps; a.b@c.de [x] (y) {z} \\ / é 😀\nline two\ttab";
    let n = 0;
    const unread = [];
    for (const f of files) {
        const text = readFileSync(f, "utf8");
        for (const m of text.matchAll(/(?<![\w)\]$])\/((?![*/])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+)\/([dgimsuvy]*)/g)) {
            let re;
            try { re = new RegExp(m[1], m[2]); } catch { continue; }
            if (riskyRegex(re.source)) continue;
            n++;
            if (!Number.isFinite(regexWork(re.source, re.flags, sample))) unread.push(`${f}: /${re.source}/${re.flags}`);
        }
    }
    assert.ok(n > 5000, `found ${n} literals`);
    assert.deepEqual(unread, []);
});

// --- the bound's own work is billed --------------------------------------------------------------------------------

test("each run scan is charged before it scans, so a pattern of many units over a long input is refused before the scans", () => {
    const charged = [];
    regexWork("a+b+c+", "", A(100000), (s) => charged.push(s));
    assert.equal(charged.length, 3, "one scan per distinct unit");
    assert.ok(charged.every((s) => s >= 100000 / 256), JSON.stringify(charged));
    let scans = 0;
    assert.throws(() => regexWork("a+b+c+", "", A(100000), () => { scans++; throw new Error("out of budget"); }), /out of budget/);
    assert.equal(scans, 1, "the first charge stops it");
    assert.equal(REGEX_UNITS_PER_STEP, 512);
});

// --- the COST corpus: the bound's order on each input, the same entries the fork's regex_work is held to ---

test("the cost corpus: every entry's bound grows with its input in the stated order, or is unbounded", async () => {
    const { regexCostVectors, regexInput } = await import("./dialect-vectors.mjs");
    const corpus = regexCostVectors("js");
    assert.ok(corpus.length >= 20, `${corpus.length} entries`);
    for (const v of corpus) {
        const at = (k) => regexWork(v.pattern, v.flags, regexInput({ input: { ...v.input, n: v.input.n * k } }));
        if (v.order === null) { assert.equal(at(1), Infinity, `${v.name}: ${v.reason}`); continue; }
        const ratio = at(2) / at(1);
        assert.ok(Math.abs(Math.log2(ratio) - v.order) < 0.1, `${v.name}: /${v.pattern}/${v.flags} doubles to ${ratio.toFixed(2)}x, order ${v.order} (${v.reason})`);
    }
});

// --- the regex CORPUS: the JS dialect's half of the one definition both dialects transcribe ---

// docs/spec/PYTHON_DIALECT.md, "one DEFINITION and one CORPUS": the regex entries of halting.json state each pattern's
// verdict once, and each dialect's check is held to them on its own side (the fork's Lib/test/test_restricted.py reads
// the same file). A verdict this check gives that the corpus does not is a failure here, never drift to tolerate.
test("the regex corpus: every pattern written in JS gets its stated verdict from riskyRegex and the price", async () => {
    const { regexCorpus, regexInput } = await import("./dialect-vectors.mjs");
    const corpus = regexCorpus("halting", "js");
    assert.ok(corpus.length >= 20, `${corpus.length} entries`);
    for (const v of corpus) {
        const { pattern, flags, verdict } = v.regex;
        const jsFlags = flags.replace(/x/g, "");
        new RegExp(pattern, jsFlags);   // a pattern written in JS compiles as JS
        const steps = regexSteps(pattern, jsFlags, regexInput(v.regex));
        const got = riskyRegex(pattern) !== null || !Number.isFinite(steps) ? "refused" : steps > (v.budget ?? STEP_BUDGET) ? "priced" : "ok";
        assert.equal(got, verdict, `${v.name}: ${pattern} (${v.reason})`);
    }
});

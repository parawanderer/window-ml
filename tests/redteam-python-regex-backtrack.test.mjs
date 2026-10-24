// redteam-python-regex-backtrack.test.mjs — three exponential-backtracking escapes in the Python read-only dialect's
// regex gate, reported by [window-ml canvas]. The fork's Lib/restricted.py `risky_regex` is a hand port of the JS
// `riskyRegex` (src/readonly-exec/limits.ts) and reads pattern syntax the way JS spells it, so a spelling only Python's
// `re` understands is misread and the cell runs unasked under autoApprovePython. The fix (parawanderer/cpython#11,
// 1e35340b: a check on `re._parser`'s own parse tree) is merged on the fork but NOT in the shipped core, so each escape
// below is a LAG line, in the shape tests/regex-corpus-core.test.mjs uses: while the core lags, the test reports the
// escape as a todo and the suite stays green; when a rebuild closes it, the test FAILS with "delete its LAG line", so a
// silently passing todo cannot hide that the defence landed. Self-SKIPS without dist/pyodide/ (like
// tests/python-dialect-vectors-wasm.test.mjs).
//
// The gate is only live once `restricted.load_manifests` has run (it is what lifts `re.*` behind `regex_check`), and a
// cell reaches `run_cell` as SOURCE, not as JSON text: the first draft of this file did neither, so every cell was a
// string literal that returned None and the "gate is live" control failed on a core whose gate was never installed.
// Both are fixed here and pinned by the positive controls below.
//
// Measured on the shipped core (tools/pyodide-dist.json pin 0169c4fd), each escape's cost doubles per added input
// character inside one `re.search` the cell budget never sees: the `{,n}` spelling runs 7.8 ms at N=16 and 283 ms at
// N=22; the verbose-64 and conditional shapes 2.2 ms at N=16 and 130 ms at N=22. N=16 is a hang guard and an assertion
// on NotInDialect, never a timing run at N=40.
import { test, before } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";

const PYODIDE_DIR = path.resolve(import.meta.dirname, "../dist/pyodide");
const DATA_DIR = path.resolve(import.meta.dirname, "../notebooks/python-dialect/data");
const PIN = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../tools/pyodide-dist.json"), "utf8")).cpython.commit;
const hasPyodide = fs.existsSync(path.join(PYODIDE_DIR, "pyodide.mjs"));
let py = null;
let skip = hasPyodide ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";

// --- the pin lag: the fork has the fix, the core in dist/pyodide does not ---------------------------------------------
//
// Same contract as regex-corpus-core.test.mjs's LAG table (one DEFINITION and one CORPUS), on the end-to-end cell
// rather than the verdict: that file reads restricted.risky_regex/risky_parse, this one runs the cell through
// run_cell and asserts NotInDialect before re.search runs. A key listed here whose escape is now closed FAILS (a
// rebuild shipped its fix: delete the line and keep the defended assertion below it). A mismatch on an escape NOT
// listed here fails too. The key is the fork commit that fixes it.
const TREE = "1e35340b"; // parawanderer/cpython#11: the parse-tree check (three exponential escapes, open in the shipped core)
const LAG = {
    "{,n}": TREE,
    "verbose-64": TREE,
    "conditional": TREE,
};

// --- the harness: one cell through restricted.run_cell, as python-dialect-vectors-wasm.test.mjs runs a vector ---
//
// `wml_cell` takes the cell's JSON text and decodes it (the `cellParse` pattern), and the allow tables are installed
// from notebooks/python-dialect/data before any cell runs: without `load_manifests`, `import re` itself is refused and
// no pattern ever reaches `regex_check`.

const HARNESS = `
import json, _restricted, restricted

def wml_cell(src_json):
    src = json.loads(src_json)
    try:
        v = restricted.run_cell(src, {})
        return json.dumps({"ran": True, "value": repr(v)[:80]})
    except BaseException as e:
        return json.dumps({"ran": False, "exc": type(e).__name__,
                           "not_in_dialect": isinstance(e, _restricted.NotInDialect), "msg": str(e)[:160]})
`;

before(async () => {
    if (!hasPyodide) return;
    const { loadPyodide } = await import(path.join(PYODIDE_DIR, "pyodide.mjs"));
    py = await loadPyodide({ indexURL: PYODIDE_DIR });
    const probe = py.runPython(`import importlib.util; "restricted" if importlib.util.find_spec("_restricted") else "stock"`);
    if (probe === "stock") { skip = "dist/pyodide is the stock Pyodide, not the restricted-mode build — `npm run fetch-pyodide` once tools/pyodide-dist.json has an artefact"; return; }
    py.FS.mkdirTree("/dialect-data");
    py.mountNodeFS("/dialect-data", DATA_DIR);
    py.runPython(HARNESS);
    py.runPython(`_restricted.reset(); restricted.load_manifests("/dialect-data")`);
}, { timeout: 240000 });

/** `restricted.run_cell(src, {})`'s answer: `{ ran, value }` or `{ ran: false, exc, not_in_dialect, msg }`. */
function cell(src) {
    return JSON.parse(py.runPython(`wml_cell(${JSON.stringify(JSON.stringify(src))})`));
}
/** The defended outcome: the gate refuses the pattern before `re.search` runs. */
function refused(out) {
    return out.ran === false && out.not_in_dialect === true;
}
/**
 * The LAG verdict for one escape: `null` when the core has no lag entry (assert the defended outcome), otherwise
 * either `assert.fail`s (the escape closed: delete the line) or `t.todo`s and returns (still open). Call with the key
 * in `LAG` and the cell's answer.
 */
function lag(t, key, out, defend) {
    const lag = LAG[key];
    if (lag && refused(out)) assert.fail(`the ${key} escape is closed (${lag} shipped): delete its LAG line and keep the defended assertion`);
    if (lag) { t.todo(`${lag} not in the shipped core (pin ${PIN.slice(0, 8)}): ${defend.why} — the cell ran: ${JSON.stringify(out)}`); return false; }
    return true;
}

// --- the gate is live: the pattern shapes it does see are refused, by the regex check itself ---

test("RED TEAM: the regex gate is live — the repeated-group shapes it knows are NotInDialect", (t) => {
    if (skip) return t.skip(skip);
    // Positive control: a safe pattern runs and returns. Without it, a core with no `re` lifted (or no gate at all)
    // would pass the refusals below for the wrong reason.
    const safe = cell("import re\nreturn bool(re.search(r'^a+$', 'aaa'))");
    assert.equal(safe.ran, true, `the harness runs a safe re: ${JSON.stringify(safe)}`);
    assert.equal(safe.value, "True");
    for (const src of [
        "import re\nreturn bool(re.search(r'(a+)+$', 'a' * 16 + '!'))",
        "import re\nreturn bool(re.search(r'(a|a)+$', 'a' * 16 + '!'))",
        "import re\nreturn bool(re.search(r'(\\w+\\s?)*$', 'a' * 16 + '!'))",
    ]) {
        const out = cell(src);
        assert.ok(refused(out), `the gate refused it: ${JSON.stringify(out)}\n${src}`);
        assert.match(out.msg, /could backtrack exponentially/, `the REGEX gate refused it, not some earlier one: ${JSON.stringify(out)}`);
    }
});

// --- Python-only spellings the hand port misreads (the three reported escapes) ---
//
// Each cell is the defended outcome (NotInDialect) with a positive control that the same harness runs a safe `re` and
// returns. N is 16: measured on the shipped core the cost doubles per added character (0.005 s at 14, 0.28 s at 22,
// about a day at 40), so 16 is a hang guard and an assertion on NotInDialect, never a timing run at 40.

test("RED TEAM: a `{,n}` count inside a repeated group is refused (Python spells {0,n}; JS's isRepeat reads {,n} as literal)", (t) => {
    if (skip) return t.skip(skip);
    const safe = cell("import re\nreturn bool(re.search(r'^a{1,5}$', 'aaa'))");
    assert.equal(safe.ran, true, `the harness runs a safe re: ${JSON.stringify(safe)}`);
    assert.equal(safe.value, "True");
    const out = cell("import re\nreturn bool(re.search(r'^(a{,5})+$', 'a' * 16 + '!'))");
    if (!lag(t, "{,n}", out, {
        why: "risky_regex's isRepeat port reads `{` as a repeat only when `\\{\\d+(,\\d*)?\\}` matches, so `(a{,5})+` is not a repeated group containing a quantifier: `re.search(r'^(a{,5})+$', 'a'*N + '!')` runs unasked under autoApprovePython and doubles per added character (7.8 ms at N=16, 283 ms at N=22 on the shipped core)",
    })) return;
    assert.ok(refused(out), `the {,n} count must be NotInDialect, got ${JSON.stringify(out)}`);
});

test("RED TEAM: verbose mode passed as the flag's integer value is refused (re.X is blocked, 64 is not)", (t) => {
    if (skip) return t.skip(skip);
    const safe = cell("import re\nreturn bool(re.search(r'^a+$', 'aaa', 64))");
    assert.equal(safe.ran, true, `the harness runs a safe re with an integer flag: ${JSON.stringify(safe)}`);
    const out = cell("import re\nreturn bool(re.search('^(a+ # )\\n)+$', 'a' * 16 + '!', 64))");
    if (!lag(t, "verbose-64", out, {
        why: "risky_regex reads the pattern the way JS spells it, so `re.search('^(a+ # )\\n)+$', 'a'*N + '!', 64)`'s `#` comment and newline are literals to the port and the `)+` is not a repeated group containing a quantifier; Python's re.X makes the comment and whitespace vanish and the real pattern is `^(a+)+$`. Runs unasked under autoApprovePython (2.2 ms at N=16, 130 ms at N=22 on the shipped core)",
    })) return;
    assert.ok(refused(out), `a verbose-mode-hidden repeat must be NotInDialect, got ${JSON.stringify(out)}`);
});

test("RED TEAM: a conditional group hiding an inner quantifier is refused", (t) => {
    if (skip) return t.skip(skip);
    // The safe conditional must take the YES branch, so group 1 has to match: `xb`, not `b`.
    const safe = cell("import re\nreturn bool(re.search(r'^(x)?(?(1)b)$', 'xb'))");
    assert.equal(safe.ran, true, `the harness runs a safe conditional group: ${JSON.stringify(safe)}`);
    assert.equal(safe.value, "True");
    const out = cell("import re\nreturn bool(re.search(r'^(x)?(?(1)b|(a+))+$', 'a' * 16 + '!'))");
    if (!lag(t, "conditional", out, {
        why: "risky_regex takes `(?(1)…)` for a group prefix like `(?:` and skips past it, so `re.search(r'^(x)?(?(1)b|(a+))+$', 'a'*N + '!')`'s inner `(a+)` is never marked as a quantifier inside the repeated outer group. Runs unasked under autoApprovePython (2.2 ms at N=16, 137 ms at N=22 on the shipped core)",
    })) return;
    assert.ok(refused(out), `a conditional group hiding a repeat must be NotInDialect, got ${JSON.stringify(out)}`);
});

test("every LAG line names an escape this file's cells reach", () => {
    assert.deepEqual(new Set(Object.keys(LAG)), new Set(["{,n}", "verbose-64", "conditional"]));
    assert.ok(Object.values(LAG).every((k) => k === TREE), "every line is keyed to the fork commit that fixes it");
});

// --- what already holds: these shapes the port does read correctly. Keep them, so a rebuild does not un-break one ---
//
// Re-measured on the shipped core once the harness was fixed (the first draft's refusals were `import re` dying, not
// the gate): each name below says which layer refuses. The next port of risky_regex has to keep every one.

test("RED TEAM: the shapes the port already refuses stay refused", (t) => {
    if (skip) return t.skip(skip);
    const cases = [
        ["a (?#…) comment group hiding a paren (regex_check)", "import re\nreturn bool(re.search(r'(a+(?#()))+$', 'a' * 16 + '!'))", /could backtrack exponentially/],
        ["an inline (?x) whose spacing is plain (regex_check)", "import re\nreturn bool(re.search(r'(?x)^(a + )+$', 'a' * 16 + '!'))", /could backtrack exponentially/],
        ["a list as the pattern (not a str)", "import re\nreturn bool(re.search(['(a+)+$'], 'a' * 16 + '!'))", /needs a pattern string/],
        ["a dict as the pattern (not a str)", "import re\nreturn bool(re.search({'p': '(a+)+$'}, 'a' * 16 + '!'))", /needs a pattern string/],
        ["a numeric pattern (not a str)", "import re\nreturn bool(re.search(123, 'a' * 16 + '!'))", /needs a pattern string/],
        ["a bytes pattern (decoded, then the gate)", "import re\nreturn bool(re.search(rb'(a+)+$', b'a' * 16 + b'!'))", /could backtrack exponentially/],
        ["a class definition (membership: no ClassDef in the dialect)", "import re\nclass P:\n    def __str__(self): return '(a+)+$'\nreturn bool(re.search(P(), 'a' * 16 + '!'))", /ClassDef/],
    ];
    for (const [name, src, why] of cases) {
        const out = cell(src);
        assert.ok(refused(out), `${name}: expected NotInDialect, got ${JSON.stringify(out)}`);
        assert.match(out.msg, why, `${name}: refused by the wrong layer — ${JSON.stringify(out)}`);
    }
});

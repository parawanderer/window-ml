// regex-corpus-core.test.mjs — the regex corpus read against the Python core window-ml SHIPS (dist/pyodide), since that core,
// not the fork's checkout, is what runs a person's cell. The same reader as the fork's RegexCorpusTest (Lib/test/
// test_restricted.py), over the same `regex` entries of tests/fixtures/dialect-vectors/halting.json, on the artifact
// under test (docs/spec/PYTHON_DIALECT.md, "one DEFINITION and one CORPUS"). Self-skips without the restricted core
// (`npm run fetch-pyodide`).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { regexCorpus } from "./dialect-vectors.mjs";

const PYODIDE_DIR = path.resolve(import.meta.dirname, "../dist/pyodide");
const PIN = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../tools/pyodide-dist.json"), "utf8")).cpython.commit;
let py = null, skip = fs.existsSync(path.join(PYODIDE_DIR, "pyodide.mjs")) ? false : "no dist/pyodide: run `npm run fetch-pyodide`";

before(async () => {
    if (skip) return;
    const { loadPyodide } = await import(path.join(PYODIDE_DIR, "pyodide.mjs"));
    py = await loadPyodide({ indexURL: PYODIDE_DIR });
    if (py.runPython(`import importlib.util; "stock" if importlib.util.find_spec("_restricted") is None else "fork"`) === "stock") {
        skip = "dist/pyodide is the stock Pyodide, not the restricted-mode build";
        return;
    }
    // The fork reader's semantics: refused on its shape by risky_regex or risky_parse (the second check is absent from a
    // core older than fork #11, which is then judged by the first alone, as it would run a cell).
    py.runPython(`
import restricted
_WML_FLAGS = {"i": 2, "m": 8, "s": 16, "x": 64}
def wml_regex_verdict(pattern, flags):
    f = sum(_WML_FLAGS.get(c, 0) for c in flags)
    parse = getattr(restricted, "risky_parse", None)
    return "refused" if restricted.risky_regex(pattern) or (parse and parse(pattern, f)) else "passes"
`);
}, { timeout: 240_000 });

// --- the shipped core lags the fork: pin 0169c4fd, before parawanderer/cpython #10 and #11 ---
//
// Every todo below IS the pin lag: the fork has the fix, the core in dist/pyodide does not, so a todo is closed by
// REBUILDING the core and moving tools/pyodide-dist.json's pin, never by a code change here. Each entry names the fork
// commit that fixes it. An entry listed here that the core now judges right FAILS (a rebuild shipped its fix: delete the
// line); a mismatch on an entry NOT listed here FAILS too (the shipped core drifted from the corpus for some other reason).
const EXACT = "59d015a5"; // parawanderer/cpython#10: an exact count is not a quantifier; {0,1} is ?
const TREE = "1e35340b"; // parawanderer/cpython#11: the parse-tree check (three exponential escapes, open in the shipped core)
const LAG = {
    "regex: a ? spelled {0,1} in a repeated group": EXACT,
    "regex: a repeated group of an exact count": EXACT,
    "regex: thousands separators": EXACT,
    "regex: a repeated group of exact counts": EXACT,
    "regex: an exact count spelled as a range": EXACT,
    "regex: an exact count then a literal in a starred group": EXACT,
    "regex: a {,n} count, which only Python spells": TREE,
    "regex: verbose mode, whose comment hides a bracket": TREE,
    "regex: a conditional group's branches": TREE,
};

for (const v of regexCorpus("halting", "py")) {
    test(`the shipped core judges ${v.name.replace(/^regex: /, "")}`, (t) => {
        if (skip) return t.skip(skip);
        const want = v.regex.verdict === "refused" ? "refused" : "passes";   // a priced entry passes the shape check
        const got = py.globals.get("wml_regex_verdict")(v.regex.pattern, v.regex.flags);
        const lag = LAG[v.name];
        if (lag && got === want) assert.fail(`${v.name}: the shipped core now judges it right, so ${lag} shipped: delete its LAG line`);
        if (lag) { t.todo(`${lag} not in the shipped core (pin ${PIN.slice(0, 8)}): rebuild the core`); return; }
        assert.equal(got, want, `${v.name}: ${v.regex.pattern} (${v.reason})`);
    });
}

test("every LAG line names a corpus entry the Python side reads", (t) => {
    if (skip) return t.skip(skip);
    const names = new Set(regexCorpus("halting", "py").map((v) => v.name));
    for (const n of Object.keys(LAG)) assert.ok(names.has(n), `LAG names "${n}", which is not a py or both regex entry`);
});

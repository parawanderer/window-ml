// python-dialect-str-kind.test.mjs — every public method of the core's own `str`, listed in the dialect's str kind or refused with a reason.
//
// whitelist.json's builtin_kinds.str comes from the corpus count (make-corpus-count.py, MIN_CELLS) plus BUILTIN_LISTED.
// str.endswith was missing and a bench corpus replay found it (7 cells refused for it alone), so this file enumerates
// the core's `str` and asserts each public name is LISTED (and a call to it runs inside) or in NOT_LISTED with a reason
// (and reading it asks): a new or missing method shows up here, not in a bench. endswith has startswith's treatment,
// form by form. Self-SKIPS without the fork core in dist/pyodide, as python-dialect-inside.test.mjs does.
import { test, before } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { wrapUserSetup, wrapUserScript } from "../src/python/python-runtime.ts";
import { dialectSetup } from "../src/python/python-dialect-run.js";

const PYODIDE_DIR = path.resolve(import.meta.dirname, "../dist/pyodide");
const DATA_DIR = path.resolve(import.meta.dirname, "../notebooks/python-dialect/data");
const FILES = Object.fromEntries(["whitelist.json", "manifest-stdlib.json", "manifest-numpy.json", "manifest-pandas.json", "manifest-pil.json"]
    .map((f) => [f, fs.readFileSync(path.join(DATA_DIR, f), "utf8")]));
const WHITELIST = JSON.parse(FILES["whitelist.json"]);
const NODES = WHITELIST.nodes;
const hasPyodide = fs.existsSync(path.join(PYODIDE_DIR, "pyodide.mjs"));

let py = null;
let skip = hasPyodide ? false : "no dist/pyodide — run `npm run fetch-pyodide` to enable";

before(async () => {
    if (!hasPyodide) return;
    const { loadPyodide } = await import(path.join(PYODIDE_DIR, "pyodide.mjs"));
    py = await loadPyodide({ indexURL: PYODIDE_DIR });
    if (py.runPython(`import importlib.util; importlib.util.find_spec("_restricted") is None`)) { skip = "dist/pyodide is the stock core, not the restricted-mode fork"; return; }
    await py.loadPackage(["numpy", "pandas", "pillow"]);
    assert.strictEqual(String(await py.runPythonAsync(dialectSetup(FILES))), "");
}, { timeout: 240000 });

/** One cell inside the dialect in a fresh namespace, as the worker runs it: refused, an error, or its value. */
async function inside(code) {
    const ns = py.globals.get("dict")();
    await py.runPythonAsync(wrapUserSetup(false, "run"), { globals: ns });
    await py.runPythonAsync(wrapUserScript(code, "run", { nodes: NODES }), { globals: ns });
    const refused = ns.get("_ml_not_in_dialect");
    if (refused) return { refused: String(refused) };
    const err = ns.get("_err");
    if (err) return { error: String(err) };
    return { value: String(ns.get("_json_result")) };
}

/** The outcome's kind alone, for comparing two forms: "refused", "error" or "value". */
const kind = (r) => Object.keys(r)[0];

// --- ENUMERATED: the core's str, name by name ---

/** A call to each listed method, run inside on a short string: it must give a value. */
const LISTED_CALLS = {
    endswith: `"a.csv".endswith(".csv")`, find: `"abc".find("b")`, index: `"abc".index("b")`, isdigit: `"12".isdigit()`,
    join: `",".join(["a", "b"])`, lower: `"AB".lower()`, replace: `"ab".replace("a", "c")`, split: `"a b".split()`,
    splitlines: `"a\\nb".splitlines()`, startswith: `"a.csv".startswith("a")`, strip: `" a ".strip()`, upper: `"ab".upper()`,
};

/** Every public method of the core's str that is NOT in the str kind, with why. "Read-only, unlisted" means nothing
 *  stops listing it but a need: add it to BUILTIN_LISTED (make-corpus-count.py) when a cell needs it. */
const UNLISTED_READ_ONLY = "read-only, unlisted: no counted cell calls it at MIN_CELLS and no replay has needed it";
const NOT_LISTED = {
    capitalize: UNLISTED_READ_ONLY, casefold: UNLISTED_READ_ONLY, count: UNLISTED_READ_ONLY,
    isalnum: UNLISTED_READ_ONLY, isalpha: UNLISTED_READ_ONLY, isascii: UNLISTED_READ_ONLY, isdecimal: UNLISTED_READ_ONLY,
    isidentifier: UNLISTED_READ_ONLY, islower: UNLISTED_READ_ONLY, isnumeric: UNLISTED_READ_ONLY,
    isprintable: UNLISTED_READ_ONLY, isspace: UNLISTED_READ_ONLY, istitle: UNLISTED_READ_ONLY, isupper: UNLISTED_READ_ONLY,
    lstrip: UNLISTED_READ_ONLY, partition: UNLISTED_READ_ONLY, removeprefix: UNLISTED_READ_ONLY,
    removesuffix: UNLISTED_READ_ONLY, rfind: UNLISTED_READ_ONLY, rindex: UNLISTED_READ_ONLY,
    rpartition: UNLISTED_READ_ONLY, rsplit: UNLISTED_READ_ONLY, rstrip: UNLISTED_READ_ONLY, swapcase: UNLISTED_READ_ONLY,
    title: UNLISTED_READ_ONLY, maketrans: UNLISTED_READ_ONLY, translate: UNLISTED_READ_ONLY,
    center: "read-only, but its result's length is an argument; unlisted until a cell needs it",
    ljust: "the same as center", rjust: "the same as center", zfill: "the same as center",
    expandtabs: "the same as center (the tab width)",
    format: "reads its arguments' attributes and items by names inside the format string ('{0.__class__}'), which no node of the cell shows",
    format_map: "the same as format",
    encode: "returns bytes, and bytes is not a kind the dialect lists",
};

test("ENUMERATED: every public method of the core's str is listed, or unlisted with a reason; none is new", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    const core = JSON.parse(String(py.runPython(`import json; json.dumps(sorted(n for n in dir(str) if not n.startswith("_")))`)));
    assert.ok(core.length > 40, `only ${core.length} public str methods: the enumeration is broken`);
    const listed = [...WHITELIST.builtin_kinds.str].sort();
    assert.deepStrictEqual(listed, Object.keys(LISTED_CALLS).sort(), "the str kind changed: give the new name a call in LISTED_CALLS");
    assert.deepStrictEqual(core, [...listed, ...Object.keys(NOT_LISTED)].sort(),
        "the core's str gained or lost a public method: list it (BUILTIN_LISTED) or give its reason in NOT_LISTED");
});

test("every listed str method runs inside; every unlisted one asks when read", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    for (const [name, code] of Object.entries(LISTED_CALLS)) {
        const r = await inside(code);
        assert.ok("value" in r, `${name}: ${JSON.stringify(r)}`);
    }
    for (const name of Object.keys(NOT_LISTED)) {
        const r = await inside(`"ab".${name}`);
        assert.ok(r.refused, `${name} was read inside: ${JSON.stringify(r)}`);
        assert.match(r.refused, new RegExp(`'${name}' of str`), name);
    }
});

// --- str.endswith: startswith's treatment, form by form ---

test("endswith answers as Python does: a suffix, a tuple of them, start and end, and the bench's listing filter", { timeout: 60000 }, async (t) => {
    if (skip) return t.skip(skip);
    const rows = [
        [`"a.csv".endswith(".csv")`, "true"], [`"a.csv".endswith(".txt")`, "false"],
        [`"a.csv".endswith((".txt", ".csv"))`, "true"], [`"a.csv".endswith("a", 0, 1)`, "true"],
        [`[f for f in ["a.csv", "b.txt", "c.csv"] if f.endswith(".csv")]`, `["a.csv", "c.csv"]`],
    ];
    for (const [code, want] of rows) assert.deepStrictEqual(await inside(code), { value: want }, code);
});

/** The forms a cell can reach a str method by: each gives endswith the outcome it gives startswith. */
const FORMS = [
    ["a method call", (m) => `"ab".${m}("b")`],
    ["a tuple argument", (m) => `"ab".${m}(("a", "b"))`],
    ["a bound method kept and called later", (m) => `f = "ab".${m}\nf("b")`],
    ["through the type", (m) => `str.${m}("ab", "b")`],
    ["through getattr", (m) => `getattr("ab", "${m}")("b")`],
    ["* spreading", (m) => `a = ["b"]\n"ab".${m}(*a)`],
    ["** spreading", (m) => `k = {}\n"ab".${m}("b", **k)`],
    ["a non-str argument", (m) => `"ab".${m}(1)`],
    ["a list argument", (m) => `"ab".${m}(["b"])`],
    ["through a value's type", (m) => `type("ab").${m}("ab", "b")`],
    ["on a non-str receiver", (m) => `[1].${m}("b")`],
    ["as a dunder lookup", (m) => `"ab".__class__.${m}`],
];

for (const [label, form] of FORMS) {
    test(`endswith matches startswith inside: ${label}`, { timeout: 60000 }, async (t) => {
        if (skip) return t.skip(skip);
        const s = await inside(form("startswith")), e = await inside(form("endswith"));
        assert.strictEqual(kind(e), kind(s), `startswith ${JSON.stringify(s)}, endswith ${JSON.stringify(e)}`);
    });
}

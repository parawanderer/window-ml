// pkg-verdict.test.mjs — the install verdict (src/python/pkg-verdict.ts) against the notebook it ports, against real installs, and against a hostile index. Run: node --import tsx --test tests/pkg-verdict.test.mjs
//
// The oracle is notebooks/python-packages (pypi-compat.ipynb), pinned for ONE core: its environment (env.json), the
// static verdict pypi.py gave the top 2,000 and their dependencies (static.json), the PyPI answers that verdict read
// (index-snapshot.json), and what a real install and import did over the top 10,000 (verdicts.json). A core bump
// regenerates all four in the same PR (the pyodide-build skill, "After a bump"); the pin test below fails until it does.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const { verdict, dependencies } = await import("../src/python/pkg-verdict.ts");
const { canonicalName } = await import("../src/python/pkg-pep508.ts");

const DATA = new URL("../notebooks/python-packages/data/pypi-compat/", import.meta.url);
const read = (f) => JSON.parse(fs.readFileSync(new URL(f, DATA), "utf8"));
const DIST = JSON.parse(fs.readFileSync(new URL("../tools/pyodide-dist.json", import.meta.url), "utf8"));
const ENV_X = read("env.json"), STATIC_X = read("static.json"), SNAP_X = read("index-snapshot.json"), VERDICTS = read("verdicts.json");
const ENV = ENV_X.rows[0];
const STATIC = STATIC_X.rows.slice(1);

/** The core the notebook probed, as CoreFacts. */
const CORE = {
    tags: ENV.tags,
    markerEnv: ENV.env,
    python: ENV.python,
    lock: new Map(Object.entries(ENV.lock).map(([k, v]) => [canonicalName(k), { version: v.version, file: v.file_name, depends: v.depends }])),
    preloaded: new Set(ENV.preloaded.map(canonicalName)),
};

// The snapshot keeps what the static verdict read and no more: no digests (the cached rows never had them) and no
// sizes for an old release (PyPI's release list has none). The verdict wants both, so this adapter gives a fixed
// digest and size 0; neither decides anything the notebook decided.
const NO_DIGEST = "0".repeat(64);
const INDEX_MAP = new Map(SNAP_X.rows.map((r) => [r.project, {
    latest: r.latest,
    releases: Object.fromEntries(Object.entries(r.releases).map(([v, rel]) => [v, {
        ...("requires_python" in rel ? { requires_python: rel.requires_python } : {}),
        ...("requires_dist" in rel ? { requires_dist: rel.requires_dist } : {}),
        files: rel.files.map((f) => {
            const [filename, size, yanked, rp] = f.split("\t");
            return { filename, sha256: NO_DIGEST, size: Number(size) || 0, yanked: yanked === "1", ...(rp ? { requires_python: rp } : {}) };
        }),
    }])),
}]));
const INDEX = (name) => INDEX_MAP.get(name);

// --- the pin: the oracle is for the core this checkout runs ---

test("pin: every extract is of the core tools/pyodide-dist.json pins", () => {
    const { tag, name } = DIST.artefact;
    assert.equal(ENV_X.source.core, name, "env.json is of another core: rerun the notebook (pyodide-build skill, After a bump)");
    assert.equal(SNAP_X.source.core, name, "index-snapshot.json is of another core");
    assert.ok(VERDICTS[tag], `verdicts.json has no key ${tag}`);
    assert.equal(VERDICTS[tag].core, name);
});

// --- parity with pypi.py's static verdict, every project it judged ---

const BY_NAME = new Map(STATIC.map((r) => [r.project, r]));

/** What pypi.py's row says the verdict is, in the verdict's terms. */
function expected(row) {
    const direct = (r) => r.kind === "python-version" ? "python-version" : r.kind === "not-on-pypi" ? "not-on-index" : "no-build";
    if (row.installable) return { ok: true };
    if (!["lock", "pure-wheel", "wasm-wheel"].includes(row.kind)) return { ok: false, reason: direct(row), at: row.project };
    if (row.blocked_why === "lock-too-old") return { ok: false, reason: "lock-too-old", at: row.blocked_by };
    const b = BY_NAME.get(row.blocked_by);
    return { ok: false, reason: b ? direct(b) : "not-on-index", at: row.blocked_by };
}

test("parity: the verdict pypi.py gave each of the 2,224 projects, and the same blocker", () => {
    const wrong = [];
    for (const row of STATIC) {
        const got = verdict({ name: row.project }, CORE, INDEX);
        const want = expected(row);
        const g = got.ok ? { ok: true } : { ok: false, reason: got.reason, at: got.at };
        if (JSON.stringify(g) !== JSON.stringify(want)) wrong.push({ project: row.project, want, got: g });
    }
    assert.equal(STATIC.length, 2224);
    assert.deepEqual(wrong.slice(0, 10), [], `${wrong.length} differ`);
});

test("parity: an installable project's own wheel, its closure size, and its PyPI bytes", () => {
    const wrong = [];
    for (const row of STATIC.filter((r) => r.installable)) {
        const got = verdict({ name: row.project }, CORE, INDEX);
        const own = got.files.find((f) => f.name === row.project);
        const fromPypi = got.files.filter((f) => f.source === "pypi" && !CORE.lock.has(f.name));
        const g = {
            wheel: row.kind === "lock" ? row.lock_version : own?.filename,
            closure: got.files.length + got.loaded.length,
            bytes: fromPypi.reduce((s, f) => s + f.size, 0),
        };
        const w = { wheel: row.kind === "lock" ? (own?.version ?? CORE.lock.get(row.project).version) : row.wheel.filename, closure: row.closure_size, bytes: row.pypi_wheel_bytes };
        if (JSON.stringify(g) !== JSON.stringify(w)) wrong.push({ project: row.project, want: w, got: g });
    }
    assert.deepEqual(wrong.slice(0, 10), [], `${wrong.length} differ`);
});

test("parity: every release's requirements read to the dependencies pypi.py read (every requirement string of every latest release)", () => {
    const wrong = [];
    let strings = 0;
    for (const row of STATIC.filter((r) => r.kind !== "lock" && INDEX_MAP.has(r.project))) {
        const p = INDEX_MAP.get(row.project), rd = p.releases[p.latest].requires_dist;
        strings += rd.length;
        const got = dependencies(rd, CORE.markerEnv);
        if (JSON.stringify(got?.deps) !== JSON.stringify(row.deps)) wrong.push({ project: row.project, want: row.deps, got: got?.deps });
    }
    assert.ok(strings > 19_000, `${strings} requirement strings`);
    assert.deepEqual(wrong.slice(0, 10), [], `${wrong.length} differ`);
});

// --- against the probe: what a yes meant in a real install and import ---

// The confusion of the verdict with the probe, pinned. A yes that measured "platform", "undeclared host", "import:
// other", "extra", "probe" or "timeout" is a limit a static verdict cannot see (the notebook, section 2): counted, not
// failed. A yes that measured "no build" or "version" is the verdict missing what it should see: each is listed in
// YES_BUT with its reason, and a new one fails.
const PROBE_TABLE = {
    "no / extra": 3, "no / import: other": 2, "no / no build": 438, "no / ok": 23, "no / platform": 1, "no / probe": 1,
    "no / undeclared host": 1, "no / version": 58,
    "yes / extra": 4, "yes / import: other": 8, "yes / no build": 2, "yes / ok": 1314, "yes / platform": 33,
    "yes / probe": 35, "yes / undeclared host": 65, "yes / version": 12,
};
const MICROPIP_NO_BACKTRACK = "micropip does not backtrack: one dependency installs uuid-utils 1.2.0 (tenacity 9.2.1), a later one asks <1.0 (<9.2.0), and the probe's error is that second request; the verdict ignores ranges between non-lock packages";
const YES_BUT = {
    "langchain-core": MICROPIP_NO_BACKTRACK, "langgraph-sdk": MICROPIP_NO_BACKTRACK, "langchain-openai": MICROPIP_NO_BACKTRACK,
    "langchain-text-splitters": MICROPIP_NO_BACKTRACK, "langchain-community": MICROPIP_NO_BACKTRACK,
    "langchain-anthropic": MICROPIP_NO_BACKTRACK, "langchain-google-genai": MICROPIP_NO_BACKTRACK,
    "langchain-classic": MICROPIP_NO_BACKTRACK, "langchain-aws": MICROPIP_NO_BACKTRACK,
    "langchain-mcp-adapters": MICROPIP_NO_BACKTRACK,
    "aws-sam-translator": "asks pydantic~=2.13.3, so the lock's pydantic 2.12.5 is replaced from PyPI, and that release pins pydantic-core==2.46.5 (no build): the verdict walks a replacement's lock dependencies, not its own requirements, as pypi.py does",
    "ndg-httpsclient": "PyPI's JSON declares no requirements, but the install pulls pyopenssl, whose cryptography<51,>=49 is outside the lock's 47.0.0 (the probe's error): the index's metadata is wrong",
    "hydra-core": "needs antlr4-python3-runtime==4.9.*, whose 4.9 releases are sdist-only; the verdict judges a non-lock dependency by its latest release",
    "python3-saml": "PyPI's JSON declares no requirements, but the wheel's METADATA asks for xmlsec: the index's metadata is wrong, and the verdict reads the index",
};

test("probe: the verdict against what installing and importing did, over the top 2,000", () => {
    const probe = VERDICTS[DIST.artefact.tag].verdicts;
    const table = {}, yesBut = [];
    for (const row of STATIC.filter((r) => r.in_top && probe[r.project])) {
        const ok = verdict({ name: row.project }, CORE, INDEX).ok;
        const measured = probe[row.project].verdict;
        const k = `${ok ? "yes" : "no"} / ${measured}`;
        table[k] = (table[k] ?? 0) + 1;
        if (ok && (measured === "no build" || measured === "version")) yesBut.push(row.project);
    }
    assert.deepEqual(yesBut.filter((p) => !YES_BUT[p]), [], "a yes the probe measured as no build or version: find why, then list it");
    assert.deepEqual(Object.keys(YES_BUT).filter((p) => !yesBut.includes(p)), [], "a listed project the verdict now gets right: drop it");
    assert.deepEqual(table, PROBE_TABLE);
});

test("probe: the spec's figures, counted the notebook's way, over the top 1,000", () => {
    // Section 2's fair count: a probe artefact or an undeclared host package is neither a right nor a wrong yes.
    // docs/spec/PYTHON_DIALECT.md says 96.4% and 99.0%, from section 2's own run of the top 1,000 (installs.json); this
    // is the 10,000 run (verdicts.json), which moved a few projects' outcome, so recall reads 99.2%.
    const probe = VERDICTS[DIST.artefact.tag].verdicts;
    const fair = STATIC.filter((r) => r.in_top && r.rank <= 1000 && probe[r.project] && !["probe", "undeclared host"].includes(probe[r.project].verdict));
    const yes = new Set(fair.filter((r) => verdict({ name: r.project }, CORE, INDEX).ok).map((r) => r.project));
    const works = fair.filter((r) => probe[r.project].verdict === "ok");
    const pct = (a, b) => (100 * a / b).toFixed(1);
    assert.equal(pct([...yes].filter((p) => probe[p].verdict === "ok").length, yes.size), "96.4", "right when it says yes");
    assert.equal(pct(works.filter((r) => yes.has(r.project)).length, works.length), "99.2", "says yes to what works");
});

// --- the defaults ---

test("defaults: a name the index lacks is not-on-index; a lock package is the lock's file; a loaded one is loaded", () => {
    assert.deepEqual(verdict({ name: "no-such-project-xyz" }, CORE, INDEX), { ok: false, reason: "not-on-index", at: "no-such-project-xyz" });
    const numpy = CORE.lock.get("numpy");
    assert.deepEqual(verdict({ name: "NumPy" }, CORE, INDEX), { ok: true, loaded: [], files: [{ name: "numpy", version: numpy.version, filename: numpy.file, source: "lock" }] });
    assert.deepEqual(verdict({ name: "packaging" }, CORE, INDEX), { ok: true, loaded: ["packaging"], files: [] });
});

// --- a hostile index: what it can make the verdict say, and what it cannot make it do ---

const { VERDICT_BOUNDS, parseWheelFilename } = await import("../src/python/pkg-verdict.ts");
const { MAX_REQUIREMENT_CHARS, MAX_MARKER_DEPTH } = await import("../src/python/pkg-pep508.ts");
const { MAX_SPECIFIER_CHARS, MAX_VERSION_CHARS } = await import("../src/python/pkg-pep440.ts");

const H_CORE = {
    tags: ["cp314-cp314-pyodide_2026_0_wasm32", "py3-none-any"],
    markerEnv: ENV.env,
    python: ENV.python,
    lock: new Map([
        ["lib-lock", { version: "1.0", file: "lib_lock-1.0-py3-none-any.whl", depends: [] }],
        ["packaging", { version: "26.0", file: "packaging-26.0-py3-none-any.whl", depends: [] }],
    ]),
    preloaded: new Set(["packaging"]),
};
const SHA = "a".repeat(64);
const wheel = (name, version, extra = {}) => ({ filename: `${name.replace(/-/g, "_")}-${version}-py3-none-any.whl`, sha256: SHA, size: 10, yanked: false, ...extra });
/** A one-release project; `rel` overrides the release's fields. */
const proj = (name, version, rel = {}) => ({ latest: version, releases: { [version]: { requires_python: "", requires_dist: [], files: [wheel(name, version)], ...rel } } });
const index = (projects) => (n) => Object.hasOwn(projects, n) ? projects[n] : undefined;
const V = (name, projects, core = H_CORE) => verdict({ name }, core, index(projects));
const names = (v) => v.ok ? v.files.map((f) => `${f.name}==${f.version}@${f.source}`) : v;

test("hostile: a filename that could name a path, or another project or release, is never a candidate", () => {
    const bad = [
        "../evil-1.0-py3-none-any.whl", "sub/evil-1.0-py3-none-any.whl", "sub\\evil-1.0-py3-none-any.whl",
        "evil-1.0-py3-none-any.whl\u0000", "évil-1.0-py3-none-any.whl", "evil-1.0-py3-none-any.whl ", " evil-1.0-py3-none-any.whl",
        "evil..x-1.0-py3-none-any.whl", "evil-1.0-py3-none-any..whl", "evil-1.0-py3-none-any.tar.gz", "evil-1.0-py3-none-any.WHL",
        "evil-1.0-py3-none.whl", "evil-1.0-1-2-py3-none-any.whl", "evil-1.0-x-py3-none-any.whl", "evil__x-1.0-py3-none-any.whl",
        "evil-1.0-py3-none-any/.whl", "evil-1.0-py3-none-.whl", "evil-1.0-py3..py2-none-any.whl", "evil-1.0-3py-none-any.whl",
        "evil-not.a.version-py3-none-any.whl", "-1.0-py3-none-any.whl", `evil-1.0-py3-none-${"a".repeat(VERDICT_BOUNDS.filename)}.whl`,
    ];
    for (const filename of bad) {
        assert.deepEqual(V("evil", { evil: proj("evil", "1.0", { files: [wheel("evil", "1.0", { filename })] }) }), { ok: false, reason: "no-build", at: "evil" }, filename);
    }
    for (const f of bad.slice(0, 7)) assert.equal(parseWheelFilename(f), null, f);
    // A wheel of ANOTHER project, or another release, listed under this one: not this release's file.
    for (const filename of ["lib_lock-9.9-py3-none-any.whl", "other-1.0-py3-none-any.whl", "evil-2.0-py3-none-any.whl"]) {
        assert.equal(V("evil", { evil: proj("evil", "1.0", { files: [wheel("evil", "1.0", { filename })] }) }).ok, false, filename);
    }
    // The same release spelled differently is the same release; a build tag is allowed.
    for (const filename of ["evil-1.0.0-py3-none-any.whl", "Evil-1.0-1-py3-none-any.whl", "evil-1.0-py2.py3-none-any.whl"]) {
        assert.equal(V("evil", { evil: proj("evil", "1.0", { files: [wheel("evil", "1.0", { filename })] }) }).ok, true, filename);
    }
    const longest = `evil-1.0-py3-none-${"a".repeat(VERDICT_BOUNDS.filename - "evil-1.0-py3-none-.whl".length)}.whl`;
    assert.equal(longest.length, VERDICT_BOUNDS.filename);
    assert.ok(parseWheelFilename(longest));
});

test("hostile: a file's digest, size and yanked flag are checked, not trusted to be the right type", () => {
    for (const extra of [{ sha256: "A".repeat(64) }, { sha256: "a".repeat(63) }, { sha256: 7 }, { size: -1 }, { size: 1.5 }, { size: "10" },
        { size: Number.MAX_SAFE_INTEGER + 2 }, { yanked: "false" }, { yanked: 0 }, { yanked: true }, { filename: 42 }]) {
        assert.deepEqual(V("evil", { evil: proj("evil", "1.0", { files: [wheel("evil", "1.0", extra)] }) }), { ok: false, reason: "no-build", at: "evil" }, JSON.stringify(extra));
    }
    assert.deepEqual(V("evil", { evil: proj("evil", "1.0", { files: "evil-1.0-py3-none-any.whl" }) }), { ok: false, reason: "malformed", at: "evil" });
    assert.deepEqual(V("evil", { evil: proj("evil", "1.0", { requires_dist: "dep" }) }), { ok: false, reason: "malformed", at: "evil" });
    assert.deepEqual(V("evil", { evil: proj("evil", "1.0", { requires_dist: [7] }) }), { ok: false, reason: "malformed", at: "evil" });
    assert.deepEqual(V("evil", { evil: { latest: "1.0", releases: [] } }), { ok: false, reason: "malformed", at: "evil" });
});

test("hostile: a name that canonicalises onto a lock package gets the lock's file, never the index's", () => {
    const projects = {
        "lib-lock": proj("lib-lock", "9.9"),
        user: proj("user", "1.0", { requires_dist: ["Lib.Lock>=0.5"] }),
        // A wheel named for the lock package, listed under another project.
        squat: proj("squat", "1.0", { files: [wheel("squat", "1.0", { filename: "lib_lock-9.9-py3-none-any.whl" })] }),
    };
    for (const name of ["lib-lock", "Lib_Lock", "LIB.LOCK", "lib--lock", "lib_.lock"]) {
        assert.deepEqual(names(V(name, projects)), ["lib-lock==1.0@lock"], name);
    }
    assert.deepEqual(names(V("user", projects)), ["user==1.0@pypi", "lib-lock==1.0@lock"]);
    assert.deepEqual(V("squat", projects), { ok: false, reason: "no-build", at: "squat" });
});

test("hostile: names a prototype holds are looked up as data", () => {
    const parsed = JSON.parse('{"latest":"1.0","releases":{"__proto__":{"files":[]},"1.0":{"requires_dist":["constructor","toString"],"files":[]}}}');
    parsed.releases["1.0"].files = [wheel("evil", "1.0")];
    assert.deepEqual(V("evil", { evil: parsed }), { ok: false, reason: "not-on-index", at: "constructor" });
    assert.deepEqual(V("constructor", {}), { ok: false, reason: "not-on-index", at: "constructor" });
    assert.deepEqual(V("evil", { evil: { latest: "__proto__", releases: {} } }), { ok: false, reason: "malformed", at: "evil" });
    assert.deepEqual(V("hasOwnProperty", { hasownproperty: proj("hasownproperty", "1.0") }).ok, true);
    for (const name of ["__proto__", "", "a b", "../x", "x/", "-x", "x-", "é", 7, null]) {
        assert.equal(verdict({ name }, H_CORE, index({})).reason, "malformed", String(name));
    }
});

test("hostile: cycles and self-dependencies end, and list each package once", () => {
    const projects = {
        a: proj("a", "1.0", { requires_dist: ["b", "a", "a>=99"] }),
        b: proj("b", "1.0", { requires_dist: ["a<1", "b"] }),
    };
    assert.deepEqual(names(V("a", projects)), ["a==1.0@pypi", "b==1.0@pypi"]);
    assert.deepEqual(names(V("b", projects)), ["b==1.0@pypi", "a==1.0@pypi"]);
});

test("hostile: each bound holds at its value and refuses one past it", () => {
    const fan = (n) => ({ root: proj("root", "1.0", { requires_dist: Array.from({ length: n }, (_, i) => `d${i}`) }),
        ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`d${i}`, proj(`d${i}`, "1.0")])) });
    assert.equal(V("root", fan(VERDICT_BOUNDS.packages - 1)).ok, true);
    assert.equal(V("root", fan(VERDICT_BOUNDS.packages)).reason, "too-large");

    const chain = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i}`, proj(`c${i}`, "1.0", { requires_dist: i + 1 < n ? [`c${i + 1}`] : [] })]));
    assert.equal(V("c0", chain(VERDICT_BOUNDS.depth)).ok, true);
    assert.deepEqual(V("c0", chain(VERDICT_BOUNDS.depth + 1)), { ok: false, reason: "too-large", at: `c${VERDICT_BOUNDS.depth}` });

    const sized = (a, b) => ({ x: proj("x", "1.0", { requires_dist: ["y"], files: [wheel("x", "1.0", { size: a })] }), y: proj("y", "1.0", { files: [wheel("y", "1.0", { size: b })] }) });
    assert.equal(V("x", sized(VERDICT_BOUNDS.bytes - 1, 1)).ok, true);
    assert.deepEqual(V("x", sized(VERDICT_BOUNDS.bytes, 1)), { ok: false, reason: "too-large", at: "y" });

    const never = 'never; extra == "z"';
    const reqs = (n) => ({ r: proj("r", "1.0", { requires_dist: Array(n).fill(never) }) });
    assert.equal(V("r", reqs(VERDICT_BOUNDS.requiresDist)).ok, true);
    assert.equal(V("r", reqs(VERDICT_BOUNDS.requiresDist + 1)).reason, "too-large");

    const files = (n) => ({ f: proj("f", "1.0", { files: Array.from({ length: n }, () => wheel("f", "1.0")) }) });
    assert.equal(V("f", files(VERDICT_BOUNDS.files)).ok, true);
    assert.equal(V("f", files(VERDICT_BOUNDS.files + 1)).reason, "too-large");

    const releases = (n) => ({ g: { latest: "0", releases: Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i), { requires_dist: [], files: [wheel("g", String(i))] }])) } });
    assert.equal(V("g", releases(VERDICT_BOUNDS.releases)).ok, true);
    assert.equal(V("g", releases(VERDICT_BOUNDS.releases + 1)).reason, "too-large");

    // Requirement text read by one verdict, across its whole closure.
    const long = (n) => `never; extra == "${"z".repeat(n - 'never; extra == "'.length - 1)}"`;
    const perReq = MAX_REQUIREMENT_CHARS, count = VERDICT_BOUNDS.metadataChars / perReq;
    const meta = (last) => ({ m: proj("m", "1.0", { requires_dist: [...Array(count - 1).fill(long(perReq)), long(last)] }) });
    assert.equal(long(perReq).length, perReq);
    assert.equal(V("m", meta(perReq)).ok, true);
    assert.equal(V("m", { m: proj("m", "1.0", { requires_dist: [...Array(count).fill(long(perReq))] }), ...{} }).ok, true);
    assert.deepEqual(V("m", { m: proj("m", "1.0", { requires_dist: [...Array(count).fill(long(perReq)), "x"] }) }), { ok: false, reason: "too-large", at: "m" });

    // One string's own caps: a requirement, a marker's nesting, a specifier set, a version, a name.
    assert.equal(V("s", { s: proj("s", "1.0", { requires_dist: [long(perReq)] }) }).ok, true);
    assert.equal(V("s", { s: proj("s", "1.0", { requires_dist: [long(perReq + 1)] }) }).reason, "malformed");
    const nest = (d) => `never; ${"(".repeat(d)}extra == "z"${")".repeat(d)}`;
    assert.equal(V("s", { s: proj("s", "1.0", { requires_dist: [nest(MAX_MARKER_DEPTH)] }) }).ok, true);
    assert.equal(V("s", { s: proj("s", "1.0", { requires_dist: [nest(MAX_MARKER_DEPTH + 1)] }) }).reason, "malformed");
    const rp = (n) => ">=3" + ",!=1".repeat((n - 3) / 4);
    assert.equal(rp(MAX_SPECIFIER_CHARS - 1).length, MAX_SPECIFIER_CHARS - 1);
    assert.equal(V("s", { s: proj("s", "1.0", { requires_python: rp(MAX_SPECIFIER_CHARS - 1) }) }).ok, true);
    assert.equal(V("s", { s: proj("s", "1.0", { requires_python: rp(MAX_SPECIFIER_CHARS + 3) }) }).reason, "malformed");
    const ver = (n) => "1." + "0".repeat(n - 2);
    assert.equal(V("s", { s: proj("s", ver(MAX_VERSION_CHARS)) }).ok, true);
    assert.equal(V("s", { s: proj("s", ver(MAX_VERSION_CHARS + 1)) }).reason, "malformed");
    const nm = (n) => "n".repeat(n);
    assert.equal(V(nm(VERDICT_BOUNDS.name), { [nm(VERDICT_BOUNDS.name)]: proj(nm(VERDICT_BOUNDS.name), "1.0") }).ok, true);
    assert.equal(V(nm(VERDICT_BOUNDS.name + 1), {}).reason, "malformed");
});

test("hostile: a requirement, marker or specifier off the grammar is malformed, never skipped", () => {
    for (const req of ['a; python_version >< "3"', 'a; os_name ~= "posix"', 'a; extras == "x"', 'a; dependency_groups == "x"', 'a; "x" == "y"',
        "a>=1.0.*", "a==1.0+local.*", "a (>=1", "a >=1 <2", 'a; python_version >= "3" and', 'a; os_name == "po\\six"', "a; os_name == 'posix",
        "a @ https://example.com/a-1.0-py3-none-any.whl", "a[b c]", "a b", "", "a; os_name == \"posix\" \n", "a ; os_name not  \"x\""]) {
        assert.deepEqual(V("p", { p: proj("p", "1.0", { requires_dist: [req] }), a: proj("a", "1.0") }), { ok: false, reason: "malformed", at: "p" }, JSON.stringify(req));
    }
    for (const rp of [">=3.x", "3.14", ">=3,", "~=3", "== 3.*.1"]) {
        assert.equal(V("p", { p: proj("p", "1.0", { requires_python: rp }) }).reason, rp === ">=3," ? undefined : "malformed", rp);
    }
});

test("hostile: a true and a false marker for every key of the core's environment", () => {
    for (const [key, value] of Object.entries(ENV.env)) {
        const q = value.includes('"') ? "'" : '"';
        const projects = (op) => ({ p: proj("p", "1.0", { requires_dist: [`dep; ${key} ${op} ${q}${value}${q}`] }), dep: proj("dep", "1.0") });
        assert.deepEqual(names(V("p", projects("=="))), ["p==1.0@pypi", "dep==1.0@pypi"], `${key} ==`);
        assert.deepEqual(names(V("p", projects("!="))), ["p==1.0@pypi"], `${key} !=`);
    }
});

test("hostile: requires_python, yanked-only releases, two candidates, and a release without metadata", () => {
    assert.deepEqual(V("p", { p: proj("p", "1.0", { requires_python: "<3.14" }) }), { ok: false, reason: "python-version", at: "p" });
    assert.deepEqual(V("p", { p: proj("p", "1.0", { files: [wheel("p", "1.0", { yanked: true })] }) }), { ok: false, reason: "no-build", at: "p" });
    // A file's own requires_python excludes it alone.
    assert.deepEqual(V("p", { p: proj("p", "1.0", { files: [wheel("p", "1.0", { requires_python: ">=4" })] }) }), { ok: false, reason: "no-build", at: "p" });
    // Two candidates: the compiled one wins over the pure one; of two pure ones, the first.
    const wasm = wheel("p", "1.0", { filename: "p-1.0-cp314-cp314-pyodide_2026_0_wasm32.whl", sha256: "b".repeat(64) });
    const pure2 = wheel("p", "1.0", { filename: "p-1.0-py2.py3-none-any.whl", sha256: "c".repeat(64) });
    assert.equal(V("p", { p: proj("p", "1.0", { files: [wheel("p", "1.0"), wasm] }) }).files[0].filename, wasm.filename);
    assert.equal(V("p", { p: proj("p", "1.0", { files: [wheel("p", "1.0"), pure2] }) }).files[0].sha256, SHA);
    // An older release asked for by version: found by PEP 440 equality; without its requirements it is not decided.
    const two = { p: { latest: "2.0", releases: { "2.0": { requires_dist: [], files: [wheel("p", "2.0")] }, "1.0": { files: [wheel("p", "1.0")] } } } };
    assert.deepEqual(verdict({ name: "p", version: "1.0.0" }, H_CORE, index(two)), { ok: false, reason: "no-metadata", at: "p" });
    assert.deepEqual(verdict({ name: "p", version: "3.0" }, H_CORE, index(two)), { ok: false, reason: "not-on-index", at: "p" });
    assert.deepEqual(verdict({ name: "p", version: "x" }, H_CORE, index(two)).reason, "malformed");
    two.p.releases["1.0"].requires_dist = null;
    assert.deepEqual(names(verdict({ name: "p", version: "1" }, H_CORE, index(two))), ["p==1.0@pypi"]);
});

test("hostile: a lock package too old for a range is replaced from the index only inside every range asked of it", () => {
    const user = (range) => ({ u: proj("u", "1.0", { requires_dist: [`lib-lock${range}`] }) });
    assert.deepEqual(V("u", user(">=2")), { ok: false, reason: "lock-too-old", at: "lib-lock" });
    const libs = { "lib-lock": { latest: "3.1", releases: { "2.5": { files: [wheel("lib-lock", "2.5")] }, "3.1": { requires_dist: [], files: [wheel("lib-lock", "3.1")] } } } };
    assert.deepEqual(names(V("u", { ...user(">=2"), ...libs })), ["u==1.0@pypi", "lib-lock==3.1@pypi"]);
    assert.deepEqual(names(V("u", { ...user(">=2,<3"), ...libs })), ["u==1.0@pypi", "lib-lock==2.5@pypi"]);
    // Two ranges each replaceable alone, with no release inside both: pypi.py says yes, the verdict says no.
    const both = { r: proj("r", "1.0", { requires_dist: ["a", "b"] }), a: proj("a", "1.0", { requires_dist: ["lib-lock<3,>=2"] }), b: proj("b", "1.0", { requires_dist: ["lib-lock>=3"] }), ...libs };
    assert.deepEqual(V("r", both), { ok: false, reason: "lock-too-old", at: "lib-lock" });
    // A loaded package is never replaced, whatever the index offers.
    assert.deepEqual(V("u", { u: proj("u", "1.0", { requires_dist: ["packaging>=99"] }), packaging: proj("packaging", "99.0") }), { ok: false, reason: "lock-too-old", at: "packaging" });
    // Asking for a lock package by another version is the same edge.
    assert.deepEqual(names(verdict({ name: "lib-lock", version: "2.5" }, H_CORE, index(libs))), ["lib-lock==2.5@pypi"]);
    assert.deepEqual(names(verdict({ name: "lib-lock", version: "1.0.0" }, H_CORE, index(libs))), ["lib-lock==1.0@lock"]);
    assert.deepEqual(verdict({ name: "lib-lock", version: "9" }, H_CORE, index(libs)), { ok: false, reason: "lock-too-old", at: "lib-lock" });
});

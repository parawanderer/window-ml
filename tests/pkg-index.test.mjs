// pkg-index.test.mjs — PyPI's JSON read for python_install's verdict (src/python/pkg-index.ts): which names may be looked up, which URLs a wheel may come from, what an untrusted answer may carry, and the rounds of requests behind a verdict. Pure: `get` is a fake. Run: node --import tsx --test tests/pkg-index.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const { lookupName, indexUrl, wheelUrlOk, projectFromJson, withRelease, fileKey, resolveVerdict, INDEX_BOUNDS, IndexRunCap, FILES_HOST } = await import("../src/python/pkg-index.ts");
const { CORE_ENV } = await import("../src/python/core-env.gen.ts");
const { VERDICT_BOUNDS } = await import("../src/python/pkg-verdict.ts");

const ROOT = new URL("../", import.meta.url);
const H = (c) => c.repeat(64);
const url = (fn) => `https://${FILES_HOST}/packages/ab/cd/${fn}`;
/** A PyPI file entry as the JSON API lists it. */
const file = (fn, o = {}) => ({ filename: fn, size: 1000, yanked: false, url: url(fn), digests: { sha256: H("a") }, ...o });
/** A project answer whose latest release is `version`, with its files and requirements. */
const answer = (name, version, files, requires_dist = null, extra = {}) => ({ info: { name, version, requires_python: null, requires_dist }, urls: files, releases: { [version]: files }, ...extra });

// --- the name check ---

test("lookupName: canonicalizes PEP 508 names", () => {
    assert.equal(lookupName("Foo_Bar"), "foo-bar");
    assert.equal(lookupName("foo.bar"), "foo-bar");
    assert.equal(lookupName("a"), "a");
    assert.equal(lookupName("Foo--Bar__baz"), "foo-bar-baz");
});

test("lookupName: refuses what is not a project name or is too long", () => {
    const bad = ["", "-foo", "foo-", ".foo", "foo bar", "foo/bar", "../x", "foo?x=1", "foo#x", "föö", "foo\n", "foo%2e", "a".repeat(VERDICT_BOUNDS.name + 1)];
    for (const n of bad) assert.equal(lookupName(n), null, JSON.stringify(n));
    assert.notEqual(lookupName("a".repeat(VERDICT_BOUNDS.name)), null);
});

// --- URLs ---

test("indexUrl: the project and release JSON URLs, only for names and versions a path can carry", () => {
    assert.equal(indexUrl("foo-bar"), "https://pypi.org/pypi/foo-bar/json");
    assert.equal(indexUrl("foo-bar", "1.0.post1+local"), "https://pypi.org/pypi/foo-bar/1.0.post1%2Blocal/json");
    assert.equal(indexUrl("Foo"), null);
    assert.equal(indexUrl("foo/bar"), null);
    assert.equal(indexUrl("foo", "1/../2"), null);
    assert.equal(indexUrl("foo", ""), null);
    assert.equal(indexUrl("foo", "1".repeat(65)), null);
});

test("wheelUrlOk: accepts https on files.pythonhosted.org ending in the filename", () => {
    assert.equal(wheelUrlOk(url("x-1-py3-none-any.whl"), "x-1-py3-none-any.whl"), true);
});

test("wheelUrlOk: rejects every other shape", () => {
    const fn = "x-1-py3-none-any.whl";
    const bad = {
        http: `http://${FILES_HOST}/packages/ab/${fn}`,
        "another host": `https://evil.example/packages/ab/${fn}`,
        "a look-alike host": `https://${FILES_HOST}.evil.example/packages/ab/${fn}`,
        port: `https://${FILES_HOST}:8443/packages/ab/${fn}`,
        userinfo: `https://user:pw@${FILES_HOST}/packages/ab/${fn}`,
        "user only": `https://user@${FILES_HOST}/packages/ab/${fn}`,
        query: `https://${FILES_HOST}/packages/ab/${fn}?x=1`,
        fragment: `https://${FILES_HOST}/packages/ab/${fn}#x`,
        "another filename": `https://${FILES_HOST}/packages/ab/other-1-py3-none-any.whl`,
        "dot-dot": `https://${FILES_HOST}/packages/../ab/${fn}`,
        "not under /packages/": `https://${FILES_HOST}/other/${fn}`,
        "not a url": "not a url",
        "too long": `https://${FILES_HOST}/packages/${"a/".repeat(1100)}${fn}`,
    };
    for (const [what, u] of Object.entries(bad)) assert.equal(wheelUrlOk(u, fn), false, what);
    for (const v of [undefined, null, 5, {}, ["x"]]) assert.equal(wheelUrlOk(v, fn), false);
});

// --- parsing an untrusted answer ---

test("projectFromJson: keeps a well-formed wheel and records its URL by fileKey", () => {
    const urls = new Map();
    const fn = "foo-1.0-py3-none-any.whl";
    const p = projectFromJson(answer("Foo", "1.0", [file(fn)]), "foo", urls);
    assert.equal(p.latest, "1.0");
    assert.deepEqual(p.releases["1.0"].files, [{ filename: fn, sha256: H("a"), size: 1000, yanked: false }]);
    assert.equal(urls.get(fileKey(H("a"), fn)), url(fn));
});

test("projectFromJson: drops files that cannot be fetched and checked", () => {
    const fn = (i) => `foo-1.${i}-py3-none-any.whl`;
    const cases = {
        "no digests": file(fn(0), { digests: undefined }),
        "no sha256": file(fn(1), { digests: { md5: "x" } }),
        "short sha256": file(fn(2), { digests: { sha256: "abc" } }),
        "uppercase sha256": file(fn(3), { digests: { sha256: H("A") } }),
        "size 0": file(fn(4), { size: 0 }),
        "negative size": file(fn(5), { size: -5 }),
        "fractional size": file(fn(6), { size: 1.5 }),
        "string size": file(fn(7), { size: "1000" }),
        "no size": file(fn(8), { size: undefined }),
        "an sdist": file("foo-1.0.tar.gz"),
        "bad url": file(fn(9), { url: "nope" }),
        "another host": file(fn(10), { url: `https://evil.example/packages/ab/${fn(10)}` }),
        "a missing url": file(fn(11), { url: undefined }),
        "a non-object": "foo.whl",
        "a null": null,
    };
    const urls = new Map();
    const p = projectFromJson(answer("foo", "1.0", Object.values(cases)), "foo", urls);
    assert.deepEqual(p.releases["1.0"].files, []);
    assert.equal(urls.size, 0);
    // positive control: each case is dropped for its own flaw, not for being in this list
    assert.equal(projectFromJson(answer("foo", "1.0", [file("foo-1.0-py3-none-any.whl")]), "foo", new Map()).releases["1.0"].files.length, 1);
});

test("projectFromJson: yanked is only true when true; an own requires_python is kept", () => {
    const f = [file("foo-1-py3-none-any.whl", { yanked: "yes", requires_python: ">=3.9" }), file("foo-2-py3-none-any.whl", { yanked: true, digests: { sha256: H("b") } })];
    const p = projectFromJson(answer("foo", "1", f), "foo", new Map());
    assert.deepEqual(p.releases["1"].files.map((x) => [x.yanked, x.requires_python]), [[false, ">=3.9"], [true, undefined]]);
});

test("projectFromJson: refuses an answer for another project, or one with no latest", () => {
    assert.equal(projectFromJson(answer("bar", "1.0", []), "foo", new Map()), null);
    assert.equal(projectFromJson(answer("Foo_Bar", "1.0", []), "foo-bar", new Map())?.latest, "1.0");
    assert.equal(projectFromJson({ info: { name: "foo" } }, "foo", new Map()), null);
    assert.equal(projectFromJson({ info: { name: "foo", version: "" } }, "foo", new Map()), null);
    assert.equal(projectFromJson({ info: { name: 5, version: "1" } }, "foo", new Map()), null);
    for (const j of [null, undefined, "x", 5, [], {}]) assert.equal(projectFromJson(j, "foo", new Map()), null);
});

test("projectFromJson: requires_dist null (declares none) differs from absent (did not say)", () => {
    const nul = projectFromJson(answer("foo", "1", [], null), "foo", new Map());
    assert.ok("requires_dist" in nul.releases["1"]);
    assert.equal(nul.releases["1"].requires_dist, null);
    const absent = projectFromJson({ info: { name: "foo", version: "1" }, urls: [] }, "foo", new Map());
    assert.ok(!("requires_dist" in absent.releases["1"]));
    const list = projectFromJson(answer("foo", "1", [], ["bar>=1", 5, null]), "foo", new Map());
    assert.deepEqual(list.releases["1"].requires_dist, ["bar>=1"]);
    const junk = projectFromJson(answer("foo", "1", [], "bar"), "foo", new Map());
    assert.ok(!("requires_dist" in junk.releases["1"]));
});

test("projectFromJson: other releases carry files only, and a release with no usable file is left out", () => {
    const j = answer("foo", "2", [file("foo-2-py3-none-any.whl")], null, { releases: {
        "1": [file("foo-1-py3-none-any.whl", { digests: { sha256: H("b") } })], "0.5": [file("foo-0.5.tar.gz")], "2": [] } });
    const p = projectFromJson(j, "foo", new Map());
    assert.deepEqual(Object.keys(p.releases).sort(), ["1", "2"]);
    assert.ok(!("requires_dist" in p.releases["1"]));
});

test("projectFromJson: does not read an inherited property", () => {
    const polluted = Object.create({ info: { name: "foo", version: "1" } });
    assert.equal(projectFromJson(polluted, "foo", new Map()), null);
});

test("withRelease: fills in one release's files and requirements; another answer leaves the project unchanged", () => {
    const urls = new Map();
    const p = projectFromJson(answer("foo", "2", [file("foo-2-py3-none-any.whl")]), "foo", urls);
    const rel = { info: { name: "foo", version: "1", requires_python: ">=3.8", requires_dist: ["bar"] }, urls: [file("foo-1-py3-none-any.whl", { digests: { sha256: H("b") } })] };
    const q = withRelease(p, rel, "foo", "1", urls);
    assert.equal(q.latest, "2");
    assert.deepEqual(q.releases["1"].requires_dist, ["bar"]);
    assert.equal(q.releases["1"].requires_python, ">=3.8");
    assert.equal(q.releases["1"].files.length, 1);
    assert.ok(urls.has(fileKey(H("b"), "foo-1-py3-none-any.whl")));
    assert.ok(q.releases["2"]);
    assert.equal(withRelease(p, { ...rel, info: { ...rel.info, version: "3" } }, "foo", "1", urls), p);
    assert.equal(withRelease(p, { ...rel, info: { ...rel.info, name: "other" } }, "foo", "1", urls), p);
});

// --- resolveVerdict ---

/** A tiny core: a lock of two packages, py3-none-any accepted, Python 3.14. */
const CORE = {
    tags: CORE_ENV.tags, markerEnv: CORE_ENV.markerEnv, python: CORE_ENV.python,
    lock: new Map([
        ["numpy", { version: "2.0.0", file: "numpy-2.0.0-cp314-cp314-pyodide_2026_0_wasm32.whl", depends: [] }],
        ["six", { version: "1.17.0", file: "six-1.17.0-py3-none-any.whl", depends: [] }],
    ]),
    preloaded: new Set(),
};
/** A `get` over a table of answers by URL; a URL not in it is a 404. Records the URLs asked. */
const fakeGet = (table) => { const asked = []; const get = async (u) => { asked.push(u); return table[u] ?? null; }; get.asked = asked; return get; };
const U = (n, v) => `https://pypi.org/pypi/${n}${v ? `/${v}` : ""}/json`;

test("resolveVerdict: a lock package is answered with zero requests", async () => {
    const get = fakeGet({});
    const r = await resolveVerdict({ name: "Six" }, CORE, get);
    assert.equal(r.verdict.ok, true);
    assert.equal(r.requests, 0);
    assert.deepEqual(get.asked, []);
    assert.equal(r.urls.size, 0);
});

test("resolveVerdict: a pure-python package with one PyPI dependency fetches both, with their URLs by fileKey", async () => {
    const top = "top-1.0-py3-none-any.whl", dep = "dep-2.0-py3-none-any.whl";
    const get = fakeGet({
        [U("top")]: answer("top", "1.0", [file(top, { digests: { sha256: H("1") }, size: 11 })], ["dep>=1", "six"]),
        [U("dep")]: answer("dep", "2.0", [file(dep, { digests: { sha256: H("2") }, size: 22 })], null),
    });
    const r = await resolveVerdict({ name: "top" }, CORE, get);
    assert.equal(r.verdict.ok, true, JSON.stringify(r.verdict));
    assert.deepEqual(r.verdict.files.map((f) => [f.name, f.source]).sort(), [["dep", "pypi"], ["six", "lock"], ["top", "pypi"]]);
    assert.deepEqual([...get.asked].sort(), [U("dep"), U("top")]);
    assert.equal(r.requests, 2);
    assert.equal(r.urls.get(fileKey(H("1"), top)), url(top));
    assert.equal(r.urls.get(fileKey(H("2"), dep)), url(dep));
});

test("resolveVerdict: a project PyPI 404s is not-on-index", async () => {
    const r = await resolveVerdict({ name: "nope" }, CORE, fakeGet({}));
    assert.deepEqual(r.verdict, { ok: false, reason: "not-on-index", at: "nope" });
});

test("resolveVerdict: a dependency PyPI 404s refuses naming the dependency", async () => {
    const get = fakeGet({ [U("top")]: answer("top", "1.0", [file("top-1.0-py3-none-any.whl")], ["ghost"]) });
    const r = await resolveVerdict({ name: "top" }, CORE, get);
    assert.equal(r.verdict.ok, false);
    assert.equal(r.verdict.reason, "not-on-index");
    assert.equal(r.verdict.at, "ghost");
});

test("resolveVerdict: a get that throws is index-error naming the request", async () => {
    const r = await resolveVerdict({ name: "Top" }, CORE, async () => { throw new Error("boom"); });
    assert.deepEqual(r.verdict, { ok: false, reason: "index-error", at: "Top" });
});

test("resolveVerdict: IndexRunCap from get is lookup-cap", async () => {
    const r = await resolveVerdict({ name: "top" }, CORE, async () => { throw new IndexRunCap(); });
    assert.deepEqual(r.verdict, { ok: false, reason: "lookup-cap", at: "top" });
});

test("resolveVerdict: more than INDEX_BOUNDS.requests in one check is too-large", async () => {
    // A chain: pkg0 needs pkg1 needs pkg2 ..., one request per round, never ending.
    let n = 0;
    const get = async (u) => {
        n++;
        const m = /pypi\/pkg(\d+)\/json/.exec(u);
        const i = Number(m[1]);
        const fn = `pkg${i}-1.0-py3-none-any.whl`;
        return answer(`pkg${i}`, "1.0", [file(fn, { digests: { sha256: H("c") } })], [`pkg${i + 1}`]);
    };
    const r = await resolveVerdict({ name: "pkg0" }, CORE, get);
    assert.equal(r.verdict.ok, false);
    assert.ok(["too-large"].includes(r.verdict.reason), JSON.stringify(r.verdict));
    assert.ok(n <= INDEX_BOUNDS.requests, `${n} requests`);
});

test("resolveVerdict: an answer for another project than the URL asked is read as not on the index", async () => {
    const get = fakeGet({ [U("top")]: answer("other", "1.0", [file("other-1.0-py3-none-any.whl")]) });
    const r = await resolveVerdict({ name: "top" }, CORE, get);
    assert.deepEqual(r.verdict, { ok: false, reason: "not-on-index", at: "top" });
});

test("resolveVerdict: a requested version other than the latest fetches that release's own JSON", async () => {
    const old = "top-1.0-py3-none-any.whl", cur = "top-2.0-py3-none-any.whl";
    const get = fakeGet({
        [U("top")]: answer("top", "2.0", [file(cur, { digests: { sha256: H("2") } })], ["six"], { releases: { "2.0": [file(cur, { digests: { sha256: H("2") } })], "1.0": [file(old, { digests: { sha256: H("1") } })] } }),
        [U("top", "1.0")]: { info: { name: "top", version: "1.0", requires_python: null, requires_dist: null }, urls: [file(old, { digests: { sha256: H("1") } })] },
    });
    const r = await resolveVerdict({ name: "top", version: "1.0" }, CORE, get);
    assert.equal(r.verdict.ok, true, JSON.stringify(r.verdict));
    assert.deepEqual(get.asked.sort(), [U("top"), U("top", "1.0")].sort());
    assert.deepEqual(r.verdict.files.map((f) => f.filename), [old]);
});

test("resolveVerdict: the latest version asked for makes no release request", async () => {
    const fn = "top-2.0-py3-none-any.whl";
    const get = fakeGet({ [U("top")]: answer("top", "2.0", [file(fn)]) });
    const r = await resolveVerdict({ name: "top", version: "2.0" }, CORE, get);
    assert.equal(r.verdict.ok, true);
    assert.deepEqual(get.asked, [U("top")]);
});

test("INDEX_BOUNDS: the per-call cap is below the per-run cap", () => {
    assert.ok(INDEX_BOUNDS.requests < INDEX_BOUNDS.perRun);
});

// --- the generated core environment ---

test("core-env.gen.ts: the pinned core's name is tools/pyodide-dist.json's artefact name", () => {
    const pin = JSON.parse(fs.readFileSync(new URL("tools/pyodide-dist.json", ROOT), "utf8"));
    assert.equal(CORE_ENV.core, pin.artefact.name);
});

test("core-env.gen.ts: scripts/gen-core-env.mjs --check finds it current", () => {
    const r = spawnSync(process.execPath, ["scripts/gen-core-env.mjs", "--check"], { cwd: ROOT.pathname, encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
});

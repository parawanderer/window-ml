// pkg-card.test.mjs — the install card's model (src/python/pkg-card.ts): a verdict as rows, index text made safe to show, an answer's rows rebuilt and compared. Run: node --import tsx --test tests/pkg-card.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const { cardFromVerdict, shownText, rowsFromAnswer, sameRows, lockEntries, preloadedClosure } = await import("../src/python/pkg-card.ts");
const { verdict, VERDICT_BOUNDS } = await import("../src/python/pkg-verdict.ts");
const { canonicalName } = await import("../src/python/pkg-pep508.ts");

const DATA = new URL("../notebooks/python-packages/data/pypi-compat/", import.meta.url);
const ENV = JSON.parse(fs.readFileSync(new URL("env.json", DATA), "utf8")).rows[0];

const H1 = "a".repeat(64), H2 = "0123456789abcdef".repeat(4);
const lockFile = (o = {}) => ({ name: "numpy", version: "2.0.0", filename: "numpy.whl", source: "lock", sha256: H1, ...o });
const pypiFile = (o = {}) => ({ name: "idna", version: "3.7", filename: "idna-3.7-py3-none-any.whl", source: "pypi", sha256: H2, size: 1234, ...o });
const okVerdict = (files, loaded = []) => ({ ok: true, files, loaded });
const row = (o = {}) => ({ name: "idna", version: "3.7", filename: "idna.whl", source: "pypi", size: 10, sha256: H2, ...o });

// --- cardFromVerdict: the rows of an ok verdict ---

test("cardFromVerdict: a refused verdict passes reason and at through", () => {
    assert.deepEqual(cardFromVerdict({ ok: false, reason: "no-build", at: "foo" }), { ok: false, reason: "no-build", at: "foo" });
});

test("cardFromVerdict: one row per file in order with all six fields", () => {
    const c = cardFromVerdict(okVerdict([pypiFile({ name: "b" }), lockFile({ name: "a" })]));
    assert.equal(c.ok, true);
    assert.deepEqual(c.files.map((f) => f.name), ["b", "a"]);
    for (const f of c.files) assert.deepEqual(Object.keys(f).sort(), ["filename", "name", "sha256", "size", "source", "version"]);
});

test("cardFromVerdict: a lock row has size null and a pypi row its size", () => {
    const c = cardFromVerdict(okVerdict([lockFile({ size: 99 }), pypiFile({ size: 5 })]));
    assert.equal(c.files[0].size, null);
    assert.equal(c.files[1].size, 5);
});

test("cardFromVerdict: totalBytes sums pypi sizes only", () => {
    const c = cardFromVerdict(okVerdict([lockFile({ size: 1000 }), pypiFile({ size: 5 }), pypiFile({ size: 7 })]));
    assert.equal(c.totalBytes, 12);
});

test("cardFromVerdict: loaded is a copy, not the same array", () => {
    const loaded = ["x", "y"];
    const c = cardFromVerdict(okVerdict([], loaded));
    assert.deepEqual(c.loaded, loaded);
    assert.notEqual(c.loaded, loaded);
});

// --- cardFromVerdict: a row the person cannot check in full refuses the whole card ---

const malformedAt = (files, at) => assert.deepEqual(cardFromVerdict(okVerdict(files)), { ok: false, reason: "malformed", at });

test("cardFromVerdict: a file without a sha256 refuses the whole card at that package", () => {
    malformedAt([lockFile({ name: "first" }), lockFile({ name: "bad", sha256: undefined })], "bad");
});

for (const [label, sha] of [["uppercase hex", "A".repeat(64)], ["63 characters", "a".repeat(63)], ["65 characters", "a".repeat(65)], ["non-hex", "g".repeat(64)], ["a number", 5]]) {
    test(`cardFromVerdict: a sha256 of ${label} refuses the whole card`, () => {
        malformedAt([lockFile({ name: "ok1" }), pypiFile({ name: "bad", sha256: sha })], "bad");
    });
}

for (const [label, size] of [["missing", undefined], ["negative", -1], ["fractional", 1.5], ["NaN", NaN], ["above MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER + 1], ["a string", "10"]]) {
    test(`cardFromVerdict: a pypi file with a ${label} size refuses the whole card`, () => {
        malformedAt([lockFile({ name: "ok1" }), pypiFile({ name: "bad", size })], "bad");
    });
}

test("cardFromVerdict: a size of 0 and of MAX_SAFE_INTEGER are accepted for a pypi file", () => {
    assert.equal(cardFromVerdict(okVerdict([pypiFile({ size: 0 })])).ok, true);
    assert.equal(cardFromVerdict(okVerdict([pypiFile({ size: Number.MAX_SAFE_INTEGER })])).ok, true);
});

// --- the real lock: every entry carries a digest and a lock package gives an all-lock card ---

const LOCK_PATH = ["pyodide-core/pyodide-lock.json", "dist/pyodide/pyodide-lock.json"].map((p) => new URL("../" + p, import.meta.url)).find((u) => fs.existsSync(u));
const realLock = LOCK_PATH ? lockEntries(JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")), canonicalName) : null;
const skipReal = LOCK_PATH ? false : "neither pyodide-core/pyodide-lock.json nor dist/pyodide/pyodide-lock.json exists (npm run fetch-pyodide)";

test("real lock: every entry carries a 64-hex sha256", { skip: skipReal }, () => {
    assert.ok(realLock.size > 100);
    for (const [k, e] of realLock) assert.match(e.sha256 ?? "", /^[0-9a-f]{64}$/, k);
});

/** CoreFacts around the real lock, with the start-up set the sandbox loads. */
function realCore() {
    const preloaded = preloadedClosure(["micropip", "packaging", "numpy", "pandas"], realLock, canonicalName);
    return { tags: ENV.tags, markerEnv: ENV.env, python: ENV.python, lock: realLock, preloaded };
}

test("real lock: a lock package with non-preloaded dependencies gives an ok card of lock rows with the lock's digests", { skip: skipReal }, () => {
    const core = realCore();
    const pick = [...realLock].find(([k, e]) => !core.preloaded.has(k) && e.depends.some((d) => realLock.has(canonicalName(d)) && !core.preloaded.has(canonicalName(d))));
    assert.ok(pick, "no lock package with non-preloaded lock dependencies");
    const v = verdict({ name: pick[0] }, core, () => undefined);
    assert.equal(v.ok, true, JSON.stringify(v));
    const c = cardFromVerdict(v);
    assert.equal(c.ok, true, JSON.stringify(c));
    assert.ok(c.files.length >= 2);
    assert.equal(c.totalBytes, 0);
    for (const f of c.files) {
        assert.equal(f.source, "lock");
        assert.equal(f.size, null);
        assert.equal(f.sha256, realLock.get(canonicalName(f.name)).sha256);
    }
});

test("real lock: a name not in the lock gives a not-on-index refusal", { skip: skipReal }, () => {
    const c = cardFromVerdict(verdict({ name: "definitely-not-a-package-zzz" }, realCore(), () => undefined));
    assert.deepEqual(c, { ok: false, reason: "not-on-index", at: "definitely-not-a-package-zzz" });
});

// --- lockEntries ---

test("lockEntries: sha256 is kept only when it is 64 lowercase hex", () => {
    const m = lockEntries({ packages: {
        A_b: { version: "1", file_name: "a.whl", depends: [], sha256: H1 },
        c: { version: "1", file_name: "c.whl", depends: [], sha256: "XYZ" },
        d: { version: "1", file_name: "d.whl" },
    } }, canonicalName);
    assert.equal(m.get("a-b").sha256, H1);
    assert.equal("sha256" in m.get("c"), false);
    assert.equal(m.has("d"), false);
});

// --- preloadedClosure ---

const LOCK = new Map([
    ["a", { version: "1", file: "a", depends: ["b"] }],
    ["b", { version: "1", file: "b", depends: ["c", "typing-extensions"] }],
    ["c", { version: "1", file: "c", depends: ["a"] }],
    ["typing-extensions", { version: "1", file: "t", depends: [] }],
    ["unrelated", { version: "1", file: "u", depends: [] }],
]);

test("preloadedClosure: includes the start-up packages and their lock dependencies transitively", () => {
    assert.deepEqual([...preloadedClosure(["a"], LOCK, canonicalName)].sort(), ["a", "b", "c", "typing-extensions"]);
});

test("preloadedClosure: a dependency cycle terminates", () => {
    assert.equal(preloadedClosure(["a", "c"], LOCK, canonicalName).size, 4);
});

test("preloadedClosure: names are canonicalized", () => {
    const s = preloadedClosure(["Typing_Extensions", "A"], LOCK, canonicalName);
    assert.ok(s.has("typing-extensions") && s.has("a") && s.has("b"));
    assert.equal(s.has("Typing_Extensions"), false);
});

test("preloadedClosure: a package absent from the lock is kept with no dependencies", () => {
    assert.deepEqual([...preloadedClosure(["ghost"], LOCK, canonicalName)], ["ghost"]);
});

// --- shownText ---

test("shownText: plain ASCII is unchanged with no hidden list", () => {
    assert.deepEqual(shownText("Foo-bar_1.0"), { text: "Foo-bar_1.0", hidden: [] });
});

const HIDE = [0x0, 0x1b, 0x7f, 0x85, 0x61c, 0x200b, 0x200d, 0x200e, 0x202e, 0x2066, 0x2069, 0xfeff, 0xe0041];
const hex = (cp) => `\\u{${cp.toString(16).toUpperCase().padStart(4, "0")}}`;

for (const cp of HIDE) {
    test(`shownText: U+${cp.toString(16).toUpperCase().padStart(4, "0")} becomes one U+FFFD and one hidden entry`, () => {
        const r = shownText(`a${String.fromCodePoint(cp)}b`);
        assert.equal(r.text, "a�b");
        assert.deepEqual(r.hidden, [hex(cp)]);
    });
}

test("shownText: the astral tag character is listed as \\u{E0041}", () => {
    assert.deepEqual(shownText("\u{E0041}").hidden, ["\\u{E0041}"]);
});

test("shownText: a name mixing several hidden characters keeps the visible ones in place and lists in order", () => {
    const r = shownText("p‮y​t\u0000h\u{E0041}on");
    assert.equal(r.text, "p�y�t�h�on");
    assert.deepEqual(r.hidden, ["\\u{202E}", "\\u{200B}", "\\u{0000}", "\\u{E0041}"]);
});

// --- rowsFromAnswer: valid lists ---

test("rowsFromAnswer: a valid list gives fresh equal rows", () => {
    const input = [row(), row({ source: "lock", size: null, name: "n" })];
    const out = rowsFromAnswer(input);
    assert.deepEqual(out, input);
    assert.notEqual(out, input);
    out.forEach((r, i) => assert.notEqual(r, input[i]));
});

test("rowsFromAnswer: an empty list is a valid empty list", () => {
    assert.deepEqual(rowsFromAnswer([]), []);
});

test("rowsFromAnswer: a list of exactly VERDICT_BOUNDS.packages rows passes", () => {
    assert.equal(rowsFromAnswer(Array.from({ length: VERDICT_BOUNDS.packages }, () => row()))?.length, VERDICT_BOUNDS.packages);
});

test("rowsFromAnswer: the row key order of the input does not matter", () => {
    const r = row();
    const shuffled = { sha256: r.sha256, size: r.size, source: r.source, filename: r.filename, version: r.version, name: r.name };
    assert.deepEqual(rowsFromAnswer([shuffled]), [r]);
});

// --- rowsFromAnswer: refusals ---

class Row { constructor() { Object.assign(this, row()); } }
const nullProto = Object.assign(Object.create(null), row());
const sparse = [row(), row()]; delete sparse[0];
const holes = new Array(2); holes[1] = row();

const BAD_LISTS = [
    ["a non-array (object)", { 0: row(), length: 1 }],
    ["a non-array (null)", null],
    ["a non-array (string)", "rows"],
    ["an array longer than VERDICT_BOUNDS.packages", Array.from({ length: VERDICT_BOUNDS.packages + 1 }, () => row())],
    ["a sparse array (deleted element)", sparse],
    ["a sparse array (hole)", holes],
    ["a null row", [null]],
    ["an array row", [[]]],
    ["a class-instance row", [new Row()]],
    ["an Object.create(null) row", [nullProto]],
    ["a string row", ["row"]],
];
for (const [label, x] of BAD_LISTS) test(`rowsFromAnswer: ${label} gives undefined`, () => assert.equal(rowsFromAnswer(x), undefined));

for (const k of ["name", "version", "filename", "source", "size", "sha256"]) {
    test(`rowsFromAnswer: a row missing ${k} gives undefined`, () => {
        const r = row(); delete r[k];
        assert.equal(rowsFromAnswer([r]), undefined);
    });
}

test("rowsFromAnswer: a row with an extra field gives undefined", () => {
    assert.equal(rowsFromAnswer([row({ extra: 1 })]), undefined);
});

test("rowsFromAnswer: a row with a missing field replaced by an extra one of the same count gives undefined", () => {
    const r = row(); delete r.size; r.other = null;
    assert.equal(rowsFromAnswer([r]), undefined);
});

const WRONG_TYPE = { name: 5, version: 5, filename: 5, source: 5, size: "10", sha256: 5 };
for (const [k, bad] of Object.entries(WRONG_TYPE)) {
    test(`rowsFromAnswer: a ${k} of the wrong type gives undefined`, () => assert.equal(rowsFromAnswer([row({ [k]: bad })]), undefined));
}

test("rowsFromAnswer: a 63-char sha256 gives undefined", () => assert.equal(rowsFromAnswer([row({ sha256: "a".repeat(63) })]), undefined));
test("rowsFromAnswer: an uppercase sha256 gives undefined", () => assert.equal(rowsFromAnswer([row({ sha256: "A".repeat(64) })]), undefined));
test('rowsFromAnswer: source "cdn" gives undefined', () => assert.equal(rowsFromAnswer([row({ source: "cdn" })]), undefined));
for (const size of [-1, 1.5, "10", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined]) {
    test(`rowsFromAnswer: size ${String(size)} gives undefined`, () => assert.equal(rowsFromAnswer([row({ size })]), undefined));
}
test("rowsFromAnswer: size 0 and null pass", () => {
    assert.equal(rowsFromAnswer([row({ size: 0 }), row({ size: null })])?.length, 2);
});

test("rowsFromAnswer: a name of VERDICT_BOUNDS.name passes and one longer gives undefined", () => {
    assert.ok(rowsFromAnswer([row({ name: "n".repeat(VERDICT_BOUNDS.name) })]));
    assert.equal(rowsFromAnswer([row({ name: "n".repeat(VERDICT_BOUNDS.name + 1) })]), undefined);
});

test("rowsFromAnswer: a filename of VERDICT_BOUNDS.filename passes and one longer gives undefined", () => {
    assert.ok(rowsFromAnswer([row({ filename: "f".repeat(VERDICT_BOUNDS.filename) })]));
    assert.equal(rowsFromAnswer([row({ filename: "f".repeat(VERDICT_BOUNDS.filename + 1) })]), undefined);
});

test("rowsFromAnswer: a version of 128 characters passes and 129 gives undefined", () => {
    assert.ok(rowsFromAnswer([row({ version: "1".repeat(128) })]));
    assert.equal(rowsFromAnswer([row({ version: "1".repeat(129) })]), undefined);
});

// --- rowsFromAnswer: getters ---

test("rowsFromAnswer: a non-enumerable getter field gives undefined (Object.keys does not list it)", () => {
    const r = row(); delete r.name;
    Object.defineProperty(r, "name", { get: () => "idna" });
    assert.equal(rowsFromAnswer([r]), undefined);
});

test("rowsFromAnswer: an enumerable getter field PASSES, and the rebuilt row is a plain data copy", () => {
    let calls = 0;
    const r = row(); delete r.name;
    Object.defineProperty(r, "name", { get: () => (++calls, "idna"), enumerable: true });
    const out = rowsFromAnswer([r]);
    assert.ok(out);
    const d = Object.getOwnPropertyDescriptor(out[0], "name");
    assert.equal(d.value, "idna");
    assert.equal(d.get, undefined);
    assert.equal(Object.getPrototypeOf(out[0]), Object.prototype);
    const before = calls;
    out[0].name; out[0].name;
    assert.equal(calls, before, "reading the copy never calls the getter again");
});

test("rowsFromAnswer: a getter that changes its value between reads cannot make the copy differ from what was validated", () => {
    let n = 0;
    const r = row(); delete r.size;
    Object.defineProperty(r, "size", { get: () => (n++ === 0 ? 10 : -5), enumerable: true });
    const out = rowsFromAnswer([r]);
    assert.ok(out);
    assert.equal(out[0].size, 10);
    assert.equal(out[0].size, 10);
});

// --- sameRows ---

test("sameRows: equal lists are true, including two empty lists", () => {
    assert.equal(sameRows([row(), row({ name: "z" })], [row(), row({ name: "z" })]), true);
    assert.equal(sameRows([], []), true);
});

test("sameRows: a different order is false", () => {
    assert.equal(sameRows([row({ name: "a" }), row({ name: "b" })], [row({ name: "b" }), row({ name: "a" })]), false);
});

const CHANGED = { name: "other", version: "9", filename: "other.whl", source: "lock", size: 11, sha256: H1 };
for (const [k, v] of Object.entries(CHANGED)) {
    test(`sameRows: one changed ${k} is false`, () => assert.equal(sameRows([row()], [row({ [k]: v })]), false));
}

test("sameRows: a length difference is false in both directions", () => {
    assert.equal(sameRows([row()], [row(), row()]), false);
    assert.equal(sameRows([row(), row()], [row()]), false);
    assert.equal(sameRows([], [row()]), false);
});

test("sameRows: size null versus 0 is false", () => {
    assert.equal(sameRows([row({ size: null })], [row({ size: 0 })]), false);
    assert.equal(sameRows([row({ size: 0 })], [row({ size: null })]), false);
});

// --- approvalPayload: the rows at the sidebar's boundary ---

const { approvalPayload } = await import("../src/approval-key.ts");

test("approvalPayload: valid rows cross rebuilt; rows that do not check out cross as null, never dropped", () => {
    assert.deepEqual(approvalPayload({ hash: "h", seq: 1, decision: true, files: [row()] }).files, [row()]);
    for (const bad of ["all of them", [row({ extra: 1 })], [row({ sha256: "x" })], {}]) {
        const p = approvalPayload({ hash: "h", seq: 1, decision: true, files: bad });
        assert.ok("files" in p, "a malformed answer still says it carried rows");
        assert.equal(p.files, null);
    }
    assert.ok(!("files" in approvalPayload({ hash: "h", seq: 1, decision: true })), "no rows sent, none carried");
});

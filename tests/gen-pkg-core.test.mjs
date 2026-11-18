// gen-pkg-core.test.mjs — scripts/gen-pkg-core.mjs: the measured core tables become src/python/pkg-core.gen.ts, and an input that cannot be trusted throws instead of writing an empty table. Run: node --import tsx --test tests/gen-pkg-core.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { writePkgCore } = await import("../scripts/gen-pkg-core.mjs");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gen-pkg-core-"));
const fixture = (name, rows, extra = {}) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, JSON.stringify({ commit: "abc", extracted_at: "2026-01-01T00:00:00+00:00", source: { core: "c" }, rows, ...extra }));
    return p;
};
const row = (over = {}) => ({ attrs: { os: ["getcwd"], dead: null }, bad: { curses: "No module" }, machine: "wasm32", system: "Emscripten", version_info: [3, 14, 2], ...over });
const gen = (p) => { const out = path.join(dir, "out.gen.ts"); writePkgCore(p, out); return fs.readFileSync(out, "utf8"); };

// --- the real scan ---

test("the real core.json yields the four exports with non-empty tables", async () => {
    const m = await import("../src/python/pkg-core.gen.ts");
    assert.ok(m.PKG_CORE_MISSING.length > 0);
    assert.ok(Object.keys(m.PKG_CORE_ATTRS).length > 0);
    assert.ok(Object.values(m.PKG_CORE_ATTRS).every((v) => Array.isArray(v)));
    assert.equal(m.PKG_CORE_PLATFORM.system, "Emscripten");
    assert.equal(m.PKG_CORE_PLATFORM.version.length, 3);
    assert.ok(m.PKG_CORE_SOURCE.core && m.PKG_CORE_SOURCE.commit && m.PKG_CORE_SOURCE.extractedAt);
});

// --- a fixture ---

test("null attrs are dropped and the text names the four exports", () => {
    const t = gen(fixture("ok.json", [row()]));
    for (const n of ["PKG_CORE_MISSING", "PKG_CORE_ATTRS", "PKG_CORE_PLATFORM", "PKG_CORE_SOURCE"]) assert.match(t, new RegExp(`export const ${n}\\b`));
    assert.doesNotMatch(t, /"dead"/);
    assert.match(t, /^\/\/ pkg-core\.gen\.ts — /);
});

// --- inputs that must throw ---

test("a missing file throws, naming it", () => {
    assert.throws(() => gen(path.join(dir, "nope.json")), /nope\.json/);
});
test("unparsable JSON throws", () => {
    const p = path.join(dir, "bad.json"); fs.writeFileSync(p, "{");
    assert.throws(() => gen(p), /bad\.json/);
});
test("no rows throws", () => {
    assert.throws(() => gen(fixture("norows.json", [])), /rows\[0\]/);
});
test("empty bad throws", () => {
    assert.throws(() => gen(fixture("nobad.json", [row({ bad: {} })])), /bad/);
});
test("empty attrs throws", () => {
    assert.throws(() => gen(fixture("noattrs.json", [row({ attrs: {} })])), /attrs/);
});

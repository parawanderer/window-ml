// scripts/move-symbols.mjs — moving declarations between modules with the compiler doing the bookkeeping.
//
// Each test builds a tiny project in a temp directory and runs the real engine over it. The cases are the ways a
// hand-done move goes wrong in THIS repo: a test that loads the module with `await import()` and destructures it, a
// helper left behind and imported back (a cycle), comments reprinted or lost, a file header stolen by whatever was
// declared first, and state assigned across the new module boundary.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Project } from "../scripts/refactor/project.mjs";
import { moveSymbols } from "../scripts/refactor/move.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "move-symbols.mjs");

const TSCONFIG = JSON.stringify({
    compilerOptions: { target: "ES2022", module: "ES2022", moduleResolution: "bundler", strict: true, allowJs: true, checkJs: false, noEmit: true, allowImportingTsExtensions: true, isolatedModules: true, types: [] },
    include: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.mjs"],
});

/** A throwaway project. @param {Record<string, string>} files root-relative path → contents */
function fixture(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "move-symbols-test-"));
    fs.writeFileSync(path.join(root, "tsconfig.json"), TSCONFIG);
    for (const [rel, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), text);
    }
    return {
        root,
        /** Plan + apply in memory; returns the report and the resulting texts. @param {Parameters<typeof moveSymbols>[1]} req */
        move(req) {
            const project = new Project(root);
            const report = moveSymbols(project, req);
            return { report, project, text: (rel) => project.read(project.abs(rel)) };
        },
        cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    };
}

const kinds = (report) => report.blocks.map((b) => b.kind);

test("moves a function to a new file, keeps its JSDoc, and rewrites the importers", (t) => {
    const f = fixture({
        "src/a.ts": [
            "// Header of a.ts, which is about a.",
            "",
            'import { readFileSync } from "node:fs";   // why fs',
            "",
            "/** Loads and tags a file. */",
            "export function load(p: string): string {",
            '    return readFileSync(p, "utf8");   // spaced trailing comment',
            "}",
            "",
            "export function other(): string {",
            '    return load("q");',
            "}",
            "",
        ].join("\n"),
        "src/b.ts": 'import { load, other } from "./a";   // b uses both\nconsole.log(load("f"), other());\n',
        "node.d.ts": 'declare module "node:fs" { export function readFileSync(p: string, e: string): string; }\n',
    });
    t.after(f.cleanup);
    const { report, text } = f.move({ from: "src/a.ts", symbols: ["load"], to: "src/loader.ts" });
    assert.deepStrictEqual(report.blocks, []);
    assert.ok(report.newFile);
    assert.ok(report.verbatim, "the moved code reads back byte-identical");

    const loader = text("src/loader.ts");
    assert.match(loader, /\/\*\* Loads and tags a file\. \*\/\nexport function load/, "the JSDoc stays attached");
    assert.match(loader, /readFileSync\(p, "utf8"\);   \/\/ spaced trailing comment/, "the refactor's reprint is undone");
    assert.doesNotMatch(loader, /Header of a\.ts/, "the source's file header does not follow its first import");
    assert.match(loader, /^import \{ readFileSync \} from "node:fs";/m);

    const a = text("src/a.ts");
    assert.match(a, /^\/\/ Header of a\.ts/, "the header stays where it was");
    assert.match(a, /import \{ load \} from "\.\/loader";/, "the source imports what it still uses");
    assert.doesNotMatch(a, /readFileSync/, "and drops the import only the moved code used");
    assert.ok(a.endsWith("}\n") && !a.endsWith("\n\n"), "one trailing newline, as before");

    const b = text("src/b.ts");
    assert.match(b, /import \{ other \} from "\.\/a";/);
    assert.match(b, /import \{ load \} from "\.\/loader";/);
});

test("pulls along a helper only the moved code uses, and leaves a shared one", (t) => {
    const f = fixture({
        "src/a.ts": [
            "const PREFIX = \"x:\";",
            "function onlyLoad(s: string) { return s.trim(); }",
            "export function load(s: string) { return PREFIX + onlyLoad(s); }",
            "export function other() { return PREFIX + load(\"\"); }",
            "",
        ].join("\n"),
    });
    t.after(f.cleanup);
    const { report } = f.move({ from: "src/a.ts", symbols: ["load"], to: "src/loader.ts" });
    assert.deepStrictEqual(report.pulled.map((p) => p.name), ["onlyLoad"]);
    assert.deepStrictEqual(report.staying.map((s) => s.name), ["PREFIX"]);
    assert.deepStrictEqual(kinds(report), ["cycle"], "PREFIX stays and a.ts imports load back: a cycle");
    assert.deepStrictEqual(report.cycles[0], ["src/loader.ts", "src/a.ts", "src/loader.ts"]);
});

test("--no-pull leaves an exclusive helper behind, which is then a cycle", (t) => {
    const f = fixture({ "src/a.ts": "function helper() { return 1; }\nexport function load() { return helper(); }\nexport const x = load();\n" });
    t.after(f.cleanup);
    const { report } = f.move({ from: "src/a.ts", symbols: ["load"], to: "src/loader.ts", pull: false });
    assert.deepStrictEqual(report.pulled, []);
    assert.deepStrictEqual(report.staying.map((s) => s.name), ["helper"]);
    assert.deepStrictEqual(kinds(report), ["cycle"]);
});

test("a dependency used only as a TYPE is not a cycle", (t) => {
    const f = fixture({
        "src/a.ts": "export interface Shape { n: number }\nexport function make(): Shape { return { n: 1 }; }\nexport const s: Shape = make();\n",
    });
    t.after(f.cleanup);
    const { report, text } = f.move({ from: "src/a.ts", symbols: ["make"], to: "src/make.ts" });
    assert.deepStrictEqual(report.blocks, []);
    assert.deepStrictEqual(report.staying.map((s) => [s.name, s.value]), [["Shape", false]]);
    assert.match(text("src/make.ts"), /import .*Shape.* from "\.\/a";/);
});

test("a class used only in type positions does not make a runtime edge", (t) => {
    const f = fixture({
        "src/a.ts": "export class Store { n = 1; }\nexport function size(s: Store): number { return s.n; }\nexport const store = new Store();\nexport const n = size(store);\n",
    });
    t.after(f.cleanup);
    const { report } = f.move({ from: "src/a.ts", symbols: ["size"], to: "src/size.ts" });
    assert.deepStrictEqual(kinds(report), [], "size.ts imports Store only as a type, so a.ts → size.ts is the only runtime edge");
});

test("rewrites every dynamic-import shape the tests use, and splits a partial destructuring", (t) => {
    const f = fixture({
        "src/a.ts": "export function load() { return 1; }\nexport function other() { return 2; }\n",
        "tests/decl.test.mjs": 'const { load, other } = await import("../src/a.ts");\nconsole.log(load, other);\n',
        "tests/all.test.mjs": 'const { load: l } = await import("../src/a.ts").catch(() => null);\nconsole.log(l);\n',
        "tests/member.test.mjs": 'const n = (await import("../src/a.ts")).load();\nconsole.log(n);\n',
        "tests/ns.test.mjs": 'const M = await import("../src/a.ts");\nM.load();\n',
        "tests/assign.test.mjs": 'let load, other;\nasync function before() {\n    ({ load, other } = await import("../src/a.ts"));   // in a hook\n}\nconsole.log(before, load, other);\n',
        "tests/untouched.test.mjs": 'const { other } = await import("../src/a.ts");\nconsole.log(other);\n',
    });
    t.after(f.cleanup);
    const { report, text } = f.move({ from: "src/a.ts", symbols: ["load"], to: "src/load.ts" });
    assert.deepStrictEqual(report.blocks, []);
    assert.strictEqual(text("tests/decl.test.mjs"),
        'const { other } = await import("../src/a.ts");\nconst { load } = await import("../src/load.ts");\nconsole.log(load, other);\n');
    assert.match(text("tests/all.test.mjs"), /import\("\.\.\/src\/load\.ts"\)\.catch/, "a .catch(() => null) import is retargeted, not left to skip itself");
    assert.match(text("tests/member.test.mjs"), /\(await import\("\.\.\/src\/load\.ts"\)\)\.load\(\)/);
    assert.match(text("tests/ns.test.mjs"), /const M = await import\("\.\.\/src\/load\.ts"\);/);
    assert.match(text("tests/assign.test.mjs"),
        /\(\{ other \} = await import\("\.\.\/src\/a\.ts"\)\);   \/\/ in a hook\n    \(\{ load \} = await import\("\.\.\/src\/load\.ts"\)\);/);
    assert.strictEqual(text("tests/untouched.test.mjs"), 'const { other } = await import("../src/a.ts");\nconsole.log(other);\n');
});

test("re-exports of the moved names follow them, split or whole, named or star", (t) => {
    const f = fixture({
        "src/a.ts": "export function load() { return 1; }\nexport function other() { return 2; }\nexport type Kind = 'a';\n",
        "src/split.ts": 'export { load, other } from "./a";   // both\n',
        "src/whole.ts": 'export { load as loadIt } from "./a";\n',
        "src/star.ts": 'export * from "./a";\n',
        "src/types.ts": 'export type { Kind } from "./a";\n',
        "src/use.ts": 'import { load, other } from "./split";\nimport { loadIt } from "./whole";\nimport { load as l2 } from "./star";\nimport type { Kind } from "./types";\nconst k: Kind = "a";\nconsole.log(load(), other(), loadIt(), l2(), k);\n',
    });
    t.after(f.cleanup);
    const { report, text } = f.move({ from: "src/a.ts", symbols: ["load", "Kind"], to: "src/util/load.ts" });
    assert.deepStrictEqual(report.blocks, [], "no new diagnostics, so every consumer still resolves");
    assert.strictEqual(text("src/split.ts"), 'export { other } from "./a";   // both\nexport { load } from "./util/load";\n');
    assert.strictEqual(text("src/whole.ts"), 'export { load as loadIt } from "./util/load";\n');
    assert.strictEqual(text("src/star.ts"), 'export * from "./a";\nexport * from "./util/load";\n');
    assert.strictEqual(text("src/types.ts"), 'export type { Kind } from "./util/load";\n');
});

test("a move into another directory recomputes relative specifiers everywhere", (t) => {
    const f = fixture({
        "src/sidebar/a.ts": 'import { dep } from "../dep";\nexport function load() { return dep; }\nexport function other() { return 2; }\n',
        "src/dep.ts": "export const dep = 1;\n",
        "tests/t.test.mjs": 'const { load, other } = await import("../src/sidebar/a.ts");\nconsole.log(load, other);\n',
    });
    t.after(f.cleanup);
    const { report, text } = f.move({ from: "src/sidebar/a.ts", symbols: ["load"], to: "src/util/load.ts" });
    assert.deepStrictEqual(report.blocks, []);
    assert.match(text("src/util/load.ts"), /^import \{ dep \} from "\.\.\/dep";/);
    assert.match(text("tests/t.test.mjs"), /const \{ load \} = await import\("\.\.\/src\/util\/load\.ts"\);/);
});

test("a namespace import that reads moved AND staying members is flagged, not guessed", (t) => {
    const f = fixture({
        "src/a.ts": "export function load() { return 1; }\nexport function other() { return 2; }\n",
        "tests/ns.test.mjs": 'const M = await import("../src/a.ts");\nM.load(); M.other();\n',
    });
    t.after(f.cleanup);
    const { report } = f.move({ from: "src/a.ts", symbols: ["load"], to: "src/load.ts" });
    assert.deepStrictEqual(kinds(report), ["dynamic-import"]);
    assert.match(report.blocks[0].message, /tests\/ns\.test\.mjs:1/);
});

test("a destructured require is retargeted without leaving `const { } = require(…)` behind", (t) => {
    const f = fixture({
        "src/a.ts": "export function load() { return 1; }\nexport function other() { return 2; }\n",
        "tests/c.test.js": 'const { load } = require("../src/a.ts");\nconsole.log(load);\n',
    });
    t.after(f.cleanup);
    const { report, text } = f.move({ from: "src/a.ts", symbols: ["load"], to: "src/load.ts" });
    assert.deepStrictEqual(report.blocks, []);
    assert.strictEqual(text("tests/c.test.js"), 'const { load } = require("../src/load.ts");\nconsole.log(load);\n');
});

test("state assigned across the new module boundary is refused", (t) => {
    const f = fixture({
        "src/a.ts": "export let counter = 0;\nexport function bump() { counter++; }\n",
        "src/b.ts": "export let mode = 'a';\nexport function setMode() { mode = 'b'; }\nexport const read = () => mode;\n",
    });
    t.after(f.cleanup);
    const moved = f.move({ from: "src/a.ts", symbols: ["counter"], to: "src/counter.ts" }).report;
    assert.deepStrictEqual(kinds(moved), ["mutable"], "counter would be imported by a.ts, which assigns it");
    const assigns = f.move({ from: "src/b.ts", symbols: ["setMode"], to: "src/set-mode.ts" }).report;
    assert.deepStrictEqual(kinds(assigns), ["mutable"], "setMode assigns mode, which stays behind");
    const together = f.move({ from: "src/a.ts", symbols: ["counter", "bump"], to: "src/counter.ts" }).report;
    assert.deepStrictEqual(kinds(together), [], "moving the state with its only writer is fine");
});

test("names that are not movable top-level declarations are refused with a reason", (t) => {
    const f = fixture({
        "src/a.ts": 'import { x } from "./x";\nexport const p = 1, q = 2;\nexport default function d() { return x; }\n',
        "src/x.ts": "export const x = 1;\n",
    });
    t.after(f.cleanup);
    const { report } = f.move({ from: "src/a.ts", symbols: ["x", "nope", "p", "d"], to: "src/b.ts" });
    const messages = report.blocks.map((b) => b.message).join("\n");
    assert.ok(report.blocks.every((b) => b.kind === "input"));
    assert.match(messages, /`x` is imported by a\.ts from \.\/x/);
    assert.match(messages, /`nope` is not a top-level declaration/);
    assert.match(messages, /name `q` too/);
    assert.match(messages, /`d` is a default export/);
});

test("overloads and merged declarations move together", (t) => {
    const f = fixture({
        "src/a.ts": [
            "export function fmt(n: number): string;",
            "export function fmt(s: string): string;",
            "export function fmt(v: unknown): string { return String(v); }",
            "export const used = fmt(1);",
            "",
        ].join("\n"),
    });
    t.after(f.cleanup);
    const { report, text } = f.move({ from: "src/a.ts", symbols: ["fmt"], to: "src/fmt.ts" });
    assert.deepStrictEqual(report.blocks, []);
    assert.strictEqual((text("src/fmt.ts").match(/export function fmt/g) ?? []).length, 3);
    assert.doesNotMatch(text("src/a.ts"), /function fmt/);
});

test("a local that shadows a top-level name is not a dependency on it", (t) => {
    const f = fixture({
        "src/a.ts": [
            "const helper = () => 0;",
            "const obj = { helper: () => 1 };",
            "export function load() { const helper = () => 2; return helper() + obj.helper(); }",
            "export const x = helper();",
            "",
        ].join("\n"),
    });
    t.after(f.cleanup);
    const { report } = f.move({ from: "src/a.ts", symbols: ["load"], to: "src/load.ts" });
    assert.deepStrictEqual(report.staying.map((s) => s.name), [], "obj is pulled (only load uses it); the shadowed helper is not a dependency");
    assert.deepStrictEqual(report.pulled.map((s) => s.name), ["obj"]);
});

test("moving into an EXISTING file appends verbatim and refuses a name it already binds", (t) => {
    const f = fixture({
        "src/a.ts": "export function load() { return 1; }   // one\nexport function clash() { return 2; }\n",
        "src/b.ts": "// b's header\n\nexport function keep() { return 0; }\nexport function clash() { return 3; }\n",
        "src/use.ts": 'import { load } from "./a";\nimport { keep } from "./b";\nconsole.log(load(), keep());\n',
    });
    t.after(f.cleanup);
    const ok = f.move({ from: "src/a.ts", symbols: ["load"], to: "src/b.ts" });
    assert.deepStrictEqual(ok.report.blocks, []);
    assert.ok(ok.report.verbatim);
    assert.match(ok.text("src/b.ts"), /^\/\/ b's header\n\nexport function keep\(\) \{ return 0; \}\nexport function clash\(\) \{ return 3; \}\n\nexport function load\(\) \{ return 1; \}   \/\/ one\n$/);
    assert.match(ok.text("src/use.ts"), /^import \{ (keep, load|load, keep) \} from "\.\/b";\nconsole/, "one import from b, not two");

    const clash = f.move({ from: "src/a.ts", symbols: ["clash"], to: "src/b.ts" });
    assert.deepStrictEqual(kinds(clash.report), ["conflict"]);
});

test("a file named as a string by a script blocks; a build entry is only reported", (t) => {
    const f = fixture({
        "src/a.ts": "export function load() { return 1; }\nexport const x = 2;\n",
        "scripts/gen.mjs": 'import { readFileSync } from "node:fs";\nimport { join } from "node:path";\nexport const src = readFileSync(join("src", "a.ts"), "utf8");\n',
        "build.mjs": 'const ENTRIES = {\n    a: "src/a.ts",\n};\nexport { ENTRIES };\n',
        "docs/notes.md": "`load` lives in `a.ts`.\n",
    });
    t.after(f.cleanup);
    const { report } = f.move({ from: "src/a.ts", symbols: ["load"], to: "src/load.ts" });
    assert.deepStrictEqual(kinds(report), ["text-ref"]);
    assert.match(report.blocks[0].message, /scripts\/gen\.mjs:3/);
    assert.deepStrictEqual(report.textRefs.map((r) => [r.file, r.kind]).sort(), [["build.mjs", "entry"], ["docs/notes.md", "doc"], ["scripts/gen.mjs", "code"]]);
});

test("reports what a bundle gains when moved code lands in a file with heavier imports", (t) => {
    const f = fixture({
        "src/entry.ts": 'import { load } from "./a";\nconsole.log(load());\n',
        "src/a.ts": "export function load() { return 1; }\n",
        "src/other.ts": 'import { heavy } from "./heavy";\nexport const o = heavy;\n',
        "src/heavy.ts": "export const heavy = 1;\n",
        "build.mjs": 'const ENTRIES = {\n    entry: "src/entry.ts",\n};\n',
    });
    t.after(f.cleanup);
    const { report } = f.move({ from: "src/a.ts", symbols: ["load"], to: "src/other.ts" });
    assert.deepStrictEqual(kinds(report), []);
    assert.deepStrictEqual(report.bundles, [{ entry: "entry", gains: ["src/other.ts", "src/heavy.ts"] }]);
});

test("notes a moved initializer that runs code at load", (t) => {
    const f = fixture({
        "src/a.ts": "export const cache = new Map();\nexport const started = Date.now();\nexport const use = () => [cache, started];\n",
    });
    t.after(f.cleanup);
    const { report } = f.move({ from: "src/a.ts", symbols: ["cache", "started"], to: "src/state.ts" });
    assert.strictEqual(report.notes.length, 1);
    assert.match(report.notes[0], /`started` runs code when the module loads/);
});

test("CLI: a blocked move writes nothing and exits 1; a clean one writes and exits 0", (t) => {
    const f = fixture({
        "src/a.ts": "const PREFIX = 'x';\nexport function load() { return PREFIX; }\nexport const other = PREFIX + load();\n",
    });
    t.after(f.cleanup);
    const run = (...args) => spawnSync(process.execPath, [CLI, "--root", f.root, "--no-typecheck", ...args], { encoding: "utf8" });
    const blocked = run("--from", "src/a.ts", "--symbols", "load", "--to", "src/load.ts");
    assert.strictEqual(blocked.status, 1, blocked.stdout + blocked.stderr);
    assert.match(blocked.stdout, /BLOCKED\s+\[cycle\]/);
    assert.ok(!fs.existsSync(path.join(f.root, "src/load.ts")));

    const dry = run("--from", "src/a.ts", "--symbols", "load,PREFIX", "--to", "src/load.ts", "--dry-run", "--diff");
    assert.strictEqual(dry.status, 0, dry.stdout + dry.stderr);
    assert.match(dry.stdout, /\+\+\+ b\/src\/load\.ts/);
    assert.ok(!fs.existsSync(path.join(f.root, "src/load.ts")));

    const done = run("--from", "src/a.ts", "--symbols", "load,PREFIX", "--to", "src/load.ts");
    assert.strictEqual(done.status, 0, done.stdout + done.stderr);
    assert.match(fs.readFileSync(path.join(f.root, "src/load.ts"), "utf8"), /export function load\(\) \{ return PREFIX; \}/);

    const usage = run("--from", "src/a.ts");
    assert.strictEqual(usage.status, 2);
});

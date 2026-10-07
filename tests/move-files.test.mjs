// scripts/move-files.mjs — moving whole files into a folder, with every path that names them rewritten.
//
// The planner is pure over a file list and a reader, so each test hands it an in-memory tree. The cases are the
// path forms this repo actually uses: an extensionless import inside src/, a `.ts` import from a test, an inline
// `import("./x").T` type query, a root-relative entry point in build.mjs, a moved file's own imports, and a doc.
import { test } from "node:test";
import assert from "node:assert";
import { planMove, dangling, parseArgs } from "../scripts/move-files.mjs";

/** Plan a move over an in-memory tree. @param {Record<string, string>} tree @param {Record<string, string>} moves */
function plan(tree, moves) {
    return planMove({ files: Object.keys(tree), read: (rel) => tree[rel], moves: new Map(Object.entries(moves)) });
}

// --- importers: every way a path names a moved file ---

test("an extensionless import, a .ts import from a test and an inline type query all follow the file", () => {
    const p = plan({
        "src/background.ts": `import { a } from "./sw-llm";\nlet x: import("./sw-llm").T;\n`,
        "tests/llm.test.mjs": `const { a } = await import("../src/sw-llm.ts");\n`,
        "src/sw-llm.ts": `export const a = 1; export type T = 1;\n`,
    }, { "src/sw-llm.ts": "src/sw/sw-llm.ts" });
    assert.strictEqual(p.rewritten.get("src/background.ts"), `import { a } from "./sw/sw-llm";\nlet x: import("./sw/sw-llm").T;\n`);
    assert.strictEqual(p.rewritten.get("tests/llm.test.mjs"), `const { a } = await import("../src/sw/sw-llm.ts");\n`);
});

test("a root-relative path (build.mjs's entry points) is rewritten exactly, and only when it names a moved file", () => {
    const p = plan({
        "build.mjs": `const e = { worker: "src/python-worker.ts", popup: "src/popup.ts" };\n`,
        "src/python-worker.ts": "", "src/popup.ts": "",
    }, { "src/python-worker.ts": "src/python/python-worker.ts" });
    assert.strictEqual(p.rewritten.get("build.mjs"), `const e = { worker: "src/python/python-worker.ts", popup: "src/popup.ts" };\n`);
});

test("a file that names nothing moved is left alone", () => {
    const p = plan({ "src/a.ts": `import "./b";\n`, "src/b.ts": "", "src/c.ts": "" }, { "src/c.ts": "src/x/c.ts" });
    assert.ok(!p.rewritten.has("src/a.ts"));
});

// --- the moved files themselves ---

test("a moved file's own imports are rewritten for its new directory, including one to a file moving with it", () => {
    const p = plan({
        "src/sw-a.ts": `import { b } from "./sw-b";\nimport { d } from "./dom";\nimport type { C } from "./contract";\n`,
        "src/sw-b.ts": "", "src/dom.ts": "", "src/contract.ts": "",
    }, { "src/sw-a.ts": "src/sw/sw-a.ts", "src/sw-b.ts": "src/sw/sw-b.ts" });
    assert.strictEqual(p.rewritten.get("src/sw/sw-a.ts"), `import { b } from "./sw-b";\nimport { d } from "../dom";\nimport type { C } from "../contract";\n`);
});

test("a moved file with no paths in it is still carried, under its new path", () => {
    const p = plan({ "src/sw-a.ts": "export const a = 1;\n" }, { "src/sw-a.ts": "src/sw/sw-a.ts" });
    assert.strictEqual(p.rewritten.get("src/sw/sw-a.ts"), "export const a = 1;\n");
});

// --- docs and the paths it can only report ---

test("a doc's exact old path is rewritten; a bare name, which stays true, is not", () => {
    const p = plan({
        "docs/dev/x.md": "The index lives in `src/sw-sessions.ts`; `sw-sessions.ts` serves the port.\n",
        "src/sw-sessions.ts": "",
    }, { "src/sw-sessions.ts": "src/sw/sw-sessions.ts" });
    assert.strictEqual(p.rewritten.get("docs/dev/x.md"), "The index lives in `src/sw/sw-sessions.ts`; `sw-sessions.ts` serves the port.\n");
});

test("a path assembled from pieces is REPORTED once per line, never rewritten", () => {
    const p = plan({
        "tests/t.test.mjs": `for (const f of ["sw-a.ts", "sw-b.ts"]) read(join(ROOT, "src", f));\n`,
        "src/sw-a.ts": "", "src/sw-b.ts": "",
    }, { "src/sw-a.ts": "src/sw/sw-a.ts", "src/sw-b.ts": "src/sw/sw-b.ts" });
    assert.deepStrictEqual(p.reports.map((r) => [r.file, r.line, r.kind]), [["tests/t.test.mjs", 1, "pieces"]]);
    assert.ok(!p.rewritten.has("tests/t.test.mjs"));
});

// --- the dangling check, which is what blocks a bad move ---

test("dangling() names a relative specifier that resolves to nothing, and accepts every suffix bundler resolution does", () => {
    const files = new Set(["src/a.ts", "src/b.tsx", "src/c/index.ts"]);
    const text = { "src/a.ts": `import "./b"; import "./c"; import "./gone"; import "./b.tsx";\n` };
    assert.deepStrictEqual(dangling(files, (r) => text[r] ?? ""), ["src/a.ts: ./gone"]);
});

test("after a planned move, nothing that resolved before dangles", () => {
    const tree = {
        "src/background.ts": `import "./sw-a";\n`,
        "src/sw-a.ts": `import "./dom";\n`, "src/dom.ts": "",
    };
    const p = plan(tree, { "src/sw-a.ts": "src/sw/sw-a.ts" });
    const read = (r) => p.rewritten.get(r) ?? tree[r] ?? null;
    assert.deepStrictEqual(dangling(p.after, read), []);
});

// --- arguments ---

test("parseArgs takes a destination and the files, and refuses neither", () => {
    assert.deepStrictEqual(parseArgs(["--to", "src/sw", "src/sw-a.ts", "src/sw-b.ts", "--dry-run"]).files, ["src/sw-a.ts", "src/sw-b.ts"]);
    assert.throws(() => parseArgs(["src/sw-a.ts"]), /--to/);
    assert.throws(() => parseArgs(["--to", "x", "--bogus"]), /unknown/);
});

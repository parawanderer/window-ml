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
        "src/background.ts": `import { a } from "./zz-llm";\nlet x: import("./zz-llm").T;\n`,
        "tests/llm.test.mjs": `const { a } = await import("../src/zz-llm.ts");\n`,
        "src/zz-llm.ts": `export const a = 1; export type T = 1;\n`,
    }, { "src/zz-llm.ts": "src/zz/zz-llm.ts" });
    assert.strictEqual(p.rewritten.get("src/background.ts"), `import { a } from "./zz/zz-llm";\nlet x: import("./zz/zz-llm").T;\n`);
    assert.strictEqual(p.rewritten.get("tests/llm.test.mjs"), `const { a } = await import("../src/zz/zz-llm.ts");\n`);
});

test("a root-relative path (build.mjs's entry points) is rewritten exactly, and only when it names a moved file", () => {
    const p = plan({
        "build.mjs": `const e = { worker: "src/zz-worker.ts", popup: "src/popup.ts" };\n`,
        "src/zz-worker.ts": "", "src/popup.ts": "",
    }, { "src/zz-worker.ts": "src/zz/zz-worker.ts" });
    assert.strictEqual(p.rewritten.get("build.mjs"), `const e = { worker: "src/zz/zz-worker.ts", popup: "src/popup.ts" };\n`);
});

test("a file that names nothing moved is left alone", () => {
    const p = plan({ "src/a.ts": `import "./b";\n`, "src/b.ts": "", "src/c.ts": "" }, { "src/c.ts": "src/x/c.ts" });
    assert.ok(!p.rewritten.has("src/a.ts"));
});

// --- the moved files themselves ---

test("a moved file's own imports are rewritten for its new directory, including one to a file moving with it", () => {
    const p = plan({
        "src/zz-a.ts": `import { b } from "./zz-b";\nimport { d } from "./dom";\nimport type { C } from "./contract";\n`,
        "src/zz-b.ts": "", "src/dom.ts": "", "src/contract.ts": "",
    }, { "src/zz-a.ts": "src/zz/zz-a.ts", "src/zz-b.ts": "src/zz/zz-b.ts" });
    assert.strictEqual(p.rewritten.get("src/zz/zz-a.ts"), `import { b } from "./zz-b";\nimport { d } from "../dom";\nimport type { C } from "../contract";\n`);
});

test("a moved file with no paths in it is still carried, under its new path", () => {
    const p = plan({ "src/zz-a.ts": "export const a = 1;\n" }, { "src/zz-a.ts": "src/zz/zz-a.ts" });
    assert.strictEqual(p.rewritten.get("src/zz/zz-a.ts"), "export const a = 1;\n");
});

test("a path to a generated, untracked file (`extra`) still follows the move, and the generated file is never rewritten", () => {
    const tree = { "src/zz-a.ts": `import { B } from "./zz-info.gen";\n` };
    const p = planMove({ files: Object.keys(tree), extra: ["src/zz-info.gen.ts"], read: (r) => tree[r], moves: new Map([["src/zz-a.ts", "src/zz/zz-a.ts"]]) });
    assert.strictEqual(p.rewritten.get("src/zz/zz-a.ts"), `import { B } from "../zz-info.gen";\n`);
    assert.ok(!p.rewritten.has("src/zz-info.gen.ts"));
});

// --- docs and the paths it can only report ---

test("a doc's exact old path is rewritten; a bare name, which stays true, is not", () => {
    const p = plan({
        "docs/dev/x.md": "The index lives in `src/zz-sessions.ts`; `zz-sessions.ts` serves the port.\n",
        "src/zz-sessions.ts": "",
    }, { "src/zz-sessions.ts": "src/zz/zz-sessions.ts" });
    assert.strictEqual(p.rewritten.get("docs/dev/x.md"), "The index lives in `src/zz/zz-sessions.ts`; `zz-sessions.ts` serves the port.\n");
});

test("a doc's relative Markdown link follows a moved file and keeps its anchor; inside a code fence only an exact path follows", () => {
    const p = plan({
        "docs/spec/X.md": "See [the worker](../../src/zz-llm.ts#L10) and [api](../API.md).\n```\n[not a link](../../src/zz-llm)\nnode src/zz-llm.ts\n```\n",
        "docs/API.md": "", "src/zz-llm.ts": "",
    }, { "src/zz-llm.ts": "src/zz/zz-llm.ts" });
    assert.strictEqual(p.rewritten.get("docs/spec/X.md"),
        "See [the worker](../../src/zz/zz-llm.ts#L10) and [api](../API.md).\n```\n[not a link](../../src/zz-llm)\nnode src/zz/zz-llm.ts\n```\n");
});

test("a doc that itself moves has every relative link rebased for its new directory", () => {
    const p = plan({
        "docs/X.md": "[api](API.md) and [src](../src/zz-a.ts) and [web](https://example.com).\n",
        "docs/API.md": "", "src/zz-a.ts": "",
    }, { "docs/X.md": "docs/zz/X.md" });
    assert.strictEqual(p.rewritten.get("docs/zz/X.md"), "[api](../API.md) and [src](../../src/zz-a.ts) and [web](https://example.com).\n");
});

test("a path assembled from pieces is REPORTED once per line, never rewritten", () => {
    const p = plan({
        "tests/t.test.mjs": `for (const f of ["zz-a.ts", "zz-b.ts"]) read(join(ROOT, "src", f));\n`,
        "src/zz-a.ts": "", "src/zz-b.ts": "",
    }, { "src/zz-a.ts": "src/zz/zz-a.ts", "src/zz-b.ts": "src/zz/zz-b.ts" });
    assert.deepStrictEqual(p.reports.map((r) => [r.file, r.line, r.kind]), [["tests/t.test.mjs", 1, "pieces"]]);
    assert.ok(!p.rewritten.has("tests/t.test.mjs"));
});

test("a rewritten ROOT-relative string is listed as `rooted`, since it may be data that only looks like a path", () => {
    const p = plan({
        "tests/kinds.test.mjs": `assert.equal(pathKind("src/zz-llm.ts"), "code");\n`,
        "src/zz-llm.ts": "",
    }, { "src/zz-llm.ts": "src/zz/zz-llm.ts" });
    assert.deepStrictEqual(p.reports.map((r) => [r.file, r.line, r.kind, r.text]), [["tests/kinds.test.mjs", 1, "rooted", "src/zz-llm.ts"]]);
});

// --- the dangling check, which is what blocks a bad move ---

test("dangling() names a relative specifier that resolves to nothing, and accepts every suffix bundler resolution does", () => {
    const files = new Set(["src/a.ts", "src/b.tsx", "src/c/index.ts"]);
    const text = { "src/a.ts": `import "./b"; import "./c"; import "./gone"; import "./b.tsx";\n` };
    assert.deepStrictEqual(dangling(files, (r) => text[r] ?? ""), ["src/a.ts: ./gone"]);
});

test("after a planned move, nothing that resolved before dangles", () => {
    const tree = {
        "src/background.ts": `import "./zz-a";\n`,
        "src/zz-a.ts": `import "./dom";\n`, "src/dom.ts": "",
    };
    const p = plan(tree, { "src/zz-a.ts": "src/zz/zz-a.ts" });
    const read = (r) => p.rewritten.get(r) ?? tree[r] ?? null;
    assert.deepStrictEqual(dangling(p.after, read), []);
});

// --- arguments ---

test("parseArgs takes a destination and the files, and refuses neither", () => {
    assert.deepStrictEqual(parseArgs(["--to", "src/sw", "src/zz-a.ts", "src/zz-b.ts", "--dry-run"]).files, ["src/zz-a.ts", "src/zz-b.ts"]);
    assert.throws(() => parseArgs(["src/zz-a.ts"]), /--to/);
    assert.throws(() => parseArgs(["--to", "x", "--bogus"]), /unknown/);
});

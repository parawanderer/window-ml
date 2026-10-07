// scripts/check-doc-links.mjs — every file a Markdown doc points at exists.
//
// The parts are pure (a doc's text plus an `exists` predicate in, broken references out), so each test hands them an
// in-memory tree. The cases are the ones the repo's docs actually contain: relative links, links in code that are
// examples rather than links, backticked paths, `mobile/` docs whose `src/` is their own, and line-anchored paths.
import { test } from "node:test";
import assert from "node:assert";
import { brokenIn, linkTargets, codePaths, prose } from "../scripts/check-doc-links.mjs";

const tree = (...files) => {
    const set = new Set(files);
    for (const f of files) for (let d = f.split("/").slice(0, -1).join("/"); d; d = d.split("/").slice(0, -1).join("/")) set.add(d);
    return (rel) => set.has(rel);
};

// --- links: what counts as one ---

test("a link's target is read relative to nothing yet: web, mail and same-page anchors are not files, an anchor is dropped", () => {
    assert.deepStrictEqual(linkTargets("[a](../src/x.ts#L3) [b](https://x.dev) [c](mailto:a@b) [d](#top)"), ["../src/x.ts"]);
});

test("a link inside inline code is an example, not a link", () => {
    assert.deepStrictEqual(linkTargets("Use real syntax (`[label](url)`), not the inverted form."), []);
});

test("fenced code is blanked, so a call like `runners[call.name](call.arguments)` is never read as a link", () => {
    const lines = prose("before\n```js\nconst r = await runners[call.name](call.arguments);\n```\nafter");
    assert.deepStrictEqual(lines, ["before", "", "", "", "after"]);
});

// --- links: resolved against the doc ---

test("a relative link resolves against the doc's own directory; a broken one is reported with its line", () => {
    const exists = tree("src/background.ts", "docs/spec/A.md");
    const text = "ok [bg](../../src/background.ts)\nbroken [bg](../../background.ts)\n";
    assert.deepStrictEqual(brokenIn("docs/spec/A.md", text, exists), [{ line: 2, kind: "link", target: "../../background.ts" }]);
});

test("a link to a directory, or rooted at `/`, resolves too; one that climbs out of the repo is broken", () => {
    const exists = tree("docs/dev/x.md", "src/a.ts");
    assert.deepStrictEqual(brokenIn("docs/A.md", "[d](dev/) [r](/src/a.ts) [out](../../etc/passwd)", exists),
        [{ line: 1, kind: "link", target: "../../etc/passwd" }]);
});

// --- backticked paths ---

test("a backticked repo path is checked from the root; a bare name, a glob or a placeholder is not a path", () => {
    assert.deepStrictEqual(codePaths("`src/a.ts` `a.ts` `src/sw-*.ts` `src/<name>.ts` `docs/dev/x.md:12` `npm test`"), ["src/a.ts", "docs/dev/x.md"]);
});

test("a dead backticked path is reported as a path, not a link", () => {
    assert.deepStrictEqual(brokenIn("docs/A.md", "see `tests/python.test.js`\n", tree("tests/python.test.mjs")),
        [{ line: 1, kind: "path", target: "tests/python.test.js" }]);
});

test("a doc under mobile/ names its own `src/`, so its paths resolve from mobile/ as well as the root", () => {
    assert.deepStrictEqual(brokenIn("mobile/AGENTS.md", "`src/theme.ts` and `src/ui-kit.tsx`", tree("mobile/src/theme.ts", "src/ui-kit.tsx")), []);
});

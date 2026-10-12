// check-memory.test.mjs — the memory-index check: where it looks, and which broken shapes it reports.

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkMemory, frontmatter, memoryDir, touchesMemory, INDEX_LINES } from "../scripts/check-memory.mjs";

const memo = (name, topics, extra = "") =>
    `---\nname: ${name}\ndescription: about ${name}\nmetadata:\n${topics === null ? "" : `  topics: ${topics}\n`}  type: project\n---\n\nbody${extra}\n`;
const hub = name => `---\nname: topic-${name}\ndescription: HUB for ${name}\nmetadata:\n  type: reference\n---\n`;

/** A folder in the right shape: two hubs, both linked, each with a memory. */
const good = () => new Map([
    ["MEMORY.md", "- [a](topic-a.md) — a\n- [b](topic-b.md) — b\n- [read me](one.md) — first\n"],
    ["topic-a.md", hub("a")],
    ["topic-b.md", hub("b")],
    ["one.md", memo("one", "a")],
    ["two.md", memo("two", "a, b")],
]);

// --- where the memory folder is ---

test("the folder is the checkout path with every non-alphanumeric as a dash, under the config dir", () => {
    assert.equal(memoryDir("/Users/sb/git/window-ml", {}, "/Users/sb"), "/Users/sb/.claude/projects/-Users-sb-git-window-ml/memory");
    assert.equal(memoryDir("/x/a.b_c", { CLAUDE_CONFIG_DIR: "/cfg" }, "/h"), "/cfg/projects/-x-a-b-c/memory");
    assert.equal(memoryDir("/x", { WML_MEMORY_DIR: "/m" }, "/h"), "/m");
});

// --- when the hook speaks ---

test("the hook runs for a write into the memory folder or a shell command naming it, and for nothing else", () => {
    const dir = "/h/.claude/projects/-x/memory";
    assert.equal(touchesMemory({ tool_input: { file_path: `${dir}/one.md` } }, dir), true);
    assert.equal(touchesMemory({ tool_input: { file_path: "/x/src/a.ts" } }, dir), false);
    assert.equal(touchesMemory({ tool_input: { file_path: `${dir}-other/one.md` } }, dir), false, "a sibling folder");
    assert.equal(touchesMemory({ tool_input: { command: `sed -i '' s/a/b/ ${dir}/one.md` } }, dir), true);
    assert.equal(touchesMemory({ tool_input: { command: "cd ~/.claude/projects/-x/memory && awk ..." } }, dir), true, "through ~");
    assert.equal(touchesMemory({ tool_input: { command: "npm test" } }, dir), false);
    assert.equal(touchesMemory({}, dir), false);
});

// --- reading frontmatter ---

test("frontmatter reads name, description and the comma-separated topics under metadata", () => {
    assert.deepEqual(frontmatter(memo("one", "a, b")), { name: "one", description: "about one", hasMetadata: true, topics: ["a", "b"] });
    assert.equal(frontmatter("no frontmatter"), null);
    assert.equal(frontmatter(memo("one", null)).topics, undefined);
});

// --- what passes ---

test("a folder in the hierarchical shape has no errors and no warnings", () => {
    assert.deepEqual(checkMemory(good()), { errors: [], warnings: [] });
});

// --- what it reports ---

test("a memory with no topics is an error naming the file", () => {
    const files = good();
    files.set("three.md", memo("three", null));
    assert.match(checkMemory(files).errors.join("\n"), /three\.md: no `  topics:`/);
});

test("a topic with no hub is an error, a hub with no memories a warning", () => {
    const files = good();
    files.set("two.md", memo("two", "a, nope"));
    const { errors, warnings } = checkMemory(files);
    assert.match(errors.join("\n"), /topic "nope" has no hub/);
    assert.match(warnings.join("\n"), /topic-b\.md has no memories/);
});

test("a hub missing from MEMORY.md and a MEMORY.md link to nothing are both errors", () => {
    const files = good();
    files.set("MEMORY.md", "- [a](topic-a.md)\n- [gone](gone.md)\n");
    const errors = checkMemory(files).errors.join("\n");
    assert.match(errors, /topic-b\.md is not linked from MEMORY\.md/);
    assert.match(errors, /links gone\.md, which does not exist/);
});

test("MEMORY.md past the harness's cut-off is an error; at the limit it is not", () => {
    const files = good();
    const base = files.get("MEMORY.md").split("\n");
    files.set("MEMORY.md", [...base, ...Array(INDEX_LINES - base.length).fill("x")].join("\n"));
    assert.deepEqual(checkMemory(files).errors, []);
    files.set("MEMORY.md", files.get("MEMORY.md") + "\none more");
    assert.match(checkMemory(files).errors.join("\n"), /cuts it off at 200/);
});

test("no frontmatter, no description, and a missing MEMORY.md are errors; a name that differs is a warning", () => {
    const files = good();
    files.set("raw.md", "just text");
    files.set("nodesc.md", "---\nname: nodesc\nmetadata:\n  topics: a\n---\n");
    files.set("renamed.md", memo("other-name", "a"));
    const { errors, warnings } = checkMemory(files);
    assert.match(errors.join("\n"), /raw\.md: no frontmatter/);
    assert.match(errors.join("\n"), /nodesc\.md: no description/);
    assert.match(warnings.join("\n"), /renamed\.md: name "other-name"/);
    assert.match(checkMemory(new Map()).errors[0], /MEMORY\.md is missing/);
});

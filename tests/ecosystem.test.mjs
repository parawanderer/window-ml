// ecosystem.test.mjs — the pure half of `scripts/ecosystem.mjs`: how a Claude trailer, a renamed numstat path, a test
// case and a `git blame --porcelain` group are read.

import { test } from "node:test";
import assert from "node:assert/strict";

const { claudeTrailer, agentPostModel, normaliseModel, attributeModel, squashPr, FOOTER_NOT_READ, resolveRenamed, countTests, churnFrom, blameOwners } = await import("../scripts/ecosystem.mjs");

// --- authorship ---

test("a Claude trailer names its model in either capitalisation, and a human co-author or none is null", () => {
    assert.equal(claudeTrailer("fix: x\n\nbody\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"), "Claude Opus 5.5");
    assert.equal(claudeTrailer("fix: x\n\nCo-authored-by: Claude Opus 5 (1M context) <noreply@anthropic.com>\n"), "Claude Opus 5 (1M context)");
    assert.equal(claudeTrailer("fix: x\n\nCo-authored-by: Someone Else <a@b.c>"), null);
    assert.equal(claudeTrailer("fix: mentions co-authored-by: claude in prose, not as a trailer"), null);
    assert.equal(claudeTrailer(""), null);
});

// --- model attribution ---

test("a trailer naming a model wins over the footer; a bare Claude Code trailer takes the footer's model or is unknown", () => {
    assert.equal(attributeModel("Claude Opus 5.5", "deepseek-flash"), "Claude Opus 5.5");
    assert.equal(attributeModel("Claude Fable 5.1", null), "Claude Fable 5.1");
    assert.equal(attributeModel("Claude Code", "mimo-v2.6-pro"), "mimo-v2.6-pro");
    assert.equal(attributeModel("Claude Code", "deepseek.deepseek-flash"), "deepseek-flash");
    assert.equal(attributeModel("Claude Code", null), "unknown");
    assert.equal(attributeModel("Claude Code", undefined), FOOTER_NOT_READ);
    assert.equal(attributeModel(null, "deepseek-flash"), null);
});

test("model ids lose a router prefix and a vendor path only, and are otherwise kept as written", () => {
    assert.equal(normaliseModel("deepseek.deepseek-flash"), "deepseek-flash");
    assert.equal(normaliseModel("deepseek-flash"), "deepseek-flash");
    assert.equal(normaliseModel("openrouter.xiaomi/mimo-v2.6-pro"), "mimo-v2.6-pro");
    assert.equal(normaliseModel("mimo-v2.6-pro"), "mimo-v2.6-pro");
    assert.equal(normaliseModel("moonshot.kimi-k3.1-pro"), "kimi-k3.1-pro");
    assert.equal(normaliseModel("openrouter.moonshotai/kimi-k3.1-pro"), "kimi-k3.1-pro");
    assert.equal(normaliseModel("gpt-6-luna"), "gpt-6-luna");
    assert.equal(normaliseModel("claude-opus-5-5"), "claude-opus-5-5");
});

test("the agent-post footer's model and a squash subject's PR number are read, and their absence is null", () => {
    const body = "Body.\n\n> *Drafted by X*\n<!-- agent-post: harness=codex work=w session=abc model=gpt-6-luna -->\n";
    assert.equal(agentPostModel(body), "gpt-6-luna");
    assert.equal(agentPostModel("<!-- agent-post: harness=h work=w session=s model=deepseek.deepseek-flash-->"), "deepseek.deepseek-flash");
    assert.equal(agentPostModel("no footer, model=gpt-6-luna in prose"), null);
    assert.equal(agentPostModel(null), null);
    assert.equal(squashPr("fix(security): the gates judge a URL (#1568)"), 1568);
    assert.equal(squashPr("docs: mentions (#12) mid-subject only"), null);
});

// --- numstat ---

test("a rename in numstat resolves to its new path, braced or whole", () => {
    assert.equal(resolveRenamed("src/{a => sw}/sw-llm.ts"), "src/sw/sw-llm.ts");
    assert.equal(resolveRenamed("src/{ => sw}/sw-llm.ts"), "src/sw/sw-llm.ts");
    assert.equal(resolveRenamed("old.ts => src/new.ts"), "src/new.ts");
    assert.equal(resolveRenamed("src/plain.ts"), "src/plain.ts");
});

test("churn counts written files only, split by whether the commit is agent-written", () => {
    const c = churnFrom([
        { agent: true, files: [{ path: "src/a.ts", added: 10, deleted: 2 }, { path: "package-lock.json", added: 999, deleted: 0 }, { path: "docs/x.md", added: 50, deleted: 0 }, { path: "tests/a.test.mjs", added: 5, deleted: 1 }] },
        { agent: false, files: [{ path: "src/b.ts", added: 3, deleted: 3 }, { path: "src/proto/x.gen.ts", added: 700, deleted: 0 }] },
    ]);
    assert.deepEqual(c, { agent: { added: 15, deleted: 3 }, other: { added: 3, deleted: 3 } });
});

// --- tests and blame ---

test("test cases are counted per language, and modifiers count but a method named test does not", () => {
    assert.equal(countTests("tests/a.test.mjs", 'test("a", () => {});\n  it.skip("b", () => {});\ntest.only("c", f);\nfoo.test("no")\n'), 3);
    assert.equal(countTests("crates/x/src/lib.rs", "#[test]\nfn a() {}\n#[tokio::test]\nasync fn b() {}\n"), 2);
    assert.equal(countTests("x_test.go", "func TestA(t *testing.T) {}\nfunc helper() {}\n"), 1);
    assert.equal(countTests("tests/test_a.py", "def test_a():\n    pass\nasync def test_b():\n    pass\ndef helper(): pass\n"), 2);
});

test("blame porcelain gives each commit the lines it owns, ignoring content lines that look like headers", () => {
    const sha = (c) => c.repeat(40);
    const out = [`${sha("a")} 1 1 2`, "author X", "\tline one", `${sha("a")} 2 2`, "\tline two", `${sha("b")} 1 3 1`, "author Y", `\t${sha("c")} 9 9 fake`].join("\n");
    assert.deepEqual([...blameOwners(out)], [[sha("a"), 2], [sha("b"), 1]]);
});

// The per-run docs-dedup memory that tool-exec.ts owns: it's keyed off the run's `byName` map (so it
// survives toolContext being rebuilt per background-delegated call) and reset by executeTool once the model
// breaks the docs streak (past a 1-step leniency). Pure enough to unit-test with stub tools.
import { test } from "node:test";
import assert from "node:assert";
import { toolContext, executeTool } from "../tool-exec.ts";

const permissive = { type: "object", properties: {} };
const stubTool = (name) => ({ name, description: "", parameters: permissive, run: () => "ok" });

test("toolContext hands back a fresh docs memory and keeps it stable per byName (WeakMap)", () => {
    const byName = { exec: stubTool("exec") };
    const a = toolContext(byName);
    assert.ok(a.docsMemory, "ctx should carry a docsMemory");
    assert.equal(a.docsMemory.shown.size, 0);
    assert.equal(a.docsMemory.sinceDocs, 0);
    // Same byName (the background path rebuilds ctx every call) → SAME memory object.
    assert.strictEqual(toolContext(byName).docsMemory, a.docsMemory, "memory must persist across toolContext calls");
    // A different run's toolset → a different memory.
    assert.notStrictEqual(toolContext({ exec: stubTool("exec") }).docsMemory, a.docsMemory);
});

test("a non-docs tool tolerates ONE intervening call, then purges the shown set on the second", async () => {
    const byName = { exec: stubTool("exec"), agent_api_docs: stubTool("agent_api_docs") };
    const ctx = toolContext(byName);
    ctx.docsMemory.shown.add("type:FetchResult");

    await executeTool(byName.exec, {}, ctx);
    assert.equal(ctx.docsMemory.sinceDocs, 1, "first non-docs call counts");
    assert.ok(ctx.docsMemory.shown.has("type:FetchResult"), "one detour is within leniency — memory kept");

    await executeTool(byName.exec, {}, ctx);
    assert.equal(ctx.docsMemory.sinceDocs, 2);
    assert.equal(ctx.docsMemory.shown.size, 0, "a second non-docs call means the model moved on — purge");
});

test("running agent_api_docs itself does NOT count as a streak-break", async () => {
    const byName = { agent_api_docs: stubTool("agent_api_docs") };
    const ctx = toolContext(byName);
    ctx.docsMemory.shown.add("type:FetchResult");
    ctx.docsMemory.sinceDocs = 5;   // pretend the model had wandered

    await executeTool(byName.agent_api_docs, {}, ctx);
    // executeTool must not touch the counter or clear for the docs tool (the tool's own run resets sinceDocs).
    assert.equal(ctx.docsMemory.sinceDocs, 5, "the docs tool must not increment its own streak counter");
    assert.ok(ctx.docsMemory.shown.has("type:FetchResult"), "the docs tool must not purge the shown set");
});

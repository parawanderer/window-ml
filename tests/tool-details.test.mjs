// tool-details.test.mjs — short tool descriptions in the schema, their mechanics served by agent_api_docs.

import { test } from "node:test";
import assert from "node:assert/strict";

// --- a pointer with the docs tool, the details inline without it ---

test("a split tool points into agent_api_docs when the run has it, and carries its details inline when it does not", async () => {
    const { withToolDetails, TOOL_DETAILS } = await import("../src/tools/tool-details.ts");
    const exec = { name: "exec", description: "short" }, other = { name: "click", description: "c" };
    const withDocs = withToolDetails([exec, other, { name: "agent_api_docs", description: "d" }]);
    assert.equal(withDocs[0].description, 'short Details: `agent_api_docs({ tool: "exec" })`.');
    assert.equal(withDocs[1], other, "a tool with no details is the same object");
    assert.equal(exec.description, "short", "the shared definition is never mutated");
    const without = withToolDetails([exec, other]);
    assert.equal(without[0].description, `short\n\n${TOOL_DETAILS.exec}`, "no docs tool: nothing is lost");
});

test("agent_api_docs({ tool }) serves a tool's details only for a tool the run has, and names the ones it can", async () => {
    const { toolDetailsSection, TOOL_DETAILS } = await import("../src/tools/tool-details.ts");
    const has = (n) => n === "exec" || n === "fetch_url";
    assert.equal(toolDetailsSection("fetch_url", has), `## Tool reference: \`fetch_url\`\n\n${TOOL_DETAILS.fetch_url}`);
    assert.match(toolDetailsSection("fetch_url", (n) => n === "exec"), /^No tool reference for `fetch_url`\. These tools have one: `exec`\.$/);
    assert.equal(toolDetailsSection("click", () => false), "No tool reference for `click`.");
});

// --- the short forms ---

test("the short forms are what the split saves: each well under its full description, with no run of two spaces", async () => {
    const { EXEC_SHORT, FETCH_SHORT, FETCH_RENDERED_SHORT, TOOL_DETAILS } = await import("../src/tools/tool-details.ts");
    const exec = EXEC_SHORT(500, 8000);
    assert.ok(exec.length < 1500 && FETCH_SHORT.length < 1500 && FETCH_RENDERED_SHORT.length < 200, `${exec.length} ${FETCH_SHORT.length}`);
    for (const text of [exec, FETCH_SHORT, FETCH_RENDERED_SHORT, ...Object.values(TOOL_DETAILS)]) assert.doesNotMatch(text, / {2}/);
});

test("'don't change my page' means fetch, in the short form and the details; navigate says it replaces the page", async () => {
    const { FETCH_SHORT, TOOL_DETAILS } = await import("../src/tools/tool-details.ts");
    assert.match(FETCH_SHORT, /always when the user asks you not to change their page/);
    assert.match(TOOL_DETAILS.fetch_url, /asks you not to change their page or what they are looking at, never navigate: fetch/);
    const src = (await import("node:fs")).readFileSync(new URL("../src/ml/ml-tool-factories.ts", import.meta.url), "utf8");
    assert.match(src, /Navigating REPLACES the page the user is looking at; to only read a URL, use `fetch_url`\./);
});

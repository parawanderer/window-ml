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

// --- the second round of cuts: locate's option texts (docs/spec/PROMPT_BUDGET.md) ---

test("locate keeps a trigger for every option, its full text is served as details, and nothing pads", async () => {
    const { LOCATE, TOOL_DETAILS } = await import("../src/tools/tool-details.ts");
    const full = TOOL_DETAILS.locate;
    for (const k of Object.keys(LOCATE.params)) assert.ok(LOCATE.params[k].length > 0, k);
    assert.match(full, /`strategy`: .*grid narrows to a cell/, "the strategies' mechanics are served");
    const short = LOCATE.description.length + Object.values(LOCATE.params).join("").length;
    assert.ok(short < full.length * 0.5, `${short} vs ${full.length}`);
    for (const t of [LOCATE.description, ...Object.values(LOCATE.params)]) assert.doesNotMatch(t, / {2}/);
});

test("python_exec keeps a trigger for each of tables/cast, its full texts are served as details, and nothing pads", async () => {
    // Round 3 (PROMPT_BUDGET.md): the cut shipped once #650 and the derived-name fix removed what it had cost glm-4.7-flash.
    const { PYTHON, PYTHON_FULL, TOOL_DETAILS } = await import("../src/tools/tool-details.ts");
    for (const k of ["tables", "cast"]) {
        assert.ok(PYTHON[k].length > 0 && PYTHON[k].length < PYTHON_FULL[k].length, k);
        assert.ok(TOOL_DETAILS.python_exec.includes(PYTHON_FULL[k]), `${k}'s full text is served`);
        assert.doesNotMatch(PYTHON[k], / {2}/, k);
    }
    assert.match(PYTHON.tables, /Python variable name/, "the key rule a model needs before it can look anything up");
    const short = Object.values(PYTHON).join("").length, full = Object.values(PYTHON_FULL).join("").length;
    assert.ok(short < full * 0.5, `${short} vs ${full}`);
});

test("a private rendered fetch with Incognito off leads with the retry that works", async () => {
    const src = (await import("node:fs")).readFileSync(new URL("../src/sw/sw-fetch.ts", import.meta.url), "utf8");
    assert.match(src, /which is off\. Retry with credentials:true to render in the user's own session instead/);
});

// --- propose_policy's details: each claim holds in the realm a proposal is checked in ---

test("propose_policy's details say what the realm does: the regex it names is refused, the forms it warns of over-match", async () => {
    const { TOOL_DETAILS } = await import("../src/tools/tool-details.ts");
    const { evalPolicy } = await import("../src/readonly-exec.ts");
    const { fetchFacts } = await import("../src/sw/sw-policies.ts");
    const { riskyRegex } = await import("../src/readonly-exec/limits.ts");
    const d = TOOL_DETAILS.propose_policy;
    const allows = (src, url) => evalPolicy(src, fetchFacts(url, {}), "allow").decision === "allow";
    // "refused as one that could backtrack, even where it would not": the example is refused, and each repetition opens
    // with a `-` its body cannot match, so it does not backtrack.
    assert.match(d, /`\(-\[a-z\]\+\)\*`/);
    assert.ok(riskyRegex("^[a-z]+(-[a-z]+)*$"));
    assert.ok(evalPolicy("(c) => /^[a-z]+(-[a-z]+)*$/.test(c.host)", fetchFacts("https://a.example/", {})).broken);
    // "the dot included (without it, evilexample.org matches)"; "ending in `/` (without it, /docs-evil matches)".
    assert.match(d, /evilexample\.org/);
    const site = '(c) => c.host === "example.org" || c.host.endsWith(".example.org")';
    assert.ok(allows(site, "https://example.org/") && allows(site, "https://docs.example.org/"), "the site and its subdomains");
    assert.ok(!allows(site, "https://evilexample.org/"));
    assert.ok(allows('(c) => c.host.endsWith("example.org")', "https://evilexample.org/"));
    assert.ok(allows('(c) => c.url.startsWith("https://example.org/docs")', "https://example.org/docs-evil/x"));
    assert.ok(!allows('(c) => c.url.startsWith("https://example.org/docs/")', "https://example.org/docs-evil/x"));
    // The examples name none of the interviews' needs, whose answers they would hand the model being measured.
    const { FETCH_NEEDS } = await import("./e2e/panel/policy-proposals.score.ts");
    for (const n of FETCH_NEEDS) for (const v of n.vectors.filter((x) => x.holds)) assert.ok(!d.includes(new URL(v.facts.url).host), `${n.id}: ${v.facts.url}`);
    // "one without `^` matches inside other URLs".
    assert.ok(allows('(c) => /docs\\.example\\.org/.test(c.url)', "https://evil.example/?u=docs.example.org"));
    // "a field `c` does not have, `==`, or a result that is not a boolean makes it broken".
    for (const src of ["(c) => c.hots === \"a\"", "(c) => c.host == \"a\"", "(c) => c.host.length"]) assert.ok(evalPolicy(src, fetchFacts("https://a/", {})).broken, src);
});

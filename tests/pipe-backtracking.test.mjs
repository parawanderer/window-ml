// pipe-backtracking.test.mjs — a pipe pattern that can backtrack without end is refused at the one place a pipe compiles one.

// V8 has no match timeout, so `grep -E '(a+)+$'` over a capture holding a long run of `a`s blocks the thread it runs
// on, the service worker's included, and a loop in a Python cell can now ask for it over the wire. `text-pipe.ts`
// `compilePattern` applies `riskyRegex` for every caller; these tests hold it on each path a pipe reaches it by: the
// pipe itself, the model's `dereference` tool, a read-only survey's `ml.dereference` in the worker, and the `ml` wire.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runPipe } from "../src/pointers/text-pipe.ts";
import { wireRun, wireCall } from "./ml-wire-harness.mjs";

const { runAgentLoop } = await import("../src/agent/agent-loop.ts");

const T = { timeout: 30000 };
// Long enough that an unguarded `(a+)+$` match runs for minutes: a refusal is the only way these tests finish.
const EVIL = "a".repeat(30) + "!";
const RISKY = ["grep -E '(a+)+$'", "grep '(\\w+\\s?)*$'", "sed 's/(a|a)+$/x/'"];

// --- the one compile point ---

test("a backtracking pattern is refused before it compiles, in grep and in sed, with no limits passed", () => {
    assert.equal(runPipe(`${EVIL}\nb`, "grep -E 'a+!'"), EVIL, "positive control: a single quantifier runs");
    for (const p of RISKY) assert.throws(() => runPipe(EVIL, p), /refused .*can take hours to match/, p);
});

test("a caller's own onPattern refusal of the same pattern wins, so the dialect's Denied outcome is unchanged", () => {
    class Denied extends Error {}
    const limits = { onPattern: (src) => { if (/\(a\+\)\+/.test(src)) throw new Denied("the caller's"); } };
    assert.throws(() => runPipe(EVIL, "grep -E '(a+)+$'", limits), (e) => e instanceof Denied);
});

test("an invalid pattern still says it is invalid, not risky", () => {
    assert.throws(() => runPipe("x", "grep '('"), /invalid regex/);
});

// --- the model's dereference tool ---

test("the model's dereference tool answers a backtracking pipe with the refusal, and the run goes on", T, async () => {
    const TOOLS = ["exec", "dereference"].map((name) => ({ name, description: "", parameters: { type: "object", properties: {} } }));
    const turns = [
        { content: "", tool_calls: [{ id: "c1", name: "exec", arguments: { js: "x", token: true } }] },
        { content: "", tool_calls: [{ id: "c2", name: "dereference", arguments: { token: "@tool:exec", pipe: "grep -E '(a+)+$'" } }] },
        { content: "", tool_calls: [{ id: "c3", name: "dereference", arguments: { token: "@tool:exec", pipe: "grep -c a" } }] },
    ];
    const results = [];
    let i = 0;
    await runAgentLoop("t", { tools: TOOLS, maxSteps: () => 8, toolTokens: true, runHash: "abcdef" }, {
        callModel: async () => turns[i++] || { content: "done", tool_calls: [] },
        runTool: async () => ({ result: EVIL }),
        autoApprove: () => null,
        buildMessages: (task) => [{ role: "user", content: task }],
        pushAssistant: (m, msg) => m.push({ role: "assistant", ...msg }),
        pushToolResult: (m, c, result) => { results.push({ name: c.name, result }); m.push({ role: "tool", content: result }); },
    });
    const derefs = results.filter((r) => r.name === "dereference").map((r) => r.result);
    assert.match(derefs[0], /refused .*can take hours to match/);
    assert.match(derefs[1], /\b1\b/, "positive control: the next read runs");
});

// --- a read-only survey's ml.dereference in the worker ---

test("a survey's ml.dereference with a backtracking pipe, evaluated in the worker, does not run the pattern", T, async () => {
    const { toolResults } = await wireRun(async () => {}, {
        url: "https://data.example/evil.txt", body: EVIL,
        calls: [
            { name: "fetch_url", args: { url: "https://data.example/evil.txt" } },
            { name: "exec", args: { js: `await ml.dereference("fetch_url", { pipe: "grep -E '(a+)+$'" })` } },
            { name: "exec", args: { js: `(await ml.dereference("fetch_url", { pipe: "grep -c a" })).trim()` } },
        ],
    });
    assert.match(toolResults[1] ?? "", /refused|can take hours/, `the survey's answer: ${toolResults[1]}`);
    assert.match(toolResults[2] ?? "", /\b\d+\b/, "positive control: a plain pipe in the same run answers a count");
});

// --- the ml wire ---

test("a wire dereference with a backtracking pipe is refused, and a plain one answers", T, async () => {
    const got = {};
    await wireRun(async (wire, bg) => {
        got.risky = await wireCall(bg, wire, "dereference", ["fetch_url", { pipe: "grep -E '(a+)+$'" }]);
        got.plain = await wireCall(bg, wire, "dereference", ["fetch_url", { pipe: "grep -c a" }]);
    }, { url: "https://data.example/evil.txt", body: EVIL });
    assert.equal(got.risky.error?.code, "Failed");
    assert.match(got.risky.error.message, /refused .*can take hours to match/);
    assert.match(got.plain.value?.text ?? "", /^\d+\s*$/, "positive control: a plain pipe answers a count");
});

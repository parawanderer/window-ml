// The pure @tool token parser/resolver (answer-tokens.ts) — the grammar gate + hallucination handling every
// surface relies on. Rendering is tested at the surfaces; this locks down what IS and ISN'T a token.
import { test } from "node:test";
import assert from "node:assert";
import { splitAnswer, hasTokens, resolveTokenStep } from "../answer-tokens.ts";
import { toolToken } from "../util.ts";

test("splitAnswer: a token link splits into prose + token + prose; default slot is out; embed vs link", () => {
    // LINK form `[…]` → embed:false (renders as a clickable jump).
    const segs = splitAnswer("The count is [9](@tool:e7ed9f:out) total.");
    assert.equal(segs.length, 3);
    assert.deepEqual(segs[0], { kind: "prose", text: "The count is " });
    assert.deepEqual(segs[1], { kind: "token", embed: false, label: "9", id: "e7ed9f", slot: "out" });
    assert.deepEqual(segs[2], { kind: "prose", text: " total." });

    // IMAGE form `![…]` → embed:true (expands the output in place).
    assert.deepEqual(splitAnswer("![9](@tool:e7ed9f:out)")[0], { kind: "token", embed: true, label: "9", id: "e7ed9f", slot: "out" });
    // bare @tool:id defaults to :out
    assert.deepEqual(splitAnswer("[x](@tool:abc123)")[0], { kind: "token", embed: false, label: "x", id: "abc123", slot: "out" });
    // :in and a piped format
    assert.deepEqual(splitAnswer("![c](@tool:abc123:in)")[0], { kind: "token", embed: true, label: "c", id: "abc123", slot: "in" });
    assert.deepEqual(splitAnswer("![e](@tool:abc123:out | latex)")[0], { kind: "token", embed: true, label: "e", id: "abc123", slot: "out", fmt: "latex" });
});

test("splitAnswer: an answer with no tokens is a single prose segment (verbatim)", () => {
    const md = "Just a plain answer with **bold** and a [real link](https://x.test).";
    assert.deepEqual(splitAnswer(md), [{ kind: "prose", text: md }]);
});

test("GRAMMAR GATE: malformed / non-token links stay prose (never specially handled)", () => {
    for (const md of [
        "[x](@tool:nothex)",              // id isn't 6-hex
        "[x](@tool:abc12)",               // too short
        "[x](@tool:abc1234)",             // too long
        "[x](@tool:)",                    // no id
        "[x](@tool:abc123:sideways)",     // bad slot → the :slot just isn't captured, but 'sideways' breaks the URL match
        "see @tool:abc123 inline",        // not a markdown link at all
        "[x](https://tool.example/abc)",  // ordinary link
    ]) {
        const segs = splitAnswer(md);
        assert.ok(segs.every(s => s.kind === "prose"), `should stay prose: ${md}`);
        assert.equal(segs.map(s => s.text).join(""), md, `prose preserved verbatim: ${md}`);
    }
});

test("hasTokens: true only when a real token is present", () => {
    assert.equal(hasTokens("[9](@tool:e7ed9f:out)"), true);
    assert.equal(hasTokens("no tokens here [x](@tool:nothex)"), false);
    assert.equal(hasTokens("plain text"), false);
});

test("TOOL-NAME ALIAS: a non-hex `@tool:<name>` is a token ONLY when isAlias confirms that tool ran", () => {
    // Models routinely write `@tool:python_exec` (the tool NAME) instead of the hidden hex id — accommodate it,
    // but ONLY when that tool actually ran this run; otherwise it's ordinary markdown (the grammar gate holds).
    // No predicate → stays prose (default strict behaviour, unchanged).
    assert.ok(splitAnswer("![r](@tool:python_exec:out)").every(s => s.kind === "prose"), "no predicate → prose");
    // A predicate that knows python_exec ran → it becomes a real token (embed + slot preserved).
    assert.deepEqual(
        splitAnswer("![r](@tool:python_exec:out)", (n) => n === "python_exec")[0],
        { kind: "token", embed: true, label: "r", id: "python_exec", slot: "out" });
    // A predicate that DOESN'T know the tool → still prose (a hallucinated tool name isn't promoted).
    assert.ok(splitAnswer("![r](@tool:python_exec:out)", (n) => n === "exec").every(s => s.kind === "prose"));
    // hasTokens follows the same gate.
    assert.equal(hasTokens("![r](@tool:python_exec:out)"), false);
    assert.equal(hasTokens("![r](@tool:python_exec:out)", (n) => n === "python_exec"), true);
});

test("resolveTokenStep: a tool-name alias resolves to the LAST tokened step of that tool", () => {
    const steps = [
        { seq: 1, tool: "python_exec", token: "aaaaaa" },
        { seq: 2, tool: "exec", token: "bbbbbb" },
        { seq: 3, tool: "python_exec", token: "cccccc" },   // the LAST python_exec that has a token
        { seq: 4, tool: "python_exec" },                     // ran but no token minted → never a target
    ];
    assert.equal(resolveTokenStep("python_exec", steps).seq, 3, "alias → last python_exec WITH a token");
    assert.equal(resolveTokenStep("exec", steps).token, "bbbbbb", "alias → the exec step");
    assert.equal(resolveTokenStep("look", steps), null, "a tool that never ran → null (no promotion)");
    assert.equal(resolveTokenStep("aaaaaa", steps).seq, 1, "an EXACT hex id still resolves precisely (wins over alias)");
});

test("resolveTokenStep: matches by the token the loop MINTED onto the step; null for a hallucinated one", () => {
    // The loop stores the exact minted id on the step; resolution is a direct equality match, NOT a re-derivation.
    const idFor2 = toolToken("abcd1234", 2);
    const steps = [{ seq: 1, tool: "exec" }, { seq: 2, tool: "look", token: idFor2 }, { seq: 3, tool: "findByText" }];
    assert.strictEqual(resolveTokenStep(idFor2, steps), steps[1], "resolves to the step whose stored token matches");
    assert.equal(resolveTokenStep("zzzzzz", steps), null, "a hallucinated id resolves to nothing");
    // a step with NO minted token (thought, un-tokened tool call) is never a target, even if its seq would derive it
    assert.equal(resolveTokenStep(toolToken("abcd1234", 1), steps), null, "an un-tokened step can't be cited");
    assert.equal(resolveTokenStep(idFor2, [{ tool: "x" }]), null, "no tokens at all → null");
});

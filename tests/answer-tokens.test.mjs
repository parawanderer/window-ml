// The pure @tool token parser/resolver (answer-tokens.ts) — the grammar gate + hallucination handling every
// surface relies on. Rendering is tested at the surfaces; this locks down what IS and ISN'T a token.
import { test } from "node:test";
import assert from "node:assert";
import { splitAnswer, hasTokens, resolveTokenStep, tokenIdsIn } from "../src/answer-tokens.ts";
import { toolToken } from "../src/util.ts";
import { markdown } from "../src/sidebar/format.ts";

test("splitAnswer: a token link splits into prose + token + prose; default slot is out; embed vs link", () => {
    // LINK form `[…]` → embed:false (renders as a clickable jump).
    const segs = splitAnswer("The count is [9](@tool:e7ed9fa:out) total.");
    assert.equal(segs.length, 3);
    assert.deepEqual(segs[0], { kind: "prose", text: "The count is " });
    assert.deepEqual(segs[1], { kind: "token", embed: false, label: "9", id: "e7ed9fa", slot: "out" });
    assert.deepEqual(segs[2], { kind: "prose", text: " total." });

    // IMAGE form `![…]` → embed:true (expands the output in place).
    assert.deepEqual(splitAnswer("![9](@tool:e7ed9fa:out)")[0], { kind: "token", embed: true, label: "9", id: "e7ed9fa", slot: "out" });
    // bare @tool:id defaults to :out
    assert.deepEqual(splitAnswer("[x](@tool:abc1231)")[0], { kind: "token", embed: false, label: "x", id: "abc1231", slot: "out" });
    // :in and a piped format
    assert.deepEqual(splitAnswer("![c](@tool:abc1231:in)")[0], { kind: "token", embed: true, label: "c", id: "abc1231", slot: "in" });
    assert.deepEqual(splitAnswer("![e](@tool:abc1231:out | latex)")[0], { kind: "token", embed: true, label: "e", id: "abc1231", slot: "out", fmt: "latex" });
});

test("splitAnswer: an answer with no tokens is a single prose segment (verbatim)", () => {
    const md = "Just a plain answer with **bold** and a [real link](https://x.test).";
    assert.deepEqual(splitAnswer(md), [{ kind: "prose", text: md }]);
});

test("GRAMMAR GATE: malformed / non-token links stay prose (never specially handled)", () => {
    for (const md of [
        "[x](@tool:nothexx)",             // id isn't hex
        "[x](@tool:abc123)",              // too short (6 — the pre-checksum length)
        "[x](@tool:abc12345)",            // too long
        "[x](@tool:)",                    // no id
        "[x](@tool:abc1231:sideways)",     // bad slot → the :slot just isn't captured, but 'sideways' breaks the URL match
        "see @tool:abc1231 inline",        // not a markdown link at all
        "[x](https://tool.example/abc)",  // ordinary link
    ]) {
        const segs = splitAnswer(md);
        assert.ok(segs.every(s => s.kind === "prose"), `should stay prose: ${md}`);
        assert.equal(segs.map(s => s.text).join(""), md, `prose preserved verbatim: ${md}`);
    }
});

test("hasTokens: true only when a real token is present", () => {
    assert.equal(hasTokens("[9](@tool:e7ed9fa:out)"), true);
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

test("MULTI-TURN resolution: a HEX citation resolves to its OWN step, and the alias to the LATEST (the reported bug's two flows)", () => {
    // Two python_exec steps across turns, minted from the GLOBAL seq so their ids DIFFER (the fix). This mirrors
    // the reported run: turn 1 explored (df.head), turn 2 re-ran with token → the model cited turn 2's id.
    const t1 = toolToken("abcd1234", 1);   // turn 1, global seq 1 (exploratory)
    const t2 = toolToken("abcd1234", 2);   // turn 2, global seq 2 (the computation the model cited)
    assert.notEqual(t1, t2, "distinct global-seq ids (the collision the fix removes)");
    const steps = [
        { seq: 1, tool: "python_exec", token: t1, result: "df.head" },
        { seq: 2, tool: "python_exec", token: t2, result: "the computation" },
    ];
    // HASH flow: citing turn 2's hex resolves to turn 2's step — NOT the earlier one (the bug went to step 1).
    assert.equal(resolveTokenStep(t2, steps).seq, 2, "hex citation → its own (latest) step");
    assert.equal(resolveTokenStep(t1, steps).seq, 1, "and the earlier hex still resolves to the earlier step");
    // NON-HASH (alias) flow: @tool:python_exec → the LATEST python_exec step, across turns.
    assert.equal(resolveTokenStep("python_exec", steps).seq, 2, "tool-name alias → the latest python_exec, across turns");
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

// A CITATION INSIDE CODE IS BEING EXPLAINED, NOT MADE. A model writing `![example](@tool:abc1234)` in
// backticks is showing you the syntax; expanding it swallows the explanation and renders the thing being
// described in place of the description. Same rule the `@tool:` macro follows in exec — a C macro does not
// expand inside a string or a comment.
test("a pointer inside an inline code span is left as text", () => {
    const segs = splitAnswer("write `![example](@tool:abc1234)` to embed it");
    assert.equal(segs.length, 1, "one prose segment");
    assert.equal(segs[0].kind, "prose");
    assert.match(segs[0].text, /`!\[example\]\(@tool:abc1234\)`/, "verbatim, backticks and all");
});

test("...the LINK form too", () => {
    const segs = splitAnswer("use `[label](@tool:abc1234)` for a jump");
    assert.deepEqual(segs.map((s) => s.kind), ["prose"]);
});

test("a pointer inside a fenced block is left as text", () => {
    const md = "Here is how:\n\n```\n![shot](@tool:abc1234)\n```\n\ndone";
    assert.deepEqual(splitAnswer(md).map((s) => s.kind), ["prose"]);
});

test("a fence containing backticks does not leak code-ness into the prose after it", () => {
    // Fences are matched first and skipped wholesale: pairing inline backticks across one would mark half
    // the document as code and silently stop citing anything below it.
    const md = "```\na ` stray tick\n```\n\nthe table ![t](@tool:abc1234) is above";
    const segs = splitAnswer(md);
    assert.ok(segs.some((s) => s.kind === "token" && s.id === "abc1234"), "the real citation still resolves");
});

test("a REAL citation beside an explained one: one renders, one does not", () => {
    const segs = splitAnswer("spelled `![x](@tool:abc1234)`, it renders as ![x](@tool:def5678)");
    const toks = segs.filter((s) => s.kind === "token");
    assert.equal(toks.length, 1, "only the one outside the backticks");
    assert.equal(toks[0].id, "def5678");
});

test("an UNTERMINATED backtick does not swallow the rest of the answer", () => {
    // A stray tick is ordinary in prose. Treating it as opening a span to end-of-document would silently
    // stop every citation after it, which is a far worse failure than rendering one that was being quoted.
    const segs = splitAnswer("a ` stray tick, then ![t](@tool:abc1234)");
    assert.ok(segs.some((s) => s.kind === "token"), "the citation after it still resolves");
});

test("double-backtick spans close on a run of exactly two, so an inner single tick is inside", () => {
    const segs = splitAnswer("``a ` b ![x](@tool:abc1234)`` after");
    assert.deepEqual(segs.map((s) => s.kind), ["prose"]);
});

test("tokenIdsIn skips a mentioned citation, so it cannot dedup an output that was never shown", () => {
    assert.deepEqual([...tokenIdsIn("as in `![x](@tool:abc1234)`")], []);
    assert.deepEqual([...tokenIdsIn("as in ![x](@tool:abc1234)")], ["abc1234"]);
});

// EVERY SHAPE OF CODE BLOCK a model might reach for, since the point is that it can explain the syntax in
// whichever one it picks.
test("a tilde fence hides a pointer too, and closes only on its own marker", () => {
    assert.deepEqual(splitAnswer("~~~\n![x](@tool:abc1234)\n~~~").map((s) => s.kind), ["prose"]);
});

test("a fence with a language tag still hides it", () => {
    assert.deepEqual(splitAnswer("```markdown\n![x](@tool:abc1234)\n```").map((s) => s.kind), ["prose"]);
});

test("a fence INDENTED inside a list item still hides it", () => {
    const md = "- like so:\n  ```\n  ![x](@tool:abc1234)\n  ```";
    assert.deepEqual(splitAnswer(md).map((s) => s.kind), ["prose"]);
});

test("a fence does not hide the citations AFTER it", () => {
    const segs = splitAnswer("```\n![a](@tool:abc1234)\n```\n\nand ![b](@tool:def5678)");
    const toks = segs.filter((s) => s.kind === "token");
    assert.deepEqual(toks.map((t) => t.id), ["def5678"], "the fence closes; the one after it is a real cite");
});

// A 4-SPACE INDENT IS NOT CODE HERE, and that is a decision coupled to the renderer rather than an oversight:
// `markdown()` emits a plain <p> for an indented block, so treating it as code would leave an unexpanded
// `![x](@tool:…)` in ordinary prose — a citation that looks broken instead of one that looks explained. Both
// halves are asserted, so a renderer that later grows indented-code support fails HERE and forces the choice.
test("a 4-space indented block is not code — and the renderer agrees", () => {
    const md = "text:\n\n    ![x](@tool:abc1234)\n\nafter";
    assert.ok(splitAnswer(md).some((s) => s.kind === "token"), "the citation still resolves");
    const html = markdown("text:\n\n    an indented line\n\nafter");
    assert.ok(!/<pre|<code/.test(html), "…because markdown() does not make a code block of it either");
});

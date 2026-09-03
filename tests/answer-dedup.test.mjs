"use strict";
// A model routinely does BOTH: embeds an output mid-sentence AND calls `answer` with the same one. The answer
// set is rendered under the reply, so the table appeared twice — once where it was quoted, once appended.
import { test } from "node:test";
import assert from "node:assert";
const { answerWithoutShown, tokenIdsIn } = await import("../answer-tokens.ts");

// Two steps, each with a minted token. `resolve` maps an id to the STEP it points at — which is the identity
// dedup must use, because the same output can be cited by hex in one place and by tool name in the other.
// Ids are 7 hex: 6 of payload plus a check character (token-id.ts). A 6-char id would parse as a tool-NAME
// alias instead, which is exactly the ambiguity the check character exists to remove.
const STEPS = [
    { step: 1, token: "a1b2c3f", tool: "python_exec" },
    { step: 2, token: "d4e5f6b", tool: "exec" },
];
const resolve = (id) => STEPS.find((s) => s.token === id)
    ?? [...STEPS].reverse().find((s) => s.tool === id) ?? null;
const isAlias = (n) => STEPS.some((s) => s.tool === n);

test("an output quoted inline is not appended again", () => {
    const prose = "Here is the table ![the table](@tool:a1b2c3f:out) — as you can see.";
    const answer = "![the table](@tool:a1b2c3f:out)";
    assert.equal(answerWithoutShown(answer, prose, resolve, isAlias).trim(), "",
        "nothing left to append — the whole set was already shown");
});

test("identity is the resolved STEP, so a hex and its tool-name alias are the same output", () => {
    // The prose cites the tool NAME; the answer set holds the hex. Comparing the strings would miss it.
    const prose = "See ![it](@tool:python_exec:out).";
    const answer = "![the table](@tool:a1b2c3f:out)";
    assert.equal(answerWithoutShown(answer, prose, resolve, isAlias).trim(), "");
    // …and the other way round.
    assert.equal(answerWithoutShown("![x](@tool:python_exec:out)", "![y](@tool:a1b2c3f:out)", resolve, isAlias).trim(), "");
});

test("an output NOT quoted inline still gets appended", () => {
    const prose = "I ran two things ![one](@tool:a1b2c3f:out).";
    const answer = "![first](@tool:a1b2c3f:out) ![second](@tool:d4e5f6b:out)";
    const left = answerWithoutShown(answer, prose, resolve, isAlias);
    assert.ok(!left.includes("a1b2c3f"), "the quoted one is dropped");
    assert.ok(left.includes("d4e5f6b"), "the unquoted one survives — it has nowhere else to be shown");
    assert.deepEqual([...tokenIdsIn(left)], ["d4e5f6b"]);
});

test("prose around a dropped citation is preserved, not mangled", () => {
    const answer = "before ![x](@tool:a1b2c3f:out) after";
    const out = answerWithoutShown(answer, "![x](@tool:a1b2c3f:out)", resolve, isAlias);
    assert.equal(out, "before  after");
});

test("no inline citations → the answer set is untouched", () => {
    const answer = "![the table](@tool:a1b2c3f:out)";
    assert.equal(answerWithoutShown(answer, "just prose, no citations", resolve, isAlias), answer);
    assert.equal(answerWithoutShown(answer, "", resolve, isAlias), answer);
});

test("an unresolvable citation never drops anything (better a duplicate than a vanished result)", () => {
    const answer = "![the table](@tool:a1b2c3f:out)";
    // The prose cites something this run doesn't have — it must not silently suppress a real output.
    assert.equal(answerWithoutShown(answer, "![gone](@tool:zzzzzz:out)", resolve, isAlias), answer);
});

test("the :in slot is the same output as :out for dedup — one step, one render", () => {
    // Citing the CODE inline and the RESULT in the answer set is still one step; showing both is the
    // duplication being removed. (If that ever proves too aggressive, slot belongs in the identity.)
    const out = answerWithoutShown("![result](@tool:a1b2c3f:out)", "![code](@tool:a1b2c3f:in)", resolve, isAlias);
    assert.equal(out.trim(), "");
});

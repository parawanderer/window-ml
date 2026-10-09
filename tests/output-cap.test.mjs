// The per-tool output-cap escalation (contract.ts). Pure — the agent alone is capped at the tool default;
// raising it needs the human gate + a justification, clamped to a ceiling. Tested directly (same code the
// exec/python run + the readonly/sandbox gates use).
import { test } from "node:test";
import assert from "node:assert";
import { resolveOutputCap, outputCapEscalated, outputCapPrecheck, OUTPUT_CAP } from "../src/contract/contract-pointers.js";

test("absent maxChars → the tool default, no escalation", () => {
    const e = resolveOutputCap("exec", undefined, undefined);
    assert.equal(e.cap, 500);
    assert.equal(e.escalated, false);
    const p = resolveOutputCap("python_exec", undefined, undefined);
    assert.equal(p.cap, 2000);
    assert.equal(p.escalated, false);
});

test("a value at or below the default is honored and never escalates (a tighter cap is always allowed)", () => {
    assert.deepEqual(
        [resolveOutputCap("exec", 300).cap, resolveOutputCap("exec", 300).escalated],
        [300, false],
    );
    assert.equal(resolveOutputCap("exec", 500).escalated, false, "exactly the default is not a raise");
});

test("above the default → escalation, clamped to the ceiling, reason required", () => {
    const e = resolveOutputCap("exec", 4000, "");
    assert.equal(e.escalated, true);
    assert.equal(e.cap, 4000);
    assert.equal(e.reasonMissing, true, "no reason yet");
    assert.equal(e.clamped, false);
    const clamped = resolveOutputCap("exec", 99999, "because");
    assert.equal(clamped.cap, OUTPUT_CAP.exec.ceiling, "clamped to 8000");
    assert.equal(clamped.clamped, true);
    assert.equal(clamped.reasonMissing, false, "reason given");
});

test("invalid / non-positive maxChars falls back to the default (never NaN/negative)", () => {
    assert.equal(resolveOutputCap("exec", "lots").cap, 500);
    assert.equal(resolveOutputCap("exec", -10).cap, 500);
    assert.equal(resolveOutputCap("exec", NaN).cap, 500);
    assert.equal(resolveOutputCap("python_exec", Infinity).escalated, false, "Infinity isn't finite → default, no raise");
});

test("outputCapEscalated mirrors the flag from raw args (the gate hook)", () => {
    assert.equal(outputCapEscalated("exec", { js: "x", maxChars: 8000, maxCharsReason: "y" }), true);
    assert.equal(outputCapEscalated("exec", { js: "x" }), false);
    assert.equal(outputCapEscalated("python_exec", { code: "x", maxChars: 3000, maxCharsReason: "y" }), true);
});

test("outputCapPrecheck: a raise with NO reason is refused with an actionable message; a justified raise passes", () => {
    const err = outputCapPrecheck("exec", { js: "x", maxChars: 8000 });
    assert.match(err, /needs a justification/i);
    assert.match(err, /maxCharsReason/, "names the arg the model must add");
    assert.equal(outputCapPrecheck("exec", { js: "x", maxChars: 8000, maxCharsReason: "reading a full config file" }), null, "justified → passes");
    assert.equal(outputCapPrecheck("exec", { js: "x" }), null, "no raise → nothing to justify");
    assert.equal(outputCapPrecheck("python_exec", { code: "x", maxChars: 5000 }), outputCapPrecheck("python_exec", { code: "x", maxChars: 5000 }));
});

test("every place that STATES a cap reads it from OUTPUT_CAP, so changing the table changes what the model is told", async () => {
    // The cap was written down four times: this table, a literal 500 in the read-only formatter (the path most surveys
    // take), "~500" in the exec description, and `outputCapParams(500, 8000, …)`. Changing the table alone would
    // have moved approved runs and left read-only surveys, and the model's instructions, on the old number.
    const { outputCapParams } = await import("../src/tools/tool-params.ts");
    for (const tool of ["exec", "python_exec"]) {
        const { default: d, ceiling: c } = OUTPUT_CAP[tool];
        const p = outputCapParams(tool, "x");
        assert.match(p.maxChars.description, new RegExp(`\\(default ${d}, max ${c}\\)`), tool);
        assert.match(p.maxCharsReason.description, new RegExp(`default ${d} chars`), tool);
    }
    // The read-only path clips at the same default, and its note states it.
    const { formatReadonlyExec } = await import("../src/agent/approval.ts");
    const d = OUTPUT_CAP.exec.default;
    assert.match(formatReadonlyExec("x".repeat(d + 100), []).result, new RegExp(`^x{${d}}… \\[first ${d} of ${d + 100} chars\\]$`));
    assert.match(formatReadonlyExec(null, ["y".repeat(d + 7)]).result, new RegExp(`… \\[first ${d} of ${d + 7} chars\\]`));
});

test("the read-only path honours a SMALLER maxChars, as the approved path does; a larger one stays at the default", async () => {
    // A tighter cap is always allowed (resolveOutputCap). The read-only formatter ignored the call's maxChars, so the
    // same exec cut at 120 when approved came back whole when its code happened to be read-only.
    const { formatReadonlyExec } = await import("../src/agent/approval.ts");
    const d = OUTPUT_CAP.exec.default;
    assert.match(formatReadonlyExec("x".repeat(300), [], undefined, 0, 120).result, /^x{120}… \[first 120 of 300 chars\]$/);
    assert.match(formatReadonlyExec(null, ["y".repeat(300)], undefined, 0, 50).result, /… \[first 50 of 300 chars\]/);
    assert.match(formatReadonlyExec("x".repeat(d + 100), [], undefined, 0, d * 4).result, new RegExp(`^x{${d}}… \\[first ${d} of`), "never above the default here");
    assert.match(formatReadonlyExec("x".repeat(d + 100), [], undefined, 0, "nonsense").result, new RegExp(`^x{${d}}…`), "an invalid value is the default");
});

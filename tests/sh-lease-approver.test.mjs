// sh-lease-approver.test.mjs — the ml.sh bench's approver approves an exec step's own gate and denies everything else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shLeaseDecide } from "./e2e/bench/sh-lease-approver.mjs";

// --- the ml.sh bench approver: one yes, every other gate a no ---

test("the ml.sh bench approver approves only an exec step's own gate", () => {
    assert.equal(shLeaseDecide({ tool: "exec", key: "k1", arguments: { js: "1" } }), true);
    assert.equal(shLeaseDecide({ tool: "exec", key: "k1", askId: null }), true);
});

test("the ml.sh bench approver denies every nested ask, every other gated tool, and a malformed gate", () => {
    const denied = [
        { tool: "sh", askId: "a1", arguments: { argv: ["cat", "/home/x/.ssh/config"] } },   // an ml.sh ask
        { tool: "exec", askId: "a2" },                         // a nested ask whose kind reads exec
        { tool: "arrival-ask", askId: "a3" },
        { tool: "python_exec", arguments: { mode: "full" } },
        { tool: "python_exec", arguments: { mode: "readonly" } },
        { tool: "propose_manifest" }, { tool: "fetch_url" }, { tool: "click" }, { tool: "type" },
        {}, null, undefined, { tool: "EXEC" },
    ];
    for (const g of denied) assert.equal(shLeaseDecide(g), false, JSON.stringify(g));
});

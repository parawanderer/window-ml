// phone-runtime-grant.test.mjs — what the PHONE grants a runtime offer: mayPair off whatever the library defaults to,
// and the "It receives" lines derived from the grant that is sent (lane 8, docs/plan/repl/LANE_8_DESIGN.md).
import { test } from "node:test";
import assert from "node:assert/strict";

const { phoneGrant, receivesLines, pairingProblem } = await import("../src/pairing/api.ts");

const base = { scopes: [], mayPair: true, mayRevoke: false, validityMs: 1 };

// --- the default grant of a runtime offer ---
test("a runtime offer starts with mayPair off, for every input the library can default to", () => {
    for (const mayPair of [true, false]) for (const mayRevoke of [true, false]) for (const scopes of [[], ["view"], ["view", "drive", "desktop"]]) {
        const g = phoneGrant({ role: "runtime", grant: { ...base, mayPair, mayRevoke, scopes } });
        assert.equal(g.mayPair, false);
        assert.equal(g.mayRevoke, mayRevoke, "mayRevoke is the library's rule, untouched");
        assert.deepEqual(g.scopes, scopes);
    }
});

test("other roles keep the library's grant exactly", () => {
    for (const role of ["client", "box-connector", "unknown-role"]) {
        assert.deepEqual(phoneGrant({ role, grant: { ...base, mayPair: true } }), { ...base, mayPair: true });
    }
});

// --- the card's lines follow the grant ---
test("the lines say what the grant sends, for every mayPair x mayRevoke x signer", () => {
    for (const mayPair of [true, false]) for (const mayRevoke of [true, false]) for (const signer of [undefined, "Work laptop"]) {
        const text = receivesLines({ signer }, { scopes: [], mayPair, mayRevoke }).join("\n");
        assert.equal(/can add devices to this account by itself/.test(text), mayPair);
        assert.equal(/cannot add devices/.test(text), !mayPair);
        assert.equal(/It will be the device that signs removals/.test(text), mayRevoke);
        assert.doesNotMatch(text, /also signs revocations/, "a second holder is never described");
        assert.equal(/signs removals for this account, and only one device can/.test(text), !mayRevoke && !!signer);
    }
});

test("the off line names what a browser runtime loses", () => {
    assert.match(receivesLines({}, { scopes: [], mayPair: false, mayRevoke: false }).join(" "), /re-sign other devices' certificates/);
});

// --- what the phone says when the runtime's proof fails ---
test("each failed-proof reason says nothing was paired, says what to do, and is its own sentence", () => {
    const seen = new Set();
    for (const reason of ["chain", "not-mine", "not-my-agreement-key", "wrong-role"]) {
        const t = pairingProblem({ reason, message: "HUB TEXT" });
        assert.match(t, /nothing was paired/);
        assert.match(t, /start again/);
        assert.doesNotMatch(t, /HUB TEXT/, "a hub's words never reach the screen");
        seen.add(t);
    }
    assert.equal(seen.size, 4);
});

test("a name shown in the signer line is marked as the device's own word", () => {
    assert.match(receivesLines({ signer: "Work laptop" }, { scopes: [], mayPair: false, mayRevoke: false }).join(" "), /gave itself, unchecked/);
});

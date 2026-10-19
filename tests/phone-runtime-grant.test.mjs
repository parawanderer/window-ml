// phone-runtime-grant.test.mjs — what the PHONE grants a runtime offer: mayPair off whatever the library defaults to,
// and the "It receives" lines derived from the grant that is sent (lane 8, docs/plan/repl/LANE_8_DESIGN.md).
import { test } from "node:test";
import assert from "node:assert/strict";

const { phoneGrant, receivesLines } = await import("../src/pairing/api.ts");

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
        assert.equal(/It will be the device that signs removals/.test(text), mayRevoke && !signer);
        assert.equal(/also signs revocations/.test(text), mayRevoke && !!signer);
        assert.equal(/signs removals for this account, and only one device can/.test(text), !mayRevoke && !!signer);
    }
});

test("the off line names what a browser runtime loses", () => {
    assert.match(receivesLines({}, { scopes: [], mayPair: false, mayRevoke: false }).join(" "), /re-sign other devices' certificates/);
});

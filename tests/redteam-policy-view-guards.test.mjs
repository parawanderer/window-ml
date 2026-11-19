// redteam-policy-view-guards.test.mjs — what a registered order or classifier that THROWS must not cost the person, read
// through the STORE the policy page reads (sessionPolicies) rather than the pure functions alone: the session's read must
// still answer, every removal must widen, and the confirm a widening removal needs must be demanded even where the
// truth is "this removal narrows" — a doubt about the order is a doubt about every removal in the view.
//
// tests/policy-effective-view.test.mjs owns the pure shapes (a throwing order, a non-order, a throwing classifier); these
// rows go through sw-policies.ts and its removal gate, which is what `exec` and the page actually call.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } } };
const P = await import("../src/sw/sw-policies.ts");
const V = await import("../src/sw/sw-policy-view.ts");
await P.policiesReady;

const T = { timeout: 30000 };
const ALWAYS = "(c) => c.kind === \"fetch\"";

test("RED TEAM: an untrusted order in the store's view still answers the read, widens every removal (another consumer's included), and demands the confirm", T, () => {
    const hash = "h-rt-guards";
    // The control FIRST, before any order is registered: a sound view removes an allow in one gesture.
    const sound = P.addRunPolicy("h-rt-sound", { consumer: "fetch", effect: "allow", source: ALWAYS, label: "sound allow", origin: "person" });
    // Read one consumer's removal class through the store, then drop that policy so the store holds only the shapes below.
    const soundRow = P.sessionPolicies("h-rt-sound").rows.find((r) => r.entry.id === sound.id);
    assert.equal(soundRow?.removal?.class, "narrows", "the control: with no registered order, an allow's removal narrows");
    assert.deepEqual(P.removeFromSession("h-rt-sound", sound.id, false), { removed: true, class: "narrows" }, "and it is one gesture");
    P.removePolicy(sound.id);

    // The shapes: a stored deny, ask and allow for fetch, and another consumer's allow, so the view spans two consumers.
    const deny = P.addGlobalPolicy({ consumer: "fetch", effect: "deny", source: ALWAYS, label: "never fetch" });
    const allow = P.addGlobalPolicy({ consumer: "fetch", effect: "allow", source: ALWAYS, label: "always fetch" });
    const ask = P.addRunPolicy(hash, { consumer: "fetch", effect: "ask", source: ALWAYS, label: "ask to fetch", origin: "person" });
    const shAllow = P.addGlobalPolicy({ consumer: "sh", effect: "allow", source: "(c) => c.argv[0] === \"ls\"", label: "ls" });

    // The consumer's judge cannot be read: both a registered order and a classifier that throw on every call.
    V.registerPrecedence("fetch", () => { throw new Error("the order broke"); });
    V.registerRemovalClass("fetch", () => { throw new Error("the classifier broke"); });

    // The read answers, and answers by strictness, knowing that it does not know.
    const read = P.sessionPolicies(hash);
    const by = (id) => read.rows.find((r) => r.entry.id === id);
    for (const id of [deny.id, ask.id, allow.id, shAllow.id, V.DEFAULT_ROW_ID]) assert.ok(by(id), `${id} is missing from the read`);
    assert.equal(by(deny.id).wins, true, "by strictness: the deny is not beaten");
    assert.equal(by(ask.id).wins, false);
    assert.equal(by(allow.id).wins, false);
    assert.deepEqual([...by(V.DEFAULT_ROW_ID).overriddenBy].sort(), [deny.id, ask.id].sort(), "the default is beaten by the deny and the ask, never by the allow");

    // Every removal widens: the throwing classifier's own row, and every other row because the view held an order it
    // could not trust — the other consumer's allow included, since the doubt is the view's, not the consumer's.
    for (const id of [deny.id, ask.id, allow.id, shAllow.id]) assert.equal(by(id).removal.class, "widens", `${id} would be removed as narrowing`);
    assert.ok(by(deny.id).removal.exposes.some((e) => e.id === ask.id), "the confirm names the ask that would decide what the deny decided");

    // The gate: a removal that would have been one gesture now needs the confirm, and the refusal carries the class and
    // what becomes reachable so the caller can show it.
    const refused = P.removeFromSession(hash, allow.id, false);
    assert.equal(refused.removed, false);
    assert.equal(refused.why, "confirm");
    assert.equal(refused.row.removal.class, "widens");
    assert.deepEqual(P.removeFromSession(hash, allow.id, true), { removed: true, class: "widens" }, "the confirmed removal goes, as a widening one");

    // And judging is untouched: the read's doubt is about a removal's class, never about which call runs.
    const j = P.judgeCall(hash, "fetch", P.fetchFacts("https://a.example/"));
    assert.deepEqual([j.decision, j.by.id], ["deny", deny.id]);
});

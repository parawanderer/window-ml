// sw-policies-unloaded.test.mjs — the policy store before its storage read finishes (src/sw/sw-policies.ts): a worker that
// has just woken. Every judgement is ASK, whatever the policies and the built-in default would say (docs/spec/POLICIES.md,
// "A store not yet loaded means ASK, free tiers included"). Its own file, since the module is loaded with storage that
// never answers.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.chrome = { storage: { local: { get: () => new Promise(() => {}), set: async () => {} } } };
const P = await import("../src/sw/sw-policies.ts");

// --- before the saved policies are read ---

test("until the saved policies are read, judgeCall answers ASK, whatever the policies and the built-in default say", () => {
    assert.equal(P.policiesLoaded(), false);
    P.addRunPolicy("h", { consumer: "fetch", effect: "allow", source: "(c) => true", label: "all", origin: "person" });
    assert.equal(P.judgeCall("h", "fetch", P.fetchFacts("https://a.example/")).decision, "ask", "not allow: a deny may be unread");
    assert.equal(P.judgeCall("h", "fetch", { kind: "fetch", url: "c", host: "", effects: [] }).decision, "ask", "not even the built-in default answers");
});

// --- an unloaded store and an `ask` policy are told apart ---

test("an unloaded store's ask names no policy; an ask POLICY's judgement does, so a consumer can tell the two apart", () => {
    const j = P.judgeCall("h", "fetch", P.fetchFacts("https://a.example/"));
    assert.equal(j.decision, "ask");
    assert.equal(j.by, undefined, "no policy decided: the store is not read");
    assert.equal(P.askWhyOf(j), undefined, "so the card says nothing about a policy");
    P.addRunPolicy("h", { consumer: "fetch", effect: "ask", source: "(c) => true", label: "asks", origin: "person" });
    const again = P.judgeCall("h", "fetch", P.fetchFacts("https://a.example/"));
    assert.equal(again.decision, "ask", "still ask until the store is read, whatever the policy says");
    assert.equal(again.by, undefined, "an unloaded store never claims a policy decided");
});

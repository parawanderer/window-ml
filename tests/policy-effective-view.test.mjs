// policy-effective-view.test.mjs — one session's effective policies as rows (src/sw/sw-policy-view.ts, sessionPolicies in
// src/sw/sw-policies.ts, docs/spec/POLICIES.md "The effective view"): the winner each row claims, ENUMERATED against judgeCall over
// every pair of layers and effects, the default's own assertions, the two removal classes, and the shape a row may carry.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } } };
const P = await import("../src/sw/sw-policies.ts");
const V = await import("../src/sw/sw-policy-view.ts");
await P.policiesReady;

const ALWAYS = "(c) => c.kind === \"fetch\"";
const call = P.fetchFacts("https://x.example/");
const pure = { kind: "fetch", url: "cache", host: "", effects: [] };   // inside the built-in default's bound: free
const STRICT = { deny: 3, ask: 2, allow: 1 };
const EFFECTS = ["allow", "ask", "deny"];
const LAYERS = ["global", "session"];

/** Put one always-matching fetch policy in a layer; returns it. */
const put = (layer, hash, effect, label) => layer === "global"
    ? P.addGlobalPolicy({ consumer: "fetch", effect, source: ALWAYS, label })
    : P.addRunPolicy(hash, { consumer: "fetch", effect, source: ALWAYS, label, origin: "person" });

// --- the winner each row claims is the policy judgeCall names: every layer pair × effect pair ---

test("for every pair of layers and effects, the rows that win are exactly the ones judgeCall answers with, and the overrides follow strictness", () => {
    let n = 0;
    for (const la of LAYERS) for (const ea of EFFECTS) for (const lb of LAYERS) for (const eb of EFFECTS) {
        const hash = `h-enum-${n++}`;
        // Two policies with the same source and effect in one run list would be one (addRunPolicy de-duplicates), so label them apart and skip that pair.
        if (la === "session" && lb === "session" && ea === eb) continue;
        const a = put(la, hash, ea, `A ${la} ${ea}`), b = put(lb, hash, eb, `B ${lb} ${eb}`);
        try {
            const j = P.judgeCall(hash, "fetch", call);
            const want = STRICT[ea] >= STRICT[eb] ? ea : eb;
            assert.equal(j.decision, want, `${la}/${ea} with ${lb}/${eb}`);
            const { rows } = P.sessionPolicies(hash);
            const row = (id) => rows.find((r) => r.entry.id === id);
            const winners = rows.filter((r) => r.layer !== "default" && r.wins).map((r) => r.entry.id).sort();
            const expected = [a, b].filter((p) => p.effect === want).map((p) => p.id).sort();
            assert.deepEqual(winners, expected, `${la}/${ea} with ${lb}/${eb}: the rows that win are the ones of the decided effect`);
            assert.ok(winners.includes(j.by.id), `judgeCall's policy (${j.by.label}) is a winning row`);
            for (const [x, y] of [[a, b], [b, a]]) {
                const beats = STRICT[x.effect] > STRICT[y.effect];
                assert.equal(row(x.id).overrides.includes(y.id), beats, `${x.label} overrides ${y.label}`);
                assert.equal(row(y.id).overriddenBy.includes(x.id), beats);
            }
        } finally { P.removePolicy(a.id); P.removePolicy(b.id); }
    }
    assert.ok(n >= 30, "the enumeration ran");
});

// --- the default has its own assertions ---

test("the default row: present for a consumer with a policy, never overriding, beaten by an ask or a deny and not by an allow", () => {
    assert.deepEqual(P.sessionPolicies("h-def-0").rows, [], "no policy of any consumer: no row, the default's words come in `builtin`");
    assert.equal(P.sessionPolicies("h-def-0").builtin.label, P.BUILTIN_POLICY.label);
    assert.equal(P.judgeCall("h-def-0", "fetch", pure).by, "builtin", "and judgeCall answers with the default on a free call");
    for (const effect of EFFECTS) {
        const hash = `h-def-${effect}`;
        const p = put("session", hash, effect, `only ${effect}`);
        const rows = P.sessionPolicies(hash).rows;
        const d = rows.find((r) => r.layer === "default");
        assert.ok(d, "the default row appears beside the consumer's policy");
        assert.deepEqual(d.overrides, [], "the default overrides nothing");
        assert.equal(d.wins, effect === "allow", `an allow ties the default's verdict, an ask or a deny beats it (${effect})`);
        assert.equal(d.removal, undefined, "the default cannot be removed");
        // judgeCall agrees on a free call: the policy's effect beats the default's allow.
        assert.equal(P.judgeCall(hash, "fetch", pure).decision, effect);
        P.removePolicy(p.id);
    }
});

// --- removal: the two classes, and what a widening one exposes ---

test("removing an allow narrows, one gesture; removing a deny or an ask widens and names what becomes reachable", () => {
    const hash = "h-rm-class";
    const allow = put("session", hash, "allow", "the allow"), ask = put("global", hash, "ask", "the ask"), deny = put("session", hash, "deny", "the deny");
    try {
        const rows = P.sessionPolicies(hash).rows;
        const rm = (p) => rows.find((r) => r.entry.id === p.id).removal;
        assert.deepEqual(rm(allow), { class: "narrows", exposes: [] });
        assert.equal(rm(deny).class, "widens");
        assert.deepEqual(rm(deny).exposes.map((e) => e.id), [ask.id], "with the ask still there, the deny hides the ask and nothing below it");
        assert.equal(rm(ask).class, "widens");
        assert.deepEqual(rm(ask).exposes, [], "the deny still stands over everything the ask decided");
    } finally { for (const p of [allow, ask, deny]) P.removePolicy(p.id); }
    const solo = put("session", "h-rm-solo", "deny", "alone");
    const row = P.sessionPolicies("h-rm-solo").rows.find((r) => r.entry.id === solo.id);
    assert.deepEqual(row.removal.exposes.map((e) => e.id), ["builtin"], "removing the only deny exposes the default");
    P.removePolicy(solo.id);
});

test("a widening removal is refused without the confirm, with the entry and what it exposes; a narrowing one is not", () => {
    const hash = "h-rm-flow";
    const allow = put("session", hash, "allow", "the allow"), deny = put("global", hash, "deny", "the deny");
    const first = P.removeFromSession(hash, deny.id, false);
    assert.equal(first.removed, false);
    assert.equal(first.why, "confirm");
    assert.equal(first.row.entry.id, deny.id, "the refusal carries the entry");
    assert.ok(first.row.removal.exposes.some((e) => e.id === allow.id), "and the allow that would decide");
    assert.equal(P.globalPolicies().some((p) => p.id === deny.id), true, "nothing was removed");
    assert.deepEqual(P.removeFromSession(hash, allow.id, false), { removed: true, class: "narrows" }, "a narrowing removal needs no confirm");
    assert.deepEqual(P.removeFromSession(hash, deny.id, true), { removed: true, class: "widens" });
    assert.equal(P.judgeCall(hash, "fetch", call).decision, undefined, "both are gone");
});

test("a policy of another session is not in this session's view, so it cannot be removed through it", () => {
    const mine = put("session", "h-view-a", "allow", "a's"), theirs = put("session", "h-view-b", "allow", "b's");
    assert.deepEqual(P.sessionPolicies("h-view-a").rows.filter((r) => r.layer === "session").map((r) => r.entry.id), [mine.id]);
    assert.deepEqual(P.removeFromSession("h-view-a", theirs.id, true), { removed: false, why: "unknown" });
    assert.equal(P.runPolicies("h-view-b").length, 1, "still there");
    P.removePolicy(mine.id); P.removePolicy(theirs.id);
});

// --- generic over the consumer, and what a row may carry ---

test("a consumer the read has never heard of is placed and classed by the same rules, and may register its own classes", () => {
    const mk = (id, effect) => ({ id, consumer: "files", label: id, source: "(c) => true", effect });
    const rows = V.effectiveRows([mk("show-1", "allow")], [mk("hide-1", "deny")], { label: "d", source: "s" });
    assert.deepEqual(rows.map((r) => [r.layer, r.entry.id, r.wins]), [["default", "builtin", false], ["global", "show-1", false], ["session", "hide-1", true]]);
    assert.equal(rows[1].removal.class, "narrows");
    V.registerRemovalClass("files", (p) => (p.id.startsWith("show") ? "widens" : "narrows"));
    const again = V.effectiveRows([mk("show-1", "allow")], [mk("hide-1", "deny")], { label: "d", source: "s" });
    assert.equal(again[1].removal.class, "widens", "the consumer's own classifier replaced the default for it");
    assert.equal(again[2].removal.class, "narrows");
});

test("a row carries a policy's words and verdict and nothing else: no value, no call, no result", () => {
    const hash = "h-shape";
    const p = put("session", hash, "allow", "a label");
    const [d, row] = P.sessionPolicies(hash).rows;
    const allowed = ["id", "label", "source", "effect", "origin", "created", "broken"];
    for (const r of [d, row]) for (const k of Object.keys(r.entry)) assert.ok(allowed.includes(k), `entry field ${k}`);
    assert.deepEqual(Object.keys(row).sort(), ["consumer", "entry", "layer", "overriddenBy", "overrides", "removal", "wins"]);
    P.removePolicy(p.id);
});

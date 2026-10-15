// sw-policies.test.mjs — the policy store (src/sw/sw-policies.ts, docs/spec/POLICIES.md): the order a call is judged
// in (deny wins across scopes, a broken policy is no opinion, the built-in default last), what "Approve + remember"
// adds, removal and a session's deletion, and what is read back from storage (only well-formed policies).
import { test } from "node:test";
import assert from "node:assert/strict";

// Storage as a previous worker left it, read at module load: one well-formed global policy and assorted junk.
const STORED = {
    ml_policies_global: [
        { id: "g-ok", scope: "global", consumer: "fetch", effect: "deny", source: '(c) => c.host === "blocked.example"', label: "never blocked.example", origin: "person", created: 1 },
        { id: "g-bad-effect", scope: "global", consumer: "fetch", effect: "maybe", source: "(c) => true", label: "x", origin: "person", created: 1 },
        { id: "g-wrong-scope", scope: "run", consumer: "fetch", effect: "allow", source: "(c) => true", label: "x", origin: "person", created: 1 },
        "not a policy",
    ],
    ml_policies_run: {
        "h-old": [{ id: "r-ok", scope: "run", consumer: "fetch", effect: "allow", source: '(c) => c.url === "https://a.example/x"', label: "fetch https://a.example/x", origin: "card", created: 1 }],
        "h-junk": "not a list",
    },
};
const writes = [];
globalThis.chrome = {
    storage: { local: {
        get: async () => structuredClone(STORED),
        set: async (o) => { writes.push(structuredClone(o)); },
    } },
};
const P = await import("../src/sw/sw-policies.ts");
await P.policiesReady;

const facts = (url) => P.fetchFacts(url);

// --- what storage held is read back, and only what is well-formed ---

test("only well-formed policies of the right scope are read back from storage; junk is dropped, never guessed at", () => {
    assert.deepEqual(P.globalPolicies().map((p) => p.id), ["g-ok"]);
    assert.deepEqual(P.runPolicies("h-old").map((p) => p.id), ["r-ok"]);
    assert.deepEqual(P.runPolicies("h-junk"), []);
});

// --- the order a call is judged in ---

test("a run policy allows the call it names, and nothing else", () => {
    assert.equal(P.judgeCall("h-old", "fetch", facts("https://a.example/x")).decision, "allow");
    assert.equal(P.judgeCall("h-old", "fetch", facts("https://a.example/y")).decision, undefined);
    assert.equal(P.judgeCall("h-other", "fetch", facts("https://a.example/x")).decision, undefined, "another run does not get it");
    assert.equal(P.judgeCall(undefined, "fetch", facts("https://a.example/x")).decision, undefined, "nor does a call no run made");
});

test("deny wins over allow across scopes: a global deny refuses what a run policy allows", () => {
    P.addRunPolicy("h-deny", { consumer: "fetch", effect: "allow", source: '(c) => c.host === "blocked.example"', label: "allow blocked", origin: "card" });
    const j = P.judgeCall("h-deny", "fetch", facts("https://blocked.example/z"));
    assert.equal(j.decision, "deny");
    assert.equal(j.by.id, "g-ok");
});

test("a broken policy is no opinion, reported with its reason, and does not stop the others from deciding", () => {
    const broken = P.addRunPolicy("h-broken", { consumer: "fetch", effect: "allow", source: "(c) => c.uurl === 1", label: "typo", origin: "person" });
    P.addRunPolicy("h-broken", { consumer: "fetch", effect: "allow", source: '(c) => c.url === "https://ok.example/"', label: "ok", origin: "person" });
    const j = P.judgeCall("h-broken", "fetch", facts("https://ok.example/"));
    assert.equal(j.decision, "allow");
    assert.equal(j.by.label, "ok");
    assert.equal(j.broken.length, 1);
    assert.match(j.broken[0].reason, /no field 'uurl'/);
    assert.match(P.brokenReason(broken.id), /no field 'uurl'/, "kept for the policy page");
});

test("a broken DENY does not refuse and does not allow: the call asks", () => {
    P.addRunPolicy("h-bdeny", { consumer: "fetch", effect: "deny", source: "(c) => c.hots === 1", label: "typo deny", origin: "person" });
    const j = P.judgeCall("h-bdeny", "fetch", facts("https://x.example/"));
    assert.equal(j.decision, undefined);
    assert.equal(j.broken.length, 1);
});

test("with no person's answer the built-in default decides: a fetch reaches the network, so it is never free", () => {
    const j = P.judgeCall("h-none", "fetch", facts("https://x.example/"));
    assert.equal(j.decision, undefined);
    assert.equal(j.by, undefined);
});

test("the built-in default allows a call whose effects are inside the bound, and a person's deny still wins over it", () => {
    const pure = { kind: "fetch", url: "cache", host: "", effects: [] };
    assert.equal(P.judgeCall("h-none", "fetch", pure).by, "builtin");
    assert.equal(P.judgeCall("h-none", "fetch", pure).decision, "allow");
    P.addRunPolicy("h-pure-deny", { consumer: "fetch", effect: "deny", source: '(c) => c.url === "cache"', label: "no cache", origin: "person" });
    assert.equal(P.judgeCall("h-pure-deny", "fetch", pure).decision, "deny");
});

// --- "Approve + remember" ---

test("remembering URLs makes one exact-URL policy each, de-duplicated, whose source is the literal the person saw", () => {
    const tricky = 'https://a.example/q?x="1"&y=\\';
    const made = P.rememberFetchUrls("h-rem", ["https://a.example/1", tricky, "https://a.example/1"]);
    assert.equal(P.runPolicies("h-rem").length, 2);
    assert.equal(made[0].id, made[2].id);
    assert.equal(P.judgeCall("h-rem", "fetch", facts(tricky)).decision, "allow", "a URL with quotes and a backslash is one literal");
    assert.equal(P.judgeCall("h-rem", "fetch", facts("https://a.example/1?")).decision, undefined, "exact, not a prefix");
    assert.equal(P.runPolicies("h-rem")[0].origin, "card");
});

test("a remembered URL is a fact the person saw: a URL that tries to break out of the literal stays a literal", () => {
    const evil = 'x" || true || "';
    P.rememberFetchUrls("h-inj", [evil]);
    assert.equal(P.judgeCall("h-inj", "fetch", facts("https://anything.example/")).decision, undefined);
});

// --- removal, and a session's deletion ---

test("a removed policy stops deciding at once, from whichever scope held it", () => {
    const [p] = P.rememberFetchUrls("h-rm", ["https://rm.example/"]);
    assert.equal(P.judgeCall("h-rm", "fetch", facts("https://rm.example/")).decision, "allow");
    assert.equal(P.removePolicy(p.id), true);
    assert.equal(P.judgeCall("h-rm", "fetch", facts("https://rm.example/")).decision, undefined);
    assert.equal(P.removePolicy(p.id), false);
});

test("a deleted session's run policies go with it, and are written away", () => {
    P.rememberFetchUrls("h-del", ["https://del.example/"]);
    const before = writes.length;
    P.forgetRunPolicies("h-del");
    assert.deepEqual(P.runPolicies("h-del"), []);
    assert.ok(writes.length > before);
    assert.ok(!("h-del" in writes.at(-1).ml_policies_run));
});

test("what the model reads lists the global and the run's policies, as written", () => {
    const seen = P.policiesForModel("h-old");
    assert.deepEqual(seen.map((p) => [p.scope, p.effect, p.label]), [["global", "deny", "never blocked.example"], ["run", "allow", "fetch https://a.example/x"]]);
    assert.deepEqual(Object.keys(P.withPolicies({ a: 1 }, "h-old")).sort(), ["a", "policies"]);
});

test("once storage has been read, the store says so; until then a consumer must ask", () => {
    assert.equal(P.policiesLoaded(), true);
});

test("policies are kept in local storage, never sync", () => {
    assert.ok(writes.length > 0);
    assert.ok(!globalThis.chrome.storage.sync, "the store never reached for sync");
});

// sw-policies-upgrade.test.mjs — the policy store across the build that added the `ask` answer (docs/spec/POLICIES.md,
// "A policy may also answer ask", rule 3). A FIXTURE of what the build before wrote (only allow and deny records, the
// exact shape `saveGlobals`/`saveRuns` wrote then), read by the new code, asserting what judging it gives; then an `ask`
// the new code stores is read back by a second load of the module, as a worker restart would.
import { test } from "node:test";
import assert from "node:assert/strict";

// What the previous build left in chrome.storage.local, field for field.
const OLD_STORE = {
    ml_policies_global: [
        { id: "pol-old-g1", scope: "global", consumer: "fetch", effect: "deny", source: '(c) => c.host === "blocked.example"', label: "never blocked.example", origin: "person", created: 1760000000000 },
        { id: "pol-old-g2", scope: "global", consumer: "sh", effect: "allow", source: '(c) => c.argv[0] === "ls"', label: "ls", origin: "person", created: 1760000000001 },
    ],
    ml_policies_run: {
        "h-old": [{ id: "pol-old-r1", scope: "run", consumer: "fetch", effect: "allow", source: '(c) => c.kind === "fetch" && c.url === "https://a.example/x"', label: "fetch https://a.example/x", origin: "card", created: 1760000000002 }],
    },
    ml_policies_archived: { "h-arch": { at: 1760000000003, labels: ["fetch https://b.example/"], told: true } },
    ml_policies_lapsed: { "h-old": [{ id: "pol-old-l1", scope: "run", consumer: "fetch", label: "fetch https://c.example/", cause: "removed", at: 1760000000004, source: '(c) => c.url === "https://c.example/"' }] },
};

let stored = structuredClone(OLD_STORE);
globalThis.chrome = {
    storage: { local: {
        get: async () => structuredClone(stored),
        set: async (o) => { stored = { ...stored, ...structuredClone(o) }; },
    } },
};
const { resetStateRegistry } = await import("../src/state-registry.ts");
const P = await import("../src/sw/sw-policies.ts");
await P.policiesReady;
const facts = (url) => P.fetchFacts(url);

// --- the old store, read by the new build ---

test("the previous build's store loads unchanged: every record, and judges exactly as it did", () => {
    assert.deepEqual(P.globalPolicies().map(({ id, effect }) => [id, effect]), [["pol-old-g1", "deny"], ["pol-old-g2", "allow"]]);
    assert.deepEqual(P.runPolicies("h-old"), OLD_STORE.ml_policies_run["h-old"]);
    assert.deepEqual(P.globalPolicies(), OLD_STORE.ml_policies_global, "no field added, none dropped");
    assert.equal(P.judgeCall("h-old", "fetch", facts("https://a.example/x")).decision, "allow");
    assert.equal(P.judgeCall("h-old", "fetch", facts("https://blocked.example/")).decision, "deny");
    assert.equal(P.judgeCall("h-old", "fetch", facts("https://a.example/y")).decision, undefined);
    assert.equal(P.judgeCall("h-old", "sh", { argv: ["ls"], effects: [{ op: "exec", res: { kind: "process" } }] }, "host-sandbox").decision, "allow");
    assert.equal(P.judgeCall("h-old", "fetch", facts("https://c.example/")).lapsed.cause, "removed", "the lapsed reasons load too");
    assert.equal(P.archivedPolicyLoss("h-arch").labels[0], "fetch https://b.example/");
});

test("none of the old records is an ask, so no call that ran before asks now", () => {
    const calls = ["https://a.example/x", "https://a.example/y", "https://blocked.example/", "https://zzz.example/"];
    for (const u of calls) assert.notEqual(P.judgeCall("h-old", "fetch", facts(u)).decision, "ask", u);
});

test("an edit of an old record keeps writing the old shape: the same fields, an effect the old build also reads", () => {
    P.editPolicy("pol-old-r1", { label: "renamed" });
    const written = stored.ml_policies_run["h-old"][0];
    assert.deepEqual(Object.keys(written).sort(), Object.keys(OLD_STORE.ml_policies_run["h-old"][0]).sort());
    assert.equal(written.effect, "allow");
});

// --- an ask the new build stores, read by a restart ---

test("an ask the new build stores survives its own reload, global and run", async () => {
    const g = P.addGlobalPolicy({ consumer: "fetch", effect: "ask", source: '(c) => c.host === "asked.example"', label: "ask about asked.example" });
    P.addRunPolicy("h-new", { consumer: "sh", effect: "ask", source: '(c) => c.argv[0] === "rm"', label: "ask on rm", origin: "proposed" });
    assert.equal(stored.ml_policies_global.find((p) => p.id === g.id).effect, "ask", "written as ask");
    // A second load of the module over what was written: a worker restart.
    resetStateRegistry();   // the module declares its state once per load; a restart is a fresh registry
    const R = await import("../src/sw/sw-policies.ts?reload=1");
    await R.policiesReady;
    assert.ok(R.globalPolicies().some((p) => p.id === g.id && p.effect === "ask"), "the global ask is read back");
    assert.equal(R.runPolicies("h-new")[0].effect, "ask", "and the run's");
    assert.equal(R.judgeCall("h-x", "fetch", R.fetchFacts("https://asked.example/")).decision, "ask");
    assert.equal(R.judgeCall("h-new", "sh", { argv: ["rm", "x"], effects: [] }, "host-sandbox").by.label, "ask on rm");
    assert.equal(R.judgeCall("h-old", "fetch", R.fetchFacts("https://a.example/x")).decision, "allow", "the old records are still there");
});

test("a record with an effect nobody defined is still dropped, never read as an ask", async () => {
    stored.ml_policies_global.push({ id: "pol-junk", scope: "global", consumer: "fetch", effect: "prompt", source: "(c) => true", label: "junk", origin: "person", created: 1 });
    resetStateRegistry();
    const R = await import("../src/sw/sw-policies.ts?reload=2");
    await R.policiesReady;
    assert.ok(!R.globalPolicies().some((p) => p.id === "pol-junk"));
});

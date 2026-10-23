// sw-policies-preload.test.mjs — a policy added BEFORE the worker's first storage read finishes (src/sw/sw-policies.ts): the
// read must merge with what was added, and no save may reach storage until it has (docs/dev/policies.md, "Storage is read
// asynchronously"). A gated `chrome.storage.local` holding a FIXTURE of what the code before this fix wrote; every test
// loads the module afresh over it, adds while the read is held, releases it, and asserts memory AND storage.
import { test } from "node:test";
import assert from "node:assert/strict";

const pol = (id, scope, effect, source, extra = {}) => ({ id, scope, consumer: "fetch", effect, source, label: id, origin: "person", created: 1760000000000, ...extra });
const OLD = () => ({
    ml_policies_global: [pol("g-old", "global", "deny", '(c) => c.host === "blocked.example"')],
    ml_policies_run: { h: [pol("r-old", "run", "allow", '(c) => c.url === "https://a.example/old"', { origin: "card" })], other: [pol("o-old", "run", "allow", "(c) => false")] },
});
const NEW = { consumer: "fetch", effect: "allow", source: '(c) => c.url === "https://a.example/new"', label: "new", origin: "card" };

let n = 0;
/** A fresh module over `seed`; the first read waits for `release()` (and rejects when `fail`). `writes` records every `set`. */
async function boot(seed, { fail = false } = {}) {
    const { resetStateRegistry } = await import("../src/state-registry.ts");
    resetStateRegistry();
    const stored = structuredClone(seed), writes = [];
    let release; const gate = new Promise((r) => { release = r; });
    const read = gate.then(() => { if (fail) throw new Error("storage gone"); return structuredClone(stored); });
    globalThis.chrome = { storage: { local: {
        get: () => read,
        set: async (o) => { writes.push(structuredClone(o)); Object.assign(stored, structuredClone(o)); },
    } } };
    const P = await import(`../src/sw/sw-policies.ts?preload=${n++}`);
    const settle = async () => { release(); await P.policiesReady; for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
    return { P, stored, writes, read, settle };
}
const ids = (l) => l.map((p) => p.id);
const facts = (P, url) => P.fetchFacts(url);

// --- shape 1: a global policy added before the read ---

test("a global policy added before the read is in memory and in storage after it, beside the stored one", async () => {
    const { P, stored, settle } = await boot(OLD());
    const made = P.addGlobalPolicy({ consumer: "fetch", effect: "deny", source: '(c) => c.host === "new.example"', label: "new" });
    await settle();
    assert.deepEqual(ids(P.globalPolicies()), ["g-old", made.id], "stored first, then the one added early");
    assert.deepEqual(ids(stored.ml_policies_global), ["g-old", made.id]);
    assert.equal(P.judgeCall(undefined, "fetch", facts(P, "https://blocked.example/")).decision, "deny", "the stored deny is enforced");
    assert.equal(P.judgeCall(undefined, "fetch", facts(P, "https://new.example/")).decision, "deny", "so is the new one");
});

// --- shape 2: a run policy added before the read ---

test("a run policy added before the read keeps that run's stored policies", async () => {
    const { P, stored, settle } = await boot(OLD());
    const made = P.addRunPolicy("h", NEW);
    await settle();
    assert.deepEqual(ids(P.runPolicies("h")), ["r-old", made.id]);
    assert.deepEqual(ids(P.runPolicies("other")), ["o-old"], "another run's list is untouched");
    assert.deepEqual(ids(stored.ml_policies_run.h), ["r-old", made.id]);
    assert.equal(P.judgeCall("h", "fetch", facts(P, "https://a.example/old")).decision, "allow");
});

// --- shape 3: a save before the read must not overwrite storage ---

test("no write reaches storage while the read is pending, and none ever drops a stored policy", async () => {
    const { P, stored, writes, settle } = await boot(OLD());
    P.addGlobalPolicy({ consumer: "fetch", effect: "ask", source: "(c) => false", label: "g-new" });
    P.addRunPolicy("h", NEW);
    assert.equal(writes.length, 0, "a save before the read is deferred");
    await settle();
    assert.ok(writes.length > 0, "and issued after it");
    for (const w of writes) {
        if (w.ml_policies_global) assert.ok(ids(w.ml_policies_global).includes("g-old"), "a write dropped the stored global");
        if (w.ml_policies_run) { assert.ok(ids(w.ml_policies_run.h).includes("r-old") && ids(w.ml_policies_run.other).includes("o-old"), "a write dropped a stored run policy"); }
    }
    assert.equal(stored.ml_policies_global.length, 2);
});

// --- shape 4: loaded flips only once memory holds the merge ---

test("a judgement in the turn the read answers in never sees loaded with memory unfilled", async () => {
    const { P, read, settle } = await boot(OLD());
    let seen;
    // Registered after the module's own reaction on the same promise: runs in the same turn as the first, before the fill.
    read.then(() => { seen = { loaded: P.policiesLoaded(), j: P.judgeCall(undefined, "fetch", facts(P, "https://blocked.example/")) }; });
    await settle();
    assert.equal(seen.j.decision, seen.loaded ? "deny" : "ask", `loaded=${seen.loaded} with the stored deny unread: judged ${seen.j.decision}`);
    assert.equal(P.policiesLoaded(), true);
    assert.equal(P.judgeCall(undefined, "fetch", facts(P, "https://blocked.example/")).decision, "deny");
});

// --- shape 5: remove / edit of an id not loaded yet ---

test("removePolicy and editPolicy of a stored id answer no-such-policy until the read; after it they act", async () => {
    const { P, stored, settle } = await boot(OLD());
    assert.equal(P.removePolicy("g-old"), false, "the store alone cannot know it (the POLICIES handler awaits policiesReady)");
    assert.equal(P.editPolicy("r-old", { label: "x" }), undefined);
    await settle();
    assert.equal(P.removePolicy("g-old"), true);
    assert.equal(P.editPolicy("r-old", { label: "x" })?.label, "x");
    assert.deepEqual(stored.ml_policies_global, []);
});

// --- adversarial ---

test("an early run policy equal in source and effect to a stored one in the same run is not stored twice", async () => {
    const { P, stored, settle } = await boot(OLD());
    P.addRunPolicy("h", { ...NEW, source: '(c) => c.url === "https://a.example/old"' });
    await settle();
    assert.deepEqual(ids(P.runPolicies("h")), ["r-old"], "the stored one stays, as addRunPolicy's dedupe would have kept it");
    assert.deepEqual(ids(stored.ml_policies_run.h), ["r-old"]);
});

test("the same source with another effect, or in another run, is kept", async () => {
    const { P, settle } = await boot(OLD());
    const src = '(c) => c.url === "https://a.example/old"';
    const a = P.addRunPolicy("h", { ...NEW, source: src, effect: "deny" });
    const b = P.addRunPolicy("fresh", { ...NEW, source: src });
    await settle();
    assert.deepEqual(ids(P.runPolicies("h")), ["r-old", a.id]);
    assert.deepEqual(ids(P.runPolicies("fresh")), [b.id]);
});

test("a policy added and removed before the read leaves nothing, and a removal is not undone by the merge", async () => {
    const { P, stored, settle } = await boot(OLD());
    const made = P.addGlobalPolicy({ consumer: "fetch", effect: "allow", source: "(c) => true", label: "tmp" });
    assert.equal(P.removePolicy(made.id), true);
    await settle();
    assert.deepEqual(ids(P.globalPolicies()), ["g-old"]);
    assert.deepEqual(ids(stored.ml_policies_global), ["g-old"]);
});

test("two adds before the read both survive, in order, with distinct ids", async () => {
    const { P, stored, settle } = await boot(OLD());
    const a = P.addGlobalPolicy({ consumer: "fetch", effect: "ask", source: "(c) => false", label: "a" });
    const b = P.addGlobalPolicy({ consumer: "fetch", effect: "ask", source: "(c) => false", label: "b" });
    const c = P.addRunPolicy("h", NEW), d = P.addRunPolicy("h", { ...NEW, source: "(c) => false" });
    await settle();
    assert.deepEqual(ids(P.globalPolicies()), ["g-old", a.id, b.id]);
    assert.deepEqual(ids(P.runPolicies("h")), ["r-old", c.id, d.id]);
    assert.deepEqual(ids(stored.ml_policies_run.h), ["r-old", c.id, d.id]);
});

test("a read that fails: early adds are honoured in memory, nothing is written over storage, calls still judge", async () => {
    const { P, stored, writes, settle } = await boot(OLD(), { fail: true });
    const made = P.addRunPolicy("h", NEW);
    await settle();
    assert.equal(P.policiesLoaded(), true);
    assert.deepEqual(ids(P.runPolicies("h")), [made.id], "the early add is honoured");
    assert.equal(P.judgeCall("h", "fetch", facts(P, "https://a.example/new")).decision, "allow");
    assert.equal(P.judgeCall("h", "fetch", facts(P, "https://a.example/old")).decision, undefined, "nothing saved is honoured");
    P.addGlobalPolicy({ consumer: "fetch", effect: "ask", source: "(c) => false", label: "later" });
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(writes, [], "no save may replace a stored list with a partial one");
    assert.deepEqual(stored, OLD(), "storage holds exactly what it held");
});

test("a judgement before the read asks, and a deferred save does not make the store look loaded", async () => {
    const { P, settle } = await boot(OLD());
    P.addRunPolicy("h", NEW);
    assert.equal(P.policiesLoaded(), false);
    assert.equal(P.judgeCall("h", "fetch", facts(P, "https://a.example/new")).decision, "ask");
    await settle();
});

test("the change listeners hear an early add at once, so a card showing is judged again", async () => {
    const { P, settle } = await boot(OLD());
    let heard = 0;
    P.onPoliciesChanged(() => { heard++; });
    P.addRunPolicy("h", NEW);
    assert.ok(heard >= 1);
    await settle();
});

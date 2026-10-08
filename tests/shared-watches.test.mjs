// Watches SHARED with the model (src/sw/sw-shared-watches.ts, `evalShared` in src/state-watch.ts): what a worker-hosted
// run's `ml.current.debug.userWatches` holds. A channel from the person to the model, so the tests are about what it can
// NOT carry: the person's half of the state, a write, a value the size of the context, or a loop that does not end.
import { test, before } from "node:test";
import assert from "node:assert/strict";

let S, W, snapshotCurrent, store;
before(async () => {
    store = {};
    globalThis.chrome = {
        storage: { local: { get: async (k) => ({ [k]: store[k] }) }, session: { get: async () => ({}), set: async () => {} } },
        runtime: { onMessage: { addListener() {} } },
    };
    S = await import("../src/sw/sw-shared-watches.ts");
    W = await import("../src/state-watch.ts");
    ({ snapshotCurrent } = await import("../src/agent/current-context.ts"));
});
const snap = () => snapshotCurrent({ run: { id: "r", model: null, step: 3, maxSteps: 5, startedTs: 0 },
    messages: [{ role: "user", content: "count the widgets" }, { role: "assistant", content: "on it" }], recorded: [], now: 1 });

// --- what the model is given ---

test("each shared watch over ml.current, with its value now; JSONPath gives what it matched", async () => {
    store.ml_runstate_shared = ["ml.current.run.step", "ml.current.messages.map(m => m.role)", "$.ml.current.messages[*].content", "ml.current.nope"];
    const { debug } = await S.withUserWatches(snap());
    assert.deepEqual(debug.userWatches, [
        { expression: "ml.current.run.step", value: 3 },
        { expression: "ml.current.messages.map(m => m.role)", value: ["user", "assistant"] },
        { expression: "$.ml.current.messages[*].content", value: ["count the widgets", "on it"] },
        { expression: "ml.current.nope" },
    ]);
    assert.ok(debug.userWatches.every((w) => !("at" in w)), "no time: a watch is re-evaluated for every read, so it is always now");
});

test("nothing shared: `debug.userWatches` is there and empty, so a script never guards for it", async () => {
    for (const v of [undefined, [], "ml.current.run", [1, null, {}]]) {
        store.ml_runstate_shared = v;
        assert.deepEqual((await S.withUserWatches(snap())).debug, { userWatches: [] }, JSON.stringify(v));
    }
});

test("the snapshot the loop made is not changed: debug is added to a copy", async () => {
    store.ml_runstate_shared = ["ml.current.run.step"];
    const s = snap();
    const out = await S.withUserWatches(s);
    assert.equal(s.debug, undefined);
    assert.equal(out.messages, s.messages, "the rest is the same snapshot, not a second copy of the context");
});

// --- ADVERSARIAL: what a shared watch cannot carry ---

test("ADVERSARIAL: a watch over inspector. is refused by name, and one that reaches for it another way finds nothing there", async () => {
    assert.equal(W.shareable("inspector.grants.turn"), false);
    assert.equal(W.shareable("$.inspector..origin"), false);
    assert.equal(W.shareable(`ml.current.messages.filter(m => m.content.includes("inspector"))`), false, "the word anywhere: the safe way to be wrong");
    assert.equal(W.shareable("ml.current.run.step"), true);
    store.ml_runstate_shared = ["inspector.grants", "$..origins", "$..*", `globalThis["insp" + "ector"]`, "this.inspector"];
    const { debug } = await S.withUserWatches(snap());
    assert.match(debug.userWatches[0].error, /model does not have/);
    assert.deepEqual(debug.userWatches[1].value, [], "the tree a shared watch reads has no inspector half to match in");
    assert.deepEqual(Object.keys(debug.userWatches[2].value[0]), ["current"], "`$..*` starts at ml and finds nothing beside it");
    for (const w of debug.userWatches.slice(3)) assert.ok(w.error || w.value === undefined, `${w.expression}: ${JSON.stringify(w)}`);
});

test("ADVERSARIAL: a shared watch cannot write into the snapshot the model reads, nor into what the next watch sees", async () => {
    // An assignment lands in the script's own copy (the dialect copies `ml.current` per evaluation): it may even answer
    // with what it assigned, but neither the loop's snapshot nor the next watch sees it.
    store.ml_runstate_shared = ["ml.current.messages.push({ role: 'user', content: 'injected' })", "ml.current.run.step = 99",
        "delete ml.current.messages", "ml.current.run.step", "ml.current.messages.length"];
    const s = snap();
    const { debug } = await S.withUserWatches(s);
    assert.deepEqual(debug.userWatches.slice(3).map((w) => w.value), [3, 2]);
    assert.equal(s.messages.length, 2);
    assert.equal(s.run.step, 3);
    assert.equal(s.messages.some((m) => m.content === "injected"), false);
});

test("ADVERSARIAL: a value too large to hand over is said as an error, not truncated into something misleading", async () => {
    const big = snapshotCurrent({ run: { id: "r", model: null, step: 1, maxSteps: 5, startedTs: 0 },
        messages: [{ role: "user", content: "x".repeat(W.SHARED_VALUE_CHARS + 10) }], recorded: [], now: 1 });
    store.ml_runstate_shared = ["ml.current.messages[0].content", "ml.current.messages.length"];
    const { debug } = await S.withUserWatches(big);
    assert.match(debug.userWatches[0].error, new RegExp(`over the ${W.SHARED_VALUE_CHARS}`));
    assert.equal(debug.userWatches[0].value, undefined);
    assert.equal(debug.userWatches[1].value, 1);
});

test("ADVERSARIAL: at most MAX_SHARED_WATCHES are evaluated, whatever storage holds", async () => {
    store.ml_runstate_shared = Array.from({ length: 50 }, (_, i) => `ml.current.run.step + ${i}`);
    const { debug } = await S.withUserWatches(snap());
    assert.equal(debug.userWatches.length, W.MAX_SHARED_WATCHES);
});

// --- HALTING: a shared watch is evaluated for every survey that reads ml.current ---

test("HALTING: a shared watch that would run on is stopped by its step budget, and the others still answer", { timeout: 10_000 }, async () => {
    store.ml_runstate_shared = ["[...Array(1e9).keys()].length", "ml.current.messages.map(() => ml.current.messages.map(() => [...Array(1e6).keys()]))", "ml.current.run.step"];
    const t = Date.now();
    const { debug } = await S.withUserWatches(snap());
    assert.ok(Date.now() - t < 5000, `took ${Date.now() - t} ms`);
    assert.ok(debug.userWatches[0].error && debug.userWatches[1].error, JSON.stringify(debug.userWatches.slice(0, 2)));
    assert.equal(debug.userWatches[2].value, 3);
});

// --- the registry member: the panel shows it at the path the model reads ---

test("declared at ml.current.debug.userWatches, for the model, and holding nothing without a live turn", async () => {
    const { declaredState } = await import("../src/state-registry.ts");
    const d = declaredState().find((x) => x.id === "debug.userWatches");
    assert.equal(d.audience, "model");
    assert.equal(d.exposedAs, "ml.current.debug.userWatches");
    store.ml_runstate_shared = ["ml.current.run.step"];
    assert.equal(await d.read({ runId: "no-such-run" }), undefined);
});

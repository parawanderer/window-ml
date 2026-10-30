// readonly-embed.test.mjs — `ml.embed` as a read-only dialect member (src/readonly-exec/policy.ts `mlFacade`, the
// `embedding` receiver kind, evaluator.ts `preflight`): what it is for, and the ADVERSARIAL probes the dialect's rule
// asks for (docs/dev/readonly-exec.md, "The rule for extending the dialect"). The caps' wall time is measured in
// notebooks/readonly/embed-cost.ipynb.
import { test } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { evalReadonly, NotInDialect, Denied, NeedsPage } from "../src/readonly-exec.ts";
import { EMBED_SURVEY_CHARS, EMBED_SURVEY_CALLS, EMBED_CALL_INPUTS } from "../src/readonly-exec/limits.ts";
import { Embedding, isEmbedding } from "../src/ml/embedding.ts";
import { AnswerSet, makeAnswerFacade } from "../src/pointers/answer-set.ts";

const doc = () => new JSDOM("<!doctype html><body><p id='p'>hello</p></body>").window.document;

/** A vector for a text: how often each of four words appears, so similarity is predictable. A zero vector is nudged. */
const vec = (t) => { const v = ["cat", "dog", "tax", "law"].map((w) => t.split(w).length - 1); return v.some(Boolean) ? v : [0.01, 0, 0, 0]; };

/** An `ml` whose `embed` is scripted and counted. `models` hands back a host array, so a test can see what reached it. */
function host() {
    const calls = [];
    const ml = {
        embed: async (...args) => { calls.push(args); const xs = Array.isArray(args[0]) ? args[0] : [args[0]]; const out = xs.map((x) => Embedding.from(vec(x))); return Array.isArray(args[0]) ? out : out[0]; },
        models: async () => HOST_ARRAY,
        range: (n) => Array.from({ length: n }, (_, i) => i),
        info: async () => ({ dims: 4, values: [1, 0, 0, 0], dot() { FAKE_RAN++; return 1; } }),
    };
    return { ml, calls };
}
const HOST_ARRAY = ["a cat", "a dog"];
let FAKE_RAN = 0, GETTER_RAN = 0;
const run = (js, ml = host().ml, opts = {}) => evalReadonly(js, doc(), ml, undefined, opts);
const outOfDialect = (e) => e instanceof NotInDialect || e instanceof Denied;
const runtimeError = (re) => (e) => !outOfDialect(e) && re.test(e.message);

// --- what it is for: find where a text talks about something, with no prompt ---

test("a survey embeds pages, ranks them against a query and reads the scores, with no approval", async () => {
    const h = host();
    const r = await run(`
        const pages = ["the cat sat", "tax law", "dog and cat", "law of tax and tax"];
        const [q, ...vs] = await ml.embed(["tax", ...pages]);
        const ranked = q.rank(vs.map((embedding, key) => ({ key, embedding })));
        return { order: ranked.map(r => r.key), self: q.dot(q), dims: q.dims, first: vs[0].values[0] };`, h.ml);
    assert.deepEqual(r.value.order.slice(0, 2).sort(), [1, 3]);
    assert.equal(r.value.self, 1);
    assert.equal(r.value.dims, 4);
    assert.equal(typeof r.value.first, "number");
    assert.equal(h.calls.length, 1, "one batched call");
});

test("one string gives one embedding; a String object is a string", async () => {
    const h = host();
    assert.equal((await run(`(await ml.embed("cat")).dims`, h.ml)).value, 4);
    assert.equal((await run(`(await ml.embed(new String("dog"))).dims`, h.ml)).value, 4);
    assert.deepEqual(h.calls.map((c) => c[0]), ["cat", "dog"], "a String object reaches the host as a primitive");
});

test("a String object is told by brand: a page's tag getter and valueOf never run, a re-tagged real String still embeds", async () => {
    let ran = 0;
    const h = host();
    const real = Object.defineProperty(new String("dog"), Symbol.toStringTag, { get() { ran++; return "Whatever"; } });
    const fake = { get [Symbol.toStringTag]() { ran++; return "String"; }, valueOf() { ran++; return "cat"; } };
    h.ml.models = async () => [real, fake];
    await assert.rejects(run(`const [a, b] = await ml.models(); return await ml.embed(b)`, h.ml), (e) => e instanceof TypeError);
    assert.equal(ran, 0, "page code ran while ml.embed read its input");
    assert.equal((await run(`const [a] = await ml.models(); return (await ml.embed(a)).dims`, h.ml)).value, 4);
    assert.equal(ran, 0, "a real String's tag getter ran");
    assert.deepEqual(h.calls.map((c) => c[0]), ["dog"]);
});

test("an embedding is told apart by brand: Embedding.from grants it, a lookalike does not", () => {
    assert.ok(isEmbedding(Embedding.from([1, 0])));
    assert.ok(!isEmbedding({ dims: 2, values: [1, 0], dot() { return 1; } }));
    assert.ok(Object.isFrozen(Embedding.from([3, 4]).values), "the unit vector cannot be changed by whoever holds it");
});

// --- ADVERSARIAL: only the configured model, and inputs read as data ---

test("ADVERSARIAL: any second argument goes to the person, and the host is handed one argument", async () => {
    for (const src of [`ml.embed("x", { model: "other" })`, `ml.embed("x", {})`, `ml.embed("x", null)`, `ml.embed(["x"], "m")`]) {
        const h = host();
        await assert.rejects(run(src, h.ml), Denied, src);
        assert.equal(h.calls.length, 0, `${src}: the host was called`);
    }
    const h = host();
    await run(`ml.embed(["a", "b"])`, h.ml);
    assert.equal(h.calls[0].length, 1, "no options forwarded");
});

test("ADVERSARIAL: a getter on an input array's index never runs, and a non-string is a catchable error", async () => {
    const h = host();
    const getterArray = () => { const a = ["x"]; Object.defineProperty(a, 0, { enumerable: true, get() { GETTER_RAN++; return "x"; } }); return a; };
    h.ml.models = async () => getterArray();
    GETTER_RAN = 0;
    await assert.rejects(run(`ml.embed(await ml.models())`, h.ml), runtimeError(/item 0 is not a string/));
    assert.equal(GETTER_RAN, 0);
    for (const src of [`ml.embed(5)`, `ml.embed([1])`, `ml.embed({ toString: () => "x" })`, `ml.embed()`]) {
        await assert.rejects(run(src, host().ml), (e) => !outOfDialect(e), src);
    }
    assert.equal((await run(`try { await ml.embed(5) } catch (e) { return "caught" }`)).value, "caught");
});

test("ADVERSARIAL: the host gets a fresh array of copies, never the array the survey handed it", async () => {
    const h = host();
    await run(`ml.embed(await ml.models())`, h.ml);
    assert.notEqual(h.calls[0][0], HOST_ARRAY);
    assert.deepEqual(h.calls[0][0], HOST_ARRAY);
});

// --- ADVERSARIAL: the caps on the server's work, checked before the call ---

test("ADVERSARIAL: past the call cap, the character cap or the strings a call carries, the survey goes to the person before the host is asked", async () => {
    let h = host();
    await assert.rejects(run(`for (const i of ml.range(${EMBED_SURVEY_CALLS + 1})) await ml.embed("cat")`, h.ml), NotInDialect);
    assert.equal(h.calls.length, EMBED_SURVEY_CALLS);

    h = host();
    await assert.rejects(run(`ml.embed("a".repeat(${EMBED_SURVEY_CHARS + 1}))`, h.ml), NotInDialect);
    assert.equal(h.calls.length, 0);

    h = host();
    await assert.rejects(run(`const s = "a".repeat(${EMBED_SURVEY_CHARS / 2}); await ml.embed(s); await ml.embed(s); await ml.embed("a")`, h.ml), NotInDialect, "the cap is across the survey's calls");
    assert.equal(h.calls.length, 2);

    h = host();
    await assert.rejects(run(`ml.embed(Array.from({ length: ${EMBED_CALL_INPUTS + 1} }, () => "a"))`, h.ml), NotInDialect);
    assert.equal(h.calls.length, 0);
});

test("the caps are per survey: each survey gets its own", async () => {
    const h = host();
    for (let i = 0; i < 2; i++) await run(`for (const i of ml.range(${EMBED_SURVEY_CALLS})) await ml.embed("cat")`, h.ml);
    assert.equal(h.calls.length, 2 * EMBED_SURVEY_CALLS);
});

test("ADVERSARIAL: the inputs are charged to the step budget before the call", async () => {
    const h = host();
    await assert.rejects(run(`ml.embed("a".repeat(400000))`, h.ml, { stepBudget: 1000 }), NotInDialect);
    assert.equal(h.calls.length, 0);
});

// --- ADVERSARIAL: the embedding kind ---

test("ADVERSARIAL: a page object shaped like an embedding gets no methods, and its own `dot` never runs", async () => {
    FAKE_RAN = 0;
    await assert.rejects(run(`(await ml.info()).dot(await ml.embed("cat"))`), NotInDialect);
    assert.equal(FAKE_RAN, 0);
});

test("ADVERSARIAL: dot and rank take only real embeddings, read as data; a getter on a candidate never runs", async () => {
    const getterCandidate = `({ key: 1, get embedding() { return e } })`;
    for (const [src, why] of [
        [`e.dot({ dims: 4, values: [1, 0, 0, 0] })`, "a lookalike to dot"],
        [`e.dot(await ml.info())`, "a page lookalike to dot"],
        [`e.rank([{ key: 1, embedding: { dims: 4, values: [1, 0, 0, 0] } }])`, "a lookalike candidate"],
        [`e.rank("x")`, "not an array"],
        [`e.rank([e])`, "an embedding where a candidate goes"],
        [`e.rank([[1, e]])`, "an array where a candidate goes"],
    ]) {
        await assert.rejects(run(`const e = await ml.embed("cat"); return ${src}`), (x) => !outOfDialect(x) && /embedding/.test(x.message), why);
    }
    // A getter cannot be written in the dialect at all; one on a host object is refused before the host reads it.
    await assert.rejects(run(`const e = await ml.embed("cat"); return e.rank([${getterCandidate}])`), outOfDialect);
    const h = host();
    h.ml.models = async () => [{ key: 1, get embedding() { GETTER_RAN++; return Embedding.from([1, 0, 0, 0]); } }];
    GETTER_RAN = 0;
    await assert.rejects(run(`const e = await ml.embed("cat"); return e.rank(await ml.models())`, h.ml), runtimeError(/embedding/));
    assert.equal(GETTER_RAN, 0);
});

test("ADVERSARIAL: dot and rank are charged their dimensions before they run", async () => {
    const h = host();
    h.ml.embed = async (xs) => (Array.isArray(xs) ? xs : [xs]).map(() => Embedding.from(Array.from({ length: 4096 }, (_, i) => (i === 0 ? 1 : 0))));
    const many = `const [q] = await ml.embed(["q"]); const c = ml.range(600).map(k => ({ key: k, embedding: q }));`;
    assert.equal((await run(`${many} return q.rank(c).length`, h.ml)).value, 600);
    await assert.rejects(run(`${many} return q.rank(c).length`, h.ml, { stepBudget: 9000 }), NotInDialect, "600 x 4096 at 256 a step is 9,600");
});

test("ADVERSARIAL: the vector cannot be changed, and no route reaches its class or the realm", async () => {
    for (const src of [
        `e.values.push(1)`, `e.values[0] = 5`, `e.values.sort()`, `e.dims = 3`,
        `e.constructor`, `e.__proto__`, `e.constructor.constructor("return 1")()`, `ml.embed.constructor`,
        `const { dot } = e; return dot(e)`, `const f = e.dot; return f(e)`, `e.dot.call(e, e)`, `e.from([1])`, `e.rank.apply(e, [[]])`,
    ]) {
        await assert.rejects(run(`const e = await ml.embed("cat"); ${src.startsWith("const") ? src : `return ${src}`}`), (x) => outOfDialect(x) || x instanceof TypeError, src);
    }
    const e = (await run(`return await ml.embed("cat")`)).value;
    assert.ok(Object.isFrozen(e.values));
});

test("ADVERSARIAL: a loop over embeddings has a fixed trip count: the values cannot grow while iterated", async () => {
    await assert.rejects(run(`const e = await ml.embed("cat"); for (const x of e.values) e.values.push(x)`), outOfDialect);
    assert.equal((await run(`const e = await ml.embed("cat dog"); let n = 0; for (const x of e.values) n = n + x * x; return Math.round(n * 1000000)`)).value, 1000000);
});

// --- failure and realms ---

test("a survey that embeds and then falls out of dialect leaves the answer set as it was", async () => {
    const set = new AnswerSet();
    set.add({ kind: "text", text: "kept" });
    const facade = makeAnswerFacade(set);
    await assert.rejects(evalReadonly(`ml.answer.clear(); await ml.embed("cat"); document.body.remove()`, doc(), host().ml, facade, { checkpoint: () => set.checkpoint() }), outOfDialect);
    assert.equal(set.length, 1);
});

test("in the worker ml.embed is absent whatever the host has, so the survey defers to the page", async () => {
    const h = host();
    await assert.rejects(run(`ml.embed("cat")`, h.ml, { realm: "worker" }), NeedsPage);
    assert.equal(h.calls.length, 0);
});

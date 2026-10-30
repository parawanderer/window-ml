// redteam-embed.test.mjs — the red team's pass on `ml.embed` (PR #1336), the first read-only dialect member that makes
// a LIVE call: what a hostile page must NOT get from it (src/readonly-exec/policy.ts `mlFacade`, src/ml/embedding.ts,
// src/readonly-exec/policy-realm.ts; docs/dev/readonly-exec.md, "ml.embed: the one live call").
//
// What must not be reachable, each a row: a second model; page code run by a read that is documented as a DATA read
// (a getter on an index, a pretense of being a String wrapper); a value that is not the page's own data (an inherited
// index, a hole); and `ml.embed` from a realm that has no page (a policy's predicate). The model-facing caps
// (EMBED_SURVEY_CHARS, EMBED_SURVEY_CALLS, EMBED_CALL_INPUTS) are the feature's own adversarial rows in
// tests/readonly-embed.test.mjs; this file is about what the member must never be talked into.
//
// The landing form for a hole still open on #1336: a `{ todo }` row asserting the DEFENDED outcome, beside a plain row
// pinning today's refusal, so the fixture cannot pass by refusing nothing.
import { test } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { evalReadonly, NotInDialect, Denied } from "../src/readonly-exec.ts";
import { Embedding } from "../src/ml/embedding.ts";

/** `textOf`'s brand read (`Object.prototype.toString`) runs a page getter, so a page can make the survey execute code
 *  during an argument read the dialect documents as data. Open on #1336: the row is a todo asserting the defended
 *  outcome, and flips when the fix lands. */
const TODO = { todo: "open on #1336: Object.prototype.toString runs the page's Symbol.toStringTag getter" };

const doc = () => new JSDOM("<!doctype html><body><p>hi</p></body>").window.document;
const vect = (t) => { const s = String(t); const v = ["cat", "dog"].map((w) => s.split(w).length - 1); return v.some(Boolean) ? [v[0], v[1], 1] : [0.01, 0, 3]; };

/** An `ml` whose `embed` is counted; `models` carries whatever a row smuggles, since it is the one allowed member that
 *  hands a host object to the survey. */
function host() {
    const calls = [];
    return {
        calls,
        ml: {
            embed: async (x) => { calls.push(x); const xs = Array.isArray(x) ? x : [x]; const out = xs.map((s) => Embedding.from(vect(s))); return Array.isArray(x) ? out : out[0]; },
            models: async () => ["cat"],
        },
    };
}
const run = (js, h) => evalReadonly(js, doc(), h.ml, undefined, {});
const refused = (e) => e instanceof NotInDialect || e instanceof Denied || e instanceof TypeError;

// --- a data read runs no page code ---

test("RED TEAM: an input that PRETENDS to be a String wrapper is refused and is not unwrapped", async () => {
    // Today's refusal, which must survive any fix: the shape reaches the facade as a plain object and is a TypeError
    // naming its position, with no call to the host and nothing of it handed over.
    let unwrapped = 0;
    const h = host();
    h.ml.models = async () => ({ [Symbol.toStringTag]: "String", valueOf() { unwrapped++; return "cat"; } });
    await assert.rejects(run(`return await ml.embed(await ml.models())`, h), (e) => e instanceof TypeError, "a String-shaped object was not refused");
    assert.equal(unwrapped, 0, "the object's valueOf ran: the facade took a string from page code");
    assert.equal(h.calls.length, 0, "a refused input still reached the embedding host");
});

test("RED TEAM: a String-shaped object's Symbol.toStringTag getter never runs (the read is data)", TODO, async () => {
    let tag = 0;
    const h = host();
    h.ml.models = async () => ({ get [Symbol.toStringTag]() { tag++; return "String"; }, valueOf() { return "cat"; } });
    await run(`return await ml.embed(await ml.models())`, h).catch(() => {});
    assert.equal(tag, 0, "Object.prototype.toString ran the page's Symbol.toStringTag getter from an argument read");
});

test("RED TEAM: a Proxy over the input array cannot lie about its length or smuggle a non-string, and no trap reaches a value the page did not put there", async () => {
    // A Proxy is not distinguishable from its target by design, so its traps DO run (measured on #1336: 7 of them for
    // a two-string array). What is pinned here is the bound: the engine's own invariants refuse a lying `length`, and
    // every value sent is one the page put in the target — the trap runs page code, never the facade's.
    const h = host();
    h.ml.models = async () => new Proxy(["cat"], {
        getOwnPropertyDescriptor(t, k) {
            if (k === "length") return { value: 2, enumerable: false, configurable: true, writable: true };
            if (k === 1) return { value: "dog", enumerable: true, configurable: true, writable: true };
            return Reflect.getOwnPropertyDescriptor(t, k);
        },
    });
    await assert.rejects(run(`return await ml.embed(await ml.models())`, h), (e) => e instanceof TypeError, "a Proxy lied its way past the length check");
    assert.equal(h.calls.length, 0, "a refused Proxy array still reached the host");

    let traps = 0;
    const lucky = host();
    lucky.ml.models = async () => new Proxy(["cat", "dog"], {
        getOwnPropertyDescriptor(t, k) { traps++; return Reflect.getOwnPropertyDescriptor(t, k); },
    });
    const r = await run(`const out = await ml.embed(await ml.models()); return out.map(e => e.dims)`, lucky);
    assert.deepEqual([...r.value], [3, 3], "an honest Proxy array embeds as the same two strings");
    assert.deepEqual(lucky.calls[0], ["cat", "dog"], "and the host got the page's own strings");
    assert.ok(traps > 0, "the read walks own descriptors, so a Proxy's trap is the price of that read");
});

// --- only the page's own data ---

test("RED TEAM: an index the array does not own is not read: an inherited string is a TypeError, not an input", async () => {
    const h = host();
    h.ml.models = async () => {
        const a = [];
        a.length = 1;
        Object.setPrototypeOf(a, Object.assign(Object.create(Array.prototype), { 0: "cat" }));
        return a;
    };
    await assert.rejects(run(`return await ml.embed(await ml.models())`, h), (e) => e instanceof TypeError && /item 0 is not a string/.test(e.message), "an inherited index was accepted as an input");
    assert.equal(h.calls.length, 0);
});

test("RED TEAM: a hole in the array is a TypeError naming its index, and nothing is embedded", async () => {
    const h = host();
    h.ml.models = async () => ["cat", , "dog"];   // eslint-disable-line no-sparse-arrays
    await assert.rejects(run(`return await ml.embed(await ml.models())`, h), (e) => e instanceof TypeError && /item 1 is not a string/.test(e.message), "a hole was skipped or filled");
    assert.equal(h.calls.length, 0);
});

// --- no other realm has it ---

test("RED TEAM: a policy's predicate has no ml.embed: a rule cannot make a live call while it judges", async () => {
    const { evalPolicy } = await import("../src/readonly-exec/policy-realm.ts");
    const r = evalPolicy(`(c) => ml.embed("cat") === undefined`, { url: "https://x.example/", host: "x.example", credentials: false, rendered: false, interactive: false });
    assert.equal(r.broken !== undefined, true, `a policy reached ml: ${JSON.stringify(r).slice(0, 120)}`);
    assert.notEqual(r.decision, "allow", "a policy that cannot be judged must not decide");
});

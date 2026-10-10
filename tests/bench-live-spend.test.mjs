// A sweep's spend as its runs' events arrive (tests/e2e/bench/live-spend.mjs): which events carry a call, each counted
// once, priced against the snapshot it names as cost.mjs prices it on read, a body fetched by hash and checked before it
// is used or kept, pending while it comes, and the summary the page and the terminal show.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { eventCalls, liveSpend, spendLine } from "../tests/e2e/bench/live-spend.mjs";
import { callCost, priceBook } from "../src/spend/price-book.ts";

const SNAP = JSON.parse(readFileSync(new URL("./fixtures/bench/price-snapshot.json", import.meta.url)));
const BODIES = Object.fromEntries(Object.entries(SNAP).map(([k, v]) => [k, Buffer.from(JSON.stringify(v))]));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const HASHES = Object.fromEntries(Object.entries(BODIES).map(([k, b]) => [k, sha(b)]));
const BY_HASH = new Map(Object.entries(BODIES).map(([, b]) => [sha(b), b]));
const PRICES = { fetchedAt: "2026-10-10T09:00:00Z", sources: HASHES };
const turn = (step, usage, extra = {}) => ({ kind: "agent-step", step, seq: step * 2, thought: "t", usage: { prices: PRICES, ...usage }, ...extra });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
const tick = () => new Promise((r) => setImmediate(r));

// --- which events carry a call ---

test("a turn's usage is one call for the driver; a tool's delegated calls each name their own model; a pending step carries none", () => {
    assert.deepEqual(eventCalls(turn(1, { promptTokens: 10, completionTokens: 2 }), "deepseek.deepseek-flash").map((c) => c.model), ["deepseek.deepseek-flash"]);
    const tool = { kind: "agent-step", step: 2, seq: 5, tool: "look", subUsage: { prompt: 9, completion: 1, calls: 2, calls_: [{ model: "gemma4:31b", ts: 1, ms: 5, prompt: 5, completion: 1 }, { model: "gemma4:31b", ts: 2, ms: 5, prompt: 4, completion: 0, prices: PRICES }] } };
    const calls = eventCalls(tool, "x");
    assert.deepEqual(calls.map((c) => [c.model, c.usage.promptTokens, !!c.usage.prices]), [["gemma4:31b", 5, false], ["gemma4:31b", 4, true]]);
    assert.deepEqual(eventCalls({ kind: "agent-step", step: 3, pending: true, tool: "click", usage: { promptTokens: 1 } }, "x"), []);
    assert.deepEqual(eventCalls({ kind: "agent-result", usage: { promptTokens: 1 } }, "x"), []);
});

test("the same event seen twice counts once, and the same step in another run counts again", () => {
    const s = liveSpend({ bodyOf: (h) => BY_HASH.get(h) ?? null });
    const ev = turn(1, { promptTokens: 1000, completionTokens: 100 });
    assert.equal(s.add(0, ev, "deepseek.deepseek-flash"), true);
    assert.equal(s.add(0, ev, "deepseek.deepseek-flash"), false);
    assert.equal(s.add(1, ev, "deepseek.deepseek-flash"), true);
    assert.equal(s.summary().total.calls, 2);
});

// --- pricing ---

test("a call is priced as scores.md prices it on read, per driver model and per run, local and unpriced apart", () => {
    const s = liveSpend({ bodyOf: (h) => BY_HASH.get(h) ?? null });
    const u = { promptTokens: 12000, completionTokens: 300, cachedTokens: 8000, raw: { cost: 0.0009 } };
    s.add(0, turn(1, u), "deepseek.deepseek-flash");
    s.add(1, turn(1, { promptTokens: 500, completionTokens: 50 }), "glm-4.7-flash:latest");
    s.add(1, turn(2, { promptTokens: 500, completionTokens: 50 }), "glm-4.7-flash:latest");
    s.add(2, turn(1, { promptTokens: 10, completionTokens: 1 }), "moonshot.kimi-k2.7-code-highspeed");
    const sum = s.summary((i) => ["deepseek.deepseek-flash", "glm-4.7-flash:latest", "moonshot.kimi-k2.7-code-highspeed"][i]);
    const want = callCost({ ...u, prices: PRICES }, "deepseek.deepseek-flash", priceBook(BODIES)).computed;
    assert.ok(want > 0);
    near(sum.total.computed, want);
    assert.deepEqual([sum.total.calls, sum.total.computedCalls, sum.total.reportedCalls, sum.total.local, sum.total.unpriced, sum.total.pending], [4, 1, 1, 2, 1, 0]);
    near(sum.models["deepseek.deepseek-flash"].reported, 0.0009);
    assert.equal(sum.models["glm-4.7-flash:latest"].local, 2);
    assert.equal(sum.runs[2].unpriced, 1);
    assert.equal(sum.currency, "USD");
});

test("no calls, no summary; a call that names no snapshot is unpriced, not 0", () => {
    const s = liveSpend();
    assert.equal(s.summary(), null);
    s.add(0, { kind: "agent-step", step: 1, thought: "t", usage: { promptTokens: 10, completionTokens: 1 } }, "deepseek.deepseek-flash");
    const t = s.summary().total;
    assert.deepEqual([t.calls, t.computedCalls, t.unpriced], [1, 0, 1]);
});

// --- snapshot bodies from the price service ---

test("a body the log lacks is fetched once by its hash, kept, and re-prices its calls; pending until then", async () => {
    const fetched = [], kept = [];
    let changes = 0;
    const s = liveSpend({ fetchBody: async (h) => { fetched.push(h); return BY_HASH.get(h); }, keep: (snap) => kept.push(snap), changed: () => changes++ });
    s.add(0, turn(1, { promptTokens: 1000, completionTokens: 10 }), "deepseek.deepseek-flash");
    s.add(0, turn(2, { promptTokens: 1000, completionTokens: 10 }), "deepseek.deepseek-flash");
    assert.deepEqual([s.summary().total.pending, s.summary().total.computedCalls], [2, 0]);
    await tick(); await tick();
    assert.equal(fetched.length, Object.keys(HASHES).length, "each hash fetched once, however many calls name it");
    assert.deepEqual(kept.map((k) => k.kind).sort(), Object.keys(HASHES).sort(), "kept under the source's name");
    assert.ok(changes >= 1);
    const t = s.summary().total;
    assert.deepEqual([t.pending, t.computedCalls], [0, 2]);
});

test("a fetched body that does not match its hash is neither used nor kept; the call is priced without that source", async () => {
    const kept = [];
    const s = liveSpend({ fetchBody: async (h) => (h === HASHES.owui_models ? Buffer.from("tampered") : BY_HASH.get(h)), keep: (snap) => kept.push(snap.kind) });
    s.add(0, turn(1, { promptTokens: 1000, completionTokens: 10 }), "deepseek.deepseek-flash");
    s.summary();
    await tick(); await tick();
    assert.equal(kept.includes("owui_models"), false);
    const t = s.summary().total;
    // Without the model list nothing joins: unpriced, with the snapshot's other sources in hand.
    assert.deepEqual([t.pending, t.computedCalls, t.unpriced], [0, 0, 1]);
});

test("a service that fails leaves the call priced by what is in hand, never pending forever", async () => {
    const s = liveSpend({ fetchBody: async () => { throw new Error("down"); } });
    s.add(0, turn(1, { promptTokens: 1000, completionTokens: 10, raw: { cost: 0.002 } }), "deepseek.deepseek-flash");
    assert.equal(s.summary().total.pending, 1);
    await tick(); await tick();
    const t = s.summary().total;
    assert.deepEqual([t.pending, t.reportedCalls, t.computedCalls], [0, 1, 0]);
});

// --- the terminal's line ---

test("the terminal line says computed and reported apart, and names what neither priced", () => {
    const line = spendLine({ currency: "USD", total: { calls: 5, computed: 0.0123, computedCalls: 2, reported: 0.011, reportedCalls: 2, local: 2, unpriced: 1, pending: 0 } });
    assert.equal(line, "5 model calls; computed 0.0123 USD over 2 calls; reported by the provider 0.0110 USD over 2 calls; 2 local (electricity, not priced here); 1 unpriced");
});

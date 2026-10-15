// nested-asks.test.mjs — a call made from inside a running step that needs the person (src/sw/sw-asks.ts): raised as an
// ask on the step, kept in the one pending-approvals store under `${runId}:${seq}#${askId}`, and ended by the person, the
// clock, a cancel, the turn's end or the run having nobody to ask. The surfaces' half is tests/sidebar-asks.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { hostAsks, raiseAsk, canAsk, stepAsks, MAX_ASKS_PER_STEP } from "../src/sw/sw-asks.ts";
import { ASK_ID, approvalKey, approvalPayload } from "../src/approval-key.ts";
import { pendingApprovals, resolveApproval } from "../src/sw/sw-consent.ts";

const FACTS = { argv: ["git", "--no-pager", "status"], cwd: { path: "/w", inRoot: true }, effects: "unknown", sandboxed: true, placement: "host-sandbox" };
let n = 0;
/** A run hosting asks, recording what it emitted. */
function run(over = {}) {
    const ctl = new AbortController();
    const emitted = [];
    const r = { runId: `run${++n}`, unattended: false, routing: "ui", signal: ctl.signal, emit: (seq, asks) => emitted.push({ seq, asks }), stepOf: () => 4, ...over };
    const unhost = hostAsks(r);
    return { r, ctl, emitted, unhost };
}
const keysOf = (runId) => [...pendingApprovals.keys()].filter((k) => k.startsWith(`${runId}:`));
const tick = () => new Promise((res) => setTimeout(res, 0));

// --- raising one, and its answers ---

test("an ask waits in the one store under the step's key plus its id, shows on the step, and the person's allow ends it", async () => {
    const { r, emitted, unhost } = run();
    const p = raiseAsk(r.runId, 7, { kind: "sh", facts: FACTS, consumer: "sh", placement: "host-sandbox" });
    const [key] = keysOf(r.runId);
    const id = key.split("#")[1];
    assert.match(key, new RegExp(`^${r.runId}:7#a[0-9a-f]{24}$`));
    assert.ok(ASK_ID.test(id));
    const d = pendingApprovals.get(key).descriptor;
    assert.deepEqual([d.askId, d.consumer, d.placement, d.seq, d.step, d.tool], [id, "sh", "host-sandbox", 7, 4, "sh"]);
    assert.deepEqual(d.facts, FACTS, "the descriptor carries the policy's c, which a store re-judges by");
    assert.deepEqual(emitted.map((e) => [e.seq, e.asks.map((a) => a.state)]), [[7, ["pending"]]], "the step is re-emitted with the ask");
    assert.equal(resolveApproval(key, { approved: true, source: "user" }), true);
    const o = await p;
    assert.deepEqual([o.allowed, o.state], [true, "allowed"]);
    assert.ok(o.answeredAt >= o.raisedAt && o.waitedMs === o.answeredAt - o.raisedAt, "the wait is measured, for the call's result to say");
    assert.deepEqual(emitted.at(-1).asks.map((a) => a.state), ["allowed"]);
    assert.equal(keysOf(r.runId).length, 0, "an answered ask leaves the store");
    unhost();
});

test("a denial carries the person's note; the facts on the step are a copy, not the consumer's object", async () => {
    const { r, emitted, unhost } = run();
    const facts = { argv: ["rm", "x"] };
    const p = raiseAsk(r.runId, 1, { kind: "sh", facts });
    facts.argv.push("y");
    resolveApproval(keysOf(r.runId)[0], { approved: false, feedback: "not that file", source: "user" });
    const o = await p;
    assert.deepEqual([o.allowed, o.state, o.note], [false, "denied", "not that file"]);
    assert.deepEqual(emitted.at(-1).asks[0].facts.argv, ["rm", "x"]);
    assert.equal(emitted.at(-1).asks[0].note, "not that file");
    unhost();
});

test("asks accumulate on their step, history included, and each step keeps its own", async () => {
    const { r, emitted, unhost } = run();
    const a = raiseAsk(r.runId, 3, { kind: "sh", facts: { argv: ["a"] } });
    resolveApproval(keysOf(r.runId)[0], { approved: true });
    await a;
    const b = raiseAsk(r.runId, 3, { kind: "sh", facts: { argv: ["b"] } });
    const c = raiseAsk(r.runId, 5, { kind: "sh", facts: { argv: ["c"] } });
    assert.deepEqual(stepAsks(r.runId, 3).map((x) => [x.facts.argv[0], x.state]), [["a", "allowed"], ["b", "pending"]]);
    assert.deepEqual(stepAsks(r.runId, 5).map((x) => x.facts.argv[0]), ["c"]);
    assert.deepEqual(emitted.at(-1), { seq: 5, asks: stepAsks(r.runId, 5) });
    for (const k of keysOf(r.runId)) resolveApproval(k, { approved: false });
    await Promise.all([b, c]);
    unhost();
});

// --- every way it ends without the person ---

test("a run with nobody to ask refuses at once: no card, nothing in the store", async () => {
    const { r, emitted, unhost } = run({ unattended: true });
    const o = await raiseAsk(r.runId, 1, { kind: "sh", facts: FACTS });
    assert.deepEqual([o.allowed, o.state, o.waitedMs], [false, "unattended", 0]);
    assert.equal(keysOf(r.runId).length, 0);
    assert.deepEqual(emitted.at(-1).asks.map((a) => a.state), ["unattended"], "the step still records what was asked");
    unhost();
});

test("an ask nobody answers is denied when the wall clock runs out", async () => {
    const { r, unhost } = run({ waitMs: 5 });
    const o = await raiseAsk(r.runId, 1, { kind: "sh", facts: FACTS });
    assert.deepEqual([o.allowed, o.state], [false, "timeout"]);
    assert.equal(keysOf(r.runId).length, 0);
    unhost();
});

test("cancelling the run denies its pending asks with that reason, whether by its signal or by the store's cancel", async () => {
    const one = run();
    const p = raiseAsk(one.r.runId, 1, { kind: "sh", facts: FACTS });
    one.ctl.abort();
    assert.deepEqual([(await p).state, (await p).allowed], ["cancelled", false]);
    assert.equal(keysOf(one.r.runId).length, 0);
    one.unhost();
    // background.ts's cancelBackgroundRun resolves every key under the run's prefix with { cancelled: true }.
    const two = run();
    const q = raiseAsk(two.r.runId, 1, { kind: "sh", facts: FACTS });
    for (const [key, e] of [...pendingApprovals]) if (key.startsWith(`${two.r.runId}:`)) { pendingApprovals.delete(key); e.resolve({ approved: false, cancelled: true }); }
    assert.equal((await q).state, "cancelled");
    two.unhost();
});

test("the turn ending ends its pending asks, and no ask can be raised after it, or for a run this worker is not hosting", async () => {
    const { r, unhost } = run();
    const p = raiseAsk(r.runId, 1, { kind: "sh", facts: FACTS });
    assert.equal(canAsk(r.runId), true);
    unhost();
    const o = await p;
    assert.deepEqual([o.allowed, o.state], [false, "ended"]);
    assert.equal(canAsk(r.runId), false);
    assert.equal((await raiseAsk(r.runId, 1, { kind: "sh", facts: FACTS })).state, "ended", "after the turn");
    assert.equal((await raiseAsk("never-hosted", 1, { kind: "sh", facts: FACTS })).state, "ended", "an unknown run (an evicted worker) fails closed");
    assert.equal(keysOf(r.runId).length, 0);
});

test("a step that has asked MAX_ASKS_PER_STEP times is refused without a card", async () => {
    const { r, unhost } = run();
    const all = Array.from({ length: MAX_ASKS_PER_STEP }, () => raiseAsk(r.runId, 1, { kind: "sh", facts: FACTS }));
    const over = await raiseAsk(r.runId, 1, { kind: "sh", facts: FACTS });
    assert.deepEqual([over.allowed, over.state], [false, "limit"]);
    assert.equal(keysOf(r.runId).length, MAX_ASKS_PER_STEP, "no card was raised past the cap");
    assert.equal(stepAsks(r.runId, 1).length, MAX_ASKS_PER_STEP, "and the step's record did not grow");
    unhost();
    await Promise.all(all);
});

// --- red team: what an answer may name ---

test("an answer reaches only the ask it names exactly: a guessed id, another run's key or a malformed id resolves nothing", async () => {
    const a = run(), b = run();
    const p = raiseAsk(a.r.runId, 2, { kind: "sh", facts: FACTS });
    const [key] = keysOf(a.r.runId);
    const id = key.split("#")[1];
    const guessed = `a${"f".repeat(24)}`;
    assert.equal(resolveApproval(approvalKey(a.r.runId, 2, guessed), { approved: true }), false, "a well-formed guess names no gate");
    assert.equal(resolveApproval(approvalKey(b.r.runId, 2, id), { approved: true }), false, "run A's ask id under run B's key is refused");
    assert.equal(resolveApproval(approvalKey(a.r.runId, 3, id), { approved: true }), false, "and under another step of the same run");
    for (const bad of ["x", `${id}#`, id.toUpperCase(), 7, {}]) assert.equal(approvalKey(a.r.runId, 2, bad), null, `malformed ${JSON.stringify(bad)} names no key`);
    await tick();
    assert.equal(keysOf(a.r.runId).length, 1, "the ask is still waiting");
    assert.equal(approvalKey(a.r.runId, 2), `${a.r.runId}:2`, "positive control: no ask id is the step's own gate");
    assert.equal(resolveApproval(approvalKey(a.r.runId, 2, id), { approved: true }), true, "positive control: the exact key resolves it");
    assert.equal((await p).state, "allowed");
    a.unhost(); b.unhost();
});

test("the step's own gate is never answered by a message that names a malformed ask", () => {
    const key = "runX:4";
    let decided = null;
    pendingApprovals.set(key, { resolve: (d) => { decided = d; }, descriptor: { key, runId: "runX", seq: 4, step: 4, tool: "exec", arguments: {}, ts: 0, routing: "ui" } });
    const k = approvalKey("runX", 4, "not-an-id");
    assert.equal(k, null);
    assert.equal(decided, null);
    assert.equal(resolveApproval(approvalKey("runX", 4), { approved: false }), true, "positive control");
});

test("the sidebar hosts' payload carries the denial's note and the ask, and nothing else the app's message had", () => {
    assert.deepEqual(approvalPayload({ hash: "h", seq: 2, decision: 1, persist: 0, feedback: "why", ask: "a1", evil: true, runId: "other" }),
        { runId: "h", seq: 2, decision: true, persist: false, feedback: "why", ask: "a1" });
    assert.deepEqual(approvalPayload({ hash: "h", seq: 2, feedback: 5, ask: 9 }), { runId: "h", seq: 2, decision: false, persist: false });
    assert.equal(approvalPayload({ hash: "h", seq: 2, feedback: "x".repeat(5000) }).feedback.length, 2000);
});

// --- in the worker: a run's exec step raises an ask; the surfaces' SET_APPROVAL and Stop answer it ---

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");
const SITE = { id: 7, windowId: 1, active: true, url: "https://site.example/", title: "Site" };
const T = { timeout: 30000 };

/**
 * A worker-built run whose model calls one page tool (a click), approved, which stays RUNNING until `release()`: the step
 * an ask is raised from (a click rather than an exec, which a default build routes to an isolated world that answers at
 * once). Every step event the surfaces get is kept.
 */
async function runningStep({ approve = true } = {}) {
    let turns = 0, release;
    const held = new Promise((r) => { release = r; });
    const events = [];
    const bg = loadBackground({
        config: { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "m", apiFormat: "openai", ocrModel: "", debugMode: "off", autoApproveReadonly: false },
        openTabs: [SITE], siteGate: false,
        onFetch: (c) => {
            if (!c.url.includes("/chat/completions")) return jsonResponse({});
            return turns++ === 0
                ? jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: "c0", type: "function", function: { name: "click", arguments: JSON.stringify({ selector: "#go" }) } }] } }] })
                : jsonResponse({ choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (_t, msg) => {
            if (msg.type === "ADOPT_RUN_NOW") return { pageInfo: "" };
            if (msg.type === "ML_DEBUG_TO_PAGE" && msg.event?.kind === "agent-step") events.push(JSON.parse(JSON.stringify(msg.event)));
            if (approve && msg.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) void bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } });
            if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
            if (msg.payload.finish || msg.payload.renderOnly || msg.payload.precheck || msg.payload.readonlyTry) return msg.payload.finish ? { result: "" } : {};
            await held;
            return { result: "value: 1" };
        },
    });
    const { hash } = await bg.context.__mlStartUserRunForTest(SITE.id, { task: "t", surface: "hud" });
    for (let i = 0; i < 400 && !events.some((e) => e.tool === "click" && e.pending && (approve ? e.approval === "user" : e.awaitingApproval)); i++) await tick();
    const seq = events.find((e) => e.tool === "click")?.seq;
    const raise = (facts = FACTS) => bg.context.__mlRaiseAskForTest(hash, seq, "sh", facts);
    const asksOn = () => events.filter((e) => e.seq === seq && e.asks).at(-1)?.asks ?? [];
    return { bg, hash, seq, events, raise, asksOn, release, finish: async () => { release(); for (let i = 0; i < 400 && turns < 2; i++) await tick(); await tick(); } };
}

test("a running step's ask reaches the surfaces on the step's own event, and their SET_APPROVAL with the ask id answers it", T, async () => {
    const w = await runningStep();
    assert.equal(typeof w.seq, "number", "positive control: the step is running");
    const p = w.raise();
    await tick();
    const [a] = w.asksOn();
    assert.deepEqual([a.kind, a.state, a.facts.argv], ["sh", "pending", FACTS.argv]);
    const ev = w.events.filter((e) => e.seq === w.seq && e.asks).at(-1);
    assert.equal(ev.tool, "click", "the ask rides the step's event, which keeps its tool");
    assert.equal(ev.awaitingApproval, false, "the step's own gate is not reopened");
    void w.bg.send({ type: "SET_APPROVAL", payload: { runId: w.hash, seq: w.seq, decision: false, feedback: "not now", ask: a.id } });   // fire-and-forget: it answers nothing
    const o = await p;
    assert.deepEqual([o.state, o.note], ["denied", "not now"]);
    assert.deepEqual(w.asksOn().map((x) => [x.state, x.note]), [["denied", "not now"]]);
    await w.finish();
    const done = w.events.filter((e) => e.seq === w.seq).at(-1);
    assert.ok(!done.pending && typeof done.result === "string", "positive control: the step finished");
    assert.deepEqual(done.asks?.map((x) => x.state), ["denied"], "the step's DONE still carries what it asked");
});

test("red team: a guessed ask id, another run's id, or a malformed one through SET_APPROVAL leaves the ask waiting", T, async () => {
    const w = await runningStep();
    const p = w.raise();
    await tick();
    const [a] = w.asksOn();
    for (const payload of [
        { runId: w.hash, seq: w.seq, decision: true, ask: `a${"0".repeat(24)}` },
        { runId: "someotherrun", seq: w.seq, decision: true, ask: a.id },
        { runId: w.hash, seq: w.seq + 1, decision: true, ask: a.id },
        { runId: w.hash, seq: w.seq, decision: true, ask: "x" },
        { runId: w.hash, seq: w.seq, decision: true, ask: { id: a.id } },
    ]) void w.bg.send({ type: "SET_APPROVAL", payload });
    await tick();
    assert.equal(w.asksOn()[0].state, "pending", "nothing answered it");
    void w.bg.send({ type: "CANCEL_RUN", payload: { runId: w.hash } });
    const o = await p;
    assert.deepEqual([o.allowed, o.state], [false, "cancelled"], "Stop denies the pending ask with that reason");
    w.release();
});

test("red team: SET_APPROVAL naming a malformed ask never falls back to the step's own pending gate", T, async () => {
    const w = await runningStep({ approve: false });
    assert.ok(w.events.some((e) => e.seq === w.seq && e.awaitingApproval), "positive control: the step's own gate is open");
    for (const ask of ["x", 5, "", `a${"0".repeat(24)}`]) void w.bg.send({ type: "SET_APPROVAL", payload: { runId: w.hash, seq: w.seq, decision: true, ask } });
    for (let i = 0; i < 20; i++) await tick();
    assert.ok(!w.events.some((e) => e.seq === w.seq && e.approval === "user"), "the gate is still closed");
    void w.bg.send({ type: "SET_APPROVAL", payload: { runId: w.hash, seq: w.seq, decision: true } });
    for (let i = 0; i < 20 && !w.events.some((e) => e.approval === "user"); i++) await tick();
    assert.ok(w.events.some((e) => e.seq === w.seq && e.approval === "user"), "positive control: no ask id opens it");
    w.release();
});

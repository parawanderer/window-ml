// Standalone tests for pushReplay (contract.ts): the per-tab HUD replay ring must NEVER drop a run's `agent`
// START event when it overflows the cap — a re-adopting page (cross-page / cross-domain nav) needs the start
// to CREATE the session, or every replayed step orphans and the corner card renders empty (the reported "the
// HUD never appears after a navigate", which bit cross-domain because a long prior session overflowed the ring).
import { test } from "node:test";
import assert from "node:assert";
import { pushReplay } from "../contract.ts";

const start = { kind: "agent", id: "r1" };
const step = (n) => ({ kind: "agent-step", step: n });

test("under the cap: nothing is dropped", () => {
    const buf = [];
    pushReplay(buf, start, 5);
    for (let i = 1; i <= 3; i++) pushReplay(buf, step(i), 5);
    assert.equal(buf.length, 4);
    assert.equal(buf[0], start);
});

test("over the cap: oldest STEPS drop, but the agent START is PINNED at the head", () => {
    const cap = 5;
    const buf = [];
    pushReplay(buf, start, cap);
    for (let i = 1; i <= 20; i++) pushReplay(buf, step(i), cap);   // way over the cap
    // The start survived (a re-adopt can still create the session)…
    assert.equal(buf.filter(e => e.kind === "agent").length, 1, "exactly one agent start retained");
    assert.equal(buf[0], start, "the start is at the head so the reducer sees it FIRST (steps don't orphan)");
    // …and the RECENT steps are kept (the tail), the middle churned.
    const lastStep = buf[buf.length - 1];
    assert.equal(lastStep.step, 20, "the newest step is retained");
    assert.ok(buf.length <= cap + 1, "bounded (~cap, plus the pinned start)");
});

test("a run with NO start (defensive) just drops oldest, no crash", () => {
    const buf = [];
    for (let i = 1; i <= 20; i++) pushReplay(buf, step(i), 5);
    assert.equal(buf.length, 5);
    assert.equal(buf[buf.length - 1].step, 20);
    assert.equal(buf.filter(e => e.kind === "agent").length, 0);
});

test("multiple runs' starts are each pinned (rare: two runs on one tab)", () => {
    const cap = 4;
    const s1 = { kind: "agent", id: "a" }, s2 = { kind: "agent", id: "b" };
    const buf = [];
    pushReplay(buf, s1, cap);
    for (let i = 1; i <= 3; i++) pushReplay(buf, step(i), cap);
    pushReplay(buf, s2, cap);
    for (let i = 4; i <= 15; i++) pushReplay(buf, step(i), cap);
    const starts = buf.filter(e => e.kind === "agent").map(e => e.id);
    assert.ok(starts.includes("a") && starts.includes("b"), "both runs' starts survive");
});

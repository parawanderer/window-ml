// The local runtime's session index (src/session-index.ts): who may write into a session, what a list row says, which
// copies of an event are the same event, what the ring keeps, and the subscription opening sequence the contract
// defines (docs/spec/SESSION_CONTRACT.md).
import test from "node:test";
import assert from "node:assert/strict";
import { SessionIndex } from "../src/session-index.ts";

const TAB_A = 11, TAB_B = 22;
const bg = (tabId = TAB_A) => ({ tabId, trusted: true });
const page = (tabId = TAB_A) => ({ tabId, trusted: false, page: { url: `https://site/${tabId}`, title: "Site" } });

const base = (hash, kind, over = {}) => ({ kind, id: hash, ts: 1, save: false, session: { hash, turn: 0 }, ...over });
const start = (hash, over = {}) => base(hash, "agent", { task: "find the price", model: "m", maxSteps: 10, config: null, ...over });
const step = (hash, seq, over = {}) => base(hash, "agent-step", { step: seq, seq, tool: "exec", arguments: {}, result: "ok", ...over });
const result = (hash, over = {}) => base(hash, "agent-result", { summary: "done", steps: 2, hitCap: false, ...over });
const stream = (hash, stepNo, content) => base(hash, "agent-stream", { step: stepNo, content });
const delta = (hash, seq, text) => base(hash, "agent-step", { step: seq, seq, streamOutput: text });

function index(over = {}) {
    let now = 1000;
    const ix = new SessionIndex({ runtime: "local", spawn: "w1", now: () => now, ...over });
    ix.tick = (ms) => { now += ms; };
    return ix;
}
const kinds = (msgs) => msgs.map((m) => (m.type === "event" ? m.event.kind : m.type));

test("a page may write only into sessions its own tab owns; a background run takes a squatted hash back", () => {
    const ix = index();
    assert.equal(ix.ingest(start("aaaa0001"), page(TAB_A)).accepted, true);
    const other = ix.ingest(step("aaaa0001", 1), page(TAB_B));
    assert.deepEqual(other, { accepted: false, reason: "not-owner" });
    // A page with no tab (nothing to bind) cannot write into a bound session either.
    assert.equal(ix.ingest(step("aaaa0001", 1), { trusted: false }).accepted, false);

    // Tab B squats a hash; the background run that really uses it runs on tab A and replaces the record.
    ix.ingest(start("bbbb0002", { task: "fake" }), page(TAB_B));
    const epochBefore = ix.epochOf("bbbb0002");
    const claim = ix.ingest(start("bbbb0002", { task: "real" }), bg(TAB_A));
    assert.equal(claim.accepted, true);
    assert.equal(claim.reset, true);
    assert.notEqual(claim.epoch, epochBefore, "a replaced session's cursors must not resume under the new record");
    assert.equal(ix.get("bbbb0002").task, "real");
    assert.deepEqual(kinds(ix.backfill("bbbb0002")), ["reset", "agent", "backfilled"]);
    // The squatter is now locked out.
    assert.equal(ix.ingest(step("bbbb0002", 1), page(TAB_B)).accepted, false);
    // Once a session is background-hosted, its own tab's page may still add what only the page emits (a steer).
    assert.equal(ix.ingest(base("bbbb0002", "agent-say", { text: "also the tax" }), page(TAB_A)).accepted, true);
});

test("malformed or unknown events are refused before they touch anything", () => {
    const ix = index();
    for (const ev of [null, "x", { kind: "agent" }, start("has:colon"), start(""), base("aaaa0001", "agent-telemetry")]) {
        assert.deepEqual(ix.ingest(ev, bg()), { accepted: false, reason: "invalid" });
    }
    assert.equal(ix.list().length, 0);
});

test("a list row follows the run: running, waiting on a gate, running, then how it ended", () => {
    const ix = index();
    const h = "aaaa0001";
    ix.ingest(start(h), bg());
    assert.equal(ix.get(h).status, "running");
    assert.equal(ix.get(h).page, undefined, "a trusted start with no page URL leaves the page unset");

    const gate = ix.ingest(step(h, 1, { pending: true, awaitingApproval: true, result: undefined }), bg());
    assert.equal(gate.summary.status, "waiting");
    assert.equal(gate.summary.pendingApprovals, 1);
    ix.ingest(step(h, 1), bg());
    assert.equal(ix.get(h).status, "running");
    assert.equal(ix.get(h).pendingApprovals, 0);

    for (const [over, status] of [[{}, "done"], [{ hitCap: true }, "capped"], [{ cancelled: true, summary: "stop" }, "cancelled"], [{ error: "boom", summary: "" }, "error"]]) {
        ix.ingest(base(h, "agent-say", { text: "next" }), page());
        assert.equal(ix.get(h).status, "running", "a new message reopens a finished run");
        ix.ingest(result(h, { steps: 9, ...over }), bg());
        assert.equal(ix.get(h).status, status);
    }
    // A straggler from the finished turn does not reopen it (the reducer's seal).
    ix.ingest(step(h, 2, { pending: true, result: undefined }), bg());
    assert.equal(ix.get(h).status, "error");

    const c = "cccc0003";
    ix.ingest(base(c, "chat", { streaming: false, request: { model: "m", messages: [{ role: "system", content: "s" }, { role: "user", content: "hello there" }] }, config: {}, save: true }), page());
    assert.deepEqual([ix.get(c).kind, ix.get(c).status, ix.get(c).task, ix.get(c).saved, ix.get(c).page.url], ["chat", "running", "hello there", true, `https://site/${TAB_A}`]);
    ix.ingest(base(c, "chat-result", { content: "hi", model: "m2" }), page());
    assert.deepEqual([ix.get(c).status, ix.get(c).model], ["done", "m2"]);
});

test("the second copy of a start, a result or a seen marker is dropped, whichever copy comes first", () => {
    const ix = index();
    const h = "aaaa0001";
    assert.equal(ix.ingest(start(h), page()).accepted, true);
    assert.deepEqual(ix.ingest(start(h), bg()), { accepted: false, reason: "duplicate" });
    // A resurrected run re-announces on purpose and is kept.
    assert.equal(ix.ingest(start(h, { resumed: true }), bg()).accepted, true);
    ix.ingest(step(h, 1), bg());
    assert.equal(ix.ingest(result(h), bg()).accepted, true);
    assert.equal(ix.ingest(result(h), page()).accepted, false);
    // The next turn's result is not a copy, even when it says the same, because something happened in between.
    ix.ingest(base(h, "agent-say", { text: "again" }), page());
    assert.equal(ix.ingest(result(h), bg()).accepted, true);
    assert.equal(ix.ingest(base(h, "agent-say-seen", { sayId: "s1" }), bg()).accepted, true);
    assert.equal(ix.ingest(base(h, "agent-say-seen", { sayId: "s1" }), page()).accepted, false);
    const chat = base("cccc0003", "chat", { id: "turn-1", session: { hash: "cccc0003", turn: 0 }, request: { messages: [] }, config: {} });
    assert.equal(ix.ingest(chat, page()).accepted, true);
    assert.equal(ix.ingest(chat, page()).accepted, false);
});

test("live output is coalesced: the ring holds the newest of each, and a finished step drops its deltas", () => {
    const ix = index();
    const h = "aaaa0001";
    ix.ingest(start(h), bg());
    ix.ingest(stream(h, 1, "thin"), bg());
    ix.ingest(stream(h, 1, "thinking"), bg());
    ix.ingest(step(h, 1, { pending: true, result: undefined }), bg());
    ix.ingest(delta(h, 1, "line 1"), bg());
    ix.ingest(delta(h, 1, "line 1\nline 2"), bg());
    let held = ix.backfill(h).filter((m) => m.type === "event").map((m) => m.event);
    assert.deepEqual(held.map((e) => e.content ?? e.streamOutput ?? e.kind), ["agent", "thinking", "agent-step", "line 1\nline 2"]);
    ix.ingest(step(h, 1), bg());
    held = ix.backfill(h).filter((m) => m.type === "event").map((m) => m.event);
    assert.deepEqual(held.map((e) => `${e.kind}${e.pending ? ":pending" : ""}`), ["agent", "agent-step:pending", "agent-step"]);
    // A delta does not change the row, so a streaming run does not flood the list with upserts.
    ix.ingest(step(h, 2, { pending: true, result: undefined }), bg());
    assert.equal(ix.ingest(delta(h, 2, "x"), bg()).summary, null);
    ix.tick(6000);
    assert.notEqual(ix.ingest(delta(h, 2, "xy"), bg()).summary, null, "recency is still reported, every few seconds");
});

test("opening a subscription: everything with a reset, only the tail from a position it holds, a reset otherwise", () => {
    const ix = index();
    const h = "aaaa0001";
    const c1 = ix.ingest(start(h), bg()).cursor;
    const c2 = ix.ingest(step(h, 1), bg()).cursor;
    const epoch = ix.epochOf(h);

    const fresh = ix.backfill(h);
    assert.deepEqual(kinds(fresh), ["reset", "agent", "agent-step", "backfilled"]);
    assert.deepEqual(fresh.at(-1), { type: "backfilled", session: { runtime: "local", hash: h }, epoch, cursor: c2, truncated: false });
    assert.ok(fresh.every((m) => m.type !== "event" || (m.v === 1 && m.session.hash === h && m.epoch === epoch)));

    const c3 = ix.ingest(result(h), bg()).cursor;
    const tail = ix.backfill(h, { epoch, cursor: c2 });
    assert.deepEqual(kinds(tail), ["agent-result", "backfilled"]);
    assert.equal(tail[0].cursor, c3);
    assert.deepEqual(kinds(ix.backfill(h, { epoch, cursor: c3 })), ["backfilled"]);
    assert.ok(c1 < c2 && c2 < c3);

    // A position from a previous worker (another spawn) cannot resume.
    assert.deepEqual(kinds(ix.backfill(h, { epoch: "w0.0", cursor: c2 })), ["reset", "agent", "agent-step", "agent-result", "backfilled"]);
    // A session this worker does not hold: no reset, so the client keeps what it shows, and truncated when it held some.
    assert.deepEqual(ix.backfill("dead0000", { epoch: "w0.0", cursor: 5 }), [{ type: "backfilled", session: { runtime: "local", hash: "dead0000" }, epoch: "w1.0", cursor: 0, truncated: true }]);
    assert.equal(ix.backfill("dead0000")[0].truncated, false);
});

test("the caps: an old position resets and says history was lost; whole sessions go finished-first", () => {
    const ix = index({ perSessionEvents: 3, maxSessions: 2 });
    const h = "aaaa0001";
    const first = ix.ingest(start(h), bg());
    for (let i = 1; i <= 4; i++) ix.ingest(step(h, i), bg());
    const msgs = ix.backfill(h, { epoch: first.epoch, cursor: first.cursor });
    assert.deepEqual(kinds(msgs), ["reset", "agent-step", "agent-step", "agent-step", "backfilled"]);
    assert.equal(msgs.at(-1).truncated, true);

    ix.ingest(start("bbbb0002"), bg(TAB_B));
    ix.ingest(result("bbbb0002"), bg(TAB_B));
    ix.tick(10);
    const third = ix.ingest(start("cccc0003"), bg(TAB_B));
    assert.deepEqual(third.evicted, [{ runtime: "local", hash: "bbbb0002" }], "the finished session goes, not the running one");
    assert.deepEqual(ix.list().map((s) => s.id.hash).sort(), [h, "cccc0003"]);
    // A hash that was dropped and comes back gets a new epoch.
    assert.equal(ix.ingest(start("bbbb0002"), bg(TAB_B)).epoch, "w1.1");
});

test("a byte cap trims the least recently changed session first, and never the event that just arrived", () => {
    const big = "x".repeat(2000);
    const ix = index({ totalBytes: 5000 });
    ix.ingest(step("aaaa0001", 1, { result: big }), bg());
    ix.tick(10);
    ix.ingest(step("bbbb0002", 1, { result: big }), bg());
    ix.tick(10);
    ix.ingest(step("bbbb0002", 2, { result: big }), bg());
    assert.equal(kinds(ix.backfill("aaaa0001")).includes("agent-step"), false);
    assert.equal(ix.backfill("aaaa0001").at(-1).truncated, true);
    assert.equal(kinds(ix.backfill("bbbb0002")).filter((k) => k === "agent-step").length, 2);
});

test("a tab's document going away interrupts the runs it hosted, not the background's", () => {
    const ix = index();
    ix.ingest(start("aaaa0001"), page(TAB_A));
    ix.ingest(start("bbbb0002"), bg(TAB_A));
    ix.ingest(start("cccc0003"), page(TAB_A));
    ix.ingest(result("cccc0003"), page(TAB_A));
    const changed = ix.pageGone(TAB_A, { closed: false });
    assert.deepEqual(changed.map((s) => [s.id.hash, s.status]), [["aaaa0001", "interrupted"]]);
    assert.equal(ix.get("bbbb0002").status, "running");
    assert.equal(ix.get("cccc0003").status, "done");

    // Closed: the binding is released. A page-hosted session can be picked up by a tab that resumes it; a
    // background-hosted one stays closed to pages.
    ix.pageGone(TAB_A, { closed: true });
    assert.equal(ix.binding("aaaa0001").tabId, undefined);
    assert.equal(ix.ingest(base("aaaa0001", "agent-say", { text: "resumed here" }), page(TAB_B)).accepted, true);
    assert.equal(ix.get("aaaa0001").status, "running");
    assert.equal(ix.ingest(step("bbbb0002", 1), page(TAB_B)).accepted, false);
});

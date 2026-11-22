// The local runtime's session index (src/session-index.ts): who may write into a session, what a list row says, which
// copies of an event are the same event, what the ring keeps, and the subscription opening sequence the contract
// defines (docs/spec/SESSION_CONTRACT.md).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SessionIndex } from "../src/session/session-index.ts";

const TAB_A = 11, TAB_B = 22, TAB_C = 33;
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

// --- a chat turn's live preview (chat-stream) ---

test("a chat turn's previews are coalesced by turn, and its result or error drops them", () => {
    const ix = index();
    const h = "cccc0001";
    const turn = (id, over = {}) => base(h, "chat", { id, streaming: true, request: { model: "m", messages: [{ role: "user", content: "hi" }] }, config: null, ...over });
    const preview = (id, content) => base(h, "chat-stream", { id, content });
    const held = () => ix.backfill(h).filter((m) => m.type === "event").map((m) => `${m.event.kind}:${m.event.content ?? m.event.id}`);
    assert.equal(ix.ingest(turn(`${h}-1`), bg()).accepted, true);
    assert.equal(ix.ingest(preview(`${h}-1`, "Hel"), bg()).accepted, true, "a known kind");
    ix.ingest(preview(`${h}-1`, "Hello"), bg());
    // The newest preview replaces the older one: each carries everything so far.
    assert.deepEqual(held(), [`chat:${h}-1`, "chat-stream:Hello"]);
    ix.ingest(base(h, "chat-result", { id: `${h}-1`, content: "Hello there", sources: null, structured: false, model: "m", extend: null, reasoning: null, usage: null }), bg());
    assert.deepEqual(held(), [`chat:${h}-1`, "chat-result:Hello there"], "the result supersedes the turn's previews");

    // Another turn's preview is its own, and an error ends a turn's previews as a result does.
    ix.ingest(turn(`${h}-2`), bg());
    ix.ingest(preview(`${h}-2`, "par"), bg());
    ix.ingest(base(h, "chat-error", { id: `${h}-2`, error: "cancelled" }), bg());
    assert.deepEqual(held().slice(2), [`chat:${h}-2`, `chat-error:${h}-2`]);
});

// --- subscriptions, caps, restores and resume notes ---

test("opening a subscription: everything with a reset, only the tail from a position it holds, a reset otherwise", () => {
    const ix = index();
    const h = "aaaa0001";
    const c1 = ix.ingest(start(h), bg()).cursor;
    const c2 = ix.ingest(step(h, 1), bg()).cursor;
    const epoch = ix.epochOf(h);

    const fresh = ix.backfill(h);
    assert.deepEqual(kinds(fresh), ["reset", "agent", "agent-step", "backfilled"]);
    // `from: 0`: nothing was lost, so the stream starts at the session's first event and there is nothing to page to.
    assert.deepEqual(fresh.at(-1), { type: "backfilled", session: { runtime: "local", hash: h }, epoch, cursor: c2, truncated: false, from: 0 });
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
    // …and the BACKGROUND one is interrupted by the close, which the navigation above deliberately did not do. Its
    // tab held the document every page tool is delegated into, so it cannot take another step.
    assert.equal(ix.get("bbbb0002").status, "interrupted");
});

test("a background run whose tab closed stops claiming an approval nobody can answer", () => {
    // The state a real run reached: a delegated tool hung, the page went, and the run never emitted a result. The
    // gate stayed in the index, so `pendingApprovals` stayed 1 — the bar said an approval was pending across
    // reloads and tab switches, with no card to reach and the one press that would clear it refused.
    const ix = index();
    ix.ingest(start("aaaa0001"), bg(TAB_A));
    ix.ingest(step("aaaa0001", 1, { pending: true, awaitingApproval: true }), bg(TAB_A));
    assert.equal(ix.get("aaaa0001").status, "waiting");
    assert.equal(ix.get("aaaa0001").pendingApprovals, 1);

    // A NAVIGATION must not do it: a background run surviving one is the whole of cross-page.
    ix.pageGone(TAB_A, { closed: false });
    assert.equal(ix.get("aaaa0001").pendingApprovals, 1, "a navigation leaves a background run alone");

    ix.pageGone(TAB_A, { closed: true });
    assert.equal(ix.get("aaaa0001").status, "interrupted");
    assert.equal(ix.get("aaaa0001").pendingApprovals, 0, "the gate goes with the page it would have been answered on");

    // Self-correcting: if the run turns out to be alive after all, its own next event takes it back.
    ix.ingest(base("aaaa0001", "agent-say", { text: "still here" }), bg(TAB_B));
    assert.equal(ix.get("aaaa0001").status, "running");
});

test("a restored session claims no approval, whatever the row on disk said", () => {
    // The row is persisted with whatever was pending at the time, and a session restored from one holds NO gates.
    // Carrying the count across left a claim with nothing behind it, and the only thing that recomputes it runs on
    // an event — which a run that died with its worker never sends. What that looked like: the bar above the
    // transcript saying an approval was pending for the rest of the browser's life, "Review" scrolling to no card,
    // and answering an unrelated gate unable to clear it, because it had never been one.
    const ix = index();
    const saved = { id: { runtime: "local", hash: "aaaa0001" }, kind: "agent", status: "waiting", createdTs: 500, lastTs: 900, pendingApprovals: 1, saved: true, task: "read the fare rules" };
    const [row] = ix.restore([{ summary: saved, count: 12 }]);
    assert.equal(row.pendingApprovals, 0);
    assert.equal(ix.get("aaaa0001").pendingApprovals, 0);
    // A gate open when the worker died cannot be answered — the loop that posted it is gone — so the status is the
    // interrupted one and the count agrees with it.
    assert.equal(row.status, "interrupted");
    // A restored session is `ended`, so nothing it is handed can reopen a gate by accident either: it takes a real
    // resume to make it live again, and that path brings its own events with it.
    ix.ingest(step("aaaa0001", 1, { pending: true, awaitingApproval: true }), page(TAB_A));
    assert.equal(ix.get("aaaa0001").pendingApprovals, 0);
});

test("a restored session is listed, is not running any more, and its events are known to be on disk", () => {
    const ix = index();
    const saved = { id: { runtime: "local", hash: "aaaa0001" }, kind: "agent", status: "running", createdTs: 500, lastTs: 900, pendingApprovals: 0, saved: true, task: "find the price" };
    const rows = ix.restore([{ summary: saved, count: 12 }]);

    // A run that was going when the worker died did not survive it: a list still showing it as running would be
    // waiting for an event that cannot arrive.
    assert.equal(rows[0].status, "interrupted");
    assert.equal(ix.get("aaaa0001").task, "find the price");
    assert.equal(ix.list().length, 1);

    // Nothing is in memory, and the index says so: every subscription to it has to read the disk.
    assert.equal(ix.needsStored("aaaa0001"), true);
    assert.equal(ix.storedThrough("aaaa0001"), 12);
    // Live cursors continue AFTER the stored ones, so a reconnecting client is not handed cursor 1 twice.
    ix.ingest(step("aaaa0001", 13), bg());
    assert.equal(ix.backfill("aaaa0001").at(-1).cursor, 13);
});

test("restore never overwrites a session this worker already holds, or an unparseable one", () => {
    const ix = index();
    ix.ingest(start("aaaa0001"), bg());
    const live = ix.get("aaaa0001").status;
    ix.restore([
        { summary: { id: { runtime: "local", hash: "aaaa0001" }, kind: "chat", status: "done", createdTs: 1, lastTs: 2, pendingApprovals: 0, saved: true }, count: 3 },
        { summary: { id: { runtime: "local", hash: "not a hash!" }, kind: "chat", status: "done", createdTs: 1, lastTs: 2, pendingApprovals: 0, saved: true }, count: 1 },
    ]);
    assert.equal(ix.get("aaaa0001").status, live, "the live record won");
    assert.equal(ix.get("aaaa0001").kind, "agent");
    assert.equal(ix.list().length, 1, "and the malformed row was refused");
});

test("needsStored is false when the ring still covers what the client asks for", () => {
    const ix = index();
    ix.ingest(start("aaaa0001"), bg());
    ix.ingest(step("aaaa0001", 1), bg());
    const epoch = ix.epochOf("aaaa0001");
    // Nothing has been lost from this session, so no read is needed whatever the client asks for.
    assert.equal(ix.needsStored("aaaa0001"), false);
    assert.equal(ix.needsStored("aaaa0001", { epoch, cursor: 1 }), false);
    assert.equal(ix.needsStored("nosuch01"), false, "a session nobody holds needs no disk either");
});

test("marking a session saved hands back what it had already emitted, and only the first time", () => {
    const ix = index();
    ix.ingest(start("aaaa0001"), bg());
    ix.ingest(step("aaaa0001", 1), bg());
    assert.equal(ix.get("aaaa0001").saved, false);

    // A session is marked a moment after its first events: the hash does not exist until the run mints it, so the
    // caller needs those events back or every kept session loses its own beginning.
    const first = ix.markSaved("aaaa0001");
    assert.equal(first.summary.saved, true);
    assert.deepEqual(first.events.map((e) => e.kind), ["agent", "agent-step"]);

    assert.equal(ix.markSaved("aaaa0001"), null, "marking twice writes nothing twice");
    assert.equal(ix.markSaved("nosuch01"), null, "and a session nobody holds cannot be kept");
});

test("a resume note belongs to a session that exists, and never makes one", () => {
    const ix = index();
    const note = (hash, over = {}) => base(hash, "session-resumed", { url: "https://new.example/", fromUrl: "https://old.example/", afterMs: 90_000, dropped: ["the page's state object"], ...over });

    // A note about a session this index does not hold is not a session: accepting it would put a row in the list
    // with a divider in it and nothing else, and the kind-from-prefix rule would have to guess what it was.
    assert.deepEqual(ix.ingest(note("ffff0001"), bg()), { accepted: false, reason: "invalid" });
    assert.equal(ix.list().length, 0);

    ix.ingest(start("aaaa0001"), bg());
    const out = ix.ingest(note("aaaa0001"), bg());
    assert.equal(out.accepted, true);
    assert.equal(ix.get("aaaa0001").kind, "agent", "and it did not change what the session is");
    assert.equal(kinds(ix.backfill("aaaa0001")).at(-2), "session-resumed", "it is in the stream like any other event");
});

test("a resume note is recorded once, however many sides report it", () => {
    const ix = index();
    const note = (hash, over = {}) => base(hash, "session-resumed", { url: "https://new.example/", afterMs: 90_000, dropped: ["the page's state object"], ...over });
    ix.ingest(start("aaaa0001"), bg());

    assert.equal(ix.ingest(note("aaaa0001"), bg()).accepted, true);
    // Off mode with `listPageSessions` wakes the page's bus while the background fans the same run, so one resume
    // arrives twice. Two notes would be two dividers, in the log and in every replay of the ring.
    assert.deepEqual(ix.ingest(note("aaaa0001"), page()), { accepted: false, reason: "duplicate" });
    assert.equal(kinds(ix.backfill("aaaa0001")).filter((k) => k === "session-resumed").length, 1);

    // A second, genuinely different resume is its own note.
    assert.equal(ix.ingest(note("aaaa0001", { id: "aaaa0001-r2", url: "https://later.example/" }), bg()).accepted, true);
    assert.equal(kinds(ix.backfill("aaaa0001")).filter((k) => k === "session-resumed").length, 2);
    assert.equal(ix.get("aaaa0001").page.url, "https://later.example/", "the row is on the later resume's page");
});

test("a resume puts the session on its new page: the row names that tab and its url, so the closed-tab bar goes", () => {
    // Shane's report (2026-11-14): "Resume on a page" added a divider and left the bar. `pageGone` deletes the row's
    // `page.tabId`, and the resume's note re-owned the session without touching the row, so `resumableHere` (which
    // reads `page.tabId`) kept offering the resume.
    const ix = index();
    const note = (over = {}) => base("aaaa0001", "session-resumed", { url: "https://new.example/", fromUrl: "https://site/11", afterMs: 1, dropped: ["state"], ...over });
    ix.ingest(start("aaaa0001"), { ...bg(TAB_A), page: { url: "https://site/11", title: "Site" } });
    ix.ingest(result("aaaa0001"), bg(TAB_A));
    ix.pageGone(TAB_A, { closed: true });
    assert.equal(ix.get("aaaa0001").page.tabId, undefined, "precondition: the closed tab let go of it");

    ix.ingest(note(), bg(TAB_B));
    assert.deepEqual(ix.get("aaaa0001").page, { url: "https://new.example/", tabId: TAB_B }, "the new page, with no stale title");
    assert.equal(ix.binding("aaaa0001").tabId, TAB_B);

});

test("a resume onto a third tab while the old one is still open moves the row and the owner there, one owner", () => {
    const ix = index();
    const note = (over = {}) => base("aaaa0001", "session-resumed", { url: "https://third.example/", fromUrl: "https://site/11", afterMs: 1, dropped: ["state"], ...over });
    ix.ingest(start("aaaa0001"), { ...bg(TAB_A), page: { url: "https://site/11", title: "Site" } });
    ix.ingest(result("aaaa0001"), bg(TAB_A));
    assert.equal(ix.ingest(note(), bg(TAB_C)).accepted, true);
    assert.deepEqual(ix.get("aaaa0001").page, { url: "https://third.example/", tabId: TAB_C });
    assert.equal(ix.binding("aaaa0001").tabId, TAB_C);
    // The tab it left, still open, is no longer the owner.
    assert.deepEqual(ix.ingest(step("aaaa0001", 3), page(TAB_A)), { accepted: false, reason: "not-owner" });
});

test("a page's own copy of a resume note, admitted for the session its tab owns, moves nothing: only the worker's word moves the row", () => {
    // A page-built session (hostedBy page, owned by TAB_A): its page's events are admitted, so the `trusted` guard is
    // the only thing between the row and a url the page chose.
    const ix = index();
    ix.ingest(start("aaaa0001"), page(TAB_A));
    const before = ix.get("aaaa0001").page;
    const r = ix.ingest(base("aaaa0001", "session-resumed", { id: "aaaa0001-r9", url: "https://elsewhere.example/", afterMs: 1, dropped: ["state"] }), page(TAB_A));
    assert.equal(r.accepted, true, "the note is admitted: it is the owning tab's");
    assert.deepEqual(ix.get("aaaa0001").page, before, "and the row's page is unchanged");
});

test("a resume note that does not say what it dropped never enters the stream", () => {
    const ix = index();
    const note = (over) => base("aaaa0001", "session-resumed", { url: "https://new.example/", afterMs: 1, dropped: ["state"], ...over });
    ix.ingest(start("aaaa0001"), bg());

    // The source is untrusted (a page-forwarded event, accepted for a session its tab owns), and the divider that
    // reads `dropped` would meet undefined where the contract promises a non-empty list of strings.
    for (const bad of [{ dropped: undefined }, { dropped: [] }, { dropped: "state" }, { dropped: [1, 2] }, { url: "" }, { url: 5 }]) {
        assert.deepEqual(ix.ingest(note(bad), page()), { accepted: false, reason: "invalid" }, JSON.stringify(bad));
    }
    assert.equal(kinds(ix.backfill("aaaa0001")).filter((k) => k === "session-resumed").length, 0);
});

test("a resume note's `kept` is absent or a list of strings", () => {
    const ix = index();
    const note = (over) => base("aaaa0001", "session-resumed", { url: "https://new.example/", afterMs: 1, dropped: ["state"], ...over });
    ix.ingest(start("aaaa0001"), bg());
    for (const bad of [{ kept: [1] }, { kept: "x" }, { kept: {} }, { kept: null }]) {
        assert.deepEqual(ix.ingest(note({ id: "r-bad", ...bad }), page()), { accepted: false, reason: "invalid" }, JSON.stringify(bad));
    }
    assert.equal(ix.ingest(note({ id: "r-ok", kept: ["x"] }), bg()).accepted, true);
    assert.equal(ix.ingest(note({ id: "r-none" }), bg()).accepted, true, "absent is fine");
});

test("every event kind the index accepts has been considered for de-duplication", async () => {
    const src = await readFile(new URL("../src/session/session-index.ts", import.meta.url), "utf8");
    const known = [...src.slice(src.indexOf("const KNOWN_KINDS"), src.indexOf("\n", src.indexOf("const KNOWN_KINDS"))).matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
    assert.ok(known.length >= 12, `found ${known.length} kinds`);

    // The rules are per KIND, and adding a kind means visiting the table rather than only the path that makes the
    // feature work: a kind with no rule is a kind that records the same event twice when the page's bus and the
    // background both report it, which is what `listPageSessions` makes routine. A kind that genuinely needs none
    // says so here, so the decision is made once and written down rather than made by omission.
    const NO_RULE_NEEDED = new Set([
        "agent-step",    // coalesced by step, and a repeat is the same step's later state
        "agent-stream",  // coalesced by step: the newest delta replaces the last
        "chat-stream",   // coalesced by turn id the same way, and dropped by the turn's result or error
        "agent-turn",    // coalesced the same way, and carries no history of its own
        "agent-cap",     // last write wins: a cap is a number, not an occurrence
        "agent-config",  // last write wins: the wire's tools and prompt replace the page's, a repeat says the same
        "agent-say",     // paired with agent-say-seen, which is the one that can arrive twice
        "chat-error",    // ends a turn opened by `chat`, which is itself de-duplicated
        "agent-site-say", // the worker's own record of one turn a site sent, written once per turn
    ]);
    const duplicate = src.slice(src.indexOf("private isDuplicate"), src.indexOf("private fold"));
    for (const kind of known) {
        if (NO_RULE_NEEDED.has(kind)) continue;
        assert.ok(duplicate.includes(`"${kind}"`), `${kind} has no de-duplication rule and is not listed as needing none`);
    }
});

test("a SAVED session is never evicted whole: the store decides whether it exists", () => {
    // It used to be. The index told every client `remove`, the store still held the session, and the next worker's
    // `restore` put it straight back — a saved session flickered out of the list and in again. The old sessions
    // somebody pins are exactly the saved ones this dropped first.
    const ix = index({ maxSessions: 2 });
    for (const h of ["aaaa0001", "aaaa0002", "aaaa0003"]) {
        ix.ingest(start(h), bg());
        ix.ingest(result(h), bg());
        ix.markSaved(h);
        ix.tick(10);
    }
    // Three saved sessions, a cap of two, and nothing was forgotten.
    assert.deepEqual(ix.list().map((s) => s.id.hash).sort(), ["aaaa0001", "aaaa0002", "aaaa0003"]);

    // Unsaved sessions still count toward the cap and are still dropped, oldest finished first — and the saved ones
    // around them are not what makes room.
    ix.ingest(start("bbbb0001"), bg(TAB_B)); ix.ingest(result("bbbb0001"), bg(TAB_B)); ix.tick(10);
    ix.ingest(start("bbbb0002"), bg(TAB_B)); ix.ingest(result("bbbb0002"), bg(TAB_B)); ix.tick(10);
    const third = ix.ingest(start("bbbb0003"), bg(TAB_B));
    assert.deepEqual(third.evicted, [{ runtime: "local", hash: "bbbb0001" }], "the oldest UNSAVED session goes");
    for (const h of ["aaaa0001", "aaaa0002", "aaaa0003"]) assert.ok(ix.get(h), `saved ${h} is still listed`);
});

test("a pin is a field on the row: set and cleared once, counted, and carried through a restore", () => {
    const ix = index();
    ix.ingest(start("aaaa0001"), bg());
    ix.markSaved("aaaa0001");
    assert.equal(ix.setPinned("aaaa0001", true).pinned, true);
    assert.equal(ix.setPinned("aaaa0001", true), null, "pinning what is pinned changes nothing, so nothing is broadcast");
    assert.equal(ix.pinnedCount(), 1);
    assert.equal(ix.setPinned("ffff0000", true), null, "a session not held");

    const row = ix.setPinned("aaaa0001", false);
    assert.equal("pinned" in row, false, "unpinned is ABSENT, as the contract says, not false");
    assert.equal(ix.pinnedCount(), 0);

    // A restarted worker gets `pinned` back from the stored summary: nothing else remembers it.
    ix.setPinned("aaaa0001", true);
    const next = index();
    next.restore([{ summary: ix.get("aaaa0001"), count: 1 }]);
    assert.equal(next.get("aaaa0001").pinned, true);
});

test("heldEvents: what the ring still has, and where in the session it begins", () => {
    // The count is the session's OWN history, not the runtime-wide cursor, and it is taken before the caps run — so
    // trimming the ring loses the event and never its place. That difference is what tells "there is no more" from
    // "there is more and it is gone", which is the whole of `truncated` on an unkept session's backfill.
    const ix = index({ perSessionEvents: 4 });
    assert.equal(ix.heldEvents("aaaa0001"), null, "a session it is not holding: nothing can be served, ever");

    assert.equal(ix.ingest(start("aaaa0001"), bg()).pos, 0, "the first event of a session sits at 0");
    for (let i = 1; i <= 3; i++) assert.equal(ix.ingest(step("aaaa0001", i), bg()).pos, i);
    let held = ix.heldEvents("aaaa0001");
    assert.equal(held.from, 0, "nothing trimmed yet, so the ring is the whole history");
    assert.equal(held.seen, 4, "and `seen` is how long that history is, trimmed or not");
    assert.deepEqual(held.events.map((e) => e.seq ?? 0), [0, 1, 2, 3]);

    for (let i = 4; i <= 9; i++) ix.ingest(step("aaaa0001", i), bg());
    held = ix.heldEvents("aaaa0001");
    assert.equal(held.events.length, 4, "the cap");
    assert.equal(held.from, 6, "ten events in, four held: the first of them is the seventh");
    assert.deepEqual(held.events.map((e) => e.seq), [6, 7, 8, 9]);

    // Each session counts its own history. A second one starting now starts at 0, however much the first has seen.
    assert.equal(ix.ingest(start("aaaa0002"), bg()).pos, 0);
    assert.equal(ix.heldEvents("aaaa0002").from, 0);

    // A restored session's events are on disk, not in the ring, and its count continues from what was stored —
    // otherwise a live event after a restart would claim a position an older one already holds.
    const next = index();
    next.restore([{ summary: ix.get("aaaa0001"), count: 40 }]);
    assert.deepEqual(next.heldEvents("aaaa0001"), { events: [], from: 40, seen: 40 });
    assert.equal(next.ingest(step("aaaa0001", 99), bg()).pos, 40);
});

// --- nested asks: a gate raised inside a running step (src/sw/sw-asks.ts) ---

test("a nested ask is a gate of its own while it waits: the row is waiting and counts it, and the phone's badge reads that count", () => {
    const ix = index();
    const h = "aaaa0002";
    ix.ingest(start(h), bg());
    const ask = (id, state, over = {}) => ({ id, kind: "sh", facts: { argv: ["ls"] }, state, raisedAt: 1, ...over });
    const running = { pending: true, result: undefined };
    ix.ingest(step(h, 1, running), bg());
    assert.equal(ix.get(h).status, "running", "positive control: a running step is not waiting");
    ix.ingest(step(h, 1, { ...running, asks: [ask("a1", "pending"), ask("a2", "pending")] }), bg());
    assert.deepEqual([ix.get(h).status, ix.get(h).pendingApprovals], ["waiting", 2]);
    ix.ingest(step(h, 1, { ...running, asks: [ask("a1", "allowed"), ask("a2", "pending")] }), bg());
    assert.equal(ix.get(h).pendingApprovals, 1, "an answered ask stops counting");
    ix.ingest(step(h, 1, { ...running, asks: [ask("a1", "allowed"), ask("a2", "pending", { external: true })] }), bg());
    assert.equal(ix.get(h).pendingApprovals, 0, "an ask only the external channel answers is not this person's to answer");
    ix.ingest(step(h, 1, { ...running, asks: [ask("a1", "allowed"), ask("a2", "denied")] }), bg());
    assert.deepEqual([ix.get(h).status, ix.get(h).pendingApprovals], ["running", 0]);
    ix.ingest(step(h, 2, { ...running, asks: [ask("a3", "pending")] }), bg());
    ix.ingest(result(h), bg());
    assert.equal(ix.get(h).pendingApprovals, 0, "a finished turn clears its asks with its gates");
});

// --- what only the worker may write: its record of what the model was sent (#968) ---

test("agent-config is the worker's record of what the model was sent: refused from a page, accepted from the worker", () => {
    const ix = index();
    const cfg = (hash, description) => base(hash, "agent-config", { config: { system: "S", tools: [{ name: "click", requiresApproval: true, vision: false, description }] } });
    const configs = (h) => ix.heldEvents(h).events.filter((e) => e.kind === "agent-config").map((e) => e.config.tools[0].description);
    // A page-built run on the page's own tab: the page may write its start, never the worker's record of the wire.
    assert.equal(ix.ingest(start("aaaa0001"), page(TAB_A)).accepted, true);
    assert.deepEqual(ix.ingest(cfg("aaaa0001", "the page's words"), page(TAB_A)), { accepted: false, reason: "invalid" });
    assert.deepEqual(configs("aaaa0001"), [], "the refused record left the session as it was");
    assert.equal(ix.ingest(cfg("aaaa0001", "ours"), bg()).accepted, true);
    assert.deepEqual(ix.ingest(cfg("aaaa0001", "the page's words"), page(TAB_A)), { accepted: false, reason: "invalid" });
    assert.deepEqual(configs("aaaa0001"), ["ours"], "a later page copy does not overwrite the worker's");
});

// --- a session's background tasks on its row (rule 4b slice E, `SessionSummary.background`) ---

test("setBackground changes the row once, returns null on the same value, and a {0,0} clears it", () => {
    const ix = index();
    ix.ingest(start("aaaa0021"), bg());
    assert.equal(ix.get("aaaa0021").background, undefined, "a session with no tasks carries no field");
    assert.deepEqual(ix.setBackground("aaaa0021", { running: 1, waiting: 0 })?.background, { running: 1, waiting: 0 });
    assert.equal(ix.setBackground("aaaa0021", { running: 1, waiting: 0 }), null, "the same value changed nothing");
    assert.deepEqual(ix.setBackground("aaaa0021", { running: 1, waiting: 2, noTab: true })?.background, { running: 1, waiting: 2, noTab: true });
    assert.ok(ix.setBackground("aaaa0021", { running: 0, waiting: 0 }), "{0,0} is a change from a marked row");
    assert.equal("background" in ix.get("aaaa0021"), false, "never {0,0}: the field is absent");
    assert.equal(ix.setBackground("aaaa0021", null), null, "clearing a clear row changes nothing");
    assert.equal(ix.setBackground("zzzz0000", { running: 1, waiting: 0 }), null, "a session not held has no row");
});

test("UPGRADE: a row saved by a worker with no `background` restores with none, and one saved WITH it restores without it", () => {
    const old = { id: { runtime: "local", hash: "aaaa0022" }, kind: "agent", status: "done", createdTs: 500, lastTs: 900, pendingApprovals: 0, saved: true, task: "t" };
    const ix = index();
    const [a] = ix.restore([{ summary: old, count: 2 }]);
    assert.equal("background" in a, false);
    const withBg = { ...old, id: { runtime: "local", hash: "aaaa0023" }, background: { running: 2, waiting: 1, noTab: true } };
    const [b] = ix.restore([{ summary: withBg, count: 2 }]);
    assert.equal("background" in b, false, "a saved summary is not the task table");
    assert.equal("background" in ix.get("aaaa0023"), false);
    assert.deepEqual(ix.setBackground("aaaa0023", { running: 1, waiting: 0 })?.background, { running: 1, waiting: 0 }, "and it takes a fresh one");
});

// --- the Session summary page's fields: forkedFrom and currentPage ---

const forkStart = (hash, forkOf, over = {}) => start(hash, { session: { hash, turn: 0, forkOf }, ...over });

test("a fork on the same tab is listed with its parent's id, on the first event only", () => {
    const ix = index();
    ix.ingest(start("aaaa0001"), page(TAB_A));
    ix.ingest(forkStart("bbbb0002", "aaaa0001"), page(TAB_A));
    assert.deepEqual(ix.get("bbbb0002").forkedFrom, { runtime: "local", hash: "aaaa0001" });
    assert.equal(ix.get("aaaa0001").forkedFrom, undefined, "the parent is not a fork");
    // The same for a fork that a background run started.
    ix.ingest(forkStart("cccc0003", "aaaa0001"), bg(TAB_A));
    assert.deepEqual(ix.get("cccc0003").forkedFrom, { runtime: "local", hash: "aaaa0001" });
});

test("a fork's claim is ignored for another tab's session, an unknown or malformed hash, itself, and an ownerless parent", () => {
    const ix = index();
    ix.ingest(start("aaaa0001"), page(TAB_A));
    const saved = { id: { runtime: "local", hash: "dddd0004" }, kind: "agent", status: "done", createdTs: 500, lastTs: 900, pendingApprovals: 0, saved: true, task: "old" };
    ix.restore([{ summary: saved, count: 3 }]);
    assert.equal(ix.binding("dddd0004")?.tabId, undefined, "a restored session has no owner");
    const claims = {
        eeee0005: "aaaa0001",   // the parent runs on TAB_A, the fork on TAB_B
        ffff0006: "zzzz9999",   // not held
        aaab0007: "has:colon",
        aaac0008: "../etc",
        aaad0009: "",
        aaae0010: "aaae0010",   // itself
        aaaf0011: "dddd0004",   // held, restored, no owner
    };
    for (const [hash, forkOf] of Object.entries(claims)) {
        const tabId = hash === "aaaf0011" ? TAB_A : TAB_B;
        assert.equal(ix.ingest(forkStart(hash, forkOf), page(tabId)).accepted, true, hash);
        assert.equal(ix.get(hash).forkedFrom, undefined, `${hash} claimed ${JSON.stringify(forkOf)}`);
    }
    [7, null, { hash: "aaaa0001" }, ["aaaa0001"], true].forEach((forkOf, i) => {
        const hash = `aabb000${i}`;
        assert.equal(ix.ingest(forkStart(hash, forkOf), page(TAB_A)).accepted, true);
        assert.equal(ix.get(hash).forkedFrom, undefined, `forkOf ${JSON.stringify(forkOf)}`);
    });
});

test("forkOf on a later event of an existing session never sets or changes forkedFrom", () => {
    const ix = index();
    ix.ingest(start("aaaa0001"), page(TAB_A));
    ix.ingest(start("bbbb0002"), page(TAB_A));
    ix.ingest(start("cccc0003"), page(TAB_A));
    // set later: ignored
    ix.ingest(step("cccc0003", 1, { session: { hash: "cccc0003", turn: 0, forkOf: "aaaa0001" } }), page(TAB_A));
    assert.equal(ix.get("cccc0003").forkedFrom, undefined);
    // a fork re-pointed later: unchanged
    ix.ingest(forkStart("dddd0004", "aaaa0001"), page(TAB_A));
    ix.ingest(step("dddd0004", 1, { session: { hash: "dddd0004", turn: 0, forkOf: "bbbb0002" } }), page(TAB_A));
    assert.deepEqual(ix.get("dddd0004").forkedFrom, { runtime: "local", hash: "aaaa0001" });
    // a repeated start for the same hash does not reassign it either
    ix.ingest(forkStart("dddd0004", "bbbb0002"), page(TAB_A));
    assert.deepEqual(ix.get("dddd0004").forkedFrom, { runtime: "local", hash: "aaaa0001" });
});

test("pageMoved: a background-hosted running session is on the new page, the row is returned, and the start url clears it", () => {
    const ix = index();
    ix.ingest(start("aaaa0001"), { ...bg(TAB_A), page: { url: "https://site/11", title: "Site" } });
    assert.equal(ix.get("aaaa0001").currentPage, undefined);
    const rows = ix.pageMoved(TAB_A, "https://other.example/x");
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].currentPage, { url: "https://other.example/x" });
    assert.deepEqual(ix.get("aaaa0001").currentPage, { url: "https://other.example/x" });
    assert.deepEqual(ix.get("aaaa0001").page, { url: "https://site/11", title: "Site", tabId: TAB_A }, "the start page stays");
    // a second move
    assert.deepEqual(ix.pageMoved(TAB_A, "https://third.example/")[0].currentPage, { url: "https://third.example/" });
    // back on the start page
    const back = ix.pageMoved(TAB_A, "https://site/11");
    assert.equal(back.length, 1);
    assert.equal("currentPage" in back[0], false);
    assert.equal("currentPage" in ix.get("aaaa0001"), false);
});

test("pageMoved leaves a page-hosted session, an ended one and another tab's alone, and an unchanged url returns nothing", () => {
    const ix = index();
    ix.ingest(start("aaaa0001"), page(TAB_A));                      // page-hosted
    ix.ingest(start("bbbb0002"), bg(TAB_A));                        // background, ends below
    ix.ingest(result("bbbb0002"), bg(TAB_A));
    ix.ingest(start("cccc0003"), bg(TAB_B));                        // another tab
    ix.ingest(start("dddd0004"), { ...bg(TAB_A), page: { url: "https://site/11" } });
    assert.equal(ix.pageMoved(TAB_A, "https://moved.example/").map((r) => r.id.hash).join(), "dddd0004");
    for (const h of ["aaaa0001", "bbbb0002", "cccc0003"]) assert.equal(ix.get(h).currentPage, undefined, h);
    assert.deepEqual(ix.pageMoved(TAB_A, "https://moved.example/"), [], "the same url again");
    assert.deepEqual(ix.pageMoved(999, "https://moved.example/"), [], "a tab with no session");
    // already on the start page and never moved
    const ix2 = index();
    ix2.ingest(start("aaaa0001"), { ...bg(TAB_A), page: { url: "https://site/11" } });
    assert.deepEqual(ix2.pageMoved(TAB_A, "https://site/11"), []);
});

test("a trusted session-resumed clears currentPage; the page's copy of the note does not", () => {
    const ix = index();
    const note = (url, id = "n1") => base("aaaa0001", "session-resumed", { url, id, fromUrl: "https://site/11", afterMs: 1, dropped: ["state"] });
    ix.ingest(start("aaaa0001"), { ...bg(TAB_A), page: { url: "https://site/11" } });
    ix.pageMoved(TAB_A, "https://other.example/");
    assert.ok(ix.get("aaaa0001").currentPage);
    ix.ingest(result("aaaa0001"), bg(TAB_A));
    ix.ingest(note("https://elsewhere.example/"), page(TAB_A));
    assert.deepEqual(ix.get("aaaa0001").currentPage, { url: "https://other.example/" }, "untrusted note changes nothing");
    const r = ix.ingest(note("https://resumed.example/", "n2"), bg(TAB_A));
    assert.equal(r.accepted, true, JSON.stringify(r));
    assert.equal(ix.get("aaaa0001").currentPage, undefined);
    assert.deepEqual(ix.get("aaaa0001").page, { url: "https://resumed.example/", tabId: TAB_A });
});

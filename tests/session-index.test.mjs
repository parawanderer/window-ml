// The local runtime's session index (src/session-index.ts): who may write into a session, what a list row says, which
// copies of an event are the same event, what the ring keeps, and the subscription opening sequence the contract
// defines (docs/spec/SESSION_CONTRACT.md).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("every event kind the index accepts has been considered for de-duplication", async () => {
    const src = await readFile(new URL("../src/session-index.ts", import.meta.url), "utf8");
    const known = [...src.slice(src.indexOf("const KNOWN_KINDS"), src.indexOf("\n", src.indexOf("const KNOWN_KINDS"))).matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
    assert.ok(known.length >= 12, `found ${known.length} kinds`);

    // The rules are per KIND, and adding a kind means visiting the table rather than only the path that makes the
    // feature work: a kind with no rule is a kind that records the same event twice when the page's bus and the
    // background both report it, which is what `listPageSessions` makes routine. A kind that genuinely needs none
    // says so here, so the decision is made once and written down rather than made by omission.
    const NO_RULE_NEEDED = new Set([
        "agent-step",    // coalesced by step, and a repeat is the same step's later state
        "agent-stream",  // coalesced by step: the newest delta replaces the last
        "agent-turn",    // coalesced the same way, and carries no history of its own
        "agent-cap",     // last write wins: a cap is a number, not an occurrence
        "agent-say",     // paired with agent-say-seen, which is the one that can arrive twice
        "chat-error",    // ends a turn opened by `chat`, which is itself de-duplicated
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

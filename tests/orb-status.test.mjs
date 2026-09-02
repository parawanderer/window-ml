// Unit tests for the HUD orb's live status projection (sidebar/orb-status.ts). Pure functions over a run's
// state, so they're tested directly (no jsdom). Two halves, per the design: STREAMING gets the richer live
// detail (a ticking token count, the reply prose streamed live); NON-STREAMING degrades to what it can know
// (the humanized tool phase + a stall heartbeat), with no live token count (it can't, mid-generation).
import { test } from "node:test";
import assert from "node:assert";
import { orbStatus, activityFor, liveProseFor, liveTokensFor, fmtTokens, STALL_MS } from "../sidebar/orb-status.ts";

// Minimal Session fixtures — only the fields the projection reads.
const run = (over = {}) => ({ steps: [], says: [], lastTs: Date.now(), ...over });
const step = (over = {}) => ({ step: 1, seq: 1, ...over });

// ---- humanized tool phase (activityFor) ----

test("activityFor: a RUNNING tool shows its humanized label (not the bare tool name)", () => {
    const a = activityFor(run({ steps: [step({ tool: "python_exec", pending: true })] }));
    assert.equal(a.label, "Running Python…");
    assert.equal(a.icon, "🐍");
});

test("activityFor: a FINISHED tool → 'Thinking about the <output>…' (contextual, not a stale 'Running…' or bare 'Thinking')", () => {
    const a = activityFor(run({ steps: [step({ tool: "python_exec", pending: false })] }));
    assert.equal(a.label, "Thinking about the Python output…");   // the requested contextual phase
    assert.equal(a.icon, "💭");
});

test("activityFor: no tool yet this turn → bare 'Thinking…'", () => {
    assert.equal(activityFor(run({ steps: [step({ thought: "hmm" })] })).label, "Thinking…");
});

test("activityFor: a CUSTOM tool with no registered message degrades gracefully (running + finished)", () => {
    const running = activityFor(run({ steps: [step({ tool: "myScraper", pending: true })] }));
    assert.equal(running.label, "Running myScraper…");   // humanized fallback — accommodates an unregistered tool
    assert.equal(running.icon, "⚙️");
    const done = activityFor(run({ steps: [step({ tool: "myScraper", pending: false })] }));
    assert.equal(done.label, "Thinking about the result…");   // generic about-phrase fallback
});

test("activityFor: scopes to the CURRENT turn — a prior turn's tool doesn't leak into a fresh turn", () => {
    // A follow-up turn (say at step 1) then a thinking-only step 2: the turn-1 python_exec must NOT surface.
    const r = run({ steps: [step({ step: 1, tool: "python_exec", pending: false }), step({ step: 2, thought: "next" })],
        says: [{ text: "follow up", atStep: 1 }] });
    assert.equal(activityFor(r).label, "Thinking…");   // scoped past the say boundary → no leak
});

// ---- STREAMING: live token count + live reply prose ----

test("liveTokensFor: counts the streamed buffer (reasoning + content); null with no live stream", () => {
    assert.equal(liveTokensFor(run()), null);   // non-streaming → no count
    assert.equal(liveTokensFor(run({ liveStream: { step: 1, reasoning: "x".repeat(4800) } })), 1200);   // ~4 chars/token
    assert.equal(liveTokensFor(run({ liveStream: { step: 1, reasoning: "ab", content: "cd" } })), 1);
});

test("fmtTokens: quantized so a per-delta count doesn't jitter (≥1k → ~X.Xk; below → nearest 10)", () => {
    assert.equal(fmtTokens(1200), "~1.2k tok");
    assert.equal(fmtTokens(843), "~840 tok");
    assert.equal(fmtTokens(12), "~10 tok");
});

test("orbStatus (streaming reasoning): the thinking phase carries a LIVE token count and auto-expands", () => {
    const r = run({ steps: [step({ tool: "python_exec", pending: false })], liveStream: { step: 1, reasoning: "y".repeat(4800) } });
    const o = orbStatus(r, Date.now());
    assert.match(o.label, /Thinking about the Python output… \(~1\.2k tok\)/);   // phase + ticking count
    assert.equal(o.caption, true, "there's live detail → show it without a hover");
});

test("orbStatus (streaming reply prose): the model's in-between output streams live as the caption", () => {
    const r = run({ liveStream: { step: 1, content: "Here is the answer so far" } });
    const o = orbStatus(r, Date.now());
    assert.match(o.label, /Here is the answer so far/);
    assert.equal(o.icon, "💬");
    assert.equal(o.caption, true);
});

// ---- NON-STREAMING: no live count, but a stall heartbeat proves liveness ----

test("orbStatus (non-streaming): NO token count — it can't know mid-generation", () => {
    const o = orbStatus(run({ steps: [step({ tool: "python_exec", pending: true })], lastTs: Date.now() }), Date.now());
    assert.equal(o.label, "Running Python…");   // just the phase, no "(~… tok)"
    assert.doesNotMatch(o.label, /tok/);
});

test("orbStatus (non-streaming): a calm recent phase stays a BARE orb (caption false)", () => {
    const now = Date.now();
    const o = orbStatus(run({ steps: [step({ tool: "look", pending: true })], lastTs: now - 1000 }), now);
    assert.equal(o.caption, false, "within the stall window + no live detail → bare circle");
    assert.doesNotMatch(o.label, /·/);
});

test("orbStatus (non-streaming): a STALLED run appends an elapsed heartbeat and auto-expands (liveness)", () => {
    const now = Date.now();
    const o = orbStatus(run({ steps: [step({ tool: "python_exec", pending: true })], lastTs: now - 8000 }), now);
    assert.match(o.label, /Running Python… · 8s/);   // still-alive proof when nothing streams
    assert.equal(o.caption, true, "a stall is exactly the case we want visible");
    assert.ok(now - (now - 8000) > STALL_MS);
});

test("liveProseFor: the model's latest narration (its thought), stripped to one line; null without one", () => {
    assert.equal(liveProseFor(run({ steps: [step({ thought: "**Scanning** the table" })] })), "Scanning the table");
    assert.equal(liveProseFor(run({ steps: [step({ tool: "look" })] })), null);
});

// The delegated-sub-call token METER (bus.ts). The auto-wired look/locate/verify tools make their own
// ml.chat() vision calls; those emit `chat-result` debug events we SUPPRESS during an agent run (they're
// not real sessions). But their tokens are real spend the agent loop never sees — so emitDebug tallies them
// at the exact point it throws the event away. This guards: only chat-results DURING a run are metered, the
// tally sums prompt+completion, a reset clears it, and a non-run chat is ignored.
import { test } from "node:test";
import assert from "node:assert";

// bus.ts calls window.addEventListener at module load — stub a minimal window BEFORE importing it.
globalThis.window = { addEventListener() {}, postMessage() {} };
const { emitDebug, enterAgentRun, exitAgentRun, resetSubcallUsage, subcallUsage } = await import("../src/bus.ts");

const chatResult = (prompt, completion) => ({ kind: "chat-result", id: "x", ts: 0, save: false, session: { hash: "h", turn: 0 }, content: "", sources: null, structured: false, model: "m", extend: null, reasoning: null, usage: { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion } });

test("suppressed sub-call chat-results DURING a run are metered (prompt + completion, per call)", () => {
    resetSubcallUsage();
    enterAgentRun();
    try {
        emitDebug(chatResult(1000, 50));   // a delegated look
        emitDebug(chatResult(800, 30));    // a locate sub-call
        const u = subcallUsage();
        assert.equal(u.prompt, 1800);
        assert.equal(u.completion, 80);
        assert.equal(u.calls, 2);
    } finally { exitAgentRun(); }
});

test("resetSubcallUsage clears the tally (per-turn lifecycle)", () => {
    resetSubcallUsage();
    enterAgentRun();
    try {
        emitDebug(chatResult(500, 10));
        resetSubcallUsage();
        emitDebug(chatResult(200, 5));
        const u = subcallUsage();
        assert.equal(u.prompt, 200, "only the post-reset call is counted");
        assert.equal(u.calls, 1);
    } finally { exitAgentRun(); }
});

test("a chat-result OUTSIDE a run is never metered (it's a real session, not a sub-call)", () => {
    resetSubcallUsage();
    // no enterAgentRun → inAgentRun is 0
    emitDebug(chatResult(999, 99));
    assert.equal(subcallUsage().calls, 0, "outside a run, a chat isn't a suppressed sub-call");
});

test("the tally is CUMULATIVE across turns — a turn boundary (exit→enter) does NOT clear it", () => {
    // The bug: chat_metadata asked on turn 2 reported "none" because a per-turn reset wiped turn 1's
    // sub-call spend. The fix moved the reset to session-start (firstTurn) only, so exit/enter — a turn
    // boundary — must leave the tally intact; only resetSubcallUsage (a new session) clears it.
    resetSubcallUsage();
    enterAgentRun();
    emitDebug(chatResult(1000, 40));   // turn 1 did a locate sub-call
    exitAgentRun();                    // ← turn 1 ends
    enterAgentRun();                   // ← turn 2 begins (no reset)
    const u = subcallUsage();
    assert.equal(u.calls, 1, "turn 1's sub-call still counted on turn 2");
    assert.equal(u.prompt, 1000);
    exitAgentRun();
});

test("a chat-result with NO usage still suppresses but contributes nothing", () => {
    resetSubcallUsage();
    enterAgentRun();
    try {
        emitDebug({ kind: "chat-result", id: "x", ts: 0, save: false, session: { hash: "h", turn: 0 }, content: "", sources: null, structured: false, model: "m", extend: null, reasoning: null, usage: null });
        assert.equal(subcallUsage().calls, 0, "no usage → nothing to add");
    } finally { exitAgentRun(); }
});

// --- what spend needs from a sub-call ---

test("a metered sub-call keeps what spend reads from its usage: raw numbers, price snapshot, electricity price", () => {
    resetSubcallUsage();
    enterAgentRun();
    try {
        const prices = { fetchedAt: "2026-10-10T09:07:00Z", sources: { openrouter: "a".repeat(64) } };
        emitDebug({ kind: "chat-result", ts: 5, model: "reader", usage: { promptTokens: 10, completionTokens: 2, genMs: 40,
            raw: { prompt_tokens: 10, completion_tokens: 2, cost: 0.0001 }, prices, electricity: { perKwh: 0.3, currency: "EUR" } } });
        emitDebug(chatResult(5, 1));
        const [withSpend, plain] = subcallUsage().calls_;
        assert.deepStrictEqual(withSpend, { model: "reader", ts: 5, ms: 40, prompt: 10, completion: 2,
            raw: { prompt_tokens: 10, completion_tokens: 2, cost: 0.0001 }, prices, electricity: { perKwh: 0.3, currency: "EUR" } });
        assert.ok(!("raw" in plain) && !("prices" in plain) && !("electricity" in plain), "nothing reported, nothing added");
    } finally { exitAgentRun(); }
});

test("a worker tool's spend delta carries the calls made between the two reads, not the earlier ones", async () => {
    const { spendDelta } = await import("../src/sw/worker-tools.ts");
    const call = (ts) => ({ model: "m", ts, ms: 1, prompt: 1, completion: 1, prices: { fetchedAt: "t", sources: {} } });
    const before = { prompt: 1, completion: 1, calls: 1, byModel: [{ model: "m", prompt: 1, completion: 1, calls: 1 }], calls_: [call(1)] };
    const after = { prompt: 3, completion: 3, calls: 3, byModel: [{ model: "m", prompt: 3, completion: 3, calls: 3 }], calls_: [call(1), call(2), call(3)] };
    assert.deepStrictEqual(spendDelta(before, after).calls_.map((c) => c.ts), [2, 3]);
});

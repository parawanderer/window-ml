// The delegated-sub-call token METER (bus.ts). The auto-wired look/locate/verify tools make their own
// ml.chat() vision calls; those emit `chat-result` debug events we SUPPRESS during an agent run (they're
// not real sessions). But their tokens are real spend the agent loop never sees — so emitDebug tallies them
// at the exact point it throws the event away. This guards: only chat-results DURING a run are metered, the
// tally sums prompt+completion, a reset clears it, and a non-run chat is ignored.
import { test } from "node:test";
import assert from "node:assert";

// bus.ts calls window.addEventListener at module load — stub a minimal window BEFORE importing it.
globalThis.window = { addEventListener() {}, postMessage() {} };
const { emitDebug, enterAgentRun, exitAgentRun, resetSubcallUsage, subcallUsage } = await import("../bus.ts");

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

test("a chat-result with NO usage still suppresses but contributes nothing", () => {
    resetSubcallUsage();
    enterAgentRun();
    try {
        emitDebug({ kind: "chat-result", id: "x", ts: 0, save: false, session: { hash: "h", turn: 0 }, content: "", sources: null, structured: false, model: "m", extend: null, reasoning: null, usage: null });
        assert.equal(subcallUsage().calls, 0, "no usage → nothing to add");
    } finally { exitAgentRun(); }
});

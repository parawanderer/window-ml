// reducer-chat-steps.test.mjs — a chat turn's tool calls in the client's reducer (src/sidebar/debug-reducer.ts): an
// `agent-step` that names its turn (`turn`) waits for that turn, so it is never drawn under an answer it did not feed,
// and a session stored before steps named a turn reduces as it did.

import test from "node:test";
import assert from "node:assert/strict";
import { onDebug, forgetSessionReduced, awaitingStart } from "../src/sidebar/debug-reducer.ts";
import { sessionMap } from "../src/sidebar/store.ts";

const chat = (hash, n, user = `q${n}`) => ({
    kind: "chat", id: `${hash}-${n}`, ts: 1000 * n, save: false, session: { hash, turn: n }, streaming: false,
    request: { model: "m", extend: null, messages: [{ role: "user", content: user }], images: null, toolIds: null, schema: false, think: null, maxTokens: null },
    config: { system: null, model: "m", think: null, schema: false, toolIds: null, maxTokens: null, save: false },
});
const result = (hash, n, content = `a${n}`) => ({ kind: "chat-result", id: `${hash}-${n}`, ts: 1000 * n + 500, save: false, session: { hash, turn: n }, content, sources: null, structured: false, model: "m", extend: null, reasoning: null, usage: null });
/** A `read_pages` step of turn `n` (its id), pending or done. */
const step = (hash, n, seq, over = {}) => ({
    kind: "agent-step", id: `${hash}-${n}`, ts: 1000 * n + 100 + seq, save: false, session: { hash, turn: n }, step: seq, seq, turn: `${hash}-${n}`,
    tool: "read_pages", arguments: { file: "a.pdf", pages: "3" }, ...over,
});
const plain = (v) => JSON.parse(JSON.stringify(v));

// --- a step waits for the turn it names ---

test("a chat step that arrives BEFORE its chat is not in steps, and appears, keeping `turn`, once the chat arrives", () => {
    const h = "cst00001";
    forgetSessionReduced(h);
    onDebug(step(h, 1, 1, { pending: true }));
    assert.equal(sessionMap.has(h), false, "no session is manufactured from a stray step");
    assert.equal(awaitingStart(h), true);
    onDebug(step(h, 1, 1, { result: "page text" }));
    onDebug(chat(h, 1));
    const s = sessionMap.get(h);
    assert.equal(s.turns.length, 1);
    assert.equal(s.steps.length, 1, "pending and done of one seq are one row");
    assert.equal(s.steps[0].turn, `${h}-1`);
    assert.equal(s.steps[0].result, "page text");
    assert.equal(s.steps[0].pending, undefined);
    assert.equal(awaitingStart(h), false);
});

test("a step of a LATER turn, arriving while the session holds only earlier ones, waits for that turn's chat", () => {
    const h = "cst00002";
    forgetSessionReduced(h);
    onDebug(chat(h, 1)); onDebug(result(h, 1));
    onDebug(step(h, 2, 1, { result: "r" }));
    assert.deepEqual(sessionMap.get(h).steps ?? [], [], "not drawn under turn 1");
    assert.equal(sessionMap.get(h).turns.length, 1);
    onDebug(chat(h, 2));
    const s = sessionMap.get(h);
    assert.deepEqual(s.steps.map((x) => [x.seq, x.turn]), [[1, `${h}-2`]]);
    assert.equal(s.turns.length, 2);
});

test("a step whose `turn` names a turn never sent stays out of steps, and creates no turn", () => {
    const h = "cst00003";
    forgetSessionReduced(h);
    onDebug(chat(h, 1)); onDebug(result(h, 1));
    const before = plain(sessionMap.get(h));
    onDebug(step(h, 9, 1, { result: "r" }));
    onDebug(step(h, 1, 2, { turn: "cst00003-77", result: "r" }));
    const s = sessionMap.get(h);
    assert.deepEqual(s.steps ?? [], []);
    assert.deepEqual(plain(s.turns), before.turns, "no turn was created or changed");
    assert.equal(s.status, before.status);
});

test("a step in turn 1 of a session that holds it applies at once, in order, and a repeat of its done is the same row", () => {
    const h = "cst00004";
    forgetSessionReduced(h);
    onDebug(chat(h, 1));
    onDebug(step(h, 1, 1, { pending: true }));
    assert.equal(sessionMap.get(h).steps.length, 1);
    assert.equal(sessionMap.get(h).steps[0].pending, true);
    onDebug(step(h, 1, 1, { result: "r" }));
    onDebug(step(h, 1, 2, { result: "r2" }));
    onDebug(step(h, 1, 2, { result: "r2" }));
    assert.deepEqual(sessionMap.get(h).steps.map((x) => [x.seq, x.pending ?? false, x.result]), [[1, false, "r"], [2, false, "r2"]]);
});

// --- UPGRADE: a session stored before a step named its turn ---

test("UPGRADE: a chat holding a step with NO `turn` keeps its turns, answers and status exactly as without the step", () => {
    const h = "cst00005";
    const run = (withStep) => {
        forgetSessionReduced(h);
        onDebug(chat(h, 1)); onDebug(result(h, 1, "first answer"));
        onDebug(chat(h, 2));
        if (withStep) onDebug(step(h, 1, 1, { turn: undefined, result: "old" }));
        onDebug(result(h, 2, "second answer"));
        return plain(sessionMap.get(h));
    };
    const without = run(false);
    const upgraded = run(true);
    // `steps` is the step itself, and `ended: false` is what any step says of its run (the agent path's flag, untouched).
    const { steps, ended, ...rest } = upgraded;
    const { steps: none, ended: noEnd, ...base } = without;
    assert.deepEqual(rest, base);
    assert.equal(steps.length, 1, "the step is kept, where it was kept before");
    assert.equal(steps[0].turn, undefined);
    assert.deepEqual(upgraded.turns.map((t) => [t.assistant, t.status]), [["first answer", "ok"], ["second answer", "ok"]]);
    assert.equal(upgraded.status, "ok");
});

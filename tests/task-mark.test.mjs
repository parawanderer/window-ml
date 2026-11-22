// task-mark.test.mjs — rule 4b slice E, the HUD half: the words of the card's task mark, and the reducer holding the
// worker's `agent-tasks` notice on the run. The worker's emitting it is in task-row.test.mjs; a page writing one is
// refused in event-admission.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { taskMarkText } from "../src/sidebar/transcript/task-mark-text.ts";
import { onDebug, forgetSessionReduced } from "../src/sidebar/debug-reducer.ts";
import { sessionMap } from "../src/sidebar/store.ts";

// --- the mark's wording ---

test("no tasks, or both counts 0, is no mark", () => {
    for (const bg of [null, undefined, { running: 0, waiting: 0 }]) assert.equal(taskMarkText(bg), null);
});

test("running only, waiting only, and both, with their plurals", () => {
    assert.equal(taskMarkText({ running: 1, waiting: 0 }), "1 running in background");
    assert.equal(taskMarkText({ running: 3, waiting: 0 }), "3 running in background");
    assert.equal(taskMarkText({ running: 0, waiting: 1 }), "1 result waiting");
    assert.equal(taskMarkText({ running: 0, waiting: 2 }), "2 results waiting");
    assert.equal(taskMarkText({ running: 2, waiting: 1 }), "2 running · 1 result waiting");
    assert.equal(taskMarkText({ running: 1, waiting: 2 }), "1 running · 2 results waiting");
});

test("a count that is not a whole non-negative number is not shown as one", () => {
    assert.equal(taskMarkText({ running: -3, waiting: 0 }), null);
    assert.equal(taskMarkText({ running: NaN, waiting: 1 }), "1 result waiting");
    assert.equal(taskMarkText({ running: 1.9, waiting: 0 }), "1 running in background");
});

// --- the reducer keeps the run's counts ---

const H = "task-mark-run";
const start = { kind: "agent", session: { hash: H }, ts: 1000, task: "t", model: "m", maxSteps: 5 };
const tasks = (background) => ({ kind: "agent-tasks", id: H, ts: 1100, save: false, session: { hash: H, turn: 0 }, background });

test("agent-tasks sets the run's background, a later one replaces it, and null clears it", () => {
    forgetSessionReduced(H); sessionMap.delete(H);
    onDebug(start);
    assert.equal(sessionMap.get(H).background, undefined);
    onDebug(tasks({ running: 1, waiting: 0 }));
    assert.deepEqual(sessionMap.get(H).background, { running: 1, waiting: 0 });
    onDebug(tasks({ running: 0, waiting: 2 }));
    assert.deepEqual(sessionMap.get(H).background, { running: 0, waiting: 2 });
    onDebug(tasks(null));
    assert.equal(sessionMap.get(H).background, undefined);
    onDebug(tasks({ running: 0, waiting: 0 }));
    assert.equal(sessionMap.get(H).background, undefined, "a zero pair is no mark");
});

test("agent-tasks for a run the panel has not seen makes no session", () => {
    forgetSessionReduced("unseen-run"); sessionMap.delete("unseen-run");
    onDebug({ ...tasks({ running: 1, waiting: 0 }), session: { hash: "unseen-run", turn: 0 } });
    assert.equal(sessionMap.has("unseen-run"), false);
});

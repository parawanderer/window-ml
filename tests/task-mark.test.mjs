// task-mark.test.mjs — rule 4b slice E, the HUD half: the words of the card's task mark, and the reducer holding the
// worker's `agent-tasks` notice on the run. The worker's emitting it is in task-row.test.mjs; a page writing one is
// refused in event-admission.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { backgroundOf } from "../src/contract/contract-debug.ts";
import { taskMarkText } from "../src/chat/task-mark-text.ts";
import { onDebug, forgetSessionReduced } from "../src/sidebar/debug-reducer.ts";
import { sessionMap } from "../src/sidebar/store.ts";

// --- backgroundOf: the one presence rule, enumerated ---

test("backgroundOf over every combination: present exactly when something is true, carrying only the true fields", () => {
    let n = 0;
    for (const running of [0, 1]) for (const waiting of [0, 1]) for (const noTab of [undefined, true]) for (const releaseAt of [undefined, 1700000000000]) {
        n++;
        const got = backgroundOf({ running, waiting, ...(noTab ? { noTab } : {}), ...(releaseAt !== undefined ? { releaseAt } : {}) });
        const something = running > 0 || waiting > 0 || noTab === true || releaseAt !== undefined;
        const label = JSON.stringify({ running, waiting, noTab, releaseAt });
        assert.equal(got !== undefined, something, label);
        if (got) assert.deepEqual(got, { running, waiting, ...(noTab ? { noTab: true } : {}), ...(releaseAt !== undefined ? { releaseAt } : {}) }, label);
    }
    assert.equal(n, 16);
});

test("backgroundOf: null and undefined are none, a falsy noTab is dropped, a bad count is 0, and the input is copied", () => {
    assert.equal(backgroundOf(null), undefined);
    assert.equal(backgroundOf(undefined), undefined);
    assert.equal(backgroundOf({ running: 0, waiting: 0, noTab: false }), undefined);
    assert.equal(backgroundOf({ running: -2, waiting: NaN }), undefined);
    assert.equal(backgroundOf({ running: 0, waiting: 0, releaseAt: NaN }), undefined);
    const input = { running: 2, waiting: 0, noTab: true };
    const out = backgroundOf(input);
    assert.deepEqual(out, input);
    assert.notEqual(out, input);
});

// --- the mark's wording ---

test("no tasks, or both counts 0, is no mark", () => {
    for (const bg of [null, undefined, { running: 0, waiting: 0 }]) assert.equal(taskMarkText(bg), null);
});

test("0/0 with noTab or releaseAt is still no mark: the card shows counts only", () => {
    assert.equal(taskMarkText({ running: 0, waiting: 0, noTab: true }), null);
    assert.equal(taskMarkText({ running: 0, waiting: 0, releaseAt: 5000 }), null);
    assert.equal(taskMarkText({ running: 0, waiting: 1, noTab: true, releaseAt: 5000 }), "1 result waiting");
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

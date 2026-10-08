// tab-replaced.test.mjs — a tab that comes back under a NEW id (a discard the browser restored, a prerender
// swapped in). `chrome.tabs.onReplaced` is the only notice of it: no navigation commits and nothing is removed,
// so every map the worker keys by tab is left filed under an id nothing will ever send again.
"use strict";
import { test } from "node:test";
import assert from "node:assert";
import { moveTabKey } from "../src/sw/tab-replaced.ts";

// --- re-filing per-tab state when the id changes ---

test("everything the tab owned follows it, and nothing else moves", () => {
    const runs = new Map([[7, new Set(["r1"])], [9, new Set(["r2"])]]);
    const replay = new Map([[7, ["a", "b"]]]);
    const untouched = new Map([[9, "mine"]]);
    assert.equal(moveTabKey([runs, replay, untouched], 7, 12), 2, "only the maps that held 7");
    assert.deepEqual([...runs.get(12)], ["r1"]);
    assert.deepEqual(replay.get(12), ["a", "b"]);
    assert.equal(runs.has(7), false);
    assert.equal(replay.has(7), false);
    assert.deepEqual([...runs.get(9)], ["r2"], "another tab's state is left alone");
    assert.equal(untouched.get(9), "mine");
});

test("a tab we were not tracking reports nothing moved", () => {
    const runs = new Map([[1, new Set(["r"])]]);
    assert.equal(moveTabKey([runs], 7, 12), 0);
    assert.equal(runs.size, 1);
});

test("the same id is a no-op, not a delete", () => {
    // Chrome has handed back the id it already had in the past; re-filing 7 as 7 by set-then-delete would
    // silently drop the run.
    const runs = new Map([[7, new Set(["r1"])]]);
    assert.equal(moveTabKey([runs], 7, 7), 0);
    assert.deepEqual([...runs.get(7)], ["r1"]);
});

test("an id already in use is overwritten, because its old tenant is gone", () => {
    const runs = new Map([[7, "new"], [12, "stale"]]);
    moveTabKey([runs], 7, 12);
    assert.equal(runs.get(12), "new");
});

test("the identity of the value is kept, not a copy — live objects are shared with their holders", () => {
    const set = new Set(["r1"]);
    const runs = new Map([[7, set]]);
    moveTabKey([runs], 7, 12);
    assert.equal(runs.get(12), set, "a reader holding this Set must keep seeing the same one");
});

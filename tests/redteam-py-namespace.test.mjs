// redteam-py-namespace.test.mjs — the red-team pass on the Python namespace's new lifetime (async/py-namespace-per-run:
// offscreen `PY_END_TURN`, `src/sw/sw-python.ts` `endPythonTurn`, `src/python/py-reap.ts`), the half the lane's own
// rows (tests/python-reap.test.mjs, tests/python-run-namespace.test.mjs, tests/python-keep.test.mjs) do not press:
// WHAT A PERSON'S SETTING CAN TURN THE DELAY INTO, and WHO A RUN'S CELLS CAN EVER SHARE A WORKER WITH.
//
// The ruled sentence this file is about is the spec's: "the namespace belongs to the RUN … an idle reap between turns
// (`pythonIdleMinutes`, default 10)". Two properties follow, and both are asserted here rather than assumed:
//   (1) the person's setting reaches the sandbox WHOLE, and the sandbox's between-turns decision does not shorten it.
//       The service worker hands the delay to the offscreen document as `PY_END_TURN { run, ms }`. At 40f031aa that
//       document passed `ms` straight to `setTimeout`, and a delay above 2147483647 is not a long wait: `setTimeout`
//       clamps it (Node: "TimeoutOverflowWarning … set to 1"; the HTML spec sets an above-range timeout to 0), so the
//       reap fired at once and the namespace was dropped immediately after every turn's end. The panel's input is
//       `<input type="number" min="0" step="1">` with no maximum, so "effectively never" is 40000 or 100000.
//       f73ec953 fixes that by STEPPING the timer (`longTimeout`, py-reap.ts) rather than clamping the value, which
//       is the right fix: a clamp at either end silently turns the person's 40000 minutes into 35791 and tells the run
//       it waited less than it did. So the property to pin on this seam is not "ms fits a timer" — at this head it
//       legitimately does not (100000 minutes is 6e9 ms) — but that NEITHER side shortens it: the worker hands the
//       setting exactly, and `reapDelay` returns it exactly. Rows A red when either is clamped; the timer's step
//       arithmetic is the lane's own row ("a delay past setTimeout's limit waits its full length", python-reap).
//   (2) one run's cell never shares a worker with another run's. The per-run principal is what makes that true (one
//       Worker per principal, offscreen.ts `ensureWorker`); the turn-end clean-up of a SHARED principal is a second
//       wall, and this file pins the first one so a future change that routes a run's cells to a shared principal
//       reds here, where the cross-run read would live.
//
// MEASURED AT 40f031aa (the branch head at the time, after `node build.mjs`, through tests/ml-wire-harness.mjs, run
// 20261113T080411-e7d248): pythonIdleMinutes 3 → PY_END_TURN ms=180000; 0 → 0; 35791 → 2147460000 (fits);
// 35792 → 2147520000; 40000 → 2400000000; 100000 → 6000000000. The last three are above the 32-bit timer cap, which
// that head's offscreen then handed to setTimeout unstepped: the reap fired immediately. The failing-first row for it
// asserted `ms <= MAX_TIMER_MS` and was red on that head with the todo stripped (pass 1 / fail 1 in the run above).
//
// MEASURED AT f73ec953 (the fix head, runs 20261113T084731-a7e6c6 and 20261113T084759-f4e69d): row A green as
// rewritten below; row B green; row B red with a cell's `principal` changed to `"full"` in src/sw/sw-python.ts ("run 0:
// a cell ran on full, not its own principal"); row A red against a `Math.min(ms, MAX_TIMER_MS)` clamp in
// endPythonTurn ("40000 min reached PY_END_TURN as 2147483647") and against the same clamp inside reapDelay ("40000 min
// was shortened to 2147483647 by the reap decision"). A clamp inside reapDelay changes no built file, so that cell was
// run twice: the first red at a stale dist still carrying the endPythonTurn clamp was the other mutation's, and only
// the fresh-dist run counts.
import { test } from "node:test";
import assert from "node:assert/strict";

// --- A. the person's idle limit reaches the sandbox whole, and the sandbox does not shorten it ---

test("a turn's end hands the sandbox exactly the person's pythonIdleMinutes, and the between-turns decision returns it unchanged, however large", async () => {
    const { wireRun } = await import("./ml-wire-harness.mjs");
    const { reapDelay, MAX_TIMER_MS } = await import("../src/python/py-reap.ts");
    // The cap's boundary in the unit this test uses: 35791 whole minutes still fit, 35792 is the first that does not.
    assert.ok(35791 * 60_000 <= MAX_TIMER_MS && 35792 * 60_000 > MAX_TIMER_MS, "the setting's boundary moved; re-derive these four values");
    for (const minutes of [3, 35791, 40000, 100000]) {
        const { bg } = await wireRun(async () => {}, { configExtra: { pythonIdleMinutes: minutes } });
        await new Promise((r) => setTimeout(r, 10));
        // One run in this harness, so its turn's one end: the PR's own row reads the list the same way.
        const ends = bg.pyEnds;
        assert.equal(ends.length, 1, `${minutes} min: one PY_END_TURN per settled turn, got ${ends.length}`);
        const ms = ends[0].ms;
        // The setting arrives whole: no clamp and no wrap on the way out of the worker, or the sandbox schedules a
        // shorter wait than the person asked for and tells the run it waited that shorter time.
        assert.equal(ms, minutes * 60_000, `${minutes} min reached PY_END_TURN as ${ms}; the person's setting must arrive unshortened`);
        // And the sandbox's own between-turns decision must return it unchanged for the same reason: the step belongs
        // in the timer (longTimeout), never in the value.
        assert.equal(reapDelay("run:abc", true, false, true, ms), ms, `${minutes} min was shortened to ${reapDelay("run:abc", true, false, true, ms)} by the reap decision`);
    }
});

// --- B. a run's cells never share a worker with another run's ---

test("every cell of a worker-hosted run runs on that run's own principal, so no other run's worker can hold its names", async () => {
    const { wireRun } = await import("./ml-wire-harness.mjs");
    const seen = [];
    for (let i = 0; i < 2; i++) {
        let wire;
        const { bg } = await wireRun(async (w) => { wire = w; });
        assert.ok(wire?.run, `run ${i}: positive control, the cell ran with a run id`);
        // PY_PREWARM shares the list with PY_RUN; only a run's own cells decide whose worker holds its dict.
        const cells = bg.pyRuns.filter((m) => m.type === "PY_RUN");
        assert.ok(cells.length > 0, `run ${i}: positive control, at least one cell was posted`);
        for (const m of cells) {
            assert.equal(m.principal, `run:${wire.run}`, `run ${i}: a cell ran on ${m.principal}, not its own principal`);
            assert.notEqual(m.principal, "full", `run ${i}: a cell ran on the shared principal, where another run's cell could read it`);
            assert.equal(m.hardened, true, `run ${i}: a cell was posted to an unhardened worker`);
        }
        seen.push(`run:${wire.run}`);
    }
    // Two runs, two principals: neither can address the other's dict, which is what "one run's cell never sees another
    // run's names" means mechanically.
    assert.equal(new Set(seen).size, seen.length, `two runs shared a principal: ${seen.join(", ")}`);
    assert.ok(seen.every((p) => /^run:[A-Za-z0-9_-]{1,64}$/.test(p)), `a principal is not a run's: ${seen.join(", ")}`);
});

// Standalone tests for the background navigation barrier (nav-barrier.ts): the per-tab gate that holds a
// delegated tool call while the page is navigating, releasing it only when the new document re-adopts the
// run. Timers are injected so the timeout fallback is deterministic (no real clock).
import { test } from "node:test";
import assert from "node:assert";
import { createNavBarrier } from "../src/nav-barrier.ts";

// A controllable timer: nothing fires until the test fires it.
function manualTimers() {
    const pending = new Map();
    let id = 0;
    return {
        set: (fn, ms) => { const h = ++id; pending.set(h, { fn, ms }); return h; },
        clear: (h) => pending.delete(h),
        fireAll: () => { for (const [h, t] of [...pending]) { pending.delete(h); t.fn(); } },
        count: () => pending.size,
    };
}

test("whenReady resolves immediately when the tab is idle (no navigation in flight)", async () => {
    const b = createNavBarrier();
    await b.whenReady(1);   // must not hang
    assert.equal(b.isNavigating(1), false);
});

test("a delegated tool is HELD during navigation and released on re-adopt", async () => {
    const b = createNavBarrier();
    b.noteNavigating(7);
    assert.equal(b.isNavigating(7), true);

    let released = false;
    const p = b.whenReady(7).then(() => { released = true; });
    await Promise.resolve();
    assert.equal(released, false, "still held while the new page hasn't re-adopted");

    b.noteReadopted(7);
    await p;
    assert.equal(released, true, "released once the new document re-adopted the run");
    assert.equal(b.isNavigating(7), false);
});

test("re-adopt releases ALL waiters queued during the same navigation", async () => {
    const b = createNavBarrier();
    b.noteNavigating(3);
    const flags = [false, false, false];
    const ps = flags.map((_, i) => b.whenReady(3).then(() => { flags[i] = true; }));
    b.noteReadopted(3);
    await Promise.all(ps);
    assert.deepEqual(flags, [true, true, true]);
});

test("timeout fallback: a navigation that never re-adopts still releases the loop (never wedges)", async () => {
    const timers = manualTimers();
    const b = createNavBarrier(timers.set, timers.clear);
    b.noteNavigating(9);
    let released = false;
    const p = b.whenReady(9, 15000).then(() => { released = true; });
    await Promise.resolve();
    assert.equal(released, false);
    assert.equal(timers.count(), 1, "a timeout timer is armed");
    timers.fireAll();   // the load never completed → the fallback fires
    await p;
    assert.equal(released, true, "the held tool proceeds (and will get the normal 'no active run' error)");
});

test("a re-adopt cancels the timeout timer (no late double-fire)", async () => {
    const timers = manualTimers();
    const b = createNavBarrier(timers.set, timers.clear);
    b.noteNavigating(2);
    const p = b.whenReady(2, 15000);
    assert.equal(timers.count(), 1);
    b.noteReadopted(2);
    await p;
    assert.equal(timers.count(), 0, "the armed timer was cleared on re-adopt");
});

test("forget() drops state and releases any pending waiter (run ended / tab closed)", async () => {
    const b = createNavBarrier();
    b.noteNavigating(5);
    let released = false;
    const p = b.whenReady(5).then(() => { released = true; });
    b.forget(5);
    await p;
    assert.equal(released, true, "a waiter isn't stranded when the tab/run disappears");
    assert.equal(b.isNavigating(5), false);
});

test("noteReadopted on an unknown tab is a harmless no-op", () => {
    const b = createNavBarrier();
    assert.doesNotThrow(() => b.noteReadopted(999));
});

test("tabs are independent — one navigating doesn't hold another", async () => {
    const b = createNavBarrier();
    b.noteNavigating(1);
    await b.whenReady(2);   // tab 2 is idle → resolves despite tab 1 navigating
    assert.equal(b.isNavigating(1), true);
    assert.equal(b.isNavigating(2), false);
});

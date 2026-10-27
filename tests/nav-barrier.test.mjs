// Standalone tests for the background navigation barrier (nav-barrier.ts): the per-tab gate that holds a
// delegated tool call while the page is navigating, releasing it only when the new document re-adopts the
// run. Timers are injected so the timeout fallback is deterministic (no real clock).
import { test } from "node:test";
import assert from "node:assert";
import { createNavBarrier } from "../src/sw/nav-barrier.ts";

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
    assert.equal(released, true, "the held tool is released, told the page is not ready");
});

// --- a re-adopt that is not coming: said once, answered at once after (#1034) ---

test("whenReady answers whether the tab is ready: true when idle or re-adopted, false when the wait ran out", async () => {
    const timers = manualTimers();
    const b = createNavBarrier(timers.set, timers.clear);
    assert.equal(await b.whenReady(1), true, "idle");
    b.noteNavigating(1);
    const adopted = b.whenReady(1, 15000);
    b.noteReadopted(1);
    assert.equal(await adopted, true, "re-adopted");
    b.noteNavigating(1);
    const ranOut = b.whenReady(1, 15000);
    timers.fireAll();
    assert.equal(await ranOut, false, "the wait ran out");
});

test("once a wait on a navigation has run out, the next answers false at once, without arming a timer", async () => {
    const timers = manualTimers();
    const b = createNavBarrier(timers.set, timers.clear);
    b.noteNavigating(4);
    const first = b.whenReady(4, 15000);
    timers.fireAll();
    assert.equal(await first, false);
    assert.equal(await b.whenReady(4, 15000), false);
    assert.equal(timers.count(), 0, "no second wait");
    assert.equal(b.isNavigating(4), true, "a late re-adopt may still release it");
});

test("a late re-adopt, or a new navigation, ends the run-out: the next wait is a real one again", async () => {
    const timers = manualTimers();
    const b = createNavBarrier(timers.set, timers.clear);
    b.noteNavigating(6);
    const first = b.whenReady(6, 15000); timers.fireAll(); await first;
    assert.equal(b.noteReadopted(6), true, "the late re-adopt is accepted");
    assert.equal(await b.whenReady(6), true, "ready after it");
    b.noteNavigating(6);
    const second = b.whenReady(6, 15000); timers.fireAll(); await second;
    b.noteNavigating(6);   // the page navigated again while the re-adopt was missing
    let settled = false;
    const third = b.whenReady(6, 15000).then((r) => { settled = true; return r; });
    await Promise.resolve();
    assert.equal(settled, false, "a new navigation is waited for again");
    b.noteReadopted(6);
    assert.equal(await third, true);
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

// --- which document may release it: never the one being left (docs/spec/SITE_ACCESS.md, the ungated sends) ---

test("a re-adopt releases only during a navigation, and never from the document it is leaving", () => {
    const b = createNavBarrier();
    b.noteDocument(4, "old");
    assert.equal(b.accepts(4, "old"), false, "no navigation: nothing to release");
    b.noteNavigating(4);   // leaving defaults to the committed document
    assert.equal(b.noteReadopted(4, "old"), false, "the departing document");
    assert.equal(b.isNavigating(4), true, "still held");
    b.noteDocument(4, "new");
    assert.equal(b.accepts(4, "stale"), false, "a document that is not the committed one");
    assert.equal(b.noteReadopted(4, "new"), true);
    assert.equal(b.isNavigating(4), false);
});

test("the leaving document is fixed when the navigation starts: a commit, or a second note, does not move it", () => {
    const b = createNavBarrier();
    b.noteDocument(5, "a");
    b.noteNavigating(5, "a");
    b.noteDocument(5, "b");
    b.noteNavigating(5);   // onCommitted's own note, after the navigate path's: keeps "a"
    assert.equal(b.accepts(5, "a"), false);
    assert.equal(b.accepts(5, "b"), true);
});

test("null leaves nothing to refuse (a fresh document about to re-adopt); an unnamed document is judged on the navigation", () => {
    const b = createNavBarrier();
    b.noteDocument(6, "fresh");
    b.noteNavigating(6, null);
    assert.equal(b.accepts(6, "fresh"), true);
    assert.equal(b.accepts(6, undefined), true);
    b.noteReadopted(6, "fresh");
    assert.equal(b.accepts(6, undefined), false, "but not outside one");
});

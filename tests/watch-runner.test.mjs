// watch-runner.test.mjs — the watchdog on a spawned test runner's `exit` (scripts/watch-runner.mjs): the lost
// child-exit hang becomes a loud failure, and a live-but-stuck runner is killed at the cap. Every outcome the
// decision branches on is enumerated here, the defaults included.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { watchRunner, POLL_MS, CAP_MS } = await import("../scripts/watch-runner.mjs");

/** A stand-in for `spawn`'s return: an emitter with a pid, no process behind it. */
function fakeChild(pid = 4242) {
    const c = new EventEmitter();
    c.pid = pid;
    return c;
}

/** Drive `watchRunner` on `child`, with the clock and process probe replaced; the watchdog ticks are real timers. */
function watch(child, o = {}) {
    return watchRunner(child, {
        pollMs: o.pollMs ?? 5,
        capMs: o.capMs ?? 60_000,
        log: o.log ?? (() => {}),
        alive: o.alive ?? (() => true),
        kill: o.kill ?? (() => {}),
    });
}

// --- the default knobs have their own assertion, so moving one is a decision ---

test("the defaults are a 15 s liveness sample and a 45 min cap", () => {
    assert.equal(POLL_MS, 15_000);
    assert.equal(CAP_MS, 45 * 60_000);
});

// --- the normal path: `exit` decides ---

test("a runner that exits 0 resolves 0", async () => {
    const child = fakeChild();
    const p = watch(child);
    child.emit("exit", 0);
    assert.equal(await p, 0);
});

test("a runner that exits 7 resolves 7", async () => {
    const child = fakeChild();
    const p = watch(child);
    child.emit("exit", 7);
    assert.equal(await p, 7);
});

test("a runner killed by a signal resolves 1, as test.mjs's bare handler did", async () => {
    const child = fakeChild();
    const p = watch(child);
    child.emit("exit", null, "SIGKILL");
    assert.equal(await p, 1);
});

// --- spawn never started ---

test("a spawn error rejects with that error", async () => {
    const child = fakeChild();
    const p = watch(child);
    const err = new Error("spawn ENOENT");
    child.emit("error", err);
    await assert.rejects(p, (e) => e === err);
});

test("an error that settles during the constructor leaves no watchdog timer armed", async () => {
    const child = fakeChild();
    const err = new Error("spawn ENOENT");
    const killed = [];
    const origOn = child.on.bind(child);
    child.on = (ev, fn) => {
        if (ev === "error") fn(err); // fires while `watchRunner` is still building its timers
        return origOn(ev, fn);
    };
    await assert.rejects(watch(child, { capMs: 40, kill: (pid, sig) => killed.push([pid, sig]) }), (e) => e === err);
    await new Promise((r) => setTimeout(r, 80)); // well past the cap, which must not have been left armed
    assert.deepEqual(killed, [], "a leaked cap would have fired on a promise that already rejected");
});

// --- the lost-child-exit hang this exists for ---

test("a runner that is gone without an exit rejects with the lost-exit diagnostic", async () => {
    const child = fakeChild(29182);
    // capMs is short so a mutation that never takes the lost-exit path reds here in milliseconds, not at the default cap
    const p = watch(child, { alive: () => false, capMs: 40, pollMs: 5 });
    await assert.rejects(p, (e) => {
        assert.match(String(e.message), /watchdog: the runner \(pid 29182\) is gone and its exit never fired/);
        assert.match(String(e.message), /lost-child-exit/);
        return true;
    });
});

test("a still-alive runner does not take the lost-exit path", async () => {
    const child = fakeChild();
    let ticks = 0;
    const p = watch(child, {
        pollMs: 5,
        capMs: 2_000, // tick 2 lands in ~10 ms; the cap is a backstop if the exit never comes, not a race with it
        alive: () => {
            ticks += 1;
            if (ticks >= 2) queueMicrotask(() => child.emit("exit", 0));
            return true;
        },
    });
    assert.equal(await p, 0);
    assert.ok(ticks >= 2, "the liveness sample ran while the child lived, and never called it gone");
});

// --- the live-but-stuck backstop ---

test("a runner still alive at the cap is SIGTERMed and the wait rejects", async () => {
    const child = fakeChild(53192);
    const killed = [];
    const said = [];
    const p = watch(child, {
        alive: () => true,
        capMs: 20,
        pollMs: 10_000,
        kill: (pid, sig) => killed.push([pid, sig]),
        log: (s) => said.push(s),
    });
    await assert.rejects(p, /exceeded .* min \(cap\): a stuck run/);
    assert.deepEqual(killed, [[53192, "SIGTERM"]]);
    assert.equal(said.length, 1);
    assert.match(said[0], /still alive after .* min: sending SIGTERM/);
});

test("a runner that exits just before the cap is not killed, and the cap timer is cleared", async () => {
    const child = fakeChild();
    const killed = [];
    const p = watch(child, { capMs: 5, pollMs: 10_000, kill: (pid, sig) => killed.push([pid, sig]) });
    child.emit("exit", 0);
    assert.equal(await p, 0);
    await new Promise((r) => setTimeout(r, 80)); // well past the cap, which must have been cleared
    assert.deepEqual(killed, [], "the cap timer was cleared with the exit");
});

// --- one settlement, whichever path got there first ---

test("a failure clears the cap timer too, so a late exit is not also a kill", async () => {
    const child = fakeChild();
    const killed = [];
    const p = watch(child, { alive: () => false, capMs: 5, pollMs: 5, kill: (pid, sig) => killed.push([pid, sig]) });
    await assert.rejects(p, /lost-child-exit/);
    child.emit("exit", 0); // late: must not flip the outcome
    await assert.rejects(p, /lost-child-exit/);
    await new Promise((r) => setTimeout(r, 80)); // well past the cap, which must have been cleared
    assert.deepEqual(killed, [], "the cap timer was cleared with the lost-exit failure");
});

// --- the wire: test.mjs must call it, or the helper is a well-tested bystander ---

test("test.mjs's runFiles waits through watchRunner, not a bare on(\"exit\")", () => {
    const src = readFileSync(path.join(ROOT, "scripts", "test.mjs"), "utf8");
    assert.match(src, /import \{ watchRunner \} from "\.\/watch-runner\.mjs"/);
    assert.match(src, /watchRunner\(child\)/);
    assert.doesNotMatch(src, /\.on\("exit", \(c\) => process\.exit/, "the bare handler must be gone");
});

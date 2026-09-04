// The server's own edges, turned into what the lane draws.
//
// This is the half of the resource panel that polling cannot do at all: for most of a load there is no runner
// object in Ollama for a poll to observe (measured on the box — `load.start` at t=4102, `load.complete` at
// t=48053, `/api/ps` empty across the whole span), so every load span the panel used to draw was
// reconstructed from the `load_duration` of whichever request happened to be waiting.
import test from "node:test";
import assert from "node:assert/strict";
import { machineEventFrom, servingSince } from "../src/sidebar/vram.tsx";

const reset = () => { servingSince.value = {}; };

test("a load is ONE span with two halves, closed by the edge that ends it", () => {
    reset();
    // The opening edges emit nothing on their own: a span with only a left edge would have to invent a right.
    assert.equal(machineEventFrom({ kind: "load.start", model: "m" }, 1000), null);
    assert.equal(machineEventFrom({ kind: "load.weights", model: "m" }, 5000), null);

    const span = machineEventFrom({ kind: "load.complete", model: "m" }, 10_000);
    assert.equal(span.kind, "load");
    assert.equal(span.t, 1000, "it starts where the load started, not where it finished");
    assert.equal(span.until, 10_000);
    // weights / context, NOT weights / warmup: the second half allocates the KV cache and compute buffers,
    // which on a long-context model is most of the model's footprint. "Resident at 5s, usable at 10s".
    assert.deepEqual(span.phases, [{ kind: "weights", until: 5000 }, { kind: "context", until: 10_000 }]);
});

test("a load with no boundary reported draws as one span, not an invented divider", () => {
    reset();
    machineEventFrom({ kind: "load.start", model: "m" }, 1000);
    const span = machineEventFrom({ kind: "load.complete", model: "m" }, 10_000);
    assert.ok(!span.phases, "no boundary, no divider — a phase label is a claim about what the machine did");
});

test("a boundary OUTSIDE the span is refused rather than clamped", () => {
    reset();
    machineEventFrom({ kind: "load.start", model: "m" }, 1000);
    // A stale `load.weights` from a previous load of the same model, arriving after this one started.
    machineEventFrom({ kind: "load.weights", model: "m" }, 900);
    assert.ok(!machineEventFrom({ kind: "load.complete", model: "m" }, 10_000).phases,
        "a divider before the span's own start is not a divider");
});

test("a load.complete with no start is DROPPED — half a span invents its left edge", () => {
    reset();
    // What a reconnect mid-load looks like: the ring replayed the completion but not the start.
    assert.equal(machineEventFrom({ kind: "load.complete", model: "m" }, 10_000), null);
});

test("serving: the span runs from busy.start to busy.end, and is live in between", () => {
    reset();
    assert.equal(machineEventFrom({ kind: "busy.start", model: "m" }, 10_000), null);
    // Open, so the lane can draw it against the clock while it is still happening — the fact the panel most
    // wants to show while you watch is that the box is working right now.
    assert.deepEqual(servingSince.value, { m: 10_000 });

    const span = machineEventFrom({ kind: "busy.end", model: "m" }, 13_000);
    assert.deepEqual(span, { t: 10_000, until: 13_000, kind: "serve", label: "m serving", model: "m" });
    assert.deepEqual(servingSince.value, {}, "…and it stops being live");
});

test("serving: busy.end with no start is dropped, and never strands a live span", () => {
    reset();
    assert.equal(machineEventFrom({ kind: "busy.end", model: "m" }, 13_000), null);
    assert.deepEqual(servingSince.value, {});
});

test("evict and unload stay DIFFERENT answers", () => {
    reset();
    // Diffing two polls can see that a model went away; it can never say which of these happened. The server
    // draws the distinction, so the lane keeps it: one made room for something, the other simply expired.
    assert.match(machineEventFrom({ kind: "evict", model: "m", reason: "oom-retry" }, 1).label, /evicted \(oom-retry\)/);
    assert.match(machineEventFrom({ kind: "unload", model: "m" }, 1).label, /unloaded \(idle\)/);
});

test("a failed load is an error, and releases the span it would have closed", () => {
    reset();
    machineEventFrom({ kind: "load.start", model: "m" }, 1000);
    const err = machineEventFrom({ kind: "load.failed", model: "m", reason: "out of memory" }, 4000);
    assert.equal(err.kind, "error");
    assert.match(err.label, /failed to load: out of memory/);
    // …and the next completion must not close a span that was abandoned four minutes ago.
    assert.equal(machineEventFrom({ kind: "load.complete", model: "m" }, 250_000), null);
});

test("frames that are not events in their own right produce none", () => {
    reset();
    for (const kind of ["sample", "heartbeat", "hello", "expires", "something.new"])
        assert.equal(machineEventFrom({ kind, model: "m" }, 1), null, `${kind} draws nothing`);
});

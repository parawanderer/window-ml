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

// ── The two spellings of one model ─────────────────────────────────────────────────────────────────────
//
// Captured off the real box (tests/e2e/fixtures/events-load-lifecycle.json): the event stream names a model
// `registry.ollama.ai/library/gemma4:31b` while `/api/ps` in the very same frame names it `gemma4:31b`. The
// panel matched them nowhere, so every streamed model was drawn a SECOND time in its own colour and badged
// "off-box" — a model that had never been resident — while the real row sat above it.

test("a fully-qualified model name is canonicalised to the one /api/ps reports", () => {
    reset();
    machineEventFrom({ kind: "load.start", model: "registry.ollama.ai/library/gemma4:31b" }, 1000);
    const span = machineEventFrom({ kind: "load.complete", model: "registry.ollama.ai/library/gemma4:31b" }, 9000);
    assert.equal(span.model, "gemma4:31b", "the lane keys on the name the rest of the panel uses");
    assert.match(span.label, /gemma4:31b/);
    assert.doesNotMatch(span.label, /registry\.ollama\.ai/, "and the label reads as the model, not as a URL");
});

test("the open-load map is keyed canonically, so the closing edge finds its start", () => {
    reset();
    // The server is consistent, but a client that canonicalises in one place and not another opens the span
    // under one key and closes it under the other — which silently drops the span rather than failing.
    machineEventFrom({ kind: "load.start", model: "registry.ollama.ai/library/m:7b" }, 1000);
    machineEventFrom({ kind: "load.weights", model: "registry.ollama.ai/library/m:7b" }, 3000);
    const span = machineEventFrom({ kind: "load.complete", model: "registry.ollama.ai/library/m:7b" }, 8000);
    assert.ok(span, "the span closed");
    assert.deepEqual(span.phases, [{ kind: "weights", until: 3000 }, { kind: "context", until: 8000 }]);
});

test("a NON-default registry keeps its prefix — ps keeps it too", () => {
    reset();
    // Stripping to the last path segment would collide two genuinely different models that share a name.
    machineEventFrom({ kind: "load.start", model: "hf.co/someone/m:7b" }, 1000);
    const span = machineEventFrom({ kind: "load.complete", model: "hf.co/someone/m:7b" }, 4000);
    assert.equal(span.model, "hf.co/someone/m:7b");
});

test("the split is read from the closing edge when the server sends it", () => {
    reset();
    // `weights_ms`/`context_ms` arrive on `load.complete`. Preferred over differencing two frames because a
    // panel that subscribes MID-load never saw the `load.weights` edge and would draw no divider at all.
    machineEventFrom({ kind: "load.start", model: "m" }, 1000);
    const span = machineEventFrom({ kind: "load.complete", model: "m", weights_ms: 604, context_ms: 5251 }, 7855);
    assert.deepEqual(span.phases, [{ kind: "weights", until: 2604 }, { kind: "context", until: 7855 }]);
});

test("a bare unload — no model — is dropped rather than drawn anonymously", () => {
    reset();
    // The server really does emit these (three in a ten-minute capture). A lane that assumed a name drew an
    // instant with no colour and no explanation.
    assert.equal(machineEventFrom({ kind: "unload" }, 5000), null);
});

// ── A reconnect must not draw everything twice ────────────────────────────────────────────────────────
//
// Captured off the real box with `ml.__events()` after the lane reported "serving 8" for four serving
// periods and "loads 3" for two loads. `sinceFor(null, …)` asks for the FULL ten-minute ring whenever the
// worker is fresh — which an MV3 respawn guarantees — so every span in that window arrived a second time,
// and `pushMachine` appended it.
import { REAL_EDGES } from "./fixtures/real-edges.mjs";
import { addMachineEvent, sameMachineEvent } from "../src/resource-model.ts";

/** Feed a sequence of server edges through the real converter into a real (deduping) list. */
const drain = (edges, into = []) => {
    let list = into;
    for (const e of edges) {
        const ev = machineEventFrom(e, e.at);
        if (ev) list = addMachineEvent(list, ev, 400);
    }
    return list;
};

test("the real capture: what one turn on the box actually produced", () => {
    reset();
    const list = drain(REAL_EDGES);
    const by = (k) => list.filter((e) => e.kind === k);
    // Two models loaded; the second one's load carries the server's own weights/context split.
    assert.deepEqual(by("load").map((e) => e.model), ["gemma4:e2b", "qwen3.8-flash-next:vision"]);
    assert.ok(by("load").every((e) => e.phases?.length === 2), "both loads know where the weights ended");
    // Four serving PERIODS, three of them back to back on one model — the box working, not four requests.
    assert.equal(by("serve").length, 4);
    assert.deepEqual(by("serve").map((e) => e.model),
        ["gemma4:e2b", "qwen3.8-flash-next:vision", "qwen3.8-flash-next:vision", "qwen3.8-flash-next:vision"]);
    // The model-less unloads produced nothing at all: unattributable is not the same as unnamed.
    assert.equal(by("evict").length, 0);
});

test("a reconnect replays the ring, and the lane does NOT double", () => {
    reset();
    const first = drain(REAL_EDGES);
    // A fresh worker asks for the whole retained window, so the SAME edges arrive again. They are re-derived
    // with a slightly different anchor, because each connection anchors on its own hello.
    reset();
    const jittered = REAL_EDGES.map((e) => ({ ...e, at: e.at + 40 }));
    const after = drain(jittered, first);
    assert.equal(after.length, first.length,
        `a replay added ${after.length - first.length} phantom events — this is "serving 8" for four periods`);

    // Three back-to-back serving periods on ONE model must still be three: they differ by when they START,
    // which is what stops the tolerance collapsing real work into one bar.
    assert.equal(after.filter((e) => e.kind === "serve" && e.model === "qwen3.8-flash-next:vision").length, 3);
});

test("identity is kind + model + when, and a genuinely different span survives it", () => {
    const span = (kind, model, t, until) => ({ t, until, kind, label: "x", model });
    // The same edge seen twice, milliseconds apart because two connections anchored differently.
    assert.ok(sameMachineEvent(span("serve", "m", 1000, 5000), span("serve", "m", 1040, 5030)));
    // Different model, different kind, different period: all distinct.
    assert.ok(!sameMachineEvent(span("serve", "m", 1000, 5000), span("serve", "n", 1000, 5000)));
    assert.ok(!sameMachineEvent(span("load", "m", 1000, 5000), span("serve", "m", 1000, 5000)));
    assert.ok(!sameMachineEvent(span("serve", "m", 1000, 5000), span("serve", "m", 9000, 12000)));
    // Same start, different end — two periods of work, not one seen twice.
    assert.ok(!sameMachineEvent(span("serve", "m", 1000, 5000), span("serve", "m", 1000, 9000)));
    // A span and an INSTANT at the same moment are not the same thing.
    assert.ok(!sameMachineEvent(span("evict", "m", 1000, undefined), span("evict", "m", 1000, 4000)));
});

test("the dedupe is bounded and keeps the newest", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ t: i * 10_000, until: i * 10_000 + 500, kind: "serve", label: "s", model: `m${i}` }));
    let list = [];
    for (const e of many) list = addMachineEvent(list, e, 5);
    assert.equal(list.length, 5);
    assert.deepEqual(list.map((e) => e.model), ["m7", "m8", "m9", "m10", "m11"]);
});

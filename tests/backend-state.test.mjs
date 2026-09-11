// What the panel says about the backend, and specifically when it may say "unreachable".
//
// It said it about a server that was answering every poll in under a millisecond. Measured on the box during
// a 64-second load of a 142 GB model: `/api/ps` answered every time with zero failures and every endpoint
// stayed under 17 ms, while the request that TRIGGERED the load produced no bytes — not even headers — for
// the whole minute. From that one hanging request the panel concluded the box was down and told the user to
// go and check their Server URL.
import test from "node:test";
import assert from "node:assert/strict";
import { backendStateFrom, isBackendUnreachable } from "../src/contract.ts";

const FAIL = "Couldn't reach the server at http://gpubox:3000/api/chat/completions (Failed to fetch).";

test("a hanging request does NOT mean unreachable while the box is answering", () => {
    // THE BUG, in one assertion. The request really did fail and the message really is the network-level
    // shape — what was wrong was the conclusion drawn from it while `/api/ps` was answering in 0.4 ms.
    assert.equal(isBackendUnreachable(FAIL), true, "the message IS the unreachable shape — that is not in question");
    assert.equal(backendStateFrom({ error: FAIL, aliveMs: 800 }), "ok");
    // …and with a load in flight, the panel has something true to say instead of something false.
    assert.equal(backendStateFrom({ error: FAIL, aliveMs: 800, loading: ["qwen3:235b"] }), "loading");
});

test("unreachable still means unreachable when nothing answers", () => {
    // The veto is EVIDENCE, not optimism. A box that has genuinely gone must still be reported, or the fix
    // for a false alarm becomes a silenced real one.
    assert.equal(backendStateFrom({ error: FAIL, aliveMs: null }), "unreachable", "never proven alive");
    assert.equal(backendStateFrom({ error: FAIL, aliveMs: 60_000 }), "unreachable", "proof went stale");
    // The staleness bound is the whole mechanism: evidence going stale is exactly what a box dying looks
    // like, so an unbounded veto would mean the banner could never fire again after one successful poll.
    assert.equal(backendStateFrom({ error: FAIL, aliveMs: 14_000 }), "ok");
    assert.equal(backendStateFrom({ error: FAIL, aliveMs: 16_000 }), "unreachable");
});

test("a LOAD is not claimed over a silent box", () => {
    // The same mistake in the other direction, and the more dangerous one: a reassuring "loading…" label
    // over a host that has stopped answering hides the failure behind a progress message.
    assert.equal(backendStateFrom({ error: FAIL, aliveMs: 60_000, loading: ["qwen3:235b"] }), "unreachable");
    assert.equal(backendStateFrom({ aliveMs: null, loading: ["qwen3:235b"] }), "ok",
        "no failure and no proof is not a claim either way — the banner is for failures");
});

test("an HTTP status is a server ANSWERING, not a missing one", () => {
    // Long-standing rule, restated here because this function is now the one place that decides.
    assert.equal(backendStateFrom({ error: "HTTP 500 from http://gpubox:3000", aliveMs: null }), "ok");
    assert.equal(backendStateFrom({ error: "HTTP 404 from http://gpubox:3000", aliveMs: 99_999 }), "ok");
});

test("no failure at all is never a complaint", () => {
    assert.equal(backendStateFrom({}), "ok");
    assert.equal(backendStateFrom({ error: "", aliveMs: 500 }), "ok");
    assert.equal(backendStateFrom({ error: null, aliveMs: 500, loading: ["m"] }), "loading",
        "a load is worth SAYING even when nothing has failed — it is why the next request will be slow");
});

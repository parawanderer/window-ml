// The keep-alive countdown, which is only correct if it knows when to STOP.
//
// Ollama rewrites a runner's `expires_at` when a request FINISHES, so during a generation the deadline
// stands still while a clock drawn against it keeps running down — on a long generation, straight past zero,
// leaving the panel claiming a model should already have been evicted while it is visibly working. The
// patched server reports `busy` off the runner's reference count, which is the freeze signal; it also covers
// traffic this browser never sees (another client, a script, a terminal), which no local in-flight flag can.
import test from "node:test";
import assert from "node:assert/strict";
import { fmtTTL, expiresIn } from "../src/sidebar/vram.tsx";

const inMs = (ms) => new Date(Date.now() + ms).toISOString();

test("fmtTTL: a compact two-unit countdown, and nothing at all once it has elapsed", () => {
    // It FLOORS, and a millisecond passes between minting the stamp and reading it, so the last unit is
    // allowed to be one short — asserting the exact second would fail on a slow machine and nowhere else.
    assert.match(fmtTTL(inMs(44_000)), /^4[34]s$/);
    assert.match(fmtTTL(inMs(5 * 60_000 + 12_000)), /^5m 1[12]s$/);
    assert.match(fmtTTL(inMs(2 * 3600_000)), /^(2h 0m|1h 59m)$/);
    assert.equal(fmtTTL(null), null, "no stamp, no claim");
    assert.equal(fmtTTL(inMs(-1000)), null, "an elapsed deadline is not a negative countdown");
    assert.equal(fmtTTL("not a date"), null);
});

test("fmtTTL: BUSY stops the clock — the stamp it holds is the one from the last request", () => {
    // The number would be wrong in the one direction that matters: a five-minute TTL and a six-minute
    // generation puts the countdown past zero on a model that is right there, working.
    assert.equal(fmtTTL(inMs(-90_000), true), "in use", "past zero, and still resident, because it is busy");
    assert.equal(fmtTTL(inMs(120_000), true), "in use", "even a stamp that still reads plausibly is stale");
    assert.equal(fmtTTL(null, true), "in use", "busy is a fact about the runner, not about the stamp");
    // Absent on a stock server, which means "not known", never "idle" — so undefined must behave as today.
    assert.equal(fmtTTL(inMs(44_000), undefined), "44s");
});

// `keep_alive: -1` pins a model in memory, and Ollama expresses that as an `expires_at` about a century out.
// Counting down to it is true and useless — "36159d 12h" is nobody's deadline, and a day count that large
// reads as a bug in the panel rather than as a decision someone made deliberately.
test("fmtTTL: a deadline a century out is a PIN, not a countdown", () => {
    const century = inMs(100 * 365 * 24 * 3600_000);
    assert.equal(fmtTTL(century), "pinned");
    assert.equal(expiresIn(century), "pinned — no expiry");
    // …and busy still wins: a pinned model serving a request is described by what it is doing.
    assert.equal(fmtTTL(century, true), "in use");
    // The threshold is far past any keep-alive a person would set, so nothing real falls between the two.
    assert.match(fmtTTL(inMs(30 * 24 * 3600_000)), /^(30d 0h|29d 23h)$/, "a month is still a countdown");
});

test("expiresIn: the same rule in the tooltip's prose", () => {
    assert.match(expiresIn(inMs(30_000)), /^expires in 30s$/);
    assert.match(expiresIn(inMs(10 * 60_000)), /^expires in 10m$/);
    assert.equal(expiresIn(inMs(30_000), true), "in use — TTL held");
    assert.equal(expiresIn(null), null);
});

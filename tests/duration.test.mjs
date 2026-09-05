// One duration scale for the panel. There were two, and they disagreed at the top end: a span's tooltip
// stopped at seconds, so a five-minute run read as "312.4s" — the number, but not an answer to "how long was
// that". The unit has to change with the magnitude, because the reader's question does.
import test from "node:test";
import assert from "node:assert/strict";
import { fmtDur, fmtAge } from "../src/sidebar/timestamps.ts";

test("fmtDur: the unit follows the magnitude", () => {
    // Under a second, milliseconds are the answer — a DOM tool call really does finish in 4ms.
    assert.equal(fmtDur(4), "4ms");
    assert.equal(fmtDur(999), "999ms");
    // Under a minute, tenths of a second. A generation of 5.6s and one of 5.1s are different facts.
    assert.equal(fmtDur(1000), "1.0s");
    assert.equal(fmtDur(14_122), "14.1s");
    assert.equal(fmtDur(59_940), "59.9s");
    // Past a minute the seconds are noise beside the minutes, and this is the case that was wrong.
    assert.equal(fmtDur(60_000), "1m");
    assert.equal(fmtDur(312_400), "5m 12s");
    assert.equal(fmtDur(3_599_000), "59m 59s");
    // …and past an hour, the same again.
    assert.equal(fmtDur(3_600_000), "1h");
    assert.equal(fmtDur(4_500_000), "1h 15m");
    // A negative extent is a clock disagreement, not a negative duration.
    assert.equal(fmtDur(-5), "0ms");
});

test("fmtAge: the same scale, minus a precision an AGE cannot use", () => {
    // Tenths of a second do not mean anything as an age — anything that recent reads as "now" — so the
    // fractional part is dropped rather than reported.
    assert.equal(fmtAge(0), "0s");
    assert.equal(fmtAge(14_122), "14s");
    assert.equal(fmtAge(312_400), "5m 12s");
    assert.equal(fmtAge(4_500_000), "1h 15m");
});

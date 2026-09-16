// The housekeeping log's text form (sidebar/housekeeping-log.tsx): one line per event for the output cell, with
// produced-at marks at each line's offset so the timestamp gutter lines up.
import { test } from "node:test";
import assert from "node:assert";
import { housekeepingText, subsystemCounts } from "../src/sidebar/housekeeping-log.tsx";
import { timeForOffset } from "../src/sidebar/timestamps.ts";

const EV = [
    { t: 100, subsystem: "sw", kind: "evicted-inferred", reason: "idle", ms: 64_000, origin: "worker", detail: { lastSeenAgoMs: 64_000 } },
    { t: 200, subsystem: "fetch-cache", kind: "evict", reason: "budget", bytes: 2048, key: "https://a/b.csv", origin: "page", tab: 3 },
    { t: 300, subsystem: "pyodide", kind: "prewarm-used", ms: 0, origin: "offscreen", detail: { warm: true } },
];

test("every event is one line, and each line's mark is its own time", () => {
    const { text, marks } = housekeepingText(EV);
    const lines = text.split("\n");
    assert.equal(lines.length, 3);
    let off = 0;
    lines.forEach((line, i) => { assert.equal(timeForOffset(marks, off), EV[i].t); off += line.length + 1; });
    assert.match(lines[0], /^sw\s+evicted-inferred \(idle\)\s+1m 4s\s+lastSeenAgoMs=64000$/);
    assert.match(lines[1], /evict \(budget\)  2\.00 KiB  https:\/\/a\/b\.csv/, "bytes are formatted, not raw");
    assert.match(lines[1], /\[page tab 3\]$/);
    assert.match(lines[2], /warm=true\s+\[offscreen\]$/);
});

test("subsystem names are padded to one column, and a hidden subsystem is left out entirely", () => {
    const { text, marks } = housekeepingText(EV, new Set(["fetch-cache"]));
    const lines = text.split("\n");
    assert.equal(lines.length, 2);
    assert.equal(marks.length, 2);
    assert.equal(lines[0].indexOf("evicted"), lines[1].indexOf("prewarm"), "the kinds line up once the widest subsystem is gone");
    assert.deepEqual(housekeepingText([]), { text: "", marks: [] });
});

test("subsystemCounts keeps first-appearance order", () => {
    assert.deepEqual(subsystemCounts([...EV, EV[0]]), [["sw", 2], ["fetch-cache", 1], ["pyodide", 1]]);
});

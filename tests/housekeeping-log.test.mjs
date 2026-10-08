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
    assert.deepEqual(housekeepingText([]), { text: "", marks: [], groups: [], headWidth: 0 });
});

test("each line says which GROUP it came from, for a surface that colours them — and which column it is in", () => {
    const { groups, headWidth, text } = housekeepingText(EV);
    // One per RENDERED line, in the same order, so a renderer can index them against the lines it splits.
    assert.deepEqual(groups, ["sw", "fetch-cache", "pyodide"]);
    assert.equal(headWidth, "fetch-cache".length);
    for (const [i, line] of text.split("\n").entries())
        assert.equal(line.slice(0, headWidth).trim(), groups[i], "the group is the line's first column");
    // Hiding one drops its line AND its group, or the two lists stop lining up — which would colour every line
    // after a filtered one as the group above it.
    assert.deepEqual(housekeepingText(EV, new Set(["sw"])).groups, ["fetch-cache", "pyodide"]);
});

test("subsystemCounts keeps first-appearance order", () => {
    assert.deepEqual(subsystemCounts([...EV, EV[0]]), [["sw", 2], ["fetch-cache", 1], ["pyodide", 1]]);
});

test("an omitted detail key leaves the LINE, not the record — the width it was spending is what makes a line wrap", () => {
    const evs = [{ t: 100, subsystem: "page", kind: "discarded", ms: 4000, origin: "worker", detail: { tab: 175215074, tool: "wait" } }];
    assert.equal(housekeepingText(evs).text, "page  discarded  4.00s  tab=175215074  tool=wait");
    assert.equal(housekeepingText(evs, new Set(), new Set(["tab"])).text, "page  discarded  4.00s  tool=wait");
    // Omitting shortens the line, so the marks the gutter is drawn from must be computed over the SHORTENED
    // text or every timestamp after the first lands on the wrong row.
    const two = [...evs, { ...evs[0], t: 200, kind: "reloaded" }];
    const { text, marks } = housekeepingText(two, new Set(), new Set(["tab"]));
    assert.equal(timeForOffset(marks, text.indexOf("reloaded")), 200);
});

// --- levels: only the records that are not routine say so ---

test("a warning or an error names its level ahead of what happened; an info record says nothing extra", () => {
    const { text } = housekeepingText([
        { t: 1, subsystem: "page", kind: "held", reason: "navigating", origin: "worker" },
        { t: 2, level: "warn", subsystem: "page", kind: "discarded", origin: "worker" },
        { t: 3, level: "error", subsystem: "cdp", kind: "refused", reason: "busy", origin: "worker" },
        { t: 4, level: "info", subsystem: "tab", kind: "pinned", origin: "worker" },
    ]);
    assert.deepEqual(text.split("\n").map((l) => l.split(/ {2}/).map((w) => w.trim())), [
        ["page", "held (navigating)"],
        ["page", "WARN", "discarded"],
        ["cdp", "ERROR", "refused (busy)"],
        ["tab", "pinned"],
    ]);
});

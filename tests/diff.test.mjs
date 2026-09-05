// The line diff (src/diff.ts) — what changed between two versions of a script the model retried.
// Pure, so it is tested here rather than through a browser. The thing worth pinning is not that a diff
// algorithm works: it is the elision, which decides what the reader ACTUALLY sees.
import { test } from "node:test";
import assert from "node:assert";
import { diffLines, collapse, codeDiff, diffStat, DIFF_MAX_LINES } from "../src/diff.ts";

const kinds = (rows) => rows.map((r) => r.kind).join(" ");
const texts = (rows) => rows.map((r) => (r.kind === "gap" ? `…${r.skipped}` : `${r.kind[0]} ${r.text}`));

test("identical text is not a diff, and neither is an oversized pair", () => {
    // Null, not an empty array: the caller renders nothing at all, rather than an empty panel that implies
    // it looked and found no change when it never looked.
    assert.equal(codeDiff("a\nb", "a\nb"), null);
    const huge = Array.from({ length: DIFF_MAX_LINES + 1 }, (_, i) => `x${i}`).join("\n");
    assert.equal(codeDiff(huge, huge + "\ny"), null);
});

test("a replaced line reads as the old one struck out and the new one under it", () => {
    // Deletion before addition, because that is what a replacement looks like — and a replacement is by far
    // the common case when a model retries a script.
    const rows = diffLines("a\nOLD\nc", "a\nNEW\nc");
    assert.equal(kinds(rows), "same del add same");
    assert.deepEqual(texts(rows), ["s a", "d OLD", "a NEW", "s c"]);
});

test("line numbers are kept for BOTH sides, since each row belongs to one or both", () => {
    const rows = diffLines("a\nb", "a\nx\nb");
    assert.deepEqual(rows, [
        { kind: "same", text: "a", a: 1, b: 1 },
        { kind: "add", text: "x", b: 2 },
        { kind: "same", text: "b", a: 2, b: 3 },
    ]);
});

test("pure insertion and pure deletion each keep the whole common part", () => {
    assert.equal(kinds(diffLines("a\nb\nc", "a\nb\nc\nd")), "same same same add");
    assert.equal(kinds(diffLines("a\nb\nc\nd", "a\nb\nc")), "same same same del");
    assert.equal(kinds(diffLines("", "x")), "del add");
});

test("a long run of unchanged lines COLLAPSES, so the one change is not buried", () => {
    // This is the point of the feature: two thirty-line scripts differing in one place must SHOW that place.
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 15", "line FIFTEEN");
    const rows = codeDiff(before, after);
    assert.equal(rows.filter((r) => r.kind === "gap").length, 2, "a gap either side of the hunk");
    const shown = rows.filter((r) => r.kind !== "gap");
    assert.ok(shown.length <= 6, `only the hunk and its context, got ${shown.length}`);
    assert.ok(rows.some((r) => r.kind === "del" && r.text === "line 15"));
    assert.ok(rows.some((r) => r.kind === "add" && r.text === "line FIFTEEN"));
    // Every line is accounted for: what is drawn plus what the gaps stand for is the whole alignment.
    const total = rows.reduce((n, r) => n + (r.kind === "gap" ? r.skipped : 1), 0);
    assert.equal(total, diffLines(before, after).length);
});

test("a gap that saves nothing is not drawn — eliding one line costs more than printing it", () => {
    // "1 line skipped" is longer than the line, and it makes the reader wonder what was hidden.
    const rows = collapse(diffLines("a\nX\nb\nc\nd\nY\ne", "a\nX2\nb\nc\nd\nY2\ne"), 1);
    assert.equal(rows.filter((r) => r.kind === "gap").length, 0);
    assert.ok(rows.every((r) => r.kind !== "gap"));
});

test("context is kept either side of every change", () => {
    const before = ["h1", "h2", "h3", "h4", "TARGET", "t1", "t2", "t3", "t4"].join("\n");
    const rows = codeDiff(before, before.replace("TARGET", "HIT"), 2);
    const same = rows.filter((r) => r.kind === "same").map((r) => r.text);
    assert.deepEqual(same, ["h3", "h4", "t1", "t2"], "two lines either side, no more");
});

test("two separate changes far apart get their own hunks", () => {
    const before = Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n");
    const after = before.replace("l3", "l3!").replace("l30", "l30!");
    const rows = codeDiff(before, after);
    // Two gaps, not three: the run BEFORE the first change is a single line, and a gap standing for one
    // line costs more to say than the line does — so it is un-elided rather than drawn.
    assert.equal(rows.filter((r) => r.kind === "gap").length, 2, "between the hunks, and after the last");
    assert.ok(rows.some((r) => r.kind === "same" && r.text === "l0"), "the un-elided leading line is drawn");
    assert.equal(diffStat(rows).added, 2);
    assert.equal(diffStat(rows).removed, 2);
});

test("a moved line reads as a delete and an add, not as a silent reorder", () => {
    // The alternative — matching it up and calling it unchanged — hides the only thing that happened.
    const rows = diffLines("a\nb\nc", "b\nc\na");
    assert.deepEqual(diffStat(rows), { added: 1, removed: 1 });
});

test("whitespace-only differences are still differences", () => {
    // The CALLER decides whether to normalise (both sides are reflowed before this is reached, which is
    // what stops spacing drowning the real change). This layer never silently equates two texts.
    assert.notEqual(codeDiff("a = 1", "a  =  1"), null);
});

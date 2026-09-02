// Standalone tests for the shared tool OUTPUT CELL (sidebar/render-panel.tsx) — the component python_exec,
// exec, and any future code-ish tool render their Out into. Rendered DIRECTLY here (no app, no debug stream)
// so its own behaviour is pinned: the tail-follow rule, and the in-cell find bar's interactivity.
// Real scrolling (which needs layout) is covered by tests/e2e/output-scroll.spec.mjs — jsdom has no layout.
import { test, before } from "node:test";
import assert from "node:assert";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

let h, render, OutputCell, findMatches, atBottomOf, doc;

before(async () => {
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { pretendToBeVisual: true });
    // Preact + the component read these at render time, so install them BEFORE importing either.
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Node = dom.window.Node;
    globalThis.NodeFilter = dom.window.NodeFilter;
    doc = dom.window.document;
    // Load preact through require, NOT `import("preact")`: tsx compiles the .tsx component to CJS, so an
    // ESM import here would be a SECOND preact instance and its hooks would have no current component.
    ({ h, render } = require_("preact"));
    ({ OutputCell, findMatches, atBottomOf } = await import("../sidebar/render-panel.tsx"));
});

// Preact defers effects to a rAF tick, and the find bar computes its match count IN an effect — so a
// settle must outlast a frame, not just a microtask (a 0ms wait reads a stale "No results").
const tick = () => new Promise(r => setTimeout(r, 40));
// Mount a cell containing `text`, and return its root element.
const mount = async (text) => {
    const host = doc.getElementById("root");
    render(null, host);                      // unmount any previous cell (drops its find ownership)
    render(h(OutputCell, {}, h("pre", null, text)), host);
    await tick();
    return host.querySelector(".r-outcell");
};
const openFind = async (cell) => {
    cell.querySelector(".r-outscroll").dispatchEvent(new doc.defaultView.KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
    await tick();
};
const type = async (cell, value) => {
    const input = cell.querySelector(".r-find-q");
    input.value = value;
    input.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
    await tick();
    return cell.querySelector(".r-find-n").textContent;
};

/* ---------------- the matching rule (pure) ---------------- */

test("findMatches: case-insensitive by default, case-sensitive on demand", () => {
    assert.deepEqual(findMatches("Alpha alpha ALPHA", "alpha", false).length, 3);
    assert.deepEqual(findMatches("Alpha alpha ALPHA", "alpha", true).length, 1, "only the exact-case one");
});

test("findMatches: non-overlapping, and an empty query matches nothing", () => {
    assert.deepEqual(findMatches("aaaa", "aa", false), [[0, 2], [2, 4]], "advances past each match");
    assert.deepEqual(findMatches("anything", "", false), [], "an empty query is not a match-everything");
});

test("atBottomOf: parked at the bottom follows; scrolled up holds", () => {
    assert.equal(atBottomOf({ scrollHeight: 1000, scrollTop: 800, clientHeight: 200 }), true);
    assert.equal(atBottomOf({ scrollHeight: 1000, scrollTop: 790, clientHeight: 200 }), true, "a few px of slack still counts");
    assert.equal(atBottomOf({ scrollHeight: 1000, scrollTop: 400, clientHeight: 200 }), false);
    assert.equal(atBottomOf({ scrollHeight: 120, scrollTop: 0, clientHeight: 260 }), true, "no overflow → stay armed");
});

/* ---------------- the cell + its find bar (rendered) ---------------- */

test("output cell: renders a scroller, no grip until it overflows, and no find bar until asked", async () => {
    const cell = await mount("alpha\nbeta\n");
    assert.ok(cell.querySelector(".r-outscroll"), "the content scrolls inside the cell");
    // This cell now wraps EVERY tool's output, so a short one-line result must not grow a drag handle.
    // (jsdom has no layout → nothing overflows here; the real overflow case is the e2e scroll spec.)
    assert.equal(cell.querySelector(".r-outgrip"), null, "no resize grip while there's nothing to resize");
    assert.equal(cell.querySelector(".r-find"), null, "find is closed until Ctrl+F");
});

test("find bar: Ctrl+F opens it, typing reports the match count, Esc closes it", async () => {
    const cell = await mount("alpha\nbeta\nalpha\n");
    await openFind(cell);
    assert.ok(cell.querySelector(".r-find"), "Ctrl+F on the focused cell opens the find bar");
    assert.equal(await type(cell, "alpha"), "1 of 2", "counts the matches and starts on the first");
    assert.equal(await type(cell, "zzz"), "No results", "a miss says so rather than showing 0 of 0");
    cell.querySelector(".r-find-q").dispatchEvent(new doc.defaultView.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    assert.equal(cell.querySelector(".r-find"), null, "Esc closes it");
});

test("find bar: the Aa toggle switches to case-sensitive matching", async () => {
    const cell = await mount("Alpha alpha ALPHA\n");
    await openFind(cell);
    assert.equal(await type(cell, "alpha"), "1 of 3", "case-insensitive by default");
    cell.querySelector(".r-find-case").click();
    await tick();
    assert.equal(cell.querySelector(".r-find-n").textContent, "1 of 1", "Aa → only the exact-case match");
    assert.match(cell.querySelector(".r-find-case").className, /\bon\b/, "and the toggle reads as pressed");
});

test("find bar: the arrows step through matches and wrap around", async () => {
    const cell = await mount("alpha\nalpha\nalpha\n");
    await openFind(cell);
    assert.equal(await type(cell, "alpha"), "1 of 3");
    const [prev, next] = cell.querySelectorAll(".r-find-nav");
    next.click(); await tick();
    assert.equal(cell.querySelector(".r-find-n").textContent, "2 of 3", "↓ advances");
    next.click(); await tick();
    next.click(); await tick();
    assert.equal(cell.querySelector(".r-find-n").textContent, "1 of 3", "and wraps past the last match");
    prev.click(); await tick();
    assert.equal(cell.querySelector(".r-find-n").textContent, "3 of 3", "↑ wraps backwards");
});

test("find bar: the arrows are disabled while there is nothing to step through", async () => {
    const cell = await mount("alpha\n");
    await openFind(cell);
    await type(cell, "nope");
    for (const b of cell.querySelectorAll(".r-find-nav")) assert.equal(b.disabled, true);
});

/* ---------------- streamed-output timestamps (supplied by the executor, not guessed) ---------------- */

test("timeForOffset: a line takes the time of the last mark at or before it", async () => {
    const { timeForOffset } = await import("../sidebar/render-panel.tsx");
    const marks = [[0, 1000], [10, 2000], [25, 3000]];
    assert.equal(timeForOffset(marks, 0), 1000, "the first chunk's own time");
    assert.equal(timeForOffset(marks, 5), 1000, "still inside the first chunk");
    assert.equal(timeForOffset(marks, 10), 2000, "exactly at the next mark");
    assert.equal(timeForOffset(marks, 30), 3000, "after the last mark");
});

test("timeForOffset: no marks → NO time is invented", async () => {
    const { timeForOffset } = await import("../sidebar/render-panel.tsx");
    assert.equal(timeForOffset(undefined, 5), null);
    assert.equal(timeForOffset([], 5), null);
    assert.equal(timeForOffset([[10, 999]], 0), null, "an offset before the first mark has no time to show");
});

test("fmtDelta: sub-second gaps stay in ms (the resolution that matters for a fast loop)", async () => {
    const { fmtDelta } = await import("../sidebar/render-panel.tsx");
    assert.equal(fmtDelta(240), "240ms");
    assert.equal(fmtDelta(1204), "1.20s");
    assert.equal(fmtDelta(65000), "1m 5s");
});

test("alignedMarks: marks that don't index into the rendered text are DROPPED, never applied", async () => {
    const { alignedMarks } = await import("../sidebar/render-panel.tsx");
    const marks = [[0, 1], [40, 2]];
    assert.deepEqual(alignedMarks(marks, "x".repeat(60)), marks, "the text covers every mark → time it");
    assert.equal(alignedMarks(marks, "short"), undefined, "text shorter than the last mark → don't time the wrong lines");
    assert.equal(alignedMarks(undefined, "abc"), undefined);
    assert.equal(alignedMarks(marks, undefined), undefined);
});

test("elideHour: drops the hour only when every mark is in the CURRENT hour", async () => {
    const { elideHour } = await import("../sidebar/render-panel.tsx");
    const now = new Date("2026-09-02T14:17:30").getTime();
    const t = (hh, mm) => new Date(`2026-09-02T${hh}:${mm}:00`).getTime();
    assert.equal(elideHour([[0, t("14", "17")], [9, t("14", "19")]], now), true, "all in the current hour → elide");
    assert.equal(elideHour([[0, t("13", "59")], [9, t("14", "01")]], now), false, "spans an hour boundary → keep it");
    assert.equal(elideHour([[0, t("13", "17")]], now), false, "a different hour → keep it");
    // Read back the next day at the same clock hour: same getHours(), different day — must NOT elide.
    const tomorrow = new Date("2026-09-03T14:17:30").getTime();
    assert.equal(elideHour([[0, t("14", "17")]], tomorrow), false, "same hour-of-day but a different DAY → keep it");
    assert.equal(elideHour([], now), false);
});

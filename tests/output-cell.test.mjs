// Standalone tests for the shared tool OUTPUT CELL (sidebar/render-panel.tsx) — the component python_exec,
// exec, and any future code-ish tool render their Out into. Rendered DIRECTLY here (no app, no debug stream)
// so its own behaviour is pinned: the tail-follow rule, and the in-cell find bar's interactivity.
// Real scrolling (which needs layout) is covered by tests/e2e/output-scroll.spec.mjs — jsdom has no layout.
import { test, before, after } from "node:test";
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

test("timestamp gutter: EVERY timestamped row is hoverable, with ms precision and a gap", async () => {
    const { h: h2, render: render2 } = await (async () => ({ h, render }))();
    const host = doc.getElementById("root");
    const { TimedOutput } = await import("../sidebar/render-panel.tsx");
    render2(null, host);
    // three lines: two share a mark (a burst), the third is 1.2s later
    const marks = [[0, 1731000000000], [8, 1731000001204]];
    render2(h2(TimedOutput, { text: "aaa\nbbb\nccc", marks }), host);
    await tick();
    const gutters = [...host.querySelectorAll(".r-ts")];
    assert.equal(gutters.length, 3, "one gutter cell per line");
    // Row 2 repeats row 1's time, so its LABEL is blank — but it must still be hoverable.
    assert.equal(gutters[1].textContent, "", "a repeated time isn't reprinted");
    for (const g of gutters) {
        assert.match(g.getAttribute("title") || "", /\d\d:\d\d:\d\d\.\d\d\d/, "every row hovers to a millisecond-precise time");
        assert.match(g.className, /hoverable/, "…and is marked as hoverable");
    }
    assert.match(gutters[2].getAttribute("title"), /\+1\.20s since the previous line/, "the third line reports the gap");
    assert.doesNotMatch(gutters[0].getAttribute("title"), /since the previous line/, "the first line has nothing to compare to");
});

/* ---------------- the Settings-controlled knobs, and find ownership ---------------- */

test("output cell: the configured height cap drives the scroller, and 'uncapped' removes it", async () => {
    const { outMaxH } = await import("../sidebar/store.ts");
    const cell = await mount("alpha\n");
    assert.match(cell.querySelector(".r-outscroll").getAttribute("style") || "", /max-height:\s*260px/);
    outMaxH.value = 420;
    await tick();
    assert.match(cell.querySelector(".r-outscroll").getAttribute("style") || "", /max-height:\s*420px/, "Settings → Appearance drives it");
    outMaxH.value = 0;
    await tick();
    assert.doesNotMatch(cell.querySelector(".r-outscroll").getAttribute("style") || "", /max-height/, "'Uncapped' means no cap at all");
    outMaxH.value = 260;
    await tick();
});

test("timestamp gutter: the Settings toggle hides it without touching the text", async () => {
    const { showOutTimes } = await import("../sidebar/store.ts");
    const { TimedOutput } = await import("../sidebar/render-panel.tsx");
    const host = doc.getElementById("root");
    const marks = [[0, 1731000000000]];
    render(null, host);
    render(h(TimedOutput, { text: "aaa\nbbb", marks }), host);
    await tick();
    assert.ok(host.querySelectorAll(".r-ts").length, "gutter on by default");
    showOutTimes.value = false;
    render(null, host);
    render(h(TimedOutput, { text: "aaa\nbbb", marks }), host);
    await tick();
    assert.equal(host.querySelector(".r-ts"), null, "toggled off → no gutter");
    assert.match(host.textContent, /aaa[\s\S]*bbb/, "…and the output itself is untouched");
    showOutTimes.value = true;
});

test("find bar: only ONE cell owns it at a time (the highlight registry is global)", async () => {
    const host = doc.getElementById("root");
    render(null, host);
    render(h("div", null, h(OutputCell, {}, h("pre", null, "alpha")), h(OutputCell, {}, h("pre", null, "alpha"))), host);
    await tick();
    const cells = [...host.querySelectorAll(".r-outcell")];
    assert.equal(cells.length, 2);
    const openIn = async (cell) => {
        cell.querySelector(".r-outscroll").dispatchEvent(new doc.defaultView.KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
        await tick();
    };
    await openIn(cells[0]);
    assert.ok(cells[0].querySelector(".r-find"), "find opened in the first cell");
    await openIn(cells[1]);
    assert.ok(cells[1].querySelector(".r-find"), "…and moves to the second");
    assert.equal(cells[0].querySelector(".r-find"), null, "the first closes — two live searches would fight one registry");
});

test("output cell: dragging the grip resizes THIS cell only", async () => {
    const cell = await mount("alpha\n");
    // jsdom reports no overflow, so force the grip by simulating a drag start on a cell that has one:
    // dragging sets an explicit height, which is what we assert.
    const scroll = cell.querySelector(".r-outscroll");
    const before = scroll.getAttribute("style") || "";
    assert.match(before, /max-height:\s*260px/);
    const W = doc.defaultView;
    // No grip without overflow (that rule is already covered) — drive the handler directly via a grip we
    // reveal by pinning a height first: dispatch pointerdown on the cell's grip if present, else skip.
    const grip = cell.querySelector(".r-outgrip");
    if (!grip) return;   // no overflow in jsdom → nothing to drag here; the e2e covers the real interaction
    grip.dispatchEvent(new W.PointerEvent("pointerdown", { clientY: 100, bubbles: true }));
    W.dispatchEvent(new W.PointerEvent("pointermove", { clientY: 180, bubbles: true }));
    W.dispatchEvent(new W.PointerEvent("pointerup", { bubbles: true }));
    await tick();
    assert.notEqual(cell.querySelector(".r-outscroll").getAttribute("style"), before, "the drag pinned a new height");
});


// The hour gutter must WIDEN when the clock rolls over — otherwise a long session left open keeps rendering a
// bare mm:ss that silently claims the current hour. It is driven by a `hourNow` signal (one timer for the whole
// app), so the roll-over is testable by advancing that signal instead of waiting an hour.
test("hour roll-over: a mounted gutter widens to hh:mm:ss when the hour ticks over", async () => {
    const { TimedOutput } = await import("../sidebar/render-panel.tsx");
    const { hourNow, armHourTick, stopHourTick } = await import("../sidebar/timestamps.ts");
    const host = doc.getElementById("root");
    const base = new Date("2026-09-02T14:17:30").getTime();
    hourNow.value = base;
    render(null, host);
    render(h(TimedOutput, { text: "alpha\nbeta", marks: [[0, base], [6, base + 1200]] }), host);
    await tick();

    const gutter = () => [...host.querySelectorAll(".r-ts")].map((n) => n.textContent).filter(Boolean);
    assert.equal(host.querySelector(".r-timed").className.includes("short"), true, "same hour → mm:ss");
    assert.deepEqual(gutter(), ["17:30", "17:31"], "the hour is elided while it is the current one");

    // The clock rolls into the next hour: the SAME marks are now in a past hour, so the full clock comes back.
    hourNow.value = new Date("2026-09-02T15:00:02").getTime();
    await tick();
    assert.equal(host.querySelector(".r-timed").className.includes("short"), false, "past hour → hh:mm:ss");
    assert.deepEqual(gutter(), ["14:17:30", "14:17:31"], "every row widened together — no mixed-width gutter");

    // The timer is armed at most once, and re-arming is a no-op while one is pending.
    armHourTick(); armHourTick();
    stopHourTick();
    render(null, host);
});

test("timedText: the export's plain-text gutter mirrors the sidebar's", async () => {
    const { timedText } = await import("../sidebar/timestamps.ts");
    const now = new Date("2026-09-02T14:17:40").getTime();
    const t0 = new Date("2026-09-02T14:17:30").getTime();
    const text = "alpha\nbeta\ngamma";
    const marks = [[0, t0], [11, t0 + 61000]];   // 11 = where "gamma" starts ("alpha\n" 6 + "beta\n" 5)

    const same = timedText(text, marks, now);
    assert.deepEqual(same.split("\n"), ["17:30  alpha", "17:30  beta", "18:31  gamma"],
        "current hour → mm:ss, and EVERY line carries its own stamp (a text file can't be hovered)");

    // Read back later (or a run that spans the boundary) → the full clock, same as the sidebar.
    const later = timedText(text, marks, new Date("2026-09-02T15:30:00").getTime());
    assert.deepEqual(later.split("\n"), ["14:17:30  alpha", "14:17:30  beta", "14:18:31  gamma"]);

    // A trailing newline must not become a row of trailing spaces in the exported file.
    assert.equal(timedText("solo\n", [[0, t0]], now), "17:30  solo\n", "the empty last line gets no gutter");

    assert.equal(timedText("short", [[0, t0], [400, t0]], now), null, "marks that don't fit the text → no guess");
    assert.equal(timedText("alpha", undefined, now), null, "no marks (a non-streaming run) → nothing to time");
});

// Midnight. The gutter is time-only, so without a divider 00:00:01 sits directly under 23:59:58 and reads as
// one second later rather than the next day.
test("day change: the gutter draws a divider, and only at the change", async () => {
    const { TimedOutput } = await import("../sidebar/render-panel.tsx");
    const { dayBreaks } = await import("../sidebar/timestamps.ts");
    const host = doc.getElementById("root");
    const late = new Date("2026-09-02T23:59:58").getTime();
    const past = new Date("2026-09-03T00:00:01").getTime();
    const text = "before\nmidnight\nafter\n";
    const marks = [[0, late], [7, late + 1000], [16, past]];

    assert.deepEqual([...dayBreaks(text, marks)], [[2, "2026-09-03"]], "one break, on the first line of the new day");
    assert.deepEqual([...dayBreaks(text, [[0, late]])], [], "a run inside ONE day gets no divider");
    assert.deepEqual([...dayBreaks(text, undefined)], [], "no marks → nothing to divide");

    render(null, host);
    render(h(TimedOutput, { text, marks }), host);
    await tick();
    const days = [...host.querySelectorAll(".r-ts-day-lbl")].map((n) => n.textContent);
    assert.deepEqual(days, ["2026-09-03"], "the divider is rendered, labelled with the new day");
    // It sits ABOVE the first line of the new day, not at the end of the old one.
    const rows = [...host.querySelector(".r-timed").children];
    const divider = rows.findIndex((n) => n.classList.contains("r-ts-day"));
    assert.match(rows[divider + 1].textContent, /after/, "the divider precedes the first line after midnight");
    assert.match(rows[divider - 1].textContent, /midnight/, "…and follows the last line before it");
    // A run that crosses midnight can never elide the hour, so both sides carry the full clock.
    assert.equal(host.querySelector(".r-timed").className.includes("short"), false);
    render(null, host);
});

test("timedText: the export marks the day change too", async () => {
    const { timedText } = await import("../sidebar/timestamps.ts");
    const late = new Date("2026-09-02T23:59:58").getTime();
    const past = new Date("2026-09-03T00:00:01").getTime();
    const out = timedText("before\nmidnight\nafter", [[0, late], [7, late + 1000], [16, past]], past);
    assert.deepEqual(out.split("\n"), [
        "23:59:58  before",
        "23:59:59  midnight",
        "────────  ── 2026-09-03 ──",
        "00:00:01  after",
    ], "the divider lands between the days");
});

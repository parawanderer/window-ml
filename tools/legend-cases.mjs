// SHARED test cases for the legend's word-clipping — the single source of truth consumed by BOTH the Node
// assertions (tests/legend.test.mjs) and the visual notebook (tools/preview-legend.mjs, which RENDERS each
// case with its box + expected/actual + a pass/fail badge, so you debug a red case by looking at it).
//
// Each word's span is [left, right]; every word sits on one line, y 0–20. The crop box is [left, top, right,
// bottom]. Spans are ~proportional to the glyphs (≈11 units/char) with real GAPS — mirroring the tight
// Range rects the live DOM gives, so a crop over whitespace, or one that only clips a line vertically, keeps
// nothing, exactly as on a real page. `expect` is clipVisibleText's output.
const T = -1, B = 21;   // a "full height" crop (covers the whole 0–20 line) for the horizontal cases

/** Build clipVisibleText's word list from [left,right] spans on the y 0–20 line. */
export function toWords(text, spans) {
    const out = []; let i = 0; const re = /\S+/g; let m;
    while ((m = re.exec(text))) { const [l, r] = spans[i++]; out.push({ start: m.index, end: m.index + m[0].length, rect: { left: l, top: 0, right: r, bottom: 20 } }); }
    return out;
}

// "hello world I am me" — glyph-tight spans (≈11/char) with ~8px gaps.
const SENT = "hello world I am me";
const SPANS = [[0, 44], [52, 96], [104, 112], [120, 148], [156, 188]];

export const CLIP_CASES = [
    { title: "Both edges spill → …word…", text: SENT, spans: SPANS, box: [46, T, 150, B], expect: "…world I am…",
      note: "Crop covers world/I/am's glyphs; hello is before it and me after → an … on each side." },
    { title: "Fully contained → no …", text: SENT, spans: SPANS, box: [0, T, 200, B], expect: "hello world I am me",
      note: "Every word's glyphs are inside the crop, so nothing is elided." },
    { title: "Left edge cuts mid-word (‘cut off at secret’)", text: SENT, spans: SPANS, box: [108, T, 300, B], expect: "…I am me",
      note: "The left edge (108) lands INSIDE 'I' (104–112) → 'I' is kept ENTIRE; hello/world are to the left → leading …." },
    { title: "Straddling word kept whole", text: SENT, spans: SPANS, box: [0, T, 70, B], expect: "hello world…",
      note: "Right edge (70) is inside 'world' (52–96); the whole word survives, then … for the spill." },
    { title: "Crop lands in a word GAP → nothing kept", text: SENT, spans: SPANS, box: [45, T, 51, B], expect: "",
      note: "The crop sits in the whitespace BETWEEN 'hello' (…44) and 'world' (52…) — neither glyph rect is inside, so nothing is anchored." },
    { title: "Vertically clipped line → nothing kept", text: SENT, spans: SPANS, box: [0, 12, 200, 40], expect: "",
      note: "The crop covers every word horizontally, but its TOP edge (12) slices the line at 60% — only the bottom sliver of the letters shows, which isn't readable, so nothing is anchored (the 'Challenge 1' bottom-of-the-heading case)." },
    { title: "Nothing in the crop → empty", text: SENT, spans: SPANS, box: [500, T, 600, B], expect: "",
      note: "The crop is off past every word → no anchor at all." },
    { title: "Case + inner quotes preserved", text: `SAME-1234 ml.agent("go")`, spans: [[0, 84], [92, 218]], box: [0, T, 240, B], expect: `SAME-1234 ml.agent("go")`,
      note: "A value is case-sensitive and may contain \" — the anchor preserves both (guillemets « » delimit it in the legend)." },
];

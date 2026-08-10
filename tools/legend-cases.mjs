// SHARED test cases for the legend's word-clipping — the single source of truth consumed by BOTH the Node
// assertions (tests/legend.test.mjs) and the visual notebook (tools/preview-legend.mjs, which RENDERS each
// case with its box + expected/actual + a pass/fail badge, so you debug a red case by looking at it).
//
// A case supplies the flattened text, each word's on-screen span [left,right] (one text line, top 0–20),
// and the crop box [left,right]; `expect` is clipVisibleText's output. Geometry only — no DOM — so it runs
// identically in Node and the browser.
//
// The spans are TIGHT to the glyphs with real GAPS between words — mirroring Range.getBoundingClientRect in
// the live DOM (not fat edge-to-edge cells). So a crop landing in a gap keeps nothing, exactly as it would
// on a real page; a word is kept only when the crop touches its actual glyphs.

/** Build clipVisibleText's word list from [left,right] spans on a single line. */
export function toWords(text, spans) {
    const out = []; let i = 0; const re = /\S+/g; let m;
    while ((m = re.exec(text))) { const [l, r] = spans[i++]; out.push({ start: m.index, end: m.index + m[0].length, rect: { left: l, top: 0, right: r, bottom: 20 } }); }
    return out;
}

// "hello world I am me" — tight glyph rects with ~8px gaps between words.
const SENT = "hello world I am me";
const SPANS = [[0, 44], [52, 96], [104, 112], [120, 148], [156, 188]];

export const CLIP_CASES = [
    { title: "Both edges spill → …word…", text: SENT, spans: SPANS, box: [46, 150], expect: "…world I am…",
      note: "Crop covers world/I/am's glyphs; hello is before it and me after → an … on each side." },
    { title: "Fully contained → no …", text: SENT, spans: SPANS, box: [0, 200], expect: "hello world I am me",
      note: "Every word's glyphs are inside the crop, so nothing is elided." },
    { title: "Left edge cuts mid-word (‘cut off at secret’)", text: SENT, spans: SPANS, box: [108, 300], expect: "…I am me",
      note: "The left edge (108) lands INSIDE 'I' (104–112) → 'I' is kept ENTIRE; hello/world's glyphs are to the left → leading …." },
    { title: "Straddling word kept whole", text: SENT, spans: SPANS, box: [0, 70], expect: "hello world…",
      note: "Right edge (70) is inside 'world' (52–96); the whole word survives, then … for the spill." },
    { title: "Crop lands in a word GAP → nothing kept", text: SENT, spans: SPANS, box: [45, 51], expect: "",
      note: "The crop sits in the whitespace BETWEEN 'hello' (…44) and 'world' (52…) — neither glyph rect is inside, so nothing is anchored. This is why tight rects matter: a crop over blank space keeps no word." },
    { title: "Nothing in the crop → empty", text: SENT, spans: SPANS, box: [500, 600], expect: "",
      note: "The crop is off past every word → no anchor at all." },
    { title: "Case + inner quotes preserved", text: `SAME-1234 ml.agent("go")`, spans: [[0, 84], [92, 180]], box: [0, 300], expect: `SAME-1234 ml.agent("go")`,
      note: "A value is case-sensitive and may contain \" — the anchor preserves both (guillemets « » delimit it in the legend)." },
];

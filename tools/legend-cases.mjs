// SHARED test cases for the legend's word-clipping — the single source of truth consumed by BOTH the Node
// assertions (tests/legend.test.mjs) and the visual notebook (tools/preview-legend.mjs, which RENDERS each
// case with its box + expected/actual + a pass/fail badge, so you debug a red case by looking at it).
//
// A case supplies the flattened text, each word's on-screen span [left,right] (one text line, top 0–20),
// and the crop box [left,right]; `expect` is clipVisibleText's output. Geometry only — no DOM — so it runs
// identically in Node and the browser.

/** Build clipVisibleText's word list from [left,right] spans on a single line. */
export function toWords(text, spans) {
    const out = []; let i = 0; const re = /\S+/g; let m;
    while ((m = re.exec(text))) { const [l, r] = spans[i++]; out.push({ start: m.index, end: m.index + m[0].length, rect: { left: l, top: 0, right: r, bottom: 20 } }); }
    return out;
}

// A shared 5-word sentence laid out left→right, plus one value-ish case.
const SENT = "hello world I am me";
const SPANS = [[0, 50], [50, 100], [100, 110], [110, 140], [140, 170]];

export const CLIP_CASES = [
    { title: "Both edges spill → …word…", text: SENT, spans: SPANS, box: [55, 135], expect: "…world I am…",
      note: "Crop covers 'orld I am'; world/I/am's rects intersect → kept whole; hello before + me after → … each side." },
    { title: "Fully contained → no …", text: SENT, spans: SPANS, box: [0, 200], expect: "hello world I am me",
      note: "Every word is inside the crop, so nothing is elided." },
    { title: "Left edge cuts mid-word (‘cut off at secret’)", text: SENT, spans: SPANS, box: [108, 300], expect: "…I am me",
      note: "The left edge bisects 'I' (100–110) → 'I' is kept ENTIRE; hello/world spill before → leading …." },
    { title: "Straddling word kept whole", text: SENT, spans: SPANS, box: [0, 75], expect: "hello world…",
      note: "Right edge at 75 bisects 'world' (50–100); the whole word survives, then … for the spill." },
    { title: "Nothing in the crop → empty", text: SENT, spans: SPANS, box: [500, 600], expect: "",
      note: "No word rect intersects the crop → no anchor at all." },
    { title: "Case + inner quotes preserved", text: `SAME-1234 ml.agent("go")`, spans: [[0, 60], [60, 130], [130, 170]], box: [0, 500], expect: `SAME-1234 ml.agent("go")`,
      note: "A value is case-sensitive and may contain \" — the anchor preserves both (guillemets « » delimit it in the legend)." },
];

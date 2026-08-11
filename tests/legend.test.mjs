// Region LEGEND — the DOM index appended to look/verify crops.
//  - formatLegend: grouped lines, suppress-empty.
//  - regionLegend: categorise the DOM in a box (controls / media / text / boundaries). Text anchors are the
//    element's FULL flattened textContent (crosses inline spans → a copy into findByText is guaranteed to
//    match), short + mostly-visible only; boundaries name the actual iframe selector. jsdom, guarded globals.
import { test, before, after } from "node:test";
import assert from "node:assert";
import { formatLegend, regionLegend, clipVisibleText } from "../legend.ts";
import { CLIP_CASES, toWords } from "../tools/legend-cases.mjs";
const collapseWs = (s) => s.replace(/\s+/g, " ").trim();   // case-preserved, mirrors legend.ts

// The SHARED cases the visual notebook (tools/preview-legend.mjs) renders — asserted here so CI enforces
// exactly what the notebook shows. A red case in the notebook == a failure here.
for (const c of CLIP_CASES) {
    test(`clip-case: ${c.title}`, () => {
        assert.equal(clipVisibleText(c.text, toWords(c.text, c.spans), { left: c.box[0], top: c.box[1], right: c.box[2], bottom: c.box[3] }), c.expect);
    });
}

// --- clipVisibleText (pure): the word-cutting logic — quote only what's in the crop -----------------
const line = (l, r) => ({ left: l, top: 0, right: r, bottom: 20 });
function words(text, rects) {
    const out = []; let i = 0; const re = /\S+/g; let m;
    while ((m = re.exec(text))) out.push({ start: m.index, end: m.index + m[0].length, rect: rects[i++] });
    return out;
}
const SENT = "hello world I am me";
const W = words(SENT, [line(0, 50), line(50, 100), line(100, 110), line(110, 140), line(140, 170)]);

test("clipVisibleText: keeps whole in-box words (completes a cut word) with … on both spills", () => {
    // box covers 'orld I am' → words world/I/am intersect → whole words kept, hello before + me after → …x…
    assert.equal(clipVisibleText(SENT, W, { left: 55, top: 0, right: 135, bottom: 20 }), "…world I am…");
});
test("clipVisibleText: fully-contained → NO ellipses", () => {
    assert.equal(clipVisibleText(SENT, W, { left: 0, top: 0, right: 200, bottom: 20 }), "hello world I am me");
});
test("clipVisibleText: leading edge only → trailing … (spills after, not before)", () => {
    assert.equal(clipVisibleText(SENT, W, { left: 0, top: 0, right: 105, bottom: 20 }), "hello world I…");
});
test("clipVisibleText: left edge cuts mid-word → leading … + the completed word (the 'cut off at secret' case)", () => {
    // box left 108 bisects 'I' (100–110) → I is kept whole; hello/world spill before → leading …
    assert.equal(clipVisibleText(SENT, W, { left: 108, top: 0, right: 300, bottom: 20 }), "…I am me");
});
test("clipVisibleText: a word straddling the edge is kept ENTIRE (not sliced mid-word)", () => {
    // box right edge (75) bisects 'world' (50–100); the whole word survives.
    assert.equal(clipVisibleText(SENT, W, { left: 0, top: 0, right: 75, bottom: 20 }), "hello world…");
});
test("clipVisibleText: nothing in the box → empty string", () => {
    assert.equal(clipVisibleText(SENT, W, { left: 500, top: 0, right: 600, bottom: 20 }), "");
});
test("clipVisibleText: case + inner quotes are PRESERVED (read exact values)", () => {
    const t = `SAME-1234 await ml.agent("go")`;
    const w = words(t, [line(0, 60), line(60, 100), line(100, 170), line(170, 210)]);
    assert.equal(clipVisibleText(t, w, { left: 0, top: 0, right: 500, bottom: 20 }), `SAME-1234 await ml.agent("go")`);
});
test("clipVisibleText: over-long visible run is word-truncated with a trailing …", () => {
    const long = "one two three four five six seven eight nine ten eleven twelve";
    const all = words(long, long.match(/\S+/g).map((_, i) => line(i * 30, i * 30 + 25)));
    const out = clipVisibleText(long, all, { left: 0, top: 0, right: 10000, bottom: 20 }, 15);
    assert.ok(out.endsWith("…") && out.length <= 16 && !/\s…$/.test(out), `cap+trailing…, no dangling space (${out})`);
});
test("clipVisibleText: uses U+2026, never ...", () => {
    const out = clipVisibleText(SENT, W, { left: 55, top: 0, right: 135, bottom: 20 });
    assert.ok(out.includes("…") && !out.includes("..."));
});
test("clipVisibleText: a line the crop clips >50% VERTICALLY is dropped (unreadable sliver)", () => {
    // words on the y 0–20 line; a crop whose TOP edge is at 12 leaves only the bottom 40% → dropped
    assert.equal(clipVisibleText(SENT, W, { left: 0, top: 12, right: 300, bottom: 40 }), "");
    // ≥50% of the height inside → kept
    assert.equal(clipVisibleText(SENT, W, { left: 0, top: 8, right: 300, bottom: 40 }), "hello world I am me");
});

// --- formatLegend (pure): grouped lines + suppress-empty --------------------------------------------
test("formatLegend: grouped lines for each non-empty category", () => {
    const s = formatLegend({
        controls: [{ name: "«Reveal secret»", selector: "#b" }],
        media: [{ name: "img «logo»", selector: ".logo" }],
        text: [{ text: "XORG-4242", selector: ".secret" }],
        boundaries: ["⚠ 1 cross-origin iframe (`#f2`) — no selector reaches inside; locate that selector → click the @pt"],
        moreControls: 0, moreMedia: 0,
    });
    assert.match(s, /DOM in view/);
    assert.match(s, /• controls: «Reveal secret» `#b`/, "label in guillemets, selector in backticks");
    assert.match(s, /• media: img «logo» `\.logo`/);
    assert.match(s, /• text: «XORG-4242» `\.secret`/);
    assert.match(s, /• boundaries: ⚠ 1 cross-origin iframe \(`#f2`\)/);
});

test("formatLegend: nothing notable → empty string (suppress-empty)", () => {
    assert.equal(formatLegend({ controls: [], media: [], text: [], boundaries: [], moreControls: 0, moreMedia: 0 }), "");
});

test("formatLegend: a `seen` set dedups the BOUNDARIES line across calls (not controls/text)", () => {
    const seen = new Set();
    const lg = () => ({
        controls: [{ name: "«Go»", selector: "#g" }],
        text: [{ text: "VAL", selector: ".v" }],
        media: [],
        boundaries: ["1 same-origin iframe (`#f`) — reach inside with `<selector> >>> …`"],
        moreControls: 0, moreMedia: 0,
    });
    const first = formatLegend(lg(), seen);
    assert.match(first, /• boundaries: 1 same-origin iframe/, "first crop shows the boundary");
    const second = formatLegend(lg(), seen);
    assert.doesNotMatch(second, /• boundaries:/, "same boundary is not re-shown");
    assert.match(second, /• controls: «Go» `#g`/, "crop-specific controls/text are NOT deduped");
    assert.match(second, /• text: «VAL» `\.v`/);
    // A genuinely NEW boundary still appears.
    const third = formatLegend({ ...lg(), boundaries: ["⚠ 1 cross-origin iframe (`#x`) — no selector reaches inside"] }, seen);
    assert.match(third, /• boundaries: ⚠ 1 cross-origin iframe \(`#x`\)/);
});

test("formatLegend: truncation counts show as …+N", () => {
    const s = formatLegend({ controls: [{ name: '"a"', selector: "#a" }], media: [], text: [], boundaries: [], moreControls: 3, moreMedia: 0 });
    assert.match(s, /…\+3/);
});

// --- regionLegend (jsdom): categorisation. Globals saved/restored so nothing leaks to other files ----
const G = ["window", "document", "ShadowRoot", "getComputedStyle", "Node", "Element", "Range", "HTMLElement", "DOMParser"];
const saved = {};
let JSDOMref;
before(async () => { ({ JSDOM: JSDOMref } = await import("jsdom")); for (const k of G) saved[k] = globalThis[k]; });
after(() => { for (const k of G) { if (saved[k] === undefined) delete globalThis[k]; else globalThis[k] = saved[k]; } });

function mountDom(html, { w = 110, h = 30 } = {}) {
    const dom = new JSDOMref(`<!doctype html><body>${html}</body>`);
    const win = dom.window;
    for (const k of ["window", "document", "ShadowRoot", "Node", "Element", "HTMLElement", "Range", "DOMParser"]) globalThis[k] = win[k];
    globalThis.window = win; globalThis.document = win.document;
    globalThis.getComputedStyle = win.getComputedStyle.bind(win);
    win.innerWidth = 800; win.innerHeight = 600;
    // No layout engine in jsdom → put every element AND every text-range word inside a fixed in-box rect,
    // so visibleText's Range measurement finds the words (partial word-clipping is covered purely above).
    for (const el of win.document.querySelectorAll("*")) el.getBoundingClientRect = () => ({ left: 10, top: 10, right: 10 + w, bottom: 10 + h, width: w, height: h });
    win.Range.prototype.getBoundingClientRect = () => ({ left: 12, top: 12, right: 12 + w - 4, bottom: 12 + h - 4, width: w - 4, height: h - 4 });
    return win;
}
const SMALL = { left: 0, top: 0, right: 300, bottom: 300 };

test("regionLegend: controls + media + verbatim text, with selectors", () => {
    mountDom(`<button id="go">Reveal secret</button><img class="logo" alt="Company logo" src="/logo.png"><p class="secret">XORG-4242</p>`);
    const lg = regionLegend(SMALL);
    assert.ok(lg.controls.some(c => c.selector === "#go" && /Reveal secret/.test(c.name)), "the button is a control with its selector");
    assert.ok(lg.media.some(m => /logo/.test(m.name)), "the img is media");
    assert.ok(lg.text.some(t => t.text === "XORG-4242"), "the paragraph text is anchored verbatim");
    assert.ok(!lg.text.some(t => /Reveal secret/.test(t.text)), "a control's text isn't ALSO listed as text");
});

test("regionLegend: text anchor is the FLATTENED textContent — inline-span words are NOT dropped", () => {
    // The bug: direct-text-only gave "Challenge 1 — a  iframe" (missing "same-origin"), which isn't a
    // substring of the real textContent → a findByText copy would MISS. Now it's the full flattened text.
    mountDom(`<h2 id="h">Challenge 1 — a <em>same-origin</em> iframe</h2>`);
    const lg = regionLegend(SMALL);
    const anchor = lg.text.find(t => t.selector === "#h");
    assert.ok(anchor, "the heading is anchored");
    assert.ok(/same-origin/.test(anchor.text), "the inline <em> word is present");
    assert.equal(anchor.text, collapseWs(document.getElementById("h").textContent), "anchor == flattened textContent, case preserved");
    assert.match(anchor.text, /Challenge 1/, "case is PRESERVED (uppercase C) — not lowercased");
});

test("regionLegend: a cross-origin iframe boundary names its SELECTOR + @pt", () => {
    const win = mountDom(`<iframe id="f" src="about:blank"></iframe>`);
    Object.defineProperty(win.document.getElementById("f"), "contentDocument", { get: () => null });   // simulate cross-origin
    const lg = regionLegend(SMALL);
    const b = lg.boundaries.find(x => /cross-origin iframe/.test(x));
    assert.ok(b, "cross-origin boundary present");
    assert.match(b, /#f/, "names the iframe selector (its only appearance)");
    assert.match(b, /@pt/, "tells the model to locate → @pt");
});

test("regionLegend: same-origin iframe TEXT is measured in TOP-viewport coords (composes the frame offset)", () => {
    // The bug: visibleText measured words with Range.getBoundingClientRect (iframe-LOCAL), but the crop box
    // is top-viewport — so an iframe's text (e.g. a revealed secret) never matched the box and was dropped,
    // even though its CONTROL showed (controls use viewportRect, which composes the offset).
    const win = mountDom(`<iframe id="f"></iframe>`);
    const iframe = win.document.getElementById("f");
    iframe.getBoundingClientRect = () => ({ left: 200, top: 100, right: 400, bottom: 300, width: 200, height: 200 });
    const idoc = iframe.contentDocument;
    idoc.body.innerHTML = `<p id="s">SAME-1234</p>`;
    idoc.getElementById("s").getBoundingClientRect = () => ({ left: 5, top: 5, right: 90, bottom: 25, width: 85, height: 20 });   // iframe-LOCAL
    iframe.contentWindow.Range.prototype.getBoundingClientRect = () => ({ left: 6, top: 6, right: 80, bottom: 24, width: 74, height: 18 });   // iframe-LOCAL word rect
    // Crop is in TOP-viewport coords, over where the iframe text actually renders (composed ≈ 205,105) — it
    // does NOT cover the iframe-local (5,5), so without the offset fix the word wouldn't match.
    const lg = regionLegend({ left: 190, top: 90, right: 340, bottom: 240 });
    assert.ok(lg.text.some(t => t.text === "SAME-1234"), `the iframe's text is anchored in top-viewport space (got ${JSON.stringify(lg.text)})`);
});

test("regionLegend: prose is NOT anchored (models read paragraphs from the image)", () => {
    mountDom(`<p id="long">${"word ".repeat(40)}</p>`);   // ~200 chars → over the prose limit
    const lg = regionLegend(SMALL);
    assert.ok(!lg.text.some(t => t.selector === "#long"), "the long paragraph is skipped");
});

test("regionLegend: a WIDE (viewport/orientation) crop anchors NO text — only controls/boundaries", () => {
    mountDom(`<button id="go">Go</button><p id="p">A short label here</p>`);
    const lg = regionLegend({ left: 0, top: 0, right: 700, bottom: 500 });   // ≥55% of 800×600
    assert.equal(lg.text.length, 0, "no prose/label dump on an orientation shot");
    assert.ok(lg.controls.some(c => c.selector === "#go"), "controls still listed");
});

test("regionLegend: an out-of-view box yields nothing (→ formatLegend suppresses)", () => {
    mountDom(`<button id="go">Hi</button>`);
    const lg = regionLegend({ left: 5000, top: 5000, right: 5100, bottom: 5100 });
    assert.equal(lg.controls.length + lg.media.length + lg.text.length + lg.boundaries.length, 0);
    assert.equal(formatLegend(lg), "");
});

// --- EXACT thresholds: the precise point where text anchoring stops -----------------------------------
// These pin the cutoffs so they can't silently drift. MIN_VERT is pure (clipVisibleText); the rest exercise
// regionLegend where the constant lives (jsdom stubs every word-rect in-box, so the full text is measured).

test("threshold MIN_VERT (0.5): exactly half the height inside is KEPT; a hair less is dropped", () => {
    // word line is y 0–20 (height 20); coverage = (20 − box.top) / 20.
    assert.equal(clipVisibleText(SENT, W, { left: 0, top: 10, right: 300, bottom: 999 }), "hello world I am me", "top=10 → 50% → kept");
    assert.equal(clipVisibleText(SENT, W, { left: 0, top: 11, right: 300, bottom: 999 }), "", "top=11 → 45% → dropped");
});

test("threshold MIN_ANCHOR (4): a 4-char anchor shows, a 3-char one is too little to bother with", () => {
    mountDom(`<p id="p3">abc</p><p id="p4">abcd</p>`);
    const lg = regionLegend(SMALL);
    assert.ok(!lg.text.some(t => t.selector === "#p3"), "3 chars → dropped");
    assert.ok(lg.text.some(t => t.selector === "#p4" && t.text === "abcd"), "4 chars → kept");
});

test("threshold PROSE_MAX (160): 160 chars still anchors (clamped to 80+…); 161 is skipped as prose", () => {
    mountDom(`<p id="p160">${"a".repeat(160)}</p><p id="p161">${"a".repeat(161)}</p>`);
    const lg = regionLegend(SMALL);
    assert.ok(lg.text.some(t => t.selector === "#p160"), "160 → anchored");
    assert.ok(!lg.text.some(t => t.selector === "#p161"), "161 → skipped (prose, read it from the image)");
});

test("threshold WIDE_FRAC (0.55): a crop under 55% of the viewport anchors text; at/over it drops ALL text", () => {
    mountDom(`<p id="t">read me</p>`);   // window is 800×600 = 480000; 55% = 264000
    assert.ok(regionLegend({ left: 0, top: 0, right: 700, bottom: 375 }).text.some(t => t.selector === "#t"), "700×375 = 262500 (<55%) → text kept");
    assert.equal(regionLegend({ left: 0, top: 0, right: 700, bottom: 378 }).text.length, 0, "700×378 = 264600 (≥55%) → wide, no text");
});

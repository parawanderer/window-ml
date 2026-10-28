// The PDF page measurements (src/pdf/pdf-measure.ts) on operator lists written by hand: the matrix math behind image
// cover, the union of overlapping images, text under render mode 3 across save/restore, and the bounds on the walk.
import test from "node:test";
import assert from "node:assert/strict";
import { GLYPH_CAP, GRID, IMAGE_CAP, IDENTITY, OP_CAP, measureOps, measureText, multiply, pageText, unitSquareThrough } from "../src/pdf/pdf-measure.ts";

// A made-up operator table: nothing here depends on pdf.js's numbering.
const NAMES = ["save", "restore", "transform", "paintFormXObjectBegin", "paintFormXObjectEnd", "paintImageXObject", "paintInlineImageXObject",
    "paintImageMaskXObject", "paintImageXObjectRepeat", "paintImageMaskXObjectRepeat", "paintImageMaskXObjectGroup", "paintInlineImageXObjectGroup",
    "setTextRenderingMode", "showText", "showSpacedText", "nextLineShowText", "nextLineSetSpacingShowText", "beginText", "endText"];
const OPS = Object.fromEntries(NAMES.map((n, i) => [n, i + 1]));
const PAGE = [0, 0, 612, 792];
/** An operator list from `[name, ...args]` rows. */
const ops = (...rows) => ({ fnArray: rows.map(([n]) => OPS[n]), argsArray: rows.map(([n, ...a]) => n === "transform" ? a[0] : a) });
const run = (rows, view = PAGE) => { const { fnArray, argsArray } = ops(...rows); return measureOps(fnArray, argsArray, OPS, view); };
const near = (actual, expected, tol = 0.012) => assert.ok(Math.abs(actual - expected) <= tol, `${actual} is not within ${tol} of ${expected}`);
const glyphs = (n) => Array.from({ length: n }, () => ({ unicode: "a", isSpace: false }));

// --- the matrix math behind image cover ---

test("an image under a page-sized matrix covers the whole page and is a full-page image", () => {
    const m = run([["transform", [612, 0, 0, 792, 0, 0]], ["paintImageXObject", "img", 10, 10]]);
    assert.equal(m.imageCover, 1);
    assert.equal(m.fullPageImage, true);
    assert.equal(m.images, 1);
});

test("an image drawn under the identity matrix is one point square and covers nothing", () => {
    const m = run([["paintImageXObject", "img", 10, 10]]);
    assert.equal(m.imageCover, 0);
    assert.equal(m.fullPageImage, false);
});

test("a scaled image covers its area's share: 408 x 396 is a third of the page", () => {
    near(run([["transform", [408, 0, 0, 396, 102, 250]], ["paintImageXObject", "img", 1, 1]]).imageCover, 1 / 3);
});

test("a rotated image is counted by its own area, not by its bounding box", () => {
    // A 300 pt square turned 45 degrees about the page centre: the box around it is twice its area.
    const s = 300, c = Math.SQRT1_2;
    const m = run([["transform", [s * c, s * c, -s * c, s * c, 306, 396 - s * c]], ["paintImageXObject", "img", 1, 1]]);
    near(m.imageCover, (s * s) / (612 * 792), 0.01);
    assert.ok(m.imageCover < 0.25, "the bounding box would have given 0.37");
});

test("a form XObject's matrix applies inside the form and is undone at its end", () => {
    const m = run([
        ["paintFormXObjectBegin", [0.5, 0, 0, 0.5, 0, 0], [0, 0, 612, 792]],
        ["transform", [612, 0, 0, 792, 0, 0]], ["paintImageXObject", "a", 1, 1],       // a quarter of the page
        ["paintFormXObjectEnd"],
        ["paintImageXObject", "b", 1, 1],                                                // back to the identity: a point
    ]);
    near(m.imageCover, 0.25);
    near(m.largestImage, 0.25);
});

test("save and restore bracket the matrix: an image after the restore is not scaled by what came before", () => {
    const m = run([["save"], ["transform", [612, 0, 0, 792, 0, 0]], ["restore"], ["paintImageXObject", "img", 1, 1]]);
    assert.equal(m.imageCover, 0);
});

test("a restore with nothing saved is ignored", () => {
    const m = run([["restore"], ["transform", [612, 0, 0, 792, 0, 0]], ["paintImageXObject", "img", 1, 1]]);
    assert.equal(m.imageCover, 1);
});

test("an image half off the page counts only the part on it", () => {
    near(run([["transform", [612, 0, 0, 792, 306, 396]], ["paintImageXObject", "img", 1, 1]]).imageCover, 0.25);
});

test("a page whose box does not start at the origin is sampled where the box is", () => {
    near(run([["transform", [100, 0, 0, 100, 150, 250]], ["paintImageXObject", "img", 1, 1]], [100, 200, 300, 400]).imageCover, 100 * 100 / (200 * 200));
});

test("a matrix with no area, or with a non-number in it, is skipped", () => {
    assert.equal(run([["transform", [0, 0, 0, 0, 0, 0]], ["paintImageXObject", "img", 1, 1]]).imageCover, 0);
    assert.equal(run([["transform", [NaN, 0, 0, 792, 0, 0]], ["transform", [612, 0, 0, 792, 0, 0]], ["paintImageXObject", "img", 1, 1]]).imageCover, 1);
});

test("multiply applies its first matrix first, and the unit square follows", () => {
    const scaled = multiply([2, 0, 0, 2, 0, 0], [1, 0, 0, 1, 10, 20]);   // scale, then move
    assert.deepEqual(scaled, [2, 0, 0, 2, 10, 20]);
    assert.deepEqual(unitSquareThrough(scaled), [[10, 20], [12, 20], [12, 22], [10, 22]]);
    assert.deepEqual(multiply(IDENTITY, [1, 2, 3, 4, 5, 6]), [1, 2, 3, 4, 5, 6]);
});

// --- the union of images ---

test("two overlapping images are a union, not a sum", () => {
    const m = run([
        ["save"], ["transform", [306, 0, 0, 792, 0, 0]], ["paintImageXObject", "a", 1, 1], ["restore"],
        ["save"], ["transform", [306, 0, 0, 792, 153, 0]], ["paintImageXObject", "b", 1, 1], ["restore"],
    ]);
    near(m.imageCover, 0.75);   // 459 of 612 wide; a sum would say 1.0
    near(m.largestImage, 0.5);
    assert.equal(m.fullPageImage, false);
});

test("the same image painted twice counts once", () => {
    const m = run([["transform", [306, 0, 0, 396, 0, 0]], ["paintImageXObject", "a", 1, 1], ["paintImageXObject", "a", 1, 1]]);
    near(m.imageCover, 0.25);
    assert.equal(m.images, 2);
});

test("a page covered by four tiles has no single full-page image", () => {
    const tile = (e, f) => [["save"], ["transform", [306, 0, 0, 396, e, f]], ["paintImageXObject", `t${e}${f}`, 1, 1], ["restore"]];
    const m = run([...tile(0, 0), ...tile(306, 0), ...tile(0, 396), ...tile(306, 396)]);
    near(m.imageCover, 1, 0.001);
    assert.equal(m.fullPageImage, false);
    near(m.largestImage, 0.25);
});

// --- the other image paints ---

test("inline images and image masks count like image XObjects", () => {
    const m = run([["save"], ["transform", [612, 0, 0, 396, 0, 0]], ["paintInlineImageXObject", {}], ["restore"], ["transform", [612, 0, 0, 396, 0, 396]], ["paintImageMaskXObject", {}]]);
    assert.equal(m.imageCover, 1);
    assert.equal(m.images, 2);
});

test("a repeated image paints once per position, scaled by the repeat's own size", () => {
    const m = run([["paintImageXObjectRepeat", "img", 306, 396, [0, 0, 306, 0, 0, 396, 306, 396]]]);
    near(m.imageCover, 1, 0.001);
    assert.equal(m.images, 4);
});

test("a repeated mask uses its skew terms and positions", () => {
    const m = run([["paintImageMaskXObjectRepeat", "mask", 612, 0, 0, 396, [0, 0]]]);
    near(m.imageCover, 0.5);
});

test("grouped masks and grouped inline images each carry their own matrix", () => {
    near(run([["paintImageMaskXObjectGroup", [{ transform: [612, 0, 0, 396, 0, 0] }, { transform: [612, 0, 0, 396, 0, 396] }]]]).imageCover, 1, 0.001);
    near(run([["paintInlineImageXObjectGroup", {}, [{ transform: [306, 0, 0, 792, 0, 0] }]]]).imageCover, 0.5);
});

// --- text under render mode 3 ---

test("glyphs shown under render mode 3 are invisible, and the mode survives the end of the text object", () => {
    const m = run([["beginText"], ["setTextRenderingMode", 3], ["showText", glyphs(5)], ["endText"], ["beginText"], ["showText", glyphs(3)], ["endText"]]);
    assert.equal(m.invisibleGlyphs, 8);
    assert.equal(m.visibleGlyphs, 0);
    assert.equal(m.invisibleShare, 1);
});

test("the render mode is restored with the graphics state", () => {
    const m = run([["save"], ["setTextRenderingMode", 3], ["showText", glyphs(5)], ["restore"], ["showText", glyphs(2)]]);
    assert.equal(m.invisibleGlyphs, 5);
    assert.equal(m.visibleGlyphs, 2);
});

test("mode 7 (clip only) is invisible, and 0, 1, 2 and 4 to 6 are not", () => {
    const at = (mode) => run([["setTextRenderingMode", mode], ["showText", glyphs(1)]]);
    for (const mode of [3, 7]) assert.equal(at(mode).invisibleGlyphs, 1, `mode ${mode}`);
    for (const mode of [0, 1, 2, 4, 5, 6]) assert.equal(at(mode).visibleGlyphs, 1, `mode ${mode}`);
});

test("spaces are not glyphs, numbers in a spaced show are skipped, and the other show operators count", () => {
    const g = [...glyphs(2), { unicode: " ", isSpace: true }];
    const m = run([["showSpacedText", [...g, -120, ...glyphs(1)]], ["nextLineShowText", g], ["nextLineSetSpacingShowText", 0, 0, g]]);
    assert.equal(m.visibleGlyphs, 3 + 2 + 2);
});

test("the form XObject's own begin and end bracket the render mode as well", () => {
    const m = run([["paintFormXObjectBegin", IDENTITY, PAGE], ["setTextRenderingMode", 3], ["showText", glyphs(4)], ["paintFormXObjectEnd"], ["showText", glyphs(1)]]);
    assert.equal(m.invisibleGlyphs, 4);
    assert.equal(m.visibleGlyphs, 1);
});

// --- bounds on the walk ---

test("an operator list past OP_CAP is walked only that far, and says so", () => {
    const n = OP_CAP + 5000;
    const fnArray = new Array(n).fill(OPS.save);
    fnArray[n - 1] = OPS.paintImageXObject;   // past the cap: never seen
    const started = Date.now();
    const m = measureOps(fnArray, new Array(n).fill([]), OPS, PAGE);
    assert.equal(m.ops, n);
    assert.equal(m.opsCapped, true);
    assert.equal(m.images, 0);
    assert.ok(Date.now() - started < 2000);
});

test("a million image paints cost IMAGE_CAP rasterisations, not a million", () => {
    const n = OP_CAP;
    const fnArray = new Array(n).fill(OPS.paintImageXObject);
    const started = Date.now();
    const m = measureOps(fnArray, new Array(n).fill([]), { ...OPS }, [0, 0, 1, 1]);
    assert.equal(m.images, n);
    assert.equal(m.imageCover, 1);
    assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms for ${IMAGE_CAP} rasterisations of ${GRID}x${GRID}`);
});

test("a repeat with a million positions stops at the cap", () => {
    const pos = new Float32Array(2_000_000);
    const started = Date.now();
    const m = run([["paintImageXObjectRepeat", "img", 1, 1, pos]]);
    assert.ok(m.images <= IMAGE_CAP + 2);
    assert.ok(Date.now() - started < 3000);
});

test("glyph counting visits at most GLYPH_CAP objects", () => {
    const big = { length: GLYPH_CAP * 2 };   // an array-like whose elements are all undefined: nothing to count, but the loop is bounded
    const started = Date.now();
    const m = run([["showText", big]]);
    assert.equal(m.visibleGlyphs, 0);
    assert.ok(Date.now() - started < 3000);
});

// --- the text layer ---

test("broken characters are U+FFFD, private use and controls; whitespace is neither broken nor usable", () => {
    const t = measureText([{ str: "hello world" }, { str: "��" }, { str: "\u{F0000}\u0001\u0085" }, { str: " \t\n  " }]);
    assert.equal(t.usableChars, 10);
    assert.equal(t.brokenChars, 6);
    near(t.brokenRatio, 6 / 16, 1e-9);
});

test("an empty or marked-content-only layer is zero with a ratio of zero", () => {
    assert.deepEqual(measureText([]), { usableChars: 0, brokenChars: 0, brokenRatio: 0 });
    assert.deepEqual(measureText([{ type: "beginMarkedContent" }, { str: "" }]), { usableChars: 0, brokenChars: 0, brokenRatio: 0 });
});

test("page text keeps lines, drops broken characters and is cut at the cap", () => {
    assert.deepEqual(pageText([{ str: "one�", hasEOL: true }, { str: "two" }], 100), { text: "one\ntwo", truncated: false });
    const cut = pageText([{ str: "abcdef" }, { str: "ghijkl" }], 8);
    assert.deepEqual(cut, { text: "abcdefgh", truncated: true });
});

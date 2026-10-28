// The PDF page classifier (src/pdf/pdf-classify.ts): measurements in, a kind out, with each provisional threshold's
// boundary pinned from both sides. The numbers move when the notebook measures real documents; these tests then move
// with the constants (they are written against the exported names), and the SHAPE of each decision stays.
import test from "node:test";
import assert from "node:assert/strict";
import { BLANK_CHARS, BLANK_COVER, BROKEN_MAX_RATIO, BROKEN_MIN_CHARS, MIXED_COVER, OCR_INVISIBLE_SHARE, SCANNED_COVER, TEXT_MIN_CHARS, classifyPage } from "../src/pdf/pdf-classify.ts";

const page = (over = {}) => ({ usableChars: 0, brokenChars: 0, brokenRatio: 0, imageCover: 0, fullPageImage: false, invisibleShare: 0, ...over });

// --- the table's rows ---

test("enough text and little image is a text page", () => {
    assert.equal(classifyPage(page({ usableChars: 1200, imageCover: 0.02 })), "text");
});

test("almost no text under a mostly-covered page is scanned", () => {
    assert.equal(classifyPage(page({ usableChars: 0, imageCover: 1, fullPageImage: true })), "scanned");
});

test("a scan with a typed footnote is still scanned: some text, most of the page a picture", () => {
    assert.equal(classifyPage(page({ usableChars: 58, imageCover: 1, fullPageImage: true })), "scanned");
});

test("enough text and a real share of picture is mixed", () => {
    assert.equal(classifyPage(page({ usableChars: 800, imageCover: 0.34 })), "mixed");
});

test("invisible text over one full-page image is an OCR'd scan, not mixed", () => {
    assert.equal(classifyPage(page({ usableChars: 1100, imageCover: 1, fullPageImage: true, invisibleShare: 1 })), "ocr-scan");
});

test("nothing at all is blank", () => {
    assert.equal(classifyPage(page()), "blank");
});

test("a text layer that is mostly junk is not text, even with no image", () => {
    assert.equal(classifyPage(page({ usableChars: 0, brokenChars: 1200, brokenRatio: 1 })), "scanned");
});

// --- the boundaries ---

test("TEXT_MIN_CHARS: one character short is not enough text, the number itself is", () => {
    assert.equal(classifyPage(page({ usableChars: TEXT_MIN_CHARS - 1, imageCover: 1, fullPageImage: true })), "scanned");
    assert.equal(classifyPage(page({ usableChars: TEXT_MIN_CHARS, imageCover: 1, fullPageImage: true })), "mixed");
    assert.equal(classifyPage(page({ usableChars: TEXT_MIN_CHARS - 1 })), "text", "a short page with no picture is a short text page, not a scan");
});

test("MIXED_COVER: the share where a text page with a picture becomes mixed", () => {
    assert.equal(classifyPage(page({ usableChars: 500, imageCover: MIXED_COVER - 0.01 })), "text");
    assert.equal(classifyPage(page({ usableChars: 500, imageCover: MIXED_COVER })), "mixed");
});

test("SCANNED_COVER: little text under that much picture is scanned, under it a figure with a caption is mixed", () => {
    assert.equal(classifyPage(page({ usableChars: 40, imageCover: SCANNED_COVER })), "scanned");
    assert.equal(classifyPage(page({ usableChars: 40, imageCover: SCANNED_COVER - 0.01 })), "mixed");
    assert.equal(classifyPage(page({ usableChars: 40, imageCover: MIXED_COVER - 0.01 })), "text");
});

test("BLANK_CHARS and BLANK_COVER: a stray mark or a speck is still blank, one more is not", () => {
    assert.equal(classifyPage(page({ usableChars: BLANK_CHARS - 1, imageCover: BLANK_COVER - 0.001 })), "blank");
    assert.equal(classifyPage(page({ usableChars: BLANK_CHARS })), "text");
    assert.equal(classifyPage(page({ imageCover: BLANK_COVER })), "text", "a small picture alone is not blank");
});

test("BROKEN_MAX_RATIO: text with a third of its layer broken is junk; with the ratio at the limit it is trusted", () => {
    const layer = (ratio) => { const total = 1000; const brokenChars = Math.round(total * ratio); return page({ usableChars: total - brokenChars, brokenChars, brokenRatio: ratio, imageCover: 0 }); };
    assert.equal(classifyPage(layer(BROKEN_MAX_RATIO)), "text");
    assert.equal(classifyPage(layer(BROKEN_MAX_RATIO + 0.05)), "scanned");
});

test("BROKEN_MIN_CHARS: a handful of broken characters on a short page prove nothing", () => {
    const m = { usableChars: 10, imageCover: 0 };
    assert.equal(classifyPage(page({ ...m, brokenChars: BROKEN_MIN_CHARS - 1, brokenRatio: 0.7 })), "text");
    assert.equal(classifyPage(page({ ...m, brokenChars: BROKEN_MIN_CHARS, brokenRatio: 0.7 })), "scanned");
});

test("OCR_INVISIBLE_SHARE: a scan layer written mostly in the open is mixed, at the share it is an OCR'd scan", () => {
    const scan = { usableChars: 1000, imageCover: 1, fullPageImage: true };
    assert.equal(classifyPage(page({ ...scan, invisibleShare: OCR_INVISIBLE_SHARE })), "ocr-scan");
    assert.equal(classifyPage(page({ ...scan, invisibleShare: OCR_INVISIBLE_SHARE - 0.05 })), "mixed");
});

test("an OCR layer needs a full-page image: invisible text over a small picture is mixed or text, never ocr-scan", () => {
    assert.equal(classifyPage(page({ usableChars: 1000, imageCover: 0.3, fullPageImage: false, invisibleShare: 1 })), "mixed");
});

test("an OCR layer that reads as broken sends the page as an image, like any junk layer", () => {
    assert.equal(classifyPage(page({ usableChars: 100, brokenChars: 900, brokenRatio: 0.9, imageCover: 1, fullPageImage: true, invisibleShare: 1 })), "scanned");
});

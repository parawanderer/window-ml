// The PDF reader (src/pdf/pdf-read.ts) on pdf.js's legacy build in node, over the committed fixtures: every fixture's
// measurements and kind, the adversarial ones bounded in time with a sentence, and the bounds exercised on a stand-in
// pdf.js where a real file cannot reach them. Rendering needs OffscreenCanvas and is tested in a browser
// (tests/e2e/pdf-offscreen.spec.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { assets, fixture, pdfLib } from "./fixtures/pdf-node.mjs";
import { BYTES_CAP, PAGE_CAP, RENDER_PIXEL_CAP, clampScale, looksLikePdf, readPdf, refusalFor, renderPage } from "../src/pdf/pdf-read.ts";
import { OP_CAP } from "../src/pdf/pdf-measure.ts";

const read = (name, opts = {}) => readPdf(pdfLib, fixture(name), { assets, ...opts });
const page1 = async (name) => { const r = await read(name); assert.equal(r.ok, true, JSON.stringify(r)); return r.doc.pages[0]; };
const near = (actual, expected, tol = 0.012) => assert.ok(Math.abs(actual - expected) <= tol, `${actual} is not within ${tol} of ${expected}`);
/** A refusal is one sentence: a capital, a full stop at the end, no line break, nothing of the exception's own text. */
const oneSentence = (s) => { assert.match(s, /^[A-Z][^\n]*\.$/); assert.doesNotMatch(s, /undefined|Exception|\bat \S+:\d+/); };

// --- each synthetic fixture: its measurements and its kind ---

test("a page of prose is a text page: the text is there, no image, nothing invisible", async () => {
    const p = await page1("text.pdf");
    assert.equal(p.kind, "text");
    assert.equal(p.measure.usableChars, 1145);
    assert.equal(p.measure.imageCover, 0);
    assert.equal(p.measure.invisibleGlyphs, 0);
    assert.match(p.text, /^The committee met on the fourth of March/);
    assert.match(p.text, /\n/, "lines are kept");
});

test("a full-page image with no text is scanned, and is one full-page image", async () => {
    const p = await page1("scan.pdf");
    assert.equal(p.kind, "scanned");
    assert.equal(p.measure.usableChars, 0);
    assert.equal(p.measure.imageCover, 1);
    assert.equal(p.measure.fullPageImage, true);
    assert.equal(p.text, "");
});

test("THE CASE TO TUNE FOR: the scan with a typed footnote is scanned, with its footnote's text", async () => {
    const p = await page1("scan-footnote.pdf");
    assert.equal(p.kind, "scanned");
    assert.equal(p.measure.usableChars, 58);
    assert.equal(p.measure.imageCover, 1);
    assert.equal(p.measure.invisibleGlyphs, 0, "the footnote is visible, so this is not an OCR layer");
    assert.match(p.text, /Typed footnote/);
});

test("the scan with an invisible (render mode 3) text layer is an OCR'd scan", async () => {
    const p = await page1("ocr-scan.pdf");
    assert.equal(p.kind, "ocr-scan");
    assert.equal(p.measure.usableChars, 1145);
    assert.equal(p.measure.visibleGlyphs, 0);
    assert.equal(p.measure.invisibleGlyphs, 1145);
    assert.equal(p.measure.fullPageImage, true);
    assert.match(p.text, /harbour/, "its text is still returned: the layer is good");
});

test("a text page with a chart over a third of it is mixed", async () => {
    const p = await page1("mixed.pdf");
    assert.equal(p.kind, "mixed");
    assert.equal(p.measure.usableChars, 792);
    near(p.measure.imageCover, 1 / 3);
    assert.equal(p.measure.fullPageImage, false);
});

test("a page whose font maps every character to U+FFFD or private use is not text", async () => {
    const p = await page1("junk-text.pdf");
    assert.equal(p.kind, "scanned");
    assert.equal(p.measure.usableChars, 0);
    assert.equal(p.measure.brokenChars, 1269);
    assert.equal(p.measure.brokenRatio, 1);
    assert.equal(p.text, "", "junk is not handed on as text");
});

test("an empty page is blank", async () => {
    const p = await page1("blank.pdf");
    assert.equal(p.kind, "blank");
    assert.equal(p.measure.usableChars, 0);
    assert.equal(p.measure.imageCover, 0);
});

// --- adversarial files: bounded, with a sentence ---

test("a page tree that claims 100,000 pages: pdf.js corrects the count and the three real pages read", async () => {
    const started = Date.now();
    const r = await read("pages-100k.pdf");
    assert.equal(r.ok, true);
    assert.equal(r.doc.pageCount, 3);
    assert.equal(r.doc.pages.length, 3);
    assert.equal(r.doc.truncated, undefined);
    assert.ok(Date.now() - started < 5000);
});

test("a count the reader does trust is cut at the page cap, and the document says so", async () => {
    const lib = standIn({ numPages: 100_000, pages: 5 });
    const r = await readPdf(lib, fixture("text.pdf"), { pageCap: 3 });
    assert.equal(r.ok, true);
    assert.equal(r.doc.pageCount, 100_000);
    assert.equal(r.doc.pages.length, 3);
    assert.deepEqual(r.doc.truncated, { after: 3, why: "page-cap", sentence: "Only the first 3 of 100000 pages were read." });
    oneSentence(r.doc.truncated.sentence);
});

test("the default page cap is PAGE_CAP", async () => {
    const r = await readPdf(standIn({ numPages: 100_000, pages: 100_000 }), fixture("text.pdf"), {});
    assert.equal(r.doc.pages.length, PAGE_CAP);
    assert.equal(r.doc.truncated.why, "page-cap");
});

test("a page that cannot be read ends the read there, after the pages that could", async () => {
    const r = await readPdf(standIn({ numPages: 100_000, pages: 2 }), fixture("text.pdf"), {});
    assert.equal(r.ok, true);
    assert.equal(r.doc.pages.length, 2);
    assert.equal(r.doc.truncated.why, "page-error");
    assert.equal(r.doc.truncated.after, 2);
    oneSentence(r.doc.truncated.sentence);
});

test("a first page that cannot be read refuses the file", async () => {
    const r = await readPdf(standIn({ numPages: 10, pages: 0 }), fixture("text.pdf"), {});
    assert.equal(r.ok, false);
    oneSentence(r.refusal);
});

test("the time budget is checked between pages: a read past it stops and says so", async () => {
    let t = 0;
    const r = await readPdf(standIn({ numPages: 50, pages: 50 }), fixture("text.pdf"), { budgetMs: 10_000, now: () => (t += 4000) });
    assert.equal(r.ok, true);
    assert.equal(r.doc.truncated.why, "time");
    assert.ok(r.doc.pages.length >= 1 && r.doc.pages.length < 50);
    oneSentence(r.doc.truncated.sentence);
});

test("forms nested 80 deep are measured within the operator cap and the time bound", async () => {
    const started = Date.now();
    const p = await page1("nested-forms.pdf");
    assert.ok(p.measure.ops < OP_CAP);
    assert.equal(p.measure.opsCapped, false);
    near(p.measure.imageCover, 90_000 / (612 * 792), 0.01);   // the innermost picture, 300 pt square, through 80 matrices
    assert.ok(Date.now() - started < 5000);
});

test("a page of 40,000 characters is cut at the text cap and marked, and measured on what it holds", async () => {
    const whole = await page1("large-text.pdf");
    assert.equal(whole.textTruncated, undefined);
    assert.ok(whole.text.length > 40_000);
    const r = await read("large-text.pdf", { pageTextCap: 5000 });
    const p = r.doc.pages[0];
    assert.equal(p.textTruncated, true);
    assert.ok(p.text.length <= 5000);
    assert.equal(p.measure.usableChars, whole.measure.usableChars, "the measurement is of the page, not of the cut");
    assert.equal(p.kind, "text");
});

test("a truncated file is refused as damaged, in one sentence", async () => {
    const started = Date.now();
    const r = await read("truncated.pdf");
    assert.equal(r.ok, false);
    assert.equal(r.code, "damaged");
    oneSentence(r.refusal);
    assert.ok(Date.now() - started < 5000);
});

test("a file that is not a PDF is refused by its bytes before pdf.js is asked", async () => {
    let asked = false;
    const lib = { ...pdfLib, getDocument: () => { asked = true; throw new Error("not reached"); } };
    const r = await readPdf(lib, fixture("not-a-pdf.txt"), {});
    assert.equal(r.ok, false);
    assert.equal(r.code, "not-pdf");
    assert.equal(r.refusal, "This file is not a PDF.");
    assert.equal(asked, false);
});

test("an empty file, and one past the byte cap, are refused without being opened", async () => {
    assert.equal((await readPdf(pdfLib, new Uint8Array(0), {})).code, "not-pdf");
    const big = new Uint8Array(BYTES_CAP + 1);
    big.set([0x25, 0x50, 0x44, 0x46, 0x2d]);
    const r = await readPdf(pdfLib, big, {});
    assert.equal(r.code, "too-large");
    oneSentence(r.refusal);
});

test("the header may follow up to a kilobyte of junk, as the format allows, but not more", () => {
    const withJunk = (n) => { const b = new Uint8Array(n + 8); b.set([0x25, 0x50, 0x44, 0x46, 0x2d], n); return b; };
    assert.equal(looksLikePdf(withJunk(100)), true);
    assert.equal(looksLikePdf(withJunk(2000)), false);
});

// --- pdf.js's errors become sentences ---

test("a password error says the PDF is password protected", () => {
    const r = refusalFor(Object.assign(new Error("No password given"), { name: "PasswordException", code: 1 }));
    assert.equal(r.code, "encrypted");
    oneSentence(r.refusal);
    assert.match(r.refusal, /password/);
});

test("an invalid-structure error says damaged, and an unknown error still gives one generic sentence without its own text", () => {
    assert.equal(refusalFor({ name: "InvalidPDFException", message: "Invalid PDF structure." }).code, "damaged");
    const odd = refusalFor(new Error("fetch https://llm.example/v1?key=sk-secret failed"));
    assert.equal(odd.code, "unreadable");
    oneSentence(odd.refusal);
    assert.doesNotMatch(odd.refusal, /secret|example/);
    oneSentence(refusalFor("a bare string").refusal);
    oneSentence(refusalFor(undefined).refusal);
});

// --- render: what node can check ---

test("render has no OffscreenCanvas in node and says so in a sentence", async () => {
    const r = await renderPage(pdfLib, fixture("text.pdf"), 1, 1, assets);
    assert.equal(r.ok, false);
    assert.equal(r.code, "unsupported");
    oneSentence(r.refusal);
});

test("a render's scale is kept in range and lowered to fit the pixel cap", () => {
    assert.equal(clampScale(1, 612, 792), 1);
    assert.equal(clampScale(100, 10, 10), 8);
    assert.equal(clampScale(0, 612, 792), 0.1);
    assert.equal(clampScale(NaN, 612, 792), 1);
    const s = clampScale(8, 612, 792);   // 8x of a letter page is 31 megapixels
    assert.ok(612 * 792 * s * s <= RENDER_PIXEL_CAP * 1.0001);
    assert.ok(s < 8 && s > 4);
});

/** A stand-in pdf.js: `numPages` as the file claims, `pages` of which can be read. Page text is a fixed sentence. */
function standIn({ numPages, pages }) {
    const page = (n) => ({
        view: [0, 0, 612, 792],
        getTextContent: async () => ({ items: [{ str: `Page ${n} has some text on it.`, hasEOL: true }] }),
        getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
        cleanup() {},
    });
    return {
        OPS: pdfLib.OPS,
        getDocument: () => ({
            promise: Promise.resolve({ numPages, getPage: async (n) => { if (n > pages) throw new Error("Invalid page request."); return page(n); } }),
            destroy: async () => {},
        }),
    };
}

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { launchExtension } from "./harness.mjs";

// THE PDF READER IN A REAL BROWSER: the offscreen document starts pdf-worker.js (pdf.js, legacy build, in-thread), which
// finds its wasm, cmaps and fonts under dist/pdfjs/, reads a page by page and draws one with OffscreenCanvas. None of
// that exists in node: the measurements and the classifier are tested there (tests/pdf-read.test.mjs) and this is the
// plumbing around them: offscreen relay, worker, assets, canvas.

const DIR = join(import.meta.dirname, "..", "fixtures", "pdf");
const b64 = (name) => readFileSync(join(DIR, name)).toString("base64");

/** Send one PDF message from the service worker, as the callers will, creating the offscreen document if it is not there. */
async function pdf(ext, msg) {
    return ext.sw.evaluate(async (msg) => {
        if (!(await chrome.offscreen.hasDocument())) {
            await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["WORKERS"], justification: "pdf e2e" }).catch(() => { /* the worker created it first */ });
        }
        // `hasDocument` is true while a document is still loading, before its listener exists: retry until it answers.
        for (let i = 0; ; i++) {
            try { return await chrome.runtime.sendMessage(msg); }
            catch (e) { if (i >= 50 || !/Receiving end does not exist/.test(String(e?.message || e))) throw e; await new Promise((r) => setTimeout(r, 100)); }
        }
    }, msg);
}

test("the offscreen document reads each synthetic fixture page by page and classifies it", async () => {
    const ext = await launchExtension();
    try {
        const kinds = { "text.pdf": "text", "scan.pdf": "scanned", "scan-footnote.pdf": "scanned", "ocr-scan.pdf": "ocr-scan", "mixed.pdf": "mixed", "junk-text.pdf": "scanned", "blank.pdf": "blank" };
        for (const [name, kind] of Object.entries(kinds)) {
            const r = await pdf(ext, { type: "PDF_READ", b64: b64(name) });
            expect(r.ok, `${name}: ${JSON.stringify(r)}`).toBe(true);
            expect(r.doc.pageCount).toBe(1);
            expect(r.doc.pages[0].kind, name).toBe(kind);
        }
        const text = await pdf(ext, { type: "PDF_READ", b64: b64("text.pdf") });
        expect(text.doc.pages[0].text).toMatch(/^The committee met on the fourth of March/);
        expect(text.doc.pages[0].measure.usableChars).toBe(1145);
        const mixed = await pdf(ext, { type: "PDF_READ", b64: b64("mixed.pdf") });
        expect(mixed.doc.pages[0].measure.imageCover).toBeGreaterThan(0.32);
        expect(mixed.doc.pages[0].measure.imageCover).toBeLessThan(0.35);
    } finally {
        await ext.close();
    }
});

test("a file that is not a PDF, a damaged one and a page that is not there are refused with a sentence", async () => {
    const ext = await launchExtension();
    try {
        const notPdf = await pdf(ext, { type: "PDF_READ", b64: b64("not-a-pdf.txt") });
        expect(notPdf).toMatchObject({ ok: false, code: "not-pdf", refusal: "This file is not a PDF." });
        const damaged = await pdf(ext, { type: "PDF_READ", b64: b64("truncated.pdf") });
        expect(damaged).toMatchObject({ ok: false, code: "damaged" });
        const nope = await pdf(ext, { type: "PDF_RENDER", b64: b64("text.pdf"), n: 2, scale: 1 });
        expect(nope).toMatchObject({ ok: false, code: "bad-page" });
        const garbage = await pdf(ext, { type: "PDF_READ", b64: "!!! not base64 !!!" });
        expect(garbage.ok).toBe(false);
    } finally {
        await ext.close();
    }
});

test("a page renders to a PNG of the size asked for, and a huge scale is lowered to the pixel cap", async () => {
    const ext = await launchExtension();
    try {
        const one = await pdf(ext, { type: "PDF_RENDER", b64: b64("mixed.pdf"), n: 1, scale: 1 });
        expect(one.ok, JSON.stringify(one)).toBe(true);
        expect({ w: one.width, h: one.height, s: one.scale }).toEqual({ w: 612, h: 792, s: 1 });
        const png = Buffer.from(one.pngB64, "base64");
        expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        expect(png.readUInt32BE(16)).toBe(612);
        expect(png.readUInt32BE(20)).toBe(792);

        const half = await pdf(ext, { type: "PDF_RENDER", b64: b64("text.pdf"), n: 1, scale: 0.5 });
        expect({ w: half.width, h: half.height }).toEqual({ w: 306, h: 396 });

        const huge = await pdf(ext, { type: "PDF_RENDER", b64: b64("scan.pdf"), n: 1, scale: 100 });
        expect(huge.ok, JSON.stringify(huge)).toBe(true);
        expect(huge.width * huge.height).toBeLessThanOrEqual(16_000_000 * 1.001);
        expect(huge.scale).toBeLessThan(8);
    } finally {
        await ext.close();
    }
});

test("the adversarial fixtures come back bounded, each with an answer inside the wall-clock cap", async () => {
    test.setTimeout(120_000);
    const ext = await launchExtension();
    try {
        for (const name of ["pages-100k.pdf", "nested-forms.pdf", "large-text.pdf"]) {
            const started = Date.now();
            const r = await pdf(ext, { type: "PDF_READ", b64: b64(name) });
            expect(r.ok, `${name}: ${JSON.stringify(r)}`).toBe(true);
            expect(Date.now() - started, name).toBeLessThan(45_000);
        }
    } finally {
        await ext.close();
    }
});

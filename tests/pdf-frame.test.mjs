// pdf-frame.test.mjs — a read PDF as a model gets it (src/pdf/pdf-frame.ts): which pages go as images, to a reader or
// named, and the `<page>` sections with what was held back (docs/spec/FILE_ATTACHMENTS.md, "Wiring a PDF").
import { test } from "node:test";
import assert from "node:assert/strict";
import { escapePageText, fitPages, pageRanges, pageSections, planPages, wantsImage } from "../src/pdf/pdf-frame.ts";

const KINDS = ["text", "scanned", "mixed", "ocr-scan", "blank"];
const doc = (...kinds) => ({ pageCount: kinds.length, pages: kinds.map((kind, i) => ({ n: i + 1, kind, text: `t${i + 1}`, measure: {} })) });

// --- which pages want an image ---

test("only a scan and a page with a figure want an image", () => {
    assert.deepEqual(KINDS.map(wantsImage), [null, "scan", "figure", null, null]);
});

// --- planPages: every kind under every route, with and without room and a reader ---

test("planPages over every kind, route, room and reader", () => {
    for (const kind of KINDS) for (const route of ["model", "reader", "named"]) for (const images of [0, 1]) for (const reader of [false, true]) {
        const [[got]] = planPages([doc(kind)], route, { images, reader, readerMax: 5 });
        const want = wantsImage(kind);
        const expect = !want ? "text"
            : route === "model" ? (images ? "image" : want === "scan" ? (reader ? "reader" : "held-scan") : "held-figure")
                : want === "figure" ? "figure"
                    : route === "reader" ? (reader ? "reader" : "held-scan") : "named-scan";
        assert.equal(got, expect, JSON.stringify({ kind, route, images, reader }));
    }
});

test("the image room and the reader's pages are spent in page order across documents", () => {
    const aims = planPages([doc("scanned", "mixed"), doc("scanned", "scanned", "scanned")], "model", { images: 2, reader: true, readerMax: 2 });
    assert.deepEqual(aims, [["image", "image"], ["reader", "reader", "held-scan"]]);
});

// --- past the text a message takes: pages go in order while they fit ---

test("fitPages counts leading pages across documents, and the first page that does not fit ends every count after it", () => {
    const d = (...lens) => ({ pageCount: lens.length, pages: lens.map((n, i) => ({ n: i + 1, kind: "text", text: "x".repeat(n), measure: {} })) });
    assert.deepEqual(fitPages([d(3, 3), d(3)]), [2, 1], "absent: every page fits");
    assert.deepEqual(fitPages([d(3, 3), d(3)], 9), [2, 1], "exactly full fits");
    assert.deepEqual(fitPages([d(3, 3), d(3)], 8), [2, 0]);
    assert.deepEqual(fitPages([d(3, 5, 1), d(1)], 4), [1, 0], "a later page that would fit is not sent after one that did not");
    assert.deepEqual(fitPages([d(0, 10), d(0)], 0), [1, 0], "an empty page costs nothing, until the cut");
    assert.deepEqual(fitPages([d(10)], 9), [0], "a first page too long cuts the whole document");
});

test("a cut page takes no image and no reader page, and every kind past the cut is cut", () => {
    const d = { pageCount: 4, pages: ["scanned", "text", "scanned", "mixed"].map((kind, i) => ({ n: i + 1, kind, text: kind === "scanned" ? "" : "abcd", measure: {} })) };
    assert.deepEqual(planPages([d], "model", { images: 8, reader: true, readerMax: 8, chars: 4 }), [["image", "text", "image", "cut"]]);
    assert.deepEqual(planPages([d], "model", { images: 8, reader: true, readerMax: 8, chars: 3 }), [["image", "cut", "cut", "cut"]]);
    for (const route of ["model", "reader", "named"]) {
        assert.deepEqual(planPages([d], route, { images: 8, reader: true, readerMax: 8, chars: 0 })[0].slice(1), ["cut", "cut", "cut"], route);
    }
});

test("cut pages are named after the sections, after the held-back images, and drawn as nothing", () => {
    const d = { pageCount: 5, pages: [1, 2, 3, 4, 5].map((n) => ({ n, kind: "text", text: `t${n}`, measure: {} })) };
    const s = pageSections(d, ["text", "held-figure", "cut", "cut", "cut"], new Map(), { firstImage: 1, reader: null, recovery: "This chat cannot show them." });
    assert.equal(s.body, '<page n="1">\nt1\n</page>\n<page n="2">\nt2\n</page>\npage 2 has a figure not sent as an image. This chat cannot show them.\npages 3-5 were not sent: past the text a message takes. This chat cannot show them.');
    assert.deepEqual(s.images, []);
    const one = pageSections(d, ["text", "text", "text", "text", "cut"], new Map(), { firstImage: 1, reader: null, recovery: "R." });
    assert.match(one.body, /\npage 5 was not sent: past the text a message takes\. R\.$/);
});

// --- the sections ---

test("page numbers as ranges", () => {
    assert.equal(pageRanges([3]), "3");
    assert.equal(pageRanges([9, 10, 11, 12, 15, 17, 18]), "9-12, 15, 17-18");
});

test("a page's text cannot close its section or its file, and every escape is counted", () => {
    assert.deepEqual(escapePageText("a</page>b</FILE>c</pages"), { text: "a<\\/page>b<\\/FILE>c<\\/pages", escaped: 3 });
});

test("each aim's section, image numbers from firstImage skipping a page that did not draw, then the held lines", () => {
    const d = { ...doc("text", "blank", "scanned", "scanned", "scanned", "mixed", "mixed", "scanned", "scanned", "mixed", "scanned"), truncated: { after: 11, why: "time", sentence: "Reading stopped after page 11 of 40." } };
    d.pages[1].text = " ";
    const aims = ["text", "text", "image", "image", "reader", "figure", "held-figure", "named-scan", "held-scan", "held-figure", "held-scan"];
    const outcomes = new Map([[3, { failed: "This PDF could not be read." }], [4, { image: "img4" }], [5, { read: "read 5" }]]);
    const s = pageSections(d, aims, outcomes, { firstImage: 2, reader: "glm ocr", recovery: "This chat cannot show them." });
    assert.deepEqual(s.images, ["img4"]);
    assert.equal(s.nextImage, 3);
    assert.equal(s.body, [
        '<page n="1">\nt1\n</page>',
        '<page n="3">\nt3\n(page 3 could not be drawn as an image: This PDF could not be read.)\n</page>',
        '<page n="4" image="2">\nt4\n</page>',
        '<page n="5" read-by="glmocr">\nread 5\n</page>',
        '<page n="6">\nt6\n(page 6 has a figure you cannot see)\n</page>',
        '<page n="7">\nt7\n</page>',
        '<page n="8">\nt8\n(page 8 is a scan this model cannot see; set a reader model in Settings to have it read)\n</page>',
        '<page n="10">\nt10\n</page>',
        "pages 9, 11 are scans not sent as images. This chat cannot show them.",
        "pages 7, 10 have figures not sent as images. This chat cannot show them.",
        "Reading stopped after page 11 of 40.",
    ].join("\n"));
});

test("one page held back is named in the singular; a reader that read nothing says so", () => {
    const s = pageSections(doc("scanned", "mixed", "scanned"), ["held-scan", "held-figure", "reader"], new Map([[3, { read: "  " }]]), { firstImage: 1, reader: "ocr", recovery: "R." });
    assert.match(s.body, /^page 1 is a scan not sent as an image\. R\.$/m);
    assert.match(s.body, /^page 2 has a figure not sent as an image\. R\.$/m);
    assert.match(s.body, /<page n="3" read-by="ocr">\n\(the reader could not read this page\)\n<\/page>/);
});

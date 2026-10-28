#!/usr/bin/env node
// make-pdf-fixtures.mjs — writes the synthetic PDFs under tests/fixtures/pdf/, by hand, with no PDF library.
//
// Each file is built so the answer is known BY CONSTRUCTION (what the PDF reader should measure and classify it as),
// which is what the thresholds in src/pdf/pdf-classify.ts are tuned against until a notebook measures real documents
// (docs/dev/pdf.md). The bytes are deterministic (no compression, no dates, no ids), so tests/pdf-fixtures.test.mjs
// can check that this script reproduces the committed files exactly.
//
//   node scripts/make-pdf-fixtures.mjs            # (re)write tests/fixtures/pdf/
//   node scripts/make-pdf-fixtures.mjs --check    # exit 1 if a committed file differs
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "pdf");
const W = 612, H = 792;

/** A PDF under construction: numbered objects, an xref table computed at the end. */
class Doc {
    objs = [];
    /** Add an object, returning its number. */
    add(body) { this.objs.push(body); return this.objs.length; }
    /** Reserve a number now (a forward reference) and fill it with `set`. */
    reserve() { return this.add(null); }
    set(n, body) { this.objs[n - 1] = body; }
    /** `<< dict >> stream data endstream` with the right /Length. */
    static stream(dict, data) {
        const body = Buffer.from(data, "latin1");
        return `<< ${dict} /Length ${body.length} >>\nstream\n${data}\nendstream`;
    }
    build(root = 1) {
        const parts = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1")];
        const offsets = [];
        let at = parts[0].length;
        this.objs.forEach((body, i) => {
            offsets.push(at);
            const b = Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, "latin1");
            parts.push(b); at += b.length;
        });
        const xref = [`xref\n0 ${this.objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
        parts.push(Buffer.from(`${xref}trailer\n<< /Size ${this.objs.length + 1} /Root ${root} 0 R >>\nstartxref\n${at}\n%%EOF\n`, "latin1"));
        return Buffer.concat(parts);
    }
}

/** A deterministic gray raster (any picture will do): diagonal stripes over a gradient, as ASCIIHex so it needs no zlib. */
function rasterObject(w = 32, h = 40) {
    let hex = "";
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) hex += ((x * 7 + y * 13 + (((x >> 2) ^ (y >> 2)) & 1) * 90) & 0xff).toString(16).padStart(2, "0");
    return Doc.stream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode`, `${hex}>`);
}

const PROSE = [
    "The committee met on the fourth of March to review the proposed changes to the harbour regulations.",
    "Members noted that the existing rules had not been revised since the nineteen nineties and no longer matched",
    "the way the port is used today. Cargo volumes have roughly doubled, and the pilot service now runs through",
    "the night. A summary of the submissions received during the consultation period follows, grouped by theme.",
    "Several operators asked for the berthing fees to be published a full quarter before they take effect, so that",
    "contracts can be priced against them. The harbour master agreed in principle but asked that an exception be",
    "kept for emergency repairs, where a vessel may need a berth at short notice and at a reduced rate.",
    "Residents of the old quarter raised the matter of noise from the cranes between ten at night and six in the",
    "morning. The committee asked the harbour master to report back on options, including a limit on the number of",
    "cranes working at once, and on whether the quieter electric models could be bought through the capital fund.",
    "The treasurer presented the accounts for the year. Income was slightly above the forecast, mostly because of",
    "the new cold store, while the cost of dredging came in under budget after the contractor finished early.",
    "The next meeting is set for the first Tuesday of May. Papers will be circulated one week beforehand.",
];

/** A content stream that shows `lines` in Helvetica at `size`, from the top left, `lead` apart. `mode` is the text render mode. */
const textBlock = (lines, { size = 11, lead = 14, y = 720, mode = 0 } = {}) =>
    `BT ${mode ? `${mode} Tr ` : ""}/F1 ${size} Tf 72 ${y} Td ${lead} TL\n${lines.map((l, i) => `${i ? "T* " : ""}(${l}) Tj`).join("\n")}\nET\n`;

/** One page with `content`; the font is Helvetica (F1), the picture (when `image`) is /Im0. Returns the doc. */
function onePage(content, { image = false, font = null } = {}) {
    const d = new Doc();
    const catalog = d.reserve(), pages = d.reserve(), page = d.reserve();
    const f1 = font ?? d.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    const im = image ? d.add(rasterObject()) : 0;
    const c = d.add(Doc.stream("", content));
    d.set(catalog, `<< /Type /Catalog /Pages ${pages} 0 R >>`);
    d.set(pages, `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`);
    d.set(page, `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${W} ${H}] /Contents ${c} 0 R /Resources << /Font << /F1 ${f1} 0 R >>${image ? ` /XObject << /Im0 ${im} 0 R >>` : ""} >> >>`);
    return d;
}

const FULL = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q\n`;
const out = {};

// A page of prose: lots of text, no picture.
out["text.pdf"] = onePage(textBlock(PROSE)).build();
// The same page as a picture: one image over the whole page, no text.
out["scan.pdf"] = onePage(FULL, { image: true }).build();
// THE CASE TO TUNE FOR: the scan plus one typed line at the foot. Some text, still a scan.
out["scan-footnote.pdf"] = onePage(FULL + textBlock(["1. Typed footnote: received 12 March, filed under reference A-1234."], { size: 9, y: 36 }), { image: true }).build();
// What a scanner's OCR writes: the scan, and the recognised text drawn invisibly (text render mode 3) over it.
out["ocr-scan.pdf"] = onePage(FULL + textBlock(PROSE, { mode: 3 }), { image: true }).build();
// A text page with a chart over about a third of it: 408 x 396 of 612 x 792 is 33.3 percent.
out["mixed.pdf"] = onePage(textBlock(PROSE.slice(0, 6), { y: 740 }) + `q 408 0 0 396 102 250 cm /Im0 Do Q\n` + textBlock(PROSE.slice(6, 9), { y: 190 }), { image: true }).build();
// Text whose layer extracts as junk: the font's ToUnicode sends every code to U+FFFD (lines 1-6) or to the private-use
// area (lines 7-12), the way a subset font with no mapping does. The page LOOKS right; the characters mean nothing.
{
    const d = new Doc();
    const catalog = d.reserve(), pages = d.reserve(), page = d.reserve();
    const head = "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Junk def /CMapType 2 def 1 begincodespacerange <20> <7E> endcodespacerange";
    const codes = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => (0x20 + i).toString(16).toUpperCase().padStart(2, "0"));
    // One font cannot map a code two ways, so two fonts: F1 sends every code to U+FFFD, F2 to U+E000.. (private use).
    const tu1 = d.add(Doc.stream("", `${head} ${codes.length} beginbfchar ${codes.map((c) => `<${c}> <FFFD>`).join(" ")} endbfchar endcmap end end`));
    const tu2 = d.add(Doc.stream("", `${head} 1 beginbfrange <20> <7E> <E000> endbfrange endcmap end end`));
    const f1 = d.add(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode ${tu1} 0 R >>`);
    const f2 = d.add(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode ${tu2} 0 R >>`);
    const c = d.add(Doc.stream("", textBlock(PROSE.slice(0, 6), { y: 740 }) + textBlock(PROSE.slice(6, 12), { y: 440 }).replace("/F1", "/F2")));
    d.set(catalog, `<< /Type /Catalog /Pages ${pages} 0 R >>`);
    d.set(pages, `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`);
    d.set(page, `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${W} ${H}] /Contents ${c} 0 R /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> >>`);
    out["junk-text.pdf"] = d.build();
}
// A blank page: an empty content stream.
out["blank.pdf"] = onePage("").build();

// ---- Adversarial ----
// A page tree claiming 100,000 pages and holding three. pdf.js walks the tree and corrects the count (numPages is 3),
// so this proves the lie is survived; the reader's page cap is tested against a count it does trust (tests/pdf-read.test.mjs).
{
    const d = new Doc();
    const catalog = d.reserve(), pages = d.reserve();
    const f1 = d.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
    const kids = [];
    for (let i = 1; i <= 3; i++) {
        const c = d.add(Doc.stream("", textBlock([`Page ${i} of a document that claims to have a hundred thousand pages.`])));
        kids.push(d.add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${W} ${H}] /Contents ${c} 0 R /Resources << /Font << /F1 ${f1} 0 R >> >> >>`));
    }
    d.set(catalog, `<< /Type /Catalog /Pages ${pages} 0 R >>`);
    // The three pages, then a subtree that claims the other 99,997 and holds none of them.
    const ghost = d.add(`<< /Type /Pages /Parent ${pages} 0 R /Kids [] /Count 99997 >>`);
    d.set(pages, `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")} ${ghost} 0 R] /Count 100000 >>`);
    out["pages-100k.pdf"] = d.build();
}
// Form XObjects nested 80 deep (each draws the next), the innermost drawing a small picture.
{
    const d = new Doc();
    const catalog = d.reserve(), pages = d.reserve(), page = d.reserve();
    const im = d.add(rasterObject());
    const DEPTH = 80;
    const forms = Array.from({ length: DEPTH }, () => d.reserve());
    forms.forEach((n, i) => {
        const inner = i === DEPTH - 1 ? `/Im0 Do` : `/X Do`;
        const res = i === DEPTH - 1 ? `/XObject << /Im0 ${im} 0 R >>` : `/XObject << /X ${forms[i + 1]} 0 R >>`;
        d.set(n, Doc.stream(`/Type /XObject /Subtype /Form /BBox [0 0 ${W} ${H}] /Matrix [1 0 0 1 0 0] /Resources << ${res} >>`, `q 1 0 0 1 0 0 cm ${i === DEPTH - 1 ? "300 0 0 300 100 100 cm " : ""}${inner} Q`));
    });
    const c = d.add(Doc.stream("", "/X Do\n"));
    d.set(catalog, `<< /Type /Catalog /Pages ${pages} 0 R >>`);
    d.set(pages, `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`);
    d.set(page, `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${W} ${H}] /Contents ${c} 0 R /Resources << /XObject << /X ${forms[0]} 0 R >> >> >>`);
    out["nested-forms.pdf"] = d.build();
}
// 40,000 characters of text on one page, in 20 lines at a 0.4 pt size. (pdf.js drops text that runs off the page, so a
// single 40,000 character line would shrink to what fits; this keeps all of it on the page.)
{
    const line = "lorem ipsum ".repeat(167).slice(0, 2000);
    out["large-text.pdf"] = onePage(`BT /F1 0.4 Tf 10 700 Td 0.4 TL\n${Array.from({ length: 20 }, (_, i) => `${i ? "T* " : ""}(${line}) Tj`).join("\n")}\nET\n`).build();
}
// A real file cut off at 60 percent: no xref, no trailer, an object in half.
out["truncated.pdf"] = out["text.pdf"].subarray(0, Math.floor(out["text.pdf"].length * 0.6));
// Not a PDF at all.
out["not-a-pdf.txt"] = Buffer.from("This is a plain text file, not a PDF document.\nIt has a .txt name here, and a reader must refuse it by its bytes.\n");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const check = process.argv.includes("--check");
    mkdirSync(OUT, { recursive: true });
    let bad = 0;
    for (const [name, bytes] of Object.entries(out)) {
        const path = join(OUT, name);
        if (check) {
            if (!existsSync(path) || !readFileSync(path).equals(bytes)) { console.error(`differs: ${name}`); bad++; }
        } else writeFileSync(path, bytes);
    }
    if (check) process.exit(bad ? 1 : 0);
    console.log(`wrote ${Object.keys(out).length} files to ${OUT}`);
}

export { out as FIXTURES, OUT as FIXTURE_DIR };

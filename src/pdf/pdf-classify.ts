// pdf-classify.ts — what a PDF page IS, from its measurements: text, scanned, mixed, an OCR'd scan, or blank.
//
// Pure. The verdict decides what is sent for the page (docs/spec/FILE_ATTACHMENTS.md, "Slice 2: PDFs"): its text, its
// image, both, or nothing. EVERY THRESHOLD BELOW IS PROVISIONAL: a first defensible value, chosen against the synthetic
// fixtures (tests/fixtures/pdf/), until the notebook over real documents measures them (docs/dev/pdf.md).
import type { PageMeasure } from "./pdf-measure";

/** What a page is. `scanned` also covers a page whose text layer is junk: both are sent as the page's image. */
export type PageKind = "text" | "scanned" | "mixed" | "ocr-scan" | "blank";

/** PROVISIONAL. Usable characters for a page to count as having text: about two lines of body copy, so a page number,
 *  a header or a typed footnote on a scan stays under it. */
export const TEXT_MIN_CHARS = 150;
/** PROVISIONAL. Share of the text layer that may be broken (U+FFFD, private use, controls) before it is not trusted:
 *  a few stray symbols in good text are normal, a third is a font with no Unicode mapping. */
export const BROKEN_MAX_RATIO = 0.3;
/** PROVISIONAL. Broken characters needed to call a short layer junk: below it a handful of odd glyphs prove nothing. */
export const BROKEN_MIN_CHARS = 20;
/** PROVISIONAL. Image cover from which a page with little text is a scan: more than half the page is picture. */
export const SCANNED_COVER = 0.5;
/** PROVISIONAL. Image cover from which a page with text is "mixed": under it a logo or an icon stays a text page. */
export const MIXED_COVER = 0.15;
/** PROVISIONAL. Image cover under which a page with no text is blank: a stray speck is not content. */
export const BLANK_COVER = 0.02;
/** PROVISIONAL. Usable characters under which a page has no text at all (a stray mark or two). */
export const BLANK_CHARS = 3;
/** PROVISIONAL. Share of shown glyphs that are invisible (render mode 3) for a text layer to be an OCR layer: scanners
 *  write all of it invisibly, so 0.9 leaves room for a visible stamp or a page number drawn by the same tool. */
export const OCR_INVISIBLE_SHARE = 0.9;

/** The measurements `classifyPage` reads. */
export type ClassifyInput = Pick<PageMeasure, "usableChars" | "brokenChars" | "brokenRatio" | "imageCover" | "fullPageImage" | "invisibleShare">;

/**
 * The page's kind. In order:
 *  1. invisible text over one full-page image, and the layer is trustworthy: `ocr-scan`;
 *  2. enough trustworthy text: `mixed` when images cover `MIXED_COVER` or more, else `text`;
 *  3. otherwise (little or broken text): a junk layer or `SCANNED_COVER` of picture is `scanned`; next to nothing at
 *     all is `blank`; a figure with a caption is `mixed`; a short page of text (a title page) is `text`.
 * A page of vector drawing with no text and no image reads as `blank`: the measurements do not see paths.
 */
export function classifyPage(m: ClassifyInput): PageKind {
    const junk = m.brokenChars >= BROKEN_MIN_CHARS && m.brokenRatio > BROKEN_MAX_RATIO;
    const enough = m.usableChars >= TEXT_MIN_CHARS && m.brokenRatio <= BROKEN_MAX_RATIO;
    if (enough && m.fullPageImage && m.invisibleShare >= OCR_INVISIBLE_SHARE) return "ocr-scan";
    if (enough) return m.imageCover >= MIXED_COVER ? "mixed" : "text";
    if (junk || m.imageCover >= SCANNED_COVER) return "scanned";
    if (m.usableChars < BLANK_CHARS && m.imageCover < BLANK_COVER) return "blank";
    return m.imageCover >= MIXED_COVER ? "mixed" : "text";
}

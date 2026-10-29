// pdf-frame.ts — a read PDF as a model gets it: which pages go as images, which to a reader model, which are named
// as not sent, and the `<page>` sections that carry them (docs/spec/FILE_ATTACHMENTS.md, "Wiring a PDF through the
// attach path").
//
// Pure, and about the document only: attached-files.ts wraps the sections in a `<file>` block, and a PDF that arrives
// some other way (a fetch) can wrap the same sections in its own frame.

import type { PdfDoc } from "./pdf-read";

/** Where the pages that need an image go, from the model's vision (image-gate.ts): to the model, to the reader model's
 *  reading of them, or named as not sent. */
export type PageRoute = "model" | "reader" | "named";

/**
 * What one page sends.
 * - `text`: its text only (a text page, an OCR'd scan, a blank page)
 * - `image`: its text and its rendered image, to the model
 * - `reader`: the reader model's reading of its image, in place of its text (a scan has almost none)
 * - `named-scan`: a scan this model cannot see and nothing can read; named in its section
 * - `figure`: its text, and a line saying it has a figure the model cannot see
 * - `held-scan`, `held-figure`: past the image cap; named after the pages
 * - `cut`: past the text the message takes, with every page after it; named after the pages, and not drawn
 */
export type PageAim = "text" | "image" | "reader" | "named-scan" | "figure" | "held-scan" | "held-figure" | "cut";

/** What a planned page came to: the rendered image (a data URL) or why it was not drawn, and the reader's text. */
export interface PageOutcome { image?: string; failed?: string; read?: string }

/** Pages whose kind asks for an image: a scan (nothing without it), or a page with a figure (text plus the figure). */
export function wantsImage(kind: string): "scan" | "figure" | null {
    return kind === "scanned" ? "scan" : kind === "mixed" ? "figure" : null;
}

/**
 * How many leading pages of each document fit in `chars` characters of page text, in page order across the
 * documents: the first page that does not fit ends the count, for it and for every document after it.
 * @param docs the documents, in attach order
 * @param chars the characters of page text the message takes (absent: every page fits)
 */
export function fitPages(docs: readonly PdfDoc[], chars?: number): number[] {
    let room = chars ?? Infinity, cut = false;
    return docs.map((doc) => {
        let n = 0;
        for (const p of doc.pages) {
            if (cut || p.text.length > room) { cut = true; break; }
            room -= p.text.length;
            n++;
        }
        return n;
    });
}

/**
 * Decide each page of each document, in page order across the documents.
 * @param docs the documents, in attach order
 * @param route where images go for this model
 * @param opts `images`: how many images the model may still get this message (the cap less what was pasted);
 *   `reader`: whether a reader model is set (a scan past the cap goes to it); `readerMax`: how many pages it may read;
 *   `chars`: how many characters of page text the message takes (absent: no limit). Pages go in order while their
 *   text fits; the first that does not, and every page after it in any document, is `cut`, and takes no image.
 */
export function planPages(docs: readonly PdfDoc[], route: PageRoute, opts: { images: number; reader: boolean; readerMax: number; chars?: number }): PageAim[][] {
    let images = Math.max(0, opts.images), reads = Math.max(0, opts.readerMax);
    const fit = fitPages(docs, opts.chars);
    const read = (): PageAim => (opts.reader && reads > 0 ? (reads--, "reader") : "held-scan");
    return docs.map((doc, d) => doc.pages.map((p, i): PageAim => {
        if (i >= fit[d]) return "cut";
        const want = wantsImage(p.kind);
        if (!want) return "text";
        if (route === "model") {
            if (images > 0) { images--; return "image"; }
            return want === "scan" ? read() : "held-figure";
        }
        if (want === "figure") return "figure";
        return route === "reader" ? read() : "named-scan";
    }));
}

/** "9-12, 15": page numbers as ranges. */
export function pageRanges(ns: readonly number[]): string {
    const out: string[] = [];
    for (let i = 0; i < ns.length; i++) {
        let j = i;
        while (j + 1 < ns.length && ns[j + 1] === ns[j] + 1) j++;
        out.push(j > i ? `${ns[i]}-${ns[j]}` : `${ns[i]}`);
        i = j;
    }
    return out.join(", ");
}

/** A literal `</page` or `</file` (any case) in a page's text, written `<\/…` so the text cannot close its section or
 *  its file and speak as the person; the count goes in the file's `escaped`. */
export function escapePageText(text: string): { text: string; escaped: number } {
    let escaped = 0;
    return { text: text.replace(/<\/(page|file)/gi, (_m, w: string) => { escaped++; return `<\\/${w}`; }), escaped };
}

/**
 * The `<page>` sections of one document, then what was held back, by the rule in HELD_BACK.md.
 * @param doc the read document
 * @param aims {@link planPages}' answer for it
 * @param outcomes what each `image` and `reader` page came to, by page number
 * @param opts `firstImage`: the number of the message's next image (1-based: pasted images come first);
 *   `reader`: the reader model's name; `recovery`: the sentence after a held-back line, saying what can get those pages
 * @returns the sections, how many sequences were escaped, the images in the order their numbers say, and the next
 *   image number
 */
export function pageSections(doc: PdfDoc, aims: readonly PageAim[], outcomes: ReadonlyMap<number, PageOutcome>, opts: { firstImage: number; reader: string | null; recovery: string }): { body: string; escaped: number; images: string[]; nextImage: number } {
    let escaped = 0, k = opts.firstImage;
    const images: string[] = [];
    const parts: string[] = [];
    const heldScans: number[] = [], heldFigures: number[] = [], cut: number[] = [];
    const section = (n: number, attrs: string, lines: string[]): void => {
        const body = lines.filter(Boolean).map((l) => { const e = escapePageText(l); escaped += e.escaped; return e.text; }).join("\n");
        parts.push(`<page n="${n}"${attrs}>\n${body}${body && !body.endsWith("\n") ? "\n" : ""}</page>`);
    };
    doc.pages.forEach((p, i) => {
        const aim = aims[i] ?? "text";
        const text = p.text.trim() ? p.text : "";
        const out = outcomes.get(p.n) ?? {};
        if (aim === "text") { if (text) section(p.n, "", [text]); return; }
        if (aim === "cut") { cut.push(p.n); return; }
        if (aim === "held-scan") { heldScans.push(p.n); return; }
        if (aim === "held-figure") { heldFigures.push(p.n); if (text) section(p.n, "", [text]); return; }
        if (aim === "figure") { section(p.n, "", [text, `(page ${p.n} has a figure you cannot see)`]); return; }
        if (aim === "named-scan") { section(p.n, "", [text, `(page ${p.n} is a scan this model cannot see; set a reader model in Settings to have it read)`]); return; }
        if (out.failed || (aim === "image" && !out.image)) { section(p.n, "", [text, `(page ${p.n} could not be drawn as an image${out.failed ? `: ${out.failed}` : ""})`]); return; }
        if (aim === "image") { images.push(out.image!); section(p.n, ` image="${k++}"`, [text]); return; }
        section(p.n, opts.reader ? ` read-by="${opts.reader.replace(/["<>&\s]/g, "")}"` : "", [out.read?.trim() || "(the reader could not read this page)"]);
    });
    const held = (ns: number[], what: [string, string]): string => ns.length === 1
        ? `page ${ns[0]} ${what[0]}. ${opts.recovery}`
        : `pages ${pageRanges(ns)} ${what[1]}. ${opts.recovery}`;
    if (heldScans.length) parts.push(held(heldScans, ["is a scan not sent as an image", "are scans not sent as images"]));
    if (heldFigures.length) parts.push(held(heldFigures, ["has a figure not sent as an image", "have figures not sent as images"]));
    if (cut.length) parts.push(held(cut, ["was not sent: past the text a message takes", "were not sent: past the text a message takes"]));
    if (doc.truncated) parts.push(doc.truncated.sentence);
    return { body: parts.join("\n"), escaped, images, nextImage: k };
}

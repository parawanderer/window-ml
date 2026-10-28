// pdf-read.ts — open a PDF's bytes with pdf.js and read it page by page: text, measurements, a kind per page, a render.
//
// pdf.js comes in as a parameter (`PdfLib`), so this file runs unchanged in the PDF worker (pdf-lib.ts) and in node
// tests (pdf.js's legacy build), and imports nothing from the extension. Every bound that keeps a crafted file from
// hanging or filling memory is here and named: a page cap, a per-page text cap, a time budget checked between pages,
// a byte cap, a render pixel cap. What a single page can still do inside pdf.js (loop in one operator) is the worker's
// wall-clock kill, not this file's: pdf-worker.ts, offscreen.ts.
import { classifyPage, type PageKind } from "./pdf-classify";
import { measurePage, pageText, type OpsTable, type PageMeasure } from "./pdf-measure";

/** The slice of pdf.js this file uses. `getDocument` returns a loading task; `OPS` is the operator table. */
export interface PdfLib {
    getDocument(src: Record<string, unknown>): { promise: Promise<PdfDocumentLike>; destroy(): Promise<void> };
    OPS: OpsTable;
}
/** The slice of a pdf.js document used here. */
export interface PdfDocumentLike {
    numPages: number;
    getPage(n: number): Promise<PdfPageLike>;
}
/** The slice of a pdf.js page used here. */
export interface PdfPageLike {
    view: number[];
    getTextContent(): Promise<{ items: { str?: string; hasEOL?: boolean }[] }>;
    getOperatorList(): Promise<{ fnArray: ArrayLike<number>; argsArray: ArrayLike<unknown> }>;
    getViewport(o: { scale: number }): { width: number; height: number };
    render(o: Record<string, unknown>): { promise: Promise<void> };
    cleanup(): void;
}

/** PROVISIONAL like the thresholds: a PDF past this many pages reads its first `PAGE_CAP` and says so. */
export const PAGE_CAP = 500;
/** Characters of one page's text kept; a page past it is cut and marked (`textTruncated`). */
export const PAGE_TEXT_CAP = 100_000;
/** Milliseconds a read may take in all, checked between pages; the worker's own wall-clock kill is longer (pdf-worker.ts). */
export const READ_BUDGET_MS = 20_000;
/** A PDF of more bytes than this is refused before pdf.js sees it. */
export const BYTES_CAP = 64 * 1024 * 1024;
/** A render is clamped to this many pixels (4000 x 4000): the scale is lowered to fit, and the result says what it was. */
export const RENDER_PIXEL_CAP = 16_000_000;
/** The scale range a render accepts (1 is 72 dpi). */
export const RENDER_SCALE_MIN = 0.1, RENDER_SCALE_MAX = 8;
/** The image size pdf.js will decode (pixels), against a picture that is a decompression bomb. */
export const MAX_IMAGE_PIXELS = 36_000_000;

/** Where pdf.js finds the files it fetches at run time: each a URL ending in `/` (a file path in node). */
export interface PdfAssets { wasm?: string; cmaps?: string; fonts?: string; icc?: string }

/** The reasons a read or render is refused. */
export type RefusalCode = "not-pdf" | "encrypted" | "damaged" | "too-large" | "unreadable" | "bad-page" | "unsupported" | "timeout";
/** Why a read or render was refused: a code to branch on and ONE sentence for the person; `detail` is the cause, for logs, never shown. */
export interface Refusal { ok: false; code: RefusalCode; refusal: string; detail?: string }

/** One page of a read document. */
export interface PdfPage {
    n: number;
    text: string;
    /** The text was cut at `PAGE_TEXT_CAP`. */
    textTruncated?: true;
    kind: PageKind;
    measure: PageMeasure;
}
/** A document read page by page. `pageCount` is what the file says; `pages` holds those that were read. */
export interface PdfDoc {
    pageCount: number;
    pages: PdfPage[];
    /** Present when not every page was read: after which page, why, and the sentence to show. */
    truncated?: { after: number; why: "page-cap" | "time" | "page-error"; sentence: string };
}
/** What `readPdf` accepts beyond the bytes: the bounds (defaults `PAGE_CAP`, `PAGE_TEXT_CAP`, `READ_BUDGET_MS`), where pdf.js finds its files, a clock for tests. */
export interface ReadOptions {
    pageCap?: number; pageTextCap?: number; budgetMs?: number; assets?: PdfAssets;
    /** The clock, for tests. */
    now?: () => number;
}

/** The sentence for a pdf.js error (or any thrown value): one sentence, no server URL, no key, no stack. */
export function refusalFor(err: unknown): Refusal {
    const name = String((err as { name?: unknown })?.name ?? "");
    const detail = String((err as { message?: unknown })?.message ?? err).slice(0, 200);
    if (name === "PasswordException") return { ok: false, code: "encrypted", refusal: "This PDF is password protected, so it cannot be read.", detail };
    if (name === "InvalidPDFException" || name === "FormatError") return { ok: false, code: "damaged", refusal: "This PDF is damaged or incomplete, so it cannot be read.", detail };
    if (name === "AbortException") return { ok: false, code: "unreadable", refusal: "Reading this PDF was stopped before it finished.", detail };
    return { ok: false, code: "unreadable", refusal: "This PDF could not be read.", detail };
}

/** Whether the bytes are a PDF by their header: `%PDF-` within the first KB (the format allows leading junk). */
export function looksLikePdf(bytes: Uint8Array): boolean {
    const head = bytes.subarray(0, 1024);
    for (let i = 0; i + 5 <= head.length; i++) if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46 && head[i + 4] === 0x2d) return true;
    return false;
}

/** The refusals to check before pdf.js is asked: not a PDF, too large. */
function precheck(bytes: Uint8Array): Refusal | null {
    if (bytes.length > BYTES_CAP) return { ok: false, code: "too-large", refusal: `This PDF is larger than ${BYTES_CAP / 1024 / 1024} MB, so it cannot be read.` };
    if (!looksLikePdf(bytes)) return { ok: false, code: "not-pdf", refusal: "This file is not a PDF." };
    return null;
}

/** The `getDocument` source for these bytes: nothing that runs code, nothing fetched from the network but our own assets. */
function source(bytes: Uint8Array, assets: PdfAssets | undefined): Record<string, unknown> {
    return {
        data: bytes,
        verbosity: 0,
        ...(typeof OffscreenCanvas === "function" ? { CanvasFactory: OffscreenCanvasFactory } : {}),
        isEvalSupported: false, enableXfa: false, useSystemFonts: false, disableFontFace: true,
        maxImageSize: MAX_IMAGE_PIXELS,
        ...(assets?.cmaps ? { cMapUrl: assets.cmaps, cMapPacked: true } : {}),
        ...(assets?.fonts ? { standardFontDataUrl: assets.fonts } : {}),
        ...(assets?.wasm ? { wasmUrl: assets.wasm } : {}),
        ...(assets?.icc ? { iccUrl: assets.icc } : {}),
        // Everything is fetched by this thread's own pdf.js (the "worker" it runs is in-thread): never the page's base.
        useWorkerFetch: !!(assets?.cmaps && assets?.fonts && assets?.wasm),
    };
}

/** Open the bytes, or say why not. The caller destroys the document. */
async function open(lib: PdfLib, bytes: Uint8Array, assets: PdfAssets | undefined): Promise<{ ok: true; doc: PdfDocumentLike; task: { destroy(): Promise<void> } } | Refusal> {
    const bad = precheck(bytes);
    if (bad) return bad;
    const task = lib.getDocument(source(bytes, assets));
    try { return { ok: true, doc: await task.promise, task }; }
    catch (e) { await task.destroy().catch(() => { /* nothing to free */ }); return refusalFor(e); }
}

/** Read one page: text, measurements, kind. */
async function readOne(lib: PdfLib, doc: PdfDocumentLike, n: number, textCap: number): Promise<PdfPage> {
    const page = await doc.getPage(n);
    try {
        const [content, ops] = await Promise.all([page.getTextContent(), page.getOperatorList()]);
        const view = page.view as [number, number, number, number];
        const measure = measurePage({ items: content.items, fnArray: ops.fnArray, argsArray: ops.argsArray, OPS: lib.OPS, view });
        const { text, truncated } = pageText(content.items, textCap);
        return { n, text, ...(truncated ? { textTruncated: true as const } : {}), kind: classifyPage(measure), measure };
    } finally { page.cleanup(); }
}

/**
 * Read a PDF: its first `pageCap` pages, each as text, measurements and a kind. A page pdf.js cannot read ends the read
 * there (`truncated`), unless it is the first, which refuses the file. The time budget is checked between pages.
 */
export async function readPdf(lib: PdfLib, bytes: Uint8Array, opts: ReadOptions = {}): Promise<{ ok: true; doc: PdfDoc } | Refusal> {
    const now = opts.now ?? Date.now;
    const started = now();
    const pageCap = opts.pageCap ?? PAGE_CAP, textCap = opts.pageTextCap ?? PAGE_TEXT_CAP, budget = opts.budgetMs ?? READ_BUDGET_MS;
    const opened = await open(lib, bytes, opts.assets);
    if (!opened.ok) return opened;
    const { doc, task } = opened;
    try {
        const pageCount = Math.max(0, Math.floor(Number(doc.numPages)) || 0);
        if (pageCount < 1) return { ok: false, code: "damaged", refusal: "This PDF has no pages." };
        const pages: PdfPage[] = [];
        let truncated: PdfDoc["truncated"];
        const last = Math.min(pageCount, pageCap);
        for (let n = 1; n <= last; n++) {
            if (n > 1 && now() - started > budget) {
                truncated = { after: n - 1, why: "time", sentence: `Reading stopped after page ${n - 1} of ${pageCount}: it took longer than ${Math.round(budget / 1000)} seconds.` };
                break;
            }
            try { pages.push(await readOne(lib, doc, n, textCap)); }
            catch (e) {
                if (n === 1) return refusalFor(e);
                truncated = { after: n - 1, why: "page-error", sentence: `Reading stopped after page ${n - 1} of ${pageCount}: page ${n} could not be read.` };
                break;
            }
        }
        if (!truncated && pageCount > last) truncated = { after: last, why: "page-cap", sentence: `Only the first ${last} of ${pageCount} pages were read.` };
        return { ok: true, doc: { pageCount, pages, ...(truncated ? { truncated } : {}) } };
    } finally { await task.destroy().catch(() => { /* already gone */ }); }
}

/** A canvas factory pdf.js can use with no DOM: OffscreenCanvas. */
export class OffscreenCanvasFactory {
    create(width: number, height: number) {
        if (!(width > 0) || !(height > 0)) throw new Error("Invalid canvas size");
        const canvas = new OffscreenCanvas(width, height);
        return { canvas, context: canvas.getContext("2d") };
    }
    reset(cc: { canvas: OffscreenCanvas }, width: number, height: number) { cc.canvas.width = width; cc.canvas.height = height; }
    destroy(cc: { canvas: OffscreenCanvas | null; context: unknown }) { if (cc.canvas) cc.canvas.width = cc.canvas.height = 0; cc.canvas = null; cc.context = null; }
}

/** A page rendered: PNG bytes, the pixel size, and the scale actually used (lowered if the request would pass the cap). */
export interface PdfRender { ok: true; png: Uint8Array; width: number; height: number; scale: number }

/** The scale to render at: `scale` within its range, lowered so the page stays within `RENDER_PIXEL_CAP` pixels. */
export function clampScale(scale: number, pageWidth: number, pageHeight: number): number {
    const s = Math.min(RENDER_SCALE_MAX, Math.max(RENDER_SCALE_MIN, Number.isFinite(scale) ? scale : 1));
    const px = pageWidth * pageHeight * s * s;
    return px > RENDER_PIXEL_CAP ? s * Math.sqrt(RENDER_PIXEL_CAP / px) : s;
}

/** Render page `n` to a PNG with OffscreenCanvas. Browser only: node has no OffscreenCanvas. */
export async function renderPage(lib: PdfLib, bytes: Uint8Array, n: number, scale: number, assets?: PdfAssets): Promise<PdfRender | Refusal> {
    if (typeof OffscreenCanvas !== "function") return { ok: false, code: "unsupported", refusal: "This environment cannot draw a PDF page." };
    const opened = await open(lib, bytes, assets);
    if (!opened.ok) return opened;
    const { doc, task } = opened;
    try {
        if (!Number.isInteger(n) || n < 1 || n > doc.numPages) return { ok: false, code: "bad-page", refusal: `This PDF has no page ${n} (it has ${doc.numPages}).` };
        const page = await doc.getPage(n);
        try {
            const one = page.getViewport({ scale: 1 });
            const s = clampScale(scale, one.width, one.height);
            const viewport = page.getViewport({ scale: s });
            const width = Math.max(1, Math.ceil(viewport.width)), height = Math.max(1, Math.ceil(viewport.height));
            const canvas = new OffscreenCanvas(width, height);
            const canvasContext = canvas.getContext("2d");
            await page.render({ canvasContext, canvas, viewport }).promise;
            const blob = await canvas.convertToBlob({ type: "image/png" });
            return { ok: true, png: new Uint8Array(await blob.arrayBuffer()), width, height, scale: s };
        } finally { page.cleanup(); }
    } catch (e) { return refusalFor(e); }
    finally { await task.destroy().catch(() => { /* already gone */ }); }
}

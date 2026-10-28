// pdf-lib.ts — pdf.js, the legacy build, set up to run in THIS thread with no nested worker, as a `PdfLib`.
//
// pdf.js normally spawns its own worker. Here it already runs in a dedicated worker (pdf-worker.ts), so the worker half
// is imported and handed over by name (`globalThis.pdfjsWorker`, the "fake worker" path), which keeps one thread, one
// terminate() and no second script to find. The legacy build is the one used everywhere, node tests included, so the
// code that is tested is the code that ships.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { WorkerMessageHandler } from "pdfjs-dist/legacy/build/pdf.worker.mjs";
import type { PdfLib } from "./pdf-read";

(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = { WorkerMessageHandler };

/** pdf.js as `pdf-read.ts` uses it. */
export const pdfLib: PdfLib = { getDocument: pdfjs.getDocument as unknown as PdfLib["getDocument"], OPS: pdfjs.OPS as unknown as PdfLib["OPS"] };

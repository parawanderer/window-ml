// pdf-worker.ts — the dedicated worker that reads and renders PDFs, started by the offscreen document (offscreen.ts, pdf-host.ts).
//
// The service worker has no DOM or canvas; the offscreen document has both but shares a renderer with the sidebar, so a
// long parse there would freeze the panel. pdf.js therefore runs here, in-thread (pdf-lib.ts, no nested worker), and a
// crafted PDF that never yields is ended by the host's terminate(), the way python-worker.ts's runs are. Stateless: each
// request carries its bytes, opens, answers, and frees the document, so a kill loses nothing but the request in flight.
//
// chrome-free like python-worker.ts: pdf.js's wasm, cmaps and fonts are found next to this script's own URL (build.mjs, copyPdfjs).
import { pdfLib } from "./pdf-lib";
import { readPdf, renderPage, type PdfAssets } from "./pdf-read";
import type { PdfWorkerReply, PdfWorkerRequest } from "./pdf-wire";

/** Where build.mjs puts pdf.js's run-time files, relative to this script. */
const ASSETS: PdfAssets = (() => {
    const at = (dir: string) => new URL(`pdfjs/${dir}/`, self.location.href).href;
    return { wasm: at("wasm"), cmaps: at("cmaps"), fonts: at("standard_fonts"), icc: at("iccs") };
})();

self.onmessage = async (e: MessageEvent<PdfWorkerRequest>) => {
    const req = e.data;
    const bytes = new Uint8Array(req.bytes);
    let reply: PdfWorkerReply;
    let transfer: Transferable[] = [];
    if (req.op === "read") {
        reply = { id: req.id, result: await readPdf(pdfLib, bytes, { assets: ASSETS, pageCap: req.pageCap, pageTextCap: req.pageTextCap, budgetMs: req.budgetMs }) };
    } else {
        const result = await renderPage(pdfLib, bytes, req.n, req.scale, ASSETS);
        reply = { id: req.id, result };
        if (result.ok) transfer = [result.png.buffer];
    }
    (self as unknown as Worker).postMessage(reply, transfer);
};

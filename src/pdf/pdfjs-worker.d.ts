// pdfjs-worker.d.ts — the worker half of pdf.js ships no types; it is only ever handed over by name (pdf-lib.ts).
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
    export const WorkerMessageHandler: unknown;
}

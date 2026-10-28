// pdf-wire.ts — the messages between the offscreen document, its PDF worker and the service worker, and base64 for the one hop that needs it.
//
// The service worker reaches the offscreen document with `chrome.runtime.sendMessage`, which carries JSON: bytes cross
// as base64 there, and as a transferred ArrayBuffer between the offscreen document and its worker.
import type { PdfDoc, PdfRender, Refusal } from "./pdf-read";

/** What the service worker sends the offscreen document (`PDF_READ`, `PDF_RENDER`); `b64` is the PDF's bytes. */
export type PdfMessage =
    | { type: "PDF_READ"; b64: string; pageCap?: number; pageTextCap?: number; budgetMs?: number }
    | { type: "PDF_RENDER"; b64: string; n: number; scale: number };

/** What the offscreen document answers a `PDF_READ` with. */
export type PdfReadReply = { ok: true; doc: PdfDoc } | Refusal;
/** What it answers a `PDF_RENDER` with: the PNG as base64, or a refusal. */
export type PdfRenderReply = ({ ok: true; pngB64: string } & Omit<PdfRender, "ok" | "png">) | Refusal;

/** What the offscreen document posts its worker: one request, the PDF's bytes transferred beside it. */
export type PdfWorkerRequest =
    | { id: number; op: "read"; bytes: ArrayBuffer; pageCap?: number; pageTextCap?: number; budgetMs?: number }
    | { id: number; op: "render"; bytes: ArrayBuffer; n: number; scale: number };
/** A worker request before the host numbers it. */
export type PdfCall = PdfWorkerRequest extends infer R ? (R extends unknown ? Omit<R, "id"> : never) : never;
/** What the worker posts back (a render's PNG bytes transferred). */
export type PdfWorkerReply = { id: number; result: { ok: true; doc: PdfDoc } | PdfRender | Refusal };

/** Base64 of bytes, in chunks (one spread of a whole PDF would overflow the stack). */
export function bytesToB64(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}

/** The bytes of a base64 string, or null if it is not valid base64. */
export function b64ToBytes(b64: string): Uint8Array | null {
    try {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    } catch { return null; }
}

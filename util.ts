// Small page-side utilities: the "where/when am I" context string, a settle beat,
// and element-rect screenshot cropping. Pure-ish (args + browser globals); bundled
// into injected.js.

import { truncate } from "./dom";

/**
 * Compact "where and when am I" snapshot: URL, title, page language, and the
 * current date/time + locale/timezone. ml.agent injects this by default (so the
 * model is oriented — knows what "today" is, and that amazon.nl implies Dutch),
 * and the pageInfo tool exposes it on demand. Guarded so it degrades when a global
 * is missing (e.g. in tests).
 */
export const pageContext = (): string => {
    const parts = [];
    try { if (typeof location !== "undefined" && location.href) parts.push(`URL: ${location.href}`); } catch {}
    try { if (typeof document !== "undefined" && document.title) parts.push(`Title: ${truncate(document.title, 80)}`); } catch {}
    try {
        const lang = (typeof document !== "undefined" && document.documentElement && document.documentElement.getAttribute)
            ? document.documentElement.getAttribute("lang") : null;
        if (lang) parts.push(`Page language: ${lang}`);
    } catch {}
    let locale, tz;
    try { const o = Intl.DateTimeFormat().resolvedOptions(); locale = o.locale; tz = o.timeZone; } catch {}
    const now = new Date();
    parts.push(`Now: ${now.toLocaleString(locale)}${tz ? ` (${tz})` : ""} — ISO ${now.toISOString()}`);
    if (locale) parts.push(`Locale: ${locale}`);
    return parts.join("\n");
};

/**
 * Await a short beat so a click/submit's navigation or DOM update can begin
 * before we read the result. Guarded: where setTimeout is absent (the jsdom
 * test sandbox) it resolves immediately rather than throwing.
 *
 * @param {number} ms Milliseconds to wait (passed to setTimeout).
 * @returns {Promise<void>} Resolves after the delay (or immediately in test sandbox).
 */
export const settle = (ms: number): Promise<void> => new Promise(r => (typeof setTimeout === "function" ? setTimeout(r, ms) : r()));

// Smallest CSS-px width/height an element may have and still be worth
// screenshotting. Below this (a 1px spacer, a collapsed box) the crop is a
// useless sliver; ml.screenshot rejects instead of sending it. Kept tiny so
// genuinely small-but-real targets (icons, badges) still pass.
export const MIN_SHOT_PX = 4;

// Context window (num_ctx) for DELEGATED one-off vision sub-calls — OCR, grounding,
// and the delegated `look`. A single screenshot + a short reply needs only a few
// thousand tokens, but a vision model's DEFAULT context is huge, and Ollama
// pre-allocates KV cache to it (tens of GB), which OOMs modest cards. Capping it
// here keeps those calls affordable for anybody. NOT applied to native look (that
// reuses the agent's own model, which needs its full conversation context).
export const VISION_NUM_CTX = 8192;

/**
 * Crop a full-viewport PNG data URL down to an element's rect. Runs page-side
 * because a data: image doesn't taint the canvas (the cross-origin-taint gotcha
 * only bites remote images), so pixel readback works. rect is in CSS px; the
 * captured PNG is at devicePixelRatio, so scale by dpr and clamp to the image
 * bounds (an element taller than the viewport gets clipped).
 *
 * @param {string} dataUrl The full-viewport PNG data URL.
 * @param {DOMRect} rect The element's bounding rectangle.
 * @param {number} dpr The device pixel ratio.
 * @returns {Promise<string>} The cropped image as a data URL.
 */
export const cropDataUrl = (dataUrl: string, rect: DOMRect, dpr: number): Promise<string> => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
        const sx = Math.max(0, Math.round(rect.left * dpr));
        const sy = Math.max(0, Math.round(rect.top * dpr));
        const sw = Math.max(1, Math.min(Math.round(rect.width * dpr), img.naturalWidth - sx));
        const sh = Math.max(1, Math.min(Math.round(rect.height * dpr), img.naturalHeight - sy));
        const canvas = document.createElement("canvas");
        canvas.width = sw;
        canvas.height = sh;
        canvas.getContext("2d")!.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
        resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => reject(new Error("failed to load the captured screenshot"));
    img.src = dataUrl;
});
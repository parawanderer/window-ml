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

// Context window cap for delegated vision sub-calls — the single source of truth
// lives in contract.ts (shared with the sidebar's model-test); re-exported here so
// page-world consumers (builtin-tools) keep importing it from util.
export { VISION_NUM_CTX } from "./contract";

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
export const cropDataUrl = (dataUrl: string, rect: { left: number; top: number; width: number; height: number }, dpr: number): Promise<string> => new Promise((resolve, reject) => {
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

// --- Canvas coordinate targets: an OPAQUE `@pt:<hex>` token → a viewport {x,y} ------
// A <canvas> has no sub-node to snap to, so `locate` mints a point token that `click`
// resolves (and `screenshot`/`look` can crop+mark for verification). Shared here so
// injected (screenshot) and builtin-tools (locate/click) use one registry. The token is
// opaque — the model copies it verbatim, never authoring coordinates. Page-lifetime map.
const pointRegistry = new Map<string, { x: number; y: number }>();
export const POINT_RE = /^@pt:([0-9a-f]{1,12})$/;
// Half-size of the square `look({ @pt })` crops around a point (→ a 2·R box). Shared
// so `locate({ selector: "@pt:…" })` searches the EXACT box look showed — the model
// re-locates the neighborhood it just visually confirmed holds the target.
export const PT_LOOK_RADIUS = 100;
export const mintPoint = (x: number, y: number): string => {
    const id = Math.random().toString(16).slice(2, 10);
    pointRegistry.set(id, { x: Math.round(x), y: Math.round(y) });
    return `@pt:${id}`;
};
export const resolvePoint = (token: string): { x: number; y: number } | null => {
    const m = POINT_RE.exec((token || "").trim());
    return m ? pointRegistry.get(m[1]) || null : null;
};
// The most-recently-minted point within `within` px of (x,y), if any. Each mint is a
// FRESH token even for the same coordinate, so a re-locate loop that keeps landing on
// the same wrong spot can't otherwise tell it's going in circles — `locate` uses this
// to warn "you already tried here". Call BEFORE minting the new point (so it can't match
// itself). Returns the prior token + coords, or null.
export const nearbyPoint = (x: number, y: number, within = 12): { token: string; x: number; y: number } | null => {
    let best: { token: string; x: number; y: number } | null = null;
    let bestD = within * within;
    for (const [id, p] of pointRegistry) {
        const dx = p.x - x, dy = p.y - y, d = dx * dx + dy * dy;
        if (d <= bestD) { bestD = d; best = { token: `@pt:${id}`, x: p.x, y: p.y }; }
    }
    return best;
};
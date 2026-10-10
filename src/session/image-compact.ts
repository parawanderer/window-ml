// image-compact.ts — the pure half of compacting a saved session's screenshots: find the PNG data URLs in its events,
// and put the lossless WebP for each back where it was. The encoding happens in image-worker.ts (the offscreen
// document); this decides what is encoded and rewrites the events, so it is tested without a browser.
//
// Lossless, and pixel-checked before it is kept: an event is what a transcript and both exports show, and the rule is
// that they show what the model saw. The model's own copy (a row's `history`, what a resume sends) is never touched.
import type { MlDebugEvent } from "../contract/contract-debug";

/** The data URLs compaction rewrites. Only PNG: a JPEG is already lossy, an SVG is text, a WebP is done. */
export const PNG_DATA_URL = /^data:image\/png;base64,/;

/**
 * libwebp's settings for the encode: lossless, at `cwebp -z 6` effort (method 4, quality 75), and `exact` so a
 * transparent pixel keeps its colour. Measured on 264 real run images: 41.6% of the PNG bytes, every pixel equal
 * (tmp/PROMPT_RAW_RENDERED_PLAN.md, "WebP MEASURED").
 */
export const WEBP_LOSSLESS = { lossless: 1, method: 4, quality: 75, exact: 1 } as const;

/** How deep the walk goes into an event: the same bound the archive's image walk uses. */
const MAX_DEPTH = 16;

/** Every distinct PNG data URL in these events, in the order first seen. */
export function collectPngs(events: readonly MlDebugEvent[]): string[] {
    const found = new Set<string>();
    const walk = (v: unknown, depth: number): void => {
        if (depth > MAX_DEPTH || v == null) return;
        if (typeof v === "string") { if (PNG_DATA_URL.test(v)) found.add(v); return; }
        if (typeof v !== "object") return;
        for (const x of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)) walk(x, depth + 1);
    };
    for (const ev of events) walk(ev, 0);
    return [...found];
}

/**
 * These events with each image in `swap` replaced by what it maps to. A value that holds no replaced image is the
 * same object it was, so an event with nothing to replace comes back unchanged; the count and order never change.
 */
export function replaceImages(events: readonly MlDebugEvent[], swap: ReadonlyMap<string, string>): MlDebugEvent[] {
    const walk = (v: unknown, depth: number): unknown => {
        if (depth > MAX_DEPTH || v == null) return v;
        if (typeof v === "string") return swap.get(v) ?? v;
        if (typeof v !== "object") return v;
        if (Array.isArray(v)) {
            let out: unknown[] | null = null;
            v.forEach((x, i) => { const y = walk(x, depth + 1); if (y !== x) (out ??= [...v])[i] = y; });
            return out ?? v;
        }
        let out: Record<string, unknown> | null = null;
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
            const y = walk(x, depth + 1);
            if (y !== x) (out ??= { ...(v as Record<string, unknown>) })[k] = y;
        }
        return out ?? v;
    };
    return events.map((ev) => walk(ev, 0) as MlDebugEvent);
}

/** True when every pixel is fully opaque. A canvas stores colour premultiplied, so only an opaque image survives the
 *  trip through one exactly; anything else is left as PNG. */
export function isOpaque(rgba: Uint8ClampedArray | Uint8Array): boolean {
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) return false;
    return true;
}

/** True when two RGBA buffers hold the same pixels. */
export function samePixels(a: Uint8ClampedArray | Uint8Array, b: Uint8ClampedArray | Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

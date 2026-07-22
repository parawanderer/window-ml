// Set-of-Marks visual element location: an accessibility-agnostic engine that
// finds visible/interactive elements by HIT-TESTING (document.elementFromPoint),
// NOT by matching a selector — so it works on non-semantic UIs (a bare <div> with
// a click handler, an unlabelled <svg> button) where role/ARIA enumeration finds
// nothing. Candidates get numbered badges drawn onto a screenshot in memory (zero
// DOM pollution), so a general vision model can pick one by number ("which badge
// is the like button?") instead of guessing pixel coordinates. Page-side; bundled
// into injected.js.

import { clickSelector } from "./dom";
import { styleHidden, roleOf, accessibleName } from "./a11y";

export type MarkFilter = "clickables" | "inputs" | "images" | "all";

export interface Mark {
    el: Element;
    id: number;      // 1-based badge number
    rect: DOMRect;   // CSS-px viewport rect
    role: string;
    name: string;
    selector: string;
}

const IMG_SEL = "img, svg, canvas, picture, [role='img']";
const INPUT_SEL = "input, textarea, select, [contenteditable='true'], [contenteditable='']";
// Semantically-interactive tags/roles. cursor:pointer is checked separately as the
// one convention even non-semantic UIs keep, so custom <div> buttons still register.
const CLICK_SEL = "a[href], button, input, select, textarea, summary, label, " +
    "[role='button'], [role='link'], [role='menuitem'], [role='menuitemcheckbox'], " +
    "[role='tab'], [role='checkbox'], [role='radio'], [role='switch'], [role='option'], " +
    "[onclick], [tabindex]:not([tabindex='-1'])";

/** True if the element is semantically interactive OR shows a pointer cursor. */
export function isClickish(el: Element): boolean {
    try { if (el.matches(CLICK_SEL)) return true; } catch { /* invalid pseudo on old engines */ }
    try { return getComputedStyle(el).cursor === "pointer"; } catch { return false; }
}

// A pointer cursor inherits, so the deepest text node under a clickable <div>
// also reports "pointer". Climb to the OUTERMOST element still showing pointer —
// the boundary is the actual clickable container, not a leaf inside it.
function pointerBoundary(hit: Element): Element | null {
    let cur: Element | null = hit, top: Element | null = null;
    for (let hops = 0; cur && hops < 10 && cur !== document.body; hops++, cur = cur.parentElement) {
        let cursor: string;
        try { cursor = getComputedStyle(cur).cursor; } catch { break; }
        if (cursor === "pointer") top = cur;
        else if (top) break;   // left the pointer region → the last pointer element is the target
    }
    return top;
}

/**
 * Climb from a raw hit-test element to the MEANINGFUL element for this filter:
 * clickables → nearest semantic-interactive ancestor, else the pointer-cursor
 * boundary; images/inputs → nearest matching ancestor; all → the element itself.
 * Returns null when nothing qualifies (e.g. a plain-text hit under `clickables`).
 */
export function representativeFor(hit: Element, filter: MarkFilter): Element | null {
    if (filter === "all") return hit;
    if (filter === "images" || filter === "inputs") {
        const sel = filter === "images" ? IMG_SEL : INPUT_SEL;
        let el: Element | null = hit;
        for (let hops = 0; el && hops < 6 && el !== document.body; hops++, el = el.parentElement) {
            try { if (el.matches(sel)) return el; } catch { /* ignore */ }
        }
        return null;
    }
    // clickables
    let el: Element | null = hit;
    for (let hops = 0; el && hops < 6 && el !== document.body; hops++, el = el.parentElement) {
        try { if (el.matches(CLICK_SEL)) return el; } catch { /* ignore */ }
    }
    return pointerBoundary(hit);
}

/**
 * Hit-test sweep of the viewport: sample a grid of points, take the topmost
 * element at each (so occluded elements are excluded for free), reduce each to its
 * representative for `filter`, and collect the unique, visible, non-tiny ones.
 *
 * @param {MarkFilter} filter Which elements to keep.
 * @param {{step?: number, max?: number}} [opts] Sample spacing (CSS px) and cap.
 * @returns {Element[]} Unique candidate elements, in reading order (top-left first).
 */
export function collectCandidates(filter: MarkFilter, opts: { step?: number; max?: number } = {}): Element[] {
    const step = opts.step ?? 24, max = opts.max ?? 40;
    const W = window.innerWidth, H = window.innerHeight;
    const seen = new Set<Element>();
    const out: Element[] = [];
    for (let y = Math.floor(step / 2); y < H; y += step) {
        for (let x = Math.floor(step / 2); x < W; x += step) {
            let hit: Element | null;
            try { hit = document.elementFromPoint(x, y); } catch { continue; }
            if (!hit) continue;
            const el = representativeFor(hit, filter);
            if (!el || seen.has(el) || styleHidden(el)) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 4 || r.height < 4) continue;
            seen.add(el);
            out.push(el);
            if (out.length >= max) return out;
        }
    }
    return out;
}

/** Turn candidate elements into numbered Marks (1-based), with role/name/selector. */
export function buildMarks(candidates: Element[]): Mark[] {
    return candidates.map((el, i) => ({
        el, id: i + 1, rect: el.getBoundingClientRect(),
        role: roleOf(el), name: accessibleName(el), selector: clickSelector(el),
    }));
}

// ---- Overlay colour heuristic (grid lines + SoM badges are model-facing, so a fixed
// red vanishes on a red-themed page) ----

// Vivid overlay colours that all read with WHITE text (mid-luminance, saturated),
// spread around the wheel so one is always far from a page's dominant hue.
const OVERLAY_PALETTE: { hex: string; h: number }[] = [
    { hex: "#ff2d55", h: 344 },   // red (the default, kept for a neutral page)
    { hex: "#ff8f00", h: 34 },    // amber
    { hex: "#12b34a", h: 142 },   // green
    { hex: "#00b8d4", h: 189 },   // cyan
    { hex: "#2979ff", h: 217 },   // blue
    { hex: "#c724ff", h: 285 },   // purple
];
const hueDist = (a: number, b: number): number => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/**
 * Colour words in a description → representative hues, so an overlay avoids the
 * TARGET's own colour ("the red umbrella") — which a page histogram alone won't repel
 * when the target is a tiny fraction of the pixels.
 */
export function colorWordHues(text: string): number[] {
    const MAP: Record<string, number> = { red: 0, orange: 30, amber: 40, gold: 45, yellow: 55, lime: 90, green: 140, teal: 175, cyan: 190, blue: 220, indigo: 250, purple: 280, violet: 280, magenta: 320, pink: 340, crimson: 348, scarlet: 5 };
    const t = (text || "").toLowerCase();
    const hues: number[] = [];
    for (const [w, h] of Object.entries(MAP)) if (new RegExp(`\\b${w}\\b`).test(t)) hues.push(h);
    return hues;
}

/**
 * Pick the palette colour that clashes LEAST with a 12-bucket hue histogram (each
 * bucket = summed saturation×value of the image's pixels at that hue), also hard-
 * avoiding any `avoidHues`. Returns a hex; defaults to red on a neutral/grey page.
 */
export function pickOverlayHex(weights: number[], avoidHues: number[] = []): string {
    const buckets = weights.length || 12, span = 360 / buckets;
    let best = OVERLAY_PALETTE[0].hex, bestScore = Infinity;
    for (const c of OVERLAY_PALETTE) {
        let clash = 0;
        for (let b = 0; b < buckets; b++) {
            const bucketHue = b * span + span / 2;
            clash += weights[b] * Math.max(0, 1 - hueDist(bucketHue, c.h) / 60);
        }
        for (const a of avoidHues) if (hueDist(a, c.h) < 45) clash += 1e6;   // never overlay the target's colour
        if (clash < bestScore) { bestScore = clash; best = c.hex; }
    }
    return best;
}

/** Sample an already-drawn canvas into a 12-bucket hue histogram (grey/near-black/
 *  near-white pixels excluded — they don't clash with any hue). */
function sampleHues(ctx: CanvasRenderingContext2D, w: number, h: number): number[] {
    const weights = new Array(12).fill(0);
    let data: Uint8ClampedArray;
    try { data = ctx.getImageData(0, 0, w, h).data; } catch { return weights; }
    const step = Math.max(1, Math.round(Math.sqrt((w * h) / 4000)));   // ~4k samples, dpr-independent
    for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        const r = data[i] / 255, g = data[i + 1] / 255, bl = data[i + 2] / 255;
        const max = Math.max(r, g, bl), min = Math.min(r, g, bl), d = max - min;
        if (d < 0.12 || max < 0.12 || max > 0.97) continue;   // grey / near-black / near-white → no hue claim
        let hue: number;
        if (max === r) hue = ((g - bl) / d + 6) % 6;
        else if (max === g) hue = (bl - r) / d + 2;
        else hue = (r - g) / d + 4;
        hue = hue * 60;
        weights[Math.min(11, Math.floor(hue / 30))] += d * max;
    }
    return weights;
}

/** Pick a contrasting overlay colour for a data-URL image (loads it, samples, scores). */
export function pickOverlayColor(dataUrl: string, avoidHues: number[] = []): Promise<string> {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const cv = document.createElement("canvas");
            cv.width = img.naturalWidth; cv.height = img.naturalHeight;
            const ctx = cv.getContext("2d");
            if (!ctx) return resolve(OVERLAY_PALETTE[0].hex);
            ctx.drawImage(img, 0, 0);
            resolve(pickOverlayHex(sampleHues(ctx, cv.width, cv.height), avoidHues));
        };
        img.onerror = () => resolve(OVERLAY_PALETTE[0].hex);
        img.src = dataUrl;
    });
}

/** One box drawn onto a screenshot: a colored outline + an optional tab holding a
 *  `badge` number or a `label` string above its top-left corner, OR `corners` — two
 *  labels at the top-left and bottom-right corners (for a grounding box shown as two
 *  (x,y) pairs). `rect` is in source units (CSS px for a viewport shot; image px for
 *  the grounding square). */
export interface Annot {
    rect: { left: number; top: number; width: number; height: number };
    color: string;
    badge?: number;
    label?: string;
    corners?: [string, string];   // [top-left, bottom-right] labels
}

/** Format grounding coords [x1,y1,x2,y2] as a readable box — a "(x1, y1) → (x2, y2)"
 *  string for the UI text + the two per-corner labels for the overlay. Ints stay
 *  ints; floats round to 1 decimal with a `.` (a range-1 model reads "0.3, 0.2"). */
export function formatBox(nums: number[]): { text: string; corners: [string, string] } {
    const f = (n: number) => Number.isInteger(n) ? String(n) : (Math.round(n * 10) / 10).toString();
    const tl = `${f(nums[0])}, ${f(nums[1])}`, br = `${f(nums[2])}, ${f(nums[3])}`;
    return { text: `(${tl}) → (${br})`, corners: [tl, br] };
}

/**
 * Draw boxes + labels onto an image in memory. `scale` maps source units to the
 * image's pixels — dpr for a devicePixelRatio-captured viewport shot, 1 for the
 * grounding square (already in its own px). Never touches the live page.
 */
export function annotate(dataUrl: string, boxes: Annot[], scale: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const cv = document.createElement("canvas");
            cv.width = img.naturalWidth; cv.height = img.naturalHeight;
            const ctx = cv.getContext("2d");
            if (!ctx) return reject(new Error("no 2d canvas context for annotate"));
            ctx.drawImage(img, 0, 0);
            const fs = Math.round(13 * scale);
            const pad = Math.round(3 * scale);
            const bh = fs + pad * 2;
            ctx.font = `bold ${fs}px sans-serif`;
            ctx.textBaseline = "top";
            const tab = (text: string, color: string, cornerX: number, cornerY: number, place: "above" | "belowRight") => {
                const bw = Math.ceil(ctx.measureText(text).width) + pad * 2;
                let bx = place === "belowRight" ? cornerX - bw : cornerX;   // right-aligned to end at the corner
                let by = place === "belowRight" ? cornerY : cornerY - bh;   // above the top edge / below the bottom
                bx = Math.max(0, Math.min(bx, cv.width - bw));
                by = Math.max(0, Math.min(by, cv.height - bh));
                ctx.fillStyle = color; ctx.fillRect(bx, by, bw, bh);
                ctx.fillStyle = "#fff"; ctx.fillText(text, bx + pad, by + pad);
            };
            for (const b of boxes) {
                const x = b.rect.left * scale, y = b.rect.top * scale;
                const w = b.rect.width * scale, h = b.rect.height * scale;
                ctx.strokeStyle = b.color; ctx.lineWidth = Math.max(1, Math.round(2 * scale));
                ctx.strokeRect(x, y, w, h);
                if (b.corners) {
                    tab(b.corners[0], b.color, x, y, "above");            // top-left
                    tab(b.corners[1], b.color, x + w, y + h, "belowRight"); // bottom-right
                } else {
                    const text = b.badge != null ? String(b.badge) : b.label;
                    if (text) tab(text, b.color, x, y, "above");
                }
            }
            resolve(cv.toDataURL("image/png"));
        };
        img.onerror = () => reject(new Error("failed to load the screenshot for annotation"));
        img.src = dataUrl;
    });
}

// ---- Grounding-VLM mechanism (locate's optional path) ----

export type Box = { left: number; top: number; right: number; bottom: number };

/**
 * Downscale a screenshot to a `size`×`size` square (stretch). Grounding needs
 * position, not legibility — and a square lets ONE configurable divisor cover every
 * coordinate convention: 0–1000 normalized, qwen2.5vl's absolute-pixels-of-the-sent
 * image (which now == 0–size), 0–100 percent, 0–1024 tokens. Map per-axis by
 * `coord/range`, independent of the viewport's aspect ratio.
 */
export function resizeToSquare(dataUrl: string, size = 1000): Promise<string> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const cv = document.createElement("canvas");
            cv.width = size; cv.height = size;
            const ctx = cv.getContext("2d");
            if (!ctx) return reject(new Error("no 2d canvas context for grounding resize"));
            ctx.drawImage(img, 0, 0, size, size);
            resolve(cv.toDataURL("image/png"));
        };
        img.onerror = () => reject(new Error("failed to load screenshot for grounding"));
        img.src = dataUrl;
    });
}

/**
 * Fit a screenshot into a `size`×`size` square PRESERVING aspect (letterbox): scale
 * to fit the longer side, draw at the top-left, pad the remainder. Unlike
 * resizeToSquare's stretch, this never distorts the image — essential once the source
 * is an arbitrary-aspect crop (a wide banner, a tall column), where a stretch mangles
 * the target. The square still lets ONE `range` divisor cover every coordinate
 * convention (the model sees size×size); projectFromSquare inverts the uniform scale
 * and the padding. The pad colour is a neutral dark so it reads as "no content".
 */
export function letterboxToSquare(dataUrl: string, size = 1000, pad = "#141414"): Promise<string> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const cv = document.createElement("canvas");
            cv.width = size; cv.height = size;
            const ctx = cv.getContext("2d");
            if (!ctx) return reject(new Error("no 2d canvas context for grounding letterbox"));
            ctx.fillStyle = pad; ctx.fillRect(0, 0, size, size);
            const s = size / Math.max(img.naturalWidth, img.naturalHeight);
            ctx.drawImage(img, 0, 0, img.naturalWidth * s, img.naturalHeight * s);
            resolve(cv.toDataURL("image/png"));
        };
        img.onerror = () => reject(new Error("failed to load screenshot for grounding"));
        img.src = dataUrl;
    });
}

/**
 * Invert letterboxToSquare: map a grounding box [x1,y1,x2,y2] (each 0..range, in the
 * size×size square the model saw) back to a viewport Box in CSS px. The letterbox
 * fits by the LONGER side, so both axes share one scale — `max(rect.width,
 * rect.height)` — unlike viewportBox's per-axis stretch inverse. `rect` is the region
 * that was cropped + letterboxed (the whole viewport when no selector scopes it); a
 * coord that lands in the padding clamps to that region's edge.
 */
export function projectFromSquare(coords: number[], range: number, rect: { left: number; top: number; width: number; height: number }): Box {
    const R = range || 1000;
    const M = Math.max(rect.width, rect.height);   // the letterbox fit dimension — uniform on both axes
    const [x1, y1, x2, y2] = coords;
    const cx = (f: number) => Math.max(rect.left, Math.min(rect.left + rect.width, rect.left + f / R * M));
    const cy = (f: number) => Math.max(rect.top, Math.min(rect.top + rect.height, rect.top + f / R * M));
    return { left: cx(Math.min(x1, x2)), right: cx(Math.max(x1, x2)), top: cy(Math.min(y1, y2)), bottom: cy(Math.max(y1, y2)) };
}

/**
 * Map a grounding model's [x1,y1,x2,y2] (each in 0..range) to a viewport box in CSS
 * px. Per-axis `coord/range` fraction — the 1000×1000 square makes `range` cover
 * every convention (see resizeToSquare). Corners are min/max-normalized. Still used to
 * draw the model's box onto the square it saw (square px == same on both axes).
 */
export function viewportBox(coords: number[], range: number, w: number, h: number): Box {
    const R = range || 1000;
    const [x1, y1, x2, y2] = coords;
    return {
        left: Math.min(x1, x2) / R * w, right: Math.max(x1, x2) / R * w,
        top: Math.min(y1, y2) / R * h, bottom: Math.max(y1, y2) / R * h,
    };
}

/**
 * Draw a `cols`×`rows` numbered grid over an image in memory — cells numbered 1..N
 * left-to-right, top-to-bottom, a label in each cell's top-left. The grid mechanism
 * asks a vision model "which cell holds <target>?", turning spatial grounding into a
 * multiple-choice pick that needs no coordinate training and can't hallucinate an
 * (x,y). `scale` sizes the lines/labels (dpr); the line/badge colour is chosen to
 * contrast with the page (avoiding `avoidHues`, e.g. the target's own colour), and each
 * line gets a dark casing so it survives even a busy multi-colour page. Never touches
 * the live page.
 */
export function drawGrid(dataUrl: string, cols: number, rows: number, scale: number, avoidHues: number[] = []): Promise<string> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const cv = document.createElement("canvas");
            cv.width = img.naturalWidth; cv.height = img.naturalHeight;
            const ctx = cv.getContext("2d");
            if (!ctx) return reject(new Error("no 2d canvas context for grid"));
            ctx.drawImage(img, 0, 0);
            const color = pickOverlayHex(sampleHues(ctx, cv.width, cv.height), avoidHues);
            const cw = cv.width / cols, ch = cv.height / rows;
            const fs = Math.round(13 * scale), pad = Math.round(3 * scale);
            const lw = Math.max(1, Math.round(1.5 * scale));
            const lines = () => {
                for (let c = 1; c < cols; c++) { ctx.beginPath(); ctx.moveTo(c * cw, 0); ctx.lineTo(c * cw, cv.height); ctx.stroke(); }
                for (let r = 1; r < rows; r++) { ctx.beginPath(); ctx.moveTo(0, r * ch); ctx.lineTo(cv.width, r * ch); ctx.stroke(); }
            };
            ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.lineWidth = lw + Math.max(2, Math.round(2 * scale)); lines();   // dark casing
            ctx.strokeStyle = color; ctx.lineWidth = lw; lines();                                                     // bright core
            ctx.font = `bold ${fs}px sans-serif`; ctx.textBaseline = "top";
            for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
                const n = String(r * cols + c + 1);
                const bw = Math.ceil(ctx.measureText(n).width) + pad * 2, bh = fs + pad * 2;
                const x = c * cw + Math.round(2 * scale), y = r * ch + Math.round(2 * scale);
                ctx.fillStyle = color; ctx.fillRect(x, y, bw, bh);
                ctx.fillStyle = "#fff"; ctx.fillText(n, x + pad, y + pad);
            }
            resolve(cv.toDataURL("image/png"));
        };
        img.onerror = () => reject(new Error("failed to load screenshot for grid"));
        img.src = dataUrl;
    });
}

/**
 * Grid dimensions matched to a region's ASPECT so cells stay roughly square — a wide
 * toolbar gets more columns than rows instead of a square grid wasting its empty rows.
 * `base` (~gridSize) sets the ballpark cell count (base²); the split follows √aspect.
 */
export function gridDims(region: { width: number; height: number }, base = 4): { cols: number; rows: number } {
    const aspect = region.height > 0 ? region.width / region.height : 1;
    const clamp = (n: number) => Math.max(2, Math.min(12, Math.round(n)));
    return { cols: clamp(base * Math.sqrt(aspect)), rows: clamp(base / Math.sqrt(aspect)) };
}

/**
 * A grid-cell SELECTION the model may return: 1 cell, 2 edge-adjacent cells (a target
 * straddling a boundary), or 4 cells forming a 2×2 block. Rejects anything else
 * (non-adjacent, an L-shape, 3 cells) so a follow-up never unions a disjoint region.
 * Cells are 1-based, numbered left-to-right, top-to-bottom.
 */
export function validateCells(cells: number[], cols: number, rows: number): { ok: boolean; reason?: string } {
    const n = cells.length;
    if (n !== 1 && n !== 2 && n !== 4) return { ok: false, reason: "select 1, 2 (adjacent), or 4 (a 2×2 block) cells" };
    if (cells.some(c => !Number.isInteger(c) || c < 1 || c > cols * rows)) return { ok: false, reason: `cells must be 1–${cols * rows}` };
    if (new Set(cells).size !== n) return { ok: false, reason: "cells must be distinct" };
    const rc = cells.map(c => ({ r: Math.floor((c - 1) / cols), c: (c - 1) % cols }));
    const minR = Math.min(...rc.map(p => p.r)), maxR = Math.max(...rc.map(p => p.r));
    const minC = Math.min(...rc.map(p => p.c)), maxC = Math.max(...rc.map(p => p.c));
    if (n === 1) return { ok: true };
    if (n === 2) {
        const [a, b] = rc;
        const adjacent = (a.r === b.r && Math.abs(a.c - b.c) === 1) || (a.c === b.c && Math.abs(a.r - b.r) === 1);
        return adjacent ? { ok: true } : { ok: false, reason: "2 cells must share an edge (left-right or top-bottom neighbours)" };
    }
    // n === 4 → exactly the 2×2 block spanning [minR..minR+1]×[minC..minC+1].
    const isBlock = maxR - minR === 1 && maxC - minC === 1;
    return isBlock ? { ok: true } : { ok: false, reason: "4 cells must form a 2×2 block" };
}

/** Union Box of a (validated-adjacent) cell selection — the rectangle they bound. */
export function cellsBox(cells: number[], cols: number, rows: number, region: { left: number; top: number; width: number; height: number }): Box {
    const rc = cells.map(c => ({ r: Math.floor((c - 1) / cols), c: (c - 1) % cols }));
    const minR = Math.min(...rc.map(p => p.r)), maxR = Math.max(...rc.map(p => p.r));
    const minC = Math.min(...rc.map(p => p.c)), maxC = Math.max(...rc.map(p => p.c));
    const cw = region.width / cols, ch = region.height / rows;
    return {
        left: region.left + minC * cw, right: region.left + (maxC + 1) * cw,
        top: region.top + minR * ch, bottom: region.top + (maxR + 1) * ch,
    };
}

/** The representative interactive element painted at a viewport point (CSS px). */
export function elementAtPoint(x: number, y: number, filter: MarkFilter): Element | null {
    let hit: Element | null;
    try { hit = document.elementFromPoint(x, y); } catch { return null; }
    return hit ? representativeFor(hit, filter) : null;
}

/**
 * Hit-test sweep restricted to a viewport box (CSS px) — the grounding box only
 * needs to be directionally right; this snaps to the real interactive node(s)
 * inside it. Same reduction/dedup as collectCandidates, clamped to the viewport.
 */
export function collectInBox(box: Box, filter: MarkFilter, opts: { step?: number; max?: number } = {}): Element[] {
    const step = opts.step ?? 18, max = opts.max ?? 20;
    const x0 = Math.max(0, box.left), x1 = Math.min(window.innerWidth, box.right);
    const y0 = Math.max(0, box.top), y1 = Math.min(window.innerHeight, box.bottom);
    const seen = new Set<Element>();
    const out: Element[] = [];
    for (let y = y0 + step / 2; y < y1; y += step) {
        for (let x = x0 + step / 2; x < x1; x += step) {
            const el = elementAtPoint(x, y, filter);
            if (!el || seen.has(el) || styleHidden(el)) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 4 || r.height < 4) continue;
            seen.add(el); out.push(el);
            if (out.length >= max) return out;
        }
    }
    return out;
}

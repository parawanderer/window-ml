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

/**
 * Draw the numbered badges onto a viewport screenshot, in memory. Mirrors
 * cropDataUrl's dpr handling: the captured PNG is at devicePixelRatio while rects
 * are CSS px, so scale by `dpr`. Never touches the live page.
 *
 * @param {string} dataUrl The viewport PNG data URL.
 * @param {Mark[]} marks The marks to draw.
 * @param {number} dpr Device pixel ratio.
 * @returns {Promise<string>} The badged image as a PNG data URL.
 */
export function drawMarks(dataUrl: string, marks: Mark[], dpr: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const cv = document.createElement("canvas");
            cv.width = img.naturalWidth; cv.height = img.naturalHeight;
            const ctx = cv.getContext("2d");
            if (!ctx) return reject(new Error("no 2d canvas context for Set-of-Marks"));
            ctx.drawImage(img, 0, 0);
            const fs = Math.round(13 * dpr);
            ctx.font = `bold ${fs}px sans-serif`;
            ctx.textBaseline = "top";
            for (const m of marks) {
                const x = m.rect.left * dpr, y = m.rect.top * dpr;
                const w = m.rect.width * dpr, h = m.rect.height * dpr;
                ctx.strokeStyle = "#ff2d55"; ctx.lineWidth = Math.max(1, Math.round(2 * dpr));
                ctx.strokeRect(x, y, w, h);
                const label = String(m.id);
                const pad = Math.round(3 * dpr);
                const bw = Math.ceil(ctx.measureText(label).width) + pad * 2;
                const bh = fs + pad * 2;
                const bx = Math.max(0, x);
                const by = Math.max(0, y - bh);   // badge above the box's top-left, clamped on-screen
                ctx.fillStyle = "#ff2d55"; ctx.fillRect(bx, by, bw, bh);
                ctx.fillStyle = "#fff"; ctx.fillText(label, bx + pad, by + pad);
            }
            resolve(cv.toDataURL("image/png"));
        };
        img.onerror = () => reject(new Error("failed to load the screenshot for marking"));
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
 * Map a grounding model's [x1,y1,x2,y2] (each in 0..range) to a viewport box in CSS
 * px. Per-axis `coord/range` fraction — the 1000×1000 square makes `range` cover
 * every convention (see resizeToSquare). Corners are min/max-normalized.
 */
export function viewportBox(coords: number[], range: number, w: number, h: number): Box {
    const R = range || 1000;
    const [x1, y1, x2, y2] = coords;
    return {
        left: Math.min(x1, x2) / R * w, right: Math.max(x1, x2) / R * w,
        top: Math.min(y1, y2) / R * h, bottom: Math.max(y1, y2) / R * h,
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

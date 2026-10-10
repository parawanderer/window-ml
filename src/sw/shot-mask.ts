// shot-mask.ts — painting the extension's own UI out of a screenshot the worker took: the shell's viewport rects scaled to the capture, checked, and filled opaque.

// Pure apart from the `Raster` it draws with, so it is tested without a worker. The rects come from the shell
// (shell-shot.ts `extensionRects`), watched from before the capture to after it; every place the UI was seen in between is
// painted, since it may have moved.

import type { Raster } from "../raster";
import type { ShotRectKind, ShotRects } from "../sidebar/shell-shot";

/** The fill a masked rect gets: a flat neutral grey, opaque, that reads as "nothing here" rather than as page content. */
export const MASK_FILL = "#808080";

/**
 * The share of the capture a mask may cover before the shot is refused. Past it, less than 40% of the page is left
 * and a vision answer about the page is mostly about a grey block. The extension's honest surfaces sit under it (a
 * sidebar at its default width, the corner card, a highlight); what crosses it is the image viewer (the whole
 * viewport), a sidebar dragged nearly full width or a maximised run card, each of which the person can put away.
 */
export const MASK_REFUSE_SHARE = 0.6;

/** CSS px added round each rect: a box shadow, an outline or anti-aliasing paints a little past the border box. */
const PAD = 2;

/** One rect in capture pixels, clamped to the image. */
export interface DeviceRect { x: number; y: number; w: number; h: number; kind: ShotRectKind; }

/** What a surface is called when it covers too much of the page, and how the person puts it away. */
const PUT_AWAY: Record<ShotRectKind, string> = {
    lightbox: "the image viewer is open over the page: close it (Esc)",
    sidebar: "the window.ml sidebar covers most of the page: narrow or collapse it",
    card: "the run card covers most of the page: restore it to its normal size",
    highlight: "the hover highlight covers most of the page: move the pointer off it",
    frame: "a window.ml frame the page embedded covers most of it",
};

/** The refusal for a page that has done something to the extension's UI that leaves where it paints unknown (moved a
 *  host into a frame of its own, put a stylesheet into a root, reflected or filtered a panel). */
export const TAMPERED = "Can't screenshot this tab: the page has moved or restyled window.ml's own panels so that where they paint can't be told, and they would be in the shot. It was not taken.";
/** The refusal for a mask past the share when the page's own styles enlarged or moved the extension's UI: the person
 *  did not widen anything, so the sentence does not tell them to narrow it. */
export const RESTYLED_COVERS = "Can't take a useful screenshot of this page: the page has enlarged or moved window.ml's own panels so that they cover most of it.";
/** The refusal for a mask past the share made of every place the UI was seen while it moved during the shot. */
export const MOVED_COVERS = "Can't take a useful screenshot of this page: window.ml's own panels moved while it was taken, and every place they were covers most of it. Retry once they settle.";

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const KINDS = new Set<string>(Object.keys(PUT_AWAY));

/**
 * The shell's answers scaled to the capture: each answer by its own capture-width / viewport-width, on both axes (a
 * resize between the two answers is then still right), padded and clamped. One scale, not one per axis: a capture
 * shorter than the viewport is a crop of its top, not a squeeze (the debugger's infobar takes the bottom of the
 * captured area while the page's viewport keeps its height). A capture TALLER than the viewport at that scale matches
 * no layout the shell measured, and is refused.
 * @param answers the shell's answers (null: no content script, so no extension UI on the page)
 * @param W the capture's width in pixels
 * @param H its height
 * @returns the rects to paint
 * @throws when an answer is not the shape the shell sends
 */
export function deviceRects(answers: (ShotRects | null)[], W: number, H: number): DeviceRect[] {
    const out: DeviceRect[] = [];
    for (const a of answers) {
        if (a === null) continue;
        if (!a || !finite(a.vw) || !finite(a.vh) || a.vw < 1 || a.vh < 1 || !Array.isArray(a.rects) || [a.tampered, a.restyled, a.moved].some((f) => f !== undefined && typeof f !== "boolean")) throw new Error("the page's window.ml frame gave an answer about its layout that can't be read, so the screenshot was not taken.");
        const sx = W / a.vw, sy = sx;
        if (H > a.vh * sx * 1.02 + 2) throw new Error("the screenshot does not match the page's viewport, so the extension's own panels can't be found in it; it was not used.");
        for (const r of a.rects) {
            if (!r || !finite(r.x) || !finite(r.y) || !finite(r.w) || !finite(r.h) || !KINDS.has(r.kind)) throw new Error("the page's window.ml frame gave an answer about its layout that can't be read, so the screenshot was not taken.");
            const x0 = Math.max(0, Math.floor((r.x - PAD) * sx)), y0 = Math.max(0, Math.floor((r.y - PAD) * sy));
            const x1 = Math.min(W, Math.ceil((r.x + r.w + PAD) * sx)), y1 = Math.min(H, Math.ceil((r.y + r.h + PAD) * sy));
            if (x1 > x0 && y1 > y0) out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, kind: r.kind });
        }
    }
    return out;
}

/**
 * The share of a `W`×`H` image the union of `rects` covers, and the kind covering the most of it, on a grid of at
 * most 128×128 cells (a cell counts when its centre is covered).
 * @param rects the rects
 * @param W the width
 * @param H the height
 * @returns the share in [0, 1] and the largest kind
 */
export function coverage(rects: DeviceRect[], W: number, H: number): { share: number; largest: ShotRectKind | null } {
    if (!rects.length || W < 1 || H < 1) return { share: 0, largest: null };
    const cols = Math.min(128, W), rows = Math.min(128, H);
    const by = new Map<ShotRectKind, number>();
    let covered = 0;
    for (let j = 0; j < rows; j++) {
        const y = (j + 0.5) * H / rows;
        for (let i = 0; i < cols; i++) {
            const x = (i + 0.5) * W / cols;
            const hit = rects.find((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
            if (hit) { covered++; by.set(hit.kind, (by.get(hit.kind) ?? 0) + 1); }
        }
    }
    const largest = [...by].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    return { share: covered / (cols * rows), largest };
}

/**
 * Paint the extension's UI out of a capture. Nothing to paint returns the capture as it is; an answer saying the page
 * tampered with the UI is refused ({@link TAMPERED}); a mask covering {@link MASK_REFUSE_SHARE} or more of it is refused
 * with a sentence naming why: the page's styles, the UI moving, or the surface the person can put away.
 * @param shot the capture and its size
 * @param answers the shell's answers before and after the capture (null where there was no content script)
 * @param raster the worker's raster
 * @returns the masked capture
 * @throws when an answer is unreadable or the mask covers too much
 */
export async function maskShot(shot: { dataUrl: string; w: number; h: number }, answers: (ShotRects | null)[], raster: Raster): Promise<{ dataUrl: string; w: number; h: number }> {
    const rects = deviceRects(answers, shot.w, shot.h);
    if (answers.some((a) => a?.tampered)) throw new Error(TAMPERED);
    if (!rects.length) return shot;
    const { share, largest } = coverage(rects, shot.w, shot.h);
    if (share >= MASK_REFUSE_SHARE) {
        // Say what made it so: the page's styles, the UI moving, or (only when neither) the surface the person can put away.
        if (answers.some((a) => a?.restyled)) throw new Error(RESTYLED_COVERS);
        if (answers.some((a) => a?.moved)) throw new Error(MOVED_COVERS);
        throw new Error(`Can't take a useful screenshot of this page: ${PUT_AWAY[largest ?? "sidebar"]}, then retry.`);
    }
    let img;
    try { img = await raster.decode(shot.dataUrl); } catch { throw new Error("the screenshot could not be decoded to mask the extension's own UI out of it, so it was not used."); }
    try {
        const c = raster.canvas(shot.w, shot.h);
        const g = c.getContext("2d");
        if (!g) throw new Error("no canvas to mask the screenshot on, so it was not used.");
        g.drawImage(img.source, 0, 0);
        g.fillStyle = MASK_FILL;
        for (const r of rects) g.fillRect(r.x, r.y, r.w, r.h);
        return { dataUrl: await raster.encode(c), w: shot.w, h: shot.h };
    } finally { img.close(); }
}

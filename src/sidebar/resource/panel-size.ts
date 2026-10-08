// panel-size.ts — how tall the resource panel is: the drag that resizes it, the floor it learns by measuring its
// own overflow, the layout key that floor is remembered under, and the eased height change when the layout moves.

import { signal } from "@preact/signals";
import { vramH } from "../store";

// The smallest the panel may be dragged is LEARNED, not computed. Summing the parts is a guess about which
// parts exist and how tall they are — it goes stale the moment a track grows a row, the font scale changes, or
// a model name wraps, and the symptom is content rendering on top of itself.
//
// Instead the panel measures its own SHORTFALL: `scrollHeight - clientHeight` is exactly how much content does
// not fit, whatever that content turns out to be. Grow by that much and the overlap is gone by construction.
// The result is remembered as the floor for this layout, and dragging can only EXPAND past it.
export const PLOT_MIN_H = 44;   // matches .rc-plot's min-height

/** True while the user's hand is on the grip. Every programmatic resize stands down until it is false: the
 *  panel may correct itself before or after a drag, never during one. */
export const dragging = signal(false);

/** When the drag last produced an event. A release can be MISSED entirely — the pointer leaves the frame, the
 *  window loses focus, the OS takes the gesture — and a `dragging` flag stuck true silently disables every
 *  later self-correction. So a drag that has gone quiet is treated as over. */
export let lastDragAt = 0;

export const DRAG_IDLE_MS = 900;   // ms after a drag before the panel may correct itself — a hand still on the grip must always win

/** Mark the panel as being dragged RIGHT NOW, so no programmatic resize fights the hand holding it. */
export const noteDrag = (t = Date.now()): void => { lastDragAt = t; };

/** Has the drag gone quiet long enough to be considered finished? */
export const dragStale = (now = Date.now()): boolean => dragging.value && now - lastDragAt > DRAG_IDLE_MS;

/** How much taller the panel must be for its content to fit. 0 when it already does. */
export function shortfall(el: HTMLElement | null): number {
    if (!el) return 0;
    return Math.max(0, el.scrollHeight - el.clientHeight);
}

/** The smallest height at which everything still fits — measured, by squeezing the panel to nothing and asking
 *  what its content then needs. One forced layout, and no guessing: a shortfall read in the same frame as the
 *  height that caused it can be WRONG (the chart's flex box and its SVG settle a frame later), which is what
 *  let a drag stop just under the true floor and then jump when the next correction disagreed. Asking for the
 *  minimum directly means the drag and the correction compute the same number. */
export function measureFloor(el: HTMLElement | null): number {
    if (!el) return 0;
    const prev = el.style.height;
    el.style.height = "0px";
    const min = el.scrollHeight;   // reading it forces the layout, so this is the settled answer
    el.style.height = prev;        // …and restoring before the frame ends means nothing is ever painted at 0
    return Math.ceil(min);
}

/** What the panel currently looks like, so a learned floor is discarded when the layout changes rather than
 *  ratcheting upward forever — switching to a smaller view must be able to shrink again. */
// The panel's WIDTH is part of it: tracks tile side by side once there is room, so a floor learned in a
// narrow sidebar is far too tall after the sidebar is dragged out — and the correction only ever grows, so it
// would never come back down on its own. Bucketed, because a floor per pixel of width is a floor per render.
export const WIDTH_BUCKET = 100;

/** The key a learned height floor is remembered under. WIDTH is part of it because tiling needs less
 *  height than stacking, and a floor learned wide would be wrong narrow. */
export const layoutKey = (tracks: number, rows: number, width = 0): string =>
    `${tracks}:${rows}:${Math.round(width / WIDTH_BUCKET)}`;

/** Animate the panel to a height with a cubic ease. Used when the size changes on its OWN — the panel
 *  correcting an overlap, or a layout needing more room — where a snap reads as a glitch. A live DRAG never
 *  uses this: dragging must track the pointer exactly, and easing it would feel like lag. */
// Bumped by cancelEase(); an in-flight animation checks it every frame and gives up if it is no longer the
// current one. The user's hand ALWAYS wins — a panel that keeps animating while you drag it is fighting you.
let easeToken = 0;

/** Abandon an in-flight height animation — anything the user does to the panel takes over from it. */
export function cancelEase(): void { easeToken++; }

/** Animate the panel to a height, so a self-correction reads as the panel adjusting rather than jumping. */
export function easeVramH(to: number, ms = 220): void {
    const mine = ++easeToken;
    const from = vramH.value;
    if (!from || Math.abs(to - from) < 2) { vramH.value = to; return; }
    // ONE clock: rAF timestamps share performance.now()'s origin, and Date.now() does not — mixing them makes
    // the elapsed fraction negative and the height undershoots below where it started.
    const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
    const t0 = clock();
    const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (f: FrameRequestCallback) => setTimeout(() => f(clock()), 16) as unknown as number;
    const step = (now: number) => {
        // Clamped at BOTH ends: a frame timestamped before t0 must never drive the panel outside the range it
        // was asked to move through.
        if (mine !== easeToken) return;   // something else took over — a drag, or a newer correction
        const t = Math.max(0, Math.min(1, (now - t0) / ms));
        // cubic ease-out: fast to start, settling gently — a resize that decelerates reads as the panel
        // finding its size rather than jumping to it.
        vramH.value = from + (to - from) * (1 - Math.pow(1 - t, 3));
        if (t < 1) raf(step);
    };
    raf(step);
}

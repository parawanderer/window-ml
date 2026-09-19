// drag.ts — one pointer DRAG, from a pointerdown to the moment it is certainly over: every resize handle's gesture.
//
// It exists because the naive version — listen for `pointermove` and `pointerup` and trust the up to arrive — sticks.
// The up goes missing more often than it seems: the button is released outside the browser, a cancelled gesture sends
// `pointercancel` instead, capture moves to another element, a re-render replaces the handle. Each left a handle
// following the mouse with no button held, until the next click. The resource panel's grip had already learned this
// (vram.tsx); the bench's divider and drawer edge had not, and stuck. So every way a drag can end is one of these:
// an up, a cancel, losing capture, or a move that arrives with no button pressed.

/**
 * Follow the pointer from this `pointerdown` until the drag is over, however it ends.
 *
 * Captures the pointer on `e.currentTarget` so a release anywhere is heard, listens on the window as well for engines
 * where capture fails, and calls `end` exactly once. Returns a function that ends the drag early.
 *
 * @param e the pointerdown that starts it; its default is prevented, so text is not selected along the way
 * @param move called with every move while a button is held
 * @param end called once when the drag is over, for persisting what it changed
 */
export function followDrag(e: PointerEvent, move: (ev: PointerEvent) => void, end?: () => void): () => void {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement | null;
    try { el?.setPointerCapture(e.pointerId); } catch { /* older engines: the window listeners still hear the up */ }
    let done = false;
    const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== e.pointerId) return;
        // The button came up somewhere we never heard about: end the drag rather than staying "held".
        if (ev.buttons === 0) { finish(); return; }
        move(ev);
    };
    const finish = () => {
        if (done) return;
        done = true;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        el?.removeEventListener("lostpointercapture", finish);
        try { el?.releasePointerCapture(e.pointerId); } catch { /* already released */ }
        end?.();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    el?.addEventListener("lostpointercapture", finish);
    return finish;
}

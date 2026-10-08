// pointer-gone.ts — the leave events the browser never sends: when the pointer goes from the sidebar's iframe out onto
// the page, the frame receives NOTHING (measured, tests/e2e/tooltips.spec.mjs: no pointerout, pointerleave, mouseout,
// blur or change of `:hover`, in one move or ten), so every tooltip that hides on a leave stayed up.
//
// The page does see the pointer arrive on it. So the frame says when the pointer comes IN (`__mlSidebarApp:
// "pointerIn"`, once per crossing, over parent-channel.ts's private port), the shell answers with `__mlSidebarPointerOut` at the page's next pointer move,
// and `pointerGone` REPLAYS the missing events on whatever the pointer was last over: a `pointerout` that bubbles,
// with no related target, and a `pointerleave` on it and every ancestor up through shadow roots. Every tip's own
// hide path then runs as if the browser had sent them, so no tip needs a case of its own.
//
// Not covered: the DevTools panel. There the app fills the panel, leaving it means leaving the panel for DevTools'
// own chrome, and no page of ours sees the pointer arrive anywhere.

import { useEffect, useRef } from "preact/hooks";

/** Where the pointer was last seen in this document, and whether it is (as far as we know) still here. */
let last: Element | null = null;
let inside = false;

/**
 * Track the pointer in `doc` and report each time it comes in from outside: `onIn` runs on the first pointer event
 * after a `pointerGone`, and once at the start.
 *
 * @param doc the document the app renders in
 * @param onIn told when the pointer arrives (the overlay tells its shell, which watches for the way out)
 * @returns a function that stops tracking
 */
export function trackPointer(doc: Document, onIn: () => void): () => void {
    const seen = (e: Event): void => {
        const t = (e.composedPath?.()[0] ?? e.target) as Element | null;
        if (t && t.nodeType === 1) last = t;
        if (!inside) { inside = true; onIn(); }
    };
    doc.addEventListener("pointerover", seen, true);
    doc.addEventListener("pointermove", seen, true);
    return () => { doc.removeEventListener("pointerover", seen, true); doc.removeEventListener("pointermove", seen, true); };
}

/** The element's parent in the composed tree: through a shadow root to its host. */
function composedParent(el: Element): Element | null {
    const p = el.parentNode;
    if (!p) return null;
    if (p.nodeType === 11) return (p as ShadowRoot).host ?? null;
    return p.nodeType === 1 ? p as Element : null;
}

/** The pointer has left this document: replay the leave events it never got. A no-op when it was not here. */
export function pointerGone(): void {
    if (!inside) return;
    inside = false;
    const el = last;
    last = null;
    if (!el?.isConnected) return;
    const view = el.ownerDocument.defaultView;
    const Ev = (view?.PointerEvent ?? view?.MouseEvent ?? MouseEvent) as typeof MouseEvent;
    el.dispatchEvent(new Ev("pointerout", { bubbles: true, composed: true, relatedTarget: null }));
    // Innermost first, the order the browser leaves in.
    for (let n: Element | null = el; n; n = composedParent(n)) n.dispatchEvent(new Ev("pointerleave", { bubbles: false, composed: false, relatedTarget: null }));
}

/**
 * While a cursor tip is `up`, take it down when what it points at may no longer be under the pointer without any
 * leave saying so: something SCROLLS (the content moves, the pointer does not, and a tip drawn at the old coordinates
 * now labels whatever slid under it), or the window loses focus (a switch to another window or tab). The anchored
 * layer (tooltip-layer.ts) already does both; the cursor-following tips did neither.
 *
 * A scroll is a reason to LOOK, not to hide: `stillHere` is asked whether what the tip describes is still under the
 * pointer, and only a no takes the tip down. Hiding on every scroll took down a tip that had just been raised, when the
 * scroll that brought its trigger into view landed a frame after the pointer did (the chat page's tab picker, in CI).
 *
 * @param up whether the tip is showing; the listeners exist only then
 * @param hide takes the tip down
 * @param stillHere after a scroll, is the tip's subject still under the pointer? Absent, or false, hides it
 */
export function useGoneOnScrollOrBlur(up: boolean, hide: () => void, stillHere?: () => boolean): void {
    const ask = useRef(stillHere);
    ask.current = stillHere;
    useEffect(() => {
        if (!up) return;
        const doc = typeof document !== "undefined" ? document : null;
        if (!doc) return;
        const onScroll = (): void => { if (!ask.current?.()) hide(); };
        doc.addEventListener("scroll", onScroll, true);
        window.addEventListener("blur", hide);
        return () => { doc.removeEventListener("scroll", onScroll, true); window.removeEventListener("blur", hide); };
    }, [up]);
}

/** What is under the pointer at (x, y), or null where nothing can say (no layout, or a test DOM without hit-testing). */
export function underPointer(x: number, y: number): Element | null {
    try { return typeof document.elementFromPoint === "function" ? document.elementFromPoint(x, y) : null; } catch { return null; }
}

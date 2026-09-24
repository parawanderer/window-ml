// fade-edges.ts — which of a scroller's two edge fades are drawn, told from where it is scrolled.

import { useLayoutEffect } from "preact/hooks";

/** Within this many pixels of an end counts as AT it: a scroller rounds, and a phone's rubber-banding overshoots. */
const EDGE_SLOP = 2;

/**
 * Marks a `.fade-edges` scroller `more-up` / `more-down` so each fade is drawn only over content that CONTINUES
 * past it. A fade is a promise that there is more in that direction; drawn at rest it is a lie, and it reads as the
 * damage it exists to hide — the session list dimmed its first group heading while sitting at the top of the list,
 * which looks exactly like the cut-off document the fade exists to soften. A scroller with nothing to scroll has
 * neither mark and fades neither end.
 *
 * The marks say what IS there rather than what is not, so an unmeasured scroller draws no fade: the stylesheet's
 * default is bare, and this only ever adds. Said the other way round (fade by default, `at-top` to remove it) the
 * first painted frame of every session showed a fade the next frame took away, and you watched it go. For the same
 * reason the first measurement is a LAYOUT effect: it lands before the browser paints, not after.
 *
 * Recomputed on scroll, on the scroller resizing, on its CONTENT resizing, and on the content CHANGING: a
 * transcript that grows a turn at the bottom stops being at its end without anyone scrolling, and neither
 * observer alone sees every way that happens (a ResizeObserver never fires for a node appended to a scroller
 * already at its full height; a MutationObserver never fires for an image finishing its load).
 */
export function useFadeEdges(ref: { current: HTMLElement | null }) {
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const mark = () => {
            const max = el.scrollHeight - el.clientHeight;
            el.classList.toggle("more-up", el.scrollTop > EDGE_SLOP);
            el.classList.toggle("more-down", el.scrollTop < max - EDGE_SLOP);
        };
        mark();
        el.addEventListener("scroll", mark, { passive: true });
        let ro: ResizeObserver | undefined, mo: MutationObserver | undefined;
        if (typeof ResizeObserver !== "undefined") {
            const observe = () => {
                ro!.disconnect();
                ro!.observe(el);
                for (const child of Array.from(el.children)) ro!.observe(child);
            };
            ro = new ResizeObserver(mark);
            observe();
            if (typeof MutationObserver !== "undefined") {
                mo = new MutationObserver(() => { observe(); mark(); });
                mo.observe(el, { childList: true, subtree: true });
            }
        }
        return () => { el.removeEventListener("scroll", mark); ro?.disconnect(); mo?.disconnect(); };
    }, []);
}

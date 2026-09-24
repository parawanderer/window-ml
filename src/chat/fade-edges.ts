// fade-edges.ts — which of a scroller's two edge fades are drawn, told from where it is scrolled.

import { useEffect } from "preact/hooks";

/** Within this many pixels of an end counts as AT it: a scroller rounds, and a phone's rubber-banding overshoots. */
const EDGE_SLOP = 2;

/**
 * Marks a `.fade-edges` scroller `at-top` / `at-end` so each fade is drawn only over content that CONTINUES past
 * it. A fade is a promise that there is more in that direction; drawn at rest it is a lie, and it reads as the
 * damage it exists to hide — the session list dimmed its first group heading while sitting at the top of the list,
 * which looks exactly like the cut-off document the fade exists to soften. A scroller with nothing to scroll is at
 * both ends and fades neither.
 *
 * Recomputed on scroll, on the scroller resizing, on its CONTENT resizing, and on the content CHANGING: a
 * transcript that grows a turn at the bottom stops being at its end without anyone scrolling, and neither
 * observer alone sees every way that happens (a ResizeObserver never fires for a node appended to a scroller
 * already at its full height; a MutationObserver never fires for an image finishing its load).
 */
export function useFadeEdges(ref: { current: HTMLElement | null }) {
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const mark = () => {
            const max = el.scrollHeight - el.clientHeight;
            el.classList.toggle("at-top", el.scrollTop <= EDGE_SLOP);
            el.classList.toggle("at-end", el.scrollTop >= max - EDGE_SLOP);
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

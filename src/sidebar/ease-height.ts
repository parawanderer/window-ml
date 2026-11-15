// ease-height.ts — a box that grows or shrinks because its content changed, eased from the height it had to the one it has.
//
// A step's body gains blocks as the call runs: the "running…" output when it starts, then the result, the footer of the
// commands it ran. Each arrives in one render, so the body, and everything under it, jumped by the block's height. The
// body is not mounted or unmounted by any of it (its own open and close have animations), so nothing animated the change.
// This measures the height before and after a change the caller names (`sig`) and eases between them.

import { useLayoutEffect, useRef } from "preact/hooks";
import type { RefObject } from "preact";

/** How long, in ms, the box takes to reach its new height. */
export const EASE_HEIGHT_MS = 260;

/**
 * Ease `ref`'s height whenever `sig` changes (a string naming what the box now holds). Only while `enabled`; it does nothing on
 * the first draw, for a change too small to see, or under reduced motion. A change that lands mid-ease starts from the height
 * it had reached, not from where the last one began.
 */
export function useHeightEase(ref: RefObject<HTMLElement>, sig: string, enabled: boolean, ms = EASE_HEIGHT_MS): void {
    // state: ui — the box's settled height and the signature it had
    const last = useRef<{ h: number | null; sig: string }>({ h: null, sig });
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) { last.current = { h: null, sig }; return; }
        const running = el.getAnimations?.().filter((a) => a.id === "ease") ?? [];
        const changed = last.current.sig !== sig;
        if (!changed) { if (!running.length) last.current.h = el.getBoundingClientRect().height; return; }
        const from = running.length ? el.getBoundingClientRect().height : last.current.h;
        running.forEach((a) => a.cancel());
        const to = el.getBoundingClientRect().height;
        last.current = { h: to, sig };
        let reduced = false;
        try { reduced = !!globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches; } catch { /* no matchMedia */ }
        if (!enabled || reduced || from == null || Math.abs(to - from) < 3 || typeof el.animate !== "function") return;
        el.animate([{ height: `${from}px`, overflow: "hidden" }, { height: `${to}px`, overflow: "hidden" }], { duration: ms, easing: "cubic-bezier(.4, 0, .2, 1)", id: "ease" });
    });
}

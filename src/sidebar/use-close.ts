// use-close.ts — keeping a body mounted for exactly as long as the surface animates it shut.
//
// A disclosure that unmounts its body the moment it closes has nothing left to animate, so it SNAPS while the
// same thing opening eases — which reads as two different controls rather than one. The way out is to hold the
// body for the length of the closing animation, and the length is the SURFACE's business, not the component's:
// the panel and the overlay close in the same tick they always have, the reading view eases. So the surface
// declares it in CSS as a custom property on the element itself and the component asks the node, rather than
// carrying a number that drifts from the stylesheet the first time someone retunes the curve.

import { useState } from "preact/hooks";
import type { RefObject } from "preact";

/**
 * How long this surface says one of its own animations lasts, from a CSS custom property on the element
 * (`--astep-close-ms`, `--asst-close-ms`). A surface that declares nothing reads 0, which means "now".
 *
 * @param el the element carrying the property (the thing being animated)
 * @param prop the custom property's name, including the leading `--`
 * @returns the declared duration in milliseconds, or 0 when there is none to honour
 */
export function cssDurationMs(el: Element | null | undefined, prop: string): number {
    if (!el || typeof getComputedStyle !== "function") return 0;
    const ms = parseFloat(getComputedStyle(el).getPropertyValue(prop));
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/**
 * The closing half of a disclosure: a `closing` flag to put on the body (the stylesheet hangs the shrink off
 * it) and a `close` that flips the caller's own state once the animation has had its time. With no declared
 * duration it calls straight through, so a surface that does not animate pays neither a timer nor a frame.
 *
 * @param ref the body being animated — the same node the duration is declared on
 * @param prop the custom property naming the duration
 */
export function useCloseAnimation(ref: RefObject<HTMLElement>, prop = "--astep-close-ms"): {
    closing: boolean;
    close: (then: () => void) => void;
    cancel: () => void;
} {
    const [closing, setClosing] = useState(false);
    return {
        closing,
        close(then) {
            const ms = cssDurationMs(ref.current, prop);
            if (!ms) { then(); return; }
            setClosing(true);
            setTimeout(() => { setClosing(false); then(); }, ms);
        },
        cancel() { setClosing(false); },
    };
}

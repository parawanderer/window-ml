// use-dismiss.ts — keep a popup MOUNTED for as long as it takes to animate away.
//
// Every menu here is drawn as `{open ? <div …> : null}`, so it arrives with an animation and then, on the click
// that chooses something, ceases to exist between two frames. The asymmetry is the tell: a surface that eases in
// and vanishes reads as two different things, and the vanish lands exactly where someone is looking.
//
// Preact has no exit hook, so the state has to live somewhere: this holds `show` true through one more beat after
// `open` goes false, and marks that beat `closing` for the stylesheet to animate. The duration is passed in and
// must match the CSS, which is the same surface-declares-its-own-duration handshake `--astep-close-ms` uses.
import { useEffect, useRef, useState } from "preact/hooks";

/** How long a menu takes to go. Shorter than its entrance: arriving wants to be noticed, leaving does not. */
export const DISMISS_MS = 110;

/**
 * Whether to draw a popup, and whether it is on its way out.
 *
 * @param open what the component actually wants
 * @param ms how long the leaving animation takes — keep it in step with the stylesheet
 */
export function useDismiss(open: boolean, ms: number = DISMISS_MS): { show: boolean; closing: boolean } {
    const [leaving, setLeaving] = useState(false);
    const was = useRef(open);
    useEffect(() => {
        const closed = was.current && !open;
        was.current = open;
        if (!closed) { if (open && leaving) setLeaving(false); return; }
        setLeaving(true);
        const t = setTimeout(() => setLeaving(false), ms);
        return () => clearTimeout(t);
    }, [open, ms]);
    // Re-opening mid-leave must not draw a closing menu: `open` wins, and the beat is dropped.
    return { show: open || leaving, closing: !open && leaving };
}

/**
 * The same, for a popup whose OPENNESS IS ITS POSITION — the row and header menus keep `{top,left}` and set it to
 * null to close, so a leaving copy drawn from a null would jump to the corner on its way out. This holds the last
 * real position for the beat it takes to go.
 *
 * @param at where it is, or null for closed
 * @param ms how long the leaving animation takes — keep it in step with the stylesheet
 */
export function useDismissAt<T>(at: T | null, ms: number = DISMISS_MS): { at: T | null; closing: boolean } {
    const [leaving, setLeaving] = useState(false);
    const last = useRef<T | null>(at);
    const was = useRef(at);
    if (at) last.current = at;
    useEffect(() => {
        const closed = !!was.current && !at;
        was.current = at;
        if (!closed) { if (at && leaving) setLeaving(false); return; }
        setLeaving(true);
        const t = setTimeout(() => setLeaving(false), ms);
        return () => clearTimeout(t);
    }, [at, ms]);
    return { at: at ?? (leaving ? last.current : null), closing: !at && leaving };
}

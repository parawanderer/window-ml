// hover-card.tsx — a card that opens beside something the pointer rests on, which the pointer can then enter to scroll it.

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";

/** How long, in ms, the pointer rests on a hover card's trigger before the card opens. */
export const HOVER_CARD_IN_MS = 450;
/** How long, in ms, the pointer may be away from a hover card and its trigger before the card closes. */
export const HOVER_CARD_OUT_MS = 280;

/**
 * Where a card of `card` size goes for a trigger at `at`, inside a `view`: below the trigger, or above it when there is
 * more room there, and shifted sideways so no edge of it leaves the view. Pure, so the rule is tested without a layout.
 */
export function placeCard(at: { left: number; top: number; bottom: number }, card: { w: number; h: number }, view: { w: number; h: number }, gap = 4, pad = 8): { left: number; top: number } {
    const below = view.h - at.bottom - gap - pad, above = at.top - gap - pad;
    const top = card.h <= below || below >= above ? at.bottom + gap : Math.max(pad, at.top - gap - card.h);
    const left = Math.min(Math.max(pad, at.left), Math.max(pad, view.w - card.w - pad));
    return { left, top };
}

/**
 * A HOVER CARD: wraps its trigger, and after the pointer has rested on it for a moment opens `card` just below (or above)
 * it, kept inside the window. The pointer may cross into the card, which stays open for as long as the pointer is in it
 * or the trigger (so a long text can be scrolled), and closes a moment after it leaves both. Escape closes it. The trigger is
 * marked `.hc-on` while it is open, for the caller's highlight. Nothing opens for a touch pointer: there is no hover.
 *
 * @param inMs / outMs the two delays, overridable for a test
 */
export function HoverCard({ class: cls = "", card, children, inMs = HOVER_CARD_IN_MS, outMs = HOVER_CARD_OUT_MS, onContextMenu }: {
    class?: string; card: ComponentChildren; children?: ComponentChildren; inMs?: number; outMs?: number; onContextMenu?: (e: MouseEvent) => void;
}) {
    const [at, setAt] = useState<{ left: number; top: number } | null>(null);
    const [open, setOpen] = useState(false);
    const trig = useRef<HTMLSpanElement>(null);
    const box = useRef<HTMLDivElement>(null);
    // state: ui — this card's two timers
    const timers = useRef<{ in: number; out: number }>({ in: 0, out: 0 });
    const t = timers.current;
    const enter = (e: PointerEvent): void => {
        if (e.pointerType === "touch") return;
        clearTimeout(t.out);
        if (open || t.in) return;
        t.in = setTimeout(() => { t.in = 0; setOpen(true); }, inMs) as unknown as number;
    };
    const leave = (): void => {
        clearTimeout(t.in); t.in = 0;
        clearTimeout(t.out);
        t.out = setTimeout(() => { setOpen(false); setAt(null); }, outMs) as unknown as number;
    };
    // Placed once it is drawn (its size is only known then); hidden until, so it never shows at the wrong place.
    useLayoutEffect(() => {
        if (!open || !trig.current || !box.current) return;
        const r = trig.current.getBoundingClientRect(), c = box.current.getBoundingClientRect();
        setAt(placeCard(r, { w: c.width, h: c.height }, { w: window.innerWidth, h: window.innerHeight }));
    }, [open]);
    useEffect(() => {
        if (!open) return;
        const esc = (e: KeyboardEvent): void => { if (e.key === "Escape") { setOpen(false); setAt(null); } };
        document.addEventListener("keydown", esc);
        return () => document.removeEventListener("keydown", esc);
    }, [open]);
    useEffect(() => () => { clearTimeout(t.in); clearTimeout(t.out); }, []);
    return (
        <span ref={trig} class={`hc${open ? " hc-on" : ""} ${cls}`} onPointerEnter={enter} onPointerLeave={leave} onContextMenu={onContextMenu}>
            {children}
            {open ? <div ref={box} class="hc-card" role="tooltip" style={at ? { left: `${at.left}px`, top: `${at.top}px` } : { visibility: "hidden", left: 0, top: 0 }}>{card}</div> : null}
        </span>
    );
}

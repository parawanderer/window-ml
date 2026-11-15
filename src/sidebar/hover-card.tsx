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

/** The line box of a wrapped trigger that the pointer is on (or the nearest one), from the boxes its lines occupy. */
export function lineAt(rects: { left: number; top: number; bottom: number }[], y: number): { left: number; top: number; bottom: number } | null {
    let best = null, gap = Infinity;
    for (const r of rects) {
        const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
        if (d < gap) { gap = d; best = r; }
    }
    return best;
}

/** How far left of the pointer the card starts, so it opens under the cursor and a move straight down is inside it. */
export const HOVER_CARD_UNDER = 16;

/**
 * A HOVER CARD: a tip the pointer can ENTER, for text too long to read in a tooltip and worth scrolling. Unlike the cursor
 * tip (`cursorTipOn`), which follows the pointer and goes when it moves, this one stays where it opened. It wraps its trigger, and after the pointer has rested on it for a moment opens `card` just below (or above) the LINE the pointer is on, starting at the cursor's column, kept inside the window. The pointer may cross into the card, which stays open for as long as the pointer is in it
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
    // state: ui — where the pointer last was over the trigger; the card opens at the line under it, not at the whole box
    const pointer = useRef({ x: 0, y: 0 });
    const box = useRef<HTMLDivElement>(null);
    // state: ui — this card's two timers
    const timers = useRef<{ in: number; out: number }>({ in: 0, out: 0 });
    const t = timers.current;
    const move = (e: PointerEvent): void => { if (!open) pointer.current = { x: e.clientX, y: e.clientY }; };
    const enter = (e: PointerEvent): void => {
        if (e.pointerType === "touch") return;
        move(e);
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
        const c = box.current.getBoundingClientRect();
        // The TEXT's own line boxes: the trigger is one block box however many lines it wraps to, and the card is inside it.
        const text = document.createRange();
        text.setStart(trig.current, 0);
        text.setEndBefore(box.current);
        const lines = [...(text.getClientRects?.() ?? [])].filter((r) => r.width > 0 && r.height > 0);
        // The line the pointer is on, and the cursor's own column: a string wrapped over twenty lines is not one box to hang a card from.
        const line = (lines.length ? lineAt(lines, pointer.current.y) : null) ?? trig.current.getBoundingClientRect();
        const left = pointer.current.x ? pointer.current.x - HOVER_CARD_UNDER : line.left;
        setAt(placeCard({ left, top: line.top, bottom: line.bottom }, { w: c.width, h: c.height }, { w: window.innerWidth, h: window.innerHeight }));
    }, [open]);
    useEffect(() => {
        if (!open) return;
        const esc = (e: KeyboardEvent): void => { if (e.key === "Escape") { setOpen(false); setAt(null); } };
        document.addEventListener("keydown", esc);
        return () => document.removeEventListener("keydown", esc);
    }, [open]);
    useEffect(() => () => { clearTimeout(t.in); clearTimeout(t.out); }, []);
    return (
        <span ref={trig} class={`hc${open ? " hc-on" : ""} ${cls}`} onPointerEnter={enter} onPointerMove={move} onPointerLeave={leave} onContextMenu={onContextMenu}>
            {children}
            {open ? <div ref={box} class="hc-card" role="tooltip" style={at ? { left: `${at.left}px`, top: `${at.top}px` } : { visibility: "hidden", left: 0, top: 0 }}>{card}</div> : null}
        </span>
    );
}

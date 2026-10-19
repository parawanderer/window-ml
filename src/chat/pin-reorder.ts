// pin-reorder.ts — dragging the Pinned section's rows into a new order: a mouse drag, a long press then drag on
// touch, and Alt+ArrowUp/Down from the keyboard.
//
// The rows move by TRANSFORM while the pointer is down and the list's order is only written once they have settled:
// the dragged row follows the pointer, the rows it passes slide out of its way on the list's shared curve, and on the
// drop it eases into the slot that opened. Then the order is committed, and the transforms are cleared in the layout
// effect of the render that draws it: the same moment the rows reach their new places, so no frame holds both.

import { useEffect, useLayoutEffect, useRef, type MutableRef } from "preact/hooks";
import { dropIndex, moved, shifts, type Slot } from "./pin-order";

/** How far a mouse moves with its button down before the press is a drag rather than a click. */
export const DRAG_SLOP_PX = 5;
/** How long a finger rests on a row before the row lifts. Shorter, and a swipe meant to scroll the list lifts a row. */
export const LONG_PRESS_MS = 350;
/** How far a finger may wander while resting and still lift the row; past it the touch is a scroll. */
const TOUCH_SLOP_PX = 8;
/** How long a row takes to slide into a slot, on the drop and when the keyboard moves one. */
export const SETTLE_MS = 180;
const EASE = "cubic-bezier(.2, .8, .2, 1)";

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Let the rows of `ref`'s section be put in a new order. Each row is a `.chat-row-wrap` holding a
 * `.chat-row[data-session]`; `commit` receives every row's key in the new order.
 */
export function useReorder(ref: MutableRef<HTMLElement | null>, commit: (keys: string[]) => void): void {
    const done = useRef(commit);
    done.current = commit;
    /** Clears the transforms of a drop just committed, once the new order is in the DOM. */
    const settle = useRef<(() => void) | null>(null);
    useLayoutEffect(() => { settle.current?.(); settle.current = null; });
    useEffect(() => {
        const section = ref.current;
        if (!section) return;
        const rowsOf = () => [...section.querySelectorAll<HTMLElement>(":scope > .chat-row-wrap")];
        const keyOf = (row: Element) => row.querySelector<HTMLElement>(".chat-row[data-session]")?.dataset.session ?? "";
        type Press = { id: number; touch: boolean; x0: number; y0: number; row: HTMLElement; timer?: ReturnType<typeof setTimeout> };
        type Drag = { id: number; y0: number; rows: HTMLElement[]; slots: Slot[]; from: number; to: number };
        let press: Press | null = null;
        let drag: Drag | null = null;
        let settling = false;
        let swallowClick = false;

        const lift = (p: Press, y0: number) => {
            const rows = rowsOf();
            const from = rows.indexOf(p.row);
            if (from < 0 || rows.length < 2) { press = null; return; }
            // LAYOUT boxes, not rendered ones: a row still sliding in (just pinned, just revealed) has a transform,
            // and measuring through it aims every row off by however far that animation had to go.
            const slots = rows.map((r) => ({ top: r.offsetTop, height: r.offsetHeight }));
            drag = { id: p.id, y0, rows, slots, from, to: from };
            press = null;
            try { section.setPointerCapture(p.id); } catch { /* the pointer is already gone */ }
            section.classList.add("reordering");
            p.row.classList.add("dragging");
        };
        const follow = (y: number) => {
            if (!drag) return;
            const { slots, from, rows } = drag;
            const last = slots[slots.length - 1];
            const dy = Math.max(-slots[from].top + slots[0].top, Math.min(y - drag.y0, last.top + last.height - slots[from].top - slots[from].height));
            drag.to = dropIndex(slots, from, dy);
            const at = shifts(slots, from, drag.to);
            rows.forEach((r, i) => { r.style.transform = i === from ? `translateY(${dy}px)` : at[i] ? `translateY(${at[i]}px)` : ""; });
        };
        const clear = (rows: HTMLElement[]) => {
            for (const r of rows) { r.style.transform = ""; r.classList.remove("dragging", "settling"); }
            section.classList.remove("reordering");
            settling = false;
        };
        const drop = (cancel: boolean) => {
            if (!drag) return;
            const { rows, slots, from } = drag;
            const to = cancel ? from : drag.to;
            drag = null;
            settling = true;
            swallowClick = true;
            setTimeout(() => { swallowClick = false; }, 0);
            const row = rows[from];
            row.classList.replace("dragging", "settling");
            const at = shifts(slots, from, to);
            rows.forEach((r, i) => { r.style.transform = at[i] ? `translateY(${at[i]}px)` : ""; });
            const finish = () => {
                settle.current = () => clear(rows);
                if (to !== from) done.current(moved(rows.map(keyOf), from, to));
                // Nothing re-renders for a drop back into its own slot.
                requestAnimationFrame(() => { settle.current?.(); settle.current = null; });
            };
            if (reduced()) finish();
            else setTimeout(finish, SETTLE_MS);
        };

        const onDown = (e: PointerEvent) => {
            if (settling || drag || !e.isPrimary || e.button !== 0) return;
            const t = e.target as Element;
            if (t.closest(".chat-row-more")) return;
            const row = t.closest<HTMLElement>(".chat-row-wrap");
            if (!row || row.parentElement !== section) return;
            const touch = e.pointerType !== "mouse";
            press = { id: e.pointerId, touch, x0: e.clientX, y0: e.clientY, row };
            if (touch) press.timer = setTimeout(() => { if (press) { lift(press, press.y0); navigator.vibrate?.(8); } }, LONG_PRESS_MS);
        };
        const onMove = (e: PointerEvent) => {
            if (drag && e.pointerId === drag.id) { follow(e.clientY); return; }
            if (!press || e.pointerId !== press.id) return;
            const far = Math.hypot(e.clientX - press.x0, e.clientY - press.y0);
            if (press.touch) { if (far > TOUCH_SLOP_PX) { clearTimeout(press.timer); press = null; } }
            else if (far > DRAG_SLOP_PX) { const p = press; lift(p, p.y0); follow(e.clientY); }
        };
        const onUp = (e: PointerEvent) => {
            if (press && e.pointerId === press.id) { clearTimeout(press.timer); press = null; }
            if (drag && e.pointerId === drag.id) drop(e.type === "pointercancel");
        };
        // Once a row is up, the finger moves it rather than the list. Only then: before the long press lands, the
        // same touch is a scroll and must stay one.
        const onTouchMove = (e: TouchEvent) => { if (drag) e.preventDefault(); };
        // A long press is also the browser's gesture for a context menu on some phones.
        const onContext = (e: Event) => { if (press?.touch || drag) e.preventDefault(); };
        // The release after a drag must not land on the row's button as a click, which would open the chat that was
        // moved. Chromium already sends it to the section holding the pointer capture; this is for an engine that does not.
        const onClick = (e: MouseEvent) => { if (swallowClick) { e.preventDefault(); e.stopPropagation(); swallowClick = false; } };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape" && drag) { e.preventDefault(); drop(true); return; }
            if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown") || drag || settling) return;
            const row = (e.target as Element).closest<HTMLElement>(".chat-row-wrap");
            const rows = rowsOf();
            const from = row ? rows.indexOf(row) : -1;
            const to = from + (e.key === "ArrowUp" ? -1 : 1);
            if (from < 0) return;
            e.preventDefault();
            if (to < 0 || to >= rows.length) return;
            const key = keyOf(rows[from]);
            const before = new Map(rows.map((r) => [r, r.getBoundingClientRect().top]));
            done.current(moved(rows.map(keyOf), from, to));
            requestAnimationFrame(() => {
                for (const [r, top] of before) {
                    const d = top - r.getBoundingClientRect().top;
                    if (d && !reduced()) r.animate([{ transform: `translateY(${d}px)` }, { transform: "none" }], { duration: SETTLE_MS, easing: EASE });
                }
                section.querySelector<HTMLElement>(`.chat-row[data-session="${CSS.escape(key)}"]`)?.focus();
            });
        };
        section.addEventListener("pointerdown", onDown);
        section.addEventListener("pointermove", onMove);
        section.addEventListener("pointerup", onUp);
        section.addEventListener("pointercancel", onUp);
        section.addEventListener("touchmove", onTouchMove, { passive: false });
        section.addEventListener("contextmenu", onContext);
        section.addEventListener("click", onClick, true);
        section.addEventListener("keydown", onKey);
        return () => {
            clearTimeout(press?.timer);
            section.removeEventListener("pointerdown", onDown);
            section.removeEventListener("pointermove", onMove);
            section.removeEventListener("pointerup", onUp);
            section.removeEventListener("pointercancel", onUp);
            section.removeEventListener("touchmove", onTouchMove);
            section.removeEventListener("contextmenu", onContext);
            section.removeEventListener("click", onClick, true);
            section.removeEventListener("keydown", onKey);
        };
    }, []);
}

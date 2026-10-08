// fold-badges.tsx — a row of badges that FOLDS what does not fit into a "+N" chip, the overflow idiom of a label list:
// as many as fit are shown in priority order, the rest open from the chip in a popover where each keeps its tooltip.
//
// - Each badge says when it may fold (`Fold`): never (live state, the reason to look at the row), last, or first.
// - Which fit is MEASURED, not set by a breakpoint, because the room is what the rest of the row leaves, and a long
//   model name leaves less. `foldPlan` is the rule, pure; the component measures and applies it.
// - A folded badge stays in the DOM, inside the CLOSED popover, which is laid out off-screen and invisible: that is
//   how its width is known without drawing it twice, and a query for it still finds the one element.
// - With no layout at all (a test DOM, a hidden panel) the ROW has no width, and then nothing folds. The badges' own
//   box having none is different: that is a row whose name took all the room, and everything foldable folds.

import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

/** When a badge may fold: 0 never, 1 last, 2 first. */
export type Fold = 0 | 1 | 2;

/** One badge for `FoldBadges`: a stable key, when it may fold, and the badge itself. */
export interface FoldItem { key: string; fold: Fold; el: ComponentChildren }

/**
 * Which badges to fold so the rest fit in `room` px: none when everything fits, else the foldable ones from the
 * RIGHT of the first tier (2), then of the second (1), until what is left plus the chip fits. A badge that may never
 * fold is never chosen, so the result can still overflow; the row's name gives way then.
 *
 * @param items each badge's key, fold tier and width in px, in row order
 * @param room the width available to the badges and the chip
 * @param gap the space between two badges
 * @param chip the width of the "+N" chip
 * @returns the keys to fold
 */
export function foldPlan(items: readonly { key: string; fold: Fold; w: number }[], room: number, gap: number, chip: number): Set<string> {
    const folded = new Set<string>();
    const width = (n: number, sum: number) => sum + gap * Math.max(0, n - 1);
    let n = items.length, sum = items.reduce((a, b) => a + b.w, 0);
    if (width(n, sum) <= room) return folded;
    for (const tier of [2, 1] as const) {
        for (let i = items.length - 1; i >= 0; i--) {
            const it = items[i];
            if (it.fold !== tier) continue;
            // Fits with the chip: stop folding.
            if (folded.size && width(n + 1, sum + chip) <= room) return folded;
            folded.add(it.key); n--; sum -= it.w;
        }
    }
    return folded;
}

/**
 * The badges of one row, folding what does not fit into a "+N" chip that opens a popover of them. It takes the
 * room it is given (a flex item that grows), so place it where the row's spacer was.
 */
export function FoldBadges({ items, label, yieldTip }: { items: readonly FoldItem[]; label: string;
    /** spread on the chip and the popover: handlers for a row tip that should stand aside over them */
    yieldTip?: Record<string, unknown> }) {
    const box = useRef<HTMLSpanElement>(null), pop = useRef<HTMLSpanElement>(null), chipRef = useRef<HTMLButtonElement>(null);
    const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
    const [open, setOpen] = useState<{ x: number; y: number; up: boolean } | null>(null);
    // Measure after every render: a badge's text changes as the model works ("prefill" → "decode", a cache filling),
    // and a width that changed can change the plan. Cheap: a handful of rects, and a state update only when the plan
    // itself moved, so it settles in one pass.
    const measure = () => {
        const el = box.current;
        // No layout (a test DOM, a panel not drawn): there is nothing to measure, so nothing folds.
        if (!el || !(el.parentElement?.clientWidth! > 0)) { if (folded.size) setFolded(new Set()); return; }
        const widths = new Map<string, number>();
        for (const b of el.querySelectorAll<HTMLElement>("[data-fold-key]")) widths.set(b.dataset.foldKey!, b.getBoundingClientRect().width);
        const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
        const chip = chipRef.current?.getBoundingClientRect().width || 28;
        const plan = foldPlan(items.map((it) => ({ key: it.key, fold: it.fold, w: widths.get(it.key) ?? 0 })), el.clientWidth, gap, chip);
        if (plan.size !== folded.size || [...plan].some((k) => !folded.has(k))) setFolded(plan);
    };
    const latest = useRef(measure);
    latest.current = measure;
    useLayoutEffect(measure);
    // The row's width changes without a render here (the panel dragged, the dock resized): observe it.
    useEffect(() => {
        const el = box.current?.parentElement;
        if (!el || typeof ResizeObserver === "undefined") return;
        const ro = new ResizeObserver(() => latest.current());
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    // A fold that empties closes the popover; and the popover closes on a press outside it or on Escape.
    useEffect(() => { if (!folded.size) setOpen(null); }, [folded.size]);
    useEffect(() => {
        if (!open) return;
        const doc = box.current?.ownerDocument ?? document;
        const onDown = (e: Event) => {
            const t = e.composedPath?.()[0] as Node | undefined ?? (e.target as Node);
            if (!pop.current?.contains(t) && !chipRef.current?.contains(t)) setOpen(null);
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); setOpen(null); chipRef.current?.focus(); } };
        doc.addEventListener("pointerdown", onDown, true);
        doc.addEventListener("keydown", onKey);
        return () => { doc.removeEventListener("pointerdown", onDown, true); doc.removeEventListener("keydown", onKey); };
    }, [open]);
    const toggle = () => {
        if (open) { setOpen(null); return; }
        const r = chipRef.current!.getBoundingClientRect(), vh = chipRef.current!.ownerDocument.defaultView?.innerHeight ?? 800;
        // Above when the chip is in the lower half (the model list sits at the bottom of the panel), below otherwise.
        const up = r.top > vh / 2;
        setOpen({ x: r.left, y: up ? vh - r.top + 4 : r.bottom + 4, up });
    };
    const shown = items.filter((it) => !folded.has(it.key)), hidden = items.filter((it) => folded.has(it.key));
    const tag = (it: FoldItem) => <span key={it.key} class="fold-item" data-fold-key={it.key}>{it.el}</span>;
    return (
        <span class="fold-badges" ref={box}>
            {shown.map(tag)}
            {/* Always rendered, so the folded badges can be measured: off-screen and invisible while closed. */}
            <span class={`fold-pop${open ? " open" : ""}`} ref={pop} role={open ? "dialog" : undefined} aria-label={open ? label : undefined}
                aria-hidden={open ? undefined : "true"} {...yieldTip}
                style={open ? { left: `${open.x}px`, ...(open.up ? { bottom: `${open.y}px` } : { top: `${open.y}px` }) } : undefined}>
                {hidden.map(tag)}
            </span>
            {hidden.length ? (
                <button ref={chipRef} class={`fold-chip${open ? " on" : ""}`} aria-expanded={!!open} aria-haspopup="dialog"
                    aria-label={`${hidden.length} more: ${label}`} onClick={toggle} {...yieldTip}>+{hidden.length}</button>
            ) : null}
        </span>
    );
}

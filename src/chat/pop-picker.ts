// pop-picker.ts — the popover behind the start page's pickers (where a run goes, which model): a pill that opens a
// list below it, or above when there is more room there, never past the window's edge; a filter to type into; arrows
// to move, Enter to pick, Escape to close; and a click outside closes it. Extracted from the tab picker so the model
// picker is the same control rather than a second one that behaves a little differently.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

/** Where the list sits, in fixed coordinates, and how tall it may be. */
export interface PopPlace { left: number; top?: number; bottom?: number; width: number; maxHeight: number }

/**
 * A picker's popover state. `picksFor(q)` is what the arrows walk for filter text `q`, in the order drawn; `onOpen` runs
 * each time it opens (to ask for a fresh list). Rows mark themselves with `.tp-row.hot` for the arrows to scroll to.
 */
export function usePickerPop<V>({ picksFor, value, onPick, onOpen, width: [minW, maxW] = [320, 460] }: {
    picksFor: (q: string) => readonly V[];
    value: V;
    onPick: (v: V) => void;
    onOpen?: () => void;
    width?: [number, number];
}) {
    const [open, setOpen] = useState(false);
    const [q, setQ] = useState("");
    const [hot, setHot] = useState(0);
    const [at, setAt] = useState<PopPlace | null>(null);
    const btn = useRef<HTMLButtonElement>(null);
    const pop = useRef<HTMLDivElement>(null);
    const filter = useRef<HTMLInputElement>(null);
    const picks = picksFor(q.trim());

    const place = () => {
        const r = btn.current?.getBoundingClientRect();
        if (!r) return;
        const width = Math.min(maxW, Math.max(r.width, minW), window.innerWidth - 16);
        const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
        // Below when there is room, otherwise above, and never past the window's edge: the list's height is capped by
        // the room on the side it opens, so a short window gets a shorter list that scrolls rather than one whose
        // bottom rows are off the page. A fixed cap alone did that whenever the room was between the two numbers.
        const GAP = 6, MARGIN = 8;
        const below = window.innerHeight - r.bottom - GAP - MARGIN, above = r.top - GAP - MARGIN;
        const down = below >= 320 || below >= above;
        const maxHeight = Math.max(120, Math.min(520, down ? below : above));
        setAt(down ? { left, top: r.bottom + GAP, width, maxHeight } : { left, bottom: window.innerHeight - r.top + GAP, width, maxHeight });
    };
    const openIt = () => { place(); setQ(""); setHot(Math.max(0, picks.indexOf(value))); setOpen(true); onOpen?.(); };
    const close = (refocus = false) => { setOpen(false); if (refocus) btn.current?.focus(); };
    const pick = (v: V) => { close(true); onPick(v); };

    useEffect(() => {
        if (!open) return;
        const onDown = (e: Event) => { const t = e.target as Node; if (!pop.current?.contains(t) && !btn.current?.contains(t)) setOpen(false); };
        const onResize = () => setOpen(false);
        document.addEventListener("pointerdown", onDown);
        window.addEventListener("resize", onResize);
        return () => { document.removeEventListener("pointerdown", onDown); window.removeEventListener("resize", onResize); };
    }, [open]);
    useEffect(() => { if (open) (filter.current ?? pop.current)?.focus(); }, [open]);
    useEffect(() => { setHot(0); }, [q]);
    // Keep the highlighted row in view as the arrows move it.
    useLayoutEffect(() => { pop.current?.querySelector(".tp-row.hot")?.scrollIntoView?.({ block: "nearest" }); }, [hot, open]);

    const onKey = (e: KeyboardEvent) => {
        if (e.key === "ArrowDown") { e.preventDefault(); setHot((h) => Math.min(picks.length - 1, h + 1)); }
        else if (e.key === "ArrowUp") { e.preventDefault(); setHot((h) => Math.max(0, h - 1)); }
        else if (e.key === "Enter") { e.preventDefault(); if (picks[hot] !== undefined) pick(picks[hot]); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); }
    };
    /** Props for the pill: toggles the list, and the arrows open it. */
    const pillProps = {
        ref: btn, type: "button" as const, "aria-haspopup": "listbox" as const, "aria-expanded": open,
        onClick: () => (open ? close() : openIt()),
        onKeyDown: (e: KeyboardEvent) => { if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); openIt(); } },
    };
    /** Props for the list's container: where it sits and the keys. */
    const popProps = at ? {
        ref: pop, role: "listbox" as const, tabIndex: -1, onKeyDown: onKey,
        style: { left: `${at.left}px`, width: `${at.width}px`, maxHeight: `${at.maxHeight}px`, ...(at.top != null ? { top: `${at.top}px` } : { bottom: `${at.bottom}px` }) },
    } : null;
    /** A row's class and hover: `hot` under the arrows, `on` for what is chosen. */
    const row = (v: V, extra = "") => ({
        class: `tp-row${extra}${picks[hot] === v ? " hot" : ""}${value === v ? " on" : ""}`,
        onMouseEnter: () => setHot(picks.indexOf(v)),
        onClick: () => pick(v),
    });
    /** Props for the filter box. */
    const filterProps = { ref: filter, class: "tp-filter", type: "search", value: q, onInput: (e: Event) => setQ((e.target as HTMLInputElement).value) };
    return { open: open && !!popProps, q, pillProps, popProps, row, filterProps };
}

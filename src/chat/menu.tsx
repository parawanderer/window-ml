// menu.tsx — the chat page's ONE popup menu look: a rounded sheet of rows, a glyph and a label each, and a tick on
// a row that is a toggle. The row menu (pin, delete) and the gear's menu (calm view, the box, the bench, settings)
// both draw with it, so the two can never drift into two styles of the same thing.
//
// A row with children (`MenuGroup`) opens them as a SECOND sheet beside the first, the way Google's menus do, on a
// wide layout; on a phone there is no room beside the menu, so the same row SLIDES OVER it instead: the sheet's contents
// are replaced by the group's rows under a back row. Either way the children are the same `MenuItem`s, so the second
// sheet is the same look, never a second style.
import { render } from "preact";
import { signal } from "@preact/signals";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { IconBack, IconCheck, IconChevron } from "../sidebar/icons";
import { useDismiss } from "../sidebar/use-dismiss";
import { useNarrow } from "./narrow";

/** One row. A toggle (`on` given) says its state with a tick rather than by changing its words. `detail` is a quiet
 *  word at the right — WHICH thing the row acts on, where the label alone would not say. It is the slot the theme
 *  row already used for its current choice (`.chat-menu-val`), so a row that must name a device says it the same
 *  way rather than growing the label into a sentence. */
export function MenuItem({ icon, label, detail, note, on, radio, sub, off, onPick }: { icon: ComponentChildren; label: string; detail?: string;
    /** a dim second LINE under the label. Where `off` is set this is the reason, which is the whole point of showing
     *  a row that cannot be used: a tooltip would be pointer-only, and a disabled control is not hoverable anyway. */
    note?: string; on?: boolean;
    /** one of several exclusive choices: `menuitemradio`, ticked while `on` (a theme, say) */
    radio?: { on: boolean };
    /** drawn as a child of an open `MenuGroup`: `i` is its place in the stagger, `open` whether it can be reached */
    sub?: { i: number; open: boolean };
    /** cannot be used from here. `aria-disabled` rather than `disabled`, so it keeps its place in the tab order and
     *  a reader still hears the row and its reason instead of meeting a hole where an option used to be. */
    off?: boolean; onPick: () => void }) {
    return (
        <button class={`chat-menu-item${sub ? " chat-menu-sub" : ""}${off ? " off" : ""}`} role={radio ? "menuitemradio" : on === undefined ? "menuitem" : "menuitemcheckbox"} aria-checked={radio ? radio.on : on}
            {...(sub ? { style: `--i:${sub.i}`, tabIndex: sub.open ? 0 : -1 } : {})} aria-disabled={off || undefined}
            aria-label={detail ? `${label} — ${detail}` : undefined} onClick={off ? undefined : onPick}>
            {/* A child row carries no glyph: its group's own row above it already said what these are, and an icon
                there pushed the label 30px past every other child's. */}
            {icon ? <span class="chat-menu-ico" aria-hidden="true">{icon}</span> : null}
            <span class="chat-menu-label">{label}{note ? <span class="chat-menu-note">{note}</span> : null}</span>
            {detail ? <span class="chat-menu-val">{detail}</span> : null}
            {on || radio?.on ? <span class="chat-menu-on" aria-hidden="true"><IconCheck /></span> : null}
        </button>
    );
}

// state: ui
/** Which group's flyout is open, by its label; null for none. One signal for every group is what makes "only one at a
 *  time" true without the groups knowing about each other. */
const flyoutOpen = signal<string | null>(null);

/** Is a flyout open? The gear's Escape asks, so the first press closes the flyout and only the second the menu. */
export const flyoutIsOpen = (): boolean => flyoutOpen.value !== null;

/** Close whichever flyout is open (the gear calls it when the whole menu closes). */
export const closeFlyout = (): void => { flyoutOpen.value = null; };

/** How long the pointer may be away from a group's row and its flyout before the flyout closes. It is what lets the
 *  pointer cross the gap between them on a diagonal (see `MenuGroup`). */
export const FLYOUT_CLOSE_MS = 250;
/** How long the pointer must rest on a group's row before its flyout opens, so sweeping past a row does not open it. */
export const FLYOUT_OPEN_MS = 120;
/** The space between the first sheet and the flyout, and the least it keeps from the viewport's edge. */
const FLY_GAP = 4, FLY_EDGE = 8;

/**
 * A row that opens into its own rows: a second menu BESIDE this one on a wide layout, a SLIDE-OVER on a phone.
 *
 * Wide: hovering the row for `FLYOUT_OPEN_MS`, clicking it, or ArrowRight/Enter on it opens the flyout, a `.chat-menu`
 * sheet whose first row lines up with the parent row, on the side with room (right, flipped left when it would leave
 * the viewport) and clamped inside it vertically. The pointer may cross from the row to the flyout on any diagonal:
 * leaving either starts a `FLYOUT_CLOSE_MS` close timer that entering the other cancels (a delay, not a safe triangle).
 * Only one group is open at a time (`flyoutOpen`); picking, Escape and a press outside close it. The sheet is drawn
 * into the nearest `.chat` (or the body) with `position: fixed`, because `.chat-list` clips what hangs outside it.
 *
 * Phone: there is no room beside the menu, so choosing the row replaces the sheet's contents with the group's rows
 * under a back row (`IconBack` and the group's label), sliding in from the right; back, or Escape, slides them out
 * again. Focus goes to the first child on entering and to the row on returning. The page is a sibling of the row
 * inside the sheet, and the stylesheet hides the sheet's other rows while one is open (`:has`).
 *
 * `children` is given whether the rows can be reached; they are drawn only while the group is open, so it is always
 * true, and `MenuItem`'s `sub.open` takes it for its tab order.
 */
export function MenuGroup({ icon, label, detail, children }: { icon: ComponentChildren; label: string; detail?: string;
    children: (open: boolean) => ComponentChildren }) {
    const narrow = useNarrow();
    const isOpen = flyoutOpen.value === label;
    const row = useRef<HTMLButtonElement>(null);
    const host = useRef<HTMLDivElement | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const focusFirst = useRef(false);
    const { show, closing } = useDismiss(isOpen && !narrow);
    const { show: showPage, closing: closingPage } = useDismiss(isOpen && narrow, 160);
    const page = useRef<HTMLDivElement>(null);
    const wasOpen = useRef(false);
    const stop = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
    const later = (ms: number, fn: () => void) => { stop(); timer.current = setTimeout(fn, ms); };
    const open = () => { stop(); flyoutOpen.value = label; };
    const close = () => { stop(); if (flyoutOpen.value === label) flyoutOpen.value = null; };

    // The sheet lives in a host element of its own, drawn with Preact's `render` (as panel-head.tsx does, and for the
    // same reason it avoids `preact/compat`), so it sits outside every clipping ancestor of the row.
    useLayoutEffect(() => {
        if (narrow) return;
        if (!show) { if (host.current) render(null, host.current); return; }
        if (!host.current) {
            host.current = document.createElement("div");
            (row.current?.closest(".chat") ?? document.body).appendChild(host.current);
        }
        render(
            <div class={`chat-menu chat-menu-flyout${closing ? " leaving" : ""}`} role="menu" aria-label={label} data-flyout={label}
                onPointerEnter={stop} onPointerLeave={() => later(FLYOUT_CLOSE_MS, close)} onClick={close}
                onKeyDown={(e) => {
                    const items = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>("button")];
                    const at = items.indexOf(document.activeElement as HTMLElement);
                    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                        e.preventDefault();
                        items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
                    } else if (e.key === "ArrowLeft" || e.key === "Escape") {
                        // Stopped here so the gear's own Escape (a document listener) does not also close the menu.
                        e.preventDefault(); e.stopPropagation(); close(); row.current?.focus();
                    }
                }}>
                {children(true)}
            </div>, host.current);
        const el = host.current.firstElementChild as HTMLElement | null, r = row.current;
        if (!el || !r || closing) return;
        // Placed before the first paint (a layout effect), from the row's and the first sheet's rectangles.
        const rr = r.getBoundingClientRect(), mr = (r.closest(".chat-menu") ?? r).getBoundingClientRect();
        const w = el.offsetWidth, h = el.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
        let left = mr.right + FLY_GAP, side = "right";
        if (left + w > vw - FLY_EDGE) { left = mr.left - FLY_GAP - w; side = "left"; }
        left = Math.max(FLY_EDGE, left);
        // 7px = the sheet's padding and border, so the first ROW (not the sheet's edge) lines up with this one.
        const top = Math.max(FLY_EDGE, Math.min(rr.top - 7, vh - h - FLY_EDGE));
        el.style.left = `${left}px`; el.style.top = `${top}px`;
        el.style.setProperty("--fly-dx", side === "right" ? "-6px" : "6px");
        el.dataset.side = side;
        if (focusFirst.current) { focusFirst.current = false; el.querySelector<HTMLElement>("button")?.focus(); }
    });
    // Phone: focus goes to the first child once the page is in, and back to the row when it goes (Escape from the
    // document leaves focus in a page that is about to be removed).
    useLayoutEffect(() => {
        if (!narrow) return;
        if (isOpen && focusFirst.current) { focusFirst.current = false; page.current?.querySelector<HTMLElement>(".chat-menu-sub")?.focus(); }
        if (wasOpen.current && !isOpen && (!document.activeElement || document.activeElement === document.body || page.current?.contains(document.activeElement))) row.current?.focus();
        wasOpen.current = isOpen;
    });
    useEffect(() => () => { stop(); if (host.current) { render(null, host.current); host.current.remove(); host.current = null; } }, []);
    // A press outside the row and its flyout closes it; so does a resize, which would leave it where it was.
    useEffect(() => {
        if (!isOpen || narrow) return;
        const onDown = (e: Event) => {
            const t = e.target as Node;
            if (!row.current?.contains(t) && !host.current?.contains(t)) close();
        };
        document.addEventListener("pointerdown", onDown);
        window.addEventListener("resize", close);
        return () => { document.removeEventListener("pointerdown", onDown); window.removeEventListener("resize", close); };
    }, [isOpen, narrow]);

    if (narrow) return (
        <>
            <button ref={row} class="chat-menu-item" role="menuitem" aria-haspopup="true" aria-expanded={isOpen} onClick={() => { focusFirst.current = true; open(); }}>
                <span class="chat-menu-ico" aria-hidden="true">{icon}</span>
                <span class="chat-menu-label">{label}</span>
                {detail ? <span class="chat-menu-val">{detail}</span> : null}
                <span class="chat-menu-caret fly" aria-hidden="true"><IconChevron /></span>
            </button>
            {showPage ? (
                <div ref={page} class={`chat-menu-page${closingPage ? " closing" : ""}`} role="group" aria-label={label}>
                    <button class="chat-menu-item chat-menu-back" role="menuitem" onClick={close}>
                        <span class="chat-menu-ico" aria-hidden="true"><IconBack /></span>
                        <span class="chat-menu-label">{label}</span>
                    </button>
                    {children(true)}
                </div>
            ) : null}
        </>
    );
    const openFocused = () => {
        if (isOpen) host.current?.querySelector<HTMLElement>("button")?.focus();
        else { focusFirst.current = true; open(); }
    };
    return (
        <button ref={row} class={`chat-menu-item${isOpen ? " fly-open" : ""}`} role="menuitem" aria-haspopup="true" aria-expanded={isOpen}
            onPointerEnter={(e) => { if (e.pointerType !== "touch") later(FLYOUT_OPEN_MS, open); }}
            onPointerLeave={() => { if (isOpen) later(FLYOUT_CLOSE_MS, close); else stop(); }}
            // A keyboard "click" (detail 0) also moves focus into the sheet; a pointer click only opens it.
            onClick={(e) => { if (e.detail === 0) openFocused(); else open(); }}
            onKeyDown={(e) => { if (e.key === "ArrowRight") { e.preventDefault(); openFocused(); } }}>
            <span class="chat-menu-ico" aria-hidden="true">{icon}</span>
            <span class="chat-menu-label">{label}</span>
            {detail ? <span class="chat-menu-val">{detail}</span> : null}
            <span class="chat-menu-caret fly" aria-hidden="true"><IconChevron /></span>
        </button>
    );
}

/** A device's rows under its name, as a labelled group: the name is a small header that cannot be focused or picked,
 *  and the group's `aria-label` is how each row below still says WHICH device it acts on. */
export function MenuSection({ name, children }: { name: string; children: ComponentChildren }) {
    return (
        <div class="chat-menu-section" role="group" aria-label={name}>
            <div class="chat-menu-section-head" role="presentation">{name}</div>
            {children}
        </div>
    );
}

/**
 * Rows put under their runtime, one section per runtime, in the order the first row of each appears. Two rows share a
 * section when their runtimes are the same object or have the same `id` (a runtime with no `id` is told by its name).
 */
export function sectionsByRuntime<T extends { rt: { id?: string; name: string } }>(rows: T[]): { rt: T["rt"]; rows: T[] }[] {
    const out: { key: string; rt: T["rt"]; rows: T[] }[] = [];
    for (const r of rows) {
        const key = r.rt.id ?? r.rt.name;
        const sec = out.find((o) => o.key === key);
        if (sec) sec.rows.push(r); else out.push({ key, rt: r.rt, rows: [r] });
    }
    return out.map(({ rt, rows: rs }) => ({ rt, rows: rs }));
}

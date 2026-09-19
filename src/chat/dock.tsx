// dock.tsx — the chat page's PANELS around the reading column: the box's resource panel and the Python bench, each
// docked to an edge the person picks, DevTools' way.
//
// - Four regions: left and right run the full height, top and bottom sit between them (VS Code's arrangement), all
//   inside the column to the right of the session list, so the list and its rail keep their whole height.
// - Panels on the same edge are TABS, one visible at a time. The tab bar is the panel's header as well: a panel puts
//   its own controls into the bar (`PanelHead`, sidebar/panel-head.tsx), so there is one bar, not tabs over a second
//   row of controls.
// - Each region resizes from its inner edge, and remembers its size on this device (`dockLayout`, view-mode.tsx).
// - Maximize is a temporary zoom over the whole column; Escape comes back.
// - A phone has no edges to spare: every open panel is one full-screen region there, with the same tabs.
//
// It knows nothing about what a panel IS. The page hands it bodies from `ChatExtras`, which keeps `src/chat/` free of
// `chrome` and lets a later panel (the state inspector) arrive as one more entry.
import { signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { IconClose, IconDock, IconExpand, IconMore } from "../sidebar/icons";
import { followDrag } from "../sidebar/drag";
import { DockBarSlot } from "../sidebar/panel-head";
import { MenuItem } from "./menu";
import { dockLayout, setDockLayout, type DockPanelId, type DockSide } from "./view-mode";

/** One panel the page has open, as the dock draws it. */
export interface DockPanel {
    id: DockPanelId;
    /** the tab's name */
    title: string;
    icon: ComponentChildren;
    /** what the tab's tip says: whose it is, when that is not obvious */
    tip?: string;
    body: ComponentChildren;
    close(): void;
}

/** The panel zoomed over the whole column, if any. Not stored: a zoom is a glance, and a reload that came back
 *  zoomed would hide the conversation behind it. */
export const maximized = signal<DockPanelId | null>(null);

const SIDE_NAME: Record<DockSide, string> = { top: "top", right: "right", bottom: "bottom", left: "left" };
/** The smallest a region can be dragged to (its tab bar and a sliver: the panel scrolls inside), and how much of the
 *  column it may take. Smaller than a panel's own floor elsewhere on purpose — here the reading column is what the
 *  room is for, and a region you only glance at can be a strip. */
const MIN_SIZE = 64, MAX_FRAC = 0.8;

/** Move a panel to an edge, and make it that edge's visible tab. */
export function dockTo(id: DockPanelId, side: DockSide): void {
    const l = dockLayout.value;
    setDockLayout({ ...l, side: { ...l.side, [id]: side }, active: { ...l.active, [side]: id } });
}

/** Group the open panels by the edge each is docked to. */
export function byEdge(panels: readonly DockPanel[]): Partial<Record<DockSide, DockPanel[]>> {
    const out: Partial<Record<DockSide, DockPanel[]>> = {};
    for (const p of panels) (out[dockLayout.value.side[p.id]] ??= []).push(p);
    return out;
}

/**
 * The reading column with its docked panels around it.
 *
 * `children` is the main pane (a session, the search page, Settings). On a phone every panel shares one full-screen
 * region instead, over the pane.
 */
export function DockFrame({ panels, narrow, children }: { panels: readonly DockPanel[]; narrow: boolean; children: ComponentChildren }) {
    const frame = useRef<HTMLDivElement>(null);
    const zoomed = maximized.value && panels.some((p) => p.id === maximized.value) ? maximized.value : null;
    // A zoom whose panel has closed is over.
    useEffect(() => { if (maximized.value && !zoomed) maximized.value = null; }, [zoomed]);
    // Escape comes back from a zoom, unless a menu or dialog over it wants the key first.
    useEffect(() => {
        if (!zoomed) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape" || e.defaultPrevented || document.querySelector(".chat-menu, .chat-dialog")) return;
            maximized.value = null;
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [zoomed]);
    // A phone lays the page out one pane at a time, the list included, so there is no column to frame: the panels
    // cover the whole page as one region instead.
    if (narrow) {
        return (
            <>
                {children}
                {panels.length ? <DockRegion side="bottom" panels={panels} frame={frame} full /> : null}
            </>
        );
    }
    const edges = byEdge(panels);
    const region = (side: DockSide) => edges[side]?.length ? <DockRegion side={side} panels={edges[side]!} frame={frame} /> : null;
    return (
        <div class={`chat-work${zoomed ? " zoomed" : ""}`} ref={frame}>
            {region("left")}
            <div class="chat-work-mid">
                {region("top")}
                {children}
                {region("bottom")}
            </div>
            {region("right")}
        </div>
    );
}

/** One edge's region: the tab bar (tabs, the visible panel's own controls, the region's menu), the resize edge, and
 *  the panels' bodies, every one kept mounted so switching tabs loses nothing. */
function DockRegion({ side, panels, frame, full }: { side: DockSide; panels: readonly DockPanel[]; frame: { current: HTMLDivElement | null }; full?: boolean }) {
    const layout = dockLayout.value;
    const active = panels.find((p) => p.id === layout.active[side]) ?? panels[0];
    const zoomed = maximized.value === active.id;
    // Each panel's slot in the bar, as elements: a panel's header row renders into its own, and only the visible
    // tab's slot is shown. State rather than refs so the panels re-render into the slots once they exist.
    const [slots, setSlots] = useState<Partial<Record<DockPanelId, HTMLElement>>>({});
    const slotRef = (id: DockPanelId) => (el: HTMLElement | null) => {
        if (el && slots[id] !== el) setSlots((s) => ({ ...s, [id]: el }));
    };
    const pick = (id: DockPanelId) => setDockLayout({ ...layout, active: { ...layout.active, [side]: id } });
    const horizontal = side === "left" || side === "right";
    const onResize = (e: PointerEvent) => {
        const box = frame.current?.getBoundingClientRect();
        if (!box) return;
        const start = layout.size[side], x0 = e.clientX, y0 = e.clientY;
        const cap = (horizontal ? box.width : box.height) * MAX_FRAC;
        // Dragging TOWARDS the column grows the region: rightwards for the left edge, upwards for the bottom one.
        const sign = side === "left" || side === "top" ? 1 : -1;
        let size = start;
        followDrag(e, (ev) => {
            const d = horizontal ? ev.clientX - x0 : ev.clientY - y0;
            size = Math.round(Math.max(MIN_SIZE, Math.min(cap, start + sign * d)));
            dockLayout.value = { ...dockLayout.value, size: { ...dockLayout.value.size, [side]: size } };
        }, () => setDockLayout({ ...dockLayout.value, size: { ...dockLayout.value.size, [side]: size } }));
    };
    const style = full || zoomed ? undefined : horizontal ? { width: `${layout.size[side]}px` } : { height: `${layout.size[side]}px` };
    return (
        <section class={`chat-dock chat-dock-${side}${zoomed ? " max" : ""}${full ? " full" : ""}`} style={style} aria-label={`Panels, ${SIDE_NAME[side]}`}>
            {full || zoomed ? null : (
                <div class="dock-edge" role="separator" aria-orientation={horizontal ? "vertical" : "horizontal"}
                    aria-label={`Drag to resize the ${SIDE_NAME[side]} panels`} onPointerDown={onResize} />
            )}
            <div class="dock-bar">
                <div class="dock-tabs" role="tablist">
                    {panels.map((p) => (
                        <button key={p.id} role="tab" aria-selected={p === active} class={`dock-tab${p === active ? " on" : ""}${p.tip ? " tt" : ""}`} onClick={() => pick(p.id)}>
                            {p.icon}<span>{p.title}</span>
                            {p.tip ? <span class="tt-pop" role="tooltip">{p.tip}</span> : null}
                        </button>
                    ))}
                </div>
                {panels.map((p) => <div key={p.id} class="dock-slot" hidden={p !== active} ref={slotRef(p.id)} />)}
                <DockMenu panel={active} side={side} zoomed={zoomed} full={full} />
            </div>
            <div class="dock-body">
                {panels.map((p) => (
                    <div key={p.id} class="dock-pane" hidden={p !== active} role="tabpanel">
                        <DockBarSlot.Provider value={slots[p.id] ?? null}>{p.body}</DockBarSlot.Provider>
                    </div>
                ))}
            </div>
        </section>
    );
}

/** The region's `⋮`: which edge the visible panel is docked to, the zoom, and closing it. The same menu component as
 *  the gear's and a session row's, so every menu on the page looks alike. */
function DockMenu({ panel, side, zoomed, full }: { panel: DockPanel; side: DockSide; zoomed: boolean; full?: boolean }) {
    const [open, setOpen] = useState(false);
    const wrap = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        const onDown = (e: Event) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); setOpen(false); } };
        document.addEventListener("pointerdown", onDown);
        document.addEventListener("keydown", onKey);
        return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
    }, [open]);
    const act = (run: () => void) => () => { setOpen(false); run(); };
    return (
        <div class="dock-menu" ref={wrap}>
            <button class="tt hbtn" aria-label={`${panel.title} options`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
                <IconMore /><span class="tt-pop left" role="tooltip">Where it sits, zoom, close</span>
            </button>
            {open ? (
                <div class="chat-menu dock-popup" role="menu" aria-label={`${panel.title} options`}>
                    {full ? null : (
                        <div class="dock-sides" role="group" aria-label="Dock side">
                            <span class="dock-sides-label">Dock side</span>
                            {(["left", "top", "bottom", "right"] as const).map((s) => (
                                <button key={s} role="menuitemradio" aria-checked={s === side} aria-label={`Dock to the ${s}`}
                                    class={`tt hbtn${s === side ? " on" : ""}`} onClick={act(() => { maximized.value = null; dockTo(panel.id, s); })}>
                                    <IconDock side={s} /><span class="tt-pop" role="tooltip">{`Dock to the ${s}`}</span>
                                </button>
                            ))}
                        </div>
                    )}
                    {full ? null : <MenuItem icon={<IconExpand />} label={zoomed ? "Restore" : "Maximize"} onPick={act(() => { maximized.value = zoomed ? null : panel.id; })} />}
                    <MenuItem icon={<IconClose />} label="Close" onPick={act(() => { if (zoomed) maximized.value = null; panel.close(); })} />
                </div>
            ) : null}
        </div>
    );
}

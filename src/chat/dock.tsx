// dock.tsx — the chat page's PANELS around the reading column: the box's resource panel and the Python bench, each
// docked to an edge the person picks, DevTools' way.
//
// - Four regions: left and right run the full height, top and bottom sit between them (VS Code's arrangement), all
//   inside the column to the right of the session list, so the list and its rail keep their whole height.
// - A region holds GROUPS of tabs, one visible at a time, laid side by side or stacked (dock-layout.ts holds the tree and
//   every way it changes). The tab bar is the panel's header as well: a panel puts its own controls into the bar
//   (`PanelHead`, sidebar/panel-head.tsx), so there is one bar, not tabs over a second row of controls.
// - A tab is DRAGGED by its title to another group's bar or middle (a tab there), a group's edge (a split beside it),
//   or an empty edge of the column (a new region); a translucent block shows where it will land. The region's ⋮ does
//   the same moves in two steps, so none of them needs a pointer.
// - Each region resizes from its inner edge, and remembers its size on this device (`dockLayout`, view-mode.tsx).
// - Maximize is a temporary zoom over the whole column; Escape comes back.
// - A phone has no edges to spare: every open panel is one full-screen region there, with the same tabs.
//
// It knows nothing about what a panel IS. The page hands it bodies from `ChatExtras`, which keeps `src/chat/` free of
// `chrome` and lets a later panel (the state inspector) arrive as one more entry.
import { signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { IconBack, IconClose, IconDock, IconExpand, IconMore, IconSplit, IconTab } from "../sidebar/icons";
import { followDrag } from "../sidebar/drag";
import { DockBarSlot } from "../sidebar/panel-head";
import { MenuItem } from "./menu";
import { dockLayout, setDockLayout } from "./view-mode";
import {
    activeOf, canDrop, findPanel, groupsOf, moveTo, reconcile, setActive, setFracs, SIDES,
    type DockGroup, type DockLayout, type DockNode, type DockPanelId, type DockPath, type DockSide, type DockTarget,
} from "./dock-layout";
import { useDismiss } from "../sidebar/use-dismiss";

/** One panel the page has open, as the dock draws it. */
export interface DockPanel {
    id: DockPanelId;
    /** the tab's name */
    title: string;
    icon: ComponentChildren;
    /** what the tab's tip says: whose it is, when that is not obvious — and, under a rule (`.tt-note`), what the
     *  panel is FOR, where that explanation would otherwise be a paragraph sitting on top of the panel's content */
    tip?: ComponentChildren;
    body: ComponentChildren;
    close(): void;
}

/** The panel zoomed over the whole column, if any. Not stored: a zoom is a glance, and a reload that came back
 *  zoomed would hide the conversation behind it. */
export const maximized = signal<DockPanelId | null>(null);

/** A tab being dragged: which panel, where it would land if released now, and the block that shows it. */
interface DockDrag { id: DockPanelId; target: DockTarget | null; ghost: { x: number; y: number; w: number; h: number } | null }
/** The drag in progress, if any. One at a time: there is one pointer. */
export const dockDrag = signal<DockDrag | null>(null);

const SIDE_NAME: Record<DockSide, string> = { top: "top", right: "right", bottom: "bottom", left: "left" };
/** The smallest a region can be dragged to (its tab bar and a sliver: the panel scrolls inside), and how much of the
 *  column it may take. Smaller than a panel's own floor elsewhere on purpose — here the reading column is what the
 *  room is for, and a region you only glance at can be a strip. */
const MIN_SIZE = 64, MAX_FRAC = 0.8;
/** The smallest a group in a split can be dragged to, in px. */
const MIN_GROUP = 80;
/** How far a pointer must move before a press on a tab is a drag rather than a click. */
const DRAG_START = 5;
/** How close to a group's side (as a fraction of the group) a drop splits it rather than joining it as a tab. */
const SPLIT_ZONE = 0.25;
/** How close to an EMPTY edge of the column, in px, a drop starts a region there. */
const EDGE_ZONE = 48;

/** The layout drawn now (`reconcile`d with the open panels), so every operation starts from what is on screen. */
const current = (open: readonly DockPanelId[]) => reconcile(dockLayout.value, open);

/** Move a panel to an edge, and make it that edge's visible tab. */
export function dockTo(id: DockPanelId, side: DockSide, open: readonly DockPanelId[] = [id]): void {
    setDockLayout(moveTo(current(open), id, { kind: "edge", side }));
}

/** Where a drop at (x, y) would land, and the block that shows it: a group's bar or middle is a tab there, its outer
 *  quarter a split on that side, and a strip along an empty edge of the column a new region. A split the layout does
 *  not allow (too deep) falls back to a tab; a drop that would change nothing is no target at all. */
export function dropAt(x: number, y: number, frame: HTMLElement, l: DockLayout, id: DockPanelId): Pick<DockDrag, "target" | "ghost"> {
    const box = (r: DOMRect) => ({ x: r.left, y: r.top, w: r.width, h: r.height });
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const g = el?.closest<HTMLElement>("[data-dock-group]");
    if (g && frame.contains(g)) {
        const side = g.dataset.dockSide as DockSide;
        const path = g.dataset.dockGroup ? g.dataset.dockGroup.split(".").map(Number) : [];
        const r = g.getBoundingClientRect(), bar = g.querySelector(":scope > .dock-bar")?.getBoundingClientRect();
        const tab: DockTarget = { kind: "tab", side, path };
        if (!bar || y > bar.bottom) {
            const fx = (x - r.left) / r.width, fy = (y - r.top) / r.height;
            const near = ([["left", fx], ["right", 1 - fx], ["top", fy], ["bottom", 1 - fy]] as [DockSide, number][])
                .sort((a, b) => a[1] - b[1])[0];
            if (near[1] < SPLIT_ZONE) {
                const t: DockTarget = { kind: "split", side, path, at: near[0] };
                if (canDrop(l, id, t)) {
                    const half = near[0] === "left" || near[0] === "right" ? { w: r.width / 2, h: r.height } : { w: r.width, h: r.height / 2 };
                    return { target: t, ghost: { x: near[0] === "right" ? r.left + r.width / 2 : r.left, y: near[0] === "bottom" ? r.top + r.height / 2 : r.top, ...half } };
                }
            }
        }
        return canDrop(l, id, tab) ? { target: tab, ghost: box(r) } : { target: null, ghost: null };
    }
    // Over the reading column: an EMPTY edge within reach starts a region there. Top and bottom run between the left
    // and right regions, so they are measured on the middle column.
    const mid = frame.querySelector(":scope > .chat-work-mid")?.getBoundingClientRect() ?? frame.getBoundingClientRect();
    const f = frame.getBoundingClientRect();
    const bands: [DockSide, number, { x: number; y: number; w: number; h: number }][] = [
        ["left", x - f.left, { x: f.left, y: f.top, w: Math.min(l.size.left, f.width * 0.4), h: f.height }],
        ["right", f.right - x, { x: f.right - Math.min(l.size.right, f.width * 0.4), y: f.top, w: Math.min(l.size.right, f.width * 0.4), h: f.height }],
        ["top", y - mid.top, { x: mid.left, y: mid.top, w: mid.width, h: Math.min(l.size.top, mid.height * 0.4) }],
        ["bottom", mid.bottom - y, { x: mid.left, y: mid.bottom - Math.min(l.size.bottom, mid.height * 0.4), w: mid.width, h: Math.min(l.size.bottom, mid.height * 0.4) }],
    ];
    if (x < f.left || x > f.right || y < f.top || y > f.bottom) return { target: null, ghost: null };
    for (const [side, d, ghost] of bands.sort((a, b) => a[1] - b[1])) {
        if (d < 0 || d > EDGE_ZONE || l.regions[side]) continue;
        return { target: { kind: "edge", side }, ghost };
    }
    return { target: null, ghost: null };
}

/**
 * The reading column with its docked panels around it.
 *
 * `children` is the main pane (a session, the search page, Settings). On a phone every panel shares one full-screen
 * region instead, over the pane.
 */
export function DockFrame({ panels, narrow, children }: { panels: readonly DockPanel[]; narrow: boolean; children: ComponentChildren }) {
    const frame = useRef<HTMLDivElement>(null);
    const open = panels.map((p) => p.id);
    const layout = current(open);
    // What is drawn is what is stored: a panel that closed leaves the tree (its edge remembered) and one that opened
    // joins its edge, written back so the next operation and the next reload start from the same layout.
    useEffect(() => { if (layout !== dockLayout.value) setDockLayout(layout); }, [layout]);
    const zoomed = maximized.value && open.includes(maximized.value) ? maximized.value : null;
    // A zoom whose panel has closed is over.
    useEffect(() => { if (maximized.value && !zoomed) maximized.value = null; }, [zoomed]);
    // Escape comes back from a zoom, unless a menu or dialog over it wants the key first.
    useEffect(() => {
        if (!zoomed) return;
        const onKey = (e: KeyboardEvent) => {
            // `:not(.leaving)` — a menu now stays in the DOM for the beat it takes to animate away (use-dismiss.ts),
            // and a menu on its way out is not one that wants this key: without it, the Escape that closed a menu
            // left a corpse that swallowed the NEXT Escape, so a zoomed panel could not be dismissed.
            if (e.key !== "Escape" || e.defaultPrevented || document.querySelector(".chat-menu:not(.leaving), .chat-dialog") || dockDrag.value) return;
            maximized.value = null;
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [zoomed]);
    const byId = new Map(panels.map((p) => [p.id, p]));
    const ctx: DockCtx = { layout, open, byId, frame, narrow };
    // A phone lays the page out one pane at a time, the list included, so there is no column to frame: the panels
    // cover the whole page as one region instead, with nothing to drag them to.
    if (narrow) {
        const all: DockGroup = { kind: "group", tabs: [...open], active: open.find((id) => findPanel(layout, id) && activeOf(findPanel(layout, id)!.group) === id) };
        return (
            <>
                {children}
                {panels.length ? (
                    <section class="chat-dock chat-dock-bottom full" aria-label="Panels, bottom">
                        <GroupView ctx={ctx} side="bottom" path={[]} group={all} full />
                    </section>
                ) : null}
            </>
        );
    }
    const at = zoomed ? findPanel(layout, zoomed) : null;
    const region = (side: DockSide) => layout.regions[side]
        ? <DockRegion ctx={ctx} side={side} node={at?.side === side ? at.group : layout.regions[side]!} zoomPath={at?.side === side ? at.path : null} />
        : null;
    const drag = dockDrag.value;
    return (
        <div class={`chat-work${zoomed ? " zoomed" : ""}`} ref={frame}>
            {region("left")}
            <div class="chat-work-mid">
                {region("top")}
                {children}
                {region("bottom")}
            </div>
            {region("right")}
            {/* WHERE IT WILL LAND, while a tab is dragged: the whole group for a tab, the half for a split, a strip
                for a new region. Fixed to the viewport, and transparent to the pointer so hit-testing sees through it. */}
            {drag?.ghost ? <div class="dock-ghost" aria-hidden="true"
                style={{ left: `${drag.ghost.x}px`, top: `${drag.ghost.y}px`, width: `${drag.ghost.w}px`, height: `${drag.ghost.h}px` }} /> : null}
        </div>
    );
}

/** What every part of the dock needs to know: the layout drawn, the open panels, and the frame drops are measured in. */
interface DockCtx { layout: DockLayout; open: readonly DockPanelId[]; byId: Map<DockPanelId, DockPanel>; frame: { current: HTMLDivElement | null }; narrow: boolean }

/** One edge's region: its resize edge and its tree. Zoomed, only the zoomed panel's group is drawn. */
function DockRegion({ ctx, side, node, zoomPath }: { ctx: DockCtx; side: DockSide; node: DockNode; zoomPath: DockPath | null }) {
    const layout = ctx.layout;
    const zoomed = zoomPath != null;
    const horizontal = side === "left" || side === "right";
    const onResize = (e: PointerEvent) => {
        const box = ctx.frame.current?.getBoundingClientRect();
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
    const style = zoomed ? undefined : horizontal ? { width: `${layout.size[side]}px` } : { height: `${layout.size[side]}px` };
    return (
        <section class={`chat-dock chat-dock-${side}${zoomed ? " max" : ""}`} style={style} aria-label={`Panels, ${SIDE_NAME[side]}`}>
            {zoomed ? null : (
                <div class="dock-edge" role="separator" aria-orientation={horizontal ? "vertical" : "horizontal"}
                    aria-label={`Drag to resize the ${SIDE_NAME[side]} panels`} onPointerDown={onResize} />
            )}
            <NodeView ctx={ctx} side={side} node={node} path={zoomPath ?? []} />
        </section>
    );
}

/** A node of a region's tree: a group, or a split drawing its children with a divider between each two. Recursive,
 *  so a deeper tree (see `MAX_SPLIT_DEPTH`) draws with no change here. */
function NodeView({ ctx, side, node, path }: { ctx: DockCtx; side: DockSide; node: DockNode; path: DockPath }) {
    const ref = useRef<HTMLDivElement>(null);
    if (node.kind === "group") return <GroupView ctx={ctx} side={side} path={path} group={node} />;
    const row = node.dir === "row";
    // Dragging a divider trades room between the two children either side of it, never below `MIN_GROUP` each.
    const onDivide = (i: number) => (e: PointerEvent) => {
        const box = ref.current?.getBoundingClientRect();
        if (!box) return;
        const total = row ? box.width : box.height, p0 = row ? e.clientX : e.clientY;
        const start = [...node.fracs], pair = start[i] + start[i + 1], min = Math.min(MIN_GROUP / total, pair / 2);
        let fracs = start;
        followDrag(e, (ev) => {
            const d = ((row ? ev.clientX : ev.clientY) - p0) / total;
            const a = Math.max(min, Math.min(pair - min, start[i] + d));
            fracs = start.map((f, j) => (j === i ? a : j === i + 1 ? pair - a : f));
            dockLayout.value = setFracs(dockLayout.value, side, path, fracs);
        }, () => setDockLayout(setFracs(dockLayout.value, side, path, fracs)));
    };
    return (
        <div class={`dock-split dock-${node.dir}`} ref={ref}>
            {node.children.map((c, i) => [
                i ? <div key={`d${i}`} class="dock-divider" role="separator" aria-orientation={row ? "vertical" : "horizontal"}
                    aria-label="Drag to share the room between these panels" onPointerDown={onDivide(i - 1)} /> : null,
                <div key={`c${i}`} class="dock-cell" style={{ flex: `${node.fracs[i]} 1 0px` }}>
                    <NodeView ctx={ctx} side={side} node={c} path={[...path, i]} />
                </div>,
            ])}
        </div>
    );
}

/** One group: the tab bar (tabs, the visible panel's own controls, the group's menu) and the panels' bodies, every
 *  one kept mounted so switching tabs loses nothing. `full` is the phone's one region, which has nowhere to move to. */
function GroupView({ ctx, side, path, group, full }: { ctx: DockCtx; side: DockSide; path: DockPath; group: DockGroup; full?: boolean }) {
    const panels = group.tabs.map((id) => ctx.byId.get(id)).filter((p): p is DockPanel => !!p);
    const active = panels.find((p) => p.id === activeOf(group)) ?? panels[0];
    // Each panel's slot in the bar, as elements: a panel's header row renders into its own, and only the visible
    // tab's slot is shown. State rather than refs so the panels re-render into the slots once they exist.
    const [slots, setSlots] = useState<Partial<Record<DockPanelId, HTMLElement>>>({});
    const slotRef = (id: DockPanelId) => (el: HTMLElement | null) => {
        if (el && slots[id] !== el) setSlots((s) => ({ ...s, [id]: el }));
    };
    // A press that turned into a drag still ends in a click on the tab it started on; that click is not a pick.
    const dragged = useRef(false);
    if (!active) return null;
    const pick = (id: DockPanelId) => {
        if (dragged.current) { dragged.current = false; return; }
        if (full) { const at = findPanel(ctx.layout, id); if (at) setDockLayout(setActive(ctx.layout, at.side, at.path, id)); return; }
        setDockLayout(setActive(ctx.layout, side, path, id));
    };
    const onTabDown = (id: DockPanelId) => (e: PointerEvent) => {
        if (full || e.button !== 0) return;
        dragged.current = false;
        const x0 = e.clientX, y0 = e.clientY, frame = ctx.frame.current;
        if (!frame) return;
        const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.preventDefault(); dockDrag.value = null; stop(); } };
        const stop = followDrag(e, (ev) => {
            if (!dockDrag.value) {
                if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_START) return;
                dragged.current = true;
                document.documentElement.toggleAttribute("data-dock-drag", true);
                document.addEventListener("keydown", onKey, true);
            }
            dockDrag.value = { id, ...dropAt(ev.clientX, ev.clientY, frame, ctx.layout, id) };
        }, () => {
            document.removeEventListener("keydown", onKey, true);
            document.documentElement.toggleAttribute("data-dock-drag", false);
            const t = dockDrag.value?.target;
            dockDrag.value = null;
            if (t) { maximized.value = null; setDockLayout(moveTo(ctx.layout, id, t)); }
        });
    };
    const zoomed = maximized.value === active.id;
    return (
        <div class="dock-group" data-dock-group={path.join(".")} data-dock-side={side}>
            <div class="dock-bar">
                <div class="dock-tabs" role="tablist">
                    {/* Each tab closes from itself, with an ✕ that arrives with the pointer: the group's menu does
                        the same, but a panel you are done with should go where you are already looking. */}
                    {panels.map((p) => (
                        <span key={p.id} class={`dock-tabwrap${p === active ? " on" : ""}${dockDrag.value?.id === p.id ? " dragging" : ""}`}>
                            <button role="tab" aria-selected={p === active} class={`dock-tab${p === active ? " on" : ""}${p.tip ? " tt" : ""}`}
                                onPointerDown={onTabDown(p.id)} onClick={() => pick(p.id)}>
                                {p.icon}<span>{p.title}</span>
                                {p.tip ? <span class="tt-pop" role="tooltip">{p.tip}</span> : null}
                            </button>
                            <button class="dock-tab-x" aria-label={`Close ${p.title}`}
                                onClick={() => { if (maximized.value === p.id) maximized.value = null; p.close(); }}><IconClose /></button>
                        </span>
                    ))}
                </div>
                {panels.map((p) => <div key={p.id} class="dock-slot" hidden={p !== active} ref={slotRef(p.id)} />)}
                <DockMenu ctx={ctx} panel={active} side={side} zoomed={zoomed} full={full} />
            </div>
            <div class="dock-body">
                {panels.map((p) => (
                    <div key={p.id} class="dock-pane" hidden={p !== active} role="tabpanel">
                        <DockBarSlot.Provider value={slots[p.id] ?? null}>{p.body}</DockBarSlot.Provider>
                    </div>
                ))}
            </div>
        </div>
    );
}

/** The group's `⋮`: which edge the visible panel is docked to, moving it next to another group (a second step, since
 *  every group times every side is too many rows for one menu), the zoom, and closing it. The same menu component as
 *  the gear's and a session row's, so every menu on the page looks alike. */
function DockMenu({ ctx, panel, side, zoomed, full }: { ctx: DockCtx; panel: DockPanel; side: DockSide; zoomed: boolean; full?: boolean }) {
    const [open, setOpen] = useState(false);
    const [step, setStep] = useState<"main" | "move">("main");
    const wrap = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) { setStep("main"); return; }
        const onDown = (e: Event) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); setOpen(false); } };
        document.addEventListener("pointerdown", onDown);
        document.addEventListener("keydown", onKey);
        return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
    }, [open]);
    const act = (run: () => void) => () => { setOpen(false); run(); };
    const move = (t: DockTarget) => act(() => { maximized.value = null; setDockLayout(moveTo(ctx.layout, panel.id, t)); });
    const { show, closing } = useDismiss(open);
    // Every group a panel could be moved next to, and what each allows: as a tab, or split on one of four sides.
    const targets = full ? [] : SIDES.flatMap((s) => groupsOf(ctx.layout.regions[s]).map((g) => {
        const tab: DockTarget = { kind: "tab", side: s, path: g.path };
        const splits = (["left", "top", "bottom", "right"] as const).map((at) => ({ at, t: { kind: "split", side: s, path: g.path, at } as DockTarget }));
        const name = g.group.tabs.map((id) => ctx.byId.get(id)?.title ?? id).join(" · ");
        return { key: `${s}:${g.path.join(".")}`, name, own: g.group.tabs.includes(panel.id), tab, splits };
    })).filter((g) => canDrop(ctx.layout, panel.id, g.tab) || g.splits.some((x) => canDrop(ctx.layout, panel.id, x.t)));
    return (
        <div class="dock-menu" ref={wrap}>
            <button class="tt hbtn" aria-label={`${panel.title} options`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
                <IconMore /><span class="tt-pop left" role="tooltip">Where it sits, zoom, close</span>
            </button>
            {show && step === "move" ? (
                <div class={`chat-menu dock-popup dock-popup-move${closing ? " leaving" : ""}`} role="menu" aria-label={`Move ${panel.title} next to`}>
                    <MenuItem icon={<IconBack />} label="Back" onPick={() => setStep("main")} />
                    {targets.map((g) => (
                        <div key={g.key} class="dock-sides dock-move" role="group" aria-label={g.own ? "Its own group" : g.name}>
                            <span class="dock-sides-label">{g.own ? <>{g.name} <span class="dock-move-own">(its own group)</span></> : g.name}</span>
                            {canDrop(ctx.layout, panel.id, g.tab) ? (
                                <button role="menuitem" aria-label={`As a tab beside ${g.name}`} class="tt hbtn" onClick={move(g.tab)}>
                                    <IconTab /><span class="tt-pop" role="tooltip">As a tab beside {g.name}</span>
                                </button>
                            ) : <span class="dock-move-gap" />}
                            {g.splits.map(({ at, t }) => {
                                const ok = canDrop(ctx.layout, panel.id, t), what = `Split to the ${at} of ${g.name}`;
                                return (
                                    <button key={at} role="menuitem" aria-label={what} aria-disabled={!ok || undefined} class={`tt hbtn${ok ? "" : " off"}`}
                                        onClick={ok ? move(t) : undefined}>
                                        <IconSplit side={at} /><span class="tt-pop" role="tooltip">{ok ? what : `${what}: not this deep`}</span>
                                    </button>
                                );
                            })}
                        </div>
                    ))}
                </div>
            ) : show ? (
                <div class={`chat-menu dock-popup${closing ? " leaving" : ""}`} role="menu" aria-label={`${panel.title} options`}>
                    {full ? null : (
                        <div class="dock-sides" role="group" aria-label="Dock side">
                            <span class="dock-sides-label">Dock side</span>
                            {(["left", "top", "bottom", "right"] as const).map((s) => (
                                <button key={s} role="menuitemradio" aria-checked={s === side} aria-label={`Dock to the ${s}`}
                                    class={`tt hbtn${s === side ? " on" : ""}`} onClick={act(() => { maximized.value = null; dockTo(panel.id, s, ctx.open); })}>
                                    <IconDock side={s} /><span class="tt-pop" role="tooltip">{`Dock to the ${s}`}</span>
                                </button>
                            ))}
                        </div>
                    )}
                    {targets.length ? <MenuItem icon={<IconSplit side="right" />} label="Move next to…" onPick={() => setStep("move")} /> : null}
                    {full ? null : <MenuItem icon={<IconExpand />} label={zoomed ? "Restore" : "Maximize"} onPick={act(() => { maximized.value = zoomed ? null : panel.id; })} />}
                    <MenuItem icon={<IconClose />} label="Close" onPick={act(() => { if (zoomed) maximized.value = null; panel.close(); })} />
                </div>
            ) : null}
        </div>
    );
}

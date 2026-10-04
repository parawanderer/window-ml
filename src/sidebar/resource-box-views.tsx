// resource-box-views.tsx — the track views that draw MORE than one pool: the whole box on one axis, every card's
// utilization over time, and every pool's fill overlaid as lines on a shared percentage scale.
//
// They share the per-pool view's pieces (resource-device-view, resource-area, the overlays and tips) and publish
// the pools they draw (`notePools`) so the arrow keys can step through them.

import { segments, runFrac } from "../resource-axis";
import { hostBands, deviceBands, type Band } from "../resource-bands";
import { type ResourceSample, type ResourceEvent, ceilingsFor, formatBytes, formatShare } from "../resource-model";
import { type DeviceCapacity } from "../resource-capacity";
import { type TrackDef, boxAxis } from "../resource-presets";
import { bridgeOrder, bridgeWalls, linkPhrase } from "../resource-topology";
import { noteRuns, notePools, trackCursor, hoverAt, hoverPool, enterPool, leavePool, snapUnder, poolHover } from "./chart-interaction";
import { W, H } from "./chart-paint";
import { hiddenPools, sampleGapMs, poolColor, togglePool } from "./panel-state";
import { HideTrack } from "./resource-device-view";
import { startBrush, BrushOverlay, EventTip } from "./resource-lane-ui";
import { useInstants, trackCrosshair, Crosshair, TimeGrid, onAxis, InstantRules, HoverSpan } from "./resource-overlays";
import { PoolsTip, hoveredSample, GapTip, UtilTip, utilOf } from "./resource-tips";
import { crosshair } from "./store";
import { kbFocus, kbPool, hoverModel } from "./vram-focus";

/**
 * THE WHOLE BOX ON ONE AXIS — every pool laid END TO END, each filling its own band from its own floor.
 *
 * The question it answers is "how much of this machine is in use", which the per-pool tracks cannot: they
 * give every pool the same height whatever its size, so a 12 GiB card and a 96 GiB one look alike and the
 * box's shape is invisible. Here a pool's height IS its share of the machine.
 *
 * What it must never do is draw the memory as ONE pool. Pools do combine — ollama splits a model across
 * cards and spills the rest into RAM — but at a cost per boundary (a compute buffer and driver context per
 * extra card, layers that do not divide, a RAM spill that is far slower), so the pools are concatenated
 * rather than poured together, and the WALLS between them are drawn. The axis total is then a true total of capacity and every fill is a real
 * reading against a real ceiling. The header says what is HELD and never what is free, which is the one
 * sentence the walls exist to deny.
 */
export function BoxView({ def, samples, latest, hidden, events = [], onHide }: { def: TrackDef; samples: ResourceSample[]; latest: ResourceSample; hidden: Set<string>; events?: ResourceEvent[]; onHide?: () => void }) {
    const cap = latest.capacity!;
    const scope = `total:${def.id}`;
    const all = def.series.map((id) => {
        if (id === "ram" || id === "mem") {
            const c = id === "mem" ? ceilingsFor(latest, cap.devices[0]?.id ?? "") : null;
            return { id, name: id === "mem" ? `${cap.devices[0]?.name ?? "Memory"}` : "System RAM",
                ceiling: c?.hardBytes ?? cap.host.totalBytes, bandsOf: hostBands };
        }
        const d = cap.devices.find((x) => x.id === id.replace(/^vram\./, ""));
        if (!d) return null;
        const c = ceilingsFor(latest, d.id);
        return { id, name: d.name, ceiling: c?.displayBytes ?? d.totalBytes,
            bandsOf: (sm: ResourceSample) => deviceBands(sm, d.id) };
    }).filter(Boolean) as { id: string; name: string; ceiling: number; bandsOf: (s: ResourceSample) => Band[] }[];
    // CARDS THAT ARE DIRECTLY LINKED SIT SIDE BY SIDE (`bridgeOrder`), because a wall between two adjacent bands
    // is the only place a bridge can be drawn on one axis. Only a MEASURED topology reorders; the host pool and
    // anything that is not a card keep their place after the cards.
    const devOrder = bridgeOrder(cap.devices, cap.topology).map((d) => `vram.${d.id}`);
    const rank = (id: string) => { const i = devOrder.indexOf(id); return i < 0 ? 1e6 + def.series.indexOf(id) : i; };
    all.sort((a, b) => rank(a.id) - rank(b.id));
    // A pool switched off leaves the axis entirely rather than sitting there empty: shrinking the total is
    // what makes "just my two cards" a view rather than arithmetic the reader has to do.
    const pools = all.filter((p) => !hiddenPools.value.has(p.id));
    const pciOf = (id: string) => (id.startsWith("vram.") ? cap.devices.find((d) => d.id === id.slice(5))?.pciId : undefined);
    // What each wall between two adjacent pools is: a bridge when THAT pair is directly linked, and whether the
    // run of bridged cards it belongs to is a full mesh (see `bridgeWalls`). Walls between visible pools only —
    // hiding a card re-adjoins its neighbours, and their wall is then about THEM.
    const walls = bridgeWalls(pools.map((p) => ({ pciId: pciOf(p.id) })), cap.topology);
    // SAID PER RUN of bridged cards, not per wall — the facts are about the run. A FULL MESH of more than two is
    // one line ("every pair directly linked"): listing its adjacent walls read as a chain, which is exactly the
    // shape it is not. A PARTIAL mesh keeps its bridge lines and names what is NOT linked ONCE, after the last:
    // the same twelve-pair list under each of seven bridges buried the reading it was there to qualify.
    const links: { label: string; phrase: string; note?: string }[] = [];
    for (let i = 0; i < walls.length;) {
        if (!walls[i].bridge || !walls[i].link) { i++; continue; }
        let j = i;
        while (j + 1 < walls.length && walls[j + 1].bridge && walls[j + 1].link) j++;
        const run = walls.slice(i, j + 1), cards = j - i + 2;
        const phrases = new Set(run.map((w) => linkPhrase(w.link!)));
        if (run[0].mesh === "full" && cards > 2 && phrases.size === 1) {
            links.push({ label: `${pools[i].name} … ${pools[j + 1].name}`,
                phrase: `all ${cards} cards, every pair directly linked (${(cards * (cards - 1)) / 2} pairs) · ${[...phrases][0]}` });
        } else {
            run.forEach((w, k) => links.push({
                label: `${pools[i + k].name} ═ ${pools[i + k + 1].name}`, phrase: linkPhrase(w.link!),
                note: k === run.length - 1 && w.mesh === "partial"
                    ? `these ${cards} cards are a PARTIAL mesh — not directly linked: ${w.unlinked.map(([a, b]) => `${pools[a].name}–${pools[b].name}`).join(", ")}` : undefined,
            }));
        }
        i = j + 1;
    }
    if (!pools.length) return null;
    const axis = boxAxis(pools);
    if (!axis.total) return null;
    const usedOf = (sm: ResourceSample, p: typeof pools[number]) =>
        p.bandsOf(sm).filter((b) => b.kind !== "free" && !(b.model && hidden.has(b.model))).reduce((n, b) => n + b.bytes, 0);
    const runs = noteRuns(segments(samples, sampleGapMs()).filter((r) => r.length > 1));
    const instants = useInstants(events);
    const held = pools.reduce((n, p) => n + usedOf(latest, p), 0);
    // THE SAME READING THE OVERLAID VIEW GIVES, because it is the same question asked of the same pools — this
    // view had none, so pointing at it (or at a key) answered nothing. Colours are the ones the bands are drawn
    // in; the pool you are pointing at is the band you are INSIDE, since the pools here own heights rather
    // than drawing lines to be near.
    const tipPools = pools.map((p) => {
        const bi = axis.bands.findIndex((b) => b.id === p.id);
        return { ...p, color: poolColor(bi < 0 ? 0 : bi, axis.bands.length) };
    });
    // ↑↓ step through THESE pools while the pointer is on this track, in the order they are stacked.
    notePools(scope, tipPools);
    const bandOf = (p: { id: string }): [number, number] => {
        const b = axis.bands.find((x) => x.id === p.id);
        return b ? [b.base / axis.total, (b.base + b.ceiling) / axis.total] : [0, 0];
    };
    return (
        <div class="rc-track">
            <div class="rc-head">
                <HideTrack onHide={onHide} label={pools.map((p) => p.name).join(" · ")} />
                <span class="rc-name">{pools.map((p) => p.name).join(" · ")}</span>
                <span class="sp" />
                {/* HELD, never FREE. Those bytes are measured, so the figure is true. A "free" total would
                    overstate the room — per-card overheads and layer-sized leftovers mean the gap is not all
                    usable — and would count a GiB of slow RAM the same as a GiB of VRAM. */}
                <span class="rc-total tt">
                    {formatBytes(held)} of {formatBytes(axis.total)} held
                    <span class="tt-pop wrap" role="tooltip">Every pool on one axis, laid end to end — each band is one pool's own capacity, filled from its own floor. Pools do combine: a model too big for one card is split across several, and what still does not fit spills into System RAM. But not one-for-one: each extra card a model spans carries its own compute buffer and driver context, layers do not divide, and a spill into RAM runs far slower — so the room above the fills does not simply add up. Switch a pool off in the legend to take it out of the axis.</span>
                </span>
            </div>
            <div class="rc-plot"
                onPointerDown={startBrush(runs)}
                onPointerMove={(e: PointerEvent) => { trackCursor(scope)(e); trackCrosshair(runs)(e); }}
                onPointerLeave={() => {
                    hoverAt.value = null;
                    if (kbFocus.value || kbPool.value) return;
                    crosshair.value = null;
                }}>
                <BrushOverlay runs={runs} />
                <Crosshair runs={runs} />
                <PoolsTip pools={tipPools} latest={latest} at={hoveredSample(runs, scope)} surface={scope} bandOf={bandOf}
                    fracOf={(sm, p) => (p.ceiling > 0 ? Math.min(1, usedOf(sm, p) / p.ceiling) : 0)} usedOf={usedOf} links={links} />
                <EventTip scope={scope} />
                <GapTip scope={scope} />
                <TimeGrid />
                {onAxis(runs, samples, scope, (run) => (<>
                        <svg class="rc-area" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
                            {axis.bands.map((b, bi) => {
                                const p = pools.find((x) => x.id === b.id)!;
                                const y = (v: number) => H - (v / axis.total) * H;
                                const pts: string[] = [];
                                run.forEach((sm) => {
                                    const x = runFrac(run, sm.t) * W;
                                    pts.push(`${x.toFixed(1)},${y(b.base + Math.min(b.ceiling, usedOf(sm, p))).toFixed(1)}`);
                                });
                                for (let i = run.length - 1; i >= 0; i--) {
                                    const x = runFrac(run, run[i].t) * W;
                                    pts.push(`${x.toFixed(1)},${y(b.base).toFixed(1)}`);
                                }
                                return <polygon key={b.id} points={pts.join(" ")} class="rc-boxfill"
                                    fill={poolColor(bi, axis.bands.length)} vector-effect="non-scaling-stroke" />;
                            })}
                        </svg>
                        {/* THE WALLS. Drawn per segment so they sit inside the same clipped box the fills do,
                            and they are the whole reason this axis is honest: without them a reader sees one
                            column and infers one pool. */}
                        {axis.bands.slice(1).map((b, wi) => (
                            // A BRIDGE where that exact pair is directly linked (NVLink, xGMI): the wall a
                            // model split across the two pays least to cross. Hatched, and lighter when the run
                            // it belongs to is only a PARTIAL mesh, so a cube-mesh never reads as a switch.
                            <i key={`w:${b.id}`} class={`rc-boxwall${walls[wi]?.bridge ? ` bridge${walls[wi].mesh === "partial" ? " partial" : ""}` : ""}`} aria-hidden="true"
                                style={{ bottom: `${(b.base / axis.total) * 100}%` }} />
                        ))}
                    </>))}
                <InstantRules instants={instants} scope={scope} />
            </div>
            {/* One key per pool, carrying what it holds OF ITS OWN capacity — the per-pool reading the axis
                deliberately refuses to compute for you. Clicking one takes it off the axis.
                THE SAME KEY THE OVERLAID VIEW USES, down to the element: `.rc-key` is styled for a SPAN with
                `role="button"`, so a native <button> here picked up the browser's own chrome and the two
                legends stopped looking like the same control. Reused rather than restyled — a second key that
                merely resembles the first is how the pointer chip got cloned. */}
            <div class="rc-legend">
                {all.map((p, i) => {
                    const off = hiddenPools.value.has(p.id);
                    const idx = axis.bands.findIndex((b) => b.id === p.id);
                    const color = poolColor(idx < 0 ? i : idx, Math.max(1, axis.bands.length));
                    return (
                        <span class={`rc-key${off ? " off" : ""}${hoverPool.value && hoverPool.value !== p.id ? " away" : ""}`}
                            key={p.id} role="button" tabIndex={0} aria-pressed={!off}
                            // A NAME, not an explanation: the reading is the pool tip this hover opens, exactly as
                            // on the overlaid view's keys. A native `title` as well was a second tooltip, a second
                            // late, for a hint the pressed state already carries.
                            aria-label={off ? `Show ${p.name}` : `Hide ${p.name}`}
                            onClick={() => togglePool(p.id)}
                            onKeyDown={(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); togglePool(p.id); } }}
                            onPointerEnter={(e: PointerEvent) => { enterPool({ ...p, color }); trackCursor(scope)(e); }}
                            onPointerMove={trackCursor(scope)}
                            onPointerLeave={() => { leavePool(); hoverAt.value = null; }}>
                            <i class="rc-swatch" style={{ background: off ? "var(--fg-faint)" : color }} />
                            {p.name} {off ? "off" : formatShare(usedOf(latest, p), p.ceiling, "/")}
                        </span>
                    );
                })}
            </div>
        </div>
    );
}

/**
 * HOW BUSY EACH CARD IS, over time — the Activity preset. Two lines per card in its own colour: SOLID for the
 * GPU, DASHED for its memory controller, which is the one to watch for decode (decode is bound by memory
 * bandwidth, and 90% there is the controller saturating). A share of TIME, so it never shares a track with a
 * share of memory (`kindRefusal`).
 *
 * Both figures are averages the DRIVER takes over its own window (1/6 s to 1 s by product, and the call does
 * not say which), so a reading cannot show two cards of a split model taking turns within one token — the
 * header says "averaged by the driver" rather than implying an instant. A missing reading BREAKS the line: it
 * is "not reported", which is not idle (0 is idle) and not a fault either — a dead card and a card without the
 * counter answer alike, and faults come from `unavailable_gpus`. The two figures are independent (an AMD iGPU
 * has the first and no file for the second), so each is drawn on its own.
 */
export function UtilView({ def, samples, latest, events = [], onHide }: { def: TrackDef; samples: ResourceSample[]; latest: ResourceSample; events?: ResourceEvent[]; onHide?: () => void }) {
    const cap = latest.capacity!;
    const scope = `util:${def.id}`;
    const cards = def.series.map((id) => cap.devices.find((d) => d.id === id.slice("util.".length))).filter(Boolean) as DeviceCapacity[];
    const runs = noteRuns(segments(samples, sampleGapMs()).filter((r) => r.length > 1));
    const instants = useInstants(events);
    if (!cards.length) return null;
    const color = (i: number) => poolColor(i, cards.length);
    const names = cards.map((c) => c.name).join(" · ");
    return (
        <div class="rc-track">
            <div class="rc-head">
                <HideTrack onHide={onHide} label={names} />
                <span class="rc-name">{names}</span>
                <span class="sp" />
                <span class="rc-total tt">
                    % of time busy
                    <span class="tt-pop wrap" role="tooltip">Solid: how busy each GPU was. Dashed: how busy its memory controller was — the one to watch while decoding, which is bound by memory bandwidth. Both are averages the driver takes over its own window (up to a second), so this cannot show two cards taking turns within one token. A card with no reading draws no line: that means not reported, which is neither idle nor a fault.</span>
                </span>
            </div>
            <div class="rc-plot"
                onPointerDown={startBrush(runs)}
                onPointerMove={(e: PointerEvent) => { trackCursor(scope)(e); trackCrosshair(runs)(e); }}
                onPointerLeave={() => { hoverAt.value = null; if (kbFocus.value || kbPool.value) return; crosshair.value = null; }}>
                <BrushOverlay runs={runs} />
                <Crosshair runs={runs} />
                <UtilTip cards={cards} color={color} at={hoveredSample(runs, scope)} latest={latest} scope={scope} />
                <EventTip scope={scope} />
                <GapTip scope={scope} />
                <TimeGrid />
                {onAxis(runs, samples, scope, (run) => (<>
                        <svg class="rc-area" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
                            {cards.flatMap((c, ci) => (["gpuPercent", "memoryPercent"] as const).flatMap((k) => {
                                // Split wherever the reading is ABSENT, so a gap in the counter is a gap in the
                                // line and never a stroke drawn down to zero.
                                const parts: string[][] = [];
                                let cur: string[] = [];
                                run.forEach((sm) => {
                                    const v = utilOf(sm, c.id)?.[k];
                                    if (v == null) { if (cur.length) parts.push(cur); cur = []; return; }
                                    cur.push(`${(runFrac(run, sm.t) * W).toFixed(1)},${(H - (v / 100) * H).toFixed(1)}`);
                                });
                                if (cur.length) parts.push(cur);
                                return parts.filter((pts) => pts.length > 1).map((pts, pi) => (
                                    <polyline key={`${c.id}:${k}:${pi}`} class={`rc-line ${k === "gpuPercent" ? "rc-util-gpu" : "rc-util-mem"}`}
                                        points={pts.join(" ")} fill="none" vector-effect="non-scaling-stroke" stroke={color(ci)} stroke-width={1.5} />
                                ));
                            }))}
                        </svg>
                    </>))}
                <InstantRules instants={instants} scope={scope} />
            </div>
            <div class="rc-legend">
                {cards.map((c, ci) => {
                    const u = utilOf(latest, c.id);
                    return (
                        <span class="rc-key" key={c.id}>
                            <i class="rc-swatch" style={{ background: color(ci) }} />
                            {c.name} {u?.gpuPercent != null ? `${u.gpuPercent}%` : "—"}{u?.memoryPercent != null ? ` · memory ${u.memoryPercent}%` : ""}
                        </span>
                    );
                })}
            </div>
        </div>
    );
}

/** Several series in ONE track, drawn as independent lines rather than a stack: each pool is measured against
 *  its OWN ceiling, so the lines are shares of their own capacity, and one stacked ceiling would compare
 *  nothing. (How much of the whole box is in use is the `total` view's question, answered with walls.) */
export function OverlayView({ def, samples, latest, hidden, events = [], onHide }: { def: TrackDef; samples: ResourceSample[]; latest: ResourceSample; hidden: Set<string>; events?: ResourceEvent[]; onHide?: () => void }) {
    const cap = latest.capacity!;
    // Each series is a POOL: a card, or the host. Including the host matters — a CPU-resident model holds no
    // VRAM, so a cards-only overlay makes it vanish from the chart entirely while it sits in the legend below.
    const pools = def.series.map((id) => {
        if (id === "ram" || id === "mem") {
            const c = id === "mem" ? ceilingsFor(latest, cap.devices[0]?.id ?? "") : null;
            return { id, name: id === "mem" ? `${cap.devices[0]?.name ?? "Memory"}` : "System RAM",
                     ceiling: c?.hardBytes ?? cap.host.totalBytes, bandsOf: hostBands };
        }
        const d = cap.devices.find((x) => x.id === id.replace(/^vram\./, ""));
        if (!d) return null;
        const c = ceilingsFor(latest, d.id);
        return { id, name: d.name, ceiling: c?.displayBytes ?? d.totalBytes, bandsOf: (s: ResourceSample) => deviceBands(s, d.id) };
    }).filter(Boolean) as { id: string; name: string; ceiling: number; bandsOf: (s: ResourceSample) => Band[] }[];
    if (!pools.length) return null;
    // WHAT THE ARROW KEYS STEP THROUGH HERE. Published with the colours the lines are actually drawn in, so a
    // keyboard focus lights the same key the pointer would — `poolColor` is keyed by index among ALL pools,
    // so colouring after any filtering renumbers them.
    notePools("overlay", pools.map((p, pi) => ({ ...p, color: poolColor(pi, pools.length) })));

    const runs = noteRuns(segments(samples, sampleGapMs()).filter((r) => r.length > 1));
    const usedOf = (s: ResourceSample, p: typeof pools[number]) =>
        p.bandsOf(s).filter((b) => b.kind !== "free" && !(b.model && hidden.has(b.model))).reduce((n, b) => n + b.bytes, 0);
    // Plotted as a FRACTION of each pool's own capacity. Absolute bytes on a shared axis would be a lie here:
    // 121.2 GiB of RAM and 95.59 GiB of VRAM are different denominators, so the same height would mean
    // different things per line. Relative occupancy is the comparison this view exists to make.
    const frac = (s: ResourceSample, p: typeof pools[number]) => (p.ceiling > 0 ? Math.min(1, usedOf(s, p) / p.ceiling) : 0);
    // A pool whose models you have ALL hidden reads as empty, with nothing to say it is a choice rather than
    // the truth. Dim it like the row you hid, so the selection is visible from both ends.
    const allHidden = (p: typeof pools[number]) => {
        const mine = p.bandsOf(latest).filter((b) => b.kind === "model" && b.model);
        return mine.length > 0 && mine.every((b) => hidden.has(b.model!));
    };
    const pct = (v: number) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;
    const instants = useInstants(events);
    return (
        <div class="rc-track">
            <div class="rc-head">
                <HideTrack onHide={onHide} label={pools.map((p) => p.name).join(" · ")} />
                <span class="rc-name">{pools.map((p) => p.name).join(" · ")}</span>
                <span class="sp" />
                <span class="rc-total tt">
                    % of each pool
                    <span class="tt-pop wrap" role="tooltip">Each line is how full THAT pool is, as a share of its own capacity — the pools have different sizes, so absolute heights on one axis would not be comparable. Hover a line's key for the real figure.</span>
                </span>
            </div>
            <div class="rc-plot"
                onPointerDown={startBrush(runs)}
                onPointerMove={(e: PointerEvent) => { trackCursor("overlay")(e); trackCrosshair(runs)(e); }}
                onPointerLeave={() => {
                    hoverAt.value = null;                     // …and the same on the overlaid view
                    if (kbFocus.value || kbPool.value) return;
                    leavePool(); crosshair.value = null;
                }}>
                <BrushOverlay runs={runs} />
                <Crosshair runs={runs} />
                <PoolsTip pools={pools.map((p, pi) => ({ ...p, color: poolColor(pi, pools.length) }))}
                    latest={latest} at={hoveredSample(runs, "overlay")} fracOf={frac} usedOf={usedOf} />
                {/* This view has rules of its own now, so it needs the tip that explains them. */}
                <EventTip scope="overlay" />
                <GapTip scope="overlay" />
                <TimeGrid />
                {onAxis(runs, samples, "overlay", (run, ri) => (<>
                        {/* ONE DOT PER LINE at the snapped sample — this view is literally lines, so it is the
                            view where "snap to the line" means the most. Positioned HTML rather than an SVG
                            circle for the same reason as the stacked one: the viewBox is stretched, so a
                            circle inside it would draw as an ellipse. */}
                        {snapUnder(runs)?.run === ri && run.length ? pools
                            // COLOURED BEFORE FILTERING: `poolColor` is keyed by the pool's index among ALL
                            // pools, so filtering first renumbers them and a focused pool takes the first
                            // pool's colour.
                            .map((p, pi) => ({ p, color: poolColor(pi, pools.length) }))
                            .filter(({ p }) => !poolHover.value || poolHover.value.id === p.id)
                            .map(({ p, color }) => {
                                const i = Math.min(run.length - 1, Math.max(0, snapUnder(runs)!.index));
                                const cx = runFrac(run, run[i].t) * 100;
                                return <i key={`sd:${p.id}`} class="rc-snapdot" aria-hidden="true"
                                    style={{ left: `${cx}%`, top: `${(1 - frac(run[i], p)) * 100}%`, background: color }} />;
                            }) : null}
                        <svg class="rc-area" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
                            {pools.map((p, pi) => {
                                const pts = run.map((s) => `${(runFrac(run, s.t) * W).toFixed(1)},${(H - frac(s, p) * H).toFixed(1)}`).join(" ");
                                // non-scaling-stroke keeps the width in DEVICE space: without it the
                                // non-uniform viewBox scale makes diagonals visibly fatter than horizontals.
                                // Two directions of the same question. Hovering this pool highlights it; and
                                // hovering a MODEL row dims every pool that model is NOT resident on, so the
                                // chart points back at the row rather than only the other way round.
                                // Switched off in the legend: no line at all, rather than a dimmed one. The
                                // point of turning a pool off is to get it out of the way of the ones you are
                                // reading, and a ghost still crosses them.
                                if (hiddenPools.value.has(p.id)) return null;
                                const holdsHovered = !!hoverModel.value && p.bandsOf(latest).some((b) => b.model === hoverModel.value);
                                const on = hoverPool.value === p.id || holdsHovered;
                                const muted = (!!hoverPool.value && hoverPool.value !== p.id)
                                    || (!!hoverModel.value && !holdsHovered)
                                    || allHidden(p);
                                return (
                                    <g key={p.id}>
                                        {/* A wide TRANSPARENT copy is the hit target: a 1.5px line is almost
                                            impossible to hover, so the visible stroke stays thin. Its width
                                            NEVER changes — it already covers the hovered stroke, so the
                                            target cannot move out from under a still pointer. */}
                                        <polyline points={pts} fill="none" stroke="transparent" stroke-width="10"
                                            vector-effect="non-scaling-stroke" class="rc-hit"
                                            onPointerEnter={(e: PointerEvent) => { enterPool({ ...p, color: poolColor(pi, pools.length) }); trackCursor("overlay")(e); }}
                                            onPointerLeave={() => leavePool()} />
                                        {/* The visible line takes NO pointer events. Painted on top of the hit
                                            target, it would take them by default — and since it THICKENS on
                                            hover, hovering near the edge put the pointer on the fat stroke,
                                            which fired pointerleave on the hit target, which thinned it again:
                                            a tooltip flickering many times a second. Only the fixed-width
                                            target decides. */}
                                        <polyline class="rc-line" points={pts} fill="none" vector-effect="non-scaling-stroke"
                                            stroke={poolColor(pi, pools.length)}
                                            stroke-width={on ? 3 : 1.5} opacity={muted ? 0.25 : 1} />
                                    </g>
                                );
                            })}
                        </svg>
                    </>))}
                <InstantRules instants={instants} scope="overlay" />
                <HoverSpan scope="lane" />
            </div>
            <div class="rc-legend">
                {pools.map((p, pi) => (
                    // Dimmed from BOTH ends: hovering a model dims the pools it isn't on, and hovering a pool
                    // (its line or its key) dims the other pools' keys — the legend is the list this selection
                    // is made from, so leaving it lit while the chart and the rows both react is a half answer.
                    // NO `tt` class here: this key opens the cursor-following pool tip (below), and a static
                    // popup as well meant two tooltips for one hover. The pool tip carries the same figure
                    // plus what is resident, so the static one had nothing left to add.
                    // CLICK toggles the line, the way clicking a series in Grafana does — and the way a model
                    // row already works here. Two different "off" states share the styling deliberately: a
                    // pool you switched off, and one whose models you have ALL hidden, both read as a line
                    // that is absent by choice rather than by measurement.
                    <span class={`rc-key${(hoverModel.value && !p.bandsOf(latest).some((b) => b.model === hoverModel.value))
                            || (hoverPool.value && hoverPool.value !== p.id) ? " away" : ""}${allHidden(p) || hiddenPools.value.has(p.id) ? " off" : ""}`} key={p.id}
                        role="button" tabIndex={0} aria-pressed={!hiddenPools.value.has(p.id)}
                        aria-label={hiddenPools.value.has(p.id) ? `Show ${p.name}` : `Hide ${p.name}`}
                        onClick={() => togglePool(p.id)}
                        onKeyDown={(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); togglePool(p.id); } }}
                        onPointerEnter={(e: PointerEvent) => { enterPool({ ...p, color: poolColor(pi, pools.length) }); trackCursor("overlay")(e); }} onPointerLeave={() => leavePool()}>
                        <i class="rc-swatch" style={{ background: poolColor(pi, pools.length) }} />
                        {p.name} {pct(frac(latest, p))}
                    </span>
                ))}
            </div>
        </div>
    );
}

// The resource panel's chart: memory over time, stacked BY MODEL, against a real ceiling.
//
// All the arithmetic lives in ../resource-model (pure, unit-tested) — this file is only the drawing. Three
// things it must get right, each one a way the old sparkline misled:
//
//   • A DENOMINATOR. "18 GiB in use" answers nothing without "of 94.97". The ceiling comes from /api/info.
//   • ATTRIBUTION. A device splits into per-model bands, then the residual, then free — never a single total.
//     The residual is named by magnitude (driver overhead vs unattributed), because an idle card still holds
//     ~0.55 GiB of ollama's discovery context and calling that "other processes" invents a process.
//   • HONEST GAPS. Polling is gated on the panel being open, so history is discontinuous. A line drawn across
//     a ten-minute hole is a confident claim about memory nobody measured; `segments` breaks it instead.
import { useMemo } from "preact/hooks";
import {
    deviceBands, hostBands, ceilingsFor, segments, formatBytes, isCpuResident,
    OTHER_BAND_NOTE, DRIVER_BAND_LABEL,
    presetsFor,
    type ResourceSample, type Band, type Capacity, type TrackDef,
} from "../resource-model";
import { colorFor, hoverModel, poolHover, ModelFacts, VRAM_COLORS } from "./vram";
import { loadedModels, resWindowS } from "./store";
import { tipStyle } from "./tip";
import { signal } from "@preact/signals";

/** Which overlay POOL (a card, or the host) is hovered — the line and its key light together. */
const hoverPool = signal<string | null>(null);

/** Where in the PLOT the pointer is (CSS px, and the plot's own width), so the tip can follow it and decide
 *  which side to sit on. Tracked on the plot rather than on each polygon: a polygon's offsetX is relative to
 *  its own segment's SVG, so with several segments it would jump, and the viewBox is 300 units wide whatever
 *  the panel's real pixel width is. */
const hoverAt = signal<{ x: number; y: number; w: number } | null>(null);

const W = 300, H = 72;

/** Every band key present anywhere in the window, in a STABLE order — models first (alphabetical, so a row
 *  doesn't jump when one evicts and reloads), then the residual, then free. Without a fixed order the stack
 *  would reshuffle between samples and the areas would cross. */
function bandOrder(frames: Band[][]): string[] {
    const models = new Set<string>();
    for (const bands of frames) for (const b of bands) if (b.kind === "model" || b.kind === "unknown") models.add(b.key);
    return [...[...models].sort(), "other", "free"];
}

const bandFill = (key: string, bands: Band[]): string => {
    if (key === "free") return "transparent";
    if (key === "other") return "var(--fg-faint)";
    if (key === "unknown") return "var(--fg-faint)";
    const b = bands.find((x) => x.key === key);
    return b?.model ? colorFor(b.model) : "var(--fg-faint)";
};

/** One device (or the host pool) as a stacked area over time. `frames` is one band list per sample. */
function StackedArea({ frames, ceiling, hidden }: { frames: Band[][]; ceiling: number; hidden: Set<string> }) {
    const order = useMemo(() => bandOrder(frames), [frames]);
    if (frames.length < 2 || ceiling <= 0) return <svg class="rc-area" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" />;
    const x = (i: number) => (i / (frames.length - 1)) * W;
    const y = (v: number) => H - Math.min(1, v / ceiling) * H;

    // Cumulative tops per key, so each band is drawn between its own top and the one below it.
    const tops: Record<string, number[]> = {};
    frames.forEach((bands, i) => {
        let acc = 0;
        for (const key of order) {
            if (key === "free") continue;
            const b = bands.find((x2) => x2.key === key);
            // A hidden model drops out of the STACK entirely (and so out of every earlier frame too), which is
            // why the whole series is recomputed on toggle rather than only new points.
            if (b && !hidden.has(b.model ?? "")) acc += b.bytes;
            (tops[key] ||= [])[i] = acc;
        }
    });

    const areas = order.filter((k) => k !== "free").map((key, ki, keys) => {
        const below = ki === 0 ? null : keys[ki - 1];
        const top = tops[key] || [];
        const pts: string[] = [];
        for (let i = 0; i < frames.length; i++) pts.push(`${x(i).toFixed(1)},${y(top[i] ?? 0).toFixed(1)}`);
        for (let i = frames.length - 1; i >= 0; i--) pts.push(`${x(i).toFixed(1)},${y(below ? (tops[below]?.[i] ?? 0) : 0).toFixed(1)}`);
        // The band knows which model it is, so hovering it can name it — and dim its neighbours, so a stack of
        // similar colours resolves into one identifiable shape.
        const model = (frames.at(-1) || []).find((b) => b.key === key)?.model;
        const dim = hoverModel.value && model && hoverModel.value !== model;
        const hot = !!model && hoverModel.value === model;
        return <polygon key={key} points={pts.join(" ")} fill={bandFill(key, frames.at(-1) || [])}
            class={model ? `rc-band${hot ? " hot" : ""}` : undefined} vector-effect="non-scaling-stroke"
            onPointerEnter={model ? () => (hoverModel.value = model) : undefined}
            onPointerLeave={model ? () => { hoverModel.value = null; hoverAt.value = null; } : undefined}
            opacity={dim ? 0.18 : key === "other" ? 0.35 : 0.75} />;
    });
    return (
        <svg class="rc-area" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
            {areas}
        </svg>
    );
}

export interface DeviceViewProps {
    label: string;
    /** The samples to draw — already the window the panel wants. */
    samples: ResourceSample[];
    /** Bands for one sample: the device's, or the host pool's. */
    bandsOf: (s: ResourceSample) => Band[];
    ceiling: number;
    /** A soft ceiling inside the hard one (unified memory's recommended working set), or null. */
    soft?: { bytes: number; label: string } | null;
    /** What the denominator IS, in this track's own terms. Passed in rather than derived here, because the
     *  honest sentence differs per pool: a discrete card's driver total names that vendor's tool, a unified
     *  device's is the system total, and the host pool has no driver in the story at all. */
    ceilingNote: string;
    hidden: Set<string>;
}

/** One track: a header carrying the denominator, then the stacked history, gaps left as gaps. */
export function DeviceView({ label, samples, bandsOf, ceiling, soft, ceilingNote, hidden }: DeviceViewProps) {
    const latest = samples.at(-1);
    const bands = latest ? bandsOf(latest) : [];
    const used = bands.filter((b) => b.kind !== "free" && !(b.model && hidden.has(b.model))).reduce((n, b) => n + b.bytes, 0);
    // Each contiguous run is drawn separately — a gap is a gap, never interpolated across.
    // A run of ONE sample has no shape to draw — StackedArea needs two points — and giving it a 2px column
    // leaves a pale sliver where the band wash is missing, which reads as a rendering artifact rather than as
    // data. Undrawable runs are skipped; nothing is lost, because a lone point conveys no trend either.
    const runs = useMemo(() => segments(samples).filter((r) => r.length > 1), [samples]);
    return (
        <div class="rc-track">
            <div class="rc-head">
                <span class="rc-name">{label}</span>
                <span class="sp" />
                <span class="rc-total tt">
                    {formatBytes(used)} / {formatBytes(ceiling)}
                    {/* RIGHT-anchored (the default): this figure sits at the panel's right edge, so a
                        left-anchored pop extends rightward and is clipped. `wrap` because it is prose. */}
                    <span class="tt-pop wrap" role="tooltip">{ceilingNote}</span>
                </span>
            </div>
            <div class="rc-plot"
                onPointerMove={(e: PointerEvent) => { const el = e.currentTarget as HTMLElement; hoverAt.value = { x: e.offsetX, y: e.offsetY, w: el.clientWidth }; }}
                onPointerLeave={() => { hoverAt.value = null; hoverModel.value = null; }}>
                {runs.map((run, i) => (
                    <div class="rc-seg" key={i} style={{ flex: `${Math.max(1, run.length)} 1 0` }}>
                        <StackedArea frames={run.map(bandsOf)} ceiling={ceiling} hidden={hidden} />
                    </div>
                ))}
                {soft ? <div class="rc-soft" style={{ bottom: `${Math.min(100, (soft.bytes / ceiling) * 100)}%` }}
                    title={soft.label} /> : null}
                <BandTip bands={bands} />
            </div>
            <div class="rc-legend">
                {bands.filter((b) => b.kind === "other" && b.bytes > 0).map((b) => (
                    <span class="rc-key tt" key={b.key}>
                        <i class="rc-swatch rc-swatch-other" /> {b.label} {formatBytes(b.bytes)}
                        <span class="tt-pop left above" role="tooltip">{b.label === DRIVER_BAND_LABEL
                            ? "Ollama's own driver context, held on every visible card whether or not a model is loaded. Not another process."
                            : OTHER_BAND_NOTE}</span>
                    </span>
                ))}
                {bands.filter((b) => b.kind === "free").map((b) => (
                    <span class="rc-key" key={b.key}><i class="rc-swatch rc-swatch-free" /> free {formatBytes(b.bytes)}</span>
                ))}
            </div>
        </div>
    );
}

/** What the hovered band is, shown over the plot. Deliberately the SAME facts as the legend row (ModelFacts),
 *  because a band and its row describe one model — an SVG <title> could carry none of it: no colour, no live
 *  TTL, no badge, and a half-second delay before it appears. */
function BandTip({ bands }: { bands: Band[] }) {
    const name = hoverModel.value;
    const at = hoverAt.value;
    if (!name) return null;
    const band = bands.find((b) => b.model === name);
    if (!band) return null;   // hovering a model that isn't on THIS device — its own track shows the tip
    const m = (loadedModels.value || []).find((x) => x.model === name);
    // Follows the cursor, offset up-left so it never sits under the pointer (which would flicker as the
    // pointer enters the tip itself) and clamped inside the plot so it can't run off the narrow panel.
    const style = at ? tipStyle(at) : undefined;
    return (
        <div class="rc-tip" role="tooltip" style={style}>
            <i class="rc-tip-dot" style={{ background: colorFor(name) }} />
            <span class="rc-tip-name">{name}</span>
            <span class="rc-tip-size">{formatBytes(band.bytes)}</span>
            {m ? <ModelFacts m={m} tips={false} /> : null}
        </div>
    );
}

/** Which device the hovered line is, and what is resident on it — following the cursor, like the band tip.
 *  The model list is deliberately SHORT here: the full detail is the rows below, which grey out to show the
 *  same answer, so this only has to name the device and confirm the selection. */
function PoolTip() {
    const h = poolHover.value, at = hoverAt.value;
    if (!h || !at) return null;
    const style = tipStyle(at);
    return (
        <div class="rc-tip rc-tip-pool" role="tooltip" style={style}>
            <div class="rc-tip-line"><span class="rc-tip-name">{h.name}</span>
                <span class="rc-tip-size">{formatBytes(h.used)} of {formatBytes(h.ceiling)}</span></div>
            {h.consumers.length
                ? h.consumers.map((c) => (
                    <div class="rc-tip-line rc-tip-dim" key={c.label}><span>{c.label}</span><span>{formatBytes(c.bytes)}</span></div>
                ))
                : <div class="rc-tip-line rc-tip-dim">nothing resident</div>}
        </div>
    );
}

/** Every track this machine warrants: one per accelerator, plus the host pool on a discrete box. A unified
 *  device has ONE pool, so it gets one track (its bands already come from the host) and no separate RAM track
 *  — two would double-count the same silicon. */
/** Hovering a pool's line publishes WHICH POOL and WHAT IS ON IT. The model rows below the chart already list
 *  every resident model, so they are the legend: rows not on this pool grey out, and a tooltip on the plot
 *  names the device. That reuses what is on screen instead of injecting a row that pushes the layout around
 *  under the cursor. */
function enterPool(p: { id: string; name: string; ceiling: number; bandsOf: (s: ResourceSample) => Band[] }, latest: ResourceSample): void {
    const bands = p.bandsOf(latest);
    hoverPool.value = p.id;
    poolHover.value = {
        name: p.name,
        ceiling: p.ceiling,
        used: bands.filter((b) => b.kind !== "free").reduce((n, b) => n + b.bytes, 0),
        // Every consumer, named with its share — including the residual, which is most of what a nearly-idle
        // card holds and is the thing a reader would otherwise go looking for a process to explain.
        consumers: bands.filter((b) => b.kind !== "free" && b.bytes > 0).map((b) => ({ label: b.label, bytes: b.bytes })),
    };
}
function leavePool(): void { hoverPool.value = null; poolHover.value = null; }

/** The per-vendor name for "the tool that shows this card's memory". Saying "nvidia-smi" on an AMD box is
 *  worse than saying nothing — it tells the reader to check something that isn't there. */
const smiFor = (runner: string): string =>
    runner === "CUDA" ? "nvidia-smi" : runner === "ROCm" ? "rocm-smi" : "";

/** What a device track's denominator is, in that device's own terms. */
function deviceCeilingNote(dev: { runner: string; unified: boolean; physicalBytes?: number }): string {
    if (dev.unified) return "This machine shares ONE pool of memory between the GPU and the system, so the ceiling is the system total. The dashed line is the working set the accelerator is advised to stay within — it is not a second pool, and the two are never added together.";
    const smi = smiFor(dev.runner);
    if (dev.physicalBytes != null)
        return `Total as the driver reports it${smi ? `, matching ${smi}` : ""}. Ollama places against a slightly lower figure (its own reserve), so a model can fail to fit slightly before this line.`;
    return `Capacity as Ollama reports it — the figure placement decides against. It sits a little below the driver's own total${smi ? `, which ${smi} shows` : ""}; this server doesn't report that one.`;
}

/** Draw one TrackDef. A track's series resolve to band sources: `vram.<id>` is that device's decomposition,
 *  `ram`/`mem` the host pool's. STACK renders the bands (the parts do sum to that pool's occupancy); OVERLAY
 *  renders one line per series, each against its own ceiling, because several pools have no shared total —
 *  which is exactly what `stackRefusal` refuses and why the Overview preset overlays. */
function TrackView({ def, samples, latest, hidden }: { def: TrackDef; samples: ResourceSample[]; latest: ResourceSample; hidden: Set<string> }) {
    const cap = latest.capacity!;
    const deviceOf = (id: string) => cap.devices.find((d) => d.id === id.replace(/^vram\./, ""));
    const first = def.series[0] ?? "";
    const isHost = first === "ram" || first === "mem";

    // `overlay` is meaningful even for ONE series — it is a LINE of that pool's occupancy rather than the
    // per-model bands, which is the compact-vs-detailed choice. Short-circuiting to the stacked view below two
    // series made the mode control inert on exactly the layout the presets produce (a track per pool).
    if (def.mode === "stack") {
        if (isHost) {
            const label = first === "mem" ? `${cap.devices[0]?.name ?? "Memory"} · unified memory` : "System RAM";
            const c = first === "mem" ? ceilingsFor(latest, cap.devices[0]?.id ?? "") : null;
            // The HOST pool: no driver, no framebuffer — just the machine's RAM. On unified memory this same
            // track IS the accelerator's pool, so it carries that explanation instead.
            const note = first === "mem" && cap.devices[0]
                ? deviceCeilingNote(cap.devices[0])
                : "Total system memory. Models here are running on the CPU, or are the spilled part of a model too large for the accelerator.";
            return <DeviceView label={label} samples={samples} bandsOf={hostBands}
                ceiling={c?.hardBytes ?? cap.host.totalBytes} ceilingNote={note}
                soft={c?.softBytes ? { bytes: c.softBytes, label: c.softLabel || "" } : null} hidden={hidden} />;
        }
        const d = deviceOf(first);
        if (!d) return null;
        const c = ceilingsFor(latest, d.id);
        return <DeviceView label={d.name} samples={samples} bandsOf={(s) => deviceBands(s, d.id)}
            ceiling={c?.displayBytes ?? d.totalBytes} ceilingNote={deviceCeilingNote(d)}
            soft={c?.softBytes ? { bytes: c.softBytes, label: c.softLabel || "" } : null} hidden={hidden} />;
    }
    return <OverlayView def={def} samples={samples} latest={latest} hidden={hidden} />;
}

/** Several series in ONE track, drawn as independent lines rather than a stack: their sum is not a quantity
 *  anything is measured against (a model can only use one card's capacity), so the chart must not draw one. */
function OverlayView({ def, samples, latest, hidden }: { def: TrackDef; samples: ResourceSample[]; latest: ResourceSample; hidden: Set<string> }) {
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

    const runs = segments(samples).filter((r) => r.length > 1);
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
    return (
        <div class="rc-track">
            <div class="rc-head">
                <span class="rc-name">{pools.map((p) => p.name).join(" · ")}</span>
                <span class="sp" />
                <span class="rc-total tt">
                    % of each pool
                    <span class="tt-pop wrap" role="tooltip">Each line is how full THAT pool is, as a share of its own capacity — the pools have different sizes, so absolute heights on one axis would not be comparable. Hover a line's key for the real figure.</span>
                </span>
            </div>
            <div class="rc-plot"
                onPointerMove={(e: PointerEvent) => { const el = e.currentTarget as HTMLElement; hoverAt.value = { x: e.offsetX, y: e.offsetY, w: el.clientWidth }; }}
                onPointerLeave={() => { hoverAt.value = null; leavePool(); }}>
                <PoolTip />
                {runs.map((run, ri) => (
                    <div class="rc-seg" key={ri} style={{ flex: `${Math.max(1, run.length)} 1 0` }}>
                        <svg class="rc-area" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
                            {pools.map((p, pi) => {
                                const pts = run.map((s, i) => `${((i / (run.length - 1)) * W).toFixed(1)},${(H - frac(s, p) * H).toFixed(1)}`).join(" ");
                                // non-scaling-stroke keeps the width in DEVICE space: without it the
                                // non-uniform viewBox scale makes diagonals visibly fatter than horizontals.
                                // Two directions of the same question. Hovering this pool highlights it; and
                                // hovering a MODEL row dims every pool that model is NOT resident on, so the
                                // chart points back at the row rather than only the other way round.
                                const holdsHovered = !!hoverModel.value && p.bandsOf(latest).some((b) => b.model === hoverModel.value);
                                const on = hoverPool.value === p.id || holdsHovered;
                                const muted = (!!hoverPool.value && hoverPool.value !== p.id)
                                    || (!!hoverModel.value && !holdsHovered)
                                    || allHidden(p);
                                return (
                                    <g key={p.id}>
                                        {/* A wide TRANSPARENT copy is the hit target: a 1.5px line is almost
                                            impossible to hover, so the visible stroke stays thin. */}
                                        <polyline points={pts} fill="none" stroke="transparent" stroke-width="10"
                                            vector-effect="non-scaling-stroke" class="rc-hit"
                                            onPointerEnter={() => enterPool(p, latest)}
                                            onPointerLeave={() => leavePool()} />
                                        <polyline points={pts} fill="none" vector-effect="non-scaling-stroke"
                                            stroke={VRAM_COLORS[pi % VRAM_COLORS.length]}
                                            stroke-width={on ? 3 : 1.5} opacity={muted ? 0.25 : 1} />
                                    </g>
                                );
                            })}
                        </svg>
                    </div>
                ))}
            </div>
            <div class="rc-legend">
                {pools.map((p, pi) => (
                    <span class={`rc-key tt${hoverModel.value && !p.bandsOf(latest).some((b) => b.model === hoverModel.value) ? " away" : ""}${allHidden(p) ? " off" : ""}`} key={p.id}
                        onPointerEnter={() => enterPool(p, latest)} onPointerLeave={() => leavePool()}>
                        <i class="rc-swatch" style={{ background: VRAM_COLORS[pi % VRAM_COLORS.length] }} />
                        {p.name} {pct(frac(latest, p))}
                        <span class="tt-pop left above" role="tooltip">{formatBytes(usedOf(latest, p))} of {formatBytes(p.ceiling)}</span>
                    </span>
                ))}
            </div>
        </div>
    );
}

/** The panel's tracks, from the chosen LAYOUT. A layout is just `TrackDef[]`; a preset is a named starting
 *  point for it (see `presetsFor`), and editing one is the same operation on the same state. */
export function ResourceTracks({ samples, capacity, hidden, layout }: { samples: ResourceSample[]; capacity: Capacity | null; hidden: Set<string>; layout?: TrackDef[] | null }) {
    // Capacity is fetched once per open and arrives AFTER the first ps poll, so the earliest samples carry
    // none. Backfill the current one rather than dropping them: capacity is slow-moving (a card doesn't change
    // size), and the alternative is a panel that renders nothing for the first two seconds every time.
    const windowed = useMemo(() => {
        const secs = resWindowS.value;
        if (!secs) return samples;
        const cutoff = Date.now() - secs * 1000;
        return samples.filter((s) => s.t >= cutoff);
    }, [samples, resWindowS.value]);
    const filled = useMemo(() => windowed.map((s) => (s.capacity ? s : { ...s, capacity })), [windowed, capacity]);
    const latest = filled.at(-1);
    if (!latest?.capacity) return null;
    const tracks = layout && layout.length ? layout : (presetsFor(latest)[0]?.tracks ?? []);
    return (
        <div class="rc">
            {tracks.map((t) => <TrackView key={t.id} def={t} samples={filled} latest={latest} hidden={hidden} />)}
        </div>
    );
}

/** Models resident on the CPU — they hold no VRAM, so they never appear in a device track and would otherwise
 *  vanish from the panel entirely. */
export const cpuResident = (s: ResourceSample | undefined) => (s?.models ?? []).filter(isCpuResident);

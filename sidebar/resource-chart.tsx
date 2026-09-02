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
    type ResourceSample, type Band, type Capacity,
} from "../resource-model";
import { colorFor } from "./vram";

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
        return <polygon key={key} points={pts.join(" ")} fill={bandFill(key, frames.at(-1) || [])}
            opacity={key === "other" ? 0.35 : 0.75} />;
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
    /** True when `ceiling` is ollama's own total rather than the driver's — say so rather than implying it is
     *  the number nvidia-smi shows. */
    ceilingIsFit?: boolean;
    hidden: Set<string>;
}

/** One track: a header carrying the denominator, then the stacked history, gaps left as gaps. */
export function DeviceView({ label, samples, bandsOf, ceiling, soft, ceilingIsFit, hidden }: DeviceViewProps) {
    const latest = samples.at(-1);
    const bands = latest ? bandsOf(latest) : [];
    const used = bands.filter((b) => b.kind !== "free" && !(b.model && hidden.has(b.model))).reduce((n, b) => n + b.bytes, 0);
    // Each contiguous run is drawn separately — a gap is a gap, never interpolated across.
    const runs = useMemo(() => segments(samples), [samples]);
    return (
        <div class="rc-track">
            <div class="rc-head">
                <span class="rc-name">{label}</span>
                <span class="sp" />
                <span class="rc-total tt">
                    {formatBytes(used)} / {formatBytes(ceiling)}
                    <span class="tt-pop left" role="tooltip">
                        {ceilingIsFit
                            ? "Capacity as Ollama reports it (cuDeviceTotalMem) — the figure placement decides against. Slightly below what nvidia-smi shows, which this server doesn't report."
                            : "Total as the driver reports it, matching nvidia-smi. Ollama places against a slightly lower figure."}
                    </span>
                </span>
            </div>
            <div class="rc-plot">
                {runs.map((run, i) => (
                    <div class="rc-seg" key={i} style={{ flex: `${Math.max(1, run.length)} 1 0` }}>
                        <StackedArea frames={run.map(bandsOf)} ceiling={ceiling} hidden={hidden} />
                    </div>
                ))}
                {soft ? <div class="rc-soft" style={{ bottom: `${Math.min(100, (soft.bytes / ceiling) * 100)}%` }}
                    title={soft.label} /> : null}
            </div>
            <div class="rc-legend">
                {bands.filter((b) => b.kind === "other" && b.bytes > 0).map((b) => (
                    <span class="rc-key tt" key={b.key}>
                        <i class="rc-swatch rc-swatch-other" /> {b.label} {formatBytes(b.bytes)}
                        <span class="tt-pop left" role="tooltip">{b.label === DRIVER_BAND_LABEL
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

/** Every track this machine warrants: one per accelerator, plus the host pool on a discrete box. A unified
 *  device has ONE pool, so it gets one track (its bands already come from the host) and no separate RAM track
 *  — two would double-count the same silicon. */
export function ResourceTracks({ samples, capacity, hidden }: { samples: ResourceSample[]; capacity: Capacity | null; hidden: Set<string> }) {
    // Capacity is fetched once per open and arrives AFTER the first ps poll, so the earliest samples carry
    // none. Backfill the current one rather than dropping them: capacity is slow-moving (a card doesn't change
    // size), and the alternative is a panel that renders nothing for the first two seconds every time.
    const filled = useMemo(() => samples.map((s) => (s.capacity ? s : { ...s, capacity })), [samples, capacity]);
    const latest = filled.at(-1);
    const cap = latest?.capacity;
    if (!cap) return null;
    const samplesIn = filled;
    const tracks = cap.devices.map((d) => {
        const c = ceilingsFor(latest!, d.id);
        return (
            <DeviceView key={d.id} label={cap.unified ? `${d.name} · unified memory` : d.name}
                samples={samplesIn} bandsOf={(s) => deviceBands(s, d.id)}
                ceiling={c?.displayBytes ?? d.totalBytes} ceilingIsFit={c?.displayIsFit}
                soft={c?.softBytes ? { bytes: c.softBytes, label: c.softLabel || "" } : null}
                hidden={hidden} />
        );
    });
    // System RAM is its own pool only on a DISCRETE box; on unified memory the device track already IS it.
    if (!cap.unified) tracks.push(
        <DeviceView key="host" label="System RAM" samples={samplesIn} bandsOf={hostBands}
            ceiling={cap.host.totalBytes} hidden={hidden} />);
    return <div class="rc">{tracks}</div>;
}

/** Models resident on the CPU — they hold no VRAM, so they never appear in a device track and would otherwise
 *  vanish from the panel entirely. */
export const cpuResident = (s: ResourceSample | undefined) => (s?.models ?? []).filter(isCpuResident);

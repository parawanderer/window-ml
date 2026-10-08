// model-rows.tsx — the model list under the resource chart: one row per resident model, the ghost rows for one
// that is loading, evicted, hidden or not yet seen, and the tooltips over a row and over its sparkline. The rows
// are the chart's legend, so hovering one lights that model on the plot.

import { signal } from "@preact/signals";
import type { LoadedModel } from "../contract/contract-server";
import { type ResourceSample, formatBytes, placementOf, isSplit } from "../resource/resource-model";
import { poolHover } from "./chart-interaction";
import { modelKindLabel } from "./model-status";
import { rowTipSuppressed, ModelFacts, CostFacts } from "./panel-facts";
import { hiddenModels, toggleHidden, poolFacts } from "./panel-state";
import { colorFor } from "./palette";
import { hhmmss } from "./timestamps";
import { useTipPlacement } from "./use-tip";
import { hoverModel } from "./vram-focus";

/** A model NAMED BUT NOT LOADED — evicted inside the window the chart still covers, or one that only ever
 *  ran off-box. The rows are the chart's legend, so a colour still being drawn needs a row to say whose it
 *  is; what it does not need is a live model's controls, because there is nothing to unload or hide.
 *
 *  ONE component for what were three near-identical copies (in-scope evicted, in-scope off-box, and the same
 *  two again inside the out-of-scope disclosure) — the third copy is what made it worth extracting. */
export function GhostRow({ name, kind }: { name: string; kind: "off" | "ghost" | "unseen" | "loading" | "idle" }) {
    const off = hiddenModels.value.has(name);
    const label = kind === "off" ? "off-box" : kind === "unseen" ? "not seen" : kind === "loading" ? "loading" : kind === "idle" ? "not loaded" : "evicted";
    const why = kind === "off"
        // Only ever a CLOUD model now — the server's own list says it is not one of its models. This tooltip
        // used to add "or one already gone before the panel opened", which lumped a local model the panel had
        // simply not seen in with a model that runs somewhere else entirely: two different facts, one label.
        ? "Not one of this server's models — it runs somewhere else, and never occupies memory here. It is drawn in the lane because it RAN; this row is what says whose colour that is."
        : kind === "idle"
            ? "Served by this box, and not in memory right now — either its load has not started yet, or it ran and left before the panel took a reading. Not off-box: when it runs, it runs here."
        : kind === "unseen"
            ? "Where this is running is UNKNOWN: the backend is not answering, so nothing has told us what is resident. It is drawn in the lane because it ran. Not the same as off-box, which is a claim we have no reading to make."
            : kind === "loading"
                ? "Loading onto this box right now. It holds memory already — that is the jump in the track above — but Ollama has no runner object for it until the load finishes, so /api/ps cannot yet name it."
                : "No longer resident. It is still drawn in the history above, for as long as that history covers the time it was loaded — this row is what says whose colour that is.";
    return (
        <div class={`vram-row ghost${hoverModel.value === name ? " hot" : ""}`}
            onPointerEnter={() => (hoverModel.value = name)}
            onPointerLeave={() => (hoverModel.value = null)}>
            {/* A REAL CONTROL, like the resident rows'. These models are drawn — a ghost across the history it
                was loaded in, an off-box one in the lane — so "switch it off" has something to do here, and
                an inert dot on a row that IS on the chart is a control that silently does nothing. */}
            <button class={`vram-dot ghost-dot${off ? " off" : ""}`}
                style={{ background: off ? "var(--fg-faint)" : colorFor(name) }}
                title={off ? "Show on the chart" : "Hide from the chart"} onClick={() => toggleHidden(name)}
                onPointerEnter={() => (rowTipSuppressed.value = true)}
                onPointerLeave={() => (rowTipSuppressed.value = false)} />
            <span class="vram-name">{name}</span>
            <span class="tt vram-embed">{label}
                <span class="tt-pop left above" role="tooltip">{why}</span>
            </span>
            <span class="sp" />
        </div>
    );
}

/** One resident model's row. Extracted because the SCOPED list draws it in two places now — the session's
 *  own models, and the folded "other models on the box" — and a second copy of a row with four interactive
 *  parts is exactly where two lists start behaving differently. */
export function ModelRow({ m, hidden, latestSample, evict }: { m: LoadedModel; hidden: Set<string>; latestSample: ResourceSample | null; evict: (model?: string) => void }) {
    const off = hidden.has(m.model);
    return (
        <div class={`vram-row${off ? " off" : ""}${hoverModel.value === m.model ? " hot" : ""}${poolHover.value && latestSample && !poolFacts(poolHover.value.bandsOf(latestSample)).consumers.some((c) => c.label === m.model) ? " away" : ""}`}
            onPointerEnter={() => (hoverModel.value = m.model)}
            onPointerMove={(e: PointerEvent) => (rowTipAt.value = { x: e.clientX, y: e.clientY })}
            onPointerLeave={() => { hoverModel.value = null; rowTipAt.value = null; rowTipSuppressed.value = false; }}>
            {/* THE ROW'S CURSOR TIP STANDS DOWN under anything with a tooltip of its OWN — the same rule
                `ModelFacts` follows for its badges (`yieldTip`), applied to the two controls that were
                missing it. Without it the row tip follows the pointer onto the control and sits on top of the
                anchored one, so the answer you asked for is covered by the answer you did not.
                `title` here rather than a `.tt-pop`: this is an icon-only control, so the accessible NAME is
                what a screen reader and a keyboard user get. */}
            <button class="vram-dot" style={{ background: off ? "var(--fg-faint)" : colorFor(m.model) }}
                title={off ? "Show in totals" : "Hide from totals"} onClick={() => toggleHidden(m.model)}
                onPointerEnter={() => (rowTipSuppressed.value = true)}
                onPointerLeave={() => (rowTipSuppressed.value = false)} />
            <span class="vram-name">{m.model}</span>
            <ModelFacts m={m} />
            <span class="sp" />
            <span class="vram-gb">{m.vramBytes ? formatBytes(m.vramBytes) : m.sizeBytes ? `${formatBytes(m.sizeBytes)} (CPU)` : "?"}</span>
            <button class="tt vram-x" aria-label="Evict from VRAM" onClick={() => evict(m.model)}
                onPointerEnter={() => (rowTipSuppressed.value = true)}
                onPointerLeave={() => (rowTipSuppressed.value = false)}>✕<span class="tt-pop" role="tooltip">Evict from VRAM</span></button>
        </div>
    );
}

/** Pointer position for the model-row tip, in viewport coords (the row is not inside the plot). */
export const rowTipAt = signal<{ x: number; y: number } | null>(null);

/** Which datapoint of the no-ceiling fallback line the pointer is on, and where the pointer is. */
export const sparkAt = signal<{ i: number; x: number; y: number } | null>(null);

/** The fallback line's readout: what was in use, and when. There is no ceiling on this server, so there is no
 *  share to report — saying "80%" of an unknown total is the exact invention the no-ceiling fallback exists to
 *  refuse. The absolute figure and the instant are what this view genuinely knows. */
export function SparkTip({ series, history }: { series: number[]; history: { t: number; models: Record<string, number> }[] }) {
    const at = sparkAt.value;
    if (!at || !series.length) return null;
    const i = Math.min(series.length - 1, Math.max(0, at.i));
    const t = history[i]?.t;
    const { ref, style } = useTipPlacement({ x: at.x, y: at.y, w: typeof window !== "undefined" ? window.innerWidth : 1e4 });
    const ago = t ? Math.max(0, Date.now() - t) : 0;
    return (
        <div class="rc-tip rc-tip-pool" role="tooltip" ref={ref} style={style}>
            <div class="rc-tip-line"><span class="rc-tip-name">in use</span>
                <span class="rc-tip-size">{formatBytes(series[i] * 1e9)}</span></div>
            {t ? <div class="rc-tip-line rc-tip-when"><span>{hhmmss(t)}</span>
                <span class="rc-tip-ago">{ago < 1500 ? "now" : `${Math.round(ago / 1000) < 60 ? `${Math.round(ago / 1000)}s` : `${Math.round(ago / 60000)}m`} ago`}</span></div> : null}
        </div>
    );
}

/** What a hovered model row is, following the cursor. The single VRAM total hides how a model is PLACED — the
 *  same 18 GiB reads identically whether it sits on one card, is split across two, or is partly offloaded to
 *  system RAM, and that last one is why a "GPU" model can still be slow. */
export function RowTip({ sample }: { sample: ResourceSample | null }) {
    const name = hoverModel.value, at = rowTipAt.value;
    if (!name || !at || !sample || rowTipSuppressed.value) return null;
    const m = sample.models.find((x) => x.model === name);
    if (!m) return null;
    const where = placementOf(m, sample.capacity, formatBytes);
    // The SAME placement every other cursor tip uses — measured, so it flips when it doesn't fit rather than
    // when it passes an arbitrary fraction of the width.
    const { ref, style } = useTipPlacement({ x: at.x, y: at.y, w: typeof window !== "undefined" ? window.innerWidth : 1e4 });
    return (
        // The SAME snapping every other cursor-following tip uses — this one had none, so it ran off the
        // window's right edge. Bounds are the viewport here (the row sits outside the plot, so the tip is
        // position: fixed).
        <div class="vram-rowtip rc-tip" role="tooltip"
            ref={ref} style={style}>
            {/* Placement rides the NAME line. It is one short phrase and the tip has grown a cost line and a
                residency line beneath it, so on its own row it read as a third fact of equal weight when it
                is really part of identifying the thing: which model, and where it is. */}
            {/* THE NAME OWNS ITS LINE. Placement is a sentence — "split: CUDA0 12.1 GiB · CUDA1 8.4 GiB · RAM
                2.0 GiB" — and beside a model id that is already long it wrapped into a ragged column where
                the name and the placement each looked like a fragment of the other. Below it they read as
                what they are: a thing, then where it is. */}
            <div class="vram-rowtip-name">
                <i class="rc-tip-dot" style={{ background: colorFor(name) }} />{name}
                {modelKindLabel(name) ? <span class="vram-rowtip-kind">{modelKindLabel(name)}</span> : null}
            </div>
            {where ? <div class={`vram-rowtip-where${isSplit(m) ? " vram-rowtip-split" : ""}`}>{isSplit(m) ? "split: " : "on "}{where}</div> : null}
            <div class="vram-rowtip-dim">{formatBytes((m.vramBytes || 0) + (m.ramBytes || 0))} resident</div>
            {/* Residency answers "what is loaded"; this answers "and was it worth the VRAM". */}
            <CostFacts model={name} />
        </div>
    );
}

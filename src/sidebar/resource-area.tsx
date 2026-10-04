// resource-area.tsx — one pool's memory as a stacked area over time: a band per model, then the residual, then
// free, against the pool's real ceiling, with the drilled-in memory parts and the KV-cache fill drawn inside a band.
//
// The arithmetic deciding each band's height is in ../resource-bands and the colours are in chart-paint; this
// is the drawing. Every track view that shows memory draws through here.

import { useMemo } from "preact/hooks";
import { runFrac } from "../resource-axis";
import { type Band, bandOrder, pendingAllocation, stepBands, bandEdge } from "../resource-bands";
import { kvFill } from "../resource-gens";
import { type ResourceSample, type ResourceEvent, type MemoryBreakdown, memoryParts, MEMORY_PARTS } from "../resource-model";
import { trackCursor, hoverAt } from "./chart-interaction";
import { bandIdentity, bandTint, W, H, partFill, bandFill } from "./chart-paint";
import { sampleGraceMs, colorFor } from "./panel-state";
import { hoverModel, kbFocus } from "./vram-focus";

/**
 * WHAT ONE GENERATION LEFT IN THE KV CACHE, drawn inside the drilled-in cache part while its lane span is
 * hovered. The part is the cache's RESERVATION — allocated in full at load, so its height never moves — and
 * this is the only view of how much of it a turn actually filled: bottom to top, the prefix reused from the
 * cache (dotted), the prompt computed this turn (dense), the tokens decoded (light), and above that the part
 * as it always looks, reserved and empty.
 *
 * Placed at the generation's own position on the axis and read from the sample at its end, where the counts
 * describe the cache. Positioned HTML over the segment rather than SVG inside it: the plot's SVG is stretched
 * to the track, and a dotted pattern drawn in it would smear into lines. A share of TOKENS, never bytes — see
 * `kvFill` — and a composition rather than a ramp over time, since the engine reports counts, not a timeline.
 */
export function KvFill({ run, bandsOf, deep, ev }: { run: ResourceSample[]; bandsOf: (s: ResourceSample) => Band[]; deep: { model: string; ceiling: number }; ev: ResourceEvent }) {
    const n = run.length;
    if (n < 2 || !ev.gen || ev.until == null) return null;
    const t0 = run[0].t, t1 = run[n - 1].t;
    // A generation outside this run belongs to another segment (or to a gap, where nothing was measured).
    if (ev.until < t0 || ev.t > t1 + sampleGraceMs()) return null;
    // On the chart's axis — linear in time across the run — and read from the first sample at or after the
    // generation's end, where the counts describe the cache.
    const a = runFrac(run, ev.t), b = runFrac(run, ev.until);
    const at = run.find((sm) => sm.t >= ev.until!) ?? run[n - 1];
    const band = bandsOf(at).find((x) => x.model === deep.model);
    const parts = band?.parts;
    const r = at.models.find((x) => x.model === deep.model);
    const fill = kvFill(ev.gen, r?.contextLength, r?.activity?.slots ?? 1);
    if (!parts || !(parts.kvCache > 0) || !fill) return null;
    // The cache part sits directly above the weights in the stack (MEMORY_PARTS order).
    const floor = parts.weights, kv = parts.kvCache;
    const pct = (bytes: number) => (bytes / Math.max(1, deep.ceiling)) * 100;
    const layers = (fill.prompt != null
        ? [{ k: "prompt", share: fill.prompt }]
        : [{ k: "cached", share: fill.cached ?? 0 }, { k: "computed", share: fill.computed ?? 0 }])
        .concat([{ k: "decoded", share: fill.decoded }]);
    let acc = floor;
    // A generation is often a few ms against a window of minutes, so it is WIDENED to stay visible; double-
    // clicking its span frames the panel on it, which is the gesture for seeing it at its real width.
    const w = Math.max(1.2, (b - a) * 100);
    return (
        <div class={`rc-kvfill${fill.overflow ? " overflow" : ""}`} aria-hidden="true"
            style={{ left: `${Math.min(100 - w, a * 100)}%`, width: `${w}%`, "--model": colorFor(deep.model) }}>
            {layers.map((l) => {
                const h = l.share * kv;
                const el = <i key={l.k} class={`rc-kvfill-${l.k}`} style={{ bottom: `${pct(acc)}%`, height: `${pct(h)}%` }} />;
                acc += h;
                return el;
            })}
            {/* The reservation's top edge, so the empty remainder above the fill reads as part of the SAME cache
                rather than as whatever happens to be drawn over it. */}
            <i class="rc-kvfill-cap" style={{ bottom: `${pct(floor + kv)}%` }} />
        </div>
    );
}

/** One device (or the host pool) as a stacked area over time. `frames` is one band list per sample. */
export function StackedArea({ frames, times, ceiling, hidden, scope, snapIndex = null, deep = null, loads = [] }: { frames: Band[][]; times: number[]; ceiling: number; hidden: Set<string>; scope: string; snapIndex?: number | null; deep?: { model: string; ceiling: number } | null; loads?: { t: number; until?: number }[] }) {
    const order = useMemo(() => bandOrder(frames), [frames]);
    const identity = useMemo(() => bandIdentity(frames), [frames]);
    const tint = useMemo(() => bandTint(frames), [frames]);
    if (frames.length < 2 || ceiling <= 0) return <svg class="rc-area" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" />;
    // LINEAR IN TIME across the run (`runFrac`), the axis every other mapping on the chart uses.
    const tr = times.map((t) => ({ t }));
    const x = (i: number) => runFrac(tr, times[i]) * W;
    const y = (v: number) => H - Math.min(1, v / ceiling) * H;
    /** One edge as points, left to right, against a given vertical mapping. A stepped edge emits the corner
     *  first: hold the previous value up to this sample's x, then drop to this sample's. Reversing the list
     *  retraces the same shape, which is how a floor is drawn without a second implementation that could
     *  disagree with this one.
     *
     *  Defined HERE, above the drilled-in branch, because every polygon in this component needs it and that
     *  branch returns early: the band edges, the hover breakdown AND the drilled-in parts. It was first written
     *  for the bands alone, so a band stepped while the parts drawn INSIDE it still sloped — a flat band with
     *  diagonal lines across it, which reads as the breakdown disagreeing with the total it breaks down. The
     *  y-mapper is a parameter because the drilled-in view draws against its OWN shared ceiling. (After `x`/`y`,
     *  never before: a closure here running ahead of those consts is the TDZ crash this function has had once.) */
    const stepEdge = (series: number[], stepped: boolean, yOf: (v: number) => number): string[] => {
        const out: string[] = [];
        for (let i = 0; i < frames.length; i++) {
            if (stepped && i > 0) out.push(`${x(i).toFixed(1)},${yOf(series[i - 1] ?? 0).toFixed(1)}`);
            out.push(`${x(i).toFixed(1)},${yOf(series[i] ?? 0).toFixed(1)}`);
        }
        return out;
    };
    const zeros = new Array<number>(frames.length).fill(0);
    /**
     * DRILLED IN: ONE MODEL, FROM THE BASELINE, ON A SHARED SCALE.
     *
     * A model is usually a few percent of a card — 6.8% in the case that prompted this — so its decomposition
     * is drawn into three pixels and the parts are a rumour. Here the track stops being "how full is this
     * pool" and becomes "what is this model holding, over time, on this card": the band lifts to the baseline
     * and everything else drops away, which is also the reading a CHART is uniquely good at, since weights
     * sit still while the cache steps with the context.
     *
     * THE SCALE IS SHARED ACROSS THE CARDS, and that is the part that must not be got wrong. Scaling each
     * track to its own contents would draw a card holding 1,991 MiB and one holding 878 MiB at the SAME
     * height — the pro-rating mistake in a different costume, in the one mode built to show that the cards
     * hold different amounts. `deep.ceiling` is the largest of them over the window, computed identically by
     * every track from the samples they all share, so no cross-track plumbing can get it out of step.
     */
    if (deep) {
        const dy = (v: number) => H - (v / Math.max(1, deep.ceiling)) * H;
        const seen = new Set<keyof MemoryBreakdown>();
        for (const bands of frames) {
            const p = bands.find((b) => b.model === deep.model)?.parts;
            if (p) for (const q of memoryParts(p)) seen.add(q.key);
        }
        const keys = MEMORY_PARTS.filter((k) => seen.has(k.key));
        // MEMORY ARRIVING FOR THIS MODEL BEFORE IT IS ATTRIBUTED — the allocation curve of a load in flight
        // (`pendingAllocation`), which otherwise vanished from exactly the view a reader drilled into to see it.
        const pending = pendingAllocation(frames, times, deep.model, loads).map((v) => Math.min(v, deep.ceiling));
        const anyPending = pending.some((v) => v > 0);
        if (!keys.length && !anyPending) return <svg class="rc-area" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" />;
        const tops = keys.map(() => new Array<number>(frames.length).fill(0));
        /**
         * A FRAME THE SERVER COULD NOT SPLIT IS NOT AN EMPTY ONE.
         *
         * `memory` is omitted whenever the server cannot divide the figure — a loading row, an MLX runner, a
         * build predating the field — and stacking nothing for those frames drops the area to ZERO, which
         * says the model was not resident. It was: we know its total, we do not know its composition, and
         * those are different absences. Drawn as an undifferentiated area at its real height instead, so the
         * trace stays continuous and only the SUBDIVISION goes missing where it is missing.
         *
         * Told apart from a frame where the model is genuinely absent by whether a BAND exists at all — no
         * band means it is not on this card at that instant, which really is zero.
         */
        const unsplit = new Array<number>(frames.length).fill(0);
        frames.forEach((bands, i) => {
            const b = bands.find((x2) => x2.model === deep.model);
            const p = b?.parts;
            let acc = 0;
            keys.forEach((part, pi) => { if (p) acc += p[part.key]; tops[pi][i] = acc; });
            unsplit[i] = !p && b ? b.bytes : 0;
        });
        const anyUnsplit = unsplit.some((v) => v > 0);
        return (
            <svg class="rc-area" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
                {/* LINES, not steps: memory really does arrive progressively while a load lands (the server calls
                    it a continuous progress signal), the same reason the device's own bands are lines. Faint and
                    dashed along its top, in the model's colour, because it is the model's load but not yet
                    anything the server has said the model holds. */}
                {anyPending ? (
                    <polygon key="d:pending" class="rc-part rc-part-pending" vector-effect="non-scaling-stroke"
                        points={[...stepEdge(pending, false, dy), ...stepEdge(zeros, false, dy).reverse()].join(" ")}
                        fill={partFill(deep.model, "other")} style={{ "--model": colorFor(deep.model) }} />
                ) : null}
                {anyUnsplit ? (() => {
                    // ONE shape for the whole stretch, at the model's own height, in its own colour but
                    // deliberately flat and faint with a dashed top: it must not read as a part, because
                    // which part it is is precisely what is not known.
                    const pts: string[] = [];
                    pts.push(...stepEdge(unsplit, true, dy), ...stepEdge(zeros, true, dy).reverse());
                    return <polygon key="d:unsplit" points={pts.join(" ")} class="rc-part rc-part-unsplit"
                        fill={partFill(deep.model, "other")} vector-effect="non-scaling-stroke" />;
                })() : null}
                {keys.map((part, pi) => {
                    const pts: string[] = [];
                    // ONE model's memory, all of it piecewise-constant, so every part edge steps — a part's floor included,
                    // since it is the part beneath it (or the baseline) and must match that edge exactly.
                    pts.push(...stepEdge(tops[pi], true, dy), ...stepEdge(pi === 0 ? zeros : tops[pi - 1], true, dy).reverse());
                    return <polygon key={`d:${part.key}`} points={pts.join(" ")} class={`rc-part rc-part-${part.key}`}
                        fill={partFill(deep.model, part.key)} vector-effect="non-scaling-stroke" />;
                })}
            </svg>
        );
    }

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

    /**
     * A MODEL'S MEMORY IS PIECEWISE-CONSTANT, SO ITS EDGE IS A STEP.
     *
     * A resident model does not drift: the runner appears holding its whole footprint, and the KV cache is
     * preallocated for the FULL context window at load and never grows — verified on the box, byte-identical
     * before and after 4,217 tokens went through it. So a straight line between two samples was drawing a
     * decay that cannot happen, and on an eviction it drew the worst version of it: samples 14 seconds apart
     * (the stream's idle cadence) with the model resident at one end and gone at the other, rendered as
     * fourteen seconds of memory gently draining away. The `unload` edge sits at the true instant, so the
     * dashed rule and the descent disagreed by up to a whole sample interval, which reads as the lane being
     * misaligned with the chart rather than as the chart interpolating.
     *
     * Held at its last measured value and dropped where the next reading says, the descent lands on the
     * sample that reported it — 2 ms after the edge in the capture that prompted this — so the two agree
     * without either being moved to suit the other.
     *
     * THE DEVICE'S OWN BANDS STAY LINES, and that difference is the point rather than an inconsistency. A
     * card's free memory really does fall progressively while weights land — the server describes it as a
     * continuous progress signal during the long half of a load — so stepping it would be the same error
     * pointed the other way. A band is drawn stepped when its top is a MODEL's, which is what `identity`
     * already answers for the fill.
     *
     * Adjacent bands SHARE an edge (this band's floor is the one below's ceiling), so the floor is drawn with
     * the step-ness of the band BELOW, never its own. Get that wrong and the two disagree by a step's height
     * and the stack opens a seam. It also means a residual sitting on models is exactly right: its base jumps
     * when a model goes, while its own thickness still varies smoothly.
     */
    // A RESIDUAL THAT BELONGS TO A MODEL steps with it: a runner's overhead (`ctx:`) and a runner `/api/ps` has not
    // caught up with (`runner:`) are that runner's memory, piecewise-constant like the model's, and they leave at
    // the same eviction. Drawn as lines, the overhead stacked on a stepped model sloped from the last sample to
    // the next — a `\\` wedge beside the model's `|` at every eviction. A LOADING runner (`load:`) stays a line:
    // its memory really does climb as the weights land, which is the device-band rule, not the model one.
    //
    // AND ONLY ON A STEPPED STACK. Cumulative tops are what the edges draw, so a band's floor is the top of the band
    // below. A stepped band holds its previous top until the next sample; stacked on a band drawn as a LINE (a
    // loading runner, climbing) its floor rose with that line while its top waited — for that stretch the floor
    // was above the top, and the inverted polygon filled as a wedge in the wrong colour. So step-ness runs up from
    // the bottom and stops at the first band that is a line: models and their overhead sit at the bottom and keep
    // stepping, and whatever is stacked on a climbing load is drawn as a line with it.
    const stepKeys = stepBands(order, identity, tint);
    const isStep = (k: string | null): boolean => !!k && stepKeys.has(k);
    /**
     * A LINE BAND RIDES ON THE STEPS BELOW IT. Above the stepped run, a band's top is the stepped BASE (the top of
     * the highest stepped band, held until the next sample) plus the band's own thickness above it, interpolated —
     * so it turns the same corner the steps turn and only its thickness varies smoothly. Interpolating the
     * CUMULATIVE top instead climbed toward a model's arrival before it happened (a pale wedge just ahead of each
     * step up) and fell below its floor at an eviction (an inverted one) — "its base jumps, its thickness varies
     * smoothly" was the stated rule, and the edge did not implement it.
     */
    const baseKey = [...stepKeys].at(-1) ?? null;
    const base = baseKey ? (tops[baseKey] || zeros) : zeros;
    const edgeOf = (k: string | null): string[] =>
        bandEdge(k ? (tops[k] || zeros) : zeros, isStep(k), k && !isStep(k) && baseKey ? base : null)
            .map(([i, v]) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    const areas = order.filter((k) => k !== "free").map((key, ki, keys) => {
        const below = ki === 0 ? null : keys[ki - 1];
        const pts: string[] = [...edgeOf(key), ...edgeOf(below).reverse()];
        // The band knows which model it is, so hovering it can name it — and dim its neighbours, so a stack of
        // similar colours resolves into one identifiable shape.
        const model = identity[key];
        const dim = hoverModel.value && model && hoverModel.value !== model;
        const hot = !!model && hoverModel.value === model;
        return <polygon key={key} points={pts.join(" ")} fill={bandFill(key, model, tint[key])}
            class={model ? `rc-band${hot ? " hot" : ""}` : undefined} vector-effect="non-scaling-stroke"
            onPointerEnter={model ? (e: PointerEvent) => {
                // THE KEYBOARD OWNS THE FOCUS while it has one. This fires without the reader touching
                // anything whenever a band moves under a parked pointer, so honouring it here would let an
                // arriving sample overwrite a selection the keys had just made. `trackCursor` still runs —
                // the tip has to follow the cursor either way — and it is what releases the focus, on a real
                // move rather than on a boundary event.
                if (!kbFocus.value) hoverModel.value = model;
                trackCursor(scope)(e);
            } : undefined}
            onPointerLeave={model ? () => { if (!kbFocus.value) { hoverModel.value = null; hoverAt.value = null; } } : undefined}
            opacity={dim ? 0.18 : key === "other" ? 0.35 : model ? 0.75 : 0.55} />;
    });

    /**
     * THE HOVERED MODEL'S BAND, SUBDIVIDED IN PLACE.
     *
     * `size_vram` alone cannot tell a big MODEL from a big CONTEXT — lots of weights with a small cache, and
     * modest weights with an enormous one, are the same number and want opposite responses. The server splits
     * it now, so hovering decomposes the area you are already looking at rather than opening a second picture
     * of the same memory somewhere else. Which also shows the part a chart is uniquely good at: weights sit
     * still while the cache steps with the context, and that is visible over TIME and nowhere in a total.
     *
     * Drawn OVER the solid band rather than instead of it, so a frame the server could not split (a loading
     * row, an MLX runner, a sample from before the field existed) simply shows the band it always had — the
     * parts collapse to zero height there instead of the whole decomposition vanishing or, worse, stretching
     * a neighbouring frame's shares across a gap it never measured.
     */
    const split = (() => {
        const model = hoverModel.value;
        if (!model) return null;
        const key = order.find((k) => identity[k] === model && k !== "free");
        if (!key || hidden.has(model)) return null;
        const ki = order.filter((k) => k !== "free").indexOf(key);
        if (ki < 0) return null;
        const belowKey = ki === 0 ? null : order.filter((k) => k !== "free")[ki - 1];
        // The parts present in ANY frame, in stack order, so a slice does not appear and disappear as the
        // window scrolls over the moment a projector was allocated.
        const seen = new Set<keyof MemoryBreakdown>();
        for (const bands of frames) {
            const p = bands.find((b) => b.key === key)?.parts;
            if (p) for (const q of memoryParts(p)) seen.add(q.key);
        }
        if (!seen.size) return null;
        const keys = MEMORY_PARTS.filter((p) => seen.has(p.key));
        const base = frames.map((_f, i) => (belowKey ? (tops[belowKey]?.[i] ?? 0) : 0));
        // Cumulative sub-tops, one row per part.
        const subTops = keys.map(() => new Array<number>(frames.length).fill(0));
        frames.forEach((bands, i) => {
            const p = bands.find((b) => b.key === key)?.parts;
            let acc = base[i];
            keys.forEach((part, pi) => {
                if (p) acc += p[part.key];
                subTops[pi][i] = acc;   // no parts → every sub-top is the base, so nothing is drawn here
            });
        });
        return keys.map((part, pi) => {
            const pts: string[] = [];
            // Every part is this model's, so every top steps. The FIRST part's floor is the band beneath the model and
            // takes THAT band's step-ness: it is the same edge the model's own band sits on, and two renderings of one
            // edge that disagree open a seam between the parts and the band.
            pts.push(...stepEdge(subTops[pi], true, y), ...stepEdge(pi === 0 ? base : subTops[pi - 1], pi === 0 ? isStep(belowKey) : true, y).reverse());
            return <polygon key={`p:${part.key}`} points={pts.join(" ")} class={`rc-part rc-part-${part.key}`}
                fill={partFill(model, part.key)} vector-effect="non-scaling-stroke" />;
        });
    })();
    /**
     * THE DATAPOINT, ON THE LINES IT IS A POINT OF.
     *
     * The dot used to ride at the POINTER's height on the argument that a stacked area has many values at one
     * x and so no single y to choose. That was wrong twice over: the lines ARE there — they are the band
     * boundaries the chart already draws — and a mark that tracks the cursor vertically is not a datapoint at
     * all, it is the cursor with a circle on it. Marking every boundary is what "where does this sample sit"
     * actually means in a stack, and it is exactly what `tops` already holds.
     *
     * The FREE band is excluded: its boundary is the ceiling, which is a constant and not a reading.
     */
    const dots = (() => {
        if (snapIndex == null || snapIndex < 0 || snapIndex >= frames.length) return null;
        // HOVERING ONE BAND narrows this to that band alone. Every boundary marked is an OVERVIEW — right
        // when the pointer is on the plot's background and nothing is picked out — but once a band is
        // hovered the panel has already dimmed its neighbours to say "this one", and a full set of dots
        // contradicts that by marking the things it just faded.
        const focus = hoverModel.value;
        const keys = order.filter((k) => k !== "free")
            .filter((k) => !focus || identity[k] === focus);
        const seen = new Set<number>();
        return keys.map((key) => {
            const v = tops[key]?.[snapIndex];
            if (v == null) return null;
            const cy = y(v);
            // Two boundaries at the same height are one line on screen, and two dots on it read as a
            // rendering fault rather than as two bands that happen to meet.
            const at = Math.round(cy * 10);
            if (seen.has(at)) return null;
            seen.add(at);
            // THE MARK CARRIES THE MODEL'S COLOUR, the way the overlaid view's marks carry their pool's. A
            // model's colour is its identity across the whole panel — the band, the row, its blocks in the
            // lane — so a mark sitting ON that band in the panel's accent said "a reading" where every other
            // surface says "this model", and with several boundaries marked at once there was nothing to tell
            // them apart. Read from `identity`, which is what `bandFill` colours the band from, so the mark
            // and the thing it is marking cannot disagree.
            //
            // A boundary with NO model keeps the accent rather than taking `bandFill`'s grey: driver overhead
            // and the unattributed residual are drawn in `--fg-faint`, and a faint grey mark on a faint grey
            // band is a mark you cannot find. Blue there is not a fallback, it is "a reading, of nothing named".
            const model = identity[key];
            // HTML, not an SVG <circle>: the viewBox is stretched with `preserveAspectRatio="none"`, so a
            // circle inside it draws as an ELLIPSE whose eccentricity depends on the plot's current size.
            // Percentages of the same box put it in exactly the same place and keep it round.
            return <i key={`d:${key}`} class="rc-snapdot" aria-hidden="true"
                style={{ left: `${(x(snapIndex) / W) * 100}%`, top: `${(cy / H) * 100}%`,
                         ...(model ? { background: colorFor(model) } : {}) }} />;
        });
    })();
    return (
        <>
            <svg class="rc-area" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
                {areas}
                {split}
            </svg>
            {dots}
        </>
    );
}

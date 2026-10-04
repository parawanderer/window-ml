// resource-tips.tsx — the tooltips that READ the resource plot: the sample stamp, a band's breakdown, the pool and
// utilization rows, a model's holdings and layer placement, and what a gap between two runs means.
//
// Each answers "what is under the pointer" for one kind of surface; which surface owns the pointer is decided in
// chart-interaction (`cursorOn`), so a tip here never has to know about the others.

import { useLayoutEffect } from "preact/hooks";
import { sampleAtFraction } from "../resource-axis";
import { type Band, OUTSIDE_VIEW_LABEL } from "../resource-bands";
import { type ResourceSample, type MemoryBreakdown, memoryParts, formatBytes, percentOf, type LayerPlacement, layersOnCard } from "../resource-model";
import { type DeviceCapacity } from "../resource-capacity";
import { cursorOn, live, poolHover, gapHover, cursorAt, eventHover } from "./chart-interaction";
import { partFill, bandFill } from "./chart-paint";
import { ModelFacts, CostFacts } from "./panel-facts";
import { sampleGraceMs, colorFor, hiddenPools, poolFacts, keysReach } from "./panel-state";
import { crosshair, loadedModels } from "./store";
import { hhmmssms, fmtAge, fmtDur, hhmmss } from "./timestamps";
import { tileOffsets } from "./tip";
import { useTipPlacement } from "./use-tip";
import { kbFocus, hoverModel, focusDepth } from "./vram-focus";

/** The sample under the pointer, or null when the pointer is not over this plot. The fraction comes from the
 *  crosshair — one pointermove sets both — so a tooltip can never name a different datapoint than the line
 *  the crosshair is drawn at, which is the drift you get from measuring the pointer twice. */
export function hoveredSample(runs: ResourceSample[][], scope: string): ResourceSample | null {
    const c = crosshair.value;
    if (!c) return null;
    // EVERY TRACK RESOLVES ONE WHEN THE KEYBOARD HAS THE FOCUS. Normally only the surface the pointer is on
    // reads a datapoint — a tooltip per track under one cursor is four answers to a question asked once. But
    // a keyboard focus is not asked at a position: it names a MODEL, and a model split across cards is on
    // several tracks at once, each holding different things (compute is flat per device, so one card's
    // breakdown genuinely does not describe the other). Reading only the pointed-at track would show one
    // half of a split and silently omit the rest.
    if (!kbFocus.value?.model && !cursorOn(scope)) return null;
    return sampleAtFraction(runs, c.frac, live.axis, sampleGraceMs());
}

/** WHEN the figures above were measured. A tooltip that reads a historical datapoint has to say which one,
 *  or every reading in it is ambiguous between "now" and "some time back". Nothing is shown when the pointer
 *  is not over the plotted area (a legend key), because there is no datapoint to stamp — inventing "now"
 *  there would be the same wrong claim from the other direction. */
function SampleStamp({ at }: { at: ResourceSample | null }) {
    if (!at) return null;
    const ago = Math.max(0, Date.now() - at.t);
    return (
        <div class="rc-tip-line rc-tip-when">
            {/* TO THE MILLISECOND. Samples land ~250ms apart during a load and the interesting ones are
                consecutive — two readings a quarter-second apart both stamped "19:21:40" cannot be told
                apart, which is exactly the stretch you hover when something looks wrong. */}
            <span>{hhmmssms(at.t)}</span>
            {/* "how long ago" is what makes a clock time mean something at a glance on a plot with no axis
                labels; the clock time is what makes it comparable with the transcript and the event lane. */}
            <span class="rc-tip-ago">{ago < 1500 ? "now" : `${fmtAge(ago)} ago`}</span>
        </div>
    );
}

/**
 * WHAT THIS MODEL'S MEMORY IS HOLDING, on THIS card.
 *
 * `size_vram` alone cannot tell a big MODEL from a big CONTEXT — lots of weights with a small cache, and
 * modest weights with an enormous one, are the same number and want opposite responses (a smaller quant, or
 * less context). This is the answer, and it is drawn as ROWS rather than as a second chart because the chart
 * is already showing it: the swatches are the exact fills the band is subdivided with, so the tip and the
 * plot are one picture rather than two pictures of the same memory.
 *
 * PER CARD, and that is not a detail. `gpus[].memory` sums to that entry's own `size_vram` exactly, so each
 * card's figures are MEASUREMENTS — while a whole-model split divided by a layer or byte ratio would be
 * right about weights and cache and quietly wrong about `compute`, which is FLAT PER DEVICE (measured: 31
 * layers against 10, and both cards holding 115 MiB of it).
 *
 * NO TOTAL ROW. The parts sum to `size_vram` to the byte, and that figure is already two lines above — a
 * total would print the same number twice, and the panel refuses a split that does not add up rather than
 * padding one with a remainder.
 */
function HoldingRows({ model, parts }: { model: string; parts: MemoryBreakdown }) {
    const rows = memoryParts(parts);
    const total = rows.reduce((n, r) => n + r.bytes, 0);
    if (!rows.length || total <= 0) return null;
    return (
        <>
            <div class="rc-tip-line rc-tip-sec">holding</div>
            {rows.map((r) => (
                <div class={`rc-tip-line rc-tip-part${r.key === "other" ? " odd" : ""}`} key={r.key}>
                    <i class="rc-tip-dot" style={{ background: partFill(model, r.key) }} />
                    <span class="rc-tip-plabel">{r.label}</span>
                    <span class="rc-tip-pbytes">{formatBytes(r.bytes)}</span>
                    <span class="rc-tip-ppct">{percentOf(r.bytes, total)}</span>
                </div>
            ))}
            {/* `other` IS THE SIGNAL, not a slice. It is what the server could not name, so it means the
                breakdown is behind the engine — the one part whose SIZE is the message. Called out rather
                than left to sit quietly in the list, and only when it is big enough to matter: a rounding
                crumb under a percent is not news. */}
            {parts.other > 0 && parts.other / total >= 0.01 ? (
                <div class="rc-tip-line rc-tip-dim rc-tip-warn">the server could not name this part — its
                    breakdown is behind the engine it is reporting on</div>
            ) : null}
        </>
    );
}

/**
 * KEEP THE KEYBOARD TIPS FROM SITTING ON EACH OTHER — by TILING them, not by dodging.
 *
 * Each of these is anchored to the track whose reading it is, which is what makes a split model's two answers
 * legible as belonging to two cards. But a drilled-in tip is taller than the ~110px track it belongs to, so
 * the second one landed on the first. The first fix put them on alternating SIDES, which stopped them
 * colliding with each other and did nothing about the plot underneath — and it broke the correspondence,
 * since which side a tip sat on then said nothing about which track it was for.
 *
 * So they are laid out in a column instead: each one wants to start at its own track's top, and is pushed
 * down only as far as the one above it requires. ORDER IS PRESERVED, which is what carries the meaning — the
 * top tip is the top track's — and a track with no tip leaves a real gap, because the next tip's preferred
 * position is still its own track's top and nothing pushed it up.
 *
 * ONLY WHEN THEY WOULD ACTUALLY OVERLAP, which is a question about both axes and was once asked about one.
 * A custom layout puts two cards SIDE BY SIDE, and the right-hand tip was then pushed a full tip's height down
 * the window for sharing a top edge with a tip it covered nothing of, its own track's corner still empty. The
 * arithmetic is `tileOffsets` (tip.ts), where it is pure and has the cases as tests; here it is only measured
 * and applied.
 *
 * Done imperatively after layout because it is a measurement: how tall a tip is depends on how many parts the
 * server reported, which nothing knows until it is drawn. Idempotent — it resets each transform before
 * measuring — so every tip may safely run it.
 */
function tileKbTips(root: Document | null): void {
    if (!root) return;
    // DOM ORDER IS TRACK ORDER: the tips are rendered inside their tracks, top to bottom.
    const els = Array.from(root.querySelectorAll(".rc-tip-kb")) as HTMLElement[];
    // SAID ONCE, AT THE BOTTOM. The instant being read and the keys that move the reading are facts about the
    // READING, not about a card — so a split model repeating both on every tip is the same two lines two or
    // three times, in the one view where height is what everything is competing for. Trimming them is what
    // takes a stack of tips from taller than its tracks to shorter, which is the difference between a tip
    // beside the trace it describes and a tip on top of it. Marked before measuring, or the layout below
    // would be computed from heights that are about to change.
    els.forEach((el, i) => el.classList.toggle("dup", i < els.length - 1));
    const view = root.defaultView;
    const vw = view?.innerWidth ?? Infinity, vh = view?.innerHeight ?? Infinity;
    for (const el of els) {
        el.style.transform = "";
        // WHERE IT WANTS TO BE: the top corner of its own track, on the side away from the crosshair. Measured, since
        // the tip is `position: fixed` — inside the plot it was clipped by the plot (see the CSS).
        const plot = el.parentElement?.closest(".rc-plot") ?? el.parentElement;
        const a = plot?.getBoundingClientRect();
        if (a) {
            const w = el.offsetWidth;
            const left = el.classList.contains("right") ? a.right - PLOT_TIP_INSET - w : a.left + PLOT_TIP_INSET;
            el.style.left = `${Math.max(4, Math.min(left, vw - w - 4))}px`;
            el.style.top = `${a.top + PLOT_TIP_INSET}px`;
        }
    }
    // Measured in one pass BEFORE any of them moves: reading a box after writing a transform would force a
    // reflow per tip, and the arithmetic wants every tip's wanted position anyway, not a running total.
    const rects = els.map((el) => el.getBoundingClientRect())
        .map((r) => ({ left: r.left, right: r.right, top: r.top, height: r.height }));
    tileOffsets(rects, vh).forEach((dy, i) => { if (dy) els[i].style.transform = `translateY(${dy}px)`; });
}

/** How far a keyboard-read tip sits inside its track's corner. */
const PLOT_TIP_INSET = 3;

/**
 * WHICH LAYERS THIS CARD IS HOLDING.
 *
 * Its OWN section with its OWN units, never a bar beside the memory ones: layers are NOT a proxy for memory
 * and must not share a scale. On an even split of `granite4.1:3b` one card held MORE layers and LESS weight —
 * the output layer is large and carries no KV — so a layers bar and a memory bar drawn together would
 * disagree, correctly, and read as a bug.
 *
 * MATCHED BY NAME, and unmatched means UNKNOWN. `device` is the ENGINE's name (`"CUDA0"`), not the ollama
 * `gpu_id`; they are different fields and a filtered-device host can make them disagree, so a card whose name
 * is not in the list simply shows nothing rather than being handed the entry that happens to sit at its
 * ordinal. `devices` is a list of RUNS rather than one entry per card, so they are summed.
 */
function LayerRows({ placement, device, cardId }: { placement: LayerPlacement; device: string; cardId?: string }) {
    const mine = layersOnCard(placement, { id: cardId, name: device });
    if (!mine.length) return null;
    const held = mine.reduce((n, d) => n + d.layers, 0);
    const span = mine.map((d) => `#${d.firstLayer}\u2013${d.lastLayer}`).join(", ");
    const swa = placement.swaLayers.filter((n) => mine.some((d) => n >= d.firstLayer && n <= d.lastLayer)).length;
    return (
        <>
            <div class="rc-tip-line rc-tip-sec">layers</div>
            {/* Its OWN class, sharing the parts' layout but not their identity: a layer count is not a
                memory part, and anything counting the parts must not pick this up as a seventh one. */}
            <div class="rc-tip-line rc-tip-part rc-tip-lrow">
                <span class="rc-tip-plabel">{held} of {placement.numLayers}</span>
                <span class="rc-tip-pbytes">{span}</span>
            </div>
            {/* A LIST, not a count, upstream — the pattern is irregular (gemma2 alternates 1:1, gemma4:31b is
                50 of 61), so this counts the ones that landed on THIS card rather than repeating a total. */}
            {swa ? <div class="rc-tip-line rc-tip-dim">{swa} sliding-window</div> : null}
        </>
    );
}

/** What the hovered band is, shown over the plot. Deliberately the SAME facts as the legend row (ModelFacts),
 *  because a band and its row describe one model — an SVG <title> could carry none of it: no colour, no live
 *  TTL, no badge, and a half-second delay before it appears. */
export function BandTip({ bands, frame, history, samples, ceiling, scope, label, cardId, hidden, at: hoverSample }: { bands: Band[]; frame: Band[] | null; history: Band[][]; samples: ResourceSample[]; ceiling: number; scope: string; label?: string; cardId?: string; hidden: Set<string>; at: ResourceSample | null }) {
    const name = hoverModel.value;
    // ANCHORED TO THE TRACK, not to the cursor, whenever the keyboard owns the focus. Two reasons, and the
    // second is the one that forces it: a reader who is not moving the mouse does not want an answer that
    // moves; and a split model shows a tip on EVERY card it is on, which under one cursor would be two
    // tooltips stacked on the same few pixels.
    const kb = kbFocus.value?.model ? kbFocus.value : null;
    const at = cursorOn(scope);
    if (!name || (!kb && !at)) return null;
    // NOTHING TO DESCRIBE once a model is switched off: it is out of the stack and out of the totals, so a
    // tip naming it would be a reading of a shape that is not on the chart.
    if (hidden.has(name)) return null;
    // READ THE DATAPOINT UNDER THE CURSOR, not the newest one. The chart is a history, so the shape being
    // hovered is a measurement from some earlier instant — often of a model that has since evicted, and
    // almost always of a different figure than the model holds now. Answering with the current value would
    // put a number in the tooltip that was never true at the place the pointer is.
    const band = (frame ?? bands).find((b) => b.model === name && b.bytes > 0)
        // Nothing at this instant: the pointer is over the model's shape in a neighbouring column, or the
        // hover fell in a gap. The last frame that held it still answers what the colour IS, rather than
        // leaving a coloured area on the chart with nothing below it to explain it.
        ?? [...history].reverse().flatMap((f) => f.filter((b) => b.model === name && b.bytes > 0)).at(0);
    if (!band) return null;   // hovering a model that isn't on THIS device — its own track shows the tip
    const m = (loadedModels.value || []).find((x) => x.model === name);
    const deep = !!kb && focusDepth() > 0;
    /**
     * THE WHOLE MODEL, found the SAME WAY ITS BAND IS.
     *
     * `perDevice` names every card it is on, so the card count is measured rather than inferred from how many
     * tracks happen to be drawn. But it has to be read from the same instant the band came from: the band
     * lookup already falls back to the last frame that held this model (the pointer is often parked on a
     * stretch from before it loaded), and reading the TOTAL from the hovered sample alone meant the tip drew
     * a band from one instant and looked for its size at another — found nothing, and silently printed
     * nothing. A split model's tips then named no total at all, which is the one figure a per-card reading
     * cannot supply.
     */
    const resAt = (sm: ResourceSample | null) => sm?.models.find((x) => x.model === name);
    let res = resAt(hoverSample);
    for (let i = samples.length - 1; i >= 0 && !res; i--) res = resAt(samples[i]);
    const across = res ? { bytes: res.vramBytes, cards: Object.values(res.perDevice).filter((v) => (v ?? 0) > 0).length } : null;
    // WHICH SIDE. One tip goes wherever the crosshair is not, which is all that matters when there is one.
    // Several — a split model puts one on every card — must not stack, and they are only ~110px of track
    // apart while a drilled-in tip is taller than that, so they alternate instead. Measured before it was
    // fixed: the first tip's last row sat underneath the second tip's header.
    // Away from the mark rather than over it: the crosshair is what the reading belongs to. ALL of them on
    // the same side — several tips are kept apart by tiling them down the column (see tileKbTips), which
    // preserves the correspondence with the tracks that alternating sides destroyed.
    const side = (crosshair.value?.frac ?? 0) < 0.5 ? " right" : " left";
    // Follows the cursor, offset up-left so it never sits under the pointer (which would flicker as the
    // pointer enters the tip itself) and clamped inside the plot so it can't run off the narrow panel.
    const { ref, style } = useTipPlacement(kb ? null : at);
    // AFTER EVERY RENDER, because what decides the layout is how TALL these turned out — which depends on how
    // many parts the server reported and is not knowable until they are drawn. Every tip runs it and the pass
    // is idempotent, so no coordinator has to know how many there are.
    useLayoutEffect(() => { tileKbTips(ref.current?.ownerDocument ?? null); });
    return (
        // A STACK, not a row: name, then the figure, then the badges. On one line the name and the figure set
        // the tip's width and every shorter line left a slab of empty space beside it.
        <div class={`rc-tip rc-tip-model${kb ? ` rc-tip-kb${side}` : ""}`} role="tooltip" ref={ref} style={style}>
            <div class="rc-tip-line"><i class="rc-tip-dot" style={{ background: colorFor(name) }} />
                <span class="rc-tip-name">{name}</span>
                {/* WHICH CARD, once you are reading one card's contents. A split model shows one of these per
                    track and their figures differ on purpose, so a tip that did not name its own device
                    would be two unlabelled answers to the same question. */}
                {deep && label ? <span class="rc-tip-of rc-tip-onwhat">on {label}</span> : null}</div>
            {/* Bytes AND the share of this device — a model is "big" only relative to the card it is on. */}
            <div class="rc-tip-line"><span class="rc-tip-size">{formatBytes(band.bytes)} <span class="rc-tip-pct">({percentOf(band.bytes, ceiling)})</span></span></div>
            {/* THE DENOMINATOR, dimmed and on its own row — the same line the pool tip carries, because the
                percentage above is a share of THIS pool and a share with no denominator on screen is the one
                figure a reader has to go and find. Dimmed because it is a CONSTANT: it does not change as
                you move along the trace, so it is the number that should recede rather than be read first.
                On the same line it competed with the reading for one glance. */}
            {/* The CARD's denominator, and only while the card is the subject. Drilled in it is not — the
                question became "what is this model holding", the rows below answer it as shares of the model,
                and a second denominator in the same tip is one the reader has to work out is unused. Dropping
                it also buys back a line, which is the difference between a tip that fits inside its track and
                one that covers the shape it is describing. */}
            {!deep ? <div class="rc-tip-line rc-tip-of">out of {formatBytes(ceiling)}</div> : null}
            {/* HOW BIG THE MODEL IS, when this card holds only part of it — the per-card figure above cannot
                answer that, and on a split it is the first thing you want. Only when it IS split: on one card
                the card's figure IS the total, and printing it twice is the same noise as a total row under
                the parts. Read from the SAMPLE rather than from what is resident now, so the whole tip stays
                a reading of one instant. */}
            {/* HOW BIG THE MODEL IS, on EVERY card's tip. A split model's per-card figure answers "how much of
                this card" and cannot answer "how big is this thing" — and 1.94 GiB beside 878 MiB, each under
                its own denominator, invites the reader to take either one for the model. So both tips carry
                the whole, and say what share of it this card is holding, which is the relationship between
                the two numbers rather than a third number to reconcile. Only when it IS split: on one card
                the card's figure IS the total, and printing it twice is the noise a total row would be. */}
            {across && across.cards > 1
                ? <div class="rc-tip-line rc-tip-of">{formatBytes(across.bytes)} across {across.cards} cards
                    <span class="rc-tip-here">{percentOf(band.bytes, across.bytes)} here</span></div>
                : null}
            {deep && band.parts ? <HoldingRows model={name} parts={band.parts} /> : null}
            {deep && res?.placement && label ? <LayerRows placement={res.placement} device={label} cardId={cardId} /> : null}
            {deep && !band.parts
                // ABSENT IS NOT ZERO. A loading row, an MLX runner, or a build predating the field reports no
                // split at all — and an empty decomposition would read as "it is holding nothing".
                ? <div class="rc-tip-line rc-tip-dim">the server did not report what this is holding</div>
                : null}
            <SampleStamp at={hoverSample} />
            {/* NO "not resident now" HERE, and none on the consumer rows either. This tooltip reads a sample
                from the PAST: it answers what was on this card at that instant, the stamp above says which
                instant, and at that instant the model WAS there. Annotating it with what happened afterwards
                answers a question nobody asked at the place they asked it. It was here to explain why a
                colour was still on the chart with no row under it — which the model list's GHOST rows now do,
                where "is it resident" is actually the question being asked. */}
            {/* Badges and cost each break onto their OWN line. On one line the tip grew past the panel and was
                clipped at the window edge — and the figure that matters (how much, what share) is the part
                that got cut. */}
            {m && !deep ? <div class="rc-tip-facts"><ModelFacts m={m} tips={false} /></div> : null}
            {!deep ? <CostFacts model={name} /> : null}
            {/* WHAT THE KEYS DO, and only while the keys are what is driving. A hint under a tip the pointer
                summoned would advertise a mode at the one moment the reader is already in another one. */}
            {/* WHENEVER A TIP IS UP, not only once the keys are already driving. Gating it on the keyboard
                showed the affordance exclusively to readers who had discovered it — the one group that did
                not need telling — so nobody arrived at it from the mouse, which is how everybody arrives.
                The keys work from a hover exactly as they do from a keyboard focus (see stepDepth), so the
                hint is true in both.

                And it names EVERYTHING the key reaches: "another model" was wrong, because the list wraps
                through the OVERVIEW, and a reader told half of what a key does stops pressing before finding
                the rest. */}
            <div class="rc-tip-line rc-tip-keys">
                <span><ClickFirst /><kbd>↑↓</kbd> models &amp; overview</span>
                <span>{deep ? <><kbd>←</kbd> back</> : <><kbd>→</kbd> details</>}</span>
            </div>
        </div>
    );
}

/** The whole pool's occupancy at the hovered instant — the stacked view's answer to "how full was it then",
 *  which is the reading a memory chart is hovered for most often and the one the band tips could not give
 *  (they each describe one model). Suppressed while a band IS hovered, so one pointer never opens two tips. */
export function PlotTip({ at, bands, ceiling, label, hidden, scope }: { at: ResourceSample; bands: Band[]; ceiling: number; label: string; hidden: Set<string>; scope: string }) {
    const cur = cursorOn(scope);
    if (!cur) return null;
    const { ref, style } = useTipPlacement(cur);
    // Hidden models are excluded, exactly as they are from the drawn stack and the header total: the figure
    // has to match the shape under the pointer, and hiding a model changes that shape retroactively.
    const used = bands.filter((b) => b.kind !== "free" && !(b.model && hidden.has(b.model))).reduce((n, b) => n + b.bytes, 0);
    const models = bands.filter((b) => b.kind === "model" && b.bytes > 0 && !(b.model && hidden.has(b.model)));
    return (
        <div class="rc-tip rc-tip-pool" role="tooltip" ref={ref} style={style}>
            {/* THE FIGURE FIRST, THE DENOMINATOR UNDER IT. On one line the ceiling competes with the reading
                for the same glance — and the ceiling is a CONSTANT, the one number in the tooltip that never
                changes as you move along the trace, so it is the one that should recede. Dimmed and on its
                own row it is still there to answer "of what", which is the question the panel exists to make
                unavoidable, without being read first. */}
            <div class="rc-tip-line"><span class="rc-tip-name">{label}</span>
                <span class="rc-tip-size">{formatBytes(used)} in use{percentOf(used, ceiling) ? ` (${percentOf(used, ceiling)})` : ""}</span></div>
            <div class="rc-tip-line rc-tip-of">out of {formatBytes(ceiling)}</div>
            <SampleStamp at={at} />
            {/* Named, because "62% full" invites "of what" as the immediate next question, and the answer is
                on the screen already but only in a list that shows the PRESENT. */}
            {models.length
                ? <div class="rc-tip-line rc-tip-dim rc-tip-holders">{models.map((b) => (
                    <span class="rc-tip-consumer" key={b.key}>
                        <i class="rc-tip-dot" style={{ background: colorFor(b.model!) }} />{b.model}</span>))}</div>
                // NOT "nothing resident" WHEN THE POOL IS FULL. Read off `ps`, which has no runner object
                // during a load, that put "88.28 GiB of 95.59 GiB (92%)" and "nothing resident" in the SAME
                // tooltip. The sample knows what was loading; when it does not, "not attributed" is still the
                // honest phrasing, because the memory is plainly there.
                : used > 0
                    ? <div class="rc-tip-line rc-tip-dim">{at.loading?.length
                        ? `loading ${at.loading.join(", ")} — not attributed yet`
                        : "in use, not attributed to a model"}</div>
                    : <div class="rc-tip-line rc-tip-dim">nothing resident</div>}
            {/* THE WAY IN. This is the tip you get by pointing anywhere on the plot, so it is where a reader
                who does not know the keys exist is standing — and the models it just listed are exactly what
                the key steps through. */}
            {/* THE REST OF "IN USE", named — a runner's overhead, a tenant, what ollama cannot see. Only once the
                server names processes: before that the residual is one guess, already in the legend. */}
            {bands.some((b) => b.kind === "other" && (b.key !== "other" || b.label === OUTSIDE_VIEW_LABEL))
                ? <div class="rc-tip-line rc-tip-dim rc-tip-holders">{bands.filter((b) => b.kind === "other" && b.bytes >= 1024 ** 2).map((b) => (
                    <span class="rc-tip-consumer" key={b.key}>
                        <i class="rc-tip-dot" style={{ background: bandFill(b.key, undefined, b.of) }} />{b.label} {formatBytes(b.bytes)}</span>))}</div>
                : null}
            {models.length ? <div class="rc-tip-line rc-tip-keys"><span><ClickFirst /><kbd>↑↓</kbd> pick a model</span></div> : null}
        </div>
    );
}

/** EVERY series at the datapoint under the cursor, one row each — the Grafana reading. Hovering a single line
 *  could only ever answer for the line that happened to be drawn on top: where two lines meet, the one
 *  underneath is unreachable, and that crossing is exactly the moment worth reading (one pool filling as
 *  another empties). So the plot itself opens the tip and every pool gets a row, with the nearest one marked
 *  rather than being the only one present.
 *
 *  Each row carries the pool's own swatch, its occupancy and its share — the shares are what the lines plot,
 *  since the pools have different capacities and a common axis of bytes would compare nothing. */
export function PoolsTip({ pools, latest, at: hoverSample, fracOf, usedOf, surface = "overlay", bandOf, links = [] }: {
    pools: { id: string; name: string; ceiling: number; color: string; bandsOf: (s: ResourceSample) => Band[] }[];
    latest: ResourceSample;
    at: ResourceSample | null;
    fracOf: (s: ResourceSample, p: any) => number;
    usedOf: (s: ResourceSample, p: any) => number;
    /** The surface the view tracks its pointer as — the overlaid view's, or a whole-box track's own scope. */
    surface?: string;
    /** The BRIDGES between adjacent pools, said in words — the walls in the whole-box view are visuals and do
     *  not open a tooltip of their own (a hover target inside the plot would stack a second tip on this one). */
    links?: { label: string; phrase: string; note?: string }[];
    /** Where a pool OWNS the height, as [bottom, top] fractions of the plot. The whole-box view lays pools end
     *  to end, so the pool you are pointing at is the band the pointer is inside, not the fill top nearest to
     *  it — nearest-by-line would name a neighbour whenever you point low inside a tall band. */
    bandOf?: (p: any) => [number, number];
}) {
    const cur = cursorOn(surface);
    if (!cur || !pools.length) return null;
    const frame = hoverSample ?? latest;
    const { ref, style } = useTipPlacement(cur);
    // Nearest by the pointer's height in the plot, which is where the lines are: a line at 92% is drawn near
    // the TOP, so the comparison is against 1 - frac.
    // A pool that is not drawn gets no row: the tip reads the LINES, and reporting a series that is not on
    // screen would be answering about something the reader deliberately removed.
    const rows = pools.filter((p) => !hiddenPools.value.has(p.id)).map((p) => {
        const frac = fracOf(frame, p);
        return { p, frac, used: usedOf(frame, p), dy: cur.yFrac == null ? Infinity : Math.abs((1 - frac) - cur.yFrac) };
    });
    // A DELIBERATE hover wins over proximity: pointing at a line, or at its key in the legend, says which pool
    // you mean more precisely than the pointer's height can. Height decides only when the pointer is just
    // somewhere on the plot, which is the case the stacked reading exists for.
    const inside = bandOf && cur.yFrac != null ? rows.find((r) => { const [lo, hi] = bandOf(r.p); const h = 1 - cur.yFrac!; return h >= lo && h <= hi; }) : null;
    const picked = (poolHover.value ? rows.find((r) => r.p.id === poolHover.value!.id) : null) ?? inside;
    const near = picked ?? rows.reduce((a, b) => (b.dy < a.dy ? b : a), rows[0]);
    const hasNear = !!picked || near.dy < Infinity;
    return (
        // ONE GRID, not a stack of independently-laid-out rows. Every row — a pool's and a consumer's alike —
        // places its name, its amount and its share in the SAME three columns, so the numbers line up on one
        // right edge whatever their nesting depth. Formatting each row's tail separately is what produced
        // three different right edges and two different percent styles in the same tooltip.
        <div class="rc-tip rc-tip-pools" role="tooltip" ref={ref} style={style}>
            <SampleStamp at={hoverSample} />
            {rows.map((r) => {
                const isNear = r === near && hasNear;
                // Only the NEAREST pool is decomposed. Listing what is resident on all three at once is the
                // detail the model rows below already carry, and it turns a reading into a wall — the stack
                // exists so a crossing can be read at a glance.
                const consumers = isNear ? poolFacts(r.p.bandsOf(frame)).consumers : [];
                const now = isNear ? new Set(poolFacts(r.p.bandsOf(latest)).consumers.map((c) => c.label)) : new Set<string>();
                return (
                    // One SECTION per pool: the pool's own line, then whatever is resident on it. The rule
                    // between sections is what stops a consumer reading as another device.
                    <div class="rc-tip-sect" key={r.p.id}>
                        <div class={`rc-tip-row rc-tip-poolrow${isNear ? " near" : ""}`}>
                            <span class="rc-tip-label"><i class="rc-swatch" style={{ background: r.p.color }} />{r.p.name}</span>
                            {/* Split into the grid's own columns rather than one formatted string: the whole
                                point is that the amount and the share are COLUMNS, and formatShare renders
                                them as a sentence. "of <ceiling>" rides with the amount, since it is what the
                                share is a share OF. */}
                            <span class="rc-tip-amt">{formatBytes(r.used)}<span class="rc-tip-of"> of {formatBytes(r.p.ceiling)}</span></span>
                            <span class="rc-tip-pct">{percentOf(r.used, r.p.ceiling)}</span>
                        </div>
                        {consumers.map((c) => (
                            <div class="rc-tip-row rc-tip-consumer-row" key={c.label}>
                                <span class="rc-tip-label">
                                    {/* A model's own dot, the same one its row carries. The residual gets a
                                        HOLLOW one: an empty ring holds the same space so the names line up,
                                        while visibly not being a colour swatch — which is the thing that
                                        would claim the residual is a model. Omitting it entirely aligned
                                        nothing and left the column ragged. */}
                                    {c.model
                                        ? <i class="rc-tip-dot" style={{ background: colorFor(c.model) }} />
                                        : <i class="rc-tip-dot rc-tip-dot-none" />}
                                    <span class="rc-tip-cname">{c.label}</span>
                                    {/* NO "gone" MARKER HERE. This tooltip reads a sample from the PAST — it
                                        answers "what was on this card at that instant", and at that instant
                                        the model was resident, so annotating it with what happened later is
                                        answering a question nobody asked at the place they asked it. Whether
                                        a model is resident NOW is the model list's job, where the row says
                                        so and the tooltip on it explains. */}
                                </span>
                                <span class="rc-tip-amt">{formatBytes(c.bytes)}</span>
                                <span class="rc-tip-pct">{percentOf(c.bytes, r.p.ceiling)}</span>
                            </div>
                        ))}
                        {isNear && !consumers.length
                            ? <div class="rc-tip-row rc-tip-consumer-row"><span class="rc-tip-label rc-tip-dim">nothing resident</span></div>
                            : null}
                    </div>
                );
            })}
            {/* THE BRIDGES the walls are drawn for, in words: which pairs are directly linked and by what. A
                section of its own, after the pools, because a link belongs to a PAIR and never to one row. */}
            {links.length ? (
                <div class="rc-tip-sect rc-tip-links">
                    {links.map((l) => (
                        <div class="rc-tip-row" key={l.label}>
                            <span class="rc-tip-label">{l.label}</span>
                            <span class="rc-tip-amt">{l.phrase}</span>
                            {l.note ? <span class="rc-tip-note rc-tip-linknote">{l.note}</span> : null}
                        </div>
                    ))}
                </div>
            ) : null}
            {/* AT THE BOTTOM, where the other view puts it — a hint that moves between views is one more
                thing to find. ONLY ↑↓: there is no depth here to descend into, since a pool has no memory
                breakdown of its own (the decomposition is per MODEL), and naming a key that silently does
                nothing is worse than naming none. */}
            {rows.length > 1 ? <div class="rc-tip-row rc-tip-keys"><span><ClickFirst /><kbd>↑↓</kbd> pick a {bandOf ? "pool" : "line"}</span></div> : null}
        </div>
    );
}

/** The utilization figures a sample carries for one card, or undefined — "not read", never idle. */
export const utilOf = (s: ResourceSample, id: string) => s.capacity?.devices.find((d) => d.id === id)?.utilization;

/** Every card's two figures at the datapoint under the cursor — the same Grafana reading the pools tip gives,
 *  for utilization. A figure the card did not report says so rather than showing a 0. */
export function UtilTip({ cards, color, at, latest, scope }: { cards: DeviceCapacity[]; color: (i: number) => string; at: ResourceSample | null; latest: ResourceSample; scope: string }) {
    const cur = cursorOn(scope);
    const { ref, style } = useTipPlacement(cur);
    if (!cur) return null;
    const frame = at ?? latest;
    const fig = (v: number | undefined) => (v != null ? `${v}%` : "not reported");
    return (
        <div class="rc-tip rc-tip-pools" role="tooltip" ref={ref} style={style}>
            <SampleStamp at={at} />
            {cards.map((c, ci) => {
                const u = utilOf(frame, c.id);
                return (
                    <div class="rc-tip-sect" key={c.id}>
                        <div class="rc-tip-row rc-tip-poolrow">
                            <span class="rc-tip-label"><i class="rc-swatch" style={{ background: color(ci) }} />{c.name}</span>
                            <span class="rc-tip-amt">GPU {fig(u?.gpuPercent)}</span>
                            <span class="rc-tip-pct">memory {fig(u?.memoryPercent)}</span>
                        </div>
                    </div>
                );
            })}
            <div class="rc-tip-note">averaged by the driver over its own window</div>
        </div>
    );
}

/** "click, then" in front of a key hint whenever the keys cannot reach the chart from where the keyboard is — the
 *  DevTools panel with focus in another pane, which nothing can relay from. A hint must never offer keys that go
 *  somewhere else; in the overlay the shell relays them, so this says nothing there. */
function ClickFirst() {
    const reach = keysReach();   // read unconditionally, so the component subscribes (the minify gotcha)
    return reach ? null : <span class="rc-tip-click">click, then </span>;
}

/** What a hovered break stands for: how long nothing was drawn, from when to when, and why. */
export function GapTip({ scope }: { scope: string }) {
    const h = gapHover.value, at = cursorAt(scope), ev = eventHover.value;
    const { ref, style } = useTipPlacement(at);
    // AN EVENT WINS. A ruled moment inside a break sits over it, and entering the rule does not LEAVE the gap, so both
    // hovers can be set at once — the event is what the pointer is on.
    if (!h || !at || h.scope !== scope || (ev && ev.scope === scope)) return null;
    const { from, to, reported, isolated } = h.gap;
    return (
        <div class="rc-tip rc-tip-event rc-tip-gap" role="tooltip" ref={ref} style={style}>
            <div class="rc-tip-line">
                <span class="rc-tip-name">{reported ? "frames dropped" : "not measured"}</span>
                <span class="rc-tip-size">{fmtDur(to - from)}</span>
            </div>
            <div class="rc-tip-line"><span>{hhmmss(from)} → {hhmmss(to)}</span></div>
            <div class="rc-tip-note">{reported
                ? "The server dropped frames here: this panel fell behind its event stream. The line breaks rather than draw across readings that never arrived."
                : "Nothing was sampled here: the panel was closed, or the box did not answer. The chart cuts the stretch out instead of drawing a line across it."}
                {isolated ? ` ${isolated === 1 ? "One isolated reading" : `${isolated} isolated readings`} fell inside it, too few to draw.` : ""}</div>
        </div>
    );
}

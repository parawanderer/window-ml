// lane-paint.ts — how ONE event-lane bar is painted: its segments, their fills and its outline, as data.
//
// No Preact and no state, so the panel's lane (resource-lane-ui.tsx) and a static page that draws the same lane off
// an exported run (the bench's pages) paint a bar with the same code and cannot drift apart. A fill is a `Paint`
// (a colour, dots or stripes on a ground), which the lane draws as SVG (lane-bars.tsx) and the phase strip and the
// tooltip's swatches draw as CSS (`phaseFill`), from the one description.

import { colorFor } from "../palette";
import type { ResourceEvent } from "../../resource/resource-timeline";

/** A phase's swatch, matching its stripe in the bar exactly — so the tooltip's sections and the block's parts
 *  are visibly the same three things, rather than a list you have to map onto a picture yourself. */
// THREE STRIPE PATTERNS THAT DIFFER IN DIRECTION, NOT IN WEIGHT. A load, its weights half and its context
// half were all 45° stripes in the model's colour, separated only by opacity — which is legible in a 200px
// bar and not at all in a 10px tooltip swatch, so the tooltip listed three rows with what read as the same
// glyph three times. Direction survives being tiny:
//
//   load (the whole thing)  ▨  crosshatch — it IS both halves, so it is both leans
//   moving the weights in   ╱  leaning one way
//   allocating the context  ╲  leaning the other
//
// Which also fixes the bar: a load's two halves were told apart by a divider and a shade, and the shade did
// almost none of the work.
// DOTS, not stripes. Two stripe layers leaning opposite ways drew a load as a row of X's — busy at any size, and in a
// 9px lane row it read as noise rather than as "waiting". A grid of dots on the panel's ground says the same thing
// (time, not work) quietly, and a denser, smaller grid tells a load's second half from its first by texture.
const dots = (c: string, r: number, cell: number): Paint => ({ dots: c, r, cell, ground: "var(--panel)" });

const loadStripes = (model?: string): Paint => dots(model ? colorFor(model) : "var(--warn, #f59e0b)", 1.2, 5);

/** One half of a load: same colour, opposite leans, so the two are told apart by DIRECTION at any size. */
const halfStripes = (c: string, lean: 45 | -45): Paint => ({ stripes: c, lean, ground: "var(--panel)" });

/** A fill: a flat colour, a grid of dots, or 3px stripes every 8px leaning `lean` degrees (as a CSS gradient angle),
 *  each pattern on its own ground. Any CSS colour, `var()` and `color-mix()` included. */
export type Paint = { color: string } | { dots: string; r: number; cell: number; ground: string } | { stripes: string; lean: 45 | -45; ground: string };

/** A `Paint` as a CSS `background`, for what draws it as HTML (the phase strip, the tooltip's swatches). */
export function paintCss(p: Paint): string {
    if ("color" in p) return p.color;
    if ("dots" in p) return `radial-gradient(circle, ${p.dots} ${p.r}px, transparent ${p.r + 0.5}px) 0 0 / ${p.cell}px ${p.cell}px, ${p.ground}`;
    return `repeating-linear-gradient(${p.lean}deg, ${p.stripes} 0 3px, ${p.ground} 3px 8px)`;
}

/** The paint for ONE phase of an event, keyed by phase kind and whose model it belongs to. A model's phases
 *  share its colour and differ only in weight, so a run reads as one thing doing several, rather than as
 *  several unrelated things that happen to be adjacent. */
export const phasePaint = (kind: string, model?: string): Paint => {
    const base = model ? colorFor(model) : "var(--accent)";
    const flat = (color: string): Paint => ({ color });
    // The model's channels share its colour and differ in WEIGHT, because they are the same model doing the
    // same work — answering is the payload, so it keeps the full colour; thinking and emitting a tool call
    // are lighter. The dividers between them are what makes the split legible; the fills only rank it.
    return kind === "model" || kind === "answer" ? flat(base)
        : kind === "think" ? flat(`color-mix(in srgb, ${base} 62%, transparent)`)
        : kind === "call" ? flat(`color-mix(in srgb, ${base} 30%, transparent)`)
        : kind === "wait" ? flat("color-mix(in srgb, var(--fg-faint) 45%, transparent)")
        // Time that is NOT the tool and NOT the machine's work: the network getting there and back, and the
        // far end queueing before it started. Both borrow the neutral the approval wait uses rather than the
        // model's colour, because neither is the model or the tool doing anything — `net` fainter still,
        // since it is the one figure we DERIVE by subtraction rather than being told.
        // Plumbing between the model finishing and the tool starting. The faintest of the neutrals: it is
        // ours, it is usually milliseconds, and it exists mainly so the block sits where the work did.
        : kind === "dispatch" ? flat("color-mix(in srgb, var(--fg-faint) 20%, transparent)")
        : kind === "net" ? flat("color-mix(in srgb, var(--fg-faint) 26%, transparent)")
        : kind === "queue" ? flat("color-mix(in srgb, var(--fg-faint) 38%, transparent)")
        // A COLD START is a wait, like a model load — so it is STRIPED for the same reason: a wide flat block
        // reads as a lot of work having happened, and none of this is work you asked for. Neutral rather than
        // the model's colour, since it is the sandbox arriving and not the model.
        : kind === "boot" ? halfStripes("color-mix(in srgb, var(--fg-faint) 34%, transparent)", 45)
        // A GENERATION's halves, by weight of the model's own colour like its channels: prefill is the dense
        // one (the whole prompt read at once), decode lighter. The same two weights the KV fill uses, so a
        // lane span and the cache it filled read as one legend. The remainder around them is not the model
        // doing either, so it takes the faintest neutral, like dispatch.
        : kind === "prefill" ? flat(base)
        : kind === "decode" ? flat(`color-mix(in srgb, ${base} 55%, transparent)`)
        : kind === "other" ? flat("color-mix(in srgb, var(--fg-faint) 20%, transparent)")
        // A PROMPT-CACHE SWAP: memory being copied for this model before it can read the prompt — a wait, like a
        // load, so it is striped the way a load is, in a lighter weight of the model's colour.
        : kind === "swap" ? halfStripes(`color-mix(in srgb, ${base} 45%, transparent)`, 45)
        // A LOAD's two halves. Both are the model arriving, so both are its colour, dotted because a load is a wait
        // rather than work; the context half's grid is denser and smaller, so the halves differ by texture.
        : kind === "weights" ? dots(base, 1.2, 5)
        // A load inside a step: the same wait the load's own span below it shows, dotted the same way.
        : kind === "load" ? dots(`color-mix(in srgb, ${base} 70%, transparent)`, 1.2, 5)
        : kind === "context" ? dots(`color-mix(in srgb, ${base} 75%, transparent)`, 0.8, 3)
        : flat(`color-mix(in srgb, ${base} 38%, transparent)`);
};

/** The same paint as a CSS `background`. */
export const phaseFill = (kind: string, model?: string): string => paintCss(phasePaint(kind, model));

/** Each phase as a [start, end] FRACTION of the block. Phases carry only their end, so a start is the
 *  previous end — which every consumer would otherwise re-derive, and one of them would get wrong. */
function phaseSpans(phases: { kind: string; until: number }[], from: number, total: number) {
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    let at = 0;
    return phases.map((ph) => {
        const end = clamp((ph.until - from) / total);
        const span = { kind: ph.kind, start: at, end };
        at = end;
        return span;
    });
}

/** Whether a phase's fill is a PATTERN (dots or stripes) rather than a colour: the tooltip's swatch draws a pattern
 *  at a size of its own. */
export const isPattern = (fill: string): boolean => fill.startsWith("repeating-") || fill.startsWith("radial-gradient(");

/** One stretch of a bar, as fractions of its width, with its fill; `edge` draws a 1px rule down its left side, and
 *  `cls` names what it is when that is more than a phase of work (`rc-ev-wait`, `rc-ev-ctxphase`, `rc-ev-pattern`). */
export interface BarSegment { start: number; end: number; paint: Paint; edge?: string; cls?: string }

/**
 * A bar's paint as plain data, whatever draws it: its classes beyond `rc-ev`, the segments tiling it left to right (one
 * per phase, a 1px cut in the panel's colour between them), what is drawn over them (a load's context half), and its
 * outline. `half` is a container's: a run or a session is drawn at half height, so the widest bar in the lane does not
 * read as the heaviest work in it. A segment of `null` paint is hollow (a session, an aside), drawn by its outline only.
 */
export interface BarShape {
    /** `rc-ev-<kind>`, plus `linked` (it navigates to a step) and `open` (still in flight) */
    cls: string;
    half: boolean;
    segs: BarSegment[];
    over: BarSegment[];
    /** gaps between segments: a 1px cut in the panel's colour, which tells two weights of one colour apart */
    cuts: boolean;
    outline?: { color: string; dash?: boolean; radius?: number };
    /** the model's colour, carried as `--model` so whose a bar is can be read off it */
    model?: string;
}

/** The fill a bar has when it has no phases: what `.rc-ev-<kind>` drew, unless a model's colour replaced it. */
function kindPaint(e: Pick<ResourceEvent, "kind" | "model">): Paint | null {
    const m = e.model ? colorFor(e.model) : null;
    switch (e.kind) {
        case "load": return loadStripes(e.model);
        // A run is the CONTAINER every other block sits inside: its colour is the model's, at half height (`half`).
        case "run": return { color: m ?? "var(--fg-dim)" };
        // A SESSION container is not a run: nothing was driven, it is just the stretch some `ml.chat()` or `ml.embed()`
        // calls happened in. HOLLOW, a bracket around its own spans rather than a bar of work.
        case "session": return null;
        // AN ASIDE (a model call YOU triggered while reading) is OUTLINED rather than filled: it spent tokens on this
        // box, so it is drawn, but it belongs to your reading session, so it must not read as a step.
        case "aside": return null;
    }
    // A model's events carry ITS colour, the one its row and its band already use, so the lane reads against the
    // model list without a legend of its own.
    if (m) return { color: m };
    return { color: e.kind === "gen" ? "var(--accent)"
        // A background embedding call: a small model working BESIDE the driver, quieter.
        : e.kind === "embed" ? "color-mix(in srgb, var(--ok, #22c55e) 60%, transparent)"
        // SERVING: the box working, from the server's own view; half weight, a backdrop to the steps against it.
        : e.kind === "serve" ? "color-mix(in srgb, var(--accent) 55%, transparent)"
        : "var(--fg-faint)" };
}

/** How to paint one event's bar, whatever draws it. */
export function barShape(e: Pick<ResourceEvent, "kind" | "t" | "until" | "phases" | "model" | "ref" | "open">): BarShape {
    return { ...shapeOf(e), ...(e.model ? { model: colorFor(e.model) } : {}) };
}

function shapeOf(e: Pick<ResourceEvent, "kind" | "t" | "until" | "phases" | "model" | "ref" | "open">): BarShape {
    const total = (e.until ?? e.t) - e.t;
    const cls = `rc-ev-${e.kind}${e.ref ? " linked" : ""}${e.open ? " open" : ""}`;
    const half = e.kind === "run" || e.kind === "session";
    const over: BarSegment[] = [];
    const outline: BarShape["outline"] = e.kind === "session" ? { color: e.model ? colorFor(e.model) : "var(--fg-dim)", radius: 3 }
        : e.kind === "aside" ? { color: `color-mix(in srgb, ${e.model ? colorFor(e.model) : "var(--fg-faint)"} 70%, transparent)`, dash: true }
        : e.kind === "load" ? { color: "var(--border)" }
        : e.kind === "serve" ? { color: `color-mix(in srgb, ${e.model ? colorFor(e.model) : "var(--accent)"} 35%, transparent)` }
        : undefined;
    const spans = e.phases && total > 0 ? phaseSpans(e.phases, e.t, total).filter((ph) => ph.end > ph.start) : [];
    // A LOAD keeps its dots for the whole span: it is a wait, and a flat fill would read as work. Its CONTEXT half (the
    // KV cache and compute buffers allocated) is drawn over it in a denser grid, with a hairline at the boundary, so
    // the split reads as a change of texture.
    if (e.kind === "load") {
        for (const ph of spans) if (ph.kind === "context") {
            const c = e.model ? colorFor(e.model) : null;
            over.push({ start: ph.start, end: ph.end, cls: "rc-ev-ctxphase", edge: `color-mix(in srgb, ${c ?? "var(--fg)"} 70%, transparent)`,
                paint: dots(`color-mix(in srgb, ${c ?? "var(--warn, #f59e0b)"} 80%, transparent)`, 0.8, 3) });
        }
        return { cls, half, segs: [{ start: 0, end: 1, paint: loadStripes(e.model) }], over, cuts: false, outline };
    }
    // A composite span is ONE block whose parts are different KINDS of time: the model, the human deciding, the tool.
    // A person at the approval gate is the step's wall time but none of the machine's work, so its stretch is striped
    // over the neutral, for the same reason a load is dotted.
    if (spans.length) {
        const segs = spans.map((ph): BarSegment => {
            if (ph.kind === "wait") return { start: ph.start, end: ph.end, cls: "rc-ev-wait",
                paint: { stripes: "color-mix(in srgb, var(--fg-faint) 60%, transparent)", lean: 45, ground: (phasePaint("wait") as { color: string }).color } };
            if (ph.kind === "context") return { start: ph.start, end: ph.end, cls: "rc-ev-ctxphase",
                paint: dots(`color-mix(in srgb, ${e.model ? colorFor(e.model) : "var(--warn, #f59e0b)"} 80%, transparent)`, 0.8, 3),
                edge: `color-mix(in srgb, ${e.model ? colorFor(e.model) : "var(--fg)"} 70%, transparent)` };
            const paint = phasePaint(ph.kind, e.model);
            // A load inside a step, a cache swap, a cold start: a wait drawn as one, dotted or striped.
            return { start: ph.start, end: ph.end, paint, ...("color" in paint ? {} : { cls: "rc-ev-pattern" }) };
        });
        return { cls, half, segs, over, cuts: true, outline };
    }
    // A step with no phases splits half and half: the model's work, then the tool's lighter wash.
    if (e.kind === "tool" && !e.model) {
        return { cls, half, cuts: false, over, outline, segs: [
            { start: 0, end: 0.5, paint: { color: "var(--accent)" } },
            { start: 0.5, end: 1, paint: { color: "color-mix(in srgb, var(--accent) 38%, transparent)" } }] };
    }
    const paint = kindPaint(e);
    return { cls, half, cuts: false, over, outline, segs: paint ? [{ start: 0, end: 1, paint }] : [] };
}

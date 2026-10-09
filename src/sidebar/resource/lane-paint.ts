// lane-paint.ts — how ONE event-lane bar is painted: its fill, its phase gradient and the pattern overlays, as data.
//
// No Preact and no state, so the panel's lane (resource-lane-ui.tsx) and a static page that draws the same lane off
// an exported run (lane-static.ts, the bench's run pages) paint a bar with the same code and cannot drift apart.

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
const dots = (c: string, r: number, cell: number): string =>
    `radial-gradient(circle, ${c} ${r}px, transparent ${r + 0.5}px) 0 0 / ${cell}px ${cell}px, var(--panel)`;

const loadStripes = (model?: string): string => dots(model ? colorFor(model) : "var(--warn, #f59e0b)", 1.2, 5);

/** One half of a load: same colour, opposite leans, so the two are told apart by DIRECTION at any size. */
const halfStripes = (c: string, lean: 45 | -45): string =>
    `repeating-linear-gradient(${lean}deg, ${c} 0 3px, var(--panel) 3px 8px)`;

/** The paint for ONE phase of an event, keyed by phase kind and whose model it belongs to. A model's phases
 *  share its colour and differ only in weight, so a run reads as one thing doing several, rather than as
 *  several unrelated things that happen to be adjacent. */
export const phaseFill = (kind: string, model?: string): string => {
    const base = model ? colorFor(model) : "var(--accent)";
    // The model's channels share its colour and differ in WEIGHT, because they are the same model doing the
    // same work — answering is the payload, so it keeps the full colour; thinking and emitting a tool call
    // are lighter. The dividers between them are what makes the split legible; the fills only rank it.
    return kind === "model" || kind === "answer" ? base
        : kind === "think" ? `color-mix(in srgb, ${base} 62%, transparent)`
        : kind === "call" ? `color-mix(in srgb, ${base} 30%, transparent)`
        : kind === "wait" ? "color-mix(in srgb, var(--fg-faint) 45%, transparent)"
        // Time that is NOT the tool and NOT the machine's work: the network getting there and back, and the
        // far end queueing before it started. Both borrow the neutral the approval wait uses rather than the
        // model's colour, because neither is the model or the tool doing anything — `net` fainter still,
        // since it is the one figure we DERIVE by subtraction rather than being told.
        // Plumbing between the model finishing and the tool starting. The faintest of the neutrals: it is
        // ours, it is usually milliseconds, and it exists mainly so the block sits where the work did.
        : kind === "dispatch" ? "color-mix(in srgb, var(--fg-faint) 20%, transparent)"
        : kind === "net" ? "color-mix(in srgb, var(--fg-faint) 26%, transparent)"
        : kind === "queue" ? "color-mix(in srgb, var(--fg-faint) 38%, transparent)"
        // A COLD START is a wait, like a model load — so it is STRIPED for the same reason: a wide flat block
        // reads as a lot of work having happened, and none of this is work you asked for. Neutral rather than
        // the model's colour, since it is the sandbox arriving and not the model.
        : kind === "boot" ? "repeating-linear-gradient(45deg, color-mix(in srgb, var(--fg-faint) 34%, transparent) 0 3px, var(--panel) 3px 8px)"
        // A LOAD's two halves. Both are the model arriving, so both are its colour — but the first is the
        // weights moving (dense, and where the memory trace actually steps) and the second is the context
        // being allocated before it will serve. Striped either way, because a load is a wait rather than
        // work; they LEAN OPPOSITE WAYS, because a difference in shade alone is invisible in a swatch and
        // nearly invisible in a thin bar (see loadStripes).
        // A GENERATION's halves, by weight of the model's own colour like its channels: prefill is the dense
        // one (the whole prompt read at once), decode lighter. The same two weights the KV fill uses, so a
        // lane span and the cache it filled read as one legend. The remainder around them is not the model
        // doing either, so it takes the faintest neutral, like dispatch.
        : kind === "prefill" ? base
        : kind === "decode" ? `color-mix(in srgb, ${base} 55%, transparent)`
        : kind === "other" ? "color-mix(in srgb, var(--fg-faint) 20%, transparent)"
        // A PROMPT-CACHE SWAP: memory being copied for this model before it can read the prompt — a wait, like a
        // load, so it is striped the way a load is, in a lighter weight of the model's colour.
        : kind === "swap" ? halfStripes(`color-mix(in srgb, ${base} 45%, transparent)`, 45)
        : kind === "weights" ? dots(base, 1.2, 5)
        // A load inside a step: the same wait the load's own span below it shows, dotted the same way.
        : kind === "load" ? dots(`color-mix(in srgb, ${base} 70%, transparent)`, 1.2, 5)
        : kind === "context" ? dots(`color-mix(in srgb, ${base} 75%, transparent)`, 0.8, 3)
        : `color-mix(in srgb, ${base} 38%, transparent)`;
};

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

/** Whether a phase's fill is a PATTERN (stripes) rather than a colour. A pattern cannot be a gradient stop: one in
 *  the list makes the whole `background` invalid, the declaration is dropped, and the block draws as nothing. So
 *  a patterned phase gets a flat stop here and its stripes as an overlay (see `rc-ev-pattern`). */
export const isPattern = (fill: string): boolean => fill.startsWith("repeating-") || fill.startsWith("radial-gradient(");

function phaseGradient(phases: { kind: string; until: number }[], from: number, total: number, model?: string): string {
    const fill = (kind: string) => { const f = phaseFill(kind, model); return isPattern(f) ? "var(--panel)" : f; };
    const stops: string[] = [];
    // A HAIRLINE between phases, in the panel's own colour so it reads as a cut rather than a fourth colour.
    // Fills alone don't do it: think and call are the same hue at different weights, and two adjacent weights
    // of one colour read as a gradient, not a boundary. Placed in px via calc so it stays one pixel whether
    // the block is 4% or 40% of the lane.
    let at = "0%";
    for (const [i, ph] of phases.entries()) {
        const end = `${Math.min(100, Math.max(0, ((ph.until - from) / total) * 100))}%`;
        if (i > 0) { stops.push(`var(--panel) ${at} calc(${at} + 1px)`); at = `calc(${at} + 1px)`; }
        stops.push(`${fill(ph.kind)} ${at} ${end}`);
        at = end;
    }
    return `linear-gradient(to right, ${stops.join(", ")})`;
}

/** A bar's paint as plain data: the classes beyond `rc-ev`, the inline style, and the pattern overlays drawn inside
 *  it. A gradient stop takes a colour and a pattern is not one, so a patterned phase is a flat stop in the gradient
 *  with its pattern drawn as an overlay; a load keeps its own dots for the whole span. */
export interface BarPaint {
    /** `rc-ev-<kind>`, plus `linked` (it navigates to a step) and `open` (still in flight) */
    cls: string;
    style: Record<string, string>;
    overlays: { cls: "rc-ev-wait" | "rc-ev-ctxphase" | "rc-ev-pattern"; start: number; end: number; background?: string }[];
}

/** How to paint one event's bar, whatever draws it. */
export function barPaint(e: Pick<ResourceEvent, "kind" | "t" | "until" | "phases" | "model" | "ref" | "open">): BarPaint {
    // A composite span is ONE block whose parts are different KINDS of time: the model, the human deciding, the tool.
    // Drawn as gradient stops rather than separate elements, so it still hovers and clicks as the single step it is.
    const total = (e.until ?? e.t) - e.t;
    // A LOAD keeps its dots for the whole span — it is a wait, and a flat fill would read as work. Its two halves are
    // OVERLAYS, for exactly the reason the approval wait is: a gradient stop takes a COLOUR, and a pattern is not one.
    // Feeding the phase fills into phaseGradient produced `linear-gradient(..., repeating-linear-gradient(...) 0% 8%,
    // ...)`, which is not valid CSS at all: the whole declaration was dropped and the divider silently never appeared.
    const bg = e.kind === "load" ? loadStripes(e.model)
        : e.phases && total > 0 ? phaseGradient(e.phases, e.t, total, e.model) : undefined;
    const style: Record<string, string> = {
        // A `run` is the CONTAINER every other block sits inside, so it is drawn as a pattern rather than a solid fill
        // (see .rc-ev-run): solid, the widest bar in the lane reads as the heaviest work in it. The pattern is built
        // from `--model`, and an inline `background` shorthand would reset the background-image that draws it.
        ...(e.model && !bg && e.kind !== "run" ? { background: colorFor(e.model) } : {}),
        // A model's events carry ITS colour, the one its row and its band already use, so the lane reads against the
        // model list without a legend of its own.
        ...(e.model ? { "--model": colorFor(e.model) } : {}),
        ...(bg ? { background: bg } : {}),
    };
    const overlays: BarPaint["overlays"] = [];
    if (e.phases && total > 0) {
        const spans = phaseSpans(e.phases, e.t, total).filter((ph) => ph.end > ph.start);
        // A person at the approval gate is the step's wall time but none of the machine's work, so it is a texture for
        // the same reason a load is; `context` is a load's second half (the KV cache and compute buffers allocated),
        // denser than the weights half so the boundary reads as a change of texture without a drawn line.
        for (const ph of spans) if (ph.kind === "wait" || ph.kind === "context") overlays.push({ cls: ph.kind === "context" ? "rc-ev-ctxphase" : "rc-ev-wait", start: ph.start, end: ph.end });
        // Every other patterned phase (a load inside a step, a cache swap, a cold start): the gradient carries a flat
        // stop for it and its pattern is drawn here; in the gradient it made the whole background invalid. A load's own
        // bar has its dots already.
        if (e.kind !== "load") for (const ph of spans) {
            if (ph.kind !== "wait" && ph.kind !== "context" && isPattern(phaseFill(ph.kind, e.model))) overlays.push({ cls: "rc-ev-pattern", start: ph.start, end: ph.end, background: phaseFill(ph.kind, e.model) });
        }
    }
    return { cls: `rc-ev-${e.kind}${e.ref ? " linked" : ""}${e.open ? " open" : ""}`, style, overlays };
}

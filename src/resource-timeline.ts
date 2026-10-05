// resource-timeline.ts — what happened on the machine, as the lane and the plots draw it: `ResourceEvent` (a run,
// a generation, a tool step with its phases, a load, an eviction, an error), where one sits on the axis
// (`EventPlacement`), and the readings that derive events from residency (`residencyEvents`, `loadEdges`, `eventsIn`).
//
// Not the event STREAM: resource-events.ts reads the server's `/api/events` frames, and `machineEventFrom`
// (sidebar/resource-feed.ts) turns those into `ResourceEvent`s. Split out of resource-model.ts.

import { MAX_SAMPLE_GAP_MS } from "./resource-axis";
import { Roofline } from "./resource-decode";
import { PredictedDecode, ServerHint } from "./resource-gens";
import { ResourceSample, LoadEstimate, MemoryBreakdown, formatBytes } from "./resource-model";

/** Where an event sits on the chart's x-axis, as fractions of the whole axis ({@link placeEvents}, {@link Axis}).
 *  The axis is linear in clock time, gaps included, so an event is placed by its time alone: one that happened in a
 *  gap is drawn in the gap, which is where it happened. */
export interface EventPlacement {
    event: ResourceEvent;
    /** Always 0 on the linear axis; kept so a row can still be grouped by it. */
    run: number;
    /** Across the whole axis, UNCLAMPED: off the left edge is below 0, off the right above 1. */
    from: number;
    /** Likewise; equals `from` for an instant. */
    to: number;
    /** The span continues past the last measurement. */
    clipped: boolean;
}

/** EVICTIONS, read straight off consecutive samples. Nothing reports them — a model simply stops being in
 *  `ps` — so the diff IS the source, and it is the one event kind that needs no cooperation from anything.
 *  Loads are NOT inferred here: `load_duration` gives a real span with a real duration, and a second inferred
 *  instant for the same load would double-report it. A model that APPEARS with no load span behind it (loaded
 *  by another client, or while the panel was closed) is reported, because otherwise it arrives from nowhere. */
export function residencyEvents(samples: ResourceSample[], knownLoads: ResourceEvent[] = []): ResourceEvent[] {
    const out: ResourceEvent[] = [];
    for (let i = 1; i < samples.length; i++) {
        const before = new Set(samples[i - 1].models.map((m) => m.model));
        const after = new Set(samples[i].models.map((m) => m.model));
        const t = samples[i].t;
        for (const m of before) if (!after.has(m)) out.push({ t, kind: "evict", label: `${m} evicted`, model: m, via: "poll" });
        for (const m of after) {
            if (before.has(m)) continue;
            // Within a poll of a load span for the same model → that span already tells the story.
            const covered = knownLoads.some((e) => e.model === m && e.kind === "load" &&
                t >= e.t - MAX_SAMPLE_GAP_MS && t <= (e.until ?? e.t) + MAX_SAMPLE_GAP_MS);
            if (!covered) out.push({ t, kind: "load", label: `${m} appeared`, model: m, via: "poll" });
        }
    }
    return out;
}

/** An annotation on the time axis — a run starting, a model loading or being evicted, a context reload.
 *  Kept separate from the samples because events are instants while samples are a cadence, and because the
 *  event source (the debug bus) is independent of the poll. */
/** The parts a span divides into. Named rather than inline because the surfaces that render a phase have to
 *  be TOTAL over it: a tooltip that fell through to a default label shipped a model load's two halves as the
 *  word "tool", which reads as a wrong fact rather than as a missing one. */
// `boot` is an executor's COLD START — a sandbox fetching its runtime before the code runs. Like a model
// load it is the step's wall time and none of the work you asked for, so it is drawn apart from `tool`.
export type PhaseKind = "model" | "wait" | "tool" | "think" | "answer" | "call" | "queue" | "net" | "boot" | "dispatch" | "weights" | "context"
    | "prefill" | "decode" | "other" | "swap" | "load";

/** What the ENGINE measured for one generation (`gen.end.timings`, patched Ollama). Every figure is the
 *  executor's own, which is what makes a prefill/decode boundary drawable at all: the event stream carries no
 *  phase transition (llama.cpp emits none, and a sampled one would stamp the moment a poll NOTICED), so the
 *  split exists only as these two durations, anchored at the end.
 *
 *  `promptTokensCached` keeps the server's three states apart: `0` is a cold prefill, a number is a cache hit,
 *  ABSENT is "not reported" (an older build omitted the cold case, and so does a route that never had it).
 *  Collapsing absent into 0 would claim a cold prefill nobody measured. `promptTokens` alone hides a cache hit
 *  completely — it is the same on both — so the count of cached tokens and the DURATION are the evidence. */
export interface GenTimings {
    promptTokens?: number;
    promptTokensCached?: number;
    promptMs: number;
    evalMs: number;
    decoded?: number;
    /** A HOST-RAM PROMPT-CACHE SWAP this request paid for, before its prefill: the conversation in the slot was
     *  saved to RAM (`savedTokens`/`savedBytes`) and this one read back if it was there (`restored`, always
     *  present — `false` is information), with other conversations evicted to make room (`evicted`,
     *  `evictedBytes`) or the outgoing one too large to keep (`tooLarge`). `ms` is the ENGINE's measure of the
     *  copy, and it is in no other timing: a turn with a 24 ms prefill took 670 ms, 500 of them swapping.
     *  Present only on a request that switched conversations, and only on a one-slot model (with more slots
     *  the log cannot say whose swap is whose, so none is reported). */
    swap?: { ms: number; restored: boolean; savedTokens?: number; savedBytes?: number; evicted?: number; evictedBytes?: number; tooLarge?: boolean };
    /** The server's own prediction for THIS generation (`gen.end.predicted_decode`, `ollama-slop:genpredict`), made
     *  from the state BEFORE it ran — see {@link PredictedDecode}. Rides with the figures, so a generation joined to
     *  our own call keeps it. */
    predicted?: PredictedDecode;
}

/** One thing that happened on the machine's timeline: an instant (a rule on the plots) or a span (a bar in the lane). */
export interface ResourceEvent {
    t: number;
    /** When it ENDED, for the kinds that have a duration. Absent → an instant (a vertical rule); present → a
     *  span (a bar in the lane), and the duration is the interesting part: a 40-second turn that spent 30 of
     *  them loading a model is a different story from one that didn't. */
    until?: number;
    /** `embed` is for background embedding calls — a small model resolving something (a tool-call label) while
     *  the driver runs. It is NOT produced yet; the kind exists so that when it is, it renders and hovers like
     *  everything else instead of arriving as an unlabelled bar. Its whole point is that it OVERLAPS the
     *  driver's own events rather than following them, which the lane's row packing already handles. */
    /** `aside` is a model call YOU triggered while reading — the code annotator, a summary. It belongs on the
     *  timeline because it spent tokens on this box and takes time you can see, and it is a separate kind
     *  because it is NOT part of the run: charging it to the run would make two runs incomparable on the
     *  strength of how much someone poked at one of them. Drawn outlined rather than filled, for the same
     *  reason. */
    kind: "run" | "session" | "gen" | "tool" | "embed" | "load" | "evict" | "error" | "note" | "serve" | "aside";
    label: string;
    /**
     * WHERE THIS EDGE CAME FROM, for the kinds a box can produce two ways.
     *
     * `"poll"` is INFERRED by diffing `/api/ps` — it says a model was there and then was not, which is the
     * most that can be read off polls: they cannot see a load happening (for most of one there is no runner
     * object at all), and they cannot tell an eviction that made room from an idle expiry. `"server"` is the
     * event stream's own edge, which knows both.
     *
     * The distinction has to travel because the panel SAYS which it is: a note reading "nothing reports an
     * eviction" is honest about an inference and false about an edge the server reported, on the very setup
     * the stream exists for. Absent on the kinds that are neither (a run, a generation).
     */
    via?: "poll" | "server";
    model?: string;
    /** This event's own id, and the event that SPAWNED it. A delegated sub-call — a vision reader, an
     *  embedding — never happens on its own: it belongs to a step, which belongs to a run. Hovering one can
     *  then light its whole lineage and dim everything else, which is the difference between "some bar" and
     *  "the reader this step called". */
    id?: string;
    parent?: string;
    /** Where this happened, so a click can go there: a session hash, and the step within it. Events are
     *  CROSS-SESSION — a model load belongs to the machine's timeline, not to whichever chat provoked it — so
     *  the reference is how the lane gets you back to the one that did. */
    /** Where clicking this span goes. `seq` names a STEP; without one it is a container, and `answer` says
     *  WHICH of the session's answers it ends at — a session holds one per run, so without it every run
     *  clicked through to the same final answer. */
    ref?: { hash: string; seq?: number; answer?: number };
    /** A composite span's PHASES, in order, each ending at `until`. A tool step is one block because it is one
     *  step and you reason about its parts together — but the parts are different kinds of time and must look
     *  different: the model generating the call, the human deciding whether to allow it, and the tool actually
     *  running. A step that waited two minutes for a click otherwise looked exactly like one that ran
     *  instantly, since only the last part is work the machine did.
     *
     *  `think`/`answer`/`call` SUBDIVIDE the model's own time, and only on a STREAMED call, where the channel
     *  each chunk arrived on is observable. `model` is the undifferentiated fallback — a non-streamed call,
     *  and the stretch before the first token (prompt eval, queue, network), which is the model's time but
     *  not any of its channels.
     *
     *  `queue`/`net` subdivide a REMOTE tool's time the same way, and for the same reason — because the
     *  executor reported its own numbers. What it said it spent evaluating is `tool`, what it spent getting
     *  started is `queue`, and whatever is left of OUR wall clock is `net`: the network and the far end's
     *  overhead. A local tool is all `tool`, which is exactly true rather than a fallback.
     *
     *  `weights`/`context` split a LOAD, and only when the server reported the boundary. They are not
     *  "loading" and "warming up": the second half ALLOCATES, and on a long-context model it allocates most
     *  of the footprint — measured as a second memory step some seconds after the weights land, immediately
     *  before the model will serve. So the span says "resident at 4s, usable at 10s", which is a readiness
     *  fact and the explanation a reader otherwise lacks for a memory trace that went flat while they waited. */
    phases?: { kind: PhaseKind; until: number }[];
    /** What a model LOAD moved into memory, as the server measured it: `loadBytes` is the whole load,
     *  `weightsBytes` the first half — so the context is the difference. Only a patched Ollama reports them
     *  (`size_vram` on the `load.weights` and `load.complete` edges).
     *
     *  They differ from the DEVICE's own step by the CUDA context floor (~0.69 GiB per card), which is
     *  agreement rather than drift: the device figure includes the driver context, the model's does not.
     *  Do not reconcile the two to zero. */
    loadBytes?: number;
    weightsBytes?: number;
    /** The WHOLE model, against `loadBytes` which is what reached the DEVICE. They are equal when it fit and
     *  differ when it did not: llama-server re-fits against the memory actually free, so an under-predicted
     *  load does not fail — it quietly runs the remainder on the CPU and is merely slow. There is no error
     *  and no other signal, so this difference is the only way to know a load was degraded. */
    totalBytes?: number;
    /** What the server's PREDICTOR expected this load to hold (the last `estimate` frame before it completed),
     *  and what the load actually held by kind (`load.complete`'s `memory`). For tuning the predictor, so the
     *  panel shows them only when asked (`predictView`). */
    estimate?: LoadEstimate;
    measured?: MemoryBreakdown;
    /** The ENGINE's own figures for a generation — prompt and cached tokens, prefill and decode durations,
     *  tokens decoded — when the server's event stream reported it (`gen.end.timings`). On a server `gen`
     *  span, and on a session block the server's generation was JOINED to (see `joinGens`). */
    gen?: GenTimings;
    /** On a session model call: OUR id for its request (`hint.request`, from its usage), so the server's record of
     *  the same generation joins to it exactly (see `joinGens`). */
    requestId?: string;
    /** On a SERVER generation: what the request said it was for (`gen.end.hint`, see `hintFrom`) — ours, when it
     *  carries our request id, or another client's traffic, which the lane can then name. */
    hint?: ServerHint;
    /** The model's KV-cache CAPACITY when a generation ended — its context (per slot) and slot count, read from
     *  the sample at that moment — so the cache fill can be drawn as shares wherever the span is shown, not only
     *  inside a drilled-in chart. Absent when no sample carried the model then. */
    genCtx?: { contextTokens: number; slots: number };
    /** The model's decode CEILING (or the reason it has none) at the generation's end, from the same sample as
     *  `genCtx` — so the tooltip can put the measured decode rate against the ceiling AT THAT CONTEXT. */
    genRoofline?: Roofline;
    /** This span has NOT FINISHED: `until` is where it had reached when the snapshot was taken, not where it
     *  ended. Only ever set by an `eventsFrom` given a `now` — a surface drawing live. It exists so the UI can
     *  say "still going" rather than drawing a bar whose right edge looks like a measured end. */
    open?: true;
    /** The tool that ran, for a composite span. */
    tool?: string;
    /** What it cost, for the kinds that spend tokens. Plain numbers rather than a RunStats import: this module
     *  stays standalone, and the surface that renders it already knows how to say "eval" vs "wall". */
    cost?: {
        inTokens: number; outTokens: number; tokPerSec: number | null;
        genBasis: "eval" | "wall" | "mixed" | null;
        /** Ollama's generation-only time and our own wall clock for the same call, when both are known. Their
         *  DIFFERENCE is what the network and the queue cost — the one number that separates "the model is
         *  slow" from "getting to the model is slow", and it exists only where the native route reports
         *  `eval_duration` beside our measurement. */
        evalMs?: number;
        wallMs?: number;
        /** Reading the prompt, when the native route reports it. Splits the wall-minus-generation remainder
         *  into model work and box latency, which are not the same kind of thing and cannot be compared
         *  between two models while they are one number. */
        promptEvalMs?: number;
        /** How long the model took to LOAD before this call could start (`load_duration`). Inside `wallMs`,
         *  so anything deriving "network" from the wall clock has to subtract it — see the tooltip. */
        loadMs?: number;
        /** How many of `inTokens` the server's prefix cache served — see `TokenUsage.cachedTokens`. Time, not
         *  spend: shown beside the count, never subtracted from it. */
        cachedTokens?: number;
    };
}

/** A LOAD's two internal edges, as instants to rule through the PLOT: where the weights finished arriving, and
 *  where the KV cache and compute buffers finished being allocated (the model can serve from there). Those are
 *  exactly the two steps in the device's free-memory trace during a load, and the lane — where the load's
 *  halves live as phases — is often collapsed, so without these the chart showed a two-step ramp with nothing
 *  saying what either step was. Only for a load whose boundary the SERVER reported (it has `phases`); an
 *  inferred load has no boundary and gets no rules, since a rule is a claim about when something happened.
 *  Each carries the bytes that half moved, when reported. */
export function loadEdges(e: ResourceEvent): ResourceEvent[] {
    if (e.kind !== "load" || e.until == null || !e.model) return [];
    const w = e.phases?.find((ph) => ph.kind === "weights");
    if (!w) return [];
    const ctx = e.loadBytes != null && e.weightsBytes != null ? e.loadBytes - e.weightsBytes : null;
    return [
        { t: w.until, kind: "load", model: e.model, ...(e.via ? { via: e.via } : {}),
          label: `${e.model} weights loaded${e.weightsBytes != null ? ` (${formatBytes(e.weightsBytes)})` : ""}` },
        { t: e.until, kind: "load", model: e.model, ...(e.via ? { via: e.via } : {}),
          label: `${e.model} KV cache and compute buffers allocated${ctx != null ? ` (${formatBytes(ctx)})` : ""} — ready to serve` },
    ];
}

/** Events inside a window, in time order — what the chart's event lane draws, and what a vertical rule
 *  through the plot is placed by. */
export function eventsIn(events: ResourceEvent[], from: number, to: number): ResourceEvent[] {
    // A SPAN counts when it overlaps the window at all — one that began before it and ended inside it is
    // exactly the case the lane exists to show (the load that started before you looked). Clipping to the
    // window is the renderer's job; deciding membership is this one's.
    return events
        .filter((e) => (e.until != null ? e.until >= from && e.t <= to : e.t >= from && e.t <= to))
        .sort((a, b) => a.t - b.t);
}

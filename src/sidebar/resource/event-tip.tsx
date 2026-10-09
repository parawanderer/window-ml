// event-tip.tsx — what one event in the lane WAS, in words: the body of the lane's tooltip. The panel shows it on hover
// (resource-lane-ui.tsx `EventTip`), and the bench's pages, which draw the same lane with no panel, show the same body.

import { SPILL_FLOOR } from "../../resource/resource-bands";
import { decodeCeiling } from "../../resource/resource-decode";
import { kvFill, predictionLine, serverGenNote } from "../../resource/resource-gens";
import { percentOf, type ResourceSample, loadTrace, formatBytes } from "../../resource/resource-model";
import type { ResourceEvent, PhaseKind } from "../../resource/resource-timeline";
import { colorFor } from "../palette";
import { fmtDur, hhmmssms } from "../timestamps";
import { phaseFill, isPattern } from "./lane-paint";

/** The server's own words for an edge, with the model's name taken off the front — the name is already the
 *  line above, and repeating it costs the width the REASON needs (`evicted (oom-retry)` against an `unload`,
 *  which the server reports without saying whether a keep-alive ran out or another load displaced it). */
function serverSaid(label: string, model?: string): string {
    const rest = model && label.startsWith(model) ? label.slice(model.length).trim() : label;
    return rest ? `the server reported this — ${rest}` : "reported by the server";
}

/** A phase's SWATCH in a tooltip. A pattern squeezed into a 7px circle is unreadable — the stripes drew as a
 *  partial ring, like a spinner — so a patterned phase (a wait: a load's halves, a cold start, a swap) is a HOLLOW
 *  ring in its colour, and work is a solid dot. The distinction the pattern makes in the lane survives. */
const phaseSwatch = (kind: string, model?: string): Record<string, string> => {
    const fill = phaseFill(kind, model);
    if (!isPattern(fill)) return { background: fill };
    const base = model ? colorFor(model) : "var(--accent)";
    const ring = kind === "boot" ? "var(--fg-faint)" : kind === "context" ? `color-mix(in srgb, ${base} 70%, transparent)` : base;
    return { background: "transparent", boxShadow: `inset 0 0 0 1.5px ${ring}` };
};

/** THE CACHE A GENERATION LEFT, as a bar in its lane tooltip — the same four textures as the drilled-in fill
 *  (`KvFill`), so it reads in EVERY preset, including Overview, whose pool lines have no cache part to fill.
 *  Left to right: reused (dotted), computed (dense), decoded (light), then the reserved remainder. The figure
 *  beside it is tokens against the cache's token capacity, never bytes. */
function KvBar({ gen, ctx, model }: { gen: NonNullable<ResourceEvent["gen"]>; ctx: NonNullable<ResourceEvent["genCtx"]>; model?: string }) {
    const f = kvFill(gen, ctx.contextTokens, ctx.slots);
    if (!f) return null;
    const cap = ctx.contextTokens * Math.max(1, ctx.slots);
    const held = (gen.promptTokens ?? 0) + (gen.decoded ?? 0);
    const layers = (f.prompt != null ? [{ k: "prompt", share: f.prompt }]
        : [{ k: "cached", share: f.cached ?? 0 }, { k: "computed", share: f.computed ?? 0 }]).concat([{ k: "decoded", share: f.decoded }]);
    return (
        <div class="rc-tip-kv sep">
            <div class="rc-tip-line">
                <span class="rc-tip-name">in the KV cache after this turn</span>
                <span class="rc-tip-size">{Math.min(held, cap).toLocaleString()} of {cap.toLocaleString()} tokens ({percentOf(Math.min(held, cap), cap)})</span>
            </div>
            <div class="rc-kvbar" style={model ? { "--model": colorFor(model) } : undefined} aria-hidden="true">
                {layers.map((l) => <i key={l.k} class={`rc-kvfill-${l.k}`} style={{ width: `${l.share * 100}%` }} />)}
            </div>
            {f.overflow ? <div class="rc-tip-note warn">More tokens than the cache holds — the context shifted, and older tokens were dropped to make room.</div> : null}
        </div>
    );
}

/** What a PROMPT-CACHE SWAP did, beside its duration: whether THIS conversation came back from RAM (the cache
 *  working — a near-total cache hit follows) or was not there (a full prefill follows), what was moved out, and
 *  what was thrown away to make room. An eviction is the one said as a warning: a conversation dropped from RAM
 *  pays a full prefill next time, and when two conversations take turns on one model under a limit too small for
 *  both, every turn evicts the one about to be needed — the thrash, which shows up as exactly this chip on turn
 *  after turn. */
/**
 * WHAT THE PREDICTOR EXPECTED, AGAINST WHAT THE LOAD TOOK — a load tooltip's section for whoever is tuning the
 * predictor, shown only with `predictView` on (the chart's gear).
 *
 * Every difference is taken against `forLoad`, the figure placement fits against; the bare `predicted` is
 * shown beside it but measuring the load against it makes the predictor look ~15% low for a reason that is not
 * an error. The PEAK is the row that decides whether a fit was safe — VRAM overshoots where it settles during a
 * load — so it leads. A load that took MORE than predicted is the dangerous direction and is flagged; less is
 * merely wasteful. Weights and KV are compared term by term and never summed: the prediction's split is the
 * metadata model's and covers only those two.
 */
function PredictionRows({ e, history }: { e: ResourceEvent; history: ResourceSample[] }) {
    const est = e.estimate;
    if (!est) return <div class="rc-tip-line sep"><span class="rc-tip-name">no prediction received for this load</span></div>;
    const target = est.forLoad ?? est.predicted;
    const trace = loadTrace(history, e);
    const diff = (bytes: number, against: number) => {
        const d = bytes - against, pct = against > 0 ? Math.round((d / against) * 100) : null;
        return <span class={`rc-chip ${d > 0 ? "rc-chip-warn" : "rc-chip-dim"}`}>
            {d >= 0 ? "+" : "−"}{formatBytes(Math.abs(d))}{pct != null ? ` (${d >= 0 ? "+" : ""}${pct}%)` : ""}</span>;
    };
    const basis = trace?.basis === "runner" ? "the runner's own memory" : "the cards' growth over their level before the load";
    return (
        <>
            <div class="rc-tip-line sep">
                <span class="rc-tip-name">predicted, for placement</span>
                <span class="rc-tip-size">{formatBytes(target)}</span>
            </div>
            <div class="rc-tip-chips">
                {est.source ? <span class="rc-chip">{est.source}</span> : null}
                {est.forLoad != null && est.forLoad !== est.predicted ? <span class="rc-chip rc-chip-dim">{formatBytes(est.predicted)} before the batch surcharge</span> : null}
                {est.numCtx != null ? <span class="rc-chip rc-chip-dim">num_ctx {est.numCtx.toLocaleString()}</span> : null}
                {est.numBatch != null ? <span class="rc-chip rc-chip-dim">num_batch {est.numBatch.toLocaleString()}</span> : null}
                {est.metadataComplete === false ? <span class="rc-chip rc-chip-dim">metadata incomplete</span> : null}
            </div>
            {trace?.peak ? <div class="rc-tip-line"><span class="rc-tip-name">peak during the load</span>{diff(trace.peak.bytes, target)}<span class="rc-tip-size">{formatBytes(trace.peak.bytes)}</span></div> : null}
            {trace?.final ? <div class="rc-tip-line"><span class="rc-tip-name">settled at</span>{diff(trace.final.bytes, target)}<span class="rc-tip-size">{formatBytes(trace.final.bytes)}</span></div> : null}
            {e.loadBytes != null ? <div class="rc-tip-line"><span class="rc-tip-name">resident (the server's count)</span>{diff(e.loadBytes, target)}<span class="rc-tip-size">{formatBytes(e.loadBytes)}</span></div> : null}
            {est.weights != null && e.measured ? <div class="rc-tip-line"><span class="rc-tip-name">weights: {formatBytes(est.weights)} predicted</span>{diff(e.measured.weights, est.weights)}<span class="rc-tip-size">{formatBytes(e.measured.weights)}</span></div> : null}
            {est.kvCache != null && e.measured ? <div class="rc-tip-line"><span class="rc-tip-name">KV cache: {formatBytes(est.kvCache)} predicted</span>{diff(e.measured.kvCache, est.kvCache)}<span class="rc-tip-size">{formatBytes(e.measured.kvCache)}</span></div> : null}
            {trace ? <div class="rc-tip-note">peak and settled are {basis}{trace.basis === "device" ? " — an eviction making room at the same time reads as negative growth" : ""}. The weights/KV split is the metadata model's, whatever the source.</div> : null}
        </>
    );
}

function SwapChips({ swap }: { swap: NonNullable<NonNullable<ResourceEvent["gen"]>["swap"]> }) {
    return (
        <>
            <span class="rc-chip rc-chip-dim">{swap.restored ? "this conversation restored from RAM" : "not in RAM — read from scratch"}</span>
            {swap.savedTokens != null
                ? <span class="rc-chip rc-chip-dim">{swap.savedTokens.toLocaleString()} tokens saved out{swap.savedBytes != null ? ` (${formatBytes(swap.savedBytes)})` : ""}</span> : null}
            {swap.evicted
                ? <span class="rc-chip rc-chip-warn">evicted {swap.evicted} {swap.evicted === 1 ? "conversation" : "conversations"}{swap.evictedBytes ? ` (${formatBytes(swap.evictedBytes)})` : ""} to make room — {swap.evicted === 1 ? "it" : "they"} will need a full prefill</span> : null}
            {swap.tooLarge ? <span class="rc-chip rc-chip-warn">the outgoing conversation was larger than the whole cache, so it was not kept</span> : null}
        </>
    );
}

/** Why the server gave no decode ceiling, in words a reader acts on. */
const CEILING_WHY: Record<string, string> = {
    mixture_of_experts: "no ceiling: a mixture-of-experts model reads only its active experts per token",
    partly_on_cpu: "no ceiling: part of this model runs from system RAM, which nothing here measures",
    bandwidth_unknown: "no ceiling: the card's memory bandwidth could not be read",
};

/** A generation's measured DECODE rate against the ceiling AT ITS CONTEXT (`decodeCeiling` at the mean
 *  occupancy over the decode, `prompt_tokens + decoded / 2`). Against the empty-context ceiling instead, a box
 *  holding a steady 80% reads as collapsing to 53% as the context grows — so that figure is never shown. Over
 *  100% on a dense model is a bug on one side, and is said rather than clamped. When there is no honest
 *  ceiling the server's reason is shown instead. */
function CeilingChip({ e }: { e: ResourceEvent }) {
    const r = e.genRoofline, g = e.gen;
    if (!r || !g || !g.decoded || !(g.evalMs > 0)) return null;
    if ("unavailable" in r) return <span class="rc-chip rc-chip-dim">{CEILING_WHY[r.unavailable] ?? `no ceiling: ${r.unavailable}`}</span>;
    const occ = (g.promptTokens ?? 0) + g.decoded / 2;
    const ceil = decodeCeiling(r, occ);
    if (ceil == null) return <span class="rc-chip rc-chip-dim">no ceiling at this context: the cache follows no single per-token rate</span>;
    const measured = g.decoded / (g.evalMs / 1000);
    const share = measured / ceil;
    return (
        <span class={`rc-chip ${share > 1.02 ? "rc-chip-warn" : "rc-chip-dim"}`}>
            {share > 1.02
                ? `above the computed ceiling (${ceil.toFixed(1)} tok/s) — one side's arithmetic is wrong`
                : `${Math.round(share * 100)}% of the memory-bandwidth ceiling at this context (${ceil.toFixed(1)} tok/s)`}
        </span>
    );
}

/** A generation's measured decode against the SERVER'S PREDICTION for it (`gen.end.predicted_decode`), beside the
 *  ceiling: the roofline says what memory bandwidth allows, this says what the box expected of this model at this
 *  context — made before the generation ran, so it is not fitted to the thing it is compared with. */
function PredictionChip({ e }: { e: ResourceEvent }) {
    const line = e.gen ? predictionLine(e.gen) : null;
    return line ? <span class="rc-chip rc-chip-dim">{line}</span> : null;
}

/** What the tip around an event says beyond the event itself: facts only the surface drawing it knows. */
export interface EventTipOpts {
    /** where a model runs, "local · ollama" or "cloud", or "" when nothing says */
    where?: (model: string) => string;
    /** show the run's hash: the lane is showing several sessions */
    showHash?: boolean;
    /** the load-prediction rows, measured against this memory history; null leaves them out */
    predict?: { history: ResourceSample[] } | null;
    /** whether a session the server names is one of this surface's own */
    ownSession?: (sess: string) => boolean;
    /** clicking the bar opens its step or run */
    clickable?: boolean;
}

/** WHAT ONE EVENT WAS, as the lane's tooltip says it: its kind, what it cost, how its time split into phases, what it
 *  waited on and what the server said about it. The panel wraps it in its hover (`EventTip`); a page with no panel
 *  (the bench's) wraps it in its own. */
export function EventTipBody({ e, clipped = false, opts = {} }: { e: ResourceEvent; clipped?: boolean; opts?: EventTipOpts }) {
    const { where = () => "", showHash = false, predict = null, ownSession = () => false, clickable = false } = opts;
    const dur = (e.until ?? e.t) - e.t;
    const ms = fmtDur;   // one duration scale for the whole panel — see timestamps.ts
    // Each phase's own duration, from where the previous one ended.
    // What getting TO the model cost. Wall MINUS generation is not that on its own: it also contains reading
    // the prompt, which is the model's own work and scales with the conversation. Reported as "network" it
    // over-charged the box for something the model did — so prompt eval comes out first, and what is left is
    // queue and network, which really are facts about the box and the moment.
    const promptMs = e.cost?.promptEvalMs ?? null;
    // …and LOADING comes out too, for exactly the same reason prompt eval does. Our wall clock starts when
    // the request goes out, so on a call that triggered a load it contains the whole load — measured at 70.8s
    // on a real box, reported as "+70884ms network", which is a claim about the box's networking that is off
    // by seventy seconds and points the reader at the wrong thing entirely. The load is drawn as its own
    // span; what is left after the model's own three durations is queue and network.
    const loadMs = e.cost?.loadMs ?? null;
    const overheadMs = e.cost?.evalMs != null && e.cost.wallMs != null
        ? Math.max(0, e.cost.wallMs - e.cost.evalMs - (promptMs ?? 0) - (loadMs ?? 0)) || null : null;
    const phases = (e.phases || []).map((ph, i) => ({ ...ph, from: i ? e.phases![i - 1].until : e.t }));
    // The two halves of a load, in bytes: the weights as the server measured them, and the context as the
    // difference between the whole load and the weights. Null unless the server reported both.
    const phaseBytes = (kind: string): number | null =>
        kind === "weights" ? (e.weightsBytes ?? null)
        : kind === "context" ? (e.loadBytes != null && e.weightsBytes != null ? e.loadBytes - e.weightsBytes : null)
        : null;
    // HOW MUCH DID NOT FIT. Null unless the server reported both figures AND they differ by enough to be a
    // real spill rather than the byte or two of bookkeeping that separates two independently-taken readings.
    const spilled = e.totalBytes != null && e.loadBytes != null && e.totalBytes - e.loadBytes > SPILL_FLOOR
        ? e.totalBytes - e.loadBytes : null;
    const first = phases[0];
    // A TOTAL record over the phase kinds, not a chain ending in a default. The chain shipped `weights` and
    // `context` — the two halves of a model load — as the word "tool", because an unknown kind fell through
    // to the tool branch and a fallback cannot tell "no name for this" from "this is a tool". Adding a phase
    // kind without naming it is now a compile error instead of a plausible wrong label.
    const PHASE_NAMES: Record<PhaseKind, string | (() => string)> = {
        model: () => e.model || "model",
        think: "thinking",
        answer: "answering",
        call: "emitting the tool call",
        wait: "waiting for approval",
        // The two halves of getting a model ready. NOT "warmup": the second half allocates the KV cache and
        // the compute buffers, which on a long-context model is most of the footprint — and the halves invert
        // between a cold load and a warm one, which is the whole reason to draw them apart.
        weights: "moving the weights in",
        context: "allocating the context",
        // Said as what it IS rather than as a label: the point of splitting a remote step is that these two
        // are not the tool being slow, and a reader should not have to know that to read the bar.
        dispatch: "dispatching the call",
        net: "network, there and back",
        queue: "queued before it started",
        // A sandbox fetching its runtime. Said as the thing it is, because a reader seeing four seconds in
        // front of a one-line script needs to know it was not the script.
        boot: "starting the sandbox (cold start)",
        tool: () => e.tool || "tool",
        // A generation's two halves, as the ENGINE timed them, and what lies around them. Said as what each
        // is, since "prefill" is jargon a reader should not need to know to read a bar.
        prefill: "reading the prompt (prefill)",
        decode: "generating tokens (decode)",
        other: "neither — scheduling and setup around the call",
        // Moving conversations' KV caches between the slot and host RAM before the prefill — the engine's own
        // measure, and in no other timing.
        swap: "swapping conversations through the RAM cache",
        // The first stretch of a call whose wall clock contained a load: the model arriving. Named, because left
        // inside the model's time it was the tooltip's "scheduling and setup", seconds of it, pointing nowhere.
        load: () => `waiting for ${e.model || "the model"} to load`,
    };
    const nameFor = (kind: string) => {
        const n = PHASE_NAMES[kind as PhaseKind];
        // A kind from OUTSIDE the union — the export's phase kinds are `@unstable` and another producer may
        // time something we have no concept of. Show the kind itself: it is at least true.
        return typeof n === "function" ? n() : (n ?? kind);
    };
    // A run span has no phases and no cost of its own — it is the CONTAINER. Saying "click to open this step"
    // under it was wrong twice over: it is not a step, and its ref carries no seq to scroll to.
    const isRun = e.kind === "run" || e.kind === "session";
    // An INSTANT has no duration and no cost — it is a moment, and the tooltip built for spans reported it as
    // "0ms" with its label dropped entirely, which said nothing at all about the thing you were pointing at.
    const instant = e.until == null;
    if (instant) return (
        <>
            <div class="rc-tip-line">
                {e.model ? <i class="rc-tip-dot" style={{ background: colorFor(e.model) }} /> : null}
                <span class="rc-tip-name">{e.model || e.label}</span>
                {/* WHEN, not how long: that is the only quantity a moment has. */}
                <span class="rc-tip-size">{hhmmssms(e.t)}</span>
            </div>
            {/* WHAT THIS EDGE IS, said differently depending on where it CAME FROM.
                An inferred one is read off `/api/ps` by noticing a model was there and then was not, and the
                note says so. A REPORTED one came from the server's own event stream, which knows things
                polling cannot — above all an OOM-retry eviction and its reason, told from an ordinary unload — so it says
                what the server said. Hardcoding the inference note for both claimed "nothing reports an
                eviction" about an edge the server had just reported, on exactly the setup the stream exists
                for, and hid the reason it had gone to the trouble of sending. */}
            <div class="rc-tip-note">{e.via === "server"
                ? serverSaid(e.label, e.model)
                : e.kind === "evict"
                    ? "left memory here — nothing reports an eviction, so this is the sample where it stopped being resident"
                    : e.kind === "load" ? "appeared here — loaded by something else, or while the panel was closed"
                        : e.label}</div>
        </>
    );
    return (
        <>
            {/* Each phase, in the order it happened: the model, the human deciding, then the tool. */}
            <div class="rc-tip-line">
                {/* The header names the WHOLE block, so it carries a swatch only when the whole block is one colour
                    (no phases: the model's). A phased block is several colours, and the header used to take its
                    FIRST phase's swatch, so a step that began by waiting for a load led with a hollow ring that
                    described one stretch of the bar while the line beside it named all of it. Each phase row
                    below carries its own swatch. */}
                {!first && e.model ? <i class="rc-tip-dot" style={phaseSwatch("model", e.model)} /> : null}
                {/* WHAT THIS BLOCK IS, always — its own label ("qwen:32b serving", "loading gemma4:e2b"), not
                    a hardcoded "run" and not just the model name. The first PHASE used to take this line,
                    which meant a machine event with no phases said nothing but the model: a serving span and
                    a load looked identical, and neither said which it was. Phases are rows below now, all of
                    them, so the header is the identity and the rows are how the time split. */}
                <span class="rc-tip-name">{e.label || e.model}</span>
                {/* THE MODEL, on every span that has one and does not already say it. This used to be the aside's
                    alone, on the argument that every other span runs on the session's own model — but a tooltip is
                    read on its own, over a chart that draws several models, and a step named only by its tool
                    ("agent_api_docs") left the reader to work out which model generated it. A label that already
                    names the model ("loading qwen3.8…", "qwen:32b serving") is not repeated. */}
                {e.model && !(e.label || "").includes(e.model) ? <span class="rc-tip-aside-model">{e.model}</span> : null}
                <span class="rc-tip-size">{ms(dur)}</span></div>
            {/* WHICH SESSION this belongs to — only while the lane is showing every session. Scoped, every
                block on screen is from the one you are reading, and the pill would repeat the same eight
                characters on every tooltip to say nothing. */}
            {/* WHERE this model runs. A cloud model occupies no local memory ever, so a span with no matching
                line in the chart above is expected of it and puzzling for a local one — the tooltip is the
                place that difference belongs. Omitted when provenance is UNKNOWN (an unpatched server lists
                no ollama ids), because guessing "cloud" from an absence would be a claim we cannot make. */}
            {(showHash && e.ref?.hash) || (e.model && where(e.model))
                ? <div class="rc-tip-chips">
                    {e.model && where(e.model)
                        ? <span class="rc-chip rc-chip-dim">{where(e.model)}</span> : null}
                    {showHash && e.ref?.hash
                        ? <span class="rc-chip rc-chip-hash">{e.ref.hash}</span> : null}
                </div> : null}
            {/* The figures as BADGES, the same little blocks the model rows use. Loose text on two dim lines
                gave no way to tell which numbers belonged together; a chip is visibly one fact. */}
            {e.cost ? (
                <div class="rc-tip-chips">
                    <span class="rc-chip">{e.cost.inTokens.toLocaleString()} in</span>
                    {/* How many of those the prefix cache served — the reason a long prompt can take no time.
                        "cold" only when the server said 0; nothing when it said nothing. */}
                    {e.cost.cachedTokens != null ? <span class="rc-chip rc-chip-dim">{e.cost.cachedTokens > 0 ? `${e.cost.cachedTokens.toLocaleString()} from cache` : "cold, none cached"}</span> : null}
                    <span class="rc-chip">{e.cost.outTokens.toLocaleString()} out</span>
                    {e.cost.tokPerSec != null ? <span class="rc-chip">{e.cost.tokPerSec.toFixed(1)} tok/s</span> : null}
                    {/* A rate's basis is part of the rate: generation-only and wall-clock measure different
                        things, and the bare number would imply a precision it doesn't have. */}
                    {e.cost.genBasis ? <span class="rc-chip rc-chip-dim">{e.cost.genBasis === "eval" ? "generation only" : e.cost.genBasis === "wall" ? "incl. network" : "mixed timing"}</span> : null}
                    {/* When BOTH timings are known, their difference is the network and the queue — a
                        different diagnosis from a slow model, and not recoverable from the rate alone. */}
                    {promptMs != null ? <span class="rc-chip rc-chip-dim">{Math.round(promptMs)}ms reading the prompt</span> : null}
                    {overheadMs != null ? <span class="rc-chip rc-chip-dim">+{Math.round(overheadMs)}ms network</span> : null}
                </div>
            ) : null}
            {/* A SEPARATOR IS A BORDER ON THE SECTION IT OPENS, never an element of its own. A standalone rule
                can end up with nothing on one side of it — first, last, or next to another rule — and then
                it is a line dividing nothing, which this tooltip produced in three different ways before it
                was made structurally impossible. A border cannot exist without the content it belongs to. */}
            {phases.map((ph, i) => (
                <>
                    {/* THREE COLUMNS: the swatch, a body that wraps (the name, then its chips), and the duration. As one
                        wrapping flex row it inherited `space-between`, so a row whose chips did not fit spread its first
                        line: the swatch at the left edge, the name pushed right or centred, the duration a line of its own. */}
                    <div class="rc-tip-line sep rc-tip-phase" key={i}>
                        <i class="rc-tip-dot" style={phaseSwatch(ph.kind, e.model)} />
                        <span class="rc-tip-phase-body">
                        {/* A bare "exec" reads as a label of unknown kind. Saying what it IS — a tool call,
                            with the name as code — is the difference between a word and an identifier. */}
                        <span class="rc-tip-name">{ph.kind === "tool"
                            ? <>tool call: <code>{e.tool}</code></>
                            : nameFor(ph.kind)}</span>
                        {/* WHAT IT MOVED, beside how long it took. A six-second weights step that moved 17
                            GiB reads very differently from one that moved 300 MiB, and the duration alone
                            cannot tell them apart. Only when the server measured it. */}
                        {phaseBytes(ph.kind) != null
                            ? <span class="rc-chip rc-chip-dim">{formatBytes(phaseBytes(ph.kind)!)}</span> : null}
                        {/* WHAT EACH HALF OF A GENERATION DID, in the engine's own counts. The prompt count alone
                            hides a cache hit completely — it is the same either way — so the cached share is said
                            beside it, and "cold" only when the server said 0, never when it said nothing. */}
                        {ph.kind === "prefill" && e.gen?.promptTokens != null ? <span class="rc-chip rc-chip-dim">{e.gen.promptTokens.toLocaleString()} tokens
                            {e.gen.promptTokensCached != null ? (e.gen.promptTokensCached > 0 ? ` · ${e.gen.promptTokensCached.toLocaleString()} from cache` : " · cold, none cached") : ""}</span> : null}
                        {ph.kind === "decode" && e.gen?.decoded != null ? <span class="rc-chip rc-chip-dim">{e.gen.decoded.toLocaleString()} tokens
                            {e.gen.evalMs > 0 ? ` · ${(e.gen.decoded / (e.gen.evalMs / 1000)).toFixed(1)} tok/s` : ""}</span> : null}
                        {ph.kind === "decode" ? <><CeilingChip e={e} /><PredictionChip e={e} /></> : null}
                        {ph.kind === "swap" && e.gen?.swap ? <SwapChips swap={e.gen.swap} /> : null}
                        </span>
                        <span class="rc-tip-size">{ms(ph.until - ph.from)}</span></div>
                </>
            ))}
            {e.gen && e.genCtx ? <KvBar gen={e.gen} ctx={e.genCtx} model={e.model} /> : null}
            {/* An OPEN span has no end yet, so every duration in this tooltip is "so far". Said once, plainly,
                because the alternative is a reader taking a number that is still growing as a measurement. */}
            {e.open ? <div class="rc-tip-note">still running — these durations are so far, not final</div> : null}
            {/* A DEGRADED LOAD, and the only place the fact exists. When the prediction was too low,
                llama-server re-fits against the memory actually free and runs the remainder on the CPU: the
                load SUCCEEDS, nothing errors, and the model is simply slow from then on. The difference
                between what the whole model is and what reached the device is the only signal, so it is
                stated in words rather than left as two numbers to subtract. */}
            {spilled != null
                ? <div class="rc-tip-note warn">{formatBytes(spilled)} of this model did not fit — it is
                    running on the CPU, which is why it will be slow. No error is raised for this.</div>
                : null}
            {predict && e.kind === "load" ? <PredictionRows e={e} history={predict.history} /> : null}
            {/* ONE rule opens the footer, and the PROSE comes first inside it. The notes explain the block —
                "the model wasn't resident", "continues past what was measured" — and they were sitting under
                the timestamp, which read as a caption on the clock rather than on the thing. The timestamp is
                the reference line: quiet, last, and the part you go looking for rather than read.

                One rule, not two: ruling the timestamp on both sides put a divider above and below a single
                line, which reads as an empty boxed cell rather than as two sections. */}
            {/* The footer opens with a border on whichever of these actually renders — `sepFirst` hands it to
                the first one, so the section is separated exactly when it has something in it. */}
            {(() => {
                const notes = [
                    e.kind === "load" ? "the model wasn't resident — this is the wait before a token" : null,
                    // Said plainly, because a bar in a run's lane that is not part of the run is exactly the
                    // sort of thing a reader would otherwise spend a minute misattributing.
                    e.kind === "aside" ? "you triggered this while reading — NOT part of the run, and not counted in its tokens" : null,
                    // A generation the SERVER reported and no session of ours matched: another client's traffic.
                    // Said, because a bar nobody here caused otherwise reads as something this browser did.
                    // With a hint the server echoed, it also says WHOSE and what kind of work (`serverGenNote`).
                    e.kind === "gen" && e.via === "server" ? serverGenNote(e.hint, ownSession) : null,
                    clipped ? "continues past what was measured" : null,
                    clickable && e.ref ? `click to open this ${e.ref.seq != null ? "step" : "run"}` : null,
                ].filter(Boolean) as string[];
                return notes.map((n, i) => <div class={`rc-tip-note${i === 0 ? " sep" : ""}`} key={n}>{n}</div>);
            })()}
            {/* WHEN, exactly. The durations say how long each part took; this is what lets a block be lined up
                against another one, or against a timestamped log. Milliseconds because an event's own timings
                are exact — unlike the crosshair, which interpolates between samples. */}
            <div class={`rc-tip-when${(e.kind === "load" || e.kind === "aside" || (e.kind === "gen" && e.via === "server") || clipped || (clickable && e.ref)) ? "" : " sep"}`}>{hhmmssms(e.t)} → {hhmmssms(e.until ?? e.t)}</div>
        </>
    );
}

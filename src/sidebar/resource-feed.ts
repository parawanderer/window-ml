// resource-feed.ts — everything that brings the resource panel its data: the model list, the `/api/ps` poll, the
// server's event stream (`connectResourceStream`), capacity from `/api/info`, the backend health probe, and the
// machine events (loads, evictions, generations) turned from those into lane spans.
//
// No JSX: this is the panel's INPUT, written into panel-state and store, and read by every view that draws from
// them. It lived in vram.tsx beside the panel component, which made the component file the data layer too.

import { signal } from "@preact/signals";
import { type LoadedModel, isBackendUnreachable } from "../contract/contract-server";
import type { WireFrame } from "../events-wire";
import { genTimingsFrom, predictedDecodeFrom, genSpan, hintFrom } from "../resource-gens";
import { addMachineEvent } from "../resource-lane";
import { type ModelResidency, memorySplit, type MemoryBreakdown, placementFrom, boxChange, sameBoxOnly, type LoadEstimate, normModel, estimateFrom, type ResourceSample } from "../resource-model";
import { type ResourceEvent } from "../resource-timeline";
import { activityFrom, rooflineFrom, expectedDecodeFrom } from "../resource-decode";
import { type SeenCards, type Capacity, noteSeenCards, type UnavailableGpu, unavailableFrom, holdCapacity, parseInfo } from "../resource-capacity";
import { seenContext } from "./model";
import { capacity, resourceHistory, layout, streamLive } from "./panel-state";
import { models, ollamaIds, modelKinds, config, psError, backendAliveAt, loadedModels, backendLoading, sidebarOpen, vramOpen, view, backendError, unreachableIfNothingSaysOtherwise } from "./store";

/** A LoadedModel (the ps relay's shape) → the residency the chart works in. Bytes, never the rounded GB: the
 *  bands subtract these from exact capacity figures. `gpus` absent means CPU-resident, and that absence is
 *  preserved as an empty device map rather than invented placement. */
export function residencyOf(m: LoadedModel): ModelResidency {
    const vram = m.vramBytes ?? 0, size = m.sizeBytes ?? 0;
    const perDevice: Record<string, number | null> = {};
    for (const g of m.gpus ?? []) perDevice[g.id] = g.vramBytes === 0 && vram > 0 ? null : g.vramBytes;
    // Parsed HERE, once — `memorySplit` is what checks the server's sum invariant, so every consumer reads a
    // split that has already been refused if it did not add up.
    const whole = memorySplit(m.memory, vram);
    const per: Record<string, MemoryBreakdown> = {};
    for (const g of m.gpus ?? []) {
        const one = memorySplit(g.memory, g.vramBytes ?? 0);
        if (one) per[g.id] = one;
    }
    const host = memorySplit(m.memoryHost, 0);
    return {
        model: m.model, vramBytes: vram, ramBytes: Math.max(0, size - vram), perDevice,
        contextLength: m.contextLength, expiresAt: m.expiresAt ? Date.parse(m.expiresAt) || null : null,
        ...(whole ? { memory: whole } : {}),
        ...(Object.keys(per).length ? { perDeviceMemory: per } : {}),
        ...(typeof m.weightsOnDisk === "number" ? { weightsOnDisk: m.weightsOnDisk } : {}),
        ...(host ? { memoryHost: host } : {}),
        ...((() => { const pl = placementFrom(m.placement); return pl ? { placement: pl } : {}; })()),
        ...((() => { const ac = activityFrom(m.activity); return ac ? { activity: ac } : {}; })()),
        ...((() => { const rf = rooflineFrom(m.roofline); return rf ? { roofline: rf } : {}; })()),
        ...((() => { const ed = expectedDecodeFrom(m.expectedDecode); return ed ? { expectedDecode: ed } : {}; })()),
    };
}

// Fetch the server's model list via the background worker (privileged fetch);
// degrade silently if unreachable. Populates the datalists.
export function fetchModels(): void {
    // `kinds: true` so the panel knows what each model IS, not just that it exists. An embedding model and a
    // chat model occupy memory identically and read identically in a list of names; the difference is the
    // first thing you want when a row you did not expect is holding a card.
    chrome.runtime.sendMessage({ type: "LIST_MODELS", payload: { kinds: true } }, (resp: any) => {
        if (chrome.runtime.lastError || !resp || resp.error) return;
        models.value = resp.data || [];
        ollamaIds.value = resp.ollamaModels ?? null;   // null = provenance unknown (skip cloud detection)
        if (resp.kinds) modelKinds.value = resp.kinds;
    });
}

// Session-long history, in a MODULE signal rather than component state: the old panel kept 45 samples in
// useState and threw them away on every close, so "what happened during that run" was unanswerable the moment
// you looked away. Session-only by choice: it dies with the page, and gaps (the panel was closed, so nothing
// was polled) stay gaps.
//
// BOUNDED BY TIME AS WELL AS BY COUNT, because the sampling rate is no longer uniform. 900 was sized as
// "~30 min at 2s"; a patched box now samples at 250ms while a load is in flight and around 16s when idle, so
// one 60-second load costs 240 slots where a minute of idle costs four. A handful of loads would evict the
// whole idle history and leave the chart with three minutes of wall time under a window set to thirty. The
// count stays as the MEMORY ceiling; the horizon is what decides what is worth keeping, and it is set past
// the longest window the chart offers so "Everything kept" still has everything it can draw.
export const RESOURCE_HISTORY = 5000;

/** How far back the sample history is kept, past the longest window the chart can be set to draw. */
export const RESOURCE_RETENTION_MS = 45 * 60_000;

// Machine CAPACITY — the denominator. The TOTALS change only when hardware does, but `free_memory` rides in
// the same payload and changes with every load and evict, so fetching once per open froze the free and
// residual bands at whatever they were when you opened the panel (a card would read "18 GiB in use" beside
// "free 94.42 GiB"). Refreshed on a SLOWER cadence than ps instead: often enough to track occupancy, rarely
// enough not to hammer a route whose totals never move.
// null = unknown (the route isn't served): the chart then draws no ceiling rather than pretending it is zero.
export const CAPACITY_EVERY = 5;   // ps polls between capacity refreshes (5 x 2s = 10s)

let psSinceCapacity = 0;

// Whether we have ASKED yet. `capacity: null` alone can't tell "the fetch hasn't come back" from "this server
// doesn't serve /api/info", and the fallback for the second is the old sparkline — so on every open the panel
// flashed the legacy chart for a moment before the tracks replaced it. Until the first answer lands the plot
// is simply empty.
export const capacityAsked = signal(false);

/** What each bus address was last seen as, per backend (`SeenCards`) — so a card that has faulted, and so left the
 *  enumeration, can still be named. Kept in storage.local: the card is usually already down when the panel opens. */
export const seenCards = signal<SeenCards>({});

const SEEN_CARDS_KEY = "ml_res_seen_cards";

const backendKey = (): string => { try { return new URL(config.value.chatUrl || "").origin; } catch { return ""; } };

let seenLoaded = false;

function noteSeen(cap: Capacity | null): void {
    const key = backendKey();
    const next = noteSeenCards(seenCards.value, cap);
    if (next === seenCards.value) return;
    seenCards.value = next;
    try {
        chrome.storage.local.get({ [SEEN_CARDS_KEY]: {} }, (d: any) => {
            const all = (d && d[SEEN_CARDS_KEY]) || {};
            chrome.storage.local.set({ [SEEN_CARDS_KEY]: { ...all, [key]: { ...(all[key] || {}), ...next } } });
        });
    } catch { /* opaque origin: session memory only */ }
}

/** Load what this backend's cards were last seen as, once, before the first reading needs it. */
export function loadSeenCards(): void {
    if (seenLoaded) return;
    seenLoaded = true;
    try {
        chrome.storage.local.get({ [SEEN_CARDS_KEY]: {} }, (d: any) => {
            const mine = ((d && d[SEEN_CARDS_KEY]) || {})[backendKey()] || {};
            seenCards.value = { ...mine, ...seenCards.value };
        });
    } catch { /* opaque origin */ }
}

/** GPUs the server can SEE and cannot USE, from wherever it last said so. A signal of its own rather than a
 *  read of `capacity.value.unavailable`, because it arrives by TWO routes and the earlier one carries no
 *  capacity at all: the `hello` frame, on every connect, and `/api/info` on every sample thereafter.
 *
 *  The hello route is the one that matters and it is not an optimisation. The reference machine's fault began
 *  at 05:51 and was still unreported when a client connected hours later — hardware does not wait for a
 *  subscriber, so an edge-only signal is silent in exactly the situation it exists for. Last writer wins,
 *  which is correct here: both routes report the server's current answer, and `hello` simply gets there first
 *  on a fresh open. */
export const unavailableGpus = signal<UnavailableGpu[]>([]);

/** One reading of the machine's CAPACITY, from a poll or from a `sample` frame's embedded `/api/info` body.
 *  Same rule as {@link applyLoaded}: one parser, one place it becomes state. */
export function applyInfo(raw: unknown): void {
    capacityAsked.value = true;
    {
        // BEFORE the early return below. That return means "this poll learned nothing new about CAPACITY",
        // which is a different question — a card faulting changes this list while every surviving pool's
        // ceiling stays exactly where it was, so folding the two would report the fault only if it happened
        // to coincide with a capacity change.
        //
        // A FULL `/api/info` BODY IS AUTHORITATIVE FOR THIS LIST, and an absent key in one means "nothing to
        // report" — which CLEARS the banner. That is the server's contract: on a healthy box the field is
        // ABSENT rather than `[]`. The distinction that matters is three-way, not two: no body at all means
        // this reading learned nothing (keep what we have); a body without the key means nothing to report
        // (clear it); a body with it means that list.
        //
        // An earlier version kept the last report whenever the key was absent, and that was WRONG in the way
        // that matters most: a GPU that faulted and then RECOVERED makes the field disappear, so the banner
        // would have stood for good, reporting a fault that was gone. It was written to fix a test in which
        // the hello carried a fault and the next sample did not — a combination the real server cannot
        // produce, since both are built from one cached probe. The fixture was inconsistent, not the server.
        const compute = (raw as { compute?: { unavailable_gpus?: unknown } } | null)?.compute;
        if (compute) unavailableGpus.value = unavailableFrom(compute.unavailable_gpus);
    }
    {
        const next = holdCapacity(capacity.value, parseInfo(raw));
        noteSeen(next);
        if (!next || next === capacity.value) return;   // this poll learned nothing new
        // Pointing at a DIFFERENT machine (a CUDA server, then a Metal Mac) invalidates the history: those
        // samples were measured against another ceiling, on devices whose ids mean different hardware. Drawing
        // them here would clip an 18 GiB band against an 11.84 GiB ceiling and look like a reading.
        // A SWITCH means one known box replaced by a different known box. The first fetch (unknown → known)
        // is not one: treating it as such would drop every sample taken before capacity arrived, which on a
        // fresh open is all of them — the panel would render nothing until the next poll.
        // Not every difference is a different machine. A card that VANISHES mid-session is an incident, and
        // the samples leading up to it are the most valuable ones on screen — so only a genuine switch (other
        // hardware, or a device's identity changing under the same id) drops the history.
        const change = boxChange(capacity.value, next);
        const switched = change === "switched";
        // On a switch, drop samples that can't be attributed to EITHER box as well — an unattributed sample is
        // backfilled with the current capacity at render, which after a switch means drawing the old machine's
        // readings against the new machine's ceiling.
        // A device set that grew or shrank still invalidates the LAYOUT — a track naming a device that is no
        // longer there would silently render nothing — so the layout is re-derived either way.
        if (switched || change === "shrank" || change === "grew") {
            resourceHistory.value = sameBoxOnly(resourceHistory.value, next, switched);
            // The LAYOUT is per-box too: one naming `vram.1` is meaningless on a machine with one device, and
            // TrackView would silently drop those tracks rather than falling back to something that fits.
            // Clearing it re-runs restoreLayout against the NEW box, where presetRefusal rejects a stale saved
            // layout and hands back that box's default.
            layout.value = null;
        }
        capacity.value = next;
    }
}

/** Ask the box what it can hold. A non-JSON body means the route is not served (OpenWebUI answers with its
 *  SPA's HTML), which is "unknown" — never zero. */
export function fetchCapacity(): void {
    if (streamLive.value) return;   // the stream carries `info` on its sample frames
    chrome.runtime.sendMessage({ type: "OLLAMA_INFO", payload: {} }, (resp: any) => {
        capacityAsked.value = true;
        if (chrome.runtime.lastError || !resp || resp.error) return;   // leave capacity unknown
        // Asked before the stream went live and answered after: the stream's frames are newer, and a full
        // body is authoritative — its absent `unavailable_gpus` would clear a fault the hello just reported.
        // Only once the stream has actually CARRIED `info`, though: it rides a sample frame when it changes,
        // and `hello` carries none, so on a quiet box this reply may be the only reading there is.
        if (streamLive.value && streamInfoSeen) return;
        applyInfo(resp.data);
    });
}

/** What the stream told us when it could not carry: shown in the panel's own note rather than swallowed, so a
 *  box that has the route but is failing on it does not look like a box that never had it. */
export const streamNote = signal<string | null>(null);

/** Set when the stream reports it dropped frames for us; consumed by the NEXT reading, which then begins a new
 *  run rather than continuing the line across the hole. A flag rather than a signal, and deliberately: it is
 *  written while frames are being handled and read a moment later inside `applyLoaded`, which is a render path
 *  — a signal written during render re-enters rendering, and this is not state anything draws from.
 *
 *  It is a PENDING mark rather than one applied to the frame that reported it, because the drop happened
 *  BEFORE that frame: the hole sits between the last reading we recorded and whatever the next one turns out
 *  to be, and the next one may arrive by the poll rather than by the stream. Either way it is the reading on
 *  the far side of the hole, which is the one that must not be joined to what came before it. */
let pendingGap = false;

/** Frames the stream has told us it lost, this session. Read by the tests and by `ml.__events`; the panel
 *  itself says so by BREAKING the line, which is the same thing it does for a sampling gap and needs no
 *  second vocabulary. */
export const framesLost = signal(0);

/** Machine events the SERVER reported, as opposed to the ones we infer by diffing polls. A load is the case
 *  that cannot be inferred at all: for most of a load there is no runner object in Ollama for a poll to
 *  observe (measured: `load.start` at t=4102, `load.complete` at t=48053, `/api/ps` empty across the whole
 *  span), so every load span drawn from polling was reconstructed from the `load_duration` of whichever
 *  request happened to be waiting. These are the edges themselves. Bounded, because a long session on a busy
 *  box accumulates them and the lane only ever draws a window. */
export const MACHINE_EVENTS_CAP = 400;

// THE BOX'S OWN EDGES — loads, evictions, serving periods — from the server's event stream when it has
// one, else inferred by diffing polls. Deduped on reconnect, because a fresh worker asks for the whole
// retained ring and would otherwise draw every span twice.
export const machineEvents = signal<ResourceEvent[]>([]);

/** Loads that have started and not yet completed, so `load.complete` can close the span it opened. */
const openLoads = new Map<string, { t: number; weightsAt?: number; weightsBytes?: number }>();

/** Generations that have started and not yet ended, PER MODEL and in order — generations interleave across
 *  models (one capture: gemma opened, granite opened and closed, gemma closed), so one slot per model is the
 *  key, and a queue within it covers a server running more than one slot. */
const openGens = new Map<string, number[]>();

/** When each model's most recent LOAD finished, so a generation that was waiting on it starts where the load
 *  ended rather than drawing the load's seconds a second time (see `genSpan`). */
const loadEndedAt = new Map<string, number>();

/** The predictor's last word on each model's pending load (an `estimate` frame), held until the load closes
 *  and then carried on its span. A retried attempt sends a new estimate, which replaces the old one. */
const pendingEstimate = new Map<string, LoadEstimate>();

/** WHICH MODELS ARE LOADING RIGHT NOW — the open half of `openLoads`, as a signal so a reading can carry it.
 *
 *  This is the answer to a question `/api/ps` cannot be asked: for most of a load Ollama has no runner object
 *  at all, so ps is not vague about the model, it omits it entirely — measured at 22 consecutive samples
 *  across one load, with the card sitting at 76.78 then 87.82 GiB the whole time. Without this the panel drew
 *  that as "unattributed 87.82 GiB" beside a model row reading "off-box", which are two confident claims made
 *  out of an absence of evidence. */
export const loadingModels = signal<string[]>([]);

/** Models the last `/api/ps` reading reported as arriving — a `loading` row with no runner behind it yet.
 *  The stream's `load.start` says the same thing and says it sooner, but a stock server has no stream, and
 *  this is the only place that server ever admits a load is happening. */
export const psLoading = signal<string[]>([]);

const noteLoading = (): void => { loadingModels.value = [...openLoads.keys()]; };

/** Models currently SERVING, by the instant they started. A signal because a span that is still open has to
 *  be drawn while it is happening — that is the whole point of knowing when responding began — and the lane
 *  synthesizes it against `now` on every render.
 *
 *  These are transitions in and out of IDLE, not per request: two overlapping generations produce one span,
 *  so this counts working PERIODS. Per-request accounting is a different signal and does not exist. */
export const servingSince = signal<Record<string, number>>({});

const pushMachine = (e: ResourceEvent): void => {
    // DEDUPED, because a reconnect replays history we already hold — see `addMachineEvent`.
    machineEvents.value = addMachineEvent(machineEvents.value, e, MACHINE_EVENTS_CAP);
};

/** What each `unload` reason means, in the lane's words (events.proto, and the fork's report of 2026-09-17). */
const UNLOAD_WHY: Record<string, string> = {
    expired: "its keep-alive ran out",
    requested: "on request",
    displaced: "displaced to make room for another load",
    leased: "a job outside ollama took the GPUs",
    "load-failed": "its own load failed",
    "oom-retry": "out of memory: everything resident was dropped to retry",
};

/** One edge frame → what the lane draws. Returns nothing for the frames that are not events in their own
 *  right (`sample`, `heartbeat`, `hello`) and for a `load.complete` with no start to close, which is what a
 *  reconnect mid-load looks like — half a span is worse than none, since its left edge would be invented. */
export function machineEventFrom(frame: Pick<WireFrame, "kind"> & Omit<Partial<WireFrame>, "kind">, at: number): ResourceEvent | null {
    // CANONICALISED ONCE, here at the boundary, so nothing downstream has to know that the same model has two
    // spellings on one server: the stream says `registry.ollama.ai/library/gemma4:31b`, `/api/ps` says
    // `gemma4:31b`. Matching them late — at the colour, at the legend, at the off-box check — means every new
    // comparison is a fresh chance to forget, and forgetting draws a second model that does not exist.
    const model = frame.model ? normModel(frame.model) : undefined;
    switch (frame.kind) {
        case "estimate": {
            const est = estimateFrom(frame.estimate);
            if (model && est) pendingEstimate.set(model, est);
            return null;                                    // carried on the load it predicted, when that closes
        }
        case "load.start":
            if (model) { openLoads.set(model, { t: at }); noteLoading(); }
            return null;                                    // the SPAN is emitted when it closes
        case "load.weights":
            // The boundary between the weights arriving and the context (KV cache + compute buffers) being
            // allocated. NOT "warmup": the second half allocates, and on a long-context model it allocates
            // most of the footprint — measured as a second step ~6s after the weights, immediately before the
            // model is ready. Held until the span closes, since it is a divider inside it.
            if (model && openLoads.has(model)) {
                const open = openLoads.get(model)!;
                open.weightsAt = at;
                // HOW MUCH the weights were, as the server measured it. The durations say how long each half
                // took; this says what each half MOVED, which is the other half of the same question — and a
                // 6s weights step that moved 17 GiB reads very differently from one that moved 300 MiB.
                open.weightsBytes = frame.size_vram ?? undefined;
            }
            return null;
        case "load.complete": {
            const open = model ? openLoads.get(model) : undefined;
            if (!model || !open) return null;
            openLoads.delete(model); noteLoading();
            loadEndedAt.set(model, at);
            const estimate = pendingEstimate.get(model);
            pendingEstimate.delete(model);
            const measured = frame.size_vram != null ? memorySplit(frame.memory, frame.size_vram) : null;
            // The server reports the split DIRECTLY when it can (`weights_ms`/`context_ms` on the closing
            // edge), and that is the form to prefer: differencing two frames only works for a client that was
            // already connected when the load began, so a panel opened mid-load lost the divider entirely.
            // The `load.weights` edge stays as the fallback for a server that does not send the durations.
            const w = frame.weights_ms != null && frame.context_ms != null
                ? at - frame.context_ms
                : open.weightsAt;
            return {
                t: open.t, until: at, kind: "load", label: `loading ${model}`, model, via: "server" as const,
                // What the two halves each moved, when the server reported it. `size_vram` on the closing
                // edge is the WHOLE load; the weights' own figure came on the boundary edge, so the context
                // is the difference. They differ from the device's own step by the CUDA context floor
                // (~0.69 GiB per card) — that is agreement, not drift, and must not be reconciled away.
                ...(open.weightsBytes != null ? { weightsBytes: open.weightsBytes } : {}),
                ...(frame.size_vram != null ? { loadBytes: frame.size_vram } : {}),
                // THE WHOLE MODEL, against what reached the device. Equal when it fit; when it did not,
                // llama-server re-fit against the memory actually free and ran the remainder on the CPU —
                // which succeeds and is merely slow, with no error anywhere. This difference is the only
                // signal that happened.
                ...(frame.size_total != null ? { totalBytes: frame.size_total } : {}),
                // What the predictor expected, beside what the load held by kind — for tuning the predictor.
                ...(estimate ? { estimate } : {}),
                ...(measured ? { measured } : {}),
                // "Resident at 4s, usable at 10s" — the two halves are weights and context, and the divider
                // only exists when the server actually reported it.
                ...(w && w > open.t && w < at
                    ? { phases: [{ kind: "weights" as const, until: w }, { kind: "context" as const, until: at }] }
                    : {}),
            };
        }
        // WHEN RESPONDING BEGAN. `busy.start` coincides with `load.complete` when the request is what
        // triggered the load, so the two spans sit end to end and the story reads straight through: weights,
        // context, serving. A model loaded and then left alone gets no `busy.start` at all, so the pair is
        // not guaranteed and must not be assumed.
        case "busy.start":
            if (model) servingSince.value = { ...servingSince.value, [model]: at };
            return null;                                    // the SPAN is emitted when it closes
        case "busy.end": {
            const from = model ? servingSince.value[model] : undefined;
            if (model) { const next = { ...servingSince.value }; delete next[model]; servingSince.value = next; }
            return model && from ? { t: from, until: at, kind: "serve", label: `${model} serving`, model } : null;
        }
        // A GENERATION, split into prefill and decode by the engine's own durations (see `genSpan`). The
        // opening edge is held, not drawn: the span needs its end, and the split is anchored there.
        case "gen.start":
            if (model) openGens.set(model, [...(openGens.get(model) ?? []), at]);
            return null;
        case "gen.end": {
            if (!model) return null;
            const q = openGens.get(model) ?? [];
            const startAt = q.shift();
            if (q.length) openGens.set(model, q); else openGens.delete(model);
            const timings = genTimingsFrom(frame.timings);
            // The server's prediction for this generation, made before it ran: carried WITH the figures, so a
            // generation joined to our own call keeps it (see `predictionLine`).
            const predicted = predictedDecodeFrom((frame as { predicted_decode?: unknown }).predicted_decode);
            if (timings && predicted) timings.predicted = predicted;
            // No timings (an older build) → no split to draw and nothing the serving span does not already
            // say; a bare "generating" bar would be a second copy of it.
            if (!timings) return null;
            const loadEnd = loadEndedAt.get(model);
            // What the request said it was for, echoed by a patched server — ours carry our request id, which is
            // what `joinGens` matches on; anyone else's the lane can name.
            return genSpan({ model, endAt: at, timings, hint: hintFrom((frame as { hint?: unknown }).hint), ...(startAt != null ? { startAt } : {}),
                ...(loadEnd != null && startAt != null && loadEnd > startAt && loadEnd <= at ? { loadEnd } : {}) });
        }
        case "load.failed": {
            if (model) { openLoads.delete(model); noteLoading(); }
            if (!model) return null;
            // AN ATTEMPT IS NOT THE REQUEST. A reason ending "; retrying" means the scheduler evicted something
            // or shrank the context and is trying again — its own `load.start` follows, so one request can read
            // start → failed → start → complete. Labelled as the request failing, the lane would report a
            // failure for a load that went on to succeed. The server's own words stay, minus the suffix the
            // label now says in plain words.
            const reason = frame.reason ?? "";
            const retrying = /;\s*retrying\s*$/.test(reason);
            const said = reason.replace(/;\s*retrying\s*$/, "");
            return { t: at, kind: "error", model, label: retrying
                ? `${model} load attempt failed, retrying${said ? `: ${said}` : ""}`
                : `${model} failed to load${said ? `: ${said}` : ""}` };
        }
        // EVICT and UNLOAD are different answers and the server draws the distinction: one made room for
        // something, the other simply expired. Inferring them by diffing polls could never tell them apart.
        case "evict":
            return model ? { t: at, kind: "evict", label: `${model} evicted${frame.reason ? ` (${frame.reason})` : ""}`, model, via: "server" as const } : null;
        // The server says WHY since fork 10b026a3 (`reason`). Before that one termination path covered a keep-alive running
        // out AND a model displaced for another load, with no reason, and the lane guessed "idle". An absent or unknown
        // reason keeps the hedged wording rather than guessing again. `evict` is only the OOM-retry path.
        case "unload":
            return model ? { t: at, kind: "evict", label: `${model} unloaded (${UNLOAD_WHY[frame.reason ?? ""] ?? "its keep-alive ran out, or another load displaced it"})`, model, via: "server" as const } : null;
        default:
            return null;
    }
}

let streamPort: chrome.runtime.Port | null = null;

/** Whether the stream has delivered `info` on this connection. A late `/api/info` reply is dropped only then —
 *  before it, that reply may be the only capacity reading there is (see `fetchCapacity`). */
let streamInfoSeen = false;

/** Subscribe to the server's event stream through the worker, which owns the host permission and the key, and
 *  holds ONE connection however many panels are open. Falls back to polling — never to an empty chart — when
 *  the route is not served, which is every stock Ollama. */
let streamHolders = 0;

/** Hold ONE connection to the box's `/api/events` while a panel is open. The only thing polling cannot
 *  approximate: for most of a load there is no runner object in Ollama at all, so `/api/ps` is not coarse
 *  during a load, it is EMPTY. Falls back to polling when the route answers with HTML. */
export function connectResourceStream(): () => void {
    streamHolders++;
    const release = () => {
        if (--streamHolders > 0) return;   // someone else is still watching
        try { streamPort?.disconnect(); } catch { /* already gone */ }
        streamPort = null; streamLive.value = false;
    };
    if (streamPort) return release;
    let port: chrome.runtime.Port;
    try { port = chrome.runtime.connect({ name: "ml-resource" }); }
    catch { streamHolders--; return () => { /* no extension context (a test harness) */ }; }
    streamPort = port;
    streamInfoSeen = false;
    port.onMessage.addListener((msg: any) => {
        if (msg?.unsupported) { streamLive.value = false; streamNote.value = null; return; }   // stock server: just poll
        if (msg?.interrupted) { streamLive.value = false; streamNote.value = String(msg.interrupted); return; }
        // BEFORE the frame is used for anything: a drop is news about the interval that ENDS at this frame, so
        // the mark has to be standing when this frame's own reading is recorded.
        if (msg?.lost) { pendingGap = true; framesLost.value += msg.lost; }
        // THE HELLO'S OWN CARGO, and the reason this route exists: a GPU that faulted before anything
        // connected is reported nowhere else. Applied before the frame is otherwise used, so a panel opening
        // onto a broken box says so on its first frame rather than on its first sample.
        if (msg?.unavailable) unavailableGpus.value = unavailableFrom(msg.unavailable);
        if (!msg?.frame) return;
        streamLive.value = true; streamNote.value = null;
        // A `sample` frame IS a poll's two answers, embedded verbatim by the server precisely so one parser
        // serves both transports. Capacity first: a reading must be recorded against the ceiling in force.
        if (msg.frame.kind === "sample") {
            if (msg.info) { streamInfoSeen = true; applyInfo(msg.info); }
            if (msg.loaded) applyLoaded(msg.loaded, msg.at);
            return;
        }
        const ev = machineEventFrom(msg.frame, msg.at);
        if (ev) pushMachine(ev);
    });
    port.onDisconnect.addListener(() => { streamPort = null; streamLive.value = false; });
    return release;
}

/** When a reading of what is RESIDENT last arrived (`/api/ps` or the event stream), by the local clock; null until one
 *  has. A failed read leaves it alone, so "how old is what we know" never mistakes an error for news. */
export const loadedAt = signal<number | null>(null);

/** One reading of what is resident, from WHEREVER it came from — a poll, or a `sample` frame off the event
 *  stream. Both transports hand over the same `LoadedModel[]` (the frame embeds the `/api/ps` body verbatim
 *  and it goes through the same parser), so this is the single place a reading becomes panel state. Two
 *  transports feeding one function is what stops the polled panel and the streamed one drifting apart. */
export function applyLoaded(raw: LoadedModel[], at: number = Date.now()): void {
    psError.value = null;
    // A READING CAME BACK, so the box is answering. Stamped with the LOCAL clock and not with `at`: a
    // backfilled frame carries a timestamp from minutes ago and would read as proof that went stale before it
    // arrived, while what this records is "we heard from it just now".
    backendAliveAt.value = Date.now();
    // NORMALISED HERE, at the one place a reading becomes state — the same rule `machineEventFrom` follows for
    // the stream, and for the same reason: match the two spellings late and every new comparison is a fresh
    // chance to forget.
    //
    // It was applied to the stream and NOT to `/api/ps`, because ps was documented as always using the short
    // name. It did not: caught on a real box (capture 2026-09-05, 19:21:40), where a second model loading
    // made ps answer with the FULLY-QUALIFIED name for two frames — and one frame carried BOTH spellings, one
    // per model. For those frames the resident model was a different id, so its band fell to zero and its
    // memory dropped into the residual: a notch straight down through a flat 88.28 GiB, a row reading
    // "off-box" for a model plainly on the card, and a tooltip saying "92%" and "nothing resident" at once.
    // The spelling was a side effect of the state above — a placeholder was built from the request's model
    // reference, which is still fully qualified — and is fixed in the same server commit.
    //
    // `/api/events` still names models fully qualified and deliberately so, which is the reason this exists
    // at all; extending it to `ps` is defence against older builds and costs a comparison.
    const named = raw.map((m) => (m.model === normModel(m.model) ? m : { ...m, model: normModel(m.model) }));
    // A `state: "loading"` ROW IS A PLACEHOLDER, NOT A MODEL HOLDING ZERO BYTES. It carries its name and
    // zeros for everything else — no `size_vram`, no `gpus` — so read as a residency it says the model is
    // here and using nothing, which is the notch: a band straight down to the axis and back up.
    //
    // And it was not only said of a model that is genuinely loading. Measured on a real box (capture
    // 2026-09-05, t=76085..77473): a model RESIDENT and serving with 94,171,928,982 bytes on CUDA0 was
    // re-reported as `loading` with zeros while a DIFFERENT model loaded, then back to its full figure 2ms
    // later — with the server's own top-level `vram_used` unchanged at 94,171,928,982 through every frame.
    //
    // FIXED SERVER-SIDE since (parawanderer/ollama `slop`, deployed as ollama-slop:latest). The cause was
    // narrower and worse than it looked: `state: "loading"` meant "I could not take this runner's lock just
    // now", and ordinary traffic holds that lock — a request finishing, an expiry being reset, another model
    // being admitted. `vram_used` disagreed because device discovery never consulted it. A `loading` row now
    // appears only for a model that genuinely has no runner.
    //
    // KEPT ANYWAY, because it costs one comparison and it is the difference between a wrong reading and a
    // right one on every build older than that fix — including whatever a user happens to be running. The
    // one case it is imprecise in is a model evicted and reloaded inside a single poll, where it carries a
    // stale figure for one reading; that is self-correcting and far cheaper than the notch.
    // So a placeholder is NO NEWS, not news of zero — and for a model we last measured as resident, no news
    // means it is still there. Carrying the previous reading forward is what keeps the band flat across the
    // flicker; dropping the row instead would leave the model with no row at all for that frame, which draws
    // the same notch by a different route. A model that genuinely goes away stops appearing in `ps` entirely,
    // or arrives as an `unload` edge — neither of which this touches.
    const wasResident = new Map((loadedModels.value ?? []).map((m) => [m.model, m]));
    const placeholders: string[] = [];
    const loaded: LoadedModel[] = [];
    for (const m of named) {
        if (m.state !== "loading") { loaded.push(m); continue; }
        const known = wasResident.get(m.model);
        if (known && (known.vramBytes ?? 0) > 0) loaded.push(known);   // still here; the row just said nothing
        else placeholders.push(m.model);                               // genuinely loading — a name, no figures
    }
    // Remember each resident model's window (overwrite → tracks a mid-run reload).
    for (const m of loaded) if (typeof m.contextLength === "number") seenContext.set(normModel(m.model), m.contextLength);
    loadedModels.value = loaded;
    loadedAt.value = Date.now();
    // One sample per reading, carrying the capacity in force at the time — a sample read back from history
    // must know the ceiling it was drawn against, not today's.
    // `loading` rides the reading because it is a fact ABOUT that instant, and the bands are derived from the
    // sample alone — a later render must not consult a signal that has since moved on, or scrolling back
    // through history would relabel old samples with today's loads.
    psLoading.value = placeholders;
    const inFlight = [...new Set([...loadingModels.value, ...placeholders])]
        .filter((n) => !loaded.some((m) => m.model === n));
    // Published to `store` so the two surfaces that judge backend health can read it without importing this
    // module — the reducer is a leaf and pulling the whole VRAM panel into it for one list would be a cycle
    // waiting to happen. Written HERE because this is the one place a reading becomes state.
    backendLoading.value = inFlight;
    const sample: ResourceSample = {
        t: at, models: loaded.map((m) => residencyOf(m)), capacity: capacity.value,
        ...(inFlight.length ? { loading: inFlight } : {}),
        ...(pendingGap ? { gapBefore: true as const } : {}),
    };
    pendingGap = false;
    // CHRONOLOGICAL, not append-order. Everything downstream — segmenting on gaps, placing an event inside
    // the run that contains it, the scrub window — assumes the samples are in time order, and a bare push
    // holds that for a poll and breaks it for the stream: a connection BACKFILLS up to ten minutes of history
    // after the poll has already appended samples for "now", so the array goes recent, then old, then recent.
    // Segmenting that yields one enormous negative gap, every run becomes a single sample, and the whole
    // event lane silently draws nothing while its filter chips still count the events.
    const prev = resourceHistory.value;
    const last = prev.at(-1);
    const next = !last || at >= last.t
        ? [...prev, sample]                                    // the ordinary case: the newest reading
        : [...prev, sample].sort((a, b) => a.t - b.t);         // backfill landing behind what we already hold
    // Age out first, then cap: trimming by count alone lets a burst of load-rate samples push out history the
    // chart is still being asked to draw.
    const cutoff = (next.at(-1)?.t ?? 0) - RESOURCE_RETENTION_MS;
    const kept = next.length > 1 && next[0].t < cutoff ? next.filter((x) => x.t >= cutoff) : next;
    resourceHistory.value = kept.slice(-RESOURCE_HISTORY);
}

/** Ask what is RESIDENT (`/api/ps`) and fold it into the history. Read `state` before anything else on an
 *  entry: a "loading" one carries zeros and a Go zero-time `expires_at` that parses to the year 1. */
export function pollPs(): void {
    if (!sidebarOpen.value) return;
    if (!vramOpen.value && view.value.name !== "detail") return;
    readPs();
}

/**
 * Read `/api/ps` once and fold it in, with no question about which panel is open: the read itself, under the
 * sidebar's guards in {@link pollPs}. The chat page calls it directly, because those guards are the SIDEBAR's —
 * `sidebarOpen` is set only by the overlay's shell, so under them the chat page's resource panel never read `ps`
 * at all and showed nothing resident on any server without the event stream.
 */
export function readPs(): void {
    // The stream, when one is carrying, IS the reading — polling on top of it would double every sample and
    // draw a history at twice the true density.
    if (streamLive.value) return;
    chrome.runtime.sendMessage({ type: "OLLAMA_PS", payload: {} }, (resp: any) => {
        // The guard above ran when the poll was SENT. The panel polls once on mount, before the stream has
        // said anything, and when that reply lands after the stream's first sample it is an OLDER reading
        // recorded on top of a newer one — against a box whose /api/ps lagged, a resident model read as evicted.
        if (streamLive.value) return;
        if (chrome.runtime.lastError || (resp && resp.error)) {
            psError.value = (resp && resp.error) || chrome.runtime.lastError?.message || "unavailable";
            loadedModels.value = []; return;
        }
        applyLoaded(resp.data || []);
        // Keep occupancy honest without polling capacity as often as residency (see CAPACITY_EVERY).
        if (++psSinceCapacity >= CAPACITY_EVERY) { psSinceCapacity = 0; fetchCapacity(); }
    });
}

// --- proactive backend-health probe (drives the offline banner + the HUD card's offline state) ---
// A run/chat failure isn't the only way to learn the box is down — probe the CHAT backend DIRECTLY so a dead
// box surfaces even before/without a run, and AUTO-RECOVERS when it's back. LIST_MODELS hits the configured
// chatUrl (backend-agnostic; it throws a network error when unreachable, an HTTP/"no models" error when it's
// up). A HANGING box (packets dropped, not refused) never calls back — so a no-RESPONSE within the window
// ALSO counts as unreachable (the "stuck on Starting…" case the user hit). Sets/clears `backendError`.
export const BACKEND_HEALTH_MS = 6000;          // probe cadence while the app is mounted

export const BACKEND_HEALTH_TIMEOUT_MS = 6000;  // no response by here → treat as unreachable (a hanging box)

let healthInFlight = false;

/** Is the backend reachable at all — drives the offline banner and the HUD's distinct dead-box card. */
export function pollBackendHealth(): void {
    if (healthInFlight) return;   // one in flight at a time; the timeout guarantees it always settles
    healthInFlight = true;
    let settled = false;
    const finish = (unreachable: string | null): void => {
        if (settled) return;
        settled = true; healthInFlight = false;
        backendError.value = unreachable ? unreachableIfNothingSaysOtherwise(unreachable) : "";
    };
    const timer = setTimeout(
        () => finish(`Couldn't reach the server at ${config.value.chatUrl || "the configured URL"} — no response. Is it running?`),
        BACKEND_HEALTH_TIMEOUT_MS);
    // NOTE the probe's own timeout is not exempt from the liveness veto — `finish` routes every verdict
    // through `backendStateFrom`. A chat backend can be slow to list models for reasons that have nothing to
    // do with the box being there, and `/api/ps` answering in under a millisecond is the better witness.
    try {
        chrome.runtime.sendMessage({ type: "LIST_MODELS", payload: {} }, (resp: { error?: string } | undefined) => {
            clearTimeout(timer);
            const err = chrome.runtime.lastError?.message || resp?.error || "";
            // Only a NETWORK-level failure means "the box is gone". An HTTP / "no models installed" error means
            // the server ANSWERED → reachable (clear). Any data likewise → reachable.
            const answered = !err || !isBackendUnreachable(err);
            // AND THAT ANSWER IS PROOF OF LIFE, recorded for everything else that has to judge reachability.
            // It cannot come from `/api/ps` alone: that poll is gated on the panel being OPEN, so the evidence
            // would exist only for a user who happened to be looking at the chart — and the banner this feeds
            // is shown to everyone. This probe runs whenever the app is mounted, which is the right scope for
            // a fact about whether the box is there.
            if (answered) backendAliveAt.value = Date.now();
            finish(answered ? null : err);
        });
    } catch { clearTimeout(timer); finish(null); }   // extension context gone → don't nag
}

// Model / VRAM diagnostics — the server model-list fetch, the Ollama /api/ps VRAM monitor panel + its
// polling, per-model load-state, backend-health probing, and the Python sandbox bench. A separate,
// self-contained surface from the run views. Extracted from app.tsx.
import type { WireFrame } from "../events-wire";
import { useState, useEffect, useRef } from "preact/hooks";
import { isBackendUnreachable } from "../contract-server";
import { signal, effect } from "@preact/signals";
import {
    config, models, ollamaIds, modelKinds, loadedModels, psError, vramOpen, backendError, rev, sessionMap,
    sidebarOpen, view, crosshair, backendAliveAt, backendLoading, unreachableIfNothingSaysOtherwise, VRAMH_KEY, vramH, resWindowS, resWindowPref, RESWIN_KEY, RESWIN_PREF_KEY, RESWIN_DEFAULT, zoomRange, laneHidden, laneScoped, LANE_HIDDEN_KEY, SECTIONS_KEY, laneEnabled, showLane, showModels, SNAPDOT_KEY, snapDot, PREDICT_KEY, predictView, TIMEGRID_KEY, timeGrid, lsGet, asides,
    scopedHash,
} from "./store";
import { truncate } from "./format";
import { normModel, seenContext } from "./model";
// The ONE predicate for "this runs somewhere else": affirmatively not a model of this server. Shared with the
// composer rather than re-derived here, so the panel and the picker cannot disagree about what is local.
import { isCloudModel } from "./card-state";
import { IconWarn, IconVram, IconEye, IconEyeOff, IconBench, IconGear } from "./icons";
import { Disclosure, TipText } from "./ui-kit";
import { useTipPlacement } from "./use-tip";
import { fmtAge, hhmmss } from "./timestamps";
// lsGet/lsSet live in store.ts, not here: a rendered code block hands the bench a script, and render-panel
// cannot import this module (it would be a cycle — this one imports RenderPanel).
export { lsGet, lsSet } from "./store";
import { eventsFrom, laneEvents, type UsageSource } from "./model-stats";
import { parseInfo, holdCapacity, memorySplit, estimateFrom, noteSeenCards, type SeenCards, type LoadEstimate, placementFrom, activityFrom, type MemoryBreakdown, formatBytes, boxSignature, sameBoxOnly, placementOf, isSplit, residencyEvents, boxChange, type ResourceEvent, type Capacity, type ResourceSample, type ModelResidency, type UnavailableGpu, unavailableFrom, isGpuFault, gpuFaultNote, genSpan, genTimingsFrom, hintFrom, rooflineFrom, expectedDecodeFrom, predictedDecodeFrom } from "../resource-model";
import { presetsFor, seriesCatalog, stackRefusal, type TrackDef, kindRefusal } from "../resource-presets";
import { chartWindow, windowSamples } from "../resource-axis";
import { sessionWindow, addMachineEvent } from "../resource-lane";
import { ResourceTracks, muteTip, stepPool, readingIsOverlay } from "./resource-chart";
import { ScopeSwitch, LANE_KINDS, toggleLaneKind } from "./resource-lane-ui";
import type { LoadedModel } from "../contract-server";

/** Is this model resident right now? `undefined` when we have no `/api/ps` answer yet — the caller must not
 *  read that as "not loaded", since the difference between "loading" and "we don't know" matters to what the
 *  UI claims. Matches on the tagged name, normalising `:latest` like the rest of the model plumbing. */
export function residentNow(model?: string | null): boolean | undefined {
    const loaded = loadedModels.value;
    if (!model || !loaded) return undefined;
    return loaded.some((m) => normModel(m.model) === normModel(model));
}

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
import { RenderPanel } from "./render-panel";
import { hoverModel, kbFocus, stepFocus, stepDepth, noteFocusOrder } from "./vram-focus";
import { poolHover } from "./chart-interaction";
import { VRAM_PALETTES, capacity, resourceHistory, layout, streamLive, colorFor, frameFocused, vramPalette, VRAM_HISTORY, sessionModels, poolFacts, choosePreset, customTracks, editLayout, presetId, restoreLayout } from "./panel-state";
import { NO_EXPIRY_MS, modelCaps, isEmbedding, isChatModel, rowTipSuppressed, ModelFacts, CostFacts } from "./panel-facts";

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


export const VRAM_PALETTE_KEY = "ml_vram_palette";   // storage.local: which colour palette names the models
export const VRAM_COLORS = VRAM_PALETTES.vivid;   // the default palette — a model keeps its colour for as long as it is DRAWN, not just while resident
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
/** A machine-level banner for GPUs the server can see and cannot use.
 *
 *  MACHINE-LEVEL, NOT A PER-CARD BADGE, because there is no card to badge: a faulted GPU is absent from
 *  `supported_gpus` entirely, so the panel draws one healthy card and every figure agrees with every other.
 *  The question this answers is "why does this box have fewer GPUs than I expect?", which no per-device
 *  decoration can be attached to.
 *
 *  It renders NOTHING when the list is empty. That is not the same as "all healthy": an empty list means
 *  nothing to report OR the server could not look, and the two are not distinguished at the source — so it
 *  may drive a warning and must never drive a reassurance. `not_offered_by_backend` is filtered out for a
 *  related reason: that card answers every query and was simply not claimed by a backend (usually
 *  `CUDA_VISIBLE_DEVICES`), and a warning triangle there tells someone to reseat working hardware.
 *
 *  `detail` and `recovery` are rendered VERBATIM. `detail` is the driver's own string — "GPU requires reset"
 *  is NVIDIA's wording, not ours — and its value is that it can be searched in vendor documentation exactly
 *  as shown, which paraphrasing would destroy. */
function GpuFaults() {
    loadSeenCards();
    const faults = unavailableGpus.value.filter(isGpuFault);
    if (!faults.length) return null;
    const total = faults.length + (capacity.value?.devices.length ?? 0);
    // AN ERROR, not a warning: a card is out of service. The one exception is AMD's `reset_in_progress`, which
    // usually clears within seconds (`gpuFaultNote`) — when every fault is that, it stays amber.
    const transient = faults.every((g) => g.reason === "reset_in_progress");
    return (
        <div class={`rc-gpufault${transient ? " transient" : ""}`} role="alert">
            <IconWarn />
            <div class="rc-gpufault-body">
                <b>{faults.length} of {total} GPUs unavailable</b>
                {faults.map((g) => {
                    // WHICH CARD, in the panel's own terms. A faulted card has left the enumeration, so it has no
                    // CUDA index today — and the indices can shift once one drops out. The server's own memory
                    // of the label comes first (`lastName`); failing that, what THIS panel last saw at that
                    // address. Always "last seen as", never "is": it is a claim about the past.
                    const was = g.lastName ?? seenCards.value[g.pciId]?.name;
                    return (
                    <div class="rc-gpufault-one" key={g.pciId}>
                        {/* The PCI address is the IDENTITY — two cards in one machine share a name — and it is
                            also the only thing present under `not_reported_by_driver`, where the driver
                            describes nothing and neither name nor uuid can be read. */}
                        <span class="rc-gpufault-id">{was ? <><b class="rc-gpufault-was">{was}</b> · </> : null}{g.name ?? seenCards.value[g.pciId]?.description ?? "GPU"} at <code>{g.pciId}</code>{was ? <span class="rc-gpufault-dim"> — its label when last seen{g.lastName && g.lastSeen ? `, ${fmtAge(Date.now() - g.lastSeen)} ago` : ""}</span> : null}</span>
                        {g.detail ? <span class="rc-gpufault-detail">{g.detail}</span> : null}
                        {gpuFaultNote(g) ? <span class="rc-gpufault-detail">{gpuFaultNote(g)}</span> : null}
                        {g.recovery ? <span class="rc-gpufault-fix"><b>Fix:</b> {g.recovery}</span> : null}
                        {/* A non-zero error counter points at the SLOT or the riser rather than the card, and
                            saying so is worth a line: a card blamed for a bad slot gets replaced and the fault
                            follows the slot. Silent when the counters are zero or absent. */}
                        {(g.bus?.fatalErrors || g.bus?.nonFatalErrors)
                            ? <span class="rc-gpufault-bus">PCIe link errors on this slot ({g.bus.fatalErrors ?? 0} fatal, {g.bus.nonFatalErrors ?? 0} non-fatal) — that points at the slot or riser rather than the card.</span>
                            : null}
                    </div>
                    );
                })}
            </div>
        </div>
    );
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
// Models the user has hidden from the totals/graph (session-only; a signal so it
// survives VramPanel remounts). Immutable Set updates so the signal notifies.
export const hiddenModels = signal<Set<string>>(new Set());
/** Hide one model from the chart — and from the event lane, since its rows ARE the legend and a colour
 *  with no row explains nothing. */
export const toggleHidden = (model: string): void => {
    const next = new Set(hiddenModels.value);
    next.has(model) ? next.delete(model) : next.add(model);
    hiddenModels.value = next;
};

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
/** Whether the model list is showing the models this session did NOT use. Off by default and NOT persisted:
 *  it answers a question you had once ("what else is on the box?"), not a preference. */
export const othersOpen = signal(false);
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

// "expires in Xs/Xm" from an /api/ps expires_at ISO stamp (Ollama's TTL). A BUSY runner has no deadline to
// report: the server rewrites it when the request finishes, so the stamp we hold is the one from last time.
export function expiresIn(expiresAt: string | null, busy?: boolean): string | null {
    if (busy) return "in use — TTL held";
    if (!expiresAt) return null;
    const ms = new Date(expiresAt).getTime() - Date.now();
    if (isNaN(ms) || ms <= 0) return null;
    if (ms > NO_EXPIRY_MS) return "pinned — no expiry";
    const s = Math.round(ms / 1000);
    return s < 90 ? `expires in ${s}s` : `expires in ${Math.round(s / 60)}m`;
}

// Live model-load state for the header's "responds-next" model, from /api/ps
// (resident) + the installed list + our own in-flight flag. Five states, detail
// in the tooltip (see SIDEBAR_UI_FEEDBACK.md). Reads signals directly so it
// updates on each poll; model/inFlight arrive as plain props.
export type LoadState = "loaded" | "cold" | "inflight" | "unavailable" | "cloud" | "unknown";
/** Is this model resident, loading, evicted or unknown — and the sentence explaining which. Shared by the
 *  status dot and its tooltip so the two cannot disagree. */
export function modelLoadState(model: string, inFlight: boolean): { state: LoadState; tip: string } {
    const ps = psError.value ? null : loadedModels.value;
    // Match the FULL tagged name (only normalising :latest). A base-name match
    // ("gemma4") picks the wrong variant when a family has several tags loaded
    // — e.g. gemma4:31b would grab gemma4:e2b's (CPU, no-VRAM) row.
    const norm = (m: string) => m.replace(/:latest$/, "");
    const resident = ps?.find(m => m.model === model || norm(m.model) === norm(model)) || null;
    if (inFlight) return { state: "inflight", tip: resident ? "Generating a response…" : "Loading the model into VRAM…" };
    if (psError.value) return { state: "unknown", tip: "Load state unknown — no Ollama backend responding." };
    if (ps == null) return { state: "unknown", tip: "Checking load state…" };
    if (resident) {
        // size_vram vs size → fully-CPU / partial-offload / full-GPU. From the EXACT bytes, in GiB like every other
        // memory figure in the panel (the rounded decimal `vramGB` read ~7% larger than the chart for the same model).
        const v = resident.vramBytes ?? (resident.vramGB != null ? resident.vramGB * 1e9 : null);
        const sz = resident.sizeBytes ?? (resident.sizeGB != null ? resident.sizeGB * 1e9 : null);
        const where = !v
            ? (sz ? `on CPU (${formatBytes(sz)} RAM)` : "on CPU (RAM)")
            : (sz && v < sz * 0.99 ? `${formatBytes(v)} of ${formatBytes(sz)} in VRAM — partial CPU offload (slower)` : `${formatBytes(v)} VRAM`);
        const bits = [where, expiresIn(resident.expiresAt, resident.busy)].filter(Boolean);
        return { state: "loaded", tip: `Loaded — ${bits.join(" · ")}.` };
    }
    // Not resident. An external (non-Ollama) model has no local load state at all.
    const listed = models.value.includes(model);
    const ollama = ollamaIds.value;   // null = provenance unknown → don't guess cloud
    if (ollama && listed && !ollama.includes(model))
        return { state: "cloud", tip: "External API model — runs remotely; no local VRAM or load state." };
    if (listed) return { state: "cold", tip: "Idle — installed but not resident; loads on next use." };
    if (models.value.length) return { state: "unavailable", tip: "Unavailable — the server doesn't list this model (not installed?)." };
    return { state: "unknown", tip: "Load state unknown." };
}


/** IS THIS MODEL READY — resident, loading, evicted, or unknown — as a dot beside the model name, with
 *  the residency facts on hover. The answer to "why is this run slow" is often here before the run
 *  starts. */
export function ModelStatusDot({ model, inFlight }: { model: string; inFlight: boolean }) {
    const { state, tip } = modelLoadState(model, inFlight);
    return (
        <span class="tt">
            <span class={`dot ${state}`} />
            <span class="tt-pop left" role="tooltip">{tip}</span>
        </span>
    );
}

const capsAsked = new Set<string>();
/** Ask Ollama what a model can do (`/api/show` capabilities). Undeterminable — a cloud model, an old
 *  server — is UNKNOWN, never "no". */
export function probeCaps(model: string): void {
    if (capsAsked.has(model)) return;
    capsAsked.add(model);
    try {
        chrome.runtime.sendMessage({ type: "MODEL_CAPS", payload: { model } }, (resp: any) => {
            if (chrome.runtime.lastError || !resp || resp.error) return;   // unknown, never "no"
            modelCaps.value = { ...modelCaps.value, [model]: Array.isArray(resp.data) ? resp.data : null };
        });
    } catch { /* no runtime (tests) */ }
}
/** One phrase for what a model IS, for every tooltip that names one. Empty when nobody said. */
export const modelKindLabel = (model: string): string =>
    isEmbedding(model) ? "embedding model" : isChatModel(model) ? "chat model" : "";

/** How long a selected range is, for the chip that offers to leave it. */
export const zoomSpan = (z: { from: number; to: number }): string => {
    const s = Math.max(0, Math.round((z.to - z.from) / 1000));
    return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};

/** Everything that happened this browsing session, on the machine's timeline: generations, tool steps, model
 *  loads (from the sessions), and evictions (from the samples themselves, since nothing else reports them).
 *  Recomputed per render for the same reason the cost ledger is — the session map IS the record. */
export function timeline(): ResourceEvent[] {
    void rev.value;
    // `now` is what turns IN-FLIGHT work into open spans — a generation being generated, a tool running, a
    // human at a gate. The lane is the live surface, so it asks for them; anything durable (the export) calls
    // eventsFrom with no `now` and gets finished work only. It advances per render, which is per poll, so a
    // live bar grows at the same cadence as the memory trace beside it.
    // A reader's own model calls (the code annotator, a summary) live beside the sessions rather than in
    // them: they describe THIS reading session, not the run's record, so they are merged in here instead of
    // being written into the session the reducer builds from the debug stream.
    const fromSessions = eventsFrom(
        [...sessionMap.values()].map((s) => (asides.has(s.hash) ? { ...s, asides: asides.get(s.hash) } : s)) as UsageSource[],
        Date.now());
    // The server's own edges REPLACE the inferred ones when we have them. Diffing polls can see that a model
    // appeared, never that it was loading — and it cannot tell an eviction that made room from an idle
    // expiry, which the server reports as two different kinds. Falling back to inference when the stream is
    // not carrying is the stock-Ollama path, unchanged.
    const machine = streamLive.value
        // A model serving RIGHT NOW has no end yet, so it is synthesized against the clock the same way an
        // in-flight generation is — `until` is where it had reached, not where it ended. Without it the fact
        // the panel most wants to show while you watch (the box is working) appears only once it is over.
        ? [...machineEvents.value, ...Object.entries(servingSince.value).map(([model, t]): ResourceEvent => (
            { t, until: Date.now(), open: true, kind: "serve", label: `${model} serving`, model }))]
        : residencyEvents(resourceHistory.value, fromSessions);
    // Both sources describe a LOAD, and with the stream carrying they describe the SAME loads — so the one we
    // inferred from `load_duration` is dropped where the server reported it (see laneEvents).
    // A MODEL SWITCHED OFF IS SWITCHED OFF EVERYWHERE THE PANEL DRAWS IT. The dot took it out of the stack
    // and the totals and left its lane blocks standing — which is most visible on an off-box model, whose
    // only presence IS the lane: its row offered a control that could not remove the one thing it drew. The
    // row itself stays, because the row is what you turn it back on with.
    const off = hiddenModels.value;
    // OUR OWN WORK ARRIVES TWICE with the stream carrying — as what the session drew and as the server's record
    // of it — so each load, generation and serving period is drawn once, inside the run it belongs to (see
    // laneEvents). Only traffic nothing here accounts for is drawn as the server's own.
    const all = laneEvents(fromSessions, machine, (hash) => sessionMap.has(hash)).map(withGenCtx).sort((a, b) => a.t - b.t);
    return off.size ? all.filter((e) => !e.model || !off.has(e.model)) : all;
}

/** A generation's cache CAPACITY at its end, read from the first sample at or after it that carries the model —
 *  where the counts describe the cache. Attached here, where the history is, so the lane's tooltip can draw the
 *  fill in any preset; the drilled-in chart reads the same sample itself. */
function withGenCtx(e: ResourceEvent): ResourceEvent {
    if (!e.gen || !e.model || e.until == null || e.genCtx) return e;
    const hist = resourceHistory.value;
    for (const s of hist) {
        if (s.t < e.until) continue;
        const r = s.models.find((m) => m.model === e.model);
        if (!r) continue;
        return { ...e,
            ...(r.contextLength ? { genCtx: { contextTokens: r.contextLength, slots: r.activity?.slots ?? 1 } } : {}),
            ...(r.roofline ? { genRoofline: r.roofline } : {}) };
    }
    return e;
}

/** One resident model's row. Extracted because the SCOPED list draws it in two places now — the session's
 *  own models, and the folded "other models on the box" — and a second copy of a row with four interactive
 *  parts is exactly where two lists start behaving differently. */
/** A model NAMED BUT NOT LOADED — evicted inside the window the chart still covers, or one that only ever
 *  ran off-box. The rows are the chart's legend, so a colour still being drawn needs a row to say whose it
 *  is; what it does not need is a live model's controls, because there is nothing to unload or hide.
 *
 *  ONE component for what were three near-identical copies (in-scope evicted, in-scope off-box, and the same
 *  two again inside the out-of-scope disclosure) — the third copy is what made it worth extracting. */
function GhostRow({ name, kind }: { name: string; kind: "off" | "ghost" | "unseen" | "loading" | "idle" }) {
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

function ModelRow({ m, hidden, latestSample, evict }: { m: LoadedModel; hidden: Set<string>; latestSample: ResourceSample | null; evict: (model?: string) => void }) {
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

// The smallest the panel may be dragged is LEARNED, not computed. Summing the parts is a guess about which
// parts exist and how tall they are — it goes stale the moment a track grows a row, the font scale changes, or
// a model name wraps, and the symptom is content rendering on top of itself.
//
// Instead the panel measures its own SHORTFALL: `scrollHeight - clientHeight` is exactly how much content does
// not fit, whatever that content turns out to be. Grow by that much and the overlap is gone by construction.
// The result is remembered as the floor for this layout, and dragging can only EXPAND past it.
export const PLOT_MIN_H = 44;   // matches .rc-plot's min-height

/** True while the user's hand is on the grip. Every programmatic resize stands down until it is false: the
 *  panel may correct itself before or after a drag, never during one. */
export const dragging = signal(false);
/** When the drag last produced an event. A release can be MISSED entirely — the pointer leaves the frame, the
 *  window loses focus, the OS takes the gesture — and a `dragging` flag stuck true silently disables every
 *  later self-correction. So a drag that has gone quiet is treated as over. */
export let lastDragAt = 0;
export const DRAG_IDLE_MS = 900;   // ms after a drag before the panel may correct itself — a hand still on the grip must always win
/** Mark the panel as being dragged RIGHT NOW, so no programmatic resize fights the hand holding it. */
export const noteDrag = (t = Date.now()): void => { lastDragAt = t; };
/** Has the drag gone quiet long enough to be considered finished? */
export const dragStale = (now = Date.now()): boolean => dragging.value && now - lastDragAt > DRAG_IDLE_MS;

/** How much taller the panel must be for its content to fit. 0 when it already does. */
export function shortfall(el: HTMLElement | null): number {
    if (!el) return 0;
    return Math.max(0, el.scrollHeight - el.clientHeight);
}

/** The smallest height at which everything still fits — measured, by squeezing the panel to nothing and asking
 *  what its content then needs. One forced layout, and no guessing: a shortfall read in the same frame as the
 *  height that caused it can be WRONG (the chart's flex box and its SVG settle a frame later), which is what
 *  let a drag stop just under the true floor and then jump when the next correction disagreed. Asking for the
 *  minimum directly means the drag and the correction compute the same number. */
export function measureFloor(el: HTMLElement | null): number {
    if (!el) return 0;
    const prev = el.style.height;
    el.style.height = "0px";
    const min = el.scrollHeight;   // reading it forces the layout, so this is the settled answer
    el.style.height = prev;        // …and restoring before the frame ends means nothing is ever painted at 0
    return Math.ceil(min);
}

/** What the panel currently looks like, so a learned floor is discarded when the layout changes rather than
 *  ratcheting upward forever — switching to a smaller view must be able to shrink again. */
// The panel's WIDTH is part of it: tracks tile side by side once there is room, so a floor learned in a
// narrow sidebar is far too tall after the sidebar is dragged out — and the correction only ever grows, so it
// would never come back down on its own. Bucketed, because a floor per pixel of width is a floor per render.
export const WIDTH_BUCKET = 100;
/** The key a learned height floor is remembered under. WIDTH is part of it because tiling needs less
 *  height than stacking, and a floor learned wide would be wrong narrow. */
export const layoutKey = (tracks: number, rows: number, width = 0): string =>
    `${tracks}:${rows}:${Math.round(width / WIDTH_BUCKET)}`;

/** Animate the panel to a height with a cubic ease. Used when the size changes on its OWN — the panel
 *  correcting an overlap, or a layout needing more room — where a snap reads as a glitch. A live DRAG never
 *  uses this: dragging must track the pointer exactly, and easing it would feel like lag. */
// Bumped by cancelEase(); an in-flight animation checks it every frame and gives up if it is no longer the
// current one. The user's hand ALWAYS wins — a panel that keeps animating while you drag it is fighting you.
let easeToken = 0;
/** Abandon an in-flight height animation — anything the user does to the panel takes over from it. */
export function cancelEase(): void { easeToken++; }

/** Animate the panel to a height, so a self-correction reads as the panel adjusting rather than jumping. */
export function easeVramH(to: number, ms = 220): void {
    const mine = ++easeToken;
    const from = vramH.value;
    if (!from || Math.abs(to - from) < 2) { vramH.value = to; return; }
    // ONE clock: rAF timestamps share performance.now()'s origin, and Date.now() does not — mixing them makes
    // the elapsed fraction negative and the height undershoots below where it started.
    const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
    const t0 = clock();
    const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (f: FrameRequestCallback) => setTimeout(() => f(clock()), 16) as unknown as number;
    const step = (now: number) => {
        // Clamped at BOTH ends: a frame timestamped before t0 must never drive the panel outside the range it
        // was asked to move through.
        if (mine !== easeToken) return;   // something else took over — a drag, or a newer correction
        const t = Math.max(0, Math.min(1, (now - t0) / ms));
        // cubic ease-out: fast to start, settling gently — a resize that decelerates reads as the panel
        // finding its size rather than jumping to it.
        vramH.value = from + (to - from) * (1 - Math.pow(1 - t, 3));
        if (t < 1) raf(step);
    };
    raf(step);
}

/** Pointer position for the model-row tip, in viewport coords (the row is not inside the plot). */
export const rowTipAt = signal<{ x: number; y: number } | null>(null);

/**
 * ONE KEY, READ BY THE CHART — whether it arrived at this frame's own document or was relayed in from the page.
 * Returns whether the key was used, so the caller calls `preventDefault` only then: the panel must not eat
 * scrolling it had no use for.
 *
 * Esc unwinds ONE RUNG AT A TIME, most transient first: the tooltip, then a keyboard focus, then the zoom. They
 * are different kinds of thing — the tip is in the way right now, the focus is a reading you are taking, the zoom
 * is state you chose — and dismissing a popup should never be what throws away a selection two rungs below it.
 *
 * The arrows only answer while the pointer is ON the chart (`crosshair` is set by the plot's own pointermove and
 * cleared when it leaves), because the whole point is reading the instant you are already pointing at without
 * moving off it. Elsewhere they stay the page's arrows.
 */
export function chartKey(key: string): boolean {
    if (key === "Escape") {
        if (muteTip()) return true;
        if (kbFocus.value) { kbFocus.value = null; hoverModel.value = null; return true; }
        if (zoomRange.value) { zoomRange.value = null; return true; }
        return false;
    }
    if (!crosshair.value) return false;                       // the pointer is not on the chart
    if (key === "ArrowDown" || key === "ArrowUp") {
        // THE SAME KEY, THE THING THIS VIEW DRAWS. Overview draws pool LINES and the stacked view draws model
        // bands, so the noun differs while the question the key answers does not. Leaving it working in one view
        // and dead in the other was the worse option: the same key would mean "change what I am reading" or
        // "scroll the page" depending on where the pointer happened to be.
        if (readingIsOverlay()) stepPool(key === "ArrowDown" ? 1 : -1);
        else stepFocus(key === "ArrowDown" ? 1 : -1);
        return true;
    }
    if (key === "ArrowRight" || key === "ArrowLeft") {
        // NO DEPTH IN THE OVERLAID VIEW — a pool has no breakdown of its own, the decomposition is per model — so
        // these are left to the page there rather than swallowed doing nothing.
        return !readingIsOverlay() && stepDepth(key === "ArrowRight" ? 1 : -1);
    }
    return false;
}

/** The pointer is over a PLOT right now — not merely that a reading is anchored (`crosshair` outlives the
 *  pointer while the keyboard holds a focus). What gates relaying the page's keys: once the mouse is on the
 *  page, the page's arrows are the page's again. */
export const pointerOnChart = signal(false);
let lastKeysSent = "";
if (typeof window !== "undefined") {
    window.addEventListener("focus", () => { frameFocused.value = true; });
    window.addEventListener("blur", () => { frameFocused.value = false; });
}

/** The keys the chart would use RIGHT NOW, for a parent that relays them: what `chartKey` would answer, known in
 *  advance, because the relay has to decide whether to take a key from the page before it can ask. ←/→ only
 *  where there is depth to move through, so a page's own arrows are not taken for nothing. */
export function chartKeysWanted(): string[] {
    if (!pointerOnChart.value || !crosshair.value) return [];
    const keys = ["ArrowUp", "ArrowDown", "Escape"];
    if (!readingIsOverlay()) {
        keys.push("ArrowRight");
        if ((kbFocus.value?.depth ?? 0) > 0) keys.push("ArrowLeft");
    }
    return keys;
}

export const editorOpen = signal(false);   // the track editor — where the panel's own settings live, beside the tracks they configure

/** Which series each track shows. Bundling and splitting are the SAME operation on a list — everything in one
 *  track is combined, one series per track is small multiples — so the editor is just this list, and a preset
 *  is a starting point for it. A stack the rule would refuse is disabled rather than hidden, with the reason,
 *  so the constraint teaches instead of just removing options. */
function TrackEditor({ sample }: { sample: ResourceSample }) {
    const tracks = layout.value ?? [];
    const cat = seriesCatalog(sample);
    const setTrack = (i: number, next: TrackDef) => editLayout(tracks.map((t, k) => (k === i ? next : t)));
    // Which SECTIONS the panel shows, beside which tracks it draws — the same question ("what is in this
    // panel"), so it belongs in the same place rather than as two more controls competing for the header.
    const setSections = (laneOn: boolean, models: boolean) => {
        laneEnabled.value = laneOn; showModels.value = models;
        // The checkbox is the ENABLE, not the fold: turning the lane back on should give you the section you
        // last had, so the open state is carried through untouched rather than reset to collapsed.
        try { chrome.storage.local.set({ [SECTIONS_KEY]: { laneOn, laneOpen: showLane.value, models } }); } catch { /* opaque origin */ }
    };
    return (
        <div class="rc-editor">
            <div class="rc-erow rc-esections">
                <span class="rc-esection-label">Show</span>
                <label class="rc-eopt">
                    <input type="checkbox" checked={laneEnabled.value}
                        onChange={() => setSections(!laneEnabled.value, showModels.value)} />
                    event lane
                </label>
                <label class="rc-eopt">
                    <input type="checkbox" checked={showModels.value}
                        onChange={() => setSections(laneEnabled.value, !showModels.value)} />
                    model list
                </label>
            </div>
            {/* WHICH EVENTS ARE DRAWN — the lane's bars, the strip's ticks and the lines ruled through the chart,
                all at once, because it is the same set the lane's chip row switches. Here as well as there because
                the lane is collapsed by default, which left the chart's lines with no control at all. */}
            <div class="rc-erow rc-esections">
                <span class="rc-esection-label">Events</span>
                {LANE_KINDS.map(({ kind, label }) => (
                    <label class="rc-eopt" key={kind}>
                        <input type="checkbox" checked={!laneHidden.value.includes(kind)} onChange={() => toggleLaneKind(kind)} />
                        {label}
                    </label>
                ))}
            </div>
            {/* HOW THE CHART BEHAVES UNDER THE POINTER, beside what it draws — the same question, answered in
                the same place. It was in Settings → Appearance, which is a surface you have to LEAVE the chart
                to reach, for a mode you flip while reading one datapoint. The lane and model-list toggles are
                here for the same reason and are the precedent. (Not a `MlConfig` flag, so the
                "every setting appears in DevTools Settings" rule does not reach it — this is a sidebar display
                preference in storage.local, like the lane's height.) */}
            <div class="rc-erow rc-esections">
                <span class="rc-esection-label">Cursor</span>
                <label class="tt rc-eopt">
                    <input type="checkbox" checked={snapDot.value}
                        onChange={() => { snapDot.value = !snapDot.value; try { chrome.storage.local.set({ [SNAPDOT_KEY]: snapDot.value }); } catch { /* opaque origin */ } }} />
                    snap to datapoint
                    <span class="tt-pop wrap" role="tooltip"><TipText
                        md="Snap the crosshair to the nearest **sample** and mark it with a dot. The tooltip already reads a real datapoint — a value between two polls was never measured — so this makes the line agree with the number beside it. Useful for reading one reading; noise while scanning the shape." /></span>
                </label>
            </div>
            {/* A READING AID FOR THE TIME AXIS, off by default: faint lines at round clock intervals, so an axis
                that is linear in time looks it, and a collapsed gap shows where the spacing restarts. */}
            <div class="rc-erow rc-esections">
                <span class="rc-esection-label">Grid</span>
                <label class="tt rc-eopt">
                    <input type="checkbox" checked={timeGrid.value}
                        onChange={() => { timeGrid.value = !timeGrid.value; try { chrome.storage.local.set({ [TIMEGRID_KEY]: timeGrid.value }); } catch { /* opaque origin */ } }} />
                    time grid
                    <span class="tt-pop wrap" role="tooltip"><TipText
                        md="Faint vertical lines at a round clock interval — 5 s, 30 s, 1 min… — chosen from how much time the chart spans, and named in each plot's corner. The axis is **linear in time** within a stretch of samples, so the lines are evenly spaced; where a gap was collapsed, the spacing restarts." /></span>
                </label>
            </div>
            {/* FOR WHOEVER IS TUNING THE SERVER'S VRAM PREDICTOR, and off unless asked: a user loading a model has
                no decision these figures inform, while the person fitting the predictor needs every one of them. */}
            <div class="rc-erow rc-esections">
                <span class="rc-esection-label">Predictor</span>
                <label class="tt rc-eopt">
                    <input type="checkbox" checked={predictView.value}
                        onChange={() => { predictView.value = !predictView.value; try { chrome.storage.local.set({ [PREDICT_KEY]: predictView.value }); } catch { /* opaque origin */ } }} />
                    load predictions
                    <span class="tt-pop wrap" role="tooltip"><TipText
                        md="On each model load, what the server's **VRAM predictor** expected against what the load took: its peak, where it settled, and weights and KV cache term by term — plus a dashed line on the card where it predicted the load would land. For tuning the predictor; `ml.__loads()` returns the same records for collecting data." /></span>
                </label>
            </div>
            {/* WHAT THE CHART DRAWS AND IN WHAT COLOURS, beside the tracks it draws them on. Both lived in
                Settings, which is a surface you have to LEAVE the chart to reach — and the whole argument for
                putting them there (a paragraph each explaining what they do) stops applying the moment the
                chart is on screen while you change them. You can simply watch. Same move as the cursor row
                above, and the lane/model-list row above that.
                (Neither is a `MlConfig` flag, so the "every setting also appears in DevTools Settings" rule
                does not reach them — these are sidebar display preferences in storage.local.) */}
            <div class="rc-erow rc-esections">
                <span class="rc-esection-label">Chart</span>
                {/* THE PREFERENCE, NEVER THE LIVE WINDOW. Scrubbing writes the live window, so when these were
                    one quantity the picker read "56 seconds (dragged)" — a reading of the moment, dressed as a
                    setting, and it needed an extra option to do it because a value no preset names renders the
                    select blank. The live window is already on screen twice, in the zoom chip and the strip. */}
                <label class="tt rc-eopt rc-esel">
                    <select value={String(resWindowPref.value)} aria-label="Chart window"
                        onChange={(e: any) => {
                            const v = Number((e.target as HTMLSelectElement).value);
                            resWindowPref.value = v;
                            resWindowS.value = v;   // applies NOW — a preference you cannot see take effect reads as broken
                            zoomRange.value = null; // …and a pinned zoom would swallow the change it just made
                            try { chrome.storage.local.set({ [RESWIN_PREF_KEY]: v, [RESWIN_KEY]: v }); } catch { /* opaque origin */ }
                        }}>
                        <option value="60">1 minute</option>
                        <option value="180">3 minutes</option>
                        <option value={String(RESWIN_DEFAULT)}>5 minutes</option>
                        <option value="900">15 minutes</option>
                        <option value="1800">30 minutes</option>
                        <option value="0">Everything kept</option>
                    </select>
                    <span class="tt-pop wrap" role="tooltip"><TipText
                        md="How far back the chart looks when it opens. Samples are kept for the whole session either way — dragging the strip changes the window you are looking at now, this sets where it starts." /></span>
                </label>
                <label class="tt rc-eopt rc-esel">
                    <select value={vramPalette.value} aria-label="Model colours"
                        onChange={(e: any) => {
                            vramPalette.value = (e.target as HTMLSelectElement).value;
                            try { chrome.storage.local.set({ [VRAM_PALETTE_KEY]: vramPalette.value }); } catch { /* opaque origin */ }
                        }}>
                        <option value="vivid">Vivid</option>
                        <option value="grafana">Grafana</option>
                        <option value="cool">Cool</option>
                        <option value="warm">Warm</option>
                    </select>
                    {/* The palette itself, beside its name. It came with the control from Settings and is worth
                        more here: the chart below is already drawn in these hues, so the swatches are how you
                        tell two palettes apart without opening the select and watching the whole panel restyle. */}
                    <span class="pal-swatches">{(VRAM_PALETTES[vramPalette.value] ?? []).map((c) => <i key={c} style={{ background: c }} />)}</span>
                    <span class="tt-pop wrap" role="tooltip"><TipText
                        md="Which palette a model's colour comes from. A model's colour is its identity everywhere in the panel, so which hues read as distinct is worth choosing. Assigned by a hash of the name, so a model keeps its colour within a palette." /></span>
                </label>
            </div>
            {tracks.map((t, i) => (
                <div class="rc-etrack" key={t.id}>
                    {/* Mode and series on ONE line. They were stacked, so every track cost two rows of a panel
                        whose whole problem is vertical space — and the two belong together anyway: "stack
                        these series" is one sentence. */}
                    <div class="rc-erow">
                        {/* THE MODE IS JUDGED BY THE SAME RULE THE SERIES ARE. The refusal guarded only the
                            checkboxes — it stopped you ADDING a series that would make an unstackable track —
                            and left the mode itself unguarded, so a multi-pool track could simply be switched
                            to "stack". Nothing warned, and the renderer drew its FIRST series alone: two
                            series silently dropped, and when that card happened to be empty the panel looked
                            broken rather than wrong. */}
                        {(() => {
                            const defs = t.series.map((id) => cat.find((c) => c.id === id)!).filter(Boolean);
                            const refusal = stackRefusal(defs, sample.capacity);
                            return (
                                <span class={refusal ? "tt" : undefined}>
                                    <select class="rc-emode" aria-label="Track mode" value={t.mode}
                                        onChange={(e) => setTrack(i, { ...t, mode: (e.target as HTMLSelectElement).value as TrackDef["mode"] })}>
                                        <option value="stack" disabled={!!refusal}>stack</option>
                                        <option value="overlay">overlay</option>
                                        {/* THE WHOLE BOX ON ONE AXIS. Offered only where there is more than
                                            one pool to lay end to end — on a single pool it would be the
                                            stacked view with the models taken out, which is strictly less. */}
                                        {t.series.length > 1 && !t.series.some((x) => x.startsWith("util.")) ? <option value="total">total</option> : null}
                                    </select>
                                    {refusal ? <span class="tt-pop wrap left" role="tooltip">{refusal}</span> : null}
                                </span>
                            );
                        })()}
                        <div class="rc-eseries">
                        {cat.filter(sd => !sd.model).map(sd => {
                            const on = t.series.includes(sd.id);
                            const next = on ? t.series.filter(x => x !== sd.id) : [...t.series, sd.id];
                            const defs = next.map(id => cat.find(c => c.id === id)!).filter(Boolean);
                            // Mixing KINDS is refused in every mode (a share of time beside a share of memory
                            // compares nothing); a stack is refused on top of that where it would not add up.
                            const refusal = !on ? (kindRefusal(defs) ?? (t.mode === "stack" ? stackRefusal(defs, sample.capacity) : null)) : null;
                            return (
                                <label class={`rc-eopt${refusal ? " tt off" : ""}`} key={sd.id}>
                                    <input type="checkbox" checked={on} disabled={!!refusal}
                                        onChange={() => setTrack(i, { ...t, series: next })} />
                                    {sd.label}
                                    {refusal ? <span class="tt-pop left" role="tooltip">{refusal}</span> : null}
                                </label>
                            );
                        })}
                        </div>
                        <span class="sp" />
                        <button class="rc-ex" aria-label="Remove track"
                            onClick={() => editLayout(tracks.filter((_, k) => k !== i))}>✕</button>
                    </div>
                </div>
            ))}
            <button class="rc-eadd" onClick={() => editLayout([...tracks, { id: `t${Date.now()}`, series: [], mode: "stack", heightPx: 96 }])}>+ Add track</button>
        </div>
    );
}

/** What a hovered model row is, following the cursor. The single VRAM total hides how a model is PLACED — the
 *  same 18 GiB reads identically whether it sits on one card, is split across two, or is partly offloaded to
 *  system RAM, and that last one is why a "GPU" model can still be slow. */
/** Which datapoint of the no-ceiling fallback line the pointer is on, and where the pointer is. */
export const sparkAt = signal<{ i: number; x: number; y: number } | null>(null);

/** The fallback line's readout: what was in use, and when. There is no ceiling on this server, so there is no
 *  share to report — saying "80%" of an unknown total is the exact invention the no-ceiling fallback exists to
 *  refuse. The absolute figure and the instant are what this view genuinely knows. */
function SparkTip({ series, history }: { series: number[]; history: { t: number; models: Record<string, number> }[] }) {
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

function RowTip({ sample }: { sample: ResourceSample | null }) {
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

/** THE RESOURCE PANEL — memory over time per pool, the model list, and the event lane underneath on the
 *  same axis. Draws only; every derivation (bands, ceilings, series, history segmentation) is the pure
 *  layer in resource-model.ts. Spec + the counter-intuitive numbers: docs/spec/RESOURCE_PANEL.md. */
export function VramPanel() {
    const loaded = loadedModels.value;
    const hidden = hiddenModels.value;
    const err = psError.value;
    // Per-model snapshots (not pre-summed totals) so hiding/showing a model
    // redraws the WHOLE line against the current visibility set, not just new
    // points. (This is also the per-model VRAM log panel-v2 will build on.)
    // Each snapshot carries WHEN it was taken. The line is a history, so a hover on it has to be able to say
    // which instant it is reading — without the stamp the fallback view is the one variant of the chart that
    // could show a figure and not what time it was measured.
    const [history, setHistory] = useState<{ t: number; models: Record<string, number> }[]>([]);
    const sumVisible = (snap: Record<string, number>) =>
        Object.entries(snap).reduce((s, [m, v]) => s + (hidden.has(m) ? 0 : v), 0);
    // Tick once a second so the TTL countdowns tick down smoothly between the
    // slower /api/ps polls (VRAM_POLL_MS). Cleared on unmount (the panel is only
    // mounted while open) so it never keeps a jsdom test window alive.
    const [, tick] = useState(0);
    useEffect(() => { const id = setInterval(() => tick(t => t + 1), 1000); return () => clearInterval(id); }, []);
    useEffect(() => { pollPs(); fetchCapacity(); }, []);   // immediate poll + the denominator
    // The learned floor for the layout on screen. Keyed by the layout, so switching to a smaller view drops
    // the old floor instead of ratcheting the panel permanently taller.
    const panelRef = useRef<HTMLDivElement>(null);
    const [learned, setLearned] = useState<{ key: string; h: number }>({ key: "", h: 0 });
    const key = layoutKey(layout.value?.length || 1, (loaded || []).length,
        panelRef.current?.getBoundingClientRect().width || 0);
    const minH = learned.key === key ? learned.h : 0;
    /** Grow until the content fits, and remember that height as this layout's floor. Called after a render,
     *  and again when a DRAG ENDS — `dragging` is only read inside effects, so flipping it back triggers no
     *  re-render, and without this explicit call the panel stayed wherever the drag left it, overlapping. */
    const correct = () => {
        const el = panelRef.current;
        if (!el || !vramH.value) return;
        // A drag that has gone quiet is over, whether or not its release ever reached us.
        if (dragging.value && dragStale()) dragging.value = false;
        if (dragging.value) return;
        const floor = measureFloor(el);
        if (floor !== minH) setLearned({ key, h: floor });
        // Only ever GROWS: a height the user chose is theirs to keep, however much room is left over.
        if (el.getBoundingClientRect().height < floor - 1) easeVramH(floor);
    };
    useEffect(correct);
    // THE CHART'S KEYBOARD. Bound while the panel is open, on the document, because the pointer may be
    // anywhere by the time you want any of this.
    //
    // Esc unwinds ONE RUNG AT A TIME, most transient first: the tooltip, then a keyboard focus, then the
    // zoom. They are different kinds of thing — the tip is in the way right now, the focus is a reading you
    // are taking, the zoom is state you chose — and dismissing a popup should never be what throws away a
    // selection two rungs below it.
    //
    // The arrows only answer while the pointer is ON the chart (`crosshair` is set by the plot's own
    // pointermove and cleared when it leaves), because the whole point is reading the instant you are already
    // pointing at without moving off it. Elsewhere they stay the page's arrows, and `preventDefault` is
    // called ONLY when a key was actually used — the panel must not eat scrolling it had no use for.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape" && (e.altKey || e.ctrlKey || e.metaKey)) return;
            if (chartKey(e.key)) e.preventDefault();
        };
        document.addEventListener("keydown", onKey);
        // WHILE THE POINTER IS OVER A PLOT, tell the parent which keys the chart would use, so a shell that can
        // see the PAGE's keys relays them in (see `chartKey`). Hovering does not move focus, and the browser
        // delivers keys only to the focused document, so without this the hint offered keys that went to the
        // page until you clicked. `pointerover` rather than the plots' own handlers so every view is covered
        // by one listener; leaving the frame entirely clears it.
        const onOver = (e: PointerEvent) => { pointerOnChart.value = !!(e.target as Element | null)?.closest?.(".rc-plot"); };
        const onOut = (e: PointerEvent) => { if (!e.relatedTarget) pointerOnChart.value = false; };
        document.addEventListener("pointerover", onOver);
        document.addEventListener("pointerout", onOut);
        const stop = effect(() => {
            const keys = chartKeysWanted();
            const sig = keys.join(",");
            if (sig === lastKeysSent) return;
            lastKeysSent = sig;
            try { window.parent.postMessage({ __mlSidebarApp: "chartKeys", keys }, "*"); } catch { /* no parent */ }
        });
        return () => {
            document.removeEventListener("keydown", onKey);
            document.removeEventListener("pointerover", onOver);
            document.removeEventListener("pointerout", onOut);
            stop();
            pointerOnChart.value = false;
            lastKeysSent = "";
            try { window.parent.postMessage({ __mlSidebarApp: "chartKeys", keys: [] }, "*"); } catch { /* no parent */ }
        };
    }, []);
    // The panel already ticks once a second (the TTL countdowns); that is also what notices a drag whose
    // release never arrived, so a missed pointerup self-heals within a second instead of wedging the panel.
    useEffect(() => { const id = setInterval(correct, 1000); return () => clearInterval(id); }, [key]);
    // The newest sample, with capacity filled in — what the picker and editor describe.
    const latestSample = (() => {
        const last = resourceHistory.value.at(-1);
        return last ? { ...last, capacity: last.capacity ?? capacity.value } : null;
    })();
    // Restore the saved view once capacity is known (a layout can only be validated against a real box).
    useEffect(() => { if (latestSample?.capacity && !layout.value) restoreLayout(latestSample); }, [capacity.value]);
    // Ask what each resident model IS, once per name (see probeCaps).
    useEffect(() => { for (const m of loaded || []) probeCaps(m.model); }, [loaded]);
    useEffect(() => {
        if (!loaded) return;
        const snap: Record<string, number> = {};
        for (const m of loaded) snap[m.model] = m.vramGB || 0;
        setHistory(h => [...h, { t: Date.now(), models: snap }].slice(-VRAM_HISTORY));
    }, [loaded]);

    const evict = (model?: string) =>
        chrome.runtime.sendMessage({ type: "OLLAMA_UNLOAD", payload: model ? { model } : {} }, () => pollPs());

    if (err) return <div class="vram"><div class="vram-empty">VRAM unavailable — no Ollama backend.</div></div>;
    // Drag the panel's bottom edge to trade height with the session list below it. Which one you want more of
    // depends on what you are doing, so it is a drag rather than a setting, and it is remembered.
    const onGrab = (e: PointerEvent) => {
        e.preventDefault();
        // Take over from anything the panel was doing to itself.
        cancelEase();
        dragging.value = true;
        noteDrag();
        const grip = e.currentTarget as HTMLElement;
        const el = grip.parentElement as HTMLElement;
        // CAPTURE the pointer: without it, releasing outside the frame (drag to the top of the screen and let
        // go) delivers the pointerup somewhere else, the drag never ends, and every later self-correction is
        // blocked by a `dragging` flag that is stuck true. Capture guarantees we hear the release.
        try { grip.setPointerCapture(e.pointerId); } catch { /* older engines: the window listeners still cover the common case */ }
        const startY = e.clientY, startH = el.getBoundingClientRect().height;
        // 80px was not a usable panel: the header, a plot at its own floor, and the model rows cannot fit, so
        // the content spilled over the session list below. The floor is what the panel actually needs to hold
        // its parts.
        // NOT clamped to a remembered floor: a stale floor is exactly the thing that fights you. The drag goes
        // where you put it, and the panel corrects once you let go — and learns the floor from that.
        // The floor is measured ONCE, up front: the layout cannot change under a held pointer, and asking each
        // frame invited the answer to differ between frames — which is exactly how a drag used to stop just
        // below the true minimum and then jump on release.
        const floor = measureFloor(el);
        const move = (ev: PointerEvent) => {
            noteDrag();
            // The button came up somewhere we never heard about — end the drag rather than staying "held".
            if (ev.buttons === 0) return up();
            // Dragging UP stops at the floor — otherwise the panel keeps shrinking and the text mangles until
            // release. Dragging DOWN is never restricted.
            const h = Math.max(floor, Math.max(1, startH + (ev.clientY - startY)));
            // Apply IMPERATIVELY: the signal's render is async, and the pointer must never outrun the panel.
            el.style.height = `${h}px`;
            vramH.value = h;
        };
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            window.removeEventListener("pointercancel", up);
            grip.removeEventListener("pointerup", up);
            grip.removeEventListener("pointercancel", up);
            try { grip.releasePointerCapture(e.pointerId); } catch { /* already released */ }
            // The floor the drag was clamped against IS this layout's floor — the same number the correction
            // will compute, so nothing moves after you let go.
            setLearned({ key, h: floor });
            dragging.value = false;
            // Let the browser lay out at the released height first, then measure and correct.
            requestAnimationFrame(() => requestAnimationFrame(correct));
            try { chrome.storage.local.set({ [VRAMH_KEY]: vramH.value }); } catch { /* opaque origin */ }
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        // A cancelled gesture (the pointer leaves the surface, or the OS takes over) must end the drag too —
        // otherwise it is indistinguishable from a drag that never finished.
        window.addEventListener("pointercancel", up);
        grip.addEventListener("pointerup", up);
        grip.addEventListener("pointercancel", up);
    };

    /**
     * THE INSTANT THE TRACKS ARE DESCRIBING, whenever that is not the present.
     *
     * A track's header and legend read the last sample of the DRAWN WINDOW; this one read the live resident
     * set whatever the window was. Scrubbed back, the two sat one above the other describing different
     * moments with nothing saying so — "6.53 GiB in use" over a track whose own edge read 19.95 GiB
     * unattributed, which reads as arithmetic going wrong rather than as two clocks.
     *
     * The window comes from the SAME pure function the chart uses (`chartWindow`), because deriving it twice
     * is how the two would drift apart again. Null when the window's edge IS the newest sample — following
     * live, there is nothing to say and nothing changes.
     *
     * The model ROWS stay live deliberately. Their content is only meaningful for the present: a countdown
     * to a keep-alive deadline, a busy flag, and an evict button — and a button that acts on now, drawn
     * inside a row describing two minutes ago, acts on a different world than the one it is sitting in.
     */
    const drawnEdge = (() => {
        const scoped = laneScoped.value ? sessionWindow(timeline(), scopedHash(), Date.now(), { followMs: resWindowS.value * 1000 }) : null;
        const inWin = windowSamples(resourceHistory.value, chartWindow(zoomRange.value, scoped, resWindowS.value, Date.now(), resourceHistory.value[0]?.t));
        const last = inWin.at(-1) ?? null;
        return last && last !== resourceHistory.value.at(-1) ? last : null;
    })();
    // Total is the resident set at the instant being DRAWN — the live one whenever that is the present, which
    // is the ordinary case. Read from `loaded` rather than the sparkline history there, which lags a render
    // and resets to 0 on reopen.
    const total = drawnEdge
        ? drawnEdge.models.reduce((s, m) => s + (hidden.has(m.model) ? 0 : m.vramBytes), 0)
        : loaded ? loaded.reduce((s, m) => s + (hidden.has(m.model) ? 0 : (m.vramBytes ?? 0)), 0) : 0;
    // What the DEVICES said was in use, independent of whether anything claimed it — from the same instant,
    // so the fallback cannot answer from a different moment than the figure it stands in for.
    const boxUsed = ((drawnEdge?.capacity ?? capacity.value)?.devices ?? [])
        .reduce((s, d) => s + Math.max(0, d.totalBytes - d.freeBytes), 0);
    // Stable order so rows don't reshuffle as models load/evict.
    const rows = loaded ? [...loaded].sort((a, b) => a.model.localeCompare(b.model)) : [];
    // The rows ARE the chart's legend, so they have to cover the WINDOW, not just this instant: a model that
    // evicted five minutes ago is still drawn in its own colour across the history, and with no row for it
    // that colour has nothing to explain it. Ghost rows carry the name and the colour, nothing else — there
    // is no size, no TTL and nothing to evict.
    const live = new Set((loaded || []).map((m) => m.model));
    /**
     * EVERY MODEL THIS SESSION HAS SEEN RESIDENT, over the WHOLE history rather than the drawn window.
     *
     * It is the evidence "off-box" needs, and reading it from the window instead was wrong in a way the panel
     * itself contradicted: the scrub gesture WRITES `resWindowS` (that is what the zoom chip is), so
     * narrowing to 42 seconds pushed a model evicted a minute ago out of the ghost list, the lane went on
     * naming it, and its row came back as "off-box — never resident here" about a model you had just watched
     * load and evict. A window is a question about what to DRAW; whether something was ever here is not.
     */
    const everResident = (() => {
        const seen = new Set<string>();
        for (const s of resourceHistory.value) {
            for (const m of s.models) if (m.vramBytes > 0 || m.ramBytes > 0) seen.add(m.model);
        }
        return seen;
    })();
    const ghosts = (() => {
        const secs = resWindowS.value;
        const cutoff = secs ? Date.now() - secs * 1000 : 0;
        const seen = new Set<string>();
        for (const s of resourceHistory.value) {
            if (s.t < cutoff) continue;
            for (const m of s.models) if (!live.has(m.model) && (m.vramBytes > 0 || m.ramBytes > 0)) seen.add(m.model);
        }
        // …AND ANYTHING THE LANE STILL NAMES that was resident earlier. It is drawn — the lane is not cut to
        // the chart's window — so it needs a row to say whose colour that is, and the only honest label for a
        // model that was here and left is "evicted".
        for (const e of timeline()) {
            if (e.model && !live.has(e.model) && everResident.has(e.model)) seen.add(e.model);
        }
        return [...seen].sort();
    })();
    // Models the LANE draws that were NEVER resident here. A cloud model is the ordinary case — it occupies
    // no local memory, ever — and a delegated reader may also have finished before the panel opened. The rows
    // are the chart's legend, so a block in a colour with no row explains nothing. Called off-box rather than
    // a ghost, because "evicted" would claim it had been here and left.
    //
    // AND IT NEEDS EVIDENCE: a reading in which the model was ABSENT. With the backend unreachable there is
    // no reading at all — `pollPs` records the failure, and the resident set it leaves behind says nothing
    // about the box — so a model the lane names is not off-box, it is unplaced. Saying "off-box" there turns
    // an outage into a claim about the user's SETUP, and it was the ordinary case rather than an edge one: a
    // run whose model is still loading, against a box that has just gone away, names a model no successful
    // poll has ever seen. It corrects itself as soon as the box answers, which is exactly what makes it
    // worth fixing — a label that is wrong and then quietly right teaches you to distrust the panel.
    const residencyKnown = !psError.value;
    const offBox = (() => {
        // `everResident` is in here because the CLAIM is "never resident HERE", and the ghost list alone
        // cannot support it — it is cut to the drawn window, which is a question about what to draw.
        const known = new Set([...(loaded || []).map((m) => m.model), ...ghosts, ...everResident]);
        const loadingNow = new Set([...loadingModels.value, ...psLoading.value]);
        const out = new Set<string>();
        for (const e of timeline()) if (e.model && !known.has(e.model)) out.add(e.model);
        // A model ARRIVING gets a row too, even when the lane names nothing yet. It holds no memory we can
        // attribute and has no deadline to count down, so it cannot be a resident row — but dropping it
        // entirely makes the panel silent about the one thing it is most obviously doing.
        for (const n of loadingNow) if (!known.has(n)) out.add(n);
        return [...out].sort().map((name) => ({
            name,
            // A model with a load IN FLIGHT is the commonest way this went wrong, and the least excusable:
            // the server told us it was loading, onto this box, and the row said it was somewhere else.
            // "OFF-BOX" IS A CLAIM ABOUT WHERE A MODEL RUNS, so it needs evidence that it runs ELSEWHERE — and
            // the only such evidence is the server's provenance list saying this is not one of its models.
            // It was the fall-through instead, which made it the label for every local model the panel had
            // not yet seen resident. The case that exposed it: ask the Commander for a local model that is not
            // loaded, and between the request going out (the lane names it at once) and the server reporting a
            // `load.start`, the row called a model ollama was about to load onto this very box "off-box".
            // Then it flipped to "loading", then to resident — two corrections of a claim that never should
            // have been made. Now it reads not loaded → loading → resident, each step true when shown.
            //
            // Unknown provenance does NOT count as cloud (`isCloudModel` is false until the list lands), so a
            // model is never called off-box on the strength of the list not having arrived yet.
            kind: (loadingNow.has(name) ? "loading"
                : !residencyKnown ? "unseen"
                : isCloudModel(name) ? "off"
                : "idle") as "off" | "unseen" | "loading" | "idle",
        }));
    })();
    // SCOPED, the same way the lane is. The rows are the lane's legend, so a lane showing one session's
    // models beside a list showing the whole box reads as the panel contradicting itself — and on a shared
    // box most of the box is another tenant. Folded rather than hidden: what else is resident is exactly the
    // context for why YOUR model got evicted, so it stays one click away instead of being a fact the panel
    // knows and won't say.
    const mine = laneScoped.value && scopedHash() ? sessionModels(scopedHash()!) : undefined;
    const isMine = (name: string) => !mine || mine.includes(name);
    const otherCount = mine ? [...rows.map((m) => m.model), ...ghosts, ...offBox.map((o) => o.name)].filter((n) => !isMine(n)).length : 0;
    // The folded rows are rendered ALWAYS and collapsed by the grid below, because a height nobody knows in
    // advance cannot be animated any other way — `height: auto` does not transition, and filtering them out
    // of the tree means there is nothing to slide.
    const others = mine
        ? [...rows.filter((m) => !isMine(m.model)).map((m) => ({ kind: "row" as const, m })),
           ...offBox.filter((o) => !isMine(o.name)),
           ...ghosts.filter((n) => !isMine(n)).map((n) => ({ kind: "ghost" as const, name: n }))]
        : [];
    // The in-scope split: what is loaded NOW, and what is only named because the chart still draws it.
    const liveRows = rows.filter((m) => isMine(m.model));
    const goneRows = [...offBox.filter((o) => isMine(o.name)),
                      ...ghosts.filter(isMine).map((n) => ({ kind: "ghost" as const, name: n }))];
    // WHAT THE ARROW KEYS STEP THROUGH — exactly the rows on screen, in the order they are drawn. Not the
    // resident set and not the models in the samples: the rows ARE the chart's legend, so stepping onto a
    // name the reader cannot see would highlight a band with nothing under it to explain the colour. The
    // folded "others" are deliberately absent for the same reason — they are not on screen.
    // HIDDEN MODELS ARE NOT IN IT. Switching a model off (its colour dot) takes it out of the stack, out of
    // the totals and out of every earlier frame — so there is no shape left for a focus to point AT, and the
    // key would latch onto a name whose band is not drawn. It is still listed as a row, because the row IS
    // the control you turn it back on with.
    noteFocusOrder([...liveRows.map((m) => m.model), ...goneRows.map((o) => o.name)]
        .filter((n) => !hiddenModels.value.has(n)));

    // Recompute every point's visible-total each render, so toggling redraws the
    // full line retroactively (not just going forward).
    const series = history.map((h) => sumVisible(h.models));
    const W = 240, H = 34;
    const yMax = Math.max(1, ...series) * 1.15;
    const pts = series.length > 1
        ? series.map((v, i) => `${((i / (series.length - 1)) * W).toFixed(1)},${(H - (v / yMax) * H).toFixed(1)}`).join(" ")
        : "";
    return (
        // The floor rides along as `minHeight`, so a height chosen for a one-track view can never render a
        // three-track one on top of itself — switching views lifts the box even before you drag it.
        <div class="vram" ref={panelRef}
            style={vramH.value ? { height: `${Math.max(vramH.value, minH)}px`, minHeight: `${minH}px` } : undefined}>
            <div class="vram-head">
                {/* WHAT IS IN USE, not what /api/ps happened to attribute. The two are the same number almost
                    always and wildly different for the seconds of a load: ps has no runner object yet, so
                    attribution is zero while the card is already 92% full — and the header read "0 B in use"
                    directly beside a track saying 88.28 GiB. Measured occupancy is the honest figure there,
                    and it says whose it is not yet known to be. */}
                {total > 0 || !boxUsed ? <span class="vram-total">{formatBytes(total)} in use</span> : (
                    <span class="tt vram-total">{formatBytes(boxUsed)} in use
                        <span class="tt-pop wrap" role="tooltip">The box reports this much memory in use, and nothing is attributed to a model yet — which is what a load looks like from outside: Ollama has no runner object until it finishes, so /api/ps cannot name what is holding it.</span>
                    </span>
                )}
                {/* WHEN, whenever it is not now. A figure describing a moment you scrubbed to is not wrong,
                    but a figure that does not say which moment it describes is.
                    AFTER the figure, not before it: in front, the total slid sideways every time you scrubbed
                    or rejoined live — and the total is the thing the eye comes to this row for, so it is the
                    thing that should not move. */}
                {drawnEdge ? <span class="vram-at tt">at {hhmmss(drawnEdge.t)}
                    <span class="tt-pop wrap left" role="tooltip">The panel is showing a stretch of history rather than following live, so this figure is the reading at the right-hand edge of what is drawn — the same instant the tracks below describe. The model rows stay live: their countdowns and controls act on now.</span>
                </span> : null}
                <span class="sp" />
                {/* What the drag selected, and the way out of it. Esc does the same — a zoom you can't leave is
                    a trap, and the panel otherwise keeps showing a stretch that scrolled into the past.
                    LEFT of the view picker: it appears and disappears as you scrub, so anything after it in
                    the row would slide sideways every time a range is taken or dropped. */}
                {/* A RESIZED WINDOW IS ALSO A DEPARTURE FROM THE DEFAULT, so it gets the same way back. This
                    was gated on `zoomRange` alone — a PINNED range — so narrowing the window while still
                    following live left no control saying you had, and no way to undo it but to guess the
                    original number and drag back to it. Both states are "you are not looking at the default",
                    and the difference between them is what the ✕ restores: a pin drops back to the rolling
                    window, a resize goes back to the width the picker names. The label is formatted by the
                    same `zoomSpan` either way, so the two cannot read as different kinds of thing. */}
                {zoomRange.value || resWindowS.value !== resWindowPref.value ? (
                    <button class={`tt vram-zoom ${zoomRange.value ? "pinned" : "resized"}`} onClick={() => {
                        if (zoomRange.value) { zoomRange.value = null; return; }
                        resWindowS.value = resWindowPref.value;
                        try { chrome.storage.local.set({ [RESWIN_KEY]: resWindowPref.value }); } catch { /* opaque origin */ }
                    }}>
                        {zoomRange.value ? zoomSpan(zoomRange.value)
                            : resWindowS.value === 0 ? "all" : zoomSpan({ from: 0, to: resWindowS.value * 1000 })} ✕
                        <span class="tt-pop wrap" role="tooltip">{zoomRange.value
                            ? <>Showing the range you selected instead of the rolling window. Click, or press Esc, to go back to live.</>
                            : <>The window has been resized away from the default. Click to go back to it — the default is the one the chart's own settings name, behind the gear.</>}</span>
                    </button>
                ) : null}
                {/* BEFORE the view picker: what the panel is ABOUT comes before how it is drawn. Not gated on
                    capacity like the picker is — scoping still governs the lane and the model list on a box
                    that answers no /api/info, and hiding the switch there would leave a scoped panel with no
                    way to say so. */}
                <ScopeSwitch />
                {capacity.value && latestSample ? (
                    <>
                        <select class="rc-preset" aria-label="View" value={presetId.value}
                            onChange={(e) => choosePreset((e.target as HTMLSelectElement).value, latestSample)}>
                            {presetsFor(latestSample).map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                            {/* Only offered once you HAVE edited — picking "Custom" from a preset would mean nothing. */}
                            {/* Offered whenever a custom layout EXISTS, not only while it is active — otherwise
                                there is no way back to it after glancing at a preset. */}
                            {customTracks.value ? <option value="custom">Custom</option> : null}
                        </select>
                    </>
                ) : null}
                {rows.length ? <button class="vram-free" onClick={() => evict()}>Free VRAM</button> : null}
                {/* Last in the row: the picker is what you reach for, the editor is the rarer follow-up. */}
                {capacity.value && latestSample ? (
                    /* The real gear icon, not a ⚙ text glyph: the glyph rendered thin and font-sized, so it
                       came out smaller than everything around it and unreadable at panel scale. Same icon and
                       the same .hbtn treatment as the header's own settings button. */
                    <button class={`tt hbtn rc-cog${editorOpen.value ? " on" : ""}`} aria-label="Edit tracks"
                        onClick={() => (editorOpen.value = !editorOpen.value)}><IconGear />
                        <span class="tt-pop" role="tooltip">Choose which series each track shows</span>
                    </button>
                ) : null}
            </div>
            {/* Kept MOUNTED so it can animate both ways: unmounting on close would snap it out of existence,
                and a collapse has nothing to animate if the content is already gone. */}
            {latestSample ? <div class={`rc-editor-wrap${editorOpen.value ? " open" : ""}`}
                // Present but not reachable while collapsed — an invisible editor must not swallow a Tab.
                inert={editorOpen.value ? undefined : true} aria-hidden={editorOpen.value ? undefined : "true"}>
                <TrackEditor sample={latestSample} />
            </div> : null}
            <GpuFaults />
            <RowTip sample={latestSample} />
            {capacity.value
                ? <ResourceTracks samples={resourceHistory.value} capacity={capacity.value} hidden={hidden} layout={layout.value} events={timeline()} />
                : !capacityAsked.value
                /* Haven't heard back yet — hold an empty plot rather than flashing the legacy chart and
                   replacing it a moment later. */
                ? <div class="rc"><div class="rc-track"><div class="rc-plot" /></div></div>
                /* Asked, and this server doesn't serve /api/info (stock Ollama, or an OpenWebUI without the
                   passthrough): capacity is UNKNOWN, so fall back to the old auto-scaled shape rather than
                   drawing a ceiling we don't have. */
                : <>
                    {/* Hoverable like every other variant. This one has no ceiling to be a share OF, so the
                        readout is the absolute figure and the instant — which is all this view ever knew. */}
                    <div class="vram-spark-wrap"
                        onPointerMove={(e: PointerEvent) => {
                            const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
                            const f = Math.min(1, Math.max(0, (e.clientX - box.left) / Math.max(1, box.width)));
                            sparkAt.value = series.length > 1
                                ? { i: Math.round(f * (series.length - 1)), x: e.clientX, y: e.clientY } : null;
                        }}
                        onPointerLeave={() => (sparkAt.value = null)}>
                        <svg class="vram-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
                            {pts ? <polyline points={pts} fill="none" stroke="var(--accent)" stroke-width="1.5" /> : null}
                            {sparkAt.value && series.length > 1 ? (
                                <>
                                    <line class="vram-spark-rule" x1={(sparkAt.value.i / (series.length - 1)) * W} x2={(sparkAt.value.i / (series.length - 1)) * W}
                                        y1={0} y2={H} vector-effect="non-scaling-stroke" />
                                    <circle class="vram-spark-dot" r="3" vector-effect="non-scaling-stroke"
                                        cx={(sparkAt.value.i / (series.length - 1)) * W}
                                        cy={H - (series[sparkAt.value.i] / yMax) * H} />
                                </>
                            ) : null}
                        </svg>
                    </div>
                    <SparkTip series={series} history={history} />
                    {/* An unexplained plain line just looks like the panel regressed to an older design. Say
                        what is missing and why, so a shape with no ceiling is legible as a degraded view. */}
                    <span class="tt vram-nocap">no ceiling — capacity unknown
                        <span class="tt-pop wrap" role="tooltip">This server doesn't answer /api/info, so how much memory the machine HAS is unknown. The line is auto-scaled to whatever has been resident, not drawn against a real capacity — no bands, no free space, no per-device split.</span>
                    </span>
                </>}
            {showModels.value && liveRows.length
                ? liveRows.map(m => (
                    <ModelRow key={m.model} m={m} hidden={hidden} latestSample={latestSample} evict={evict} />
                ))
                // "Nothing loaded" only when there is NOTHING — no evicted rows the chart is still drawing,
                // no models out of scope. With either of those below it, it sat as a flat contradiction over
                // a list of models: the panel saying it has nothing directly above two things it has.
                : !showModels.value || goneRows.length || otherCount ? null
                    : <div class="vram-empty">Nothing loaded.</div>}
            {/* NOT RESIDENT, AND FOLDED. These rows exist to name a colour the chart is still drawing — an
                evicted model in the window it covers, or one that only ever ran off-box — which is a
                REFERENCE you consult, not a list you read. Inline they pushed the models that ARE loaded
                down the panel and made a box with two models look like a box with six. The same disclosure
                the out-of-scope models use, so "there is more here" means one thing in this list.
                Off-box first: a cloud model is a standing fact about the setup, where an eviction is a thing
                that just happened. */}
            {showModels.value && goneRows.length ? (
                <Disclosure label="not resident" note={`${goneRows.length}`}>
                    {goneRows.map((o) => <GhostRow key={`${o.kind}:${o.name}`} name={o.name} kind={o.kind} />)}
                </Disclosure>
            ) : null}
            {/* What the scope is NOT showing, and the way to see it. A count rather than a silent
                omission: a list that just gets shorter reads as models having been evicted. */}
            {/* The same disclosure every other opening section uses — as a bare line of text this was the one
                interactive thing on the panel that did not look interactive. */}
            {showModels.value && otherCount ? (
                <Disclosure label={`other model${otherCount === 1 ? "" : "s"} on the box`} note={`${otherCount}`}>
                    {others.map((o) => (o.kind === "row"
                        ? <ModelRow key={o.m.model} m={o.m} hidden={hidden} latestSample={latestSample} evict={evict} />
                        : <GhostRow key={`${o.kind}:${o.name}`} name={o.name} kind={o.kind} />))}
                </Disclosure>
            ) : null}
        <div class="vram-grip" role="separator" aria-label="Drag to resize the resource panel"
                title="Drag to resize" onPointerDown={onGrab} />
        </div>
    );
}

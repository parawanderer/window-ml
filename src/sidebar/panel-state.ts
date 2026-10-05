// panel-state.ts — what the resource panel currently KNOWS, held where both halves of it can read.
//
// The box's capacity, the samples polled so far, which pools are hidden, the chosen layout, the lane's filter,
// the palette and the colour each model is drawn in. None of it belongs to one view: the panel component reads
// it to draw the rows, the chart reads it to draw the plots, and the lane reads it to decide what is in scope.
//
// It lived in vram.tsx, which is where the panel COMPONENT is, and that is the accident this module fixes.
// Because the chart imported nineteen names from vram and vram imported seven back, the two files were one
// module in two halves, and nothing could be lifted out of either without the import graph closing behind it.
// Everything here is state or a pure reading of it — no JSX — so it can sit underneath both.

import { signal } from "@preact/signals";
import { STREAM_MAX_GAP_MS, MAX_SAMPLE_GAP_MS, STREAM_SAMPLE_MS } from "../resource-axis";
import type { LaneFilter } from "../resource-lane";
import { type ResourceSample, normModel } from "../resource-model";
import { type Capacity } from "../resource-capacity";
import { type TrackDef, presetRefusal, presetsFor } from "../resource-presets";
import { usageByModel, type UsageSource } from "./model-stats";
import { scopedHash, laneScoped, laneHidden, sessionMap } from "./store";
import type { Band } from "../resource-bands";

export const VRAM_HISTORY = 45, VRAM_POLL_MS = 2000;   // samples kept, and how often we ask — polling is gated on the panel being open, so gaps are real gaps

// EVERY MEMORY SAMPLE this session took, per box. Session-only and dropped on a backend change: redrawing
// one box's readings against another's ceiling looks like a measurement rather than a mistake.
export const resourceHistory = signal<ResourceSample[]>([]);

// WHAT THE BOX CAN HOLD (`/api/info`, patched Ollama only). A fact about the MACHINE, not about a poll —
// a request that learns nothing must not forget what was measured, or the panel swaps to the no-ceiling
// fallback until some later poll happens to succeed. Null = never answered, which is drawn as unknown.
export const capacity = signal<Capacity | null>(null);

/** Pools (a card, or the host) the user has clicked OFF in the Overview legend. The legend key already IS the
 *  line's identity — its swatch, its name, its figure — so making it the switch adds an affordance rather than
 *  a control, which is the same bargain the model rows make. Session-only, like {@link hiddenModels}: it is a
 *  reading choice about what is on screen now, not a setting about the box. */
export const hiddenPools = signal<Set<string>>(new Set());

/** Switch one memory pool's line off and back on (a legend key). */
export const togglePool = (id: string): void => {
    const next = new Set(hiddenPools.value);
    next.has(id) ? next.delete(id) : next.add(id);
    hiddenPools.value = next;
};

// Poll Ollama's resident-model set (/api/ps) into the shared signals, for BOTH
// the VRAM panel and the header status dot. Gated so it never hammers Ollama in
// the background: only while the shell is slid open AND something needs it (the
// panel is up, or a detail header — the only place a status dot shows).
/** Is the event stream carrying? While it is, polling stands down — two transports feeding the same history
 *  would double every sample and draw it at twice the true density. Null until we know (a fresh open has not
 *  asked yet); false means this server does not serve the route, which is the ordinary stock-Ollama case and
 *  not an error. */
export const streamLive = signal(false);

/** How far apart two samples may be before the history is a HOLE rather than a quiet stretch. It depends on
 *  the transport, because a gap means a different thing on each — see the two constants. Read at render time
 *  rather than baked in, since a stream can drop mid-session and the answer changes with it. */
export const sampleGapMs = (): number => (streamLive.value ? STREAM_MAX_GAP_MS : MAX_SAMPLE_GAP_MS);

/** How far past the last sample still belongs to the final run — one sampling interval, whichever transport
 *  is providing them. */
export const sampleGraceMs = (): number => (streamLive.value ? STREAM_SAMPLE_MS : VRAM_POLL_MS);

/** The filter as the lane sees it. */
export function laneFilter(): LaneFilter {
    const hash = scopedHash();
    return {
        hash,
        scope: laneScoped.value ? "session" : "all",
        hidden: laneHidden.value as LaneFilter["hidden"],
        // Which models THIS session ran — the ledger already answers it, delegated readers charged to the
        // reader, which is what makes a sub-call's load belong to the session that caused it.
        models: hash ? sessionModels(hash) : undefined,
    };
}

/** The models a session ran, for scoping the machine half of the lane. Undefined when the session is not
 *  known — "no models" and "not known" must not collapse, since one hides nothing and the other hides all. */
export function sessionModels(hash: string): readonly string[] | undefined {
    const s = sessionMap.get(hash);
    if (!s) return undefined;
    return Object.keys(usageByModel([s] as UsageSource[])).map(normModel);
}

/** Whether this frame's own document has focus, so keys typed now reach `chartKey` without any relay. */
export const frameFocused = signal(typeof document !== "undefined" && document.hasFocus());

/** The parent relays the page's keys while the pointer is on the chart (the overlay's shell says so on ready).
 *  The DevTools panel cannot: keys typed while another DevTools pane has focus never reach it. */
export const keyRelay = signal(false);

/** Will ↑↓ reach the chart from where the keyboard is now? What the key hints read, so they never offer keys
 *  that go somewhere else until you click. */
export const keysReach = (): boolean => keyRelay.value || frameFocused.value;

export const layout = signal<TrackDef[] | null>(null);   // which tracks are drawn, in what mode, at what height (null = use the preset)

/** What a hovered pool holds RIGHT NOW: total in use, and each consumer that has any of it. */
export function poolFacts(bands: Band[]): { used: number; consumers: { label: string; bytes: number; model?: string }[] } {
    return {
        used: bands.filter((b) => b.kind !== "free").reduce((n, b) => n + b.bytes, 0),
        // Including the residual, which is most of what a nearly-idle card holds and is the thing a reader
        // would otherwise go looking for a process to explain. `model` rides along so the tip can carry each
        // consumer's own colour — the residual has none, because it is not a model.
        consumers: bands.filter((b) => b.kind !== "free" && b.bytes > 0)
            .map((b) => ({ label: b.label, bytes: b.bytes, ...(b.model ? { model: b.model } : {}) })),
    };
}

// The chosen VIEW. A preset is a named starting point for a layout, and editing one is the same operation on
// the same state (`TrackDef[]`) — so there is no "am I in preset mode or edit mode" to get wrong. `layout`
// null means "use the default preset for this box", which is also the fallback when a saved layout doesn't
// fit the machine we're now pointed at.
export const LAYOUT_KEY = "ml_res_layout";

export const presetId = signal<string>("");   // the chosen track PRESET (derived from the box's catalog, and validated against the stacking rule)

/** The last CUSTOM layout, kept beside the active one. Picking a preset used to overwrite the stored tracks,
 *  so a layout you had built by hand was destroyed the moment you looked at a preset — and the "Custom" entry
 *  only existed while it was already selected, so there was no way back to it either. */
export const customTracks = signal<TrackDef[] | null>(null);

/** Restore a saved view, but only if it still describes THIS box — a layout saved on a two-card server names
 *  `vram.1`, which is meaningless on a one-device Mac. Anything that doesn't fit falls back to the default
 *  preset rather than rendering a track for a card that isn't there. */
export function restoreLayout(sample: ResourceSample): void {
    chrome.storage.local.get([LAYOUT_KEY], (got: Record<string, unknown>) => {
        const saved = got?.[LAYOUT_KEY] as { presetId?: string; tracks?: TrackDef[]; custom?: TrackDef[] } | undefined;
        const presets = presetsFor(sample);
        const fallback = () => { presetId.value = presets[0]?.id ?? ""; layout.value = presets[0]?.tracks ?? null; };
        if (!saved?.tracks?.length) return fallback();
        // A saved PRESET is re-derived, never replayed. Storing its tracks would pin the preset as it was the
        // day you picked it: Overview later gained the host pool, and a layout saved before that kept showing
        // a cards-only chart with a CPU-resident model missing from it. Only a CUSTOM layout is a literal
        // record of choices, and only that is restored verbatim.
        // A custom layout that still fits this box is offered again even when a preset is active.
        if (saved.custom?.length && !presetRefusal({ id: "c", label: "", description: "", tracks: saved.custom }, sample))
            customTracks.value = saved.custom;
        const named = saved.presetId && saved.presetId !== "custom"
            ? presets.find((x) => x.id === saved.presetId) : null;
        if (named) { presetId.value = named.id; layout.value = named.tracks; return; }
        const probe = { id: "saved", label: "", description: "", tracks: saved.tracks };
        if (presetRefusal(probe, sample)) return fallback();   // saved on another machine, or now invalid
        presetId.value = "custom";
        layout.value = saved.tracks;
        customTracks.value = saved.tracks;
    });
}

const saveLayout = (): void => {
    try {
        chrome.storage.local.set({ [LAYOUT_KEY]: {
            presetId: presetId.value, tracks: layout.value,
            ...(customTracks.value ? { custom: customTracks.value } : {}),
        } });
    } catch { /* opaque origin */ }
};

/** Pick a preset: it POPULATES the layout, which the editor then edits in place. */
export function choosePreset(id: string, sample: ResourceSample): void {
    // "Custom" is a real destination, not just a state you fall into: it restores the layout you built.
    if (id === "custom" && customTracks.value) { presetId.value = "custom"; layout.value = customTracks.value; return saveLayout(); }
    const p = presetsFor(sample).find((x) => x.id === id);
    if (!p) return;
    presetId.value = p.id; layout.value = p.tracks; saveLayout();
}

/** Any edit flips the picker to Custom — the layout no longer IS that preset. */
export function editLayout(tracks: TrackDef[]): void {
    layout.value = tracks; presetId.value = "custom";
    customTracks.value = tracks;   // kept so a detour through a preset doesn't destroy it
    saveLayout();
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

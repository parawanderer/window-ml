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
import { type ResourceSample, type Capacity, normModel, type TrackDef } from "../resource-model";
import { usageByModel, type UsageSource } from "./model-stats";
import { scopedHash, laneScoped, laneHidden, sessionMap } from "./store";
import type { Band } from "../resource-bands";

// --- VRAM monitor ---
/**
 * The palettes a model's colour can come from. A model's colour is its identity across the whole panel — the
 * line, the band, the row, its lane blocks, its ticks on the strip — so this is a real preference rather
 * than decoration: which eight hues read as distinct depends on the display, the theme and the eyes.
 *
 * `grafana` is the classic dashboard palette, which is what a lot of people are already reading GPU graphs
 * in; `warm`/`cool` narrow the range for a panel sitting beside other colour; `vivid` is the original.
 * Every palette is eight long, because the assignment hashes a name into it and a shorter one collides more.
 */
export const VRAM_PALETTES: Record<string, string[]> = {
    vivid:   ["#6366f1", "#22c55e", "#f59e0b", "#ec4899", "#06b6d4", "#a855f7", "#ef4444", "#84cc16"],
    grafana: ["#7EB26D", "#EAB839", "#6ED0E0", "#EF843C", "#E24D42", "#1F78C1", "#BA43A9", "#705DA0"],
    cool:    ["#4C78A8", "#54A24B", "#72B7B2", "#B279A2", "#439894", "#5C7EC1", "#83B4D8", "#3F8F7A"],
    warm:    ["#E45756", "#F58518", "#EECA3B", "#B279A2", "#D67195", "#C4693D", "#E7955A", "#B4451F"],
};

/** Which one is in use. A sidebar-only display pref in `chrome.storage.local`, like the font scale and the
 *  code-block prefs — it changes how the panel LOOKS, not what the extension does, so it has no business in
 *  the synced `MlConfig`. */
export const vramPalette = signal<string>("vivid");

/** A model's colour: its name hashed into the chosen palette, so it is stable for as long as the model is
 *  called the same thing and identical on every surface that draws it. */
export const colorFor = (name: string) => {
    const p = VRAM_PALETTES[vramPalette.value] ?? VRAM_PALETTES.vivid;
    return p[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % p.length];
};

/** A POOL's colour. Pools are an ordered set, not names to hash, so they get distinct colours by construction
 *  — which `VRAM_COLORS[i % 8]` stopped doing on a box with more than eight pools: an 8-GPU node (eight cards
 *  plus system RAM) gave card 0 and System RAM the same indigo, in a legend whose entire job is telling the
 *  lines apart. Past the curated palette, hues are spread evenly over however many pools there are. */
export function poolColor(i: number, count: number): string {
    const pal = VRAM_PALETTES[vramPalette.value] ?? VRAM_PALETTES.vivid;
    if (count <= pal.length) return pal[i % pal.length];
    // Golden-angle-free even spread: with the count known, evenly spaced hues are maximally far apart, and
    // fixed saturation/lightness keeps them legible on both themes.
    return `hsl(${Math.round((i * 360) / count)}deg 70% 55%)`;
}

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

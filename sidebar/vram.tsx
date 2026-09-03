// Model / VRAM diagnostics — the server model-list fetch, the Ollama /api/ps VRAM monitor panel + its
// polling, per-model load-state, backend-health probing, and the Python sandbox bench. A separate,
// self-contained surface from the run views. Extracted from app.tsx.
import { useState, useEffect, useRef } from "preact/hooks";
import type { RenderDescriptor } from "../contract";
import { fmtCtx, isBackendUnreachable } from "../contract";
import { signal } from "@preact/signals";
import {
    config, models, ollamaIds, loadedModels, psError, vramOpen, backendError, rev, sessionMap,
    sidebarOpen, view,
} from "./store";
import { truncate } from "./format";
import { normModel, seenContext } from "./model";
import { IconVram, IconEye, IconEyeOff, IconBench, IconGear } from "./icons";
import { useTipPlacement } from "./use-tip";
import { VRAMH_KEY, vramH, resWindowS, zoomRange } from "./store";
import { usageByModel, eventsFrom, type UsageSource } from "./model-stats";
import type { RunStats } from "../contract";
import { parseInfo, holdCapacity, formatBytes, boxSignature, sameBoxOnly, presetsFor, presetRefusal, seriesCatalog, stackRefusal, placementOf, isSplit, residencyEvents, type ResourceEvent, type Band, type Capacity, type ResourceSample, type ModelResidency, type TrackDef } from "../resource-model";
import { ResourceTracks } from "./resource-chart";
import type { LoadedModel } from "../contract";

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
    return {
        model: m.model, vramBytes: vram, ramBytes: Math.max(0, size - vram), perDevice,
        contextLength: m.contextLength, expiresAt: m.expiresAt ? Date.parse(m.expiresAt) || null : null,
    };
}
import { RenderPanel } from "./render-panel";

// Fetch the server's model list via the background worker (privileged fetch);
// degrade silently if unreachable. Populates the datalists.
export function fetchModels(): void {
    chrome.runtime.sendMessage({ type: "LIST_MODELS", payload: {} }, (resp: any) => {
        if (chrome.runtime.lastError || !resp || resp.error) return;
        models.value = resp.data || [];
        ollamaIds.value = resp.ollamaModels ?? null;   // null = provenance unknown (skip cloud detection)
    });
}


// --- VRAM monitor ---
export const VRAM_COLORS = ["#6366f1", "#22c55e", "#f59e0b", "#ec4899", "#06b6d4", "#a855f7", "#ef4444", "#84cc16"];
export const colorFor = (name: string) => VRAM_COLORS[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % VRAM_COLORS.length];
/** A POOL's colour. Pools are an ordered set, not names to hash, so they get distinct colours by construction
 *  — which `VRAM_COLORS[i % 8]` stopped doing on a box with more than eight pools: an 8-GPU node (eight cards
 *  plus system RAM) gave card 0 and System RAM the same indigo, in a legend whose entire job is telling the
 *  lines apart. Past the curated palette, hues are spread evenly over however many pools there are. */
export function poolColor(i: number, count: number): string {
    if (count <= VRAM_COLORS.length) return VRAM_COLORS[i % VRAM_COLORS.length];
    // Golden-angle-free even spread: with the count known, evenly spaced hues are maximally far apart, and
    // fixed saturation/lightness keeps them legible on both themes.
    return `hsl(${Math.round((i * 360) / count)}deg 70% 55%)`;
}
export const VRAM_HISTORY = 45, VRAM_POLL_MS = 2000;
// Session-long history, in a MODULE signal rather than component state: the old panel kept 45 samples in
// useState and threw them away on every close, so "what happened during that run" was unanswerable the moment
// you looked away. ~30 min at 2s is ~900 samples of a few numbers each — kilobytes. Session-only by choice:
// it dies with the page, and gaps (the panel was closed, so nothing was polled) stay gaps.
export const RESOURCE_HISTORY = 900;
export const resourceHistory = signal<ResourceSample[]>([]);
// Machine CAPACITY — the denominator. The TOTALS change only when hardware does, but `free_memory` rides in
// the same payload and changes with every load and evict, so fetching once per open froze the free and
// residual bands at whatever they were when you opened the panel (a card would read "18 GiB in use" beside
// "free 94.42 GiB"). Refreshed on a SLOWER cadence than ps instead: often enough to track occupancy, rarely
// enough not to hammer a route whose totals never move.
// null = unknown (the route isn't served): the chart then draws no ceiling rather than pretending it is zero.
export const CAPACITY_EVERY = 5;   // ps polls between capacity refreshes (5 x 2s = 10s)
let psSinceCapacity = 0;
export const capacity = signal<Capacity | null>(null);
// Whether we have ASKED yet. `capacity: null` alone can't tell "the fetch hasn't come back" from "this server
// doesn't serve /api/info", and the fallback for the second is the old sparkline — so on every open the panel
// flashed the legacy chart for a moment before the tracks replaced it. Until the first answer lands the plot
// is simply empty.
export const capacityAsked = signal(false);
export function fetchCapacity(): void {
    chrome.runtime.sendMessage({ type: "OLLAMA_INFO", payload: {} }, (resp: any) => {
        capacityAsked.value = true;
        if (chrome.runtime.lastError || !resp || resp.error) return;   // leave capacity unknown
        const next = holdCapacity(capacity.value, parseInfo(resp.data));
        if (!next || next === capacity.value) return;   // this poll learned nothing new
        // Pointing at a DIFFERENT machine (a CUDA server, then a Metal Mac) invalidates the history: those
        // samples were measured against another ceiling, on devices whose ids mean different hardware. Drawing
        // them here would clip an 18 GiB band against an 11.84 GiB ceiling and look like a reading.
        // A SWITCH means one known box replaced by a different known box. The first fetch (unknown → known)
        // is not one: treating it as such would drop every sample taken before capacity arrived, which on a
        // fresh open is all of them — the panel would render nothing until the next poll.
        const switched = !!capacity.value && boxSignature(next) !== boxSignature(capacity.value);
        // On a switch, drop samples that can't be attributed to EITHER box as well — an unattributed sample is
        // backfilled with the current capacity at render, which after a switch means drawing the old machine's
        // readings against the new machine's ceiling.
        if (switched) {
            resourceHistory.value = sameBoxOnly(resourceHistory.value, next, true);
            // The LAYOUT is per-box too: one naming `vram.1` is meaningless on a machine with one device, and
            // TrackView would silently drop those tracks rather than falling back to something that fits.
            // Clearing it re-runs restoreLayout against the NEW box, where presetRefusal rejects a stale saved
            // layout and hands back that box's default.
            layout.value = null;
        }
        capacity.value = next;
    });
}
// Models the user has hidden from the totals/graph (session-only; a signal so it
// survives VramPanel remounts). Immutable Set updates so the signal notifies.
export const hiddenModels = signal<Set<string>>(new Set());
export const toggleHidden = (model: string): void => {
    const next = new Set(hiddenModels.value);
    next.has(model) ? next.delete(model) : next.add(model);
    hiddenModels.value = next;
};

// Poll Ollama's resident-model set (/api/ps) into the shared signals, for BOTH
// the VRAM panel and the header status dot. Gated so it never hammers Ollama in
// the background: only while the shell is slid open AND something needs it (the
// panel is up, or a detail header — the only place a status dot shows).
export function pollPs(): void {
    if (!sidebarOpen.value) return;
    if (!vramOpen.value && view.value.name !== "detail") return;
    chrome.runtime.sendMessage({ type: "OLLAMA_PS", payload: {} }, (resp: any) => {
        if (chrome.runtime.lastError || (resp && resp.error)) {
            psError.value = (resp && resp.error) || chrome.runtime.lastError?.message || "unavailable";
            loadedModels.value = []; return;
        }
        psError.value = null;
        const loaded = resp.data || [];
        // Remember each resident model's window (overwrite → tracks a mid-run reload).
        for (const m of loaded) if (typeof m.contextLength === "number") seenContext.set(normModel(m.model), m.contextLength);
        loadedModels.value = loaded;
        // One sample per poll, carrying the capacity in force at the time — a sample read back from history
        // must know the ceiling it was drawn against, not today's.
        const sample: ResourceSample = {
            t: Date.now(),
            models: loaded.map((m: LoadedModel) => residencyOf(m)),
            capacity: capacity.value,
        };
        resourceHistory.value = [...resourceHistory.value, sample].slice(-RESOURCE_HISTORY);
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
export function pollBackendHealth(): void {
    if (healthInFlight) return;   // one in flight at a time; the timeout guarantees it always settles
    healthInFlight = true;
    let settled = false;
    const finish = (unreachable: string | null): void => {
        if (settled) return;
        settled = true; healthInFlight = false;
        backendError.value = unreachable || "";
    };
    const timer = setTimeout(
        () => finish(`Couldn't reach the server at ${config.value.chatUrl || "the configured URL"} — no response. Is it running?`),
        BACKEND_HEALTH_TIMEOUT_MS);
    try {
        chrome.runtime.sendMessage({ type: "LIST_MODELS", payload: {} }, (resp: { error?: string } | undefined) => {
            clearTimeout(timer);
            const err = chrome.runtime.lastError?.message || resp?.error || "";
            // Only a NETWORK-level failure means "the box is gone". An HTTP / "no models installed" error means
            // the server ANSWERED → reachable (clear). Any data likewise → reachable.
            finish(err && isBackendUnreachable(err) ? err : null);
        });
    } catch { clearTimeout(timer); finish(null); }   // extension context gone → don't nag
}

// "expires in Xs/Xm" from an /api/ps expires_at ISO stamp (Ollama's TTL).
export function expiresIn(expiresAt: string | null): string | null {
    if (!expiresAt) return null;
    const ms = new Date(expiresAt).getTime() - Date.now();
    if (isNaN(ms) || ms <= 0) return null;
    const s = Math.round(ms / 1000);
    return s < 90 ? `expires in ${s}s` : `expires in ${Math.round(s / 60)}m`;
}

// Live keep-alive countdown from an /api/ps expires_at stamp, as a compact
// two-unit d/h/m/s string ("2d 3h", "5m 12s", "44s") for the VRAM row. Ollama
// evicts a model once this hits zero; each use resets it (Ollama recomputes
// expires_at). Returns null when there's no stamp or it's already elapsed.
export function fmtTTL(expiresAt: string | null): string | null {
    if (!expiresAt) return null;
    const ms = new Date(expiresAt).getTime() - Date.now();
    if (isNaN(ms) || ms <= 0) return null;
    let s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${s}s`;
    return `${s}s`;
}

// Live model-load state for the header's "responds-next" model, from /api/ps
// (resident) + the installed list + our own in-flight flag. Five states, detail
// in the tooltip (see SIDEBAR_UI_FEEDBACK.md). Reads signals directly so it
// updates on each poll; model/inFlight arrive as plain props.
export type LoadState = "loaded" | "cold" | "inflight" | "unavailable" | "cloud" | "unknown";
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
        // size_vram (vramGB) vs size (sizeGB) → fully-CPU / partial-offload / full-GPU.
        const v = resident.vramGB, sz = resident.sizeGB;
        const where = !v
            ? (sz ? `on CPU (${sz} GB RAM)` : "on CPU (RAM)")
            : (sz && v < sz - 0.1 ? `${v} of ${sz} GB in VRAM — partial CPU offload (slower)` : `${v} GB VRAM`);
        const bits = [where, expiresIn(resident.expiresAt)].filter(Boolean);
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


export function ModelStatusDot({ model, inFlight }: { model: string; inFlight: boolean }) {
    const { state, tip } = modelLoadState(model, inFlight);
    return (
        <span class="tt">
            <span class={`dot ${state}`} />
            <span class="tt-pop left" role="tooltip">{tip}</span>
        </span>
    );
}

// Live VRAM: a sparkline of total usage over time + a per-model legend with
// evict controls. Reads the shared OLLAMA_PS signals (polled at App level while
// the sidebar is open) and accumulates the sparkline history locally.
/** The facts about one resident model: context window and keep-alive TTL, each with its explanation. Shared
 *  by the legend row and the chart's hover tooltip so the two can never drift — a badge added here appears in
 *  both placements, which is the whole reason this isn't inlined twice. */
// What each resident model can DO, by name. /api/ps says nothing about a model's role, so an embedding model
// sits in the list looking exactly like a chat model — and one of those is 5.8 GiB of a card you were trying
// to account for. /api/show knows (`capabilities` includes "embedding"), so ask ONCE per model and keep it:
// capabilities don't change while a model is loaded, and the panel re-renders every two seconds.
export const modelCaps = signal<Record<string, string[] | null>>({});
const capsAsked = new Set<string>();
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
/** Only a POSITIVE answer counts: a cloud model or an old Ollama reports nothing, and "unknown" must not be
 *  rendered as a claim either way. */
export const isEmbedding = (model: string): boolean => !!modelCaps.value[model]?.includes("embedding");

/** What this model has COST this browsing session, across every chat and run in the list. Recomputed from the
 *  session map on each render rather than kept as its own accumulator: the map IS the record, and a second
 *  copy is a second thing to keep true. `rev` is what makes it re-read (the map mutates in place). */
export function costOf(model: string): RunStats | null {
    void rev.value;
    return usageByModel([...sessionMap.values()] as UsageSource[])[model] ?? null;
}

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
    const fromSessions = eventsFrom([...sessionMap.values()] as UsageSource[]);
    return [...fromSessions, ...residencyEvents(resourceHistory.value, fromSessions)].sort((a, b) => a.t - b.t);
}

/** The cost line under a model's name: what it spent, and how fast — with the rate's BASIS said out loud,
 *  since one from Ollama's own eval timings and one from wall clock (network and queue included) are not the
 *  same measurement. */
export function CostFacts({ model }: { model: string }) {
    const c = costOf(model);
    if (!c || !c.calls) return null;
    return (
        <div class="vram-cost">
            {c.calls} call{c.calls === 1 ? "" : "s"} · {c.inTokens.toLocaleString()} in / {c.outTokens.toLocaleString()} out
            {c.tokPerSec != null ? <> · {c.tokPerSec.toFixed(1)} tok/s <span class="rc-tip-pct">({c.genBasis === "eval" ? "generation only" : c.genBasis === "wall" ? "incl. network" : "mixed"})</span></> : null}
        </div>
    );
}

export function ModelFacts({ m, tips = true }: { m: LoadedModel; tips?: boolean }) {
    const ttl = fmtTTL(m.expiresAt);
    // Only the row's copy has its own tooltips to defer to; the chart tip renders these as plain text.
    const yieldTip = tips
        ? { onPointerEnter: () => (rowTipSuppressed.value = true), onPointerLeave: () => (rowTipSuppressed.value = false) }
        : {};
    return (
        <>
            {isEmbedding(m.model) ? (
                <span class={tips ? "tt vram-embed" : "vram-embed"} {...yieldTip}>embed
                    {tips ? <span class="tt-pop left above" role="tooltip">An EMBEDDING model — it turns text into vectors for search and retrieval; it doesn't chat. It holds its VRAM like any other resident model, and evicts the same way.</span> : null}
                </span>
            ) : null}
            {m.contextLength ? (
                <span class={tips ? "tt vram-ctx" : "vram-ctx"} {...yieldTip}>{fmtCtx(m.contextLength)}
                    {tips ? <span class="tt-pop left above" role="tooltip">Loaded with a {m.contextLength.toLocaleString()}-token context window. Ollama preallocates the KV cache for the FULL window, even when your prompts are short. Load with a smaller <code>num_ctx</code> to reclaim it.</span> : null}
                </span>
            ) : null}
            {ttl ? (
                <span class={tips ? "tt vram-ttl" : "vram-ttl"} {...yieldTip}>{ttl}
                    {tips ? <span class="tt-pop left above" role="tooltip">Keep-alive TTL — Ollama evicts this model from {m.vramBytes ? "VRAM" : "memory"} when the countdown reaches zero (expires {new Date(m.expiresAt!).toLocaleTimeString()}). Each use resets it. Set <code>keep_alive</code> to change how long it lingers.</span> : null}
                </span>
            ) : null}
        </>
    );
}

/** The pool (card or host) currently hovered in the chart, and which models sit on it. The model rows below
 *  ARE the legend, so rows not on that pool grey out — reusing what is already on screen instead of injecting
 *  a row that shifts the layout under the cursor. */
// WHICH pool is hovered, not what it held when you got there. The numbers are recomputed from the newest
// sample every render (poolFacts) — the panel polls every 2s, and a tooltip that froze at hover time would
// quietly disagree with the chart moving underneath it.
export const poolHover = signal<{ id: string; name: string; ceiling: number; bandsOf: (s: ResourceSample) => Band[] } | null>(null);
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
export const DRAG_IDLE_MS = 900;
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
export const layoutKey = (tracks: number, rows: number, width = 0): string =>
    `${tracks}:${rows}:${Math.round(width / WIDTH_BUCKET)}`;

/** Animate the panel to a height with a cubic ease. Used when the size changes on its OWN — the panel
 *  correcting an overlap, or a layout needing more room — where a snap reads as a glitch. A live DRAG never
 *  uses this: dragging must track the pointer exactly, and easing it would feel like lag. */
// Bumped by cancelEase(); an in-flight animation checks it every frame and gives up if it is no longer the
// current one. The user's hand ALWAYS wins — a panel that keeps animating while you drag it is fighting you.
let easeToken = 0;
export function cancelEase(): void { easeToken++; }

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
/** True while the pointer is over a badge inside the row that has its OWN tooltip (the context window, the
 *  keep-alive TTL). Two tooltips for one pointer is never right — the specific one wins, and the row's
 *  follower steps aside rather than overlapping it. */
export const rowTipSuppressed = signal(false);

/** The model a chart band is being hovered on, so the band and its legend row highlight together. Module-level
 *  because the chart and the rows are different components either side of the panel. */
export const hoverModel = signal<string | null>(null);

// The chosen VIEW. A preset is a named starting point for a layout, and editing one is the same operation on
// the same state (`TrackDef[]`) — so there is no "am I in preset mode or edit mode" to get wrong. `layout`
// null means "use the default preset for this box", which is also the fallback when a saved layout doesn't
// fit the machine we're now pointed at.
export const LAYOUT_KEY = "ml_res_layout";
export const presetId = signal<string>("");
export const layout = signal<TrackDef[] | null>(null);
/** The last CUSTOM layout, kept beside the active one. Picking a preset used to overwrite the stored tracks,
 *  so a layout you had built by hand was destroyed the moment you looked at a preset — and the "Custom" entry
 *  only existed while it was already selected, so there was no way back to it either. */
export const customTracks = signal<TrackDef[] | null>(null);
export const editorOpen = signal(false);

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

/** Which series each track shows. Bundling and splitting are the SAME operation on a list — everything in one
 *  track is combined, one series per track is small multiples — so the editor is just this list, and a preset
 *  is a starting point for it. A stack the rule would refuse is disabled rather than hidden, with the reason,
 *  so the constraint teaches instead of just removing options. */
function TrackEditor({ sample }: { sample: ResourceSample }) {
    const tracks = layout.value ?? [];
    const cat = seriesCatalog(sample);
    const setTrack = (i: number, next: TrackDef) => editLayout(tracks.map((t, k) => (k === i ? next : t)));
    return (
        <div class="rc-editor">
            {tracks.map((t, i) => (
                <div class="rc-etrack" key={t.id}>
                    <div class="rc-erow">
                        <select class="rc-emode" aria-label="Track mode" value={t.mode}
                            onChange={(e) => setTrack(i, { ...t, mode: (e.target as HTMLSelectElement).value as TrackDef["mode"] })}>
                            <option value="stack">stack</option>
                            <option value="overlay">overlay</option>
                        </select>
                        <span class="sp" />
                        <button class="rc-ex" aria-label="Remove track"
                            onClick={() => editLayout(tracks.filter((_, k) => k !== i))}>✕</button>
                    </div>
                    <div class="rc-eseries">
                        {cat.filter(sd => !sd.model).map(sd => {
                            const on = t.series.includes(sd.id);
                            const next = on ? t.series.filter(x => x !== sd.id) : [...t.series, sd.id];
                            const defs = next.map(id => cat.find(c => c.id === id)!).filter(Boolean);
                            const refusal = !on && t.mode === "stack" ? stackRefusal(defs, sample.capacity) : null;
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
                </div>
            ))}
            <button class="rc-eadd" onClick={() => editLayout([...tracks, { id: `t${Date.now()}`, series: [], mode: "stack", heightPx: 96 }])}>+ Add track</button>
        </div>
    );
}

/** What a hovered model row is, following the cursor. The single VRAM total hides how a model is PLACED — the
 *  same 18 GiB reads identically whether it sits on one card, is split across two, or is partly offloaded to
 *  system RAM, and that last one is why a "GPU" model can still be slow. */
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
            <div class="vram-rowtip-name"><i class="rc-tip-dot" style={{ background: colorFor(name) }} />{name}</div>
            {where ? <div class={isSplit(m) ? "vram-rowtip-split" : ""}>{isSplit(m) ? "split: " : "on "}{where}</div> : null}
            <div class="vram-rowtip-dim">{formatBytes((m.vramBytes || 0) + (m.ramBytes || 0))} resident</div>
            {/* Residency answers "what is loaded"; this answers "and was it worth the VRAM". */}
            <CostFacts model={name} />
        </div>
    );
}

export function VramPanel() {
    const loaded = loadedModels.value;
    const hidden = hiddenModels.value;
    const err = psError.value;
    // Per-model snapshots (not pre-summed totals) so hiding/showing a model
    // redraws the WHOLE line against the current visibility set, not just new
    // points. (This is also the per-model VRAM log panel-v2 will build on.)
    const [history, setHistory] = useState<Record<string, number>[]>([]);
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
    // Esc leaves the zoom. Bound while the panel is open, on the document, because the pointer may be
    // anywhere by the time you want out.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && zoomRange.value) zoomRange.value = null; };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
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
        setHistory(h => [...h, snap].slice(-VRAM_HISTORY));
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

    // Total is the CURRENT visible resident set — read it straight from `loaded`,
    // not the sparkline history (which lags a render and resets to 0 on reopen).
    const total = loaded ? loaded.reduce((s, m) => s + (hidden.has(m.model) ? 0 : (m.vramBytes ?? 0)), 0) : 0;
    // Stable order so rows don't reshuffle as models load/evict.
    const rows = loaded ? [...loaded].sort((a, b) => a.model.localeCompare(b.model)) : [];
    // The rows ARE the chart's legend, so they have to cover the WINDOW, not just this instant: a model that
    // evicted five minutes ago is still drawn in its own colour across the history, and with no row for it
    // that colour has nothing to explain it. Ghost rows carry the name and the colour, nothing else — there
    // is no size, no TTL and nothing to evict.
    const ghosts = (() => {
        const live = new Set((loaded || []).map((m) => m.model));
        const secs = resWindowS.value;
        const cutoff = secs ? Date.now() - secs * 1000 : 0;
        const seen = new Set<string>();
        for (const s of resourceHistory.value) {
            if (s.t < cutoff) continue;
            for (const m of s.models) if (!live.has(m.model) && (m.vramBytes > 0 || m.ramBytes > 0)) seen.add(m.model);
        }
        return [...seen].sort();
    })();
    // Recompute every point's visible-total each render, so toggling redraws the
    // full line retroactively (not just going forward).
    const series = history.map(sumVisible);
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
                <span class="vram-total">{formatBytes(total)} in use</span>
                <span class="sp" />
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
                {/* What the drag selected, and the way out of it. Esc does the same — a zoom you can't leave is
                    a trap, and the panel otherwise keeps showing a stretch that scrolled into the past. */}
                {zoomRange.value ? (
                    <button class="tt vram-zoom" onClick={() => (zoomRange.value = null)}>
                        {zoomSpan(zoomRange.value)} ✕
                        <span class="tt-pop wrap" role="tooltip">Showing the range you selected instead of the rolling window. Click, or press Esc, to go back to live.</span>
                    </button>
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
                    <svg class="vram-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
                        {pts ? <polyline points={pts} fill="none" stroke="var(--accent)" stroke-width="1.5" /> : null}
                    </svg>
                    {/* An unexplained plain line just looks like the panel regressed to an older design. Say
                        what is missing and why, so a shape with no ceiling is legible as a degraded view. */}
                    <span class="tt vram-nocap">no ceiling — capacity unknown
                        <span class="tt-pop wrap" role="tooltip">This server doesn't answer /api/info, so how much memory the machine HAS is unknown. The line is auto-scaled to whatever has been resident, not drawn against a real capacity — no bands, no free space, no per-device split.</span>
                    </span>
                </>}
            {rows.length
                ? rows.map(m => {
                    const off = hidden.has(m.model);
                    return (
                        <div class={`vram-row${off ? " off" : ""}${hoverModel.value === m.model ? " hot" : ""}${poolHover.value && latestSample && !poolFacts(poolHover.value.bandsOf(latestSample)).consumers.some((c) => c.label === m.model) ? " away" : ""}`} key={m.model}
                            onPointerEnter={() => (hoverModel.value = m.model)}
                            onPointerMove={(e: PointerEvent) => (rowTipAt.value = { x: e.clientX, y: e.clientY })}
                            onPointerLeave={() => { hoverModel.value = null; rowTipAt.value = null; rowTipSuppressed.value = false; }}>
                            <button class="vram-dot" style={{ background: off ? "var(--fg-faint)" : colorFor(m.model) }}
                                title={off ? "Show in totals" : "Hide from totals"} onClick={() => toggleHidden(m.model)} />
                            <span class="vram-name">{m.model}</span>
                            <ModelFacts m={m} />
                            <span class="sp" />
                            <span class="vram-gb">{m.vramBytes ? formatBytes(m.vramBytes) : m.sizeBytes ? `${formatBytes(m.sizeBytes)} (CPU)` : "?"}</span>
                            <button class="tt vram-x" aria-label="Evict from VRAM" onClick={() => evict(m.model)}>✕<span class="tt-pop" role="tooltip">Evict from VRAM</span></button>
                        </div>
                    );
                })
                : ghosts.length ? null : <div class="vram-empty">Nothing loaded.</div>}
            {ghosts.map((name) => (
                <div class={`vram-row ghost${hoverModel.value === name ? " hot" : ""}`} key={`ghost:${name}`}
                    onPointerEnter={() => (hoverModel.value = name)}
                    onPointerLeave={() => (hoverModel.value = null)}>
                    <i class="vram-dot ghost-dot" style={{ background: colorFor(name) }} />
                    <span class="vram-name">{name}</span>
                    <span class="tt vram-embed">evicted
                        <span class="tt-pop left above" role="tooltip">No longer resident. It is still drawn in the history above, for as long as that history covers the time it was loaded — this row is what says whose colour that is.</span>
                    </span>
                    <span class="sp" />
                </div>
            ))}
        <div class="vram-grip" role="separator" aria-label="Drag to resize the resource panel"
                title="Drag to resize" onPointerDown={onGrab} />
        </div>
    );
}

// Shape a raw PYTHON_EXEC response into a `python-out` descriptor for RenderPanel.
export function pyBenchDescriptor(r: { ok: boolean; value?: unknown; stdout: string; error?: string; table?: { columns: string[]; rows: (string | number | null)[][] } }): RenderDescriptor {
    const stdout = r.stdout || undefined;
    if (!r.ok) return { type: "python-out", stdout, error: r.error || "error" };
    if (r.table) return { type: "python-out", stdout, df: r.table };   // a returned DataFrame → real table
    const v = r.value;
    if (typeof v === "string" && /^data:image\//.test(v)) return { type: "python-out", stdout, image: v };
    const value = v == null ? undefined : (typeof v === "string" ? v : JSON.stringify(v, null, 2));
    return { type: "python-out", stdout, value };
}
// A standalone Python workbench: run scripts against the SAME sandbox the python_exec tool uses
// (offscreen → worker → Pyodide) with a readonly/full mode selector, for debugging. Code-only — no
// page image/tables (the sidebar iframe can't screenshot the page). The sidebar already talks to the
// background directly (LIST_MODELS/OLLAMA_PS), so this is just one more message. Script + mode persist
// in localStorage so they survive navigation. A full-mode run here is USER-initiated in the trusted
// UI, so it just runs — no approval prompt (you are the approver).
// Guarded localStorage — the bench persists its script/mode there, but an opaque origin (jsdom, or a
// locked-down context) throws SecurityError on access, so degrade to no-persist instead of crashing.
export const lsGet = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
export const lsSet = (k: string, v: string): void => { try { localStorage.setItem(k, v); } catch { /* opaque origin — skip */ } };
export function PythonBench() {
    const [code, setCode] = useState(() => lsGet("ml_bench_code") ?? "import numpy as np\nreturn int(np.arange(10).sum())");
    const [mode, setMode] = useState<"readonly" | "full">(() => (lsGet("ml_bench_mode") === "full" ? "full" : "readonly"));
    const [running, setRunning] = useState(false);
    const [result, setResult] = useState<{ ok: boolean; value?: unknown; stdout: string; error?: string } | null>(null);
    const taRef = useRef<HTMLTextAreaElement>(null);
    const run = () => {
        if (running || !code.trim()) return;
        setRunning(true); setResult(null);
        lsSet("ml_bench_code", code); lsSet("ml_bench_mode", mode);
        try {
            chrome.runtime.sendMessage({ type: "PYTHON_EXEC", payload: { code, hardened: mode === "readonly", image: null, tables: null } },
                (resp: any) => {
                    // The background wraps the offscreen result: { data: PyResult } | { error }.
                    const r = resp?.data ?? (resp?.error ? { ok: false, stdout: "", error: resp.error } : null);
                    setResult(r || { ok: false, stdout: "", error: "No response from the sandbox." });
                    setRunning(false);
                });
        } catch (e) { setResult({ ok: false, stdout: "", error: String(e) }); setRunning(false); }
    };
    // Tab inserts spaces (don't escape the field); Cmd/Ctrl+Enter runs.
    const onKey = (e: KeyboardEvent) => {
        const ta = taRef.current;
        if (e.key === "Tab" && ta) {
            e.preventDefault();
            const s = ta.selectionStart, en = ta.selectionEnd;
            setCode(code.slice(0, s) + "    " + code.slice(en));
            requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = s + 4; });
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(); }
    };
    const outD = result ? pyBenchDescriptor(result) : null;
    const empty = result?.ok && !result.stdout && result.value == null;
    return (
        <div class="bench">
            <textarea ref={taRef} class="bench-code code" spellcheck={false} value={code} onInput={e => setCode((e.target as HTMLTextAreaElement).value)} onKeyDown={onKey} placeholder="return 6 * 7" />
            <div class="bench-bar">
                <span class="tt bench-info" aria-label="about the bench">ⓘ<span class="tt-pop wrap left" role="tooltip">Runs against the SAME sandbox python_exec uses (offscreen → worker → Pyodide). Code-only — no page image/tables. `return` a value (or end with a bare expression, Jupyter-style); print() is captured. 15s cap.</span></span>
                <label class="bench-mode">mode
                    <select value={mode} onChange={e => setMode((e.target as HTMLSelectElement).value === "full" ? "full" : "readonly")}>
                        <option value="readonly">readonly (sandboxed)</option>
                        <option value="full">full (network)</option>
                    </select>
                </label>
                <span class="sp" />
                <span class="bench-kbd dim">⌘/Ctrl+↵</span>
                <button class="bench-run" disabled={running || !code.trim()} onClick={run}>{running ? "running…" : "Run"}</button>
            </div>
            {outD
                ? <div class="bench-out"><div class="io-label">Out:</div>{empty ? <span class="dim">(ran — no output, no return)</span> : <RenderPanel d={outD} />}</div>
                : running ? <div class="bench-out dim">running…</div> : null}
        </div>
    );
}

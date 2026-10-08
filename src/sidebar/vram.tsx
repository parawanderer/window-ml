// vram.tsx — the resource panel COMPONENT (`VramPanel`): the head, the chart, the model list, the event lane and
// the track editor laid out together, plus the chart's key handling and the timeline the lane draws.
//
// The rest of the panel lives beside it: its data arrives through resource-feed.ts, its state is panel-state.ts,
// the chart is resource-chart.tsx, the rows are model-rows.tsx, a model's load state is model-status.tsx, and the
// panel's height is panel-size.ts. Extracted from app.tsx, and split on 2026-10-04.

import { PanelHead } from "./panel-head";
import { useState, useEffect, useRef } from "preact/hooks";
import { signal, effect } from "@preact/signals";
import {
    loadedModels, psError, rev, sessionMap,
    crosshair, VRAMH_KEY, vramH, resWindowS, resWindowPref, RESWIN_KEY, zoomRange, laneScoped, LANE_HIDDEN_KEY, showModels, lsGet, asides,
    scopedHash,
} from "./store";
import { truncate } from "./format";
// The ONE predicate for "this runs somewhere else": affirmatively not a model of this server. Shared with the
// composer rather than re-derived here, so the panel and the picker cannot disagree about what is local.
import { isCloudModel } from "./model";
import { IconWarn, IconVram, IconEye, IconEyeOff, IconBench, IconGear, IconEvictAll } from "./icons";
import { Disclosure } from "./ui-kit";
import { fmtAge, hhmmss } from "./timestamps";
// lsGet/lsSet live in store.ts, not here: a rendered code block hands the bench a script, and render-panel
// cannot import this module (it would be a cycle — this one imports RenderPanel).
export { lsGet, lsSet } from "./store";
import { eventsFrom, laneEvents, type UsageSource } from "./model-stats";
import { formatBytes, boxSignature } from "../resource/resource-model";
import { residencyEvents, type ResourceEvent } from "../resource/resource-timeline";
import { isGpuFault, gpuFaultNote } from "../resource/resource-capacity";
import { presetsFor } from "../resource/resource-presets";
import { chartWindow, windowSamples } from "../resource/resource-axis";
import { sessionWindow } from "../resource/resource-lane";
import { ResourceTracks, muteTip } from "./resource-chart";
import { stepPool, readingIsOverlay } from "./chart-interaction";
import { ScopeSwitch } from "./resource-lane-ui";

import { RenderPanel } from "./render-panel";
import { hoverModel, kbFocus, stepFocus, stepDepth, noteFocusOrder } from "./vram-focus";
import { capacity, resourceHistory, layout, streamLive, frameFocused, VRAM_HISTORY, sessionModels, choosePreset, customTracks, presetId, restoreLayout, hiddenModels } from "./panel-state";
import { loadSeenCards, unavailableGpus, seenCards, machineEvents, servingSince, pollPs, fetchCapacity, loadingModels, psLoading, capacityAsked } from "./resource-feed";
import { probeCaps } from "./model-status";
import { layoutKey, dragging, dragStale, measureFloor, easeVramH, cancelEase, noteDrag } from "./panel-size";
import { TrackEditor } from "./track-editor";
import { RowTip, sparkAt, SparkTip, ModelRow, GhostRow } from "./model-rows";

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

/** Whether the model list is showing the models this session did NOT use. Off by default and NOT persisted:
 *  it answers a question you had once ("what else is on the box?"), not a preference. */
export const othersOpen = signal(false);

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
            {/* The header row goes into the dock's tab bar when the panel is docked (the chat page), so there is
                one bar rather than tabs over a second row of controls. */}
            <PanelHead><div class="vram-head">
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
                {/* An icon with its name in the tip, like the bench's controls: the word cost more of the row than
                    anything else in it. Amber on hover, because it empties the whole box. */}
                {rows.length ? (
                    <button class="tt hbtn vram-free" aria-label="Free VRAM" onClick={() => evict()}>
                        <IconEvictAll /><span class="tt-pop wrap" role="tooltip">Free VRAM: unload every model the runtime holds. The next call loads its model again.</span>
                    </button>
                ) : null}
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
            </div></PanelHead>
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

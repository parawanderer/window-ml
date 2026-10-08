// track-editor.tsx — the resource panel's track editor: which series each chart track shows, the presets that
// start a layout, and the panel's own settings (palette, lane, crosshair, grid), which live beside the tracks.

import { PREDICT_KEY } from "../../resource/load-records";
import type { ResourceSample } from "../../resource/resource-model";
import { seriesCatalog, type TrackDef, stackRefusal, kindRefusal } from "../../resource/resource-presets";
import { layout, editLayout } from "./panel-state";
import { vramPalette, VRAM_PALETTE_KEY, VRAM_PALETTES } from "../palette";
import { LANE_KINDS, toggleLaneKind } from "./resource-lane-ui";
import { laneEnabled, showModels, SECTIONS_KEY, showLane, laneHidden, snapDot, SNAPDOT_KEY, timeGrid, TIMEGRID_KEY, predictView, resWindowPref, resWindowS, zoomRange, RESWIN_PREF_KEY, RESWIN_KEY, RESWIN_DEFAULT } from "../store";
import { TipText } from "../ui-kit";

/** Which series each track shows. Bundling and splitting are the SAME operation on a list — everything in one
 *  track is combined, one series per track is small multiples — so the editor is just this list, and a preset
 *  is a starting point for it. A stack the rule would refuse is disabled rather than hidden, with the reason,
 *  so the constraint teaches instead of just removing options. */
export function TrackEditor({ sample }: { sample: ResourceSample }) {
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
                    {/* NOT "Model colours" any more: the same palette is what a LOG's groups are coloured from
                        (the execution log, run-log-view.tsx), and a setting named after one of the two things it
                        governs is how someone concludes it does not apply to the other. */}
                    <select value={vramPalette.value} aria-label="Colour palette"
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
                        md="Which palette a colour is picked from wherever something is identified by NAME — a model in these graphs, a group in a log. That colour is its identity across every surface that draws it, so which hues read as distinct is worth choosing. Assigned by a hash of the name, so a thing keeps its colour within a palette." /></span>
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

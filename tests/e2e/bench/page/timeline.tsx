// timeline.tsx — the sweep TIMELINE: every run of the sweep on one clock, each row that run's own event lane. Where the
// time went, and which runs overlapped (on one GPU overlap is contention: a slow cell beside three others is not a slow
// model). The events are the resource panel's derivation (`eventsFrom`), sent by the harness; the layout and the bars
// are the panel's too (lane-view.tsx).

import { useState, useMemo } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { Tip } from "../../../../src/sidebar/help-tip";
import { colorFor } from "../../../../src/sidebar/palette";
import { FilterChips } from "../../../../src/sidebar/filter-chips";
import type { BenchState, PackedSamples } from "./state";
import { ResourceTracks } from "../../../../src/sidebar/resource/resource-chart";
import { WindowChip } from "../../../../src/sidebar/resource/resource-scrub";
import { startBrush, BrushOverlay, LANE_KINDS } from "../../../../src/sidebar/resource/resource-lane-ui";
import type { ResourceSample } from "../../../../src/resource/resource-model";
import type { ResourceEvent } from "../../../../src/resource/resource-timeline";
import { LaneRows, LaneAxis, laneWindow } from "./lane-view";
import { runName } from "./runs";
import { Card } from "./card";

/** Hidden `dim=value` pairs, remembered per sweep in this browser; guarded, since a saved page opened from file:// can
 *  throw on storage. */
const hiddenKey = (name: string) => `benchTimelineHidden:${name}`;
const readHidden = (name: string): string[] => { try { return JSON.parse(localStorage.getItem(hiddenKey(name)) || "[]"); } catch { return []; } };

/**
 * Show or hide runs by the value of a dimension: a chip per value (each model, each prompt variant), with how many of
 * the drawn runs have it, the panel lane's filter chips (`.rc-lane-chip`). A run is hidden when any of its values is,
 * and the axis closes up around what is left.
 */
function TimelineFilter({ values, kinds, hidden, toggle }: { values: Map<string, Map<string, number>>; kinds: Map<string, number>; hidden: Set<string>; toggle: (k: string) => void }) {
    return (
        <div class="tlfilter">
            {/* Event kinds, as the panel's lane chips (`LANE_KINDS`): one set, obeyed by the box row, every run's lane and
                the chart's marks alike, so no surface draws a kind another hides. */}
            {kinds.size ? (
                <div class="tlrow">
                    <Tip tip="The kinds of event drawn, with how many of each the shown rows hold. Click one to hide or show it in the box row, every run's lane and the chart."><span class="dim">events</span></Tip>
                    <FilterChips hidden={hidden} toggle={toggle} items={LANE_KINDS.filter((k) => kinds.has(k.kind)).map((k) => ({
                        key: `kind=${k.kind}`, label: k.label, count: kinds.get(k.kind)!,
                        tip: `${hidden.has(`kind=${k.kind}`) ? "Show" : "Hide"} ${k.label}.`,
                    }))} />
                </div>
            ) : null}
            {[...values].map(([dim, vals]) => (
                <div class="tlrow" key={dim}>
                    <Tip tip="A dimension of the spec. Click a value to hide or show the runs that used it."><span class="dim">{dim}</span></Tip>
                    <FilterChips hidden={hidden} toggle={toggle} items={[...vals].map(([v, n]) => {
                        const k = `${dim}=${v}`;
                        return {
                            key: k, count: n,
                            label: dim === "model" ? <><i class="swatch" style={{ background: colorFor(v) }} />{v}</> : v,
                            tip: `${hidden.has(k) ? "Show" : "Hide"} the ${n} run${n === 1 ? "" : "s"} with ${dim} = ${v}.`,
                        };
                    })} />
                </div>
            ))}
        </div>
    );
}

export function SweepTimeline({ s }: { s: BenchState }) {
    const [hiddenList, setHidden] = useState<string[]>(() => readHidden(s.name));
    // The box's memory, when the harness read it (unpacked once per new state, before any early return: a hook).
    const mem = useMemo(() => unpackSamples(s.resources), [s.resources]);
    const t = s.timeline;
    if (!t?.runs.length) return null;
    const hidden = new Set(hiddenList);
    const toggle = (k: string) => {
        const next = hidden.has(k) ? hiddenList.filter((x) => x !== k) : [...hiddenList, k];
        setHidden(next);
        try { localStorage.setItem(hiddenKey(s.name), JSON.stringify(next)); } catch { /* storage off */ }
    };
    // Every value a drawn run has, per dimension; only dimensions with more than one value can be told apart.
    const values = new Map<string, Map<string, number>>();
    for (const { index } of t.runs) for (const d of s.dims) {
        const v = String(s.runs[index].combo[d]);
        if (!values.has(d)) values.set(d, new Map());
        values.get(d)!.set(v, (values.get(d)!.get(v) ?? 0) + 1);
    }
    for (const [d, vals] of values) if (vals.size < 2) values.delete(d);
    const shown = t.runs.filter(({ index }) => !s.dims.some((d) => hidden.has(`${d}=${String(s.runs[index].combo[d])}`)));
    const axis = laneWindow(shown.flatMap((r) => r.events), t.now);
    // With memory readings, the panel's own chart, these lanes drawn under it on ITS axis, so a zoom, a scrub or a drag to
    // select on either moves both. A hidden model is hidden in the chart's bands too.
    const hiddenModels = new Set([...hidden].filter((k) => k.startsWith("model=")).map((k) => k.slice(6)));
    // The box's events (its stream), with a hidden model's left out as the chart leaves out its bands.
    const boxAll: ResourceEvent[] = (s.resources?.events ?? []).filter((e) => !(e.model && hiddenModels.has(e.model)));
    // How many of each kind the shown rows hold (counted before the kind filter, so a hidden kind keeps its chip).
    const kinds = new Map<string, number>();
    for (const e of [...boxAll, ...shown.flatMap((r) => r.events)]) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
    const kindShown = (e: ResourceEvent) => !hidden.has(`kind=${e.kind}`);
    const boxEvents = boxAll.filter(kindShown);
    const runLanes = shown.map((r) => ({ ...r, events: r.events.filter(kindShown) }));
    const shownEvents: ResourceEvent[] = [...boxEvents, ...runLanes.flatMap((r) => r.events)];
    /** Each shown run's lane, labelled, on `axis`; with the time axis under them when no chart draws one. Called, never
     *  mounted as a component: a component defined here would be a new type each render and remount its rows. */
    const lanes = ({ axis, withAxis, rowAttrs, rowPrefix }: { axis: { from: number; to: number }; withAxis?: boolean; rowAttrs?: Parameters<typeof LaneRows>[0]["rowAttrs"]; rowPrefix?: () => ComponentChildren }) => (
        <div class="tl">
            {/* The box's own events above the runs: what the server did, whoever asked (another sweep, a person's panel). */}
            {boxEvents.length ? [
                <div key="wbox" class="who box"><Tip tip="What the server itself reported over the sweep, from its event stream: model loads (weights, then context), evictions and unloads with its reason, serving spans and generations from any client, this sweep's or not. Hover a bar for what it was.">the box</Tip></div>,
                <section key="lbox" class="wml-lane"><LaneRows events={boxEvents} axis={axis} now={t.now} maxRows={4} maxTotal={6} rowAttrs={rowAttrs} rowPrefix={rowPrefix} /></section>,
            ] : null}
            {runLanes.map(({ index, events }) => {
                const r = s.runs[index];
                const name = runName(r, s.dims);
                return [
                    <div key={`w${index}`} class="who"><Tip tip={name}>{name}</Tip></div>,
                    <section key={`l${index}`} class="wml-lane"><LaneRows events={events} axis={axis} now={t.now} maxRows={4} maxTotal={6} rowAttrs={rowAttrs} rowPrefix={rowPrefix} /></section>,
                ];
            })}
            {withAxis ? <><div /><section class="wml-lane"><LaneAxis axis={axis} /></section></> : null}
        </div>
    );
    const cached = s.runs.filter((r) => r.cached).length;
    return (
        <Card id="timeline" label="the timeline">
            <header>
                <h2><Tip tip="Each run's model calls, tool steps and model loads on one clock, under the box's memory when the harness could read it (the resource panel's chart: drag on it or on a lane to select a stretch, scroll or drag the strip to move along). Rows that overlap ran at the same time; on one GPU that is contention. Hover a bar for what it was. Also as text in timeline.md and memory.md.">Timeline</Tip></h2>
                {cached ? <span class="sub">{cached} cached run(s) are not drawn: they ran in an earlier sweep.</span> : null}
                {mem && axis ? <><span class="sp" /><WindowChip always allMs={(s.finished ? Math.max(s.finished, mem.samples.at(-1)!.t) : Date.now()) - mem.samples[0].t} /></> : null}
            </header>
            {values.size || kinds.size > 1 ? <TimelineFilter values={values} kinds={kinds.size > 1 ? kinds : new Map()} hidden={hidden} toggle={toggle} /> : null}
            {!axis ? <div class="empty">Every run is hidden: click a struck-out value to show it again.</div>
                : mem ? <div class="tlchart">
                    <ResourceTracks samples={mem.samples} capacity={mem.samples.at(-1)!.capacity} hidden={hiddenModels} events={shownEvents}
                        endAt={s.finished ? Math.max(s.finished, mem.samples.at(-1)!.t) : undefined}
                        lane={({ axis: chartAxis, runs }) => lanes({ axis: chartAxis, rowAttrs: { onPointerDown: startBrush(runs) }, rowPrefix: () => <BrushOverlay runs={runs} /> })} />
                </div>
                : lanes({ axis, withAxis: true })}
        </Card>
    );
}

/** The harness's packed samples (resource-poll.mjs `packSamples`) back into the panel's `ResourceSample`s; null without
 *  any, or with too few to draw a line. */
export function unpackSamples(p: PackedSamples | null | undefined): { samples: ResourceSample[] } | null {
    if (!p || p.samples.length < 2) return null;
    return { samples: p.samples.map(({ c, ...rest }) => ({ ...rest, capacity: p.capacities[c] }) as ResourceSample) };
}

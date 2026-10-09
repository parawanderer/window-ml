// timeline.tsx — the sweep TIMELINE: every run of the sweep on one clock, each row that run's own event lane. Where the
// time went, and which runs overlapped (on one GPU overlap is contention: a slow cell beside three others is not a slow
// model). The events are the resource panel's derivation (`eventsFrom`), sent by the harness; the layout and the bars
// are the panel's too (lane-view.tsx).

import type { BenchState } from "./state";
import { LaneRows, LaneAxis, laneWindow } from "./lane-view";
import { runName } from "./runs";

export function SweepTimeline({ s }: { s: BenchState }) {
    const t = s.timeline;
    if (!t?.runs.length) return null;
    const axis = laneWindow(t.runs.flatMap((r) => r.events), t.now);
    if (!axis) return null;
    const cached = s.runs.filter((r) => r.cached).length;
    return (
        <section class="card">
            <header>
                <h2>Timeline</h2>
                <span class="sub">Each run's model calls, tool steps and loads on one clock; rows that overlap ran at the same time. Hover a bar for what it was.
                    {cached ? ` ${cached} cached run(s) are not drawn: they ran in an earlier sweep.` : ""}</span>
            </header>
            <div class="tl">
                {t.runs.map(({ index, events }) => {
                    const r = s.runs[index];
                    const name = runName(r, s.dims);
                    return [
                        <div key={`w${index}`} class="who" title={name}>{name}</div>,
                        <section key={`l${index}`} class="wml-lane"><LaneRows events={events} axis={axis} now={t.now} maxRows={4} maxTotal={6} /></section>,
                    ];
                })}
                <div />
                <section class="wml-lane"><LaneAxis axis={axis} /></section>
            </div>
        </section>
    );
}

// timeline.tsx — the sweep TIMELINE: every run of the sweep on one clock, each row that run's own event lane. Where the
// time went, and which runs overlapped (on one GPU overlap is contention: a slow cell beside three others is not a slow
// model). The events are the resource panel's derivation (`eventsFrom`), sent by the harness; the layout and the bars
// are the panel's too (lane-view.tsx).

import { Tip } from "../../../../src/sidebar/help-tip";
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
                <h2><Tip tip="Each run's model calls, tool steps and model loads on one clock. Rows that overlap ran at the same time; on one GPU that is contention. Hover a bar for what it was. Also as text in timeline.md.">Timeline</Tip></h2>
                {cached ? <span class="sub">{cached} cached run(s) are not drawn: they ran in an earlier sweep.</span> : null}
            </header>
            <div class="tl">
                {t.runs.map(({ index, events }) => {
                    const r = s.runs[index];
                    const name = runName(r, s.dims);
                    return [
                        <div key={`w${index}`} class="who"><Tip tip={name}>{name}</Tip></div>,
                        <section key={`l${index}`} class="wml-lane"><LaneRows events={events} axis={axis} now={t.now} maxRows={4} maxTotal={6} /></section>,
                    ];
                })}
                <div />
                <section class="wml-lane"><LaneAxis axis={axis} /></section>
            </div>
        </section>
    );
}

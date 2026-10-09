// timeline-text.mjs — the sweep timeline as text, for a model reading the bench from the command line: the same data the
// page's Timeline card draws (each run's events, the resource panel's `eventsFrom`), written as timeline.md. Pure.

/** What a seeded run's scripted first turn is called wherever the timeline names its model: the page, timeline.md and
 *  page.json. Not a model: the history the spec replays through the fake LLM before the measured model takes over. */
export const SEED_LABEL = "seed (scripted, from the spec)";

/**
 * A seeded run's events, each named for what really served it. The run's steps carry no model of their own, so the lane
 * gives every one the model the run STARTED on, the fake's: by that, the measured model's steps read as the fake's too.
 * The seed is the first turn, so an event that began before the seed's answer (`seedEnd`) is the seed (`SEED_LABEL`),
 * and one after it is the measured model's (`measured`), in the model and the label alike.
 */
export function labelSeed(events, fakeModel, { seedEnd = Infinity, measured = null } = {}) {
    return events.map((e) => {
        if (e.model !== fakeModel) return e;
        const name = e.t < seedEnd ? SEED_LABEL : measured;
        return name ? { ...e, model: name, label: String(e.label).split(fakeModel).join(name) } : e;
    });
}

/** When a seeded run's seed turn answered: its first `agent-result`, from the run's raw events; Infinity before it has. */
export const seedEndOf = (rawEvents) => rawEvents.find((e) => e.kind === "agent-result")?.ts ?? Infinity;

/** A duration: milliseconds under a second (a fake-model run takes a few), else seconds. */
const span = (ms) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);

/** One run's extent and what filled it, from its events. */
function runSpan(events) {
    const spans = events.filter((e) => e.until != null);
    if (!spans.length) return null;
    const from = Math.min(...spans.map((e) => e.t)), to = Math.max(...spans.map((e) => e.until));
    const of = (k) => spans.filter((e) => e.kind === k);
    const sum = (xs) => xs.reduce((a, e) => a + (e.until - e.t), 0);
    return { from, to, gens: of("gen"), tools: of("tool"), loads: of("load"), subs: of("embed"), busy: sum(of("gen")) + sum(of("tool")) };
}

/**
 * The timeline as markdown: a table of runs on one clock (start and end in seconds from the earliest event), which runs
 * overlapped and for how long (on one GPU, overlap is contention), then each run's spans in order. Open work (a run
 * still going) is drawn to `now`, as the page draws it.
 *
 * @param {{ runs: { index: number, events: object[] }[], now: number } | null} timeline the page's `timeline`
 * @param {(index: number) => string} nameOf a run's name, as the page labels its row
 * @param {{ cached?: number }} [opts] how many cached runs were left out, to say so
 */
export function timelineText(timeline, nameOf, { cached = 0 } = {}) {
    if (!timeline?.runs?.length) return "# Timeline\n\nNo run has events to draw yet.\n";
    const runs = timeline.runs.map(({ index, events }) => {
        const evs = events.map((e) => (e.until == null && e.open ? { ...e, until: timeline.now } : e));
        return { name: nameOf(index), events: evs, span: runSpan(evs) };
    }).filter((r) => r.span);
    const zero = Math.min(...runs.map((r) => r.span.from));
    // A point on the clock: seconds from the start, to the hundredth.
    const at = (t) => `${((t - zero) / 1000).toFixed(2)}s`;
    const L = ["# Timeline", "", `Every run on one clock: seconds from ${new Date(zero).toISOString()}.${cached ? ` ${cached} cached run(s) are left out: they ran in an earlier sweep.` : ""}`, ""];
    L.push("| run | start | end | duration | model calls | tool steps | loads | sub-calls | busy |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const r of runs) {
        const s = r.span;
        L.push(`| \`${r.name}\` | ${at(s.from)} | ${at(s.to)} | ${span(s.to - s.from)} | ${s.gens.length} | ${s.tools.length} | ${s.loads.length} | ${s.subs.length} | ${span(s.busy)} |`);
    }
    const overlaps = [];
    for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) {
        const a = runs[i].span, b = runs[j].span;
        const from = Math.max(a.from, b.from), to = Math.min(a.to, b.to);
        if (to > from) overlaps.push(`- \`${runs[i].name}\` and \`${runs[j].name}\`: ${span(to - from)} together (${at(from)} to ${at(to)})`);
    }
    L.push("", "## Overlaps", "", ...(overlaps.length ? overlaps : ["None: every run had the machine to itself."]));
    L.push("", "## Spans per run");
    for (const r of runs) {
        L.push("", `### ${r.name}`, "");
        for (const e of [...r.events].filter((x) => x.until != null).sort((x, y) => x.t - y.t || y.until - x.until)) {
            const phases = e.phases?.length ? ` (${e.phases.map((ph, i) => `${ph.kind} ${span(ph.until - (i ? e.phases[i - 1].until : e.t))}`).join(", ")})` : "";
            const label = e.label && e.label !== e.kind ? ` · ${e.label}` : "";
            L.push(`- ${at(e.t)} to ${at(e.until)} · ${e.kind}${label}${e.model && !String(e.label).includes(e.model) ? ` · ${e.model}` : ""} · ${span(e.until - e.t)}${phases}${e.open ? " · still running" : ""}`);
        }
    }
    return L.join("\n") + "\n";
}

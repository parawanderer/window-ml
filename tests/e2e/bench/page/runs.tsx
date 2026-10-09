// runs.tsx — the sweep's tables and the pieces that describe one run: its outcome badge, its artifacts, what is in
// flight, and the aggregate results.

import { Tip } from "../../../../src/sidebar/help-tip";

/** A spec dimension's column: what a value in it is. */
const dimTip = (d: string) => `A dimension of the spec: the value of ${d} this run used.`;
const TASK_TIP = "The spec's task id: what the run was asked to do.";
import { Hash } from "../../../../src/sidebar/copy-hash";
import type { BenchState, RunState, Agg } from "./state";
import { dur } from "./format";
import { now } from "./clock";
import { Card } from "./card";

/** A run's directory as a link base, or "" before it has one. */
export const runDir = (r: RunState, base: string): string => (r.path ? base + encodeURI(r.path) : "");

/** A run's name in a list: its task, each dimension's value, and its repeat. */
export const runName = (r: RunState, dims: string[]): string =>
    [r.taskId, ...dims.map((d) => r.combo[d]), `r${r.repeat}`].filter((x) => x != null && x !== "").join(" · ");

/** Where a run is: queued, running (step x of the budget, what it is doing, for how long), or how it ended. */
export function Outcome({ r }: { r: RunState }) {
    if (r.state === "running") {
        const l = r.live || {};
        return (
            <span class="badge run"><i class="spin" />{l.step != null ? <>step {l.step}{l.maxSteps ? <span class="dim">/{l.maxSteps}</span> : null}</> : "starting"}
                {l.tool ? <> · {l.tool}</> : null}{r.startedAt ? <span class="dim"> · {dur(now.value - r.startedAt)}</span> : null}</span>
        );
    }
    if (r.state === "pending") return <span class="badge">queued</span>;
    if (!r.ok && r.rateLimited) return <span class="badge bad tt" data-tip="The backend refused it for a rate limit, so it measured nothing about the model. Run fewer at once (--jobs), or --lanes (one at a time per model); the next sweep runs it again.">rate-limited</span>;
    if (!r.ok) return <span class="badge bad">failed</span>;
    if (r.cached) return <span class="badge">cached</span>;
    if (r.succeeded == null) return <span class="badge ok">ok</span>;
    return r.succeeded ? <span class="badge ok">correct</span> : <span class="badge warn">wrong</span>;
}

/**
 * Whether a run's model turns were streamed, beside its outcome: shown only for a run that asked to (a console run's
 * default is not to). Asked and nothing arrived is flagged, since then the option never took effect; so is a turn
 * without usage, which the token figures then leave out.
 */
export function StreamTag({ r }: { r: RunState }) {
    const st = r.stream;
    if (!st?.asked || r.state !== "done") return null;
    if (!st.streamed) return st.turns ? <span class="badge bad tt" data-tip="Asked to stream its model turns, but no live delta arrived: the option did not take effect, so this run was measured unstreamed.">not streamed</span> : null;
    const short = st.turnsWithUsage < st.turns;
    return <span class={`badge tt${short ? " warn" : ""}`} data-tip={`Its model turns were streamed, as the HUD streams them: ${st.deltas} live deltas over ${st.turns} turn${st.turns === 1 ? "" : "s"}. ${st.turnsWithUsage} of ${st.turns} turns reported usage${short ? ": the provider left it off a stream, so this run's token figures miss the rest" : ""}.`}>streamed</span>;
}

/**
 * The outcome, linked into the transcript AT the step that broke where one is identifiable (`focus`, from the run's own
 * event stream), since landing at the top of a fifty-screen run.md is the work the link was supposed to save. A clean
 * wrong run has no failing step, so it links to the top.
 */
function OutcomeLink({ r, dir, dims }: { r: RunState; dir: string; dims: string[] }) {
    if (!dir || r.state !== "done") return <><Outcome r={r} /><StreamTag r={r} /></>;
    const f = r.focus;
    // The heading slugs are lower-cased, so the tool is too (sampleText -> sampletext).
    const anchor = f ? `#step-${f.step}${f.tool ? `-${String(f.tool).toLowerCase()}` : ""}` : "";
    return <><a href={`${dir}/run.md.html${anchor}`} class="view plain tt" data-tip={f ? `Opens the transcript at step ${f.step}: ${f.why}` : "Opens the transcript"} data-title={runName(r, dims)}><Outcome r={r} /></a><StreamTag r={r} /></>;
}

/** What is running, lifted out of the table: with `--jobs N` the live rows can be anywhere in a hundred. */
export function Flight({ s }: { s: BenchState }) {
    const live = s.runs.filter((r) => r.state === "running");
    if (!live.length) return null;
    return (
        <Card id="flight" label="what is running">
            <header><h2><Tip tip="The runs in flight: the step against its budget, the tool it is in, and how long it has been going.">Running now</Tip></h2><span class="sub">{live.length} of {s.jobs} job{s.jobs > 1 ? "s" : ""}</span></header>
            <div class="flight">
                {live.map((r) => (
                    <div key={r.path || runName(r, s.dims)} class="frow">
                        <code class="who">{runName(r, s.dims)}</code>
                        <Outcome r={r} />
                        <span class="last">{r.live?.last ?? ""}</span>
                    </div>
                ))}
            </div>
        </Card>
    );
}

/** The four numbers a long sweep raises: elapsed, per run, per step, and when it will be over (withheld until a few
 *  runs have landed: an ETA from one sample is a guess wearing a number's clothes). */
export function Stats({ s }: { s: BenchState }) {
    const at = now.value;
    const done = s.runs.filter((r) => r.state === "done");
    const timed = done.filter((r) => typeof r.secs === "number" && !r.cached);
    const total = timed.reduce((a, r) => a + (r.secs || 0), 0);
    const meanRun = timed.length ? total / timed.length : null;
    const steps = timed.reduce((a, r) => a + (r.steps || 0), 0);
    const left = s.runs.length - done.length;
    const eta = !s.finished && meanRun != null && timed.length >= 3 && left > 0 ? new Date(at + (left * meanRun * 1000) / Math.max(1, s.jobs)) : null;
    const tile = (label: string, value: string, tip: string) => <div class="tile"><b>{value}</b><span><Tip tip={tip}>{label}</Tip></span></div>;
    return (
        <div class="tiles">
            {tile("elapsed", dur((s.finished || at) - s.started), "Wall-clock time since the sweep started.")}
            {tile("per run", meanRun == null ? "–" : dur(meanRun * 1000), `Mean wall-clock time of one run${timed.length ? `, over ${timed.length} timed run(s)` : ""}. Cached runs are left out: their time belongs to an earlier sweep.`)}
            {tile("per step", steps ? `${(total / steps).toFixed(1)}s` : "–", `Mean time of one agent step (a tool call or an answer)${steps ? `: ${steps} steps across ${timed.length} run(s)` : ""}.`)}
            {s.finished ? tile("finished", dur(s.finished - s.started), "How long the whole sweep took.")
                : tile("eta", eta ? eta.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "–", eta ? `When the sweep should end: about ${dur(eta.getTime() - at)} left, from the mean run time at ${s.jobs} job(s).` : "When the sweep should end; shown once three runs have been timed, since one sample is a guess.")}
        </div>
    );
}

function Fmt({ a, digits }: { a?: Agg; digits: number }) {
    if (!a || a.mean == null) return <span class="dim">—</span>;
    return <>{a.mean.toFixed(digits)}{a.sd != null && a.n >= 2 ? <span class="dim"> ±{a.sd.toFixed(digits)}</span> : null}</>;
}

/** The aggregate table: one row per (combination x task), mean ± sd over its repeats. */
export function Results({ s }: { s: BenchState }) {
    return (
        <Card id="results" label="the results">
            <header><h2><Tip tip="One row per combination and task: the mean over its repeats, ± the sample standard deviation. A dash is not measured. Also in report.md and rows.json.">Results</Tip></h2></header>
            {!s.rows?.length ? <div class="empty">Nothing measured yet.</div> : (
                <div class="tablewrap"><table>
                    <thead><tr>{s.dims.map((d) => <th key={d} class="l"><Tip tip={dimTip(d)}>{d}</Tip></th>)}<th class="l"><Tip tip={TASK_TIP}>task</Tip></th><th><Tip tip="Runs that completed out of the runs this row is the mean of (its repeats).">runs</Tip></th>{s.columns.map((c) => <th key={c.key}><Tip tip={c.about}>{c.label}</Tip></th>)}</tr></thead>
                    <tbody>{s.rows.map((r, i) => (
                        <tr key={i}>{s.dims.map((d) => <td key={d} class="l"><code>{String(r.combo[d])}</code></td>)}<td class="l">{r.taskId}</td>
                            <td>{r.agg.runs - r.agg.errors}/{r.agg.runs}</td>
                            {s.columns.map((c) => <td key={c.key}><Fmt a={r.agg[c.key]} digits={c.digits} /></td>)}</tr>
                    ))}</tbody>
                </table></div>
            )}
        </Card>
    );
}

/** Every run, in matrix order (a reordering queue would move what you are watching), with its artifacts. */
export function Runs({ s, base }: { s: BenchState; base: string }) {
    const nextUp = s.runs.findIndex((r) => r.state === "pending");
    return (
        <Card id="runs" label="the runs">
            <header><h2><Tip tip="Every run, in the order of the matrix. The status opens the transcript, at the step that broke when one did.">Runs</Tip></h2></header>
            {!s.runs.length ? <div class="empty">Nothing has started.</div> : (
                <div class="tablewrap"><table>
                    <thead><tr>{s.dims.map((d) => <th key={d} class="l"><Tip tip={dimTip(d)}>{d}</Tip></th>)}<th class="l"><Tip tip={TASK_TIP}>task</Tip></th>
                        <th class="l"><Tip tip="Which repeat of this combination and task: r0 is the first.">run</Tip></th>
                        <th class="l"><Tip tip="The run's session hash, the id the panel and run.json use. Click to copy it whole.">agent</Tip></th>
                        <th class="l"><Tip tip="queued, running (step and tool), failed (the run errored), cached (measured in an earlier sweep of the same build), ok (no predicate to score it), correct or wrong (the task's predicate).">status</Tip></th>
                        <th><Tip tip="Agent steps the run took: tool calls and answers.">steps</Tip></th>
                        <th><Tip tip="Wall-clock seconds the run took.">secs</Tip></th>
                        <th class="l"><Tip tip="read: the transcript, rendered (run.md.html). md: the same as markdown. json: the machine-readable export, for diffing two runs.">artifacts</Tip></th></tr></thead>
                    <tbody>{s.runs.map((r, i) => {
                        const dir = runDir(r, base);
                        const who = [runName(r, s.dims), r.hash].filter(Boolean).join(" · ");
                        return (
                            <tr key={i} class={r.state === "running" ? "live" : i === nextUp ? "next" : ""}>
                                {s.dims.map((d) => <td key={d} class="l"><code>{String(r.combo[d])}</code></td>)}
                                <td class="l">{r.taskId}</td><td class="l">r{r.repeat}</td>
                                <td class="l">{r.hash ? <Hash hash={r.hash} stop /> : <span class="dim">–</span>}</td>
                                <td class="l"><OutcomeLink r={r} dir={dir} dims={s.dims} /></td>
                                <td>{r.steps ?? <span class="dim">–</span>}</td>
                                <td>{r.secs != null ? r.secs.toFixed(1) : <span class="dim">–</span>}</td>
                                <td class="l links">{dir ? <>
                                    <a class="view" href={`${dir}/run.md.html`} data-title={who}>read</a>
                                    <a href={`${dir}/run.md`}>md</a><a href={`${dir}/run.json`}>json</a>
                                    {s.pdf ? <a href={`${dir}/run.html`} target="_blank" rel="noopener">export</a> : null}
                                </> : null}</td>
                            </tr>
                        );
                    })}</tbody>
                </table></div>
            )}
        </Card>
    );
}

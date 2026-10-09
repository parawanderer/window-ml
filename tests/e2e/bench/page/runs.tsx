// runs.tsx — the sweep's tables and the pieces that describe one run: its outcome badge, its artifacts, what is in
// flight, and the aggregate results.

import type { BenchState, RunState, Agg } from "./state";
import { dur } from "./format";

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
                {l.tool ? <> · {l.tool}</> : null}{r.startedAt ? <span class="dim"> · {dur(Date.now() - r.startedAt)}</span> : null}</span>
        );
    }
    if (r.state === "pending") return <span class="badge">queued</span>;
    if (!r.ok) return <span class="badge bad">failed</span>;
    if (r.cached) return <span class="badge">cached</span>;
    if (r.succeeded == null) return <span class="badge ok">ok</span>;
    return r.succeeded ? <span class="badge ok">correct</span> : <span class="badge warn">wrong</span>;
}

/**
 * The outcome, linked into the transcript AT the step that broke where one is identifiable (`focus`, from the run's own
 * event stream), since landing at the top of a fifty-screen run.md is the work the link was supposed to save. A clean
 * wrong run has no failing step, so it links to the top.
 */
function OutcomeLink({ r, dir, dims }: { r: RunState; dir: string; dims: string[] }) {
    if (!dir || r.state !== "done") return <Outcome r={r} />;
    const f = r.focus;
    // The heading slugs are lower-cased, so the tool is too (sampleText -> sampletext).
    const anchor = f ? `#step-${f.step}${f.tool ? `-${String(f.tool).toLowerCase()}` : ""}` : "";
    return <a class="view plain" href={`${dir}/run.md.html${anchor}`} title={f ? `step ${f.step} — ${f.why}` : "open the transcript"} data-title={runName(r, dims)}><Outcome r={r} /></a>;
}

/** What is running, lifted out of the table: with `--jobs N` the live rows can be anywhere in a hundred. */
export function Flight({ s }: { s: BenchState }) {
    const live = s.runs.filter((r) => r.state === "running");
    if (!live.length) return null;
    return (
        <section class="card">
            <header><h2>Running now</h2><span class="sub">{live.length} of {s.jobs} job{s.jobs > 1 ? "s" : ""}</span></header>
            <div class="flight">
                {live.map((r) => (
                    <div key={r.path || runName(r, s.dims)} class="frow">
                        <code class="who">{runName(r, s.dims)}</code>
                        <Outcome r={r} />
                        <span class="last">{r.live?.last ?? ""}</span>
                    </div>
                ))}
            </div>
        </section>
    );
}

/** The four numbers a long sweep raises: elapsed, per run, per step, and when it will be over (withheld until a few
 *  runs have landed: an ETA from one sample is a guess wearing a number's clothes). */
export function Stats({ s }: { s: BenchState }) {
    const now = Date.now();
    const done = s.runs.filter((r) => r.state === "done");
    const timed = done.filter((r) => typeof r.secs === "number" && !r.cached);
    const total = timed.reduce((a, r) => a + (r.secs || 0), 0);
    const meanRun = timed.length ? total / timed.length : null;
    const steps = timed.reduce((a, r) => a + (r.steps || 0), 0);
    const left = s.runs.length - done.length;
    const eta = !s.finished && meanRun != null && timed.length >= 3 && left > 0 ? new Date(now + (left * meanRun * 1000) / Math.max(1, s.jobs)) : null;
    const tile = (label: string, value: string, title = "") => <div class="tile" title={title}><b>{value}</b><span>{label}</span></div>;
    return (
        <div class="tiles">
            {tile("elapsed", dur((s.finished || now) - s.started))}
            {tile("per run", meanRun == null ? "–" : dur(meanRun * 1000), timed.length ? `mean over ${timed.length} timed runs` : "")}
            {tile("per step", steps ? `${(total / steps).toFixed(1)}s` : "–", steps ? `${steps} steps across ${timed.length} runs` : "")}
            {s.finished ? tile("finished", dur(s.finished - s.started))
                : tile("eta", eta ? eta.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "–", eta ? `about ${dur(eta.getTime() - now)} left, at ${s.jobs} job(s)` : "needs a few runs first")}
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
        <section class="card">
            <header><h2>Results</h2><span class="sub">Mean over each cell's repeats, ± the sample standard deviation; — is not measured.</span></header>
            {!s.rows?.length ? <div class="empty">Nothing measured yet.</div> : (
                <div class="tablewrap"><table>
                    <thead><tr>{s.dims.map((d) => <th key={d} class="l">{d}</th>)}<th class="l">task</th><th>runs</th>{s.columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
                    <tbody>{s.rows.map((r, i) => (
                        <tr key={i}>{s.dims.map((d) => <td key={d} class="l"><code>{String(r.combo[d])}</code></td>)}<td class="l">{r.taskId}</td>
                            <td>{r.agg.runs - r.agg.errors}/{r.agg.runs}</td>
                            {s.columns.map((c) => <td key={c.key}><Fmt a={r.agg[c.key]} digits={c.digits} /></td>)}</tr>
                    ))}</tbody>
                </table></div>
            )}
        </section>
    );
}

/** Every run, in matrix order (a reordering queue would move what you are watching), with its artifacts. */
export function Runs({ s, base }: { s: BenchState; base: string }) {
    const nextUp = s.runs.findIndex((r) => r.state === "pending");
    return (
        <section class="card">
            <header><h2>Runs</h2><span class="sub">The status opens the transcript at the step that broke, when one did.</span></header>
            {!s.runs.length ? <div class="empty">Nothing has started.</div> : (
                <div class="tablewrap"><table>
                    <thead><tr>{s.dims.map((d) => <th key={d} class="l">{d}</th>)}<th class="l">task</th><th class="l">run</th><th class="l">agent</th><th class="l">status</th><th>steps</th><th>secs</th><th class="l">artifacts</th></tr></thead>
                    <tbody>{s.runs.map((r, i) => {
                        const dir = runDir(r, base);
                        const who = [runName(r, s.dims), r.hash].filter(Boolean).join(" · ");
                        return (
                            <tr key={i} class={r.state === "running" ? "live" : i === nextUp ? "next" : ""}>
                                {s.dims.map((d) => <td key={d} class="l"><code>{String(r.combo[d])}</code></td>)}
                                <td class="l">{r.taskId}</td><td class="l">r{r.repeat}</td>
                                <td class="l">{r.hash ? <span class="hash">{r.hash.slice(0, 12)}</span> : <span class="dim">–</span>}</td>
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
        </section>
    );
}

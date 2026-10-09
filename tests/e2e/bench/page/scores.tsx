// scores.tsx — the scoreboard page: every model the bench has run, its score from the runs whose task has a pass/fail
// predicate, the tasks behind it, and how each number is computed. Rendered from the board scores.mjs builds out of the
// SQLite log (baked in as `window.__BENCH_SCORES__`); scores.md is the same board as text. Every number has a tooltip
// saying where it comes from, so a reader never needs the code to know what they are looking at.

import { render, Fragment } from "preact";
import type { ScoreBoard, ScoreModel } from "./state";
import { Tip } from "../../../../src/sidebar/help-tip";
import { ThemeToggle, applyTheme, readTheme } from "./theme";
import { Hash } from "../../../../src/sidebar/copy-hash";
import { installTooltipLayer } from "../../../../src/sidebar/tooltip-layer";
import { signed, Interval } from "../../../../src/sidebar/interval-bar";
import { Disclosure } from "../../../../src/sidebar/disclosure";

declare global { interface Window { __BENCH_SCORES__?: ScoreBoard } }

const pct = (x: number) => `${Math.round(x * 100)}%`;
/** The digest without its algorithm, for the copy chip. */
const bareDigest = (d: string) => d.replace(/^sha256:/, "");
const when = (iso: string) => iso.slice(0, 16).replace("T", " ");

/** The model's name, its digest as a click-to-copy chip, and how it is stored (quantisation, or cloud). */
export function ModelName({ m }: { m: ScoreModel }) {
    const kind = m.quant ? `${m.quant}${m.params ? ` · ${m.params}` : ""}` : m.local === false ? "cloud" : null;
    return (
        <span class="mname">
            <code>{m.model}</code>
            {m.digest ? <Hash hash={bareDigest(m.digest)} /> : null}
            {kind ? <span class="dim kind">{kind}</span> : null}
        </span>
    );
}

/** What one model's score cell says in words: the number, its interval, and the runs behind it. */
export const scoreTip = (m: ScoreModel, minScored: number) => m.score
    ? `θ = ${signed(m.score.theta)}, interval ${signed(m.score.lo)} to ${signed(m.score.hi)}, fitted from ${m.scored} scored run${m.scored === 1 ? "" : "s"} over ${m.tasks} task${m.tasks === 1 ? "" : "s"} (${m.passed} passed). Fitted chance on a task of average difficulty: ${pct(m.score.chance)} (${pct(m.score.chanceLo)} to ${pct(m.score.chanceHi)}).`
    : `Not scored yet: ${m.scored} of the ${minScored} scored runs a score needs.${m.unscored ? ` ${m.unscored} run${m.unscored === 1 ? "" : "s"} had no predicate to score ${m.unscored === 1 ? "it" : "them"}.` : ""}`;

/** Token bloat in words for one model. */
export const bloatTip = (m: ScoreModel) => m.bloat
    ? `${m.bloat.ratio.toFixed(2)} times the tokens of the typical run of the same task, as a geometric mean over ${m.bloat.runs} run${m.bloat.runs === 1 ? "" : "s"} on tasks at least one other model also ran.`
    : "No run on a task another model also ran, with tokens reported: nothing to compare with yet.";

function Models({ b }: { b: ScoreBoard }) {
    const a = b.about;
    return (
        <section class="card">
            <header><h2><Tip tip="Every model with a logged run, best score first; models without a score yet after them.">Models</Tip></h2>
                <span class="sub">Scores are comparable across models that ran different tasks: the fit separates how hard a task is from how able a model is.</span></header>
            <div class="tablewrap">
                <table class="scores">
                    <thead><tr>
                        <th class="l"><Tip tip={a.model}>model</Tip></th>
                        <th class="l"><Tip tip={a.score}>score θ</Tip></th>
                        <th><Tip tip={a.chance}>chance</Tip></th>
                        <th><Tip tip={a.scored}>scored</Tip></th>
                        <th><Tip tip={a.passed}>passed</Tip></th>
                        <th><Tip tip={a.tasks}>tasks</Tip></th>
                        <th><Tip tip={a.bloat}>bloat</Tip></th>
                        <th><Tip tip={a.medianTokens}>tokens</Tip></th>
                        <th><Tip tip={a.runs}>runs</Tip></th>
                        <th class="l"><Tip tip={a.last}>last run</Tip></th>
                    </tr></thead>
                    <tbody>{b.models.map((m) => (
                        <tr key={m.key}>
                            <td class="l"><ModelName m={m} /></td>
                            <td class="l">{m.score
                                ? <Interval lo={m.score.lo} hi={m.score.hi} v={m.score.theta} tip={scoreTip(m, b.method.minScored)} />
                                : <span class="dim tt" data-tip={scoreTip(m, b.method.minScored)}>too few runs ({m.scored}/{b.method.minScored})</span>}</td>
                            <td>{m.score ? <span class="tt" data-tip={scoreTip(m, b.method.minScored)}>{pct(m.score.chance)}</span> : ""}</td>
                            <td>{m.scored}</td>
                            <td>{m.passed}</td>
                            <td>{m.tasks}</td>
                            <td>{m.bloat ? <span class={`tt${m.bloat.ratio >= 1.5 ? " hot" : ""}`} data-tip={bloatTip(m)}>×{m.bloat.ratio.toFixed(2)}</span> : <span class="dim tt" data-tip={bloatTip(m)}>—</span>}</td>
                            <td>{m.medianTokens ?? ""}</td>
                            <td><span class="tt" data-tip={`${m.runs} logged: ${m.scored} scored, ${m.unscored} with no predicate, ${m.errored} errored. First ${when(m.first)}.`}>{m.runs}</span></td>
                            <td class="l dim">{when(m.last)}</td>
                        </tr>
                    ))}</tbody>
                </table>
            </div>
        </section>
    );
}

function Tasks({ b }: { b: ScoreBoard }) {
    const a = b.about;
    // Only a spec with dimensions besides the model has variants; without any, the column would be empty.
    const variants = b.tasks.some((t) => t.variant !== "{}");
    return (
        <section class="card">
            <header><h2><Tip tip="Every task with a logged run, hardest first. A task edited in its spec (text or predicate) gets a new hash and a new line.">Tasks</Tip></h2></header>
            <div class="tablewrap">
                <table class="scores">
                    <thead><tr>
                        <th class="l"><Tip tip="The spec's task id, and the hash of what it asks and how it is scored. Hover the id for the task's text.">task</Tip></th>
                        {variants ? <th class="l"><Tip tip="The spec's other dimensions this item ran under, besides the model. The same task under another variant is another item.">variant</Tip></th> : null}
                        <th class="l"><Tip tip={a.difficulty}>difficulty b</Tip></th>
                        <th><Tip tip={a.taskPassed}>passed</Tip></th>
                        <th><Tip tip={a.taskRuns}>runs</Tip></th>
                        <th><Tip tip={a.taskModels}>models</Tip></th>
                        <th><Tip tip="The median of every run's total tokens on this task, the baseline the bloat column divides by.">median tokens</Tip></th>
                    </tr></thead>
                    <tbody>{b.tasks.map((t) => (
                        <tr key={t.key}>
                            <td class="l"><span class="tt from" data-tip={`The task, from its spec: ${t.text}`}>{t.task}</span> <Hash hash={t.taskHash} /></td>
                            {variants ? <td class="l dim">{t.variant === "{}" ? "" : t.variant}</td> : null}
                            <td class="l">{t.difficulty
                                ? <Interval lo={t.difficulty.lo} hi={t.difficulty.hi} v={t.difficulty.b} tip={`b = ${signed(t.difficulty.b)}, interval ${signed(t.difficulty.lo)} to ${signed(t.difficulty.hi)}, from ${t.scoredRuns} scored run${t.scoredRuns === 1 ? "" : "s"} by ${t.models} model${t.models === 1 ? "" : "s"}.`} />
                                : <span class="dim tt" data-tip={t.scored ? "Every run of it errored, so none was scored." : "The task has no pass/fail predicate (`succeeded` in its spec), so its runs count only for tokens."}>{t.scored ? "no scored run" : "no predicate"}</span>}</td>
                            <td>{t.scored ? `${t.passed}/${t.scoredRuns}` : ""}</td>
                            <td>{t.runs}</td>
                            <td>{t.models}</td>
                            <td>{t.medianTokens ?? ""}</td>
                        </tr>
                    ))}</tbody>
                </table>
            </div>
        </section>
    );
}

/** How every number is computed, and where the raw data is: folded away until asked for. */
function Method({ b }: { b: ScoreBoard }) {
    const query = `sqlite3 ${b.db} "SELECT model, task, passed, tokens, at, by FROM runs ORDER BY at DESC LIMIT 20"`;
    const labels: Record<string, string> = { model: "model", score: "score θ", chance: "chance", scored: "scored", passed: "passed", tasks: "tasks", bloat: "bloat", medianTokens: "tokens", runs: "runs", last: "last run", difficulty: "difficulty b", taskRuns: "a task's runs", taskModels: "a task's models", taskPassed: "a task's passed" };
    return (
        <section class="card">
            <Disclosure label={<h2>How these numbers are computed</h2>} note="and where the raw data is">
                <div class="method">
                <dl>{Object.entries(b.about).map(([k, v]) => <Fragment key={k}><dt>{labels[k] ?? k}</dt><dd>{v}</dd></Fragment>)}</dl>
                <p>The fit {b.method.converged ? `converged in ${b.method.iterations} Newton step${b.method.iterations === 1 ? "" : "s"}` : "did NOT converge: treat these scores as unreliable"}. The raw data is the <code>runs</code> table of <code>{b.db}</code>: one row per run, inserted once and never updated, each saying who started its sweep and when. <code>scores.md</code> and <code>scores.json</code> beside it are this page as text. To look yourself:</p>
                <pre class="query">{query}</pre>
                </div>
            </Disclosure>
        </section>
    );
}

function Board({ b }: { b: ScoreBoard }) {
    const t = b.totals;
    return (
        <>
            <header class="top">
                <div class="titlebar">
                    <div class="names">
                        <h1>Model scoreboard</h1>
                        <p class="desc">Every run the bench made against a real model, scored where its task has a pass/fail predicate.</p>
                    </div>
                    <ThemeToggle />
                </div>
                <div class="counts">
                    <span class="badge tt" data-tip={`The raw data: the runs table of ${b.db} (SQLite), one row per run, never updated. This page, scores.md and scores.json are views of it, generated ${when(b.generated)}.`}>{t.runs} runs in <code>{b.db.split("/").pop()}</code></span>
                    <span class="badge tt" data-tip={b.about.scored}>{t.fitted} scored</span>
                    {t.unscored ? <span class="badge warn tt" data-tip="Runs of tasks with no pass/fail predicate: they count for tokens, not for the score. Give the task a `succeeded` predicate in its spec to count them.">{t.unscored} no predicate</span> : null}
                    {t.errored ? <span class="badge tt" data-tip="Scored tasks' runs that errored (backend down, timeout, crash): left out of the score.">{t.errored} errored</span> : null}
                    <span class="badge">{t.models} model{t.models === 1 ? "" : "s"} · {t.tasks} task{t.tasks === 1 ? "" : "s"}</span>
                </div>
            </header>
            <main>
                {t.runs ? <><Models b={b} /><Tasks b={b} /></> : <section class="card"><div class="empty">Nothing logged yet: a sweep against a real model logs every run it makes.</div></section>}
                <Method b={b} />
            </main>
        </>
    );
}

applyTheme(readTheme());
installTooltipLayer(document);
const board = window.__BENCH_SCORES__;
render(board ? <Board b={board} /> : <main><div class="card"><div class="empty">No scoreboard in this page.</div></div></main>, document.getElementById("app")!);

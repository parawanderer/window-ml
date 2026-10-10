// app.tsx — the bench's page: a sweep as it runs (over SSE from serve.mjs) and as it ended (report.html, the same code
// with the last state baked in as `window.__BENCH_STATE__`). One renderer, two lifetimes, so the archive cannot drift
// from the live view.
//
// Laid out as cards, one per question a sweep raises, in the order you ask them: how far along is it and what is
// running, what did the models say (an interview), where did the time go, how did the cells compare, and which run to
// open.

import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { BenchState } from "./state";
import { Answers, Continued } from "./answers";
import { SweepTimeline } from "./timeline";
import { Flight, Stats, Results, Runs } from "./runs";
import { Viewer } from "./viewer";
import { SpecCard } from "./spec";
import { Watch } from "./streams";
import { FromSpec, specSource } from "./from-spec";
import { installTooltipLayer } from "../../../../src/sidebar/tooltip-layer";
import { ThemeToggle, applyTheme, readTheme } from "./theme";
import { runClock } from "./clock";
import { signed } from "../../../../src/sidebar/interval-bar";
import { laneScoped, resWindowS, resWindowPref } from "../../../../src/sidebar/store";
import { installChartKeys } from "../../../../src/sidebar/resource/resource-chart";
import { cloudModels, scriptedModels } from "../../../../src/sidebar/palette";
import { SpendBadge, SpendRole } from "./spend";
import { MemoryCard } from "./memory";

declare global { interface Window { __BENCH_STATE__?: BenchState } }

/** Where the reader was when a rebuild reloaded the page; restored once, then forgotten. */
const SCROLL_KEY = "benchScrollY";

/** The models behind the runs, by role: the driver, the vision reader and the utility model, since a delegated look or
 *  a utility call makes "which model produced this" three questions. */
/** What each model of a run does, for its pill's tooltips. */
const ROLE_TIP = {
    driver: "The model that runs the agent: it reads the page and picks every tool call.",
    vision: "The model that reads screenshots for look, locate and verify.",
    utility: "A small, cheap model for side tasks, such as summarising a session into its title.",
};

/**
 * The driver model's line on the bench's scoreboard (scores.mjs), as one more segment of its pill: θ, or how many scored
 * runs it still needs. The tip says what the number is and where it came from; the link opens the scoreboard.
 */
function ScoreRole({ s, driver }: { s: BenchState; driver?: string | null }) {
    const sc = s.scores, m = driver ? sc?.models[driver] : null;
    if (!sc || !m) return null;
    const tip = m.score
        ? `On the bench's scoreboard: θ ${signed(m.score.theta)} (interval ${signed(m.score.lo)} to ${signed(m.score.hi)}) from ${m.scored} scored runs over ${m.tasks} tasks, every sweep's runs of this model included. 0 means even odds on a task of average difficulty. Click for the scoreboard, which says how it is computed.`
        : `Not on the scoreboard yet: ${m.scored} of the ${sc.minScored} scored runs a score needs (runs of tasks with a \`succeeded\` predicate). Click for the scoreboard.`;
    return <a class="role score tt" href={sc.href} data-tip={tip}><span class="rk">score</span>{m.score ? <b>{signed(m.score.theta)}</b> : <span class="dim">{m.scored}/{sc.minScored}</span>}</a>;
}

/** The way to the scoreboard from the sweep, beside the theme; when this sweep logged nothing to it, a dim button saying why. */
function ScoreboardLink({ s }: { s: BenchState }) {
    if (s.scores) return <a class="btn small tt" href={s.scores.href} data-tip="Every model the bench has run against a real backend, scored over all sweeps (this one included), with how each number is computed and the SQLite file that holds the runs.">scoreboard</a>;
    return <span class="btn small off tt" aria-disabled="true" data-tip="This sweep has no scoreboard: it ran against the fake model, on a Node without node:sqlite, or with a harness from before the scoreboard (#480). A sweep against a real model logs its runs, and this becomes a link.">scoreboard</span>;
}

function Models({ s }: { s: BenchState }) {
    const seen = new Map<string, NonNullable<BenchState["runs"][number]["models"]>>();
    for (const r of s.runs) if (r.models) seen.set([r.models.driver, r.models.vision, r.models.utility].join(" "), r.models);
    if (!seen.size) return null;
    const role = (k: keyof typeof ROLE_TIP, v?: string | null) => <span class={`role tt${v ? "" : " none"}`} data-tip={ROLE_TIP[k]}><span class="rk">{k}</span>{v ? <code>{v}</code> : "none"}</span>;
    return <div class="models">{[...seen.values()].map((m, i) => <span key={i} class="mset">{role("driver", m.driver)}<ScoreRole s={s} driver={m.driver} /><SpendRole spend={s.spend} driver={m.driver} />{role("vision", m.vision)}{role("utility", m.utility)}</span>)}</div>;
}

/** The sweep's name, what it is for, how far along it is, and its counts; sticky, so it stays in view. */
function Head({ s, disconnected }: { s: BenchState; disconnected: boolean }) {
    const done = s.runs.filter((r) => r.state === "done").length;
    const pct = s.runs.length ? Math.round((done / s.runs.length) * 100) : 0;
    const failed = s.runs.filter((r) => r.state === "done" && !r.ok).length;
    const cached = s.runs.filter((r) => r.cached && !r.onDisk).length;
    const onDisk = s.runs.filter((r) => r.onDisk).length;
    useEffect(() => { document.title = s.finished ? `✓ ${s.name}` : `${pct}% ${s.name}`; }, [s.finished, pct, s.name]);
    return (
        <header class="top">
            <div class="titlebar">
                <div class="names">
                    <FromSpec as="h1" tip={`The sweep's name, from ${specSource(s)}.`}>{s.name}</FromSpec>
                    {s.description ? <FromSpec as="p" class="desc" tip={`The sweep's description, from ${specSource(s)}: written by whoever wrote the spec, not by this page.`}>{s.description}</FromSpec> : null}
                </div>
                <ScoreboardLink s={s} />
                <ThemeToggle />
            </div>
            <div class="bar"><i style={{ width: `${pct}%` }} /></div>
            <div class="counts">
                <span class="badge tt" data-tip="Runs finished out of the whole matrix.">{done} / {s.runs.length} runs · {pct}%</span>
                {failed ? <span class="badge bad">{failed} failed</span> : null}
                <SpendBadge spend={s.spend} />
                {cached ? <span class="badge tt" data-tip="Runs not re-run: an earlier sweep of the same build measured them. --no-cache runs them again.">{cached} cached</span> : null}
                {onDisk ? <span class="badge tt" data-tip="Runs this invocation did not select (--only, --models) that an earlier one of the same spec and build ran: in every figure, as if read from the cache.">{onDisk} already on disk</span> : null}
                {s.finished ? <span class="badge ok">done</span> : <span class="badge tt" data-tip="Runs going at once, each in its own browser (--jobs).">{s.jobs} job{s.jobs > 1 ? "s" : ""}</span>}
                {s.spec?.changed ? <a class="badge warn tt" href="#spec" data-tip="The spec differs from the sweep before: see the Spec card.">spec changed</a> : null}
                {s.dirty ? <span class="badge warn tt" data-tip="Built with uncommitted changes: these numbers are not reproducible from a commit.">dirty tree</span> : null}
                {s.memory?.paused ? <a class="badge warn tt" href="#memory" data-tip={`Paused at the memory budget: ${s.memory.paused}`}>paused: memory</a> : null}
                {disconnected ? <span class="badge bad">disconnected</span> : null}
            </div>
        </header>
    );
}

/** Runs in the sweep's directory from an earlier spec or build: named so they are not taken for lost, never counted. */
function Older({ s, base }: { s: BenchState; base: string }) {
    if (!s.older?.length) return null;
    return (
        <section class="card">
            <header><h2>Also on disk, from an earlier version</h2><span class="sub">not in any figure here; run their cells again to measure them on this version</span></header>
            <ul>{s.older.map((o) => (
                <li key={o.path}>{o.combo ? Object.entries(o.combo).map(([k, v]) => `${k}=${v}`).join(" ") + " · " : ""}{o.taskId ?? "?"} · r{o.repeat ?? "?"}: <a href={`${base}${o.path}/run.md.html`}><code>{o.path}</code></a></li>
            ))}</ul>
        </section>
    );
}

function App() {
    const baked = window.__BENCH_STATE__ ?? null;
    const [s, setS] = useState<BenchState | null>(baked);
    const [disconnected, setDisconnected] = useState(false);
    const [buildError, setBuildError] = useState<string | null>(null);
    useEffect(() => {
        // A SAVED page has its state already; subscribing would sit on a dead port and report a complete sweep as lost.
        if (baked) return;
        const src = new EventSource("/events");
        src.onmessage = (e) => { const next = JSON.parse(e.data); markCloud(next); setS(next); setDisconnected(false); };
        src.onerror = () => setDisconnected(true);
        // The page's own source changed and the server rebuilt it (serve.mjs `watch`): reload onto the new build, keeping
        // the place. The state comes straight back on the stream.
        src.addEventListener("reload", () => {
            try { sessionStorage.setItem(SCROLL_KEY, String(window.scrollY)); } catch { /* storage off */ }
            location.reload();
        });
        src.addEventListener("build-error", (e) => setBuildError(JSON.parse((e as MessageEvent).data).message));
        return () => src.close();
    }, []);
    // Back where the reader was before a rebuild reloaded the page, once there is something to scroll.
    useEffect(() => {
        if (!s) return;
        try {
            const y = sessionStorage.getItem(SCROLL_KEY);
            if (y != null) { sessionStorage.removeItem(SCROLL_KEY); requestAnimationFrame(() => window.scrollTo(0, Number(y))); }
        } catch { /* storage off */ }
    }, [!!s]);
    // The clocks (elapsed, a running step's time, the ETA) move with the wall, not with events: one clock for the page
    // (clock.ts), stopped once the sweep is over.
    useEffect(() => { runClock(!!s && !s.finished); return () => runClock(false); }, [!!s, s?.finished]);
    if (!s) return <main><div class="card"><div class="empty">Waiting for the sweep…</div></div></main>;
    const base = s.artifactBase ?? "/artifacts/";
    return (
        <>
            <Head s={s} disconnected={disconnected} />
            <main>
                {buildError ? (
                    <section class="card builderr">
                        <header><h2>The page's last edit did not build</h2><span class="sub">Still showing the previous build; it reloads once the source builds again.</span>
                            <span class="sp" /><button class="btn small" onClick={() => setBuildError(null)}>dismiss</button></header>
                        <pre>{buildError}</pre>
                    </section>
                ) : null}
                <section class="card"><Stats s={s} /><Models s={s} /></section>
                <MemoryCard m={s.memory} />
                <Flight s={s} />
                <Answers s={s} base={base} live={!baked} />
                <Continued s={s} base={base} />
                <Watch live={!baked} />
                <SweepTimeline s={s} />
                <Results s={s} />
                <Runs s={s} base={base} />
                <Older s={s} base={base} />
                <SpecCard s={s} />
            </main>
            <Viewer s={s} base={base} live={!baked} />
        </>
    );
}

/** The sweep's cloud models get their own shade wherever a model is coloured (palette.ts `cloudModels`), and a seeded
 *  run's script a neutral one (`scriptedModels`); set before the state renders, and only when a list changed, so a live
 *  update does not recolour every bar for nothing. */
function markCloud(s: BenchState | null | undefined) {
    for (const [sig, next] of [[cloudModels, s?.cloud ?? []], [scriptedModels, s?.scripted ?? []]] as const) {
        const cur = sig.value;
        if (next.length !== cur.size || next.some((m) => !cur.has(m))) sig.value = new Set(next);
    }
}

applyTheme(readTheme());
// The resource panel's chart (the timeline's memory) reads its window from the panel's store. Here nothing is scoped to
// one session, and the window is the WHOLE sweep, not the panel's last few minutes. A finished sweep's chart is told
// where it ends (`endAt`, timeline.tsx), so "live" there is the whole sweep, and not the wall clock the page is read at.
laneScoped.value = false;
resWindowS.value = 0;
resWindowPref.value = 0;   // the default the window chip's ✕ goes back to: the whole sweep
markCloud(window.__BENCH_STATE__);
// The chart's keys (↑/↓ pick a line, ←/→ through a model's parts, Esc unwinds), which the panel installs with its own.
installChartKeys(document);
// The panel's tooltip layer, so a `Hash` chip shows the tip it shows in the panel.
installTooltipLayer(document);
render(<App />, document.getElementById("app")!);

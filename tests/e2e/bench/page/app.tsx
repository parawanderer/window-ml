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
import { Answers } from "./answers";
import { SweepTimeline } from "./timeline";
import { Flight, Stats, Results, Runs } from "./runs";
import { Viewer } from "./viewer";
import { SpecCard } from "./spec";

declare global { interface Window { __BENCH_STATE__?: BenchState } }

/** Where the reader was when a rebuild reloaded the page; restored once, then forgotten. */
const SCROLL_KEY = "benchScrollY";

type Theme = "auto" | "light" | "dark";
const THEME_KEY = "benchTheme";
/** Remembered per browser; guarded, since a saved report opened from file:// can throw on localStorage. */
const readTheme = (): Theme => { try { const t = localStorage.getItem(THEME_KEY); return t === "light" || t === "dark" ? t : "auto"; } catch { return "auto"; } };
const applyTheme = (t: Theme) => { if (t === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t; };

/** Auto (follow the system), light, dark: one button that says what it is now and switches to the next. */
function ThemeToggle() {
    const [theme, setTheme] = useState<Theme>(readTheme);
    useEffect(() => { applyTheme(theme); try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode */ } }, [theme]);
    const next: Record<Theme, Theme> = { auto: "light", light: "dark", dark: "auto" };
    const icon = { auto: "◐", light: "☀", dark: "☾" }[theme];
    return <button class="btn small" title={`Theme: ${theme} (click for ${next[theme]})`} aria-label={`Theme: ${theme}`} onClick={() => setTheme(next[theme])}>{icon} {theme}</button>;
}

/** The models behind the runs, by role: the driver, the vision reader and the utility model, since a delegated look or
 *  a utility call makes "which model produced this" three questions. */
function Models({ s }: { s: BenchState }) {
    const seen = new Map<string, NonNullable<BenchState["runs"][number]["models"]>>();
    for (const r of s.runs) if (r.models) seen.set([r.models.driver, r.models.vision, r.models.utility].join(" "), r.models);
    if (!seen.size) return null;
    const role = (k: string, v?: string | null) => <span class={`role${v ? "" : " none"}`}><span class="rk">{k}</span>{v ? <code>{v}</code> : "none"}</span>;
    return <div class="models">{[...seen.values()].map((m, i) => <span key={i} class="mset">{role("driver", m.driver)}{role("vision", m.vision)}{role("utility", m.utility)}</span>)}</div>;
}

/** The sweep's name, what it is for, how far along it is, and its counts; sticky, so it stays in view. */
function Head({ s, disconnected }: { s: BenchState; disconnected: boolean }) {
    const done = s.runs.filter((r) => r.state === "done").length;
    const pct = s.runs.length ? Math.round((done / s.runs.length) * 100) : 0;
    const failed = s.runs.filter((r) => r.state === "done" && !r.ok).length;
    const cached = s.runs.filter((r) => r.cached).length;
    useEffect(() => { document.title = s.finished ? `✓ ${s.name}` : `${pct}% ${s.name}`; }, [s.finished, pct, s.name]);
    return (
        <header class="top">
            <div class="titlebar">
                <div class="names"><h1>{s.name}</h1>{s.description ? <p class="desc">{s.description}</p> : null}</div>
                <ThemeToggle />
            </div>
            <div class="bar"><i style={{ width: `${pct}%` }} /></div>
            <div class="counts">
                <span class="badge">{done} / {s.runs.length} runs · {pct}%</span>
                {failed ? <span class="badge bad">{failed} failed</span> : null}
                {cached ? <span class="badge">{cached} cached</span> : null}
                {s.finished ? <span class="badge ok">done</span> : <span class="badge">{s.jobs} job{s.jobs > 1 ? "s" : ""}</span>}
                {s.spec?.changed ? <a class="badge warn" href="#spec" title="the spec differs from the sweep before: see the Spec card">spec changed</a> : null}
                {s.dirty ? <span class="badge warn" title="uncommitted changes: these numbers are not reproducible from a commit">dirty tree</span> : null}
                {disconnected ? <span class="badge bad">disconnected</span> : null}
            </div>
        </header>
    );
}

function App() {
    const baked = window.__BENCH_STATE__ ?? null;
    const [s, setS] = useState<BenchState | null>(baked);
    const [, tick] = useState(0);
    const [disconnected, setDisconnected] = useState(false);
    const [buildError, setBuildError] = useState<string | null>(null);
    useEffect(() => {
        // A SAVED page has its state already; subscribing would sit on a dead port and report a complete sweep as lost.
        if (baked) return;
        const src = new EventSource("/events");
        src.onmessage = (e) => { setS(JSON.parse(e.data)); setDisconnected(false); };
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
    // The clocks (elapsed, a running step's time, the ETA) move with the wall, not with events.
    useEffect(() => {
        if (s?.finished) return;
        const t = setInterval(() => tick((n) => n + 1), 1000);
        return () => clearInterval(t);
    }, [s?.finished]);
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
                <Flight s={s} />
                <Answers s={s} base={base} live={!baked} />
                <SweepTimeline s={s} />
                <Results s={s} />
                <Runs s={s} base={base} />
                <SpecCard s={s} />
            </main>
            <Viewer s={s} base={base} live={!baked} />
        </>
    );
}

applyTheme(readTheme());
render(<App />, document.getElementById("app")!);

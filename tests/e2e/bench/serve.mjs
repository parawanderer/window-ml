// serve.mjs — a live dashboard for a running sweep.
//
// A sweep is the one thing in this repo with a genuinely long feedback loop: 120 runs is hours, and the
// terminal sink emits one line per cell, so watching it means reading scrollback and holding the matrix in
// your head. This serves a page that fills in as results land.
//
// It is a SINK, not a second brain: the server recomputes the aggregate with the same `aggregate()` the
// report uses and pushes the whole table each time a cell finishes. Nothing is aggregated in the browser,
// so the page cannot disagree with `report.md` — which is the failure mode a client-side reimplementation
// would eventually have.
//
// Deliberately dependency-free (node:http + Server-Sent Events, one inline page). A local dev view should
// not add a build step or a package, and SSE is the whole protocol: one direction, text frames, automatic
// reconnect in the browser.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { COLUMNS } from "./metrics.mjs";

const MIME = {
    ".md": "text/plain; charset=utf-8", ".json": "application/json", ".txt": "text/plain; charset=utf-8",
    ".png": "image/png", ".html": "text/html; charset=utf-8", ".pdf": "application/pdf",
};

const PAGE = /* html */ `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>bench</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --dim:#666; --line:#e3e3e3; --ok:#137333; --bad:#c5221f; --warn:#a86400; --run:#1a73e8; --panel:#f7f7f8; }
  @media (prefers-color-scheme: dark) { :root { --bg:#16171a; --fg:#e6e6e6; --dim:#9aa0a6; --line:#2c2e33; --ok:#5bb974; --bad:#f28b82; --warn:#fdd663; --run:#8ab4f8; --panel:#1e2024; } }
  * { box-sizing: border-box }
  body { margin:0; padding:20px 22px 60px; background:var(--bg); color:var(--fg);
         font:13px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif }
  h1 { font-size:16px; margin:0 0 2px; font-weight:600 }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.07em; color:var(--dim);
       margin:26px 0 8px; font-weight:600 }
  .sub { color:var(--dim); margin:0 0 16px }
  .bar { height:5px; background:var(--panel); border-radius:3px; overflow:hidden; margin:12px 0 4px }
  .bar > i { display:block; height:100%; background:var(--run); transition:width .3s ease }
  .counts { color:var(--dim); font-variant-numeric:tabular-nums }
  table { border-collapse:collapse; width:100%; font-variant-numeric:tabular-nums }
  th,td { text-align:right; padding:5px 9px; border-bottom:1px solid var(--line); white-space:nowrap }
  th:first-child,td:first-child,th.l,td.l { text-align:left }
  th { color:var(--dim); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.05em }
  tbody tr:hover { background:var(--panel) }
  code { font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace }
  a { color:var(--run) }
  .ok { color:var(--ok) } .bad { color:var(--bad) } .warn { color:var(--warn) } .dim { color:var(--dim) }
  .pill { display:inline-block; padding:1px 7px; border-radius:9px; background:var(--panel); font-size:11px }
  .spin { display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--run);
          animation:p 1s infinite ease-in-out; margin-right:6px; vertical-align:1px }
  @keyframes p { 0%,100%{opacity:.25} 50%{opacity:1} }
  .empty { color:var(--dim); padding:14px 0 }
  .stats { display:flex; flex-wrap:wrap; gap:22px; margin:14px 0 6px }
  .stats div { min-width:96px }
  .stats b { display:block; font-size:17px; font-weight:600; font-variant-numeric:tabular-nums }
  .stats span { color:var(--dim); font-size:11px; text-transform:uppercase; letter-spacing:.05em }
  .last { margin:10px 0 0; color:var(--dim); min-height:19px }
  .last code { color:var(--fg) }
  tr.live { background:color-mix(in srgb, var(--run) 9%, transparent) }
  tr.live td { border-bottom-color:color-mix(in srgb, var(--run) 30%, var(--line)) }
  tr.next td:first-child::before { content:"▸ "; color:var(--run) }
  .flight { color:var(--fg) }
  .budget { color:var(--dim) }
</style>
<h1 id="name">bench</h1>
<p class="sub" id="desc"></p>
<div class="bar"><i id="fill" style="width:0"></i></div>
<p class="counts" id="counts">waiting for the sweep…</p>
<div id="stats" class="stats"></div>
<p id="last" class="last"></p>

<h2>Results</h2>
<div id="agg" class="empty">Nothing measured yet.</div>

<h2>Runs</h2>
<div id="runs" class="empty">Nothing has started.</div>

<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
let dims = [], cols = [];

function table(headers, rows) {
    return "<table><thead><tr>" + headers.map((h, i) =>
        \`<th\${i === 0 ? ' class="l"' : ""}>\${esc(h)}</th>\`).join("") + "</tr></thead><tbody>" +
        rows.map((r) => "<tr>" + r.map((c, i) =>
            \`<td\${i === 0 ? ' class="l"' : ""}>\${c}</td>\`).join("") + "</tr>").join("") +
        "</tbody></table>";
}

function renderAgg(rows) {
    if (!rows?.length) { $("agg").className = "empty"; $("agg").textContent = "Nothing measured yet."; return; }
    $("agg").className = "";
    $("agg").innerHTML = table([...dims, "task", "runs", ...cols.map((c) => c.label)],
        rows.map((r) => [
            ...dims.map((d) => \`<code>\${esc(r.combo[d])}</code>\`),
            esc(r.taskId),
            \`\${r.agg.runs - r.agg.errors}/\${r.agg.runs}\`,
            ...cols.map((c) => fmt(r.agg[c.key], c.digits)),
        ]));
}

function fmt(a, digits) {
    if (!a || a.mean == null) return '<span class="dim">—</span>';
    const m = a.mean.toFixed(digits);
    return a.sd == null || a.n < 2 ? m : \`\${m} <span class="dim">±\${a.sd.toFixed(digits)}</span>\`;
}

/** mm:ss from a millisecond span. */
function dur(ms) {
    if (!(ms >= 0)) return "–";
    const t = Math.round(ms / 1000);
    return t < 60 ? t + "s" : Math.floor(t / 60) + "m" + String(t % 60).padStart(2, "0") + "s";
}

function outcome(r, now) {
    if (r.state === "running") {
        // x steps in, against the budget, and what it is doing right now.
        const l = r.live || {};
        const step = l.step != null ? \`step \${l.step}\${l.maxSteps ? \`<span class="budget">/\${l.maxSteps}</span>\` : ""}\` : "starting";
        const doing = l.tool ? \` · <span class="flight">\${esc(l.tool)}</span>\` : "";
        const el = r.startedAt ? \` · <span class="dim">\${dur(now - r.startedAt)}</span>\` : "";
        return \`<span class="spin"></span>\${step}\${doing}\${el}\`;
    }
    if (r.state === "pending") return '<span class="dim">queued</span>';
    if (!r.ok) return '<span class="bad">failed</span>';
    if (r.cached) return '<span class="dim">cached</span>';
    if (r.succeeded === null) return '<span class="ok">ok</span>';
    return r.succeeded ? '<span class="ok">ok · correct</span>' : '<span class="warn">ok · wrong</span>';
}

function renderRuns(runs) {
    if (!runs?.length) return;
    const now = Date.now();
    const nextUp = runs.findIndex((r) => r.state === "pending");
    $("runs").className = "";
    $("runs").innerHTML = "<table><thead><tr>" +
        [...dims, "task", "run", "status", "steps", "secs", "artifacts"].map((h, i) =>
            \`<th\${i === 0 ? ' class="l"' : ""}>\${esc(h)}</th>\`).join("") + "</tr></thead><tbody>" +
        runs.map((r, i) => {
            const cls = r.state === "running" ? " class=\"live\"" : (i === nextUp ? " class=\"next\"" : "");
            const cells = [
                ...dims.map((d) => \`<code>\${esc(r.combo[d])}</code>\`),
                esc(r.taskId), "r" + r.repeat, outcome(r, now),
                r.steps ?? '<span class="dim">–</span>',
                r.secs != null ? r.secs.toFixed(1) : '<span class="dim">–</span>',
                r.path ? \`<a href="/artifacts/\${encodeURI(r.path)}/run.md">run.md</a> <span class="dim">·</span> <a href="/artifacts/\${encodeURI(r.path)}/run.json">json</a>\` : "",
            ];
            return \`<tr\${cls}>\` + cells.map((c, j) => \`<td\${j === 0 ? ' class="l"' : ""}>\${c}</td>\`).join("") + "</tr>";
        }).join("") + "</tbody></table>";
}

/**
 * The four numbers a long sweep raises: how long it has been going, how long a run costs, how long a STEP
 * costs, and when this will be over.
 *
 * The estimate divides remaining work by the observed mean and by the job count. It is deliberately shown
 * as a time of day as well as a duration — "17:40" is actionable in a way "3h 12m" is not — and it is
 * withheld until a few runs have landed, because an ETA extrapolated from one sample is a guess wearing a
 * number's clothes.
 */
function renderStats(s, now) {
    const done = s.runs.filter((r) => r.state === "done");
    const timed = done.filter((r) => typeof r.secs === "number" && !r.cached);
    const meanRun = timed.length ? timed.reduce((a, r) => a + r.secs, 0) / timed.length : null;
    const steps = timed.reduce((a, r) => a + (r.steps || 0), 0);
    const meanStep = steps ? timed.reduce((a, r) => a + r.secs, 0) / steps : null;
    const left = s.runs.length - done.length;
    const elapsed = (s.finished || now) - s.started;

    let eta = null;
    if (!s.finished && meanRun != null && timed.length >= 3 && left > 0) {
        eta = new Date(now + (left * meanRun * 1000) / Math.max(1, s.jobs));
    }
    const cell = (label, value, title) =>
        \`<div title="\${esc(title || "")}"><b>\${value}</b><span>\${esc(label)}</span></div>\`;
    $("stats").innerHTML = [
        cell("elapsed", dur(elapsed)),
        cell("per run", meanRun == null ? "–" : dur(meanRun * 1000), timed.length ? \`mean over \${timed.length} timed runs\` : ""),
        cell("per step", meanStep == null ? "–" : meanStep.toFixed(1) + "s", steps ? \`\${steps} steps across \${timed.length} runs\` : ""),
        s.finished
            ? cell("finished", dur(s.finished - s.started))
            : cell("eta", eta ? eta.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "–",
                eta ? \`about \${dur(eta - now)} left, at \${s.jobs} job(s)\` : "needs a few runs first"),
    ].join("");

    // The last thing that actually happened, across whatever is in flight.
    const live = s.runs.filter((r) => r.state === "running" && r.live?.last);
    $("last").innerHTML = live.length
        ? live.map((r) => \`<code>\${esc(r.taskId)} r\${r.repeat}</code> \${esc(r.live.last)}\`).join("<br>")
        : (s.finished ? "" : '<span class="dim">…</span>');
}

function renderHead(s) {
    $("name").textContent = s.name;
    $("desc").textContent = s.description || "";
    const done = s.runs.filter((r) => r.state === "done").length;
    const pct = s.runs.length ? Math.round((done / s.runs.length) * 100) : 0;
    $("fill").style.width = pct + "%";
    const failed = s.runs.filter((r) => r.state === "done" && !r.ok).length;
    const cached = s.runs.filter((r) => r.cached).length;
    $("counts").innerHTML = \`\${done} / \${s.runs.length} runs · \${pct}%\` +
        (failed ? \` · <span class="bad">\${failed} failed</span>\` : "") +
        (cached ? \` · <span class="dim">\${cached} cached</span>\` : "") +
        (s.finished ? \` · <span class="pill">done in \${((s.finished - s.started) / 60000).toFixed(1)} min</span>\`
                    : \` · <span class="dim">\${s.jobs} job\${s.jobs > 1 ? "s" : ""}</span>\`) +
        (s.dirty ? ' · <span class="warn">dirty tree</span>' : "");
    document.title = s.finished ? \`✓ \${s.name}\` : \`\${pct}% \${s.name}\`;
}

let latest = null;
const draw = () => {
    if (!latest) return;
    const now = Date.now();
    renderHead(latest); renderStats(latest, now); renderAgg(latest.rows); renderRuns(latest.runs);
};
const src = new EventSource("/events");
src.onmessage = (e) => {
    latest = JSON.parse(e.data);
    dims = latest.dims || []; cols = latest.columns || [];
    draw();
};
// Redraw on a timer as well as on a push: the elapsed clocks and the ETA move with the wall, not with
// events, and a run that sits in one tool for a minute would otherwise look frozen.
setInterval(() => { if (latest && !latest.finished) draw(); }, 1000);
src.onerror = () => { $("counts").innerHTML += ' <span class="dim">(disconnected)</span>'; };
</script>
`;

/**
 * Serve a live view of a sweep. Returns `{ url, update, stop }` — call `update(state)` whenever anything
 * changes and every connected browser is pushed the new state.
 *
 * @param {object} opts
 * @param {number} [opts.port] 0 picks a free port
 * @param {string} opts.artifactRoot directory that `run.path` values are relative to, served read-only
 */
export async function startDashboard({ port = 0, artifactRoot }) {
    const clients = new Set();
    let state = { name: "bench", runs: [], rows: [], jobs: 1, started: Date.now() };
    const root = resolve(artifactRoot);

    const server = createServer(async (req, res) => {
        const url = new URL(req.url, "http://localhost");
        if (url.pathname === "/") {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            return res.end(PAGE);
        }
        if (url.pathname === "/events") {
            res.writeHead(200, {
                "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive",
            });
            res.write(`data: ${JSON.stringify(state)}\n\n`);   // the current state, so a late tab is not blank
            clients.add(res);
            req.on("close", () => clients.delete(res));
            return;
        }
        if (url.pathname.startsWith("/artifacts/")) {
            // Confined to the sweep directory: a `..` in a link must not read the filesystem, even on a
            // localhost dev server, because the link text comes from a spec's task ids.
            const rel = normalize(decodeURIComponent(url.pathname.slice("/artifacts/".length)));
            const file = join(root, rel);
            if (!file.startsWith(root + sep)) { res.writeHead(403); return res.end("outside the sweep"); }
            try {
                const body = await readFile(file);
                res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
                return res.end(body);
            } catch { res.writeHead(404); return res.end("not written yet"); }
        }
        res.writeHead(404); res.end("no such thing");
    });

    await new Promise((r) => server.listen(port, "127.0.0.1", r));
    const url = `http://127.0.0.1:${server.address().port}`;

    let flushTimer = null;
    const flush = () => {
        const frame = `data: ${JSON.stringify(state)}\n\n`;
        for (const c of clients) { try { c.write(frame); } catch { clients.delete(c); } }
    };

    return {
        url,
        /**
         * Replace the pushed state. COALESCED: the in-flight stream reports every step of every run, and a
         * frame per event would put a run's debug rate on the wire for no gain — nothing on the page reads
         * faster than a few times a second. The trailing flush is what guarantees the LAST state (the one
         * saying the sweep finished) is never the one dropped.
         */
        update(next) {
            state = { ...next, columns: COLUMNS.map((c) => ({ key: c.key, label: c.label, digits: c.digits })) };
            if (flushTimer) return;
            flush();
            flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 150);
        },
        async stop() {
            if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
            flush();   // never end on a coalesced-away final state
            for (const c of clients) { try { c.end(); } catch { /* already gone */ } }
            clients.clear();
            await new Promise((r) => server.close(r));
        },
    };
}

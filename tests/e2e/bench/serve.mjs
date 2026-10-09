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
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { watch as fsWatch, readFileSync } from "node:fs";
import { extname, join, normalize, resolve, sep, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { COLUMNS } from "./metrics.mjs";
import { appScript, scoresScript, appCss, invalidate } from "./page/bundle.mjs";

/** The stable default. Arbitrary, but FIXED: a reused URL is the whole point (see startDashboard). */
export const DEFAULT_PORT = 7331;

/**
 * Where a FINISHED sweep's page server says who it is (`{ pid, port, url, dir, at }`): `serveSweep` writes it once
 * listening and removes it on the way out. The next sweep reads it to take the port back (so the URL a person was given
 * stays the URL), and `serve.mjs --stop` to stop it. A sweep still RUNNING never writes it, so nothing stops a live one.
 */
export const SERVER_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "../artifacts/bench/server.json");

/** The finished sweep's server named in SERVER_FILE, when its process is still alive; else null. */
export function servedSweep() {
    let s;
    try { s = JSON.parse(readFileSync(SERVER_FILE, "utf8")); } catch { return null; }
    try { process.kill(s.pid, 0); return s; } catch { return null; }
}

/**
 * Stop the finished sweep's server (SERVER_FILE), when there is one and, with `port`, when it holds that port: SIGTERM,
 * then wait up to `waitMs` for it to go. Resolves what it stopped, or null.
 */
export async function stopServedSweep({ port = null, waitMs = 5000 } = {}) {
    const s = servedSweep();
    if (!s || s.pid === process.pid || (port != null && s.port !== port)) return null;
    try { process.kill(s.pid, "SIGTERM"); } catch { return null; }
    for (const until = Date.now() + waitMs; Date.now() < until;) {
        try { process.kill(s.pid, 0); } catch { break; }
        await new Promise((r) => setTimeout(r, 100));
    }
    await rm(SERVER_FILE, { force: true });
    return s;
}

const MIME = {
    ".md": "text/plain; charset=utf-8", ".json": "application/json", ".txt": "text/plain; charset=utf-8",
    ".png": "image/png", ".html": "text/html; charset=utf-8", ".pdf": "application/pdf",
};

/**
 * The page: the stylesheet, a mount point, and the dashboard's script (page/app.tsx, Preact, bundled in memory by
 * page/bundle.mjs). `state`, when given, is baked in ahead of the script as `window.__BENCH_STATE__`, which is all a
 * saved report.html is: the same page with the last state inlined, so the archive cannot drift from the live view.
 */
async function pageHtml(state = null, { script = appScript, title = "bench", key = "__BENCH_STATE__" } = {}) {
    // `</script>` inside the JSON would close the tag early, and U+2028/9 are literal line terminators in a script:
    // escaping `<` and those two keeps the JSON a valid JS object literal that cannot leave its tag.
    const baked = state == null ? "" : `<script>window.${key} = ${JSON.stringify(state)
        .replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")};</script>`;
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${await appCss()}</style></head>
<body><div id="app"></div>
${baked}<script>${script()}</script>
</body></html>
`;
}

/**
 * Serve a live view of a sweep. Returns `{ url, update, stop }` — call `update(state)` whenever anything
 * changes and every connected browser is pushed the new state.
 *
 * @param {object} opts
 * @param {number} [opts.port] omit for the stable default; 0 picks any free port
 * @param {string} opts.artifactRoot directory that `run.path` values are relative to, served read-only
 * @param {(body: object) => Promise<object | null>} [opts.onMark] stores a person's mark on an answer (POST /mark);
 *   null means it was not a valid one
 * @param {string[]} [opts.watch] files and directories the page is built from (`pageSources()`). When given, the page is
 *   EDITABLE WHILE SOMEONE LOOKS AT IT: a change rebuilds it and every open browser reloads (its state comes back on the
 *   stream, its scroll position with it), so a person, Claude Code or any other agent can work on the page live. A
 *   build that fails is shown on the page and the last good build keeps being served.
 * @param {() => Promise<string>} [opts.rebuild] how to build the page again after a change (a test's seam)
 * @param {() => Promise<object | null>} [opts.scores] the scoreboard as it is now (scores.mjs `scoreboard`), served at
 *   /scores, read afresh on every visit so it includes the runs this sweep has logged so far
 */
export async function startDashboard({ port = DEFAULT_PORT, artifactRoot, onMark = null, watch = null, rebuild = null, scores = null }) {
    let page = await pageHtml();
    const clients = new Set();
    let state = { name: "bench", runs: [], rows: [], jobs: 1, started: Date.now() };
    const root = resolve(artifactRoot);

    const server = createServer(async (req, res) => {
        const url = new URL(req.url, "http://localhost");
        if (url.pathname === "/") {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            return res.end(page);
        }
        if (url.pathname === "/scores" && scores) {
            const board = await scores().catch(() => null);
            if (!board) { res.writeHead(404); return res.end("no scores log"); }
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            return res.end(await scoresPage(board));
        }
        if (url.pathname === "/events") {
            res.writeHead(200, {
                "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive",
            });
            res.write(`data: ${JSON.stringify(state)}\n\n`);   // the current state, so a late tab is not blank
            clients.add(res);
            seen.set(res, version);
            // Drained: the newest state, unless it already has it (resending the same one refilled the buffer forever).
            res.on("drain", () => { if (behind.delete(res) && seen.get(res) !== version) sendState(res); });
            req.on("close", () => { clients.delete(res); behind.delete(res); seen.delete(res); });
            return;
        }
        if (url.pathname === "/mark" && req.method === "POST" && onMark) {
            // JSON only: a page on another origin can POST text/plain here without asking, but not
            // application/json, which needs a CORS preflight this server never answers.
            if (!/^application\/json\b/.test(req.headers["content-type"] || "")) { res.writeHead(415); return res.end("JSON only"); }
            let raw = "";
            for await (const chunk of req) { raw += chunk; if (raw.length > 64_000) { res.writeHead(413); return res.end("too large"); } }
            let body; try { body = JSON.parse(raw); } catch { res.writeHead(400); return res.end("not JSON"); }
            const saved = await onMark(body);
            if (!saved) { res.writeHead(400); return res.end("not a mark: taskId, who, turn, and a quote or a note"); }
            res.writeHead(200, { "content-type": "application/json" });
            return res.end(JSON.stringify(saved));
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

    // A STABLE port, so the browser tab survives between sweeps — reload rather than re-paste a new URL.
    // That matters most in VS Code, where the page lives in a Simple Browser editor tab you would
    // otherwise have to reopen every run. Falls back to any free port if something already holds it,
    // rather than refusing to start over a convenience.
    // A finished sweep's server left on the port (serveSweep) gives it back, so this sweep keeps the URL already in use.
    if (port) await stopServedSweep({ port });
    let bound = port;
    try {
        await new Promise((res, rej) => server.listen(port, "127.0.0.1", res).once("error", rej));
    } catch {
        bound = 0;
        server.removeAllListeners("error");
        await new Promise((r) => server.listen(0, "127.0.0.1", r));
    }
    const url = `http://127.0.0.1:${server.address().port}`;
    if (bound !== port) console.log(`  (port ${port} was taken — serving on ${server.address().port} instead)`);

    /**
     * The clients that could not take the last state frame: its socket's buffer was full (a tab in the background, a
     * slow link). A state frame REPLACES the one before, so such a client is skipped until it drains and then sent the
     * newest one. Written to regardless, a reader that stopped reading kept every frame in this process: a 1 to 2 MB state
     * several times a second filled the heap in minutes (a 330-run sweep died at 4 GB).
     */
    const behind = new Set();
    /** Which state each client was last sent, by `version` (bumped on every update). */
    const seen = new Map();
    let version = 0, stateFrame = null;
    const send = (c, frame) => {
        try { if (!c.write(frame)) behind.add(c); } catch { clients.delete(c); behind.delete(c); }
    };
    const sendState = (c) => {
        stateFrame ??= `data: ${JSON.stringify(state)}\n\n`;
        seen.set(c, version);
        send(c, stateFrame);
    };
    /** A named event to every open page: `reload` after a rebuild, `build-error` when one failed. */
    const announce = (name, data) => {
        const frame = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const c of clients) send(c, frame);   // rare and small: sent even to a client that is behind
    };
    // The live-edit loop. Debounced, since an editor's save is often several writes and a model's edit several files.
    const watchers = [];
    let rebuildTimer = null;
    const onSourceChange = () => {
        clearTimeout(rebuildTimer);
        rebuildTimer = setTimeout(async () => {
            rebuildTimer = null;
            invalidate();
            try {
                page = await (rebuild ? rebuild() : pageHtml());
                announce("reload", { at: Date.now() });
            } catch (e) {
                announce("build-error", { message: String(e?.message || e).slice(0, 4000) });
            }
        }, 150);
    };
    for (const p of watch || []) {
        try { watchers.push(fsWatch(p, { recursive: true }, onSourceChange)); }
        catch { /* a path that is not there is not watched */ }
    }

    let flushTimer = null;
    const flush = () => {
        for (const c of clients) {
            if (behind.has(c) || seen.get(c) === version) continue;   // a client that is behind gets the newest when it drains
            sendState(c);
        }
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
            state = { ...next, columns: COLUMNS.map((c) => ({ key: c.key, label: c.label, about: c.about, digits: c.digits })) };
            version++; stateFrame = null;
            if (flushTimer) return;
            flush();
            flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 150);
        },
        async stop() {
            if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
            clearTimeout(rebuildTimer);
            for (const w of watchers) w.close();
            flush();   // never end on a coalesced-away final state
            for (const c of clients) { try { c.end(); } catch { /* already gone */ } }
            clients.clear();
            await new Promise((r) => server.close(r));
        },
    };
}

/**
 * The same page with the final state baked in — a SAVED sweep.
 *
 * The live view is already an index of the runs, so archiving it makes the sweep directory navigable on
 * its own: open `report.html` and every run is one click away, with the aggregate table above it. Written
 * beside `report.md` for whoever prefers which.
 *
 * It is the same HTML and the same renderer, differing only in where the state comes from and in the link
 * base — relative, since the file sits IN the sweep directory rather than being served from `/artifacts/`.
 * Writing a separate static report instead would be a third implementation of the same table, and it
 * would eventually disagree with the other two.
 *
 * @param {object} state the final sweep state (as pushed to `update`)
 * @returns {Promise<string>} a self-contained HTML document
 */
export async function staticPage(state) {
    return pageHtml({ ...state, artifactBase: "", columns: COLUMNS.map((c) => ({ key: c.key, label: c.label, about: c.about, digits: c.digits })) });
}

/**
 * The scoreboard page (page/scores.tsx) with a board baked in: scores.html beside the log, and /scores on a live sweep.
 * Same stylesheet and tooltip layer as the sweep page.
 */
export const scoresPage = (board) => pageHtml(board, { script: scoresScript, title: "scoreboard", key: "__BENCH_SCORES__" });

/**
 * Serve a FINISHED sweep's page from its directory, as the live page showed it at the end: page.json's state, the run
 * artifacts, /scores read afresh, and marks (POST /mark, and marks.jsonl edits from mark.mjs) checked against the
 * answers as the live sweep did. run.mjs hands its page to this in a detached process when a `--serve` sweep ends, so
 * the sweep process can exit (its caller learns it is done) while the open browser tab reconnects to the same URL.
 * Writes SERVER_FILE once listening; SIGTERM or SIGINT stops it and removes the file.
 */
export async function serveSweep(dir, { port = DEFAULT_PORT } = {}) {
    const { readMarks, addMark } = await import("./mark.mjs");
    const { checkMarks, validMark, followContinued } = await import("../interview.mjs");
    const { pageSources } = await import("./page/bundle.mjs");
    const { openScores, readRuns, scoreboard } = await import("./scores.mjs");
    const sweepDir = resolve(dir);
    const state = JSON.parse(await readFile(join(sweepDir, "page.json"), "utf8"));
    // page.json links the saved page's scoreboard beside the log; served, the scoreboard is /scores.
    if (state.scores) state.scores = { ...state.scores, href: "/scores" };
    const db = await openScores().catch(() => null);
    let dash = null;
    const recheck = async () => {
        const marks = await readMarks(sweepDir);
        for (const r of state.runs) if (r.turns) r.checks = checkMarks(r, marks);
        dash?.update(state);
    };
    dash = await startDashboard({
        port, artifactRoot: sweepDir, watch: pageSources(),
        ...(db ? { scores: async () => scoreboard(readRuns(db)) } : {}),
        onMark: async (body) => {
            if (!validMark(body)) return null;
            const mark = await addMark(sweepDir, body, "person (page)");
            await recheck();
            return mark;
        },
    });
    await recheck();
    // Turns someone sends a run held open after the sweep (bench/hold.mjs): onto the open page, and into page.json and
    // report.html, so the saved copy shows them too.
    let saveTimer = null;
    const unfollow = followContinued(sweepDir, () => state.runs, () => {
        dash?.update(state);
        clearTimeout(saveTimer);
        saveTimer = setTimeout(async () => {
            await writeFile(join(sweepDir, "page.json"), JSON.stringify({ ...state, ...(state.scores ? { scores: { ...state.scores, href: "../scores.html" } } : {}) }, null, 2)).catch(() => {});
            await writeFile(join(sweepDir, "report.html"), await staticPage({ ...state, ...(state.scores ? { scores: { ...state.scores, href: "../scores.html" } } : {}) })).catch(() => {});
        }, 500);
    });
    let marksTimer = null;
    const marksWatch = (() => {
        try { return fsWatch(sweepDir, (_, f) => { if (f === "marks.jsonl") { clearTimeout(marksTimer); marksTimer = setTimeout(recheck, 100); } }); }
        catch { return null; }
    })();
    const url = dash.url;
    await mkdir(dirname(SERVER_FILE), { recursive: true });
    await writeFile(SERVER_FILE, JSON.stringify({ pid: process.pid, port: Number(new URL(url).port), url, dir: sweepDir, at: new Date().toISOString() }));
    const stop = async () => {
        unfollow();
        clearTimeout(marksTimer);
        marksWatch?.close();
        await dash.stop();
        if (servedSweep()?.pid === process.pid) await rm(SERVER_FILE, { force: true });
        process.exit(0);
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    return { url, stop };
}

// node --import tsx tests/e2e/bench/serve.mjs <sweep dir> [--port N]   serve a finished sweep's page (run.mjs does this)
// node --import tsx tests/e2e/bench/serve.mjs --stop                    stop the one that is serving
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const argv = process.argv.slice(2);
    if (argv[0] === "--stop") {
        const s = await stopServedSweep();
        console.log(s ? `stopped the page server for ${s.dir} (${s.url}, pid ${s.pid})` : "no finished sweep is being served");
    } else if (argv[0]) {
        const i = argv.indexOf("--port");
        const { url } = await serveSweep(argv[0], { port: i >= 0 ? Number(argv[i + 1]) : DEFAULT_PORT });
        console.log(`serving ${argv[0]} at ${url}`);
    } else {
        console.log("usage: serve.mjs <sweep dir> [--port N] | --stop");
        process.exit(2);
    }
}

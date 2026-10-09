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
import { watch as fsWatch } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { COLUMNS } from "./metrics.mjs";
import { appScript, appCss, invalidate } from "./page/bundle.mjs";

/** The stable default. Arbitrary, but FIXED: a reused URL is the whole point (see startDashboard). */
export const DEFAULT_PORT = 7331;

const MIME = {
    ".md": "text/plain; charset=utf-8", ".json": "application/json", ".txt": "text/plain; charset=utf-8",
    ".png": "image/png", ".html": "text/html; charset=utf-8", ".pdf": "application/pdf",
};

/**
 * The page: the stylesheet, a mount point, and the dashboard's script (page/app.tsx, Preact, bundled in memory by
 * page/bundle.mjs). `state`, when given, is baked in ahead of the script as `window.__BENCH_STATE__`, which is all a
 * saved report.html is: the same page with the last state inlined, so the archive cannot drift from the live view.
 */
async function pageHtml(state = null) {
    // `</script>` inside the JSON would close the tag early, and U+2028/9 are literal line terminators in a script:
    // escaping `<` and those two keeps the JSON a valid JS object literal that cannot leave its tag.
    const baked = state == null ? "" : `<script>window.__BENCH_STATE__ = ${JSON.stringify(state)
        .replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")};</script>`;
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>bench</title>
<style>${await appCss()}</style></head>
<body><div id="app"></div>
${baked}<script>${appScript()}</script>
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
 */
export async function startDashboard({ port = DEFAULT_PORT, artifactRoot, onMark = null, watch = null, rebuild = null }) {
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
        if (url.pathname === "/events") {
            res.writeHead(200, {
                "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive",
            });
            res.write(`data: ${JSON.stringify(state)}\n\n`);   // the current state, so a late tab is not blank
            clients.add(res);
            req.on("close", () => clients.delete(res));
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

    /** A named event to every open page: `reload` after a rebuild, `build-error` when one failed. */
    const announce = (name, data) => {
        const frame = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const c of clients) { try { c.write(frame); } catch { clients.delete(c); } }
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
    return pageHtml({ ...state, artifactBase: "", columns: COLUMNS.map((c) => ({ key: c.key, label: c.label, digits: c.digits })) });
}

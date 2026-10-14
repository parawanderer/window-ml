// server.mjs — the probe site for tests/e2e/detection-surface.spec.mjs: pages that watch, from their own main world,
// everything a page can observe about window.ml acting in it, and report it back here.
//
// One local server answers for several hostnames, told apart by the Host header, reached through Chromium's
// `--host-resolver-rules` (`DETECT_RESOLVER_ARGS`), so each is a distinct origin: `probe.test` (the page a run acts
// on, approved by the spec), `other.test` (an unapproved page), `xo.test` (the cross-origin iframe the reserved click
// reaches into) and `api.test` (the target of the worker's fetches, with a cookie of its own).
//
// Every HTML page loads `probe.js` as its FIRST script, which posts what it sees to `/log`. The server also records
// every request it answers (headers included), which is how the spec reads what a site sees of a fetch the worker
// makes. Nothing here needs a network.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Chromium switches that resolve every hostname this server answers for to it. Pass to the browser's args. */
export const DETECT_RESOLVER_ARGS = ["--host-resolver-rules=MAP *.test 127.0.0.1"];

const PROBE_JS = fileURLToPath(new URL("./probe.js", import.meta.url));

/** The probe page: one of each surface a tool acts on, with probe.js first in <head>. */
const probePage = (host, port, { title = "Probe", strict = false } = {}) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<script src="/probe.js"></script>
<style>body{font:14px sans-serif;margin:8px} #xo{width:300px;height:120px;border:1px solid #888} canvas{border:1px solid #888}</style>
</head><body>
<h1 id="h">${title} on ${host}${strict ? " (strict CSP)" : ""}</h1>
<p id="para">A page that watches what happens to it.</p>
<button id="btn">Press</button>
<input id="field" placeholder="type here">
<a id="next" href="/page2">Next page</a>
<div><canvas id="cv" tabindex="0" width="200" height="80"></canvas></div>
<sealed-box id="sealed"><template shadowrootmode="closed"><button id="inner" style="width:160px;height:40px">Sealed</button><input id="sinput" placeholder="sealed field"></template></sealed-box>
<div><iframe id="xo" src="http://xo.test:${port}/frame"></iframe></div>
</body></html>`;

/** The cross-origin frame: a full-size button, the probe watching from inside. */
const framePage = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>frame</title><script src="/probe.js"></script>
<style>html,body{margin:0;height:100%} button{width:100%;height:100%}</style></head>
<body><button id="fbtn">Inside the frame</button></body></html>`;

/**
 * Start the probe site on an ephemeral port.
 * @returns {Promise<{ port: number, url: (host: string, path?: string) => string, origin: (host: string) => string,
 *   reports: () => any[], requests: () => any[], clear: () => void, stop: () => Promise<void> }>}
 */
export async function startProbeSite() {
    /** @type {any[]} */ const reports = [];
    /** @type {any[]} */ const requests = [];
    const server = createServer((req, res) => {
        const host = String(req.headers.host || "").split(":")[0].toLowerCase();
        const u = new URL(req.url || "/", "http://x");
        const path = u.pathname;
        if (path === "/log" && req.method === "POST") {
            let b = "";
            req.on("data", (c) => (b += c));
            req.on("end", () => {
                try { const m = JSON.parse(b); for (const e of m.entries || []) reports.push({ ...e, pid: m.pid, href: m.href, host }); } catch { /* a torn beacon */ }
                res.writeHead(204, { "access-control-allow-origin": "*" });
                res.end();
            });
            return;
        }
        requests.push({ t: Date.now(), host, method: req.method, path, query: u.search, headers: { ...req.headers } });
        if (path === "/probe.js") {
            res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
            res.end(readFileSync(PROBE_JS, "utf8"));
            return;
        }
        if (path === "/setcookie") {
            res.writeHead(200, { "content-type": "text/html", "set-cookie": `session=${host}-secret; Path=/; SameSite=Lax` });
            res.end(`<!doctype html><title>cookie</title><p>cookie set on ${host}</p>`);
            return;
        }
        if (path === "/echo" || path === "/img.png") {
            const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
            if (path === "/img.png") { res.writeHead(200, { "content-type": "image/png", "access-control-allow-origin": "*" }); res.end(png); return; }
            res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
            res.end(`<!doctype html><title>echo</title><p id="echo">echo from ${host}, cookie=${req.headers.cookie ? "yes" : "no"}</p>`);
            return;
        }
        if (path === "/frame") { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(framePage()); return; }
        const strict = u.searchParams.get("csp") === "strict";
        const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...(strict ? { "content-security-policy": "script-src 'self'" } : {}) };
        res.writeHead(200, headers);
        res.end(probePage(host, /** @type {any} */ (server.address()).port, { title: path === "/page2" ? "Page two" : "Probe", strict }));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
    const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
    return {
        port,
        url: (host, path = "/") => `http://${host}:${port}${path}`,
        origin: (host) => `http://${host}:${port}`,
        reports: () => reports.slice(),
        requests: () => requests.slice(),
        clear: () => { reports.length = 0; requests.length = 0; },
        stop: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r(undefined)); }),
    };
}

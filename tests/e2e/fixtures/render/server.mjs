// server.mjs — the render site for the step-5 tab-render rows (docs/spec/SITE_PRESENCE.md, "Redirects on
// auto-approved fetches"; issue #1316): one HTTP server answering for many `*.test` hostnames, 302ing between
// them with a REAL Location chain, serving iframes and a script navigation, and logging every request it
// answers. "The hop's target was NEVER REQUESTED" is a fact about this log — the only oracle that can see a
// tab's own navigation, which no mock and no unit test can.
//
// Reached through Chromium's --host-resolver-rules (renderResolverArgs), told apart by the Host header. The
// `*.test` origins are declared potentially trustworthy (renderSecureArgs) because Chromium only sends the
// `Sec-Fetch-*` headers to trustworthy targets, and one row reads that shape.
//
// Routes (every host):
//   /                    → 200 html, a page
//   /ok                  → 200 text/plain "ok from <host>"
//   /secret              → 200 html "top secret" (the leak target)
//   /start               → 302 to victim.test/secret (an off-site hop, first request)
//   /hop1                → 302 to attacker.test/hop2 → 302 to victim.test/secret (a chain: first hop allowed)
//   /to-partner          → 302 to partner.test/ok (a hop to a URL the run may already have approved)
//   /sub                 → 302 to sub.attacker.test/ok (a hop to a SUBDOMAIN: same registrable domain)
//   /frames              → 200 html with two iframes: sub.attacker.test/frame-ok and victim.test/frame-secret
//   /frame-ok            → 200 html "frame ok from <host>"
//   /frame-secret        → 200 html "frame secret"
//   /script              → 200 html that sets location.href to victim.test/secret after a beat
//   anything else        → 404 text/plain

import { createServer } from "node:http";

/**
 * Chromium flags landing every fixture hostname on this machine, keeping the URL's own port (they all share
 * the one listener, so a URL is `http://<host>:<port>/…`).
 * @param {{port: number}} site the started fixture
 */
export const renderResolverArgs = (site) => [`--host-resolver-rules=MAP *.test 127.0.0.1`];

/** The fixture's hosts, made potentially trustworthy: Chromium sends `Sec-Fetch-*` only to trustworthy
 *  targets, and one row reads the first request's `sec-fetch-site` to tell "the tab was born with its URL"
 *  from "the tab existed and was sent there" (the fix's own note: an `about:blank` tab then `tabs.update`
 *  sends `cross-site`). */
export const RENDER_HOSTS = ["attacker.test", "sub.attacker.test", "victim.test", "partner.test"];
export const renderSecureArgs = (site) => [`--unsafely-treat-insecure-origin-as-secure=${RENDER_HOSTS.map((h) => site.origin(h)).join(",")}`];

/**
 * Start the render site.
 * @returns {Promise<{
 *   port: number,
 *   url: (host: string, path?: string) => string,
 *   origin: (host: string) => string,
 *   requests: () => Array<{host: string, path: string, t: number, headers: Record<string, string>}>,
 *   requestsTo: (host: string) => Array<{host: string, path: string, t: number, headers: Record<string, string>}>,
 *   clear: () => void, stop: () => Promise<void>,
 * }>}
 */
export function startRenderSite() {
    /** @type {Array<{host: string, path: string, t: number, headers: Record<string, string>}>} */
    const log = [];
    const serve = (req, res) => {
        const host = String(req.headers.host || "").split(":")[0].toLowerCase();
        const url = new URL(req.url || "/", `http://${host}`);
        log.push({ host, path: `${url.pathname}${url.search}`, t: Date.now(), headers: req.headers });
        const redirect = (to) => { res.writeHead(302, { location: to, "content-type": "text/plain" }); res.end(`moved to ${to}`); };
        const html = (body) => { res.writeHead(200, { "content-type": "text/html" }); res.end(`<!doctype html><title>${host}</title>${body}`); };
        const text = (body) => { res.writeHead(200, { "content-type": "text/plain" }); res.end(body); };
        const me = `http://${req.headers.host || host}`;
        switch (url.pathname) {
            case "/": return html(`<p>a page on ${host}</p>`);
            case "/ok": return text(`ok from ${host}`);
            case "/secret": return html("<p>top secret</p>");
            case "/start": return redirect(`${me.replace(host, "victim.test")}/secret`);
            case "/hop1": return redirect(`${me.replace(host, "attacker.test")}/hop2`);
            case "/hop2": return redirect(`${me.replace(host, "victim.test")}/secret`);
            case "/to-partner": return redirect(`${me.replace(host, "partner.test")}/ok`);
            case "/sub": return redirect(`${me.replace(host, "sub.attacker.test")}/ok`);
            case "/frames": return html(`<p>frames</p><iframe src="${me.replace(host, "sub.attacker.test")}/frame-ok"></iframe><iframe src="${me.replace(host, "victim.test")}/frame-secret"></iframe>`);
            case "/frame-ok": return html(`<p>frame ok from ${host}</p>`);
            case "/frame-secret": return html("<p>frame secret</p>");
            case "/script": return html(`<p>about to move</p><script>setTimeout(() => { location.href = "${me.replace(host, "victim.test")}/secret"; }, 60);</script>`);
            default: res.writeHead(404, { "content-type": "text/plain" }); res.end(`no route ${url.pathname} on ${host}`);
        }
    };
    const http = createServer(serve);
    return new Promise((resolve) => {
        http.listen(0, "127.0.0.1", () => {
            const port = /** @type {import("node:net").AddressInfo} */ (http.address()).port;
            resolve({
                port,
                url: (host, path = "/") => `http://${host}:${port}${path}`,
                origin: (host) => `http://${host}:${port}`,
                requests: () => [...log],
                requestsTo: (host) => log.filter((r) => r.host === host),
                clear: () => { log.length = 0; },
                stop: () => new Promise((done) => { http.close(() => done(undefined)); }),
            });
        });
    });
}

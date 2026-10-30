// server.mjs — the redirect site for the step-5 rows (docs/spec/SITE_PRESENCE.md, "Redirects on auto-approved
// fetches"): one server answering for many hostnames that 302s between them with a REAL Location chain, logging
// every request it answers. Three listeners: plain HTTP (the hosts' main port), HTTPS (the sheet's https://
// URLs and the http→https upgrade hop need https in the URL shape — test-only cert, the browser runs with
// --ignore-certificate-errors), and a separate loopback-target listener: the "must never be requested" oracle
// for the image row's private hop. Reached through Chromium's --host-resolver-rules (redirectResolverArgs);
// the hosts are told apart by the Host header, as detect/server.mjs does.
//
// `cert.pem`/`key.pem` are a self-signed pair for these fixture names ONLY (CN "redirect-fixture.test (window-ml
// e2e test-only key)", SANs the .test hosts, the Google hosts and localhost), committed so the fixture needs no
// openssl at run time. Regenerate with:
//   openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -keyout key.pem -out cert.pem \
//     -subj "/CN=redirect-fixture.test (window-ml e2e test-only key)" \
//     -addext "subjectAltName=DNS:docs.google.com,DNS:accounts.google.com,DNS:googleusercontent.com,DNS:*.googleusercontent.com,DNS:a.site.test,DNS:b.site.test,DNS:attacker.test,DNS:victim.test,DNS:partner.test,DNS:localhost"
// (The wildcard covers the declared pair's hop target `u0.googleusercontent.com`; without it that hop dies in
// TLS whenever the browser stops being told to ignore certificate errors.)
//
// Routes (every listener; `?to=` gives the Location):
//   /r?to=<url>                      → 302 to <url>
//   /r/<n>                           → 302 to the URL registered under `n` by `site.hopTo(url)`. A row whose first
//                                      URL must not SPELL the hop's target registers it here: a hostile page that
//                                      writes `<url>?to=<target>` puts the target in its own URL, so the refusal it
//                                      reads back echoes it and "the refusal never names the target" is decided by the
//                                      page's text rather than by the worker's. The 302's body does not name it either.
//   /ok                              → 200 text/plain "ok from <host>"
//   /body                            → 200 text/plain "body from <host>"
//   /secret                          → 200 text/html "top secret" (the leak target; a non-raster body)
//   /pixel.png                       → 200 image/png (1x1 raster)
//   /page                            → 200 text/html (a non-raster body)
//   /spreadsheets/d/<id>/export?...  → the sheet's export: `plain` serves CSV; `hop-accounts` 302s to
//                                      accounts.google.com/ServiceLogin (the refused sign-in hop); `hop-cdn`
//                                      302s to *.googleusercontent.com (the declared pair, followed)
//   /uc                              → 200 text/csv (where the declared-pair hop lands)
//   anything else                    → 404 text/plain

import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";

/**
 * Chromium flags landing every fixture hostname on this machine. `*.test` and `localhost` keep the URL's port
 * (the fixture's own listeners). The Google hosts are pinned TO THE TLS PORT instead: their URLs must be
 * port-free (`https://docs.google.com/spreadsheets/...`), because `googleSheetId`/`SHEET_URL_OK` match only
 * `docs.google.com/…` with no port, so the connect has to be redirected at resolution time.
 * @param {{port: number, tlsPort: number, loopbackPort: number}} site the started fixture
 */
export const redirectResolverArgs = (site) => [
    `--host-resolver-rules=MAP docs.google.com 127.0.0.1:${site.tlsPort}, MAP accounts.google.com 127.0.0.1:${site.tlsPort}, MAP *.googleusercontent.com 127.0.0.1:${site.tlsPort}, MAP *.test 127.0.0.1, MAP localhost 127.0.0.1`,
];

/** The fixture's http origins, made potentially trustworthy: Chromium sends the `Sec-Fetch-*` headers only to
 *  trustworthy targets, and the rows read them off the log to tell a worker fetch from a tab navigation
 *  (detection-surface.spec.mjs does the same for its probe hosts). */
export const SECURE_HOSTS = ["attacker.test", "victim.test", "partner.test", "a.site.test", "b.site.test", "img.test", "cdn2.test"];
export const secureOriginArgs = (site) => [`--unsafely-treat-insecure-origin-as-secure=${SECURE_HOSTS.map((h) => site.origin(h)).join(",")}`];

const TLS_KEY = readFileSync(new URL("./key.pem", import.meta.url));
const TLS_CERT = readFileSync(new URL("./cert.pem", import.meta.url));

/** A 1x1 PNG — the one body every "is it a raster" check must accept. */
const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const CSV = "id,name\n1,Ada\n2,Bob\n";
const HTML = "<!doctype html><title>no raster here</title><p>an html body</p>";
const SECRET = "<!doctype html><title>secret</title><p>top secret</p>";

/** What the export ids do: `plain` serves the CSV, the `hop-*` ids 302 to the hop the rows need. */
function exportHop(id) {
    if (id === "hop-accounts") return "https://accounts.google.com/ServiceLogin?continue=%2Fspreadsheets";
    if (id === "hop-cdn") return "https://u0.googleusercontent.com/uc?id=hop-cdn&export=download";
    return null;
}

/** Answer one request on `via`. Everything is logged first: which listener answered, for which host, and what
 *  was asked (headers included — the step-5 rows read `sec-fetch-*` off the log to tell a worker fetch from a
 *  tab's navigation). */
function handle(via, log, req, res, hops) {
    const host = String(req.headers.host || "").split(":")[0].toLowerCase();
    const url = new URL(req.url || "/", `http://${host}`);
    log.push({ via, host, path: `${url.pathname}${url.search}`, t: Date.now(), headers: req.headers });
    const to = url.searchParams.get("to");
    if (url.pathname === "/r" && to) {
        res.writeHead(302, { location: to, "content-type": "text/plain" });
        res.end(`moved to ${to}`);
        return;
    }
    // A hop registered server-side (`site.hopTo`): the Location is the only place the target is written, so nothing
    // the page could have written, and nothing it reads back, carries it.
    const table = /^\/r\/(\d+)$/.exec(url.pathname);
    if (table) {
        const target = hops.get(Number(table[1]));
        if (target) {
            res.writeHead(302, { location: target, "content-type": "text/plain" });
            res.end("moved");
            return;
        }
    }
    if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><title>${host}</title><p>a page on ${host}</p>`);
        return;
    }
    if (url.pathname === "/ok") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`ok from ${host}`);
        return;
    }
    if (url.pathname === "/body") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`body from ${host}`);
        return;
    }
    if (url.pathname === "/secret") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(SECRET);
        return;
    }
    if (url.pathname === "/pixel.png") {
        res.writeHead(200, { "content-type": "image/png", "content-length": String(PNG_1X1.length) });
        res.end(PNG_1X1);
        return;
    }
    if (url.pathname === "/page") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(HTML);
        return;
    }
    if (url.pathname === "/uc") {
        res.writeHead(200, { "content-type": "text/csv" });
        res.end(CSV);
        return;
    }
    const sheet = /^\/spreadsheets\/d\/([A-Za-z0-9_-]+)\/export$/.exec(url.pathname);
    if (sheet) {
        const hop = exportHop(sheet[1]);
        if (hop) {
            res.writeHead(302, { location: hop, "content-type": "text/plain" });
            res.end(`moved to ${hop}`);
            return;
        }
        res.writeHead(200, { "content-type": "text/csv" });
        res.end(CSV);
        return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end(`no route ${url.pathname} on ${host}`);
}

/**
 * Start the redirect site. Mirrors detect/server.mjs's `startProbeSite` shape, plus the TLS and loopback URLs.
 * @returns {Promise<{
 *   port: number, tlsPort: number, loopbackPort: number,
 *   url: (host: string, path?: string) => string, origin: (host: string) => string,
 *   tlsUrl: (host: string, path?: string) => string, tlsOrigin: (host: string) => string,
 *   loopbackUrl: (path?: string) => string,
 *   hopTo: (target: string) => string,
 *   requests: () => Array<{via: string, host: string, path: string, t: number, headers: Record<string, string>}>,
 *   requestsTo: (host: string) => Array<{via: string, host: string, path: string, t: number, headers: Record<string, string>}>,
 *   clear: () => void, stop: () => Promise<void>,
 * }>}
 */
export function startRedirectSite() {
    /** @type {Array<{via: string, host: string, path: string, t: number, headers: Record<string, string>}>} */
    const log = [];
    /** Hop targets by number, for `/r/<n>`: see the header's route list. Never cleared with the log. */
    const hops = new Map();
    let nextHop = 1;
    const http = createHttpServer((req, res) => handle("http", log, req, res, hops));
    const tls = createHttpsServer({ key: TLS_KEY, cert: TLS_CERT }, (req, res) => handle("tls", log, req, res, hops));
    const loopback = createHttpServer((req, res) => handle("loopback", log, req, res, hops));
    return new Promise((resolve) => {
        http.listen(0, "127.0.0.1", () => {
            tls.listen(0, "127.0.0.1", () => {
                loopback.listen(0, "127.0.0.1", () => {
                    const port = /** @type {import("node:net").AddressInfo} */ (http.address()).port;
                    const tlsPort = /** @type {import("node:net").AddressInfo} */ (tls.address()).port;
                    const loopbackPort = /** @type {import("node:net").AddressInfo} */ (loopback.address()).port;
                    resolve({
                        port,
                        tlsPort,
                        loopbackPort,
                        url: (host, path = "/") => `http://${host}:${port}${path}`,
                        origin: (host) => `http://${host}:${port}`,
                        tlsUrl: (host, path = "/") => `https://${host}:${tlsPort}${path}`,
                        tlsOrigin: (host) => `https://${host}:${tlsPort}`,
                        loopbackUrl: (path = "/") => `http://localhost:${loopbackPort}${path}`,
                        /** Register `target` as a hop and return the PATH that 302s to it: a first URL that does not
                         *  spell the target. Each call is a new number, so rows never share a registration. */
                        hopTo: (target) => { const n = nextHop++; hops.set(n, target); return `/r/${n}`; },
                        requests: () => [...log],
                        requestsTo: (host) => log.filter((r) => r.host === host),
                        clear: () => { log.length = 0; },
                        stop: () => new Promise((done) => {
                            let left = 3;
                            const tick = () => { if (--left === 0) done(undefined); };
                            http.close(tick); tls.close(tick); loopback.close(tick);
                        }),
                    });
                });
            });
        });
    });
}

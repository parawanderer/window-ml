// server.mjs — a mock website whose only job is attacking window.ml's site-access surface
// (docs/spec/SITE_ACCESS.md, tests/e2e/site-access.spec.mjs).
//
// One local server answers for several hostnames, told apart by the Host header. The browser reaches them all at
// 127.0.0.1 through Chromium's `--host-resolver-rules` (see `HOSTILE_RESOLVER_ARGS`), so each hostname is a real,
// distinct ORIGIN as far as the browser and the extension can tell: `evil.test`, any `sNN.evil.test`, `evil2.test`,
// `approved.test` (the page a test approves, which starts runs) and `frame.test` (cross-origin iframes).
//
// Every page loads `evil.js`, the attack toolkit, so a page on any of these hosts can be turned hostile by its query
// string. The approved page is a plain page with a link a run can follow.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Chromium switches that resolve every hostname this server answers for to it. Pass to `launchExtension({ args })`. */
export const HOSTILE_RESOLVER_ARGS = ["--host-resolver-rules=MAP *.test 127.0.0.1, MAP evil.test 127.0.0.1"];

const EVIL_JS = fileURLToPath(new URL("./evil.js", import.meta.url));

/** @param {string} title @param {string} body */
const html = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<script src="/evil.js"></script>
</head><body>
<h1>${title}</h1>
${body}
</body></html>`;

/**
 * Start the hostile site on an ephemeral port.
 * @returns {Promise<{ port: number, url: (host: string, path?: string) => string, origin: (host: string) => string, stop: () => Promise<void> }>}
 */
export async function startHostileSite() {
    const server = createServer((req, res) => {
        const host = String(req.headers.host || "").split(":")[0].toLowerCase();
        const path = (req.url || "/").split("?")[0];
        if (path === "/evil.js") {
            res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
            res.end(readFileSync(EVIL_JS, "utf8"));
            return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        if (path === "/frame") {
            // A page that embeds `src` (another origin, or a sandboxed copy) so a frame's requests can be attacked.
            const q = new URL(req.url || "/", "http://x").searchParams;
            const sandbox = q.get("sandbox") === "1" ? ' sandbox="allow-scripts"' : "";
            res.end(html(`frame host ${host}`, `<iframe id="f" src="${q.get("src") || ""}"${sandbox}></iframe>`));
            return;
        }
        res.end(html(`${host} page`, `<p id="secret">The code on ${host} is 4417.</p>
<p><a id="next" href="${new URL(req.url || "/", "http://x").searchParams.get("next") || "#"}">Next</a></p>`));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
    const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
    return {
        port,
        url: (host, path = "/") => `http://${host}:${port}${path}`,
        origin: (host) => `http://${host}:${port}`,
        stop: () => new Promise((r) => server.close(() => r(undefined))),
    };
}

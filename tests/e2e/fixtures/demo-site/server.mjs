// server.mjs — the policies demo site (origin B): a few pages that try the edges of a rule, and a server-side log the test reads.

// The worked example of docs/spec/POLICIES.md ("The demo site"): `/` links into `/user/`; `/user/x` has a button whose script
// sets `location` to `/admin/` and an anchor to it; `/user/approvals` has three buttons that each post their click to the log
// (`?redirect=1` makes "Approve This Draft" also move the tab to `/admin/`); `/admin/` posts its arrival; `/other` has a text
// input. The log is what HAPPENED on the server, so a test asserts the effect and not only the refusal.

import { createServer } from "node:http";

const shell = (title, body, script = "") => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}<script>${script}</script></body></html>`;
const post = (what) => `fetch("/__log", { method: "POST", body: ${JSON.stringify(what)} })`;

/** @type {Record<string, (url: URL) => string>} */
const PAGES = {
    "/": () => shell("Demo site", `<h1>Demo site</h1><a id="user" href="/user/x">User area</a> <a id="approvals" href="/user/approvals">Approvals</a>`),
    "/user/x": () => shell("User x", `<h1>User x</h1><button id="open-admin" onclick="location = '/admin/'">Open admin</button> <a id="admin-link" href="/admin/">Admin link</a>`),
    "/user/approvals": (url) => {
        const redirect = url.searchParams.get("redirect") === "1";
        const go = (what, then = "") => `${post(what)}.then(() => { ${then} })`;
        return shell("Approvals", `<h1>Approvals</h1>
            <button id="approve" onclick='${go("approve", redirect ? "location = \"/admin/\"" : "")}'>Approve This Draft</button>
            <button id="delete" onclick='${go("delete")}'>Delete</button>
            <button id="publish" onclick='${go("publish")}'>Publish</button>`);
    },
    "/admin/": () => shell("Admin", `<h1>ADMIN</h1><p>Secret admin page.</p>`, post("arrival")),
    "/other": () => shell("Other", `<h1>Other</h1><input id="q" aria-label="Search" type="text">`),
};

/**
 * Serve the demo site on an ephemeral port.
 * @returns {Promise<{ url: string, log: () => string[], requests: () => string[], reset: () => void, stop: () => Promise<void> }>}
 *   `log` is what the pages posted (approve, delete, publish, arrival); `requests` is every path asked of the server.
 */
export async function startDemoSite() {
    /** @type {string[]} */ let log = [];
    /** @type {string[]} */ let requests = [];
    const srv = createServer((req, res) => {
        const url = new URL(req.url || "/", "http://x");
        if (url.pathname === "/__log") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => { if (req.method === "POST") log.push(body); res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(log)); });
            return;
        }
        requests.push(url.pathname + url.search);
        const page = PAGES[url.pathname];
        if (!page) { res.writeHead(404, { "content-type": "text/plain" }); res.end("not found"); return; }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(page(url));
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    // `localhost` and `127.0.0.1` are different origins, so the page server of origin A (also on 127.0.0.1) is told apart by port.
    return {
        url: `http://127.0.0.1:${srv.address().port}`,
        log: () => [...log], requests: () => [...requests], reset: () => { log = []; requests = []; },
        stop: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r(undefined)); }),
    };
}

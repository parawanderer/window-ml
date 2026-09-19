// A static file server on port 0, for pages that are not the extension: the chat page's web build (dist-web/). Shared
// by its spec and its screenshot tool so they serve the same thing the same way.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".png": "image/png", ".svg": "image/svg+xml" };

/** Serve `root` on 127.0.0.1. Resolves to its base URL (with a trailing slash) and a `close`. */
export async function serveStatic(root, { port = 0, host = "127.0.0.1" } = {}) {
    const base = path.resolve(root);
    const srv = http.createServer((req, res) => {
        let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
        if (p.endsWith("/")) p += "index.html";
        const f = path.join(base, p);
        // A PAGE ADDRESS as a path (`/settings/devices`): the chat page routes in the hash (src/chat/route.ts), since
        // the extension and the phone app cannot serve paths, so a path that is not a file goes to its hash.
        if (!path.extname(p) && !(fs.existsSync(f) && fs.statSync(f).isFile())) { res.writeHead(302, { location: `/#${p}` }); res.end(); return; }
        if (!f.startsWith(base + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream", "cache-control": "no-store" });
        fs.createReadStream(f).pipe(res);
    });
    await new Promise((r) => srv.listen(port, host, r));
    return { url: `http://${host}:${srv.address().port}/`, close: () => new Promise((r) => srv.close(r)) };
}

// serve.mjs — a tiny, dependency-free server for testing CROSS-PAGE agent persistence.
//
// A background-hosted ml.agent run should survive a FULL page navigation (a real <a> link or a form
// submit that replaces the document), not just SPA route changes. That needs two real HTTP pages the
// agent walks between. This serves a 3-step same-origin chain on :8080 (Variant A — the main case) plus
// one CROSS-domain page on :8081 (Variant B — different port ⇒ different origin under the SOP).
//
//   node examples/cross-page/serve.mjs
//   → open  http://localhost:8080   in a tab where window.ml is active  (NOT a file:// path)
//
// Then, from the page's devtools console (needs your local backend + a tool-capable model):
//
//   await ml.agent("Go to step 2, then step 3, and tell me the code shown on step 3.")
//
// Success = the run survives TWO full reloads, reads step 3, and answers — with the HUD card following
// across the navigations. For Variant B, step 3 links to the :8081 origin (a cross-domain hop).
//
// Ports are overridable (PORT / CROSS_PORT).

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

// One editable template for every page: a heading, an origin/path badge, some body copy, and (usually) a
// big obvious link to the next step. `next` is the href+label of the forward link (null on a leaf).
const page = ({ title, badge, body, next, accent = "#4f46e5" }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
  :root{--bg:#fbfbfd;--fg:#111;--dim:#555;--card:#fff;--line:#e3e3e8;--accent:${accent}}
  @media(prefers-color-scheme:dark){:root{--bg:#17171b;--fg:#eaeaee;--dim:#b3b3bd;--card:#1e1e24;--line:#2e2e36}}
  *{box-sizing:border-box}
  body{margin:0;font:16px/1.55 system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--fg);
    min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px}
  main{max-width:560px;width:100%;background:var(--card);border:1px solid var(--line);border-radius:16px;
    padding:30px 34px 34px}
  .badge{display:inline-block;font:600 11px ui-monospace,monospace;letter-spacing:.04em;text-transform:uppercase;
    color:var(--accent);border:1px solid var(--accent);border-radius:999px;padding:3px 10px;margin-bottom:14px}
  h1{font-size:26px;margin:0 0 10px;letter-spacing:-.01em}
  p{color:var(--dim);margin:0 0 14px}
  .code{font:700 20px ui-monospace,monospace;color:var(--fg);background:var(--bg);border:1px dashed var(--accent);
    border-radius:10px;padding:14px 18px;text-align:center;margin:18px 0}
  a.next{display:inline-flex;align-items:center;gap:8px;margin-top:10px;font-weight:650;text-decoration:none;
    background:var(--accent);color:#fff;padding:11px 18px;border-radius:10px}
  a.next:hover{filter:brightness(1.08)}
  .o{margin-top:22px;font:11px ui-monospace,monospace;color:var(--dim);opacity:.7}
  a.x{color:var(--accent)}
</style></head><body><main>
  <span class="badge">${badge}</span>
  <h1>${title}</h1>
  ${body}
  ${next ? `<a class="next" href="${next.href}">${next.label} →</a>` : ""}
  <div class="o" id="o"></div>
</main><script>document.getElementById("o").textContent = location.href;</script></body></html>`;

const send = (res, body, code = 200) => {
    res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
};

// A page that BLOCKS the extension's injected main-world script — served with the SAME Content-Security-Policy
// raw.githubusercontent.com uses (`default-src 'none'; sandbox`). window.ml can't come up here, so a delegated
// agent tool has no answerer: the extension must fail it FAST, not wedge the run. Text lives in a <pre> like a
// raw file. (default-src 'none' also blocks the page's own styles/scripts — fine, it's just readable text.)
const BLOCKED_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sandboxed file</title></head>
<body><pre>SANDBOXED-FILE-CONTENT-9999
Served with a "sandbox" CSP (like raw.githubusercontent.com). The extension's injected main-world
script is blocked here, so window.ml never initialises on this page.</pre></body></html>`;
const sendBlocked = (res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; sandbox", "cache-control": "no-store" });
    res.end(BLOCKED_PAGE);
};

// Raw content endpoints for the ml.fetch e2e — the agent READS these via fetch_url (not the DOM). Note
// /code.ts is served as text/plain (a raw-git mislabel) so classification must fall back to the extension.
const RAW = {
    "/data.json": { ct: "application/json", body: JSON.stringify({ id: 7, name: "widget", tags: ["a", "b"] }) },
    "/data.csv": { ct: "text/csv", body: "name,qty,price\napples,3,1.20\npears,5,0.90\n" },
    "/code.ts": { ct: "text/plain; charset=utf-8", body: "export const answer: number = 42;\nexport function id<T>(x: T): T { return x; }\n" },
};
const sendRaw = (res, r) => { res.writeHead(200, { "content-type": r.ct, "cache-control": "no-store" }); res.end(r.body); };

// --- Same-origin 3-step chain — the Variant A case ----------------------------------------------------
const routes = (crossOrigin) => ({
    "/": page({
        badge: "Step 1 of 3", title: "Cross-page persistence demo",
        body: `<p>This is a plain multi-page site — every link below is a <strong>real full-page
            navigation</strong> (a new document, not an SPA route). An agent that persists across pages should
            walk this chain without losing its run.</p>
            <p>Ask it: <em>“Go to step 2, then step 3, and tell me the code shown on step 3.”</em></p>`,
        next: { href: "/step2", label: "Go to step 2" },
    }),
    "/step2": page({
        badge: "Step 2 of 3", title: "Halfway there", accent: "#0891b2",
        body: `<p>You navigated here from step 1 — a full reload replaced the document. The run should still be
            alive and know it needs to continue to step 3.</p>
            <p>Nothing to read here yet. Keep going.</p>`,
        next: { href: "/step3", label: "Go to step 3" },
    }),
    "/step3": page({
        badge: "Step 3 of 3", title: "The code", accent: "#16a34a",
        body: `<p>You made it across two navigations. Here is the code the task asked for:</p>
            <div class="code">CROSSPAGE-9471</div>
            <p>For the cross-<em>domain</em> test (Variant B), continue to a <strong>different origin</strong>
            (<code>${crossOrigin}</code>) below.</p>`,
        next: { href: `${crossOrigin}/`, label: "Continue to the other domain" },
    }),
});

const CROSS_PAGE = (crossOrigin) => page({
    badge: "Different origin", title: "Another domain", accent: "#db2777",
    body: `<p>This page is served from <code>${crossOrigin}</code> — a <strong>different origin</strong> than
        the chain (different port ⇒ different origin under the Same-Origin Policy). A run that follows a link
        here has crossed a domain boundary, which is the Variant-B consent case.</p>
        <div class="code">XDOMAIN-2025</div>`,
    next: null,
});

/**
 * Start the test site: the same-origin chain on `port`, plus one cross-domain page on `crossPort`.
 * Pass 0 for ephemeral ports (the harness does; the CLI uses 8080/8081). Returns { url, crossOrigin, stop }.
 */
export function startPageServer({ port = 0, crossPort = 0, host = "127.0.0.1" } = {}) {
    return new Promise((resolve) => {
        const cross = createServer((_req, res) => send(res, CROSS_PAGE(`http://${host}:${crossPortActual}`)));
        let crossPortActual;
        cross.listen(crossPort, host, () => {
            crossPortActual = cross.address().port;
            const crossOrigin = `http://${host}:${crossPortActual}`;
            const outer = createServer((req, res) => {
                const p = (req.url || "/").split("?")[0];
                if (p === "/blocked") return sendBlocked(res);   // a CSP-sandboxed page (blocks injected.js)
                if (p === "/spa") {   // CLIENT-RENDERED: raw HTML is an empty shell; JS fills the content AND pops a
                    // cookie-consent overlay after load — the rendered fetch must return the content, minus the overlay.
                    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
                    return res.end(`<!doctype html><meta charset=utf-8><title>SPA</title><div id=app>Loading…</div>`
                        + `<script>setTimeout(()=>{`
                        + `document.getElementById('app').textContent='SPA-RENDERED-9931 the client script ran';`
                        + `var c=document.createElement('div');c.id='cookie-consent-banner';`
                        + `c.style.cssText='position:fixed;left:0;right:0;bottom:0;z-index:9999';`
                        + `c.textContent='COOKIE-OVERLAY-SLOP-7777 We value your privacy. Accept all cookies?';`
                        + `document.body.appendChild(c);},50)</script>`);
                }
                if (p === "/vis") {   // VISIBILITY-GATED (like GitHub's deferred <include-fragment>): the page reports
                    // what it sees (visibilityState / hasFocus) and only reveals its "lazy" content when it believes it's
                    // VISIBLE — so a background render captures the hidden state + misses the content unless we emulate focus.
                    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
                    return res.end(`<!doctype html><meta charset=utf-8><title>vis</title><body><div id=state>init</div><div id=lazy></div>`
                        + `<script>`
                        + `function tryLoad(){`
                        + `document.getElementById('state').textContent='VIS:'+document.visibilityState+' FOCUS:'+document.hasFocus()+' HIDDEN:'+document.hidden;`
                        + `if(document.visibilityState==='visible'&&!document.getElementById('lazy').textContent){document.getElementById('lazy').textContent='LAZY-VISIBLE-8842 the deferred widget loaded';}`
                        + `}`
                        + `tryLoad();document.addEventListener('visibilitychange',tryLoad);setInterval(tryLoad,100);`
                        + `</script>`);
                }
                if (p === "/slow") {   // content STREAMS in over ~2.4s (a real SPA hydrating) — a fixed 1.2s settle would
                    // truncate it mid-stream; the DOM-quiet wait keeps going until the stream stops, then snapshots.
                    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
                    return res.end(`<!doctype html><meta charset=utf-8><title>slow</title><body><div id=app>EARLY-CONTENT</div>`
                        + `<script>var n=0,iv=setInterval(function(){n++;var d=document.createElement('div');d.textContent='CHUNK-'+n;document.body.appendChild(d);`
                        // Dense 150ms ticks (well under the 700ms quiet threshold, even load-stretched) for ~1.8s — past
                        // the old fixed 1.2s window, so a fixed settle truncates it while the DOM-quiet wait captures it.
                        + `if(n>=12){clearInterval(iv);var f=document.createElement('div');f.id='done';f.textContent='STREAM-DONE-3377 all chunks loaded';document.body.appendChild(f);}},150)</script>`);
                }
                if (p === "/lazy") {   // a widget that only loads when SCROLLED into view (IntersectionObserver, like GitHub's lazy fragments).
                    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
                    return res.end(`<!doctype html><meta charset=utf-8><title>lazy</title><body><div style="height:4000px">spacer above the fold</div><div id=target>placeholder</div>`
                        + `<script>var t=document.getElementById('target');var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){t.textContent='LAZY-SCROLL-5591 loaded on scroll-into-view';io.disconnect();}})});io.observe(t);</script>`);
                }
                if (p === "/hidden") {   // CSS-CLASS hidden content (display:none via a stylesheet rule) — only the
                    // rendered path's layout-aware checkVisibility() catches it (the raw static strip sees inline/attr only).
                    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
                    return res.end(`<!doctype html><meta charset=utf-8><title>hidden</title><style>.gone{display:none}</style>`
                        + `<body><main><p>VISIBLE-CONTENT-1</p><div class="gone"><h3>CSS-HIDDEN-JUNK-4242</h3><p>should not reach the markdown</p></div></main>`);
                }
                if (p === "/table") {   // a DATA TABLE (reps × quarters) — for python_exec `{ tables }` → DataFrame probes.
                    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
                    const rows = [["Ada", "North", 120, 150, 130, 160], ["Ben", "South", 90, 110, 95, 105], ["Cara", "East", 200, 180, 210, 190],
                        ["Dan", "West", 75, 80, 85, 90], ["Eve", "North", 140, 160, 155, 165], ["Finn", "South", 100, 120, 110, 130],
                        ["Gia", "East", 210, 220, 205, 215], ["Hal", "West", 60, 70, 65, 75]];
                    return res.end(`<!doctype html><meta charset=utf-8><title>sales</title><body><h1>Quarterly sales</h1>`
                        + `<table id="sales"><thead><tr><th>Rep</th><th>Region</th><th>Q1</th><th>Q2</th><th>Q3</th><th>Q4</th></tr></thead><tbody>`
                        + rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join("")}</tr>`).join("") + `</tbody></table>`);
                }
                if (RAW[p]) return sendRaw(res, RAW[p]);          // raw JSON/CSV/code endpoints (ml.fetch e2e)
                const r = routes(crossOrigin);
                if (r[p]) return send(res, r[p]);
                send(res, page({ badge: "404", title: "No such page", body: `<p>Try <a class="x" href="/">the start</a>.</p>`, next: null }), 404);
            });
            outer.listen(port, host, () => {
                resolve({
                    url: `http://${host}:${outer.address().port}`,
                    crossOrigin,
                    stop: () => Promise.all([new Promise((r) => outer.close(r)), new Promise((r) => cross.close(r))]),
                });
            });
        });
    });
}

// CLI: `node examples/cross-page/serve.mjs` → fixed 8080/8081 so the URLs are stable to open by hand.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const s = await startPageServer({ port: Number(process.env.PORT) || 8080, crossPort: Number(process.env.CROSS_PORT) || 8081, host: "localhost" });
    console.log(`\n  window.ml — cross-page persistence test`);
    console.log(`  START HERE  →  ${s.url}   ← open this (window.ml active)`);
    console.log(`  chain: /  →  /step2  →  /step3  (all same origin, full reloads)`);
    console.log(`  cross-domain    →  ${s.crossOrigin}/   (Variant B — a different origin)`);
    console.log(`\n  Ctrl+C to stop.\n`);
}

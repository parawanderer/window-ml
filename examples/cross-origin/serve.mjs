// serve.mjs — a tiny, dependency-free server for the iframe test cases (same-origin + cross-origin).
//
// A genuinely CROSS-origin iframe needs two real HTTP origins; `file://` won't do. Different PORTS on
// localhost ARE different origins under the Same-Origin Policy, so this serves the challenge page + the
// SAME-origin frame on port 8080, and the CROSS-origin frame on port 8081 — no second machine/domain needed.
//
//   node examples/cross-origin/serve.mjs
//   → open  http://localhost:8080   in a tab where window.ml is active  (NOT a file:// path)
//
// Ports are overridable (OUTER_PORT / INNER_PORT). The page's cross-origin iframe src is injected at serve
// time (the __CROSS_ORIGIN__ placeholder) so it always matches INNER_PORT.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const OUTER_PORT = Number(process.env.OUTER_PORT) || 8080;
const INNER_PORT = Number(process.env.INNER_PORT) || 8081;
const CROSS_ORIGIN = `http://localhost:${INNER_PORT}`;

// The tiny frame contents are inline (each is just a reveal button + a click-gated secret with its own JS
// handler) so the demo stays ONE editable HTML page. Identical apart from the label + secret.
const frame = (label, secret) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
  body{margin:0;font:14px system-ui,sans-serif;color:#111;background:#fbfbfd;display:flex;align-items:center;gap:10px;padding:14px 16px}
  .lbl{color:#555} button{font:600 13px system-ui;padding:7px 13px;border:1px solid #c9c9d2;border-radius:7px;background:#fff;cursor:pointer}
  button:hover{background:#f2f2f6} code{display:none;font:12px ui-monospace,monospace;background:#f0f0f2;padding:2px 7px;border-radius:4px}
  code.show{display:inline} .o{margin-left:auto;font:11px ui-monospace,monospace;color:#aaa}
  @media(prefers-color-scheme:dark){body{background:#191b1f;color:#eee}.lbl{color:#aaa}button{background:#26262c;border-color:#3a3a44;color:#eee}button:hover{background:#2f2f37}code{background:#2a2a30}.o{color:#666}}
</style></head><body>
  <span class="lbl">${label}:</span>
  <button id="b">Reveal secret</button>
  <code id="c">${secret}</code>
  <span class="o" id="o"></span>
  <script>
    document.getElementById("o").textContent = location.origin;
    document.getElementById("b").addEventListener("click", () => {
      document.getElementById("c").classList.add("show");
      document.getElementById("b").style.display = "none";
    });
  </script>
</body></html>`;

const SAME_FRAME = frame("Same-origin secret", "SAME-1234");
const CROSS_FRAME = frame("Cross-origin secret", "XORG-4242");

const sendHtml = (res, body) => {
    // No X-Frame-Options / frame-ancestors → the page may embed the frames (incl. cross-origin).
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
};

// Outer origin (8080): the challenge page + the SAME-origin frame (same port ⇒ same origin).
createServer(async (req, res) => {
    try {
        if ((req.url || "").startsWith("/same")) return sendHtml(res, SAME_FRAME);
        const page = (await readFile(join(dir, "iframes.html"), "utf8")).replaceAll("__CROSS_ORIGIN__", CROSS_ORIGIN);
        sendHtml(res, page);
    } catch (e) { res.writeHead(500, { "content-type": "text/plain" }); res.end(`Failed: ${e?.message || e}`); }
}).listen(OUTER_PORT, () => {
    console.log(`\n  window.ml — iframe test cases`);
    console.log(`  challenge page      →  http://localhost:${OUTER_PORT}   ← open THIS (window.ml active)`);
});

// Cross origin (8081): the CROSS-origin frame (different port ⇒ different origin).
createServer((_req, res) => sendHtml(res, CROSS_FRAME)).listen(INNER_PORT, () => {
    console.log(`  cross-origin frame  →  ${CROSS_ORIGIN}   (a different origin)`);
    console.log(`\n  Ctrl+C to stop.\n`);
});

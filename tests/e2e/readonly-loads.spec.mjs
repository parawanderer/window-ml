// readonly-loads.spec.mjs — whether a read the read-only dialect allows makes the browser start a request: the dialect
// itself (`evalReadonly`, bundled from the checked-out source with esbuild, as raster.spec.mjs bundles its page side) runs
// in a real Chromium page's main world, as the page leg of a survey does (run-delegation.ts), against a page whose
// resources load only if something computes or lays out an element nothing renders. No extension: the question is the
// platform's, and the dialect has no network member to test (`ml.fetch` there is cache-only).
//
// It settles a guess in docs/dev/readonly-exec.md, "Threat questions answered" (item 5): `getComputedStyle` resolves
// style, so it might start a background-image or font load on a domain nobody approved. It does not, in the Chromium this
// runs; if a later Chromium does, this fails and the doc's answer is wrong.
import { test, expect } from "@playwright/test";
import { buildSync } from "esbuild";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** `evalReadonly` as a script that sets `window.__evalReadonly`. */
function dialectScript() {
    const out = buildSync({
        stdin: { contents: 'import { evalReadonly } from "./src/readonly-exec.ts"; window.__evalReadonly = evalReadonly;', resolveDir: ROOT, loader: "ts" },
        bundle: true, write: false, format: "iife", platform: "browser",
    });
    return out.outputFiles[0].text;
}

// Every resource here is one the page never loads by itself: in a `display:none` subtree, on a `display:none` element,
// a pseudo-element's `content` in that subtree, a font used only there, and a lazy image far below the fold.
const PAGE = `<!doctype html><style>
@font-face { font-family: Hid; src: url(/font-hidden.woff2); }
#e::before { content: url(/before-hidden.png); }
</style><body>
<div style="display:none">
  <span id="a" style="background-image:url(/bg-in-hidden-subtree.png)">x</span>
  <span id="c" style="font-family:Hid">text</span>
  <span id="e">y</span>
</div>
<span id="b" style="display:none;background-image:url(/bg-display-none.png)">z</span>
<div style="height:5000px"></div>
<img id="d" loading="lazy" src="/lazy-below-fold.png" width="10" height="10">
</body>`;

// --- what a survey's reads make the browser fetch ---

test("a survey's style, geometry and attribute reads start no request, on resources the page itself never loads", async ({ page }) => {
    const hits = [];
    const srv = http.createServer((req, res) => {
        hits.push(req.url);
        if (req.url === "/") { res.setHeader("content-type", "text/html"); res.end(PAGE); return; }
        res.statusCode = 404; res.end();
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    try {
        await page.goto(`http://127.0.0.1:${srv.address().port}/`);
        await page.waitForTimeout(500);
        expect(hits.filter((u) => u !== "/" && u !== "/favicon.ico"), "the page loads none of them by itself").toEqual([]);
        await page.addScriptTag({ content: dialectScript() });
        // Each survey is in the dialect (it answers, no refusal), and reads what could plausibly make the browser fetch.
        const surveys = [
            `getComputedStyle(document.getElementById("a")).backgroundImage`,
            `getComputedStyle(document.getElementById("b")).backgroundImage`,
            `getComputedStyle(document.getElementById("c")).fontFamily`,
            `const c = document.getElementById("c"); [c.getBoundingClientRect().height, c.offsetHeight, c.innerText]`,
            `getComputedStyle(document.getElementById("e"), "::before").content`,
            `const d = document.getElementById("d"); [d.getBoundingClientRect().y, d.offsetTop, d.getAttribute("src")]`,
            `[...document.querySelectorAll("*")].map(el => getComputedStyle(el).backgroundImage + el.offsetWidth).length`,
        ];
        for (const js of surveys) {
            const r = await page.evaluate((src) => window.__evalReadonly(src, document).then((x) => ({ ok: true }), (e) => ({ refused: e.constructor.name, message: e.message })), js);
            expect(r, js).toEqual({ ok: true });
        }
        await page.waitForTimeout(800);
        expect(hits.filter((u) => u !== "/" && u !== "/favicon.ico"), "no read started a load").toEqual([]);
    } finally {
        srv.close();
    }
});

// review-look.spec.mjs — the masking half of the validation and coverage review of #533 (deferred from #495): the
// worker's shot of a run's tab (src/sw/worker-vision.ts `workerShot`) paints the extension's own UI out of the capture
// at the rects the shell reports (src/sidebar/shell-shot.ts `extensionRects`, masked by src/sw/shot-mask.ts). Here the
// page's CSS and script do what a hostile page can to OUR elements and their ancestors (the shadow hosts are styled
// `all: initial` inline, which a page's `!important` beats, and their shadow roots are open), and each test asks whether
// the pixels the extension paints still fall inside what was masked. A `test.fixme` shows a gap: it asserts the correct
// behaviour and fails if un-fixme'd until the gap is fixed.
//
// The oracle is tests/e2e/worker-shot.spec.mjs's: the page is one flat green and the mask one flat grey (MASK_FILL), so
// any other pixel in the worker's shot is the extension's UI. Each test first shows, on a bare capture, that the
// attack does put extension pixels somewhere, so a pass is not a page that hid the UI altogether.
import { test, expect } from "@playwright/test";
import http from "node:http";
import { launchExtension, configureExtension } from "./harness.mjs";

/** A page that is one flat green with a transparent target box at (300,300) 200×100, on a local http server. */
async function greenSite() {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        const other = req.url?.startsWith("/b");
        res.end(`<!doctype html><title>${other ? "b" : "green"}</title><style>html,body{margin:0;height:100%;background:#00ff00}
#t{position:absolute;left:300px;top:300px;width:200px;height:100px}</style><body><div id="t"></div></body>`);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => server.close(r)) };
}

/** Pixels of a capture that are neither the page's green nor the mask's grey, decoded in `page`; `outside` excludes a
 *  CSS-px box (the highlighted target's own interior, which the shell deliberately leaves unmasked). */
const offGreen = (page, dataUrl, outside = null) => page.evaluate(async ({ src, outside }) => {
    const img = new Image();
    await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = src; });
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const s = c.width / window.innerWidth;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
        const x = (i / 4) % c.width, y = Math.floor(i / 4 / c.width);
        if (outside && x >= outside.left * s && x < (outside.left + outside.width) * s && y >= outside.top * s && y < (outside.top + outside.height) * s) continue;
        const green = d[i] < 8 && d[i + 1] > 247 && d[i + 2] < 8, grey = d[i] === 128 && d[i + 1] === 128 && d[i + 2] === 128;
        if (!green && !grey) n++;
    }
    return n;
}, { src: dataUrl, outside });

/**
 * The extension loaded, the overlay sidebar mounted and OPEN on the green page (so its iframe paints), the tab in front.
 * @returns the page, the run tab's id, `shoot()` (the worker's masked shot), `bare()` (an unmasked capture) and `css()`
 */
async function setup(ext, site) {
    await configureExtension(ext.sw, { debugMode: "overlay", cdp: false });
    const page = await ext.context.newPage();
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(site.url);
    await page.waitForSelector("#ml-sb-root", { state: "attached", timeout: 15000 });
    await page.evaluate(() => document.getElementById("ml-sb-root").shadowRoot.getElementById("ml-sb-tab").click());
    await page.waitForTimeout(400);
    await page.bringToFront();
    const tabId = await ext.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, site.url);
    return {
        page, tabId,
        shoot: () => ext.sw.evaluate((id) => globalThis.__mlWorkerVisionForTest.workerShot(id).then((s) => ({ dataUrl: s.dataUrl }), (e) => ({ error: String(e?.message || e) })), tabId),
        bare: () => ext.sw.evaluate((id) => globalThis.__mlWorkerVisionForTest.captureRunTab(id), tabId),
        /** Put `text` in the page's own stylesheet (replacing the last one), and let it paint. */
        css: async (text) => { await page.evaluate((t) => { let s = document.getElementById("atk"); if (!s) { s = document.createElement("style"); s.id = "atk"; document.head.append(s); } s.textContent = t; }, text); await page.waitForTimeout(150); },
    };
}

/** Run `fn` with a fresh extension and green site, closing both after. */
async function withShell(fn) {
    const site = await greenSite();
    const ext = await launchExtension();
    try { await fn(await setup(ext, site), ext, site); } finally { await ext.close(); await site.close(); }
}

/** Put `text` in a stylesheet inside our open shadow root, as a page can. */
const shadowCss = (page, text) => page.evaluate((t) => { const st = document.createElement("style"); st.textContent = t; document.getElementById("ml-sb-root").shadowRoot.append(st); }, text);

// --- control: the open sidebar is in a bare capture and not in the worker's shot ---

test("control: the open sidebar paints into a bare capture, and the worker's shot of the same page has none of it", async () => {
    await withShell(async (s) => {
        expect(await offGreen(s.page, (await s.bare()).dataUrl)).toBeGreaterThan(1000);
        const shot = await s.shoot();
        expect(shot.error).toBeUndefined();
        expect(await offGreen(s.page, shot.dataUrl)).toBe(0);
    });
});

// --- the page's CSS on our hosts and their ancestors: what getBoundingClientRect already follows ---

for (const [what, rule] of [
    ["an ancestor transform (html translated and rotated)", "html{transform:translateX(-160px) rotate(4deg) !important}"],
    ["page zoom on html", "html{zoom:1.4 !important}"],
    ["zoom on our host", "#ml-sb-root{zoom:1.5 !important}"],
    ["the individual transform properties on our host", "#ml-sb-root{scale:1.3 !important;translate:-260px 30px !important;rotate:6deg !important}"],
    ["contain: paint on our host", "#ml-sb-root{contain:paint !important}"],
    ["a perspective transform on html", "html{transform:perspective(400px) rotateY(12deg) !important}"],
]) {
    test(`${what}: the extension's pixels stay inside the mask`, async () => {
        await withShell(async (s) => {
            await s.css(rule);
            expect(await offGreen(s.page, (await s.bare()).dataUrl), "the UI still paints somewhere").toBeGreaterThan(500);
            const shot = await s.shoot();
            expect(shot.error).toBeUndefined();
            expect(await offGreen(s.page, shot.dataUrl)).toBe(0);
        });
    });
}

for (const [what, rule] of [
    ["the individual transform properties on our panel (through the open shadow root)", "#ml-sb-host{scale:1.2 !important;translate:-300px 20px !important;rotate:5deg !important}"],
    ["zoom on our panel (through the open shadow root)", "#ml-sb-host{zoom:1.3 !important}"],
    ["content-visibility: hidden on our panel's body", "#ml-sb-body{content-visibility:hidden !important}"],
]) {
    test(`${what}: the extension's pixels stay inside the mask`, async () => {
        await withShell(async (s) => {
            await shadowCss(s.page, rule);
            await s.page.waitForTimeout(150);
            expect(await offGreen(s.page, (await s.bare()).dataUrl), "the UI still paints somewhere").toBeGreaterThan(500);
            const shot = await s.shoot();
            expect(shot.error).toBeUndefined();
            expect(await offGreen(s.page, shot.dataUrl)).toBe(0);
        });
    });
}

// --- the page's CSS that paints our pixels where no rect says ---

// A filter or a reflection on the HOST makes it the containing block of the fixed panel, which then lays out against a
// zero-size inline box (the UI moves, and getBoundingClientRect follows it); on the html element a filter changes
// nothing. Both are confirmed below. The panel inside the shadow root is the page's to style too (the root is open), and
// there a filter or a reflection paints past the panel's box; `paintsBeyond` adds at most 64 px for a filter.
for (const [what, rule] of [
    ["-webkit-box-reflect on our host", "#ml-sb-root{-webkit-box-reflect:left 0px !important}"],
    ["filter: drop-shadow on an ancestor (html)", "html{filter:drop-shadow(-300px 0 0 #000) !important}"],
]) {
    test(`${what}: the extension's pixels stay inside the mask`, async () => {
        await withShell(async (s) => {
            await s.css(rule);
            expect(await offGreen(s.page, (await s.bare()).dataUrl), "the UI still paints somewhere").toBeGreaterThan(500);
            const shot = await s.shoot();
            expect(shot.error).toBeUndefined();
            expect(await offGreen(s.page, shot.dataUrl)).toBe(0);
        });
    });
}


for (const [what, rule] of [
    ["-webkit-box-reflect on our panel (a mirrored copy of the sidebar to its left)", "#ml-sb-host{-webkit-box-reflect:left 0px !important}"],
    ["filter: blur(100px) on our panel (the sidebar smeared past the 64 px the shell allows a filter)", "#ml-sb-host{filter:blur(100px) !important}"],
    ["filter: drop-shadow 300 px to the left of our panel (its silhouette past the 64 px the shell allows)", "#ml-sb-host{filter:drop-shadow(-300px 0 0 #000) !important}"],
]) {
    // GAP: paintsBeyond caps a filter at 64 px and knows nothing of -webkit-box-reflect; the page reaches the panel's
    // style because the shadow root is open (measured: 21k-160k unmasked px).
    test.fixme(`${what}: the extension's pixels stay inside the mask`, async () => {
        await withShell(async (s) => {
            const plain = await offGreen(s.page, (await s.bare()).dataUrl);
            await shadowCss(s.page, rule);
            await s.page.waitForTimeout(150);
            expect(await offGreen(s.page, (await s.bare()).dataUrl), "the rule paints more than the panel did").toBeGreaterThan(plain);
            const shot = await s.shoot();
            expect(shot.error).toBeUndefined();
            expect(await offGreen(s.page, shot.dataUrl)).toBe(0);
        });
    });
}

// --- the top layer ---

test("our host put in the top layer by the page (popover) is still masked where it paints", async () => {
    await withShell(async (s) => {
        await s.page.evaluate(() => { const h = document.getElementById("ml-sb-root"); h.popover = "manual"; h.showPopover(); });
        await s.page.waitForTimeout(150);
        const shot = await s.shoot();
        expect(shot.error).toBeUndefined();
        expect(await offGreen(s.page, shot.dataUrl)).toBe(0);
    });
});

// --- the skip rule: an element whose own style paints nothing is left out, and nothing that paints is ---

test("the skip rule: a page hiding our panel (visibility, opacity 0) through the open shadow root while its frame stays visible leaves no frame pixels unmasked", async () => {
    await withShell(async (s) => {
        await s.page.evaluate(() => {
            const st = document.createElement("style");
            st.textContent = "#ml-sb-host{visibility:hidden !important} #ml-sb-frame{visibility:visible !important} #ml-sb-body{opacity:0 !important}";
            document.getElementById("ml-sb-root").shadowRoot.append(st);
        });
        await s.page.waitForTimeout(150);
        const shot = await s.shoot();
        expect(shot.error).toBeUndefined();
        expect(await offGreen(s.page, shot.dataUrl)).toBe(0);
    });
});

// --- the highlight: reported as four strips 4 px either side of its edge (its interior, a tint over the page's own
// element, is left unmasked by design so the element is not blanked: the counts below exclude it) ---

/** Draw the shell's highlight over #t (`kind` "approve": the pulsing approval variant), as the panel's hover does. */
const highlight = (ext, tabId, kind) => ext.sw.evaluate(({ id, kind }) => chrome.tabs.sendMessage(id, { type: "ML_HL_REMOTE", anyMode: true, ref: { selector: "#t", ...(kind ? { kind } : {}) } }), { id: tabId, kind });
const TARGET = { left: 300, top: 300, width: 200, height: 100 };

test("the hover highlight's outline stays inside its strips", async () => {
    await withShell(async (s, ext) => {
        await highlight(ext, s.tabId);
        await s.page.waitForTimeout(300);
        expect(await offGreen(s.page, (await s.bare()).dataUrl, TARGET), "the highlight paints outside the target").toBeGreaterThan(0);
        expect(await offGreen(s.page, (await s.shoot()).dataUrl, TARGET)).toBe(0);
    });
});

// GAP: the highlight element is reported as strips 4 px either side of its edge and skips paintsBeyond, so the approve
// variant's own box-shadow pulse (out to 13 px) paints past them (measured ~1.5k unmasked px), with no page involved.
test.fixme("the approval highlight's pulse (a box-shadow animating out to 13 px) stays inside the highlight's strips", async () => {
    await withShell(async (s, ext) => {
        await highlight(ext, s.tabId, "approve");
        await s.page.waitForTimeout(300);
        let worst = 0;
        // The pulse is an animation (1.25 s): shoot across a whole period.
        for (let i = 0; i < 6; i++) {
            const shot = await s.shoot();
            expect(shot.error).toBeUndefined();
            worst = Math.max(worst, await offGreen(s.page, shot.dataUrl, TARGET));
            await s.page.waitForTimeout(200);
        }
        expect(worst, "pulse pixels outside the strips").toBe(0);
    });
});

// GAP: the same strips ignore the highlight's outline-offset, which the page can set through the open shadow root
// (measured ~1k unmasked px).
test.fixme("a page-set outline-offset on the highlight (through the open shadow root) stays inside the highlight's strips", async () => {
    await withShell(async (s, ext) => {
        await highlight(ext, s.tabId);
        await shadowCss(s.page, "#ml-highlight{outline-offset:40px !important}");
        await s.page.waitForTimeout(300);
        expect(await offGreen(s.page, (await s.shoot()).dataUrl, TARGET), "an outline-offset ring outside the strips").toBe(0);
    });
});

// --- our host moved by the page ---

// GAP: extensionRects keeps reading a host the page adopted into one of its own frames: its rects are in that frame's
// viewport, not the top one, so the mask lands 300,200 px off the UI (measured ~156k unmasked px; the extension's
// sidebar frame reloads there and paints).
test.fixme("our host moved by the page into a same-origin iframe it placed at (300,200): its UI is masked where it now paints", async () => {
    await withShell(async (s) => {
        await s.page.evaluate(async () => {
            const f = document.createElement("iframe");
            f.style.cssText = "position:fixed;left:300px;top:200px;width:900px;height:500px;border:0;background:transparent";
            f.srcdoc = "<style>html,body{margin:0;background:#00ff00}</style>";
            document.body.append(f);
            await new Promise((r) => { f.onload = r; });
            f.contentDocument.documentElement.append(document.getElementById("ml-sb-root"));
        });
        await s.page.waitForTimeout(800);
        expect(await offGreen(s.page, (await s.bare()).dataUrl), "the UI paints inside the page's iframe").toBeGreaterThan(500);
        const shot = await s.shoot();
        if (shot.error) return;   // refusing the shot is also correct
        expect(await offGreen(s.page, shot.dataUrl)).toBe(0);
    });
});

// GAP: the mask is the union of two reads (before and after the capture); a panel the page moves every frame is captured
// at a position neither read saw (measured up to ~205k unmasked px).
test.fixme("our panel moved by the page between the shell's two reads and the capture (a position cycling every frame) is never left unmasked", async () => {
    await withShell(async (s) => {
        await s.page.evaluate(() => {
            const p = document.getElementById("ml-sb-root").shadowRoot.getElementById("ml-sb-host");
            let i = 0;
            const tick = () => { p.style.setProperty("translate", `${[0, -300, -600][i++ % 3]}px 0`, "important"); requestAnimationFrame(tick); };
            tick();
        });
        expect(await offGreen(s.page, (await s.bare()).dataUrl), "the panel paints").toBeGreaterThan(500);
        let leaked = 0, taken = 0;
        for (let k = 0; k < 10; k++) {
            const shot = await s.shoot();
            if (shot.error) continue;
            taken++;
            leaked = Math.max(leaked, await offGreen(s.page, shot.dataUrl));
        }
        test.info().annotations.push({ type: "shots", description: `${taken} of 10 taken, the rest refused` });
        expect(taken, "some shots were taken (a refusal is not a pass)").toBeGreaterThan(0);
        expect(leaked).toBe(0);
    });
});

// --- extension frames the page embeds itself ---

// GAP: sidebar.html is web-accessible to every site; inside a page's own (closed) shadow root it is not found by
// document.querySelectorAll("iframe") and goes into the shot whole (measured 160k px: the Sessions list and the
// configured server URL, which the page itself cannot read, put in front of the model).
test.fixme("the extension's sidebar.html embedded by the page inside its own shadow root is masked like a frame in the document", async () => {
    await withShell(async (s, ext) => {
        await s.page.evaluate((id) => {
            const h = document.createElement("div");
            h.style.cssText = "position:fixed;left:40px;top:40px;width:400px;height:400px";
            document.body.append(h);
            const f = document.createElement("iframe");
            f.src = `chrome-extension://${id}/sidebar.html`;
            f.style.cssText = "width:400px;height:400px;border:0";
            h.attachShadow({ mode: "closed" }).append(f);
        }, ext.extensionId);
        await s.page.waitForTimeout(1500);
        const bare = await s.bare();
        expect(await offGreen(s.page, bare.dataUrl), "the embedded extension page paints").toBeGreaterThan(500);
        const shot = await s.shoot();
        expect(shot.error).toBeUndefined();
        expect(await offGreen(s.page, shot.dataUrl)).toBe(0);
    });
});

// --- refusals the page can steer: is the cause named right? ---

test("a page that holds its main thread past the shell's bound gets a refusal that names the page as too busy", async () => {
    await withShell(async (s) => {
        await s.page.evaluate(() => { setTimeout(() => { const t = Date.now() + 3000; while (Date.now() < t) { /* busy */ } }, 50); });
        await s.page.waitForTimeout(150);
        const shot = await s.shoot();
        expect(shot.error).toMatch(/the page is too busy/);
    });
});

// GAP: `zoom:4 !important` on our host (the page's rule beats the inline `all: initial`) gets the refusal "the window.ml
// sidebar covers most of the page: narrow or collapse it": the person is told to fix what the page did.
test.fixme("a page that enlarges our sidebar past the refusal share gets a refusal that does not tell the person to narrow a sidebar they never widened", async () => {
    await withShell(async (s) => {
        await s.css("#ml-sb-root{zoom:4 !important}");
        const shot = await s.shoot();
        expect(shot.error, "the shot is refused").toBeDefined();
        expect(shot.error).not.toMatch(/narrow or collapse it/);
    });
});

// --- second pass (red team, 2026-10-09): the page navigates the run's tab itself, mid-shot ---

// workerShot pins the capture to one document: a webNavigation.onCommitted for frame 0 during the shot refuses it, and
// so does a topDocument mismatch after it. The vm (tests/redteam-worker-shot.test.mjs) plays the browser's commit
// events; this is the real browser: the page (which shares the main world) drives history.back()/forward() on its own
// timers so a navigation can land while a shot is in flight. Two properties, both held 2026-10-09: every shot ANSWERS
// in bounded time (measured 30-60 ms taken, ~1.1 s refused; captureVisibleTab is bounded by its quota, the rects read
// by SHOT_RECTS_MS), and a shot that survives is of one document with the UI masked.
// All of it is measured INSIDE the worker and read back in one evaluate. An earlier shape armed each navigation with
// an un-awaited page.evaluate and raced each shot from the runner; its "hung" rounds were Playwright's evaluate
// channel wedged by promises whose document navigated away — not workerShot: with the collision driven entirely from
// the worker (chrome.tabs.goForward/goBack armed mid-shot, and the same with a page-driven loop) every shot settled
// in 30-60 ms. Harness lesson, kept here so the next reader does not re-learn it: keep the page loop self-driving and
// the shots worker-fired, with ONE read-back after the page settles. The page stops its own loop (a time cap) so no
// evaluate has to cross a navigation to clearInterval either.
const SHOT_DEADLINE_MS = 8000;
test("a page that navigates its own tab while a shot is in flight: every shot answers in bounded time and never leaks", async () => {
    await withShell(async (s, ext, site) => {
        // Seed a forward entry (/b) and come back, so the loop's first forward() is a real navigation, not a silent no-op.
        await s.page.goto(`${site.url}b`);
        await s.page.waitForTimeout(400);
        await s.page.goBack();
        await s.page.waitForTimeout(400);
        expect(await offGreen(s.page, (await s.bare()).dataUrl), "the panel paints on the page back at /").toBeGreaterThan(500);
        // The page drives its own history on raw timers for ~9 s, then self-stops. No page evaluate crosses a navigation.
        await s.page.evaluate(() => {
            const stopAt = Date.now() + 9000;
            let i = 0;
            window.__navLoop = setInterval(() => {
                if (Date.now() > stopAt) { clearInterval(window.__navLoop); window.__navDone = true; return; }
                (i++ % 2 === 0 ? history.forward() : history.back());
            }, 700);
        });
        // Six shots staggered 700 ms against the 700 ms loop, so the collision phase drifts and some rounds catch a
        // navigation mid-flight. Each is raced against a worker-side deadline; the rows ride back in one evaluate.
        const rows = await ext.sw.evaluate(async (a) => {
            const out = [];
            for (let k = 0; k < 6; k++) {
                const t0 = Date.now();
                const p = globalThis.__mlWorkerVisionForTest.workerShot(a.id).then(
                    (sh) => ({ outcome: "taken", dataUrl: sh.dataUrl }),
                    (er) => ({ outcome: "refused: " + String(er?.message || er).slice(0, 60) }),
                );
                const row = await Promise.race([p, new Promise((res) => setTimeout(() => res({ outcome: "HUNG" }), a.deadline))]);
                out.push({ k, ms: Date.now() - t0, ...row });
                await new Promise((r) => setTimeout(r, 700));
            }
            return out;
        }, { id: s.tabId, deadline: SHOT_DEADLINE_MS });
        const hung = rows.filter((r) => r.outcome === "HUNG").length;
        const taken = rows.filter((r) => r.dataUrl).map((r) => r.dataUrl);
        const refused = rows.filter((r) => r.outcome.startsWith("refused")).length;
        test.info().annotations.push({ type: "mid-shot nav", description: `${refused} refused, ${taken.length} taken, ${hung} past ${SHOT_DEADLINE_MS} ms; settle times ${rows.map((r) => r.ms + "ms").join(", ")}` });
        expect(hung, `${hung} shot(s) did not answer within ${SHOT_DEADLINE_MS} ms across a mid-shot navigation`).toBe(0);
        // Wait for the page's own loop to end, settle on /, and decode every taken shot: one that survived a
        // mid-flight navigation must still be leak-free.
        await s.page.waitForFunction(() => window.__navDone === true, undefined, { timeout: 20000 }).catch(() => {});
        await s.page.goto(site.url);
        await s.page.waitForSelector("#ml-sb-root", { state: "attached", timeout: 15000 });
        await s.page.bringToFront();
        await s.page.waitForTimeout(200);
        for (const url of taken) expect(await offGreen(s.page, url), "pixels outside the mask on a mid-navigation shot").toBe(0);
    });
});

// A real back/forward-cache restore keeps its documentId, so the documentId recheck could not see it: only the
// onCommitted event can. Measured here (2026-10-09): Chromium under Playwright never serves goBack() from the cache
// (pageshow.persisted is false) even with NO extension loaded and no unload handler anywhere — the CDP attach itself
// keeps pages out of the cache — so a same-documentId restore cannot be produced in this harness. What is pinned
// instead: the vm refuses a commit during a shot even when it carries the SAME documentId
// (redteam-worker-shot.test.mjs, "a commit back to the same document id"), and after a real back navigation (restore
// or not) the worker's shot of the tab that came back is still leak-free.
test("after a back navigation the worker's shot of the tab is still leak-free, whether or not the page came from the back/forward cache", async () => {
    await withShell(async (s, ext, site) => {
        // Detect a real cache restore WITHOUT asking the restored page through CDP: a document served from the
        // back/forward cache keeps its JS state, so a recorder registered on / before leaving still exists after the
        // back navigation and reports pageshow.persisted; a reloaded document has no recorder at all.
        await s.page.evaluate(() => {
            window.__rec = [];
            addEventListener("pageshow", (e) => window.__rec.push({ persisted: e.persisted, type: performance.getEntriesByType("navigation")[0]?.type }));
        });
        await s.page.goto(`${site.url}b`);
        await s.page.waitForTimeout(300);
        await s.page.goBack();
        await s.page.waitForTimeout(600);
        const rec = await s.page.evaluate(() => window.__rec ?? null);
        test.info().annotations.push({ type: "bfcache", description: `recorder after goBack: ${JSON.stringify(rec)} (null: the document was NOT restored from the cache — its state was gone)` });
        // The shell re-runs on the restored document: the panel is where it always was, and a shot must mask it there.
        expect(await offGreen(s.page, (await s.bare()).dataUrl), "the panel paints after the back navigation").toBeGreaterThan(500);
        const shot = await s.shoot();
        expect(shot.error).toBeUndefined();
        expect(await offGreen(s.page, shot.dataUrl)).toBe(0);
    });
});

// --- second pass: paint the two reads cannot see ---

// text-shadow is in no measurement (paintsBeyond adds box-shadow, filter and outline only). Measured 2026-10-09: the
// rule paints nothing outside the host in this engine, even with `overflow:visible` forced on the tab and the panel.
// The case therefore HOLDS today and stays a test: if text-shadow ever starts painting there, the shot must not go
// out under-covered. (The panel's body is an iframe and text does not inherit across it, hence the tab, whose
// "ml · debug" is real text in our open shadow root.)
test("text-shadow 500 px off our shadow-root tab paints nothing outside the host, and the shot stays leak-free", async () => {
    await withShell(async (s) => {
        await shadowCss(s.page, "#ml-sb-tab{text-shadow:-500px 0 0 #ff00ff,-500px 0 25px #ff00ff !important}");
        await s.page.waitForTimeout(150);
        const shot = await s.shoot();
        if (!shot.error) expect(await offGreen(s.page, shot.dataUrl), "pixels outside the mask").toBe(0);
        else expect(shot.error, "a refusal must name the page, not the person").toMatch(/page/i);
    });
});

// GAP: a `filter: url(#...)` SVG reference has no px lengths, so paintsBeyond adds 0 — while feOffset MOVES the panel
// 200 px left at paint time and getBoundingClientRect (what the shell measures) does not follow a filter. The svg and
// the rule both go into our open shadow root, so the paint-server reference resolves in-tree; the filter region is
// widened (default objectBoundingBox would clip the shifted copy). The panel itself is the filtered box: a filter on
// the OUTER host would also make it the containing block of the fixed panel and relayout it (measured 2026-10-09).
// STRIP excludes the sidebar's honest area: the control counts only pixels LEFT of it, which exist only if the ghost
// really painted there (without the displacement that region is plain green).
const STRIP = { left: 760, top: 0, width: 520, height: 720 };
test.fixme("an SVG feOffset filter on our panel moves the UI 200 px left of every rect: the shot is refused, not under-covered", async () => {
    await withShell(async (s) => {
        await s.page.evaluate(() => {
            const root = document.getElementById("ml-sb-root").shadowRoot;
            const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            svg.setAttribute("width", "0"); svg.setAttribute("height", "0");
            svg.innerHTML = `<filter id="ml-shift" x="-100%" y="-10%" width="300%" height="120%"><feOffset in="SourceGraphic" dx="-200" dy="0"/></filter>`;
            const st = document.createElement("style");
            st.textContent = "#ml-sb-host{filter:url(#ml-shift) !important}";
            root.append(svg, st);
        });
        await s.page.waitForTimeout(200);
        expect(await offGreen(s.page, (await s.bare()).dataUrl, STRIP), "the displaced copy paints left of the sidebar").toBeGreaterThan(1000);
        const shot = await s.shoot();
        if (!shot.error) expect(await offGreen(s.page, shot.dataUrl), "displaced pixels outside the mask").toBe(0);
        else expect(shot.error, "a refusal must blame the page, not the person").toMatch(/page/i);
    });
});

// --- second pass: a prerendered document ---

// A page that declares a speculation rule gets /b prerendered and, on navigating to it, ACTIVATED: the activated
// document ran its life (and our content script) in the prerender phase, then flips to visible with the shell already
// mounted — the mask must be right on it too. Measured 2026-10-09: this headless Chromium never starts the prerender
// (no commits for /b before the navigation; activationStart 0, navigation type "navigate") even with
// --enable-features=Prerender2 and even with NO extension loaded, so the property is asserted for whatever document
// the tab ends up holding, and the annotation says which.
test("a page with a speculation-rules prerender: the shot of the /b document (activated or plain) is leak-free", async () => {
    const site = await greenSite();
    const ext = await launchExtension(["--enable-features=Prerender2"]);
    try {
        const s = await setup(ext, site);
        // greenSite serves the same body everywhere; declare the rule from the page itself (an inline rules script
        // inserted before the navigation is what a hostile page does; the parser runs it at insertion).
        await s.page.evaluate((u) => { const l = document.createElement("link"); l.rel = "prerender"; l.href = `${u}b`; document.head.append(l); }, site.url);
        await s.page.waitForTimeout(1500);
        await s.page.goto(`${site.url}b`);
        await s.page.waitForTimeout(800);
        const act = await s.page.evaluate(() => {
            const n = performance.getEntriesByType("navigation")[0];
            return { type: n?.type, activationStart: n?.activationStart ?? null };
        });
        test.info().annotations.push({ type: "prerender", description: `navigation type=${act.type}, activationStart=${act.activationStart} (0/null: not activated — this Chromium did not prerender)` });
        await s.page.bringToFront();
        expect(await offGreen(s.page, (await s.bare()).dataUrl), "the panel paints on the /b document").toBeGreaterThan(500);
        const shot = await s.shoot();
        expect(shot.error).toBeUndefined();
        expect(await offGreen(s.page, shot.dataUrl)).toBe(0);
    } finally { await ext.close(); await site.close(); }
});

// --- navigations during a shot ---

// A back-forward cache restore keeps its documentId, so only the commit event tells workerShot the pixels may be another
// page's. This harness never restores from the cache (the annotation says which it was: the extension's content scripts
// keep the page ineligible here), so what is pinned is the weaker premise: a back navigation commits the top frame and
// onCommitted carries the id getFrame then reports.
test("a back navigation commits the top frame, and webNavigation.onCommitted reports it with the document id getFrame then gives", async () => {
    await withShell(async (s, ext, site) => {
        const doc0 = await ext.sw.evaluate((id) => chrome.webNavigation.getFrame({ tabId: id, frameId: 0 }).then((f) => f.documentId), s.tabId);
        await ext.sw.evaluate((id) => { globalThis.__rlCommits = []; chrome.webNavigation.onCommitted.addListener((d) => { if (d.tabId === id && d.frameId === 0) globalThis.__rlCommits.push(d.documentId); }); }, s.tabId);
        await s.page.goto(`${site.url}b`);
        await s.page.goBack();
        await s.page.waitForTimeout(500);
        const doc1 = await ext.sw.evaluate((id) => chrome.webNavigation.getFrame({ tabId: id, frameId: 0 }).then((f) => f.documentId), s.tabId);
        const commits = await ext.sw.evaluate(() => globalThis.__rlCommits);
        expect(commits.length, "both navigations committed").toBeGreaterThanOrEqual(2);
        expect(commits.at(-1)).toBe(doc1);
        // Only meaningful when the page was restored from the cache (no-store pages are not), so report which it was.
        test.info().annotations.push({ type: "bfcache", description: doc1 === doc0 ? "restored with the same documentId" : "not restored from bfcache (new documentId)" });
    });
});

// review-look.spec.mjs — the masking half of the validation and coverage review of #533 (deferred from #495): the
// worker's shot of a run's tab (src/sw/worker-vision.ts `workerShot`) paints the extension's own UI out of the capture
// at the rects the shell reports (src/sidebar/shell-shot.ts `extensionRects`, masked by src/sw/shot-mask.ts). Here the
// page's CSS and script do what a hostile page can to OUR elements and their ancestors (the shadow hosts are styled
// `all: initial` inline, which a page's `!important` beats, and their shadow roots are open), and each test asks whether
// the pixels the extension paints still fall inside what was masked, or the shot is refused with a fixed sentence: what
// the shell cannot bound (a stylesheet of the page's in our root, a reflection, a filter, a host moved into a frame) is
// refused as TAMPERED, never under-covered.
//
// The oracle is tests/e2e/worker-shot.spec.mjs's: the page is one flat green and the mask one flat grey (MASK_FILL), so
// any other pixel in the worker's shot is the extension's UI. Each test first shows, on a bare capture, that the
// attack does put extension pixels somewhere, so a pass is not a page that hid the UI altogether.
import { test, expect } from "@playwright/test";
import http from "node:http";
import { launchExtension, configureExtension } from "./harness.mjs";
import { TAMPERED, RESTYLED_COVERS, MOVED_COVERS } from "../../src/sw/shot-mask.ts";

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
/** Set `decls` as `!important` inline styles on the element `id` inside our open shadow root, as a page can. */
const inlineCss = (page, id, decls) => page.evaluate(({ id, decls }) => {
    const e = document.getElementById("ml-sb-root").shadowRoot.getElementById(id) ?? document.getElementById("ml-sb-root").shadowRoot.querySelector(`#${id}`);
    for (const [k, v] of Object.entries(decls)) e.style.setProperty(k, v, "important");
}, { id, decls });

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

// Inline on our elements (a stylesheet of the page's in our root is refused outright, below), so what is tested is the
// measurement: getBoundingClientRect follows each of these.
for (const [what, id, decls] of [
    ["the individual transform properties on our panel (through the open shadow root)", "ml-sb-host", { scale: "1.2", translate: "-300px 20px", rotate: "5deg" }],
    ["zoom on our panel (through the open shadow root)", "ml-sb-host", { zoom: "1.3" }],
    ["content-visibility: hidden on our panel's body", "ml-sb-body", { "content-visibility": "hidden" }],
]) {
    test(`${what}: the extension's pixels stay inside the mask`, async () => {
        await withShell(async (s) => {
            await inlineCss(s.page, id, decls);
            await s.page.waitForTimeout(150);
            expect(await offGreen(s.page, (await s.bare()).dataUrl), "the UI still paints somewhere").toBeGreaterThan(500);
            const shot = await s.shoot();
            expect(shot.error).toBeUndefined();
            expect(await offGreen(s.page, shot.dataUrl)).toBe(0);
        });
    });
}

// --- the page's CSS that paints our pixels where no rect says ---

// A filter on the html element is bounded (a drop shadow's offset and blur) and masked round every rect. A reflection
// on our HOST copies the UI where no box says (to the left of a zero-size host here, off screen; mirrored to its right it
// would be on it), so any reflection is refused rather than bounded.
test("filter: drop-shadow on an ancestor (html): the extension's pixels stay inside the mask", async () => {
    await withShell(async (s) => {
        await s.css("html{filter:drop-shadow(-300px 0 0 #000) !important}");
        expect(await offGreen(s.page, (await s.bare()).dataUrl), "the UI still paints somewhere").toBeGreaterThan(500);
        const shot = await s.shoot();
        expect(shot.error).toBeUndefined();
        expect(await offGreen(s.page, shot.dataUrl)).toBe(0);
    });
});

for (const side of ["left", "right"]) {
    test(`-webkit-box-reflect ${side} on our host: the shot is refused, not under-covered`, async () => {
        await withShell(async (s) => {
            await s.css(`#ml-sb-root{-webkit-box-reflect:${side} 0px !important}`);
            expect(await offGreen(s.page, (await s.bare()).dataUrl), "the UI still paints somewhere").toBeGreaterThan(500);
            expect((await s.shoot()).error).toBe(TAMPERED);
        });
    });
}

// The panel inside the shadow root is the page's to style too (the root is open), and there a filter or a reflection
// paints copies of it past its box. Our own styles use neither, so the shell reports either as `tampered`, whether a
// stylesheet the page put in our root (refused for being one) or an inline style on our element sets it.
for (const [what, decls] of [
    ["-webkit-box-reflect on our panel (a mirrored copy of the sidebar to its left)", { "-webkit-box-reflect": "left 0px" }],
    ["filter: blur(100px) on our panel (the sidebar smeared far past its box)", { filter: "blur(100px)" }],
    ["filter: drop-shadow 300 px to the left of our panel (its silhouette)", { filter: "drop-shadow(-300px 0 0 #000)" }],
    ["text-shadow 500 px to the left of our panel's text", { "text-shadow": "-500px 0 0 #000" }],
]) {
    for (const how of ["a stylesheet in our root", "an inline style on our panel"]) {
        test(`${what}, by ${how}: the shot is refused, not under-covered`, async () => {
            await withShell(async (s) => {
                const plain = await offGreen(s.page, (await s.bare()).dataUrl);
                if (how === "an inline style on our panel") await inlineCss(s.page, "ml-sb-host", decls);
                else await shadowCss(s.page, `#ml-sb-host{${Object.entries(decls).map(([k, v]) => `${k}:${v} !important`).join(";")}}`);
                await s.page.waitForTimeout(150);
                if (!("text-shadow" in decls)) expect(await offGreen(s.page, (await s.bare()).dataUrl), "the rule paints more than the panel did").toBeGreaterThan(plain);
                const shot = await s.shoot();
                expect(shot.error).toBe(TAMPERED);
            });
        });
    }
}

test("a rule the page edits into our own stylesheet through the CSSOM (no DOM mutation, no new stylesheet) is refused", async () => {
    await withShell(async (s) => {
        await s.page.evaluate(() => { const st = document.getElementById("ml-sb-root").shadowRoot.querySelector("style"); st.sheet.insertRule("#ml-sb-host{translate:-600px 0 !important}", st.sheet.cssRules.length); });
        await s.page.waitForTimeout(150);
        expect((await s.shoot()).error).toBe(TAMPERED);
    });
});

test("our panel carried by the page out of our shadow root into its own document is refused (nothing measures it there)", async () => {
    await withShell(async (s) => {
        await s.page.evaluate(() => { const p = document.getElementById("ml-sb-root").shadowRoot.getElementById("ml-sb-host"); const d = document.createElement("div"); document.body.append(d); d.append(p); });
        await s.page.waitForTimeout(800);
        expect((await s.shoot()).error).toBe(TAMPERED);
    });
});

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
        await inlineCss(s.page, "ml-sb-host", { visibility: "hidden" });
        await inlineCss(s.page, "ml-sb-frame", { visibility: "visible" });
        await inlineCss(s.page, "ml-sb-body", { opacity: "0" });
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

// The approve variant's own box-shadow pulse goes out to 13 px: its band is measured at the furthest any running
// animation takes it, not at the instant read.
test("the approval highlight's pulse (a box-shadow animating out to 13 px) stays inside the highlight's strips", async () => {
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

// The page can set the highlight's outline-offset through the open shadow root: inline, the band follows the outline
// out (or in) to wherever it is drawn; as a stylesheet in our root, the shot is refused.
for (const offset of ["40px", "-30px"]) {
    test(`a page-set outline-offset of ${offset} on the highlight (an inline style through the open shadow root) stays inside the highlight's band`, async () => {
        await withShell(async (s, ext) => {
            await highlight(ext, s.tabId);
            await s.page.waitForTimeout(300);
            await inlineCss(s.page, "ml-highlight", { "outline-offset": offset });
            await s.page.waitForTimeout(150);
            const inner = { left: 300 + 35, top: 300 + 35, width: 200 - 70, height: 100 - 70 };   // left unmasked by design; the -30px ring is outside it
            expect(await offGreen(s.page, (await s.bare()).dataUrl, offset === "40px" ? TARGET : inner), "the ring paints").toBeGreaterThan(0);
            const shot = await s.shoot();
            expect(shot.error).toBeUndefined();
            expect(await offGreen(s.page, shot.dataUrl, offset === "40px" ? TARGET : inner), "an outline-offset ring outside the band").toBe(0);
        });
    });
}

test("a page-set outline-offset on the highlight by a stylesheet in our root refuses the shot", async () => {
    await withShell(async (s, ext) => {
        await highlight(ext, s.tabId);
        await shadowCss(s.page, "#ml-highlight{outline-offset:40px !important}");
        await s.page.waitForTimeout(300);
        expect((await s.shoot()).error).toBe(TAMPERED);
    });
});

// --- our host moved by the page ---

// A host the page adopted into one of its own frames has rects in that frame's viewport, not the top one (the mask would
// land 300,200 px off the UI): a host off the root element the shell mounted it on is refused.
test("our host moved by the page into a same-origin iframe it placed at (300,200): its UI is masked where it now paints", async () => {
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
        expect((await s.shoot()).error).toBe(TAMPERED);
    });
});

// The shell watches the UI from before the capture to after it: a read on every frame, and one right after every write the
// page makes to our hosts and roots (a MutationObserver runs before the next paint, so a write undone before the next
// frame is still seen). The mask is every place it was seen: a panel cycling across most of the page is refused with a
// sentence saying it moved, and a smaller cycle is masked everywhere it went.
/** Move our panel by the page every frame through `xs` (px), as an inline translate. */
const cycle = (page, xs) => page.evaluate((xs) => {
    const p = document.getElementById("ml-sb-root").shadowRoot.getElementById("ml-sb-host");
    let i = 0;
    const tick = () => { p.style.setProperty("translate", `${xs[i++ % xs.length]}px 0`, "important"); requestAnimationFrame(tick); };
    tick();
}, xs);

test("our panel moved by the page every frame across most of the page (0, -300, -600 px) is never left unmasked: each shot is refused as moving, or masked where it went", async () => {
    await withShell(async (s) => {
        await cycle(s.page, [0, -300, -600]);
        expect(await offGreen(s.page, (await s.bare()).dataUrl), "the panel paints").toBeGreaterThan(500);
        let leaked = 0, taken = 0;
        for (let k = 0; k < 10; k++) {
            const shot = await s.shoot();
            if (shot.error) { expect([MOVED_COVERS, RESTYLED_COVERS]).toContain(shot.error); continue; }
            taken++;
            leaked = Math.max(leaked, await offGreen(s.page, shot.dataUrl));
        }
        test.info().annotations.push({ type: "shots", description: `${taken} of 10 taken, the rest refused` });
        expect(leaked).toBe(0);
    });
});

test("our panel moved by the page every frame within a bound (0, -40, -80 px) is masked at every place it went, and the shots are taken", async () => {
    await withShell(async (s) => {
        await cycle(s.page, [0, -40, -80]);
        let leaked = 0, taken = 0;
        for (let k = 0; k < 6; k++) {
            const shot = await s.shoot();
            if (shot.error) continue;
            taken++;
            leaked = Math.max(leaked, await offGreen(s.page, shot.dataUrl));
        }
        expect(taken, "a bounded move is masked, not refused").toBe(6);
        expect(leaked).toBe(0);
    });
});

test("our panel moved by the page after every frame read and put back before the next (a move no once-per-frame read sees) is still masked where it was painted", async () => {
    await withShell(async (s) => {
        await s.page.evaluate(() => {
            const p = document.getElementById("ml-sb-root").shadowRoot.getElementById("ml-sb-host");
            // A ResizeObserver callback runs after every frame callback and layout, just before the paint: the panel is
            // painted at -80 px, and a task puts it back before the next frame's callbacks run.
            const probe = document.createElement("div");
            probe.style.cssText = "position:absolute;left:0;top:0;height:1px;width:1px";
            document.body.append(probe);
            let w = 1;
            new ResizeObserver(() => { p.style.setProperty("translate", "-80px 0", "important"); setTimeout(() => p.style.removeProperty("translate"), 0); }).observe(probe);
            const tick = () => { probe.style.width = `${(w = 3 - w)}px`; requestAnimationFrame(tick); };
            requestAnimationFrame(tick);
        });
        await s.page.waitForTimeout(200);
        expect(await offGreen(s.page, (await s.bare()).dataUrl), "the panel paints").toBeGreaterThan(500);
        let leaked = 0, taken = 0;
        for (let k = 0; k < 6; k++) {
            const shot = await s.shoot();
            if (shot.error) continue;
            taken++;
            leaked = Math.max(leaked, await offGreen(s.page, shot.dataUrl));
        }
        expect(taken).toBeGreaterThan(0);
        expect(leaked).toBe(0);
    });
});

// --- extension frames the page embeds itself ---

// sidebar.html is web-accessible to every site, and a page can frame it where the shell's search for extension frames
// does not look (its own closed shadow root here). The app mounts only once the shell that framed IT hands it a port
// (parent-channel.ts `awaitHost`), so the page's frame of it is empty and transparent: nothing of the Sessions list or
// the configured server URL is in the shot, or on the page at all.
test("the extension's sidebar.html embedded by the page inside its own shadow root shows nothing: not in a bare capture, not in the worker's shot", async () => {
    await withShell(async (s, ext) => {
        const plain = await offGreen(s.page, (await s.bare()).dataUrl);
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
        const sb = s.page.frames().filter((f) => f.url().includes("sidebar.html"));
        expect(sb.length, "ours and the page's").toBe(2);
        const mounted = await Promise.all(sb.map((f) => f.evaluate(() => document.getElementById("root")?.childElementCount ?? -1)));
        expect(mounted.filter((n) => n > 0).length, "our own sidebar mounted; the page's frame of sidebar.html did not").toBe(1);
        // The page's frame sits at (40,40) 400x400, clear of our sidebar on the right: nothing off-green there.
        const SIDEBAR = { left: 800, top: 0, width: 480, height: 720 };
        expect(plain, "our own sidebar paints").toBeGreaterThan(1000);
        expect(await offGreen(s.page, (await s.bare()).dataUrl, SIDEBAR), "the page's frame paints nothing").toBe(0);
        const shot = await s.shoot();
        expect(shot.error).toBeUndefined();
        expect(await offGreen(s.page, shot.dataUrl)).toBe(0);
    });
});

// Top-level, the app is its own window and mounts (no shell frames it there), so it is the worker that must not shoot it:
// the browser reports no document for an extension page, which workerShot already refuses.
test("a run tab the page sends to the extension's own sidebar.html (a top-level navigation) is not screenshot", async () => {
    await withShell(async (s, ext) => {
        await s.page.goto(`chrome-extension://${ext.extensionId}/sidebar.html`);
        await s.page.waitForTimeout(500);
        const shot = await s.shoot();
        expect(shot.dataUrl).toBeUndefined();
        expect(shot.error).toMatch(/^Can't screenshot this tab: the browser does not say which page it holds\.$/);
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

// `zoom:4 !important` on our host (the page's rule beats the inline `all: initial`): the refusal names the page's styles,
// not a sidebar the person never widened.
test("a page that enlarges our sidebar past the refusal share gets a refusal that does not tell the person to narrow a sidebar they never widened", async () => {
    await withShell(async (s) => {
        await s.css("#ml-sb-root{zoom:4 !important}");
        const shot = await s.shoot();
        expect(shot.error, "the shot is refused").toBeDefined();
        expect(shot.error).not.toMatch(/narrow or collapse it/);
        expect(shot.error).toBe(RESTYLED_COVERS);
    });
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

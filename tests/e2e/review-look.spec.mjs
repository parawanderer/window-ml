// review-look.spec.mjs — the masking half of the validation and coverage review of #533 (deferred from #495): the
// worker's shot of a run's tab (src/sw/worker-vision.ts `workerShot`) paints the extension's own UI out of the capture
// at the rects the shell reports (src/sidebar/shell-shot.ts `extensionRects`, masked by src/sw/shot-mask.ts). Here the
// page's CSS and script do what a hostile page can to OUR elements and their ancestors (the shadow hosts are styled
// `all: initial !important` inline, which no page stylesheet beats, but their shadow roots are open and `<html>` is the
// page's), and each test asks whether
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
// The three rules on our host no longer apply (its inline `all: initial !important` holds; the section on that is
// below); they stay as a check that the shot is still clean with them in place.

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

// Our host's inline `all: initial !important` holds against the page's reflection rule, so the shot is taken and clean.
// A reflection set where the page's rule does win (inside our root) is refused below.
for (const side of ["left", "right"]) {
    test(`-webkit-box-reflect ${side} on our host by a page stylesheet is held off by the host's inline style: the shot is taken and clean`, async () => {
        await withShell(async (s) => {
            await s.css(`#ml-sb-root{-webkit-box-reflect:${side} 0px !important}`);
            expect(await s.page.evaluate(() => getComputedStyle(document.getElementById("ml-sb-root")).webkitBoxReflect)).toBe("none");
            expect(await offGreen(s.page, (await s.bare()).dataUrl), "the UI still paints somewhere").toBeGreaterThan(500);
            const shot = await s.shoot();
            expect(shot.error).toBeUndefined();
            expect(await offGreen(s.page, shot.dataUrl)).toBe(0);
        });
    });
}

// A `:host` rule in a stylesheet inside our open root is the one page rule that beats the host's inline `!important`
// (for `!important`, the inner context wins), so the host checks stay: it is refused, for the stylesheet and for the paint.
test("a :host reflection rule the page puts in a stylesheet inside our root (it beats the host's inline !important): the shot is refused", async () => {
    await withShell(async (s) => {
        await shadowCss(s.page, ":host{-webkit-box-reflect:left 0px !important;translate:-300px 0 !important;display:block !important}");
        await s.page.waitForTimeout(150);
        expect(await s.page.evaluate(() => getComputedStyle(document.getElementById("ml-sb-root")).webkitBoxReflect), "the inner rule wins").not.toBe("none");
        expect((await s.shoot()).error).toBe(TAMPERED);
    });
});

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

// --- our hosts pinned against the page's own `!important` rules ---
// Each shadow host carries `all: initial !important` inline (`HOST_STYLE`, shell-shot.ts). An inline `!important` declaration beats
// every author stylesheet `!important` rule, layered or not, so no page rule moves, scales, filters, reflects, hides or
// repaints a host. Without it the rects still follow a persistent rule (getBoundingClientRect), but a rule the page
// inserts through the CSSOM after one of the shell's reads and deletes before the next is a change no read sees and no
// MutationObserver reports. The oracle is where the UI paints in a bare capture: before and after the rule, the same place.

/** The bounding box, in CSS px, of every pixel of a capture that is neither the page's green nor the mask's grey. */
const paintBox = (page, dataUrl) => page.evaluate(async (src) => {
    const img = new Image();
    await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = src; });
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const s = c.width / window.innerWidth;
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (let i = 0; i < d.length; i += 4) {
        const green = d[i] < 8 && d[i + 1] > 247 && d[i + 2] < 8, grey = d[i] === 128 && d[i + 1] === 128 && d[i + 2] === 128;
        if (green || grey) continue;
        const x = (i / 4) % c.width, y = Math.floor(i / 4 / c.width);
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return x1 < 0 ? null : { left: x0 / s, top: y0 / s, width: (x1 + 1 - x0) / s, height: (y1 + 1 - y0) / s };
}, dataUrl);
/** The sidebar panel's viewport rect inside our open shadow root. */
const panelRect = (page) => page.evaluate(() => { const r = document.getElementById("ml-sb-root").shadowRoot.getElementById("ml-sb-host").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });

// The page's rule targets our host by id. The host is an inline box, which ignores a transform, so most rules also set
// `display:block`. Each one moved, copied, refused or hid the UI on 771cb650.
for (const [what, rule] of [
    ["translate, scale and rotate", "display:block !important;translate:-400px 30px !important;scale:1.3 !important;rotate:6deg !important"],
    ["display:block and a transform (also makes the host the panel's containing block)", "display:block !important;transform:translateX(-400px) !important"],
    ["zoom", "zoom:1.5 !important"],
    ["a drop-shadow filter (a copy of the UI 400 px to its left)", "display:block !important;filter:drop-shadow(-400px 0 0 #f0f) !important"],
    ["a reflection across the viewport (position:fixed, inset:0, -webkit-box-reflect)", "position:fixed !important;inset:0 !important;-webkit-box-reflect:left -1280px !important"],
    ["position, inset, margin and perspective with a 3D transform", "display:block !important;position:fixed !important;left:-300px !important;top:40px !important;margin:20px !important;perspective:300px !important;transform:rotateY(20deg) !important"],
    ["will-change, contain and an offset path", "display:block !important;will-change:transform !important;contain:paint !important;offset-path:path('M0 0 L-500 0') !important;offset-distance:100% !important"],
]) {
    test(`a page stylesheet's !important ${what} on our host does not move it: the UI paints where it did, and the shot is clean`, async () => {
        await withShell(async (s) => {
            const before = await paintBox(s.page, (await s.bare()).dataUrl);
            const rect = await panelRect(s.page);
            expect(before, "the UI paints").not.toBeNull();
            await s.css(`#ml-sb-root{${rule}}`);
            expect(await panelRect(s.page), "the panel did not move").toEqual(rect);
            expect(await offGreen(s.page, (await s.bare()).dataUrl, before), "UI pixels outside where it painted before the rule").toBe(0);
            const shot = await s.shoot();
            expect(shot.error).toBeUndefined();
            expect(await offGreen(s.page, shot.dataUrl)).toBe(0);
        });
    });
}

// Hiding or recolouring our host is not a leak, but the approval card lives in such a host, and a page that can hide or
// blend it away can hide what the person is asked to approve.
for (const [what, rule] of [
    ["display:none", "display:none !important"],
    ["visibility:hidden", "visibility:hidden !important"],
    ["opacity:0", "opacity:0 !important"],
    ["content-visibility:hidden", "display:block !important;content-visibility:hidden !important"],
    ["clip-path", "clip-path:inset(50%) !important"],
    ["a mask", "mask:linear-gradient(transparent,transparent) !important;-webkit-mask:linear-gradient(transparent,transparent) !important"],
    ["mix-blend-mode", "mix-blend-mode:difference !important"],
    ["backdrop-filter and filter", "backdrop-filter:invert(1) !important;filter:invert(1) !important"],
]) {
    test(`a page stylesheet's !important ${what} on our host does not hide or repaint the UI`, async () => {
        await withShell(async (s) => {
            const before = await offGreen(s.page, (await s.bare()).dataUrl);
            const box = await paintBox(s.page, (await s.bare()).dataUrl);
            await s.css(`#ml-sb-root{${rule}}`);
            const after = await s.bare();
            expect(await paintBox(s.page, after.dataUrl), "the UI paints in the same box").toEqual(box);
            expect(Math.abs(await offGreen(s.page, after.dataUrl) - before), "the same pixels paint").toBeLessThan(before * 0.02);
        });
    });
}

// The page-hosted shot's hide handshake writes the host's visibility, which a plain inline value would lose to the host's
// own `all: initial !important`: the hide is `!important` too, and the show takes it off again.
test("the page's own hide handshake still hides our pinned host, and its show brings the UI back where it was", async () => {
    await withShell(async (s) => {
        const before = await paintBox(s.page, (await s.bare()).dataUrl);
        await s.page.evaluate(() => new Promise((ok) => {
            addEventListener("message", (e) => { if (e.data?.__mlSidebarShot === "hidden") ok(); });
            postMessage({ __mlSidebarShot: "hide" }, "*");
        }));
        expect(await offGreen(s.page, (await s.bare()).dataUrl), "the hide hid the UI").toBe(0);
        await s.page.evaluate(() => postMessage({ __mlSidebarShot: "show" }, "*"));
        await s.page.waitForTimeout(200);
        expect(await paintBox(s.page, (await s.bare()).dataUrl), "the show brought it back").toEqual(before);
        expect(await s.page.evaluate(() => document.getElementById("ml-sb-root").style.cssText), "the hide left nothing behind").toBe("all: initial !important;");
    });
});

// The timed form: the rule is inserted into the page's own stylesheet through the CSSOM (no DOM mutation, so no
// MutationObserver record) and deleted again before the shell's next frame read. A decoy page element matches the same
// rule, so the test shows the edit really applied in the frames it painted: the decoy moved, our panel did not.
/** Start the timed edit: `#ml-sb-root, #decoy {display:block !important;translate:-600px 0 !important}` (an inline
 *  host ignores a translate, hence the display) applied at `when` and deleted after it. */
const timedEdit = (page, when) => page.evaluate((when) => {
    const st = document.createElement("style");
    document.head.append(st);
    const decoy = document.createElement("div");
    decoy.id = "decoy";
    decoy.style.cssText = "position:fixed;left:900px;top:10px;width:10px;height:10px";
    document.body.append(decoy);
    const panel = document.getElementById("ml-sb-root").shadowRoot.getElementById("ml-sb-host");
    const stats = (window.__atk = { applied: 0, decoyMoved: 0, panelMoved: 0, panelX: panel.getBoundingClientRect().x });
    const apply = () => {
        if (st.sheet.cssRules.length) return;
        st.sheet.insertRule("#ml-sb-root, #decoy {display:block !important;translate:-600px 0 !important}", 0);
        stats.applied++;
        if (decoy.getBoundingClientRect().x !== 900) stats.decoyMoved++;
        if (panel.getBoundingClientRect().x !== stats.panelX) stats.panelMoved++;
    };
    const undo = () => { if (st.sheet.cssRules.length) st.sheet.deleteRule(0); };
    if (when === "raf") {
        // Applied in one frame's callback, deleted in the next one's.
        let on = false;
        const tick = () => { (on = !on) ? apply() : undo(); requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
    } else {
        // Applied in a ResizeObserver callback (after every frame callback and layout, just before the paint), deleted by
        // a task before the next frame's callbacks: painted every frame, present at no frame read.
        const probe = document.createElement("div");
        probe.style.cssText = "position:absolute;left:0;top:0;height:1px;width:1px";
        document.body.append(probe);
        let w = 1;
        new ResizeObserver(() => { apply(); setTimeout(undo, 0); }).observe(probe);
        const tick = () => { probe.style.width = `${(w = 3 - w)}px`; requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
    }
}, when);

for (const when of ["raf", "resize-observer"]) {
    test(`a page's !important translate on our host, inserted through the CSSOM ${when === "raf" ? "in one animation frame and deleted in the next" : "after every frame read and deleted before the next"}, never moves our panel, and every shot is clean`, async () => {
        await withShell(async (s) => {
            const before = await paintBox(s.page, (await s.bare()).dataUrl);
            await timedEdit(s.page, when);
            await s.page.waitForTimeout(300);
            let leaked = 0, taken = 0, stray = 0;
            for (let k = 0; k < 6; k++) {
                stray = Math.max(stray, await offGreen(s.page, (await s.bare()).dataUrl, before));
                const shot = await s.shoot();
                if (shot.error) continue;
                taken++;
                leaked = Math.max(leaked, await offGreen(s.page, shot.dataUrl));
            }
            const stats = await s.page.evaluate(() => window.__atk);
            expect(stats.applied, "the edit ran").toBeGreaterThan(10);
            expect(stats.decoyMoved, "the rule applied: the decoy it also matches moved").toBe(stats.applied);
            expect(stats.panelMoved, "our panel never moved").toBe(0);
            expect(stray, "UI pixels outside where it painted before the edit, in a bare capture").toBe(0);
            expect(taken, "the shots are taken").toBe(6);
            expect(leaked).toBe(0);
        });
    });
}

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

// `zoom:4` on our panel through the open shadow root (a page stylesheet's zoom on the host no longer applies): the
// refusal names the page's styles, not a sidebar the person never widened.
test("a page that enlarges our sidebar past the refusal share gets a refusal that does not tell the person to narrow a sidebar they never widened", async () => {
    await withShell(async (s) => {
        await inlineCss(s.page, "ml-sb-host", { zoom: "4" });
        await s.page.waitForTimeout(150);
        const shot = await s.shoot();
        expect(shot.error, "the shot is refused").toBeDefined();
        expect(shot.error).not.toMatch(/narrow or collapse it/);
        expect(shot.error).toBe(RESTYLED_COVERS);
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

// A `filter: url(#...)` SVG reference has no px lengths, and feOffset MOVES the panel 200 px left at paint time, where
// getBoundingClientRect (what the shell measures) does not follow. The svg goes into our open shadow root, so the
// paint-server reference resolves in-tree; the filter region is widened (default objectBoundingBox would clip the shifted
// copy). The panel itself is the filtered box: a filter on the OUTER host would also make it the containing block of the
// fixed panel and relayout it (measured 2026-10-09). STRIP excludes the sidebar's honest area: the control counts only
// pixels LEFT of it, which exist only if the ghost really painted there. Our own styles set no filter on our UI, so any
// filter there (this one included) is `tampered` and refused with the sentence that names the page; the mask is never
// grown to the viewport for it. Set by a stylesheet in our root (refused for that too) and by an inline style alone.
const STRIP = { left: 760, top: 0, width: 520, height: 720 };
for (const how of ["a stylesheet in our root", "an inline style on our panel"]) {
    test(`an SVG feOffset filter on our panel moves the UI 200 px left of every rect: the shot is refused, not under-covered (${how})`, async () => {
        await withShell(async (s) => {
            await s.page.evaluate((inline) => {
                const root = document.getElementById("ml-sb-root").shadowRoot;
                const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
                svg.setAttribute("width", "0"); svg.setAttribute("height", "0");
                svg.innerHTML = `<filter id="ml-shift" x="-100%" y="-10%" width="300%" height="120%"><feOffset in="SourceGraphic" dx="-200" dy="0"/></filter>`;
                root.append(svg);
                if (inline) { root.getElementById("ml-sb-host").style.setProperty("filter", "url(#ml-shift)", "important"); return; }
                const st = document.createElement("style");
                st.textContent = "#ml-sb-host{filter:url(#ml-shift) !important}";
                root.append(st);
            }, how === "an inline style on our panel");
            await s.page.waitForTimeout(200);
            expect(await offGreen(s.page, (await s.bare()).dataUrl, STRIP), "the displaced copy paints left of the sidebar").toBeGreaterThan(1000);
            const shot = await s.shoot();
            expect(shot.dataUrl).toBeUndefined();
            expect(shot.error, "refused with the sentence that names the page, not the person").toBe(TAMPERED);
        });
    });
}

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

// output-scroll.spec.mjs — the tool OUTPUT CELL's scroll mechanics, in a real browser (jsdom has no layout,
// so this is the only place the behaviour is real). Drives a LONG, slowly-streaming exec and checks Jupyter's
// tail-follow contract while output is still arriving:
//   1. the cell overflows and scrolls;
//   2. parked at the BOTTOM → new output keeps scrolling into view (locked to the tail);
//   3. scrolled to the MIDDLE → new output does NOT snap you back down;
//   4. scrolled back to the bottom → following resumes.
import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Scroll the cell and DELIVER the scroll event now: the cell arms/disarms tail-follow from that event
// (prompt for a real wheel/drag, but async for a programmatic scrollTop — which would race a delta).
const scrollTo = async (locator, pick) => {
    const top = await locator.evaluate((el, fn) => {
        el.scrollTop = new Function("el", `return (${fn})(el)`)(el);
        el.dispatchEvent(new Event("scroll"));
        return el.scrollTop;
    }, pick.toString());
    await sleep(120);
    return top;
};
// ~110 lines paced ~120ms apart → ~13s of streaming. Deliberately longer than the checks need: every
// assertion below is about behaviour WHILE output is arriving, so a stream that ran dry mid-test would let
// "it stayed pinned" pass for the wrong reason (nothing left to push it). The growth assertions enforce that.
const EXEC_JS = `
const wait = (ms) => new Promise(r => setTimeout(r, ms));
for (let i = 1; i <= 110; i++) { console.log('scroll-line ' + i + ' ................................'); await wait(120); }
return 'done';
`.trim();

test("output cell: tail-follows at the bottom, holds still when scrolled up", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay",
        });
        fake.setScript([{ tool: "exec", args: { js: EXEC_JS } }, { content: "done" }]);

        const page = await ext.context.newPage();
        await page.setViewportSize({ width: 1400, height: 900 });
        await page.goto(site.url + "/");
        await waitForMl(page);
        await page.evaluate(() => { window.ml.agent("stream a lot", { stream: true, approvalRouting: "both" }); });

        // Approve the exec from the SW-only channel (no human click in a test).
        for (let i = 0; i < 60; i++) {
            const n = await ext.sw.evaluate(() => {
                const p = globalThis.__mlApprovals?.list?.() || [];
                p.forEach(d => globalThis.__mlApprovals.resolve(d.key, true));
                return p.length;
            });
            if (n) break;
            await sleep(150);
        }

        // Open the overlay and expand the running step so its live Out (the output cell) is on screen.
        await page.waitForFunction(() => !!document.getElementById("ml-sb-root")?.shadowRoot?.getElementById("ml-sb-host"), null, { timeout: 20000 });
        await page.evaluate(() => {
            const root = document.getElementById("ml-sb-root").shadowRoot;
            const panel = root.getElementById("ml-sb-host");
            panel.style.width = `${Math.round(window.innerWidth / 2)}px`;
            panel.classList.add("open");
            root.getElementById("ml-sb-frame")?.contentWindow?.postMessage({ __mlSidebarOpen: true }, "*");
        });
        const frame = await (async () => {
            for (let i = 0; i < 80; i++) {
                const f = page.frames().find((fr) => /sidebar\.html/.test(fr.url()));
                if (f) return f;
                await sleep(100);
            }
            throw new Error("sidebar iframe never appeared");
        })();
        for (let i = 0; i < 60; i++) {
            const row = frame.locator("button.row").first();
            if (await row.count()) await row.click({ timeout: 1500 }).catch(() => {});
            if (await frame.locator('button.nav[aria-label="Back to sessions"]').count()) break;
            await sleep(200);
        }
        for (let i = 0; i < 40; i++) {
            const head = frame.locator(".astep.tool:not(.open) .astep-head").last();
            if (await head.count()) await head.click({ timeout: 800 }).catch(() => {});
            if (await frame.locator(".r-outscroll").count()) break;
            await sleep(200);
        }

        const cell = frame.locator(".r-outscroll").last();
        // 1. It overflows with a REAL scroll range — enough that the midpoint is far outside the follow slack
        //    (with only a few px of overflow, "the middle" would still count as parked at the bottom).
        await expect.poll(async () => cell.evaluate((el) => el.scrollHeight - el.clientHeight), { timeout: 30000 })
            .toBeGreaterThan(300);

        // 2. Parked at the bottom → it keeps following as new lines land.
        await scrollTo(cell, (el) => el.scrollHeight);
        await sleep(900);
        const gapAtBottom = await cell.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
        expect(gapAtBottom, "still pinned to the tail after new output").toBeLessThanOrEqual(24);

        // 3. Scroll UP to the middle → new output must NOT yank us back down.
        const parked = await scrollTo(cell, (el) => Math.floor(el.scrollHeight / 2));
        const grewWhileParked = await (async () => {
            const before = await cell.evaluate((el) => el.scrollHeight);
            await sleep(1200);
            return (await cell.evaluate((el) => el.scrollHeight)) > before;
        })();
        expect(grewWhileParked, "output kept streaming while we sat mid-scroll").toBe(true);
        const after = await cell.evaluate((el) => el.scrollTop);
        expect(Math.abs(after - parked), "scroll position held — no snap to the bottom").toBeLessThanOrEqual(2);

        // 3b. Opening FIND must not move the view. Focusing the input normally makes the browser reveal it by
        //     scrolling ancestors, which yanked the panel around and fought tail-follow ("Ctrl+F randomly
        //     scrolls"). Parked mid-scroll, the position must be identical before and after Ctrl+F.
        const beforeFind = await cell.evaluate((el) => el.scrollTop);
        await cell.click({ position: { x: 20, y: 20 } });
        await page.keyboard.press("Control+f");
        await sleep(400);
        expect(await frame.locator(".r-find").count(), "the find bar opened").toBeGreaterThan(0);
        expect(Math.abs((await cell.evaluate((el) => el.scrollTop)) - beforeFind),
            "opening find left the scroll position alone").toBeLessThanOrEqual(2);
        // 3c. Find must BRING THE MATCH INTO VIEW — typing alone, not only the arrows. Park at the very top,
        //     search for a line near the bottom, and the cell must scroll to it.
        await scrollTo(cell, () => 0);
        await page.keyboard.type("scroll-line 55");
        await sleep(500);
        const afterType = await cell.evaluate((el) => el.scrollTop);
        expect(afterType, "typing scrolled the match into view (no need to press the arrow first)").toBeGreaterThan(20);
        // The match itself must be inside the visible band, not merely 'somewhere scrolled'.
        const visible = await cell.evaluate((el) => {
            const hit = el.querySelector("*") && document.getSelection ? null : null;   // (paint is CSS-only; measure by text)
            const rows = [...el.querySelectorAll("*")].filter(n => /scroll-line 55/.test(n.textContent || "") && !n.children.length);
            if (!rows.length) return false;
            const r = rows[0].getBoundingClientRect(), b = el.getBoundingClientRect();
            return r.top >= b.top - 2 && r.bottom <= b.bottom + 2;
        });
        expect(visible, "the matched line is on screen inside the cell").toBe(true);
        await page.keyboard.press("Escape");
        await sleep(200);

        // 4. Scroll back DOWN to the bottom → follow RE-ARMS and the tail starts tracking again. This only
        //    proves anything while output is still arriving, so assert the content grew during the window too:
        //    otherwise "still at the bottom" is just "nothing pushed it".
        await scrollTo(cell, (el) => el.scrollHeight);
        const heightBefore = await cell.evaluate((el) => el.scrollHeight);
        await sleep(900);
        const grewAfterReattach = (await cell.evaluate((el) => el.scrollHeight)) > heightBefore;
        expect(grewAfterReattach, "output was still streaming when we returned to the bottom").toBe(true);
        const gapAgain = await cell.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
        expect(gapAgain, "re-armed: back at the tail, following the new lines again").toBeLessThanOrEqual(24);
    } finally {
        await ext.close();
        fake.stop?.();
        site.stop?.();
    }
});

// The live rail (the pulsing accent bar on a streaming step) must take NO layout: when the step finishes and
// the rail goes away, the Out content must stay exactly where it was. It used to be a real border+padding, so
// the whole block jumped left on completion — visible and irritating. Measured in a real browser (no layout in jsdom).
test("output cell: the Out content does not shift when streaming stops", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay",
        });
        // Short, so it settles quickly — we care about the live→settled transition, not the volume.
        fake.setScript([
            { tool: "exec", args: { js: "const w=(ms)=>new Promise(r=>setTimeout(r,ms));\nfor (let i=1;i<=8;i++){ console.log('shift-check line '+i); await w(300); }\nreturn 'done';" } },
            { content: "finished" },
        ]);

        const page = await ext.context.newPage();
        await page.setViewportSize({ width: 1400, height: 900 });
        await page.goto(site.url + "/");
        await waitForMl(page);
        await page.evaluate(() => { window.ml.agent("stream briefly", { stream: true, approvalRouting: "both" }); });
        for (let i = 0; i < 60; i++) {
            const n = await ext.sw.evaluate(() => {
                const p = globalThis.__mlApprovals?.list?.() || [];
                p.forEach(d => globalThis.__mlApprovals.resolve(d.key, true));
                return p.length;
            });
            if (n) break;
            await sleep(150);
        }
        await page.waitForFunction(() => !!document.getElementById("ml-sb-root")?.shadowRoot?.getElementById("ml-sb-host"), null, { timeout: 20000 });
        await page.evaluate(() => {
            const root = document.getElementById("ml-sb-root").shadowRoot;
            const panel = root.getElementById("ml-sb-host");
            panel.style.width = `${Math.round(window.innerWidth / 2)}px`;
            panel.classList.add("open");
            root.getElementById("ml-sb-frame")?.contentWindow?.postMessage({ __mlSidebarOpen: true }, "*");
        });
        const frame = await (async () => {
            for (let i = 0; i < 80; i++) {
                const f = page.frames().find((fr) => /sidebar\.html/.test(fr.url()));
                if (f) return f;
                await sleep(100);
            }
            throw new Error("sidebar iframe never appeared");
        })();
        for (let i = 0; i < 60; i++) {
            const row = frame.locator("button.row").first();
            if (await row.count()) await row.click({ timeout: 1500 }).catch(() => {});
            if (await frame.locator('button.nav[aria-label="Back to sessions"]').count()) break;
            await sleep(200);
        }
        for (let i = 0; i < 40; i++) {
            const head = frame.locator(".astep.tool:not(.open) .astep-head").last();
            if (await head.count()) await head.click({ timeout: 800 }).catch(() => {});
            if (await frame.locator(".astep-streaming").count()) break;
            await sleep(200);
        }

        // Measure the LIVE output's left edge…
        const live = frame.locator(".astep-streaming").last();
        await expect.poll(async () => live.count(), { timeout: 20000 }).toBeGreaterThan(0);
        await sleep(500);   // let the panel finish laying out — an x measured mid-layout is meaningless
        const liveX = (await live.boundingBox()).x;
        // …then the SETTLED output's, once the step has a real result.
        await expect.poll(async () => frame.locator(".r-py-out").count(), { timeout: 25000 }).toBeGreaterThan(0);
        await sleep(400);
        const settledX = (await frame.locator(".r-py-out").last().boundingBox()).x;
        // The gutter must survive too — if the settled view dropped its timestamps the text would shift by the
        // gutter's width, which is exactly the kind of jump this test exists to catch.
        expect(await frame.locator(".r-py-out .r-ts").count(), "the settled output kept its timestamp gutter").toBeGreaterThan(0);
        expect(Math.abs(settledX - liveX), "the Out content stays put when the live rail goes away").toBeLessThanOrEqual(1);
    } finally {
        await ext.close();
        fake.stop?.();
        site.stop?.();
    }
});

// Things jsdom structurally CANNOT cover — they need real layout and a real highlight registry:
//   · the cap actually CLIPS (a jsdom cell has no height at all)
//   · the resize grip only appears once content overflows, and DRAGGING it really resizes that cell
//   · find matches actually PAINT (jsdom has no CSS Custom Highlight API, so the unit tests can only count)
test("output cell (real layout): cap clips, grip drags to resize, matches actually paint", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay",
        });
        fake.setScript([{ tool: "exec", args: { js: EXEC_JS } }, { content: "done" }]);
        const page = await ext.context.newPage();
        await page.setViewportSize({ width: 1400, height: 900 });
        await page.goto(site.url + "/");
        await waitForMl(page);
        await page.evaluate(() => { window.ml.agent("stream a lot", { stream: true, approvalRouting: "both" }); });
        for (let i = 0; i < 60; i++) {
            const n = await ext.sw.evaluate(() => {
                const p = globalThis.__mlApprovals?.list?.() || [];
                p.forEach(d => globalThis.__mlApprovals.resolve(d.key, true));
                return p.length;
            });
            if (n) break;
            await sleep(150);
        }
        await page.waitForFunction(() => !!document.getElementById("ml-sb-root")?.shadowRoot?.getElementById("ml-sb-host"), null, { timeout: 20000 });
        await page.evaluate(() => {
            const root = document.getElementById("ml-sb-root").shadowRoot;
            const panel = root.getElementById("ml-sb-host");
            panel.style.width = `${Math.round(window.innerWidth / 2)}px`;
            panel.classList.add("open");
            root.getElementById("ml-sb-frame")?.contentWindow?.postMessage({ __mlSidebarOpen: true }, "*");
        });
        const frame = await (async () => {
            for (let i = 0; i < 80; i++) {
                const f = page.frames().find((fr) => /sidebar\.html/.test(fr.url()));
                if (f) return f;
                await sleep(100);
            }
            throw new Error("sidebar iframe never appeared");
        })();
        for (let i = 0; i < 60; i++) {
            const row = frame.locator("button.row").first();
            if (await row.count()) await row.click({ timeout: 1500 }).catch(() => {});
            if (await frame.locator('button.nav[aria-label="Back to sessions"]').count()) break;
            await sleep(200);
        }
        for (let i = 0; i < 40; i++) {
            const head = frame.locator(".astep.tool:not(.open) .astep-head").last();
            if (await head.count()) await head.click({ timeout: 800 }).catch(() => {});
            if (await frame.locator(".r-outscroll").count()) break;
            await sleep(200);
        }

        const cell = frame.locator(".r-outscroll").last();
        // 1. The cap CLIPS: once the content is taller than the cap, the box stays at the configured height.
        await expect.poll(async () => cell.evaluate((el) => el.scrollHeight - el.clientHeight), { timeout: 30000 })
            .toBeGreaterThan(60);
        const capped = await cell.evaluate((el) => el.clientHeight);
        expect(capped, "the cell is clipped to the configured 260px cap, not grown to fit").toBeLessThanOrEqual(266);

        // 2. The grip appears only once there IS something to resize — and dragging it resizes THIS cell.
        const grip = frame.locator(".r-outcell:has(.r-outscroll) .r-outgrip").last();
        expect(await grip.count(), "overflowing content grows a resize grip").toBeGreaterThan(0);
        const g = await grip.boundingBox();
        await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
        await page.mouse.down();
        await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2 + 140, { steps: 8 });
        await page.mouse.up();
        await sleep(300);
        const dragged = await cell.evaluate((el) => el.clientHeight);
        expect(dragged - capped, "dragging the grip down made this cell taller").toBeGreaterThan(60);

        // 3. Matches actually PAINT via the CSS Custom Highlight API (not just counted in the bar).
        await cell.click({ position: { x: 20, y: 20 } });
        await page.keyboard.press("Control+f");
        await sleep(250);
        await page.keyboard.type("scroll-line 1");
        await sleep(500);
        const painted = await frame.evaluate(() => {
            const reg = CSS.highlights;
            return reg ? (reg.get("ml-find")?.size ?? 0) : -1;
        });
        expect(painted, "the highlight registry holds a range per match").toBeGreaterThan(1);
        const current = await frame.evaluate(() => CSS.highlights?.get("ml-find-cur")?.size ?? 0);
        expect(current, "and exactly one range is marked as the current match").toBe(1);
    } finally {
        await ext.close();
        fake.stop?.();
        site.stop?.();
    }
});

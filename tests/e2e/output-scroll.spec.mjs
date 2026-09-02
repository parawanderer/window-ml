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
// ~60 lines paced ~120ms apart → ~7s of streaming: long enough to overflow the cell and to scroll mid-flight.
const EXEC_JS = `
const wait = (ms) => new Promise(r => setTimeout(r, ms));
for (let i = 1; i <= 60; i++) { console.log('scroll-line ' + i + ' ................................'); await wait(120); }
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

        // 4. Return to the bottom → following resumes.
        await scrollTo(cell, (el) => el.scrollHeight);
        await sleep(900);
        const gapAgain = await cell.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
        expect(gapAgain, "re-armed: back at the tail, following again").toBeLessThanOrEqual(24);
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
        const liveX = (await live.boundingBox()).x;
        // …then the SETTLED output's, once the step has a real result.
        await expect.poll(async () => frame.locator(".r-py-out").count(), { timeout: 25000 }).toBeGreaterThan(0);
        await sleep(400);
        const settledX = (await frame.locator(".r-py-out").last().boundingBox()).x;
        expect(Math.abs(settledX - liveX), "the Out content stays put when the live rail goes away").toBeLessThanOrEqual(1);
    } finally {
        await ext.close();
        fake.stop?.();
        site.stop?.();
    }
});

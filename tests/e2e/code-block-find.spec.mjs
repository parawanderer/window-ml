// code-block-find.spec.mjs — Ctrl/Cmd+F inside a rendered CODE BLOCK (an exec's code), in a real browser. jsdom has
// no layout, so the parts that matter here only exist in this file: the match is SCROLLED INTO VIEW by whatever holds
// the block (a code block does not scroll on its own), the bar STICKS in view while the block is taller than the
// panel, and the match is actually PAINTED through the highlight registry.
import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl, openRunInSidebar } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Far taller than the panel, so the line searched for starts well below the fold.
const LINES = 160;
const EXEC_JS = [...Array(LINES)].map((_, i) => `const needle_${i + 1} = ${i + 1};`).join("\n") + `\nreturn needle_${LINES};`;

test("code block find: the match scrolls into view, the bar stays on screen, the match paints", async () => {
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
        await page.evaluate(() => { window.ml.agent("define many constants", { approvalRouting: "both" }); });
        // Approve whatever asks (the dialect may also run it unasked), until the run has used its whole script.
        for (let i = 0; i < 150 && fake.calls().length < 2; i++) {
            await ext.sw.evaluate(() => {
                for (const d of globalThis.__mlApprovals?.list?.() || []) globalThis.__mlApprovals.resolve(d.key, true);
            });
            await sleep(100);
        }
        expect(fake.calls().length, "the run used its whole script").toBeGreaterThanOrEqual(2);

        const frame = await openRunInSidebar(page, { width: 700 });
        await expect.poll(() => frame.locator(".astep.tool.pending").count(), { timeout: 15000 }).toBe(0);
        await frame.locator(".astep.tool .astep-head").first().click();
        const block = frame.locator(".code-block").first();
        await expect(block).toBeVisible({ timeout: 10000 });
        // Precondition: the searched line starts OUT of view, or "it scrolled into view" proves nothing.
        const band = () => block.evaluate((el) => {
            let s = el.parentElement;
            for (; s; s = s.parentElement) {
                const ov = getComputedStyle(s).overflowY;
                if (s.scrollHeight > s.clientHeight + 1 && (ov === "auto" || ov === "scroll")) break;
            }
            if (!s) return { top: 0, bottom: window.innerHeight };
            const r = s.getBoundingClientRect();
            return { top: r.top, bottom: r.top + s.clientHeight };
        });
        // Measured on the TEXT, since the highlighter splits a line into spans and the gutter may be off.
        const lineRect = () => block.evaluate((el, n) => {
            const w = document.createTreeWalker(el.querySelector("pre.code"), NodeFilter.SHOW_TEXT);
            for (let t = w.nextNode(); t; t = w.nextNode()) {
                const at = t.data.indexOf(`needle_${n} `);
                if (at < 0) continue;
                const range = document.createRange();
                range.setStart(t, at); range.setEnd(t, at + `needle_${n}`.length);
                const r = range.getBoundingClientRect();
                return { top: r.top, bottom: r.bottom };
            }
            return null;
        }, LINES - 10);
        const before = await lineRect(), b0 = await band();
        expect(before && before.top > b0.bottom, "the target line starts below the fold").toBe(true);

        await block.click({ position: { x: 60, y: 30 } });
        await page.keyboard.press("Control+f");
        await expect(block.locator(".r-find")).toBeVisible();
        expect(await block.locator(".code-tools").isVisible(), "the toolbar steps aside for the bar").toBe(false);
        // The query box takes focus on a timer after the bar mounts: typing before that lands in the block, not the box.
        await expect(block.locator(".r-find-q")).toBeFocused();
        await page.keyboard.type(`needle_${LINES - 10} `);
        await expect(block.locator(".r-find-n")).toHaveText("1 of 1");
        await sleep(300);

        const hit = await lineRect(), b1 = await band();
        expect(hit.top >= b1.top - 2 && hit.bottom <= b1.bottom + 2, `the match is on screen (${JSON.stringify({ hit, b1 })})`).toBe(true);
        const bar = await block.locator(".r-find").evaluate((el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
        expect(bar.top >= b1.top - 2 && bar.bottom <= b1.bottom + 2, `the bar stuck in view (${JSON.stringify({ bar, b1 })})`).toBe(true);
        expect(await frame.evaluate(() => CSS.highlights?.get("ml-find")?.size ?? -1), "the match is painted").toBe(1);

        await page.keyboard.press("Escape");
        await expect(block.locator(".r-find")).toHaveCount(0);
        expect(await frame.evaluate(() => CSS.highlights?.get("ml-find")?.size ?? 0), "closing drops the paint").toBe(0);
    } finally {
        await ext.close();
        fake.stop?.();
        site.stop?.();
    }
});

// session-summary.spec.mjs — the sidebar detail header's per-session ⋮ in the real extension (docs/spec/SESSION_SUMMARY.md).
//
// The page and its lines are unit-tested (tests/session-summary.test.mjs) and the chat page's entries are in
// chat-web.spec.mjs. What only a real extension has is the sidebar's own route to them: a sessions port opened through
// services().connectSessions from the sidebar frame, an index row for the run the view shows, and the chat page's
// SessionActions drawn in a frame that loads only sidebar.css.
import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl, openRunInSidebar } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("the sidebar's detail header offers the session's actions, and Summary opens its page", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay" });
        fake.setScript([{ content: "done" }]);
        const page = await ext.context.newPage();
        await page.goto(`${fake.url}/api/version`);
        await waitForMl(page);
        await page.evaluate(() => { window.ml.agent("say hello"); });
        const frame = await openRunInSidebar(page, { task: "say hello" });
        // Wait for the RUN, not for something on screen: the one scripted turn answered.
        for (let i = 0; i < 100 && fake.calls().length < 1; i++) await sleep(100);

        const more = frame.getByRole("button", { name: "Session options" });
        await expect(more).toBeVisible({ timeout: 15000 });
        await more.click();
        const menu = frame.getByRole("menu", { name: "Session options" });
        await expect(menu.getByRole("menuitem", { name: "Summary" })).toBeVisible();
        await expect(menu.getByRole("menuitem", { name: "Pin to the top" })).toBeVisible();
        // The chat page's menu look, drawn from sidebar.css: a real sheet, not unstyled buttons.
        expect(await menu.evaluate((m) => getComputedStyle(m).borderRadius)).toBe("14px");
        await menu.getByRole("menuitem", { name: "Summary" }).click();

        const dialog = frame.getByRole("dialog");
        await expect(dialog).toBeVisible();
        await expect(dialog.locator('.sum-line[data-field="kind"] dd')).toHaveText("Agent run");
        await expect(dialog.locator('.sum-line[data-field="model"] dd')).toHaveText("fake-model");
        await expect(dialog.locator('.sum-line[data-field="state"] dd')).toHaveText(/finished|running/);
        await frame.locator("body").press("Escape");
        await expect(dialog).toHaveCount(0);
    } finally { await ext.context.close(); await fake.stop(); }
});

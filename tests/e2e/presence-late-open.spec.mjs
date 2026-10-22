// presence-late-open.spec.mjs — a page allowed AFTER the sidebar's app is up still shows its own runs
// (docs/spec/SITE_PRESENCE.md, step 2).
//
// A hidden page gets injected.js only once its origin is allowed, so the overlay's app can be listening before the
// page script exists. The bus goes live on the shell's `ready`; the app's own handshake sent that while the page was
// hidden, so the shell has to say it again when injected.js says hello. On CI's slower runners this order was the
// usual one and a page's run never reached the session list.
import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl, waitInShell, openRunInSidebar } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

test("a page allowed after the overlay's app loaded gets its run into the session list", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay" });
        fake.setScript([{ content: "done" }]);
        const page = await ext.context.newPage();
        await page.setViewportSize({ width: 1400, height: 950 });
        await page.goto(`${fake.url}/api/version`);
        await waitForMl(page, { approve: false });
        expect(await page.evaluate(() => "ml" in window), "precondition: the page is hidden").toBe(false);
        // The app first, while the page has no page script.
        await waitInShell(page, (roots) => !!roots.sidebar?.getElementById("ml-sb-tab"));
        await waitInShell(page, (roots) => { /** @type {HTMLElement} */ (roots.sidebar?.getElementById("ml-sb-tab")).click(); return true; });
        await expect.poll(() => page.frames().some((f) => /sidebar\.html/.test(f.url())), { timeout: 15000 }).toBe(true);
        const app = page.frames().find((f) => /sidebar\.html/.test(f.url()));
        await app.waitForLoadState("load");
        // Then the origin is allowed; the open page gets injected.js without a reload.
        await waitForMl(page);
        await page.evaluate(() => { void (/** @type {any} */ (window)).ml.agent("say done"); });
        // The oracle: the run's row is in the list to open (it throws "no session row" when the bus never went live).
        await openRunInSidebar(page, { task: "say done" });
    } finally { await ext.context.close(); await fake.stop(); }
});

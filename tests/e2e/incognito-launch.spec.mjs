// launchExtension({ incognito: true }): the harness turns on "Allow in Incognito" the way the chrome://extensions toggle
// does, and a private rendered fetch then RENDERS instead of returning the incognito guidance (cross-page.spec.mjs keeps
// the default, off, and asserts the guidance). The bench's spa-rendered task depends on this.
import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

test.describe.configure({ mode: "default" });

let ext, fake, site;
test.beforeAll(async () => {
    fake = await startFakeLlm({ model: "fake-model" });
    site = await startPageServer({});
    ext = await launchExtension({ incognito: true });
    await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", modelFilter: "", debugMode: "off" });
});
test.afterAll(async () => {
    await ext?.close();
    await fake?.stop();
    await site?.stop();
});

// --- incognito on at launch ---

test("the relaunched extension is allowed in incognito and is the worker the harness hands back", async () => {
    expect(await ext.sw.evaluate(() => new Promise((r) => chrome.extension.isAllowedIncognitoAccess(r)))).toBe(true);
    expect(new URL(ext.sw.url()).host).toBe(ext.extensionId);
});

test("a private rendered fetch renders the page instead of returning the incognito guidance", async () => {
    await configureExtension(ext.sw, { debugMode: "devtools", agentHudInDevtools: false });
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);
    const before = fake.calls().length;
    // Same origin, no credentials: free, and rendered in incognito (cross-page.spec.mjs, the same call with it off).
    fake.setScript([{ tool: "fetch_url", args: { url: site.url + "/spa", rendered: true } }, { content: "done" }]);
    await page.evaluate(() => { window.ml.agent("render /spa", { env: false, approvalRouting: "external" }); return true; });
    await expect.poll(() => fake.calls().length - before, { timeout: 30000 }).toBe(2);
    const result = JSON.stringify(fake.calls()[before + 1]?.messages || []);
    expect(result).toContain("SPA-RENDERED-9931");
    expect(/Allow in Incognito/i.test(result)).toBe(false);
    await page.close();
});

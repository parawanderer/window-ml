// remote-stream.spec.mjs — a run's live tool output reaches a REMOTE client: the standalone chat page, paired to this
// browser through a real hub, which is also the page the phone app shows in its WebView (native-embed.tsx builds
// from the same chat page). The run's exec prints a line and then waits on a call the test holds open, so "the line
// is on the client while the step is still running" is a state the test looks at rather than a race.
//
// Needs the pinned `wmlhub` binary (tests/fixtures/hub-harness.mjs); skipped with the reason when there is none.
import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { serveStatic } from "./static-server.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";
import { HAVE_HUB, NO_HUB, startHub } from "../fixtures/hub-harness.mjs";

test.skip(!HAVE_HUB, NO_HUB);

// The printed text is built at run time, so the source shown in the step's args can never be what a check finds.
const SURVEY = `console.log("before" + " the wait"); const ps = await ml.ps(); console.log("after" + " the wait"); return "done"`;

/** The client makes an account on the hub, and this browser joins it as a runtime (chat-pairing.spec.mjs walks the
 *  same screens with assertions). Returns the client page, on its session list. */
async function pairClient(ext, hub, web) {
    const client = await ext.context.newPage();
    await client.goto(`${web.url}client.html`);
    await client.getByRole("button", { name: "Create an account" }).click();
    await client.getByLabel("Hub", { exact: true }).fill(hub.url);
    await client.getByRole("button", { name: "Create it" }).click();
    await expect(client.locator(".chat")).toBeVisible({ timeout: 20_000 });
    const page = await ext.context.newPage();
    await page.goto(`chrome-extension://${ext.extensionId}/chat.html#/settings/devices`);
    await page.getByRole("button", { name: "Join an account" }).click();
    await page.getByLabel("Call this device").fill("Test laptop");
    await page.getByLabel("Hub", { exact: true }).fill(hub.url);
    await page.getByRole("button", { name: "Get a code" }).click();
    const code = (await page.locator(".pair-code").textContent()).trim();
    await client.goto(`${web.url}client.html#/settings/devices`);
    await client.getByRole("button", { name: "Pair a device" }).click();
    await client.getByLabel("Its code").fill(code);
    await client.getByRole("button", { name: "Find it" }).click();
    await client.getByRole("button", { name: "They match: pair it" }).click();
    await expect(page.locator(".pair-conn")).toContainText("Connected", { timeout: 20_000 });
    await page.close();
    await client.goto(`${web.url}client.html`);
    return client;
}

// --- live tool output on a remote client, read-only and approved ---

for (const readonly of [true, false]) {
    test(`a ${readonly ? "read-only" : "approved"} exec's console line reaches a paired client while the step is still running`, async () => {
        test.setTimeout(120_000);
        const fake = await startFakeLlm({ model: "fake-model" });
        const hub = await startHub();
        const web = await serveStatic("dist-web");
        const site = await startPageServer({});
        const ext = await launchExtension();
        try {
            await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model",
                debugMode: "off", autoApproveReadonly: readonly });
            const client = await pairClient(ext, hub, web);

            fake.setScript([{ tool: "exec", args: { js: SURVEY } }, { content: "Surveyed." }]);
            const page = await ext.context.newPage();
            await page.goto(site.url + "/");
            await waitForMl(page);
            fake.holdPs();
            await page.evaluate(() => { window.__run = window.ml.agent("survey the page remotely", { stream: true, approvalRouting: "both" }); window.__run.catch(() => {}); });
            if (!readonly) {
                await expect.poll(async () => (await ext.sw.evaluate(() => globalThis.__mlApprovals.list())).length, { timeout: 20_000 }).toBe(1);
                const [gate] = await ext.sw.evaluate(() => globalThis.__mlApprovals.list());
                await ext.sw.evaluate((key) => globalThis.__mlApprovals.resolve(key, true), gate.key);
            }

            const row = client.locator(".chat-row", { hasText: "survey the page remotely" });
            await expect(row).toBeVisible({ timeout: 30_000 });
            await row.click();
            // WHILE `ml.ps` is held: the first line is on the client, the second is not.
            const main = client.locator(".chat-main");
            const step = main.locator(".astep.tool").first();
            await expect(step).toBeVisible({ timeout: 20_000 });
            await step.locator(".astep-head, summary, [role=button]").first().click();
            try {
                await expect(step.locator(".r-ts-line", { hasText: "before the wait" })).toBeVisible({ timeout: 20_000 });   // the output cell's own line, stamped
            } finally {
                await client.screenshot({ path: test.info().outputPath("client-held.png") });
            }
            await expect(step).not.toContainText("after the wait");
            fake.releasePs();
            await page.evaluate(() => window.__run);
            await expect(main).toContainText("Surveyed.", { timeout: 20_000 });
        } finally {
            fake.releasePs();
            await ext.context.close();
            await web.close();
            await site.stop();
            hub.stop();
            await fake.stop();
        }
    });
}

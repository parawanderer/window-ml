import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

// THE SESSION INDEX, FED BY REAL PAGES: a page's own `ml.chat` reaches the background's cross-tab index (what the chat
// page's local host reads) through the content-script shell, which only a real browser runs. The unit tests cover the
// index and the port; this covers the shell's forwarding in each mode, including that off mode stays silent (and
// its corner card stays unmounted) unless `listPageSessions` is on.

/** Open an extension page subscribed to the `ml-sessions` index; returns a reader of its current rows. */
async function indexReader(ext) {
    const page = await ext.context.newPage();
    await page.goto(`chrome-extension://${ext.extensionId}/popup.html`);
    await page.evaluate(() => {
        const rows = new Map();
        globalThis.__rows = rows;
        const port = chrome.runtime.connect({ name: "ml-sessions" });
        port.onMessage.addListener((m) => {
            if (m.type !== "index") return;
            const u = m.update;
            if (u.type === "snapshot") { rows.clear(); for (const s of u.sessions) rows.set(s.id.hash, s); }
            else if (u.type === "upsert") rows.set(u.session.id.hash, u.session);
            else if (u.type === "remove") rows.delete(u.id.hash);
        });
        port.postMessage({ type: "sessions" });
    });
    return () => page.evaluate(() => [...globalThis.__rows.values()].map((s) => ({ kind: s.kind, status: s.status, task: s.task, url: s.page?.url })));
}

test("overlay mode: a page's own chat is listed, with the tab's URL", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay" });
        fake.setScript([{ content: "hello back" }]);
        const rows = await indexReader(ext);
        const page = await ext.context.newPage();
        await page.goto(site.url + "/");
        await waitForMl(page);
        await page.evaluate(() => window.ml.chat("hello from the overlay page"));
        await expect.poll(rows).toEqual([{ kind: "chat", status: "done", task: "hello from the overlay page", url: site.url + "/" }]);
    } finally { await ext.context.close(); await fake.stop(); await site.stop(); }
});

test("off mode: a page's own sessions are not listed until listPageSessions is on, and the corner card never mounts for them", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off" });
        fake.setScript([{ content: "a" }, { content: "b" }]);
        const rows = await indexReader(ext);
        const page = await ext.context.newPage();
        await page.goto(site.url + "/");
        await waitForMl(page);
        await page.evaluate(() => window.ml.chat("not reported"));
        // Nothing arrives: give a forward that should not happen the time a real one takes, then look.
        await page.waitForTimeout(500);
        expect(await rows()).toEqual([]);

        // The site is on the page-approval list, so its agent runs page-hosted: reported only by the page's own bus.
        await configureExtension(ext.sw, { listPageSessions: true, pageApprovalDomains: [new URL(site.url).hostname] });
        await page.reload();
        await waitForMl(page);
        // An agent, not a chat: the card mounts on agent events, so this is what would put it on screen for a run the
        // background does not host.
        const res = await page.evaluate(() => window.ml.agent("reported now", { maxSteps: 2 }));
        expect(res.summary).toBe("b");
        await expect.poll(rows).toEqual([{ kind: "agent", status: "done", task: "reported now", url: site.url + "/" }]);
        await expect(page.locator("#ml-sb-card")).toHaveCount(0);
    } finally { await ext.context.close(); await fake.stop(); await site.stop(); }
});

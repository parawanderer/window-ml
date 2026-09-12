import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

// REQUEST HINTS THROUGH THE REAL PIPELINE: page → content script → service worker → the request body. The unit
// tests mock the page's runtime messaging, so they cannot see a relay that drops the field; this reads what the
// server actually received (`fake.calls()`), for both places the agent loop can run and for a one-shot chat.

const chatBodies = (fake) => fake.calls().filter((b) => Array.isArray(b?.messages));

for (const [label, debugMode] of [["page-hosted (no debug surface)", "off"], ["background-hosted (overlay)", "overlay"]]) {
    test(`request hints: a ${label} run's steps are agent requests in its session, the second after a tool`, async () => {
        const fake = await startFakeLlm({ model: "fake-model" });
        const site = await startPageServer({});
        const ext = await launchExtension();
        try {
            await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode });
            fake.setScript([{ tool: "findByText", args: { text: "step" } }, { content: "done" }]);
            const page = await ext.context.newPage();
            await page.goto(site.url + "/");
            await waitForMl(page);
            const res = await page.evaluate(() => window.ml.agent("read the page", { maxSteps: 3 }));
            expect(res.summary).toBe("done");
            const hints = chatBodies(fake).map((b) => b.hint);
            const session = `wml-${res.hash}`;
            expect(hints.map(({ request, ...said }) => said)).toEqual([{ use: "agent", session }, { use: "agent", session, after: "tool" }]);
            expect(new Set(hints.map((h) => h.request)).size, "a distinct request id on every request").toBe(2);
        } finally { await ext.context.close(); await fake.stop(); await site.stop(); }
    });
}

test("request hints: a one-shot ml.chat carries only what the caller said", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off" });
        fake.setScript([{ content: "a" }, { content: "b" }]);
        const page = await ext.context.newPage();
        await page.goto(site.url + "/");
        await waitForMl(page);
        await page.evaluate(() => window.ml.chat("hi"));
        await page.evaluate(() => window.ml.chat("hi", { use: "interactive" }));
        const hints = chatBodies(fake).map(({ hint: { request, ...said } = {} }) => said);
        expect(hints[0], "no use, no session: only our correlation id goes out").toEqual({});
        expect(hints[1]).toEqual({ use: "interactive" });
    } finally { await ext.context.close(); await fake.stop(); await site.stop(); }
});

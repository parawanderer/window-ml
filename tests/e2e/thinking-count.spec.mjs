// thinking-count.spec.mjs — a STREAMED run started the way the Commander starts one labels its thinking with the
// ENGINE's count when the server gives one, and with an honest `~` estimate when it does not. The count is stamped in
// the service worker from the per-chunk usage, rides the step's usage to the sidebar, and only a real browser runs that
// whole path. Each case is a stream SHAPE measured against a real server (2026-09-16), not an invented one.
import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl, openRunInSidebar } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run a two-turn thinking agent the way the Commander does, and return the sidebar's thinking labels. */
async function thinkingLabels(fakeOpts) {
    const fake = await startFakeLlm({ model: "fake-model", ...fakeOpts });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay",
        });
        fake.setScript([
            { tool: "pageInfo", args: {}, reasoning: "I should look at where I am before answering anything at all." },
            { content: "You are on a demo page.", reasoning: "The page info says enough to answer the question now." },
        ]);
        const page = await ext.context.newPage();
        await page.setViewportSize({ width: 1400, height: 900 });
        await page.goto(site.url + "/");
        await waitForMl(page);
        // EXACTLY what the Commander's Send posts through the overlay shell (shell.ts, `startRun` → `__mlStartAgent`).
        await page.evaluate(() => window.postMessage({ __mlStartAgent: { task: "where am I?", stream: true, hud: "quiet" } }, "*"));
        for (let i = 0; i < 100 && fake.calls().length < 2; i++) await sleep(100);
        expect(fake.calls().length, "the run used its whole script").toBeGreaterThanOrEqual(2);
        expect(fake.calls().every((c) => c.stream === true), "the Commander's run streams").toBe(true);
        const frame = await openRunInSidebar(page, { task: "where am I?" });
        await expect.poll(() => frame.locator(".athinking:not(.live) .astep-tokest").count(), { timeout: 15000 }).toBe(2);
        return await frame.locator(".athinking .astep-tokest").allTextContents();
    } finally {
        await ext.close();
        fake.stop?.();
        site.stop?.();
    }
}

test("a server that counts: each thinking block shows the counted figure, not ~", async () => {
    const labels = await thinkingLabels({});
    for (const l of labels) expect(l, JSON.stringify(labels)).toMatch(/^\d[\d,]* tokens$/);
});

// OpenWebUI's own route on the reference box: no usage on any chunk until the last. There is no count taken while
// thinking, so the label must stay the estimate it is.
test("a server that reports usage only at the end: the thinking stays a ~ estimate", async () => {
    const labels = await thinkingLabels({ continuousUsage: false });
    for (const l of labels) expect(l, JSON.stringify(labels)).toMatch(/^~\d[\d,]* tokens$/);
});

// Ollama's /v1 passthrough on the reference box: a usage object on every chunk, its count stuck at 0 (the runner does
// not count). A 0 was taken as the thinking count and the block read "0 tokens" — an exact figure that was wrong.
test("a server whose running count stays 0: the thinking stays a ~ estimate, never '0 tokens'", async () => {
    const labels = await thinkingLabels({ zeroRunningCount: true });
    for (const l of labels) expect(l, JSON.stringify(labels)).toMatch(/^~\d[\d,]* tokens$/);
});

// The same passthrough spells the thinking channel `reasoning`, not `reasoning_content`, and the SSE parser read only
// the latter: the thinking text was dropped entirely.
test("ollama's `reasoning` spelling of the thinking channel is read, and counted", async () => {
    const labels = await thinkingLabels({ reasoningKey: "reasoning" });
    for (const l of labels) expect(l, JSON.stringify(labels)).toMatch(/^\d[\d,]* tokens$/);
});

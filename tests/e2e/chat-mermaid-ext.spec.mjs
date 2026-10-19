// chat-mermaid-ext.spec.mjs — a ```mermaid fence in a reply is drawn in the EXTENSION too: there the frame is a manifest
// `sandbox` page under its own strict CSP (no inline script, no eval), which the web build cannot test. Both surfaces a
// reply reaches: the chat page tab, and the sidebar overlay inside an ordinary page.
import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl, openRunInSidebar } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

const REPLY = "Here is the flow:\n\n```mermaid\ngraph TD\n  A[Ask] --> B{Tool?}\n  B -->|yes| C[Run it]\n  B -->|no| D[Answer]\n```\n\nThat is all.";

// --- the extension's sandboxed frame, on the chat page and in the overlay ---

test("a reply's diagram is drawn in the extension's chat page and in the page's sidebar, by the sandboxed frame", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay" });
        fake.setScript([{ content: REPLY }]);
        const tab = await ext.context.newPage();
        await tab.goto(site.url + "/");
        await waitForMl(tab);
        const hash = await tab.evaluate(async () => { const c = window.ml.createChat({}); await c.chat("draw the flow"); return c.hash; });

        // The chat page tab.
        const chat = await ext.context.newPage();
        const errors = [];
        chat.on("pageerror", (e) => errors.push(e.message));
        await chat.goto(`chrome-extension://${ext.extensionId}/chat.html`);
        await chat.locator(`.chat-row[data-session="local:${hash}"]`).click();
        const block = chat.locator(".chat-main .mmd");
        await expect(block).toHaveAttribute("data-mmd", "done", { timeout: 15_000 });
        expect(await block.locator("img.mmd-img").evaluate((i) => i.complete && i.naturalWidth > 50)).toBe(true);
        // The frame is the manifest's sandbox page: an opaque origin, so nothing in it reaches the extension's APIs.
        const frame = chat.frames().find((f) => f.url().endsWith("/mermaid.html"));
        expect(frame, "the sandboxed frame loaded").toBeTruthy();
        expect(await frame.evaluate(() => ({ origin, chrome: typeof globalThis.chrome?.runtime?.id }))).toEqual({ origin: "null", chrome: "undefined" });
        expect(errors).toEqual([]);

        // The overlay in the page the chat belongs to, while that page forges a "finished drawing" into every frame it
        // can reach: the sidebar's listener takes an answer only from its own diagram frame (mermaid-client.ts).
        await tab.evaluate(() => {
            const forge = () => { for (let i = 0; i < window.frames.length; i++) for (let id = 1; id < 20; id++) window.frames[i].postMessage({ mmd: "done", id, svg: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 9 9'><text>FORGED</text></svg>", w: 9, h: 9 }, "*"); };
            window.__forger = setInterval(forge, 5);
        });
        const sidebar = await openRunInSidebar(tab);
        // The sidebar is an extension frame inside a WEB page, so its nested frame loads only because mermaid.html is a
        // web-accessible resource (manifest.json); without that entry the block stays undrawn.
        const img = sidebar.locator(".mmd[data-mmd='done'] img.mmd-img");
        await expect(img).toBeVisible({ timeout: 15_000 });
        await tab.evaluate(() => clearInterval(window.__forger));
        const svg = await img.evaluate((i) => decodeURIComponent(i.src));
        expect(svg).not.toContain("FORGED");
        expect(svg).toContain("Ask");
    } finally { await ext.context.close(); await fake.stop(); await site.stop(); }
});

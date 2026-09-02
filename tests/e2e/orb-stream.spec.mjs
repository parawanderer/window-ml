// orb-stream.spec.mjs — end-to-end (real Chromium + built extension) proof that the HUD orb surfaces a LIVE
// token count during a streaming agent run. The whole point of the feature is liveness: a long reasoning
// phase must not sit as a frozen "Looking…" — a ticking count proves the pipe is alive. Deterministic via the
// scripted fake-LLM, whose SSE stream is PACED (streamDelayMs) so the reasoning phase lasts long enough to
// observe the count mid-stream. Off-mode → the run is background-hosted and the orb lives in the corner card.
import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

test("HUD orb (streaming): a live token count ticks in the corner-card orb during the reasoning phase", async () => {
    const fake = await startFakeLlm({ model: "fake-model", streamDelayMs: 90 });   // pace the SSE so reasoning lasts ~5s
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model",
            debugMode: "off",   // off → the run routes to the background and the HUD is the corner-card orb
        });
        // ONE streaming turn: a long REASONING phase (paced word-by-word), then the answer. During the
        // reasoning stream (before any reply content), the orb shows the thinking phase + a live "~N tok".
        const reasoning = Array.from({ length: 60 }, (_, i) => `reasoning-word-${i}`).join(" ");
        fake.setScript([{ reasoning, content: "The answer is 42." }]);

        const page = await ext.context.newPage();
        await page.goto(site.url + "/");
        await waitForMl(page);
        await page.evaluate(() => { window.__run = window.ml.agent("compute the answer", { stream: true }); });

        // The corner card mounts on the first agent event; find its sidebar iframe.
        await page.waitForFunction(() => !!document.getElementById("ml-sb-card")?.shadowRoot, null, { timeout: 20000 });
        const cardFrame = await (async () => {
            for (let i = 0; i < 100; i++) {
                const f = page.frames().find((fr) => /sidebar\.html/.test(fr.url()));
                if (f) return f;
                await new Promise((r) => setTimeout(r, 100));
            }
            throw new Error("the corner-card iframe never appeared");
        })();

        // Poll the orb caption for a live token count while the reasoning streams (bounded well under the ~5s
        // reasoning window). Capture the text we saw for a helpful failure message.
        let seen = "";
        for (let i = 0; i < 120; i++) {
            const txt = await cardFrame.locator(".card-orb-label").first().textContent().catch(() => null);
            if (txt) { seen = txt; if (/~\d[\d.]*k? tok/.test(txt)) break; }
            await new Promise((r) => setTimeout(r, 70));
        }
        expect(seen, `orb caption should carry a live token count; last saw: "${seen}"`).toMatch(/~\d[\d.]*k? tok/);
    } finally {
        await ext.close();
        fake.stop?.();
        site.stop?.();
    }
});

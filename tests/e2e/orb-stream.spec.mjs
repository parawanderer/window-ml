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
    // A STOCK server — one that ignores the ask for a running count — so the orb falls back to its estimate.
    const fake = await startFakeLlm({ model: "fake-model", streamDelayMs: 90, continuousUsage: false });   // pace the SSE so reasoning lasts ~5s
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
        // The count lives in `.card-orb-live`, its OWN span beside the label — the pill ellipsizes on width
        // and with the two concatenated it was the number that got cut. Read the whole orb so this asserts
        // the count is on screen, then check separately that it is in the span that cannot be truncated.
        let seen = "";
        for (let i = 0; i < 120; i++) {
            const txt = await cardFrame.locator(".card-orb").first().textContent().catch(() => null);
            if (txt) { seen = txt; if (/~\d[\d.]*k? tok/.test(txt)) break; }
            await new Promise((r) => setTimeout(r, 70));
        }
        expect(seen, `orb caption should carry a live token count; last saw: "${seen}"`).toMatch(/~\d[\d.]*k? tok/);
        const live = cardFrame.locator(".card-orb-live").first();
        await expect(live).toHaveText(/~\d[\d.]*k? tok/);
        // It must not shrink: whatever the label does, the readout is the part still telling you something.
        expect(await live.evaluate((el) => getComputedStyle(el).flexShrink)).toBe("0");
        expect(await cardFrame.locator(".card-orb-label").first().textContent()).not.toMatch(/tok/);
    } finally {
        await ext.close();
        fake.stop?.();
        site.stop?.();
    }
});

// THE FROZEN COUNTER. The estimate is built from the streamed reasoning and reply text, and a tool call's argument
// fragments are neither — so while a model wrote a call the count stood still. The engine's own running count
// (asked for with stream_options.continuous_usage_stats) keeps climbing through the call, and is shown exact.
test("HUD orb (streaming): the engine's own count is shown exact, and keeps climbing while a tool call is written", async () => {
    const fake = await startFakeLlm({ model: "fake-model", streamDelayMs: 120 });   // the patched server: counts every chunk
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off",
        });
        // A short think, then a LONG tool call streamed as forty argument fragments — no text at all for ~5s.
        const args = { text: "x".repeat(800) };
        fake.setScript([
            { tool: "findByText", args, emit: [{ kind: "think", text: "Let me look." }, ...Array.from({ length: 40 }, () => ({ kind: "call" }))] },
            { content: "done" },
        ]);
        const page = await ext.context.newPage();
        await page.goto(site.url + "/");
        await waitForMl(page);
        await page.evaluate(() => { window.__run = window.ml.agent("find it", { stream: true }); });
        await page.waitForFunction(() => !!document.getElementById("ml-sb-card")?.shadowRoot, null, { timeout: 20000 });
        const cardFrame = await (async () => {
            for (let i = 0; i < 100; i++) {
                const f = page.frames().find((fr) => /sidebar\.html/.test(fr.url()));
                if (f) return f;
                await new Promise((r) => setTimeout(r, 100));
            }
            throw new Error("the corner-card iframe never appeared");
        })();
        // Read the live count while the CALL streams: every reading after the think has landed moved no text.
        const counts = [];
        for (let i = 0; i < 80 && counts.length < 6; i++) {
            const txt = await cardFrame.locator(".card-orb-live").first().textContent().catch(() => null);
            const m = txt && /(\d[\d.,]*k?) tok/.exec(txt);
            if (m) {
                expect(txt, "an exact count carries no ~").not.toMatch(/~/);
                const n = Number(m[1].replace(/,/g, ""));
                if (!counts.length || n !== counts.at(-1)) counts.push(n);
            }
            await new Promise((r) => setTimeout(r, 150));
        }
        expect(counts.length, `the count kept moving during the tool call: ${counts}`).toBeGreaterThanOrEqual(4);
        expect(counts.every((n, i) => !i || n > counts[i - 1]), `a running total only climbs: ${counts}`).toBe(true);
        await page.evaluate(() => window.__run);
    } finally {
        await ext.close();
        fake.stop?.();
        site.stop?.();
    }
});

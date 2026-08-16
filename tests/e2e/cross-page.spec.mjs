// cross-page.spec.mjs — end-to-end (real Chromium + the built extension) tests for cross-page agent
// persistence. Deterministic by default: a scripted fake-LLM stands in for the model, so the REAL pipeline
// (background loop → tool delegation → page) runs with no Ollama. Point at a real backend with:
//     E2E_BACKEND=http://localhost:3000/api/chat/completions  E2E_MODEL=qwen3:32b  npm run test:e2e
// (then the scripted turns are ignored and the real model drives — slower, non-deterministic).

import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

const BACKEND = process.env.E2E_BACKEND;   // real-backend override (skips the fake)
let ext, fake, site;

test.beforeAll(async () => {
    fake = BACKEND ? null : await startFakeLlm({ model: "fake-model" });
    site = await startPageServer({});
    ext = await launchExtension();
    await configureExtension(ext.sw, {
        chatUrl: BACKEND || fake.url,
        apiKey: process.env.E2E_KEY || "",   // a hosted backend (e.g. Groq) needs the bearer token
        apiFormat: "openai",
        model: BACKEND ? (process.env.E2E_MODEL || "") : "fake-model",
        modelFilter: "",
        debugMode: "off",
    });
});

test.afterAll(async () => {
    await ext?.close();
    await fake?.stop();
    await site?.stop();
});

// Smoke: proves the whole harness — the extension loads, window.ml is live in the page main world, the
// background loop reaches the (fake) backend, and a one-shot agent run resolves with the model's reply.
test("smoke: the extension loads and window.ml runs a one-shot agent", async () => {
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);

    if (fake) fake.setScript([{ content: "hello from the harness" }]);
    const result = await page.evaluate(() => window.ml.agent("Say hello.", { env: false }));
    expect(JSON.stringify(result)).toContain(BACKEND ? "" : "hello from the harness");
    await page.close();
});

// A real-shape sanity check that ALSO runs in the non-blocking real-model job: the agent reads a value off
// the page with a DOM tool and answers it. Deterministic under the fake (a hard gate); a genuine "can a
// real OpenAI-shaped model actually drive a tool and answer" probe under E2E_BACKEND.
test("sanity: the agent reads a value off the page via a DOM tool and answers with it", async () => {
    const page = await ext.context.newPage();
    await page.goto(site.url + "/step3");
    await waitForMl(page);
    if (fake) fake.setScript([
        { tool: "findByText", args: { text: "CROSSPAGE" } },
        (req) => {
            const seen = req.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join(" ");
            const m = seen.match(/CROSSPAGE-\d+/);
            return { content: m ? `The code is ${m[0]}.` : "not found" };
        },
    ]);
    const result = await page.evaluate(() =>
        window.ml.agent("What code is shown on this page? Use findByText to locate it, then answer with just the code."));
    expect(JSON.stringify(result)).toContain("CROSSPAGE-9471");
    await page.close();
});

// The acceptance test for the feature under construction. Skipped until the navigate tool + nav barrier +
// re-adopt land; flip to `test(...)` then. Script: navigate to /step2, then /step3, read the code, answer.
test.skip("cross-page: a background run survives a same-origin navigation and reads the far page", async () => {
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);

    fake.setScript([
        { tool: "navigate", args: { url: "/step2" } },
        { tool: "navigate", args: { url: "/step3" } },
        { tool: "findByText", args: { text: "CROSSPAGE" } },
        // final answer echoes the code the REAL findByText read off /step3 (proves the tool ran post-nav)
        (req) => {
            const readText = req.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join(" ");
            const m = readText.match(/CROSSPAGE-\d+/);
            return { content: m ? `The code is ${m[0]}.` : "I could not find the code." };
        },
    ]);
    const result = await page.evaluate(() =>
        window.ml.agent("Go to step 2, then step 3, and tell me the code shown on step 3."));
    expect(JSON.stringify(result)).toContain("CROSSPAGE-9471");
    // …and the run really walked the pages, not stalled on page 1.
    expect(page.url()).toContain("/step3");
    await page.close();
});

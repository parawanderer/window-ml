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

// The acceptance test for cross-page persistence. The default toolset includes `exec` (an approval tool),
// so under debugMode:"off" on a non-whitelisted origin the run is BACKGROUND-hosted — the durable spine that
// survives the navigation. Script: navigate to /step2, then /step3, read the code, answer.
//
// We do NOT await ml.agent()'s return: the caller's page main-world context is DESTROYED by the navigation,
// so its promise can never resolve back into page.evaluate (that's the whole reason the loop must live in
// the background). Instead we observe the run through the STABLE fake-LLM, which sees every model turn.
test("cross-page: a background run survives a same-origin navigation and reads the far page", async () => {
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);

    const before = fake.calls().length;   // calls accumulate across tests → measure THIS run's tail
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
    // Fire-and-forget: the promise dies with the page context; the background run carries on.
    await page.evaluate(() => { window.ml.agent("Go to step 2, then step 3, and tell me the code shown on step 3."); return true; });

    // All FOUR model turns fired → the loop kept stepping across BOTH navigations (re-adopting each new page).
    await expect.poll(() => fake.calls().length - before, { timeout: 20000 }).toBe(4);
    // The real proof of re-adoption: the DOM tool ran on /step3 and the code it read reached the model's final
    // turn. A FAILED adopt would feed the model a "no active run" error instead — so this string can't appear.
    const seen = (fake.calls().at(-1).messages || []).map((m) => (typeof m.content === "string" ? m.content : "")).join(" ");
    expect(seen).toContain("CROSSPAGE-9471");
    expect(page.url()).toContain("/step3");
    await page.close();
});

// Overlay/off HUD replay-across-nav: the destination page must receive the run's PRE-nav history (start +
// early steps), so a fresh card can rebuild mid-run instead of only showing the tail. We tag each debug
// event with the URL it arrived on; a `kind:"agent"` / step-1 event landing on /step3 can ONLY be the
// background replay (the fresh /step3 document never emits the run start itself — it's background-hosted).
test("cross-page: the destination page replays the run's pre-nav history", async () => {
    const page = await ext.context.newPage();
    const events = [];
    await page.exposeFunction("__cpEvent", (e) => events.push(e));
    await page.addInitScript(() => {
        if (window.top !== window) return;   // top frame only (avoid an overlay iframe double-capture)
        window.addEventListener("message", (e) => {
            if (e.data && e.data.__mlDebug) window.__cpEvent({ url: location.pathname, kind: e.data.__mlDebug.kind, step: e.data.__mlDebug.step ?? null, fromBg: !!e.data.__mlFromBg });
        });
    });
    await page.goto(site.url + "/");
    await waitForMl(page);

    const before = fake.calls().length;
    fake.setScript([
        { tool: "navigate", args: { url: "/step2" } },
        { tool: "navigate", args: { url: "/step3" } },
        { tool: "findByText", args: { text: "CROSSPAGE" } },
        (req) => {
            const seen = req.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join(" ");
            const m = seen.match(/CROSSPAGE-\d+/);
            return { content: m ? `The code is ${m[0]}.` : "not found" };
        },
    ]);
    await page.evaluate(() => { window.ml.agent("Go to step 2, then step 3, and read the code.", { env: false }); return true; });
    await expect.poll(() => fake.calls().length - before, { timeout: 20000 }).toBe(4);
    await expect.poll(() => events.some((e) => e.url.includes("/step3") && e.kind === "agent-result"), { timeout: 10000 }).toBe(true);

    const onStep3 = events.filter((e) => e.url.includes("/step3"));
    // The run START replayed onto /step3 (fresh doc → could only come from the background buffer)…
    expect(onStep3.some((e) => e.kind === "agent" && e.fromBg)).toBe(true);
    // …and an EARLY step (the step-1 navigate, emitted while on "/") replayed too.
    expect(onStep3.some((e) => e.kind === "agent-step" && e.step === 1)).toBe(true);
    await page.close();
});

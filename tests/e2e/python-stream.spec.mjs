// python-stream.spec.mjs — end-to-end proof that python_exec's print() output streams LIVE to the page.
// This exercises the whole reverse channel that no unit test can: the offscreen Pyodide WORKER's stdout tee →
// offscreen → background → content → page → the tool's ctx.stream → an agent-step `streamOutput` delta on the
// debug bus. A page-hosted (overlay) run under the deterministic fake-LLM; the python bundle is required, so
// the test self-skips when it's absent (mirrors tests/python.test.mjs).
import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HAS_PYODIDE = existsSync(join(HERE, "../../dist/pyodide/pyodide.mjs"));

test("python_exec streams print() output live (worker → page ctx.stream → streamOutput delta)", async () => {
    test.skip(!HAS_PYODIDE, "needs the bundled Pyodide (npm run fetch-pyodide) — self-skips without it");
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model",
            // `overlay` → the run is BACKGROUND-hosted (design A), which is how a real run with a debug
            // surface works — so this exercises the full reverse channel: worker stdout → offscreen → SW →
            // page (ml.pythonExec progress) → the tool's ctx.stream → PAGE_TOOL_STREAM → SW → the loop's fan.
            debugMode: "overlay",
            autoApprovePython: true,    // readonly python auto-approves, so no gate blocks the run
        });
        // Turn 1: run python that PRINTS two lines then sleeps briefly (so the deltas propagate before the
        // final result). Turn 2: answer. The prints must reach the page as live streamOutput deltas.
        fake.setScript([
            { tool: "python_exec", args: { code: "print('LIVE-ALPHA'); print('LIVE-BETA'); import time; time.sleep(1)", mode: "readonly" } },
            { content: "Done." },
        ]);

        const page = await ext.context.newPage();
        await page.goto(site.url + "/");
        await waitForMl(page);
        // Collect every agent-step debug event carrying a live streamOutput (posted on the page window).
        await page.evaluate(() => {
            window.__deltas = [];
            window.addEventListener("message", (e) => {
                const d = e.data && e.data.__mlDebug;
                if (d && d.kind === "agent-step" && d.streamOutput != null) window.__deltas.push(d.streamOutput);
            });
        });
        await page.evaluate(() => window.ml.agent("run the code", { stream: true, extraTools: [window.ml.pythonTool()] }));

        // Poll until a delta carries the printed text (the whole chain worked), bounded well past the ~1s run.
        let seen = [];
        for (let i = 0; i < 150; i++) {
            seen = await page.evaluate(() => window.__deltas || []);
            if (seen.some((d) => /LIVE-ALPHA/.test(d))) break;
            await new Promise((r) => setTimeout(r, 100));
        }
        expect(seen.some((d) => /LIVE-ALPHA/.test(d)), `a stream delta should carry the printed output; saw: ${JSON.stringify(seen).slice(0, 300)}`).toBe(true);
    } finally {
        await ext.close();
        fake.stop?.();
        site.stop?.();
    }
});

// python-kernel-death.spec.mjs — a cell that kills Pyodide in real Chromium: the fatal error is answered at once as the
// kernel's death, and the run's next cell gets a fresh interpreter that says its namespace was reset. Real Chromium,
// because where a parse overflows the stack depends on the engine's stack: Node overflows near 2,000 attributes, a
// Chromium worker compiles 3,000 and dies at 10,000 (measured 2026-11-18, docs/dev/python-sandbox.md). Self-skips
// without the bundled Pyodide.
import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { launchExtension, configureExtension, waitForMl, approveGates } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HAS_PYODIDE = existsSync(join(HERE, "../../dist/pyodide/pyodide.mjs"));

/** A cell whose compile overflows the JS stack inside Pyodide's parser: a fatal error, never a Python exception. */
const KILLER = `compile("obj" + ".a" * 30000 + "()", "k", "exec")`;

test("a cell that kills Pyodide is answered as the kernel's death, not a timeout, and the next cell runs in a fresh interpreter", async () => {
    test.skip(!HAS_PYODIDE, "needs the bundled Pyodide (npm run fetch-pyodide) — self-skips without it");
    test.setTimeout(120_000);
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay", autoApprovePython: true });
        fake.setScript([
            { tool: "python_exec", args: { code: "x = 41\nprint('BEFORE')" } },
            { tool: "python_exec", args: { code: "print('KEPT', 'x' in globals())" } },
            { tool: "python_exec", args: { code: KILLER } },
            { tool: "python_exec", args: { code: "print('AFTER', 'x' in globals())" } },
            { content: "Done." },
        ]);
        const page = await ext.context.newPage();
        await page.goto(site.url + "/");
        await waitForMl(page);
        approveGates(ext);
        // A worker-hosted run: its cells share one namespace (`run:<id>`), which is what a dead kernel loses.
        const tabId = await ext.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(u))?.id, site.url);
        await ext.sw.evaluate((id) => globalThis.__mlStartUserRunForTest(id, { task: "run the code", hud: "quiet", surface: "hud" }, { approvalRouting: "both" }), tabId);
        await expect.poll(() => fake.calls().length, { timeout: 90_000 }).toBeGreaterThanOrEqual(5);
        const tools = (fake.calls()[4].messages ?? []).filter((m) => m.role === "tool").map((m) => String(m.content));
        expect(tools.length, JSON.stringify(tools).slice(0, 600)).toBe(4);
        const [, kept, died, after] = tools;
        expect(kept, "the control: the run's cells share one namespace").toMatch(/KEPT True/);
        expect(died, "the cell's own answer names the kernel's death").toMatch(/Python interpreter crashed/);
        expect(died, "and says what was lost").toMatch(/defined before .* gone/);
        expect(died, "never the watchdog's timeout").not.toMatch(/exceeded \d+s/);
        expect(after, "the next cell ran").toMatch(/AFTER False/);
        expect(after, "in a fresh interpreter that says its namespace was reset").toMatch(/namespace reset at .*the interpreter crashed/);
    } finally {
        await ext.close();
        fake.stop?.();
        site.stop?.();
    }
});

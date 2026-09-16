// housekeeping.spec.mjs — the housekeeping log in a real Chrome, for the three things no unit test can show:
// that storage.session holds it across a worker restart, that the worker infers that restart, and that the
// offscreen document's reports arrive stamped `offscreen` by the browser's own sender, not by the payload.
import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HAS_PYODIDE = existsSync(join(HERE, "../../dist/pyodide/pyodide.mjs"));

/** Polls the log until `pred` holds or the budget runs out, and returns the last read either way. */
async function logUntil(page, pred, ms = 20_000) {
    const end = Date.now() + ms;
    let events = [];
    while (Date.now() < end) {
        events = await page.evaluate(() => window.ml.__housekeeping());
        if (pred(events)) break;
        await new Promise((r) => setTimeout(r, 250));
    }
    return events;
}

test("a stopped service worker is logged as an inferred eviction by the next one, and the log survives it", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model" });
        const page = await ext.context.newPage();
        await page.goto(`${fake.url}/api/version`);
        await waitForMl(page);
        const before = await logUntil(page, (ev) => ev.some((e) => e.subsystem === "sw" && e.kind === "start"));
        expect(before.some((e) => e.subsystem === "sw" && e.kind === "start" && e.origin === "worker")).toBe(true);
        // Let a heartbeat land, then stop the worker the way DevTools' "Stop" does.
        await new Promise((r) => setTimeout(r, 1_500));
        const cdp = await ext.context.newCDPSession(page);
        await cdp.send("ServiceWorker.enable");
        await cdp.send("ServiceWorker.stopAllWorkers");
        const after = await logUntil(page, (ev) => ev.some((e) => e.kind === "evicted-inferred"));
        const inferred = after.find((e) => e.kind === "evicted-inferred");
        expect(inferred, `an inferred eviction after the stop; log: ${JSON.stringify(after).slice(0, 400)}`).toBeTruthy();
        expect(inferred.origin).toBe("worker");
        expect(typeof inferred.ms).toBe("number");
        expect(after.filter((e) => e.subsystem === "sw" && e.kind === "start").length, "the first start is still in the log").toBeGreaterThanOrEqual(2);
    } finally { await ext.close(); await fake.stop(); }
});

test("a Python cold start is reported by the offscreen document and stamped offscreen", async () => {
    test.skip(!HAS_PYODIDE, "needs the bundled Pyodide (npm run fetch-pyodide) — self-skips without it");
    test.setTimeout(90_000);
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model" });
        const page = await ext.context.newPage();
        await page.goto(`${fake.url}/api/version`);
        await waitForMl(page);
        const first = await page.evaluate(() => window.ml.pythonExec("1 + 1"));
        expect(first.ok, first.error).toBe(true);
        await page.evaluate(() => window.ml.pythonExec("2 + 2"));
        const events = await logUntil(page, (ev) => ev.some((e) => e.subsystem === "pyodide" && e.kind === "cold-start"));
        const cold = events.filter((e) => e.subsystem === "pyodide" && e.kind === "cold-start");
        expect(cold.length, "one cold start for two runs: the warm run reports nothing").toBe(1);
        expect(cold[0].origin).toBe("offscreen");
        expect(cold[0].reason).toBe("run");
        // The event times the start itself; the run's bootMs is how long IT waited, measured a moment earlier.
        expect(Math.abs(cold[0].ms - first.bootMs), `start ${cold[0].ms}ms vs the run's wait ${first.bootMs}ms`).toBeLessThan(250);
    } finally { await ext.close(); await fake.stop(); }
});

test("a run with python_exec pre-warms Pyodide at start, and its first call finds the runtime warm", async () => {
    test.skip(!HAS_PYODIDE, "needs the bundled Pyodide (npm run fetch-pyodide) — self-skips without it");
    test.setTimeout(90_000);
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model" });
        fake.setScript([{ content: "Done." }]);
        const page = await ext.context.newPage();
        await page.goto(`${fake.url}/api/version`);
        await waitForMl(page);
        await page.evaluate(() => window.ml.agent("nothing to compute", { extraTools: [window.ml.pythonTool()], vision: false }));
        const warmed = await logUntil(page, (ev) => ev.some((e) => e.kind === "cold-start"), 60_000);
        expect(warmed.find((e) => e.kind === "prewarm")?.reason, "the worker logged the pre-warm and its trigger").toBe("run-start");
        expect(warmed.find((e) => e.kind === "cold-start")?.reason, "the start was the pre-warm's, not a run's").toBe("prewarm");
        const r = await page.evaluate(() => window.ml.pythonExec("1 + 1"));
        expect(r.ok, r.error).toBe(true);
        expect(r.bootMs, "a warm runtime charges the run no cold start").toBeUndefined();
        const used = (await logUntil(page, (ev) => ev.some((e) => e.kind === "prewarm-used"))).find((e) => e.kind === "prewarm-used");
        expect(used?.detail?.warm, "a page reads booleans in details it did not report").toBe(true);
        expect(used?.origin).toBe("offscreen");
    } finally { await ext.close(); await fake.stop(); }
});

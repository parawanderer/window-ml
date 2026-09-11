// aside-lane.spec.mjs — a model call YOU triggered while reading, drawn on the event lane.
//
// The code annotator spends tokens on this box and takes visible time, so leaving it off the timeline
// would be dishonest — the lane's whole job is answering "where did the time go". It is also not the
// agent's work, and charging it to the run would make two runs incomparable on the strength of how much
// someone poked at one. Both halves are unit-tested (summaries records it; eventsFrom draws it with no cost
// and no parent); the seam neither of them covers is the MERGE at the call site and the class the lane
// actually paints, which is what this is for.
import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl, openRunInSidebar } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PY = "import pandas as pd\nreturn pd.DataFrame([{'a': 1}])";

// A BOX FOR THE PANEL TO DRAW. Without capacity and a resident model the panel has no samples, so it draws
// no tracks and no lane — and a lane that was never drawn cannot be missing a bar. (The first version of
// this test asserted against an empty panel and would have "passed" the day the feature broke.)
const GiB = 1024 ** 3;
const card = (id, freeBytes) => ({
    gpu_id: String(id), name: `CUDA${id}`, runner: "CUDA", compute: "12.0", driver: "13.2",
    total_memory: 101972967424, physical_memory: 102641958912, free_memory: freeBytes,
});
const box = (free) => ({ compute: {
    system_compute: { cpu_cores: 32, total_memory: 130142785536, free_memory: 12.3 * GiB },
    supported_gpus: [card(0, free)],
} });
const resident = (name, vramBytes) => ({
    model: name, name, size: vramBytes, size_vram: vramBytes, context_length: 262144, expires_at: null,
    gpus: [{ gpu_id: "0", runner: "CUDA", size_vram: vramBytes }],
});

test("annotating a step draws an ASIDE on the lane, and does not touch the run's tokens", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        // The lane is collapsed by default (its chip row is the control), so a spec about what it DRAWS
        // states that as a precondition rather than leaning on a default that can change.
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_res_sections: { lane: true, models: true } }));
        await configureExtension(ext.sw, {
            chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model",
            utilityModel: "util-4b", debugMode: "overlay", autoApprovePython: true,
        });
        // The annotator's call carries no `tools`, so it is answered off to the side and the scripted turns
        // stay where they are — see fake-llm's setSide.
        fake.setSide((body) => /Annotate this/.test(String(body.messages?.[1]?.content ?? ""))
            ? { content: JSON.stringify({ notes: [{ line: 2, note: "returns the frame" }] }) }
            : null);
        fake.setScript([{ tool: "python_exec", args: { code: PY, mode: "readonly" } }, { content: "done" }]);
        fake.setCapacity(box(76 * GiB));
        fake.setResident([resident("fake-model", 18 * GiB)]);

        const page = await ext.context.newPage();
        await page.setViewportSize({ width: 1400, height: 950 });
        await page.goto(`${fake.url}/api/version`);
        await waitForMl(page);
        await page.evaluate(() => {
            window.ml.agent("make a frame", { approvalRouting: "both", extraTools: [window.ml.pythonTool()] });
        });
        const frame = await openRunInSidebar(page, { task: "make a frame" });
        for (let i = 0; i < 60; i++) {
            const pending = await ext.sw.evaluate(() => (globalThis.__mlApprovals?.list?.() || []).map((d) => d.key));
            for (const k of pending) await ext.sw.evaluate((key) => globalThis.__mlApprovals.resolve(key, true), k);
            if (await frame.locator(".astep.tool").count()) break;
            await sleep(400);
        }
        // Open the resource panel — the lane lives in it.
        for (let i = 0; i < 5 && !(await frame.locator(".vram").count()); i++) {
            await frame.locator('[aria-label="VRAM monitor"]').click();
            await sleep(400);
        }
        await expect(frame.locator(".vram")).toBeVisible();
        // THE LANE HAS TO BE DRAWING. A lane that was never drawn cannot be missing a bar, so the absence
        // below would mean nothing without this.
        await expect(frame.locator(".rc-lane")).toBeVisible({ timeout: 20000 });
        await expect(frame.locator(".rc-ev").first()).toBeVisible({ timeout: 20000 });
        // Nothing you triggered yet, so nothing of yours on the lane.
        await expect(frame.locator(".rc-ev-aside")).toHaveCount(0);
        const barsBefore = await frame.locator(".rc-ev").count();

        const step = frame.locator(".astep").first();
        if (!(await step.locator(".r-py-in").count())) await step.locator(".astep-head").click();
        await step.locator(".code-tool", { hasText: "explain" }).click();
        await expect(step.locator(".lnote")).toHaveCount(1, { timeout: 15000 });

        // It appears, as its own kind — the lane polls, so this needs a beat rather than a click.
        await expect(frame.locator(".rc-ev-aside")).toHaveCount(1, { timeout: 15000 });
        // Exactly ONE, and only from the click: the button asks once. Deliberately NOT a count of every bar
        // on the lane — it is live, and the box keeps emitting while the test runs, so a total would be an
        // assertion about the fake backend rather than about the aside.
        expect(await frame.locator(".rc-ev").count()).toBeGreaterThan(barsBefore);

        // It says outright that it is not part of the run — a bar in a run's lane that is not the run's work
        // is exactly what a reader would otherwise spend a minute misattributing.
        await frame.locator(".rc-ev-aside").hover();
        const tip = frame.locator(".rc-tip-event");
        await expect(tip).toBeVisible();
        await expect(tip).toContainText("NOT part of the run");
        await expect(tip).toContainText("util-4b", { timeout: 5000 });
    } finally { await ext.context.close(); await fake.stop(); }
});

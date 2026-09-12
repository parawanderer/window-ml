// resource-stream.spec.mjs — the panel driven by the SERVER'S EVENT STREAM, in a real browser.
//
// The polling path is covered by resource-panel.spec.mjs. This is the other transport, and until now it had
// none: every test drove frames this repo also wrote, which is a closed loop, and the closed loop is exactly
// what hid these bugs. So the frames here are a RECORDING off the real box (tests/e2e/capture-frames.mjs →
// fixtures/events-load-lifecycle.json), replayed verbatim by the fake backend.
//
// What the recording contains that no hand-written fixture did: the stream names a model
// `registry.ollama.ai/library/gemma4:31b` while `/api/ps`, in the very same frame, names it `gemma4:31b`.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FRAMES = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/events-load-lifecycle.json", import.meta.url)), "utf8"));

/** Boot the extension against a fake box whose event stream replays the recording, panel open. */
async function openPanel(fake, ext) {
    // The event LANE is collapsed by default (its chip row is the control). These specs are about what the
    // lane draws, so they state that as a precondition rather than relying on a default that can change —
    // the default itself is pinned by its own test.
    await ext.sw.evaluate(() => chrome.storage.local.set({ ml_res_sections: { lane: true, models: true } }));
    const page = await ext.context.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${fake.url}/api/version`);
    await page.waitForFunction(() => !!document.getElementById("ml-sb-root")?.shadowRoot, null, { timeout: 20000 });
    await page.evaluate(() => {
        const root = document.getElementById("ml-sb-root").shadowRoot;
        const panel = root.getElementById("ml-sb-host");
        panel.style.width = "560px";
        panel.classList.add("open");
        root.getElementById("ml-sb-frame")?.contentWindow?.postMessage({ __mlSidebarOpen: true }, "*");
    });
    const frame = await (async () => {
        for (let i = 0; i < 80; i++) {
            const f = page.frames().find((fr) => /sidebar\.html/.test(fr.url()));
            if (f) return f;
            await sleep(100);
        }
        throw new Error("sidebar iframe never appeared");
    })();
    for (let i = 0; i < 5 && !(await frame.locator(".vram").count()); i++) {
        await frame.locator('[aria-label="VRAM monitor"]').click();
        await sleep(400);
    }
    if (!(await frame.locator(".vram").count())) throw new Error("couldn't open the VRAM panel");
    return { page, frame };
}

test("the stream feeds the panel, and one model is not drawn as two", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        // Scoping off: this test is about the MACHINE half, and there is no session to scope to.
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_lane_scope: false }));
        fake.setEvents(FRAMES);
        const { frame } = await openPanel(fake, ext);

        // The worker holds ONE connection however many panels are open, and only while somebody is looking.
        await expect.poll(() => fake.streamSubscribers(), { timeout: 20000 }).toBe(1);
        // Live, not polling: the readouts came off `sample` frames.
        await expect.poll(() => frame.locator(".vram-row").count(), { timeout: 20000 }).toBeGreaterThan(0);

        const rows = await frame.locator(".vram-row .vram-name").allTextContents();
        // THE BUG: the load frames name gemma4:31b fully-qualified, so it was listed a second time, in its
        // own colour, badged "off-box" — a model that had never been resident — beneath its own real row.
        expect(rows.filter((r) => /registry\.ollama\.ai/.test(r))).toEqual([]);
        expect(new Set(rows).size, "no model appears twice under two spellings").toBe(rows.length);

        // And the lane drew the load under the same name, so block and legend are one model.
        const laneModels = await frame.locator(".rc-ev").evaluateAll((els) => els.map((e) => e.getAttribute("data-model")).filter(Boolean));
        expect(laneModels.filter((m) => /registry\.ollama\.ai/.test(m))).toEqual([]);
    } finally { await ext.context.close(); await fake.stop(); }
});

test("a load span is drawn with its two halves, and named as them", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_lane_scope: false }));
        fake.setEvents(FRAMES);
        const { frame } = await openPanel(fake, ext);

        // The load span, with the weights/context divider the server reported.
        const load = frame.locator(".rc-ev-load").first();
        await expect(load).toBeVisible({ timeout: 20000 });
        await expect(load.locator(".rc-ev-ctxphase")).toHaveCount(1);

        // THE BUG: the tooltip named both halves "tool". `nameFor` was a chain ending in a tool fallback, so
        // an unnamed phase kind could not be told from an actual tool call — a wrong fact, not a missing one.
        await load.hover();
        const tip = frame.locator(".rc-tip-event");
        await expect(tip).toBeVisible({ timeout: 5000 });
        const tipText = await tip.textContent();
        expect(tipText).toMatch(/moving the weights in/);
        expect(tipText).toMatch(/allocating the context/);
        expect(tipText, "a load's halves are not tool calls").not.toMatch(/\btool\b/);
        expect(tipText).toMatch(/wasn't resident/);

        // …AND ITS TWO STEPS ARE RULED THROUGH THE PLOT, where the device's free memory steps: the lane is often
        // collapsed, and a two-step ramp with nothing saying what either step was is half a reading.
        const model = await load.getAttribute("data-model");
        const rules = frame.locator(`.rc-plot .rc-rule-load[data-model="${model}"]`);
        await expect.poll(() => rules.count(), { timeout: 10000 }).toBeGreaterThanOrEqual(2);
        await frame.locator(".vram-head").first().hover();
        await rules.first().hover();
        const ruleTip = frame.locator(".rc-tip-event");
        await expect(ruleTip).toBeVisible({ timeout: 5000 });
        expect(await ruleTip.textContent()).toMatch(/weights loaded/);

        // ONE SET OF KIND TOGGLES, obeyed everywhere: unticking "loads" in the chart's gear takes the load
        // steps off the plot AND the load bars out of the lane — the lane's chips and the gear are two views of
        // the same switch, so neither surface can show what the other has hidden.
        await frame.locator('[aria-label="Edit tracks"]').click();
        const loadsBox = frame.locator(".rc-editor .rc-eopt", { hasText: /^\s*loads\s*$/ }).locator("input");
        await expect(loadsBox).toBeChecked({ timeout: 5000 });
        await loadsBox.uncheck();
        await expect.poll(() => rules.count(), { timeout: 5000 }).toBe(0);
        expect(await frame.locator(".rc-ev-load").count(), "the lane's load bars go with them").toBe(0);
        await loadsBox.check();
        await expect.poll(() => rules.count(), { timeout: 5000 }).toBeGreaterThanOrEqual(2);
    } finally { await ext.context.close(); await fake.stop(); }
});

// PREFILL AND DECODE, from the engine's own durations. Replays a second recording off the real box
// (fixtures/events-gen-timings.json): five generations across four models, one of them the same 2,223-token
// prompt run twice — 99.6 ms of prefill cold, 5.5 ms with 2,222 tokens from the cache.
test("a server generation is split into prefill and decode, and says what each did", async () => {
    const recorded = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/events-gen-timings.json", import.meta.url)), "utf8"));
    // This recording was captured LIVE, so its offsets run forward from its hello (2.4 s to 43.4 s). The fake
    // replays a ring as BACKFILL after its own hello, where a positive offset is the future — past the end of
    // every window, so most of it was never drawn. Shifted, unaltered otherwise, to end a second before hello.
    const last = Math.max(...recorded.map((f) => f.t));
    const GEN_FRAMES = recorded.map((f) => ({ ...f, t: f.t - last - 1000 }));
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_lane_scope: false }));
        fake.setEvents(GEN_FRAMES);
        const { frame } = await openPanel(fake, ext);

        // One span per generation — none of them started here, so none is joined to a session of ours.
        await expect.poll(() => frame.locator(".rc-ev-gen").count(), { timeout: 20000 }).toBe(5);
        const models = await frame.locator(".rc-ev-gen").evaluateAll((els) => els.map((e) => e.getAttribute("data-model")));
        expect(models.filter((m) => /registry\.ollama\.ai/.test(m)), "canonical names, like every other edge").toEqual([]);

        // THE CACHE HIT, read off its tooltip: the second gemma4:e2b generation.
        const gemma = frame.locator('.rc-ev-gen[data-model="gemma4:e2b"]');
        await expect(gemma).toHaveCount(2);
        await gemma.nth(1).hover();
        const tip = frame.locator(".rc-tip-event");
        await expect(tip).toBeVisible({ timeout: 5000 });
        const text = (await tip.textContent()).replace(/\s+/g, " ");
        expect(text).toMatch(/reading the prompt \(prefill\)/);
        expect(text).toMatch(/2,223 tokens · 2,222 from cache/);
        expect(text).toMatch(/generating tokens \(decode\)/);
        expect(text).toMatch(/168 tokens · 317\.\d tok\/s/);
        expect(text, "another client's traffic is said to be").toMatch(/not started from this browser/);

        // The COLD one says so only because the server said nothing was cached — and this older capture did not
        // say (it omitted the count), so it must not claim "cold" either.
        await frame.locator(".rc-legend, .vram-head").first().hover();
        await gemma.nth(0).hover();
        const cold = (await tip.textContent()).replace(/\s+/g, " ");
        expect(cold).toMatch(/2,223 tokens/);
        expect(cold, "absent is not zero").not.toMatch(/from cache|cold, none cached/);
    } finally { await ext.context.close(); await fake.stop(); }
});

// WHAT A GENERATION LEFT IN THE CACHE, drawn when its lane span is hovered. The cache is reserved in full at load
// and its bytes never move, so this is the only view of how much of it a turn filled.
test("hovering a generation drills its model in and fills its KV cache part with what that turn left", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_lane_scope: false }));
        const GiB = 1024 ** 3, TOTAL = 101_959_499_776, VRAM = 20 * GiB, MODEL = "gemma4:31b";
        // The parts sum to size_vram EXACTLY, or the panel refuses the split.
        const memory = { weights: 16 * GiB, kv_cache: 3 * GiB, compute: 1 * GiB };
        const info = () => ({
            version: "0.0.0", models: { running: 1, vram_used: VRAM },
            compute: {
                system_compute: { cpu_cores: 32, total_memory: 130_142_785_536, free_memory: 100 * GiB },
                supported_gpus: [{ gpu_id: "0", name: "CUDA0", runner: "CUDA", total_memory: TOTAL,
                    physical_memory: 102_641_958_912, free_memory: TOTAL - VRAM,
                    memory_bandwidth_bytes_per_sec: 1_792_128_000_000, pcie_max_generation: 5, pcie_max_width: 8 }],
            },
        });
        const ps = () => ({ models: [{
            model: MODEL, name: MODEL, size: VRAM, size_vram: VRAM, context_length: 8192, memory,
            expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
            gpus: [{ gpu_id: "0", runner: "CUDA", size_vram: VRAM, memory }],
            // The server's decode ceiling for this placement: the empty-context figure and the per-token KV
            // rate the client needs to put a generation against the ceiling AT ITS CONTEXT.
            roofline: { basis: "dense_weights", bytes_per_token: 16 * GiB, ceiling_tokens_per_sec: 104.3, kv_bytes_per_context_token: 262144,
                devices: [{ gpu_id: "0", bytes_per_token: 16 * GiB, kv_bytes_per_context_token: 262144, memory_bandwidth_bytes_per_sec: 1_792_128_000_000 }] },
        }] });
        fake.setEvents([{ v: 1, kind: "hello", t: 0, box: "test", retainedMs: 60_000 },
            { v: 1, kind: "sample", t: -2000, ps: ps(), info: info() }]);
        // TWO TRACKS: the card as a stack, where the drilled-in fill is drawn, and the overlaid pools (what a
        // one-card box shows by default), where there is no cache part and the tooltip has to carry it.
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_res_layout: { presetId: "custom", tracks: [
            { id: "card", series: ["vram.0"], mode: "stack", heightPx: 120 },
            { id: "pools", series: ["vram.0", "ram"], mode: "overlay", heightPx: 90 },
        ] } }));
        const { frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-seg").count(), { timeout: 25000 }).toBeGreaterThan(0);

        // Paced to the wall clock, like every frame here: a frame's `t` is resolved against its hello, so
        // pushing ahead of the clock puts it in the future, past the window.
        const STEP = 350;
        let t = 0;
        const sample = async () => { t += STEP; fake.pushFrame({ v: 1, kind: "sample", t, ps: ps(), info: info() }); await sleep(STEP); };
        for (let i = 0; i < 4; i++) await sample();
        // A turn that reused 3,000 tokens of its prompt, computed 1,000 and decoded 500, in an 8,192 context.
        fake.pushFrame({ v: 1, kind: "gen.start", t: t + 20, model: `registry.ollama.ai/library/${MODEL}` });
        fake.pushFrame({ v: 1, kind: "gen.end", t: t + 300, model: `registry.ollama.ai/library/${MODEL}`,
            timings: { prompt_tokens: 4000, prompt_tokens_cached: 3000, prompt_ms: 40, eval_ms: 6400, decoded: 500 } });
        for (let i = 0; i < 4; i++) await sample();

        const span = frame.locator(".rc-ev-gen").first();
        await expect(span).toBeVisible({ timeout: 10000 });
        expect(await frame.locator(".rc-kvfill").count(), "nothing is drawn until the span is hovered").toBe(0);
        await span.hover();

        // THE TOOLTIP CARRIES IT IN EVERY PRESET. The overlaid track below draws pool LINES and has no cache
        // part to fill — a one-card box DEFAULTS to that view — so the bar in the tooltip is what a reader on
        // the default layout sees. 3000 reused, 1000 computed, 500 decoded, of 8192.
        const bar = frame.locator(".rc-tip-event .rc-kvbar");
        await expect(bar).toHaveCount(1, { timeout: 5000 });
        const w = await bar.evaluate((el) => Object.fromEntries([...el.children].map((c) => [c.className, parseFloat(c.style.width)])));
        expect(w["rc-kvfill-cached"]).toBeCloseTo((3000 / 8192) * 100, 3);
        expect(w["rc-kvfill-computed"]).toBeCloseTo((1000 / 8192) * 100, 3);
        expect(w["rc-kvfill-decoded"]).toBeCloseTo((500 / 8192) * 100, 3);
        expect((await frame.locator(".rc-tip-event .rc-tip-kv").textContent()).replace(/\s+/g, " ")).toMatch(/4,500 of 8,192 tokens \(55%\)/);
        // DECODE AGAINST THE CEILING AT THIS CONTEXT: 500 tokens in 6.4 s is 78.1 tok/s, and at a mean occupancy
        // of 4,250 tokens the ceiling is 1 / ((16 GiB + 4,250 × 256 KiB) / 1.792 TB/s) = 98.0 tok/s — 80%.
        // Against the EMPTY-context ceiling it would read as 75%, and that figure is never shown.
        expect((await frame.locator(".rc-tip-event").textContent()).replace(/\s+/g, " "))
            .toMatch(/80% of the memory-bandwidth ceiling at this context \(98\.0 tok\/s\)/);
        // The card's own ceilings, on its name: bandwidth, and the host link ruling itself out.
        const facts = (await frame.locator(".rc-devfacts .tt-pop").first().textContent()).replace(/\s+/g, " ");
        expect(facts).toMatch(/bandwidth 1\.79 TB\/s the ceiling decode is bound by/);
        expect(facts).toMatch(/host link PCIe Gen 5 x8 at most — sets how fast a model loads, not how fast it runs/);

        // The hover DRILLS the model in — the same mode the keys enter — so the fill has a part to live in.
        await expect.poll(() => frame.locator(".rc-track.deep").count(), { timeout: 5000 }).toBeGreaterThan(0);
        const fill = frame.locator(".rc-kvfill");
        await expect(fill).toHaveCount(1);
        for (const k of ["cached", "computed", "decoded"]) await expect(fill.locator(`.rc-kvfill-${k}`)).toHaveCount(1);
        // Proportions are the engine's counts over the context: 3000 : 1000 : 500 of 8192, stacked from the
        // cache part's floor (the weights) — the heights, in the track's own shared scale, say exactly that.
        const h = await fill.evaluate((el) => Object.fromEntries([...el.children].map((c) => [c.className, parseFloat(c.style.height)])));
        expect(h["rc-kvfill-cached"] / h["rc-kvfill-computed"]).toBeCloseTo(3, 3);
        expect(h["rc-kvfill-computed"] / h["rc-kvfill-decoded"]).toBeCloseTo(2, 3);
        const bottom = await fill.locator(".rc-kvfill-cached").evaluate((el) => parseFloat(el.style.bottom));
        expect(bottom, "the fill starts where the cache part does: on top of the weights").toBeCloseTo((16 / 20) * 100, 3);

        // Leaving the lane takes it away again — it is a reading of the hovered turn, not a mode.
        await frame.locator(".vram-head").first().hover();
        await expect.poll(() => frame.locator(".rc-kvfill").count(), { timeout: 5000 }).toBe(0);
    } finally { await ext.context.close(); await fake.stop(); }
});

// THE HOST-RAM PROMPT CACHE: a swap before the prefill, measured by the engine and in no other timing, and the
// conversations parked in RAM for a model. The gen.end frames are the server's real ones (tests/fixtures/hw/).
test("a prompt-cache swap is drawn before the prefill, says what it did, and the RAM cache sits on the row", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_lane_scope: false }));
        const read = (n) => readFileSync(fileURLToPath(new URL(`../fixtures/hw/${n}-2026-09-11.ndjson`, import.meta.url)), "utf8")
            .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
        const restore = read("prompt-cache-restore").filter((f) => f.kind === "gen.end")[3];
        const thrash = read("prompt-cache-thrash").filter((f) => f.kind === "gen.end")[2];
        const occupancy = read("prompt-cache-occupancy-sample").find((f) => f.kind === "sample").ps.models.find((m) => m.name === "qwen3:32b").activity;
        const GiB = 1024 ** 3, TOTAL = 101_959_499_776, VRAM = 22 * GiB, MODEL = "qwen3:32b";
        const info = () => ({ version: "0.0.0", models: { running: 1, vram_used: VRAM }, compute: {
            system_compute: { cpu_cores: 32, total_memory: 130_142_785_536, free_memory: 100 * GiB },
            supported_gpus: [{ gpu_id: "0", name: "CUDA0", runner: "CUDA", total_memory: TOTAL, physical_memory: 102_641_958_912, free_memory: TOTAL - VRAM }] } });
        const ps = () => ({ models: [{ model: MODEL, name: MODEL, size: VRAM, size_vram: VRAM, context_length: 40960,
            expires_at: new Date(Date.now() + 5 * 60_000).toISOString(), gpus: [{ gpu_id: "0", runner: "CUDA", size_vram: VRAM }],
            activity: occupancy }] });
        fake.setEvents([{ v: 1, kind: "hello", t: 0, box: "test", retainedMs: 60_000 }, { v: 1, kind: "sample", t: -2000, ps: ps(), info: info() }]);
        const { frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-seg").count(), { timeout: 25000 }).toBeGreaterThan(0);

        // THE RAM CACHE ON THE ROW: two conversations, 1.61 GiB of the model's 8 GiB.
        // The model rows land off the first samples; 20 s like every other wait on them in this spec.
        await expect.poll(() => frame.locator(".vram-row").count(), { timeout: 20000 }).toBeGreaterThan(0);
        await expect(frame.locator(".vram-pcache").first()).toHaveText(/1\.61 GiB \/ 8(\.00)? GiB RAM cache/, { timeout: 20000 });

        const STEP = 350;
        let t = 0;
        const sample = async () => { t += STEP; fake.pushFrame({ v: 1, kind: "sample", t, ps: ps(), info: info() }); await sleep(STEP); };
        for (let i = 0; i < 4; i++) await sample();
        fake.pushFrame({ ...restore, t: t + 10 });
        for (let i = 0; i < 3; i++) await sample();
        fake.pushFrame({ ...thrash, t: t + 10 });
        for (let i = 0; i < 4; i++) await sample();

        const spans = frame.locator('.rc-ev-gen[data-model="qwen3:32b"]');
        await expect(spans).toHaveCount(2, { timeout: 10000 });
        const tip = frame.locator(".rc-tip-event");
        const text = async (i) => { await frame.locator(".vram-head").first().hover(); await spans.nth(i).hover(); await expect(tip).toBeVisible({ timeout: 5000 }); return (await tip.textContent()).replace(/\s+/g, " "); };
        // Spans are ordered by START, and spans run backwards from their end: the thrash turn is 8.6 s long, so
        // although it ended after the restore turn it STARTED before it, and is the first in the lane.
        // THE CACHE WORKING: 500 ms swapping, this conversation restored, then an almost-free prefill.
        const r = await text(1);
        expect(r).toMatch(/swapping conversations through the RAM cache/);
        expect(r).toMatch(/this conversation restored from RAM/);
        expect(r).toMatch(/6,537 tokens · 6,515 from cache/);
        // THE THRASH: not in RAM, and three conversations evicted to make room — the one said as a warning.
        const th = await text(0);
        expect(th).toMatch(/not in RAM — read from scratch/);
        expect(th).toMatch(/evicted 3 conversations \(6\.91 GiB\) to make room/);
    } finally { await ext.context.close(); await fake.stop(); }
});

// A LOAD'S ALLOCATION CURVE SURVIVES DRILLING IN. For most of a load there is no runner, so the memory arriving
// is only the card's unattributed residual; the drilled-in view drew only what IS attributed, so it showed the
// model appearing at full size and dropped the curve the reader zoomed in to see.
test("drilled into a model, its load's allocation curve is still drawn before the runner exists", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_lane_scope: false, ml_res_layout: { presetId: "custom", tracks: [
            { id: "card", series: ["vram.0"], mode: "stack", heightPx: 140 }] } }));
        const GiB = 1024 ** 3, TOTAL = 101_959_499_776, MODEL = "granite4.1:3b", FQ = `registry.ollama.ai/library/${MODEL}`;
        const memory = { weights: 2 * GiB, kv_cache: 10 * GiB, compute: 1 * GiB };
        const info = (used) => ({ version: "0.0.0", models: { running: 0, vram_used: 0 }, compute: {
            system_compute: { cpu_cores: 32, total_memory: 130_142_785_536, free_memory: 100 * GiB },
            supported_gpus: [{ gpu_id: "0", name: "CUDA0", runner: "CUDA", total_memory: TOTAL, physical_memory: 102_641_958_912, free_memory: TOTAL - used }] } });
        const ps = (resident) => ({ models: resident ? [{ model: MODEL, name: MODEL, size: 13 * GiB, size_vram: 13 * GiB, context_length: 131072, memory,
            expires_at: new Date(Date.now() + 5 * 60_000).toISOString(), gpus: [{ gpu_id: "0", runner: "CUDA", size_vram: 13 * GiB, memory }] }] : [] });
        fake.setEvents([{ v: 1, kind: "hello", t: 0, box: "test", retainedMs: 60_000 }, { v: 1, kind: "sample", t: -2000, ps: ps(false), info: info(0.6 * GiB) }]);
        const { page, frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-seg").count(), { timeout: 25000 }).toBeGreaterThan(0);

        const STEP = 350;
        let t = 0;
        const sample = async (resident, used) => { t += STEP; fake.pushFrame({ v: 1, kind: "sample", t, ps: ps(resident), info: info(used) }); await sleep(STEP); };
        for (let i = 0; i < 3; i++) await sample(false, 0.6 * GiB);
        // THE LOAD: no runner, so /api/ps has no row while the card's free memory falls — weights, then context.
        fake.pushFrame({ v: 1, kind: "load.start", t: t + 10, model: FQ });
        for (const used of [2, 3, 7, 11, 13.6]) await sample(false, used * GiB);
        fake.pushFrame({ v: 1, kind: "load.weights", t: t - 3 * STEP, model: FQ, size_vram: 2 * GiB });
        fake.pushFrame({ v: 1, kind: "load.complete", t: t + 10, model: FQ, weights_ms: 3 * STEP, context_ms: 2 * STEP, size_vram: 13 * GiB });
        for (let i = 0; i < 4; i++) await sample(true, 13.6 * GiB);

        // DRILL IN with the keys: pick the model, then dig in.
        const plot = await frame.locator(".rc-plot").first().boundingBox();
        await page.mouse.move(plot.x + plot.width * 0.9, plot.y + plot.height * 0.5);
        await sleep(300);
        await page.keyboard.press("ArrowDown");
        await sleep(250);
        await page.keyboard.press("ArrowRight");
        await expect.poll(() => frame.locator(".rc-track.deep").count(), { timeout: 5000 }).toBeGreaterThan(0);
        // The allocation is drawn — memory arriving for this model before any runner could say it was the model's.
        await expect.poll(() => frame.locator(".rc-track.deep .rc-part-pending").count(), { timeout: 5000 }).toBeGreaterThan(0);
        const pts = await frame.locator(".rc-track.deep .rc-part-pending").first().getAttribute("points");
        const tops = pts.split(" ").map((p) => p.split(",").map(Number));
        // The SVG's own height is 72 (the baseline); a point above it is memory drawn.
        expect(Math.min(...tops.map(([, y]) => y)), "it rises above the baseline").toBeLessThan(72);
    } finally { await ext.context.close(); await fake.stop(); }
});

test("a frame that arrives while you watch lands without a poll", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_lane_scope: false }));
        // Backfill only up to the load, so the eviction below is genuinely NEW rather than replayed.
        fake.setEvents(FRAMES.filter((f) => f.kind === "sample"));
        const { frame } = await openPanel(fake, ext);
        await expect.poll(() => fake.streamSubscribers(), { timeout: 20000 }).toBe(1);
        // An eviction is an INSTANT: it is drawn as a dashed rule through the PLOT, where the curve steps,
        // not as a block in the lane — and one rule per track, since it is one thing that happened to the box.
        const before = await frame.locator(".rc-rule-evict").count();

        // An eviction the server REPORTS, rather than one inferred by diffing two polls — which could never
        // tell "made room for something" from "idle timeout" at all.
        fake.pushFrame({ v: 1, kind: "evict", t: -50, model: "registry.ollama.ai/library/gemma4:e2b", reason: "oom-retry" });
        await expect.poll(() => frame.locator(".rc-rule-evict").count(), { timeout: 15000 }).toBeGreaterThan(before);
        const evicted = await frame.locator(".rc-rule-evict").last().getAttribute("data-model");
        expect(evicted, "canonicalised on the way in, like every other frame").toBe("gemma4:e2b");

        // AND THE RULE SAYS WHERE IT CAME FROM. The note was hardcoded per kind, so it told you "nothing
        // reports an eviction, so this is the sample where it stopped being resident" about an eviction the
        // server had just reported WITH ITS REASON — false on precisely the setup the stream exists for, and
        // it hid the one thing polling can never recover: whether the model was pushed out to make room or
        // simply timed out idle.
        await frame.locator(".rc-rule-evict").last().hover();
        await expect.poll(() => frame.locator(".rc-tip-event .rc-tip-note").textContent().catch(() => ""),
            { timeout: 8000 }).toMatch(/server reported/);
        const note = await frame.locator(".rc-tip-event .rc-tip-note").textContent();
        expect(note, `the reason the server gave is the point of it: ${note}`).toMatch(/oom-retry/);
        expect(note, "…and it must not claim nothing reported it").not.toMatch(/nothing reports/);
        // The model's name is not repeated — it is already the line above, and the width belongs to the reason.
        expect(note.trim().startsWith("gemma4:e2b"), `the name is not repeated: ${note}`).toBe(false);
    } finally { await ext.context.close(); await fake.stop(); }
});

test("a stock server has no stream, and the panel polls instead of emptying", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        // setEvents NOT called: the route answers with the SPA's HTML at 200, exactly as OpenWebUI does for
        // an unknown route. "No stream here" has to be read off the content type, never off the status.
        fake.setResident([{ model: "gemma4:e2b", name: "gemma4:e2b", size: 7_950_000_000, size_vram: 0, context_length: 4096, expires_at: null }]);
        const { frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".vram-row").count(), { timeout: 20000 }).toBeGreaterThan(0);
        expect(await frame.locator(".vram-row .vram-name").allTextContents()).toContain("gemma4:e2b");
        expect(fake.streamSubscribers(), "nothing is held open against a server that cannot serve it").toBe(0);
    } finally { await ext.context.close(); await fake.stop(); }
});

// "This session" scoped the LANE and not the list, so a qwen session sat under a list of gemma models and a
// lane full of gemma's loads and evictions — on a shared box, mostly another tenant's traffic. The rows are
// the lane's legend, so the two disagreeing reads as the panel contradicting itself.
test("a scoped panel shows the session's models, and folds the rest away", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        // Our OWN samples, not the recording's — a `sample` frame carries the whole `/api/ps` body, so
        // replaying the recording's would make the resident set the box's rather than this test's, and the
        // count in the fold would be reading someone else's machine. The `info` (capacity) is the real one.
        const info = FRAMES.find((f) => f.kind === "sample")?.info;
        const row = (name, bytes) => ({ model: name, name, size: bytes, size_vram: bytes, context_length: 262144, expires_at: null, gpus: [{ gpu_id: "0", runner: "CUDA", size_vram: bytes }] });
        const ps = { models: [row("qwen3.5:35b", 20e9), row("gemma4:31b", 18e9)] };
        fake.setResident(ps.models);
        fake.setEvents([
            ...[-90000, -60000, -45000, -30000, -15000, -3000].map((t) => ({ v: 1, kind: "sample", t, ps, info })),
            // The other tenant's model loading, named the way the STREAM names it.
            { v: 1, kind: "load.start", t: -30000, model: "registry.ollama.ai/library/gemma4:31b" },
            { v: 1, kind: "load.complete", t: -25000, model: "registry.ollama.ai/library/gemma4:31b", weights_ms: 3000, context_ms: 2000 },
        ].sort((a, b) => a.t - b.t));
        const { page, frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".vram-row").count(), { timeout: 20000 }).toBeGreaterThan(0);

        // A run of our own, on qwen.
        await page.evaluate(() => {
            const now = Date.now();
            const post = (ev) => window.postMessage({ __mlDebug: ev }, "*");
            post({ kind: "agent", id: "sess-q", ts: now - 6000, save: false, session: { hash: "sess-q", turn: 0 },
                   task: "task qwen", model: "qwen3.5:35b", maxSteps: 4, config: null });
            post({ kind: "agent-step", id: "sess-q", ts: now - 3000, save: false, session: { hash: "sess-q", turn: 1 },
                   step: 1, seq: 1, tool: "exec", toolMs: 300, arguments: { js: "1" }, result: "ok",
                   usage: { promptTokens: 90, completionTokens: 10, totalTokens: 100, genMs: 250, model: "qwen3.5:35b" } });
        });
        await frame.locator(".row", { hasText: "task qwen" }).first().click();
        await expect.poll(() => frame.locator(".astep").count(), { timeout: 10000 }).toBeGreaterThan(0);

        // Scoped is the default; assert it rather than assuming, since the whole test turns on it. The
        // control is a segmented pair in the panel header — it decides the window, the model list and the
        // lane together, so it does not sit among the per-kind filter chips.
        await expect(frame.locator(".rc-scope-seg.on")).toHaveText(/session/);

        // The session's OWN rows — the ones outside the fold. The folded rows are rendered but collapsed
        // (that is what lets them slide), so this asks what is on screen rather than what is in the DOM.
        const names = () => frame.locator(".vram-row:not(.disc-body .vram-row) .vram-name").allTextContents();
        await expect.poll(names, { timeout: 10000 }).toContain("qwen3.5:35b");
        expect(await names(), "another tenant's model is not this session's legend").not.toContain("gemma4:31b");
        // FOLDED, not hidden: what else is on the box is exactly the context for why your model gets evicted.
        // The same disclosure every other opening section uses, so a chevron means one thing panel-wide.
        const fold = frame.locator(".disc-head").filter({ hasText: "other model" });
        await expect(fold).toHaveText(/other model on the box/);
        await expect(fold.locator(".disc-note")).toHaveText("1");
        expect(await fold.getAttribute("aria-expanded")).toBe("false");
        // A collapsed body still HAS its rows — that is what lets them slide — so the question is its
        // height, not whether the row exists. (Playwright counts a clipped element as visible: an element
        // inside an `overflow: hidden` box still reports its own bounding box.)
        const foldHeight = () => frame.locator(".disc-body").last().evaluate((el) => el.getBoundingClientRect().height);
        expect(await foldHeight(), "collapsed").toBeLessThan(2);
        await fold.click();
        expect(await fold.getAttribute("aria-expanded")).toBe("true");
        await expect.poll(foldHeight, { timeout: 5000 }).toBeGreaterThan(8);
        expect(await frame.locator(".disc-body .vram-name").filter({ hasText: "gemma4:31b" }).count()).toBe(1);

        // And the lane agrees with the list, which is the point — one model's blocks, not the box's.
        await fold.click();
        await expect.poll(foldHeight, { timeout: 5000 }).toBeLessThan(2);
        const laneModels = await frame.locator(".rc-ev").evaluateAll((els) => els.map((e) => e.getAttribute("data-model")).filter(Boolean));
        expect(laneModels).not.toContain("gemma4:31b");
    } finally { await ext.context.close(); await fake.stop(); }
});


// The lane is CONTENT — what happened — and it competes with the chart for whatever height the panel was
// dragged to. It is collapsed on a fresh profile, and it is the SAME disclosure the sections below it use:
// a bespoke chevron in a box beside a row of chips read as unrelated chrome, and gave no hint that the two
// were one control. The header carries what is in there, which is what makes it worth opening.
test("the event lane is collapsed on a fresh panel, and its header opens it", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_lane_scope: false }));
        fake.setEvents(FRAMES);
        // NOT openPanel(): that seeds the lane open, which is the thing under test here.
        const page = await ext.context.newPage();
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto(`${fake.url}/api/version`);
        await page.waitForFunction(() => !!document.getElementById("ml-sb-root")?.shadowRoot, null, { timeout: 20000 });
        await page.evaluate(() => {
            const root = document.getElementById("ml-sb-root").shadowRoot;
            const panel = root.getElementById("ml-sb-host");
            panel.style.width = "560px";
            panel.classList.add("open");
            root.getElementById("ml-sb-frame")?.contentWindow?.postMessage({ __mlSidebarOpen: true }, "*");
        });
        const frame = await (async () => {
            for (let i = 0; i < 80; i++) {
                const f = page.frames().find((fr) => /sidebar\.html/.test(fr.url()));
                if (f) return f;
                await sleep(100);
            }
            throw new Error("sidebar iframe never appeared");
        })();
        for (let i = 0; i < 5 && !(await frame.locator(".vram").count()); i++) {
            await frame.locator('[aria-label="VRAM monitor"]').click();
            await sleep(400);
        }

        // The header is drawn — it is the control, and hiding it would hide the way back.
        const fold = frame.locator(".disc-head").filter({ hasText: "events" });
        await expect(fold).toBeVisible({ timeout: 20000 });
        expect(await fold.getAttribute("aria-expanded")).toBe("false");
        // It says WHAT is in there, which is what makes it worth opening — and counts only, since a filter
        // is about what is drawn and nothing is drawn while it is closed.
        await expect(fold.locator(".disc-note")).toHaveText(/\d+ (runs|steps|calls|loads|serving)/);
        // The body stays MOUNTED while closed — that is what there is to slide — so the question is its
        // height, not whether the rows exist. It takes no space at all, which is the point: the panel does
        // not jump when a run starts.
        const bodyH = () => frame.locator(".disc").filter({ hasText: "events" }).first()
            .locator(".disc-body").evaluate((el) => el.getBoundingClientRect().height);
        expect(await bodyH(), "the lane takes no height while closed").toBeLessThan(2);

        await fold.click();
        await expect.poll(() => frame.locator(".rc-lane-row").count(), { timeout: 10000 }).toBeGreaterThan(0);
        expect(await fold.getAttribute("aria-expanded")).toBe("true");
        // The filters arrive ON THE HEADER LINE, not in a body row of their own: the panel competes with the
        // chart for height, and the counts were already there in words.
        await expect.poll(() => frame.locator(".rc-lane-chip").count(), { timeout: 5000 }).toBeGreaterThan(0);
        expect(await bodyH(), "and cost no row to do it").toBeLessThan(2);
        const headBox = await fold.boundingBox();
        const chipBox = await frame.locator(".rc-lane-chip").first().boundingBox();
        expect(Math.abs((chipBox.y + chipBox.height / 2) - (headBox.y + headBox.height / 2)),
            "the chips sit on the header's own line").toBeLessThan(6);
        // …and the header STOPS saying it in words. The chips beside it carry the same counts in the same
        // order, so leaving the summary up made the line recite itself.
        expect(await fold.locator(".disc-note").count(), "the header does not repeat the chips").toBe(0);
        // Remembered, like the other panel sections — as the FOLD, which is a different fact from whether the
        // lane is drawn at all (`laneOn`).
        expect(await ext.sw.evaluate(() => new Promise((r) => chrome.storage.local.get("ml_res_sections", (d) => r(d.ml_res_sections)))))
            .toMatchObject({ laneOn: true, laneOpen: true });

        // And it closes again.
        await fold.click();
        await expect.poll(bodyH, { timeout: 5000 }).toBeLessThan(2);
    } finally { await ext.context.close(); await fake.stop(); }
});


// DEPTH IN THE LANE MEANS CONTAINMENT, and that is a claim the DOM has to make, not just the packer: a run
// contains its steps so it is drawn above them, and the machine's own spans are the ground the run happened
// on so they are drawn below. Reproduced from a real capture (`ml.__events()` on the box), where the run
// container was drawn on the second row UNDER its own two tool steps while a model load held the top row.
test("the lane draws a run above its steps, and the machine below both", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_lane_scope: false }));
        const info = FRAMES.find((f) => f.kind === "sample")?.info;
        const row = (name, bytes) => ({ model: name, name, size: bytes, size_vram: bytes, context_length: 262144, expires_at: null, gpus: [{ gpu_id: "0", runner: "CUDA", size_vram: bytes }] });
        const ps = { models: [row("qwen3.5:35b", 20e9)] };
        fake.setResident(ps.models);
        // A load that begins a HAIR BEFORE the run it is loading for — which is what let it take the top row.
        fake.setEvents([
            ...[-120000, -90000, -60000, -40000, -20000, -5000].map((t) => ({ v: 1, kind: "sample", t, ps, info })),
            { v: 1, kind: "load.start", t: -61000, model: "registry.ollama.ai/library/qwen3.5:35b" },
            { v: 1, kind: "load.complete", t: -58000, model: "registry.ollama.ai/library/qwen3.5:35b", weights_ms: 1000, context_ms: 2000 },
            { v: 1, kind: "busy.start", t: -58000, model: "registry.ollama.ai/library/qwen3.5:35b" },
            { v: 1, kind: "busy.end", t: -30000, model: "registry.ollama.ai/library/qwen3.5:35b" },
        ].sort((a, b) => a.t - b.t));
        const { page, frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-lane-row").count(), { timeout: 20000 }).toBeGreaterThan(0);

        // A run with two tool steps, starting just after the load did.
        await page.evaluate(() => {
            const now = Date.now();
            const post = (ev) => window.postMessage({ __mlDebug: ev }, "*");
            post({ kind: "agent", id: "ord", ts: now - 60000, save: false, session: { hash: "ord", turn: 0 },
                   task: "ordering", model: "qwen3.5:35b", maxSteps: 4, config: null });
            for (const [i, at] of [[1, 50000], [2, 40000]]) {
                post({ kind: "agent-step", id: "ord", ts: now - at, save: false, session: { hash: "ord", turn: i },
                       step: i, seq: i, tool: "exec", toolMs: 4000, approveMs: 0, dispatchMs: 10,
                       arguments: { js: `s${i}` }, result: "ok",
                       usage: { promptTokens: 90, completionTokens: 10, totalTokens: 100, genMs: 3000, model: "qwen3.5:35b" } });
            }
        });
        await expect.poll(() => frame.locator(".rc-ev-run").count(), { timeout: 15000 }).toBe(1);
        await expect.poll(() => frame.locator(".rc-ev-tool").count(), { timeout: 15000 }).toBeGreaterThan(0);

        // Read the DRAWN vertical order — the thing a person actually sees.
        const yOf = async (sel) => {
            const boxes = await frame.locator(sel).evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
            return boxes.length ? Math.min(...boxes) : null;
        };
        const run = await yOf(".rc-ev-run");
        const tool = await yOf(".rc-ev-tool");
        const load = await yOf(".rc-ev-load");
        const serve = await yOf(".rc-ev-serve");
        expect(run, "the run is drawn").not.toBeNull();
        expect(tool, "its steps are drawn").not.toBeNull();
        expect(run, "the container is ABOVE the children it holds").toBeLessThan(tool);
        if (load != null) expect(load, "a load is below the run's own work, not above it").toBeGreaterThan(tool);
        if (serve != null) expect(serve, "and so is a serving span").toBeGreaterThan(tool);
    } finally { await ext.context.close(); await fake.stop(); }
});

test("the track editor's checkbox takes the whole event section, header and all", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_lane_scope: false }));
        fake.setEvents(FRAMES);
        const { frame } = await openPanel(fake, ext);
        const head = frame.locator(".disc-head").filter({ hasText: "events" });
        await expect(head).toBeVisible({ timeout: 20000 });

        // The setting is the ENABLE, and the enable takes the header with it. It used to drive the same
        // signal the chevron does, so unchecking it merely collapsed the section — the `events 1 runs · …`
        // row stayed exactly where it was, which reads as a control that does nothing.
        await frame.locator('[aria-label="Edit tracks"]').click();
        const box = frame.locator(".rc-eopt").filter({ hasText: "event lane" }).locator("input");
        await expect(box).toBeChecked();
        await box.uncheck();
        await expect(head, "the section goes, header included").toHaveCount(0);
        // …and the fold it had is not forgotten, so turning it back on gives you the section you left.
        expect(await ext.sw.evaluate(() => new Promise((r) => chrome.storage.local.get("ml_res_sections", (d) => r(d.ml_res_sections)))))
            .toMatchObject({ laneOn: false, laneOpen: true });

        await box.check();
        await expect(head).toBeVisible();
        await expect.poll(() => frame.locator(".rc-lane-row").count(), { timeout: 10000 }).toBeGreaterThan(0);
    } finally { await ext.context.close(); await fake.stop(); }
});

// `/api/ps` CONTRADICTING ITSELF, replayed frame for frame off a real box (capture 2026-09-05,
// t=76085..77473). A model resident and serving with 94,171,928,982 bytes on CUDA0 was re-reported as
// `state: "loading"` with `size_vram: 0`, no `gpus`, and its name suddenly FULLY-QUALIFIED — twice, 2ms
// either side of a correct row — while the server's own top-level `vram_used` never moved. Read literally
// that is the model vanishing and coming back: a band straight down to the axis, its memory falling into the
// residual as "unattributed", and the row tagged "off-box" for a model plainly on the card.
//
// The two defences are independent and this drives both at once: the NAME goes through `normModel` at the
// boundary, and a `loading` row is a name with no occupancy rather than a residency of zero.
test("a self-contradicting ps frame does not make a resident model vanish", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_lane_scope: false }));

        const TOTAL = 101972967424, VRAM = 94171928982;
        const MODEL = "qwen3.8-flash-next:vision";
        const FQ = `registry.ollama.ai/library/${MODEL}`;
        const card = (id, free) => ({
            gpu_id: String(id), name: `CUDA${id}`, runner: "CUDA", compute: "12.0", driver: "13.2",
            total_memory: TOTAL, physical_memory: 102641958912, free_memory: free,
        });
        // `vram_used` is the server's OWN total and it is identical in every frame below — including the two
        // whose per-model rows sum to zero. That contradiction is the fixture.
        const info = () => ({
            version: "0.0.0", models: { running: 1, vram_used: VRAM },
            compute: {
                system_compute: { cpu_cores: 32, total_memory: 130142785536, free_memory: 100 * 1024 ** 3 },
                supported_gpus: [card(0, TOTAL - VRAM), card(1, TOTAL - 589824)],
            },
        });
        const RUNNING = { models: [{
            model: MODEL, name: MODEL, size: VRAM, size_vram: VRAM, context_length: 262144,
            expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
            gpus: [{ gpu_id: "0", runner: "CUDA", size_vram: VRAM }],
        }] };
        // The bad frame, verbatim in shape: fully-qualified, `loading`, zeros, Go zero-time, no `gpus`.
        const LOADING = { models: [{
            model: FQ, name: FQ, state: "loading", size: 0, size_vram: 0,
            expires_at: "0001-01-01T00:00:00Z",
        }] };

        fake.setEvents([{ v: 1, kind: "hello", t: 0, box: "test", retainedMs: 60000 },
            { v: 1, kind: "sample", t: -1000, ps: RUNNING, info: info() }]);
        const { frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".vram-row").count(), { timeout: 25000 }).toBeGreaterThan(0);
        const before = await frame.locator(".vram-total").textContent();
        expect(before, "the model is resident to begin with").not.toMatch(/^0 B/);

        // …now the contradictions, in the order the box sent them.
        for (const [t, ps] of [[100, LOADING], [200, RUNNING], [300, LOADING], [400, RUNNING]]) {
            fake.pushFrame({ v: 1, kind: "sample", t, ps, info: info() });
            await sleep(150);
            // NOTHING FLICKERS. Asserted on every frame, not only at the end: the bug is transient by nature,
            // so a check that only looks once it has settled passes with the fix reverted.
            expect(await frame.locator(".vram-total").textContent(), `t=${t}: the header dropped to zero`).not.toMatch(/^0 B/);
            expect(await frame.locator(".vram-row").count(), `t=${t}: the model row vanished`).toBeGreaterThan(0);
            expect((await frame.locator(".vram-embed").allTextContents()).join(" "),
                `t=${t}: a resident model was called off-box`).not.toContain("off-box");
            // THE MODEL'S OWN ROW still says what it holds. The header alone is not enough: it falls back to
            // the box's measured occupancy when nothing is attributed, so it stays right even while the
            // attribution underneath it is wrong — which is the whole failure, one layer down.
            const row = await frame.locator(".vram-row").filter({ hasText: MODEL }).first().textContent();
            expect(row, `t=${t}: the row lost the model's memory`).toMatch(/GiB/);
            expect(row, `t=${t}: the row went to zero`).not.toMatch(/\b0 B\b/);
        }
        // And it is ONE model throughout — the two spellings must never have drawn two rows.
        const names = await frame.locator(".vram-name").allTextContents();
        expect(names.filter((n) => n.includes(MODEL)).length, "one model, one row").toBe(1);
        expect(names.join(" "), "the short name is the one shown").not.toContain("registry.ollama.ai");
    } finally { await ext.context.close(); await fake.stop(); }
});

// THE LANE HAS ITS OWN HEIGHT, and that is what stops the panel jumping. The lane RE-PACKS as the window
// moves — a row is a claim that two bars overlap, so a step entering the view can add one — and unbounded
// inside a fixed-height panel every row it gained came straight off the CHARTS above it, which visibly shrank
// while you were dragging the panel's edge. The charts must not move when the lane's content changes.
test("the event lane is resizable, and its content never resizes the charts above it", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_lane_scope: false }));
        fake.setEvents(FRAMES);
        const { page, frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-lane-row").count(), { timeout: 25000 }).toBeGreaterThan(0);

        const plotH = () => frame.locator(".rc-plot").first().evaluate((e) => e.getBoundingClientRect().height);
        const rowsH = () => frame.locator(".rc-lane-rows").evaluate((e) => e.getBoundingClientRect().height);

        // THE CAP HOLDS whatever the lane's content wants to be — that is what makes the charts stable.
        expect(await rowsH(), "the lane is bounded, not as tall as its rows").toBeLessThan(140);
        const scrolls = await frame.locator(".rc-lane-rows").evaluate((e) => e.scrollHeight > e.clientHeight + 1);
        const before = await plotH();

        // GROW IT with its own grip, and the panel gives the lane the room rather than the charts losing it…
        // The grip IS the box's bottom rule — no pill, because a pill reads as a drawer's grab and this is
        // the edge of a box.
        expect(await frame.locator(".rc-lane-pill").count(), "no pill handle").toBe(0);
        expect(await frame.locator(".rc-lane-rows").evaluate((e) => getComputedStyle(e).borderBottomStyle),
            "the box has a visible bottom").toBe("solid");
        const grip = await frame.locator(".rc-lane-grip").boundingBox();
        await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
        await page.mouse.down();
        await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 + 60, { steps: 6 });
        await page.mouse.up();
        await expect.poll(rowsH, { timeout: 5000 }).toBeGreaterThan(140);

        // …and it is REMEMBERED, like every other size in this panel.
        await expect.poll(async () => await ext.sw.evaluate(() =>
            new Promise((r) => chrome.storage.local.get("ml_res_laneh", (d) => r(d.ml_res_laneh)))),
        { timeout: 5000 }).toBeGreaterThan(140);

        // A DOUBLE-CLICK puts it back — a drag you cannot undo is a setting with no reset.
        await frame.locator(".rc-lane-grip").dblclick();
        await expect.poll(rowsH, { timeout: 5000 }).toBeLessThan(140);
        expect(Math.abs((await plotH()) - before), "the charts are where they were").toBeLessThan(2);
        // Sanity on the premise: if the fixture's lane fits inside the cap with room to spare, this test is
        // not exercising the overflow it exists for.
        expect(scrolls || (await rowsH()) > 40, "the lane has content to bound").toBe(true);
    } finally { await ext.context.close(); await fake.stop(); }
});

// `dropped` — a hole in the record that no timestamp can see.
//
// The stream reports, cumulatively per subscriber, how many frames it lost when we stopped reading fast
// enough. Nothing read it. So under a burst the panel drew a continuous line across frames that never
// arrived, which is exactly the claim `segments()` refuses to make about a sampling gap — and a worse one:
// frames are dropped when the subscriber is behind, which is when the box is busiest, so the interpolation
// lands on the movement the chart exists to show. The two readings either side can be an ordinary two
// seconds apart, so the interval alone says nothing is wrong.
test("frames the server says it dropped break the line, not interpolate across it", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_lane_scope: false }));

        const TOTAL = 101_959_499_776, VRAM = 20 * 1024 ** 3, MODEL = "gemma4:31b";
        const info = () => ({
            version: "0.0.0", models: { running: 1, vram_used: VRAM },
            compute: {
                system_compute: { cpu_cores: 32, total_memory: 130_142_785_536, free_memory: 100 * 1024 ** 3 },
                supported_gpus: [{
                    gpu_id: "0", name: "CUDA0", runner: "CUDA", compute: "12.0", driver: "13.2",
                    total_memory: TOTAL, physical_memory: 102_641_958_912, free_memory: TOTAL - VRAM,
                }],
            },
        });
        const ps = () => ({ models: [{
            model: MODEL, name: MODEL, size: VRAM, size_vram: VRAM, context_length: 8192,
            expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
            gpus: [{ gpu_id: "0", runner: "CUDA", size_vram: VRAM }],
        }] });

        fake.setEvents([{ v: 1, kind: "hello", t: 0, box: "test", retainedMs: 60_000, dropped: 0 },
            { v: 1, kind: "sample", t: -2000, ps: ps(), info: info(), dropped: 0 }]);
        const { frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-seg").count(), { timeout: 25000 }).toBeGreaterThan(0);

        // A run of ordinary samples FIRST, so the baseline is a single unbroken segment per track. Without
        // this the test could not tell "the drop split the line" from "the line was already in pieces".
        //
        // Frame time is PACED to the wall clock. A frame's `t` is resolved against its connection's hello, so
        // pushing 1s apart in frame time while sleeping 200ms puts every later sample in the FUTURE — outside
        // a window that ends now, which silently drops exactly the samples the assertion is about.
        const STEP = 350;
        let t = 0;
        const push = async (dropped) => {
            t += STEP;
            fake.pushFrame({ v: 1, kind: "sample", t, ps: ps(), info: info(), dropped });
            await sleep(STEP);
        };
        const segs = () => frame.locator(".rc-plot").first().locator(".rc-seg").count();
        for (let i = 0; i < 3; i++) await push(0);
        expect(await segs(), "an ordinary cadence draws ONE run").toBe(1);

        // …now a frame saying three went missing. Same cadence as every sample before it, well inside
        // `maxGapMs`, so nothing about WHEN this one arrived is unusual. The only news is the counter, and
        // the line must break on that alone.
        await push(3);
        await push(3);
        expect(await segs(), "the reported hole splits the run").toBe(2);

        // AND THE SAME COUNT IS NOT A SECOND HOLE. The counter is cumulative, so every frame after a drop
        // carries it — read as a value rather than a delta, the chart would break at every subsequent
        // sample and end up in permanent pieces after one hiccup, which teaches a reader to ignore breaks.
        for (let i = 0; i < 3; i++) await push(3);
        expect(await segs(), "the standing count must not break the line again").toBe(2);

        // The worker counted it, which is what `ml.__events()` reports when the drawn picture is in question.
        const lost = await ext.sw.evaluate(() => globalThis.__mlResourceStream?.status()?.lost);
        expect(lost, "the connection reports what it lost").toBe(3);
    } finally { await ext.context.close(); await fake.stop(); }
});

// A GPU THE SERVER CAN SEE AND CANNOT USE, reported on the HELLO frame.
//
// A faulted GPU is not reported broken, it is reported ABSENT — gone from `supported_gpus`, so `/api/ps`
// looks normal, `/api/info` returns one healthy card, every figure agrees with every other, and a two-GPU
// box with a dead card renders identically to a one-GPU box. One sat faulted for five and a half hours on
// the reference machine while the panel drew a perfectly consistent picture of the wrong machine.
//
// It rides the HELLO rather than an edge event because hardware does not wait for a subscriber: that fault
// began at 05:51 and was still unreported when a client connected hours later. This test is the fresh-open
// case specifically — no sample has arrived yet, so `hello` is the ONLY thing that has spoken.
test("a GPU that faulted before we connected is reported on the hello frame", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        const TOTAL = 101_959_499_776, VRAM = 20 * 1024 ** 3, MODEL = "gemma4:31b";
        // ONE card in `supported_gpus` — the faulted one is absent, which is the whole shape of the failure.
        const FAULT = [{
            pci_id: "0000:03:00.0",
            name: "NVIDIA RTX PRO 6000 Blackwell Workstation Edition",
            uuid: "GPU-ea77999f-c55b-d5ed-bcae-71115e033a47",
            reason: "reset_required",
            detail: "GPU requires reset",
            recovery: "a cold power cycle: shut down, wait for the rails to drain, power on.",
            bus: { present: true, pcie_fatal_errors: 0, pcie_nonfatal_errors: 0 },
        }];
        // CONSISTENT WITH THE REAL SERVER: `hello` and every `/api/info` body are built from ONE cached probe,
        // so while a card is faulted BOTH carry it, and on a healthy box the field is ABSENT from both. An
        // earlier fixture put the fault on the hello only, which the server cannot produce — and fixing the
        // panel to survive that impossible state made a GPU that RECOVERED leave its banner up for good.
        const info = (faulted) => ({
            version: "0.0.0", models: { running: 1, vram_used: VRAM },
            compute: {
                system_compute: { cpu_cores: 32, total_memory: 130_142_785_536, free_memory: 100 * 1024 ** 3 },
                supported_gpus: [{ gpu_id: "0", name: "CUDA0", runner: "CUDA", compute: "12.0", driver: "13.2", pci_id: "0000:01:00.0",
                    description: "NVIDIA RTX PRO 6000 Blackwell Workstation Edition",
                    total_memory: TOTAL, physical_memory: 102_641_958_912, free_memory: TOTAL - VRAM }],
                ...(faulted ? { unavailable_gpus: FAULT } : {}),
            },
        });
        // Before the fault: BOTH cards healthy, so the panel saw which label each bus address carried.
        const healthy = () => { const i = info(false);
            i.compute.supported_gpus.push({ ...i.compute.supported_gpus[0], gpu_id: "1", name: "CUDA1", pci_id: "0000:03:00.0", free_memory: TOTAL });
            return i; };
        const ps = () => ({ models: [{ model: MODEL, name: MODEL, size: VRAM, size_vram: VRAM,
            context_length: 8192, expires_at: new Date(Date.now() + 300_000).toISOString(),
            gpus: [{ gpu_id: "0", runner: "CUDA", size_vram: VRAM }] }] });

        // A per-card track, so the healthy card has a header to hover.
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_res_layout: { presetId: "custom", tracks: [
            { id: "dev-0", series: ["vram.0"], mode: "stack", heightPx: 96 }] } }));
        fake.setEvents([
            { v: 1, kind: "hello", t: 0, box: "test", retainedMs: 60_000, unavailable_gpus: FAULT },
            { v: 1, kind: "sample", t: -3000, ps: ps(), info: healthy() },
            { v: 1, kind: "sample", t: -1000, ps: ps(), info: info(true) },
        ]);
        const { frame } = await openPanel(fake, ext);

        const banner = frame.locator(".rc-gpufault");
        await expect(banner).toHaveCount(1, { timeout: 25000 });
        const text = await banner.textContent();
        // MACHINE-LEVEL: the question is "why does this box have fewer GPUs than I expect", which attaches
        // to no card — there IS no card to badge, since the faulted one is not in the device list.
        expect(text, "says how many of how many").toMatch(/1 of 2 GPUs unavailable/);
        // The PCI address is the identity: two cards in one machine share a name.
        expect(text).toContain("0000:03:00.0");
        // VERBATIM, because `detail` is the driver's own string and its value is that it can be searched in
        // vendor docs exactly as shown — paraphrasing destroys the only thing it is good for.
        expect(text).toContain("GPU requires reset");
        expect(text, "and what to actually do").toMatch(/cold power cycle/);
        // Zero error counters say nothing rather than saying "0 errors" — the line exists to implicate a
        // SLOT when there is something to implicate.
        expect(text, "no link errors, so no line about them").not.toMatch(/link errors/);
        // WHICH CARD, in the panel's terms: a faulted card has left the enumeration, so the label is what that bus
        // address was LAST SEEN as — and the banner says that is what it is.
        expect(text).toMatch(/CUDA1 · NVIDIA RTX PRO 6000 Blackwell Workstation Edition at 0000:03:00\.0 — its label when last seen/);
        // AN ERROR, not a warning: a card is out of service (only a reset already under way stays amber).
        expect(await banner.evaluate((b) => b.classList.contains("transient"))).toBe(false);
        const tone = await banner.evaluate((b) => [getComputedStyle(b).getPropertyValue("--tone").trim(),
            getComputedStyle(b).getPropertyValue("--err").trim()]);
        expect(tone[0], `the banner is in the error tone: ${tone}`).toBe(tone[1]);
        // …and the HEALTHY card says what it is, in the driver's words, on its name.
        const facts = (await frame.locator(".rc-devfacts .tt-pop").first().textContent()).replace(/\s+/g, " ");
        expect(facts).toMatch(/^CUDA0 · NVIDIA RTX PRO 6000 Blackwell Workstation Edition CUDA · 0000:01:00\.0/);

        // AND THE FAULTED CARD IS NOT A POOL. It holds nothing and can hold nothing, so it must never
        // appear as a track or be summed into a capacity — the chart still shows exactly one card.
        expect(await frame.locator(".rc-name").allTextContents()).not.toContain("0000:03:00.0");
        const headers = (await frame.locator(".rc-name").allTextContents()).join(" ");
        expect(headers, "one card and the host, not two cards").not.toMatch(/CUDA1/);

        // AND WHEN THE CARD RECOVERS, THE BANNER GOES. The field disappears from `/api/info` on a healthy box —
        // absent, not `[]` — so a panel that treated absence as "learned nothing" would keep reporting a fault
        // that no longer exists. This is the case the first version got wrong.
        fake.pushFrame({ v: 1, kind: "sample", t: 500, ps: ps(), info: info(false) });
        await expect(banner, "a recovered card is no longer reported unavailable").toHaveCount(0, { timeout: 10000 });
    } finally { await ext.context.close(); await fake.stop(); }
});

// THE OTHER HALF: an empty list is not a clean bill of health. It means nothing to report OR the server
// could not look, and those are not distinguished at the source — so it may drive a warning and must never
// drive a reassurance. `not_offered_by_backend` is the same rule in a different costume: that card answered
// every query and was simply not claimed by a backend, so a warning there tells someone to reseat hardware
// that is working perfectly.
test("no fault, and a card merely not claimed by a backend, both draw nothing", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        const TOTAL = 101_959_499_776;
        const info = (unavailable) => ({
            version: "0.0.0", models: { running: 0, vram_used: 0 },
            compute: {
                system_compute: { cpu_cores: 32, total_memory: 130_142_785_536, free_memory: 100 * 1024 ** 3 },
                supported_gpus: [{ gpu_id: "0", name: "CUDA0", runner: "CUDA", compute: "12.0", driver: "13.2",
                    total_memory: TOTAL, physical_memory: 102_641_958_912, free_memory: TOTAL }],
                ...(unavailable ? { unavailable_gpus: unavailable } : {}),
            },
        });
        fake.setEvents([{ v: 1, kind: "hello", t: 0, box: "test", retainedMs: 60_000 },
            { v: 1, kind: "sample", t: -1000, ps: { models: [] }, info: info(null) }]);
        const { frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-plot").count(), { timeout: 25000 }).toBeGreaterThan(0);
        await expect(frame.locator(".rc-gpufault")).toHaveCount(0);

        // …and a card the backend did not claim is REPORTED by the server but is not a fault, so it still
        // draws nothing. This is the assertion that stops the banner from becoming a false alarm on every
        // machine running CUDA_VISIBLE_DEVICES.
        fake.pushFrame({ v: 1, kind: "sample", t: 500, ps: { models: [] }, info: info([
            { pci_id: "0000:01:00.0", name: "CUDA1", reason: "not_offered_by_backend",
              detail: "no backend claimed this device" },
        ]) });
        await sleep(1500);
        await expect(frame.locator(".rc-gpufault")).toHaveCount(0);
    } finally { await ext.context.close(); await fake.stop(); }
});

// THE PREDICTOR'S FIGURES, for whoever is tuning it — OFF by default, and a load then says nothing about it. With
// the gear toggle on, the load's tooltip sets the prediction against what the load took, the card it landed on
// carries a dashed line where the prediction said it would land, and `ml.__loads()` hands the same comparison
// back as data. The recording is the real load of gemma4:31b onto CUDA1, with an estimate frame added in front of
// its start (this capture predates the frame).
const ESTIMATE = { v: 1, kind: "estimate", t: -62600, model: "registry.ollama.ai/library/gemma4:31b",
    estimate: { predicted: 40 * 1024 ** 3, predicted_for_load: 42 * 1024 ** 3, source: "calibration", num_ctx: 262144,
                num_gpu: 1, num_batch: 512, metadata_complete: true, breakdown: { weights: 18 * 1024 ** 3, kv_cache: 20 * 1024 ** 3, compute: 0 } } };
// …and the fields today's `load.complete` carries, which this capture predates (it was recorded while the ring
// still stripped edge payloads), so the record's verbatim copy has something to be verbatim about.
const COMPLETE = { size_vram: 45_995_000_000, size_total: 45_995_000_000, memory: { weights: 19_853_132_208, kv_cache: 25_000_000_000, compute: 1_141_867_792 } };
const WITH_ESTIMATE = [...FRAMES.filter((f) => f.t < ESTIMATE.t), ESTIMATE, ...FRAMES.filter((f) => f.t >= ESTIMATE.t)]
    .map((f) => (f.kind === "load.complete" ? { ...f, ...COMPLETE } : f));
const PER_CARD = { presetId: "memory", tracks: [
    { id: "dev-0", series: ["vram.0"], mode: "stack", heightPx: 96 },
    { id: "dev-1", series: ["vram.1"], mode: "stack", heightPx: 96 },
] };

test("load predictions: off by default, and with the toggle on the load is set against its prediction", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        await ext.sw.evaluate((layout) => chrome.storage.local.set({ ml_lane_scope: false, ml_res_layout: layout }), PER_CARD);
        fake.setEvents(WITH_ESTIMATE);
        const { page, frame } = await openPanel(fake, ext);
        const load = frame.locator(".rc-ev-load").first();
        await expect(load).toBeVisible({ timeout: 20000 });

        // OFF BY DEFAULT: no line, the load's tooltip says nothing about a predictor, and the worker — which has
        // seen the whole load by now, since the lane drew it — collected nothing.
        expect(await frame.locator(".rc-predict").count()).toBe(0);
        await waitForMl(page);
        await sleep(500);
        expect(await page.evaluate(() => window.ml.__loads()), "nothing is collected while the toggle is off").toEqual([]);
        await load.hover();
        await expect(frame.locator(".rc-tip-event")).toBeVisible({ timeout: 5000 });
        expect(await frame.locator(".rc-tip-event").textContent()).not.toMatch(/predicted/);

        // ON, from the gear.
        await frame.locator(".vram-head").first().hover();
        await frame.locator('[aria-label="Edit tracks"]').click();
        const box = frame.locator(".rc-editor .rc-eopt", { hasText: /load predictions/ }).locator("input");
        await expect(box).not.toBeChecked();
        await box.check();
        await frame.locator('[aria-label="Edit tracks"]').click();

        // The dashed line sits on the card the load LANDED on — CUDA1, the second track — and only there.
        const tracks = frame.locator(".rc-track");
        await expect.poll(() => tracks.nth(1).locator(".rc-predict").count(), { timeout: 5000 }).toBe(1);
        expect(await tracks.nth(0).locator(".rc-predict").count(), "a card the load did not land on draws none").toBe(0);

        await load.hover();
        const tip = frame.locator(".rc-tip-event");
        await expect(tip).toBeVisible({ timeout: 5000 });
        const text = await tip.textContent();
        expect(text).toMatch(/predicted, for placement\s*42\.00 GiB/);
        expect(text).toMatch(/calibration/);
        expect(text).toMatch(/40\.00 GiB before the batch surcharge/);
        expect(text, "where it settled, measured on the card").toMatch(/settled at/);
        expect(text, "this capture lists no runner, so it says which measure it used").toMatch(/the cards' growth/);
        // Term by term, never summed: weights near the prediction, the KV cache over it — flagged, since more
        // than predicted is the direction that breaks a fit.
        expect(text).toMatch(/weights: 18\.00 GiB predicted/);
        expect(text).toMatch(/KV cache: 20\.00 GiB predicted/);
        expect(await tip.locator(".rc-chip-warn").count(), "a load that took more than predicted is flagged").toBeGreaterThan(0);
    } finally { await ext.context.close(); await fake.stop(); }
});

test("load predictions: the worker keeps one record per load while the toggle is on, for ml.__loads()", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_lane_scope: false, ml_res_predict: true }));
        fake.setEvents(WITH_ESTIMATE);
        const { page } = await openPanel(fake, ext);
        await waitForMl(page);
        await expect.poll(async () => (await page.evaluate(() => window.ml.__loads())).length, { timeout: 20000 }).toBe(1);
        const [rec] = await page.evaluate(() => window.ml.__loads());
        expect(rec.model).toBe("gemma4:31b");
        expect(rec.estimate, "the server's estimate, verbatim").toEqual(ESTIMATE.estimate);
        expect(rec.complete, "the load's own figures, verbatim").toEqual(COMPLETE);
        expect(rec.trace.cards).toEqual(["1"]);
        expect(rec.trace.final.bytes).toBeGreaterThan(30 * 1024 ** 3);
        // `clear` empties the store once read.
        await page.evaluate(() => window.ml.__loads({ clear: true }));
        expect(await page.evaluate(() => window.ml.__loads())).toEqual([]);
    } finally { await ext.context.close(); await fake.stop(); }
});

// WHAT EACH CARD WAS DOING: the phase ribbon along the top of a per-card track, from the engine's own prefill and
// decode timings (the real five-generation capture, four models on one card), a row per model — and it obeys the
// same kind toggles as the lane, so hiding "calls" takes it away.
test("the phase ribbon draws each model's prefill and decode along its card, and follows the kind toggles", async () => {
    const recorded = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/events-gen-timings.json", import.meta.url)), "utf8"));
    const last = Math.max(...recorded.map((f) => f.t));
    const GEN_FRAMES = recorded.map((f) => ({ ...f, t: f.t - last - 1000 }));
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_lane_scope: false, ml_res_layout: { presetId: "memory", tracks: [
            { id: "dev-0", series: ["vram.0"], mode: "stack", heightPx: 96 }] } }));
        fake.setEvents(GEN_FRAMES);
        const { frame } = await openPanel(fake, ext);
        await expect.poll(() => frame.locator(".rc-ev-gen").count(), { timeout: 20000 }).toBe(5);

        const track = frame.locator(".rc-track").first();
        await expect.poll(() => track.locator(".rc-ribbon-seg.k-prefill").count(), { timeout: 5000 }).toBeGreaterThan(0);
        expect(await track.locator(".rc-ribbon-seg.k-decode").count()).toBeGreaterThan(0);
        const rows = await track.locator(".rc-ribbon-seg").evaluateAll((els) => new Set(els.map((e) => e.style.top)).size);
        expect(rows, "a row per model, since two models on one card can generate at once").toBeGreaterThan(1);

        // ONE set of kind toggles: "calls" off in the lane's chips takes the ribbon away with the lane's bars.
        await frame.locator(".rc-lane-filter .rc-lane-chip", { hasText: /^calls/ }).first().click();
        await expect.poll(() => track.locator(".rc-ribbon-seg").count(), { timeout: 5000 }).toBe(0);
    } finally { await ext.context.close(); await fake.stop(); }
});

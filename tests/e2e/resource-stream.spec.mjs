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
import { launchExtension, configureExtension } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FRAMES = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/events-load-lifecycle.json", import.meta.url)), "utf8"));

/** Boot the extension against a fake box whose event stream replays the recording, panel open. */
async function openPanel(fake, ext) {
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

        const names = () => frame.locator(".vram-row .vram-name").allTextContents();
        await expect.poll(names, { timeout: 10000 }).toContain("qwen3.5:35b");
        expect(await names(), "another tenant's model is not this session's legend").not.toContain("gemma4:31b");
        // FOLDED, not hidden: what else is on the box is exactly the context for why your model gets evicted.
        const fold = frame.locator(".vram-others");
        await expect(fold).toHaveText(/show 1 other model on the box/);
        await fold.click();
        await expect.poll(names).toContain("gemma4:31b");
        await expect(fold).toHaveText(/hide 1 other model/);

        // And the lane agrees with the list, which is the point — one model's blocks, not the box's.
        await fold.click();
        const laneModels = await frame.locator(".rc-ev").evaluateAll((els) => els.map((e) => e.getAttribute("data-model")).filter(Boolean));
        expect(laneModels).not.toContain("gemma4:31b");
    } finally { await ext.context.close(); await fake.stop(); }
});

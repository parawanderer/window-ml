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

// sidebar-resource.test.js — the resource panel's tracks and chart: one track per pool against a real
// ceiling, the overview's share-of-each comparison, the chart's own controls, and the panel's own box.
// The event lane that draws over these is tests/sidebar-event-lane.test.js.

const { test, after } = require("node:test");
const assert = require("node:assert");
const { closeSidebarWorlds, loadSidebarWorld } = require("./helpers");
const { chatStart, chatResult, openSettings, STACKED_LAYOUT, INFO_2CARD, sidebarCss, cssRule } = require("./sidebar-helpers");

// Close every jsdom window after the file — the VRAM panel's setInterval keeps a
// window's timers alive, which would otherwise hang the runner after all pass.
after(closeSidebarWorlds);

/** A class that dims must have a RULE behind it. Asserting only the class name let both cross-highlight
 *  directions ship with no styling at all — every test green, nothing visibly dimmed. */
function assertDims(selector) {
    assert.match(cssRule(selector), /opacity:\s*0?\.\d/, `${selector} must actually reduce opacity`);
}

// Mixed-size GPUs are normal (a 4090 beside a 3060), so an overlay must not assume one shared denominator.
const INFO_MIXED = { compute: {
    system_compute: { cpu_cores: 16, total_memory: 68719476736, free_memory: 30 * 1024 ** 3 },
    supported_gpus: [
        { gpu_id: "0", name: "CUDA0", runner: "CUDA", total_memory: 25757220864, free_memory: 5 * 1024 ** 3 },   // 24 GiB
        { gpu_id: "1", name: "CUDA1", runner: "CUDA", total_memory: 12884901888, free_memory: 11 * 1024 ** 3 },  // 12 GiB
    ],
} };

// --- resource tracks: one per pool, each against a ceiling the box reported ------------------------------

test("resource tracks: one per card plus host RAM, each against a real ceiling", async () => {
    const w = await loadSidebarWorld({
        vram: [{ model: "gemma4:31b", vramGB: 14, vramBytes: 14 * 1024 ** 3, sizeBytes: 14 * 1024 ** 3,
                 gpus: [{ id: "0", runner: "CUDA", vramBytes: 14 * 1024 ** 3 }], contextLength: 262144, expiresAt: null }],
        info: INFO_2CARD, ...STACKED_LAYOUT,
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();   // restoreLayout resolves through a chrome.storage callback, a turn after the click

    const names = [...w.shadow.querySelectorAll(".rc-name")].map((n) => n.textContent);
    assert.deepEqual(names, ["CUDA0", "CUDA1", "System RAM"], "small multiples — a model uses ONE card's capacity");
    assert.equal(w.shadow.querySelectorAll(".rc-track").length, 3, "one track each, never a shared axis");
    // The figure lives alongside a tooltip inside .rc-total, so match the pair rather than the whole node.
    const totals = [...w.shadow.querySelectorAll(".rc-total")].map((n) => n.textContent);
    // The DISPLAY ceiling is the driver framebuffer total (95.59 GiB), not ollama's 94.97 — it must agree
    // with what nvidia-smi shows the user everywhere else.
    // The numerator is what is IN USE on the card — the 14 GiB model plus ~1 GiB of driver context — because
    // that is the figure that reconciles with free. The legend breaks it into model vs overhead.
    assert.match(totals[0], /14\.97 GiB \/ 95\.59 GiB/, "in use on card 0, against the DRIVER total");
    assert.match(totals[1], /993\.0 MiB \/ 95\.59 GiB/, "the IDLE card shows only its driver context");
    assert.match(totals[2], /GiB \/ 121\.2 GiB/, "and system RAM against its own total");
    const figures = totals.join(" ").match(/[\d.]+ [KMGT]?i?B/g) || [];
    assert.ok(figures.every((f) => /( B|iB)$/.test(f)), `binary units only, saw ${figures.join()}`);
});

test("resource tracks: the residual is named driver overhead on an idle card, not a phantom process", async () => {
    const w = await loadSidebarWorld({ vram: [], info: INFO_2CARD, ...STACKED_LAYOUT });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();   // restoreLayout resolves through a chrome.storage callback, a turn after the click
    // CUDA1 is the genuinely idle card in the fixture (94 of 94.97 GiB free → ~1 GiB residual). CUDA0 has
    // 80 GiB free with nothing of ours on it, so ITS 14.97 GiB really is unattributed — correctly so, which
    // is the other half of this behaviour.
    const cardLegend = w.shadow.querySelectorAll(".rc-track")[1].querySelector(".rc-legend").textContent;
    const busyLegend = w.shadow.querySelectorAll(".rc-track")[0].querySelector(".rc-legend").textContent;
    assert.match(busyLegend, /unattributed/, "a card holding 15 GiB nobody claims IS unattributed");
    assert.match(cardLegend, /driver overhead/,
        "an idle card's residual is ollama's own discovery context, not a phantom third party");
    assert.ok(!/unattributed/.test(cardLegend), "…it never escalates past the floor on an idle card");
    assert.match(cardLegend, /free/, "free capacity is always named");
    // The host pool, by contrast, really does have other processes in it.
    const hostLegend = [...w.shadow.querySelectorAll(".rc-track")].at(-1).querySelector(".rc-legend").textContent;
    assert.match(hostLegend, /unattributed/, "the OS's own RAM use clears the floor and is named as such");
});

test("resource tracks: no /api/info means NO ceiling — it falls back, never invents one", async () => {
    const w = await loadSidebarWorld({
        vram: [{ model: "a", vramGB: 8, vramBytes: 8 * 1024 ** 3, expiresAt: null }],
        info: null,   // stock Ollama / no passthrough → capacity unknown
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();   // restoreLayout resolves through a chrome.storage callback, a turn after the click
    assert.equal(w.shadow.querySelectorAll(".rc-track").length, 0, "no capacity → no tracks");
    assert.ok(w.shadow.querySelector(".vram-spark"), "…it degrades to the auto-scaled sparkline");
    assert.match(w.shadow.querySelector(".vram-total").textContent, /8\.00 GiB in use/, "the total still renders");
});

// Hovering a coloured band names the model it belongs to — the SAME facts the legend row carries, because a
// band and its row describe one model. One component in two placements, so a future badge lands in both.
test("resource tracks: hovering a band names its model, with the row's own facts", async () => {
    const w = await loadSidebarWorld({
        vram: [
            { model: "gemma4:31b", vramGB: 18, vramBytes: 18 * 1024 ** 3, sizeBytes: 18 * 1024 ** 3,
              gpus: [{ id: "0", runner: "CUDA", vramBytes: 18 * 1024 ** 3 }], contextLength: 262144,
              expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() },
        ],
        info: INFO_2CARD, ...STACKED_LAYOUT,
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();   // restoreLayout resolves through a chrome.storage callback, a turn after the click

    assert.equal(w.shadow.querySelectorAll(".rc-tip").length, 0, "no tooltip until something is hovered");
    const band = w.shadow.querySelector(".rc-band");
    assert.ok(band, "a model's band is hoverable");
    band.dispatchEvent(new w.window.PointerEvent("pointerenter", { bubbles: true }));
    await w.flush();

    const tip = w.shadow.querySelector(".rc-tip");
    assert.ok(tip, "hovering names the model");
    assert.match(tip.textContent, /gemma4:31b/);
    assert.match(tip.textContent, /18\.00 GiB/, "how much it holds ON THIS card, in binary units");
    assert.match(tip.textContent, /256K/, "the context window — the same fact the row shows");
    assert.match(tip.textContent, /\dm ?\d*s?/, "and the keep-alive TTL");
    // The row lights up too: a band and its row are the same model, so hovering either marks both.
    assert.ok(w.shadow.querySelector(".vram-row.hot"), "the legend row highlights with the band");

    band.dispatchEvent(new w.window.PointerEvent("pointerleave", { bubbles: true }));
    await w.flush();
    assert.equal(w.shadow.querySelectorAll(".rc-tip").length, 0, "and it clears on leave");
});

// Tooltip anchoring is a real trap here: `.tt-pop.left` means LEFT-anchored (extends rightward), for triggers
// at the panel's LEFT edge. The track header's figure is right-aligned, so a left-anchored pop runs off the
// panel and is clipped — which is exactly what shipped once.
test("resource tracks: the header tooltip is right-anchored so it can't run off the panel", async () => {
    const w = await loadSidebarWorld({ vram: [], info: INFO_2CARD, ...STACKED_LAYOUT });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();   // restoreLayout resolves through a chrome.storage callback, a turn after the click

    const pop = w.shadow.querySelector(".rc-total .tt-pop");
    assert.ok(pop, "the denominator explains which of the three totals it is");
    assert.ok(!pop.classList.contains("left"),
        "right-aligned trigger → right-anchored pop (extends leftward), or it clips at the panel edge");
    assert.ok(pop.classList.contains("wrap"), "and it wraps — the explanation is prose, not a label");
    // The legend keys sit at the LEFT edge, so those are correctly left-anchored.
    const keyPop = w.shadow.querySelector(".rc-key .tt-pop");
    assert.ok(keyPop.classList.contains("left"), "left-edge trigger → left-anchored pop");
});

test("resource tracks: the hovered band outlines itself, and single-sample runs aren't drawn", async () => {
    const w = await loadSidebarWorld({
        vram: [{ model: "gemma4:31b", vramGB: 18, vramBytes: 18 * 1024 ** 3, sizeBytes: 18 * 1024 ** 3,
                 gpus: [{ id: "0", runner: "CUDA", vramBytes: 18 * 1024 ** 3 }], expiresAt: null }],
        info: INFO_2CARD, ...STACKED_LAYOUT,
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();   // restoreLayout resolves through a chrome.storage callback, a turn after the click

    // A run of one sample has no shape to draw, and reserving a 2px column for it leaves a pale sliver where
    // the band wash is missing — the "ghost corner". Undrawable runs are skipped entirely.
    const segs = [...w.shadow.querySelectorAll(".rc-seg")];
    assert.ok(segs.every((sg) => sg.querySelectorAll("polygon, polyline").length > 0),
        "every drawn segment actually contains a shape");

    const band = w.shadow.querySelector(".rc-band");
    if (!band) return;   // needs ≥2 samples to have drawn anything yet
    assert.ok(!band.classList.contains("hot"), "nothing is marked until hovered");
    band.dispatchEvent(new w.window.PointerEvent("pointerenter", { bubbles: true }));
    await w.flush();
    assert.ok(w.shadow.querySelector(".rc-band.hot"), "the hovered band marks ITSELF, not just its neighbours");
});

// "Not resident" and "we don't know yet" are different claims — the orb says "Awakening…" for the first and
// must say nothing for the second.
test("residentNow: knows loaded from not-loaded, and unknown from either", async () => {
    const { residentNow } = await import("../src/sidebar/vram.tsx");
    const { loadedModels } = await import("../src/sidebar/store.ts");
    const before = loadedModels.value;
    try {
        loadedModels.value = null;                       // no /api/ps answer yet
        assert.equal(residentNow("qwen3:8b"), undefined, "unknown, NOT 'not loaded'");
        loadedModels.value = [{ model: "qwen3:8b" }];
        assert.equal(residentNow("qwen3:8b"), true);
        assert.equal(residentNow("gemma4:31b"), false, "a model that isn't there really isn't");
        // :latest is normalised like the rest of the model plumbing, so the tag doesn't create a false miss.
        loadedModels.value = [{ model: "qwen3:latest" }];
        assert.equal(residentNow("qwen3"), true);
        assert.equal(residentNow(null), undefined, "no model named → nothing to claim");
    } finally { loadedModels.value = before; }
});

// A box that has NEVER answered /api/info degrades honestly: no ceiling is invented. (The other half of the
// rule — that a box which STOPS answering keeps what it measured — is holdCapacity in resource-model.test.mjs
// for the decision, and resource-panel.spec.mjs for the call site: the refresh cadence is 10s of real time,
// which is an e2e's business, not this suite's.)
test("capacity: a box that never answers draws no ceiling", async () => {
    const never = await loadSidebarWorld({
        vram: [{ model: "big", vramGB: 19, vramBytes: 19 * 1024 ** 3, expiresAt: null }],
        info: null,
    });
    await never.raw({ __mlSidebarOpen: true });
    never.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    for (let i = 0; i < 4; i++) await never.flush();
    assert.equal(never.shadow.querySelectorAll(".rc-track").length, 0, "no ceiling is invented");
    assert.ok(never.shadow.querySelector(".vram-spark"), "it falls back to the auto-scaled shape");
    // …and SAYS so. An unexplained bare line just reads as the panel having regressed to an older design.
    const note = never.shadow.querySelector(".vram-nocap");
    assert.ok(note, "the degraded view names itself");
    assert.match(note.textContent, /capacity unknown/);
    assert.match(note.querySelector(".tt-pop").textContent, /api\/info/, "…and says what is missing");
});

// Every memory figure carries its share of the pool. "18.00 GiB of 95.59 GiB" makes the reader divide; the
// question they are actually asking is how FULL the card is.
test("resource figures: bytes always come with the percentage of the pool", async () => {
    const w = await loadSidebarWorld({
        vram: [{ model: "big", vramGB: 19, vramBytes: 19 * 1024 ** 3, sizeBytes: 19 * 1024 ** 3,
                 gpus: [{ id: "0", runner: "CUDA", vramBytes: 19 * 1024 ** 3 }], expiresAt: null }],
        info: INFO_MIXED,
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();

    // The Overview key opens the CURSOR tip (it used to also carry a static popup, which meant two tooltips
    // for one hover), and that is where the real figure behind the plotted percentage lives.
    assert.equal(w.shadow.querySelectorAll(".rc-legend .rc-key .tt-pop").length, 0, "one tooltip per hover");
    const key = w.shadow.querySelector(".rc-legend .rc-key");
    key.dispatchEvent(new w.window.MouseEvent("pointerenter", {}));
    await w.flush();
    // The tip is a TABLE, so the share is its own column rather than a parenthetical at the end of a
    // sentence — the parens existed to separate it from the prose it used to sit in, and in a column they
    // are noise. What must survive is that the amount is still quoted against the ceiling it is a share of.
    const poolRow = w.shadow.querySelector(".rc-tip-pools .rc-tip-poolrow");
    assert.match(poolRow.querySelector(".rc-tip-amt").textContent, /GiB of .*GiB/, "the amount, against its ceiling");
    assert.match(poolRow.querySelector(".rc-tip-pct").textContent, /^\s*<?\d[\d.]*%\s*$/, "…and the share, in its own column");

    // A device track's header says the same thing in its compact form.
    w.shadow.querySelector('[aria-label="Edit tracks"]').click();
    await w.flush();
    const sel = w.shadow.querySelector(".rc-emode");
    if (sel) { /* the editor is open; the header is what matters */ }
    const totals = [...w.shadow.querySelectorAll(".rc-total")].map((e) => e.firstChild.textContent.trim());
    assert.ok(totals.some((t) => /GiB \/ .*GiB \(\d[\d.]*%\)/.test(t) || t === "% of each pool"),
        `a track header states its share (${totals.join(" | ")})`);
});

// Two models on ONE card: the case the scripted fixtures never produce, where a device's stack has to divide
// between two models and every figure has to keep saying which is which.
test("one GPU, two models: each gets its own band, its own share, and both are named", async () => {
    const two = [
        { model: "gemma4:31b", vramGB: 18, vramBytes: 18 * 1024 ** 3, sizeBytes: 18 * 1024 ** 3,
          gpus: [{ id: "0", runner: "CUDA", vramBytes: 18 * 1024 ** 3 }], expiresAt: null },
        { model: "phi5:14b", vramGB: 9, vramBytes: 9 * 1024 ** 3, sizeBytes: 9 * 1024 ** 3,
          gpus: [{ id: "0", runner: "CUDA", vramBytes: 9 * 1024 ** 3 }], expiresAt: null },
    ];
    const w = await loadSidebarWorld({ vram: two, info: INFO_2CARD, ...STACKED_LAYOUT });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    for (let i = 0; i < 20 && w.shadow.querySelectorAll(".rc-band").length < 2; i++) {
        await w.flush(); await new Promise((r) => setTimeout(r, 150));
    }
    // Card 0's track holds two model bands; a single merged band would lose which model is which.
    const track = w.shadow.querySelector(".rc-track");
    assert.equal(track.querySelectorAll(".rc-band").length, 2, "one band per model on the card they share");

    // Hovering either names THAT model and its share of the card, not the pair's total.
    track.querySelectorAll(".rc-band")[0].dispatchEvent(new w.window.MouseEvent("pointerenter", { bubbles: true }));
    track.querySelector(".rc-plot").dispatchEvent(new w.window.MouseEvent("pointermove", { bubbles: true }));
    await w.flush();
    const tip = w.shadow.querySelector(".rc-tip:not(.vram-rowtip)").textContent;
    assert.match(tip, /(18|9)\.00 GiB/, "the band tip quotes that model's own bytes");
    assert.match(tip, /\d[\d.]*%/, "…and what share of the card that is");
    assert.doesNotMatch(tip, /27\.00 GiB/, "never the pair's total");

    // Both rows are listed, and both are attributed to the same card.
    const rows = [...w.shadow.querySelectorAll(".vram-row")].map((r) => r.textContent);
    assert.equal(rows.length, 2);
    assert.ok(rows.some((r) => /gemma4:31b/.test(r)) && rows.some((r) => /phi5:14b/.test(r)));
});

// The device view's compact labels leave the SHARE to the hover text — that is the figure that says whether a
// number matters (562.9 MiB is nothing on a 95 GiB card and everything on an 8 GiB one).
test("device view: the hover text carries the share, not just the bytes", async () => {
    const w = await loadSidebarWorld({
        vram: [{ model: "big", vramGB: 19, vramBytes: 19 * 1024 ** 3, sizeBytes: 19 * 1024 ** 3,
                 gpus: [{ id: "0", runner: "CUDA", vramBytes: 19 * 1024 ** 3 }], expiresAt: null }],
        info: INFO_2CARD, ...STACKED_LAYOUT,
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();
    const tips = [...w.shadow.querySelectorAll(".rc-legend .rc-key .tt-pop")].map((e) => e.textContent);
    assert.ok(tips.length, "the legend keys have hover text");
    for (const t of tips) assert.match(t, /GiB \(|MiB \(|B \(/, `a legend tooltip states its share: ${t}`);
    assert.ok(tips.some((t) => /unused/i.test(t)), "including the free band, which had no hover text at all");
});

// The ceiling note names the tool that shows the same figure — nvidia-smi on CUDA, rocm-smi on AMD. Saying
// "nvidia-smi" on an AMD box is worse than saying nothing: it sends the reader to check something that isn't
// installed. And a runner we don't know (Vulkan, oneAPI, whatever ships next) must say nothing rather than
// guess.
test("ceiling note: names the right tool per vendor, and none for a runner we don't know", async () => {
    const box = (gpu) => ({ compute: {
        system_compute: { cpu_cores: 16, total_memory: 68719476736, free_memory: 20 * 1024 ** 3 },
        supported_gpus: [gpu],
    } });
    const noteFor = async (gpu) => {
        const w = await loadSidebarWorld({
            vram: [{ model: "big", vramGB: 8, vramBytes: 8 * 1024 ** 3, sizeBytes: 8 * 1024 ** 3,
                     gpus: [{ id: "0", runner: gpu.runner, vramBytes: 8 * 1024 ** 3 }], expiresAt: null }],
            info: box(gpu),
            // THE PER-POOL VIEW, because a ceiling note is a statement about ONE pool's capacity and that is
            // the view that has one. It used to arrive via Overview, which on a one-card box was a stack of
            // the card and the host — a layout `stackRefusal` refuses, and a bug this test was silently
            // depending on. Overview overlays there now, and an overlaid track's header explains the overlay
            // rather than naming a ceiling.
            local: { ml_res_layout: { presetId: "memory", tracks: [
                { id: "dev-0", series: ["vram.0"], mode: "stack", heightPx: 96 },
            ] } },
        });
        await w.raw({ __mlSidebarOpen: true });
        w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
        for (let i = 0; i < 20 && !w.shadow.querySelector(".rc-total .tt-pop"); i++) {
            await w.flush(); await new Promise((r) => setTimeout(r, 100));
        }
        return w.shadow.querySelector(".rc-total .tt-pop")?.textContent || "";
    };

    const nvidia = await noteFor({ gpu_id: "0", name: "CUDA0", runner: "CUDA", total_memory: 101972967424, physical_memory: 102641958912, free_memory: 80 * 1024 ** 3 });
    assert.match(nvidia, /nvidia-smi/);

    const amd = await noteFor({ gpu_id: "0", name: "ROCm0", runner: "ROCm", total_memory: 51539607552, physical_memory: 51539607552, free_memory: 40 * 1024 ** 3 });
    assert.match(amd, /rocm-smi/, "an AMD card names AMD's tool");
    assert.doesNotMatch(amd, /nvidia/i, "…and never NVIDIA's");

    // Metal is UNIFIED: there is no second pool and no vendor tool to name — the note is about the shared pool
    // and the advised working set instead.
    const metal = await noteFor({ gpu_id: "0", name: "MTL0", runner: "Metal", total_memory: 12712935424, free_memory: 12711886848 });
    assert.match(metal, /ONE pool of memory/, "a Mac shares its memory with the system");
    assert.doesNotMatch(metal, /-smi/, "no vendor tool exists to point at");

    // Something we've never seen (Vulkan today, whatever ships next). Ollama treats an unknown runner as
    // unified — the conservative default — so it gets the shared-pool note and, either way, no invented tool.
    const unknown = await noteFor({ gpu_id: "0", name: "VLK0", runner: "Vulkan", total_memory: 17179869184, free_memory: 16 * 1024 ** 3 });
    assert.doesNotMatch(unknown, /-smi/, "an unknown runner names no tool rather than guessing one");
});

// Embedding models are resident models like any other — /api/ps reports them with the same shape and says
// NOTHING about what they are, so a 5.8 GiB embedder sat in the list looking like a chat model. Real capture
// from the live box: qwen3-embedding:0.6b, 5.78 GB on CUDA1, capabilities ["tools","thinking","embedding"].
test("embedding models: named as such, and evicted the same way", async () => {
    const asked = [];
    const w = await loadSidebarWorld({
        vram: [
            { model: "qwen3.8:27b", vramGB: 35, vramBytes: 37959227144, sizeBytes: 37959227144, contextLength: 262144,
              gpus: [{ id: "0", runner: "CUDA", vramBytes: 37959227144 }], expiresAt: null },
            { model: "qwen3-embedding:0.6b", vramGB: 5, vramBytes: 5776426925, sizeBytes: 5776426925, contextLength: 32768,
              gpus: [{ id: "1", runner: "CUDA", vramBytes: 5776426925 }], expiresAt: null },
        ],
        info: INFO_2CARD,
        caps: (model) => { asked.push(model); return model.includes("embedding") ? ["tools", "thinking", "embedding"] : ["completion", "tools"]; },
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    for (let i = 0; i < 20 && !w.shadow.querySelector(".vram-embed"); i++) { await w.flush(); await new Promise((r) => setTimeout(r, 120)); }

    const rowFor = (name) => [...w.shadow.querySelectorAll(".vram-row")].find((r) => r.textContent.includes(name));
    assert.ok(rowFor("qwen3-embedding:0.6b").querySelector(".vram-embed"), "the embedder says what it is");
    assert.ok(!rowFor("qwen3.8:27b").querySelector(".vram-embed"), "…and the chat model doesn't claim to be one");
    // "embedding" arrives ALONGSIDE tools/thinking on a real capture — the badge is about that one capability,
    // not about the absence of the others.
    assert.match(rowFor("qwen3-embedding:0.6b").querySelector(".vram-embed .tt-pop").textContent, /doesn't chat/);

    // Asked once per model, not once per poll: the panel re-renders every two seconds.
    const before = asked.length;
    for (let i = 0; i < 4; i++) await w.flush();
    assert.equal(asked.length, before, "capabilities are asked for once and kept");

    // And it evicts through the same path as any other resident model — verified against the live box, where
    // /api/generate with keep_alive:0 unloads an embedding model (done_reason "unload").
    rowFor("qwen3-embedding:0.6b").querySelector(".vram-x").click();
    await w.flush();
    assert.deepEqual(w.unloadCalls.at(-1), { model: "qwen3-embedding:0.6b" }, "the row's ✕ evicts the embedder");
});

// A model that evicts doesn't erase what it did. Its band was coloured and named from the LAST frame only, so
// the moment it left the newest sample its whole history turned anonymous grey and stopped being hoverable —
// in the one view whose job is to say what WAS there.
test("history: an evicted model keeps its colour, and says it is gone", async () => {
    const withModel = (gb) => [{ model: "gemma4:31b", vramGB: gb, vramBytes: gb * 1024 ** 3, sizeBytes: gb * 1024 ** 3,
                                 gpus: [{ id: "0", runner: "CUDA", vramBytes: gb * 1024 ** 3 }], expiresAt: null }];
    const w = await loadSidebarWorld({ vram: withModel(18), info: INFO_2CARD, ...STACKED_LAYOUT });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    for (let i = 0; i < 25 && w.shadow.querySelectorAll(".rc-band").length < 1; i++) {
        await w.flush(); await new Promise((r) => setTimeout(r, 150));
    }
    const bandFill = () => w.shadow.querySelector(".rc-track .rc-band")?.getAttribute("fill");
    const colour = bandFill();
    assert.ok(colour && !/fg-faint/.test(colour), `a resident model's band is its own colour (${colour})`);

    // It evicts. The history it is drawn across is unchanged, so it must look unchanged.
    w.setVram([]);
    for (let i = 0; i < 25; i++) {
        await w.flush();
        await new Promise((r) => setTimeout(r, 150));
        if (!w.shadow.querySelector(".vram-row")) break;
    }
    assert.equal(w.shadow.querySelectorAll(".vram-row:not(.ghost)").length, 0, "it is no longer a resident row");
    assert.equal(bandFill(), colour, "…but its history keeps the colour it was drawn in");
    // And it keeps a GHOST row, because the rows are the chart's legend: a colour still drawn with no row to
    // name it is a colour nothing on screen explains.
    const ghost = w.shadow.querySelector(".vram-row.ghost");
    assert.ok(ghost, "an evicted model still drawn keeps a row");
    // …FOLDED, though. These rows are a reference you consult, not a list you read: inline they push the
    // models that are actually loaded down the panel and make a box with two models look like a box with
    // six. (The body stays mounted while closed — that is how the disclosure has something to slide — so
    // the row is findable here either way; `aria-hidden` is the state.)
    const fold = ghost.closest(".disc");
    assert.ok(fold, "the ghost rows live in a disclosure");
    assert.equal(fold.querySelector(".disc-head").getAttribute("aria-expanded"), "false", "…collapsed by default");
    assert.match(fold.querySelector(".disc-label").textContent, /not resident/);
    fold.querySelector(".disc-head").click();
    await w.flush();
    assert.equal(fold.querySelector(".disc-head").getAttribute("aria-expanded"), "true", "…and it opens");
    assert.match(ghost.textContent, /gemma4:31b/);
    assert.match(ghost.textContent, /evicted/);
    assert.equal(ghost.querySelector(".vram-x"), null, "…with nothing to evict");

    // And hovering it still answers, because there is no row left to explain the colour.
    const band = w.shadow.querySelector(".rc-track .rc-band");
    band.dispatchEvent(new w.window.MouseEvent("pointerenter", { bubbles: true }));
    w.shadow.querySelector(".rc-plot").dispatchEvent(new w.window.MouseEvent("pointermove", { bubbles: true }));
    await w.flush();
    const tip = w.shadow.querySelector(".rc-tip:not(.vram-rowtip)");
    assert.ok(tip, "the band is still hoverable after the model evicted");
    assert.match(tip.textContent, /gemma4:31b/, "it names what was there");
    // …and it does NOT annotate that with what happened later. The tooltip reads a sample from the PAST, the
    // stamp beside it says which instant, and at that instant the model WAS there — so a "gone" marker
    // answers a question nobody asked at the place they asked it. Whether it is resident NOW is the model
    // list's question, and the ghost row above is where that is answered.
    assert.doesNotMatch(tip.textContent, /not resident now|\bgone\b/, "history is not annotated with the present");
});

// A box with more cards than the curated palette. Eight A100s plus system RAM is NINE pools, and
// VRAM_COLORS[i % 8] gave card 0 and System RAM the same indigo — in a legend whose only job is telling the
// lines apart. (The 4×3090 NVLink rig, five pools, is the common version of this.)
test("many pools: every pool gets its own colour, past the curated palette", async () => {
    const { VRAM_COLORS } = await import("../src/sidebar/vram.tsx");
    const { poolColor } = await import("../src/sidebar/panel-state.ts");
    // Inside the palette, the hand-picked colours are used as-is.
    assert.equal(poolColor(0, 5), VRAM_COLORS[0]);
    assert.equal(poolColor(4, 5), VRAM_COLORS[4]);
    // Past it, hues are spread over however many there are — and no two collide.
    for (const n of [9, 12, 20]) {
        const seen = new Set(Array.from({ length: n }, (_, i) => poolColor(i, n)));
        assert.equal(seen.size, n, `${n} pools get ${n} distinct colours`);
    }
});

test("many GPUs: a lab node draws a track per card, and a split model is attributed to each", async () => {
    const cards = 4;   // the homelab rig: 4x RTX 3090, NVLink-paired
    const GB = 1024 ** 3;
    const shares = [17, 13, 15, 16];   // one 70B model, split unevenly across all four
    const info = { compute: {
        system_compute: { cpu_cores: 32, total_memory: 137438953472, free_memory: 40 * GB },
        // Free follows from what is ON each card (its share, plus ollama's ~0.35 GiB context) — a fixture with
        // one flat free figure would make the headers disagree with the split it is meant to describe.
        supported_gpus: Array.from({ length: cards }, (_, i) => ({
            gpu_id: String(i), name: `CUDA${i}`, runner: "CUDA",
            total_memory: 25757220864, physical_memory: 25769803776,
            free_memory: 25757220864 - shares[i] * GB - Math.round(0.35 * GB) })),
    } };
    // It fits on NO single card, so the remainder lives in system RAM.
    const onGpu = shares.reduce((n, g) => n + g, 0) * GB;
    const w = await loadSidebarWorld({
        vram: [{ model: "llama4:70b", vramGB: onGpu / GB, vramBytes: onGpu, sizeBytes: onGpu + 7 * GB,
                 gpus: shares.map((g, i) => ({ id: String(i), runner: "CUDA", vramBytes: g * GB })), expiresAt: null }],
        info,
        local: { ml_res_layout: { presetId: "memory", tracks: [
            ...Array.from({ length: cards }, (_, i) => ({ id: `dev-${i}`, series: [`vram.${i}`], mode: "stack", heightPx: 96 })),
            { id: "ram", series: ["ram"], mode: "stack", heightPx: 96 },
        ] } },
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    for (let i = 0; i < 20 && w.shadow.querySelectorAll(".rc-track").length < 5; i++) {
        await w.flush(); await new Promise((r) => setTimeout(r, 120));
    }
    const names = [...w.shadow.querySelectorAll(".rc-name")].map((e) => e.textContent);
    assert.deepEqual(names, ["CUDA0", "CUDA1", "CUDA2", "CUDA3", "System RAM"], "a track per card, plus the host pool");

    // Each card's header states ITS OWN share, never the model's 61 GiB total — a model can only use one
    // card's capacity, and a header claiming otherwise would be the "false total" the design refuses.
    const totals = [...w.shadow.querySelectorAll(".rc-total")].map((e) => e.firstChild.textContent.trim());
    // A card's header is what is on THAT card — its share of the split plus ollama's own context — never the
    // model's 61 GiB total.
    shares.forEach((g, i) => assert.match(totals[i], new RegExp(`^${g}\\.3\\d GiB / 24\\.00 GiB`), `CUDA${i} shows its own ~${g} GiB (${totals[i]})`));
    for (const t of totals) assert.doesNotMatch(t, /61\.00 GiB \//, "no card claims the whole model");

    // The row says it was divided, and names every place it landed.
    const row = w.shadow.querySelector(".vram-row");
    row.dispatchEvent(new w.window.MouseEvent("pointerenter", {}));
    row.dispatchEvent(new w.window.MouseEvent("pointermove", { clientX: 40, clientY: 40 }));
    await w.flush();
    const tip = w.shadow.querySelector(".vram-rowtip").textContent;
    assert.match(tip, /split:/, "the row calls it a split");
    for (const i of [0, 1, 2, 3]) assert.match(tip, new RegExp(`CUDA${i}`), `…naming CUDA${i}`);
    assert.match(tip, /RAM/, "…and the part that didn't fit on any card");
});

// --- the overview track: pools of different sizes compared as a share of each ----------------------------

test("overview: pools of DIFFERENT sizes are compared as a share of each, not on one denominator", async () => {
    const w = await loadSidebarWorld({
        vram: [{ model: "big", vramGB: 19, vramBytes: 19 * 1024 ** 3, sizeBytes: 19 * 1024 ** 3,
                 gpus: [{ id: "0", runner: "CUDA", vramBytes: 19 * 1024 ** 3 }], expiresAt: null }],
        info: INFO_MIXED,
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();

    // Default is Overview: ONE track, every pool overlaid — including the host, so a CPU-resident model can
    // never vanish from the chart.
    assert.equal(w.shadow.querySelectorAll(".rc-track").length, 1, "one compact track");
    const keys = [...w.shadow.querySelectorAll(".rc-key")].map((n) => n.textContent);
    assert.equal(keys.length, 3, `both cards and the host pool — got ${keys.join(" | ")}`);
    assert.match(keys.join(" "), /System RAM/, "the host pool is in the overview");
    // Read as a SHARE of each pool: with unequal capacities an absolute height would mean different things
    // per line. The header must not claim a single denominator ("of X each").
    const head = w.shadow.querySelector(".rc-total").textContent;
    assert.match(head, /% of each pool/);
    assert.ok(!/each$/.test(head.split("Each")[0].trim()), "never a single shared capacity for unequal cards");
    assert.match(keys[0], /%/, "each key shows its own occupancy as a percentage");
});

test("model row: hovering shows WHERE it sits, and flags a split", async () => {
    const w = await loadSidebarWorld({
        vram: [{ model: "big", vramGB: 19, vramBytes: 19 * 1024 ** 3, sizeBytes: 25 * 1024 ** 3,
                 gpus: [{ id: "0", runner: "CUDA", vramBytes: 12 * 1024 ** 3 },
                        { id: "1", runner: "CUDA", vramBytes: 7 * 1024 ** 3 }], expiresAt: null }],
        info: INFO_MIXED,
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();

    const row = w.shadow.querySelector(".vram-row");
    row.dispatchEvent(new w.window.PointerEvent("pointerenter", { bubbles: true }));
    row.dispatchEvent(new w.window.PointerEvent("pointermove", { bubbles: true, clientX: 100, clientY: 200 }));
    await w.flush();

    const tip = w.shadow.querySelector(".vram-rowtip");
    assert.ok(tip, "the row names itself on hover");
    // The placement a single total cannot show: two cards AND a RAM spill.
    assert.match(tip.textContent, /CUDA0 12\.00 GiB/);
    assert.match(tip.textContent, /CUDA1 7\.00 GiB/);
    assert.match(tip.textContent, /RAM 6\.00 GiB/, "the partial offload — why a 'GPU' model can still be slow");
    assert.match(tip.textContent, /split/, "and it is flagged as split, not just listed");
    assert.ok(w.shadow.querySelector(".vram-rowtip-split"), "the split line is marked");

    row.dispatchEvent(new w.window.PointerEvent("pointerleave", { bubbles: true }));
    await w.flush();
    assert.equal(w.shadow.querySelectorAll(".vram-rowtip").length, 0, "and clears on leave");
});

// Hovering a pool must never move the layout: a panel that shifts under the cursor reads as broken, and the
// shift can pull the thing you were pointing at out from under the pointer. So no row is injected at all —
// the model rows below ARE the legend, and the ones not on that pool grey out.
test("overview: hovering a line greys the models that aren't on it, and injects no row", async () => {
    const w = await loadSidebarWorld({
        vram: [
            { model: "onzero", vramGB: 19, vramBytes: 19 * 1024 ** 3, sizeBytes: 19 * 1024 ** 3,
              gpus: [{ id: "0", runner: "CUDA", vramBytes: 19 * 1024 ** 3 }], expiresAt: null },
            { model: "onone", vramGB: 8, vramBytes: 8 * 1024 ** 3, sizeBytes: 8 * 1024 ** 3,
              gpus: [{ id: "1", runner: "CUDA", vramBytes: 8 * 1024 ** 3 }], expiresAt: null },
        ],
        info: INFO_MIXED,
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();

    const rowsBefore = w.shadow.querySelectorAll(".vram-row").length;
    assert.equal(w.shadow.querySelectorAll(".vram-row.away").length, 0, "nothing dimmed until a pool is hovered");

    // Hover CUDA0's key: the model on CUDA1 greys out, the one on CUDA0 does not.
    const key = w.shadow.querySelector(".rc-key");
    key.dispatchEvent(new w.window.PointerEvent("pointerenter", { bubbles: true }));
    await w.flush();

    assert.equal(w.shadow.querySelectorAll(".vram-row").length, rowsBefore, "no row is added — nothing shifts");
    const away = [...w.shadow.querySelectorAll(".vram-row.away")].map((r) => r.querySelector(".vram-name").textContent);
    assert.deepEqual(away, ["onone"], "only the model that is NOT on this pool greys out");
    // …and the class must actually DIM. A class with no rule behind it passed every test while doing nothing
    // visible — which is exactly how this shipped broken.
    assertDims(".vram-row.away");

    key.dispatchEvent(new w.window.PointerEvent("pointerleave", { bubbles: true }));
    await w.flush();
    assert.equal(w.shadow.querySelectorAll(".vram-row.away").length, 0, "and it clears on leave");
});

// The reverse of dimming rows: hovering a MODEL row dims the pools it is NOT resident on, so the chart points
// back at the row as directly as the rows point at the chart.
test("overview: hovering a model row dims the pools it isn't on", async () => {
    const w = await loadSidebarWorld({
        vram: [
            { model: "onzero", vramGB: 19, vramBytes: 19 * 1024 ** 3, sizeBytes: 19 * 1024 ** 3,
              gpus: [{ id: "0", runner: "CUDA", vramBytes: 19 * 1024 ** 3 }], expiresAt: null },
            { model: "onone", vramGB: 8, vramBytes: 8 * 1024 ** 3, sizeBytes: 8 * 1024 ** 3,
              gpus: [{ id: "1", runner: "CUDA", vramBytes: 8 * 1024 ** 3 }], expiresAt: null },
        ],
        info: INFO_MIXED,
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();

    assert.equal(w.shadow.querySelectorAll(".rc-key.away").length, 0, "no pool dimmed until a row is hovered");
    const row = [...w.shadow.querySelectorAll(".vram-row")].find((r) => r.textContent.includes("onone"));
    row.dispatchEvent(new w.window.PointerEvent("pointerenter", { bubbles: true }));
    await w.flush();

    const lit = [...w.shadow.querySelectorAll(".rc-key")].filter((k) => !k.classList.contains("away"))
        .map((k) => k.textContent.replace(/\s+/g, " ").trim());
    assert.equal(lit.length, 1, `only the pool holding it stays lit — got ${lit.join(" | ")}`);
    assert.match(lit[0], /CUDA1/, "the card this model is actually resident on");
    assertDims(".rc-key.away");

    row.dispatchEvent(new w.window.PointerEvent("pointerleave", { bubbles: true }));
    await w.flush();
    assert.equal(w.shadow.querySelectorAll(".rc-key.away").length, 0, "and it clears on leave");
});

test("overview: the line tooltip gives size, usage and the consumers", async () => {
    const w = await loadSidebarWorld({
        vram: [{ model: "onzero", vramGB: 19, vramBytes: 19 * 1024 ** 3, sizeBytes: 19 * 1024 ** 3,
                 gpus: [{ id: "0", runner: "CUDA", vramBytes: 19 * 1024 ** 3 }], expiresAt: null }],
        info: INFO_MIXED,
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();

    const key = w.shadow.querySelector(".rc-key");
    key.dispatchEvent(new w.window.PointerEvent("pointerenter", { bubbles: true }));
    // The tip follows the cursor, so it needs a position before it renders.
    w.shadow.querySelector(".rc-plot").dispatchEvent(new w.window.PointerEvent("pointermove", { bubbles: true }));
    await w.flush();

    const tip = w.shadow.querySelector(".rc-tip-pools");
    assert.ok(tip, "hovering a pool's line opens the tip");
    assert.match(tip.textContent, /CUDA0/, "which device");
    assert.match(tip.textContent, /of 23\.99 GiB/, "how big the pool is");
    assert.match(tip.textContent, /19\.00 GiB|20\.00 GiB/, "how much of it is consumed");
    assert.match(tip.textContent, /onzero/, "and BY WHAT — the consumers, named again in the tip");
});

// Two tooltips for one pointer is never right: the badge has its own, so the row's follower steps aside.
test("model row: a badge's own tooltip suppresses the follow-along tip", async () => {
    const w = await loadSidebarWorld({
        vram: [{ model: "a", vramGB: 19, vramBytes: 19 * 1024 ** 3, sizeBytes: 19 * 1024 ** 3,
                 gpus: [{ id: "0", runner: "CUDA", vramBytes: 19 * 1024 ** 3 }],
                 contextLength: 262144, expiresAt: null }],
        info: INFO_MIXED,
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();

    const row = w.shadow.querySelector(".vram-row");
    row.dispatchEvent(new w.window.PointerEvent("pointerenter", { bubbles: true }));
    row.dispatchEvent(new w.window.PointerEvent("pointermove", { bubbles: true, clientX: 100, clientY: 200 }));
    await w.flush();
    assert.ok(w.shadow.querySelector(".vram-rowtip"), "the row tip follows the cursor across the row");

    // Onto the context badge, which carries its own .tt-pop.
    const badge = w.shadow.querySelector(".vram-ctx");
    assert.ok(badge.classList.contains("tt"), "the badge really does have its own tooltip");
    badge.dispatchEvent(new w.window.PointerEvent("pointerenter", { bubbles: true }));
    await w.flush();
    assert.equal(w.shadow.querySelectorAll(".vram-rowtip").length, 0, "the follower yields to the specific one");

    // Back onto the row proper and it returns.
    // pointerleave does NOT bubble in a browser — dispatching it with bubbles:true would also fire the ROW's
    // leave and clear the hover, which is not what happens when you slide off a badge onto the row.
    badge.dispatchEvent(new w.window.PointerEvent("pointerleave", { bubbles: false }));
    row.dispatchEvent(new w.window.PointerEvent("pointermove", { bubbles: true, clientX: 120, clientY: 200 }));
    await w.flush();
    assert.ok(w.shadow.querySelector(".vram-rowtip"), "and comes back when you leave the badge");
});

// Hovering the EDGE of an overview line used to make the tooltip flicker many times a second: the visible
// stroke THICKENS on hover, and being painted over the hit target it took the pointer events, which fired
// pointerleave on the target, which thinned it again. The hit target's width is the fix — it never changes,
// and the visible line is not interactive at all.
test("overview lines: the hit target never moves under the pointer", async () => {
    const w = await loadSidebarWorld({
        vram: [{ model: "big", vramGB: 19, vramBytes: 19 * 1024 ** 3, sizeBytes: 19 * 1024 ** 3,
                 gpus: [{ id: "0", runner: "CUDA", vramBytes: 19 * 1024 ** 3 }], expiresAt: null }],
        info: INFO_2CARD,
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    for (let i = 0; i < 20 && !w.shadow.querySelector(".rc-hit"); i++) { await w.flush(); await new Promise((r) => setTimeout(r, 150)); }
    const hit = w.shadow.querySelector(".rc-hit");
    assert.ok(hit, "the overview draws a hit target for each line");
    const widthOf = (el) => el.getAttribute("stroke-width");
    const before = widthOf(hit);
    const lineBefore = widthOf(w.shadow.querySelector(".rc-line"));

    hit.dispatchEvent(new w.window.MouseEvent("pointerenter", { bubbles: true }));
    await w.flush();
    assert.notEqual(widthOf(w.shadow.querySelector(".rc-line")), lineBefore, "the visible line does thicken (that is the point of the highlight)");
    assert.equal(widthOf(w.shadow.querySelector(".rc-hit")), before, "…but the target it sits on does not move");

    // And the thickened line can't steal the pointer from the target underneath it.
    const css = sidebarCss();
    assert.match(css, /\.rc-line \{[^}]*pointer-events:\s*none/, "the visible line takes no pointer events");
});

// Hovering a pool dims the model rows and the other lines, but the legend it was selected FROM stayed fully
// lit — a half answer to "which one am I pointing at". It dims from both ends now.
test("overview legend: hovering one pool's line dims every other pool's key", async () => {
    const w = await loadSidebarWorld({
        vram: [{ model: "big", vramGB: 19, vramBytes: 19 * 1024 ** 3, sizeBytes: 19 * 1024 ** 3,
                 gpus: [{ id: "0", runner: "CUDA", vramBytes: 19 * 1024 ** 3 }], expiresAt: null }],
        info: INFO_2CARD,
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    for (let i = 0; i < 20 && !w.shadow.querySelector(".rc-hit"); i++) { await w.flush(); await new Promise((r) => setTimeout(r, 150)); }

    const keys = () => [...w.shadow.querySelectorAll(".rc-legend .rc-key")];
    assert.ok(keys().length >= 2, "the overview lists a key per pool");
    assert.equal(keys().filter((k) => k.classList.contains("away")).length, 0, "nothing is dimmed at rest");

    // Hover the FIRST pool's line (the hit target — the same handler its key uses).
    w.shadow.querySelector(".rc-hit").dispatchEvent(new w.window.MouseEvent("pointerenter", { bubbles: true }));
    await w.flush();
    const after = keys();
    assert.ok(!after[0].classList.contains("away"), "the hovered pool's own key stays lit");
    assert.ok(after.slice(1).every((k) => k.classList.contains("away")),
        `every other key dims (${after.map((k) => k.className).join(" | ")})`);

    // The class has to actually reduce the opacity — a class name alone proves nothing.
    const css = sidebarCss();
    assert.match(css, /\.rc-key\.away \{[^}]*opacity:\s*0?\.\d/, ".rc-key.away dims the key");

    // …and it comes back.
    w.shadow.querySelector(".rc-hit").dispatchEvent(new w.window.MouseEvent("pointerleave", { bubbles: true }));
    await w.flush();
    assert.equal(keys().filter((k) => k.classList.contains("away")).length, 0, "leaving restores the legend");
});

// Residency says what is LOADED. The other half of the question — was it worth the VRAM — is what the model
// has cost this session, which the sessions already recorded and nothing was showing.
test("model tooltips: carry what the model has cost, with the rate's basis said out loud", async () => {
    const w = await loadSidebarWorld({
        vram: [{ model: "qwen3.8:27b", vramGB: 19, vramBytes: 19 * 1024 ** 3, sizeBytes: 19 * 1024 ** 3,
                 gpus: [{ id: "0", runner: "CUDA", vramBytes: 19 * 1024 ** 3 }], expiresAt: null }],
        info: INFO_2CARD,
    });
    // Two calls on that model: 300 tokens out over 6s of Ollama's OWN generation timing.
    await w.dispatch(chatStart("s1", 0, "ask one"));
    await w.dispatch(chatResult("s1", 0, "one", { model: "qwen3.8:27b",
        usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100, evalMs: 2000 } }));
    await w.dispatch(chatStart("s1", 1, "ask two"));
    await w.dispatch(chatResult("s1", 1, "two", { model: "qwen3.8:27b",
        usage: { promptTokens: 1200, completionTokens: 200, totalTokens: 1400, evalMs: 4000 } }));
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();

    const row = w.shadow.querySelector(".vram-row");
    row.dispatchEvent(new w.window.MouseEvent("pointerenter", {}));
    row.dispatchEvent(new w.window.MouseEvent("pointermove", { clientX: 40, clientY: 40 }));
    await w.flush();
    const tip = w.shadow.querySelector(".vram-rowtip").textContent;
    assert.match(tip, /2 calls/, "how many times it ran");
    assert.match(tip, /2,200 in \/ 300 out/, "cumulative spend, in and out");
    assert.match(tip, /50\.0 tok\/s/, "300 tokens over 6s of generation");
    // The basis matters: a rate from Ollama's eval timing and one from wall clock (network and queue included)
    // are different measurements, and a bare number would imply a precision it doesn't have.
    assert.match(tip, /generation only/);

    // A model with no calls this session says nothing rather than a row of zeroes.
    w.setVram([{ model: "never-used:8b", vramGB: 5, vramBytes: 5 * 1024 ** 3, sizeBytes: 5 * 1024 ** 3,
                 gpus: [{ id: "0", runner: "CUDA", vramBytes: 5 * 1024 ** 3 }], expiresAt: null }]);
    for (let i = 0; i < 20; i++) {
        await w.flush(); await new Promise((r) => setTimeout(r, 120));
        if (w.shadow.querySelector(".vram-row")?.textContent.includes("never-used")) break;
    }
    const fresh = w.shadow.querySelector(".vram-row");
    fresh.dispatchEvent(new w.window.MouseEvent("pointerenter", {}));
    fresh.dispatchEvent(new w.window.MouseEvent("pointermove", { clientX: 40, clientY: 40 }));
    await w.flush();
    assert.doesNotMatch(w.shadow.querySelector(".vram-rowtip").textContent, /tok\/s|call/,
        "a model that hasn't run reports nothing, not zeroes");
});

// --- the chart's own controls: window, zoom, layout presets and the track editor -------------------------

test("the chart's own settings live in the chart, and the window picker shows a PREFERENCE", async () => {
    const { RESWIN_DEFAULT } = await import("../src/sidebar/store.ts");
    assert.equal(RESWIN_DEFAULT, 300, "5 minutes — 30 squeezed into a narrow panel is an unreadable smear");

    // The live window is 56s — a value no preset names, of the kind a scrub drag produces. The PICKER must
    // still read the preference. Sharing one quantity made the control read "56 seconds (dragged)": a reading
    // of the moment rendered as a setting, which also needed an extra option to render at all, since a value
    // no preset names leaves a select BLANK. Where you actually are is on screen twice already — the zoom
    // chip and the scrub strip — so the picker's job is the default, and only that.
    const w = await loadSidebarWorld({
        vram: [], info: INFO_MIXED,
        local: { ml_res_window: 56, ml_res_window_pref: 900 },
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();
    w.shadow.querySelector('[aria-label="Edit tracks"]').click();
    await w.flush();

    // IN THE PANEL'S OWN EDITOR, beside the tracks it configures — not in Settings, which is a surface you
    // have to leave the chart to reach for a knob whose whole effect is visible on the chart. (Not a
    // `MlConfig` flag, so the "everything also appears in DevTools Settings" rule does not reach it; the
    // cursor snap toggle moved here first and is the precedent.)
    const win = w.shadow.querySelector('[aria-label="Chart window"]');
    assert.ok(win, "the window picker is in the track editor");
    assert.equal(win.value, "900", "it shows the PREFERENCE, not the 56s the chart is currently drawing");
    assert.ok(![...win.options].some((o) => /dragged/.test(o.textContent)),
        "and it never grows an option describing where the scrub happens to be");
    assert.ok(w.shadow.querySelector('[aria-label="Model colours"]'), "…as does the palette");

    // And it is no longer in two places disagreeing. Checked by RENDERING every Settings tab, not by grepping
    // settings.tsx: a grep passes vacuously the day the settings UI moves to another file.
    await openSettings(w);
    const tabs = [...w.shadow.querySelectorAll(".set-tab")];
    assert.ok(tabs.length >= 5, "every Settings tab is visited");
    for (const tab of tabs) {
        tab.click();
        await w.tick();
        const body = w.shadow.querySelector(".set-body");
        assert.ok(body, `the ${tab.textContent.trim()} tab rendered`);
        assert.equal(body.querySelector('[aria-label="Chart window"]'), null, `no window picker under ${tab.textContent.trim()}`);
        assert.doesNotMatch(body.textContent, /Chart window/, `nor a label for one under ${tab.textContent.trim()}`);
    }
});

// A RESIZED WINDOW IS A DEPARTURE FROM THE DEFAULT, so it needs the same way back a pinned range has. The
// chip was gated on a PIN alone, so narrowing the window while still following live left no control saying
// you had and no way to undo it short of guessing the original number and dragging back to it.
test("the zoom chip offers a way back from a resized window, not only from a pinned range", async () => {
    const w = await loadSidebarWorld({
        vram: [], info: INFO_MIXED,
        local: { ml_res_window: 56, ml_res_window_pref: 300 },   // as a scrub drag leaves it
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();

    const chip = () => w.shadow.querySelector(".vram-zoom.resized");
    assert.ok(chip(), "the window is not the default, so the way back is offered");
    assert.match(chip().textContent, /56s/, "and it says what the window currently is");

    // THE ✕ RESTORES THE DEFAULT — the width the picker names, not some hardcoded number, which is the whole
    // reason the preference is a separate quantity.
    chip().click();
    await w.flush();
    assert.equal(chip(), null, "back at the default, there is nothing to go back FROM");
    const { resWindowS } = await import("../src/sidebar/store.ts");
    assert.equal(resWindowS.value, 300);
});

test("the zoom chip stays away when the window IS the default", async () => {
    // The other half, and the one that keeps it from becoming furniture: a control permanently present says
    // nothing, and this row is deliberately short — it never wraps and gives up width first.
    const w = await loadSidebarWorld({
        vram: [], info: INFO_MIXED,
        local: { ml_res_window: 300, ml_res_window_pref: 300 },
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();
    assert.equal(w.shadow.querySelector(".vram-zoom.resized"), null);
});

// A saved PRESET is re-derived, not replayed: storing its tracks pins the preset as it was the day it was
// picked. Overview later gained the host pool, and a layout saved before that kept drawing a cards-only chart
// with a CPU-resident model missing from it entirely.
test("layout: a saved preset picks up later improvements; only Custom is restored verbatim", async () => {
    const stale = { ml_res_layout: { presetId: "overview", tracks: [
        { id: "overview", series: ["vram.0", "vram.1"], mode: "overlay", heightPx: 96 },   // pre-host-pool
    ] } };
    const w = await loadSidebarWorld({ vram: [], info: INFO_MIXED, local: stale });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();
    const keys = [...w.shadow.querySelectorAll(".rc-key")].map((n) => n.textContent);
    assert.equal(keys.length, 3, `the CURRENT overview, including the host pool — got ${keys.join(" | ")}`);
    assert.match(keys.join(" "), /System RAM/, "the improvement lands rather than being pinned out");

    // A CUSTOM layout is a literal record of choices, so it IS restored as saved.
    const custom = { ml_res_layout: { presetId: "custom", tracks: [
        { id: "just-one", series: ["vram.1"], mode: "stack", heightPx: 96 },
    ] } };
    const w2 = await loadSidebarWorld({ vram: [], info: INFO_MIXED, local: custom });
    await w2.raw({ __mlSidebarOpen: true });
    w2.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w2.flush();
    await w2.flush();
    assert.deepEqual([...w2.shadow.querySelectorAll(".rc-name")].map((n) => n.textContent), ["CUDA1"],
        "a custom layout is kept exactly as chosen");
});

// Opening the panel used to flash the OLD sparkline before the tracks replaced it: `capacity: null` could not
// distinguish "the fetch hasn't come back" from "this server has no /api/info", and the fallback for the
// second is that legacy chart.
test("panel open: holds an empty plot until capacity answers, never flashes the old chart", async () => {
    let release;
    const held = new Promise((r) => { release = r; });
    const w = await loadSidebarWorld({
        vram: [{ model: "a", vramGB: 8, vramBytes: 8 * 1024 ** 3, expiresAt: null }],
        info: INFO_2CARD,
        holdInfo: held,   // the harness waits on this before answering OLLAMA_INFO
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();

    // Capacity has not answered yet.
    assert.equal(w.shadow.querySelectorAll(".vram-spark").length, 0,
        "the legacy sparkline must NOT appear while we are still waiting");
    assert.equal(w.shadow.querySelectorAll(".rc-plot").length, 1, "an empty plot holds the space instead");

    release();
    await w.flush();
    await w.flush();
    assert.ok(w.shadow.querySelectorAll(".rc-key").length > 0, "…and the real tracks replace it once it lands");
    assert.equal(w.shadow.querySelectorAll(".vram-spark").length, 0, "still no legacy chart");
});

// The editor's stack/overlay control must DO something on the layouts the presets actually produce — a track
// per pool, i.e. one series each. It was short-circuiting to the stacked view below two series, so the
// dropdown was inert exactly where it is most used.
test("editor: stack vs overlay changes the rendering even for a single-series track", async () => {
    const one = (mode) => ({ local: { ml_res_layout: { presetId: "custom", tracks: [
        { id: "t", series: ["vram.0"], mode, heightPx: 96 },
    ] } } });
    const mk = async (mode) => {
        const w = await loadSidebarWorld({
            vram: [{ model: "a", vramGB: 19, vramBytes: 19 * 1024 ** 3, sizeBytes: 19 * 1024 ** 3,
                     gpus: [{ id: "0", runner: "CUDA", vramBytes: 19 * 1024 ** 3 }], expiresAt: null }],
            info: INFO_MIXED, ...one(mode),
        });
        await w.raw({ __mlSidebarOpen: true });
        w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
        await w.flush();
        await w.flush();
        return w;
    };

    const stacked = await mk("stack");
    assert.ok(stacked.shadow.querySelectorAll("polygon").length > 0, "stack draws per-model BANDS");
    assert.match(stacked.shadow.querySelector(".rc-legend").textContent, /free/, "with the pool's breakdown");

    const overlaid = await mk("overlay");
    assert.equal(overlaid.shadow.querySelectorAll("polygon").length, 0, "overlay draws no bands…");
    assert.ok(overlaid.shadow.querySelectorAll("polyline").length > 0, "…it draws a LINE of the pool's occupancy");
    assert.match(overlaid.shadow.querySelector(".rc-total").textContent, /% of each pool/,
        "and reads as a share, like any overlay");
});

// A cursor-following tip must never sit UNDER the cursor. Clamping `top` to the plot's edge did exactly that
// near the top of the chart: the tip landed on the pointer and covered the line it was describing.
test("chart tips: flip BELOW the cursor near the top edge instead of clamping onto it", async () => {
    const w = await loadSidebarWorld({
        vram: [{ model: "a", vramGB: 19, vramBytes: 19 * 1024 ** 3, sizeBytes: 19 * 1024 ** 3,
                 gpus: [{ id: "0", runner: "CUDA", vramBytes: 19 * 1024 ** 3 }], expiresAt: null }],
        info: INFO_MIXED,
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();

    const plot = w.shadow.querySelector(".rc-plot");
    const key = w.shadow.querySelector(".rc-key");
    const tipTop = async (y) => {
        key.dispatchEvent(new w.window.PointerEvent("pointerenter", { bubbles: true }));
        const ev = new w.window.PointerEvent("pointermove", { bubbles: true });
        Object.defineProperty(ev, "offsetY", { value: y });
        Object.defineProperty(ev, "offsetX", { value: 40 });
        plot.dispatchEvent(ev);
        await w.flush();
        return parseFloat(w.shadow.querySelector(".rc-tip").style.top);
    };

    // Room above → the tip sits above the cursor.
    const low = await tipTop(60);
    assert.ok(low < 60, `above the cursor when there is room (top ${low} < 60)`);
    // No room above → it goes BELOW, never onto the pointer.
    const high = await tipTop(4);
    assert.ok(high > 4, `below the cursor near the top edge (top ${high} > 4), not clamped onto it`);

    // The model ROW's tip is the third of these and had NO snapping at all — it ran off the window's right
    // edge. It carries .rc-tip now, so it shares both the look and the positioning.
    const row = w.shadow.querySelector(".vram-row");
    row.dispatchEvent(new w.window.PointerEvent("pointerenter", { bubbles: true }));
    const ev = new w.window.PointerEvent("pointermove", { bubbles: true, clientX: 5000, clientY: 300 });
    row.dispatchEvent(ev);
    await w.flush();
    const rowTip = w.shadow.querySelector(".vram-rowtip");
    assert.ok(rowTip.classList.contains("rc-tip"), "shares the one tooltip look, so sizes match across the panel");
    assert.equal(rowTip.style.left, "auto", "far right → it opens LEFTWARD instead of off-screen");
    assert.ok(parseFloat(rowTip.style.right) >= 2);
});

// A custom layout must SURVIVE a detour through a preset. It used to be destroyed: picking a preset
// overwrote the stored tracks, and the "Custom" entry only existed while it was already selected — so there
// was no way back to something you had built by hand.
test("layout: a custom layout survives picking a preset, and can be returned to", async () => {
    const w = await loadSidebarWorld({
        vram: [{ model: "a", vramGB: 19, vramBytes: 19 * 1024 ** 3, sizeBytes: 19 * 1024 ** 3,
                 gpus: [{ id: "0", runner: "CUDA", vramBytes: 19 * 1024 ** 3 }], expiresAt: null }],
        info: INFO_MIXED,
        local: { ml_res_layout: { presetId: "custom", custom: [{ id: "mine", series: ["vram.1"], mode: "stack", heightPx: 96 }],
                                  tracks: [{ id: "mine", series: ["vram.1"], mode: "stack", heightPx: 96 }] } },
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();

    const names = () => [...w.shadow.querySelectorAll(".rc-name")].map((n) => n.textContent);
    const picker = w.shadow.querySelector(".rc-preset");
    assert.deepEqual(names(), ["CUDA1"], "the custom layout is what we start on");
    assert.ok([...picker.options].some((o) => o.value === "custom"), "and Custom is an option");

    // Detour through a preset.
    picker.value = "overview";
    picker.dispatchEvent(new w.window.Event("change", { bubbles: true }));
    await w.flush();
    assert.ok(names().length >= 1 && names()[0] !== "CUDA1", "the preset takes over");
    assert.ok([...w.shadow.querySelector(".rc-preset").options].some((o) => o.value === "custom"),
        "Custom is STILL offered — it wasn't destroyed by looking at a preset");

    // …and back.
    const p2 = w.shadow.querySelector(".rc-preset");
    p2.value = "custom";
    p2.dispatchEvent(new w.window.Event("change", { bubbles: true }));
    await w.flush();
    assert.deepEqual(names(), ["CUDA1"], "returning to Custom restores exactly what was built");
    assert.deepEqual(w.localStore.ml_res_layout.custom, [{ id: "mine", series: ["vram.1"], mode: "stack", heightPx: 96 }],
        "and it is still on disk beside whatever is active");
});

// The editor grows from nothing and collapses the same way, rather than appearing at full height.
test("track editor: expands and collapses instead of snapping in", async () => {
    const w = await loadSidebarWorld({
        vram: [{ model: "a", vramGB: 8, vramBytes: 8 * 1024 ** 3, expiresAt: null }],
        info: INFO_MIXED,
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();

    // Mounted but collapsed — it must stay in the DOM, or a close has nothing to animate out.
    const wrap = w.shadow.querySelector(".rc-editor-wrap");
    assert.ok(wrap, "the editor is mounted even while closed");
    assert.ok(!wrap.classList.contains("open"), "…and collapsed");
    assert.ok(w.shadow.querySelector(".rc-editor"), "its content exists, ready to animate");

    w.shadow.querySelector('[aria-label="Edit tracks"]').click();
    await w.flush();
    assert.ok(w.shadow.querySelector(".rc-editor-wrap").classList.contains("open"), "opening is a class flip, so it transitions");

    w.shadow.querySelector('[aria-label="Edit tracks"]').click();
    await w.flush();
    assert.ok(!w.shadow.querySelector(".rc-editor-wrap").classList.contains("open"), "and it collapses the same way");

    // The animation is height-driven from the content's own size — a hardcoded max-height either clips the
    // editor or eases against empty space.
    const rule = cssRule(".rc-editor-wrap");
    assert.match(rule, /grid-template-rows:\s*0fr/, "collapsed to a zero-height row");
    assert.match(rule, /transition:[^;]*grid-template-rows/, "…and it transitions to the content's real height");
});

// The editor stays mounted so it can animate both ways — which means "closed" must genuinely occupy nothing.
// min-height:0 zeroes only the content box, so the editor's own margin/padding/border left a strip of empty
// panel between the header and the plot.
test("track editor: collapsed occupies no height at all, chrome included", async () => {
    const rule = cssRule(".rc-editor-wrap:not(.open) > *");   // the collapsed state has a rule of its own
    for (const prop of ["margin-block", "padding-block", "border-block-width"]) {
        assert.match(rule, new RegExp(`${prop}:\\s*0`), `${prop} is zeroed while collapsed`);
    }
    // And it eases rather than snapping, on the same curve as the row transition.
    assert.match(cssRule(".rc-editor-wrap > *"), /transition:[^;]*padding-block/);
});

// --- the panel's own box: dragging it taller, and what that must not clip --------------------------------

// The resource panel sits above the session list and competes with it for height, so it is draggable and the
// choice is remembered. (Layout is jsdom-less, so this covers the mechanics: the grip exists, a drag sets a
// height, it persists, and a saved height is applied on open. The feel is the e2e's job.)
test("resource panel: drag the bottom edge to resize, and the height is remembered", async () => {
    const w = await loadSidebarWorld({
        vram: [{ model: "a", vramGB: 8, vramBytes: 8 * 1024 ** 3, expiresAt: null }],
        info: INFO_MIXED,
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();

    const panel = w.shadow.querySelector(".vram");
    assert.ok(!panel.getAttribute("style"), "no height until you choose one — it sizes to its content");
    const grip = w.shadow.querySelector(".vram-grip");
    assert.ok(grip, "the boundary with the session list is a handle");

    grip.dispatchEvent(new w.window.PointerEvent("pointerdown", { bubbles: true, clientY: 300 }));
    w.window.dispatchEvent(new w.window.PointerEvent("pointermove", { clientY: 420, buttons: 1 }));
    await w.flush();
    const h = parseFloat(w.shadow.querySelector(".vram").style.height);
    assert.ok(h > 0, "dragging down sets a height");

    w.window.dispatchEvent(new w.window.PointerEvent("pointerup", {}));
    await w.flush();
    assert.equal(w.localStore.ml_vram_h, h, "…and it is remembered, not just applied");

    // A height can't be dragged to nothing. The floor is MEASURED from the rendered parts, and jsdom has no
    // layout — so this only checks the clamp holds at all; the real geometry is the e2e's job.
    grip.dispatchEvent(new w.window.PointerEvent("pointerdown", { bubbles: true, clientY: 300 }));
    w.window.dispatchEvent(new w.window.PointerEvent("pointermove", { clientY: -5000, buttons: 1 }));
    await w.flush();
    assert.ok(parseFloat(w.shadow.querySelector(".vram").style.height) > 0, "clamped, never dragged past zero");
    w.window.dispatchEvent(new w.window.PointerEvent("pointerup", {}));
});

test("resource panel: a remembered height is applied on open", async () => {
    const w = await loadSidebarWorld({
        vram: [{ model: "a", vramGB: 8, vramBytes: 8 * 1024 ** 3, expiresAt: null }],
        info: INFO_MIXED, local: { ml_vram_h: 240 },
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();
    assert.match(w.shadow.querySelector(".vram").getAttribute("style") || "", /height:\s*240px/);
});

// Dragging the panel taller must grow the CHART, not add empty space under it. jsdom has no layout, so this
// asserts the flex chain that makes it so — a fixed-height plot inside a resizable panel is the bug.
test("resource panel: the chart flexes into the dragged height", async () => {
    const css = sidebarCss();
    for (const sel of [".rc", ".rc-track", ".rc-plot"]) {
        assert.match(cssRule(sel), /flex:\s*1 1/, `${sel} must grow with the panel`);
    }
    // …but they must NOT be allowed to shrink below their content: `min-height: 0` let the chart be squeezed
    // past what fits, and a flex item smaller than its content overflows and renders ON TOP of the rows below.
    // Too little room is the panel's problem to solve by scrolling.
    assert.ok(!/min-height:\s*0/.test(cssRule(".rc")), ".rc must not shrink past its content");
    assert.ok(!/min-height:\s*0/.test(cssRule(".rc-track")), ".rc-track must not shrink past its content");
    // The plot keeps a floor so it can't collapse to nothing.
    assert.match(cssRule(".rc-plot"), /min-height:\s*\d+px/);
    assert.match(css, /\.vram\[style\*="height"\] \.rc-plot \{ height: auto/, "a dragged height releases the fixed one");
});

// A scroll container CLIPS its children, so the panel only scrolls once a height has been dragged — and the
// badges in the rows open their tooltips UPWARD, since the rows sit at the bottom where the room is above.
test("resource panel: badge tooltips aren't clipped by the resizable panel", async () => {
    const css = sidebarCss();
    const vram = cssRule(".vram");
    assert.ok(!/overflow-y:\s*auto/.test(vram), "no clipping until a height is chosen");
    assert.match(css, /\.vram\[style\*="height"\] \{ overflow-y: auto/, "…and only then");

    const w = await loadSidebarWorld({
        vram: [{ model: "a", vramGB: 8, vramBytes: 8 * 1024 ** 3, contextLength: 262144,
                 expiresAt: new Date(Date.now() + 60_000).toISOString() }],
        info: INFO_MIXED,
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();
    // Direction is no longer a class on the source — the floating layer computes it (tooltip-layer.ts), so
    // asserting `.above` here would be a green test with nothing behind it. What matters now is that the
    // source never renders in place (so a clipping ancestor is irrelevant, and its prose can't be copied).
    for (const sel of [".vram-ctx", ".vram-ttl"]) {
        assert.ok(w.shadow.querySelector(`${sel} .tt-pop`), `${sel} still carries its tooltip content`);
    }
    const ttPop = cssRule(".tt-pop");
    assert.match(ttPop, /display:\s*none/, "the source is never rendered in the flow, so nothing clips it");
});

// A panel dragged too small cannot fit its header, plot and rows — the content spilled over the session list
// below rather than shrinking. Both the drag and the stylesheet enforce a floor.
test("resource panel: the floor is MEASURED, not summed from parts", async () => {
    const { shortfall, measureFloor, layoutKey } = await import("../src/sidebar/vram.tsx");
    // Summing the parts is a guess about which parts exist and how tall they are — it goes stale the moment a
    // track grows a row or a name wraps, and the symptom is content rendering on top of itself. The shortfall
    // is what does not fit, whatever that content turns out to be.
    assert.equal(shortfall({ scrollHeight: 400, clientHeight: 300 }), 100, "exactly the height that is missing");
    assert.equal(shortfall({ scrollHeight: 300, clientHeight: 300 }), 0, "it fits → nothing to learn");
    assert.equal(shortfall({ scrollHeight: 200, clientHeight: 300 }), 0, "never negative — room to spare is not a floor");
    assert.equal(shortfall(null), 0);

    // The floor itself is asked for directly: squeeze the panel to nothing and see what its content then
    // needs. A shortfall read in the same frame as the height that caused it can be wrong (the chart settles a
    // frame later), which is what let a drag stop just under the floor and then jump when the correction
    // disagreed. One question, one answer, used by both.
    const el = {
        style: { height: "180px" }, scrollHeight: 0,
        set _h(v) { this.style.height = v; this.scrollHeight = v === "0px" ? 167 : 180; },
    };
    Object.defineProperty(el.style, "height", {
        get() { return this._v ?? "180px"; },
        set(v) { this._v = v; el.scrollHeight = v === "0px" ? 167 : 180; },
    });
    assert.equal(measureFloor(el), 167, "the minimum is what the content needs at zero height");
    assert.equal(el.style.height, "180px", "…and the panel is put back before anything is painted");
    assert.equal(measureFloor(null), 0);

    // The floor is keyed by the LAYOUT, so switching to a smaller view can shrink again rather than the panel
    // ratcheting permanently taller.
    assert.equal(layoutKey(3, 2), layoutKey(3, 2));
    assert.notEqual(layoutKey(3, 2), layoutKey(1, 2), "fewer tracks is a different floor");
    assert.notEqual(layoutKey(3, 2), layoutKey(3, 5), "…and so is a longer model list");
    // WIDTH too: tracks tile side by side once there is room, so a wide panel needs LESS height. The
    // correction only ever grows, so without this the floor learned in a narrow sidebar would never come back
    // down after you drag the sidebar out.
    assert.notEqual(layoutKey(3, 2, 460), layoutKey(3, 2, 1200), "a tiled layout is a different floor");
    assert.equal(layoutKey(3, 2, 1200), layoutKey(3, 2, 1240), "…but not a new one per pixel of width");
});

// A programmatic resize (switching views changes the floor) EASES; a drag must not, because easing the
// pointer would feel like lag. Driven by rAF, so the test steps the clock rather than waiting.
test("resize easing: eases to the target over time, and never snaps mid-flight", async () => {
    const { easeVramH } = await import("../src/sidebar/vram.tsx");
    const { vramH } = await import("../src/sidebar/store.ts");
    const frames = [];
    const realRaf = globalThis.requestAnimationFrame;
    // rAF timestamps share performance.now()'s origin — start there, or the elapsed fraction is nonsense.
    let now = performance.now();
    globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
    try {
        vramH.value = 200;
        easeVramH(400, 200);
        // It moves in steps, not one jump — and each step lands between where it was and where it's going.
        const seen = [];
        while (frames.length && seen.length < 40) {
            now += 25;
            const fn = frames.shift();
            fn(now);
            seen.push(vramH.value);
        }
        assert.ok(seen.length > 3, `several frames, not a snap (saw ${seen.length})`);
        assert.ok(seen.every((v) => v >= 200 && v <= 400), "never overshoots either end");
        for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], "monotonic toward the target");
        assert.equal(Math.round(seen.at(-1)), 400, "lands exactly on the target");
        // Ease-OUT: most of the distance is covered early, so it decelerates into place.
        assert.ok(seen[0] - 200 > (400 - seen.at(-2)), "decelerates — the first step moves further than the last");
    } finally { globalThis.requestAnimationFrame = realRaf; vramH.value = 0; }
});

test("resize easing: a tiny or first-time change is applied directly, not animated", async () => {
    const { easeVramH } = await import("../src/sidebar/vram.tsx");
    const { vramH } = await import("../src/sidebar/store.ts");
    const realRaf = globalThis.requestAnimationFrame;
    let scheduled = 0;
    globalThis.requestAnimationFrame = () => { scheduled++; return 1; };
    try {
        vramH.value = 0;                 // no height yet → nothing to animate FROM
        easeVramH(300);
        assert.equal(vramH.value, 300, "the first height is applied directly");
        vramH.value = 300;
        easeVramH(301);                  // a sub-pixel nudge would be an animation nobody can see
        assert.equal(vramH.value, 301);
        assert.equal(scheduled, 0, "neither case schedules a frame");
    } finally { globalThis.requestAnimationFrame = realRaf; vramH.value = 0; }
});

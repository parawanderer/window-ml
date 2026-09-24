// sidebar-vram.test.js — the VRAM monitor (what is resident, what it cost, evicting it) and the model
// status dot that reads the same residency into a session row.

const { test, after } = require("node:test");
const assert = require("node:assert");
const { closeSidebarWorlds, loadSidebarWorld } = require("./helpers");
const { chatStart, chatResult } = require("./sidebar-helpers");

// Close every jsdom window after the file — the VRAM panel's setInterval keeps a
// window's timers alive, which would otherwise hang the runner after all pass.
after(closeSidebarWorlds);

// The header status dot reflects the "responds-next" model's load state. It
// polls OLLAMA_PS only in detail view + slid-open, so each test opens the row.
async function openDetail(w, hash, model, opts = {}) {
    await w.raw({ __mlSidebarOpen: true });                 // slid open → polling allowed
    await w.dispatch(chatStart(hash, 0, "q", { model: opts.pending ? null : model, ...opts.startExtend }));
    if (!opts.pending) await w.dispatch(chatResult(hash, 0, "a", { model, extend: opts.extend ?? null }));
    w.shadow.querySelector(".row").click();
    await w.flush();
    return w.shadow.querySelector(".head .dot");
}

// --- the VRAM monitor: what is resident, what it cost, and evicting it -----------------------------------

test("VRAM monitor lists loaded models with a total, and evicts one + all", async () => {
    const w = await loadSidebarWorld({ vram: [
        { model: "qwen3:14b", vramGB: 8.2, vramBytes: 8 * 1024 ** 3, expiresAt: null },
        { model: "glm-ocr", vramGB: 2.1, vramBytes: 2 * 1024 ** 3, expiresAt: null },
    ] });
    await w.raw({ __mlSidebarOpen: true });                     // shell reports slid-open → polling allowed
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();   // restoreLayout resolves through a chrome.storage callback, a turn after the click                                            // let the poll effect run

    assert.equal(w.shadow.querySelectorAll(".vram-row").length, 2, "one row per loaded model");
    assert.match(w.shadow.querySelector(".vram-total").textContent, /10\.00 GiB/, "total VRAM summed, in BINARY units");
    // Rows are sorted by name (stable order, no reshuffle on load/evict).
    assert.deepEqual([...w.shadow.querySelectorAll(".vram-name")].map(n => n.textContent), ["glm-ocr", "qwen3:14b"]);

    w.shadow.querySelector(".vram-row .vram-x").click();        // evict the first (glm-ocr, sorted)
    await w.tick();
    assert.deepEqual(w.unloadCalls.at(-1), { model: "glm-ocr" });

    w.shadow.querySelector(".vram-free").click();               // free all
    await w.tick();
    assert.deepEqual(w.unloadCalls.at(-1), {});
});

// WHICH BUILD a model is: the quantization is the one choice a user makes about a model that changes its size, speed
// and answers at once, and the name rarely says which was pulled.
test("VRAM monitor shows each model's quantization, with its size and family behind it", async () => {
    const w = await loadSidebarWorld({ vram: [
        { model: "gemma4:31b", vramGB: 21.4, vramBytes: 8 * 1024 ** 3, contextLength: 8192, expiresAt: null, quant: "Q4_K_M", paramSize: "31.3B", family: "gemma4" },
        { model: "old-server", vramGB: 1.0, contextLength: null, expiresAt: null },   // a loading row or an unreported one
    ] });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();
    const rows = [...w.shadow.querySelectorAll(".vram-row")];
    const badge = rows[0].querySelector(".vram-quant");
    assert.ok(badge, "the quantization is on the row");
    // In WORDS on the chip; the code, and what it means, behind it.
    assert.equal(badge.firstChild.textContent.trim(), "4-bit weights");
    assert.match(badge.querySelector(".tt-pop").textContent, /Q4_K_M: Weights stored as 4-bit integers/);
    assert.match(badge.querySelector(".tt-pop").textContent, /31\.3B parameters, gemma4 family/);
    assert.equal(rows[1].querySelector(".vram-quant"), null, "nothing reported, nothing drawn — never a guess");
});

test("VRAM monitor shows the context a model was LOADED with (Ollama preallocates the KV cache)", async () => {
    const w = await loadSidebarWorld({ vram: [
        { model: "gemma4:31b", vramGB: 21.4, vramBytes: 8 * 1024 ** 3, contextLength: 262144, expiresAt: null },
        { model: "glm-ocr", vramGB: 2.1, vramBytes: 2 * 1024 ** 3, contextLength: 8192, expiresAt: null },
        { model: "old-server", vramGB: 1.0, contextLength: null, expiresAt: null },   // pre-0.11 Ollama: not reported
    ] });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();   // restoreLayout resolves through a chrome.storage callback, a turn after the click

    // Rows sort by name: gemma4:31b, glm-ocr, old-server. A missing context renders
    // NOTHING (rather than a misleading "0" / "?"), so only two chips exist.
    const chips = [...w.shadow.querySelectorAll(".vram-ctx")].map(n => n.textContent.trim().split("Loaded")[0]);
    assert.deepEqual(chips, ["256K", "8K"], "compact context chip per reporting model, none for the old server");
    assert.equal(w.shadow.querySelectorAll(".vram-row").length, 3, "the non-reporting model still gets a row");
    // The tooltip explains WHY it matters (preallocation), not just what it is.
    const tip = w.shadow.querySelector(".vram-ctx .tt-pop").textContent;
    assert.match(tip, /preallocates/i);
    // …and it RECONCILES the chip with the exact count. 262,144 tokens IS 256K, binary — but a chip reading
    // "256K" beside a tooltip reading "262,144" looks like two different numbers, and the reader has nothing
    // on screen telling them which to trust. Both forms, chip's first, plus the word that explains the gap.
    assert.match(tip, /256K-token context window/, "the chip's own figure leads");
    assert.match(tip, /262,144 tokens exactly/, "…then the exact count the server reported");
    assert.match(tip, /binary/, "…and why the two look different");
});

test("VRAM monitor: clicking a colour dot hides that model from the total", async () => {
    const w = await loadSidebarWorld({ vram: [
        { model: "qwen3:14b", vramGB: 8.2, vramBytes: 8 * 1024 ** 3, expiresAt: null },
        { model: "glm-ocr", vramGB: 2.1, vramBytes: 2 * 1024 ** 3, expiresAt: null },
    ] });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();   // restoreLayout resolves through a chrome.storage callback, a turn after the click
    assert.match(w.shadow.querySelector(".vram-total").textContent, /10\.00 GiB/);

    // Hide the first row (glm-ocr, 2.1) → total drops, row is marked off.
    w.shadow.querySelector(".vram-row .vram-dot").click();
    await w.tick();
    assert.match(w.shadow.querySelector(".vram-total").textContent, /8\.00 GiB/, "hidden model excluded from total");
    assert.ok(w.shadow.querySelector(".vram-row.off"), "hidden row is dimmed");

    // Click again → back in.
    w.shadow.querySelector(".vram-row .vram-dot").click();
    await w.tick();
    assert.match(w.shadow.querySelector(".vram-total").textContent, /10\.00 GiB/, "unhidden → back in total");
});

test("VRAM monitor pauses polling while the sidebar is slid closed", async () => {
    const w = await loadSidebarWorld({ vram: [{ model: "x", vramGB: 1, expiresAt: null }] });
    // sidebarOpen defaults false (no __mlSidebarOpen received) → poll is skipped
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.tick();
    assert.equal(w.shadow.querySelectorAll(".vram-row").length, 0, "no poll while closed");
});

test("VRAM monitor shows unavailable with no Ollama backend", async () => {
    const w = await loadSidebarWorld({ psError: "no ollama" });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();   // restoreLayout resolves through a chrome.storage callback, a turn after the click
    assert.match(w.shadow.querySelector(".vram-empty").textContent, /unavailable/);
});

test("VRAM panel shows a CPU-resident model's RAM size, not '?'", async () => {
    // vramBytes 0 / no gpus[] is the server's "on the CPU" — the row shows its RAM footprint, never "?".
    const w = await loadSidebarWorld({ vram: [{ model: "util:2b", vramGB: null, vramBytes: 0, sizeGB: 7.7, sizeBytes: 8 * 1024 ** 3, expiresAt: null }] });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();   // restoreLayout resolves through a chrome.storage callback, a turn after the click
    assert.match(w.shadow.querySelector(".vram-gb").textContent, /8\.00 GiB \(CPU\)/);
});

// --- the model status dot: residency, provenance and its tooltip -----------------------------------------

test("status dot: loaded (green) when the model is resident in VRAM", async () => {
    const w = await loadSidebarWorld({ vram: [{ model: "qwen3:14b", vramGB: 8, expiresAt: null }] });
    const dot = await openDetail(w, "s1", "qwen3:14b");
    assert.ok(dot.classList.contains("loaded"), `expected loaded, got "${dot.className}"`);
});

test("status dot: cold (blue) when installed but not resident", async () => {
    const w = await loadSidebarWorld({ models: ["qwen3:14b"], vram: [] });   // in the list, not in /api/ps
    const dot = await openDetail(w, "s2", "qwen3:14b");
    assert.ok(dot.classList.contains("cold"), `expected cold, got "${dot.className}"`);
});

test("status dot: unavailable (red) when the server doesn't list the model", async () => {
    const w = await loadSidebarWorld({ models: ["other:1b"], vram: [] });
    const dot = await openDetail(w, "s3", "ghost:70b");
    assert.ok(dot.classList.contains("unavailable"), `expected unavailable, got "${dot.className}"`);
});

test("status dot: in-flight (pulsing) while a turn is pending", async () => {
    const w = await loadSidebarWorld({ vram: [{ model: "qwen3:14b", vramGB: 8, expiresAt: null }] });
    const dot = await openDetail(w, "s4", "qwen3:14b", { pending: true });
    assert.ok(dot.classList.contains("inflight"), `expected inflight, got "${dot.className}"`);
});

test("status dot: tooltip shows the RIGHT variant's VRAM when a family shares a base name", async () => {
    const w = await loadSidebarWorld({ vram: [
        { model: "gemma4:e2b", vramGB: null, expiresAt: null },   // CPU-resident, listed first
        { model: "gemma4:31b", vramGB: 47.4, vramBytes: 47_400_000_000, expiresAt: null },
    ] });
    const dot = await openDetail(w, "sv", "gemma4:31b");
    assert.ok(dot.classList.contains("loaded"));
    const tip = dot.parentElement.querySelector(".tt-pop").textContent;
    // In GiB from the exact bytes, like the rest of the panel: 47.4e9 bytes is 44.14 GiB.
    assert.match(tip, /44\.14 GiB VRAM/, `tooltip should show the 31b's VRAM, got "${tip}"`);
});

test("status dot: a CPU-resident model's tooltip says CPU, not a fake VRAM number", async () => {
    const w = await loadSidebarWorld({ vram: [{ model: "gemma4:e2b", vramGB: null, sizeGB: 7.7, vramBytes: null, sizeBytes: 7_700_000_000, expiresAt: null }] });
    const dot = await openDetail(w, "scpu", "gemma4:e2b");
    const tip = dot.parentElement.querySelector(".tt-pop").textContent;
    assert.match(tip, /on CPU \(7\.17 GiB RAM\)/, `expected CPU RAM detail, got "${tip}"`);
});

test("status dot: tooltip flags partial CPU offload when size_vram < size", async () => {
    const w = await loadSidebarWorld({ vram: [{ model: "big:70b", vramGB: 30, sizeGB: 45, expiresAt: null }] });
    const dot = await openDetail(w, "spart", "big:70b");
    assert.ok(dot.classList.contains("loaded"));
    assert.match(dot.parentElement.querySelector(".tt-pop").textContent, /partial CPU offload/);
});

test("status dot: cloud (violet) for a listed-but-not-Ollama model", async () => {
    const w = await loadSidebarWorld({ models: ["gpt-4o", "local:8b"], ollamaModels: ["local:8b"], vram: [] });
    const dot = await openDetail(w, "scloud", "gpt-4o");
    assert.ok(dot.classList.contains("cloud"), `expected cloud, got "${dot.className}"`);
    assert.match(dot.parentElement.querySelector(".tt-pop").textContent, /External API/);
});

test("status dot: no cloud guess when provenance is unknown (ollamaModels null)", async () => {
    const w = await loadSidebarWorld({ models: ["gpt-4o"], ollamaModels: null, vram: [] });
    const dot = await openDetail(w, "sunk", "gpt-4o");
    // Can't confirm it's external → falls back to cold, never mislabels as cloud.
    assert.ok(dot.classList.contains("cold"), `expected cold, got "${dot.className}"`);
});

test("status dot: unknown (grey) when there's no Ollama backend", async () => {
    const w = await loadSidebarWorld({ psError: "no ollama" });
    const dot = await openDetail(w, "s5", "qwen3:14b");
    assert.ok(dot.classList.contains("unknown"), `expected unknown, got "${dot.className}"`);
});

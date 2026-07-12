const { test } = require("node:test");
const assert = require("node:assert");
const { loadSidebarWorld } = require("./helpers");

// Build __mlDebug events like injected.js emits them (see contract.ts).
const chatStart = (hash, turn, user, opts = {}) => ({
    kind: "chat", id: `${hash}-${turn}`, ts: Date.now() + turn, save: !!opts.save,
    session: { hash, turn }, streaming: false,
    request: {
        model: opts.model || "m",
        messages: [...(opts.system ? [{ role: "system", content: opts.system }] : []), { role: "user", content: user }],
        images: opts.images || null, toolIds: null, schema: false, think: null, maxTokens: null
    },
    config: {
        system: opts.system || null, model: opts.model || "m", think: opts.think ?? null,
        cleanup: opts.cleanup ?? true, schema: false, toolIds: null, maxTokens: null, save: !!opts.save
    }
});
const chatResult = (hash, turn, content, opts = {}) => ({
    kind: "chat-result", id: `${hash}-${turn}`, ts: Date.now() + turn, save: !!opts.save,
    session: { hash, turn }, content, sources: opts.sources || null, structured: !!opts.structured
});

test("sidebar mounts and shows the empty state", async () => {
    const w = await loadSidebarWorld();
    assert.ok(w.shadow, "shadow root mounted");
    assert.match(w.shadow.querySelector(".empty").textContent, /No ml calls yet/);
});

test("groups turns of one createChat into a single session (the item-1 fix)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(chatStart("aaa", 0, "first"));
    await w.dispatch(chatResult("aaa", 0, "reply one"));
    await w.dispatch(chatStart("aaa", 1, "second"));       // same hash → same session, not a new block
    await w.dispatch(chatResult("aaa", 1, "reply two"));

    const rows = w.shadow.querySelectorAll(".row");
    assert.equal(rows.length, 1, "one session, not two blocks");

    rows[0].click();                                       // open the session
    await w.tick();
    const users = [...w.shadow.querySelectorAll(".msg.user .utext")].map(n => n.textContent);
    assert.deepEqual(users, ["first", "second"]);          // two turns, in order
    assert.equal(w.shadow.querySelectorAll(".msg.asst").length, 2);
});

test("detail shows the options-first-message and renders assistant markdown with a raw toggle", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(chatStart("bbb", 0, "q", { model: "qwen", system: "be terse" }));
    await w.dispatch(chatResult("bbb", 0, "# Title\n**bold** text"));
    w.shadow.querySelector(".row").click();
    await w.tick();

    w.shadow.querySelector(".block .block-head").click();  // options is collapsed by default
    await w.tick();
    const opts = w.shadow.querySelector(".block .opts");   // the "first message" = options
    assert.match(opts.textContent, /model: qwen/);
    assert.match(opts.textContent, /system: be terse/);

    const md = w.shadow.querySelector(".msg.asst .md");    // markdown rendered by default
    assert.match(md.innerHTML, /<h1>Title<\/h1>/);
    assert.match(md.innerHTML, /<strong>bold<\/strong>/);

    w.shadow.querySelector(".msg.asst .raw-btn").click();  // toggle → raw
    await w.tick();
    assert.match(w.shadow.querySelector(".msg.asst .code").textContent, /\*\*bold\*\*/);
});

test("a result arriving while the detail view is OPEN re-renders it live (no stale …thinking)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(chatStart("eee", 0, "q"));
    w.shadow.querySelector(".row").click();                 // open detail while the turn is pending
    await w.tick();
    assert.ok(w.shadow.querySelector(".msg.asst .pending-note"), "shows …thinking while pending");

    await w.dispatch(chatResult("eee", 0, "the answer"));   // result lands WITHOUT re-navigating
    assert.ok(!w.shadow.querySelector(".pending-note"), "…thinking cleared live");
    assert.match(w.shadow.querySelector(".msg.asst .md").innerHTML, /the answer/);
});

test("status dot goes pending → ok, and a save:true call is tagged saved", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(chatStart("ccc", 0, "hi", { save: true }));
    let row = w.shadow.querySelector(".row");
    assert.ok(row.querySelector(".dot.pending"), "pending while in flight");
    assert.match(row.querySelector(".tag.saved").textContent, /saved/);

    await w.dispatch(chatResult("ccc", 0, "done", { save: true }));
    row = w.shadow.querySelector(".row");
    assert.ok(row.querySelector(".dot.ok"), "ok after the result settles");
});

test("settings: the font-size stepper scales --fs and persists it", async () => {
    const w = await loadSidebarWorld();
    const html = w.window.document.documentElement;
    w.shadow.querySelector('[title="Settings"]').click();                // open settings
    await w.tick();
    assert.ok(w.shadow.querySelector(".settings"), "settings panel opens");

    w.shadow.querySelectorAll(".stepper button")[1].click();   // the "+" button
    await w.tick();
    assert.equal(html.style.getPropertyValue("--fs"), "13.20px", "12 × 1.1");
    assert.equal(w.localStore.ml_debug_fontscale, 1.1, "persisted");
    assert.match(w.shadow.querySelector(".set-val").textContent, /110%/);
});

test("settings: a saved font scale is applied on mount", async () => {
    const w = await loadSidebarWorld({ local: { ml_debug_fontscale: 1.3 } });
    const html = w.window.document.documentElement;
    assert.equal(html.style.getPropertyValue("--fs"), "15.60px", "12 × 1.3 applied from storage");
});

test("settings view: loads config, populates the model datalist, gates + persists utility fields", async () => {
    const w = await loadSidebarWorld({ sync: { chatUrl: "http://host/api" }, models: ["qwen3:14b", "qwen3.5:0.8b"] });
    w.shadow.querySelector('[title="Settings"]').click();
    await w.tick();

    assert.equal(w.shadow.querySelector('input[type="text"]').value, "http://host/api", "chatUrl loaded from storage.sync");
    assert.equal(w.shadow.querySelectorAll("#ml-models option").length, 2, "model datalist populated from LIST_MODELS");
    assert.ok(w.shadow.querySelector('input[type="number"]').disabled, "utility context disabled until a utility model is set");

    const util = w.shadow.querySelector('input[placeholder="blank = use main model"]');
    util.value = "qwen3.5:0.8b";
    util.dispatchEvent(new w.window.Event("input", { bubbles: true }));
    util.dispatchEvent(new w.window.Event("change", { bubbles: true }));
    await w.tick();
    assert.equal(w.syncStore.utilityModel, "qwen3.5:0.8b", "utility model persisted to storage.sync");
    assert.ok(!w.shadow.querySelector('input[type="number"]').disabled, "utility context enabled once a model is set");
});

test("settings: Test models runs a per-model liveness check (set models pass, unset stays '—')", async () => {
    const w = await loadSidebarWorld({ sync: { model: "qwen3:14b", utilityModel: "gemma:2b" }, models: ["qwen3:14b"] });
    w.shadow.querySelector('[title="Settings"]').click();
    await w.tick();
    assert.equal(w.shadow.querySelectorAll(".test-row").length, 3, "one row per model role");

    w.shadow.querySelector(".test-btn").click();
    await w.tick();
    assert.equal(w.shadow.querySelectorAll(".test-ic.ok").length, 2, "the two set models pass");
    assert.equal(w.shadow.querySelectorAll(".test-ic.unset").length, 1, "the unset OCR model stays not-set");
});

test("settings: a failing model test shows the error", async () => {
    const w = await loadSidebarWorld({ sync: { model: "badmodel" }, fetchLlm: () => ({ error: "model not found" }) });
    w.shadow.querySelector('[title="Settings"]').click();
    await w.tick();
    w.shadow.querySelector(".test-btn").click();
    await w.tick();
    assert.ok(w.shadow.querySelector(".test-ic.err"), "error icon shown");
    assert.match(w.shadow.querySelector(".test-err").textContent, /model not found/);
});

test("settings view live-syncs a config change made elsewhere (e.g. the popup)", async () => {
    const w = await loadSidebarWorld();
    w.shadow.querySelector('[title="Settings"]').click();
    await w.tick();
    w.window.chrome.storage.sync.set({ model: "llama3:70b" });   // popup edit → storage.onChanged
    await w.tick();
    assert.equal(w.shadow.querySelector('input[placeholder="e.g. qwen3:14b"]').value, "llama3:70b");
});

test("VRAM monitor lists loaded models with a total, and evicts one + all", async () => {
    const w = await loadSidebarWorld({ vram: [
        { model: "qwen3:14b", vramGB: 8.2, expiresAt: null },
        { model: "glm-ocr", vramGB: 2.1, expiresAt: null },
    ] });
    await w.raw({ __mlSidebarOpen: true });                     // shell reports slid-open → polling allowed
    w.shadow.querySelector('[title="VRAM monitor"]').click();
    await w.flush();                                            // let the poll effect run

    assert.equal(w.shadow.querySelectorAll(".vram-row").length, 2, "one row per loaded model");
    assert.match(w.shadow.querySelector(".vram-total").textContent, /10\.3 GB/, "total VRAM summed");

    w.shadow.querySelector(".vram-row .vram-x").click();        // evict the first model
    await w.tick();
    assert.deepEqual(w.unloadCalls.at(-1), { model: "qwen3:14b" });

    w.shadow.querySelector(".vram-free").click();               // free all
    await w.tick();
    assert.deepEqual(w.unloadCalls.at(-1), {});
});

test("VRAM monitor pauses polling while the sidebar is slid closed", async () => {
    const w = await loadSidebarWorld({ vram: [{ model: "x", vramGB: 1, expiresAt: null }] });
    // sidebarOpen defaults false (no __mlSidebarOpen received) → poll is skipped
    w.shadow.querySelector('[title="VRAM monitor"]').click();
    await w.tick();
    assert.equal(w.shadow.querySelectorAll(".vram-row").length, 0, "no poll while closed");
});

test("VRAM monitor shows unavailable with no Ollama backend", async () => {
    const w = await loadSidebarWorld({ psError: "no ollama" });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[title="VRAM monitor"]').click();
    await w.flush();
    assert.match(w.shadow.querySelector(".vram-empty").textContent, /unavailable/);
});

test("an error result marks the turn (and session) failed", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(chatStart("ddd", 0, "boom"));
    await w.dispatch({ kind: "chat-error", id: "ddd-0", ts: Date.now(), save: false, session: { hash: "ddd", turn: 0 }, error: "HTTP 500" });
    assert.ok(w.shadow.querySelector(".row .dot.err"), "session shows error");
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.match(w.shadow.querySelector(".msg.asst.err .errtext").textContent, /HTTP 500/);
});

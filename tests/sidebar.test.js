const { test, after } = require("node:test");
const assert = require("node:assert");
const { loadSidebarWorld, closeSidebarWorlds } = require("./helpers");

// Close every jsdom window after the file — the VRAM panel's setInterval keeps a
// window's timers alive, which would otherwise hang the runner after all pass.
after(closeSidebarWorlds);

// Build __mlDebug events like injected.js emits them (see contract.ts).
const chatStart = (hash, turn, user, opts = {}) => ({
    kind: "chat", id: `${hash}-${turn}`, ts: Date.now() + turn, save: !!opts.save,
    session: { hash, turn }, streaming: false,
    request: {
        // Explicit null passes through (caller didn't name a model → default/utility).
        model: "model" in opts ? opts.model : "m",
        extend: opts.extend ?? null,
        messages: [...(opts.system ? [{ role: "system", content: opts.system }] : []), { role: "user", content: user }],
        images: opts.images || null, toolIds: null, schema: false, think: null, maxTokens: null
    },
    config: {
        system: opts.system || null, model: opts.model || "m", think: opts.think ?? null,
        schema: false, toolIds: null, maxTokens: null, save: !!opts.save
    }
});
const chatResult = (hash, turn, content, opts = {}) => ({
    kind: "chat-result", id: `${hash}-${turn}`, ts: Date.now() + turn, save: !!opts.save,
    session: { hash, turn }, content, sources: opts.sources || null, structured: !!opts.structured,
    model: opts.model ?? null, extend: opts.extend ?? null, reasoning: opts.reasoning ?? null
});
// ml.agent run events (see contract.ts DebugAgent*).
const agentStart = (hash, task, model = "m", maxSteps = 10) => ({ kind: "agent", id: hash, ts: Date.now(), save: false, session: { hash, turn: 0 }, task, model, maxSteps });
const agentStep = (hash, step, fields) => ({ kind: "agent-step", id: hash, ts: Date.now() + step, save: false, session: { hash, turn: step }, step, ...fields });
const agentResult = (hash, summary, steps, hitCap = false) => ({ kind: "agent-result", id: hash, ts: Date.now() + 100, save: false, session: { hash, turn: steps }, summary, steps, hitCap });

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
    // Rows are sorted by name (stable order, no reshuffle on load/evict).
    assert.deepEqual([...w.shadow.querySelectorAll(".vram-name")].map(n => n.textContent), ["glm-ocr", "qwen3:14b"]);

    w.shadow.querySelector(".vram-row .vram-x").click();        // evict the first (glm-ocr, sorted)
    await w.tick();
    assert.deepEqual(w.unloadCalls.at(-1), { model: "glm-ocr" });

    w.shadow.querySelector(".vram-free").click();               // free all
    await w.tick();
    assert.deepEqual(w.unloadCalls.at(-1), {});
});

test("VRAM monitor: clicking a colour dot hides that model from the total", async () => {
    const w = await loadSidebarWorld({ vram: [
        { model: "qwen3:14b", vramGB: 8.2, expiresAt: null },
        { model: "glm-ocr", vramGB: 2.1, expiresAt: null },
    ] });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[title="VRAM monitor"]').click();
    await w.flush();
    assert.match(w.shadow.querySelector(".vram-total").textContent, /10\.3 GB/);

    // Hide the first row (glm-ocr, 2.1) → total drops, row is marked off.
    w.shadow.querySelector(".vram-row .vram-dot").click();
    await w.tick();
    assert.match(w.shadow.querySelector(".vram-total").textContent, /8\.2 GB/, "hidden model excluded from total");
    assert.ok(w.shadow.querySelector(".vram-row.off"), "hidden row is dimmed");

    // Click again → back in.
    w.shadow.querySelector(".vram-row .vram-dot").click();
    await w.tick();
    assert.match(w.shadow.querySelector(".vram-total").textContent, /10\.3 GB/, "unhidden → back in total");
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

test("provenance: a utility-profile call shows the resolved model in the row, header, and per-reply chip", async () => {
    const w = await loadSidebarWorld();
    // extend:"utility" → the client-side request.model is null, but the server
    // resolves + reports the real model on the result.
    await w.dispatch(chatStart("prov", 0, "summarise this", { model: null }));
    await w.dispatch(chatResult("prov", 0, "a title", { model: "qwen3:0.5b", extend: "utility" }));

    const row = w.shadow.querySelector(".row");
    assert.equal(row.querySelector(".model").textContent, "qwen3:0.5b", "row shows the resolved model, not 'default'");
    assert.ok(row.querySelector(".profile"), "row shows the utility badge");

    row.click();
    await w.tick();
    assert.match(w.shadow.querySelector(".head-model").textContent, /qwen3:0\.5b/, "header shows the model that responds next");
    assert.match(w.shadow.querySelector(".head .profile").textContent, /utility/, "header carries the (utility) tag too");
    // The reply carries a click-to-copy model chip + a (utility) tag.
    const chip = w.shadow.querySelector(".msg.asst .model-name");
    assert.equal(chip.textContent, "qwen3:0.5b", "per-reply chip shows the resolved model");
    assert.match(w.shadow.querySelector(".msg.asst .profile-inline").textContent, /utility/, "per-reply (utility) tag");
});

test("provenance: a pending turn resolves its model from the config (not 'default')", async () => {
    const w = await loadSidebarWorld({ sync: { model: "gemma4:31b", utilityModel: "qwen3:0.5b" } });
    // Two just-created (still pending) turns — no results yet.
    await w.dispatch(chatStart("pend", 0, "hi", { model: null }));                    // default profile
    await w.dispatch(chatStart("pendu", 0, "hi", { model: null, extend: "utility" })); // utility profile

    // The list rows already resolve the pending model from config (not "default").
    const rows = [...w.shadow.querySelectorAll(".row")];
    const models = rows.map(r => r.querySelector(".model").textContent);
    assert.ok(models.includes("gemma4:31b"), "pending default row shows the configured default model");
    assert.ok(models.includes("qwen3:0.5b"), "pending utility row shows the utility model");

    // Header resolves it too. Open the default one (find by its resolved model).
    rows.find(r => r.querySelector(".model").textContent === "gemma4:31b").click();
    await w.tick();
    assert.match(w.shadow.querySelector(".head-model").textContent, /gemma4:31b/);
    assert.match(w.shadow.querySelector(".head .profile").textContent, /default/);
});

test("provenance: an explicitly-requested model gets no (default)/(utility) tag", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(chatStart("exp", 0, "hello", { model: "llama3:70b" }));
    await w.dispatch(chatResult("exp", 0, "hi", { model: "llama3:70b", extend: null }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.equal(w.shadow.querySelector(".msg.asst .model-name").textContent, "llama3:70b");
    assert.equal(w.shadow.querySelector(".msg.asst .profile-inline"), null, "no profile tag when the model was explicit");
});

test("provenance: a default-resolved reply is tagged (default)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(chatStart("def", 0, "hello", { model: null }));
    await w.dispatch(chatResult("def", 0, "hi", { model: "default-model", extend: null }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.match(w.shadow.querySelector(".msg.asst .profile-inline").textContent, /default/);
});

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
        { model: "gemma4:31b", vramGB: 47.4, expiresAt: null },
    ] });
    const dot = await openDetail(w, "sv", "gemma4:31b");
    assert.ok(dot.classList.contains("loaded"));
    const tip = dot.parentElement.querySelector(".tt-pop").textContent;
    assert.match(tip, /47\.4 GB VRAM/, `tooltip should show the 31b's VRAM, got "${tip}"`);
});

test("status dot: a CPU-resident model's tooltip says CPU, not a fake VRAM number", async () => {
    const w = await loadSidebarWorld({ vram: [{ model: "gemma4:e2b", vramGB: null, sizeGB: 7.7, expiresAt: null }] });
    const dot = await openDetail(w, "scpu", "gemma4:e2b");
    const tip = dot.parentElement.querySelector(".tt-pop").textContent;
    assert.match(tip, /on CPU \(7\.7 GB RAM\)/, `expected CPU RAM detail, got "${tip}"`);
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

test("VRAM panel shows a CPU-resident model's RAM size, not '?'", async () => {
    const w = await loadSidebarWorld({ vram: [{ model: "util:2b", vramGB: null, sizeGB: 7.7, expiresAt: null }] });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[title="VRAM monitor"]').click();
    await w.flush();
    assert.match(w.shadow.querySelector(".vram-gb").textContent, /7\.7 GB \(CPU\)/);
});

test("status dot: unknown (grey) when there's no Ollama backend", async () => {
    const w = await loadSidebarWorld({ psError: "no ollama" });
    const dot = await openDetail(w, "s5", "qwen3:14b");
    assert.ok(dot.classList.contains("unknown"), `expected unknown, got "${dot.className}"`);
});

test("thinking: a reply with reasoning shows a collapsed thinking block; without it, none", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(chatStart("th", 0, "q"));
    await w.dispatch(chatResult("th", 0, "the answer", { reasoning: "let me consider the options carefully" }));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const think = w.shadow.querySelector(".msg.asst details.thinking");
    assert.ok(think, "thinking disclosure present");
    assert.ok(!think.open, "collapsed by default");
    assert.match(think.textContent, /consider the options/);

    // A reply with no reasoning has no thinking block.
    await w.dispatch(chatStart("th2", 0, "q2"));
    await w.dispatch(chatResult("th2", 0, "plain answer"));
    w.shadow.querySelector(".nav").click();                     // back to list
    await w.tick();
    [...w.shadow.querySelectorAll(".row")].find(r => /q2/.test(r.textContent))?.click();
    await w.tick();
    assert.equal(w.shadow.querySelector(".msg.asst details.thinking"), null, "no thinking block without reasoning");
});

test("agent runs render as their own session with steps + a final answer", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("ag1", "find the login button", "qwen3:14b"));
    await w.dispatch(agentStep("ag1", 1, { thought: "Let me look at the page" }));
    await w.dispatch(agentStep("ag1", 1, { tool: "look", arguments: { selector: "nav" }, result: "a top navigation bar", elements: 1 }));
    await w.dispatch(agentResult("ag1", "The login button is top-right.", 2));

    const row = w.shadow.querySelector(".row");
    assert.ok(row.querySelector(".agent-badge"), "row shows the agent badge");
    assert.match(row.querySelector(".row-title").textContent, /find the login button/);

    row.click();
    await w.tick();
    // Both steps are turn 1 → grouped into one turn card (thought + the tool call).
    assert.equal(w.shadow.querySelectorAll(".aturn").length, 1, "one turn group");
    assert.match(w.shadow.querySelector(".step-pill").textContent, /step 1\/10/, "turn pill shows step/max");
    assert.ok(w.shadow.querySelector(".athought"), "the turn's thought is shown");
    const toolStep = w.shadow.querySelector(".astep.tool");
    assert.match(toolStep.querySelector(".tool-name").textContent, /look/);
    assert.match(toolStep.querySelector(".el-count").textContent, /1 el/);
    // Collapsed by default → shows a one-line preview of the result.
    assert.match(toolStep.querySelector(".astep-preview").textContent, /top navigation/);

    // Expand → In: args + Out: result.
    toolStep.querySelector(".astep-head").click();
    await w.tick();
    assert.match(toolStep.textContent, /selector/, "In: shows the args");
    assert.match(toolStep.textContent, /top navigation/, "Out: shows the result");
    assert.match(w.shadow.querySelector(".agent-summary").textContent, /login button is top-right/);
});

test("agent tool steps render descriptors (image / elements / table)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("agr", "look at stuff"));
    await w.dispatch(agentStep("agr", 1, { tool: "look", arguments: {}, render: { type: "image", src: "data:image/png;base64,AAA", label: "viewport" } }));
    await w.dispatch(agentStep("agr", 2, { tool: "findByText", arguments: { text: "cat" }, elements: 2, render: { type: "elements", items: [{ path: "div.card", text: "Black cat", index: 0 }, { path: "div.card", text: "White cat", index: 1 }] } }));
    await w.dispatch(agentStep("agr", 3, { tool: "stats", arguments: {}, render: { type: "table", columns: ["k", "v"], rows: [["a", 1], ["b", 2]] } }));
    await w.dispatch(agentResult("agr", "done", 3));

    w.shadow.querySelector(".row").click();
    await w.tick();
    for (const h of w.shadow.querySelectorAll(".astep.tool .astep-head")) h.click();   // expand all
    await w.tick();

    assert.equal(w.shadow.querySelector(".r-image img").getAttribute("src"), "data:image/png;base64,AAA");
    assert.match(w.shadow.querySelector(".r-image-label").textContent, /viewport/);
    assert.equal(w.shadow.querySelectorAll(".r-el").length, 2, "elements list rendered");
    assert.match(w.shadow.querySelector(".r-el-text").textContent, /Black cat/);
    assert.equal(w.shadow.querySelectorAll(".r-table td").length, 4, "table cells rendered");
});

test("agent tool step with a descriptor has a rendered⇄raw toggle (raw shows In:/Out:)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("agt", "run js"));
    await w.dispatch(agentStep("agt", 1, { tool: "exec", arguments: { js: "1 + 1" }, result: "2", render: { type: "code", text: "1 + 1", lang: "javascript" } }));
    await w.dispatch(agentResult("agt", "done", 1));

    w.shadow.querySelector(".row").click();
    await w.tick();
    const toolStep = w.shadow.querySelector(".astep.tool");
    toolStep.querySelector(".astep-head").click();   // expand
    await w.tick();
    // Rendered by default: the code descriptor, no In:/Out: yet.
    assert.ok(toolStep.querySelector(".code"), "rendered code descriptor shown");
    assert.equal(toolStep.querySelector("details.io"), null, "no raw In:/Out: while rendered");

    // Toggle to raw → In:/Out: appear.
    [...toolStep.querySelectorAll(".rr-toggle button")].find(b => b.textContent === "raw").click();
    await w.tick();
    assert.ok(toolStep.querySelector("details.io"), "raw view shows In:/Out:");
    assert.match(toolStep.textContent, /"js"/, "raw In: shows the args");
});

test("agent thought + failed tool show status dots", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("agd", "thing"));
    await w.dispatch(agentStep("agd", 1, { thought: "hmm" }));
    await w.dispatch(agentStep("agd", 1, { tool: "click", arguments: {}, result: "Error: no element matches" }));
    await w.dispatch(agentResult("agd", "done", 1));

    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.ok(w.shadow.querySelector(".athought .dot.ok"), "thought has an ok status dot");
    assert.ok(w.shadow.querySelector(".astep.tool .dot.err"), "failed tool call flagged err");
});

test("a running agent shows …running, then the answer arrives live", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("ag2", "do a thing"));
    assert.ok(w.shadow.querySelector(".row .dot.pending"), "row pending while running");
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.ok(w.shadow.querySelector(".pending-note"), "…running while in flight");

    await w.dispatch(agentResult("ag2", "all done", 1));   // lands while detail is open
    assert.ok(!w.shadow.querySelector(".pending-note"), "…running cleared live");
    assert.match(w.shadow.querySelector(".agent-summary").textContent, /all done/);
});

test("an agent that hits the step cap is flagged as stopped/error", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("ag3", "endless task"));
    await w.dispatch(agentResult("ag3", "Stopped at the 10-step cap without finishing.", 10, true));
    assert.ok(w.shadow.querySelector(".row .dot.err"), "capped run marked error");
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.match(w.shadow.querySelector(".agent-summary.capped").textContent, /step cap/);
});

test("detail: an assistant reply collapses to its first line and expands again", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(chatStart("col", 0, "q"));
    await w.dispatch(chatResult("col", 0, "First line here\n\nSecond paragraph with more detail."));
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.ok(w.shadow.querySelector(".msg.asst .md"), "expanded by default");

    w.shadow.querySelector(".who-toggle").click();              // collapse
    await w.tick();
    assert.ok(!w.shadow.querySelector(".msg.asst .md"), "markdown hidden when collapsed");
    const c = w.shadow.querySelector(".asst-collapsed");
    assert.match(c.textContent, /First line here/);
    assert.ok(!/Second paragraph/.test(c.textContent), "only the first line shows");
    assert.ok(c.querySelector(".more"), "trailing … since content is hidden");

    w.shadow.querySelector(".who-toggle").click();              // expand again
    await w.tick();
    assert.ok(w.shadow.querySelector(".msg.asst .md"), "markdown back after expand");
});

test("session titles: summarises the first prompt via the utility model when the panel is open", async () => {
    const calls = [];
    const w = await loadSidebarWorld({ sync: { utilityModel: "qwen3:0.5b" }, fetchLlm: (p) => { calls.push(p); return { data: '"Reverse a linked list."' }; } });
    await w.raw({ __mlSidebarOpen: true });                          // panel slid open → titles allowed
    await w.dispatch(chatStart("t1", 0, "how do I reverse a linked list in rust"));
    await w.dispatch(chatResult("t1", 0, "Here's how…"));
    await w.flush();

    const titleCall = calls.find(c => c.extend === "utility");
    assert.ok(titleCall, "title generated through extend:'utility'");
    // cleanTitle strips the wrapping quotes + trailing period the model returned.
    assert.equal(w.shadow.querySelector(".row-title").textContent, "Reverse a linked list");
});

test("session titles: no summary while the panel is slid closed (falls back to the prompt)", async () => {
    const calls = [];
    const w = await loadSidebarWorld({ sync: { utilityModel: "qwen3:0.5b" }, fetchLlm: (p) => { calls.push(p); return { data: "Should not be used" }; } });
    // no __mlSidebarOpen received → closed → titles must not generate
    await w.dispatch(chatStart("t2", 0, "some request text here"));
    await w.dispatch(chatResult("t2", 0, "reply"));
    await w.flush();

    assert.ok(!calls.some(c => c.extend === "utility"), "no title call while closed");
    assert.match(w.shadow.querySelector(".row-title").textContent, /some request text here/);
});

test("session titles: skipped when autoTitles is turned off in settings", async () => {
    const calls = [];
    const w = await loadSidebarWorld({ sync: { utilityModel: "qwen3:0.5b", autoTitles: false }, fetchLlm: (p) => { calls.push(p); return { data: "nope" }; } });
    await w.raw({ __mlSidebarOpen: true });
    await w.dispatch(chatStart("noauto", 0, "some request text here"));
    await w.dispatch(chatResult("noauto", 0, "reply"));
    await w.flush();

    assert.ok(!calls.some(c => c.extend === "utility"), "no title call when autoTitles is off");
    assert.match(w.shadow.querySelector(".row-title").textContent, /some request text here/);
});

test("session titles: skipped entirely when no utility model is configured (opt-in)", async () => {
    const calls = [];
    const w = await loadSidebarWorld({ fetchLlm: (p) => { calls.push(p); return { data: "unwanted" }; } });  // no utilityModel
    await w.raw({ __mlSidebarOpen: true });                          // open, but still opt-out
    await w.dispatch(chatStart("t3", 0, "some request text here"));
    await w.dispatch(chatResult("t3", 0, "reply"));
    await w.flush();

    assert.ok(!calls.some(c => c.extend === "utility"), "no title call without a utility model");
    assert.match(w.shadow.querySelector(".row-title").textContent, /some request text here/);
});

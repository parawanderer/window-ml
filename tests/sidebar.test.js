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
    model: opts.model ?? null, extend: opts.extend ?? null, reasoning: opts.reasoning ?? null,
    usage: opts.usage ?? null
});
// ml.agent run events (see contract.ts DebugAgent*).
const agentStart = (hash, task, model = "m", maxSteps = 10, config = null) => ({ kind: "agent", id: hash, ts: Date.now(), save: false, session: { hash, turn: 0 }, task, model, maxSteps, config });
const agentStep = (hash, step, fields) => ({ kind: "agent-step", id: hash, ts: Date.now() + step, save: false, session: { hash, turn: step }, step, ...fields });
const agentResult = (hash, summary, steps, hitCap = false) => ({ kind: "agent-result", id: hash, ts: Date.now() + 100, save: false, session: { hash, turn: steps }, summary, steps, hitCap });

// Open the settings panel and optionally switch to a category tab (Connection /
// Models / Appearance / Advanced). Controls are grouped under tabs, so a test that
// touches e.g. the model fields must select the "Models" tab first.
const openSettings = async (w, tab) => {
    w.shadow.querySelector('[aria-label="Settings"]').click();
    await w.tick();
    if (tab) {
        [...w.shadow.querySelectorAll(".set-tab")].find(b => b.textContent.trim() === tab).click();
        await w.tick();
    }
};

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

test("assistant markdown renders a GFM table (aligned, XSS-safe); a lone pipe stays a paragraph", async () => {
    const w = await loadSidebarWorld();
    const md = [
        "| Name | Score |",
        "| :--- | ---: |",
        "| <script>alert(1)</script> | 10 |",
        "| **Ada** | 20 |",
        "",
        "Just a | pipe in a paragraph.",
    ].join("\n");
    await w.dispatch(chatStart("ttt", 0, "q"));
    await w.dispatch(chatResult("ttt", 0, md));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const body = w.shadow.querySelector(".msg.asst .md");
    const table = body.querySelector("table.md-table");
    assert.ok(table, "GFM table rendered as a real <table>");
    const th = [...table.querySelectorAll("thead th")];
    assert.deepEqual(th.map(n => n.textContent), ["Name", "Score"], "header cells → <th>");
    assert.equal(th[0].style.textAlign, "left", "separator :--- → left align");
    assert.equal(th[1].style.textAlign, "right", "separator ---: → right align");

    const rows = table.querySelectorAll("tbody tr");
    assert.equal(rows.length, 2, "two body rows → <td>");
    assert.ok(rows[1].querySelector("strong"), "inline() runs on cells (**Ada** → <strong>)");

    // XSS: a <script> in a cell is escaped text, never live HTML.
    assert.ok(!body.querySelector("script"), "no live <script> from a cell");
    assert.match(body.innerHTML, /&lt;script&gt;/, "script tag escaped, not rendered");

    // A pipe outside a table header/separator pair stays an ordinary paragraph.
    const ps = [...body.querySelectorAll("p")].map(n => n.textContent);
    assert.ok(ps.includes("Just a | pipe in a paragraph."), "lone pipe line → <p>, not a table");
});

test("assistant markdown renders LaTeX math via KaTeX ($…$ inline, $$…$$ display); currency/prose isn't math", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(chatStart("math", 0, "q"));
    await w.dispatch(chatResult("math", 0, "Inline $6 \\times 7 = 42$ and display:\n$$E = mc^2$$\nIt costs $5 or $10."));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const body = w.shadow.querySelector(".msg.asst .md");
    const kx = body.querySelectorAll(".katex");
    assert.ok(kx.length >= 2, "both the inline (has \\times) and display math rendered as KaTeX");
    assert.ok(body.querySelector(".katex-display"), "the $$…$$ block is display mode");
    // Currency ("$5 or $10") is NOT treated as math (the space-inside guard).
    assert.match(body.textContent, /It costs \$5 or \$10\./, "currency stays literal, not math");
});

test("inline $…$ with NO math signal (dollars in prose) is NOT rendered as math — the 'FY sales ($k)' slop", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(chatStart("slop", 0, "q"));
    // Two $k) in prose used to pair into a giant italic math span.
    await w.dispatch(chatResult("slop", 0, 'A table titled "FY sales ($k)". This looks like the "FY sales ($k)" big one.'));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const body = w.shadow.querySelector(".msg.asst .md");
    assert.equal(body.querySelector(".katex"), null, "no KaTeX — the $…$ has no math signal (\\, ^, _)");
    assert.match(body.textContent, /FY sales \(\$k\)". This looks like the "FY sales \(\$k\)"/, "prose stays literal");
});

test("composer usage gauge: fills against the loaded model's context window (occupancy = latest turn, not a sum)", async () => {
    const w = await loadSidebarWorld({
        vram: [{ model: "gemma4:31b", vramGB: 21, contextLength: 1000, expiresAt: null }],
    });
    // Two turns on the same resident model. Each turn's promptTokens already includes
    // the prior turn (the whole history is re-sent), so occupancy is the LAST turn's
    // prompt+completion (250+50=300 → 30% of 1000), NOT 100+250 summed.
    await w.dispatch(chatStart("uuu", 0, "hi", { model: "gemma4:31b" }));
    await w.dispatch(chatResult("uuu", 0, "a", { model: "gemma4:31b", usage: { promptTokens: 80, completionTokens: 20, totalTokens: 100 } }));
    await w.dispatch(chatStart("uuu", 1, "more", { model: "gemma4:31b" }));
    await w.dispatch(chatResult("uuu", 1, "b", { model: "gemma4:31b", usage: { promptTokens: 250, completionTokens: 50, totalTokens: 300 } }));
    await w.raw({ __mlSidebarOpen: true });   // shell open → pollPs allowed to fetch the ps set (denominator)
    w.shadow.querySelector(".row").click();   // open the session (a detail view triggers a poll)
    await w.tick(); await w.flush();          // let the ps poll populate loadedModels

    const gauge = w.shadow.querySelector(".usage-gauge");
    assert.ok(gauge, "gauge renders in the composer");
    assert.match(w.shadow.querySelector(".usage-pct").textContent, /30%/, "occupancy is the latest turn (300/1000), not the sum");
    assert.ok(w.shadow.querySelector(".usage-fill"), "has a fill bar");
});

test("composer usage gauge: a DEFAULT session (no requested model) uses the RESOLVED model's window", async () => {
    // Regression: a plain ml.chat() has request.model === null (s.model null), but the
    // reply resolved to a resident model. The gauge must look up the RESOLVED model
    // (like the header), not s.model — else it wrongly falls back to cumulative spend.
    const w = await loadSidebarWorld({
        vram: [{ model: "gemma4:31b", vramGB: 21, contextLength: 1000, expiresAt: null }],
    });
    await w.dispatch(chatStart("dfl", 0, "hi", { model: null }));                       // caller named no model
    await w.dispatch(chatResult("dfl", 0, "a", { model: "gemma4:31b", usage: { promptTokens: 250, completionTokens: 50, totalTokens: 300 } }));  // resolved server-side
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector(".row").click();
    await w.tick(); await w.flush();

    assert.ok(w.shadow.querySelector(".usage-pct"), "a % gauge (not the cumulative fallback)");
    assert.match(w.shadow.querySelector(".usage-pct").textContent, /30%/, "measured against the resolved model's 1000-token window");
});

test("composer usage gauge: a utility-profile session measures against the UTILITY model's (small) window", async () => {
    // extend:"utility" also sends request.model === null, but resolves server-side to
    // the utility model — often loaded with a small utilityNumCtx. The gauge must use
    // that resolved model's window (here 4096), same shownModel path as the header.
    const w = await loadSidebarWorld({
        sync: { model: "gemma4:31b", utilityModel: "gemma4:e2b" },
        vram: [
            { model: "gemma4:31b", vramGB: 21, contextLength: 262144, expiresAt: null },
            { model: "gemma4:e2b", vramGB: 0, sizeGB: 6.8, contextLength: 4096, expiresAt: null },   // utility, small ctx, on CPU
        ],
    });
    await w.dispatch(chatStart("utl", 0, "summarise", { model: null, extend: "utility" }));
    await w.dispatch(chatResult("utl", 0, "sum", { model: "gemma4:e2b", extend: "utility", usage: { promptTokens: 1948, completionTokens: 100, totalTokens: 2048 } }));
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector(".row").click();
    await w.tick(); await w.flush();

    // 2048 / 4096 = 50% — measured against the UTILITY window, NOT the 262K main model.
    assert.ok(w.shadow.querySelector(".usage-pct"), "a % gauge against the utility window");
    assert.match(w.shadow.querySelector(".usage-pct").textContent, /50%/, "utility model's 4096 window, not the main model's 262K");
});

test("composer usage gauge: an unknown-window model shows RAW OCCUPANCY (last turn), not a cumulative sum", async () => {
    const w = await loadSidebarWorld({ vram: [] });   // never resident → no contextLength denominator, ever
    await w.dispatch(chatStart("ccl", 0, "hi", { model: "gpt-cloud" }));
    await w.dispatch(chatResult("ccl", 0, "a", { model: "gpt-cloud", usage: { promptTokens: 80, completionTokens: 20, totalTokens: 100 } }));
    await w.dispatch(chatStart("ccl", 1, "more", { model: "gpt-cloud" }));
    await w.dispatch(chatResult("ccl", 1, "b", { model: "gpt-cloud", usage: { promptTokens: 250, completionTokens: 50, totalTokens: 300 } }));
    w.shadow.querySelector(".row").click();
    await w.tick(); await w.flush();

    assert.ok(!w.shadow.querySelector(".usage-pct"), "no percentage without a known window");
    // Occupancy = the LAST turn's prompt+completion = 250+50 = 300 — NOT the 400 sum
    // (summing double-counts the re-sent history). Same numerator as the % branch.
    const total = w.shadow.querySelector(".usage-total").textContent;
    assert.match(total, /300/, "raw occupancy = latest turn");
    assert.ok(!/400/.test(total), "not the cumulative sum");
});

test("composer usage gauge: an EVICTED model keeps its % (remembers the window it was seen at)", async () => {
    // First poll sees gemma4:31b resident at 262144; a later poll finds it gone. The
    // gauge must keep showing occupancy% against the remembered window, not flip to a
    // raw count — a model's window is a property of the model, not of residency.
    const w = await loadSidebarWorld({ vram: [{ model: "gemma4:31b", vramGB: 21, contextLength: 262144, expiresAt: null }] });
    await w.dispatch(chatStart("evi", 0, "hi", { model: "gemma4:31b" }));
    await w.dispatch(chatResult("evi", 0, "a", { model: "gemma4:31b", usage: { promptTokens: 5000, completionTokens: 240, totalTokens: 5240 } }));
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector(".row").click();
    await w.tick(); await w.flush();
    assert.ok(w.shadow.querySelector(".usage-pct"), "shows a % while resident");

    // Model evicted → ps now empty. Re-poll and re-render.
    w.setVram([]);
    await w.flush(); await w.tick();
    assert.ok(w.shadow.querySelector(".usage-pct"), "STILL a % after eviction (window remembered)");
    assert.ok(!w.shadow.querySelector(".usage-total"), "did not flip to a raw-count fallback");
});

test("composer usage gauge: absent until the server reports token counts", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(chatStart("non", 0, "hi"));
    await w.dispatch(chatResult("non", 0, "a"));   // no usage on the result
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.ok(w.shadow.querySelector(".composer"), "the composer placeholder still renders");
    assert.ok(!w.shadow.querySelector(".usage-gauge"), "but no gauge without any usage data");
    assert.ok(w.shadow.querySelector(".cinput").disabled, "the input is a disabled placeholder");
    assert.ok(w.shadow.querySelector(".csend").disabled, "the send button is disabled");
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
    await openSettings(w, "Appearance");                                  // font size lives under Appearance
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
    await openSettings(w, "Connection");

    assert.equal(w.shadow.querySelector('input[type="text"]').value, "http://host/api", "chatUrl loaded from storage.sync");
    assert.equal(w.shadow.querySelectorAll("#ml-models option").length, 2, "model datalist populated from LIST_MODELS");

    [...w.shadow.querySelectorAll(".set-tab")].find(b => b.textContent.trim() === "Models").click();   // utility fields live under Models
    await w.tick();
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
    await openSettings(w, "Models");
    assert.equal(w.shadow.querySelectorAll(".test-row").length, 4, "one row per model role");

    w.shadow.querySelector(".test-btn").click();
    await w.tick();
    assert.equal(w.shadow.querySelectorAll(".test-ic.ok").length, 2, "the two set models pass");
    assert.equal(w.shadow.querySelectorAll(".test-ic.unset").length, 2, "the unset OCR + grounding stay not-set");
});

test("settings: Test models unloads only the models it freshly loaded (leaves already-warm ones)", async () => {
    const w = await loadSidebarWorld({
        sync: { model: "gemma4:31b", ocrModel: "qwen2.5vl:7b" },
        models: ["gemma4:31b", "qwen2.5vl:7b"],
        vram: [{ model: "gemma4:31b", vramGB: 20, sizeGB: 20, expiresAt: null }],   // default already resident
        caps: () => ["completion", "vision"],
    });
    await openSettings(w, "Models");
    w.shadow.querySelector(".test-btn").click();
    await w.tick(); await w.tick(); await w.tick();
    const unloaded = w.unloadCalls.map(c => c.model);
    assert.ok(unloaded.includes("qwen2.5vl:7b"), "the freshly-loaded OCR model was unloaded");
    assert.ok(!unloaded.includes("gemma4:31b"), "the already-warm default model was left resident");
});

test("settings: a failing model test shows the error", async () => {
    const w = await loadSidebarWorld({ sync: { model: "badmodel" }, fetchLlm: () => ({ error: "model not found" }) });
    await openSettings(w, "Models");
    w.shadow.querySelector(".test-btn").click();
    await w.tick();
    assert.ok(w.shadow.querySelector(".test-ic.err"), "error icon shown");
    // The error is prefixed with the role label so you can tell which model failed.
    assert.match(w.shadow.querySelector(".test-err").textContent, /Default:.*model not found/);
});

test("settings: grounding checkbox + model field persist, and the field is gated on the checkbox", async () => {
    const w = await loadSidebarWorld({ models: ["qwen2.5vl:7b"] });
    await openSettings(w, "Models");
    const field = () => w.shadow.querySelector('input[list="ml-models"][placeholder*="qwen2.5vl:7b"]');
    // Placeholder auto-detects the qwen on the server; field disabled until enabled.
    assert.ok(field(), "grounding field shows the auto-detected qwen as its placeholder");
    assert.ok(field().disabled, "grounding model field disabled while grounding is off");

    const check = [...w.shadow.querySelectorAll(".set-check")].find(l => /grounding model/i.test(l.textContent)).querySelector("input");
    check.click();
    await w.tick();
    assert.equal(w.syncStore.groundingEnabled, true, "enable persisted");
    assert.ok(!field().disabled, "field enabled once grounding is on");

    field().value = "qwen2.5vl:3b";
    field().dispatchEvent(new w.window.Event("change", { bubbles: true }));
    await w.tick();
    assert.equal(w.syncStore.groundingModel, "qwen2.5vl:3b", "grounding model persisted");
});

test("settings: grounding enabled + blank field tests the auto-detected model (not skipped)", async () => {
    const w = await loadSidebarWorld({
        sync: { groundingEnabled: true }, models: ["qwen2.5vl:7b"],
        caps: () => ["completion", "vision"], fetchLlm: () => ({ data: "250,750" }),
    });
    await openSettings(w, "Models");
    const gRow = () => [...w.shadow.querySelectorAll(".test-row")].find(r => /Grounding/.test(r.textContent));
    assert.match(gRow().textContent, /qwen2.5vl:7b/, "status row shows the auto-detected effective model");
    w.shadow.querySelector(".test-btn").click();
    await w.tick(); await w.tick();
    assert.ok(gRow().querySelector(".test-ic.ok"), "the auto-detected grounding model got tested, not left unset");
});

test("settings: editing a model invalidates its stale test result", async () => {
    const w = await loadSidebarWorld({ sync: { model: "qwen3:14b" }, models: ["qwen3:14b", "llama3:8b"] });
    await openSettings(w, "Models");
    w.shadow.querySelector(".test-btn").click();
    await w.tick(); await w.tick();
    const defRow = () => [...w.shadow.querySelectorAll(".test-row")].find(r => /Default/.test(r.textContent));
    assert.ok(defRow().querySelector(".test-ic.ok"), "default model passes after Test");

    const field = w.shadow.querySelector('input[placeholder="e.g. qwen3:14b"]');
    field.value = "llama3:8b";
    field.dispatchEvent(new w.window.Event("input", { bubbles: true }));
    await w.tick();
    assert.ok(!defRow().querySelector(".test-ic.ok"), "editing the model clears the stale pass");
    assert.match(defRow().textContent, /llama3:8b/, "row shows the new model");
});

test("settings: a vision-required role (OCR) fails RED when the model lacks vision capability", async () => {
    const w = await loadSidebarWorld({
        sync: { ocrModel: "text-only" },
        caps: (m) => m === "text-only" ? ["completion"] : null,   // no "vision"
        fetchLlm: () => ({ data: "OK" }),   // functional test would pass — but the cap gate stops it first
    });
    await openSettings(w, "Models");
    w.shadow.querySelector(".test-btn").click();
    await w.tick(); await w.tick();
    assert.ok(w.shadow.querySelector(".test-ic.err"), "OCR flagged failed");
    assert.match(w.shadow.querySelector(".test-err").textContent, /doesn't report vision capability/);
});

test("settings: a configured model the model-filter excludes is flagged RED up front (no test needed)", async () => {
    const w = await loadSidebarWorld({
        sync: { model: "qwen3:14b", ocrModel: "gpt-4o-cloud", modelFilter: "^qwen" },
        models: ["qwen3:14b", "gpt-4o-cloud"],
    });
    await openSettings(w, "Models");
    await w.tick();
    const rows = [...w.shadow.querySelectorAll(".test-row")];
    const ocrRow = rows.find(r => r.querySelector(".role").textContent === "OCR");
    const defRow = rows.find(r => r.querySelector(".role").textContent === "Default");
    // gpt-4o-cloud fails /^qwen/ → RED with the filter reason, statically (no Test click).
    assert.ok(ocrRow.querySelector(".test-ic.err"), "excluded OCR model flagged RED");
    assert.match(ocrRow.querySelector(".tt-pop").textContent, /Excluded by the model access filter/);
    // qwen3:14b matches → not flagged.
    assert.ok(!defRow.querySelector(".test-ic.err"), "a matching model is not flagged");
    // The input FIELD holding the excluded model is red-bordered where you're looking,
    // not only the status row far below.
    const ocrInput = [...w.shadow.querySelectorAll(".set-field")]
        .find(f => /OCR model/.test(f.querySelector(".lbl, label, .set-lbl")?.textContent || f.textContent))
        ?.querySelector("input");
    assert.ok(ocrInput && ocrInput.classList.contains("err"), "excluded OCR input red-bordered");
    const defInput = [...w.shadow.querySelectorAll(".set-field")]
        .find(f => /Default model/.test(f.textContent))?.querySelector("input");
    assert.ok(defInput && !defInput.classList.contains("err"), "matching Default input not flagged");
    // The model-picker datalist hides the excluded ids so the dropdown matches ml.models().
    const opts = [...w.shadow.querySelectorAll("#ml-models option")].map(o => o.value);
    assert.ok(opts.includes("qwen3:14b"), "datalist keeps a matching model");
    assert.ok(!opts.includes("gpt-4o-cloud"), "datalist hides an excluded model");
});

test("settings: unknown caps (cloud/non-Ollama) do NOT red a vision role — fall through to the functional test", async () => {
    const w = await loadSidebarWorld({
        sync: { ocrModel: "cloud-vlm" },
        caps: () => null,   // unknown → must not block
        fetchLlm: (p) => ({ data: p.messages[0].content.match(/[A-Z0-9]{4}/) ? "n/a" : "OK" }),
    });
    await openSettings(w, "Models");
    w.shadow.querySelector(".test-btn").click();
    await w.tick(); await w.tick();
    // It got PAST the cap gate to the OCR image test (which fails on our stub reply),
    // proving unknown caps didn't short-circuit to a capability error.
    assert.doesNotMatch(w.shadow.querySelector(".test-err")?.textContent || "", /vision capability/);
});

test("settings view live-syncs a config change made elsewhere (e.g. the popup)", async () => {
    const w = await loadSidebarWorld();
    await openSettings(w, "Models");
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
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
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

test("VRAM monitor shows the context a model was LOADED with (Ollama preallocates the KV cache)", async () => {
    const w = await loadSidebarWorld({ vram: [
        { model: "gemma4:31b", vramGB: 21.4, contextLength: 262144, expiresAt: null },
        { model: "glm-ocr", vramGB: 2.1, contextLength: 8192, expiresAt: null },
        { model: "old-server", vramGB: 1.0, contextLength: null, expiresAt: null },   // pre-0.11 Ollama: not reported
    ] });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();

    // Rows sort by name: gemma4:31b, glm-ocr, old-server. A missing context renders
    // NOTHING (rather than a misleading "0" / "?"), so only two chips exist.
    const chips = [...w.shadow.querySelectorAll(".vram-ctx")].map(n => n.textContent.trim().split("Loaded")[0]);
    assert.deepEqual(chips, ["256K", "8K"], "compact context chip per reporting model, none for the old server");
    assert.equal(w.shadow.querySelectorAll(".vram-row").length, 3, "the non-reporting model still gets a row");
    // The tooltip explains WHY it matters (preallocation), not just what it is.
    assert.match(w.shadow.querySelector(".vram-ctx .tt-pop").textContent, /preallocates/i);
});

test("VRAM monitor: clicking a colour dot hides that model from the total", async () => {
    const w = await loadSidebarWorld({ vram: [
        { model: "qwen3:14b", vramGB: 8.2, expiresAt: null },
        { model: "glm-ocr", vramGB: 2.1, expiresAt: null },
    ] });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
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
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.tick();
    assert.equal(w.shadow.querySelectorAll(".vram-row").length, 0, "no poll while closed");
});

test("VRAM monitor shows unavailable with no Ollama backend", async () => {
    const w = await loadSidebarWorld({ psError: "no ollama" });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
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
    assert.ok(row.querySelector(".profile"), "row shows the utility badge");
    assert.equal(row.querySelector(".model"), null, "the model name is not shown in the list row");

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

    // Rows are newest-first: pendu (utility) then pend (default). The header resolves
    // a still-pending turn's model from config (not "default") — the list row no
    // longer shows a model at all.
    const rows = [...w.shadow.querySelectorAll(".row")];
    assert.equal(rows.length, 2);
    assert.equal(rows[0].querySelector(".model"), null, "no model in the row");

    rows[1].click();   // pend (default), older → second
    await w.tick();
    assert.match(w.shadow.querySelector(".head-model").textContent, /gemma4:31b/, "pending default resolves to the configured model");
    assert.match(w.shadow.querySelector(".head .profile").textContent, /default/);

    w.shadow.querySelector('[aria-label="Back to sessions"]').click();
    await w.tick();
    [...w.shadow.querySelectorAll(".row")][0].click();   // pendu (utility), newest → first
    await w.tick();
    assert.match(w.shadow.querySelector(".head-model").textContent, /qwen3:0\.5b/, "pending utility resolves to the utility model");
    assert.match(w.shadow.querySelector(".head .profile").textContent, /utility/);
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
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
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
    assert.ok(w.shadow.querySelector(".aturn-prose"), "the turn's prose (content) is shown");
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
    assert.match(w.shadow.querySelector(".msg.asst").textContent, /login button is top-right/);
    // The merged reply bubble: a model chip + a raw⇄nice toggle, like a chat reply.
    assert.ok(w.shadow.querySelector(".msg.asst .model-name"), "answer shows the model chip");
    assert.ok(w.shadow.querySelector(".msg.asst .raw-btn"), "answer has a raw toggle");
});

test("debug In render of a click step is a hoverable element reference, not the card's intent sentence", async () => {
    // Regression: click/type emit an `action` intent descriptor (for the off-mode CARD). The DEBUG log
    // (overlay/devtools) must still render it as a hoverable/selectable element reference — the selector
    // + human label, hover-to-outline, right-click-to-copy — NOT the user-facing "Agent wants to…" sentence.
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("act1", "click the toggle", "m"));
    await w.dispatch(agentStep("act1", 1, {
        seq: 0, tool: "click", arguments: { selector: "#bigToggle" }, result: "Clicked #bigToggle",
        renderIn: { type: "action", verb: "Click", kind: "button", target: "Show the giant scrolling table", selector: "#bigToggle" },
    }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const toolStep = w.shadow.querySelector(".astep.tool");
    toolStep.querySelector(".astep-head").click();   // expand → In/Out
    await w.tick();

    const elRef = toolStep.querySelector(".r-el");
    assert.ok(elRef, "In renders a hoverable element reference");
    assert.match(elRef.querySelector(".r-el-path").textContent, /#bigToggle/, "shows the selector (copyable/hoverable)");
    assert.match(elRef.textContent, /Show the giant scrolling table/, "shows the human label too");
    assert.ok(!toolStep.querySelector(".action-sentence"), "the user-facing intent sentence stays OUT of the debug log");
});

test("a FINAL-answer turn with only reasoning (no thought/tool) still renders its thinking block", async () => {
    // The model thinks in reasoning_content and puts its answer in content → the content becomes the
    // summary (answer bubble), the reasoning is a reasoning-only step. It must NOT be filtered out.
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("fin", "what is 6*7"));
    await w.dispatch(agentStep("fin", 1, { reasoning: "6 times 7 is 42." }));   // reasoning-only, no thought/tool
    await w.dispatch(agentResult("fin", "It's 42.", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.ok(w.shadow.querySelector(".athought.athinking"), "the final turn's thinking block renders (not filtered out)");
    assert.match(w.shadow.querySelector(".msg.asst").textContent, /It's 42/, "the content shows as the answer");
});

test("a delegated look's Out renders the reader's image + which model + its output (not element text)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("lk", "look at the card"));
    await w.dispatch(agentStep("lk", 1, { tool: "look", arguments: { selector: "#card" }, result: "a sponsored product card",
        renderOut: { type: "look", image: "data:image/png;base64,SHOT", model: "qwen2.5vl", output: "a sponsored product card", label: 'the element "#card"' } }));
    await w.dispatch(agentResult("lk", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    w.shadow.querySelector(".astep.tool .astep-head").click();
    await w.tick();
    const look = w.shadow.querySelector(".r-look");
    assert.ok(look, "the look Out renders");
    assert.equal(look.querySelector("img").getAttribute("src"), "data:image/png;base64,SHOT", "the exact image the reader saw");
    assert.match(look.querySelector(".r-image-label").textContent, /viewed by.*qwen2\.5vl/, "names which model read it");
    assert.match(look.querySelector(".r-look-out").textContent, /sponsored product card/, "the model's output");
});

test("agent step: reasoning_content renders as a distinct 'thinking' block, separate from the prose thought", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("rsn", "click the red guy"));
    // A turn where the model thinks in reasoning_content AND says something in content.
    await w.dispatch(agentStep("rsn", 1, { thought: "I'll click it.", reasoning: "The red guy has a red cap and blue overalls." }));
    await w.dispatch(agentStep("rsn", 1, { tool: "click", arguments: { selector: "b" }, result: "clicked" }));
    await w.dispatch(agentResult("rsn", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const thinking = w.shadow.querySelector(".athought.athinking");
    assert.ok(thinking, "a distinct thinking block renders");
    assert.match(thinking.querySelector(".who").textContent, /thinking/);
    // Collapsed: no status dot (thinking can't fail), and the preview is an ~token estimate, NOT the text.
    assert.equal(thinking.querySelector(".dot"), null, "no status dot on a thinking block");
    assert.match(thinking.querySelector(".astep-preview").textContent, /~\d+ tokens/, "collapsed shows a token estimate");
    assert.doesNotMatch(thinking.querySelector(".astep-preview").textContent, /red cap/, "collapsed does NOT spam the reasoning text");
    // Expand it → the reasoning text.
    thinking.querySelector(".astep-head").click();
    await w.tick();
    assert.match(thinking.textContent, /red cap and blue overalls/, "reasoning shown");
    // The content is rendered as PROSE (like the answer) — no 'thought' label or status dot, expanded.
    const prose = w.shadow.querySelector(".aturn-prose");
    assert.ok(prose, "content renders as its own prose block");
    assert.equal(prose.querySelector(".who"), null, "no 'thought' label on the prose");
    assert.equal(prose.querySelector(".dot"), null, "no status dot on the prose");
    assert.match(prose.querySelector(".md").textContent, /I'll click it/, "the content prose is shown, expanded");
});

test("agent step renders IN-FLIGHT, then the DONE patches it in place (same seq → no duplicate row)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("ifl", "compute a thing"));
    // In-flight START: a pending tool call, no result yet.
    await w.dispatch(agentStep("ifl", 1, { seq: 1, pending: true, tool: "python_exec", arguments: { code: "return 6*7" } }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    let steps = w.shadow.querySelectorAll(".astep.tool");
    assert.equal(steps.length, 1, "the pending tool call renders while still running");
    assert.ok(steps[0].classList.contains("pending"), "step marked pending");
    assert.match(steps[0].querySelector(".astep-preview").textContent, /running/i, "shows a running indicator, not a result");

    // DONE for the same seq → patches the row in place (one step, now with the result).
    await w.dispatch(agentStep("ifl", 1, { seq: 1, tool: "python_exec", arguments: { code: "return 6*7" }, result: "42" }));
    await w.tick();
    steps = w.shadow.querySelectorAll(".astep.tool");
    assert.equal(steps.length, 1, "no duplicate row — the pending step was PATCHED, not appended");
    assert.ok(!steps[0].classList.contains("pending"), "no longer pending");
    assert.match(steps[0].querySelector(".astep-preview").textContent, /42/, "the result filled in");
});

test("agent view: a usage-only step (no thought/tool) does not render an empty step box", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("aus", "answer directly"));
    // The model answers on step 1 with no tools — the loop emits a usage-only step
    // (for the gauge). It must NOT render as a bare "STEP 1/10" box.
    await w.dispatch(agentStep("aus", 1, { usage: { promptTokens: 40, completionTokens: 10, totalTokens: 50 } }));
    await w.dispatch(agentResult("aus", "done, no tools needed.", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.equal(w.shadow.querySelectorAll(".aturn").length, 0, "no empty step group rendered");
    assert.match(w.shadow.querySelector(".msg.asst").textContent, /no tools needed/, "the answer still renders");
});

test("agent tool steps render descriptors (image / elements / table)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("agr", "look at stuff"));
    await w.dispatch(agentStep("agr", 1, { tool: "look", arguments: {}, renderOut: { type: "image", src: "data:image/png;base64,AAA", label: "viewport" } }));
    await w.dispatch(agentStep("agr", 2, { tool: "findByText", arguments: { text: "cat" }, elements: 2, renderOut: { type: "elements", items: [{ path: "div.card", text: "Black cat", index: 0 }, { path: "div.card", text: "White cat", index: 1 }] } }));
    await w.dispatch(agentStep("agr", 3, { tool: "stats", arguments: {}, renderIn: { type: "table", columns: ["k", "v"], rows: [["a", 1], ["b", 2]] } }));
    await w.dispatch(agentResult("agr", "done", 3));

    w.shadow.querySelector(".row").click();
    await w.tick();
    for (const h of w.shadow.querySelectorAll(".astep.tool .astep-head")) h.click();   // expand all
    await w.tick();

    assert.equal(w.shadow.querySelector(".r-image img").getAttribute("src"), "data:image/png;base64,AAA");
    assert.match(w.shadow.querySelector(".r-image-label").textContent, /viewport/);
    assert.equal(w.shadow.querySelectorAll(".r-el").length, 2, "elements list rendered");
    assert.match(w.shadow.querySelector(".r-el-text").textContent, /Black cat/);
    assert.equal(w.shadow.querySelectorAll(".r-el-idx").length, 2, "multiple elements → each shows its #N badge");
    assert.equal(w.shadow.querySelector(".r-table td") ? w.shadow.querySelectorAll(".r-table td").length : 0, 4, "table cells rendered");
});

test("a SINGLE-element render hides the #0 badge (it's just the one element)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("one", "find the button"));
    await w.dispatch(agentStep("one", 1, { tool: "locate", arguments: {}, renderOut: { type: "elements", items: [{ path: "#go", text: "Go" }] } }));
    await w.dispatch(agentResult("one", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    w.shadow.querySelector(".astep.tool .astep-head").click();
    await w.tick();
    assert.equal(w.shadow.querySelectorAll(".r-el").length, 1, "one element rendered");
    assert.equal(w.shadow.querySelector(".r-el-idx"), null, "no #0 badge for a single element");
    assert.match(w.shadow.querySelector(".r-el-path").textContent, /#go/, "the element still shows");
});

// Helper: build a locate render descriptor from an array of substeps + the final pick.
const locateRender = (mode, model, substeps, extra = {}) => ({ type: "locate", mode, model, substeps, ...extra });

test("locate render: grounding is a box substep + a DOM-snap substep, with the pick", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("lgr", "find it"));
    await w.dispatch(agentStep("lgr", 1, { tool: "locate", arguments: { description: "star" }, elements: 1, renderOut:
        locateRender("grounding", "qwen2.5vl:7b", [
            { label: "Grounding · box (250, 250) → (300, 300)", prompt: "Locate \"star\" …", output: "250,250,300,300", rawImage: "data:image/png;base64,GGGraw", image: "data:image/png;base64,GGG" },
            { label: "DOM snap · +40px search margin", image: "data:image/png;base64,RRR" },
        ], { picked: "[button] \"Star\" → #bar > div:nth-of-type(1)", pickedBy: "snap" }) }));
    await w.dispatch(agentResult("lgr", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    for (const h of w.shadow.querySelectorAll(".astep.tool .astep-head")) h.click();
    await w.tick();

    const loc = w.shadow.querySelector(".r-locate");
    assert.match(loc.querySelector(".r-loc-head").textContent, /Grounding · qwen2.5vl:7b/);
    assert.equal(loc.querySelectorAll(".r-loc-sub").length, 2, "two substeps");
    assert.ok(loc.querySelector(".r-loc-io"), "In(prompt) disclosure present");
    assert.match(loc.textContent, /box \(250, 250\) → \(300, 300\)/);      // box coords in substep 1's head
    assert.match(loc.textContent, /\+40px search margin/);                  // margin in substep 2's head
    assert.match(loc.textContent, /Out:.*250,250,300,300/);   // Out is a collapsible like In
    // Default view is "visualise" → the overlay images.
    const imgs = [...loc.querySelectorAll(".r-loc-stage img")].map(i => i.getAttribute("src"));
    assert.deepEqual(imgs, ["data:image/png;base64,GGG", "data:image/png;base64,RRR"]);
    assert.match(loc.querySelector(".r-loc-picked").textContent, /Snapped to[\s\S]*Star[\s\S]*nth-of-type\(1\)/);
});

test("locate render: the raw⇄visualise toggle swaps to the exact image sent to the model", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("lrv", "find it"));
    await w.dispatch(agentStep("lrv", 1, { tool: "locate", arguments: { description: "x" }, elements: 1, renderOut:
        locateRender("marks", "gemma4:31b", [
            { label: "Set-of-Marks · 3 candidates · model chose #2", prompt: "which badge…", output: "2", rawImage: "data:image/png;base64,SENT", image: "data:image/png;base64,OVERLAY" },
        ], { picked: "#2 [button] → #b", pickedBy: "model" }) }));
    await w.dispatch(agentResult("lrv", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    for (const h of w.shadow.querySelectorAll(".astep.tool .astep-head")) h.click();
    await w.tick();
    const loc = w.shadow.querySelector(".r-locate");
    assert.equal(loc.querySelector(".r-loc-stage img").getAttribute("src"), "data:image/png;base64,OVERLAY", "visualise by default");
    const toggle = loc.querySelector(".r-loc-viz");
    [...toggle.querySelectorAll("button")].find(b => b.textContent === "raw").click();
    await w.tick();
    assert.equal(w.shadow.querySelector(".r-locate .r-loc-stage img").getAttribute("src"), "data:image/png;base64,SENT", "raw = the image sent to the model");
});

test("locate render: no-box grounding is a single box substep (no snap)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("lnb", "find it"));
    await w.dispatch(agentStep("lnb", 1, { tool: "locate", arguments: { description: "ghost" }, renderOut:
        locateRender("grounding", "qwen2.5vl:3b", [
            { label: "Grounding · no box returned", prompt: "Locate …", output: "NONE", image: "data:image/png;base64,PLAIN" },
        ]) }));
    await w.dispatch(agentResult("lnb", "not found", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    for (const h of w.shadow.querySelectorAll(".astep.tool .astep-head")) h.click();
    await w.tick();
    const loc = w.shadow.querySelector(".r-locate");
    assert.equal(loc.querySelectorAll(".r-loc-sub").length, 1, "one substep, no snap");
    assert.match(loc.querySelector(".r-loc-subhead").textContent, /no box returned/);
    assert.match(loc.querySelector(".r-loc-picked").textContent, /Snapped to[\s\S]*\(none\)/);
});

test("locate render: marks is one Set-of-Marks substep with the pick", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("lmk", "find it"));
    await w.dispatch(agentStep("lmk", 1, { tool: "locate", arguments: { description: "trash" }, elements: 1, renderOut:
        locateRender("marks", "gemma4:31b", [
            { label: "Set-of-Marks · 4 candidates · model chose #2", prompt: "which badge…", output: "2", rawImage: "data:image/png;base64,RAW", image: "data:image/png;base64,MARKS" },
        ], { picked: "#2 [button] → #bar > div:nth-of-type(2)", pickedBy: "model" }) }));
    await w.dispatch(agentResult("lmk", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    for (const h of w.shadow.querySelectorAll(".astep.tool .astep-head")) h.click();
    await w.tick();
    const loc = w.shadow.querySelector(".r-locate");
    assert.match(loc.querySelector(".r-loc-head").textContent, /Set-of-Marks · gemma4:31b/);
    assert.equal(loc.querySelector(".r-loc-stage img").getAttribute("src"), "data:image/png;base64,MARKS");
    assert.match(loc.querySelector(".r-loc-picked").textContent, /Model picked[\s\S]*nth-of-type\(2\)/);
});

test("locate render: auto-fallback shows the grounding attempt substep above the Set-of-Marks one", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("lfb", "find it"));
    await w.dispatch(agentStep("lfb", 1, { tool: "locate", arguments: { description: "trash" }, elements: 1, renderOut:
        locateRender("marks", "gemma4:31b", [
            { label: "Grounding · no box returned", prompt: "Locate…", output: "NONE", image: "data:image/png;base64,GROUND" },
            { label: "Set-of-Marks · 5 candidates · model chose #2", note: "Grounding returned no box — fell back to Set-of-Marks.", prompt: "which badge…", output: "2", rawImage: "data:image/png;base64,RAW", image: "data:image/png;base64,MARKS" },
        ], { picked: "#2 [button] → #bar > div:nth-of-type(2)", pickedBy: "model" }) }));
    await w.dispatch(agentResult("lfb", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    for (const h of w.shadow.querySelectorAll(".astep.tool .astep-head")) h.click();
    await w.tick();
    const loc = w.shadow.querySelector(".r-locate");
    assert.match(loc.querySelector(".r-loc-note").textContent, /Grounding returned no box.*fell back to Set-of-Marks/);
    const imgs = [...loc.querySelectorAll(".r-loc-stage img")].map(i => i.getAttribute("src"));
    assert.deepEqual(imgs, ["data:image/png;base64,GROUND", "data:image/png;base64,MARKS"], "grounding attempt first, then marks");
});

test("locate render: grid single-element — cell-pick substep + DOM snap, 'Snapped to'", async () => {
    const w = await loadSidebarWorld();
    // Driver model == the sub-call model → the "standalone sub-call" note should show.
    await w.dispatch(agentStart("lgs", "find it", "gemma4:31b", 10));
    await w.dispatch(agentStep("lgs", 1, { tool: "locate", arguments: { description: "star", strategy: "grid" }, elements: 1, renderOut:
        locateRender("grid", "gemma4:31b", [
            { label: "Cell pick · grid 4×4 · model chose cells 2,3", prompt: "This image is divided into a 4×4 …", output: "2,3", rawImage: "data:image/png;base64,GRIDraw", image: "data:image/png;base64,GRID" },
            { label: "DOM snap · single element in the cell", image: "data:image/png;base64,SNAP" },
        ], { picked: "[button] → #bar > div:nth-of-type(3)", pickedBy: "snap" }) }));
    await w.dispatch(agentResult("lgs", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    for (const h of w.shadow.querySelectorAll(".astep.tool .astep-head")) h.click();
    await w.tick();
    const loc = w.shadow.querySelector(".r-locate");
    assert.match(loc.querySelector(".r-loc-head").textContent, /Grid · gemma4:31b/);
    assert.match(loc.querySelector(".r-loc-delegated").textContent, /standalone sub-call/);
    assert.match([...loc.querySelectorAll(".r-loc-subhead")].map(c => c.textContent).join(" "), /grid 4×4 · model chose cells 2,3/);
    const imgs = [...loc.querySelectorAll(".r-loc-stage img")].map(i => i.getAttribute("src"));
    assert.deepEqual(imgs, ["data:image/png;base64,GRID", "data:image/png;base64,SNAP"], "grid image then the snap");
    assert.match(loc.querySelector(".r-loc-picked").textContent, /Snapped to[\s\S]*nth-of-type\(3\)/);
    assert.equal(loc.querySelector(".r-loc-note"), null, "no hand-off note when a single element");
});

test("locate render: grid hand-off is two substeps (cell pick → Set-of-Marks pick), 'Model picked'", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("lgh", "find it", "gemma4:31b", 10));
    await w.dispatch(agentStep("lgh", 1, { tool: "locate", arguments: { description: "star", strategy: "grid" }, elements: 1, renderOut:
        locateRender("grid", "gemma4:31b", [
            { label: "Cell pick · grid 5×3 · model chose cell 11", prompt: "grid…", output: "11", rawImage: "data:image/png;base64,GRIDraw", image: "data:image/png;base64,GRID" },
            { label: "Set-of-Marks · 15 candidates · model chose #12", note: "The cell held 15 elements, so they were re-badged and a second vision call picked one (Set-of-Marks).", prompt: "which badge…", output: "12", rawImage: "data:image/png;base64,RAW", image: "data:image/png;base64,MARKS" },
        ], { picked: "#12 [div] → #grid > div:nth-of-type(92)", pickedBy: "model" }) }));
    await w.dispatch(agentResult("lgh", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    for (const h of w.shadow.querySelectorAll(".astep.tool .astep-head")) h.click();
    await w.tick();
    const loc = w.shadow.querySelector(".r-locate");
    assert.equal(loc.querySelectorAll(".r-loc-sub").length, 2, "two substeps");
    assert.match(loc.querySelector(".r-loc-note").textContent, /held 15 elements.*second vision call picked one/i);
    assert.match([...loc.querySelectorAll(".r-loc-subhead")].map(c => c.textContent).join(" "), /Set-of-Marks · 15 candidates · model chose #12/);
    assert.match(loc.querySelector(".r-loc-picked").textContent, /Model picked[\s\S]*#12[\s\S]*nth-of-type\(92\)/);
});

test("locate render: no delegated note when the sub-call model differs from the driver", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("lgd", "find it", "qwen3:14b", 10));   // driver ≠ reader
    await w.dispatch(agentStep("lgd", 1, { tool: "locate", arguments: { description: "star" }, elements: 1, renderOut:
        locateRender("marks", "gemma4:31b", [{ label: "Set-of-Marks · 2 candidates", image: "data:image/png;base64,MARKS" }], { picked: "#1 [button] → #b", pickedBy: "model" }) }));
    await w.dispatch(agentResult("lgd", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    for (const h of w.shadow.querySelectorAll(".astep.tool .astep-head")) h.click();
    await w.tick();
    assert.equal(w.shadow.querySelector(".r-loc-delegated"), null, "different model → no standalone-note");
});

test("agent tool step: descriptor renders its target block; the other stays raw (per-block)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("agt", "run js"));
    // exec-style: the descriptor targets "in" (pretty JS); Out stays raw (the error/result).
    await w.dispatch(agentStep("agt", 1, { tool: "exec", arguments: { js: "1 + 1" }, result: "2", renderIn: { type: "code", text: "1 + 1", lang: "javascript" } }));
    await w.dispatch(agentResult("agt", "done", 1));

    w.shadow.querySelector(".row").click();
    await w.tick();
    const toolStep = w.shadow.querySelector(".astep.tool");
    toolStep.querySelector(".astep-head").click();   // expand
    await w.tick();

    const blocks = [...toolStep.querySelectorAll("details.io")];
    assert.equal(blocks.length, 2, "In + Out blocks");
    const [inB, outB] = blocks;
    assert.ok(inB.querySelector(".rr-toggle"), "In (descriptor target) has the rendered/raw toggle");
    assert.ok(inB.querySelector(".code"), "In renders the JS by default");
    assert.equal(outB.querySelector(".rr-toggle"), null, "Out has no toggle — raw only");
    assert.match(outB.textContent, /2/, "Out shows the raw result");

    // Toggle In → raw → the JSON args.
    [...inB.querySelectorAll(".rr-toggle button")].find(b => b.textContent === "raw").click();
    await w.tick();
    assert.match(inB.textContent, /"js"/, "In raw shows the JSON args");
});

test("python-in: an external-sheet source renders a smart chip with the real title (not the raw id)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("pysh", "sum the sheet"));
    await w.dispatch(agentStep("pysh", 1, { tool: "python_exec", arguments: { code: "return df.sum()" }, result: "ok",
        renderIn: { type: "python-in", mode: "script", code: "return df.sum()",
            tables: [{ name: "df", source: { kind: "sheet-external", label: "SHEETID44CHARS", name: "Quarterly Sales" }, columns: ["A"], rows: [[1]] }] } }));
    await w.dispatch(agentResult("pysh", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    w.shadow.querySelector(".astep.tool .astep-head").click();
    await w.tick();
    const chip = w.shadow.querySelector(".r-py-in .sheet-chip");
    assert.ok(chip, "the sheet source is a smart chip");
    assert.match(chip.querySelector(".sheet-chip-name").textContent, /Quarterly Sales/, "shows the real title, not the id");
    assert.match(chip.getAttribute("href"), /spreadsheets\/d\/SHEETID44CHARS/, "links to the sheet by id");
});

test("python_exec render: In is a notebook cell (mode + input image + source); Out is stdout + token", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("pyc", "click the star"));
    await w.dispatch(agentStep("pyc", 1, {
        tool: "python_exec", arguments: { code: "return [10, 20]", cast: "pt" },
        result: "stdout:\nfound\n\n→ @pt:abcd1234 at (10, 20).",
        renderIn: { type: "python-in", mode: "pt", code: "return [10, 20]", image: "data:image/png;base64,INIMG" },
        renderOut: { type: "python-out", stdout: "found\n", token: "@pt:abcd1234" },
    }));
    await w.dispatch(agentResult("pyc", "done", 1));

    w.shadow.querySelector(".row").click();
    await w.tick();
    const toolStep = w.shadow.querySelector(".astep.tool");
    toolStep.querySelector(".astep-head").click();
    await w.tick();

    // In slot = the python-in cell header.
    const inCell = toolStep.querySelector(".r-py-in");
    assert.ok(inCell, "In renders the python-in cell");
    assert.match(inCell.querySelector(".r-py-mode").textContent, /cast: pt/, "mode line reflects the cast");
    assert.equal(inCell.querySelector(".r-py-img img").getAttribute("src"), "data:image/png;base64,INIMG", "input image shown");
    assert.match(inCell.querySelector(".code").textContent, /return \[10, 20\]/, "source highlighted");

    // Out slot = the python-out block: stdout + the minted token.
    const outCell = toolStep.querySelector(".r-py-out");
    assert.ok(outCell, "Out renders the python-out block");
    assert.match(outCell.querySelector(".r-py-stdout").textContent, /found/, "stdout shown byte-exact");
    assert.match(outCell.querySelector(".r-py-token").textContent, /@pt:abcd1234/, "minted token shown");

    // The Out raw toggle falls back to the exact result string the model received.
    const outBlock = [...toolStep.querySelectorAll("details.io")].find(b => b.querySelector(".r-py-out"));
    [...outBlock.querySelectorAll(".rr-toggle button")].find(b => b.textContent === "raw").click();
    await w.tick();
    assert.match(outBlock.textContent, /→ @pt:abcd1234 at \(10, 20\)/, "Out raw = the model-facing result");
});

test("python_exec render: a Python error surfaces the traceback in the Out block", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("pye", "compute"));
    await w.dispatch(agentStep("pye", 1, {
        tool: "python_exec", arguments: { code: "return 1/0" },
        result: "Python error: ZeroDivisionError: division by zero",
        renderIn: { type: "python-in", mode: "script", code: "return 1/0" },
        renderOut: { type: "python-out", error: "Traceback (most recent call last):\nZeroDivisionError: division by zero" },
    }));
    await w.dispatch(agentResult("pye", "done", 1));

    w.shadow.querySelector(".row").click();
    await w.tick();
    const toolStep = w.shadow.querySelector(".astep.tool");
    toolStep.querySelector(".astep-head").click();
    await w.tick();

    assert.match(toolStep.querySelector(".r-py-mode").textContent, /script/, "no cast → script mode");
    assert.equal(toolStep.querySelector(".r-py-in .r-py-img"), null, "no input image row for an image-less run");
    assert.match(toolStep.querySelector(".r-py-err").textContent, /ZeroDivisionError/, "traceback shown");
});

test("awaiting approval of a python_exec that loads an EXTERNAL sheet warns it's a session-scoped grant", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("shg", "sum the sheet"));
    // A pending, approval-gated python_exec loading an external Google Sheet. The In is the PRE-RUN
    // preview (code-only, no tables loaded yet) — the note MUST come from the ARGS (`tables`), which is
    // the real approval-time scenario (the earlier renderIn-based detection silently showed nothing).
    await w.dispatch(agentStep("shg", 1, {
        seq: 1, pending: true, awaitingApproval: true, tool: "python_exec",
        arguments: { code: "return df['A'].sum()", tables: "https://docs.google.com/spreadsheets/d/SHEETID/edit" },
        renderIn: { type: "python-in", mode: "script", code: "return df['A'].sum()" },   // code-only, no tables
    }));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const note = w.shadow.querySelector(".astep-approve .appr-note");
    assert.ok(note, "the approval bar shows a session-grant note (from the args, pre-run)");
    assert.match(note.textContent, /rest of this session/i, "explains the grant is session-scoped");
    // A smart chip (not the raw 44-char id): a link to the sheet, the id in its tooltip.
    const chip = note.querySelector(".sheet-chip");
    assert.ok(chip, "the sheet is a smart chip, not a raw id");
    assert.match(chip.getAttribute("href"), /spreadsheets\/d\/SHEETID/, "chip links to the sheet");
    assert.match(chip.querySelector(".tt-pop").textContent, /SHEETID/, "the full id is on hover");
    // A page-table run (a selector, not a Sheets URL) must NOT show the grant note.
    await w.dispatch(agentStep("shg", 2, {
        seq: 2, pending: true, awaitingApproval: true, tool: "python_exec",
        arguments: { code: "return df.sum()", tables: "#t" },
        renderIn: { type: "python-in", mode: "script", code: "return df.sum()" },
    }));
    await w.tick();
    const notes = [...w.shadow.querySelectorAll(".astep-approve .appr-note")];
    assert.equal(notes.length, 1, "only the external-sheet step warns — a page-table step doesn't");
});

test("agent options: the tool definitions viewer renders a JSON tree of each tool's parameter schema", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("tdv", "do stuff", "m", 10, {
        system: "you are an automation agent", customSystem: false, maxSteps: 10,
        think: null, env: true, vision: null, hints: null,
        tools: [{
            name: "click", requiresApproval: true, vision: false,
            description: "Click an element by selector.",
            parameters: { type: "object", properties: { selector: { type: "string", description: "a CSS selector" } }, required: ["selector"] },
        }],
    }));
    await w.dispatch(agentResult("tdv", "done", 0));
    w.shadow.querySelector(".row").click();
    await w.tick();

    // Open the "agent options" block, then reveal the tool definitions.
    w.shadow.querySelector(".block .block-head").click();
    await w.tick();
    const toolsBtn = [...w.shadow.querySelectorAll(".raw-btn")].find(b => /tool definitions/.test(b.textContent));
    assert.ok(toolsBtn, "a 'tool definitions' toggle appears when the config carries full defs");
    toolsBtn.click();
    await w.tick();

    const def = w.shadow.querySelector(".tooldef");
    // Collapsed by default: the name + badges show, the description/params don't.
    assert.match(def.querySelector(".tooldef-name").textContent, /click/, "the tool name");
    assert.ok(def.querySelector(".tooldef-warn"), "requiresApproval shows a warn marker (even collapsed)");
    assert.equal(def.querySelector(".tooldef-desc"), null, "description hidden until expanded");
    // Expand the card → description + params appear.
    def.querySelector(".tooldef-head.clickable").click();
    await w.tick();
    assert.match(def.querySelector(".tooldef-desc").textContent, /Click an element/, "the description");
    // The JSON tree: a foldable `parameters` root; expanding it reveals the schema keys.
    const root = def.querySelector(".tooldef-params .jt-branch");
    assert.match(root.textContent, /parameters/, "the tree roots at `parameters`");
    root.click();   // expand
    await w.tick();
    assert.match(def.querySelector(".tooldef-params").textContent, /selector/, "expanded tree shows a nested property");
});

test("agent tool steps carry an approval provenance badge (auto/user green, denied red)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("apv", "run"));
    await w.dispatch(agentStep("apv", 1, { tool: "exec", arguments: { js: "1" }, result: "1", approval: "readonly", renderIn: { type: "code", text: "1", lang: "javascript" } }));
    await w.dispatch(agentStep("apv", 2, { tool: "click", arguments: { selector: "b" }, result: "clicked", approval: "user" }));
    await w.dispatch(agentStep("apv", 3, { tool: "exec", arguments: { js: "2" }, result: "Denied by the user.", approval: "denied" }));
    await w.dispatch(agentStep("apv", 4, { tool: "click", arguments: { selector: "#gone" }, result: 'No element matches "#gone".', approval: "skipped" }));
    await w.dispatch(agentResult("apv", "done", 4));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const steps = [...w.shadow.querySelectorAll(".astep.tool")];
    assert.equal(steps.length, 4, "four tool steps");
    assert.match(steps[0].querySelector(".appr.yes").textContent, /auto-approved/);
    assert.ok(steps[0].classList.contains("appr-yes"), "auto-approved step gets the green outline");
    assert.match(steps[1].querySelector(".appr.yes").textContent, /approved/);
    assert.match(steps[2].querySelector(".appr.no").textContent, /denied/);
    assert.ok(steps[2].classList.contains("appr-no"), "denied step gets the red outline");
    // A doomed (precheck-skipped) action gets a neutral grey "skipped" badge — not yes/no.
    assert.match(steps[3].querySelector(".appr.skip").textContent, /skipped/);
    assert.ok(steps[3].classList.contains("appr-skip"), "skipped step gets the grey outline");
    assert.equal(steps[3].querySelector(".appr.yes, .appr.no"), null, "skipped is neither approved nor denied");
});

test("denying a gated step KEEPS its In render (the DONE's blank renderIn doesn't clobber the START's)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("dng", "click something"));
    // The awaiting-approval START carries the In preview (e.g. click's targeted @pt).
    await w.dispatch(agentStep("dng", 1, {
        seq: 1, pending: true, awaitingApproval: true, tool: "click",
        arguments: { selector: "@pt:ce6c8a40" },
        renderIn: { type: "elements", items: [{ path: "@pt:ce6c8a40" }] },
    }));
    // The DONE after DENIAL: result + approval, but NO renderIn/renderOut — the tool never ran.
    await w.dispatch(agentStep("dng", 1, {
        seq: 1, tool: "click", arguments: { selector: "@pt:ce6c8a40" },
        result: "Denied by the user. Do not retry this exact call; try another approach.", approval: "denied",
    }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const toolStep = w.shadow.querySelector(".astep.tool");
    toolStep.querySelector(".astep-head").click();
    await w.tick();
    // The In still renders the elements descriptor (not raw JSON) despite the blank DONE.
    assert.ok(toolStep.querySelector(".r-el"), "the In render persists after denial");
    assert.match(toolStep.querySelector(".r-el-path").textContent, /@pt:ce6c8a40/);
    assert.match(toolStep.textContent, /Denied by the user/, "the denial result still shows");
});

test("python bench: opens from the header, runs a script, and renders the sandbox result", async () => {
    const w = await loadSidebarWorld({ pythonExec: (p) => ({ ok: true, value: p.hardened ? 1 : 2, stdout: "hi\n" }) });
    w.shadow.querySelector('[aria-label="Python bench"]').click();
    await w.tick();
    const ta = w.shadow.querySelector(".bench-code");
    assert.ok(ta, "the code editor renders");
    ta.value = "print('hi')\nreturn 1";
    ta.dispatchEvent(new w.window.Event("input"));
    await w.tick();
    w.shadow.querySelector(".bench-run").click();
    await w.tick();
    // The PYTHON_EXEC payload carried the code; default mode readonly → hardened.
    assert.equal(w.pyCalls.length, 1);
    assert.match(w.pyCalls[0].code, /print\('hi'\)/);
    assert.equal(w.pyCalls[0].hardened, true, "readonly mode → hardened");
    // The result renders through the python-out panel (stdout).
    const out = w.shadow.querySelector(".bench-out .r-py-out");
    assert.ok(out, "result renders in the python-out panel");
    assert.match(out.textContent, /hi/, "stdout shown");
    // stdout is a collapsible section (a <details>), like the other blocks.
    assert.equal(out.querySelector(".r-py-stdout").tagName, "DETAILS", "stdout is a collapsible section");
    // The info note is a tooltip now, not always-shown prose.
    assert.equal(w.shadow.querySelector(".bench-note"), null, "no always-shown note");
    assert.ok(w.shadow.querySelector(".bench-info .tt-pop"), "the note is a hover tooltip");
});

test("python bench: a returned DataFrame renders as a real table (PyDfTable), not a text repr", async () => {
    const w = await loadSidebarWorld({ pythonExec: () => ({ ok: true, value: "  foo  bar\n0  1  4", stdout: "", table: { columns: ["foo", "bar"], rows: [[1, 4], [2, 5]] } }) });
    w.shadow.querySelector('[aria-label="Python bench"]').click();
    await w.tick();
    const ta = w.shadow.querySelector(".bench-code");
    ta.value = "return df"; ta.dispatchEvent(new w.window.Event("input"));
    await w.tick();
    w.shadow.querySelector(".bench-run").click();
    await w.tick();
    const df = w.shadow.querySelector(".bench-out .r-df-scroll, .bench-out table.dftable, .bench-out .r-py-val table");
    assert.ok(df || w.shadow.querySelector(".bench-out .r-py-val"), "the value section renders");
    // The DataFrame table (PyDfTable) shows the column headers.
    assert.match(w.shadow.querySelector(".bench-out .r-py-val").textContent, /foo/);
    assert.match(w.shadow.querySelector(".bench-out .r-py-val").textContent, /bar/);
});

test("python bench: full mode sends hardened:false", async () => {
    const w = await loadSidebarWorld();
    w.shadow.querySelector('[aria-label="Python bench"]').click();
    await w.tick();
    const sel = w.shadow.querySelector(".bench-mode select");
    sel.value = "full";
    sel.dispatchEvent(new w.window.Event("change"));
    const ta = w.shadow.querySelector(".bench-code");
    ta.value = "return 1";
    ta.dispatchEvent(new w.window.Event("input"));
    await w.tick();
    w.shadow.querySelector(".bench-run").click();
    await w.tick();
    assert.equal(w.pyCalls[0].hardened, false, "full mode → not hardened");
});

test("exec code is beautified for display when the descriptor sets format", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("bty", "run js"));
    const ugly = "[...document.querySelectorAll('a')].map(x=>{const y=x.href;return {y}})";
    await w.dispatch(agentStep("bty", 1, { tool: "exec", arguments: { js: ugly }, result: "ok", renderIn: { type: "code", text: ugly, lang: "javascript", format: true } }));
    await w.dispatch(agentResult("bty", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    w.shadow.querySelector(".astep.tool .astep-head").click();
    await w.tick();

    const code = w.shadow.querySelector("details.io .code").textContent;
    assert.match(code, /=> \{/, "arrow body spaced out by the beautifier");
    assert.ok(code.split("\n").length >= 3, "reflowed onto multiple lines (source was one line)");
});

test("code line-number gutter: off by default, toggled on via settings, applied from storage", async () => {
    // Applied from storage on mount.
    const w = await loadSidebarWorld({ local: { ml_debug_codelines: true } });
    const html = w.window.document.documentElement;
    assert.equal(html.getAttribute("data-codelines"), "on", "gutter attr set from storage.local");
    await w.dispatch(agentStart("ln", "x"));
    await w.dispatch(agentStep("ln", 1, { tool: "exec", arguments: { js: "a;\nb;\nc;" }, result: "ok", renderIn: { type: "code", text: "a;\nb;\nc;", lang: "javascript" } }));
    await w.dispatch(agentResult("ln", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    w.shadow.querySelector(".astep.tool .astep-head").click();
    await w.tick();
    const inB = w.shadow.querySelector(".astep.tool details.io");   // the In block (the JS)
    const nos = [...inB.querySelectorAll(".code.numbered .cline .lno")].map(n => n.textContent);
    assert.deepEqual(nos, ["1", "2", "3"], "one right-aligned number per source line");
});

test("numbered gutter preserves line content — no spurious span-reopen prefix", async () => {
    // Regression: a text token starting with " s" was misread as a <span> open and
    // re-emitted on every following line (e.g. "searchResults = " leaking downward).
    const w = await loadSidebarWorld({ local: { ml_debug_codelines: true } });
    const js = "const searchResults = 1;\nconsole.log('n:', searchResults);\nreturn searchResults;";
    await w.dispatch(agentStart("lnp", "x"));
    await w.dispatch(agentStep("lnp", 1, { tool: "exec", arguments: { js }, result: "1", renderIn: { type: "code", text: js, lang: "javascript" } }));
    await w.dispatch(agentResult("lnp", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    w.shadow.querySelector(".astep.tool .astep-head").click();
    await w.tick();
    const inB = w.shadow.querySelector(".astep.tool details.io");
    const lines = [...inB.querySelectorAll(".code.numbered .cline .lcode")].map(n => n.textContent);
    assert.deepEqual(lines, js.split("\n"), "each rendered line matches its source line exactly");
});

test("code display prefs: wrap⇄scroll + line-number toggles flip root attrs and persist", async () => {
    const w = await loadSidebarWorld();
    const html = w.window.document.documentElement;
    assert.equal(html.getAttribute("data-codewrap"), "on", "wrap on by default");
    assert.equal(html.getAttribute("data-codelines"), "off", "gutter off by default");

    await openSettings(w, "Appearance");

    const sel = [...w.shadow.querySelectorAll(".settings select")].find(s => [...s.options].some(o => o.value === "scroll"));
    sel.value = "scroll";
    sel.dispatchEvent(new w.window.Event("change", { bubbles: true }));
    await w.tick();
    assert.equal(html.getAttribute("data-codewrap"), "off", "wrap → scroll");
    assert.equal(w.localStore.ml_debug_codewrap, false, "scroll persisted");

    const chk = [...w.shadow.querySelectorAll(".settings .set-check")]
        .find(l => /line numbers/i.test(l.textContent)).querySelector("input");
    chk.click();
    await w.tick();
    assert.equal(html.getAttribute("data-codelines"), "on", "line numbers toggled on");
    assert.equal(w.localStore.ml_debug_codelines, true, "line numbers persisted");
});

// Open the export menu and click one of its format items ("Markdown" / "PDF").
async function openExportMenu(w, label) {
    w.shadow.querySelector('[aria-label="Export log"]').click();
    await w.tick();
    const item = [...w.shadow.querySelectorAll(".menu-item")].find(b => b.textContent.startsWith(label));
    assert.ok(item, `export menu offers "${label}"`);
    return item;
}

// Capture what the export menu's "Markdown" item downloads: stub the object-URL +
// anchor click (jsdom has neither URL.createObjectURL nor real navigation) and
// read back the Blob it built. Returns { name, blob }.
async function captureExport(w) {
    let blob = null, name = null;
    w.window.URL.createObjectURL = (b) => { blob = b; return "blob:mock"; };
    w.window.URL.revokeObjectURL = () => {};
    w.window.HTMLAnchorElement.prototype.click = function () { name = this.download; };
    (await openExportMenu(w, "Markdown")).click();
    await w.tick();
    return { name, blob };
}

// The text a browser would show for some markup: drop the tags (hljs wraps every
// token in a span), then undo the entity escaping. Lets a test assert on the
// source that reaches the page without hard-coding the highlighter's output.
const plainText = (html) => html.replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

// Capture the printable document the "PDF" item builds: it loads an offscreen
// iframe from a Blob URL, so stub createObjectURL and read the HTML back.
async function capturePrint(w) {
    let blob = null;
    w.window.URL.createObjectURL = (b) => { blob = b; return "blob:mock-print"; };
    w.window.URL.revokeObjectURL = () => {};
    (await openExportMenu(w, "PDF")).click();
    await w.tick();
    const frame = w.window.document.querySelector("iframe.printframe");
    return { frame, html: blob ? await blob.text() : null };
}

test("export: an image-free agent run downloads a plain markdown log", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("expa", "hide slow items", "gemma4:31b", 60));
    await w.dispatch(agentStep("expa", 2, { tool: "exec", arguments: { js: "items.forEach(i=>i.remove())" }, result: "Hidden 38 items.", renderIn: { type: "code", text: "items.forEach(i=>i.remove())", lang: "javascript", format: true } }));
    await w.dispatch(agentResult("expa", "I hid all slow items.", 2));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const { name, blob } = await captureExport(w);
    const text = await blob.text();
    assert.equal(name, "ml-agent-expa.md", "no images → a bare .md, named by kind + hash");
    assert.match(text, /# Agent run · gemma4:31b · expa/);
    assert.match(text, /\*\*Task:\*\* hide slow items/);
    assert.match(text, /items\.forEach\(i => i\.remove\(\)\)/, "exec JS is beautified in the log");
    assert.match(text, /Hidden 38 items\./, "tool result captured");
    assert.match(text, /## Answer\n\nI hid all slow items\./);
});

test("export: Steps counts TURNS, not events (a turn emits a thought + one event per tool)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("stp", "do stuff", "m", 10));
    // ONE turn (step 1): a thought + two tool calls → 3 events but 1 turn.
    await w.dispatch(agentStep("stp", 1, { thought: "planning" }));
    await w.dispatch(agentStep("stp", 1, { tool: "exec", arguments: { js: "1" }, result: "1", renderIn: { type: "code", text: "1", lang: "javascript" } }));
    await w.dispatch(agentStep("stp", 1, { tool: "pageInfo", arguments: {}, result: "a page" }));
    await w.dispatch(agentResult("stp", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const { blob } = await captureExport(w);
    const text = await blob.text();
    assert.match(text, /\*\*Steps:\*\* 1 \/ 10/, "Steps = distinct turns (1), not the 3 emitted events");
});

test("export: keeps the raw args alongside a rendered In (both, since there's no toggle)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("pyx", "compute", "gemma4:31b", 10));
    await w.dispatch(agentStep("pyx", 1, {
        tool: "python_exec", arguments: { code: "return 6 * 7", cast: "pt", mode: "readonly" },
        result: "→ @pt:dead", renderIn: { type: "python-in", mode: "pt", code: "return 6 * 7" },
        renderOut: { type: "python-out", value: "[42]" },
    }));
    await w.dispatch(agentResult("pyx", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const { blob } = await captureExport(w);
    const text = await blob.text();
    assert.match(text, /return 6 \* 7/, "the rendered python source is shown");
    assert.match(text, /In · raw args/, "and the raw args disclosure is present");
    assert.match(text, /"cast": "pt"/, "the raw args carry the full tool call the model emitted (not just the code)");
});

test("export: a python_exec df renders as a real <table> (PDF) and a GFM table (markdown)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("pytab", "compute", "m", 10));
    await w.dispatch(agentStep("pytab", 1, {
        tool: "python_exec", arguments: { code: "return df['Q1'].sum()", table: "#sales" }, result: "210",
        renderIn: { type: "python-in", mode: "script", code: "return df['Q1'].sum()", tables: [{ name: "df", source: { kind: "dom", label: "#sales" }, columns: ["Rep", "Q1"], rows: [["Ada", 120], ["Ben", 90]] }] },
        renderOut: { type: "python-out", value: "210" },
    }));
    await w.dispatch(agentResult("pytab", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const md = await (await captureExport(w)).blob.text();
    assert.match(md, /<details><summary>input table → df \(2 × 2\)/, "markdown → the df is collapsed into a disclosure (doesn't flood the .md)");
    assert.match(md, /\| Rep \| Q1 \|/, "markdown → GFM table header (inside the disclosure)");
    assert.match(md, /\| Ada \| 120 \|/, "markdown → GFM row (all rows, uncapped)");

    const { html } = await capturePrint(w);
    assert.match(html, /<details open><summary>input table → df/, "PDF → the disclosure is OPEN so the table still prints");
    assert.match(html, /<table class="dftable">/, "PDF → a real table, not markdown pipes");
    assert.match(html, /<td class="num">120<\/td>/, "numeric cell tagged for right-align");
    assert.match(html, /<td class="">Ada<\/td>/, "string cell");
});

test("export: skips a usage-only step (no bare 'Step N · ?' header)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("expu", "answer directly", "gemma4:31b"));
    // A thinking-model step: reasoning went to the thinking channel, so the emit
    // carries only a token sample (no thought/tool). It must not serialise a header.
    await w.dispatch(agentStep("expu", 1, { usage: { promptTokens: 40, completionTokens: 10, totalTokens: 50 } }));
    await w.dispatch(agentResult("expu", "Done.", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const { blob } = await captureExport(w);
    const text = await blob.text();
    assert.ok(!/Step 1 · \?/.test(text), "no phantom empty-step header");
    assert.match(text, /## Answer\n\nDone\./);
});

test("export: a run with screenshots downloads a zip (run.md + png sidecars)", async () => {
    // A real 1×1 PNG, so the decoded sidecar is genuine image bytes.
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("expz", "look around", "gemma4:31b", 60));
    await w.dispatch(agentStep("expz", 1, { tool: "look", renderOut: { type: "image", src: "data:image/png;base64," + PNG, label: "viewport" }, result: "a page" }));
    await w.dispatch(agentResult("expz", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const { name, blob } = await captureExport(w);
    assert.equal(name, "ml-agent-expz.zip", "images present → a .zip bundle");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04], "starts with the PK local-file signature");
    // store method (no compression) → filenames + run.md text live verbatim in the bytes.
    const latin1 = String.fromCharCode(...bytes);
    assert.ok(latin1.includes("run.md"), "contains run.md");
    assert.ok(latin1.includes("images/step-1.png"), "contains the png sidecar");
    assert.match(latin1, /!\[step 1[^\]]*\]\(images\/step-1\.png\)/, "run.md references the sidecar, not a placeholder");
    assert.ok(latin1.includes(String.fromCharCode(0x89) + "PNG"), "the real PNG bytes are embedded");
});

test("export: a grounding locate step serialises its substeps (box + DOM snap, prompt/out/pick)", async () => {
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const url = "data:image/png;base64," + PNG;
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("expl", "find the star", "gemma4:31b", 10));
    await w.dispatch(agentStep("expl", 1, { tool: "locate", arguments: { description: "star" }, elements: 1, renderOut:
        locateRender("grounding", "qwen2.5vl:7b", [
            { label: "Grounding · box (28, 242) → (45, 264)", prompt: "Locate \"star\" …", output: "28,242,45,264", rawImage: url + "#raw", image: url },
            { label: "DOM snap · +40px search margin", image: url },
        ], { picked: "[button] \"Star\" → #bar > div:nth-of-type(1)", pickedBy: "snap" }) }));
    await w.dispatch(agentResult("expl", "clicked star", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const { name, blob } = await captureExport(w);
    assert.equal(name, "ml-agent-expl.zip");
    const latin1 = String.fromCharCode(...new Uint8Array(await blob.arrayBuffer()));
    assert.ok(latin1.includes("images/step-1-sub1.png"), "substep 1 image sidecar");
    assert.ok(latin1.includes("images/step-1-sub2.png"), "substep 2 image sidecar");
    assert.match(latin1, /Grounding.{1,4}qwen2\.5vl:7b/, "model + mode (· is multibyte in latin1)");
    assert.match(latin1, /box \(28, 242\)/, "box coords as a pair");
    assert.match(latin1, /\+40px search margin/, "margin");
    assert.match(latin1, /Out:.*28,242,45,264/, "the raw model output");
    assert.match(latin1, /Snapped to:.*nth-of-type\(1\)/, "picked element (grounding → snapped)");
    assert.match(latin1, /In \(prompt\)/, "the VLM prompt is included");
});

test("export: an auto-fallback locate step serialises the grounding-attempt substep + the marks one", async () => {
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const url = "data:image/png;base64," + PNG;
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("expf", "find the star", "gemma4:31b", 10));
    await w.dispatch(agentStep("expf", 1, { tool: "locate", arguments: { description: "star" }, elements: 1, renderOut:
        locateRender("marks", "gemma4:31b", [
            { label: "Grounding · no box returned", prompt: "Locate…", output: "NONE", image: url },
            { label: "Set-of-Marks · 5 candidates · model chose #2", note: "Grounding returned no box — fell back to Set-of-Marks.", prompt: "which badge…", output: "2", rawImage: url + "#raw", image: url },
        ], { picked: "#2 [button] → #bar > div:nth-of-type(2)", pickedBy: "model" }) }));
    await w.dispatch(agentResult("expf", "clicked star", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const { blob } = await captureExport(w);
    const latin1 = String.fromCharCode(...new Uint8Array(await blob.arrayBuffer()));
    assert.ok(latin1.includes("images/step-1-sub1.png"), "grounding-attempt sidecar");
    assert.ok(latin1.includes("images/step-1-sub2.png"), "the marks-pass sidecar");
    assert.match(latin1, /Grounding returned no box .{1,4} fell back to Set-of-Marks/, "the fallback note");
    assert.match(latin1, /Model picked[\s\S]*nth-of-type\(2\)/, "marks pick");
});

test("export: a grid hand-off locate step serialises both substeps + the raw image sent", async () => {
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const url = "data:image/png;base64," + PNG;
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("expg", "find the star", "gemma4:31b", 10));
    const raw = "data:image/png;base64,QUJDRA==";   // a DIFFERENT but valid data-URL (so the raw sidecar is written)
    await w.dispatch(agentStep("expg", 1, { tool: "locate", arguments: { description: "star", strategy: "grid" }, elements: 1, renderOut:
        locateRender("grid", "gemma4:31b", [
            { label: "Cell pick · grid 4×4 · model chose cells 2,3", prompt: "This image is divided into a 4×4 …", output: "2,3", rawImage: raw, image: url },
            { label: "Set-of-Marks · 6 candidates · model chose #4", note: "The cell held 6 elements, so they were re-badged and a second vision call picked one (Set-of-Marks).", prompt: "which badge…", output: "4", rawImage: raw, image: url },
        ], { picked: "#4 [button] → #bar > div:nth-of-type(3)", pickedBy: "model" }) }));
    await w.dispatch(agentResult("expg", "clicked star", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const { blob } = await captureExport(w);
    const latin1 = String.fromCharCode(...new Uint8Array(await blob.arrayBuffer()));
    assert.ok(latin1.includes("images/step-1-sub1.png"), "cell-pick image sidecar");
    assert.ok(latin1.includes("images/step-1-sub2.png"), "SoM-pick image sidecar");
    assert.ok(latin1.includes("images/step-1-sub1-raw.png"), "the raw image sent to the model (differs from overlay)");
    assert.match(latin1, /Grid.{1,4}gemma4:31b/, "mode + model");
    assert.match(latin1, /standalone sub-call/, "delegated note (same model as driver)");
    assert.match(latin1, /model chose cells 2,3/, "selected cells");
    assert.match(latin1, /held 6 elements.{1,40}second/i, "hand-off note");
    assert.match(latin1, /Set-of-Marks.{1,4}6 candidates.{1,4}model chose #4/, "SoM-pick substep label (· is multibyte in latin1)");
    assert.match(latin1, /Model picked:.*nth-of-type\(3\)/, "the model picked the badge");
});

test("export: a chat session downloads a markdown log (options, turns, reply)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(chatStart("expc", 0, "what is 2+2", { model: "qwen3:14b" }));
    await w.dispatch(chatResult("expc", 0, "It is **4**.", { model: "qwen3:14b" }));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const { name, blob } = await captureExport(w);
    const text = await blob.text();
    assert.equal(name, "ml-chat-expc.md");
    assert.match(text, /# Chat · qwen3:14b · expc/);
    assert.match(text, /## Options/);
    assert.match(text, /## Turn 1 ·/);
    assert.match(text, /\*\*User:\*\*\n\nwhat is 2\+2/);
    assert.match(text, /\*\*Assistant\*\* \(qwen3:14b\):\n\nIt is \*\*4\*\*\./);
});

test("export menu: offers both formats, and closes once one is picked", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("expm", "look around", "gemma4:31b"));
    await w.dispatch(agentResult("expm", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const trigger = w.shadow.querySelector('[aria-label="Export log"]');
    assert.ok(!w.shadow.querySelector(".menu"), "menu is closed until asked for");
    trigger.click();
    await w.tick();
    assert.deepEqual([...w.shadow.querySelectorAll(".menu-item")].map(b => b.firstChild.textContent),
        ["Markdown", "PDF"], "both export formats offered");
    assert.equal(trigger.getAttribute("aria-expanded"), "true");

    w.window.URL.createObjectURL = () => "blob:mock";
    w.window.URL.revokeObjectURL = () => {};
    w.window.HTMLAnchorElement.prototype.click = function () {};
    w.shadow.querySelector(".menu-item").click();
    await w.tick();
    assert.ok(!w.shadow.querySelector(".menu"), "picking a format closes the menu");
});

test("export menu: Escape closes it without exporting", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("expe", "look around", "gemma4:31b"));
    await w.dispatch(agentResult("expe", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    w.shadow.querySelector('[aria-label="Export log"]').click();
    await w.flush();   // the key listener is registered in an effect (post-rAF)
    assert.ok(w.shadow.querySelector(".menu"));
    w.window.document.dispatchEvent(new w.window.KeyboardEvent("keydown", { key: "Escape" }));
    await w.tick();
    assert.ok(!w.shadow.querySelector(".menu"), "Escape dismisses the menu");
});

test("export → PDF: builds a self-contained printable document in an offscreen frame", async () => {
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const src = "data:image/png;base64," + PNG;
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("expp", "hide slow items", "gemma4:31b", 60));
    await w.dispatch(agentStep("expp", 1, { tool: "look", renderOut: { type: "image", src, label: "viewport" }, result: "a page" }));
    await w.dispatch(agentStep("expp", 2, { tool: "exec", arguments: { js: "items.forEach(i=>i.remove())" }, result: "Hidden 38 items." }));
    await w.dispatch(agentResult("expp", "I hid all **slow** items.", 2));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const { frame, html } = await capturePrint(w);
    assert.ok(frame, "an offscreen print frame is appended");
    assert.equal(frame.getAttribute("src"), "blob:mock-print", "loaded from the document blob");
    assert.match(html, /^<!doctype html>/);
    // Chrome seeds the "Save as PDF" filename from the title.
    assert.match(html, /<title>ml-agent-expp<\/title>/, "titled like the .md export, for the PDF filename");
    assert.match(html, /@page\s*\{[^}]*margin/, "print margins");
    assert.match(html, /white-space: pre-wrap/, "code wraps instead of clipping off the page");
    assert.match(html, /<h1>Agent run · gemma4:31b · expp<\/h1>/);
    assert.match(html, /<h2>Step 1 · look<\/h2>/);
    assert.ok(html.includes(`<img src="${src}"`), "screenshots are inlined (a print doc has no sidecars)");
    // Code is syntax-highlighted, so read the source back through the tokens.
    assert.match(plainText(html), /items\.forEach\(i => i\.remove\(\)\)/, "exec JS is beautified");
    assert.ok(!/i=>i\.remove/.test(html), "the cramped original was reflowed");
    assert.match(html, /Hidden 38 items\./);
    assert.match(html, /<strong>slow<\/strong>/, "the answer's markdown is rendered, not shown raw");
});

test("export → PDF: a chat run renders turns, and hostile content can't inject markup", async () => {
    const w = await loadSidebarWorld();
    // The printable doc renders at the extension's origin, so every dynamic string
    // (a model reply here) must be escaped, never passed through as markup.
    await w.dispatch(chatStart("expx", 0, "hi", { model: "qwen3:14b" }));
    await w.dispatch(chatResult("expx", 0, "<script>alert(1)</script><img src=x onerror=alert(2)>", { model: "qwen3:14b" }));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const { html } = await capturePrint(w);
    assert.match(html, /<h1>Chat · qwen3:14b · expx<\/h1>/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, "script tag escaped");
    assert.ok(!/<script/.test(html), "no live script element");
    assert.ok(!/<img[^>]*onerror/.test(html), "no injected event handler — only the escaped text");
    assert.match(plainText(html), /<img src=x onerror=alert\(2\)>/, "…and the reply still reads verbatim");
});

test("clicking a debug image opens the full-window lightbox (posts src to the shell)", async () => {
    const w = await loadSidebarWorld();
    let posted = null;
    w.window.addEventListener("message", (e) => { if (e.data && e.data.__mlLightbox) posted = e.data.__mlLightbox; });
    await w.dispatch(agentStart("img", "x"));
    await w.dispatch(agentStep("img", 1, { tool: "look", renderOut: { type: "image", src: "data:image/png;base64,ZZZ", label: "shot" } }));
    await w.dispatch(agentResult("img", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    w.shadow.querySelector(".astep.tool .astep-head").click();   // expand → Out renders the image
    await w.tick();

    const img = w.shadow.querySelector(".r-image img.zoomable");
    assert.ok(img, "the descriptor image is a click-to-zoom image");
    img.click();
    await w.tick();
    assert.equal(posted, "data:image/png;base64,ZZZ", "posts the src up to the shell for a full-window overlay");
});

test("agent tool In/Out carry a grey inline preview (minified args / newline-collapsed output)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("agp", "x"));
    await w.dispatch(agentStep("agp", 1, { tool: "click", arguments: { selector: "button.like", index: 2 }, result: "Clicked the button.\nPage title: Foo." }));
    await w.dispatch(agentResult("agp", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const toolStep = w.shadow.querySelector(".astep.tool");
    toolStep.querySelector(".astep-head").click();
    await w.tick();
    const [inB, outB] = [...toolStep.querySelectorAll("details.io")];
    assert.match(inB.querySelector(".io-preview").textContent, /"selector": "button\.like"/, "In preview = minified args");
    assert.match(outB.querySelector(".io-preview").textContent, /Clicked the button\. Page title: Foo\./, "Out preview collapses newlines");
});

test("agent content is plain prose (no status dot); a failed tool call shows an err dot", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("agd", "thing"));
    await w.dispatch(agentStep("agd", 1, { thought: "hmm" }));
    await w.dispatch(agentStep("agd", 1, { tool: "click", arguments: {}, result: "Error: no element matches" }));
    await w.dispatch(agentResult("agd", "done", 1));

    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.ok(w.shadow.querySelector(".aturn-prose"), "content renders as prose");
    assert.equal(w.shadow.querySelector(".aturn-prose .dot"), null, "the content prose has no status dot");
    assert.ok(w.shadow.querySelector(".astep.tool .dot.err"), "failed tool call flagged err");
});

test("agent options block renders the config + reveals the system prompt", async () => {
    const cfg = {
        system: "You are an automation agent operating on the page.", customSystem: false,
        tools: [{ name: "look", requiresApproval: false }, { name: "click", requiresApproval: true }],
        maxSteps: 8, think: null, env: true, vision: null, hints: null,
    };
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("ao", "task", "gemma", 8, cfg));
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.match(w.shadow.querySelector(".block .block-label").textContent, /agent options/);

    w.shadow.querySelector(".block .block-head").click();   // expand
    await w.tick();
    assert.match(w.shadow.querySelector(".opts").textContent, /maxSteps: 8/);
    assert.match(w.shadow.querySelector(".opts").textContent, /tools \(2\): look, click ⚠/);

    w.shadow.querySelector(".sys-block .raw-btn").click();   // reveal the system prompt
    await w.tick();
    assert.match(w.shadow.querySelector(".sys-block .code").textContent, /automation agent/);
});

test("agent options: warns when no vision model resolved (look/locate unavailable)", async () => {
    const cfg = {
        system: "s", customSystem: false,
        tools: [{ name: "findByText", requiresApproval: false }],   // no vision tool
        maxSteps: 10, think: null, env: true, vision: null, hints: null,
    };
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("nv", "task", "text-model", 10, cfg));
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.match(w.shadow.querySelector(".block-head .arg-warn").textContent, /no vision/);
    w.shadow.querySelector(".block .block-head").click();   // expand
    await w.tick();
    assert.match(w.shadow.querySelector(".arg-issues").textContent, /visual tools unavailable/);
});

test("agent options: no vision warning when a vision tool IS wired", async () => {
    const cfg = {
        system: "s", customSystem: false,
        tools: [{ name: "look", requiresApproval: false, vision: true }],
        maxSteps: 10, think: null, env: true, vision: null, hints: null,
    };
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("hv", "task", "qwen2.5vl", 10, cfg));
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.equal(w.shadow.querySelector(".block-head .arg-warn"), null, "no warning when look is present");
});

test("agent tool step flags args that don't match the schema", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("ai", "x"));
    await w.dispatch(agentStep("ai", 1, { tool: "grab", arguments: { index: 2 }, argIssues: ['missing required "selector"', 'unknown property "index"'] }));
    await w.dispatch(agentResult("ai", "done", 1));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const toolStep = w.shadow.querySelector(".astep.tool");
    assert.ok(toolStep.querySelector(".arg-warn"), "warning badge in the collapsed header");
    toolStep.querySelector(".astep-head").click();
    await w.tick();
    assert.match(toolStep.querySelector(".arg-issues").textContent, /missing required "selector"/);
    assert.match(toolStep.querySelector(".arg-issues").textContent, /unknown property "index"/);
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
    assert.match(w.shadow.querySelector(".msg.asst").textContent, /all done/);
});

test("running footer swaps to 'waiting for your approval' when blocked, and back the instant you decide", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("agB", "do a thing"));
    w.shadow.querySelector(".row").click();
    await w.tick();
    let note = w.shadow.querySelector(".pending-note");
    assert.ok(note && !note.classList.contains("blocked"), "actively running: not blocked");
    assert.match(note.textContent, /running/);

    // A step lands awaiting the gate → the footer goes amber/blocked with the approval copy.
    await w.dispatch(agentStep("agB", 1, { seq: 1, pending: true, awaitingApproval: true, tool: "click", arguments: { selector: "#go" } }));
    note = w.shadow.querySelector(".pending-note");
    assert.ok(note.classList.contains("blocked"), "blocked while awaiting approval");
    assert.match(note.textContent, /waiting for your approval/i);

    // Click Approve → the footer must drop 'blocked' immediately, WITHOUT waiting for the tool's DONE.
    w.shadow.querySelector(".astep-approve .appr-btn.yes").click();
    await w.tick();
    note = w.shadow.querySelector(".pending-note");
    assert.ok(note && !note.classList.contains("blocked"), "no longer blocked the instant you approve (before DONE)");
});

test("an agent that hits the step cap is flagged as stopped/error", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("ag3", "endless task"));
    await w.dispatch(agentResult("ag3", "Stopped at the 10-step cap without finishing.", 10, true));
    assert.ok(w.shadow.querySelector(".row .dot.err"), "capped run marked error");
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.match(w.shadow.querySelector(".msg.asst.capped").textContent, /step cap/);
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

// ─── off-mode approval CARD (the "card" surface) ───
// The shell hosts the SAME app iframe as a corner card and tells it `__mlSidebarSurface: "card"`. The
// app then renders a curated view of the one background-hosted run, drives its own reveal via
// `__mlSidebarCard`, and gates approval through the same unforgeable `__mlSidebarApp: "approval"` path.

test("card surface: a pending approval shows the action directly + Approve posts the unforgeable decision", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);   // capture what the app posts to its parent (the shell)

    await w.raw({ __mlSidebarSurface: "card" });
    assert.equal(w.window.document.documentElement.dataset.surface, "card", "switched to the card surface");

    const hash = "cardrun1";
    await w.dispatch(agentStart(hash, "delete the account", "m"));
    // The tool provides an `action` intent descriptor (verb + human target + highlight selector).
    await w.dispatch(agentStep(hash, 1, { seq: 0, pending: true, awaitingApproval: true, tool: "click",
        arguments: { selector: "#danger" }, renderIn: { type: "action", verb: "Click", kind: "button", target: "Delete account", selector: "#danger" } }));
    await w.flush();

    // A pending approval reveals the card EXPANDED (urgent — you act on it), showing the intent sentence.
    assert.ok(posted.some(m => m.__mlSidebarCard === "expanded"), "pending approval shows expanded directly");
    const doc = w.window.document;
    assert.match(doc.querySelector(".card-head-txt").textContent, /Approval needed/);
    const sentence = doc.querySelector(".action-sentence").textContent;
    assert.match(sentence, /click the button/, "plain-English intent");
    assert.match(sentence, /Delete account/, "human target, not the selector");
    // The card highlighted the real element on the page as a pulsing-green approval spotlight.
    assert.ok(posted.some(m => m.__mlHighlight && m.__mlHighlight.selector === "#danger" && m.__mlHighlight.kind === "approve"), "pulsing highlight on the target");

    // The Deny/Approve controls live in the fixed footer (outside the scroll area), with key hints.
    const approve = doc.querySelector(".card-foot .appr-btn.yes");
    assert.ok(approve && approve.textContent.includes("Approve"), "Approve control rendered in the footer");
    approve.click(); await w.flush();

    const decision = posted.find(m => m.__mlSidebarApp === "approval");
    assert.ok(decision, "posted an approval decision to the shell (→ SET_APPROVAL)");
    assert.equal(decision.hash, hash);
    assert.equal(decision.seq, 0);
    assert.equal(decision.decision, true);
});

test("card surface: the final answer shows; debug steps/thinking don't leak", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });

    const hash = "cardrun2";
    await w.dispatch(agentStart(hash, "survey the page", "m"));
    await w.dispatch(agentStep(hash, 1, { reasoning: "thinking about it…" }));
    await w.dispatch(agentStep(hash, 1, { seq: 0, tool: "exec", arguments: { js: "x" }, result: "ok", approval: "readonly" }));
    await w.dispatch(agentResult(hash, "The page has three sections.", 1));
    await w.flush();

    // A finished run shows its ANSWER directly (expanded) — no click needed; only the answer, no rows.
    assert.ok(posted.some(m => m.__mlSidebarCard === "expanded"), "finished run reveals the answer directly");
    const body = w.window.document.querySelector(".card-body");
    assert.ok(body, "answer body rendered");
    assert.doesNotMatch(body.textContent, /thinking about it/, "thinking is hidden in the card");
    assert.ok(!body.querySelector(".astep"), "no debug step rows leak into the card");
    assert.ok(body.querySelector(".card-answer"), "answer rendered as plain markdown");
    assert.match(body.textContent, /three sections/, "the final answer shows");
});

test("card surface: a running run shows the working pill + right-click asks for the corner menu", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    const posted = [];
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });

    const hash = "cardrun3";
    await w.dispatch(agentStart(hash, "read the page", "m"));
    // A running tool step (pending, but NOT awaiting approval) → the compact progress pill.
    await w.dispatch(agentStep(hash, 1, { seq: 0, pending: true, tool: "look", arguments: {} }));
    await w.flush();

    assert.ok(posted.some(m => m.__mlSidebarCard === "pill"), "reveals the working pill while running");
    const pill = w.window.document.querySelector(".card-pill");
    assert.ok(pill, "pill rendered");
    assert.match(pill.textContent, /look/, "shows the current tool");

    // Right-clicking the pill asks the shell to draw the corner menu (shell-side, unclipped).
    pill.dispatchEvent(new w.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    await w.tick();
    assert.ok(posted.some(m => m.__mlSidebarCornerMenu), "right-click requests the corner menu");
});

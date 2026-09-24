// sidebar-settings.test.js — the settings view (model fields, their probes, testing each role), the
// server-tool browser, the housekeeping log, and how a dead box reads in both surfaces.

const { test, after } = require("node:test");
const assert = require("node:assert");
const { closeSidebarWorlds, loadSidebarWorld } = require("./helpers");
const { agentStart, agentStep, agentResult, openSettings } = require("./sidebar-helpers");

// Close every jsdom window after the file — the VRAM panel's setInterval keeps a
// window's timers alive, which would otherwise hang the runner after all pass.
after(closeSidebarWorlds);

const agentFail = (hash, error, steps = 0) => ({ kind: "agent-result", id: hash, ts: Date.now() + 100, save: false, session: { hash, turn: steps }, summary: "", steps, hitCap: false, error });

const UNREACHABLE = "Couldn't reach the server at http://gpubox:11434 (Failed to fetch). Is OpenWebUI / Ollama running there?";

const HK = (t, subsystem, kind, extra = {}) => ({ t, subsystem, kind, origin: "worker", ...extra });

const openHousekeeping = async (w) => {
    const more = w.shadow.querySelector('[aria-label="More panels"]');
    assert.ok(more, "the header has a More panels menu");
    more.click();
    await w.flush();
    const items = [...w.shadow.querySelectorAll('.menu [role="menuitem"]')];
    assert.match(items[0]?.textContent || "", /^Housekeeping log/, "the housekeeping log is the menu's first panel");
    items[0].click();
    await w.flush();
    // The log is READ on open, asynchronously: wait until it has arrived (a line, or the empty log's sentence) rather
    // than for one flush. One flush was enough on a laptop and not on CI's runners, where the chips were still [].
    // Bounded, so a view that never loads still fails here instead of hanging the run.
    for (let i = 0; i < 60; i++) {
        const v = w.shadow.querySelector(".hk-view");
        if (v && (v.querySelector(".r-ts-line") || /Nothing recorded/.test(v.textContent || ""))) return;
        await new Promise((r) => setTimeout(r, 25));
        await w.flush();
    }
};

// --- a dead box, read at a glance in both surfaces -------------------------------------------------------

test("backend offline (panel): an unreachable run failure shows a top banner; a later success clears it", async () => {
    // The proactive health probe (LIST_MODELS) independently sets/clears backendError, so make it AGREE with
    // each phase (down, then up) — else it races the run-driven banner (a flaky CI red). `flush` lets it settle.
    let reachable = false;
    const w = await loadSidebarWorld({ sync: { chatUrl: "http://gpubox:11434" }, listModels: () => reachable ? { data: ["m"] } : { error: "Failed to fetch" } });
    await w.dispatch(agentStart("bo1", "do a thing"));
    await w.dispatch(agentFail("bo1", UNREACHABLE));
    await w.flush();
    const banner = w.shadow.querySelector(".backend-offline");
    assert.ok(banner, "the offline banner appears in the panel");
    assert.match(banner.textContent, /Backend unreachable/);
    assert.match(banner.textContent, /gpubox/, "shows the configured server URL");
    // A subsequent successful run means the box answered → clear it (the probe now agrees it's reachable).
    reachable = true;
    await w.dispatch(agentStart("bo2", "another"));
    await w.dispatch(agentResult("bo2", "done", 1));
    await w.flush();
    assert.equal(w.shadow.querySelector(".backend-offline"), null, "a successful run clears the banner");
});

test("backend offline (panel): a hanging request during a LOAD is not a dead box", async () => {
    // THE BUG. Measured on the box during a 64-second load of a 142 GB model: `/api/ps` answered every poll
    // in 0.4-0.8 ms with zero failures and every endpoint stayed under 17 ms, while the request that TRIGGERED
    // the load produced no bytes at all — not even headers — for the whole minute. From that one hanging
    // request the panel concluded the box was down and told the user to go and check their Server URL.
    //
    // `/api/ps` is answering here (the world's OLLAMA_PS mock returns a resident set), which is the evidence
    // that must veto the claim. The failure message is the genuine network-level shape, unchanged — what was
    // wrong was never the classification of the message, it was the conclusion drawn from it alone.
    const w = await loadSidebarWorld({
        sync: { chatUrl: "http://gpubox:11434" },
        vram: [{ model: "qwen3:235b", state: "loading" }],
        // The CHAT backend is what hangs — `listModels` goes to IT, so it fails here exactly as the real
        // request did, while `/api/ps` answers normally. That asymmetry IS the incident, and it is also what
        // makes this test discriminating: with a healthy probe the probe itself clears the banner a moment
        // later, so the assertion would pass with the fix reverted and prove nothing.
        listModels: () => ({ error: "Failed to fetch" }),
    });
    // The panel OPEN, because that is what polls `/api/ps` — and the name of what is loading can only come
    // from there. With it closed the fix still holds (no false alarm) but the panel has nothing to name, which
    // is the honest outcome rather than a guess.
    await w.raw({ __mlSidebarOpen: true });                     // shell reports slid-open → polling allowed
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();
    await w.dispatch(agentStart("bl1", "ask the big model something"));
    await w.dispatch(agentFail("bl1", UNREACHABLE));
    await w.flush();
    assert.equal(w.shadow.querySelector(".backend-offline"), null,
        "a box answering /api/ps in under a millisecond is not unreachable");
    // …and the panel says the true thing instead of nothing, because the silence is what sent the user to
    // Settings in the first place.
    const loading = w.shadow.querySelector(".backend-loading");
    assert.ok(loading, "the panel says a model is loading");
    assert.match(loading.textContent, /qwen3:235b/, "and names it");
    assert.doesNotMatch(loading.textContent, /unreachable/i);
});

test("backend offline (panel): an HTTP-status failure does NOT show the banner (the box answered)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("bo3", "x"));
    await w.dispatch(agentFail("bo3", "HTTP 500 from http://x: boom"));
    await w.tick();
    assert.equal(w.shadow.querySelector(".backend-offline"), null, "an HTTP error is not 'unreachable'");
});

test("backend offline (HUD card): an unreachable failure shows a distinct 'Backend unreachable' card", async () => {
    // The box is down, so the health probe must AGREE (error), else it clears the run-set backendError → flake.
    const w = await loadSidebarWorld({ sync: { chatUrl: "http://gpubox:11434" }, listModels: () => ({ error: "Failed to fetch" }) });
    await w.raw({ __mlSidebarSurface: "card" });
    await w.dispatch(agentStart("boc", "do a thing"));
    await w.dispatch(agentFail("boc", UNREACHABLE));
    await w.flush();
    assert.ok(w.shadow.querySelector(".card-error-offline"), "the HUD card uses the offline error variant");
    assert.match(w.shadow.querySelector(".card-app, .card-body, body").textContent, /Backend unreachable/, "the card headline says the box is unreachable");
});

// The PROACTIVE path: the health probe (LIST_MODELS) flags a dead box even when NO run runs (or a run hangs
// silently with no error event — the reported "stuck on Starting…" bug). This is what makes the offline state
// appear without drilling into a failed run.
test("backend offline (proactive): the health probe flags an unreachable backend with NO run at all", async () => {
    const w = await loadSidebarWorld({ sync: { chatUrl: "http://gpubox:11434" }, listModels: () => ({ error: "/api/models: Failed to fetch" }) });
    await w.flush();   // let the on-mount health probe run
    const banner = w.shadow.querySelector(".backend-offline");
    assert.ok(banner, "the banner appears from the probe — no run needed");
    assert.match(banner.textContent, /Backend unreachable/);
    assert.match(banner.textContent, /gpubox/);
});

test("backend offline (proactive): an HTTP / 'no models installed' probe error is NOT flagged (the box answered)", async () => {
    const w = await loadSidebarWorld({ listModels: () => ({ error: "The server is reachable but has no models installed." }) });
    await w.flush();
    assert.equal(w.shadow.querySelector(".backend-offline"), null, "a reachable-but-empty server is not 'offline'");
});

test("backend offline (proactive): a healthy probe leaves no banner", async () => {
    const w = await loadSidebarWorld({ listModels: () => ({ data: ["m1", "m2"] }) });
    await w.flush();
    assert.equal(w.shadow.querySelector(".backend-offline"), null);
});

test("backend offline (HUD card, proactive): a dead box shows an offline card even with no run event", async () => {
    const w = await loadSidebarWorld({ sync: { chatUrl: "http://gpubox:11434" }, listModels: () => ({ error: "Failed to fetch" }) });
    await w.raw({ __mlSidebarSurface: "card" });
    await w.flush();
    assert.match(w.shadow.querySelector("body").textContent, /Backend (unreachable|down)/i, "the HUD reflects the dead box instead of a silent/stuck card");
});

test("backend offline (mid-run): a server that dies MID-run flags offline AND keeps the completed steps", async () => {
    const w = await loadSidebarWorld({ sync: { chatUrl: "http://gpubox:11434" }, listModels: () => ({ error: "Failed to fetch" }) });
    await w.dispatch(agentStart("mid", "a multi-step task"));
    await w.dispatch(agentStep("mid", 1, { seq: 1, tool: "findByText", arguments: { text: "x" }, result: "found: x" }));
    // …the box dies on the NEXT model call → the loop errors with an unreachable message.
    await w.dispatch(agentFail("mid", UNREACHABLE, 1));
    await w.tick();
    assert.ok(w.shadow.querySelector(".backend-offline"), "a mid-run death raises the offline banner");
    // The progress so far is NOT lost — the completed step is still in the run's detail.
    w.shadow.querySelector(".row").click();
    await w.tick();
    assert.match(w.shadow.querySelector(".view").textContent, /found: x/, "the step that completed before the death survives");
});

test("backend offline (mid-run, HUD card): a mid-run death shows the offline card, not a stuck 'Working…'", async () => {
    const w = await loadSidebarWorld({ sync: { chatUrl: "http://gpubox:11434" }, listModels: () => ({ error: "Failed to fetch" }) });
    await w.raw({ __mlSidebarSurface: "card" });
    await w.dispatch(agentStart("midc", "a multi-step task"));
    await w.dispatch(agentStep("midc", 1, { seq: 1, tool: "findByText", arguments: { text: "x" }, result: "found: x" }));
    await w.dispatch(agentFail("midc", UNREACHABLE, 1));
    await w.tick();
    assert.ok(w.shadow.querySelector(".card-error-offline"), "the HUD card flags the mid-run death as unreachable");
});

// --- the settings view: model fields, their probes, and testing each role --------------------------------

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

    [...w.shadow.querySelectorAll(".set-tab")].find(b => b.textContent.trim() === "Models").click();   // model pickers + utility live under Models
    await w.tick();
    // The model picker drops the full server list on its caret (not a native datalist that hides non-matches).
    w.shadow.querySelector(".model-pick .model-pick-caret").click();
    await w.tick();
    assert.equal(w.shadow.querySelectorAll(".model-pick-menu .model-pick-opt").length, 2, "picker menu populated from LIST_MODELS");
    assert.ok(w.shadow.querySelector('input[type="number"]').disabled, "utility context disabled until a utility model is set");

    const util = w.shadow.querySelector('input[placeholder="blank = use main model"]');
    util.value = "qwen3.5:0.8b";
    util.dispatchEvent(new w.window.Event("input", { bubbles: true }));
    util.dispatchEvent(new w.window.Event("change", { bubbles: true }));
    await w.tick();
    assert.equal(w.syncStore.utilityModel, "qwen3.5:0.8b", "utility model persisted to storage.sync");
    assert.ok(!w.shadow.querySelector('input[type="number"]').disabled, "utility context enabled once a model is set");
});

test("settings: the 'vision capable?' override is DISABLED (locked to Auto) for an Ollama default model", async () => {
    // caps non-null (an array) ⇒ the model is Ollama-probeable ⇒ detection wins ⇒ the manual override is moot.
    const w = await loadSidebarWorld({ sync: { model: "llava", defaultModelVision: "yes" }, models: ["llava"], caps: ["completion", "vision"] });
    await openSettings(w, "Models");
    const sel = [...w.shadow.querySelectorAll("select")].find(s => [...s.options].some(o => /Auto-detect/.test(o.textContent)));
    assert.ok(sel, "the vision-capable select is present");
    await new Promise(r => w.window.setTimeout(r, 450));   // the vision probe is debounced 400ms
    await w.tick();
    assert.ok(sel.disabled, "an Ollama model locks the override (auto-detected)");
    assert.equal(sel.value, "", "and it visually reads as Auto-detect, not the stored 'yes'");
    assert.ok([...w.shadow.querySelectorAll(".set-moot")].some(m => /auto-detected/i.test(m.textContent)), "a note explains the lock");
});

test("settings: the 'vision capable?' override stays ENABLED for a cloud (unprobeable) default model", async () => {
    const w = await loadSidebarWorld({ sync: { model: "gpt-4o", defaultModelVision: "yes" }, models: ["gpt-4o"], caps: null });   // caps null ⇒ can't probe ⇒ cloud
    await openSettings(w, "Models");
    const sel = [...w.shadow.querySelectorAll("select")].find(s => [...s.options].some(o => /Auto-detect/.test(o.textContent)));
    await new Promise(r => w.window.setTimeout(r, 450));
    await w.tick();
    assert.ok(!sel.disabled, "a cloud model keeps the manual override selectable");
    assert.equal(sel.value, "yes", "and shows the stored override value");
});

test("settings: Test models runs a per-model liveness check (set models pass, unset stays '—')", async () => {
    const w = await loadSidebarWorld({ sync: { model: "qwen3:14b", utilityModel: "gemma:2b" }, models: ["qwen3:14b"] });
    await openSettings(w, "Models");
    // One row per role: default, OCR, utility, grounding, embedding.
    assert.equal(w.shadow.querySelectorAll(".test-row").length, 5, "one row per model role");
    const roles = [...w.shadow.querySelectorAll(".test-row .role")].map((e) => e.textContent);
    assert.deepEqual(roles, ["Default", "OCR", "Utility", "Grounding", "Embedding"]);

    w.shadow.querySelector(".test-btn").click();
    await w.tick();
    assert.equal(w.shadow.querySelectorAll(".test-ic.ok").length, 2, "the two set models pass");
    assert.equal(w.shadow.querySelectorAll(".test-ic.unset").length, 3, "unset OCR, grounding + embedding stay not-set");
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
    const field = () => w.shadow.querySelector('.model-pick input[placeholder*="qwen2.5vl:7b"]');
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

test("settings: the default-model vision probe is DEBOUNCED — no per-keystroke MODEL_CAPS (keeps the datalist alive)", async () => {
    // Regression: probing on every keystroke fired an async setState mid-typing that dismissed the native
    // <datalist> autocomplete popup ("the dropdown broke"). The probe must debounce until typing settles.
    const probes = [];
    const w = await loadSidebarWorld({ sync: { model: "" }, models: ["gemma3", "gemma4:31b"], caps: (m) => { probes.push(m); return ["completion", "vision"]; } });
    await openSettings(w, "Models");
    const field = w.shadow.querySelector('input[placeholder="e.g. qwen3:14b"]');
    for (const v of ["g", "ge", "gem", "gemm", "gemma3"]) {
        field.value = v;
        field.dispatchEvent(new w.window.Event("input", { bubbles: true }));
        await w.tick();
    }
    assert.equal(probes.length, 0, "no MODEL_CAPS probe fires WHILE typing (debounced) — the datalist stays open");
    // Once typing settles, exactly ONE probe fires — for the final value only.
    await new Promise(r => w.window.setTimeout(r, 500));
    await w.flush();
    assert.deepEqual(probes, ["gemma3"], "one probe after settling, for the final model");
});

test("settings: the model picker shows the FULL list on its caret even when the typed text matches nothing", async () => {
    // Regression: the native <datalist> hid every option when the typed text matched none, so a non-matching
    // entry looked like a broken/empty dropdown. The picker always lets you browse the whole server list.
    const w = await loadSidebarWorld({ sync: { model: "this matches nothing" }, models: ["gemma3", "qwen3:14b"] });
    await openSettings(w, "Models");
    const pick = w.shadow.querySelector(".model-pick");
    pick.querySelector(".model-pick-caret").click();
    await w.tick();
    assert.ok(pick.querySelector(".model-pick-none"), "a non-matching entry shows the 'used as typed' note, not an empty popup");
    // Clear the field → the whole server list is browsable.
    const input = pick.querySelector("input");
    input.value = "";
    input.dispatchEvent(new w.window.Event("input", { bubbles: true }));
    await w.tick();
    assert.equal(pick.querySelectorAll(".model-pick-opt").length, 2, "cleared → the full list shows");
    // Picking an option fills + persists the field.
    pick.querySelectorAll(".model-pick-opt")[1].click();
    await w.tick();
    assert.equal(w.syncStore.model, "qwen3:14b", "picking an option persists it");
    assert.ok(!w.shadow.querySelector(".model-pick-menu"), "the menu closes after picking");
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

test("settings: the vision (OCR) field reds INLINE when a KNOWN local model lacks vision — and NOT for unknown caps", async () => {
    // Known local text-only model → the field itself flags red (debounced probe, no Test click).
    const bad = await loadSidebarWorld({ sync: { ocrModel: "text-only" }, caps: (m) => m === "text-only" ? ["completion"] : null });
    await openSettings(bad, "Models");
    await new Promise(r => bad.window.setTimeout(r, 500)); await bad.flush();
    const badInput = bad.shadow.querySelector('.model-pick input[placeholder="e.g. qwen2.5vl"]');
    assert.ok(badInput && badInput.classList.contains("err"), "a known non-vision model reds the field");
    assert.ok([...bad.shadow.querySelectorAll(".set-err")].some(e => /doesn't report vision capability/.test(e.textContent)), "with an inline explanation");

    // Cloud / undeterminable caps → NOT flagged (unknown ≠ no).
    const cloud = await loadSidebarWorld({ sync: { ocrModel: "gpt-4o" }, caps: () => null });
    await openSettings(cloud, "Models");
    await new Promise(r => cloud.window.setTimeout(r, 500)); await cloud.flush();
    const cloudInput = cloud.shadow.querySelector('.model-pick input[placeholder="e.g. qwen2.5vl"]');
    assert.ok(cloudInput && !cloudInput.classList.contains("err"), "unknown caps are not flagged");
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
    // Match by the stable placeholder, not the label text (which the UI copy may rename).
    const ocrInput = w.shadow.querySelector('.model-pick input[placeholder="e.g. qwen2.5vl"]');
    assert.ok(ocrInput && ocrInput.classList.contains("err"), "excluded OCR/vision input red-bordered");
    const defInput = [...w.shadow.querySelectorAll(".set-field")]
        .find(f => /Default model/.test(f.textContent))?.querySelector("input");
    assert.ok(defInput && !defInput.classList.contains("err"), "matching Default input not flagged");
    // The picker menu hides the excluded ids so the dropdown matches ml.models().
    const defPick = [...w.shadow.querySelectorAll(".set-field")].find(f => /Default model/.test(f.textContent))?.querySelector(".model-pick");
    defPick.querySelector(".model-pick-caret").click();
    await w.tick();
    const opts = [...defPick.querySelectorAll(".model-pick-opt")].map(o => o.textContent);
    assert.ok(opts.includes("qwen3:14b"), "picker keeps a matching model");
    assert.ok(!opts.includes("gpt-4o-cloud"), "picker hides an excluded model");
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

// Settings copy must stay attached to the control it describes: inserting a new toggle between a select and
// its explanatory note orphans the note under the wrong control (which is exactly what happened once).
test("settings (Appearance): each explanatory note stays under its own control", async () => {
    const w = await loadSidebarWorld();
    await openSettings(w, "Appearance");
    const texts = [...w.shadow.querySelectorAll(".set-field > span, .set-check span, .set-note")].map(e => e.textContent || "");
    const at = (re) => texts.findIndex(t => re.test(t));
    const heightCtl = at(/Tool output height/);
    const heightNote = at(/How tall ANY tool/);
    const stampsCtl = at(/Timestamp streamed output lines/);
    const stampsNote = at(/gutter beside it/);
    assert.ok(heightCtl >= 0 && heightNote >= 0 && stampsCtl >= 0 && stampsNote >= 0, "all four are rendered");
    assert.ok(heightCtl < heightNote, "the height note follows the height control");
    assert.ok(heightNote < stampsCtl, "…and comes BEFORE the next control (not orphaned under it)");
    assert.ok(stampsCtl < stampsNote, "the timestamp note follows the timestamp toggle");
});

// The embedding role cannot be liveness-checked the way the others are: it can't answer a chat ping, and
// reading its capability list only says what the server CLAIMS. So it is tested by actually embedding —
// which also reports the DIMENSIONS, the fact that matters most, since vectors from two different models
// cannot be compared and that failure is silent.
test("settings: the embedding model is tested by EMBEDDING, and reports its dimensions", async () => {
    let embedded = null;
    const w = await loadSidebarWorld({
        sync: { model: "qwen3:14b", embeddingModel: "embeddinggemma:300m" },
        models: ["qwen3:14b"],
        embed: (payload) => { embedded = payload; return { data: { model: payload.model, vectors: [Array(768).fill(0.1)] } }; },
    });
    await openSettings(w, "Models");
    w.shadow.querySelector(".test-btn").click();
    await w.tick();

    assert.ok(embedded, "it embedded rather than sending a chat ping");
    assert.equal(embedded.model, "embeddinggemma:300m", "against the configured model");
    const row = [...w.shadow.querySelectorAll(".test-row")].find((r) => r.querySelector(".role")?.textContent === "Embedding");
    assert.ok(row.querySelector(".test-ic.ok"), "a real vector came back, so it passes");
    assert.match(row.querySelector('[role="tooltip"]').textContent, /768 dimensions/, "and says which geometry");});

// A SETTING THAT SILENTLY DOES NOTHING is what this warning exists to prevent. The protobuf encoder lives on
// the ollama PASSTHROUGH route; OpenWebUI's own `/api/chat/completions` re-encodes the model's stream as SSE,
// so on that URL the header goes out, SSE comes back, everything works exactly as before — and a control
// saying "on" implies otherwise. Measured on a real box: /api/chat/completions → text/event-stream,
// /ollama/v1/chat/completions → application/protobuf; delimited=varint.
//
// ON ONLY, which is what the third state buys. Under AUTO — the default, so this is most people most of the
// time — the same URL is not a mistake to warn about: asking costs one header and the SSE answer is the
// expected other branch. Warning there would put a permanent caveat under a setting nobody chose, which is
// the noise that teaches people to skip the times it means something.
test("settings: protobuf streaming SAYS when the configured URL has no encoder behind it", async () => {
    // A ROUTE WITH NO ENCODER. Both chat routes have one now (OpenWebUI's own, on the patched build, and the
    // ollama passthrough), so the warning is for a URL that is neither.
    const onOther = await loadSidebarWorld({
        sync: { protoStream: "on", chatUrl: "http://gpubox:3000/v1/chat/completions" },
    });
    await openSettings(onOther, "Advanced");
    await onOther.flush();
    const warn = [...onOther.shadow.querySelectorAll(".set-warn")].map((e) => e.textContent).join(" ");
    assert.match(warn, /serves no protobuf encoder/, "it says the URL cannot do it");
    assert.match(warn, /\/ollama\/v1\/chat\/completions/, "…and names the ones that can");
    assert.match(warn, /a stock one answers SSE/i, "…and that OpenWebUI's own route needs the patched build");

    // On a route that DOES serve it, no warning — an unconditional caveat is noise that undermines the times
    // it is true. Both of them now.
    for (const chatUrl of ["http://gpubox:3000/ollama/v1/chat/completions", "http://gpubox:3000/api/chat/completions"]) {
        const w = await loadSidebarWorld({ sync: { protoStream: "on", chatUrl } });
        await openSettings(w, "Advanced");
        await w.flush();
        assert.doesNotMatch([...w.shadow.querySelectorAll(".set-warn")].map((e) => e.textContent).join(" "),
            /serves no protobuf encoder/, chatUrl);
    }

    // …and none at all while the feature is OFF, whatever the URL is.
    const off = await loadSidebarWorld({ sync: { protoStream: "off", chatUrl: "http://gpubox:3000/api/chat/completions" } });
    await openSettings(off, "Advanced");
    await off.flush();
    assert.doesNotMatch([...off.shadow.querySelectorAll(".set-warn")].map((e) => e.textContent).join(" "),
        /serves no protobuf encoder/);

    // …nor under AUTO, which is the DEFAULT — so a fresh profile on OpenWebUI's own route, the commonest
    // setup there is, must not open Settings to a warning about a preference it never expressed.
    const auto = await loadSidebarWorld({ sync: { chatUrl: "http://gpubox:3000/api/chat/completions" } });
    await openSettings(auto, "Advanced");
    await auto.flush();
    assert.doesNotMatch([...auto.shadow.querySelectorAll(".set-warn")].map((e) => e.textContent).join(" "),
        /serves no protobuf encoder/);
});

test("settings: the wire format is a THREE-state control, defaulting to auto", async () => {
    // A checkbox cannot express this: "ask" and "insist" send the identical request and differ only in what a
    // miss MEANS, so the third state is the whole feature rather than a nicety.
    const w = await loadSidebarWorld({ sync: { chatUrl: "http://gpubox:3000/ollama/v1/chat/completions" } });
    await openSettings(w, "Advanced");
    await w.flush();
    const sel = [...w.shadow.querySelectorAll("select")]
        .find((e) => [...e.options].some((o) => o.value === "auto") && [...e.options].some((o) => o.value === "on"));
    assert.ok(sel, "there is a wire-format picker");
    assert.deepEqual([...sel.options].map((o) => o.value), ["auto", "on", "off"], "auto first: it is the default");
    assert.equal(sel.value, "auto", "…and it is what an untouched profile shows");

    // Choosing one WRITES the string, not a boolean — the storage key is read by the background on every
    // streamed turn, so a control that wrote the old type would silently mean something else there.
    sel.value = "on";
    sel.dispatchEvent(new w.window.Event("change", { bubbles: true }));
    await w.flush();
    assert.equal(w.syncStore.protoStream, "on");
});

// --- what the backend exposes: the server-tool browser and the wire format -------------------------------

// Reuses the SAME ToolDefsView an agent run's "agent options" block uses for its local toolset, so a remote
// tool and a local one read the same way rather than in two dialects.

test("server tools: listed on demand, one entry per FUNCTION", async () => {
    const w = await loadSidebarWorld({ serverTools: [{
        id: "searxng_web_search", name: "SearXNG", description: "Web search.", kind: "local",
        functions: [{ name: "search_web", description: "Search the web.", parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }],
    }, {
        id: "web_page_fetch_summarize", name: "Fetch", description: "Read a page.", kind: "local",
        functions: [{ name: "fetch_page", description: "Fetch one page.", parameters: { type: "object", properties: { url: { type: "string" } } } }],
    }] });
    await openSettings(w, "Advanced");

    // Fetched on EXPAND, not on mount: a settings panel opening should not call the backend for a section
    // nobody looked at.
    const btn = [...w.shadow.querySelectorAll(".disc-head")].find(b => /server tools/i.test(b.textContent));
    assert.ok(btn, `the section offers to open them — sections: ${[...w.shadow.querySelectorAll(".disc-head")].map(b => b.textContent.trim()).join(" | ")} — has heading: ${/server-side tools/i.test(w.shadow.textContent)}`);
    btn.click();
    await w.flush();

    // One per function, named the way ml.agent({serverTools}) would expose it — so what you read here is
    // what a run would actually be given, not a bundle summary to unpack.
    const html = w.shadow.body.innerHTML;
    assert.ok(/searxng_web_search__search_web/.test(html), "bundle__function");
    assert.ok(/web_page_fetch_summarize__fetch_page/.test(html));
    assert.match(html, /2 bundles, 2 functions/);
});

test("server tools: an EMPTY list explains itself instead of reading as an error", async () => {
    // A bare-Ollama backend has no such concept and a stock OpenWebUI has none configured — neither is a
    // failure, and a blank panel would look like one.
    const w = await loadSidebarWorld({ serverTools: [] });
    await openSettings(w, "Advanced");
    const b2 = [...w.shadow.querySelectorAll(".disc-head")].find(b => /server tools/i.test(b.textContent));
    assert.ok(b2, `no section — sections: ${[...w.shadow.querySelectorAll(".disc-head")].map(b => b.textContent.trim()).join(" | ")}`);
    b2.click();
    await w.flush();
    assert.match(w.shadow.body.innerHTML, /no server-side tools configured/i);
});

test("server tools: an unreachable backend says so, and does not look empty", async () => {
    const w = await loadSidebarWorld({ serverTools: () => { throw new Error("Failed to fetch"); } });
    await openSettings(w, "Advanced");
    const b3 = [...w.shadow.querySelectorAll(".disc-head")].find(b => /server tools/i.test(b.textContent));
    assert.ok(b3, "no list button");
    b3.click();
    await w.flush();
    assert.match(w.shadow.body.innerHTML, /could not reach the backend/i);
});

// --- the housekeeping log: what the system decided on its own --------------------------------------------

test("housekeeping log: read on open, drawn in the output cell with a timestamp gutter, page reports marked", async () => {
    const now = Date.now();
    const w = await loadSidebarWorld({ housekeeping: [
        HK(now - 3000, "sw", "start"),
        HK(now - 2000, "pyodide", "cold-start", { reason: "prewarm", ms: 1850, origin: "offscreen" }),
        HK(now - 1000, "fetch-cache", "evict", { reason: "budget", bytes: 41_000_000, key: "https://x.example/a.csv", origin: "page", tab: 7 }),
    ] });
    await w.flush();
    assert.equal(w.hkCalls.length, 0, "nothing is read until the view opens");
    await openHousekeeping(w);
    assert.equal(w.hkCalls.length, 1);
    assert.match(w.shadow.querySelector(".head b")?.textContent || "", /Housekeeping log/);
    const cell = w.shadow.querySelector(".hk-view .r-outcell.fill");
    assert.ok(cell, "the log renders into the shared output cell (find, grip, tail-follow)");
    const rows = [...cell.querySelectorAll(".r-ts-row")].map(r => r.querySelector(".r-ts-line").textContent);
    assert.equal(rows.length, 3, "one line per event, oldest first");
    assert.match(rows[1], /cold-start \(prewarm\).*1\.85s.*\[offscreen\]/);
    assert.match(rows[2], /evict \(budget\).*https:\/\/x\.example\/a\.csv.*\[page tab 7\]/);
    assert.ok(!/\[worker\]/.test(rows[0]), "the worker's own events carry no reporter tag");
    assert.ok(cell.querySelector(".r-ts").textContent, "the gutter shows when each event happened");
    assert.match(w.shadow.body.innerHTML, /3 events/);
});

test("housekeeping log: subsystem chips filter the lines, and a storage change updates the open log", async () => {
    const now = Date.now();
    const w = await loadSidebarWorld({ housekeeping: [HK(now - 2000, "sw", "start"), HK(now - 1000, "pyodide", "kill", { reason: "timeout", origin: "offscreen" })] });
    await openHousekeeping(w);
    const chips = () => [...w.shadow.querySelectorAll(".hk-view .rc-lane-chip")];
    assert.deepEqual(chips().map(c => c.textContent), ["sw 1", "pyodide 1"]);
    chips().find(c => c.textContent.startsWith("sw")).click();
    await w.flush();
    let lines = [...w.shadow.querySelectorAll(".hk-view .r-ts-line")].map(l => l.textContent);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^pyodide/);
    w.setHousekeeping([HK(now - 2000, "sw", "start"), HK(now - 1000, "pyodide", "kill", { reason: "timeout", origin: "offscreen" }), HK(now, "pyodide", "cold-start", { reason: "run", ms: 900, origin: "offscreen" })]);
    await w.flush();
    lines = [...w.shadow.querySelectorAll(".hk-view .r-ts-line")].map(l => l.textContent);
    assert.equal(lines.length, 2, "the new event arrived without reopening, and the sw filter still holds");
    assert.equal(w.hkCalls.length, 1, "live updates come from storage, not from re-asking the worker");
});

test("housekeeping log: an empty log says so, and clear asks the worker (a cleared log shows its marker)", async () => {
    const w = await loadSidebarWorld({ housekeeping: [] });
    await openHousekeeping(w);
    assert.match(w.shadow.body.innerHTML, /Nothing recorded since the browser started/);
    w.setHousekeeping([HK(Date.now(), "sw", "start")]);
    await w.flush();
    [...w.shadow.querySelectorAll(".hk-view .raw-btn")].find(b => b.textContent === "clear").click();
    await w.flush();
    assert.deepEqual(w.hkCalls.at(-1), { clear: true });
    w.setHousekeeping([HK(Date.now(), "log", "clear")]);
    await w.flush();
    const lines = [...w.shadow.querySelectorAll(".hk-view .r-ts-line")].map(l => l.textContent);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^log\s+clear$/, "a cleared log reads differently from an empty one");
});

test("housekeeping log: ‹ returns to the view it replaced, and the header's panel buttons step aside meanwhile", async () => {
    const w = await loadSidebarWorld({ housekeeping: [HK(Date.now(), "sw", "start")] });
    await w.flush();
    await openHousekeeping(w);
    assert.equal(w.shadow.querySelector('[aria-label="More panels"]'), null, "no menu while a replacing view is up");
    assert.equal(w.shadow.querySelector('[aria-label="Settings"]'), null);
    w.shadow.querySelector(".head .nav").click();
    await w.flush();
    assert.match(w.shadow.querySelector(".head b")?.textContent || "", /^Sessions/);
    assert.ok(w.shadow.querySelector('[aria-label="More panels"]'));
    assert.equal(w.shadow.querySelector(".hk-view"), null);
});

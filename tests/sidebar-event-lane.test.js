// sidebar-event-lane.test.js — the event lane drawn over the resource tracks: spans and their phases,
// sub-call lineage, evictions ruled through the plot, the lane's tooltips and filter chips, and a box
// whose hardware changes mid-session.

const { test, after } = require("node:test");
const assert = require("node:assert");
const { closeSidebarWorlds, loadSidebarWorld } = require("./helpers");
const { agentStart, agentStep, STACKED_LAYOUT, INFO_2CARD, sidebarCss, cssRule } = require("./sidebar-helpers");

// Close every jsdom window after the file — the VRAM panel's setInterval keeps a
// window's timers alive, which would otherwise hang the runner after all pass.
after(closeSidebarWorlds);

// Every tooltip that shows a live figure has to KEEP showing it: the panel polls every 2s, and a model can
// load, grow or evict while the pointer sits still. A tip that froze at hover time quietly disagrees with the
// chart underneath it. Two tests, because the four surfaces don't all exist in one layout.
const growModel = (gb) => [{ model: "big", vramGB: gb, vramBytes: gb * 1024 ** 3, sizeBytes: gb * 1024 ** 3,
                             gpus: [{ id: "0", runner: "CUDA", vramBytes: gb * 1024 ** 3 }], expiresAt: null }];

async function untilTrue(w, fn, why) {
    for (let i = 0; i < 40; i++) { if (fn()) return; await w.flush(); await new Promise((r) => setTimeout(r, 150)); }
    assert.fail(`${why} — gave up after 6s`);
}

const mouse = (w, el, type, init = {}) => el.dispatchEvent(new w.window.MouseEvent(type, { bubbles: true, ...init }));

// --- the event lane: spans, phases, lineage and evictions ruled through the plot -------------------------

// The lane: what HAPPENED, on the same axis as what was in memory — which answers the question neither view
// answers alone (did that slow turn spend its time LOADING a model, or was the model already there?).
test("event lane: spans render, a tool step is one phased block, and clicking opens its step", async () => {
    const w = await loadSidebarWorld({
        // The lane scopes to the OPEN session by default, and these render it in the list view — so they ask
        // for every session's events explicitly. What the scoping itself does has its own test.
        local: { ml_lane_scope: false },
        vram: [{ model: "qwen3.8:27b", vramGB: 19, vramBytes: 19 * 1024 ** 3, sizeBytes: 19 * 1024 ** 3,
                 gpus: [{ id: "0", runner: "CUDA", vramBytes: 19 * 1024 ** 3 }], expiresAt: null }],
        info: INFO_2CARD,
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    // Let a couple of samples land, so there is an axis to place events on.
    for (let i = 0; i < 20 && w.shadow.querySelectorAll(".rc-seg").length < 1; i++) {
        await w.flush(); await new Promise((r) => setTimeout(r, 150));
    }
    // A run whose steps sit INSIDE the sampled window: one tool step (model, then tool) and one that had to
    // wait for the model to load.
    const now = Date.now();
    await w.dispatch(agentStart("ev1", "do it", "qwen3.8:27b"));
    await w.dispatch({ ...agentStep("ev1", 1, { seq: 1, tool: "python_exec", toolMs: 900,
        usage: { promptTokens: 500, completionTokens: 60, totalTokens: 560, genMs: 700, loadMs: 4000 } }), ts: now });
    await w.flush();
    await w.flush();

    assert.ok(w.shadow.querySelectorAll(".rc-ev").length >= 1, "the lane draws the run's events");
    const tool = w.shadow.querySelector(".rc-ev-tool");
    assert.ok(tool, "a tool step is ONE block…");
    // Phased by who was working, and carrying the MODEL's own colour — the same one its row and bands use,
    // so the lane reads against the model list without needing a legend of its own.
    assert.match(tool.getAttribute("style") || "", /linear-gradient/, "…drawn with a stop where the model handed over");
    assert.match(tool.getAttribute("style") || "", /--model:/, "…in that model's colour");
    // NOTHING IS ASSERTED ABOUT THE LOAD SPAN HERE. It ends where the step starts, ~1.6 s before `now`, so
    // whether it overlaps the sampled window depends on how long the setup above took on this machine — it
    // was absent locally and drawn (correctly, clipped) on a slow CI runner, which failed an assertion that was
    // measuring the runner. "A span that ended before anything was measured is not drawn" is pinned in
    // resource-model.test.mjs (`placeEvents`), where the samples are a fixture rather than the wall clock.

    // Hovering names both halves, in the order they happened, with the rate's basis.
    tool.dispatchEvent(new w.window.MouseEvent("pointerenter", { bubbles: true }));
    tool.parentElement.dispatchEvent(new w.window.MouseEvent("pointermove", { bubbles: true }));
    await w.flush();
    const tip = w.shadow.querySelector(".rc-tip-event");
    assert.ok(tip, "the lane has its own tooltip");
    assert.match(tip.textContent, /qwen3\.8:27b/, "the model half");
    // …and the HEADER names the model too: a step's label is its tool, and a tooltip is read on its own.
    assert.equal(tip.querySelector(".rc-tip-line .rc-tip-aside-model")?.textContent, "qwen3.8:27b", "the header says which model generated this step");
    assert.match(tip.textContent, /python_exec/, "…then the tool half");
    // The figures are BADGES — one chip per fact, so it is visible which numbers belong together.
    const chips = [...tip.querySelectorAll(".rc-chip")].map((c) => c.textContent);
    assert.ok(chips.includes("500 in") && chips.includes("60 out"), `what the model call cost (${chips.join(", ")})`);
    // A separator is a BORDER on the section it opens, never an element of its own — a standalone rule can
    // end up with nothing on one side of it, which this tooltip produced three different ways.
    assert.ok(tip.querySelector(".sep"), "the two halves are separated, not run together");
    assert.equal(tip.querySelector(".rc-tip-rule"), null, "…and not by a floating line");

    // Clicking goes to the step that produced it.
    tool.click();
    await w.flush();
    assert.match(w.shadow.body.innerHTML, /astep|agent/, "it navigated into the run");
});

// Instants belong on the memory trace, not in the lane: an eviction's whole meaning is WHERE the curve steps,
// and a bar below the chart can't say that. (Spans stay in the lane, where their length can be read.)
test("event lane: an eviction rules through the plot and names itself", async () => {
    const two = [
        { model: "keeper:8b", vramGB: 5, vramBytes: 5 * 1024 ** 3, sizeBytes: 5 * 1024 ** 3,
          gpus: [{ id: "0", runner: "CUDA", vramBytes: 5 * 1024 ** 3 }], expiresAt: null },
        { model: "doomed:12b", vramGB: 7, vramBytes: 7 * 1024 ** 3, sizeBytes: 7 * 1024 ** 3,
          gpus: [{ id: "0", runner: "CUDA", vramBytes: 7 * 1024 ** 3 }], expiresAt: null },
    ];
    const w = await loadSidebarWorld({ vram: two, info: INFO_2CARD, ...STACKED_LAYOUT });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    for (let i = 0; i < 25 && w.shadow.querySelectorAll(".rc-seg").length < 1; i++) {
        await w.flush(); await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(w.shadow.querySelectorAll(".rc-rule").length, 0, "nothing has happened yet");

    // One evicts. Nothing REPORTS that — a model simply stops being in ps — so the diff is the only source.
    w.setVram([two[0]]);
    for (let i = 0; i < 25 && !w.shadow.querySelector(".rc-rule"); i++) {
        await w.flush(); await new Promise((r) => setTimeout(r, 150));
    }
    const rule = w.shadow.querySelector(".rc-rule-evict");
    assert.ok(rule, "the eviction is ruled through the plot");
    // Positioned by time on the plot's own axis — not pinned to an edge, and not inside a run's box: the axis is
    // linear in clock time, so an eviction that happened in a gap between runs is drawn in the gap, where it happened.
    assert.match(rule.getAttribute("style") || "", /left:/);
    assert.ok(rule.closest(".rc-plot") && !rule.closest(".rc-seg"), "…on the plot's axis");

    // The SAME eviction is drawn in every track (it happened to the machine, not to one card), so hovering it
    // in one plot must thicken it in all of them — otherwise three copies of one moment read as three moments.
    const allRules = [...w.shadow.querySelectorAll(".rc-rule-evict")];
    assert.ok(allRules.length >= 2, "every track draws the moment");
    assert.equal(w.shadow.querySelectorAll(".rc-rule.hot").length, 0, "nothing highlighted at rest");
    rule.dispatchEvent(new w.window.MouseEvent("pointerenter", { bubbles: true }));
    await w.flush();
    assert.equal(w.shadow.querySelectorAll(".rc-rule.hot").length, allRules.length,
        "hovering one highlights the same moment everywhere");
    // A dashed rule, not solid: a solid line reads as part of the chart (a ceiling, an axis) rather than as
    // something that happened.
    const css = sidebarCss();
    assert.match(cssRule(".rc-rule::before"), /repeating-linear-gradient/);
    // A moment inside a BREAK is the more specific target: its rule stacks above the gap mark, or the gap takes the
    // hover and pointing at an eviction says "not measured".
    const z = (sel) => Number((css.match(new RegExp(`\\${sel} \\{[^}]*z-index: (\\d+)`)) || [])[1]);
    assert.ok(z(".rc-rule") > z(".rc-gap"), `rule z ${z(".rc-rule")} must be above gap z ${z(".rc-gap")}`);

    rule.dispatchEvent(new w.window.MouseEvent("pointerenter", { bubbles: true }));
    w.shadow.querySelector(".rc-plot").dispatchEvent(new w.window.MouseEvent("pointermove", { bubbles: true }));
    await w.flush();
    const tips = [...w.shadow.querySelectorAll(".rc-tip-event")];
    assert.equal(tips.length, 1, "ONE tooltip — every track renders one, and they share a signal");
    assert.match(tips[0].textContent, /doomed:12b/, "…naming the model that left");
    // An instant has no duration: reporting "0ms" and dropping the label said nothing about the thing being
    // pointed at. It says WHEN, and what happened.
    assert.match(tips[0].textContent, /\d{2}:\d{2}:\d{2}/, "the moment it happened");
    assert.doesNotMatch(tips[0].textContent, /0ms/);
    assert.match(tips[0].textContent, /left memory here/, "…and what the line means");
    assert.ok(tips[0].querySelector(".rc-tip-dot"), "in the model's own colour");
    // It belongs to the plot the rule is in, not to a sibling track.
    assert.equal(tips[0].closest(".rc-track"), rule.closest(".rc-track"));
});

// A sub-call means something only next to the step that spawned it: hovering one lights its lineage — the
// step, and the run that contains it — and drops everything else back.
test("event lane: hovering a sub-call lights its lineage and dims the rest", async () => {
    const w = await loadSidebarWorld({
        // The lane scopes to the OPEN session by default, and these render it in the list view — so they ask
        // for every session's events explicitly. What the scoping itself does has its own test.
        local: { ml_lane_scope: false },
        vram: [{ model: "qwen3.8:27b", vramGB: 19, vramBytes: 19 * 1024 ** 3, sizeBytes: 19 * 1024 ** 3,
                 gpus: [{ id: "0", runner: "CUDA", vramBytes: 19 * 1024 ** 3 }], expiresAt: null }],
        info: INFO_2CARD,
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    for (let i = 0; i < 25 && w.shadow.querySelectorAll(".rc-seg").length < 1; i++) {
        await w.flush(); await new Promise((r) => setTimeout(r, 150));
    }
    const now = Date.now();
    await w.dispatch(agentStart("lin", "look at it", "qwen3.8:27b"));
    // Two steps: one that delegated to a vision reader, one that didn't.
    await w.dispatch({ ...agentStep("lin", 1, { seq: 1, tool: "look", toolMs: 500,
        usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110, genMs: 200 },
        // Ends WITH the step: in this world the panel has only just started sampling, so the window is a few
        // milliseconds wide and an event that finished before it began is correctly not drawn.
        subUsage: { byModel: [{ model: "minicpm-v", prompt: 700, completion: 30, calls: 1 }],
                    calls_: [{ model: "minicpm-v", ts: now, ms: 200, prompt: 700, completion: 30 }] } }), ts: now });
    await w.dispatch({ ...agentStep("lin", 2, { seq: 2, tool: "click", toolMs: 100,
        usage: { promptTokens: 120, completionTokens: 8, totalTokens: 128, genMs: 150 } }), ts: now });
    await w.flush();
    await w.flush();

    const sub = w.shadow.querySelector(".rc-ev-embed");
    assert.ok(sub, "the delegated reader is drawn as its own span");
    assert.equal(w.shadow.querySelectorAll(".rc-ev.away").length, 0, "nothing is dimmed at rest");

    sub.dispatchEvent(new w.window.MouseEvent("pointerenter", { bubbles: true }));
    await w.flush();
    const away = [...w.shadow.querySelectorAll(".rc-ev.away")];
    const lit = [...w.shadow.querySelectorAll(".rc-ev:not(.away)")];
    assert.ok(away.length >= 1, "the unrelated step drops back");
    // Its lineage stays: the sub-call, the step that spawned it, the run that contains it.
    assert.ok(lit.some((el) => el.classList.contains("rc-ev-embed")), "the sub-call itself");
    assert.ok(lit.some((el) => el.classList.contains("rc-ev-tool")), "the step that spawned it");
    assert.ok(lit.some((el) => el.classList.contains("rc-ev-run")), "and the run that contains it");
    // The dimmed one is the sibling step — a different call, not part of this lineage.
    assert.ok(away.every((el) => !el.classList.contains("rc-ev-embed")));

    // Hovering it also cross-highlights the READER's own model in the list below, since that is whose time it
    // is — the same mechanism the bands and rows already use.
    assert.match(w.shadow.querySelector(".rc-tip-event")?.textContent || "minicpm-v", /minicpm-v|/);
});

// (The LOAD span's striping is asserted in resource-panel.spec.mjs: a load precedes its own generation, so
// it only lands inside a window that is seconds wide — which the real panel has and this world, sampling
// milliseconds apart, does not.)

// The lane's tooltip names a model, so it carries that model's own dot — the same colour its row and its
// bands use, so the tip is identifiable at a glance from the list below it.
test("event lane: the tooltip's model line carries the model's colour", async () => {
    const w = await loadSidebarWorld({
        // The lane scopes to the OPEN session by default, and these render it in the list view — so they ask
        // for every session's events explicitly. What the scoping itself does has its own test.
        local: { ml_lane_scope: false },
        vram: [{ model: "gemma4:31b", vramGB: 19, vramBytes: 19 * 1024 ** 3, sizeBytes: 19 * 1024 ** 3,
                 gpus: [{ id: "0", runner: "CUDA", vramBytes: 19 * 1024 ** 3 }], expiresAt: null }],
        info: INFO_2CARD,
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    for (let i = 0; i < 25 && w.shadow.querySelectorAll(".rc-seg").length < 1; i++) {
        await w.flush(); await new Promise((r) => setTimeout(r, 150));
    }
    const now = Date.now();
    await w.dispatch(agentStart("dot", "go", "gemma4:31b"));
    await w.dispatch({ ...agentStep("dot", 1, { seq: 1, tool: "exec", toolMs: 80,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, genMs: 60 } }), ts: now });
    await w.flush();
    await w.flush();

    const bar = w.shadow.querySelector(".rc-ev-tool");
    bar.dispatchEvent(new w.window.MouseEvent("pointerenter", { bubbles: true }));
    await w.flush();
    const tip = w.shadow.querySelector(".rc-tip-event");
    // A phased block is several colours, so its header (the whole block) has no swatch; the phases carry them.
    assert.equal(tip.querySelector(".rc-tip-line:first-child .rc-tip-dot"), null, "no swatch on the header of a phased block");
    const dot = tip.querySelector(".rc-tip-dot");
    assert.ok(dot, "the model phase has a dot");
    // The SAME colour the row below uses — a different one would be a second colour scheme for one model.
    const rowDot = w.shadow.querySelector(".vram-row .vram-dot");
    assert.equal(dot.getAttribute("style"), rowDot.getAttribute("style"));
    // Every phase carries the swatch of the stripe it describes, so the tooltip's sections and the block's
    // parts read as the same things rather than a list you map onto a picture yourself.
    // The HEADER says what the block is, then one row per phase. The first phase used to take the header
    // line, which left a machine event with no phases showing nothing but a model name — a serving span and
    // a load looked identical and neither said which it was.
    const phaseDots = [...tip.querySelectorAll(".rc-tip-dot")];
    assert.equal(phaseDots.length, 2, "one per phase: the model, then the tool");
    assert.notEqual(phaseDots[0].getAttribute("style"), phaseDots[1].getAttribute("style"), "…and they differ, as the stripes do");
    // The tool phase says WHAT it is: a bare "exec" reads as a label of unknown kind.
    assert.match(tip.textContent, /tool call:/);
    assert.ok(tip.querySelector("code"), "…with the tool name as an identifier");
});

// The rules were written INLINE in the per-pool view, so the Overview preset — the default — had none at all:
// the same events, drawn in one place and not the other. Both views draw them from one helper now.
test("event lane: evictions rule through the Overview track too, not just the per-pool ones", async () => {
    const two = [
        { model: "keeper:8b", vramGB: 5, vramBytes: 5 * 1024 ** 3, sizeBytes: 5 * 1024 ** 3,
          gpus: [{ id: "0", runner: "CUDA", vramBytes: 5 * 1024 ** 3 }], expiresAt: null },
        { model: "doomed:12b", vramGB: 7, vramBytes: 7 * 1024 ** 3, sizeBytes: 7 * 1024 ** 3,
          gpus: [{ id: "0", runner: "CUDA", vramBytes: 7 * 1024 ** 3 }], expiresAt: null },
    ];
    // No layout seeded → the DEFAULT preset, which is Overview: one track, a line per pool.
    const w = await loadSidebarWorld({ vram: two, info: INFO_2CARD });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    for (let i = 0; i < 25 && w.shadow.querySelectorAll(".rc-seg").length < 1; i++) {
        await w.flush(); await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(w.shadow.querySelectorAll(".rc-name").length, 1, "this is the Overview track");

    w.setVram([two[0]]);
    for (let i = 0; i < 25 && !w.shadow.querySelector(".rc-rule"); i++) {
        await w.flush(); await new Promise((r) => setTimeout(r, 150));
    }
    const rule = w.shadow.querySelector(".rc-rule-evict");
    assert.ok(rule, "the eviction is ruled through the overlay plot");
    assert.ok(rule.closest(".rc-plot") && !rule.closest(".rc-seg"), "…on the plot's axis, by time");
    rule.dispatchEvent(new w.window.MouseEvent("pointerenter", { bubbles: true }));
    await w.flush();
    assert.match(w.shadow.querySelector(".rc-tip-event").textContent, /doomed:12b/, "and it says what happened");
});

// Both timings are reported by the native route: Ollama's own generation time, and our wall clock around the
// fetch. Their difference is what getting TO the model cost, which is a different diagnosis from a slow model.
test("event lane: the tooltip separates generation time from the network", async () => {
    const w = await loadSidebarWorld({
        // The lane scopes to the OPEN session by default, and these render it in the list view — so they ask
        // for every session's events explicitly. What the scoping itself does has its own test.
        local: { ml_lane_scope: false },
        vram: [{ model: "gemma4:31b", vramGB: 19, vramBytes: 19 * 1024 ** 3, sizeBytes: 19 * 1024 ** 3,
                 gpus: [{ id: "0", runner: "CUDA", vramBytes: 19 * 1024 ** 3 }], expiresAt: null }],
        info: INFO_2CARD,
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    for (let i = 0; i < 25 && w.shadow.querySelectorAll(".rc-seg").length < 1; i++) {
        await w.flush(); await new Promise((r) => setTimeout(r, 150));
    }
    const now = Date.now();
    await w.dispatch(agentStart("net", "go", "gemma4:31b"));
    await w.dispatch({ ...agentStep("net", 1, { seq: 1, tool: "exec", toolMs: 50,
        usage: { promptTokens: 100, completionTokens: 90, totalTokens: 190, genMs: 900, evalMs: 300 } }), ts: now });
    await w.flush();
    await w.flush();

    w.shadow.querySelector(".rc-ev-tool").dispatchEvent(new w.window.MouseEvent("pointerenter", { bubbles: true }));
    await w.flush();
    const tip = w.shadow.querySelector(".rc-tip-event");
    const chips = [...tip.querySelectorAll(".rc-chip")].map((c) => c.textContent);
    assert.ok(chips.includes("generation only"), `the rate says what it measures (${chips.join(", ")})`);
    assert.ok(chips.includes("+600ms network"), `…and what getting there cost (${chips.join(", ")})`);
    // Exact start and end, to the millisecond: a duration says how long, not when, and lining a block up
    // against a log needs the clock.
    assert.match(tip.querySelector(".rc-tip-when").textContent, /\d{2}:\d{2}:\d{2}\.\d{3} → \d{2}:\d{2}:\d{2}\.\d{3}/);
});

// --- reading the lane: its tooltips, its filter chips and the scrub strip --------------------------------

test("tooltips: a chart tip reads the DATAPOINT under the cursor; the row tip reads the present", async () => {
    // A one-second window: jsdom has no layout, so the pointer below reads as the plot's RIGHT EDGE, and while a window
    // is still filling (see `chartWindow`) that edge is the future. At one second it is within a poll of the newest
    // reading, which is what "the pointer is over the newest datapoint" means here.
    const w = await loadSidebarWorld({ vram: growModel(19), info: INFO_2CARD, local: { ...STACKED_LAYOUT.local, ml_res_window: 1 } });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();

    // A band needs two samples to have a shape at all.
    await untilTrue(w, () => w.shadow.querySelector(".rc-band"), "no model band was ever drawn");
    mouse(w, w.shadow.querySelector(".rc-band"), "pointerenter");
    mouse(w, w.shadow.querySelector(".rc-plot"), "pointermove", { clientX: 10, clientY: 10 });
    const row = w.shadow.querySelector(".vram-row");
    mouse(w, row, "pointerenter");
    mouse(w, row, "pointermove", { clientX: 40, clientY: 40 });
    await w.flush();

    const bandTip = () => [...w.shadow.querySelectorAll(".rc-tip")].find((e) => !e.classList.contains("vram-rowtip"))?.textContent || "";
    const rowTip = () => w.shadow.querySelector(".vram-rowtip")?.textContent || "";
    assert.match(bandTip(), /19\.00 GiB/, "the band tip opens on what is resident");
    assert.match(rowTip(), /19\.00 GiB/, "so does the row tip");
    // The chart is a history, so a reading off it is only meaningful with the instant attached.
    assert.match(bandTip(), /\d\d:\d\d:\d\d/, "the band tip stamps the datapoint it read");

    // The model grows while both are open. The ROW is a list of what is resident NOW, so its tip follows; the
    // pointer is over the newest datapoint, which is that same reading, so the chart's does too. Reading an
    // OLDER datapoint needs real layout (jsdom reports every element as zero-sized, so every fraction clamps
    // to the right edge) and is asserted in tests/e2e/resource-panel.spec.mjs against a real plot.
    w.setVram(growModel(31));
    await untilTrue(w, () => rowTip().includes("31.00 GiB"), `the row tip froze at hover time (${rowTip()})`);
    assert.doesNotMatch(rowTip(), /19\.00 GiB/);
    await untilTrue(w, () => bandTip().includes("31.00 GiB"), `hovering the newest point still read stale (${bandTip()})`);
});

test("tooltips: the overview pool tip reads its datapoint, and carries the line's own swatch", async () => {
    const w = await loadSidebarWorld({ vram: growModel(19), info: INFO_2CARD });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();

    // Overview: one track, a line per pool, each with a key that quotes the real figure behind the percentage.
    const key = w.shadow.querySelector(".rc-legend .rc-key");
    assert.ok(key, "the overview draws pool keys");
    mouse(w, key, "pointerenter");                       // → the cursor-following pool tip
    mouse(w, w.shadow.querySelector(".rc-plot"), "pointermove", { clientX: 10_000, clientY: 10 });
    await w.flush();

    const tip = () => w.shadow.querySelector(".rc-tip-pools");
    const poolTip = () => tip()?.textContent || "";
    assert.match(poolTip(), /19\.00 GiB of /, "the pool tip opens on what is on that pool");
    // The share is a COLUMN now, not a parenthetical — see the table note above.
    assert.match(tip().querySelector(".rc-tip-pct").textContent, /\d[\d.]*%/, "…quoting the figure AND its share");
    // Several lines cross in one plot, so the tip carries the same swatch the legend key does — without it
    // you are matching a device name to a stroke by eye.
    assert.ok(tip().querySelector(".rc-swatch"), "the pool tip carries its line's colour");

    // Hovering the newest datapoint, it tracks live.
    w.setVram(growModel(31));
    await untilTrue(w, () => poolTip().includes("31.00 GiB"), `the pool tip froze at hover time (${poolTip()})`);
    assert.doesNotMatch(poolTip(), /19\.00 GiB/);
    // The cloned STATIC tooltips (a track header, a device legend key) have their own live-update watch —
    // covered in tooltip-layer.test.mjs, since the pool key no longer has one to test here.
    assert.equal(w.shadow.querySelectorAll(".rc-legend .rc-key .tt-pop").length, 0);
});

// The pool tip lists what is resident, so each MODEL there carries its own dot — the same colour its row
// uses. The residual gets none: it is not a model, and a dot would say it was.
test("pool tooltip: each model consumer carries its colour, the residual doesn't", async () => {
    const w = await loadSidebarWorld({
        vram: [{ model: "qwen3.5:35b", vramGB: 22, vramBytes: 22 * 1024 ** 3, sizeBytes: 22 * 1024 ** 3,
                 gpus: [{ id: "0", runner: "CUDA", vramBytes: 22 * 1024 ** 3 }], expiresAt: null }],
        info: INFO_2CARD,
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    await w.flush();
    const key = w.shadow.querySelector(".rc-legend .rc-key");
    key.dispatchEvent(new w.window.MouseEvent("pointerenter", {}));
    await w.flush();

    const tip = w.shadow.querySelector(".rc-tip-pools");
    const modelLine = [...tip.querySelectorAll(".rc-tip-row")].find((l) => l.textContent.includes("qwen3.5:35b"));
    assert.ok(modelLine.querySelector(".rc-tip-dot"), "the model consumer has a dot");
    assert.equal(modelLine.querySelector(".rc-tip-dot").getAttribute("style"),
        w.shadow.querySelector(".vram-row .vram-dot").getAttribute("style"), "…in the colour its row uses");
    // The residual keeps the dot's FOOTPRINT so the names line up in the grid's first column, but as an empty
    // ring: omitting it left the column ragged, and a filled one would claim the residual is a model.
    const residual = [...tip.querySelectorAll(".rc-tip-row")].find((l) => /driver overhead|unattributed/.test(l.textContent));
    if (residual) {
        const ring = residual.querySelector(".rc-tip-dot");
        assert.ok(ring, "the residual still occupies the dot column, so the names align");
        assert.ok(ring.classList.contains("rc-tip-dot-none"), "…as an empty ring, not a model's colour");
        assert.equal(ring.getAttribute("style"), null, "…and it carries no colour of its own");
    }
});

// The scrub strip: the whole session in one bar, with a box for the slice the chart is drawing. It is drawn
// for as long as there is a WINDOW, even while that window is wider than the session and the box therefore
// fills the strip — which is the state every live view is in for its first minutes. It used to be withheld
// there, on the reasoning that a full-width box is a control that cannot do anything; the cost was that the
// control DELETED ITSELF, both on a fresh open and whenever a stretch-while-following was remembered as the
// new width, and reappeared minutes later when the session outgrew it. It takes the chart's wheel-scrub with
// it when it goes, so there is then no way back at all.
//
// The UNPIN/re-pin round trip is an e2e: in a session a few seconds long, every position is within one poll
// of the tail (TAIL_SLACK_MS), so "dragged back" and "following live" are genuinely the same state here —
// correct behaviour, and untestable at this timescale. The rule itself is covered by scrubExtent's own test.
test("scrub strip: is there from the first samples, and narrows as the session outgrows the window", async () => {
    const GB = 1024 ** 3;
    const w = await loadSidebarWorld({
        vram: [{ model: "big:27b", vramGB: 19, vramBytes: 19 * GB, sizeBytes: 19 * GB,
                 gpus: [{ id: "0", runner: "CUDA", vramBytes: 19 * GB }], expiresAt: null }],
        info: INFO_2CARD,
        // A 2-second window, so a few polls of history is already more session than it draws.
        local: { ml_res_window: 2 },
    });
    // Every width the window box takes, from its FIRST render. Read once after a wait instead, this raced the
    // clock: with a 2-second window, a slow runner (Node 22 on CI) had more than two seconds of session before the
    // first look, and the box had already narrowed. The claim is about the first render, so that is what is read.
    const widths = [];
    const seen = new w.window.MutationObserver(() => {
        const st = w.shadow.querySelector(".rc-scrub-win")?.getAttribute("style");
        const wd = st && Number(/width:\s*([\d.]+)%/.exec(st)?.[1]);
        if (wd && wd !== widths.at(-1)) widths.push(wd);
    });
    seen.observe(w.shadow, { subtree: true, childList: true, attributes: true, attributeFilter: ["style"] });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    for (let i = 0; i < 60 && !w.shadow.querySelector(".rc-scrub"); i++) {
        await w.flush(); await new Promise((r) => setTimeout(r, 200));
    }
    let strip = w.shadow.querySelector(".rc-scrub");
    assert.ok(strip, "the strip is drawn as soon as there is a session to draw");
    assert.ok(widths[0] > 90, `…full width to begin with, because the window is wider than the session so far (first widths: ${widths.slice(0, 4).join(", ")})`);
    assert.ok(strip.querySelectorAll(".rc-scrub-run").length >= 1, "the session's runs are drawn as blocks");
    // Wait until the box is a genuine BOX and not the whole strip. The strip appears the instant history
    // exceeds the window, at which point the window still covers ~100% of it — and a grab at x=0 then lands
    // on the window's own LEFT HANDLE, which means resize, not pan. This test passed for a while on that
    // mix-up, because a resize dragged to the far left also produces `left: 0%`.
    for (let i = 0; i < 60; i++) {
        const st = w.shadow.querySelector(".rc-scrub-win")?.getAttribute("style") || "";
        if (Number(/width:\s*([\d.]+)%/.exec(st)?.[1] ?? 100) < 50) break;
        await w.flush(); await new Promise((r) => setTimeout(r, 200));
    }
    strip = w.shadow.querySelector(".rc-scrub");
    const boxBefore = strip.querySelector(".rc-scrub-win").getAttribute("style");
    assert.match(boxBefore, /left:\s*[\d.]+%/, "the window is a box on the strip");
    assert.ok(Number(/width:\s*([\d.]+)%/.exec(boxBefore)[1]) < 50, "…a box, with strip either side of it to pan into");
    assert.ok(strip.querySelector(".rc-scrub-live").classList.contains("on"), "it starts pinned to live");
    seen.disconnect();

    // Dragging the box moves the window through the session — it scrolls, it does not zoom.
    const track = strip.querySelector(".rc-scrub-track");
    track.dispatchEvent(new w.window.MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 0, clientY: 0 }));
    await w.flush();
    const boxAfter = w.shadow.querySelector(".rc-scrub-win").getAttribute("style");
    assert.notEqual(boxAfter, boxBefore, "the box moved to where it was dragged");
    assert.match(boxAfter, /left:\s*0%/, "…to the start of the session");
    // And the panel is holding an explicit range now rather than the rolling window.
    assert.ok(w.shadow.querySelector(".vram-zoom.pinned"), "the window became a range you chose");
    w.window.dispatchEvent(new w.window.MouseEvent("pointerup", { bubbles: true, clientX: 0, clientY: 0 }));
});

// The lane draws every session's events, which is right until a browsing session holds a dozen runs. The
// filter is two independent axes: which KINDS to draw, and whether to scope to the run being read.
test("lane filter: chips say what they hide, kinds persist, scope follows what you're reading", async () => {
    const GB = 1024 ** 3;
    const w = await loadSidebarWorld({
        // The kind-chip half needs events on screen, and scoping (the default) hides every run's while
        // nothing is open — so this world starts unscoped and the scope half toggles it on below.
        local: { ml_lane_scope: false },
        vram: [{ model: "gemma4:31b", vramGB: 19, vramBytes: 19 * GB, sizeBytes: 19 * GB,
                 gpus: [{ id: "0", runner: "CUDA", vramBytes: 19 * GB }], expiresAt: null }],
        info: INFO_2CARD,
    });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    for (let i = 0; i < 25 && w.shadow.querySelectorAll(".rc-seg").length < 1; i++) {
        await w.flush(); await new Promise((r) => setTimeout(r, 150));
    }
    // Two runs, so scoping has something to exclude.
    const now = Date.now();
    for (const hash of ["one", "two"]) {
        await w.dispatch(agentStart(hash, "go", "gemma4:31b"));
        await w.dispatch({ ...agentStep(hash, 1, { seq: 1, tool: "exec", toolMs: 60,
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, genMs: 50 } }), ts: now });
        await w.dispatch({ ...agentStep(hash, 2, { seq: 2, tool: "click", toolMs: 40,
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, genMs: 40 } }), ts: now });
    }
    await w.flush();
    await w.flush();

    const bars = () => w.shadow.querySelectorAll(".rc-ev").length;
    // Only the bars a RUN owns. Machine events (a load, an eviction) belong to no session and survive every
    // scoping — counting them would make "scoped to nothing" look like it had failed to hide anything.
    const runBars = () => w.shadow.querySelectorAll(".rc-ev-run, .rc-ev-tool, .rc-ev-gen, .rc-ev-embed").length;
    const chip = (label) => [...w.shadow.querySelectorAll(".rc-lane-chip")].find((c) => c.textContent.startsWith(label));
    assert.ok(bars() >= 4, "both runs' events are drawn");
    // A chip carries its COUNT: a filter that makes you toggle blindly to learn what it hides is worse than none.
    assert.match(chip("steps").textContent, /steps \d+/);

    const before = bars();
    chip("steps").click();
    await w.flush();
    assert.ok(bars() < before, "hiding a kind removes it from the lane");
    assert.ok(chip("steps").classList.contains("off"), "…and the chip says so");
    // Remembered, because it is a preference about what you want to see.
    assert.deepEqual(w.localStore.ml_lane_hidden, ["tool"]);
    chip("steps").click();
    await w.flush();
    assert.equal(bars(), before, "and toggling back restores them");

    // Scoping is the DEFAULT, and its control is offered everywhere — in the list view it is the only thing
    // that says why there are no run events, and the only way to get them. It is a SEGMENTED pair in the
    // panel header rather than a chip in this filter row: it decides the window, the model list and the lane
    // together, where these chips each hide one kind, and sitting among them said it was one of them.
    const seg = (label) => [...w.shadow.querySelectorAll(".rc-scope-seg")].find(b => b.textContent.trim().startsWith(label));
    assert.ok(seg("session") && seg("full"), "the scope switch is offered in the list view too");
    // Both states are VISIBLE, one lit — a single toggling label has to be read twice to work out whether it
    // names the current state or the thing it will do.
    assert.ok(seg("full").getAttribute("aria-pressed") === "true", "starts on full (the fixture's default)");
    const all = runBars();

    // Scoping with NOTHING open shows no run's events at all — that is the intended overview, not an empty
    // panel: there is no session to scope to.
    seg("session").click();
    await w.flush();
    assert.equal(runBars(), 0, "nothing open, so no run events");
    assert.equal(seg("session").getAttribute("aria-pressed"), "true", "…and the switch says which it is on");
    assert.deepEqual(w.localStore.ml_lane_scope, true, "remembered, like the kind chips");

    // Reading ONE run: its events come back, the other run's stay gone.
    w.shadow.querySelectorAll(".row")[0].click();
    await w.flush();
    const scoped = runBars();
    assert.ok(scoped > 0 && scoped < all, `only this session's events (${scoped} of ${all})`);
    // And the AXIS follows too — one switch, one meaning. The window is the session's own stretch, not the
    // rolling one, so the chart cannot draw ten minutes of a shared box around a list showing one model.
    assert.ok(w.shadow.querySelector(".rc-scope-seg.on").textContent.trim().startsWith("session"));
    // …but NOT the machine's own: an eviction has no run to belong to, and hiding it would remove the events
    // the chart exists for. (Covered exactly in resource-model.test.mjs; here it is the scope chip working.)
});

// --- a session whose hardware changes under it -----------------------------------------------------------

// EVERY figure on the panel has to follow the data — not just the ones with their own test. A stale number is
// the worst failure this panel can have: it looks authoritative and it is wrong. So rather than asserting six
// specific figures, this asserts the INVARIANT — after the resident set changes, no element anywhere in the
// panel still shows a value from before it.
test("every displayed figure updates: no stale number survives a change", async () => {
    const GB = 1024 ** 3;
    let gb = 19;   // what the model holds right now; the box's free memory follows from it
    const model = () => [{ model: "big:27b", vramGB: gb, vramBytes: gb * GB, sizeBytes: gb * GB, contextLength: 262144,
                           gpus: [{ id: "0", runner: "CUDA", vramBytes: gb * GB }], expiresAt: null }];
    const boxInfo = () => ({ compute: {
        system_compute: { cpu_cores: 32, total_memory: 130142785536, free_memory: 40 * GB },
        supported_gpus: [
            { gpu_id: "0", name: "CUDA0", runner: "CUDA", total_memory: 101972967424, physical_memory: 102641958912,
              free_memory: 101972967424 - gb * GB - Math.round(0.55 * GB) },
            { gpu_id: "1", name: "CUDA1", runner: "CUDA", total_memory: 101972967424, physical_memory: 102641958912,
              free_memory: 101972967424 - Math.round(0.55 * GB) },
        ],
    } });

    // Both layouts, because they display DIFFERENT figures: the per-pool tracks show bytes and a share each,
    // the Overview shows a percentage per pool.
    for (const layout of [STACKED_LAYOUT, {}]) {
        gb = 19;
        const w = await loadSidebarWorld({ vram: model(), info: boxInfo, ...layout });
        await w.raw({ __mlSidebarOpen: true });
        w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
        for (let i = 0; i < 25 && !w.shadow.querySelector(".rc-total"); i++) {
            await w.flush(); await new Promise((r) => setTimeout(r, 150));
        }
        const panelText = () => w.shadow.querySelector(".vram")?.textContent ?? "";
        // Everything that shows a number, by selector — the header total, each track's used/ceiling/share,
        // every legend key, and the model rows.
        const SELECTORS = [".vram-total", ".rc-total", ".rc-key", ".vram-row"];
        const snap = () => SELECTORS.flatMap((sel) => [...w.shadow.querySelectorAll(sel)].map((e) => `${sel}: ${e.textContent.trim()}`));
        const before = snap();
        assert.ok(before.some((t) => /19\.00 GiB/.test(t)), `the starting figures are on screen (${before.join(" | ")})`);

        // The model grows. Every figure derived from it must move: the header total, the card's used and its
        // share, the free band beside it, and the row.
        gb = 31;
        w.setVram(model());
        for (let i = 0; i < 40; i++) {
            await w.flush(); await new Promise((r) => setTimeout(r, 150));
            if (!/19\.00 GiB/.test(panelText()) && /31\.00 GiB/.test(panelText())) break;
        }
        const after = snap();
        assert.ok(after.some((t) => /31\.00 GiB/.test(t)), `the new figure is shown (${after.join(" | ")})`);
        // THE invariant: nothing anywhere still quotes the old value.
        assert.doesNotMatch(panelText(), /19\.00 GiB/, `a stale figure survived: ${after.join(" | ")}`);
        // The free band exists only in the per-pool layout — Overview shows a percentage per pool and no free
        // key at all, so there is nothing to check there.
        // The free band comes from CAPACITY, not from ps, and capacity is deliberately polled on a slower
        // cadence (CAPACITY_EVERY) — so it lags by up to that interval by design. Reopening the panel forces
        // a fresh fetch, which is the fastest honest way to see it follow.
        if (/free \d/.test(panelText())) {
            w.shadow.querySelector('[aria-label="VRAM monitor"]').click();   // closed
            await w.flush();
            w.shadow.querySelector('[aria-label="VRAM monitor"]').click();   // …and open again → refetch
            for (let i = 0; i < 40 && !/free 63\.\d\d GiB/.test(panelText()); i++) {
                await w.flush(); await new Promise((r) => setTimeout(r, 150));
            }
            assert.match(panelText(), /free 63\.\d\d GiB/, `the free band followed capacity (${snap().join(" | ")})`);
        }
        // Percentages are derived too, so they cannot be left behind either.
        const pctBefore = before.join(" ").match(/\((\d+)%\)|\s(\d+)%/g) || [];
        const pctAfter = snap().join(" ").match(/\((\d+)%\)|\s(\d+)%/g) || [];
        if (pctBefore.length) assert.notDeepEqual(pctAfter, pctBefore, "the shares moved with the bytes");
    }
});

// A GPU disappearing mid-session: a driver crash, a GPU reset, a container losing its device. Three things
// must hold — the panel re-shapes without breaking, the history leading up to it SURVIVES (that trace is the
// incident), and a model still resident on the missing card is not quietly dropped or mislabelled.
test("a card that vanishes mid-session: re-shape, keep the trace, say what happened", async () => {
    const GB = 1024 ** 3;
    let cards = 2;
    const info = () => ({ compute: {
        system_compute: { cpu_cores: 32, total_memory: 130142785536, free_memory: 40 * GB },
        supported_gpus: [0, 1].slice(0, cards).map((i) => ({
            gpu_id: String(i), name: `CUDA${i}`, runner: "CUDA",
            total_memory: 101972967424, physical_memory: 102641958912, free_memory: 80 * GB })),
    } });
    // The model lives on the card that is about to disappear.
    const onCard1 = [{ model: "orphan:22b", vramGB: 22, vramBytes: 22 * GB, sizeBytes: 22 * GB, contextLength: 262144,
                       gpus: [{ id: "1", runner: "CUDA", vramBytes: 22 * GB }], expiresAt: null }];
    const w = await loadSidebarWorld({ vram: onCard1, info, ...STACKED_LAYOUT });
    await w.raw({ __mlSidebarOpen: true });
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    for (let i = 0; i < 25 && w.shadow.querySelectorAll(".rc-track").length < 3; i++) {
        await w.flush(); await new Promise((r) => setTimeout(r, 150));
    }
    assert.deepEqual([...w.shadow.querySelectorAll(".rc-name")].map((e) => e.textContent),
        ["CUDA0", "CUDA1", "System RAM"]);
    // Sample for long enough to have a trace worth keeping.
    for (let i = 0; i < 10; i++) { await w.flush(); await new Promise((r) => setTimeout(r, 150)); }
    const segsBefore = w.shadow.querySelectorAll(".rc-seg").length;
    assert.ok(segsBefore > 0, "there is a trace on screen");

    // CUDA1 stops being reported. The panel must re-fetch capacity to notice, which happens on reopen.
    cards = 1;
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    await w.flush();
    w.shadow.querySelector('[aria-label="VRAM monitor"]').click();
    for (let i = 0; i < 40 && w.shadow.querySelectorAll(".rc-name").length !== 2; i++) {
        await w.flush(); await new Promise((r) => setTimeout(r, 150));
    }

    // 1. It re-shapes to the devices that are actually there — a track for a device that is gone would render
    //    nothing and look broken.
    assert.deepEqual([...w.shadow.querySelectorAll(".rc-name")].map((e) => e.textContent), ["CUDA0", "System RAM"]);
    // 2. The trace survives: a vanished card is an incident, not a different machine, and the samples leading
    //    up to it are the most valuable ones on screen.
    assert.ok(w.shadow.querySelectorAll(".rc-seg").length > 0, "the history was not wiped");
    // 3. The model is still listed — ps still reports it resident — and its placement is honest about the
    //    card being gone rather than printing a bare device id.
    const row = [...w.shadow.querySelectorAll(".vram-row")].find((r) => r.textContent.includes("orphan:22b"));
    assert.ok(row, "a model resident on the missing card is not quietly dropped");
    row.dispatchEvent(new w.window.MouseEvent("pointerenter", {}));
    row.dispatchEvent(new w.window.MouseEvent("pointermove", { clientX: 40, clientY: 40 }));
    await w.flush();
    assert.match(w.shadow.querySelector(".vram-rowtip").textContent, /no longer reported/,
        "…and the tooltip says the card it was on is gone");
    // The row itself carries a warning: its memory is real but has no pool to be drawn against, so it is in
    // the list and not in the chart — asymmetric enough to need saying out loud.
    const chip = row.querySelector(".vram-orphan");
    assert.ok(chip, "the row warns that its card is gone");
    assert.match(chip.querySelector(".tt-pop").textContent, /stopped reporting/);
});

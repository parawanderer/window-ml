// sidebar-agent-step.test.js — the render of ONE agent step: its In (the verb, the raw args, the schema
// behind them), its Out (descriptors, delegated sub-calls), the locate substeps, and the step box itself.

const { test, after } = require("node:test");
const assert = require("node:assert");
const { closeSidebarWorlds, loadSidebarWorld } = require("./helpers");
const { agentStart, agentStep, agentResult, locateRender } = require("./sidebar-helpers");

// Close every jsdom window after the file — the VRAM panel's setInterval keeps a
// window's timers alive, which would otherwise hang the runner after all pass.
after(closeSidebarWorlds);

const agentCfg = (tools) => ({ system: "sys", customSystem: false, tools, maxSteps: 10, think: null, env: true, vision: null, systemAppend: null, unattended: false, silent: false, driverSees: false, visionModel: null });

const clickTool = { name: "click", requiresApproval: true, vision: false, description: "Click an element.", summary: "Clicks.",
    parameters: { type: "object", required: ["selector"], properties: {
        selector: { type: "string", description: "CSS selector or @pt token from locate." },
        verify: { type: "boolean", description: "Look at the result after clicking." } } } };

const nestedTool = { name: "cfg", summary: "Configures.", parameters: { type: "object", properties: {
    opts: { type: "object", description: "Options bag.", properties: { retries: { type: "number", description: "How many times to retry." } } } } } };

// --- locate render: the substeps a pick was made through -------------------------------------------------

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

// --- a step's In: the rendered verb, the raw args, and the schema behind them ----------------------------

// The macro's mark is a byte RANGE, and the renderer highlights around it segment by segment — so the span
// it wraps has to be exactly the generated call and nothing either side of it. `expandPointers` is tested for
// producing the right range; this is the other half, that the range is what actually gets underlined.
test("pointer macro: the underline wraps EXACTLY the expanded call, not the code around it", async () => {
    const w = await loadSidebarWorld();
    const src = `const n = ml.dereference("@tool:a39f599").length; console.log("@tool:not-a-macro", n);`;
    const at = src.indexOf('ml.dereference');
    await w.dispatch(agentStart("mac", "read it"));
    await w.dispatch(agentStep("mac", 1, {
        seq: 1, tool: "exec", arguments: { js: src }, result: "ok",
        renderIn: { type: "code", text: src, lang: "javascript", note: "1 pointer macro expanded",
                    marks: [{ start: at, end: at + 'ml.dereference("@tool:a39f599")'.length, from: "@tool:a39f599" }] },
    }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const head = w.shadow.querySelector('[data-astep-seq="1"] .astep-head');
    head.click();
    await w.tick();

    const marks = w.shadow.querySelectorAll('[data-astep-seq="1"] code .expanded');
    assert.equal(marks.length, 1, "one mark, for the one expansion");
    // The tooltip lives INSIDE the mark, so read the mark's own text without it.
    const markText = [...marks[0].childNodes]
        .filter((n) => !(n.classList && n.classList.contains("tt-pop")))
        .map((n) => n.textContent).join("");
    assert.equal(markText, 'ml.dereference("@tool:a39f599")',
        "exactly the generated call — no leading `const n = `, no trailing `.length`");
    // (Whether the tooltip is display:none — which is what stops its prose being selected along with the
    // code — is a CSS fact, and this world loads no stylesheet, so asserting it here would assert nothing.)
    // The pointer written INSIDE A STRING is not a macro and must not be underlined: the renderer marks what
    // the expander marked, and marking by search would have caught this one too.
    const body = w.shadow.querySelector('[data-astep-seq="1"] .astep-body').textContent;
    assert.ok(body.includes("@tool:not-a-macro"), "the string literal is still shown verbatim");

    // The original spelling rides the tooltip, so hovering the underline says what the model actually wrote.
    const pop = marks[0].querySelector(".tt-pop");
    assert.ok(pop, "the mark carries a tooltip");
    assert.match(pop.textContent, /Expanded from/);
    assert.match(pop.textContent, /@tool:a39f599/);
});

test("fetch_url step: the rendered In shows a clean verb + URL line, NOT a raw JSON dump of the descriptor", async () => {
    const w = await loadSidebarWorld();
    const url = "https://raw.githubusercontent.com/SideStore/anisette-servers/main/servers.json";
    await w.dispatch(agentStart("fu2", "why no https"));
    await w.dispatch(agentStep("fu2", 1, { seq: 1, tool: "fetch_url", arguments: { url }, result: "Fetched …", renderIn: { type: "action", verb: "fetch", target: url } }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    // Expand the fetch_url step to reveal the In block.
    const head = [...w.shadow.querySelectorAll(".astep.tool .astep-head")].find(h => /fetch_url/.test(h.textContent));
    head.click();
    await w.tick();

    const action = w.shadow.querySelector(".r-action");
    assert.ok(action, "the action renders as a clean line (not JSON)");
    assert.match(action.textContent, /fetch/i, "shows the verb");
    const target = w.shadow.querySelector(".r-action-target");
    assert.ok(target, "the URL is styled as a target");
    assert.match(target.textContent, /servers\.json/, "and is the fetched URL");
    // The rendered view must NOT be the raw descriptor JSON.
    assert.doesNotMatch(w.shadow.querySelector(".astep-body").textContent, /"type":\s*"action"/, "no raw {type:action} JSON dump");

    // Right-click the URL → a context menu offering "Open in new tab" + "Copy URL".
    let opened = null;
    w.window.open = (u) => { opened = u; return null; };
    target.dispatchEvent(new w.window.MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }));
    await w.tick();
    const items = [...w.shadow.querySelectorAll(".ctx-menu .ctx-item")].map(b => b.textContent);
    assert.ok(items.includes("Open in new tab"), "the menu offers open-in-new-tab");
    assert.ok(items.includes("Copy URL"), "and copy");
    [...w.shadow.querySelectorAll(".ctx-menu .ctx-item")].find(b => b.textContent === "Open in new tab").click();
    assert.equal(opened, url, "clicking it opens the URL in a new tab");
});

test("fetch_url `ask` step: the In shows the FULL question on its own line + who answered it and the tokens", async () => {
    const w = await loadSidebarWorld();
    const url = "https://api.github.com/repos/o/r/git/trees/abc?recursive=1";
    const ask = "List only the file paths (type: blob) that plausibly hold a system prompt";
    await w.dispatch(agentStart("ask1", "find the prompt file"));
    await w.dispatch(agentStep("ask1", 1, {
        seq: 1, tool: "fetch_url", arguments: { url, ask }, result: "Fetched …\n\nAnswer:\nREADME.md",
        renderIn: { type: "action", verb: "fetch", target: url, ask, answeredBy: "qwen3:4b", tokens: 5231 },
    }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const head = [...w.shadow.querySelectorAll(".astep.tool .astep-head")].find(h => /fetch_url/.test(h.textContent));
    head.click();
    await w.tick();

    const askLine = w.shadow.querySelector(".r-action-ask");
    assert.ok(askLine, "the question renders on its own line");
    assert.match(askLine.textContent, /Asked:/, "with a bold Asked: label");
    assert.ok(askLine.textContent.includes(ask), "the FULL question is shown (not truncated)");
    const meta = w.shadow.querySelector(".r-action-meta");
    assert.ok(meta, "the answered-by/tokens meta line renders");
    assert.match(meta.textContent, /Answered by:/);
    assert.match(meta.textContent, /qwen3:4b/, "names the reader model");
    assert.match(meta.textContent, /5,231 tokens/, "and the tokens the answer used");
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

test("raw In args: a key documented in the tool schema gets a hover tooltip; an undefined arg gets a red-squiggle warning", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("r1", "task", "m", 10, agentCfg([clickTool])));
    await w.dispatch(agentStep("r1", 1, { seq: 1, tool: "click", arguments: { selector: "#b", verify: true, bogus: 1 } }));
    w.shadow.querySelector(".row").click(); await w.tick();
    w.shadow.querySelector(".astep.tool .astep-head").click(); await w.tick();

    const docKeys = [...w.shadow.querySelectorAll(".astep.tool .jt-key-doc")].map(n => n.textContent);
    assert.ok(docKeys.some(t => /selector/.test(t)) && docKeys.some(t => /verify/.test(t)), `documented keys are underlined (${docKeys})`);
    const bogus = [...w.shadow.querySelectorAll(".astep.tool .jt-key")].find(n => /bogus/.test(n.textContent));
    assert.ok(bogus && bogus.classList.contains("jt-key-unknown"), "an arg NOT in the schema gets the red-squiggle 'unknown' style");
    assert.match(bogus.querySelector(".tt-pop").textContent, /Not in this tool's parameter schema/, "…with a hallucinated-arg warning");
    const tips = [...w.shadow.querySelectorAll(".astep.tool .jt-key-doc .tt-pop")].map(n => n.textContent).join(" | ");
    assert.match(tips, /CSS selector or @pt/, "tooltip text is the schema description");
    assert.ok(w.shadow.querySelector(".astep.tool .r-outcorner"), "the raw view carries a copy button — on the CELL, so it does not scroll away with the text");
});

test("raw In args: malformed schema / non-object args never crash the panel (falls back safely)", async () => {
    const w = await loadSidebarWorld();
    const badProps = { name: "x", parameters: { type: "object", properties: "not-an-object" } };
    const badNode = { name: "y", parameters: { type: "object", properties: { a: "should-be-a-schema", b: 5 } } };
    await w.dispatch(agentStart("r2", "t", "m", 10, agentCfg([badProps, badNode])));
    await w.dispatch(agentStep("r2", 1, { seq: 1, tool: "x", arguments: { a: 1, b: 2 } }));
    await w.dispatch(agentStep("r2", 2, { seq: 2, tool: "y", arguments: { a: { nested: true }, b: [1, 2] } }));
    await w.dispatch(agentStep("r2", 3, { seq: 3, tool: "z", arguments: "a bare string, not an object" }));
    w.shadow.querySelector(".row").click(); await w.tick();
    for (const head of w.shadow.querySelectorAll(".astep.tool .astep-head")) { head.click(); await w.tick(); }

    assert.ok(w.shadow.querySelectorAll(".astep.tool").length >= 3, "every step rendered — nothing threw");
    assert.equal(w.shadow.querySelectorAll(".jt-key-doc").length, 0, "a malformed schema yields NO descriptions (never a crash)");
    assert.ok(w.shadow.querySelector(".astep.tool .code"), "non-object args fall back to the copyable code renderer");
});

test("raw In args: a NESTED arg key gets its schema description (schema walk recurses)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("rn", "t", "m", 10, agentCfg([nestedTool])));
    await w.dispatch(agentStep("rn", 1, { seq: 1, tool: "cfg", arguments: { opts: { retries: 3 } } }));
    w.shadow.querySelector(".row").click(); await w.tick();
    w.shadow.querySelector(".astep.tool .astep-head").click(); await w.tick();
    const retries = [...w.shadow.querySelectorAll(".astep.tool .jt-key-doc")].find(n => /retries/.test(n.textContent));
    assert.ok(retries, "the nested key is documented");
    assert.match(retries.querySelector(".tt-pop").textContent, /How many times to retry/, "nested tooltip is the nested schema description");
});

test("raw In args: the always-expanded tree has NO collapse chevrons and shows nested values", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("re", "t", "m", 10, agentCfg([nestedTool])));
    await w.dispatch(agentStep("re", 1, { seq: 1, tool: "cfg", arguments: { opts: { retries: 3 } } }));
    w.shadow.querySelector(".row").click(); await w.tick();
    w.shadow.querySelector(".astep.tool .astep-head").click(); await w.tick();
    assert.equal(w.shadow.querySelectorAll(".astep.tool .jt-args .tri").length, 0, "no chevrons in the raw In tree (allOpen)");
    assert.ok([...w.shadow.querySelectorAll(".astep.tool .jt-key")].some(n => /retries/.test(n.textContent)), "the nested value is expanded, not collapsed behind a preview");
});

// badge" already have tests near line 1104/1511 — these fill the remaining gaps). ------------------------
test("agent-step: an arg-schema mismatch shows the warning count + the red strip", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("i1", "t"));
    await w.dispatch(agentStep("i1", 1, { seq: 1, tool: "click", arguments: { selector: 1 }, result: "ok", argIssues: ["selector should be string"] }));
    w.shadow.querySelector(".row").click(); await w.tick();
    assert.ok(w.shadow.querySelector(".astep.tool .arg-warn"), "the head shows an arg-warn count");
    w.shadow.querySelector(".astep.tool .astep-head").click(); await w.tick();
    assert.match(w.shadow.querySelector(".astep.tool .arg-issues").textContent, /selector should be string/, "the red strip lists the issue");
});

// --- the step box itself: the thought, the thinking block, and what is not a step ------------------------

test("turn prose: a SHORT one-line thought has NO misleading collapse chevron; a LONG one keeps it", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("tp", "do it"));
    await w.dispatch(agentStep("tp", 1, { seq: 1, thought: "Let me try the fetch tool instead:" }));   // short → nothing to collapse
    await w.dispatch(agentStep("tp", 2, { seq: 2, thought: "x ".repeat(120) }));   // long (>100 chars) → truncates
    w.shadow.querySelector(".row").click();
    await w.tick();
    const proses = [...w.shadow.querySelectorAll(".aturn-prose")];
    assert.equal(proses.length, 2, "both thoughts render as prose");
    const short = proses.find(p => /fetch tool instead/.test(p.textContent));
    assert.ok(short.classList.contains("no-toggle"), "short thought is flagged no-toggle");
    assert.equal(short.querySelector(".prose-tri"), null, "…and has NO chevron (nothing to expand)");
    const long = proses.find(p => !/fetch tool instead/.test(p.textContent));
    assert.ok(long.querySelector(".prose-tri"), "the long thought keeps its collapse chevron");
});

test("a tool step shows the tool's short summary as a hover tooltip on its name", async () => {
    const w = await loadSidebarWorld();
    const cfg = { system: "", customSystem: false, maxSteps: 10, think: null, env: true, vision: null, systemAppend: null,
        tools: [{ name: "look", requiresApproval: false, summary: "Screenshots the page so the agent can see it." }] };
    await w.dispatch(agentStart("tsum", "look at it", "m", 10, cfg));
    await w.dispatch(agentStep("tsum", 1, { tool: "look", arguments: {}, result: "a screenshot" }));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const toolStep = w.shadow.querySelector(".astep.tool");
    const wrap = toolStep.querySelector(".tool-name-wrap");
    assert.ok(wrap, "the tool name has a tooltip wrapper (a summary was provided)");
    assert.match(wrap.querySelector(".tt-pop").textContent, /Screenshots the page/, "the summary is the tooltip");
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
    assert.ok(steps[0].classList.contains("appr-yes"), "auto-approved step marks provenance (badge-only: the BADGE is the cue, the bar stays neutral)");
    assert.match(steps[1].querySelector(".appr.yes").textContent, /approved/);
    assert.match(steps[2].querySelector(".appr.no").textContent, /denied/);
    assert.ok(steps[2].classList.contains("appr-no"), "denied step marks provenance (visual status is the red DENIED badge, not the bar)");
    // A doomed (precheck-skipped) action gets a neutral grey "skipped" badge — not yes/no.
    assert.match(steps[3].querySelector(".appr.skip").textContent, /skipped/);
    assert.ok(steps[3].classList.contains("appr-skip"), "skipped step marks provenance (badge carries it)");
    assert.equal(steps[3].querySelector(".appr.yes, .appr.no"), null, "skipped is neither approved nor denied");
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

// --- a step's Out: descriptors, delegated sub-calls and what was sent back -------------------------------

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
    // A `table` descriptor draws the same grid a DataFrame does (scroll-capped, sticky header, copy-CSV) —
    // there is one table renderer now, not two.
    // `:not(.r-df-idx)` skips the index gutter this grid draws per row (the pandas index).
    assert.equal(w.shadow.querySelectorAll(".r-df-table tbody td:not(.r-df-idx)").length, 4, "table cells rendered");
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

test("agent-step: a tool's feedback renders the 'Sent to the model' block", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("f1", "t"));
    await w.dispatch(agentStep("f1", 1, { seq: 1, tool: "locate", arguments: { description: "x" }, result: "ok",
        feedback: { reason: "point located — fed back automatically", via: "image", image: "data:image/png;base64,AAAA" } }));
    w.shadow.querySelector(".row").click(); await w.tick();
    w.shadow.querySelector(".astep.tool .astep-head").click(); await w.tick();
    const fb = w.shadow.querySelector(".astep.tool .astep-feedback");
    assert.ok(fb, "the feedback disclosure is present");
    assert.match(fb.querySelector(".feedback-title").textContent, /Sent to the model/);
    assert.match(fb.querySelector(".feedback-why").textContent, /point located/);
});

test("agent-step: a step's delegated sub-call tokens surface as the '+N sub' usage chip", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("s1", "t"));
    await w.dispatch(agentStep("s1", 1, { seq: 1, tool: "locate", arguments: { description: "x" }, result: "ok",
        usage: { promptTokens: 1000, completionTokens: 20, totalTokens: 1020 }, subUsage: { prompt: 2800, completion: 60, calls: 2 } }));
    w.shadow.querySelector(".row").click(); await w.tick();
    const sub = w.shadow.querySelector(".usage-sub");
    assert.ok(sub, "the usage bar shows the delegated sub-call chip");
    assert.match(sub.textContent, /sub/, "labelled as sub-call spend");
    assert.match(sub.querySelector(".tt-pop").textContent, /2,860 tokens over 2 delegated/, "tooltip has the total + call count");
});

// sidebar-export.test.js — getting a run out: the markdown log, the zip of PNG sidecars, and the
// self-contained printable PDF. See docs/dev/export.md.

const { test, after } = require("node:test");
const assert = require("node:assert");
const { closeSidebarWorlds, loadSidebarWorld } = require("./helpers");
const { chatStart, chatResult, agentStart, agentStep, agentResult, locateRender } = require("./sidebar-helpers");

// Close every jsdom window after the file — the VRAM panel's setInterval keeps a
// window's timers alive, which would otherwise hang the runner after all pass.
after(closeSidebarWorlds);

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

// Capture the printable document the "PDF" item builds. printSession routes the rendered doc to the
// background (PRINT_SESSION), which prints it from a real tab — window.print() is suppressed for a frame
// inside docked DevTools. The mock records the PRINT_SESSION payload, so read the HTML back from there.
async function capturePrint(w) {
    (await openExportMenu(w, "PDF")).click();
    await w.tick();
    const last = w.printCalls[w.printCalls.length - 1];
    return { html: last ? last.html : null };
}

// --- export: the markdown log, the zip of sidecars and the printable PDF ---------------------------------

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

test("export: a navigate step writes a page-transition divider into the markdown log", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("expn", "go read the other site", "m", 60));
    await w.dispatch(agentStep("expn", 1, { seq: 1, tool: "navigate", arguments: { url: "https://example.com/page" }, result: "Navigating to https://example.com/page …", renderIn: { type: "action", verb: "go to", target: "https://example.com/page" } }));
    await w.dispatch(agentStep("expn", 2, { seq: 2, tool: "findByText", arguments: { text: "hi" }, result: "found" }));
    await w.dispatch(agentResult("expn", "Read it.", 2));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const { blob } = await captureExport(w);
    const text = await blob.text();
    assert.match(text, /→ navigated to https:\/\/example\.com\/page · session resumed/, "the transition divider is in the export, mirroring the sidebar");
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

test("export: a multi-turn agent run interleaves the follow-up prompts + per-turn answers", async () => {
    const w = await loadSidebarWorld();
    const H = "multi";
    await w.dispatch(agentStart(H, "type something", "m", 20));
    await w.dispatch(agentStep(H, 1, { tool: "type", arguments: { selector: "input", text: "hi" }, result: "Typed." }));
    await w.dispatch(agentResult(H, "Typed hi into the box.", 1));                 // turn 1 answer @ step 1 (ts +100)
    // The follow-up prompt lands AFTER turn 1's answer (realistic ts): ordering is by real time, not a
    // fixed answer-before-say rule — a chat-style turn that runs no tool steps keeps the same atStep, so ts
    // is what interleaves them (the DevTools/HUD ordering bug this guards against).
    await w.dispatch({ kind: "agent-say", id: H, ts: Date.now() + 150, save: false, session: { hash: H, turn: 1 }, text: "would you be able to submit too?" });
    await w.dispatch(agentStep(H, 2, { thought: "They're asking about submitting." }));
    await w.dispatch(agentResult(H, "Yes, via submit:true.", 2));                  // turn 2 answer (final)
    w.shadow.querySelector(".row").click();
    await w.tick();

    const md = await (await captureExport(w)).blob.text();
    assert.match(md, /## User Asked[\s\S]*would you be able to submit too\?/, "the follow-up prompt is exported");
    assert.match(md, /## Answered[\s\S]*Typed hi into the box\./, "turn 1's answer is exported as 'Answered'");
    assert.match(md, /## Answer\b[\s\S]*Yes, via submit:true\./, "the final answer is the last one, headed 'Answer'");
    // Order: turn-1 answer BEFORE the follow-up prompt BEFORE the final answer.
    assert.ok(md.indexOf("Typed hi into the box") < md.indexOf("would you be able to submit"), "answer precedes the next prompt");
    assert.ok(md.indexOf("would you be able to submit") < md.indexOf("Yes, via submit:true"), "prompt precedes the final answer");
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

test("export menu: offers every format, and closes once one is picked", async () => {
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
        ["Markdown", "PDF", "JSON"], "every export format offered");
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

test("export → PDF: builds a self-contained printable document routed to the background print tab", async () => {
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const src = "data:image/png;base64," + PNG;
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("expp", "hide slow items", "gemma4:31b", 60));
    await w.dispatch(agentStep("expp", 1, { tool: "look", renderOut: { type: "image", src, label: "viewport" }, result: "a page" }));
    await w.dispatch(agentStep("expp", 2, { tool: "exec", arguments: { js: "items.forEach(i=>i.remove())" }, result: "Hidden 38 items." }));
    await w.dispatch(agentResult("expp", "I hid all **slow** items.", 2));
    w.shadow.querySelector(".row").click();
    await w.tick();

    const { html } = await capturePrint(w);
    assert.ok(html, "the rendered doc is posted to the background (PRINT_SESSION)");
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

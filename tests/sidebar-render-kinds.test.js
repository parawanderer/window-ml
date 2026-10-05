// sidebar-render-kinds.test.js — EVERY render descriptor a tool can produce, drawn for real in the session
// views the chat page and the panel share.
//
// It exists for a failure this file would have caught on the day it was written and no other test could: the
// `FetchLadder` helper had been declared INSIDE RenderPanel's `switch`, between two `case`s. A switch jumps
// straight to its matching label, so that declaration never ran and the binding stayed in its temporal dead
// zone — every `action` descriptor carrying a negotiation ladder threw `Cannot access 'FetchLadder' before
// initialization`, Preact unmounted the subtree, and the step rendered NOTHING. On screen it read as
// "fetch_url has no rendering", intermittently, because only a fetch whose ladder actually ran reaches it.
//
// What makes that invisible to the rest of the suite: a descriptor kind nobody has a test for is a `case`
// nobody executes, and a crash inside one is silent — Preact drops the subtree and the surrounding transcript
// still renders. So this asserts the two things a missing case cannot fake: that the render RAISED NOTHING,
// and that it put SOMETHING in the step's body.
const { test, after } = require("node:test");
const assert = require("node:assert");
const { closeSidebarWorlds, loadSidebarWorld } = require("./helpers");
const { agentStart, agentStep } = require("./sidebar-helpers");

after(closeSidebarWorlds);

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// One representative descriptor per `type` in the RenderDescriptor union (contract-render.ts), each with the
// fields its renderer actually reaches for. `tool` is the tool that really produces it, so a failure names
// something a reader can go and look at.
const CASES = [
    ["action · fetch with a negotiation ladder", "fetch_url", {
        type: "action", verb: "fetch", target: "https://example.test/README.md",
        attempts: [
            { strategy: "accept", url: "https://example.test/README.md", status: 200, contentType: "text/plain", bytes: 7085, ms: 388, outcome: "hit" },
            { strategy: "declared", url: "", outcome: "skipped", note: "not attempted — already resolved" },
            { strategy: "sibling", url: "", outcome: "skipped", note: "not attempted — already resolved" },
            { strategy: "convert", url: "", outcome: "skipped", note: "not attempted — already resolved" },
        ],
        resolvedBy: "accept",
    }],
    ["action · a page element", "click", { type: "action", verb: "click", selector: "#go", target: "Go" }],
    ["action · a plain target", "navigate", { type: "action", verb: "navigate", target: "https://example.test/next" }],
    ["code", "exec", { type: "code", text: "const a = 1;\nreturn a;", lang: "javascript" }],
    ["elements", "interactives", { type: "elements", items: [{ path: "#a", text: "A", index: 0 }] }],
    ["exec-out", "exec", { type: "exec-out", stdout: "one\ntwo\n", value: "3" }],
    ["image", "screenshot", { type: "image", src: PNG, label: "the page" }],
    ["keyval", "pageInfo", { type: "keyval", pairs: [["title", "Example"], ["url", "https://example.test/"]] }],
    ["locate", "locate", {
        type: "locate", mode: "grid", model: "m",
        substeps: [{ label: "Cell pick · grid 5×3 · model chose cell 12", prompt: "which cell?", output: "12", image: PNG }],
        picked: "#go", pickedBy: "model",
    }],
    ["look", "look", { type: "look", image: PNG, model: "m", output: "a page with a button", label: "the screen" }],
    ["python-in", "python_exec", { type: "python-in", mode: "script", code: "x = 1\nreturn x" }],
    ["python-out", "python_exec", { type: "python-out", stdout: "1\n", value: "1" }],
    ["python-out · a dataframe", "python_exec", { type: "python-out", df: { columns: ["a", "b"], rows: [[1, 2], [3, 4]], rowCount: 2 } }],
    ["python-out · a traceback", "python_exec", { type: "python-out", error: 'File "<python_exec>", line 1, in _user\nBoom' }],
    ["table", "fetch_url", { type: "table", columns: ["a", "b"], rows: [["1", "2"]], rowCount: 1, dtypes: { a: "int64", b: "int64" } }],
];

for (const [name, tool, descriptor] of CASES) {
    // BOTH slots, because they are different renderers over the same union: an In is drawn beside the call's
    // arguments and an Out inside the output cell, and a kind can be wired into one and not the other.
    for (const slot of ["renderIn", "renderOut"]) {
        test(`${slot}: ${name} renders, and raises nothing`, async () => {
            const w = await loadSidebarWorld();
            const raised = [];
            const realError = console.error;
            console.error = (...a) => raised.push(a.map(String).join(" "));
            try {
                await w.dispatch(agentStart("agR", "draw every kind"));
                w.shadow.querySelector(".row").click();
                await w.tick();
                await w.dispatch(agentStep("agR", 1, { seq: 1, tool, arguments: { x: 1 }, result: "ok", [slot]: descriptor }));
                await w.tick();
                // Steps start COLLAPSED, so nothing inside the body exists until it is opened — a test that
                // skipped this would pass on a renderer that throws (AGENTS.md: a wait loop that breaks on
                // something inside a collapsed step).
                for (const h of w.shadow.querySelectorAll(".astep-head")) h.click();
                await w.tick();
            } finally {
                console.error = realError;
            }
            const crash = raised.find(t => /ReferenceError|TypeError|before initialization|is not defined/.test(t));
            assert.ok(!crash, `rendering raised: ${crash}`);
            const step = w.shadow.querySelector(".astep");
            assert.ok(step, "the step itself is drawn");
            assert.ok(step.textContent.trim().length > tool.length, "the step body drew something, not just the tool name");
        });
    }
}

// The regression's own assertion, stated as the behaviour rather than as the absence of a crash: the ladder's
// rungs are what the descriptor carries, and all four are drawn (the skipped ones dimmed, which is the point
// of drawing them at all).
test("a fetch_url ladder draws every rung it was given, used and unused alike", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("agL", "fetch a readme"));
    w.shadow.querySelector(".row").click();
    await w.tick();
    await w.dispatch(agentStep("agL", 1, { seq: 1, tool: "fetch_url", arguments: { url: "https://example.test/README.md" }, result: "ok", renderIn: CASES[0][2] }));
    await w.tick();
    for (const h of w.shadow.querySelectorAll(".astep-head")) h.click();
    await w.tick();
    assert.equal(w.shadow.querySelectorAll(".r-lad-row").length, 4, "one row per attempt");
    assert.equal(w.shadow.querySelectorAll(".r-lad-row.r-lad-unused").length, 3, "the three never needed are dimmed");
    assert.match(w.shadow.querySelector(".r-lad-by")?.textContent ?? "", /resolved by/i);
});

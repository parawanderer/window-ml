// sidebar-live-call.test.js — a tool call the model is still WRITING, as the panel draws it: the tool's name, its code
// growing with a caret where it grows, the tree of any other call's arguments, and the step that replaces it.

const { test, after } = require("node:test");
const assert = require("node:assert");
const { closeSidebarWorlds, loadSidebarWorld } = require("./helpers");
const { agentStart, agentStep, agentResult } = require("./sidebar-helpers");

after(closeSidebarWorlds);

/** An `agent-stream` for run `id` carrying `calls`. */
const live = (id, calls, extra = {}) => ({ kind: "agent-stream", id, ts: Date.now(), save: false, session: { hash: id, turn: 1 }, step: 1, localStep: 1, calls, ...extra });
const call = (name, args) => ({ index: 0, name, args, chars: args.length });

// --- a call being written: drawn as the step it will become, growing ---

test("python_exec being written shows its code so far with a caret, then grows, then the step replaces it", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("lc1", "plot it"));
    w.shadow.querySelector(".row").click();
    await w.tick();
    await w.dispatch(live("lc1", [call("python_exec", '{"code": "import math\\nprint(math.pi')], { reasoning: "plot it" }));
    await w.tick();
    const lc = () => w.shadow.querySelector(".live-call");
    assert.ok(lc(), "the call is drawn while it is written");
    assert.match(lc().querySelector(".tool-name").textContent, /^python_exec$/);
    assert.match(lc().querySelector(".astep-preview").textContent, /writing… \d+ chars/);
    assert.match(lc().querySelector(".live-call-code").textContent, /import math\s*print\(math\.pi/, "the code, decoded, not the JSON");
    assert.ok(lc().querySelector(".live-call-code.writing"), "the caret is on while the code arrives");
    assert.ok(lc().closest(".aturn")?.querySelector(".astep-thought, .thought, .aturn-head"), "inside the turn, under its pill and thinking");

    await w.dispatch(live("lc1", [call("python_exec", '{"code": "import math\\nprint(math.pi)\\nprint(2')]));
    await w.tick();
    assert.match(lc().querySelector(".live-call-code").textContent, /print\(2/, "it grows in place");

    await w.dispatch(agentStep("lc1", 1, { seq: 1, pending: true, tool: "python_exec", arguments: { code: "import math\nprint(math.pi)\nprint(2)" } }));
    await w.tick();
    assert.equal(lc(), null, "the parsed call's step takes its place");
    assert.ok(w.shadow.querySelector(".astep.tool"), "…which is drawn");
});

test("a call that is not a code tool is the tree of its arguments so far; a whole one has no caret", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("lc2", "fetch it"));
    w.shadow.querySelector(".row").click();
    await w.tick();
    await w.dispatch(live("lc2", [call("fetch_url", '{"url": "https://example.com/a')]));
    await w.tick();
    const lc = w.shadow.querySelector(".live-call");
    assert.match(lc.querySelector(".jt-args").textContent, /https:\/\/example\.com\/a/, "the half-written string is shown");
    assert.ok(lc.querySelector(".live-caret"), "with the caret after it");
    await w.dispatch(live("lc2", [call("fetch_url", '{"url": "https://example.com/a"}')]));
    await w.tick();
    assert.equal(w.shadow.querySelector(".live-call .live-caret"), null, "the call is complete: nothing is arriving");
});

test("answer's Markdown streams as Markdown, its open formatting closed", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("lc3", "summarise"));
    w.shadow.querySelector(".row").click();
    await w.tick();
    await w.dispatch(live("lc3", [call("answer", '{"text": "## Fares\\n\\nThe **cheapest')]));
    await w.tick();
    const md = w.shadow.querySelector(".live-call .live-call-md.writing");
    assert.ok(md, "drawn as Markdown, with the caret");
    assert.equal(md.querySelector("h2")?.textContent, "Fares");
    assert.equal(md.querySelector("strong")?.textContent, "cheapest", "the open ** is closed for it, not shown as asterisks");
});

test("a preview a hub cut to its size says the call is being written and how far it got", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("lc4", "big"));
    w.shadow.querySelector(".row").click();
    await w.tick();
    await w.dispatch(live("lc4", [{ index: 0, name: "python_exec", chars: 48000 }]));
    await w.tick();
    const lc = w.shadow.querySelector(".live-call");
    assert.match(lc.querySelector(".astep-preview").textContent, /48\.0k chars/);
    assert.match(lc.querySelector(".astep-body").textContent, /once the call is complete/);
});

// --- a call that has gone quiet: said, timed from the last character that arrived ---

test("a call with nothing new for longer than the orb's stall says so, the caret stops, and a new fragment clears it", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("lc5", "write it"));
    w.shadow.querySelector(".row").click();
    await w.tick();
    await w.dispatch(live("lc5", [call("python_exec", '{"code": "for i in range(')]));
    await w.tick();
    const lc = () => w.shadow.querySelector(".live-call");
    assert.equal(lc().querySelector(".live-call-stall"), null, "just arrived: not quiet");
    // The panel's clock moves 10 s on, as a stalled server would leave it; the 1 s beat re-renders.
    const realNow = w.window.Date.now;
    const skew = 10_000;
    w.window.Date.now = () => realNow.call(w.window.Date) + skew;
    try {
        await new Promise((r) => setTimeout(r, 300));
        await w.tick();
        assert.match(lc().querySelector(".astep-preview").textContent, /writing… \d+ chars · no output for 10s/);
        assert.ok(lc().classList.contains("stalled"), "the caret stops blinking");
        await w.dispatch(live("lc5", [call("python_exec", '{"code": "for i in range(3):')]));
        await w.tick();
        assert.equal(lc().querySelector(".live-call-stall"), null, "a fragment arrived: it is writing again");
        assert.ok(!lc().classList.contains("stalled"));
    } finally { w.window.Date.now = realNow; }
});

// --- a call that never landed: the preview does not outlive the turn ---

test("a call the server never finished leaves no preview once the run ends, or once the next turn streams", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("lc6", "cut off"));
    w.shadow.querySelector(".row").click();
    await w.tick();
    await w.dispatch(live("lc6", [call("python_exec", '{"code": "for i in range(')]));
    await w.tick();
    assert.ok(w.shadow.querySelector(".live-call"));
    // The model is told the call was cut off and streams its next turn: text, no call.
    await w.dispatch(live("lc6", undefined, { step: 2, localStep: 2, session: { hash: "lc6", turn: 2 }, content: "Let me try that again" }));
    await w.tick();
    assert.equal(w.shadow.querySelector(".live-call"), null, "the next turn's stream replaces it");
    await w.dispatch(live("lc6", [call("python_exec", '{"code": "for i in')], { step: 2, localStep: 2, session: { hash: "lc6", turn: 2 } }));
    await w.tick();
    assert.ok(w.shadow.querySelector(".live-call"));
    await w.dispatch(agentResult("lc6", "", 2));
    await w.tick();
    assert.equal(w.shadow.querySelector(".live-call"), null, "the run ended: nothing is being written");
});

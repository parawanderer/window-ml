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
/** The live call's code once the reveal has caught up with what arrived: unchanged for longer than its slowest tick
 *  (it ticks less often as a render costs more, and a render in jsdom costs a lot). */
async function typedOut(w) {
    let last = null, since = Date.now();
    for (let i = 0; i < 200; i++) {
        await new Promise((r) => setTimeout(r, 20));
        await w.tick();
        const now = w.shadow.querySelector(".live-call .live-call-code")?.textContent ?? null;
        if (now !== last) { last = now; since = Date.now(); } else if (Date.now() - since > 200) return now;
    }
    return last;
}

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
    assert.match(await typedOut(w), /import math\s*print\(math\.pi/, "the code, decoded, not the JSON");
    assert.ok(lc().querySelector(".live-call-code.writing"), "the caret is on while the code arrives");
    assert.ok(lc().closest(".aturn")?.querySelector(".astep-thought, .thought, .aturn-head"), "inside the turn, under its pill and thinking");

    await w.dispatch(live("lc1", [call("python_exec", '{"code": "import math\\nprint(math.pi)\\nprint(2')]));
    await w.tick();
    assert.match(await typedOut(w), /print\(2/, "it grows in place");

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

// --- typed out: an even pace, never ahead of what arrived, and never in the way of the step ---

/** `n` lines of Python as a call's arguments, and the code they decode to. */
const pyLines = (n) => {
    const code = Array.from({ length: n }, (_, i) => `print("line ${i + 1} of the cell")`).join("\n");
    return { code, args: JSON.stringify({ code }) };
};

test("a burst is typed out: shown a part at a time, each a start of what arrived, caught up soon after", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("lc7", "type it"));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const { code, args } = pyLines(30);
    await w.dispatch(live("lc7", [call("python_exec", args.slice(0, 40))]));
    await typedOut(w);
    await w.dispatch(live("lc7", [call("python_exec", args)]));
    const seen = [];
    for (let i = 0; i < 200; i++) {
        await w.tick();
        const t = w.shadow.querySelector(".live-call .live-call-code")?.textContent ?? "";
        if (seen.at(-1) !== t) seen.push(t);
        if (t.replace(/\n/g, "") === code.replace(/\n/g, "")) break;
        await new Promise((r) => setTimeout(r, 20));
    }
    const flat = (t) => t.replace(/\n/g, "");
    assert.ok(seen.length > 2, `typed out over several steps, not at once: ${seen.length}`);
    for (const t of seen) assert.ok(flat(code).startsWith(flat(t)), `never ahead of what arrived: …${t.slice(-30)}`);
    assert.equal(flat(seen.at(-1)), flat(code), "caught up");
});

test("the step lands mid-reveal: it replaces the call at once, and the reveal is dropped", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("lc8", "land it"));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const { code, args } = pyLines(60);
    await w.dispatch(live("lc8", [call("python_exec", args.slice(0, 30))]));
    await typedOut(w);
    await w.dispatch(live("lc8", [call("python_exec", args)]));
    await w.tick();
    const mid = w.shadow.querySelector(".live-call .live-call-code")?.textContent ?? "";
    assert.ok(mid.length < code.length, "the reveal is still behind");
    await w.dispatch(agentStep("lc8", 1, { seq: 1, pending: true, tool: "python_exec", arguments: { code } }));
    await w.tick();
    assert.equal(w.shadow.querySelector(".live-call"), null, "the step did not wait for the animation");
    assert.ok(w.shadow.querySelector(".astep.tool"));
    await new Promise((r) => setTimeout(r, 120));
    await w.tick();
    assert.equal(w.shadow.querySelector(".live-call"), null, "and nothing the reveal scheduled brings it back");
});

test("a backlog too long to type out is shown at once", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("lc9", "jump"));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const big = pyLines(200);
    assert.ok(big.code.length > 4000);
    await w.dispatch(live("lc9", [call("python_exec", big.args)]));
    await w.tick();
    assert.equal(w.shadow.querySelector(".live-call .live-call-code").textContent.replace(/\n/g, ""), big.code.replace(/\n/g, ""), "a reopened panel or a hub's catch-up is not typed out");

});

test("with reduced motion, arrived code is shown at once", async () => {
    const w = await loadSidebarWorld();
    w.window.matchMedia = (q) => ({ matches: /reduce/.test(q), media: q, addEventListener() {}, removeEventListener() {} });
    await w.dispatch(agentStart("lc10", "still"));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const small = pyLines(12);
    await w.dispatch(live("lc10", [call("python_exec", small.args.slice(0, 20))]));
    await w.tick();
    await w.dispatch(live("lc10", [call("python_exec", small.args)]));
    await w.tick();
    assert.equal(w.shadow.querySelector(".live-call .live-call-code").textContent.replace(/\n/g, ""), small.code.replace(/\n/g, ""));
});

test("arrivals closer together than a tick do not postpone it: the reveal advances while they keep coming", async () => {
    // Re-arming the timer on every render pushed the tick back with each arrival, so a stream faster than the tick
    // (any long cell, whose ticks are spaced out by its cost) was never typed out until it stopped.
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("lc11", "flood"));
    w.shadow.querySelector(".row").click();
    await w.tick();
    const { args } = pyLines(80);
    const shown = () => (w.shadow.querySelector(".live-call .live-call-code")?.textContent ?? "").length;
    const lens = [];
    const t0 = Date.now();
    for (let n = 60; n < args.length && Date.now() - t0 < 1500; n += 25) {
        await w.dispatch(live("lc11", [call("python_exec", args.slice(0, n))]));
        lens.push(shown());
        await new Promise((r) => setTimeout(r, 5));
    }
    assert.ok(lens.length > 10, `enough arrivals: ${lens.length}`);
    assert.ok(lens.slice(0, -1).some((l) => l > 0), `typed out while arrivals kept coming, not only after: ${lens.slice(0, 12).join(",")}`);
});

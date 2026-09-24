// sidebar-answer.test.js — the tool-token ANSWER render: the bottom Result block, which citation resolves
// to which step, the casts (latex / raw / img / table), and where a citation is inline vs a display block.
// See docs/spec/TOOL_TOKENS.md.

const { test, after } = require("node:test");
const assert = require("node:assert");
const { closeSidebarWorlds, loadSidebarWorld } = require("./helpers");
const { agentStart, agentStep, agentResult, agentSay, openRun } = require("./sidebar-helpers");

// Close every jsdom window after the file — the VRAM panel's setInterval keeps a
// window's timers alive, which would otherwise hang the runner after all pass.
after(closeSidebarWorlds);

// Two ways an output reaches the answer, BOTH explicit (no auto-fallback): (1) inline @tool cite (expands in the
// reply), (2) designated into the answer set (ml.answer / the answer tool). The reducer stores ev.answer (the
// finalized bottom markdown) + the step's minted `token`; the render resolves it.
const OUT = "abcdef5";

const compStep = (hash) => agentStep(hash, 1, { seq: 1, tool: "python_exec", token: OUT, result: "COMPUTED_TABLE",
    renderOut: { type: "code", text: "COMPUTED_TABLE", lang: "text" } });

// Reproduces run 200d7599: turn 1 mints @tool:239987c on a python_exec; a FOLLOW-UP turn cites that SAME hex
// token INLINE, mid-sentence, with `| latex`. It must (a) RESOLVE (a hex anchors any turn — the per-turn scope
// broke it → "unresolved" in the DevTools reply) and (b) render INLINE, not a display block. Both surfaces
// must agree (parity).
async function inlineHexLatexRun(w) {
    const hash = "xt";
    await w.dispatch(agentStart(hash, "differentiate", "gemma4:31b"));
    await w.dispatch(agentStep(hash, 1, { seq: 1, tool: "python_exec", token: "239987c", result: "e^{x} + 2",
        renderOut: { type: "python-out", value: "e^{x} + 2 \\sin{\\left(x \\right)} \\cos{\\left(x \\right)}", latex: true } }));
    await w.dispatch(agentResult(hash, "On its own line:\n\n![deriv](@tool:239987c:out | latex)", 1));   // turn 1: standalone
    await w.dispatch({ kind: "agent-say", id: hash, ts: Date.now(), save: false, session: { hash, turn: 0 }, text: "inline please" });
    // turn 2: cite the SAME token INLINE, mid-sentence — NO python_exec step in this turn.
    await w.dispatch(agentResult(hash, "The derivative of $x$ is ![deriv](@tool:239987c:out | latex), which renders inline.", 2));
    await w.flush();
    return hash;
}

// The rendered LATEST answer's citation must be resolved + inline in whichever surface's container is passed.
function assertInlineResolved(root) {
    const answers = [...root.querySelectorAll(".answer-rendered")];
    const latest = answers[answers.length - 1];
    const tok = latest.querySelector(".tok-ref");
    assert.ok(tok, "the latest answer's citation renders");
    assert.ok(!tok.classList.contains("tok-unresolved"), "a hex citation to a PRIOR turn RESOLVES (not unresolved)");
    assert.ok(tok.classList.contains("tok-inline") && !tok.classList.contains("tok-block"), "a mid-sentence citation is INLINE (green tok-inline), not a display block");
    assert.ok(tok.querySelector(".katex") && !tok.querySelector(".katex-display"), "…inline-mode KaTeX");
}

// The "why do I need a newline top AND bottom" surprise (gemma4 rendering-variation runs): the model writes a
// labelled block as `No pipe:\n![cite]\n\nWith…` — the citation is ALONE on its own line. The line-based
// markdown() makes it the sole child of its own <p> → a DISPLAY block, no blank line needed on both sides.
const oneSidedBlockText = "No pipe:\n![no pipe](@tool:" + OUT + ":out)\n\nDone.";

async function oneSidedBlockRun(w, hash, text) {
    await w.dispatch(agentStart(hash, "diff"));
    await w.dispatch(agentStep(hash, 1, { seq: 1, tool: "python_exec", token: OUT, result: "x",
        renderOut: { type: "python-out", value: "x^{2} + 2x", latex: true } }));
    await w.dispatch(agentResult(hash, text, 1));
    await w.flush();
}

function lastAnswer(root) {
    const answers = [...root.querySelectorAll(".answer-rendered")];
    return answers[answers.length - 1];
}

function firstTok(root) { return lastAnswer(root)?.querySelector(".tok-ref"); }

// The list-item regression: a citation INSIDE a `- ` list item must stay INSIDE the <li>, with the trailing
// text on the SAME line as part of the same item. The old split-per-fragment renderer ran each prose run as its
// OWN markdown block, so `- No pipe: the result is ` became a CLOSED <ul>, the token landed AFTER it, and the
// trailing `.` orphaned into its own paragraph. The single-pass renderer keeps the list intact.
const listItemText = [
    "Results:",
    "- No pipe: the result is ![no pipe](@tool:" + OUT + ":out).",
    "- With raw: the value is ![v](@tool:" + OUT + ":out|raw).",
].join("\n");

function assertListIntact(root) {
    const ans = lastAnswer(root);
    assert.ok(ans, "the answer renders");
    const items = [...ans.querySelectorAll("ul > li")];
    assert.equal(items.length, 2, "both citations stay as list items (the <ul> isn't split apart)");
    // The token lives INSIDE its <li> and the trailing period is in the SAME item (not orphaned after the list).
    assert.ok(items[0].querySelector(".tok-ref"), "the citation is INSIDE the list item, not a sibling after the <ul>");
    assert.match(items[0].textContent.replace(/\s+/g, " ").trim(), /No pipe: the result is .*\.$/, "the item keeps its lead-in AND its trailing period");
    assert.ok(!ans.querySelector(".tok-ref")?.classList.contains("tok-block"), "an in-sentence list citation renders INLINE, not a display block");
    // No stray lone-period paragraph orphaned out of the list.
    assert.ok(![...ans.children].some((c) => c.tagName === "P" && c.textContent.trim() === "."), "no orphaned `.` paragraph");
}

// Clicking a citation IMAGE must open the lightbox and NOT also fire the citation's jump-to-step (which
// scrolls the panel away — the DevTools "click the image and it scrolls to the python function" bug). The img
// stops propagation; the surrounding tok-ref padding still jumps. Parity across the sidebar/DevTools + HUD card.
async function imageCiteRun(w, hash) {
    w.window.HTMLElement.prototype.scrollIntoView = function () {};   // jsdom stub; make the jump path clean
    await w.dispatch(agentStart(hash, "draw a fractal"));
    await w.dispatch(agentStep(hash, 1, { seq: 1, tool: "python_exec", token: OUT, result: "Returned an image.",
        renderOut: { type: "python-out", image: "data:image/png;base64,PIC" } }));
    await w.dispatch(agentResult(hash, "Here is the fractal:\n\n![Mandelbrot](@tool:" + OUT + ":out)", 1));
}

// A follow-up turn's answer citing a tool it ran in an EARLIER turn — "show me how you computed this" → the
// prior python_exec. A tool-NAME alias (@tool:python_exec) means "that tool's LATEST call", so the LATEST
// answer must resolve it against the WHOLE run, not just its own (python_exec-less) turn. Regression: the
// DevTools panel scoped the latest answer per-turn → "(unresolved @tool:python_exec)", while the HUD (no
// scope on the final answer) resolved it — a surface parity break. Both surfaces must resolve it now.
const xTurnCitedRun = async (w, hash) => {
    await w.dispatch(agentStart(hash, "compute the totals"));
    await w.dispatch(compStep(hash));                                          // TURN 1: a tokened python_exec
    await w.dispatch({ ...agentResult(hash, "Grand total: 6260.", 1), ts: Date.now() + 1 });
    // FOLLOW-UP turn (a continuation — no sayId), whose answer cites the turn-1 python_exec BY NAME.
    await w.dispatch(agentSay(hash, "Can you show me how you computed this?", undefined, Date.now() + 2));
    await w.dispatch({ ...agentResult(hash,
        "Here's the exact code that ran:\n\n![computation code](@tool:python_exec:out)\n\nDone.", 2),
        ts: Date.now() + 3 });
};

// --- the bottom-of-answer Result block: what is designated, and what is deduped away ---------------------

test("answer render (sidebar): a bottom-of-answer output shows in a RESULT block under the prose", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("af", "compute it"));
    await w.dispatch(compStep("af"));
    // prose summary (no inline cite) + a designated bottom token (what finalizeAnswer emits for ml.answer.add)
    await w.dispatch({ ...agentResult("af", "The total is 42.", 1), answer: `![computed result](@tool:${OUT}:out)` });
    await openRun(w);
    const rb = w.shadow.querySelector(".card-result");
    assert.ok(rb, "a Result block renders under the answer");
    assert.match(rb.querySelector(".result-label").textContent, /result/i, "the label is the muted 'Result'");
    assert.match(rb.textContent, /COMPUTED_TABLE/, "the cited step's output is inlined into the block");
});

test("answer render (sidebar): an INLINE citation expands in the reply, with NO separate Result block", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("inl", "compute it"));
    await w.dispatch(compStep("inl"));
    // cited inline → finalizeAnswer dedups it out of the bottom (answer = "")
    await w.dispatch({ ...agentResult("inl", `The total is ![it](@tool:${OUT}:out).`, 1), answer: "" });
    await openRun(w);
    assert.ok(!w.shadow.querySelector(".card-result"), "no bottom Result block when the output is cited inline");
    const reply = w.shadow.querySelector(".msg.asst .answer-rendered");
    assert.ok(reply && /COMPUTED_TABLE/.test(reply.textContent), "the output expands inline in the reply body");
});

test("answer render (sidebar): a DESIGNATED output shows in the Result block, with the model's caption", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("dsg", "compute it"));
    await w.dispatch(compStep("dsg"));
    await w.dispatch({ ...agentResult("dsg", "Done.", 1), answer: `![the sales table](@tool:${OUT}:out)` });
    await openRun(w);
    const rb = w.shadow.querySelector(".card-result");
    assert.ok(rb && /COMPUTED_TABLE/.test(rb.textContent), "the designated output renders at the bottom");
    assert.match([...rb.querySelectorAll(".tok-anno")].map(n => n.textContent).join(" "), /the sales table/, "the model's caption shows under the block");
});

test("answer render (sidebar): the Result block ONLY renders on the run's LATEST answer (single-valued s.answer)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("mt", "compute it"));
    await w.dispatch(compStep("mt"));
    await w.dispatch({ ...agentResult("mt", "First.", 1), answer: `![a](@tool:${OUT}:out)` });
    // a follow-up turn (a new answer) — s.answer now reflects the LATEST turn only
    await w.dispatch({ kind: "agent-say", id: "mt", ts: Date.now() + 50, save: false, session: { hash: "mt", turn: 1 }, text: "again" });
    await w.dispatch({ ...agentResult("mt", "Second.", 1), answer: `![b](@tool:${OUT}:out)` });
    await openRun(w);
    const results = w.shadow.querySelectorAll(".card-result");
    assert.equal(results.length, 1, "exactly one Result block — on the latest answer, not every turn");
});

test("answer render (sidebar): a follow-up that designates NOTHING clears the prior Result block (no stale answer)", async () => {
    // The purge invariant: turn 1 surfaces a Result; a follow-up turn that designates/cites nothing arrives with NO
    // `answer` field, and the reducer REPLACES (s.answer = ev.answer || undefined) — so the stale block disappears.
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("clr", "compute it"));
    await w.dispatch(compStep("clr"));
    await w.dispatch({ ...agentResult("clr", "The total is 42.", 1), answer: `![computed result](@tool:${OUT}:out)` });
    await openRun(w);
    assert.ok(w.shadow.querySelector(".card-result"), "turn 1's Result block renders");
    // Follow-up turn: a plain prose reply, no `answer` field (nothing designated).
    await w.dispatch({ kind: "agent-say", id: "clr", ts: Date.now() + 50, save: false, session: { hash: "clr", turn: 1 }, text: "thanks" });
    await w.dispatch(agentResult("clr", "You're welcome.", 2));   // NO answer field
    assert.ok(!w.shadow.querySelector(".card-result"), "the stale Result block is cleared after a designation-free follow-up");
});

// The reported bug: the model quoted an output inline AND designated the same one with the `answer` tool, so
// the table rendered TWICE — once where it was quoted, once appended under the reply. Anything shown inline
// must not be fallback-attached at the end of the turn.
test("answer dedup (sidebar): an output quoted inline is not ALSO appended in the Result block", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("dup", "compute it"));
    await w.dispatch(compStep("dup"));
    // Both at once: cited inline in the prose, AND designated in the answer set.
    await w.dispatch({ ...agentResult("dup", `The total is ![it](@tool:${OUT}:out).`, 1),
                       answer: `![the sales table](@tool:${OUT}:out)` });
    await openRun(w);

    const reply = w.shadow.querySelector(".msg.asst .answer-rendered");
    assert.ok(reply && /COMPUTED_TABLE/.test(reply.textContent), "it expands inline, where the model put it");
    assert.ok(!w.shadow.querySelector(".card-result"), "and is NOT appended again at the end of the turn");
    const shown = (w.shadow.querySelector(".msg.asst").textContent.match(/COMPUTED_TABLE/g) || []).length;
    assert.equal(shown, 1, "exactly one render of the output");
});

// The mixed form is the one a naive dedup misses: the prose cites the tool NAME while the answer set holds
// the hex id (or the reverse). They are the same output, so comparing the strings would render it twice.
test("answer dedup (sidebar): @tool:<name> inline and @tool:<id> in the answer set are ONE output", async () => {
    for (const [prose, designated] of [
        [`See ![it](@tool:python_exec:out).`, `![the table](@tool:${OUT}:out)`],   // name inline, hex designated
        [`See ![it](@tool:${OUT}:out).`, `![the table](@tool:python_exec:out)`],   // hex inline, name designated
    ]) {
        const w = await loadSidebarWorld();
        await w.dispatch(agentStart("mix", "compute it"));
        await w.dispatch(compStep("mix"));
        await w.dispatch({ ...agentResult("mix", prose, 1), answer: designated });
        await openRun(w);
        const count = (w.shadow.querySelector(".msg.asst").textContent.match(/COMPUTED_TABLE/g) || []).length;
        assert.equal(count, 1, `one render for ${prose} + ${designated}`);
        assert.ok(!w.shadow.querySelector(".card-result"), "no duplicate Result block");
    }
});

// Both surfaces render the Result block independently, so the dedup has to hold in each (the parity rule).
test("answer dedup (HUD card): the same output isn't shown twice there either", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    await w.raw({ __mlSidebarSurface: "card" });
    await w.dispatch(agentStart("hdup", "compute it"));
    await w.dispatch(compStep("hdup"));
    await w.dispatch({ ...agentResult("hdup", `The total is ![it](@tool:python_exec:out).`, 1),
                       answer: `![the sales table](@tool:${OUT}:out)` });
    await w.tick();

    const card = w.shadow.querySelector(".card-body") || w.shadow.querySelector("body");
    const count = (card.textContent.match(/COMPUTED_TABLE/g) || []).length;
    assert.equal(count, 1, "the HUD shows it once, like the sidebar");
    assert.ok(!w.shadow.querySelector(".card-result"), "no appended duplicate on the card");
});

// …and an output the model did NOT quote still gets appended: dedup must not swallow a real result.
test("answer dedup: an UNquoted designated output still appears in the Result block", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("keep", "compute it"));
    await w.dispatch(compStep("keep"));
    await w.dispatch({ ...agentResult("keep", "Done — see below.", 1), answer: `![the sales table](@tool:${OUT}:out)` });
    await openRun(w);
    const rb = w.shadow.querySelector(".card-result");
    assert.ok(rb && /COMPUTED_TABLE/.test(rb.textContent), "it has nowhere else to be shown, so it is appended");
});

// --- resolving a citation: hex token, tool-name alias, and which turn owns it ----------------------------

test("answer render (sidebar): a TOOL-NAME alias (@tool:python_exec) resolves to that tool's last step", async () => {
    // The real hallucination case: the model never set token:true (so it never saw the hex id) and cited the tool
    // by NAME — `![results](@tool:python_exec:out)`. compStep is a python_exec step with a minted token, so the
    // alias must resolve to it and the Result block must expand its output (proves aliasOf is threaded to the render).
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("al", "compute it"));
    await w.dispatch(compStep("al"));   // tool: python_exec, token: OUT
    await w.dispatch({ ...agentResult("al", "Here are the results.", 1), answer: "![results](@tool:python_exec:out)" });
    await openRun(w);
    const rb = w.shadow.querySelector(".card-result");
    assert.ok(rb && /COMPUTED_TABLE/.test(rb.textContent), "the tool-name alias resolves to the python_exec step's output");
});

test("answer render (HUD card): a PRIOR Show-work block's answer resolves its @tool citation, not raw markdown", async () => {
    // Regression: the multi-task HUD trace rendered a prior block's answer via plain markdown, so a
    // `![Calculations](@tool:…)` citation showed as literal text (bug). It must resolve like the card body /
    // sidebar reply — via AnswerBody — so the cited output renders instead.
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });   // off-mode corner card
    const hash = "blkcite";
    await w.dispatch(agentStart(hash, "compute totals", "m"));
    await w.dispatch(agentStep(hash, 1, { seq: 1, tool: "python_exec", token: "aa11bb0", result: "COMPUTED_TABLE",
        renderOut: { type: "code", text: "COMPUTED_TABLE", lang: "text" } }));
    // The FIRST task's answer cites that step inline (the summary carries the ![…](@tool:…)).
    await w.dispatch(agentResult(hash, "The total is 42. ![Calculations](@tool:aa11bb0:out)", 1));
    // A follow-up task → a second block, so the run SEGMENTS and block 0 becomes a PRIOR (CardTraceMsg-rendered).
    await w.dispatch({ kind: "agent-say", id: hash, ts: Date.now(), save: false, session: { hash, turn: 0 }, text: "again" });
    await w.dispatch(agentStep(hash, 2, { seq: 2, tool: "findByText", arguments: { text: "x" }, result: "ok" }));
    await w.dispatch(agentResult(hash, "Done.", 2));
    await w.flush();
    w.window.document.querySelector(".card-work-toggle").click(); await w.tick();   // open Show work
    const block0 = w.window.document.querySelectorAll(".run-block")[0];
    block0.querySelector(".run-block-head").click(); await w.tick();                 // expand the prior block
    const answered = block0.querySelector(".acard-ans");
    answered.querySelector(".astep-head").click(); await w.tick();                   // expand its "answered" disclosure
    assert.ok(answered.querySelector(".tok-ref"), "the @tool citation resolves to a token render");
    assert.match(answered.textContent, /COMPUTED_TABLE/, "the cited step's output is inlined");
    assert.doesNotMatch(answered.innerHTML, /@tool:aa11bb0/, "the raw @tool markdown is NOT shown");
});

test("answer render (sidebar): a PRIOR turn's tool-name alias resolves to ITS turn's call, not a later turn's", async () => {
    // The DevTools/overlay chat log (AgentRunView) renders each turn's answer via ReplyBubble; a prior turn's
    // `@tool:python_exec` alias must stay pinned to that turn's call as later turns run the same tool.
    const w = await loadSidebarWorld();
    const hash = "sbalias";
    await w.dispatch(agentStart(hash, "compute", "m"));
    await w.dispatch(agentStep(hash, 1, { seq: 1, tool: "python_exec", token: "aaa111",
        renderIn: { type: "python-in", code: "CODE_ONE", mode: "script" }, result: "out1" }));
    await w.dispatch(agentResult(hash, "First: ![the code](@tool:python_exec:in)", 1));
    await w.dispatch({ kind: "agent-say", id: hash, ts: Date.now(), save: false, session: { hash, turn: 0 }, text: "again" });
    await w.dispatch(agentStep(hash, 2, { seq: 2, tool: "python_exec", token: "bbb222",
        renderIn: { type: "python-in", code: "CODE_TWO", mode: "script" }, result: "out2" }));
    await w.dispatch(agentResult(hash, "Second: ![the code](@tool:python_exec:in)", 2));
    await w.flush();
    w.shadow.querySelector(".row").click(); await w.tick();
    const replies = [...w.shadow.querySelectorAll(".msg.asst .answer-rendered")];
    assert.ok(replies.length >= 2, "both answers render as token-resolved bodies");
    assert.match(replies[0].textContent, /CODE_ONE/, "turn 1's answer alias → CODE_ONE (its own call)");
    assert.doesNotMatch(replies[0].textContent, /CODE_TWO/, "…and does NOT drift to turn 2's later call");
    assert.match(replies[1].textContent, /CODE_TWO/, "turn 2's answer alias → CODE_TWO");
});

test("DevTools panel: a follow-up answer's tool-NAME @tool alias resolves whole-run, not per-turn", async () => {
    const w = await loadSidebarWorld();
    await xTurnCitedRun(w, "xturn");
    await openRun(w);
    assert.equal(w.shadow.querySelector(".tok-unresolved"), null,
        "the latest answer's @tool:python_exec resolves (its own turn ran no python_exec — was 'unresolved')");
    assert.ok(w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref"),
        "the cross-turn citation renders as a resolved tool-output block in the panel");
});

test("HUD card: the SAME cross-turn tool-name citation resolves (parity with the DevTools panel)", async () => {
    const w = await loadSidebarWorld();
    await w.raw({ __mlSidebarSurface: "card" });   // off-mode corner card
    await xTurnCitedRun(w, "xturnC");
    await w.tick();
    assert.equal(w.shadow.querySelector(".tok-unresolved"), null,
        "the HUD resolves the same cross-turn tool-name citation");
    assert.ok(w.shadow.querySelector(".answer-rendered .tok-ref"),
        "the citation renders as a resolved block on the corner card");
});

// --- a citation's cast: latex, raw, img, tables and elements ---------------------------------------------

test("answer render (sidebar): a sympy-AUTO `latex` python-out typesets with NO cast; `| raw` overrides", async () => {
    // python-runtime detects a sympy return and flags the descriptor `latex:true`, so a plain `:out` citation
    // typesets WITHOUT the model writing `| latex`. `| raw` still forces the literal string.
    const autoStep = (hash) => w.dispatch(agentStep(hash, 1, { seq: 1, tool: "python_exec", token: OUT, result: "2 x e^{3 x}",
        renderOut: { type: "python-out", value: "2 x e^{3 x} \\cos\\left(x^{2}\\right)", latex: true } }));
    let w = await loadSidebarWorld();
    await w.dispatch(agentStart("auto", "differentiate"));
    await autoStep("auto");
    await w.dispatch({ ...agentResult("auto", "The derivative is ![d](@tool:" + OUT + ":out).", 1), answer: "" });   // NO | latex
    await openRun(w);
    let tok = w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref");
    assert.ok(tok?.querySelector(".katex"), "an auto-latex python-out typesets with NO | latex cast");

    w = await loadSidebarWorld();
    await w.dispatch(agentStart("auto2", "x"));
    await autoStep("auto2");
    await w.dispatch({ ...agentResult("auto2", "Literal: ![d](@tool:" + OUT + ":out | raw)", 1), answer: "" });
    await openRun(w);
    tok = w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref");
    // Mid-sentence `| raw` → inline <code> literal (not a katex render, not a boxed block).
    assert.ok(tok && !tok.querySelector(".katex") && tok.querySelector("code.tok-val") && !tok.querySelector("pre.code"),
        "| raw overrides the auto-latex → inline literal text");
});

test("answer render: a comma-inline `| latex` cite (no newlines) is INLINE, not a display block — run 918874", async () => {
    // The EXACT text the model wrote: the citation is mid-sentence (comma right after, no blank line), so it
    // must render INLINE. (A stale `!`-embed build rendered every `![…]` as a display block — this guards it.)
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("ex", "differentiate"));
    await w.dispatch(agentStep("ex", 1, { seq: 1, tool: "python_exec", token: "9188747", result: "3x^2",
        renderOut: { type: "python-out", value: "3x^{2} + 4x - 5", latex: true } }));
    await w.dispatch(agentResult("ex", "The derivative is ![result](@tool:9188747:out | latex), which is typeset inline.", 1));
    w.shadow.querySelector(".row").click(); await w.tick();
    const tok = w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref");
    assert.ok(tok?.classList.contains("tok-inline") && !tok.classList.contains("tok-block"), "a comma-inline citation is INLINE");
    assert.ok(tok.querySelector(".katex") && !tok.querySelector(".katex-display"), "inline-mode KaTeX (not a display block)");
});

test("answer render (DevTools): an inline `| latex` cite of a PRIOR turn's hex token resolves + renders inline", async () => {
    const w = await loadSidebarWorld();
    await inlineHexLatexRun(w);
    w.shadow.querySelector(".row").click(); await w.tick();
    assertInlineResolved(w.shadow.querySelector(".view") || w.shadow);
});

test("answer render (sidebar): a cited exec output that returned ELEMENTS renders as an element list", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("els", "find the cards"));
    // exec that returned nodes → an `elements` renderOut (serialized path/text previews; live nodes can't cross the bus).
    await w.dispatch(agentStep("els", 1, { seq: 1, tool: "exec", token: OUT, result: "3 element(s)",
        renderOut: { type: "elements", items: [{ path: "div.card#a", text: "Card A" }, { path: "div.card#b", text: "Card B" }] } }));
    await w.dispatch({ ...agentResult("els", "Found 3 cards.", 1), answer: `![the cards](@tool:${OUT}:out)` });
    await openRun(w);
    const rb = w.shadow.querySelector(".card-result");
    assert.ok(rb, "the Result block renders");
    assert.match(rb.textContent, /div\.card#a|Card A/, "the returned elements render as a list of previews");
});

test("answer render (sidebar): a result cited with `| latex` renders as a KaTeX equation — a REAL number", async () => {
    const w = await loadSidebarWorld();
    // python_exec evaluated an equation to a real number; the model cites it with the latex format so it
    // typesets as math, not plain text. `| latex` renders the step's RESULT (rawText) via KaTeX.
    await w.dispatch(agentStart("lxr", "evaluate the discriminant"));
    await w.dispatch(agentStep("lxr", 1, { seq: 1, tool: "python_exec", token: OUT, result: "5", renderOut: { type: "python-out", value: "5" } }));
    await w.dispatch({ ...agentResult("lxr", `Solving b^2-4ac gives ![discriminant](@tool:${OUT}:out | latex).`, 1), answer: "" });
    await openRun(w);
    const reply = w.shadow.querySelector(".msg.asst .answer-rendered");
    assert.ok(reply, "the answer renders with the citation");
    assert.ok(reply.querySelector(".katex"), "the `| latex` result typesets via KaTeX");
    assert.match(reply.textContent, /5/, "the computed value is present");
    // A latex citation is STILL a provenance ref: the KaTeX sits inside a clickable .tok-ref with a tooltip
    // that names the source step (clicking jumps to the compute step that produced the value).
    const tok = reply.querySelector(".tok-ref");
    assert.ok(tok && tok.querySelector(".katex"), "the typeset value is INSIDE the clickable citation");
    assert.match(tok.querySelector(".tok-tip")?.textContent || "", /step 1 · python_exec/, "the hover tooltip names the source compute step");
});

test("answer render (sidebar): a STANDALONE `| latex` citation → a green DISPLAY block; an INLINE one → inline", async () => {
    const latexStep = (hash) => w.dispatch(agentStep(hash, 1, { seq: 1, tool: "python_exec", token: OUT, result: "\\frac{1}{2}",
        renderOut: { type: "python-out", value: "\\frac{1}{2}" } }));
    // STANDALONE — the citation sits alone in its own paragraph (blank lines around it) → display block + outline.
    let w = await loadSidebarWorld();
    await w.dispatch(agentStart("lxd", "differentiate"));
    await latexStep("lxd");
    await w.dispatch({ ...agentResult("lxd", "The derivative is:\n\n![Derivative](@tool:" + OUT + ":out | latex)\n\nDone.", 1), answer: "" });
    await openRun(w);
    let tok = w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref");
    assert.ok(tok?.classList.contains("tok-block"), "a standalone latex citation is a tok-block (green outline)");
    assert.ok(tok.querySelector(".katex-display"), "…in DISPLAY mode (centered, full-size)");
    assert.match(tok.querySelector(".tok-anno")?.textContent || "", /Derivative/, "the label shows as the block caption");

    // INLINE — the same citation written MID-SENTENCE → inline, no block outline, inline-mode KaTeX.
    w = await loadSidebarWorld();
    await w.dispatch(agentStart("lxi2", "differentiate"));
    await latexStep("lxi2");
    await w.dispatch({ ...agentResult("lxi2", "The derivative is ![d](@tool:" + OUT + ":out | latex) exactly.", 1), answer: "" });
    await openRun(w);
    tok = w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref");
    assert.ok(tok && !tok.classList.contains("tok-block"), "a mid-sentence latex citation stays inline (no block outline)");
    assert.ok(tok.querySelector(".katex") && !tok.querySelector(".katex-display"), "…inline-mode KaTeX, not display");
});

test("answer render (sidebar): `| raw` forces the literal value (no table/latex/image derivation)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("rw", "compute"));
    // renderOut is a python-out df — WITHOUT | raw it'd render a table; | raw shows the literal value string.
    await w.dispatch(agentStep("rw", 1, { seq: 1, tool: "python_exec", token: OUT, result: "the-literal-value",
        renderOut: { type: "python-out", value: "the-literal-value" } }));
    await w.dispatch({ ...agentResult("rw", "Raw: ![v](@tool:" + OUT + ":out | raw)", 1), answer: "" });
    await openRun(w);
    const tok = w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref");
    // Mid-sentence, short value → inline <code> (not a boxed block); still a literal (no table derivation).
    assert.ok(tok?.querySelector("code.tok-val") && !tok.querySelector("pre.code"), "| raw renders the value as inline literal code");
    assert.match(tok.textContent, /the-literal-value/, "the literal value is shown verbatim");
    assert.ok(!tok.querySelector(".katex"), "no latex typesetting for a | raw citation");
});

test("answer render (sidebar): a STANDALONE (own-line) `| raw` citation is a code BLOCK", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("rwb", "compute"));
    await w.dispatch(agentStep("rwb", 1, { seq: 1, tool: "python_exec", token: OUT, result: "x^{2} e^{x}",
        renderOut: { type: "python-out", value: "x^{2} e^{x}" } }));
    // Alone on its own line → a boxed code block (contrast with the mid-sentence inline <code> above).
    await w.dispatch({ ...agentResult("rwb", "Raw:\n\n![v](@tool:" + OUT + ":out | raw)\n\ndone.", 1), answer: "" });
    await openRun(w);
    const tok = w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref");
    assert.ok(tok?.classList.contains("tok-block") && tok.querySelector("pre.code") && !tok.querySelector("code.tok-val"),
        "standalone | raw → a code BLOCK, not inline <code>");
});

test("answer render (sidebar): `| img` renders a base64 value as an image; an external URL stays non-image (beacon-safe)", async () => {
    const w = await loadSidebarWorld();
    const B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    await w.dispatch(agentStart("im", "make a chart"));
    await w.dispatch(agentStep("im", 1, { seq: 1, tool: "python_exec", token: OUT, result: B64,
        renderOut: { type: "python-out", value: B64 } }));
    await w.dispatch({ ...agentResult("im", "Chart: ![chart](@tool:" + OUT + ":out | img)", 1), answer: "" });
    await openRun(w);
    const img = w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref img.zoomable");
    assert.ok(img, "| img renders the base64 value as an <img>");
    assert.match(img.getAttribute("src") || "", /^data:image\/png;base64,iVBOR/, "bare base64 is wrapped as a data: URL");

    // An external URL cited `| img` must NOT become an <img> (that would beacon the viewer) — it falls back.
    const w2 = await loadSidebarWorld();
    await w2.dispatch(agentStart("im2", "x"));
    await w2.dispatch(agentStep("im2", 1, { seq: 1, tool: "python_exec", token: OUT, result: "https://evil.example/x.png",
        renderOut: { type: "python-out", value: "https://evil.example/x.png" } }));
    await w2.dispatch({ ...agentResult("im2", "Look: ![x](@tool:" + OUT + ":out | img)", 1), answer: "" });
    await w2.dispatch({ __mlDebug: undefined });
    w2.shadow.querySelector(".row").click(); await w2.tick();
    const tok2 = w2.shadow.querySelector(".msg.asst .answer-rendered .tok-ref");
    assert.ok(tok2 && !tok2.querySelector("img"), "an external URL is NOT rendered as an <img> (no beacon)");
});

test("answer render (sidebar): `| img` is HARDENED against abuse (external/js/html/svg/attr-breakout)", async () => {
    // `| img` renders a MODEL-controlled value, so it must never become a beacon or a script surface. Each
    // hostile value must render as text (no <img>, no <script>). dataImageFrom accepts only raster data:image
    // + clean base64.
    const citeImg = async (val) => {
        const w = await loadSidebarWorld();
        await w.dispatch(agentStart("adv", "x"));
        await w.dispatch(agentStep("adv", 1, { seq: 1, tool: "python_exec", token: OUT, result: val,
            renderOut: { type: "python-out", value: val } }));
        await w.dispatch({ ...agentResult("adv", "Look: ![x](@tool:" + OUT + ":out | img)", 1), answer: "" });
        w.shadow.querySelector(".row").click(); await w.tick();
        return w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref");
    };
    const hostile = [
        "https://evil.example/beacon.png",                             // external URL → IP beacon
        "http://evil.example/x",                                       // external http
        "//evil.example/x.png",                                       // protocol-relative
        "javascript:alert(1)",                                        // js scheme
        "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==", // data:text/html carrying a <script>
        "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+",     // svg (onload) — rejected as a surface
        'data:image/png;base64,AAAA" onerror="alert(1)',              // attribute-breakout attempt
        "data:image/png;base64,AA<script>alert(1)</script>",          // markup in the "base64"
        "not base64 at all !!! $$$",                                  // junk
    ];
    for (const v of hostile) {
        const tok = await citeImg(v);
        assert.ok(tok, `citation still renders (as text) for: ${v.slice(0, 28)}`);
        assert.equal(tok.querySelector("img"), null, `NO <img> for hostile value: ${v.slice(0, 28)}`);
        assert.equal(tok.querySelector("script"), null, "never a <script> element");
    }
    // Positive control: a clean raster data URL DOES render as an image.
    const ok = await citeImg("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");
    assert.ok(ok.querySelector("img.zoomable"), "a clean data:image/png;base64 DOES render as an <img>");
});

test("answer render (sidebar): a `| latex` citation renders an IMAGINARY / complex result too", async () => {
    const w = await loadSidebarWorld();
    // sqrt(-9) → a complex root the python step computed; the model formats it for math (2 + 3i).
    await w.dispatch(agentStart("lxi", "solve x^2 + 9 = 0"));
    await w.dispatch(agentStep("lxi", 1, { seq: 1, tool: "python_exec", token: OUT, result: "2 + 3i", renderOut: { type: "python-out", value: "2 + 3i" } }));
    await w.dispatch({ ...agentResult("lxi", `The complex root is ![root](@tool:${OUT}:out | latex).`, 1), answer: "" });
    await openRun(w);
    const reply = w.shadow.querySelector(".msg.asst .answer-rendered");
    assert.ok(reply.querySelector(".katex"), "the complex result typesets via KaTeX (no throw on `i`)");
    assert.match(reply.textContent, /3/, "the imaginary component is present");
});

test("answer render (sidebar): a :out citation of a python SCALAR shows the CLEAN value, not the model-facing prelude", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("pys", "compute the total"));
    // result carries the model-facing prelude; renderOut.value is the clean "6260" (the citation must use the latter).
    await w.dispatch(agentStep("pys", 1, { seq: 1, tool: "python_exec", token: OUT,
        result: "[loaded, reference directly] a 12×6 DataFrame → `df`.\n\n6260", renderOut: { type: "python-out", value: "6260" } }));
    await w.dispatch({ ...agentResult("pys", `The grand total is ![total](@tool:${OUT}:out).`, 1), answer: "" });
    await openRun(w);
    const tok = w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref");
    assert.ok(tok, "the citation renders");
    assert.match(tok.textContent, /6260/, "the clean value shows");
    assert.doesNotMatch(tok.textContent, /loaded, reference directly/, "the model-facing prelude is NOT in the citation");
});

test("answer render (sidebar): LINK form `[label](@tool:…)` renders a clickable link, NOT an inline expansion", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("lnk", "compute"));
    await w.dispatch(agentStep("lnk", 1, { seq: 1, tool: "python_exec", token: OUT, result: "COMPUTED_TABLE", renderOut: { type: "code", text: "COMPUTED_TABLE", lang: "text" } }));
    // LINK form (no `!`) → a jump-to-output link, not the expanded output.
    await w.dispatch({ ...agentResult("lnk", `See the [full table](@tool:${OUT}:out) for details.`, 1), answer: "" });
    await openRun(w);
    const reply = w.shadow.querySelector(".msg.asst .answer-rendered");
    const link = reply.querySelector(".tok-link");
    assert.ok(link, "renders a .tok-link (not an embed)");
    assert.match(link.textContent, /full table/, "the label is the link text");
    assert.doesNotMatch(reply.textContent, /COMPUTED_TABLE/, "the output is NOT expanded inline — a link references it, an embed shows it");
    assert.ok(!reply.querySelector(".tok-ref"), "no embed citation present");
});

test("answer render (sidebar): a sympy.latex() output cited `| latex` typesets via KaTeX (commands render; no prelude)", async () => {
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("sym", "solve x^2+2x+5=0 symbolically"));
    // What a real `python_exec` returning `sympy.latex(root)` looks like: the model-facing result carries the
    // prelude, but the descriptor `value` is the clean LaTeX string (with real commands: \frac, \sqrt).
    await w.dispatch(agentStep("sym", 1, { seq: 1, tool: "python_exec", token: OUT,
        result: "[loaded, reference directly] a DataFrame → `df`.\n\n- 1 + 2 i",
        renderOut: { type: "python-out", value: "- \\frac{1}{2} + \\frac{\\sqrt{19} i}{2}" } }));
    await w.dispatch({ ...agentResult("sym", `The root is ![root](@tool:${OUT}:out | latex).`, 1), answer: "" });
    await openRun(w);
    const tok = w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref");
    assert.ok(tok, "the citation renders");
    assert.ok(tok.querySelector(".katex"), "the sympy.latex output (with \\frac/\\sqrt) typesets via KaTeX");
    assert.doesNotMatch(tok.textContent, /loaded, reference directly/, "the model-facing prelude is NOT fed to KaTeX");
});

// --- inline vs display: where a citation breaks the prose and where it does not --------------------------

test("answer render (HUD card): a TOOL-NAME alias in a PRIOR block resolves to THAT block's tool call, not a later turn's", async () => {
    // The alias `@tool:python_exec` means "that tool's latest call" — unambiguous within a turn, but a PRIOR
    // turn's answer must NOT drift to a LATER turn's call once it runs. Turn 1 and turn 2 each run python_exec
    // (CODE_ONE / CODE_TWO) and each answer cites `@tool:python_exec:in`; block 0's answer must still show
    // CODE_ONE after turn 2's CODE_TWO exists. (The hex id is anchored per-step; this guards the alias.)
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });
    const hash = "aliasdrift";
    await w.dispatch(agentStart(hash, "compute", "m"));
    await w.dispatch(agentStep(hash, 1, { seq: 1, tool: "python_exec", token: "aaa111",
        renderIn: { type: "python-in", code: "CODE_ONE", mode: "script" }, result: "out1" }));
    await w.dispatch(agentResult(hash, "First: ![the code](@tool:python_exec:in)", 1));
    await w.dispatch({ kind: "agent-say", id: hash, ts: Date.now(), save: false, session: { hash, turn: 0 }, text: "again" });
    await w.dispatch(agentStep(hash, 2, { seq: 2, tool: "python_exec", token: "bbb222",
        renderIn: { type: "python-in", code: "CODE_TWO", mode: "script" }, result: "out2" }));
    await w.dispatch(agentResult(hash, "Second: ![the code](@tool:python_exec:in)", 2));
    await w.flush();
    w.window.document.querySelector(".card-work-toggle").click(); await w.tick();
    const block0 = w.window.document.querySelectorAll(".run-block")[0];
    block0.querySelector(".run-block-head").click(); await w.tick();
    const answered = block0.querySelector(".acard-ans");
    answered.querySelector(".astep-head").click(); await w.tick();
    assert.match(answered.textContent, /CODE_ONE/, "block 0's alias resolves to ITS OWN python_exec (CODE_ONE)");
    assert.doesNotMatch(answered.textContent, /CODE_TWO/, "it did NOT drift to turn 2's later python_exec");
});

test("answer render: an inline latex citation has NO wrapping <p> (KaTeX flows inline, not on its own line)", async () => {
    // The real "inline is broken" bug: markdown() wraps the inline `\(…\)` KaTeX in a block-level <p>, which
    // forced the formula onto its own line even though it was mid-sentence. inlineMarkdown strips that <p>.
    // Uses AUTO-latex (a python-out flagged latex, NO pipe) — the exact observe repro (run cbb2b8).
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("nop", "diff"));
    await w.dispatch(agentStep("nop", 1, { seq: 1, tool: "python_exec", token: OUT, result: "x",
        renderOut: { type: "python-out", value: "x^{2} \\cos{\\left(x \\right)} + 2 x \\sin{\\left(x \\right)}", latex: true } }));
    await w.dispatch(agentResult("nop", "The derivative is ![result](@tool:" + OUT + ":out), as computed.", 1));
    await openRun(w);
    const tok = w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref");
    assert.ok(tok?.classList.contains("tok-inline"), "a mid-sentence auto-latex cite is inline");
    assert.equal(tok.querySelector("p"), null, "NO block <p> wrapper — the KaTeX flows in the sentence");
    assert.ok(tok.querySelector(".katex") && !tok.querySelector(".katex-display"), "inline-mode KaTeX (not display)");
});

test("answer render: a citation ALONE on its own line is a DISPLAY block; SAME-line prose keeps it INLINE", async () => {
    const step = (w2, h) => w2.dispatch(agentStep(h, 1, { seq: 1, tool: "python_exec", token: OUT, result: "x",
        renderOut: { type: "python-out", value: "x^{2}", latex: true } }));
    // ALONE on its own line (single newlines each side, no blank) → DISPLAY block. The model's line placement IS
    // the intent ("on its own line → block"); the line-based markdown makes it the sole child of its own <p>.
    let w = await loadSidebarWorld();
    await w.dispatch(agentStart("sn", "diff")); await step(w, "sn");
    await w.dispatch(agentResult("sn", "The derivative:\n![d](@tool:" + OUT + ":out)\nDone.", 1));
    await openRun(w);
    let tok = w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref");
    assert.ok(tok?.classList.contains("tok-block") && tok.querySelector(".katex-display"), "alone on its own line → DISPLAY block");
    // SAME line as prose (mid-sentence) → INLINE.
    w = await loadSidebarWorld();
    await w.dispatch(agentStart("bl", "diff")); await step(w, "bl");
    await w.dispatch(agentResult("bl", "The derivative is ![d](@tool:" + OUT + ":out) exactly.", 1));
    await openRun(w);
    tok = w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref");
    assert.ok(tok && !tok.classList.contains("tok-block") && !tok.querySelector(".katex-display"), "prose on the same line → INLINE");
});

test("answer render (DevTools): a citation on its own line (`label:\\n![cite]`) is a DISPLAY block", async () => {
    const w = await loadSidebarWorld();
    await oneSidedBlockRun(w, "osb", oneSidedBlockText);
    await openRun(w);
    const tok = firstTok(w.shadow);
    assert.ok(tok?.classList.contains("tok-block") && tok.querySelector(".katex-display"),
        "alone on its own line → DISPLAY block (no double-blank needed)");
});

test("answer render (HUD card): the SAME own-line citation is a DISPLAY block — parity", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });
    await oneSidedBlockRun(w, "osb", oneSidedBlockText);
    const tok = firstTok(w.window.document);
    assert.ok(tok?.classList.contains("tok-block") && tok.querySelector(".katex-display"),
        "HUD card renders the own-line citation as a DISPLAY block too");
});

test("answer render (DevTools): an inline citation inside a `- ` list item keeps the list intact", async () => {
    const w = await loadSidebarWorld();
    await oneSidedBlockRun(w, "li1", listItemText);
    await openRun(w);
    assertListIntact(w.shadow);
});

test("answer render (HUD card): the SAME list-item citation keeps the list intact — parity", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });
    await oneSidedBlockRun(w, "li1", listItemText);
    assertListIntact(w.window.document);
});

test("answer render (HUD card): the SAME inline cite resolves + renders inline — parity with DevTools", async () => {
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = () => {};
    await w.raw({ __mlSidebarSurface: "card" });
    await inlineHexLatexRun(w);
    assertInlineResolved(w.window.document);
});

test("answer render (sidebar): a citation CAPTION renders inline `$…$` math (models write latex in labels)", async () => {
    // Regression: the .tok-anno caption showed the model's label as raw text, so an inline `$\sin^2(x)$` in a
    // caption displayed the literal `$…$`. The caption is model prose → render it markdown+math.
    const w = await loadSidebarWorld();
    await w.dispatch(agentStart("cap", "compute"));
    await w.dispatch(compStep("cap"));   // a block citation (renderOut code) → the label becomes a caption
    await w.dispatch({ ...agentResult("cap", "See:\n\n![Derivative of $\\sin^2(x) + e^x$](@tool:" + OUT + ":out)", 1), answer: "" });
    await openRun(w);
    const anno = w.shadow.querySelector(".msg.asst .answer-rendered .tok-anno");
    assert.ok(anno, "the block citation shows its caption");
    assert.ok(anno.querySelector(".katex"), "inline $…$ in the caption typesets via KaTeX");
    assert.ok(!anno.textContent.includes("$"), "no literal $ delimiters remain in the caption");
});

test("HUD card: clicking a bottom-answer citation OPENS the collapsed block holding its source step (the group-reveal fix)", async () => {
    const w = await loadSidebarWorld();
    w.window.Element.prototype.scrollIntoView = function () {};       // jsdom has no scroll
    w.window.requestAnimationFrame = () => 0;                         // no-op: the block opens via the reveal EFFECT, not the scroll retry (and this avoids a post-teardown timer)
    await w.raw({ __mlSidebarSurface: "card" });                      // the HUD card surface
    // Turn 1: a computation (seq 1, token OUT). Turn 2 (a follow-up) cites that earlier output at the bottom —
    // so its SOURCE step lives in the PRIOR, collapsed block. This is the multi-task shape that segments into
    // collapsible blocks (the bug: the citation opened Show-work but not the collapsed GROUP).
    await w.dispatch(agentStart("blk", "compute the totals"));
    await w.dispatch(agentStep("blk", 1, { seq: 1, tool: "python_exec", token: OUT, result: "COMPUTED_TABLE", renderOut: { type: "code", text: "COMPUTED_TABLE", lang: "text" } }));
    await w.dispatch({ ...agentResult("blk", "The total is 42.", 1), answer: "" });
    await w.dispatch({ kind: "agent-say", id: "blk", ts: Date.now() + 50, save: false, session: { hash: "blk", turn: 1 }, text: "show me that table again" });
    await w.dispatch({ kind: "agent-step", id: "blk", ts: Date.now() + 60, save: false, session: { hash: "blk", turn: 2 }, step: 2, seq: 2, thought: "reusing the earlier result" });
    await w.dispatch({ ...agentResult("blk", "Here it is.", 2), answer: `![the table](@tool:${OUT}:out)` });
    await w.tick();
    // Open "Show work" → the run is multi-task, so it segments into blocks: the PRIOR one collapsed.
    w.shadow.querySelector(".card-work-toggle").click(); await w.tick();
    assert.ok(!w.shadow.querySelector('[data-astep-seq="1"]'), "the prior block is collapsed → the source step row isn't rendered yet");
    // Click the bottom Result citation (source = seq 1, in the collapsed prior block).
    const tok = w.shadow.querySelector(".card-result .tok-ref");
    assert.ok(tok, "the bottom Result citation is present in the card");
    tok.click(); await w.tick(); await w.tick(); await w.tick();
    assert.ok(w.shadow.querySelector('[data-astep-seq="1"]'), "clicking the citation force-opened the collapsed block → the source step is now shown");
});

test("answer render (sidebar): clicking a citation IMAGE opens the lightbox and does NOT jump to the step", async () => {
    const posted = [];
    const w = await loadSidebarWorld();
    w.window.postMessage = (d) => posted.push(d);   // window.parent === window in jsdom → captures openLightbox
    await imageCiteRun(w, "imgc");
    await openRun(w);
    const img = w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref img.zoomable");
    const step = w.shadow.querySelector('[data-astep-seq="1"]');
    assert.ok(img && step, "the citation renders a zoomable image and the source step row exists");
    img.click(); await w.tick();
    assert.ok(posted.some(d => d.__mlLightbox === "data:image/png;base64,PIC"), "the image click posts __mlLightbox (opens the lightbox)");
    assert.ok(!step.classList.contains("astep-pulse"), "the image click did NOT bubble to the citation jump (no scroll/pulse)");
    // Positive control: clicking the citation BACKGROUND (not the image) still jumps to the source step.
    const tok = w.shadow.querySelector(".msg.asst .answer-rendered .tok-ref");
    tok.click(); await w.tick();
    assert.ok(step.classList.contains("astep-pulse"), "clicking the citation background still jumps to the step");
});

test("answer render (HUD card): the SAME image click opens the lightbox without jumping — parity", async () => {
    const posted = [];
    const w = await loadSidebarWorld({ sync: { debugMode: "off" } });
    w.window.postMessage = (d) => posted.push(d);
    await w.raw({ __mlSidebarSurface: "card" });
    await imageCiteRun(w, "imgc");
    const img = w.window.document.querySelector(".answer-rendered .tok-ref img.zoomable");
    assert.ok(img, "the HUD card renders the zoomable citation image");
    img.click(); await w.tick();
    assert.ok(posted.some(d => d.__mlLightbox === "data:image/png;base64,PIC"), "the HUD image click posts __mlLightbox too");
});
